/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { IConnectionsData, IHostGroup, IHostProfile } from '../common/ishell.js';

/** 敏感字段编解码（主进程注入 safeStorage/DPAPI 实现；单测注入假实现） */
export interface ISecretCodec {
	encrypt(value: string): Promise<string>;
	decrypt(value: string): Promise<string>;
}

/** 文件 IO 抽象（主进程注入 fs；单测注入内存实现） */
export interface IFileIO {
	readFile(): Promise<string | undefined>;
	writeFile(content: string): Promise<void>;
}

export const EMPTY_CONNECTIONS_DATA: IConnectionsData = { version: 1, groups: [], hosts: [] };

/**
 * 主机档案存储：JSON 文件 + 敏感字段（密码/密钥口令）加密后落盘。
 * 纯逻辑类，不直接触碰 fs / electron。
 */
export class ConnectionStore {

	private data: IConnectionsData = EMPTY_CONNECTIONS_DATA;

	constructor(
		private readonly io: IFileIO,
		private readonly codec: ISecretCodec
	) { }

	async load(): Promise<IConnectionsData> {
		const raw = await this.io.readFile();
		if (raw === undefined || raw.trim() === '') {
			this.data = EMPTY_CONNECTIONS_DATA;
			return this.data;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error('connections.json 解析失败（文件损坏）');
		}
		this.data = this.validate(parsed);
		return this.get();
	}

	/** 返回深拷贝，避免外部直接修改内部状态 */
	get(): IConnectionsData {
		return JSON.parse(JSON.stringify(this.data));
	}

	private async persist(): Promise<void> {
		await this.io.writeFile(JSON.stringify(this.data, null, '\t'));
	}

	private validate(parsed: unknown): IConnectionsData {
		if (typeof parsed !== 'object' || parsed === null) {
			return EMPTY_CONNECTIONS_DATA;
		}
		const candidate = parsed as Partial<IConnectionsData>;
		const groups = Array.isArray(candidate.groups) ? candidate.groups.filter(g => g && typeof g.id === 'string' && typeof g.name === 'string') : [];
		const hosts = Array.isArray(candidate.hosts) ? candidate.hosts.filter(h => h && typeof h.id === 'string' && typeof h.host === 'string') : [];
		return { version: 1, groups, hosts };
	}

	// ==== 档案 CRUD ====

	/**
	 * 保存主机档案。
	 * - secret !== undefined：将新明文加密后存入 encSecret
	 * - secret === undefined：以 profile.encSecret 表达意图（保留旧密文 = 传入旧值；清除 = 传 undefined）
	 */
	async saveProfile(profile: IHostProfile, secret: string | undefined): Promise<IHostProfile> {
		const next: IHostProfile = { ...profile };
		if (secret !== undefined) {
			next.encSecret = await this.codec.encrypt(secret);
		}
		const index = this.data.hosts.findIndex(h => h.id === next.id);
		if (index >= 0) {
			this.data.hosts[index] = next;
		} else {
			this.data.hosts.push(next);
		}
		await this.persist();
		return this.get().hosts.find(h => h.id === next.id)!;
	}

	async deleteProfile(id: string): Promise<void> {
		this.data.hosts = this.data.hosts.filter(h => h.id !== id);
		await this.persist();
	}

	async resolveSecret(profile: IHostProfile): Promise<string | undefined> {
		if (profile.encSecret === undefined) {
			return undefined;
		}
		try {
			return await this.codec.decrypt(profile.encSecret);
		} catch {
			return undefined;
		}
	}

	// ==== 分组 CRUD ====

	async createGroup(name: string): Promise<IHostGroup> {
		const group: IHostGroup = { id: generateUuid(), name };
		this.data.groups.push(group);
		await this.persist();
		return group;
	}

	async renameGroup(id: string, name: string): Promise<void> {
		const group = this.data.groups.find(g => g.id === id);
		if (group) {
			group.name = name;
			await this.persist();
		}
	}

	async deleteGroup(id: string, deleteHosts: boolean): Promise<void> {
		this.data.groups = this.data.groups.filter(g => g.id !== id);
		if (deleteHosts) {
			this.data.hosts = this.data.hosts.filter(h => h.groupId !== id);
		} else {
			for (const host of this.data.hosts) {
				if (host.groupId === id) {
					host.groupId = undefined;
				}
			}
		}
		await this.persist();
	}

	async moveProfileToGroup(profileId: string, groupId: string | undefined): Promise<void> {
		const host = this.data.hosts.find(h => h.id === profileId);
		if (host) {
			host.groupId = groupId;
			await this.persist();
		}
	}
}
