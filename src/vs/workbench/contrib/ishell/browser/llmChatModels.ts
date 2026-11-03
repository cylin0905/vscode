/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatMessageRole, IChatMessage, IChatMessageTextPart, IChatResponsePart, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ILlmChatChunkEvent, ILlmChatMessage, ILlmModelRecord, IIshellLlmService, resolveModelKind } from '../common/llm.js';

/** 内置 Chat 语言模型注册表中的 iShell 本地模型 vendor id */
export const ISHELL_LLM_VENDOR_ID = 'ishell';

/**
 * 把本地 LLM（llama.cpp 引擎 + 已下载模型）发布为内置 Chat 的语言模型：
 * - provideLanguageModelChatInfo：暴露全部已下载模型（未运行的发送消息时自动拉起）
 * - sendChatRequest：确保目标模型运行（必要时自动切换）后桥接 IIshellLlmService.sendChat 流式对话
 */
export class LlmLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** 模型拉起/切换串行队列：并发请求按顺序决策，后者命中前者的结果可直接复用 */
	private ensureQueue: Promise<unknown> = Promise.resolve();

	constructor(
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	/** 引擎 / 模型列表变化时通知注册表刷新模型列表 */
	refresh(): void {
		this._onDidChange.fire();
	}

	/** 全局默认上下文长度（模型未单独配置时使用） */
	private get defaultContextSize(): number {
		return this.configurationService.getValue<number>('ishell.llm.contextSize') ?? 4096;
	}

	/** 按模型解析生效的上下文长度：模型参数优先，其次全局默认 */
	private modelContextSize(model: ILlmModelRecord): number {
		return model.params?.contextSize ?? this.defaultContextSize;
	}

	/** 上下文长度展示文本（4096 → 4K，32768 → 32K） */
	private formatContext(ctx: number): string {
		if (ctx >= 1024) {
			const k = Math.round(ctx / 1024 * 10) / 10;
			return `${k}K`;
		}
		return String(ctx);
	}

	async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		// 暴露全部已下载的对话模型（音乐模型由「音乐生成」区使用，不进入 Chat 选择器）
		const models = (await this.llmService.getModels()).filter(m => resolveModelKind(m) === 'chat');
		return models.map(model => {
			const ctx = this.modelContextSize(model);
			const maxOutput = Math.max(256, Math.min(ctx - 1024, model.params?.maxTokens ?? 1024));
			return {
				identifier: `${ISHELL_LLM_VENDOR_ID}:${model.catalogId}`,
				metadata: {
					extension: nullExtensionDescription.identifier,
					name: model.name,
					id: model.catalogId,
					vendor: ISHELL_LLM_VENDOR_ID,
					version: '1',
					family: model.catalogId,
					detail: localize('ishell.llm.providerDetailWithContext', '本地运行 · llama.cpp · {0} 上下文', this.formatContext(ctx)),
					tooltip: localize('ishell.llm.providerTooltip', 'iShell 本地模型（llama.cpp 推理引擎，数据不出本机）'),
					maxInputTokens: Math.max(1024, ctx - maxOutput),
					maxOutputTokens: maxOutput,
					// Chat 的 K 值按 1000 进制显示（32768 → 33K）；按 1024 进制归一后显示为用户设置的 32K
					maxContextWindowTokens: ctx >= 1024 ? Math.floor(ctx / 1024) * 1000 : ctx,
					isDefaultForLocation: {},
					isUserSelectable: true,
					capabilities: {
						vision: false,
						// 门控标记：Agent 模式要求 toolCalling+agentMode 才在模型选择器中可见（suitableForAgentMode）
						toolCalling: true,
						agentMode: true,
					},
				},
			};
		});
	}

	// ==== 模型自动拉起 / 切换 ====

	/** 串行化模型拉起/切换决策：避免并发请求交替 stop/start 模型互相打断 */
	private ensureRunningModel(identifier: string, token: CancellationToken): Promise<void> {
		const run = this.ensureQueue
			.catch(() => undefined)
			.then(() => this.doEnsureRunningModel(identifier, token));
		this.ensureQueue = run;
		return run;
	}

	private async doEnsureRunningModel(identifier: string, token: CancellationToken): Promise<void> {
		const catalogId = identifier.startsWith(`${ISHELL_LLM_VENDOR_ID}:`)
			? identifier.slice(ISHELL_LLM_VENDOR_ID.length + 1)
			: identifier;
		let engine = await this.llmService.getEngineInfo();
		// 其他入口（如 UI 手动启动）正在加载模型：等待其完成再判断（上限与引擎健康检查一致 5 分钟）
		const waitStart = Date.now();
		while (engine.state === 'starting' && !token.isCancellationRequested && Date.now() - waitStart < 300_000) {
			await new Promise<void>(resolve => setTimeout(resolve, 500));
			engine = await this.llmService.getEngineInfo();
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (engine.state === 'missing' || engine.state === 'downloading') {
			throw new Error(localize('ishell.llm.engineMissing', '本地引擎未就绪，请先在本地模型管理中下载 llama-server 引擎'));
		}
		const models = await this.llmService.getModels();
		const target = models.find(m => m.catalogId === catalogId);
		if (!target) {
			throw new Error(localize('ishell.llm.modelMissing', "模型未下载：{0}，请先在本地模型管理中下载", catalogId));
		}
		if (resolveModelKind(target) === 'music') {
			throw new Error(localize('ishell.llm.musicModelNotChat', '「{0}」是音乐模型，请在模型管理的「音乐生成」标签页使用', target.name));
		}
		if (engine.state === 'running' && engine.runningModelId === target.id) {
			return;
		}
		if (engine.state === 'running') {
			// 运行中的是其他模型：自动切换
			await this.llmService.stopModel();
		}
		try {
			await this.llmService.startModel(target.id);
		} catch (err) {
			// 并发请求竞态：启动期间另一请求已把目标模型拉起 → 视为成功
			const now = await this.llmService.getEngineInfo();
			if (now.state === 'running' && now.runningModelId === target.id) {
				return;
			}
			throw err;
		}
	}

	async sendChatRequest(modelId: string, messages: readonly IChatMessage[], _from: unknown, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// 目标模型未运行时自动拉起；运行其他模型时自动切换
		await this.ensureRunningModel(modelId, token);

		const mapped: ILlmChatMessage[] = [];
		for (const message of messages) {
			const text = message.content
				.filter((part): part is IChatMessageTextPart => part.type === 'text')
				.map(part => part.value)
				.join('');
			if (!text) {
				continue;
			}
			mapped.push({
				role: message.role === ChatMessageRole.System ? 'system' : message.role === ChatMessageRole.User ? 'user' : 'assistant',
				content: text,
			});
		}
		if (mapped.length === 0) {
			throw new Error(localize('ishell.llm.emptyRequest', '请求内容为空'));
		}

		const requestId = await this.llmService.sendChat(mapped);

		// 流式桥接：onDidChatChunk(requestId) -> AsyncIterable<IChatResponsePart[]>
		const pending: ILlmChatChunkEvent[] = [];
		const waiters: ((chunk: ILlmChatChunkEvent | undefined) => void)[] = [];
		let ended = false;

		const listener = this.llmService.onDidChatChunk(chunk => {
			if (chunk.requestId !== requestId) {
				return;
			}
			if (chunk.done) {
				ended = true;
			}
			const waiter = waiters.shift();
			if (waiter) {
				waiter(chunk);
			} else {
				pending.push(chunk);
			}
		});
		const cancellation = token.onCancellationRequested(() => {
			this.llmService.cancelChat(requestId).catch(() => { });
		});

		const next = (): Promise<ILlmChatChunkEvent | undefined> => {
			if (pending.length > 0) {
				return Promise.resolve(pending.shift());
			}
			if (ended) {
				return Promise.resolve(undefined);
			}
			return new Promise(resolve => waiters.push(resolve));
		};

		const settled = { resolve: () => { }, reject: (_err: unknown) => { } };
		const result = new Promise<void>((resolve, reject) => {
			settled.resolve = resolve;
			settled.reject = reject;
		});

		const stream = (async function* (): AsyncIterable<IChatResponsePart[]> {
			try {
				while (true) {
					const chunk = await next();
					if (!chunk) {
						break;
					}
					if (chunk.delta) {
						yield [{ type: 'text', value: chunk.delta }];
					}
					if (chunk.done) {
						if (chunk.error) {
							throw new Error(chunk.error);
						}
						break;
					}
				}
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				settled.resolve();
			} catch (err) {
				settled.reject(err);
				throw err;
			} finally {
				listener.dispose();
				cancellation.dispose();
			}
		})();

		return { stream, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.filter((part): part is IChatMessageTextPart => part.type === 'text').map(part => part.value).join('');
		return Math.ceil(text.length / 2);
	}
}

/**
 * 引擎/模型生命周期 <-> 内置 Chat 语言模型注册：
 * 只要存在已下载模型就注册 vendor + provider（模型始终出现在 Chat 模型选择器，不随启停消失），
 * 发送消息时未运行的模型自动拉起（见 LlmLanguageModelProvider.sendChatRequest）。
 */
export class LlmChatModelsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.ishellLlmChatModels';

	private provider: LlmLanguageModelProvider | undefined;
	private session = this._register(new DisposableStore());

	private readonly vendorDescriptor = {
		vendor: ISHELL_LLM_VENDOR_ID,
		displayName: localize('ishell.llm.vendorName', 'iShell 本地模型'),
		configuration: undefined,
		managementCommand: undefined,
		when: undefined,
	};

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IIshellLlmService private readonly llmService: IIshellLlmService,
	) {
		super();

		this._register(this.llmService.onDidChangeEngine(() => this.update()));
		this._register(this.llmService.onDidChangeModels(() => this.update()));
		this.update();
	}

	private async update(): Promise<void> {
		const models = (await this.llmService.getModels()).filter(m => resolveModelKind(m) === 'chat');
		if (this._store.isDisposed) {
			return;
		}
		if (models.length > 0) {
			this.register();
		} else {
			this.unregister();
		}
	}

	private register(): void {
		if (this.provider) {
			this.provider.refresh();
			return;
		}
		const store = new DisposableStore();
		this.session.add(store);
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors([this.vendorDescriptor], []);
		store.add(toDisposable(() => this.languageModelsService.deltaLanguageModelChatProviderDescriptors([], [this.vendorDescriptor])));
		const provider = store.add(this.instantiationService.createInstance(LlmLanguageModelProvider));
		// 注意顺序：先 registerLanguageModelProvider 再 fire onDidChange（首个事件才会被注册表观察到）
		store.add(this.languageModelsService.registerLanguageModelProvider(ISHELL_LLM_VENDOR_ID, provider));
		this.provider = provider;
		provider.refresh();
	}

	private unregister(): void {
		if (this.provider) {
			this.session.clear();
			this.provider = undefined;
		}
	}
}
