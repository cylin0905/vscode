/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { ILlmFileVersion, IIshellLlmService } from '../common/llm.js';

// #########################################################################
// ##    iShell 版本历史（自动保存的每一次代码变更都可追溯）                   ##
// ##  指令跟随 / 自动修复 / 模型重写每次写盘前都会落独立版本快照；            ##
// ##  本文件提供 UI：QuickPick 选择版本 -> 回滚 / 预览 / 与当前文件对比      ##
// ##  回滚本身也会先把"当前内容"存为新快照，任何操作都可反悔                  ##
// #########################################################################

interface IVersionPickItem extends IQuickPickItem {
	version: ILlmFileVersion;
}

interface IActionPickItem extends IQuickPickItem {
	action: 'rollback' | 'preview' | 'diff';
}

/** 查看当前文件的 iShell 自动保存版本历史（回滚 / 预览 / 对比） */
class ShowFileHistoryAction extends Action2 {

	static readonly ID = 'ishell.llm.showFileHistory';

	constructor() {
		super({
			id: ShowFileHistoryAction.ID,
			title: localize2('ishell.llm.history.title', "查看文件版本历史（自动保存记录）"),
			category: { value: localize('ishell.category', "iShell"), original: 'iShell' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const editor = getCodeEditor(accessor.get(IEditorService).activeTextEditorControl);
		const uri = editor?.getModel()?.uri;
		if (!uri || !uri.fsPath) {
			notificationService.info(localize('ishell.llm.history.noEditor', '请先打开一个要查看版本历史的文件'));
			return;
		}
		const llmService = accessor.get(IIshellLlmService);
		const quickInputService = accessor.get(IQuickInputService);
		const versions = await llmService.getFileVersions(uri.fsPath);
		if (versions.length === 0) {
			notificationService.info(localize('ishell.llm.history.empty', '该文件暂无自动保存的版本记录（模型写盘 / 自动修复时会自动生成）'));
			return;
		}

		const pick = await quickInputService.pick<IVersionPickItem>(
			versions.map((version): IVersionPickItem => ({
				label: `$(history) ${new Date(version.time).toLocaleString()}`,
				description: localize('ishell.llm.history.size', '{0} B · {1}', String(version.bytes), version.id.slice(0, 8)),
				detail: version.preview.split('\n')[0]?.slice(0, 120) ?? '',
				version,
			})),
			{
				placeHolder: localize('ishell.llm.history.pickVersion', '选择一个版本（共 {0} 个，新记录在上）', String(versions.length)),
				matchOnDetail: true,
			},
		);
		if (!pick) {
			return;
		}

		const actionPick = await quickInputService.pick<IActionPickItem>([
			{ label: localize('ishell.llm.history.rollback', '$(arrow-left) 回滚到此版本（当前内容先存为新快照，可再次回滚）'), action: 'rollback' },
			{ label: localize('ishell.llm.history.preview', '$(eye) 预览此版本内容'), action: 'preview' },
			{ label: localize('ishell.llm.history.diff', '$(diff) 与当前文件对比'), action: 'diff' },
		], { placeHolder: localize('ishell.llm.history.pickAction', '选择操作') });
		if (!actionPick) {
			return;
		}

		const content = await llmService.readFileVersion(pick.version.id);
		if (!content) {
			notificationService.warn(localize('ishell.llm.history.readFailed', '版本内容读取失败（快照文件缺失）'));
			return;
		}
		const when = new Date(pick.version.time).toLocaleString();

		if (actionPick.action === 'rollback') {
			const textFileService = accessor.get(ITextFileService);
			const model = textFileService.files.get(uri)?.textEditorModel
				?? (await textFileService.files.resolve(uri)).textEditorModel;
			if (!model) {
				notificationService.warn(localize('ishell.llm.history.noModel', '无法解析当前文件，回滚中止'));
				return;
			}
			// 先快照当前内容：回滚本身可被再次回滚（完整可追溯）
			await llmService.recordFileVersion(uri.fsPath, model.getValue());
			model.setValue(content); // 编辑器内存事务：未保存前可 Ctrl+Z，由用户确认后持久化
			notificationService.info(localize('ishell.llm.history.rolled', '已回滚到 {0}（原内容已另存为快照，可 Ctrl+Z 撤销）', when));
			return;
		}

		const untitledService = accessor.get(IUntitledTextEditorService);
		const editorService = accessor.get(IEditorService);
		const versionModel = untitledService.create({ initialValue: content });
		if (actionPick.action === 'preview') {
			await editorService.openEditor({ resource: versionModel.resource });
			return;
		}
		// 与当前文件对比（左：历史版本，右：当前文件）
		await editorService.openEditor({
			original: { resource: versionModel.resource },
			modified: { resource: uri },
			label: localize('ishell.llm.history.diffLabel', '{0}（历史版本）↔ 当前', when),
		});
	}
}

export function registerLlmHistoryActions(): void {
	registerAction2(ShowFileHistoryAction);
}
