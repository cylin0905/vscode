/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { apiBaseOfSource, buildSearchUrl, parseNetworkModels } from '../../node/llmNetworkSearch.js';
import { ILlmSourceConfig } from '../../common/llm.js';

const SOURCE = (kind: 'official' | 'mirror' | 'custom', endpoint: string): ILlmSourceConfig => ({
	id: 'src', kind, name: '', endpoint, engineChannel: 'direct',
});

suite('LlmNetworkSearch', () => {

	teardown(() => { });

	ensureNoDisposablesAreLeakedInTestSuite();

	test('apiBaseOfSource：镜像固定 hf-mirror，其余取端点 origin', () => {
		assert.strictEqual(apiBaseOfSource(SOURCE('mirror', 'https://hf-mirror.com')), 'https://hf-mirror.com');
		assert.strictEqual(apiBaseOfSource(SOURCE('official', 'https://huggingface.co')), 'https://huggingface.co');
		assert.strictEqual(apiBaseOfSource(SOURCE('custom', 'https://example.com/hf')), 'https://example.com');
		// 端点非法时回退官方
		assert.strictEqual(apiBaseOfSource(SOURCE('custom', 'not-a-url')), 'https://huggingface.co');
	});

	test('buildSearchUrl：library=gguf + 下载量降序 + 条数上限', () => {
		const url = buildSearchUrl('https://hf-mirror.com', 'qwen coder');
		assert.ok(url.startsWith('https://hf-mirror.com/api/models?'));
		assert.ok(url.includes('search=qwen+coder'), '关键词应编码传递');
		assert.ok(url.includes('library=gguf'), '仅检索 GGUF 库');
		assert.ok(url.includes('sort=downloads'));
		assert.ok(url.includes('direction=-1'));
		assert.ok(url.includes('limit=30'));
	});

	test('parseNetworkModels：正常条目 / 缺字段容错 / 非数组', () => {
		const models = parseNetworkModels([
			{ id: 'Qwen/Qwen2.5-7B-Instruct-GGUF', downloads: 123456, likes: 78, pipeline_tag: 'text-generation', tags: ['gguf'] },
			{ id: 'no-slash-id', downloads: 1 }, // 缺斜杠：跳过
			'dropped', // 非对象：跳过
		]);
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].author, 'Qwen');
		assert.strictEqual(models[0].name, 'Qwen2.5-7B-Instruct-GGUF');
		assert.strictEqual(models[0].downloads, 123456);
		assert.strictEqual(models[0].likes, 78);
		assert.strictEqual(models[0].pipelineTag, 'text-generation');
		assert.deepStrictEqual(models[0].tags, ['gguf']);

		assert.deepStrictEqual(parseNetworkModels(null), []);
		assert.deepStrictEqual(parseNetworkModels({}), []);
		// 字段缺失时取默认值
		const [loose] = parseNetworkModels([{ id: 'a/b' }]);
		assert.strictEqual(loose.downloads, 0);
		assert.strictEqual(loose.likes, 0);
		assert.deepStrictEqual(loose.tags, []);
	});
});
