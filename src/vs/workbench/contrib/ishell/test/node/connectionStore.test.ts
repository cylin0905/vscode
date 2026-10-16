/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ConnectionStore, IFileIO, ISecretCodec } from '../../node/connectionStore.js';
import { IHostProfile } from '../../common/ishell.js';

class MemoryIO implements IFileIO {
	constructor(public content: string | undefined = undefined) { }
	async readFile(): Promise<string | undefined> { return this.content; }
	async writeFile(content: string): Promise<void> { this.content = content; }
}

class FakeCodec implements ISecretCodec {
	public encrypted: string[] = [];
	async encrypt(value: string): Promise<string> {
		const encoded = `ENC(${Buffer.from(value, 'utf8').toString('base64')})`;
		this.encrypted.push(encoded);
		return encoded;
	}
	async decrypt(value: string): Promise<string> {
		assert.ok(value.startsWith('ENC(') && value.endsWith(')'), '非法密文格式');
		return Buffer.from(value.slice(4, -1), 'base64').toString('utf8');
	}
}

function makeProfile(overrides: Partial<IHostProfile> = {}): IHostProfile {
	return {
		id: 'p1',
		name: 'web-1',
		host: '192.168.1.10',
		port: 22,
		username: 'root',
		authMethod: 'password',
		...overrides,
	};
}

suite('ishell > ConnectionStore', () => {

	let io: MemoryIO;
	let codec: FakeCodec;
	let store: ConnectionStore;

	setup(() => {
		io = new MemoryIO();
		codec = new FakeCodec();
		store = new ConnectionStore(io, codec);
	});

	test('空文件返回空档案', async () => {
		io.content = undefined;
		const data = await store.load();
		assert.deepStrictEqual(data.groups, []);
		assert.deepStrictEqual(data.hosts, []);
	});

	test('保存新档案并持久化，磁盘上密码为密文', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), 'super-secret-密码');
		const raw = io.content!;
		assert.ok(raw.includes('ENC('), '落盘内容应包含密文');
		assert.ok(!raw.includes('super-secret-密码'), '明文密码不得落盘');

		const data = store.get();
		assert.strictEqual(data.hosts.length, 1);
		assert.ok(data.hosts[0].encSecret!.startsWith('ENC('));
	});

	test('resolveSecret 解密回明文', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), 'hunter2');
		const data = store.get();
		assert.strictEqual(await store.resolveSecret(data.hosts[0]), 'hunter2');
	});

	test('更新档案不带新密码时保留旧密文', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), 'old-pass');
		await store.saveProfile(makeProfile({ name: 'renamed', encSecret: store.get().hosts[0].encSecret }), undefined);
		const host = store.get().hosts[0];
		assert.strictEqual(host.name, 'renamed');
		assert.ok(host.encSecret!.startsWith('ENC('), '旧密文应保留');
		assert.strictEqual(await store.resolveSecret(host), 'old-pass');
	});

	test('更新档案带新密码时替换密文', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), 'old-pass');
		await store.saveProfile(makeProfile(), 'new-pass');
		const host = store.get().hosts[0];
		assert.strictEqual(await store.resolveSecret(host), 'new-pass');
	});

	test('损坏密文解密失败返回 undefined', async () => {
		await store.load();
		await store.saveProfile(makeProfile({ encSecret: 'ENC(broken' }), undefined);
		// encSecret 保持原样（非加密路径），decrypt 抛错 → undefined
		assert.strictEqual(await store.resolveSecret(store.get().hosts[0]), undefined);
	});

	test('删除档案', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), 'x');
		await store.deleteProfile('p1');
		assert.strictEqual(store.get().hosts.length, 0);
	});

	test('分组 CRUD 与主机移动', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), undefined);
		const group = await store.createGroup('生产环境');
		await store.moveProfileToGroup('p1', group.id);
		assert.strictEqual(store.get().hosts[0].groupId, group.id);

		await store.renameGroup(group.id, 'test');
		assert.strictEqual(store.get().groups[0].name, 'test');

		await store.deleteGroup(group.id, false);
		assert.strictEqual(store.get().groups.length, 0);
		assert.strictEqual(store.get().hosts[0].groupId, undefined, '主机应移入未分组');
	});

	test('删除分组同时删除主机', async () => {
		await store.load();
		await store.saveProfile(makeProfile(), undefined);
		const group = await store.createGroup('prod');
		await store.moveProfileToGroup('p1', group.id);
		await store.deleteGroup(group.id, true);
		assert.strictEqual(store.get().hosts.length, 0, '组内主机应一并删除');
	});

	test('加载时过滤非法条目', async () => {
		io.content = JSON.stringify({
			version: 1,
			groups: [{ id: 'g', name: 'ok' }, { id: 42, name: 'bad' }, null],
			hosts: [makeProfile(), { id: 'x' }, 'garbage']
		});
		const data = await store.load();
		assert.strictEqual(data.groups.length, 1);
		assert.strictEqual(data.hosts.length, 1);
	});

	test('加载损坏 JSON 抛出可诊断错误', async () => {
		io.content = '{broken json';
		await assert.rejects(() => store.load(), /解析失败/);
	});
});
