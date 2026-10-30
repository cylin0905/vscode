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
import { ILlmChatChunkEvent, ILlmChatMessage, ILlmEngineInfo, IIshellLlmService } from '../common/llm.js';

/** 内置 Chat 语言模型注册表中的 iShell 本地模型 vendor id */
export const ISHELL_LLM_VENDOR_ID = 'ishell';

/**
 * 把本地 LLM（llama.cpp 引擎 + 当前运行模型）发布为内置 Chat 的语言模型：
 * - provideLanguageModelChatInfo：引擎 running 时暴露当前模型，否则为空列表
 * - sendChatRequest：桥接 IIshellLlmService.sendChat 流式对话
 */
export class LlmLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private engine: ILlmEngineInfo = { state: 'missing' };

	constructor(
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	/** 引擎状态变化（模型启动/停止）时更新并通知注册表刷新模型列表 */
	updateEngine(engine: ILlmEngineInfo): void {
		this.engine = engine;
		this._onDidChange.fire();
	}

	private get contextSize(): number {
		return this.configurationService.getValue<number>('ishell.llm.contextSize') ?? 4096;
	}

	async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		if (this.engine.state !== 'running' || !this.engine.runningModelId) {
			return [];
		}
		// 模型记录 id -> catalogId（catalogId 跨重启稳定，作为模型短 id）
		let modelId = this.engine.runningModelId;
		try {
			const models = await this.llmService.getModels();
			modelId = models.find(m => m.id === this.engine.runningModelId)?.catalogId ?? modelId;
		} catch {
			// 查询失败时退回记录 id，不影响注册
		}
		const ctx = this.contextSize;
		return [{
			identifier: `${ISHELL_LLM_VENDOR_ID}:${modelId}`,
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: this.engine.runningModelName ?? modelId,
				id: modelId,
				vendor: ISHELL_LLM_VENDOR_ID,
				version: '1',
				family: modelId,
				detail: localize('ishell.llm.providerDetail', '本地运行 · llama.cpp'),
				tooltip: localize('ishell.llm.providerTooltip', 'iShell 本地模型（llama.cpp 推理引擎，数据不出本机）'),
				maxInputTokens: Math.max(1024, ctx - 1024),
				maxOutputTokens: 1024,
				isDefaultForLocation: {},
				isUserSelectable: true,
				capabilities: {
					vision: false,
					// 门控标记：Agent 模式要求 toolCalling+agentMode 才在模型选择器中可见（suitableForAgentMode）
					toolCalling: true,
					agentMode: true,
				},
			},
		}];
	}

	async sendChatRequest(modelId: string, messages: readonly IChatMessage[], _from: unknown, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		if (this.engine.state !== 'running') {
			throw new Error(localize('ishell.llm.notRunning', '本地模型未在运行，请先在本地模型管理中启动模型'));
		}

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
 * 引擎生命周期 <-> 内置 Chat 语言模型注册：
 * 模型 running 时注册 vendor + provider（模型出现在 Chat 模型选择器），离开 running 时注销。
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

		this._register(this.llmService.onDidChangeEngine(engine => this.update(engine)));
		this.llmService.getEngineInfo().then(engine => {
			if (!this._store.isDisposed) {
				this.update(engine);
			}
		});
	}

	private update(engine: ILlmEngineInfo): void {
		if (engine.state === 'running') {
			this.register(engine);
		} else {
			this.unregister();
		}
	}

	private register(engine: ILlmEngineInfo): void {
		if (this.provider) {
			this.provider.updateEngine(engine);
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
		provider.updateEngine(engine);
	}

	private unregister(): void {
		if (this.provider) {
			this.session.clear();
			this.provider = undefined;
		}
	}
}
