/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IHostProfile, ITerminalCloseEvent, ITerminalOutputEvent } from '../../common/ishell.js';
import { KnownHostsStore } from '../../node/knownHostsStore.js';
import { ISshChannelLike, ISshClientLike } from '../../node/sshSession.js';
import { SshConnectionPool } from '../../node/sshConnectionPool.js';
import { completeUtf8Length, SshTerminalManager } from '../../node/sshTerminalManager.js';

// ==== Fake ssh2 基建 ====

type Listener = (...args: any[]) => void;

class FakeShellChannel implements ISshChannelLike {
	public readonly writes: string[] = [];
	public readonly windows: { rows: number; cols: number }[] = [];
	public closed = false;
	public destroyed = false;
	private listeners = new Map<string, Listener[]>();

	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}
	setWindow(rows: number, cols: number): void {
		this.windows.push({ rows, cols });
	}
	close(): void { this.closed = true; }
	destroy(): void { this.destroyed = true; this.emit('close'); }
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
	public shellWindows: { term: string; cols: number; rows: number }[] = [];
	public channels: FakeShellChannel[] = [];
	public destroyed = false;
	private listeners = new Map<string, Listener[]>();

	connect(): ISshClientLike { return this; }
	end(): ISshClientLike { return this; }
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

class MemoryFileIO {
	public content: string | undefined;
	async readFile(): Promise<string | undefined> { return this.content; }
	async writeFile(content: string): Promise<void> { this.content = content; }
}

// ==== 测试基建 ====

interface IHarness {
	pool: SshConnectionPool;
	manager: SshTerminalManager;
	clients: FakeClient[];
	outputs: ITerminalOutputEvent[];
	closes: ITerminalCloseEvent[];
	profile: IHostProfile;
	connect(): Promise<void>;
}

const activeHarnesses: IHarness[] = [];

function createHarness(): IHarness {
	const clients: FakeClient[] = [];
	const pool = new SshConnectionPool(
		{ reconnectPolicy: { initialDelayMs: 10, maxDelayMs: 40, factor: 2, maxRetries: 3 } },
		{
			loadPrivateKey: async () => '',
			resolveAgent: () => undefined,
			log: () => { },
		},
		new KnownHostsStore(new MemoryFileIO()),
		() => {
			const client = new FakeClient();
			clients.push(client);
			return client;
		}
	);

	const manager = new SshTerminalManager(pool);
	const outputs: ITerminalOutputEvent[] = [];
	const closes: ITerminalCloseEvent[] = [];
	manager.onDidOutput(e => outputs.push(e));
	manager.onDidClose(e => closes.push(e));

	const profile: IHostProfile = {
		id: 'p1', name: 'web-1', host: 'web.example.com', port: 22,
		username: 'root', authMethod: 'password',
	};

	const harness: IHarness = {
		pool, manager, clients, outputs, closes, profile,
		connect: async () => {
			await pool.connectProfile(profile, 'hunter2');
			clients[0].emit('ready');
		},
	};
	activeHarnesses.push(harness);
	return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		await new Promise(resolve => setTimeout(resolve, 5));
		if (predicate()) { return; }
		if (Date.now() > deadline) { throw new Error(`waitFor 超时（${timeoutMs}ms）`); }
	}
}

suite('ishell > SshTerminalManager', () => {

	teardown(() => {
		for (const h of activeHarnesses) {
			h.manager.dispose();
			h.pool.dispose();
		}
		activeHarnesses.length = 0;
	});

	test('open：已连接会话返回递增 terminalId，shell 收到 xterm-256color 与窗口尺寸', async () => {
		const h = createHarness();
		await h.connect();
		const first = await h.manager.open('p1', 100, 30);
		const second = await h.manager.open('p1', 120, 40);
		assert.strictEqual(first, 'p1#1');
		assert.strictEqual(second, 'p1#2');
		assert.strictEqual(h.clients[0].shellWindows.length, 2);
		assert.deepStrictEqual(h.clients[0].shellWindows[0], { term: 'xterm-256color', cols: 100, rows: 30 });
		assert.deepStrictEqual(h.clients[0].shellWindows[1], { term: 'xterm-256color', cols: 120, rows: 40 });
	});

	test('open：会话不存在 / 未连接 → 抛错', async () => {
		const h = createHarness();
		await assert.rejects(() => h.manager.open('nope', 80, 24), /会话不存在/);
		// 已存档案但尚未连接完成（connecting 阶段）
		const connecting = h.pool.connectProfile(h.profile, 'hunter2');
		await assert.rejects(() => h.manager.open('p1', 80, 24), /未连接/);
		await connecting;
	});

	test('write：数据写入 shell 通道', async () => {
		const h = createHarness();
		await h.connect();
		const t1 = await h.manager.open('p1', 80, 24);
		h.manager.write(t1, 'ls -la\r');
		assert.deepStrictEqual(h.clients[0].channels[0].writes, ['ls -la\r']);
	});

	test('resize：setWindow 收到 cols/rows', async () => {
		const h = createHarness();
		await h.connect();
		const t1 = await h.manager.open('p1', 80, 24);
		h.manager.resize(t1, 132, 43);
		assert.deepStrictEqual(h.clients[0].channels[0].windows, [{ rows: 43, cols: 132 }]);
	});

	test('输出批量合并：高频 data 在 flush 窗口内合并为一次事件', async () => {
		const h = createHarness();
		await h.connect();
		const t1 = await h.manager.open('p1', 80, 24);
		const channel = h.clients[0].channels[0];
		channel.emit('data', Buffer.from('hello '));
		channel.emit('data', Buffer.from('wor'));
		channel.emit('data', Buffer.from('ld\n'));
		await waitFor(() => h.outputs.length > 0);
		assert.strictEqual(h.outputs.length, 1, '应合并为一次事件');
		assert.strictEqual(h.outputs[0].terminalId, t1);
		assert.strictEqual(h.outputs[0].data, 'hello world\n');
	});

	test('UTF-8 安全切分：多字节中文跨 Buffer 边界不产生替换字符', async () => {
		const h = createHarness();
		await h.connect();
		await h.manager.open('p1', 80, 24);
		const channel = h.clients[0].channels[0];
		const text = '连接成功';
		const bytes = Buffer.from(text, 'utf8'); // 12 字节
		channel.emit('data', bytes.subarray(0, 7)); // 截断在多字节序列中间
		await waitFor(() => h.outputs.length > 0);
		assert.strictEqual(h.outputs.length, 1);
		assert.ok(!h.outputs[0].data.includes('\uFFFD'), '不得出现替换字符');
		assert.ok(text.startsWith(h.outputs[0].data), `部分输出应是原文前缀：${h.outputs[0].data}`);
		// 补齐剩余字节 → 合并后完整
		channel.emit('data', bytes.subarray(7));
		await waitFor(() => h.outputs.length > 1);
		const merged = h.outputs.map(o => o.data).join('');
		assert.strictEqual(merged, text);
	});

	test('通道 close → onDidClose(channel-closed)', async () => {
		const h = createHarness();
		await h.connect();
		const t1 = await h.manager.open('p1', 80, 24);
		h.clients[0].channels[0].emit('close');
		assert.strictEqual(h.closes.length, 1);
		assert.deepStrictEqual(h.closes[0], { terminalId: t1, reason: 'channel-closed' });
	});

	test('会话断开 → 该会话全部通道 session-closed 且通道销毁', async () => {
		const h = createHarness();
		await h.connect();
		const first = await h.manager.open('p1', 80, 24);
		await h.manager.open('p1', 80, 24);
		h.clients[0].emit('close'); // 意外断线 → reconnecting 快照
		await waitFor(() => h.closes.length === 2);
		const reasons = h.closes.map(c => c.reason);
		assert.deepStrictEqual(reasons.sort(), ['session-closed', 'session-closed']);
		assert.ok(h.clients[0].channels[0].destroyed);
		assert.ok(h.clients[0].channels[1].destroyed);
		// 关闭后的写入不抛错
		h.manager.write(first, 'x');
	});

	test('close：用户关闭通道，幂等且不产生事件', async () => {
		const h = createHarness();
		await h.connect();
		const t1 = await h.manager.open('p1', 80, 24);
		h.manager.close(t1);
		assert.ok(h.clients[0].channels[0].closed);
		h.manager.close(t1); // 幂等
		assert.strictEqual(h.closes.length, 0, '用户主动关闭不回发事件');
	});

	test('close 冲刷残留输出：关闭前 pending 数据仍送达', async () => {
		const h = createHarness();
		await h.connect();
		const t1 = await h.manager.open('p1', 80, 24);
		h.clients[0].channels[0].emit('data', Buffer.from('final output'));
		h.manager.close(t1);
		await waitFor(() => h.outputs.length > 0);
		assert.strictEqual(h.outputs[0].data, 'final output');
	});
});

suite('ishell > completeUtf8Length', () => {

	test('纯 ASCII 全部完整', () => {
		assert.strictEqual(completeUtf8Length(Buffer.from('hello')), 5);
	});

	test('完整多字节序列全部保留', () => {
		const buf = Buffer.from('中文测试', 'utf8');
		assert.strictEqual(completeUtf8Length(buf), buf.length);
	});

	test('尾部不完整 3 字节序列被截掉', () => {
		const full = Buffer.from('中a文', 'utf8'); // 3+1+3 = 7 字节
		const truncated = full.subarray(0, 5); // 截在"文"的第 2 字节
		assert.strictEqual(completeUtf8Length(truncated), 4); // 保留"中a"
	});

	test('全续字节异常输入保守全发', () => {
		assert.strictEqual(completeUtf8Length(Buffer.from([0x80, 0x80])), 2);
	});
});
