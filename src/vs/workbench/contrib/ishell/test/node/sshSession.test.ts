/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ISshChannelLike, ISshClientLike, ISshSessionCallbacks, ISshSessionOptions, ISshTarget, SshSession } from '../../node/sshSession.js';
import { IReconnectPolicy } from '../../node/backoff.js';
import { HostKeyVerificationResult } from '../../node/knownHostsStore.js';

// ==== Fake ssh2 客户端 ====

type Listener = (...args: any[]) => void;

class FakeShellChannel implements ISshChannelLike {
	public readonly writes: string[] = [];
	public readonly windows: { rows: number; cols: number }[] = [];
	public closed = false;
	public destroyed = false;
	private listeners = new Map<string, Listener[]>();

	write(data: string): boolean { this.writes.push(data); return true; }
	setWindow(rows: number, cols: number): void { this.windows.push({ rows, cols }); }
	close(): void { this.closed = true; }
	destroy(): void { this.destroyed = true; }
	on(event: string, listener: Listener): ISshChannelLike {
		const arr = this.listeners.get(event) ?? [];
		arr.push(listener);
		this.listeners.set(event, arr);
		return this;
	}
	emit(event: string, ...args: any[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			listener(...args);
		}
	}
}

class FakeClient implements ISshClientLike {
	public connectConfig: any;
	public destroyed = false;
	public ended = false;
	public shellWindows: { term: string; cols: number; rows: number }[] = [];
	public channels: FakeShellChannel[] = [];
	private listeners = new Map<string, Listener[]>();

	connect(config: object): ISshClientLike {
		this.connectConfig = config;
		return this;
	}
	end(): ISshClientLike { this.ended = true; return this; }
	destroy(): void { this.destroyed = true; }
	shell(window: { term: string; cols: number; rows: number }, callback: (err: Error | undefined, stream: ISshChannelLike) => void): ISshClientLike {
		this.shellWindows.push(window);
		const channel = new FakeShellChannel();
		this.channels.push(channel);
		callback(undefined, channel);
		return this;
	}
	on(event: string, listener: Listener): ISshClientLike {
		const arr = this.listeners.get(event) ?? [];
		arr.push(listener);
		this.listeners.set(event, arr);
		return this;
	}
	emit(event: string, ...args: any[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			listener(...args);
		}
	}
}

// ==== 测试基建 ====

const FAST_POLICY: IReconnectPolicy = { initialDelayMs: 10, maxDelayMs: 40, factor: 2, maxRetries: 3 };

const DEFAULT_OPTIONS: ISshSessionOptions = {
	keepaliveIntervalMs: 60_000,
	keepaliveCountMax: 3,
	readyTimeoutMs: 5_000,
	reconnectEnabled: true,
	reconnectPolicy: FAST_POLICY,
};

interface ISpy {
	verifyCalls: string[];
	confirmCalls: { host: string; port: number; algorithm: string; fingerprint: string }[];
	acceptedCalls: { host: string; port: number; algorithm: string; fingerprint: string }[];
}

interface IHarness {
	session: SshSession;
	clients: FakeClient[];
	spy: ISpy;
}

const activeSessions: SshSession[] = [];

function createHarness(overrides: {
	target?: Partial<ISshTarget>;
	callbacks?: Partial<ISshSessionCallbacks>;
	options?: Partial<ISshSessionOptions>;
	policy?: Partial<IReconnectPolicy>;
} = {}): IHarness {
	const clients: FakeClient[] = [];
	const factory = () => {
		const client = new FakeClient();
		clients.push(client);
		return client;
	};
	const spy: ISpy = { verifyCalls: [], confirmCalls: [], acceptedCalls: [] };
	const callbacks: ISshSessionCallbacks = {
		onVerifyHostKey: async (_host, _port, fingerprint): Promise<HostKeyVerificationResult> => {
			spy.verifyCalls.push(fingerprint);
			return 'unknown';
		},
		onConfirmHostKey: async (host, port, algorithm, fingerprint) => {
			spy.confirmCalls.push({ host, port, algorithm, fingerprint });
			return true;
		},
		onConfirmAccepted: async (host, port, algorithm, fingerprint) => {
			spy.acceptedCalls.push({ host, port, algorithm, fingerprint });
		},
		loadPrivateKey: async () => 'PRIVATE-KEY-CONTENT',
		resolveAgent: () => 'pipe-test-agent',
		log: () => { },
		...overrides.callbacks,
	};
	const options: ISshSessionOptions = {
		...DEFAULT_OPTIONS,
		...overrides.options,
		reconnectPolicy: { ...FAST_POLICY, ...overrides.policy },
	};
	const target: ISshTarget = {
		host: 'web.example.com',
		port: 22,
		username: 'root',
		authMethod: 'password',
		secret: 'hunter2',
		...overrides.target,
	};
	const session = new SshSession('s1', 'web-1', target, options, callbacks, factory);
	activeSessions.push(session);
	return { session, clients, spy };
}

/** 轮询等待条件成立（先休眠再检查，避免同步竞态） */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		await new Promise(resolve => setTimeout(resolve, 5));
		if (predicate()) { return; }
		if (Date.now() > deadline) { throw new Error(`waitFor 超时（${timeoutMs}ms）`); }
	}
}

suite('ishell > SshSession', () => {

	teardown(() => {
		for (const session of activeSessions) { session.dispose(); }
		activeSessions.length = 0;
	});

	test('首次连接成功 → connected，密码配置含 tryKeyboard', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('ready');
		assert.strictEqual(h.session.snapshot().status, 'connected');
		assert.strictEqual(h.clients[0].connectConfig.password, 'hunter2');
		assert.strictEqual(h.clients[0].connectConfig.tryKeyboard, true);
		assert.strictEqual(h.session.connected, true);
	});

	test('connect 幂等：连接中重复调用不新建客户端', async () => {
		const h = createHarness();
		await h.session.connect();
		await h.session.connect();
		assert.strictEqual(h.clients.length, 1);
	});

	test('已知指纹直接放行，不弹确认', async () => {
		const h = createHarness({ callbacks: { onVerifyHostKey: async () => 'known' } });
		await h.session.connect();
		const accepted = await h.clients[0].connectConfig.hostVerifier(Buffer.from('server-key'));
		assert.strictEqual(accepted, true);
		assert.strictEqual(h.spy.confirmCalls.length, 0, 'known 指纹不得打扰用户');
		h.clients[0].emit('ready');
		assert.strictEqual(h.session.snapshot().status, 'connected');
	});

	test('指纹变更（mismatch）→ 硬阻断 failed/hostkey-mismatch', async () => {
		const h = createHarness({ callbacks: { onVerifyHostKey: async () => 'mismatch' } });
		await h.session.connect();
		const accepted = await h.clients[0].connectConfig.hostVerifier(Buffer.from('evil-key'));
		assert.strictEqual(accepted, false);
		const snap = h.session.snapshot();
		assert.strictEqual(snap.status, 'failed');
		assert.strictEqual(snap.errorCode, 'hostkey-mismatch');
		assert.ok(snap.detail!.includes('指纹'), '失败详情应说明指纹变更');
	});

	test('未知指纹用户接受 → 记录 known_hosts 并继续连接', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('handshake', { algorithms: { serverHostKey: 'ssh-ed25519' } });
		const accepted = await h.clients[0].connectConfig.hostVerifier(Buffer.from('new-key'));
		assert.strictEqual(accepted, true);
		assert.strictEqual(h.spy.acceptedCalls.length, 1, '接受后应记录指纹');
		assert.strictEqual(h.spy.acceptedCalls[0].algorithm, 'ssh-ed25519');
		assert.ok(h.spy.acceptedCalls[0].fingerprint.startsWith('SHA256:'));
		h.clients[0].emit('ready');
		assert.strictEqual(h.session.snapshot().status, 'connected');
	});

	test('未知指纹用户拒绝 → failed/hostkey-rejected', async () => {
		const h = createHarness({ callbacks: { onConfirmHostKey: async () => false } });
		await h.session.connect();
		const accepted = await h.clients[0].connectConfig.hostVerifier(Buffer.from('new-key'));
		assert.strictEqual(accepted, false);
		const snap = h.session.snapshot();
		assert.strictEqual(snap.status, 'failed');
		assert.strictEqual(snap.errorCode, 'hostkey-rejected');
		assert.strictEqual(h.spy.acceptedCalls.length, 0, '拒绝后不得记录指纹');
	});

	test('认证失败 → failed/auth-failed 且不重连', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('error', new Error('All configured authentication methods failed'));
		assert.strictEqual(h.session.snapshot().errorCode, 'auth-failed');
		h.clients[0].emit('close');
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(h.clients.length, 1, '认证失败不得触发重连（防止账户锁定）');
		assert.strictEqual(h.session.snapshot().status, 'failed');
	});

	test('首连网络失败（未连接过即 close）→ failed/network 不重连', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('close');
		const snap = h.session.snapshot();
		assert.strictEqual(snap.status, 'failed');
		assert.strictEqual(snap.errorCode, 'network');
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(h.clients.length, 1, '首连失败不自动重连');
	});

	test('意外断开 → reconnecting → 自动重连成功', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('ready');
		h.clients[0].emit('close');
		const snap = h.session.snapshot();
		assert.strictEqual(snap.status, 'reconnecting');
		assert.ok(snap.detail!.includes('第 1 次重连'), `快照应包含重连计划：${snap.detail}`);
		await waitFor(() => h.clients.length === 2);
		h.clients[1].emit('ready');
		await waitFor(() => h.session.snapshot().status === 'connected');
		assert.strictEqual(h.session.connected, true);
	});

	test('重试耗尽 → failed/network 且详情说明已达最大次数', async () => {
		const h = createHarness({ policy: { maxRetries: 2 } });
		await h.session.connect();
		h.clients[0].emit('ready');
		h.clients[0].emit('close');
		await waitFor(() => h.clients.length === 2);
		h.clients[1].emit('close');
		await waitFor(() => h.clients.length === 3);
		h.clients[2].emit('close');
		await waitFor(() => h.session.snapshot().status === 'failed');
		const snap = h.session.snapshot();
		assert.strictEqual(snap.errorCode, 'network');
		assert.strictEqual(snap.detail, '重连失败：已达最大重试次数（2）');
	});

	test('禁用自动重连时断开直接 failed', async () => {
		const h = createHarness({ options: { reconnectEnabled: false } });
		await h.session.connect();
		h.clients[0].emit('ready');
		h.clients[0].emit('close');
		const snap = h.session.snapshot();
		assert.strictEqual(snap.status, 'failed');
		assert.strictEqual(snap.errorCode, 'network');
	});

	test('主动断开 → disconnected，销毁客户端且不重连', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('ready');
		h.session.disconnect();
		assert.strictEqual(h.session.snapshot().status, 'disconnected');
		assert.ok(h.clients[0].destroyed, '客户端应被销毁');
		h.clients[0].emit('close');
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(h.clients.length, 1, '主动断开不得触发重连');
		assert.strictEqual(h.session.closed, true);
	});

	test('密钥认证：privateKey + passphrase 配置', async () => {
		const h = createHarness({ target: { authMethod: 'key', keyPath: 'C:/keys/id_ed25519', secret: 'key-passphrase' } });
		await h.session.connect();
		assert.strictEqual(h.clients[0].connectConfig.privateKey, 'PRIVATE-KEY-CONTENT');
		assert.strictEqual(h.clients[0].connectConfig.passphrase, 'key-passphrase');
	});

	test('Agent 认证：显式管道优先，否则用回调解析', async () => {
		const explicit = createHarness({ target: { authMethod: 'agent', agentPipe: '\\\\.\\pipe\\custom-agent', secret: undefined } });
		await explicit.session.connect();
		assert.strictEqual(explicit.clients[0].connectConfig.agent, '\\\\.\\pipe\\custom-agent');

		const resolved = createHarness({ target: { authMethod: 'agent', secret: undefined } });
		await resolved.session.connect();
		assert.strictEqual(resolved.clients[0].connectConfig.agent, 'pipe-test-agent');
	});

	test('密码认证但未提供密码 → 配置错误 failed', async () => {
		const h = createHarness({ target: { secret: undefined } });
		await h.session.connect();
		const snap = h.session.snapshot();
		assert.strictEqual(snap.status, 'failed');
		assert.strictEqual(snap.errorCode, 'unknown');
		assert.ok(snap.detail!.includes('未提供密码'));
	});

	test('keyboard-interactive 用已有密码应答', async () => {
		const h = createHarness();
		await h.session.connect();
		let answers: string[] | undefined;
		h.clients[0].emit('keyboard-interactive', 'Password', '', 'en', [{ prompt: 'Password: ', echo: false }], (a: string[]) => { answers = a; });
		assert.deepStrictEqual(answers, ['hunter2']);
	});

	test('openShell：未连接时抛错', async () => {
		const h = createHarness();
		await assert.rejects(() => h.session.openShell(80, 24), /未连接/);
		await h.session.connect();
		h.clients[0].emit('close'); // 首连失败 → failed 终态
		await assert.rejects(() => h.session.openShell(80, 24), /未连接/);
	});

	test('openShell：已连接时返回通道并携带 PTY 参数', async () => {
		const h = createHarness();
		await h.session.connect();
		h.clients[0].emit('ready');
		const channel = await h.session.openShell(120, 40);
		assert.ok(channel instanceof FakeShellChannel);
		assert.strictEqual(h.clients[0].shellWindows.length, 1);
		assert.deepStrictEqual(h.clients[0].shellWindows[0], { term: 'xterm-256color', cols: 120, rows: 40 });
		// 多通道复用：可再开第二个
		const channel2 = await h.session.openShell(80, 24);
		assert.strictEqual(h.clients[0].channels.length, 2);
		assert.notStrictEqual(channel, channel2);
	});
});
