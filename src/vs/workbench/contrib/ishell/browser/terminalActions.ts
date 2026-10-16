/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IIshellService, IHostProfile, ISshConnectionSnapshot } from '../common/ishell.js';
import { SshTerminalEditorInput } from './sshTerminalEditorInput.js';

/** 终端命令所需服务集合（ServicesAccessor 不能跨 await 使用，必须在命令 run() 同步段捕获后传入） */
export interface IShellTerminalServices {
	ishellService: IIshellService;
	quickInput: IQuickInputService;
	notificationService: INotificationService;
	editorService: IEditorService;
	instantiationService: IInstantiationService;
}

/** 每会话终端序号（保证同一会话多终端 resource 唯一，可并存于不同编辑器组） */
const sessionTerminalSeq = new Map<string, number>();

function nextTerminalResource(sessionId: string): URI {
	const n = (sessionTerminalSeq.get(sessionId) ?? 0) + 1;
	sessionTerminalSeq.set(sessionId, n);
	return URI.from({ scheme: 'ishell-terminal', authority: sessionId, path: `/${n}` });
}

/** 等待会话进入 connected / failed（监听快照事件 + 当前状态查询，超时返回 undefined） */
export async function waitForSessionSettled(ishellService: IIshellService, sessionId: string, timeoutMs = 25000): Promise<ISshConnectionSnapshot | undefined> {
	const current = (await ishellService.getConnections()).find(s => s.id === sessionId);
	if (current && (current.status === 'connected' || current.status === 'failed')) {
		return current;
	}
	return new Promise<ISshConnectionSnapshot | undefined>(resolve => {
		const store = new DisposableStore();
		let settled = false;
		const done = (result: ISshConnectionSnapshot | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			store.dispose();
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => done(undefined), timeoutMs);
		store.add(ishellService.onDidChangeConnections(snapshot => {
			if (!snapshot || snapshot.id !== sessionId) {
				return;
			}
			if (snapshot.status === 'connected' || snapshot.status === 'failed') {
				done(snapshot);
			}
		}));
	});
}

/**
 * 为主机档案确保一条已连接会话（复用已有连接 / 发起新连接并等待结果）。
 * 返回会话快照；连接失败或超时返回 undefined 并通知错误。
 */
export async function ensureSessionForProfile(services: IShellTerminalServices, profile: IHostProfile): Promise<ISshConnectionSnapshot | undefined> {
	const { ishellService, notificationService, quickInput } = services;

	let snapshot = (await ishellService.getConnections()).find(s => s.id === profile.id);
	if (snapshot?.status === 'connected') {
		return snapshot;
	}

	if (!snapshot || snapshot.status === 'failed' || snapshot.status === 'disconnected') {
		// 发起连接（密码未存档时现场询问，逻辑与 connectHost 一致）
		let secret: string | undefined;
		if (profile.authMethod === 'password' && !profile.encSecret) {
			secret = await quickInput.input({
				placeHolder: localize('ishell.enterPassword', '输入 {0}@{1} 的密码', profile.username, profile.host),
				password: true,
				prompt: localize('ishell.passwordOnce', '密码仅在本次连接中使用，不会保存'),
			});
			if (secret === undefined) {
				return undefined; // 用户取消
			}
		}
		try {
			await ishellService.connect(profile.id, secret);
		} catch (err) {
			notificationService.error(localize('ishell.connectError', '连接失败：{0}', (err as Error).message));
			return undefined;
		}
	}

	snapshot = await waitForSessionSettled(ishellService, profile.id);
	if (!snapshot) {
		notificationService.warn(localize('ishell.connectTimeout', '连接 {0} 超时', profile.name || profile.host));
		return undefined;
	}
	if (snapshot.status !== 'connected') {
		notificationService.error(localize('ishell.connectFailed', '连接失败：{0}', snapshot.detail ?? snapshot.errorCode ?? '未知错误'));
		return undefined;
	}
	return snapshot;
}

/** 为主机档案打开终端（确保连接 → 打开编辑器标签） */
export async function openTerminalForProfile(services: IShellTerminalServices, profile: IHostProfile): Promise<void> {
	const snapshot = await ensureSessionForProfile(services, profile);
	if (snapshot) {
		await openTerminalEditorInput(services, snapshot.id, snapshot.label);
	}
}

/** 命令面板：新建终端（QuickPick 选择已连接会话或主机档案） */
export async function newTerminalCommand(services: IShellTerminalServices): Promise<void> {
	const { ishellService, quickInput, notificationService } = services;

	const [connections, profiles] = await Promise.all([
		ishellService.getConnections(),
		ishellService.getProfiles(),
	]);

	type PickItem = IQuickPickItem & { sessionId?: string; profile?: IHostProfile };
	const items: PickItem[] = [];

	// 已连接会话优先
	for (const s of connections.filter(s => s.status === 'connected')) {
		items.push({
			label: `$(terminal) ${s.label}`,
			description: localize('ishell.stConnected3', '已连接'),
			sessionId: s.id,
		});
	}
	// 未连接的主机档案（排除进行中/已连接的会话；failed/disconnected 会话仍可重新选择发起连接）
	const activeIds = new Set(connections
		.filter(s => s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting')
		.map(s => s.id));
	for (const p of profiles.hosts.filter(p => !activeIds.has(p.id))) {
		items.push({ label: `$(plug) ${p.name || p.host}`, description: `${p.username}@${p.host}`, profile: p });
	}

	if (items.length === 0) {
		notificationService.info(localize('ishell.noHosts', '还没有主机档案，请先在连接管理中新建连接'));
		return;
	}

	const picked = await quickInput.pick<PickItem>(items, {
		placeHolder: localize('ishell.pickTerminalHost', '选择要打开终端的主机'),
		matchOnDescription: true,
	});
	if (!picked) {
		return;
	}
	if (picked.sessionId !== undefined) {
		await openTerminalEditorInput(services, picked.sessionId, picked.label.replace(/^\$\(terminal\) /, ''));
	} else if (picked.profile) {
		await openTerminalForProfile(services, picked.profile);
	}
}

/** 创建终端 EditorInput 并打开编辑器标签（pinned） */
async function openTerminalEditorInput(services: IShellTerminalServices, sessionId: string, label: string): Promise<void> {
	const input = services.instantiationService.createInstance(SshTerminalEditorInput, nextTerminalResource(sessionId), sessionId, label);
	await services.editorService.openEditor(input, { pinned: true });
}
