/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThrottledDelayer } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILlmDiagnosticReport, IIshellLlmService, inferLanguageFromPath } from '../common/llm.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

// #########################################################################
// ##    iShell 静态诊断集成（渲染层）                                      ##
// ##  - 诊断结果写入 IMarkerService → 问题面板实时展示                     ##
// ##  - 保存文件时自动触发分析（去抖，配置开关）                            ##
// ##  - 手动诊断当前文件命令（报告归档由主进程完成）                         ##
// #########################################################################

export const LLM_DIAGNOSTIC_MARKER_OWNER = 'ishell.llm.diagnostics';

const DIAGNOSTIC_SAVE_DELAY = 1500;

function severityToMarkerSeverity(severity: 'error' | 'warning' | 'info' | 'hint'): MarkerSeverity {
	switch (severity) {
		case 'error': return MarkerSeverity.Error;
		case 'warning': return MarkerSeverity.Warning;
		case 'info': return MarkerSeverity.Info;
		default: return MarkerSeverity.Hint;
	}
}

/** 诊断报告 → Markers（空报告清空既有标记） */
export function applyDiagnosticsToMarkers(markerService: IMarkerService, resource: URI, report: ILlmDiagnosticReport): void {
	const markers: IMarkerData[] = report.diagnostics.map(d => ({
		code: d.ruleId,
		severity: severityToMarkerSeverity(d.severity),
		message: `${d.message}（建议：${d.suggestion}）`,
		source: 'iShell',
		startLineNumber: d.line,
		startColumn: d.startColumn,
		endLineNumber: d.endLine,
		endColumn: d.endColumn,
	}));
	markerService.changeOne(LLM_DIAGNOSTIC_MARKER_OWNER, resource, markers);
}

/** 保存时自动诊断贡献（问题实时上屏，不依赖模型运行） */
export class LlmDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.ishellLlmDiagnostics';

	private readonly delayers = new Map<string, ThrottledDelayer<void>>();

	constructor(
		@ITextFileService private readonly textFileService: ITextFileService,
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.textFileService.files.onDidSave(e => {
			const onSave = this.configurationService.getValue<boolean>('ishell.llm.diagnostics.onSave') ?? true;
			const enabled = this.configurationService.getValue<boolean>('ishell.llm.diagnostics.enabled') ?? true;
			if (!onSave || !enabled) {
				return;
			}
			const resource = e.model.resource;
			if (inferLanguageFromPath(resource.path) === 'plaintext') {
				return;
			}
			this.getDelayer(resource.toString()).trigger(() => this.analyze(resource));
		}));
	}

	private getDelayer(key: string): ThrottledDelayer<void> {
		let delayer = this.delayers.get(key);
		if (!delayer) {
			delayer = new ThrottledDelayer<void>(DIAGNOSTIC_SAVE_DELAY);
			this.delayers.set(key, delayer);
		}
		return delayer;
	}

	private async analyze(resource: URI): Promise<void> {
		try {
			// 保存后磁盘即最新内容，直接读盘分析
			const content = (await this.fileService.readFile(resource)).value.toString();
			const report = await this.llmService.analyzeCode(content, inferLanguageFromPath(resource.path), resource.fsPath);
			applyDiagnosticsToMarkers(this.markerService, resource, report);
		} catch (err) {
			this.logService.warn(`[ishell-llm] 保存后自动诊断失败: ${(err as Error)?.message ?? err}`);
		}
	}

	override dispose(): void {
		for (const delayer of this.delayers.values()) {
			delayer.dispose();
		}
		super.dispose();
	}
}

// ==== 诊断命令 ====

/** 手动诊断当前活动编辑器文件：Markers 上屏 + 摘要通知 */
class DiagnoseActiveFileAction extends Action2 {

	static readonly ID = 'ishell.llm.diagnoseFile';

	constructor() {
		super({
			id: DiagnoseActiveFileAction.ID,
			title: localize2('ishell.llm.diagnoseFile.title', 'iShell：诊断当前文件代码'),
			category: { value: localize('ishell.category', 'iShell'), original: 'iShell' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const llmService = accessor.get(IIshellLlmService);
		const markerService = accessor.get(IMarkerService);
		const notificationService = accessor.get(INotificationService);

		const input = editorService.activeEditor;
		const resource = input?.resource;
		if (!input || !resource) {
			notificationService.info(localize('ishell.llm.diagnoseFile.noFile', '未打开可诊断的文件编辑器'));
			return;
		}
		try {
			// 读磁盘最新内容（编辑器可能未保存）
			const fileService = accessor.get(IFileService);
			let content = '';
			try {
				content = (await fileService.readFile(resource)).value.toString();
			} catch {
				notificationService.info(localize('ishell.llm.diagnoseFile.unsaved', '当前文件尚未保存到磁盘，请先保存'));
				return;
			}
			const language = inferLanguageFromPath(resource.path);
			const report = await llmService.analyzeCode(content, language, resource.fsPath);
			applyDiagnosticsToMarkers(markerService, resource, report);
			if (report.diagnostics.length === 0) {
				notificationService.info(localize('ishell.llm.diagnoseFile.clean', '诊断完成：未发现问题，质量评分 {0}/100', String(report.summary.score)));
			} else {
				const s = report.summary;
				notificationService.warn(localize(
					'ishell.llm.diagnoseFile.summary',
					'诊断完成：错误 {0} / 警告 {1} / 提示 {2}，质量评分 {3}/100（详情见问题面板，报告已归档）',
					String(s.errors), String(s.warnings), String(s.infos + s.hints), String(s.score),
				));
			}
		} catch (err) {
			notificationService.error(localize('ishell.llm.diagnoseFile.failed', '诊断失败：{0}', (err as Error)?.message ?? String(err)));
		}
	}
}

export function registerLlmDiagnosticsActions(): void {
	registerAction2(DiagnoseActiveFileAction);
}
