/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditOperation } from '../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CodeAction, CodeActionContext, CodeActionList, CodeActionProvider, Command } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILlmDiagnostic, IIshellLlmService, inferLanguageFromPath } from '../common/llm.js';
import { LLM_DIAGNOSTIC_MARKER_OWNER, applyDiagnosticsToMarkers } from './llmDiagnostics.js';

// #########################################################################
// ##    iShell 模型自动修复（"让模型自己改代码"）                            ##
// ##  - 灯泡快速修复：诊断问题 → 本地模型重写 → 自动替换（可 Ctrl+Z 撤销） ##
// ##  - 整文件批量修复命令（ishell.llm.fixFile）                             ##
// ##  - 写盘前自动落版本快照；修复后重新诊断并刷新问题面板                    ##
// #########################################################################

const QUICK_FIX_TITLE = localize('ishell.llm.fix.quickFixTitle', "iShell：使用本地模型修复此问题");

/** 诊断问题 → 发给模型的摘要行 */
function describeProblem(d: ILlmDiagnostic): string {
	return `${d.ruleId}（第 ${d.line}-${d.endLine} 行，${d.category}）：${d.message}。建议：${d.suggestion}`;
}

function fixEnabled(accessor: ServicesAccessor): boolean {
	const enabled = accessor.get(IConfigurationService).getValue<boolean>('ishell.llm.fix.enabled');
	return enabled ?? true;
}

/** 读取当前内容：打开的编辑器优先（含未保存修改），否则读盘 */
async function readCurrentContent(textFileService: ITextFileService, fileService: IFileService, uri: URI): Promise<{ content: string; language: string } | undefined> {
	const model = textFileService.files.get(uri)?.textEditorModel;
	if (model) {
		return { content: model.getValue(), language: model.getLanguageId() };
	}
	try {
		const data = await fileService.readFile(uri);
		return { content: data.value.toString(), language: inferLanguageFromPath(uri.path) };
	} catch {
		return undefined;
	}
}

/** 应用修复内容：打开的编辑器走编辑事务（可撤销），否则写盘前落版本快照 */
async function applyFixedContent(accessor: ServicesAccessor, uri: URI, fixed: string): Promise<'editor' | 'disk'> {
	const textFileService = accessor.get(ITextFileService);
	const model = textFileService.files.get(uri)?.textEditorModel;
	if (model) {
		applyModelContent(model, fixed);
		return 'editor';
	}
	const fileService = accessor.get(IFileService);
	const llmService = accessor.get(IIshellLlmService);
	try {
		const before = await fileService.readFile(uri);
		await llmService.recordFileVersion(uri.fsPath, before.value.toString());
	} catch {
		// 读不到旧内容：跳过快照，仍继续写入
	}
	await fileService.writeFile(uri, VSBuffer.fromString(fixed));
	return 'disk';
}

function applyModelContent(model: ITextModel, fixed: string): void {
	model.pushEditOperations([], [EditOperation.replace(model.getFullModelRange(), fixed)], () => []);
}

/** 调本地模型完成修复（进度条 + 失败抛错） */
async function requestModelFix(accessor: ServicesAccessor, content: string, language: string, problems: ILlmDiagnostic[]): Promise<string> {
	const progressService = accessor.get(IProgressService);
	const llmService = accessor.get(IIshellLlmService);
	return progressService.withProgress({
		location: ProgressLocation.Notification,
		title: localize('ishell.llm.fix.progressTitle', "iShell 正在让本地模型修复 {0} 个问题…", String(problems.length)),
	}, async () => {
		const fixed = await llmService.applyModelFix({
			content,
			language,
			problems: problems.map(describeProblem),
			instruction: localize('ishell.llm.fix.instruction', '仅修复上述问题，其余内容逐字保留'),
		});
		if (fixed.trim() === '' || fixed === content) {
			throw new Error(localize('ishell.llm.fix.noChange', '模型未返回有效的修改'));
		}
		return fixed;
	});
}

/** 修复后重新诊断并刷新问题面板 */
async function refreshDiagnostics(accessor: ServicesAccessor, uri: URI, content: string, language: string): Promise<number> {
	const llmService = accessor.get(IIshellLlmService);
	const report = await llmService.analyzeCode(content, language, uri.path);
	applyDiagnosticsToMarkers(accessor.get(IMarkerService), uri, report);
	return report.diagnostics.length;
}

/** 单问题修复（灯泡 / 问题面板快速修复触发）：args = [uriString, startLine, endLine] */
class FixIssueAction extends Action2 {

	static readonly ID = 'ishell.llm.fixIssue';

	constructor() {
		super({
			id: FixIssueAction.ID,
			title: localize2('ishell.llm.fixIssue.title', "修复此代码问题（本地模型）"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, uriString?: string, startLine?: number, endLine?: number): Promise<void> {
		if (typeof uriString !== 'string' || typeof startLine !== 'number') {
			return;
		}
		if (!fixEnabled(accessor)) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		const uri = URI.parse(uriString);
		const current = await readCurrentContent(accessor.get(ITextFileService), accessor.get(IFileService), uri);
		if (!current) {
			notificationService.warn(localize('ishell.llm.fix.fileMissing', '无法读取文件内容'));
			return;
		}
		const llmService = accessor.get(IIshellLlmService);
		const report = await llmService.analyzeCode(current.content, current.language, uri.path);
		const lastLine = typeof endLine === 'number' ? endLine : startLine;
		const problems = report.diagnostics.filter(d => d.line >= startLine && d.line <= lastLine);
		if (problems.length === 0) {
			notificationService.info(localize('ishell.llm.fix.noProblem', '该位置当前没有待修复问题'));
			return;
		}
		try {
			const fixed = await requestModelFix(accessor, current.content, current.language, problems);
			await applyFixedContent(accessor, uri, fixed);
			const remaining = await refreshDiagnostics(accessor, uri, fixed, current.language);
			notificationService.info(remaining === 0
				? localize('ishell.llm.fix.done', 'iShell 已自动修复 {0} 个问题（可 Ctrl+Z 撤销）', String(problems.length))
				: localize('ishell.llm.fix.partial', '已修复，剩余 {0} 个问题', String(remaining)));
		} catch (err) {
			notificationService.error(localize('ishell.llm.fix.failed', '自动修复失败：{0}', (err as Error)?.message ?? String(err)));
		}
	}
}

/** 整文件批量修复：当前编辑器全部诊断问题一次交给模型 */
class FixFileAction extends Action2 {

	static readonly ID = 'ishell.llm.fixFile';

	constructor() {
		super({
			id: FixFileAction.ID,
			title: localize2('ishell.llm.fixFile.title', "用本地模型自动修复此文件的问题"),
			category: { value: localize('ishell.category', "iShell"), original: 'iShell' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (!fixEnabled(accessor)) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		const editor = getCodeEditor(accessor.get(IEditorService).activeTextEditorControl);
		const model = editor?.getModel();
		if (!editor || !model) {
			notificationService.info(localize('ishell.llm.fixFile.noEditor', '请先打开一个文本编辑器'));
			return;
		}
		const llmService = accessor.get(IIshellLlmService);
		const content = model.getValue();
		const language = model.getLanguageId();
		const report = await llmService.analyzeCode(content, language, model.uri.path);
		if (report.diagnostics.length === 0) {
			notificationService.info(localize('ishell.llm.fixFile.clean', '未发现可自动修复的问题（评分 {0}）', String(report.summary.score)));
			return;
		}
		try {
			const fixed = await requestModelFix(accessor, content, language, report.diagnostics);
			applyModelContent(model, fixed); // 打开状态：编辑事务直接应用，可撤销
			const remaining = await refreshDiagnostics(accessor, model.uri, fixed, language);
			notificationService.info(localize('ishell.llm.fixFile.done',
				'已自动修复（评分 {0} → 待重新计算，剩余问题 {1} 个，可 Ctrl+Z 撤销）',
				String(report.summary.score), String(remaining)));
		} catch (err) {
			notificationService.error(localize('ishell.llm.fix.failed', '自动修复失败：{0}', (err as Error)?.message ?? String(err)));
		}
	}
}

/** 灯泡 / 问题面板快速修复：iShell 诊断问题 → 本地模型修复（1.143 接口：返回 CodeActionList，markers 自行读取） */
class LlmQuickFixProvider implements CodeActionProvider {

	readonly displayName = 'iShell';

	constructor(private readonly markerService: IMarkerService) { }

	provideCodeActions(model: ITextModel, range: Range, _context: CodeActionContext, _token: CancellationToken): CodeActionList {
		const actions: CodeAction[] = [];
		const markers = this.markerService.read({ resource: model.uri });
		for (const marker of markers) {
			if (marker.owner !== LLM_DIAGNOSTIC_MARKER_OWNER) {
				continue;
			}
			// 仅对当前选区 / 光标行相交的问题提供
			if (marker.startLineNumber > range.endLineNumber || marker.endLineNumber < range.startLineNumber) {
				continue;
			}
			const command: Command = {
				id: FixIssueAction.ID,
				title: QUICK_FIX_TITLE,
				arguments: [model.uri.toString(), marker.startLineNumber, marker.endLineNumber],
			};
			actions.push({
				title: QUICK_FIX_TITLE,
				kind: 'quickfix.ishell',
				diagnostics: [marker],
				isPreferred: marker.severity === MarkerSeverity.Error,
				isAI: true,
				command,
			});
		}
		return {
			actions,
			dispose(): void { /* 结果为纯数据，无需清理 */ },
		};
	}
}

/** 修复贡献注册：Quick Fix Provider + 两个命令 */
export class LlmFixContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.ishellLlmFix';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IMarkerService markerService: IMarkerService,
	) {
		super();
		this._register(languageFeaturesService.codeActionProvider.register('*', new LlmQuickFixProvider(markerService)));
	}
}

export function registerLlmFixContribution(): void {
	registerAction2(FixFileAction);
	registerAction2(FixIssueAction);
	registerWorkbenchContribution2(LlmFixContribution.ID, LlmFixContribution, WorkbenchPhase.AfterRestored);
}
