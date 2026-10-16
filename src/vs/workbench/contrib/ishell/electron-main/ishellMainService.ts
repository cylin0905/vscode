/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp, existsSync } from 'fs';
import { join, dirname } from 'path';
import { Client as Ssh2Client } from 'ssh2';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEncryptionMainService } from '../../../../platform/encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConnectionsData, IHostGroup, IHostKeyPrompt, IHostProfile, IIshellService, IQuickConnectTarget, ISshConnectionSnapshot } from '../common/ishell.js';
import { ConnectionStore, EMPTY_CONNECTIONS_DATA, IFileIO } from '../node/connectionStore.js';
import { KnownHostsStore } from '../node/knownHostsStore.js';
import { SshConnectionPool } from '../node/sshConnectionPool.js';
import type { ISshClientLike } from '../node/sshSession.js';

class NodeFileIO implements IFileIO {

	constructor(private readonly filePath: string) { }

	async readFile(): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.filePath, 'utf8');
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') {
				return undefined;
			}
			throw err;
		}
	}

	async writeFile(content: string): Promise<void> {
		await fsp.mkdir(dirname(this.filePath), { recursive: true });
		await fsp.writeFile(this.filePath, content, 'utf8');
	}
}

/**
 * iShell 连接管理主进程服务：
 * - 主机档案 JSON 持久化（敏感字段经 safeStorage/DPAPI 加密）
 * - known_hosts 指纹管理与硬阻断
 * - SSH 连接池（渲染层崩溃不影响连接）
 * 经 app.ts 挂载到 'ishell' IPC 通道（ProxyChannel）。
 */
export class IshellMainService extends Disposable implements IIshellService {

	declare readonly _serviceBrand: undefined;

	private readonly store: ConnectionStore;
	private readonly knownHosts: KnownHostsStore;
	private readonly pool: SshConnectionPool;
	private profilesCache: IConnectionsData = EMPTY_CONNECTIONS_DATA;
	private loaded: Promise<void>;

	private readonly _onDidChangeProfiles = new Emitter<void>();
	readonly onDidChangeProfiles: Event<void> = this._onDidChangeProfiles.event;

	private readonly _onDidChangeConnections = new Emitter<ISshConnectionSnapshot | undefined>();
	readonly onDidChangeConnections: Event<ISshConnectionSnapshot | undefined> = this._onDidChangeConnections.event;

	private readonly _onDidRequestHostKeyConfirm = new Emitter<IHostKeyPrompt>();
	readonly onDidRequestHostKeyConfirm: Event<IHostKeyPrompt> = this._onDidRequestHostKeyConfirm.event;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IEncryptionMainService encryptionMainService: IEncryptionMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const dataDir = join(environmentMainService.userDataPath, 'ishell');
		this.store = new ConnectionStore(new NodeFileIO(join(dataDir, 'connections.json')), encryptionMainService);
		this.knownHosts = new KnownHostsStore(new NodeFileIO(join(dataDir, 'known_hosts.json')));

		this.pool = this._register(new SshConnectionPool(
			{
				keepaliveIntervalMs: Math.max(1, configurationService.getValue<number>('ishell.connection.keepaliveIntervalSeconds') ?? 15) * 1000,
				keepaliveCountMax: configurationService.getValue<number>('ishell.connection.keepaliveCountMax') ?? 3,
				readyTimeoutMs: Math.max(1, configurationService.getValue<number>('ishell.connection.connectTimeoutSeconds') ?? 15) * 1000,
				reconnectEnabled: configurationService.getValue<boolean>('ishell.connection.reconnectEnabled') ?? true,
				reconnectPolicy: {
					initialDelayMs: 1000,
					factor: 2,
					maxDelayMs: Math.max(1, configurationService.getValue<number>('ishell.connection.reconnectMaxDelaySeconds') ?? 30) * 1000,
					maxRetries: configurationService.getValue<number>('ishell.connection.reconnectMaxRetries') ?? 10,
				},
			},
			{
				loadPrivateKey: async path => fsp.readFile(path, 'utf8'),
				resolveAgent: () => this.resolveAgentPipe(),
				log: message => this.logService.info(`[ishell] ${message}`),
			},
			this.knownHosts,
			// ssh2 v1.17 运行时支持 keyboard-interactive 事件，但 @types/ssh2 1.15 缺少该事件重载，此处做一次结构断言
			() => new Ssh2Client() as unknown as ISshClientLike
		));

		this._register(this.pool.onDidChange(e => this._onDidChangeConnections.fire(e)));
		this._register(this.pool.onDidRequestHostKeyConfirm(e => this._onDidRequestHostKeyConfirm.fire(e)));

		this._register(lifecycleMainService.onWillShutdown(() => this.pool.dispose()));

		this.loaded = this.loadInitialData();
	}

	private async loadInitialData(): Promise<void> {
		try {
			this.profilesCache = await this.store.load();
		} catch (err) {
			this.logService.error(`[ishell] 档案加载失败：${(err as Error).message}`);
		}
		try {
			await this.knownHosts.load();
		} catch (err) {
			this.logService.error(`[ishell] known_hosts 加载失败：${(err as Error).message}`);
		}
	}

	private resolveAgentPipe(): string | undefined {
		if (process.platform === 'win32') {
			// 优先 Windows 内置 OpenSSH Agent，其次 Pageant
			try {
				if (existsSync('\\\\.\\pipe\\openssh-ssh-agent')) {
					return '\\\\.\\pipe\\openssh-ssh-agent';
				}
			} catch {
				// ignore
			}
			return 'pageant';
		}
		return process.env.SSH_AUTH_SOCK || undefined;
	}

	// ==== 档案管理 ====

	async getProfiles(): Promise<IConnectionsData> {
		await this.loaded;
		return this.profilesCache;
	}

	async saveProfile(profile: IHostProfile, secret: string | undefined): Promise<IHostProfile> {
		await this.loaded;
		const saved = await this.store.saveProfile(profile, secret);
		this.profilesCache = this.store.get();
		this._onDidChangeProfiles.fire();
		return saved;
	}

	async deleteProfile(id: string): Promise<void> {
		await this.loaded;
		this.pool.disconnect(id);
		await this.store.deleteProfile(id);
		this.profilesCache = this.store.get();
		this._onDidChangeProfiles.fire();
	}

	async createGroup(name: string): Promise<IHostGroup> {
		await this.loaded;
		const group = await this.store.createGroup(name);
		this.profilesCache = this.store.get();
		this._onDidChangeProfiles.fire();
		return group;
	}

	async renameGroup(id: string, name: string): Promise<void> {
		await this.loaded;
		await this.store.renameGroup(id, name);
		this.profilesCache = this.store.get();
		this._onDidChangeProfiles.fire();
	}

	async deleteGroup(id: string, deleteHosts: boolean): Promise<void> {
		await this.loaded;
		const hosts = this.profilesCache.hosts.filter(h => h.groupId === id);
		for (const host of hosts) {
			this.pool.disconnect(host.id);
		}
		await this.store.deleteGroup(id, deleteHosts);
		this.profilesCache = this.store.get();
		this._onDidChangeProfiles.fire();
	}

	async moveProfileToGroup(profileId: string, groupId: string | undefined): Promise<void> {
		await this.loaded;
		await this.store.moveProfileToGroup(profileId, groupId);
		this.profilesCache = this.store.get();
		this._onDidChangeProfiles.fire();
	}

	// ==== 连接管理 ====

	async connect(profileId: string, secret: string | undefined): Promise<void> {
		await this.loaded;
		const profile = this.profilesCache.hosts.find(h => h.id === profileId);
		if (!profile) {
			throw new Error(`主机档案不存在：${profileId}`);
		}
		// 未显式传入凭据时使用已存档的加密凭据
		const resolvedSecret = secret ?? await this.store.resolveSecret(profile);
		await this.pool.connectProfile(profile, resolvedSecret);
	}

	async quickConnect(target: IQuickConnectTarget): Promise<string> {
		await this.loaded;
		return this.pool.quickConnect(target);
	}

	async disconnect(sessionId: string): Promise<void> {
		this.pool.disconnect(sessionId);
	}

	async getConnections(): Promise<ISshConnectionSnapshot[]> {
		return this.pool.getSnapshots();
	}

	async confirmHostKey(sessionId: string, accepted: boolean): Promise<void> {
		this.pool.resolveHostKeyConfirmation(sessionId, accepted);
	}
}
