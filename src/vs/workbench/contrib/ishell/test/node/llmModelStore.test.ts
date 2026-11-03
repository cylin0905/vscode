/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IFileIO } from '../../node/connectionStore.js';
import { LlmModelStore, MODELSCOPE_ENDPOINT, MIRROR_ENDPOINT, OFFICIAL_ENDPOINT } from '../../node/llmModelStore.js';
import { ILlmModelRecord } from '../../common/llm.js';

class MemoryIO implements IFileIO {
	constructor(public content: string | undefined = undefined) { }
	async readFile(): Promise<string | undefined> { return this.content; }
	async writeFile(content: string): Promise<void> { this.content = content; }
}

function makeRecord(overrides: Partial<Omit<ILlmModelRecord, 'id' | 'downloadedAt'>> = {}): Omit<ILlmModelRecord, 'id' | 'downloadedAt'> {
	return {
		catalogId: 'qwen2.5-1.5b-instruct-q4km',
		name: 'Qwen2.5 1.5B Instruct',
		filePath: 'C:\\models\\qwen2.5-1_5b-instruct-q4_k_m.gguf',
		sizeBytes: 1_073_741_824,
		...overrides,
	};
}

suite('ishell > LlmModelStore', () => {

	let io: MemoryIO;
	let store: LlmModelStore;

	setup(() => {
		io = new MemoryIO();
		store = new LlmModelStore(io);
	});

	test('空文件返回默认状态（mirror 源 + ghproxy 通道）', async () => {
		io.content = undefined;
		await store.load();
		const source = store.getSource();
		assert.strictEqual(source.kind, 'mirror');
		assert.strictEqual(source.endpoint, MIRROR_ENDPOINT);
		assert.strictEqual(source.engineChannel, 'ghproxy');
		assert.deepStrictEqual(store.getModels(), []);
	});

	test('持久化后重新加载状态一致', async () => {
		await store.load();
		await store.setEngineChannel('direct');
		await store.setEngineVersion('b6000');
		await store.addModel(makeRecord());

		const reloaded = new LlmModelStore(io);
		await reloaded.load();
		assert.strictEqual(reloaded.getSource().engineChannel, 'direct');
		assert.strictEqual(reloaded.getEngineVersion(), 'b6000');
		assert.strictEqual(reloaded.getModels().length, 1);
		assert.strictEqual(reloaded.getModels()[0].catalogId, 'qwen2.5-1.5b-instruct-q4km');
	});

	test('setSource 切换 official / mirror', async () => {
		await store.load();
		const official = await store.setSource('official');
		assert.strictEqual(official.endpoint, OFFICIAL_ENDPOINT);
		const mirror = await store.setSource('mirror');
		assert.strictEqual(mirror.endpoint, MIRROR_ENDPOINT);
	});

	test('setSource modelscope 固定端点且重载后保持', async () => {
		await store.load();
		const source = await store.setSource('modelscope');
		assert.strictEqual(source.kind, 'modelscope');
		assert.strictEqual(source.endpoint, MODELSCOPE_ENDPOINT);
		const reloaded = new LlmModelStore(io);
		await reloaded.load();
		assert.strictEqual(reloaded.getSource().kind, 'modelscope');
		assert.strictEqual(reloaded.getSource().endpoint, MODELSCOPE_ENDPOINT);
	});

	test('加载 sourceKind=modelscope 被接受', async () => {
		io.content = JSON.stringify({ version: 1, sourceKind: 'modelscope', customEndpoint: '', engineChannel: 'ghproxy', engineVersion: '', models: [] });
		await store.load();
		assert.strictEqual(store.getSource().kind, 'modelscope');
		assert.strictEqual(store.getSource().endpoint, MODELSCOPE_ENDPOINT);
	});

	test('setSource custom 校验协议前缀并去除尾斜杠', async () => {
		await store.load();
		await assert.rejects(() => store.setSource('custom', 'ftp://example.com'), /http/);
		await assert.rejects(() => store.setSource('custom', ''), /http/);

		const custom = await store.setSource('custom', 'https://my-hf.example.com/');
		assert.strictEqual(custom.kind, 'custom');
		assert.strictEqual(custom.endpoint, 'https://my-hf.example.com');
	});

	test('addModel / removeModel / getModelByCatalogId', async () => {
		await store.load();
		const added = await store.addModel(makeRecord());
		assert.ok(added.id.length > 0);
		assert.ok(added.downloadedAt > 0);

		assert.strictEqual(store.getModels().length, 1);
		assert.strictEqual(store.getModelByCatalogId('qwen2.5-1.5b-instruct-q4km')?.id, added.id);
		assert.strictEqual(store.getModelByCatalogId('不存在'), undefined);

		const removed = await store.removeModel(added.id);
		assert.strictEqual(removed?.id, added.id);
		assert.strictEqual(store.getModels().length, 0);
		assert.strictEqual(await store.removeModel('不存在'), undefined);
	});

	test('加载损坏 JSON 抛出可诊断错误', async () => {
		io.content = '{broken json';
		await assert.rejects(() => store.load(), /解析失败/);
	});

	test('加载时过滤非法模型条目并回退非法枚举', async () => {
		io.content = JSON.stringify({
			version: 1,
			sourceKind: 'bad-kind',
			engineChannel: 'wrong',
			engineVersion: 123,
			models: [{ ...makeRecord(), id: 'm1', downloadedAt: 1 }, { id: 'x' }, 'garbage', null],
		});
		await store.load();
		// 非法枚举回退默认值
		assert.strictEqual(store.getSource().kind, 'mirror');
		assert.strictEqual(store.getSource().engineChannel, 'ghproxy');
		assert.strictEqual(store.getEngineVersion(), '');
		// 仅保留含 id + filePath 的条目
		assert.strictEqual(store.getModels().length, 1);
	});
});
