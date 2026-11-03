/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { getCatalogEntry, getLlmSystemInfo, LLM_MODEL_CATALOG } from '../../node/llmCatalog.js';

suite('ishell > LlmCatalog', () => {

	test('目录条目 id 唯一且字段完整', () => {
		const ids = LLM_MODEL_CATALOG.map(m => m.id);
		assert.strictEqual(new Set(ids).size, ids.length, '目录 id 不得重复');
		for (const entry of LLM_MODEL_CATALOG) {
			assert.ok(entry.name.length > 0);
			assert.ok(!/\s/.test(entry.repo), `repo 不应含空格：${entry.repo}`);
			assert.ok(entry.repo.includes('/'), `repo 应为 owner/name 格式：${entry.repo}`);
			assert.ok(entry.file.endsWith('.gguf'), `文件应为 GGUF：${entry.file}`);
			assert.ok(entry.sizeBytes > 0);
			assert.ok(entry.minRamGb > 0);
			assert.ok(entry.description.length > 0);
			assert.ok(entry.tags.length > 0);
			// 品牌图标可选，但配置了就必须是本地静态资源键（禁止在线 URL）
			if (entry.vendorIcon !== undefined) {
				assert.ok(['qwen', 'deepseek', 'llama'].includes(entry.vendorIcon), `vendorIcon 应为本地品牌键：${entry.id}`);
			}
		}
	});

	test('getCatalogEntry 命中与未命中', () => {
		const first = LLM_MODEL_CATALOG[0];
		assert.strictEqual(getCatalogEntry(first.id), first);
		assert.strictEqual(getCatalogEntry('不存在'), undefined);
	});

	test('getLlmSystemInfo 推荐与实际内存分档一致', () => {
		const info = getLlmSystemInfo();
		assert.ok(info.totalMemGb > 0);
		// 可用内存用于下载前提示：应为非负且不超过总量
		assert.ok(info.availableMemGb >= 0);
		assert.ok(info.availableMemGb <= info.totalMemGb + 1);
		assert.ok(info.cpuCores >= 1);
		assert.ok(info.cpuModel.length > 0);
		assert.ok(info.arch.length > 0);

		// 推荐 = 目录中全部 minRamGb <= totalMemGb 的条目（双向校验）
		const expected = LLM_MODEL_CATALOG.filter(m => m.minRamGb <= info.totalMemGb).map(m => m.id);
		assert.deepStrictEqual(info.recommendedModelIds, expected);
		// 推荐之外的一定超内存档
		for (const entry of LLM_MODEL_CATALOG) {
			if (!info.recommendedModelIds.includes(entry.id)) {
				assert.ok(entry.minRamGb > info.totalMemGb, `未推荐条目 ${entry.id} 应超内存档`);
			}
		}
	});
});
