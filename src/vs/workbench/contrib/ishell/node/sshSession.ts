/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ISshConnectionSnapshot, SshAuthMethod } from '../common/ishell.js';
import { BackoffController, IReconnectPolicy } from './backoff.js';
import { HostKeyVerificationResult } from './knownHostsStore.js';

// ==== 可注入的 ssh2 客户端抽象（便于单测 mock） ====

/** ssh2 ClientChannel（shell 通道）的最小抽象 */
export interface ISshChannelLike {
	write(data: string | Buffer): boolean;
	/** PTY 窗口尺寸变化（cols/rows + 像素高宽，像素可传 0） */
	setWindow(rows: number, cols: number, height: number, width: number): void;
	close(): void;
	destroy(): void;
	on(event: 'data', listener: (data: Buffer) => void): ISshChannelLike;
	on(event: 'close', listener: () => void): ISshChannelLike;
	on(event: 'error', listener: (err: Error) => void): ISshChannelLike;
}

export interface ISshClientLike {
	connect(config: object): ISshClientLike;
	end(): ISshClientLike;
	destroy(): void;
	/** 打开交互 shell 通道（请求 PTY），流经 callback 返回 */
	shell(window: { term: string; cols: number; rows: number }, callback: (err: Error | undefined, stream: ISshChannelLike) => void): ISshClientLike;
	on(event: 'ready', listener: () => void): ISshClientLike;
	on(event: 'error', listener: (err: Error & { level?: string }) => void): ISshClientLike;
	on(event: 'close', listener: () => void): ISshClientLike;
	on(event: 'end', listener: () => void): ISshClientLike;
	on(event: 'keyboard-interactive', listener: (name: string, instructions: string, instructionsLang: string, prompts: { prompt: string; echo: boolean }[], finish: (answers: string[]) => void) => void): ISshClientLike;
}

export type SshClientFactory = () => ISshClientLike;

// ==== 连接目标与选项 ====

export interface ISshTarget {
	host: string;
	port: number;
	username: string;
	authMethod: SshAuthMethod;
	keyPath?: string;
	agentPipe?: string;
	/** 明文凭据（内存中），用于密码认证 / 密钥口令 / keyboard-interactive */
	secret?: string;
}

export interface ISshSessionOptions {
	keepaliveIntervalMs: number;
	keepaliveCountMax: number;
	readyTimeoutMs: number;
	reconnectEnabled: boolean;
	reconnectPolicy: IReconnectPolicy;
}

export const DEFAULT_SSH_SESSION_OPTIONS: ISshSessionOptions = {
	keepaliveIntervalMs: 15000,
	keepaliveCountMax: 3,
	readyTimeoutMs: 15000,
	reconnectEnabled: true,
	reconnectPolicy: {
		initialDelayMs: 1000,
		maxDelayMs: 30000,
		factor: 2,
		maxRetries: 10,
	},
};

export interface ISshSessionCallbacks {
	/** 指纹验证（查 known_hosts）：known / unknown / mismatch */
	onVerifyHostKey(host: string, port: number, fingerprint: string): Promise<HostKeyVerificationResult>;
	/** 新指纹弹出用户确认（true = 接受并记住） */
	onConfirmHostKey(host: string, port: number, algorithm: string, fingerprint: string): Promise<boolean>;
	/** 用户接受新指纹后记录到 known_hosts */
	onConfirmAccepted(host: string, port: number, algorithm: string, fingerprint: string): Promise<void>;
	/** 读取密钥文件内容 */
	loadPrivateKey(path: string): Promise<string>;
	/** 解析 SSH Agent 管道地址 */
	resolveAgent(): string | undefined;
	/** 日志 */
	log(message: string): void;
}

const enum InternalState {
	Idle,
	Connecting,
	Connected,
	Reconnecting,
	Terminal,
	UserClosed,
}

/**
 * 单条 SSH 连接的完整状态机：
 * connecting -> connected -> (意外断开) reconnecting -> connecting -> ...
 * 任意阶段可进入 failed（认证失败 / 指纹变更 / 重试耗尽）或主动 disconnected。
 * keepalive 探活 + 指数退避重连。
 */
export class SshSession {

	private state: InternalState = InternalState.Idle;
	private client: ISshClientLike | undefined;
	private everConnected = false;
	private terminalDetail: { message: string; code: ISshConnectionSnapshot['errorCode'] } | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingRetry: { attemptNo: number; delayMs: number } | undefined;
	private readonly backoff: BackoffController;

	private readonly _onDidChangeSnapshot = new Emitter<ISshConnectionSnapshot>();
	readonly onDidChangeSnapshot: Event<ISshConnectionSnapshot> = this._onDidChangeSnapshot.event;

	constructor(
		readonly id: string,
		readonly label: string,
		private readonly target: ISshTarget,
		private readonly options: ISshSessionOptions,
		private readonly callbacks: ISshSessionCallbacks,
		private readonly clientFactory: SshClientFactory,
	) {
		this.backoff = new BackoffController(options.reconnectPolicy);
	}

	get connected(): boolean {
		return this.state === InternalState.Connected;
	}

	get closed(): boolean {
		return this.state === InternalState.UserClosed || this.state === InternalState.Terminal;
	}

	snapshot(): ISshConnectionSnapshot {
		const base: ISshConnectionSnapshot = {
			id: this.id,
			label: this.label,
			host: this.target.host,
			port: this.target.port,
			username: this.target.username,
			status: 'disconnected',
		};
		switch (this.state) {
			case InternalState.Connecting:
				return { ...base, status: 'connecting', detail: this.terminalDetail === undefined ? '连接中…' : undefined };
			case InternalState.Connected:
				return { ...base, status: 'connected' };
			case InternalState.Reconnecting: {
				const delay = this.pendingRetry?.delayMs ?? this.backoff.peekDelay();
				const attemptNo = this.pendingRetry?.attemptNo ?? (this.backoff.attempts + 1);
				return { ...base, status: 'reconnecting', retryCount: this.backoff.attempts, detail: `连接断开，${Math.round(delay / 1000)} 秒后进行第 ${attemptNo} 次重连` };
			}
			case InternalState.Terminal:
				return { ...base, status: 'failed', detail: this.terminalDetail?.message, errorCode: this.terminalDetail?.code };
			default:
				return base;
		}
	}

	private fireSnapshot(): void {
		this._onDidChangeSnapshot.fire(this.snapshot());
	}

	// ==== 对外操作 ====

	/** 发起连接（幂等：进行中/已连接时忽略） */
	async connect(): Promise<void> {
		if (this.state === InternalState.Connecting || this.state === InternalState.Connected || this.state === InternalState.Reconnecting) {
			return;
		}
		this.everConnected = false;
		this.terminalDetail = undefined;
		this.backoff.reset();
		await this.doConnect();
	}

	/** 主动断开：不触发重连 */
	disconnect(): void {
		if (this.state === InternalState.UserClosed || this.state === InternalState.Terminal) {
			return;
		}
		this.clearRetryTimer();
		this.state = InternalState.UserClosed;
		this.destroyClient();
		this.fireSnapshot();
	}

	/**
	 * 在已连接会话上打开交互 shell 通道（请求 PTY，xterm-256color）。
	 * 单连接多通道复用：可同时打开多个互不干扰的通道。
	 * 通道生命周期不随会话重连延续：断线后通道即死，由上层（SshTerminalManager）负责重开。
	 */
	openShell(cols: number, rows: number): Promise<ISshChannelLike> {
		if (this.state !== InternalState.Connected || !this.client) {
			return Promise.reject(new Error('会话未连接，无法打开终端通道'));
		}
		const client = this.client;
		return new Promise((resolve, reject) => {
			try {
				client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
					if (err) {
						reject(err);
					} else {
						resolve(stream);
					}
				});
			} catch (err) {
				reject(err as Error);
			}
		});
	}

	dispose(): void {
		this.clearRetryTimer();
		this.destroyClient();
		this._onDidChangeSnapshot.dispose();
	}

	// ==== 内部状态机 ====

	private destroyClient(): void {
		if (this.client) {
			try {
				this.client.destroy();
			} catch {
				// ignore
			}
			this.client = undefined;
		}
	}

	private clearRetryTimer(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	private fail(message: string, code: ISshConnectionSnapshot['errorCode']): void {
		this.clearRetryTimer();
		this.destroyClient();
		this.terminalDetail = { message, code };
		this.state = InternalState.Terminal;
		this.fireSnapshot();
	}

	private async doConnect(): Promise<void> {
		this.pendingRetry = undefined;
		this.state = InternalState.Connecting;
		this.fireSnapshot();

		const client = this.clientFactory();
		this.client = client;

		client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
			// 密码认证被服务端要求 keyboard-interactive 时，用已有凭据应答
			if (this.target.secret !== undefined) {
				finish([this.target.secret]);
			} else {
				finish([]);
			}
		});

		client.on('error', (err) => {
			this.callbacks.log(`[${this.label}] SSH 错误：${err.message}${err.level ? ` (${err.level})` : ''}`);
			if (this.state === InternalState.UserClosed || this.state === InternalState.Terminal) {
				return;
			}
			// 认证失败：不重连（避免密码错误被无限重试锁定账户）
			if (err.message.includes('All configured authentication methods failed')) {
				this.fail('认证失败：用户名/密码/密钥被拒绝', 'auth-failed');
				return;
			}
			if (err.message.includes('Keepalive timeout')) {
				// 连接已判定失活，等 close 事件走重连
				return;
			}
			// 其余错误：若尚未成功连接过，由 close 兜底判定；若已连接过，同样交由 close 统一调度重连
		});

		client.on('close', () => {
			if (this.state === InternalState.UserClosed || this.state === InternalState.Terminal) {
				return;
			}
			this.client = undefined;
			if (this.everConnected) {
				this.scheduleReconnect();
			} else {
				this.fail('无法连接到服务器（网络不可达 / 服务未启动 / 超时）', 'network');
			}
		});

		client.on('ready', () => {
			if (this.state !== InternalState.Connecting) {
				return;
			}
			this.everConnected = true;
			this.backoff.reset();
			this.state = InternalState.Connected;
			this.fireSnapshot();
		});

		try {
			await client.connect(await this.buildConnectConfig());
		} catch (err) {
			// connect() 同步抛出（配置错误等）
			if (this.state === InternalState.Connecting) {
				this.fail(`连接配置错误：${(err as Error).message}`, 'unknown');
			}
		}
	}

	private scheduleReconnect(): void {
		if (!this.options.reconnectEnabled || this.backoff.exhausted) {
			const reason = this.backoff.exhausted
				? `重连失败：已达最大重试次数（${this.options.reconnectPolicy.maxRetries}）`
				: '连接已断开（自动重连未启用）';
			this.fail(reason, 'network');
			return;
		}
		const attemptNo = this.backoff.attempts + 1;
		const delay = this.backoff.nextDelay();
		this.pendingRetry = { attemptNo, delayMs: delay };
		this.state = InternalState.Reconnecting;
		this.fireSnapshot();
		this.callbacks.log(`[${this.label}] 连接断开，${delay}ms 后进行第 ${attemptNo} 次重连`);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.pendingRetry = undefined;
			if (this.state === InternalState.Reconnecting) {
				this.doConnect();
			}
		}, delay);
	}

	private async buildConnectConfig(): Promise<object> {
		const target = this.target;
		const config: {
			host: string;
			port: number;
			username: string;
			password?: string;
			privateKey?: string;
			passphrase?: string;
			agent?: string;
			tryKeyboard?: boolean;
			keepaliveInterval: number;
			keepaliveCountMax: number;
			readyTimeout: number;
			hostVerifier: (key: Buffer) => Promise<boolean>;
		} = {
			host: target.host,
			port: target.port,
			username: target.username,
			keepaliveInterval: this.options.keepaliveIntervalMs,
			keepaliveCountMax: this.options.keepaliveCountMax,
			readyTimeout: this.options.readyTimeoutMs,
			hostVerifier: (key: Buffer) => this.verifyHostKey(key),
		};

		switch (target.authMethod) {
			case 'password': {
				if (target.secret === undefined) {
					throw new Error('未提供密码');
				}
				config.password = target.secret;
				config.tryKeyboard = true;
				break;
			}
			case 'key': {
				if (!target.keyPath) {
					throw new Error('未指定密钥文件');
				}
				config.privateKey = await this.callbacks.loadPrivateKey(target.keyPath);
				if (target.secret !== undefined) {
					config.passphrase = target.secret;
				}
				break;
			}
			case 'agent': {
				const agent = target.agentPipe || this.callbacks.resolveAgent();
				if (!agent) {
					throw new Error('未找到可用的 SSH Agent（OpenSSH 服务或 Pageant）');
				}
				config.agent = agent;
				break;
			}
		}
		return config;
	}

	private async verifyHostKey(key: Buffer): Promise<boolean> {
		const fingerprint = `SHA256:${this.sha256Base64(key)}`;
		const algorithm = this.parseKeyAlgorithm(key);
		const { host, port } = this.target;
		const result = await this.callbacks.onVerifyHostKey(host, port, fingerprint);
		if (result === 'known') {
			return true;
		}
		if (result === 'mismatch') {
			this.fail(`主机密钥指纹变更（疑似中间人攻击）！\n${host}:${port} 的指纹已与记录不一致，连接被硬阻断。\n新指纹：${fingerprint}`, 'hostkey-mismatch');
			return false;
		}
		// unknown：请求用户确认（120 秒无响应视为拒绝）
		const accepted = await Promise.race([
			this.callbacks.onConfirmHostKey(host, port, algorithm, fingerprint),
			timeout(120000).then(() => false),
		]);
		if (accepted) {
			await this.callbacks.onConfirmAccepted(host, port, algorithm, fingerprint);
			return true;
		}
		this.fail(`用户拒绝了主机指纹（${host}:${port}），连接取消`, 'hostkey-rejected');
		return false;
	}

	private sha256Base64(key: Buffer): string {
		return createHash('sha256').update(key).digest('base64');
	}

	/**
	 * 从 SSH 公钥 blob 解析算法名（如 ssh-ed25519 / ssh-rsa / ssh-rsa-cert-v01@openssh.com）。
	 * hostVerifier 在 KEX 期间触发，早于 handshake 事件，算法名只能取自 key blob 首字段（长度前缀字符串）。
	 */
	private parseKeyAlgorithm(key: Buffer): string {
		if (key.length > 8) {
			const nameLen = key.readUInt32BE(0);
			if (nameLen > 0 && nameLen <= 64 && 4 + nameLen <= key.length) {
				const name = key.subarray(4, 4 + nameLen).toString('utf8');
				if (/^[a-zA-Z0-9@.\-]+$/.test(name)) {
					return name;
				}
			}
		}
		return 'unknown';
	}
}
