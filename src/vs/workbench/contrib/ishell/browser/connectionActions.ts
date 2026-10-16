/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHostProfile, IIshellService, ISshConnectionSnapshot } from '../common/ishell.js';

/** 连接一个已存档主机（必要时现场询问密码，不落盘） */
export async function connectHost(instantiationService: IInstantiationService, profile: IHostProfile): Promise<void> {
	await instantiationService.invokeFunction(async accessor => {
		const ishellService = accessor.get(IIshellService);
		const quickInput = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		let secret: string | undefined;
		if (profile.authMethod === 'password' && !profile.encSecret) {
			secret = await quickInput.input({
				placeHolder: localize('ishell.enterPassword', '输入 {0}@{1} 的密码', profile.username, profile.host),
				password: true,
				prompt: localize('ishell.passwordOnce', '密码仅在本次连接中使用，不会保存'),
			});
			if (secret === undefined) {
				return; // 用户取消
			}
		}

		try {
			await ishellService.connect(profile.id, secret);
		} catch (err) {
			notificationService.error(localize('ishell.connectError', '连接失败：{0}', (err as Error).message));
		}
	});
}

/** 移动主机到分组 */
export async function moveHostToGroup(instantiationService: IInstantiationService, profile: IHostProfile): Promise<void> {
	await instantiationService.invokeFunction(async accessor => {
		const ishellService = accessor.get(IIshellService);
		const quickInput = accessor.get(IQuickInputService);

		const data = await ishellService.getProfiles();
		const items: IQuickPickItem[] = [
			{ label: localize('ishell.noGroup', '$(circle-slash) 不分组') },
			...data.groups.map(g => ({ label: `$(folder) ${g.name}` })),
		];
		const picked = await quickInput.pick(items, { placeHolder: localize('ishell.moveTo', '移动 "{0}" 到分组', profile.name || profile.host), matchOnLabel: true });
		if (!picked) {
			return;
		}
		const index = items.indexOf(picked);
		const groupId = index === 0 ? undefined : data.groups[index - 1].id;
		await ishellService.moveProfileToGroup(profile.id, groupId);
	});
}

/** 删除主机（二次确认） */
export async function deleteHost(instantiationService: IInstantiationService, profile: IHostProfile): Promise<void> {
	await instantiationService.invokeFunction(async accessor => {
		const ishellService = accessor.get(IIshellService);
		const dialogService = accessor.get(IDialogService);

		const { confirmed } = await dialogService.confirm({
			type: Severity.Warning,
			message: localize('ishell.deleteHost', '删除连接 "{0}"？', profile.name || profile.host),
			detail: localize('ishell.deleteHostDetail', '将同时删除其已保存的凭据与分组归属，已建立的连接会被断开。'),
			primaryButton: localize({ key: 'ishell.delete', comment: ['&& denotes a mnemonic'] }, '&&删除'),
		});
		if (confirmed) {
			await ishellService.deleteProfile(profile.id);
		}
	});
}

/** 删除分组（二选一确认） */
export async function deleteGroup(instantiationService: IInstantiationService, group: { id: string; name: string }): Promise<void> {
	await instantiationService.invokeFunction(async accessor => {
		const ishellService = accessor.get(IIshellService);
		const dialogService = accessor.get(IDialogService);

		const choice = await dialogService.prompt<number>({
			type: Severity.Warning,
			message: localize('ishell.deleteGroup', '删除分组 "{0}"？', group.name),
			buttons: [
				{ label: localize('ishell.deleteGroupOnly', '仅删除分组（主机移入未分组）'), run: () => 0 },
				{ label: localize('ishell.deleteGroupAndHosts', '删除分组及全部主机'), run: () => 1 },
			],
			cancelButton: localize('ishell.cancel', '取消'),
		});
		if (choice.result === 0) {
			await ishellService.deleteGroup(group.id, false);
		} else if (choice.result === 1) {
			await ishellService.deleteGroup(group.id, true);
		}
	});
}

/** 监听会话直到连接成功/失败，弹通知（用于快速连接） */
export function notifySessionResult(ishellService: IIshellService, notificationService: INotificationService, sessionId: string): void {
	const disposable = ishellService.onDidChangeConnections(snapshot => {
		if (!snapshot || snapshot.id !== sessionId) {
			return;
		}
		if (snapshot.status === 'connected') {
			disposable.dispose();
			notificationService.info(localize('ishell.quickConnected', '已连接 {0}', snapshot.label));
		} else if (snapshot.status === 'failed') {
			disposable.dispose();
			notificationService.error(localize('ishell.quickFailed', '连接失败：{0}', snapshot.detail ?? snapshot.errorCode ?? '未知错误'));
		}
	});
}

/** 命令面板：断开会话（列出所有活动会话选择） */
export async function pickAndDisconnect(instantiationService: IInstantiationService): Promise<void> {
	await instantiationService.invokeFunction(async accessor => {
		const ishellService = accessor.get(IIshellService);
		const quickInput = accessor.get(IQuickInputService);

		const snapshots = (await ishellService.getConnections())
			.filter(s => s.status !== 'disconnected');
		if (snapshots.length === 0) {
			return;
		}
		const items: (IQuickPickItem & { snapshot: ISshConnectionSnapshot })[] = snapshots.map(s => ({
			label: s.label,
			description: s.status === 'connected' ? localize('ishell.stConnected2', '已连接') : s.status === 'connecting' ? localize('ishell.stConnecting2', '连接中') : localize('ishell.stReconnecting2', '重连中'),
			snapshot: s,
		}));
		const picked = await quickInput.pick<IQuickPickItem & { snapshot: ISshConnectionSnapshot }>(items, { placeHolder: localize('ishell.pickDisconnect', '选择要断开的会话') });
		if (picked) {
			await ishellService.disconnect(picked.snapshot.id);
		}
	});
}
