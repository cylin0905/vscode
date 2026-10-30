/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IIshellLlmService, ILlmSkillManifest, ILlmSkillRegistration, LlmSkillOrigin } from '../common/llm.js';

// #########################################################################
// ##     iShell Skill 管理界面 + 插件注册命令接口                            ##
// ##  - manageSkills：QuickPick 列表（启停切换 / 卸载 / 打开技能目录）      ##
// ##  - registerSkill：标准插件开发接口（executeCommand 传 JSON 清单）      ##
// ##  - unregisterSkill：按 id 卸载（内置拒绝）                              ##
// #########################################################################

interface ISkillItem extends IQuickPickItem {
	skill: ILlmSkillManifest;
}

interface IManageItem extends IQuickPickItem {
	action: 'open-folder' | 'unregister';
}

function originLabel(origin: LlmSkillOrigin): string {
	switch (origin) {
		case 'builtin': return localize('ishell.skills.originBuiltin', '内置');
		case 'user': return localize('ishell.skills.originUser', '自定义');
		case 'extension': return localize('ishell.skills.originExtension', '插件');
	}
}

/** Skill 管理（QuickPick 循环操作，Esc 退出） */
class ManageLlmSkillsAction extends Action2 {

	static readonly ID = 'ishell.llm.manageSkills';

	constructor() {
		super({
			id: ManageLlmSkillsAction.ID,
			title: localize2('ishell.llm.manageSkills.title', "管理本地模型 Skill（技能）"),
			category: { value: localize('ishell.category', "iShell"), original: 'iShell' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const llmService = accessor.get(IIshellLlmService);
		const quickInput = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		for (;;) {
			const skills = await llmService.getSkills();
			const items: (ISkillItem | IManageItem | IQuickPickSeparator)[] = [
				...skills.map(skill => ({
					label: skill.enabled
						? `$(check) ${skill.name}`
						: `$(circle-slash) ${skill.name}`,
					description: `${originLabel(skill.origin)} · v${skill.version}`,
					detail: `${skill.description}\n${localize('ishell.skills.triggers', '触发词：{0}', skill.triggers.join('、'))}`,
					skill,
				})),
				{ type: 'separator', label: localize('ishell.skills.manageSection', '管理') },
				{ label: `$(folder-opened) ${localize('ishell.skills.openFolder', '打开 Skill 用户目录（放置 *.json 热加载）')}`, action: 'open-folder' },
				{ label: `$(trash) ${localize('ishell.skills.unregisterEntry', '卸载自定义 / 插件 Skill...')}`, action: 'unregister' },
			];

			const pick = await quickInput.pick<ISkillItem | IManageItem>(items, {
				placeHolder: localize('ishell.skills.placeHolder', '选择 Skill 切换启停（Esc 退出）'),
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!pick) {
				return;
			}
			if ('action' in pick) {
				if (pick.action === 'open-folder') {
					await llmService.openSkillsFolder();
				} else {
					await this.pickUnregister(llmService, quickInput, notificationService);
				}
				continue;
			}
			const target = pick.skill.enabled ? false : true;
			try {
				const updated = await llmService.setSkillEnabled(pick.skill.id, target);
				notificationService.info(target
					? localize('ishell.skills.enabled', 'Skill 已启用：{0}', updated.name)
					: localize('ishell.skills.disabled', 'Skill 已停用：{0}', updated.name));
			} catch (err) {
				notificationService.error(localize('ishell.skills.toggleFailed', 'Skill 启停失败：{0}', (err as Error)?.message ?? String(err)));
			}
		}
	}

	private async pickUnregister(llmService: IIshellLlmService, quickInput: IQuickInputService, notificationService: INotificationService): Promise<void> {
		const custom = (await llmService.getSkills()).filter(s => s.origin !== 'builtin');
		if (custom.length === 0) {
			notificationService.info(localize('ishell.skills.noCustom', '当前没有可卸载的自定义 / 插件 Skill'));
			return;
		}
		const pick = await quickInput.pick<ISkillItem>(
			custom.map(skill => ({
				label: skill.name,
				description: `${originLabel(skill.origin)} · v${skill.version}`,
				detail: skill.description,
				skill,
			})),
			{ placeHolder: localize('ishell.skills.unregisterPlaceHolder', '选择要卸载的 Skill（内置 Skill 不可卸载）') },
		);
		if (!pick) {
			return;
		}
		try {
			await llmService.unregisterSkill(pick.skill.id);
			notificationService.info(localize('ishell.skills.unregistered', 'Skill 已卸载：{0}', pick.skill.name));
		} catch (err) {
			notificationService.error(localize('ishell.skills.unregisterFailed', '卸载失败：{0}', (err as Error)?.message ?? String(err)));
		}
	}
}

/**
 * 插件注册接口（功能 6 扩展点）：`workbench.actions.executeCommand('ishell.llm.registerSkill', manifest)`。
 * manifest 结构：{ id, name, description, version, triggers: string[], instruction, enabled?, extensionId? }
 * 校验在主进程注册中心完成，失败抛错并通知。
 */
class RegisterLlmSkillAction extends Action2 {

	static readonly ID = 'ishell.llm.registerSkill';

	constructor() {
		super({
			id: RegisterLlmSkillAction.ID,
			title: localize2('ishell.llm.registerSkill.title', "注册本地模型 Skill（插件接口）"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, registration?: unknown): Promise<ILlmSkillManifest | undefined> {
		const llmService = accessor.get(IIshellLlmService);
		const notificationService = accessor.get(INotificationService);
		try {
			const manifest = await llmService.registerSkill(registration as ILlmSkillRegistration);
			notificationService.info(localize('ishell.skills.registerDone', 'Skill 注册成功：{0}（{1}）', manifest.name, manifest.id));
			return manifest;
		} catch (err) {
			notificationService.error(localize('ishell.skills.registerFailed', 'Skill 注册失败：{0}', (err as Error)?.message ?? String(err)));
			return undefined;
		}
	}
}

/** 插件卸载接口：`executeCommand('ishell.llm.unregisterSkill', id)` */
class UnregisterLlmSkillAction extends Action2 {

	static readonly ID = 'ishell.llm.unregisterSkill';

	constructor() {
		super({
			id: UnregisterLlmSkillAction.ID,
			title: localize2('ishell.llm.unregisterSkill.title', "卸载本地模型 Skill（插件接口）"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const llmService = accessor.get(IIshellLlmService);
		const notificationService = accessor.get(INotificationService);
		if (typeof id !== 'string' || id === '') {
			notificationService.error(localize('ishell.skills.unregisterMissingId', '缺少 Skill id 参数'));
			return;
		}
		try {
			await llmService.unregisterSkill(id);
			notificationService.info(localize('ishell.skills.unregistered', 'Skill 已卸载：{0}', id));
		} catch (err) {
			notificationService.error(localize('ishell.skills.unregisterFailed', '卸载失败：{0}', (err as Error)?.message ?? String(err)));
		}
	}
}

export function registerLlmSkillActions(): void {
	registerAction2(ManageLlmSkillsAction);
	registerAction2(RegisterLlmSkillAction);
	registerAction2(UnregisterLlmSkillAction);
}
