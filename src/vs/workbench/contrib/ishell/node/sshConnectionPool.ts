/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IHostKeyPrompt, IHostProfile, ISshConnectionSnapshot, IQuickConnectTarget } from '../common/ishell.js';
import { HostKeyVerificationResult, KnownHostsStore } from './knownHostsStore.js';
import { DEFAULT_SSH_SESSION_OPTIONS, ISshSessionCallbacks, ISshSessionOptions, ISshTarget, SshClientFactory, SshSession } from './sshSession.js';

/**
 * SSH 连接池（运行于主进程，渲染层崩溃不影响连接）。
 * 单连接多通道复用的通道管理将在 M3（终端）/M4（SFTP）在此扩展。
 */
export class SshConnectionPool extends Disposable {

	private readonly sessions = new Map<string, SshSession>();

	private readonly _onDidChange = new Emitter<ISshConnectionSnapshot | undefined>();
	readonly onDidChange: Event<ISshConnectionSnapshot | undefined> = this._onDidChange.event;

	private readonly _onDidRequestHostKeyConfirm = new Emitter<IHostKeyPrompt>();
	readonly onDidRequestHostKeyConfirm: Event<IHostKeyPrompt> = this._onDidRequestHostKeyConfirm.event;

	/** 每个会话指纹确认的 pending 决议（渲染层响应后 resolve） */
	private readonly hostKeyConfirmations = new Map<string, (accepted: boolean) => void>();

	constructor(
		private readonly options: Partial<ISshSessionOptions>,
		private readonly callbacks: Omit<ISshSessionCallbacks, 'onVerifyHostKey' | 'onConfirmHostKey' | 'onConfirmAccepted'>,
		private readonly knownHosts: KnownHostsStore,
		private readonly clientFactory: SshClientFactory,
	) {
		super();
	}

	// ==== 连接操作 ====

	async connectProfile(profile: IHostProfile, secret: string | undefined): Promise<void> {
		const existing = this.sessions.get(profile.id);
		if (existing && !existing.closed) {
			if (secret === undefined) {
				return; // 已连接/连接中
			}
			existing.disconnect(); // 带新凭据重连：先断开旧会话
		} else if (existing) {
			existing.dispose(); // 清理已结束会话的资源
		}
		const session = this.createSession(profile.id, profile.name, {
			host: profile.host,
			port: profile.port,
			username: profile.username,
			authMethod: profile.authMethod,
			keyPath: profile.keyPath,
			agentPipe: profile.agentPipe,
			secret,
		});
		await session.connect();
	}

	async quickConnect(target: IQuickConnectTarget): Promise<string> {
		const id = `quick:${generateUuid()}`;
		const label = `${target.username}@${target.host}`;
		const session = this.createSession(id, label, {
			host: target.host,
			port: target.port,
			username: target.username,
			authMethod: target.authMethod,
			keyPath: target.keyPath,
			agentPipe: target.agentPipe,
			secret: target.secret,
		});
		this._onDidChange.fire(undefined); // 会话列表新增
		await session.connect();
		return id;
	}

	disconnect(sessionId: string): void {
		this.hostKeyConfirmations.delete(sessionId);
		const session = this.sessions.get(sessionId);
		if (session) {
			session.disconnect();
			if (sessionId.startsWith('quick:')) {
				// 快速连接会话关闭后即移除
				this.sessions.delete(sessionId);
				this._onDidChange.fire(undefined);
			}
		}
	}

	getSnapshots(): ISshConnectionSnapshot[] {
		return [...this.sessions.values()].map(s => s.snapshot());
	}

	getSession(sessionId: string): SshSession | undefined {
		return this.sessions.get(sessionId);
	}

	/** 渲染层用户指纹确认响应 */
	resolveHostKeyConfirmation(sessionId: string, accepted: boolean): void {
		const resolver = this.hostKeyConfirmations.get(sessionId);
		if (resolver) {
			this.hostKeyConfirmations.delete(sessionId);
			resolver(accepted);
		}
	}

	override dispose(): void {
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.sessions.clear();
		this._onDidChange.dispose();
		this._onDidRequestHostKeyConfirm.dispose();
		super.dispose();
	}

	private createSession(id: string, label: string, target: ISshTarget): SshSession {
		const session = new SshSession(id, label, target, {
			...DEFAULT_SSH_SESSION_OPTIONS,
			...this.options,
		}, {
			...this.callbacks,
			onVerifyHostKey: async (host, port, fingerprint) => this.verifyHostKey(host, port, fingerprint),
			onConfirmHostKey: (host, port, algorithm, fingerprint) => new Promise<boolean>(resolve => {
				const prompt: IHostKeyPrompt = { sessionId: id, host, port, keyAlgorithm: algorithm, fingerprint };
				this.hostKeyConfirmations.set(id, resolve);
				this._onDidRequestHostKeyConfirm.fire(prompt);
			}),
			onConfirmAccepted: async (host, port, algorithm, fingerprint) => this.knownHosts.record(host, port, algorithm, fingerprint),
		}, this.clientFactory);
		this.sessions.set(id, session);
		this._register(session.onDidChangeSnapshot(s => this._onDidChange.fire(s)));
		return session;
	}

	private async verifyHostKey(host: string, port: number, fingerprint: string): Promise<HostKeyVerificationResult> {
		return this.knownHosts.verify(host, port, fingerprint);
	}
}
