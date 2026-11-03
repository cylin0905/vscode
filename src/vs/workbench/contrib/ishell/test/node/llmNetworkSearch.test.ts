/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { apiBaseOfSource, buildModelFilesUrl, buildModelScopeFilesUrl, buildModelScopeSearchBody, buildModelScopeSearchUrl, buildSearchUrl, isNonQuantGgufFile, parseModelScopeModelFiles, parseModelScopeModels, parseNetworkModelFiles, parseNetworkModels } from '../../node/llmNetworkSearch.js';
import { ILlmSourceConfig, networkModelCatalogId } from '../../common/llm.js';

const SOURCE = (kind: 'official' | 'mirror' | 'modelscope' | 'custom', endpoint: string): ILlmSourceConfig => ({
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

	test('apiBaseOfSource：魔搭固定 modelscope.cn', () => {
		assert.strictEqual(apiBaseOfSource(SOURCE('modelscope', 'https://placeholder.example.com')), 'https://modelscope.cn');
	});

	test('buildSearchUrl：library=gguf + 下载量降序 + 分页参数', () => {
		const url = buildSearchUrl('https://hf-mirror.com', 'qwen coder');
		assert.ok(url.startsWith('https://hf-mirror.com/api/models?'));
		assert.ok(url.includes('search=qwen+coder'), '关键词应编码传递');
		assert.ok(url.includes('library=gguf'), '仅检索 GGUF 库');
		assert.ok(url.includes('sort=downloads'));
		assert.ok(url.includes('direction=-1'));
		assert.ok(url.includes('limit=100'));
		assert.ok(!url.includes('skip='), '首页不带 skip');
		assert.ok(buildSearchUrl('https://hf-mirror.com', 'qwen', 100).includes('skip=100'), '翻页带 skip');
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

	test('buildModelFilesUrl：仓库路径直达 tree/main', () => {
		assert.strictEqual(
			buildModelFilesUrl('https://hf-mirror.com', 'Qwen/Qwen2.5-7B-Instruct-GGUF'),
			'https://hf-mirror.com/api/models/Qwen/Qwen2.5-7B-Instruct-GGUF/tree/main'
		);
	});

	test('parseNetworkModelFiles：只保留 .gguf 文件 + 体积取 size/lfs + 量化优先', () => {
		const files = parseNetworkModelFiles([
			{ type: 'file', path: 'model-q8_0.gguf', size: 8_000 },
			{ type: 'file', path: 'model-q4_k_m.gguf', lfs: { size: 4_000 } },
			{ type: 'file', path: 'model-bf16.gguf', size: 3_000 }, // 非量化：体积最小也排在量化之后
			{ type: 'directory', path: 'sub' }, // 目录：跳过
			{ type: 'file', path: 'README.md' }, // 非 GGUF：跳过
			{ type: 'file', path: 'broken.gguf' }, // 缺体积：保留，排序按 0
			{ type: 'file', path: 'mmproj-model-bf16.gguf', size: 500 }, // 视觉投影辅助：跳过
			{ type: 'file', path: 'imatrix_unsloth.gguf', size: 600 }, // 量化校准辅助：跳过
			'not-an-object',
		]);
		assert.deepStrictEqual(files.map(f => f.file), ['broken.gguf', 'model-q4_k_m.gguf', 'model-q8_0.gguf', 'model-bf16.gguf']);
		assert.strictEqual(files[1].sizeBytes, 4000);
		assert.strictEqual(files[2].sizeBytes, 8000);
		assert.strictEqual(files[3].sizeBytes, 3000);
		assert.deepStrictEqual(parseNetworkModelFiles(null), []);
		assert.deepStrictEqual(parseNetworkModelFiles({}), []);
	});

	test('buildModelScopeSearchUrl / buildModelScopeSearchBody：dolphin 接口 + 下载量降序 + 去首尾空格', () => {
		assert.strictEqual(buildModelScopeSearchUrl('https://modelscope.cn'), 'https://modelscope.cn/api/v1/dolphin/models');
		const body = buildModelScopeSearchBody(' qwen ');
		assert.strictEqual(body.PageSize, 100);
		assert.strictEqual(body.PageNumber, 1);
		assert.strictEqual(body.SortBy, 'DownloadsCount');
		assert.strictEqual(body.Name, 'qwen');
		assert.strictEqual(body.Target, '');
		assert.deepStrictEqual(body.Criterion, [{ category: 'libraries', predicate: 'contains', values: ['gguf'] }]);
		assert.strictEqual(buildModelScopeSearchBody('qwen', 3).PageNumber, 3, '翻页传入页码');
	});

	test('parseModelScopeModels：GGUF 过滤 / 缺作者跳过 / 字段映射', () => {
		const payload = {
			Code: 200, Success: true,
			Data: { Model: { Models: [
				{ Path: 'Qwen', Name: 'Qwen2.5-7B-Instruct-GGUF', Downloads: 123456, Stars: 78, Libraries: ['gguf'], Tasks: [{ Name: 'text-generation' }] },
				{ Path: 'org', Name: 'my-gguf-model', Libraries: [], Tasks: [] },
				{ Path: 'org', Name: 'plain-model', Libraries: ['pytorch'] },
				{ Path: '', Name: 'missing-author', Libraries: ['gguf'] },
				'garbage',
			] } }
		};
		const models = parseModelScopeModels(payload);
		assert.strictEqual(models.length, 2);
		assert.strictEqual(models[0].author, 'Qwen');
		assert.strictEqual(models[0].name, 'Qwen2.5-7B-Instruct-GGUF');
		assert.strictEqual(models[0].id, 'Qwen/Qwen2.5-7B-Instruct-GGUF');
		assert.strictEqual(models[0].downloads, 123456);
		assert.strictEqual(models[0].likes, 78);
		assert.strictEqual(models[0].pipelineTag, 'text-generation');
		assert.deepStrictEqual(models[0].tags, ['gguf']);
		assert.strictEqual(models[1].name, 'my-gguf-model');
		assert.deepStrictEqual(models[1].tags, []);

		assert.deepStrictEqual(parseModelScopeModels(null), []);
		assert.deepStrictEqual(parseModelScopeModels({}), []);
		assert.deepStrictEqual(parseModelScopeModels({ Data: { Model: { Models: 'x' } } }), []);
	});

	test('buildModelScopeFilesUrl：仓库路径逐段编码', () => {
		assert.strictEqual(
			buildModelScopeFilesUrl('https://modelscope.cn', 'Org/My Model'),
			'https://modelscope.cn/api/v1/models/Org/My%20Model/repo/files?Revision=master&Recursive=True'
		);
	});

	test('parseModelScopeModelFiles：只保留 .gguf blob/file + 排除分片 + 量化优先', () => {
		const payload = { Data: { Files: [
			{ Path: 'model-q8_0.gguf', Type: 'blob', Size: 8000 },
			{ Path: 'model-q4_k_m.gguf', Type: 'blob', Size: 4000 },
			{ Path: 'model-BF16.gguf', Type: 'blob', Size: 3000 }, // 非量化：排在量化之后
			{ Path: 'model-00001-of-00004.gguf', Type: 'blob', Size: 1000 },
			{ Path: 'README.md', Type: 'blob', Size: 10 },
			{ Path: 'sub', Type: 'tree', Size: 0 },
			{ Path: 'broken.gguf', Type: 'file' },
			{ Path: 'mmproj-model-bf16.gguf', Type: 'blob', Size: 500 }, // 视觉投影辅助：跳过
			{ Path: 'imatrix_unsloth.gguf', Type: 'blob', Size: 600 }, // 量化校准辅助：跳过
			'garbage',
		] } };
		const files = parseModelScopeModelFiles(payload);
		assert.deepStrictEqual(files.map(f => f.file), ['broken.gguf', 'model-q4_k_m.gguf', 'model-q8_0.gguf', 'model-BF16.gguf']);
		assert.strictEqual(files[1].sizeBytes, 4000);
		assert.strictEqual(files[2].sizeBytes, 8000);
		assert.strictEqual(files[3].sizeBytes, 3000);

		assert.deepStrictEqual(parseModelScopeModelFiles(null), []);
		assert.deepStrictEqual(parseModelScopeModelFiles({}), []);
	});

	test('isNonQuantGgufFile：识别全精度文件名（bf16/f16/f32 等）', () => {
		for (const name of ['model-bf16.gguf', 'model-BF16.gguf', 'Qwen3.8-27B-F16.gguf', 'x.fp32.gguf', 'model_f8.gguf']) {
			assert.strictEqual(isNonQuantGgufFile(name), true, name);
		}
		for (const name of ['model-q4_k_m.gguf', 'Qwen3-32B-Q8_0.gguf', 'IQ4_XS.gguf', 'model-q6_k.gguf']) {
			assert.strictEqual(isNonQuantGgufFile(name), false, name);
		}
	});

	test('networkModelCatalogId：仓库+文件名稳定派生（小写归一，去重前缀）', () => {
		assert.strictEqual(
			networkModelCatalogId('Qwen/Qwen2.5-7B-Instruct-GGUF', 'qwen2.5-7b-instruct-q4_k_m.gguf'),
			'qwen-qwen2.5-7b-instruct-gguf--qwen2.5-7b-instruct-q4_k_m'
		);
		// 子目录文件保留层级信息（用 - 连接）
		assert.strictEqual(
			networkModelCatalogId('org/repo', 'sub/model.gguf'),
			'org-repo--sub-model'
		);
	});
});
