/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IHostProfile, IIshellService, IQuickConnectTarget, SshAuthMethod } from '../common/ishell.js';
import { notifySessionResult } from './connectionActions.js';

export interface IWizardServices {
	ishellService: IIshellService;
	quickInput: IQuickInputService;
	notificationService: INotificationService;
}

type AuthPickItem = IQuickPickItem & { method: SshAuthMethod };

function authMethodPicks(): AuthPickItem[] {
	return [
		{ label: localize('ishell.authPasswordPick', '$(symbol-key) 密码认证'), description: localize('ishell.authPasswordDesc', '使用账号密码登录'), method: 'password' },
		{ label: localize('ishell.authKeyPick', '$(file) 密钥文件'), description: localize('ishell.authKeyDesc', 'ed25519 / RSA 等私钥'), method: 'key' },
		{ label: localize('ishell.authAgentPick', '$(plug) SSH Agent'), description: localize('ishell.authAgentDesc', 'OpenSSH Agent 管道 / Pageant'), method: 'agent' },
	];
}

/**
 * 新建/编辑连接 —— 多步 QuickInput 向导。
 * existing 传入时为编辑模式（预填当前值）。
 */
export async function showConnectionWizard(services: IWizardServices, existing?: IHostProfile): Promise<void> {
	const { ishellService, quickInput, notificationService } = services;
	const editing = existing !== undefined;

	// 1. 基本信息
	const name = await quickInput.input({
		placeHolder: localize('ishell.wiz.name', '名称（别名，可留空）'),
		value: existing?.name ?? '',
		prompt: localize('ishell.wiz.namePrompt', '主机别名，留空则使用主机地址'),
	});
	if (name === undefined) { return; }

	const host = await quickInput.input({
		placeHolder: localize('ishell.wiz.host', '主机地址（IP 或域名）'),
		value: existing?.host ?? '',
		validateInput: async value => value.trim().length === 0 ? localize('ishell.wiz.hostRequired', '主机地址不能为空') : undefined,
	});
	if (host === undefined) { return; }

	const portStr = await quickInput.input({
		placeHolder: localize('ishell.wiz.port', '端口（默认 22）'),
		value: existing ? String(existing.port) : '22',
		validateInput: async value => {
			if (value.trim().length === 0) { return undefined; }
			const port = Number(value.trim());
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				return localize('ishell.wiz.portInvalid', '端口必须是 1-65535 的整数');
			}
			return undefined;
		},
	});
	if (portStr === undefined) { return; }
	const port = portStr.trim().length === 0 ? 22 : Number(portStr.trim());

	const username = await quickInput.input({
		placeHolder: localize('ishell.wiz.user', '用户名'),
		value: existing?.username ?? '',
		validateInput: async value => value.trim().length === 0 ? localize('ishell.wiz.userRequired', '用户名不能为空') : undefined,
	});
	if (username === undefined) { return; }

	// 2. 认证方式
	const authItems = authMethodPicks();
	const authPick = await quickInput.pick(authItems, {
		placeHolder: localize('ishell.wiz.auth', '选择认证方式'),
		activeItem: authItems.find(m => m.method === (existing?.authMethod ?? 'password')) ?? authItems[0],
	}) as AuthPickItem | undefined;
	if (!authPick) { return; }
	const authMethod = authPick.method;

	// 3. 认证详情
	let newSecret: string | undefined;           // 本次新输入的明文凭据
	let keepEncrypted = existing?.encSecret !== undefined; // 是否保留旧密文
	let keyPath: string | undefined = existing?.keyPath;
	let agentPipe: string | undefined = existing?.agentPipe;

	switch (authMethod) {
		case 'password': {
			const password = await quickInput.input({
				placeHolder: localize('ishell.wiz.password', '密码'),
				password: true,
				prompt: keepEncrypted
					? localize('ishell.wiz.passwordKeep', '留空并回车 = 保留已保存的密码')
					: undefined,
			});
			if (password === undefined) { return; }
			if (password.length > 0) {
				newSecret = password;
				const savePick = await quickInput.pick([
					{ label: localize('ishell.wiz.saveYes', '$(lock) 保存密码（DPAPI 加密存储）'), save: true },
					{ label: localize('ishell.wiz.saveNo', '$(circle-slash) 不保存（每次连接时输入）'), save: false },
				] as (IQuickPickItem & { save: boolean })[], { placeHolder: localize('ishell.wiz.saveTitle', '是否保存密码？') }) as (IQuickPickItem & { save: boolean }) | undefined;
				if (!savePick) { return; }
				keepEncrypted = savePick.save;
			}
			break;
		}
		case 'key': {
			const key = await quickInput.input({
				placeHolder: localize('ishell.wiz.keyPath', '私钥文件路径'),
				value: existing?.keyPath ?? '',
				prompt: localize('ishell.wiz.keyPrompt', '例如 C:\\Users\\you\\.ssh\\id_ed25519'),
				validateInput: async value => value.trim().length === 0 ? localize('ishell.wiz.keyRequired', '密钥路径不能为空') : undefined,
			});
			if (key === undefined) { return; }
			keyPath = key.trim();
			const passphrase = await quickInput.input({
				placeHolder: localize('ishell.wiz.passphrase', '密钥口令（无口令则留空）'),
				password: true,
			});
			if (passphrase === undefined) { return; }
			if (passphrase.length > 0) {
				newSecret = passphrase;
				keepEncrypted = true; // 加密密钥的口令随档案保存，自动重连需要
			} else {
				keepEncrypted = false;
			}
			break;
		}
		case 'agent': {
			const pipe = await quickInput.input({
				placeHolder: localize('ishell.wiz.agent', 'Agent 管道（留空 = 自动探测）'),
				value: existing?.agentPipe ?? '',
				prompt: localize('ishell.wiz.agentPrompt', '留空自动使用 OpenSSH Agent / Pageant'),
			});
			if (pipe === undefined) { return; }
			agentPipe = pipe.trim().length === 0 ? undefined : pipe.trim();
			break;
		}
	}

	// 4. 分组
	const data = await ishellService.getProfiles();
	const groupItems: (IQuickPickItem & { groupId: string | undefined })[] = [
		{ label: localize('ishell.noGroup', '$(circle-slash) 不分组'), groupId: undefined },
		...data.groups.map(g => ({ label: `$(folder) ${g.name}`, groupId: g.id })),
	];
	const groupPick = await quickInput.pick(groupItems, {
		placeHolder: localize('ishell.wiz.group', '所属分组'),
		activeItem: groupItems.find(g => g.groupId === existing?.groupId) ?? groupItems[0],
	}) as (IQuickPickItem & { groupId: string | undefined }) | undefined;
	if (!groupPick) { return; }

	// 5. 保存（encSecret 表达"是否保留旧密文"意图；newSecret 为新明文）
	const profile: IHostProfile = {
		id: existing?.id ?? generateUuid(),
		name: name.trim().length === 0 ? host.trim() : name.trim(),
		host: host.trim(),
		port,
		username: username.trim(),
		authMethod,
		keyPath,
		agentPipe,
		encSecret: keepEncrypted ? existing?.encSecret : undefined,
		groupId: groupPick.groupId,
		tags: existing?.tags,
	};

	try {
		await ishellService.saveProfile(profile, newSecret);
	} catch (err) {
		notificationService.error(localize('ishell.wiz.saveError', '保存失败：{0}', (err as Error).message));
		return;
	}

	// 6. 新建时询问是否立即连接
	if (!editing) {
		const goPick = await quickInput.pick([
			{ label: localize('ishell.wiz.saveOnly', '$(save) 仅保存'), connect: false },
			{ label: localize('ishell.wiz.saveConnect', '$(play) 保存并连接'), connect: true },
		] as (IQuickPickItem & { connect: boolean })[], { placeHolder: localize('ishell.wiz.done', '已保存 "{0}"', profile.name) }) as (IQuickPickItem & { connect: boolean }) | undefined;
		if (goPick?.connect) {
			await ishellService.connect(profile.id, newSecret);
		}
	}
}

/** 快速连接：user@host[:port]，不落盘 */
export async function showQuickConnect(services: IWizardServices): Promise<void> {
	const { ishellService, quickInput, notificationService } = services;

	const target0 = await quickInput.input({
		placeHolder: localize('ishell.qc.target', '快速连接 user@host[:port]（不会保存）'),
		prompt: localize('ishell.qc.prompt', '例如 root@192.168.1.100 或 root@ssh.example.com:2222'),
		validateInput: async value => value.trim().length === 0 ? localize('ishell.qc.required', '请输入连接目标') : undefined,
	});
	if (target0 === undefined) { return; }

	const parsed = parseUserAtHost(target0.trim());
	if (!parsed.host) {
		notificationService.error(localize('ishell.qc.invalid', '无法解析连接目标 "{0}"', target0));
		return;
	}
	let username = parsed.username;
	if (!username) {
		const inputUser = await quickInput.input({
			placeHolder: localize('ishell.qc.user', '用户名'),
			validateInput: async v => v.trim().length === 0 ? localize('ishell.wiz.userRequired', '用户名不能为空') : undefined,
		});
		if (inputUser === undefined) { return; }
		username = inputUser.trim();
	}

	const authPick = await quickInput.pick(authMethodPicks(), { placeHolder: localize('ishell.wiz.auth', '选择认证方式') }) as AuthPickItem | undefined;
	if (!authPick) { return; }

	const target: IQuickConnectTarget = {
		host: parsed.host,
		port: parsed.port ?? 22,
		username,
		authMethod: authPick.method,
	};

	switch (authPick.method) {
		case 'password': {
			const password = await quickInput.input({
				placeHolder: localize('ishell.qc.password', '密码'),
				password: true,
			});
			if (password === undefined) { return; }
			target.secret = password;
			break;
		}
		case 'key': {
			const key = await quickInput.input({
				placeHolder: localize('ishell.wiz.keyPath', '私钥文件路径'),
				validateInput: async v => v.trim().length === 0 ? localize('ishell.wiz.keyRequired', '密钥路径不能为空') : undefined,
			});
			if (key === undefined) { return; }
			target.keyPath = key.trim();
			const passphrase = await quickInput.input({
				placeHolder: localize('ishell.wiz.passphrase', '密钥口令（无口令则留空）'),
				password: true,
			});
			if (passphrase === undefined) { return; }
			if (passphrase.length > 0) {
				target.secret = passphrase;
			}
			break;
		}
		case 'agent': {
			break; // 自动探测
		}
	}

	try {
		const sessionId = await ishellService.quickConnect(target);
		notifySessionResult(ishellService, notificationService, sessionId);
	} catch (err) {
		notificationService.error(localize('ishell.qc.error', '连接失败：{0}', (err as Error).message));
	}
}

/** 解析 user@host[:port] / host[:port] */
export function parseUserAtHost(input: string): { username?: string; host?: string; port?: number } {
	const at = input.indexOf('@');
	const userPart = at >= 0 ? input.slice(0, at) : undefined;
	const hostPart = at >= 0 ? input.slice(at + 1) : input;
	if (hostPart.trim().length === 0) {
		return {};
	}
	let host: string;
	let port: number | undefined;
	if (hostPart.startsWith('[')) {
		// [IPv6]:port
		const close = hostPart.indexOf(']');
		if (close < 0) { return {}; }
		host = hostPart.slice(1, close);
		const portSuffix = hostPart.slice(close + 1);
		if (portSuffix.startsWith(':')) {
			const candidate = Number(portSuffix.slice(1));
			if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) {
				port = candidate;
			}
		}
	} else {
		const lastColon = hostPart.lastIndexOf(':');
		if (lastColon >= 0 && hostPart.indexOf(':') === lastColon) {
			const candidate = Number(hostPart.slice(lastColon + 1));
			if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) {
				host = hostPart.slice(0, lastColon);
				port = candidate;
			} else {
				host = hostPart;
			}
		} else {
			host = hostPart; // 纯 IPv6（无端口）
		}
	}
	return { username: userPart && userPart.length > 0 ? userPart : undefined, host, port };
}
