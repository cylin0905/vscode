/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { join, dirname } from 'path';
import { shell } from 'electron';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogMainService } from '../../../../platform/dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	ILlmChatChunkEvent, ILlmChatMessage, ILlmChatProvider, ILlmDownloadProgress, ILlmEngineInfo,
	ILlmLogEntry, ILlmModelCatalogEntry, ILlmModelRecord, ILlmSourceConfig, ILlmSystemInfo, ILlmNetworkModel,
	IIshellLlmService, LlmEngineState, LlmLogLevel, LlmLogSource, LlmSourceKind,
	ILlmArtifactMeta, ILlmPersistOptions, ILlmCompletionOptions, ILlmDiagnosticReport, ILlmFixOptions,
	ILlmSkillManifest, ILlmSkillRegistration, ILlmFileVersion
} from '../common/llm.js';
import { extractCodeBlocks } from '../common/llmInstructions.js';
import { IFileIO } from '../node/connectionStore.js';
import { getCatalogEntry, getLlmSystemInfo, LLM_MODEL_CATALOG } from '../node/llmCatalog.js';
import { fetchNetworkModels } from '../node/llmNetworkSearch.js';
import { downloadFile } from '../node/llmDownloader.js';
import { findEngineExe, installEngine } from '../node/llmEngine.js';
import { LlmApiGateway } from '../node/llmApiGateway.js';
import { LocalChatProvider } from '../node/llmChatProvider.js';
import { LlmLogStore } from '../node/llmLog.js';
import { LlmModelStore } from '../node/llmModelStore.js';
import { LlamaServerController } from '../node/llamaServer.js';
import { LlmArtifactStore } from '../node/llmArtifactStore.js';
import { analyzeDiagnostics } from '../node/llmDiagnosticsEngine.js';
import { LlmSkillRegistry } from '../node/llmSkillRegistry.js';
import { LlmCodeHistoryStore } from '../node/llmCodeHistory.js';

class LlmFileIO implements IFileIO {
	constructor(private readonly filePath: string) { }

	async readFile(): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.filePath, 'utf8');
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') {
				return undefined;
			}
			throw err;
		}
	}

	async writeFile(content: string): Promise<void> {
		await fsp.mkdir(dirname(this.filePath), { recursive: true });
		await fsp.writeFile(this.filePath, content, 'utf8');
	}
}

interface IDownloadState {
	cts: CancellationTokenSource;
	startedAt: number;
}

/**
 * iShell 本地 LLM 主进程服务：
 * - 模型/源/引擎状态持久化（llm.json）
 * - 引擎下载（llama.cpp releases）与模型下载（HF 端点）
 * - llama-server 子进程托管 + OpenAI 兼容 API 网关（LM Studio 规范）
 * - 流式对话（Provider 抽象，云端预留）
 * - 全流程运行日志
 * 经 app.ts 挂载到 'ishellLlm' IPC 通道（ProxyChannel）。
 */
export class LlmMainService extends Disposable implements IIshellLlmService {

	declare readonly _serviceBrand: undefined;

	private readonly store: LlmModelStore;
	private readonly logStore: LlmLogStore;
	private readonly llamaServer: LlamaServerController;
	private readonly gateway: LlmApiGateway;
	private readonly providers = new Map<string, ILlmChatProvider>();

	private readonly dataDir: string;
	private readonly binDir: string;

	private loaded: Promise<void>;
	private engineInfo: ILlmEngineInfo = { state: 'missing' };
	private runningModel: ILlmModelRecord | undefined;
	private readonly downloads = new Map<string, IDownloadState>();
	private readonly chatRequests = new Map<string, AbortController>();

	private readonly _onDidChangeModels = new Emitter<void>();
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidDownloadProgress = new Emitter<ILlmDownloadProgress>();
	readonly onDidDownloadProgress: Event<ILlmDownloadProgress> = this._onDidDownloadProgress.event;

	private readonly _onDidChangeEngine = new Emitter<ILlmEngineInfo>();
	readonly onDidChangeEngine: Event<ILlmEngineInfo> = this._onDidChangeEngine.event;

	private readonly _onDidChatChunk = new Emitter<ILlmChatChunkEvent>();
	readonly onDidChatChunk: Event<ILlmChatChunkEvent> = this._onDidChatChunk.event;

	private readonly _onDidAppendLog = new Emitter<ILlmLogEntry>();
	readonly onDidAppendLog: Event<ILlmLogEntry> = this._onDidAppendLog.event;

	private readonly _onDidChangeSkills = new Emitter<void>();
	readonly onDidChangeSkills: Event<void> = this._onDidChangeSkills.event;

	// iShell 工程能力：模型产物持久化 / Skill 注册 / 代码版本历史
	private artifactStore: LlmArtifactStore | undefined;
	private readonly skillRegistry: LlmSkillRegistry;
	private readonly codeHistory: LlmCodeHistoryStore;
	private skillsLoaded = false;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.dataDir = join(environmentMainService.userDataPath, 'ishell', 'llm');
		this.binDir = join(this.dataDir, 'bin');
		this.store = new LlmModelStore(new LlmFileIO(join(this.dataDir, 'llm.json')));
		this.logStore = this._register(new LlmLogStore());

		const log = (level: LlmLogLevel, source: LlmLogSource, message: string) => {
			this.logStore.log(level, source, message);
			this.logService[level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'](`[ishell-llm] [${source}] ${message}`);
		};
		this._register(this.logStore.onDidAppendLog(e => this._onDidAppendLog.fire(e)));

		this.llamaServer = this._register(new LlamaServerController(log));
		this.gateway = this._register(new LlmApiGateway(log));

		// 对话 Provider 注册表（'local' 先行；云端未来注册即接入）
		const localProvider = new LocalChatProvider(() => this.gateway.port);
		this.providers.set(localProvider.id, localProvider);

		// iShell 工程能力初始化（Skill 注册 / 代码版本历史）
		this.skillRegistry = this._register(new LlmSkillRegistry(join(this.dataDir, 'skills'), join(this.dataDir, 'skills-registered.json')));
		this._register(this.skillRegistry.onDidChange(() => this._onDidChangeSkills.fire()));
		this.codeHistory = new LlmCodeHistoryStore(join(this.dataDir, 'versions'));

		this._register(this.llamaServer.onDidExit(({ code }) => {
			if (this.engineInfo.state === 'running' || this.engineInfo.state === 'starting') {
				this.gateway.stop();
				const crashed = code !== 0 && code !== null;
				this.setEngineState(crashed ? 'crashed' : 'stopped', crashed ? `引擎进程异常退出（code ${code}）` : undefined);
				this.runningModel = undefined;
			}
		}));

		this._register(lifecycleMainService.onWillShutdown(() => {
			this.gateway.stop();
			this.llamaServer.dispose();
			for (const cts of this.downloads.values()) {
				cts.cts.cancel();
			}
		}));

		this.loaded = this.loadInitialData();
	}

	private async loadInitialData(): Promise<void> {
		try {
			await this.store.load();
		} catch (err) {
			this.logStore.error('system', `llm.json 加载失败：${(err as Error).message}`);
		}
		try {
			await this.skillRegistry.load();
			this.skillsLoaded = true;
		} catch (err) {
			this.logStore.error('system', `Skill 注册表加载失败：${(err as Error).message}`);
		}
		await this.refreshEngineState();
	}

	private async refreshEngineState(): Promise<void> {
		if (this.llamaServer.running) {
			return; // 运行中状态不覆盖
		}
		const customPath = this.configurationService.getValue<string>('ishell.llm.enginePath');
		let enginePath: string | undefined;
		try {
			enginePath = customPath && customPath.trim() !== '' ? customPath : await findEngineExe(this.binDir);
		} catch (err) {
			this.logStore.error('system', `引擎探测失败：${(err as Error).message}`);
		}
		if (enginePath) {
			this.engineInfo = {
				state: 'ready',
				enginePath,
				version: this.store.getEngineVersion() || undefined,
			};
		} else {
			this.engineInfo = { state: 'missing' };
		}
		this._onDidChangeEngine.fire(this.getEngineSnapshot());
	}

	private setEngineState(state: LlmEngineState, detail?: string): void {
		this.engineInfo = {
			...this.engineInfo,
			state,
			detail,
			runningModelId: state === 'running' ? this.runningModel?.id : undefined,
			runningModelName: state === 'running' ? this.runningModel?.name : undefined,
			apiBaseUrl: state === 'running' && this.gateway.port ? `http://127.0.0.1:${this.gateway.port}` : undefined,
		};
		this._onDidChangeEngine.fire(this.getEngineSnapshot());
	}

	private getEngineSnapshot(): ILlmEngineInfo {
		return { ...this.engineInfo };
	}

	private get modelsDir(): string {
		const configured = this.configurationService.getValue<string>('ishell.llm.modelDirectory');
		return configured && configured.trim() !== '' ? configured : join(this.dataDir, 'models');
	}

	// ==== 目录与推荐 ====

	async getModelCatalog(): Promise<ILlmModelCatalogEntry[]> {
		return LLM_MODEL_CATALOG;
	}

	async getSystemInfo(): Promise<ILlmSystemInfo> {
		return getLlmSystemInfo();
	}

	async searchNetworkModels(query: string): Promise<ILlmNetworkModel[]> {
		await this.loaded;
		return fetchNetworkModels(query, this.store.getSource());
	}

	// ==== 下载源 ====

	async getSource(): Promise<ILlmSourceConfig> {
		await this.loaded;
		return this.store.getSource();
	}

	async setSource(kind: LlmSourceKind, customEndpoint?: string): Promise<ILlmSourceConfig> {
		await this.loaded;
		const source = await this.store.setSource(kind, customEndpoint);
		this.logStore.info('system', `模型下载源已切换：${source.name}（${source.endpoint}）`);
		return source;
	}

	async setEngineChannel(channel: 'direct' | 'ghproxy'): Promise<void> {
		await this.loaded;
		await this.store.setEngineChannel(channel);
		this.logStore.info('system', `引擎下载通道已切换：${channel === 'direct' ? 'GitHub 直连' : 'gh-proxy.com 加速'}`);
	}

	// ==== 模型管理 ====

	async getModels(): Promise<ILlmModelRecord[]> {
		await this.loaded;
		return this.store.getModels();
	}

	async downloadModel(catalogId: string): Promise<void> {
		await this.loaded;
		const entry = getCatalogEntry(catalogId);
		if (!entry) {
			throw new Error(`未知模型：${catalogId}`);
		}
		if (this.store.getModelByCatalogId(catalogId)) {
			throw new Error(`模型已下载：${entry.name}`);
		}
		if (this.downloads.has(catalogId)) {
			throw new Error(`模型正在下载中：${entry.name}`);
		}

		const source = this.store.getSource();
		const url = `${source.endpoint}/${entry.repo}/resolve/main/${entry.file}`;
		const destPath = join(this.modelsDir, `${catalogId}.gguf`);

		const { promise } = this.runDownload('model', catalogId, url, destPath, entry.name);
		const stat = await promise;
		await this.store.addModel({
			catalogId,
			name: entry.name,
			filePath: destPath,
			sizeBytes: stat.size,
		});
		this.logStore.info('model-download', `模型下载完成：${entry.name}（${formatBytes(stat.size)}）`);
		this._onDidChangeModels.fire();
	}

	async cancelDownload(id: string): Promise<void> {
		const state = this.downloads.get(id);
		if (state) {
			state.cts.cancel();
		}
	}

	async deleteModel(modelId: string): Promise<void> {
		await this.loaded;
		if (this.runningModel?.id === modelId) {
			await this.stopModel();
		}
		const removed = await this.store.removeModel(modelId);
		if (removed) {
			await fsp.rm(removed.filePath, { force: true });
			this.logStore.info('model-download', `模型已删除：${removed.name}（${removed.filePath}）`);
			this._onDidChangeModels.fire();
		}
	}

	// ==== 引擎 ====

	async getEngineInfo(): Promise<ILlmEngineInfo> {
		await this.loaded;
		return this.getEngineSnapshot();
	}

	async downloadEngine(): Promise<void> {
		await this.loaded;
		if (this.downloads.has('engine')) {
			throw new Error('引擎正在下载中');
		}
		if (this.engineInfo.enginePath && this.engineInfo.state !== 'missing') {
			throw new Error('引擎已安装，无需重复下载');
		}

		const channel = this.store.getEngineChannel();
		this.setEngineState('downloading', `下载通道：${channel === 'direct' ? 'GitHub 直连' : 'gh-proxy 加速'}`);
		this.logStore.info('engine-download', `开始下载 llama-server 引擎（${channel === 'direct' ? 'GitHub 直连' : 'gh-proxy.com 加速'}）`);

		const downloadStartedAt = Date.now();
		const { promise } = this.runDownload('engine', 'engine', '', '', 'llama-server', async () => {
			const asset = await installEngine({
				channel,
				binDir: this.binDir,
				onProgress: (received, total) => {
					const elapsed = (Date.now() - downloadStartedAt) / 1000;
					this.fireProgress('engine', 'engine', 'downloading', received, total, elapsed > 0.5 ? Math.round(received / elapsed) : 0);
				},
				token: this.downloads.get('engine')?.cts.token,
			});
			return { size: asset.sizeBytes, enginePath: asset.enginePath, version: asset.version };
		});

		try {
			const result = await promise;
			await this.store.setEngineVersion(result.version);
			this.engineInfo = { state: 'ready', enginePath: result.enginePath, version: result.version };
			this._onDidChangeEngine.fire(this.getEngineSnapshot());
			this.logStore.info('engine-download', `引擎安装完成：${result.version}（${result.enginePath}）`);
		} catch (err) {
			const canceled = this.downloads.get('engine')?.cts.token.isCancellationRequested;
			this.setEngineState('missing', canceled ? undefined : (err as Error).message);
			throw err;
		}
	}

	/** 统一下载执行（进度事件 + 取消 + 状态清理） */
	private runDownload(
		kind: 'engine' | 'model',
		id: string,
		url: string,
		destPath: string,
		label: string,
		customRun?: () => Promise<{ size: number; enginePath: string; version: string }>,
	): { promise: Promise<{ size: number; enginePath: string; version: string }> } {
		const cts = new CancellationTokenSource();
		const startedAt = Date.now();
		this.downloads.set(id, { cts, startedAt });

		const promise = (async () => {
			if (customRun) {
				return customRun();
			}
			let lastReceived = 0;
			let lastTime = startedAt;
			let receivedAtLastSample = 0;
			let speed = 0;
			await downloadFile({
				url,
				destPath,
				onProgress: (received, total) => {
					const now = Date.now();
					if (now - lastTime >= 1000) {
						speed = Math.round((received - receivedAtLastSample) / ((now - lastTime) / 1000));
						lastTime = now;
						receivedAtLastSample = received;
					}
					lastReceived = received;
					this.fireProgress(kind, id, 'downloading', received, total, speed);
				},
				token: cts.token,
			});
			return { size: lastReceived, enginePath: '', version: '' };
		})();

		promise.then(
			result => {
				this.downloads.delete(id);
				this.fireProgress(kind, id, 'completed', result.size, result.size, 0);
			},
			err => {
				this.downloads.delete(id);
				const canceled = cts.token.isCancellationRequested;
				this.fireProgress(kind, id, canceled ? 'canceled' : 'failed', 0, 0, 0, canceled ? undefined : (err as Error).message);
				this.logStore[canceled ? 'info' : 'error'](kind === 'engine' ? 'engine-download' : 'model-download', `${label} 下载${canceled ? '已取消' : `失败：${(err as Error).message}`}`);
			},
		);

		return { promise };
	}

	private fireProgress(kind: 'engine' | 'model', id: string, state: ILlmDownloadProgress['state'], receivedBytes: number, totalBytes: number, speedBytesPerSec: number, error?: string): void {
		this._onDidDownloadProgress.fire({ id, kind, state, receivedBytes, totalBytes, speedBytesPerSec, error });
	}

	// ==== 运行 ====

	async startModel(modelId: string): Promise<void> {
		await this.loaded;
		if (this.llamaServer.running || this.engineInfo.state === 'starting') {
			throw new Error('已有模型在运行，请先停止');
		}
		const model = this.store.getModels().find(m => m.id === modelId);
		if (!model) {
			throw new Error(`模型记录不存在：${modelId}`);
		}
		await this.refreshEngineState();
		if (this.engineInfo.state !== 'ready' || !this.engineInfo.enginePath) {
			throw new Error(this.engineInfo.detail ?? '引擎未就绪，请先下载 llama-server 引擎');
		}
		try {
			await fsp.access(model.filePath);
		} catch {
			throw new Error(`模型文件不存在：${model.filePath}`);
		}

		this.runningModel = model;
		this.setEngineState('starting', `加载模型 ${model.name}…`);
		this.logStore.info('engine', `开始加载模型：${model.name}`);

		try {
			const internalPort = await this.llamaServer.start({
				enginePath: this.engineInfo.enginePath,
				modelPath: model.filePath,
				modelName: model.name,
				contextSize: this.configurationService.getValue<number>('ishell.llm.contextSize') ?? 4096,
				gpuLayers: this.configurationService.getValue<number>('ishell.llm.gpuLayers') ?? 0,
			});
			const preferredPort = this.configurationService.getValue<number>('ishell.llm.apiPort') ?? 1234;
			const gatewayPort = await this.gateway.start(preferredPort, internalPort, model.name);
			this.setEngineState('running');
			this.logStore.info('gateway', `本地 API 已就绪：http://127.0.0.1:${gatewayPort}/v1（OpenAI 兼容，模型 ${model.name}）`);
		} catch (err) {
			this.gateway.stop();
			this.runningModel = undefined;
			this.setEngineState('ready', `启动失败：${(err as Error).message}`);
			this.logStore.error('engine', `模型启动失败：${(err as Error).message}`);
			throw err;
		}
	}

	async stopModel(): Promise<void> {
		if (!this.llamaServer.running && this.engineInfo.state !== 'starting') {
			return;
		}
		const name = this.runningModel?.name ?? '模型';
		this.gateway.stop();
		await this.llamaServer.stop();
		this.runningModel = undefined;
		this.setEngineState('stopped');
		this.logStore.info('engine', `模型已停止：${name}`);
	}

	// ==== 对话 ====

	async sendChat(messages: ILlmChatMessage[], sessionId?: string): Promise<string> {
		const provider = this.providers.get('local');
		if (!provider) {
			throw new Error('无可用对话 Provider');
		}
		if (!(await provider.isReady())) {
			throw new Error('本地模型未运行，请先启动模型');
		}
		const requestId = generateUuid();
		const controller = new AbortController();
		const sessionKey = sessionId && sessionId.trim() !== '' ? sessionId : 'adhoc';
		this.chatRequests.set(requestId, controller);
		this.logStore.info('chat', `发送对话（${messages.length} 条消息）`);

		let full = '';
		provider.chatStream(
			messages,
			delta => {
				full += delta;
				this._onDidChatChunk.fire({ requestId, delta, done: false });
			},
			controller.signal,
		).then(
			() => this._onDidChatChunk.fire({ requestId, done: true }),
			err => {
				this.logStore.error('chat', `对话失败：${(err as Error).message}`);
				this._onDidChatChunk.fire({ requestId, done: true, error: (err as Error).message });
			},
		).finally(() => {
			this.chatRequests.delete(requestId);
			// 模型产物自动持久化（功能 1）：无论成败，已生成内容均落盘
			void this.persistChatOutput(messages, sessionKey, requestId, full, this.engineInfo.runningModelName)
				.catch(err => this.logStore.error('chat', `产物持久化失败：${(err as Error).message}`));
		});

		return requestId;
	}

	async cancelChat(requestId: string): Promise<void> {
		this.chatRequests.get(requestId)?.abort();
	}

	/** 对话产物持久化：转录 + 代码块（按配置） */
	private async persistChatOutput(messages: ILlmChatMessage[], sessionKey: string, requestId: string, assistantText: string, modelName: string | undefined): Promise<void> {
		if (assistantText.trim() === '') {
			return;
		}
		const options = await this.getPersistOptions();
		if (!options.enabled) {
			return;
		}
		const store = await this.ensureArtifactStore();
		const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '(无用户输入)';
		const firstLine = lastUser.trim().split('\n')[0].slice(0, 60);
		await store.save({
			kind: 'chat-transcript',
			sessionId: sessionKey,
			requestId,
			title: firstLine,
			ext: '.md',
			content: renderTranscriptText(messages, assistantText, sessionKey, requestId, modelName),
		});
		if (options.includeCodeBlocks) {
			for (const block of extractCodeBlocks(assistantText)) {
				if (block.content.trim() === '') {
					continue;
				}
				await store.save({
					kind: 'code-block',
					sessionId: sessionKey,
					requestId,
					title: `${block.language || 'code'} 片段：${block.content.trim().split('\n')[0].slice(0, 40)}`,
					ext: languageExtOf(block.language),
					content: block.content,
				});
			}
		}
		this.logStore.info('chat', `对话产物已持久化：${options.resolvedDir}`);
	}

	/** 产物根目录：配置覆盖 > 默认 userData/ishell/llm/artifacts */
	private resolveArtifactRoot(): string {
		const configured = this.configurationService.getValue<string>('ishell.llm.persistence.path');
		const trimmed = (configured ?? '').trim();
		return trimmed !== '' ? trimmed : join(this.dataDir, 'artifacts');
	}

	private async ensureArtifactStore(): Promise<LlmArtifactStore> {
		const root = this.resolveArtifactRoot();
		if (!this.artifactStore || this.artifactStore.rootDir !== root) {
			this.artifactStore = new LlmArtifactStore(root);
		}
		this.artifactStore.setNamingRule(this.configurationService.getValue<string>('ishell.llm.persistence.namingRule') ?? '');
		return this.artifactStore;
	}

	// ==== 模型产物持久化（功能 1） ====

	async getPersistOptions(): Promise<ILlmPersistOptions> {
		return {
			enabled: this.configurationService.getValue<boolean>('ishell.llm.persistence.enabled') ?? true,
			path: this.configurationService.getValue<string>('ishell.llm.persistence.path') ?? '',
			resolvedDir: this.resolveArtifactRoot(),
			namingRule: this.configurationService.getValue<string>('ishell.llm.persistence.namingRule') ?? '',
			includeCodeBlocks: this.configurationService.getValue<boolean>('ishell.llm.persistence.includeCodeBlocks') ?? true,
		};
	}

	async getArtifacts(sessionId?: string): Promise<ILlmArtifactMeta[]> {
		const store = await this.ensureArtifactStore();
		return store.list(sessionId);
	}

	async openArtifactsFolder(): Promise<string | undefined> {
		const root = this.resolveArtifactRoot();
		await fsp.mkdir(root, { recursive: true });
		await shell.openPath(root);
		return root;
	}

	// ==== 智能补全（功能 5） ====

	async sendCompletion(options: ILlmCompletionOptions): Promise<string> {
		if (!this.gateway.running) {
			throw new Error('本地模型未运行，无法补全');
		}
		const configuredMaxTokens = this.configurationService.getValue<number>('ishell.llm.completion.maxTokens') ?? 96;
		const maxTokens = Math.max(16, Math.min(512, Math.floor(options.maxTokens ?? configuredMaxTokens)));
		const system = '你是代码补全引擎。根据已有代码继续编写光标处应插入的代码。只输出接下来要插入的代码本身：不要解释、不要 Markdown 围栏、不要重复已有代码。保持与现有代码一致的缩进、命名与风格。';
		const userParts: string[] = [];
		userParts.push(options.filePath ? `文件：${options.filePath}（语言：${options.language || '未知'}）` : `语言：${options.language || '未知'}`);
		userParts.push('光标前代码：', '<prefix>', options.prefix, '</prefix>');
		if (options.suffix.trim() !== '') {
			userParts.push('光标后代码（保持衔接，不要重复输出这部分）：', '<suffix>', options.suffix, '</suffix>');
		}
		userParts.push('请输出 <prefix> 之后光标处应插入的代码：');
		try {
			return await this.chatOnce(
				[{ role: 'system', content: system }, { role: 'user', content: userParts.join('\n') }],
				maxTokens, 0.2, 8000,
			);
		} catch (err) {
			throw new Error(`补全失败：${(err as Error).message}`);
		}
	}

	/** 非流式单轮对话（补全 / 自动修复共用；超时中断） */
	private async chatOnce(messages: ILlmChatMessage[], maxTokens: number, temperature: number, timeoutMs: number): Promise<string> {
		if (!this.gateway.running) {
			throw new Error('本地模型未运行');
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`http://127.0.0.1:${this.gateway.port}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'local',
					messages,
					stream: false,
					max_tokens: maxTokens,
					temperature,
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`网关返回 ${response.status}`);
			}
			const data = await response.json() as { choices?: { message?: { content?: string } }[] };
			const content = data.choices?.[0]?.message?.content;
			if (typeof content !== 'string' || content.trim() === '') {
				throw new Error('模型未返回内容');
			}
			return content;
		} finally {
			clearTimeout(timer);
		}
	}

	// ==== 模型自动修复（诊断联动，"让模型自己改代码"） ====

	async applyModelFix(options: ILlmFixOptions): Promise<string> {
		const configuredMaxTokens = this.configurationService.getValue<number>('ishell.llm.fix.maxTokens') ?? 2048;
		const maxTokens = Math.max(128, Math.min(8192, Math.floor(options.maxTokens ?? configuredMaxTokens)));
		const system = '你是代码修复引擎。根据现有代码与问题清单完成修复，只输出修复后的完整代码：不要解释、不要 Markdown 围栏；除解决问题所必需的改动外，其余内容必须逐字保留（保持缩进、命名、注释与风格）。';
		const userParts: string[] = [`语言：${options.language || '未知'}`];
		if (options.problems.length > 0) {
			userParts.push('问题清单：');
			options.problems.forEach((p, i) => userParts.push(`${i + 1}. ${p}`));
		}
		userParts.push(`修复要求：${options.instruction}`);
		userParts.push('现有代码：', '<code>', options.content, '</code>');
		userParts.push('请输出修复后的完整代码：');
		const raw = await this.chatOnce(
			[{ role: 'system', content: system }, { role: 'user', content: userParts.join('\n') }],
			maxTokens, 0.1, 60000,
		);
		const blocks = extractCodeBlocks(raw);
		const fixed = blocks.length > 0 ? blocks[0].content : raw.trim();
		if (fixed === '') {
			throw new Error('模型返回内容为空');
		}
		return fixed;
	}

	// ==== 静态诊断（功能 4） ====

	async analyzeCode(content: string, language: string, path?: string): Promise<ILlmDiagnosticReport> {
		const report = analyzeDiagnostics(content, language, path);
		// 诊断报告自动归档为产物（含问题明细与修复建议）
		if (report.diagnostics.length > 0) {
			try {
				const options = await this.getPersistOptions();
				if (options.enabled) {
					const store = await this.ensureArtifactStore();
					await store.save({
						kind: 'diagnostic-report',
						sessionId: 'diagnostics',
						requestId: report.createdAt.toString(36),
						title: `诊断报告：${path ?? language}`,
						ext: '.md',
						content: renderDiagnosticReportText(report),
					});
				}
			} catch (err) {
				this.logStore.warn('system', `诊断报告归档失败：${(err as Error).message}`);
			}
		}
		return report;
	}

	// ==== Skill 注册体系（功能 6） ====

	async getSkills(): Promise<ILlmSkillManifest[]> {
		if (!this.skillsLoaded) {
			await this.skillRegistry.load();
			this.skillsLoaded = true;
		}
		return this.skillRegistry.list();
	}

	async registerSkill(registration: ILlmSkillRegistration): Promise<ILlmSkillManifest> {
		if (!this.skillsLoaded) {
			await this.skillRegistry.load();
			this.skillsLoaded = true;
		}
		const manifest = await this.skillRegistry.register(registration);
		this.logStore.info('system', `Skill 已注册：${manifest.id}（${manifest.name}）`);
		return manifest;
	}

	async setSkillEnabled(id: string, enabled: boolean): Promise<ILlmSkillManifest> {
		if (!this.skillsLoaded) {
			await this.skillRegistry.load();
			this.skillsLoaded = true;
		}
		const manifest = await this.skillRegistry.setEnabled(id, enabled);
		this.logStore.info('system', `Skill ${enabled ? '已启用' : '已停用'}：${manifest.id}`);
		return manifest;
	}

	async unregisterSkill(id: string): Promise<void> {
		await this.skillRegistry.unregister(id);
		this.logStore.info('system', `Skill 已卸载：${id}`);
	}

	async openSkillsFolder(): Promise<string | undefined> {
		await fsp.mkdir(this.skillRegistry.skillsDir, { recursive: true });
		await shell.openPath(this.skillRegistry.skillsDir);
		return this.skillRegistry.skillsDir;
	}

	// ==== 代码版本历史（功能 3） ====

	async recordFileVersion(filePath: string, content: string): Promise<ILlmFileVersion | undefined> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.autoSave.enabled') ?? true;
		if (!enabled) {
			return undefined; // 关闭版本历史：写盘继续，但冲突场景无法自动合并
		}
		const limit = this.configurationService.getValue<number>('ishell.llm.autoSave.historyLimit') ?? 20;
		this.codeHistory.setLimitPerFile(limit);
		return this.codeHistory.record(filePath, content);
	}

	async getFileVersions(filePath: string): Promise<ILlmFileVersion[]> {
		return this.codeHistory.list(filePath);
	}

	async readFileVersion(versionId: string): Promise<string | undefined> {
		return this.codeHistory.read(versionId);
	}


	// ==== 日志 ====

	async getLogs(sinceSeq?: number): Promise<ILlmLogEntry[]> {
		return this.logStore.getEntries(sinceSeq);
	}

	async clearLogs(): Promise<void> {
		this.logStore.clear();
		this.logStore.info('system', '日志已清空');
	}

	async exportLogs(): Promise<string | undefined> {
		const result = await this.dialogMainService.showSaveDialog({
			title: '导出 iShell 运行日志',
			defaultPath: `ishell-llm-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`,
			filters: [{ name: '文本文件', extensions: ['txt', 'log'] }],
		});
		if (result.canceled || !result.filePath) {
			return undefined;
		}
		await fsp.writeFile(result.filePath, this.logStore.exportText(), 'utf8');
		this.logStore.info('system', `日志已导出：${result.filePath}`);
		return result.filePath;
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	}
	if (bytes >= 1024 ** 2) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	}
	return `${Math.round(bytes / 1024)} KB`;
}

/** 语言标识 → 产物文件扩展名 */
function languageExtOf(language: string): string {
	const map: Record<string, string> = {
		typescript: '.ts', typescriptreact: '.tsx', javascript: '.js', javascriptreact: '.jsx',
		python: '.py', go: '.go', rust: '.rs', java: '.java', c: '.c', cpp: '.cpp', csharp: '.cs',
		php: '.php', ruby: '.rb', kotlin: '.kt', swift: '.swift', shellscript: '.sh', bash: '.sh',
		sh: '.sh', powershell: '.ps1', sql: '.sql', json: '.json', yaml: '.yml', html: '.html',
		css: '.css', markdown: '.md', xml: '.xml', toml: '.toml', vue: '.vue',
	};
	if (map[language]) {
		return map[language];
	}
	const safe = language.replace(/[^\w]/g, '');
	return safe !== '' ? `.${safe}` : '.txt';
}

/** 渲染对话转录 Markdown */
function renderTranscriptText(messages: ILlmChatMessage[], assistantText: string, sessionKey: string, requestId: string, modelName: string | undefined): string {
	const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '(无用户输入)';
	return [
		'# iShell 本地模型对话记录',
		'',
		`- 时间：${new Date().toISOString()}`,
		`- 会话：\`${sessionKey}\``,
		`- 请求：\`${requestId}\``,
		modelName ? `- 模型：${modelName}` : '- 模型：iShell 本地引擎',
		'',
		'## 用户',
		'',
		lastUser,
		'',
		'## 助手',
		'',
		assistantText,
		'',
	].join('\n');
}

/** 渲染诊断报告 Markdown（明细表 + 修复建议） */
function renderDiagnosticReportText(report: ILlmDiagnosticReport): string {
	const severityLabel: Record<string, string> = { error: '错误', warning: '警告', info: '提示', hint: '建议' };
	const categoryLabel: Record<string, string> = { syntax: '语法', logic: '逻辑', bug: '缺陷', performance: '性能', style: '风格' };
	const lines: string[] = [
		'# iShell 代码诊断报告',
		'',
		`- 时间：${new Date(report.createdAt).toISOString()}`,
		report.uri ? `- 目标：\`${report.uri}\`` : `- 语言：${report.language}`,
		`- 结果：错误 ${report.summary.errors} / 警告 ${report.summary.warnings} / 提示 ${report.summary.infos} / 建议 ${report.summary.hints}，质量评分 **${report.summary.score}**`,
		'',
	];
	if (report.diagnostics.length > 0) {
		lines.push('| 严重度 | 类别 | 行 | 规则 | 问题 | 修复建议 |', '| --- | --- | --- | --- | --- | --- |');
		for (const d of report.diagnostics) {
			const rule = d.ruleId.replace(/\|/g, '/');
			const msg = d.message.replace(/\|/g, '/');
			const sug = d.suggestion.replace(/\|/g, '/');
			lines.push(`| ${severityLabel[d.severity]} | ${categoryLabel[d.category]} | ${d.line} | ${rule} | ${msg} | ${sug} |`);
		}
		lines.push('');
	}
	if (report.suggestions.length > 0) {
		lines.push('## 总体修复建议', '');
		for (const s of report.suggestions) {
			lines.push(`- ${s}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}
