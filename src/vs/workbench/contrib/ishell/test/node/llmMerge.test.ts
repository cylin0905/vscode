/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { merge3Way, MERGE_CONFLICT_LABEL_OURS, MERGE_CONFLICT_LABEL_THEIRS, MERGE_CONFLICT_SEP } from '../../common/llmMerge.js';

suite('iShell/llmMerge', () => {

	test('无改动：三侧一致', () => {
		const text = 'a\nb\nc';
		const result = merge3Way(text, text, text);
		assert.strictEqual(result.conflicts, 0);
		assert.strictEqual(result.merged, text);
	});

	test('仅模型侧（theirs）改动：自动采纳', () => {
		const base = 'a\nb\nc';
		const ours = base;
		const theirs = 'a\nB\nc';
		const result = merge3Way(base, ours, theirs);
		assert.strictEqual(result.conflicts, 0);
		assert.strictEqual(result.merged, theirs);
	});

	test('仅本地侧（ours）改动：保留本地', () => {
		const base = 'a\nb\nc';
		const ours = 'a\nx\nc';
		const theirs = base;
		const result = merge3Way(base, ours, theirs);
		assert.strictEqual(result.conflicts, 0);
		assert.strictEqual(result.merged, ours);
	});

	test('双侧一致改动：取一份', () => {
		const base = 'a\nb\nc';
		const changed = 'a\nz\nc';
		const result = merge3Way(base, changed, changed);
		assert.strictEqual(result.conflicts, 0);
		assert.strictEqual(result.merged, changed);
	});

	test('双侧改同一处且不同：输出冲突标记', () => {
		const base = 'a\nb\nc';
		const ours = 'a\nours\nc';
		const theirs = 'a\ntheirs\nc';
		const result = merge3Way(base, ours, theirs);
		assert.strictEqual(result.conflicts, 1);
		assert.ok(result.merged.includes(MERGE_CONFLICT_LABEL_OURS));
		assert.ok(result.merged.includes(MERGE_CONFLICT_SEP));
		assert.ok(result.merged.includes(MERGE_CONFLICT_LABEL_THEIRS));
		assert.ok(result.merged.includes('ours') && result.merged.includes('theirs'));
	});

	test('不相交区间的双侧改动：干净合并', () => {
		const base = 'a\nb\nc\nd';
		const ours = 'A\nb\nc\nd'; // 头部改动
		const theirs = 'a\nb\nc\nD'; // 尾部改动
		const result = merge3Way(base, ours, theirs);
		assert.strictEqual(result.conflicts, 0);
		assert.strictEqual(result.merged, 'A\nb\nc\nD');
	});

	test('单侧插入（新增行）：干净合并', () => {
		const base = 'a\nb\nc';
		const ours = 'a\ninserted\nb\nc';
		const theirs = 'a\nb\nc\nappended';
		const result = merge3Way(base, ours, theirs);
		assert.strictEqual(result.conflicts, 0);
		assert.ok(result.merged.includes('inserted'));
		assert.ok(result.merged.endsWith('appended'));
		assert.ok(result.merged.includes('b'));
	});

	test('结尾换行保留', () => {
		const base = 'a\n';
		const theirs = 'a\nb\n';
		const result = merge3Way(base, base, theirs);
		assert.strictEqual(result.conflicts, 0);
		assert.ok(result.merged.endsWith('\n'));
	});
});
