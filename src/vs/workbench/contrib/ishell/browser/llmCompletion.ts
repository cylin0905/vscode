/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsDisposeReason, InlineCompletionsProvider, ProviderResult } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IIshellLlmService, ILlmEngineInfo } from '../common/llm.js';
import { normalizeModelCompletion } from '../common/llmInstructions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

// #########################################################################
// ##    iShell 智能代码补全（本地模型内联补全）                             ##
// ##  - 全语言注册（'*'），多框架感知由模型按上下文推断                     ##
// ##  - 仅在本地模型运行中生效；失败/未运行静默退回默认补全                 ##
// ##  - 输出经清洗（去围栏/缩进对齐/截断），符合项目现有代码风格            ##
// #########################################################################

/** 补全上下文光标后取的行数 */
const SUFFIX_LINES = 8;

class LlmInlineCompletionsProvider implements InlineCompletionsProvider<InlineCompletions> {

	private engineRunning = false;
	/** 在途请求互斥：模型响应慢时不再堆积新请求（击键即回退默认补全，避免卡顿） */
	private inflight = false;

	constructor(
		private readonly llmService: IIshellLlmService,
		private readonly configurationService: IConfigurationService,
	) {
		this.llmService.getEngineInfo().then(info => { this.engineRunning = info.state === 'running'; }).catch(() => { });
		this.llmService.onDidChangeEngine((info: ILlmEngineInfo) => { this.engineRunning = info.state === 'running'; });
	}

	provideInlineCompletions(model: ITextModel, position: Position, _context: InlineCompletionContext, token: CancellationToken): ProviderResult<InlineCompletions> {
		return this.doProvide(model, position, token);
	}

	disposeInlineCompletions(_completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		// 结果为纯数据（无句柄/缓存），无需清理
	}

	private async doProvide(model: ITextModel, position: Position, token: CancellationToken): Promise<InlineCompletions | undefined> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.completion.enabled') ?? true;
		const language = model.getLanguageId();
		if (!enabled || !this.engineRunning || language === 'plaintext' || language === '') {
			return undefined;
		}
		const maxContextLines = Math.max(10, Math.min(400, this.configurationService.getValue<number>('ishell.llm.completion.maxContextLines') ?? 80));

		const startLine = Math.max(1, position.lineNumber - maxContextLines);
		const prefix = model.getValueInRange(new Range(startLine, 1, position.lineNumber, position.column));
		if (prefix.trimEnd().length < 2) {
			return undefined; // 输入太少，避免无意义请求
		}
		const endLine = Math.min(model.getLineCount(), position.lineNumber + SUFFIX_LINES);
		const suffix = model.getValueInRange(new Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine)));

		if (token.isCancellationRequested) {
			return undefined;
		}
		if (this.inflight) {
			return undefined; // 上一次请求仍在途：跳过本次，避免堆积拖慢输入
		}
		let raw: string;
		try {
			this.inflight = true;
			raw = await this.llmService.sendCompletion({
				prefix,
				suffix,
				filePath: model.uri.path,
				language,
			});
		} catch {
			return undefined; // 补全失败静默退回（不打断输入）
		} finally {
			this.inflight = false;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}
		const currentLinePrefix = model.getValueInRange(new Range(position.lineNumber, 1, position.lineNumber, position.column));
		const insertText = normalizeModelCompletion(raw, currentLinePrefix);
		if (insertText === '') {
			return undefined;
		}
		return { items: [{ insertText }] };
	}
}

/** 补全贡献注册（AfterRestored，惰性创建，不影响启动性能） */
export class LlmCompletionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.ishellLlmCompletion';
	static readonly LABEL = localize('ishell.llm.completion.label', 'iShell 本地模型代码补全');

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IIshellLlmService llmService: IIshellLlmService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		const provider = new LlmInlineCompletionsProvider(llmService, configurationService);
		this._register(languageFeaturesService.inlineCompletionsProvider.register('*', provider));
	}
}

export function registerLlmCompletionContribution(): void {
	registerWorkbenchContribution2(LlmCompletionContribution.ID, LlmCompletionContribution, WorkbenchPhase.AfterRestored);
}
