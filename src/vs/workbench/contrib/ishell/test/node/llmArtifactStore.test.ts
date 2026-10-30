/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LlmArtifactStore, DEFAULT_LLM_ARTIFACT_NAMING_RULE } from '../../node/llmArtifactStore.js';

suite('iShell/llmArtifactStore', () => {

	let root: string;
	let store: LlmArtifactStore;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ishell-artifacts-'));
		store = new LlmArtifactStore(root);
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	suite('sanitizeRelativePath', () => {

		test('禁止目录穿越段', () => {
			const cleaned = LlmArtifactStore.sanitizeRelativePath('../../etc/passwd');
			assert.ok(!cleaned.includes('..'));
			assert.ok(!cleaned.startsWith('/'));
		});

		test('段内非法字符替换为短横线', () => {
			assert.strictEqual(LlmArtifactStore.sanitizeRelativePath('a b/c:d'), 'a-b/c-d');
		});

		test('全空输入回退 artifact', () => {
			assert.strictEqual(LlmArtifactStore.sanitizeRelativePath('///'), 'artifact');
			assert.strictEqual(LlmArtifactStore.sanitizeRelativePath('...'), 'artifact');
		});
	});

	suite('expandNamingRule', () => {

		test('展开全部占位符', () => {
			const expanded = LlmArtifactStore.expandNamingRule('{date}/{sessionId}-{requestId}-{slug}{ext}', {
				date: '20260101',
				time: '120000',
				sessionId: 's1',
				requestId: 'r1',
				slug: 'my-title',
				ext: '.md',
			});
			assert.strictEqual(expanded, '20260101/s1-r1-my-title.md');
		});

		test('未知占位符净化后保留语义', () => {
			const expanded = LlmArtifactStore.expandNamingRule('{unknown}-{ext}', {
				date: '', time: '', sessionId: '', requestId: '', slug: '', ext: '.txt',
			});
			assert.ok(expanded.startsWith('unknown'));
			assert.ok(expanded.endsWith('.txt'));
			assert.ok(!expanded.includes('{') && !expanded.includes('}'));
		});

		test('默认命名规则含日期与会话目录', () => {
			assert.ok(DEFAULT_LLM_ARTIFACT_NAMING_RULE.includes('{date}'));
			assert.ok(DEFAULT_LLM_ARTIFACT_NAMING_RULE.includes('{sessionId}'));
			assert.ok(DEFAULT_LLM_ARTIFACT_NAMING_RULE.endsWith('{ext}'));
		});
	});

	suite('save / list', () => {

		test('保存产物：文件落盘且索引可查', async () => {
			const meta = await store.save({
				kind: 'chat-transcript',
				sessionId: 'sess-a',
				requestId: 'req-1',
				title: '生成排序算法 Quick Sort 示例',
				content: '# transcript\nhello',
				ext: '.md',
			});
			assert.ok(meta.fileName.length > 0);
			assert.ok(meta.filePath.startsWith(root));
			assert.strictEqual(meta.bytes, Buffer.byteLength('# transcript\nhello', 'utf8'));

			const onDisk = fs.readFileSync(meta.filePath, 'utf8');
			assert.strictEqual(onDisk, '# transcript\nhello');

			const all = await store.list();
			assert.strictEqual(all.length, 1);
			assert.strictEqual(all[0].id, meta.id);
		});

		test('按会话过滤', async () => {
			await store.save({ kind: 'code-block', sessionId: 'sess-a', requestId: 'r1', title: 't', content: 'a', ext: '.ts' });
			await store.save({ kind: 'code-block', sessionId: 'sess-b', requestId: 'r2', title: 't', content: 'b', ext: '.ts' });
			const ofA = await store.list('sess-a');
			assert.strictEqual(ofA.length, 1);
			assert.strictEqual(ofA[0].sessionId, 'sess-a');
		});

		test('索引跨实例持久化（新→旧排序）', async () => {
			await store.save({ kind: 'chat-transcript', sessionId: 's', requestId: 'r1', title: 'first', content: '1', ext: '.md' });
			await store.save({ kind: 'chat-transcript', sessionId: 's', requestId: 'r2', title: 'second', content: '2', ext: '.md' });

			const reopened = new LlmArtifactStore(root);
			const items = await reopened.list();
			assert.strictEqual(items.length, 2);
			assert.strictEqual(items[0].requestId, 'r2'); // 新在前
			assert.strictEqual(items[1].requestId, 'r1');
		});

		test('自定义命名规则生效', async () => {
			store.setNamingRule('flat-{requestId}{ext}');
			const meta = await store.save({ kind: 'code-block', sessionId: 's', requestId: 'reqX', title: 't', content: 'x', ext: '.ts' });
			assert.strictEqual(meta.fileName, 'flat-reqx.ts'); // requestId 经 slugify 规范化（小写）
			store.setNamingRule(''); // 空串回退默认
			const meta2 = await store.save({ kind: 'code-block', sessionId: 's', requestId: 'r2', title: 't2', content: 'y', ext: '.ts' });
			assert.notStrictEqual(meta2.fileName, '');
			assert.ok(meta2.fileName.includes('s'));
		});
	});
});
