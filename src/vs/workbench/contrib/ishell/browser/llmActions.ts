/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ILlmModelRecord, IIshellLlmService, LlmSourceKind } from '../common/llm.js';
import { LlmModelsView } from './llmModelsView.js';

// ==== 视图打开辅助（供其他视图/命令复用） ====

export async function openLlmModelsView(viewsService: IViewsService): Promise<void> {
	await viewsService.openView(LlmModelsView.ID, true);
}

// ==== 命令 ====

interface ILlmCommandServices {
	viewsService: IViewsService;
	llmService: IIshellLlmService;
	quickInput: IQuickInputService;
	notificationService: INotificationService;
}

/** 命令 run() 同步段捕获服务（ServicesAccessor 不可跨 await） */
function llmServices(accessor: ServicesAccessor): ILlmCommandServices {
	return {
		viewsService: accessor.get(IViewsService),
		llmService: accessor.get(IIshellLlmService),
		quickInput: accessor.get(IQuickInputService),
		notificationService: accessor.get(INotificationService),
	};
}

/** 打开本地模型管理（含对话与日志面板） */
export class OpenLlmModelsViewAction extends Action2 {
	static readonly ID = 'ishell.llm.openModels';
	constructor() {
		super({
			id: OpenLlmModelsViewAction.ID,
			title: localize2('ishell.llm.cmd.openModels', "打开本地模型管理"),
			category: localize2('ishell.category', "iShell"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await openLlmModelsView(llmServices(accessor).viewsService);
	}
}

/** 切换下载源（QuickPick） */
export class SwitchLlmSourceAction extends Action2 {
	static readonly ID = 'ishell.llm.switchSource';
	constructor() {
		super({
			id: SwitchLlmSourceAction.ID,
			title: localize2('ishell.llm.cmd.switchSource', "本地模型：切换下载源"),
			category: localize2('ishell.category', "iShell"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const s = llmServices(accessor);
		const pick = await s.quickInput.pick<IQuickPickItem & { kind: LlmSourceKind }>([
			{ label: localize('ishell.llm.srcModelScope', '魔搭社区（ModelScope）'), description: '国内模型社区，GGUF 资源丰富', kind: 'modelscope' },
			{ label: localize('ishell.llm.srcMirror', '国内镜像源（hf-mirror.com）'), description: '推荐国内网络使用', kind: 'mirror' },
			{ label: localize('ishell.llm.srcOfficial', '国外官方源（HuggingFace）'), description: '海外网络使用', kind: 'official' },
			{ label: localize('ishell.llm.srcCustom', '自定义源…'), description: '输入自定义下载端点', kind: 'custom' },
		], { placeHolder: localize('ishell.llm.pickSource', '选择模型下载源') });
		if (!pick) {
			return;
		}
		try {
			let endpoint: string | undefined;
			if (pick.kind === 'custom') {
				endpoint = await s.quickInput.input({
					placeHolder: localize('ishell.llm.customEndpointHint', '输入自定义源地址（http:// 或 https:// 开头）'),
					validateInput: async value => value.trim().startsWith('http://') || value.trim().startsWith('https://') ? undefined : localize('ishell.llm.endpointInvalid', '地址必须以 http:// 或 https:// 开头'),
				});
				if (endpoint === undefined) {
					return;
				}
			}
			await s.llmService.setSource(pick.kind, endpoint);
			s.notificationService.info(localize('ishell.llm.sourceSwitched', "下载源已切换"));
		} catch (err) {
			s.notificationService.error((err as Error).message);
		}
	}
}

/** 启动模型（QuickPick 已下载模型） */
export class StartLlmModelAction extends Action2 {
	static readonly ID = 'ishell.llm.startModel';
	constructor() {
		super({
			id: StartLlmModelAction.ID,
			title: localize2('ishell.llm.cmd.startModel', "本地模型：启动模型"),
			category: localize2('ishell.category', "iShell"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const s = llmServices(accessor);
		const models: ILlmModelRecord[] = await s.llmService.getModels();
		if (models.length === 0) {
			s.notificationService.info(localize('ishell.llm.noModels', "还没有已下载的模型，请先在本地模型管理中下载"));
			await openLlmModelsView(s.viewsService);
			return;
		}
		const pick = await s.quickInput.pick<IQuickPickItem & { model: ILlmModelRecord }>(
			models.map(m => ({ label: m.name, description: m.filePath, model: m })),
			{ placeHolder: localize('ishell.llm.pickModel', '选择要启动的模型') }
		);
		if (!pick) {
			return;
		}
		try {
			await s.llmService.startModel(pick.model.id);
			await openLlmModelsView(s.viewsService);
		} catch (err) {
			s.notificationService.error((err as Error).message);
		}
	}
}

/** 停止模型 */
export class StopLlmModelAction extends Action2 {
	static readonly ID = 'ishell.llm.stopModel';
	constructor() {
		super({
			id: StopLlmModelAction.ID,
			title: localize2('ishell.llm.cmd.stopModel', "本地模型：停止模型"),
			category: localize2('ishell.category', "iShell"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const s = llmServices(accessor);
		try {
			await s.llmService.stopModel();
		} catch (err) {
			s.notificationService.error((err as Error).message);
		}
	}
}

export function registerLlmActions(): void {
	registerAction2(OpenLlmModelsViewAction);
	registerAction2(SwitchLlmSourceAction);
	registerAction2(StartLlmModelAction);
	registerAction2(StopLlmModelAction);
}
