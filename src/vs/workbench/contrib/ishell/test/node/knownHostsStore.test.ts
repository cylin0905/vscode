/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { KnownHostsStore } from '../../node/knownHostsStore.js';
import { IFileIO } from '../../node/connectionStore.js';

class MemoryIO implements IFileIO {
	constructor(public content: string | undefined = undefined) { }
	async readFile(): Promise<string | undefined> { return this.content; }
	async writeFile(content: string): Promise<void> { this.content = content; }
}

const FP_A = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const FP_B = 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

suite('ishell > KnownHostsStore', () => {

	let io: MemoryIO;
	let store: KnownHostsStore;

	setup(() => {
		io = new MemoryIO();
		store = new KnownHostsStore(io);
	});

	test('未记录的主机返回 unknown', async () => {
		await store.load();
		assert.strictEqual(store.verify('web.example.com', 22, FP_A), 'unknown');
	});

	test('record 后同指纹 known、不同指纹 mismatch', async () => {
		await store.load();
		await store.record('web.example.com', 22, 'ssh-ed25519', FP_A);
		assert.strictEqual(store.verify('web.example.com', 22, FP_A), 'known');
		assert.strictEqual(store.verify('web.example.com', 22, FP_B), 'mismatch', '指纹变更必须判定为 mismatch');
	});

	test('主机名大小写归一、端口区分', async () => {
		await store.load();
		await store.record('Web.Example.COM', 22, 'ssh-ed25519', FP_A);
		assert.strictEqual(store.verify('web.example.com', 22, FP_A), 'known', '主机名应大小写归一');
		assert.strictEqual(store.verify('web.example.com', 2222, FP_A), 'unknown', '端口不同视为不同主机');
	});

	test('remove 后回到 unknown（用于指纹变更后重新信任）', async () => {
		await store.load();
		await store.record('web.example.com', 22, 'ssh-ed25519', FP_A);
		await store.remove('web.example.com', 22);
		assert.strictEqual(store.verify('web.example.com', 22, FP_A), 'unknown');
	});

	test('record 后重连同一主机无需再次确认', async () => {
		await store.load();
		await store.record('web.example.com', 22, 'ssh-ed25519', FP_A);
		// 模拟重连：换一个 store 实例从同一磁盘内容加载
		const second = new KnownHostsStore(new MemoryIO(io.content));
		await second.load();
		assert.strictEqual(second.verify('web.example.com', 22, FP_A), 'known');
	});

	test('落盘为 JSON 且包含指纹', async () => {
		await store.load();
		await store.record('web.example.com', 22, 'ssh-ed25519', FP_A);
		const raw = io.content!;
		assert.ok(raw.includes('"version": 1'), '落盘应为 version 1 的 JSON');
		assert.ok(raw.includes(FP_A), '指纹应写入磁盘');
	});

	test('损坏 JSON 容错为空', async () => {
		io.content = '{broken';
		await store.load();
		assert.strictEqual(store.verify('web.example.com', 22, FP_A), 'unknown');
	});

	test('entries 结构非法时容错为空', async () => {
		io.content = JSON.stringify({ version: 1, entries: 'not-an-object' });
		await store.load();
		assert.strictEqual(store.verify('web.example.com', 22, FP_A), 'unknown');
	});
});
