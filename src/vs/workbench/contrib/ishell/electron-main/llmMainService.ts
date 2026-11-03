/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fsp } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { shell } from 'electron';
import { timeout } from '../../../../base/common/async.js';
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
	ILlmLogEntry, ILlmModelCatalogEntry, ILlmModelParams, ILlmModelRecord, ILlmSourceConfig, ILlmSystemInfo, ILlmNetworkModel,
	ILlmNetworkFile, networkModelCatalogId,
	IIshellLlmService, LlmEngineState, LlmLogLevel, LlmLogSource, LlmSourceKind,
	ILlmArtifactMeta, ILlmPersistOptions, ILlmCompletionOptions, ILlmDiagnosticReport, ILlmFixOptions,
	ILlmSkillManifest, ILlmSkillRegistration, ILlmFileVersion, detectDegenerateRepetition,
	ILlmMusicRequest, ILlmMusicProgress, ILlmMusicResult, ILlmAudioEngineInfo, resolveModelKind
} from '../common/llm.js';
import { extractCodeBlocks } from '../common/llmInstructions.js';
import { IFileIO } from '../node/connectionStore.js';
import { getCatalogEntry, getLlmSystemInfo, LLM_MODEL_CATALOG } from '../node/llmCatalog.js';
import { fetchNetworkModelFiles, fetchNetworkModels, isAuxiliaryGgufFile } from '../node/llmNetworkSearch.js';
import { downloadFile } from '../node/llmDownloader.js';
import { findEngineExe, installEngine } from '../node/llmEngine.js';
import { findAudioEngineExe, installAudioEngine } from '../node/audioEngine.js';
import { buildMusicArgs, prepareMusicModel } from '../node/audioMusic.js';
import { LlmApiGateway } from '../node/llmApiGateway.js';
import { LocalChatProvider } from '../node/llmChatProvider.js';
import { LlmLogStore } from '../node/llmLog.js';
import { LlmModelStore, MIRROR_ENDPOINT, MODELSCOPE_ENDPOINT, OFFICIAL_ENDPOINT } from '../node/llmModelStore.js';
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

	// 音乐生成（audio.cpp）：引擎状态 + 进行中的生成任务
	private audioEngineInfo: ILlmAudioEngineInfo = { state: 'missing' };
	private readonly musicRequests = new Map<string, {
		child?: ChildProcessWithoutNullStreams;
		modelName: string;
		startedAt: number;
		outPath: string;
		cts: CancellationTokenSource;
	}>();
	/** 所有已启动的音乐引擎进程：跨请求跟踪，保证同一时刻只有一个引擎占用内存 */
	private readonly musicChildren = new Set<ChildProcessWithoutNullStreams>();

	private readonly _onDidChangeModels = new Emitter<void>();
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidDownloadProgress = new Emitter<ILlmDownloadProgress>();
	readonly onDidDownloadProgress: Event<ILlmDownloadProgress> = this._onDidDownloadProgress.event;

	private readonly _onDidChangeEngine = new Emitter<ILlmEngineInfo>();
	readonly onDidChangeEngine: Event<ILlmEngineInfo> = this._onDidChangeEngine.event;

	private readonly _onDidChangeSource = new Emitter<ILlmSourceConfig>();
	readonly onDidChangeSource: Event<ILlmSourceConfig> = this._onDidChangeSource.event;

	private readonly _onDidChatChunk = new Emitter<ILlmChatChunkEvent>();
	readonly onDidChatChunk: Event<ILlmChatChunkEvent> = this._onDidChatChunk.event;

	private readonly _onDidMusicProgress = new Emitter<ILlmMusicProgress>();
	readonly onDidMusicProgress: Event<ILlmMusicProgress> = this._onDidMusicProgress.event;

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
			for (const request of this.musicRequests.values()) {
				request.cts.cancel();
				this.terminateMusicChild(request.child);
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
		await this.loaded;
		// 预置目录 + 网络下载模型（从已下载记录反推目录项，让它们以同样的卡片展示、可启动/删除）
		const known = new Set(LLM_MODEL_CATALOG.map(entry => entry.id));
		const dynamic = this.store.getModels()
			.filter(record => !known.has(record.catalogId))
			.map((record): ILlmModelCatalogEntry => {
				const isModelScope = record.source === 'modelscope';
				const vendorId = isModelScope ? 'modelscope' : 'huggingface';
				const vendorName = isModelScope ? '魔搭 ModelScope' : 'HuggingFace';
				return {
					id: record.catalogId,
					name: record.name,
					vendorId,
					vendorName,
					repo: record.repo ?? '',
					file: record.file ?? '',
					sizeBytes: record.sizeBytes,
					description: record.description ?? (record.repo ? `网络模型 · ${record.repo}` : '网络模型'),
					minRamGb: record.minRamGb ?? Math.max(4, Math.ceil((record.sizeBytes / 1024 ** 3) * 1.3)),
					tags: [resolveModelKind(record)],
				};
			});
		return [...LLM_MODEL_CATALOG, ...dynamic];
	}

	async getSystemInfo(): Promise<ILlmSystemInfo> {
		return getLlmSystemInfo();
	}

	async searchNetworkModels(query: string, page = 0): Promise<ILlmNetworkModel[]> {
		await this.loaded;
		return fetchNetworkModels(query, this.store.getSource(), page);
	}

	async listNetworkModelFiles(repoId: string): Promise<ILlmNetworkFile[]> {
		await this.loaded;
		return fetchNetworkModelFiles(repoId, this.store.getSource());
	}

	/** 下载网络仓库中的指定 GGUF：进度 id 与目录 id 均为 networkModelCatalogId(repo,file) */
	async downloadNetworkModel(repoId: string, file: string): Promise<void> {
		await this.loaded;
		const catalogId = networkModelCatalogId(repoId, file);
		if (this.store.getModelByCatalogId(catalogId)) {
			throw new Error(`模型已下载：${repoId}`);
		}
		if (this.downloads.has(catalogId)) {
			throw new Error(`模型正在下载中：${repoId}`);
		}

		const source = this.store.getSource();
		// HF 直链：endpoint/{repo}/resolve/main/{file}；魔搭走 repo?FilePath= 形式（302 跳转 CDN）
		const fileUrl = (endpoint: string) => `${endpoint}/${repoId}/resolve/main/${file}`;
		const repoPath = repoId.split('/').map(segment => encodeURIComponent(segment)).join('/');
		let urls: string[];
		if (source.kind === 'modelscope') {
			urls = [`${MODELSCOPE_ENDPOINT}/api/v1/models/${repoPath}/repo?Revision=master&FilePath=${encodeURIComponent(file)}`];
		} else {
			urls = [fileUrl(source.endpoint)];
			if (source.kind === 'official') {
				urls.push(fileUrl(MIRROR_ENDPOINT));
			} else if (source.kind === 'mirror') {
				urls.push(fileUrl(OFFICIAL_ENDPOINT));
			}
		}
		const repoName = repoId.includes('/') ? repoId.slice(repoId.indexOf('/') + 1) : repoId;
		const quant = (/i?q\d+[_a-z0-9]*|f16|bf16|f32|fp16/i.exec(file.replace(/\.gguf$/i, ''))?.[0] ?? '').toUpperCase();
		const label = `${repoName}${quant ? ` · ${quant}` : ''}`;
		const destPath = join(this.modelsDir, `${catalogId}.gguf`);

		const { promise } = this.runDownload('model', catalogId, urls, destPath, label);
		const stat = await promise;
		const sourceName = source.kind === 'modelscope' ? '魔搭 ModelScope' : 'HuggingFace';
		await this.store.addModel({
			catalogId,
			name: label,
			filePath: destPath,
			sizeBytes: stat.size,
			repo: repoId,
			file,
			description: `${sourceName} · ${repoId}`,
			minRamGb: Math.max(4, Math.ceil((stat.size / 1024 ** 3) * 1.3)),
			source: source.kind,
			kind: resolveModelKind({ repo: repoId, file, name: label, catalogId }),
		});
		this.logStore.info('model-download', `网络模型下载完成：${label}（${formatBytes(stat.size)}）`);
		this._onDidChangeModels.fire();
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
		this._onDidChangeSource.fire(source);
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
		// 预置目录均为 HuggingFace 仓库：魔搭源下改用镜像/官方候选，自定义源尊重用户配置
		const fileUrl = (endpoint: string) => `${endpoint}/${entry.repo}/resolve/main/${entry.file}`;
		let urls: string[];
		if (source.kind === 'modelscope') {
			urls = [fileUrl(MIRROR_ENDPOINT), fileUrl(OFFICIAL_ENDPOINT)];
		} else {
			urls = [fileUrl(source.endpoint)];
			if (source.kind === 'official') {
				urls.push(fileUrl(MIRROR_ENDPOINT));
			} else if (source.kind === 'mirror') {
				urls.push(fileUrl(OFFICIAL_ENDPOINT));
			}
		}
		const destPath = join(this.modelsDir, `${catalogId}.gguf`);

		const { promise } = this.runDownload('model', catalogId, urls, destPath, entry.name);
		const stat = await promise;
		await this.store.addModel({
			catalogId,
			name: entry.name,
			filePath: destPath,
			sizeBytes: stat.size,
			repo: entry.repo,
			file: entry.file,
			kind: resolveModelKind({ repo: entry.repo, file: entry.file, name: entry.name, catalogId }),
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
			if (resolveModelKind(removed) === 'music') {
				// 音乐模型目录含主文件链接、VAE 与 sidecars：一并清理
				await fsp.rm(join(this.modelsDir, 'music', removed.catalogId), { recursive: true, force: true });
			}
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
		const { promise } = this.runDownload('engine', 'engine', [], '', 'llama-server', async () => {
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

	/** 统一下载执行（进度事件 + 取消 + 状态清理 + 多源回退轮询） */
	private runDownload(
		kind: 'engine' | 'model',
		id: string,
		urls: string[],
		destPath: string,
		label: string,
		customRun?: () => Promise<{ size: number; enginePath: string; version: string }>,
	): { promise: Promise<{ size: number; enginePath: string; version: string }> } {
		const cts = new CancellationTokenSource();
		const startedAt = Date.now();
		this.downloads.set(id, { cts, startedAt });
		const logSource: LlmLogSource = kind === 'engine' ? 'engine-download' : 'model-download';

		const promise = (async () => {
			if (customRun) {
				return customRun();
			}
			let lastReceived = 0;
			let lastTime = startedAt;
			let receivedAtLastSample = 0;
			let speed = 0;
			const onProgress = (received: number, total: number) => {
				const now = Date.now();
				if (now - lastTime >= 1000) {
					speed = Math.round((received - receivedAtLastSample) / ((now - lastTime) / 1000));
					lastTime = now;
					receivedAtLastSample = received;
				}
				lastReceived = received;
				this.fireProgress(kind, id, 'downloading', received, total, speed);
			};
			// 候选源轮询：当前源（含其内部重试）失败后切换备用源；多源下进度连续累计展示
			let lastErr: Error | undefined;
			for (let i = 0; i < urls.length; i++) {
				if (cts.token.isCancellationRequested) {
					break;
				}
				try {
					await downloadFile({
						url: urls[i],
						destPath,
						onProgress,
						token: cts.token,
						maxRetries: 2,
						onRetry: (attempt, err) => this.logStore.warn(logSource, `${label} 下载重试（第 ${attempt} 次）：${err.message}`),
					});
					return { size: lastReceived, enginePath: '', version: '' };
				} catch (err) {
					lastErr = err as Error;
					if (cts.token.isCancellationRequested) {
						break;
					}
					if (i < urls.length - 1) {
						this.logStore.warn(logSource, `${label} 当前下载源失败（${(err as Error).message}），切换备用下载源重试`);
					}
				}
			}
			throw lastErr ?? new Error('下载失败');
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
				this.logStore[canceled ? 'info' : 'error'](logSource, `${label} 下载${canceled ? '已取消' : `失败：${(err as Error).message}`}`);
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
		const model = this.store.getModels().find(m => m.id === modelId);
		if (!model) {
			throw new Error(`模型记录不存在：${modelId}`);
		}
		// 音乐模型（Yue2 / audiocpp）不能走 llama-server：引导到音乐生成区
		if (resolveModelKind(model) === 'music') {
			const message = `「${model.name}」是音乐模型，请切换到「音乐生成」标签页生成音乐（llama-server 不支持 audiocpp 架构）`;
			this.logStore.error('music', message);
			throw new Error(message);
		}
		// 幂等：目标模型已在运行，直接视为成功（避免重复点击报错）
		if (this.engineInfo.state === 'running' && this.runningModel?.id === model.id) {
			return;
		}
		// 同一模型正在加载中（如重复点击「启动」）：等待其就绪，避免打断本次加载
		if (this.engineInfo.state === 'starting' && this.runningModel?.id === model.id) {
			const deadline = Date.now() + 5 * 60 * 1000;
			while (this.engineInfo.state === 'starting' && Date.now() < deadline) {
				await timeout(500);
			}
			return;
		}
		// 引擎单实例：切换模型时自动停止当前模型，而非要求用户先手动停止
		if (this.llamaServer.running || this.runningModel || this.engineInfo.state === 'starting') {
			this.logStore.info('engine', `切换模型：先停止当前运行的模型（${this.runningModel?.name ?? '加载中'}）`);
			await this.stopModel();
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
		// 辅助 GGUF（mmproj 视觉投影 / imatrix 量化校准）不是独立模型：提前拦截，避免引擎报晦涩的 CLIP 错误
		if (isAuxiliaryGgufFile(model.filePath)) {
			const message = `该文件是辅助 GGUF（视觉投影 mmproj / 量化校准 imatrix），不能作为主模型启动：${model.filePath}。请在本地模型列表中删除它，并重新下载仓库中的主模型文件。`;
			this.logStore.error('engine', message);
			throw new Error(message);
		}

		this.runningModel = model;
		this.setEngineState('starting', `加载模型 ${model.name}…`);
		this.logStore.info('engine', `开始加载模型：${model.name}`);

		try {
			const internalPort = await this.llamaServer.start({
				enginePath: this.engineInfo.enginePath,
				modelPath: model.filePath,
				modelName: model.name,
				// 优先使用该模型自身的参数配置，未配置字段回退全局默认
				contextSize: model.params?.contextSize ?? this.configurationService.getValue<number>('ishell.llm.contextSize') ?? 4096,
				gpuLayers: model.params?.gpuLayers ?? this.configurationService.getValue<number>('ishell.llm.gpuLayers') ?? 0,
				threads: model.params?.threads,
				batchSize: model.params?.batchSize,
				ubatchSize: model.params?.ubatchSize,
				flashAttention: model.params?.flashAttention,
				cacheTypeK: model.params?.cacheTypeK,
				cacheTypeV: model.params?.cacheTypeV,
			});
			const preferredPort = model.params?.apiPort ?? this.configurationService.getValue<number>('ishell.llm.apiPort') ?? 1234;
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

	async updateModelParams(modelId: string, params: ILlmModelParams): Promise<void> {
		await this.loaded;
		const updated = await this.store.updateModelParams(modelId, params);
		if (!updated) {
			throw new Error(`模型记录不存在：${modelId}`);
		}
		this._onDidChangeModels.fire();
		const p = updated.params ?? {};
		this.logStore.info('engine', `已更新模型参数：${updated.name}（上下文 ${p.contextSize ?? '默认'} · GPU 层 ${p.gpuLayers ?? '默认'} · 线程 ${p.threads ?? '自动'} · 批处理 ${p.batchSize ?? '默认'} · Flash Attention ${p.flashAttention ?? '自动'} · 端口 ${p.apiPort ?? '默认'} · 温度 ${p.temperature ?? '默认'} · 最大输出 ${p.maxTokens ?? '默认'}）`);
		// 正在运行该模型：立即重新加载使新参数生效
		if (this.runningModel?.id === modelId) {
			this.logStore.info('engine', `模型 ${updated.name} 正在运行，参数变更后自动重新加载`);
			try {
				await this.stopModel();
			} catch {
				// 停止失败时仍尝试重新启动，由启动流程给出最终错误
			}
			await this.startModel(modelId);
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
		let finished = false;
		let lastRepetitionCheck = 0;
		const finish = (error?: string) => {
			if (finished) {
				return;
			}
			finished = true;
			this._onDidChatChunk.fire({ requestId, done: true, error });
		};
		// 采样参数：优先使用当前运行模型的配置，未配置字段交给引擎默认值
		const params = this.runningModel?.params;
		const maxTokens = params?.maxTokens ?? Math.max(128, this.configurationService.getValue<number>('ishell.llm.chat.maxTokens') ?? 2048);
		const guardThreshold = this.configurationService.getValue<number>('ishell.llm.chat.repeatGuardThreshold') ?? 8;
		provider.chatStream(
			messages,
			delta => {
				full += delta;
				this._onDidChatChunk.fire({ requestId, delta, done: false });
				// 退化重复检测：尾部窗口内同一结构反复出现则中止，避免无限复读
				if (guardThreshold > 0 && full.length - lastRepetitionCheck >= 200) {
					lastRepetitionCheck = full.length;
					if (detectDegenerateRepetition(full, guardThreshold)) {
						this.logStore.warn('chat', '检测到模型输出重复，已自动中止本次生成');
						controller.abort();
						finish('检测到模型输出在重复（同一段内容反复出现），已自动中止。可以让它换一种写法，或改用更大的模型。');
					}
				}
			},
			controller.signal,
			{
				maxTokens,
				temperature: params?.temperature,
				topP: params?.topP,
				topK: params?.topK,
				repeatPenalty: params?.repeatPenalty,
				seed: params?.seed,
			},
		).then(
			() => finish(),
			err => {
				this.logStore.error('chat', `对话失败：${(err as Error).message}`);
				finish((err as Error).message);
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

	// ==== 音乐生成（audio.cpp / Yue2） ====

	private emitMusicProgress(progress: ILlmMusicProgress): void {
		this._onDidMusicProgress.fire(progress);
	}

	private get audioBinDir(): string {
		return join(this.binDir, 'audio');
	}

	private get audioOutputDir(): string {
		return join(this.dataDir, 'audio');
	}

	async getAudioEngineInfo(): Promise<ILlmAudioEngineInfo> {
		await this.loaded;
		if (this.audioEngineInfo.state === 'ready' || this.audioEngineInfo.state === 'downloading') {
			return { ...this.audioEngineInfo };
		}
		try {
			const enginePath = await findAudioEngineExe(this.audioBinDir);
			this.audioEngineInfo = enginePath
				? { state: 'ready', enginePath }
				: { state: 'missing' };
		} catch (err) {
			this.audioEngineInfo = { state: 'failed', detail: (err as Error).message };
		}
		return { ...this.audioEngineInfo };
	}

	async downloadAudioEngine(): Promise<void> {
		await this.loaded;
		if (this.downloads.has('audio-engine')) {
			throw new Error('音频引擎正在下载中');
		}
		const cts = new CancellationTokenSource();
		this.downloads.set('audio-engine', { cts, startedAt: Date.now() });
		this.audioEngineInfo = { state: 'downloading' };
		const channel = this.store.getEngineChannel();
		this.logStore.info('music', `开始下载 audio.cpp 引擎（${channel === 'direct' ? 'GitHub 直连' : 'gh-proxy 加速'}）`);
		const startedAt = Date.now();
		try {
			const asset = await installAudioEngine({
				channel,
				binDir: this.binDir,
				onProgress: (received, total) => {
					const elapsed = (Date.now() - startedAt) / 1000;
					const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : undefined;
					this.emitMusicProgress({
						requestId: 'audio-engine',
						modelId: '',
						state: 'downloading-engine',
						message: `下载音频引擎 ${formatBytes(received)} / ${formatBytes(total)}${elapsed > 0.5 ? ` · ${formatBytes(Math.round(received / elapsed))}/s` : ''}`,
						percent,
					});
				},
				token: cts.token,
			});
			this.audioEngineInfo = { state: 'ready', enginePath: asset.enginePath, version: asset.version };
			this.logStore.info('music', `音频引擎安装完成：${asset.version}（${asset.enginePath}）`);
		} catch (err) {
			const canceled = cts.token.isCancellationRequested;
			this.audioEngineInfo = { state: canceled ? 'missing' : 'failed', detail: canceled ? undefined : (err as Error).message };
			if (!canceled) {
				this.logStore.error('music', `音频引擎下载失败：${(err as Error).message}`);
			}
			throw err;
		} finally {
			this.downloads.delete('audio-engine');
		}
	}

	/** 确保音频引擎就位（缺失时自动下载并推送进度） */
	private async ensureAudioEngine(requestId: string, modelId: string): Promise<string> {
		const info = await this.getAudioEngineInfo();
		if (info.state === 'ready' && info.enginePath) {
			return info.enginePath;
		}
		this.emitMusicProgress({ requestId, modelId, state: 'downloading-engine', message: '音频引擎缺失，开始自动下载…' });
		await this.downloadAudioEngine();
		const ready = await this.getAudioEngineInfo();
		if (ready.state !== 'ready' || !ready.enginePath) {
			throw new Error(ready.detail ?? '音频引擎未就绪');
		}
		return ready.enginePath;
	}

	async generateMusic(request: ILlmMusicRequest): Promise<ILlmMusicResult> {
		await this.loaded;
		const model = this.store.getModels().find(m => m.id === request.modelId);
		if (!model) {
			throw new Error(`模型记录不存在：${request.modelId}`);
		}
		if (resolveModelKind(model) !== 'music') {
			throw new Error(`「${model.name}」不是音乐模型`);
		}
		if ((request.lyrics ?? '').trim() === '') {
			throw new Error('歌词不能为空');
		}
		// 音乐引擎会占用数 GB 内存：同一时刻只允许一个任务，避免多个引擎同时加载模型拖垮系统
		if (this.musicRequests.size > 0) {
			throw new Error('已有音乐生成任务正在运行，请等待完成或先取消');
		}

		const requestId = generateUuid();
		const cts = new CancellationTokenSource();
		const startedAt = Date.now();
		// 先占用任务槽，再做任何 await：并发调用在这里立即失败（多个引擎同时加载模型会耗尽内存）
		const fileName = this.buildMusicFileName(request.title);
		const outPath = join(this.audioOutputDir, fileName);
		this.musicRequests.set(requestId, { modelName: model.name, startedAt, outPath, cts });
		await fsp.mkdir(this.audioOutputDir, { recursive: true });
		this.logStore.info('music', `开始生成音乐：${model.name}`);
		this.emitMusicProgress({ requestId, modelId: model.id, state: 'preparing', message: '准备音频引擎与模型文件…' });

		try {
			const enginePath = await this.ensureAudioEngine(requestId, model.id);
			if (cts.token.isCancellationRequested) {
				throw new Error('已取消');
			}
			const source = this.store.getSource();
			this.emitMusicProgress({ requestId, modelId: model.id, state: 'downloading-model', message: '准备模型文件…' });
			const prepared = await prepareMusicModel(model, {
				modelsDir: this.modelsDir,
				source,
				token: cts.token,
				onProgress: (message, percent) => {
					this.emitMusicProgress({ requestId, modelId: model.id, state: 'downloading-model', message, percent });
				},
				onLog: line => this.logStore.info('music', line),
			});
			if (cts.token.isCancellationRequested) {
				throw new Error('已取消');
			}

			const params = model.params ?? {};
			const worker: Required<Pick<ILlmMusicRequest, 'lyrics' | 'style'>> & {
				cotMode: 'off' | 'melody' | 'full';
				steps: number;
				seed: number;
				threads: number;
				audioBackend: 'auto' | 'metal' | 'cuda' | 'cpu';
				durationSeconds: number;
			} = {
				lyrics: request.lyrics,
				style: request.style ?? '',
				cotMode: request.cotMode ?? params.cotMode ?? 'off',
				steps: request.steps ?? params.numInferenceSteps ?? 8,
				seed: request.seed ?? params.seed ?? -1,
				threads: request.threads ?? params.threads ?? 0,
				audioBackend: request.audioBackend ?? params.audioBackend ?? 'auto',
				durationSeconds: request.durationSeconds ?? params.durationSeconds ?? 0,
			};
			// 单次尝试：返回 true 表示因长时间无输出被判为后端卡住并已终止
			const runAttempt = async (backend: 'auto' | 'metal' | 'cuda' | 'cpu'): Promise<boolean> => {
				const args = buildMusicArgs({
					modelDir: prepared.modelDir,
					mainFile: prepared.mainFile,
					vaeFile: prepared.vaeFile,
					request: { ...worker, audioBackend: backend },
					outPath,
				});
				this.logStore.info('music', `audiocpp_cli ${args.join(' ')}`);
				this.emitMusicProgress({ requestId, modelId: model.id, state: 'generating', message: '正在生成音乐…', percent: 0 });

				// 同一时刻只允许一个引擎进程：先确保此前所有引擎（含取消后仍在收尾的）完全退出
				await this.stopMusicChildren();
				const resolvedBackend: 'auto' | 'metal' | 'cuda' | 'cpu' = backend === 'auto'
					? (process.platform === 'darwin' ? 'metal' : 'cpu')
					: backend;
				// Metal 的 residency sets 在部分机型会让命令缓冲卡死在 waitUntilCompleted（实测卡在 ggml_metal_synchronize）；
				// 引擎提供 GGML_METAL_NO_RESIDENCY 关闭它，避免推理悬停
				const env = resolvedBackend === 'metal'
					? { ...process.env, GGML_METAL_NO_RESIDENCY: '1' }
					: process.env;
				const child = spawn(enginePath, args, { cwd: prepared.modelDir, windowsHide: true, detached: process.platform !== 'win32', env });
				this.musicChildren.add(child);
				child.once('exit', () => this.musicChildren.delete(child));
				this.musicRequests.get(requestId)!.child = child;

				// 引擎在部分后端（如 Metal）可能卡死且不再输出日志：长时间无输出即判为卡住并终止。
				// 但各阶段正常静默时长差异很大：AR 语义生成在长歌词下可静默数分钟，NAR / VAE 阶段则持续输出计时行
				let phase: 'load' | 'ar' | 'nar' | 'vae' = 'load';
				const stallLimitMinutes = (): number => {
					if (phase === 'nar') { return 6; }
					if (phase === 'vae') { return 3; }
					if (phase === 'ar') { return 15; }
					return 8;
				};
				let lastOutputAt = Date.now();
				let stalled = false;
				const stallTimer = setInterval(() => {
					if (stalled || child.exitCode !== null) {
						return;
					}
					const limit = stallLimitMinutes();
					if (Date.now() - lastOutputAt >= limit * 60 * 1000) {
						stalled = true;
						this.logStore.warn('music', `超过 ${limit} 分钟无输出（阶段：${phase}），判定为后端卡住，已终止生成`);
						this.terminateMusicChild(child);
					}
				}, 15_000);

				let percent = 0;
				let phaseMessage: string | undefined;
				const consume = (raw: string) => {
					const line = raw.trim();
					if (line === '') {
						return;
					}
					lastOutputAt = Date.now();
					this.logStore.info('music', line);
					const step = /step\s+(\d+)\s*\/\s*(\d+)/i.exec(line);
					const pct = /(\d{1,3}(?:\.\d+)?)%/.exec(line);
					if (step) {
						percent = Math.min(99, Math.round((Number(step[1]) / Math.max(1, Number(step[2]))) * 100));
					} else if (pct) {
						percent = Math.min(99, Math.round(Number(pct[1])));
					}
					// 引擎不回报百分比：按计时行切换阶段文案，让界面能看出当前在生成哪一步。
					// NAR 阶段会打印 yue2.ar.prefix_state.* 等行，阶段只能向前推进，否则文案会来回跳
					let nextPhase: 'load' | 'ar' | 'nar' | 'vae' = phase;
					if (/yue2\.semantic_ms|yue2\.semantic\.|yue2\.nar\./i.test(line)) {
						nextPhase = 'nar';
					} else if (/yue2\.vae_decode/i.test(line)) {
						// 不要匹配 yue2.vae_tile_frames 等加载期配置行，否则阶段会误跳到「解码音频」
						nextPhase = 'vae';
					} else if (phase === 'load' && /yue2\.ar\./i.test(line)) {
						nextPhase = 'ar';
					}
					const phaseOrder = { load: 0, ar: 1, nar: 2, vae: 3 };
					if (phaseOrder[nextPhase] > phaseOrder[phase]) {
						phase = nextPhase;
						phaseMessage = nextPhase === 'ar'
							? '生成歌词与旋律的语义序列…'
							: nextPhase === 'nar'
								? '声学合成（NAR）…'
								: '解码音频…';
					}
					this.emitMusicProgress({ requestId, modelId: model.id, state: 'generating', percent, logLine: line, message: phaseMessage });
				};
				const attach = (stream: NodeJS.ReadableStream) => {
					let buffer = '';
					stream.on('data', (chunk: Buffer | string) => {
						buffer += chunk.toString();
						const lines = buffer.split(/\r?\n/);
						buffer = lines.pop() ?? '';
						for (const line of lines) {
							consume(line);
						}
					});
					stream.on('end', () => {
						if (buffer) {
							consume(buffer);
							buffer = '';
						}
					});
				};
				attach(child.stdout);
				attach(child.stderr);

				await new Promise<void>((resolvePromise, rejectPromise) => {
					child.once('error', err => {
						clearInterval(stallTimer);
						rejectPromise(err);
					});
					child.once('exit', code => {
						clearInterval(stallTimer);
						if (cts.token.isCancellationRequested) {
							rejectPromise(new Error('已取消'));
							return;
						}
						if (stalled) {
							resolvePromise();
							return;
						}
						if (code !== 0) {
							const reason = code === null && child.signalCode
								? `被信号 ${child.signalCode} 终止`
								: `code ${code}`;
							rejectPromise(new Error(`audiocpp_cli 退出（${reason}），详见音乐日志`));
							return;
						}
						resolvePromise();
					});
				});
				return stalled;
			};

			// 每次生成前清理残留引擎进程（应用异常退出 / 上次生成异常可能留下多个），避免并发占满内存
			await this.stopMusicChildren();
			await this.killOrphanMusicProcesses(enginePath);

			// 硬件后端（Metal）偶发卡死且是随机性的：用相同后端重试一次通常即可。
			// 不再自动回退 CPU：实测同一段音频 CPU 仅 AR 阶段已超过 8 分钟（Metal 约 100 秒），长歌词下会让用户白等半小时
			let stalled = await runAttempt(worker.audioBackend);
			if (stalled && worker.audioBackend !== 'cpu' && !cts.token.isCancellationRequested) {
				this.logStore.warn('music', `后端「${worker.audioBackend}」卡住，正在以相同后端重试一次`);
				this.emitMusicProgress({ requestId, modelId: model.id, state: 'generating', message: '推理后端卡住，正在重试…', percent: 0 });
				await fsp.rm(outPath, { force: true }).catch(() => undefined);
				stalled = await runAttempt(worker.audioBackend);
			}
			if (stalled) {
				throw new Error('推理后端长时间无输出（已自动重试一次仍失败）；可降低「推理步数」或「时长」后重试，或将「推理后端」切换为 cpu');
			}

			const stat = await fsp.stat(outPath);
			if (stat.size <= 0) {
				throw new Error('生成结束但 WAV 文件为空');
			}
			const result: ILlmMusicResult = {
				requestId,
				modelId: model.id,
				modelName: model.name,
				filePath: outPath,
				fileName,
				elapsedMs: Date.now() - startedAt,
			};
			this.emitMusicProgress({ requestId, modelId: model.id, state: 'completed', message: '生成完成', percent: 100 });
			this.logStore.info('music', `音乐生成完成：${outPath}（耗时 ${Math.round(result.elapsedMs / 1000)} 秒）`);
			return result;
		} catch (err) {
			const canceled = cts.token.isCancellationRequested;
			this.emitMusicProgress({
				requestId,
				modelId: model.id,
				state: canceled ? 'canceled' : 'failed',
				message: canceled ? '已取消' : (err as Error).message,
			});
			this.logStore[canceled ? 'info' : 'error']('music', `音乐生成${canceled ? '已取消' : `失败：${(err as Error).message}`}`);
			await fsp.rm(outPath, { force: true }).catch(() => undefined);
			throw err;
		} finally {
			// 无论成功、取消还是异常，都确保引擎进程（含派生子进程）完全退出
			const request = this.musicRequests.get(requestId);
			this.terminateMusicChild(request?.child);
			this.musicRequests.delete(requestId);
			await this.stopMusicChildren();
		}
	}

	/** 歌名 → 输出文件名：去掉路径分隔符/非法字符与首尾空白；未填写时按时间命名，重名追加序号 */
	private buildMusicFileName(title: string | undefined): string {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, '0');
		const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const base = (title ?? '')
			.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 80)
			.replace(/[. ]+$/, '')
			|| `音乐-${stamp}`;
		for (let i = 2; i <= 999; i++) {
			const name = i === 2 ? `${base}.wav` : `${base} (${i}).wav`;
			if (!existsSync(join(this.audioOutputDir, name))) {
				return name;
			}
		}
		return `${base}-${stamp}.wav`;
	}

	/** 终止引擎进程及其派生的所有子进程（引擎会 fork 多个进程，只杀父进程会残留） */
	private killMusicTree(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
		if (!child || child.pid === undefined) {
			return;
		}
		if (process.platform !== 'win32') {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch {
				// 进程组已不存在，退回单进程终止
			}
		}
		try {
			child.kill(signal);
		} catch {
			// 已退出
		}
	}

	/** 立即强制结束引擎进程组：音乐引擎占用数 GB 内存，残留进程会拖垮系统；WAV 仅在完成时写出，无需优雅退出 */
	private terminateMusicChild(child: ChildProcessWithoutNullStreams | undefined): void {
		this.killMusicTree(child, 'SIGKILL');
	}

	/** 等待指定引擎进程真正退出（最多 2 秒兜底），保证新任务启动前内存已释放 */
	private async stopMusicChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
		if (!child) {
			return;
		}
		this.killMusicTree(child, 'SIGKILL');
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		await new Promise<void>(resolve => {
			let settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			child.once('exit', done);
			setTimeout(() => {
				this.killMusicTree(child, 'SIGKILL');
				done();
			}, 2000);
		});
	}

	/** 结束所有已知引擎进程并等待退出：保证同一时刻只有一个引擎占用内存 */
	private async stopMusicChildren(): Promise<void> {
		await Promise.all(Array.from(this.musicChildren).map(child => this.stopMusicChild(child)));
	}

	/** 清理应用异常退出残留的引擎进程（含子进程），并等待其真正退出 */
	private async killOrphanMusicProcesses(enginePath: string): Promise<void> {
		if (process.platform === 'win32') {
			return;
		}
		const run = (command: string, args: string[]): Promise<boolean> => new Promise(resolve => {
			try {
				const proc = spawn(command, args, { stdio: 'ignore' });
				proc.once('error', () => resolve(false));
				proc.once('exit', code => resolve(code === 0));
			} catch {
				resolve(false);
			}
		});
		await run('pkill', ['-9', '-f', enginePath]);
		// 等待残留进程真正退出，否则新引擎可能与其同时加载模型
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			if (!(await run('pgrep', ['-f', enginePath]))) {
				return;
			}
			await timeout(150);
		}
	}

	async cancelMusicGeneration(requestId: string): Promise<void> {
		const request = this.musicRequests.get(requestId);
		if (!request) {
			return;
		}
		request.cts.cancel();
		this.terminateMusicChild(request.child);
		this.emitMusicProgress({ requestId, modelId: '', state: 'canceled', message: '已取消' });
	}

	async readMusicAudio(filePath: string): Promise<string> {
		await this.loaded;
		const root = resolve(this.audioOutputDir);
		const target = resolve(filePath);
		if (!target.startsWith(root + sep)) {
			throw new Error('只能读取音乐生成目录下的音频文件');
		}
		const buffer = await fsp.readFile(target);
		return buffer.toString('base64');
	}

	async revealMusicFile(filePath: string): Promise<void> {
		shell.showItemInFolder(filePath);
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
