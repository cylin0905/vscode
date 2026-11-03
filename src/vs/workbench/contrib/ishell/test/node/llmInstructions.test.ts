/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseCompletedInstructions, parseInstructions, extractCodeBlocks, slugify, shortHash, normalizeModelCompletion, planAutoSaveFromCodeBlocks, parseWorkflowPlan } from '../../common/llmInstructions.js';

suite('iShell/llmInstructions', () => {

	suite('parseInstructions', () => {

		test('解析 write 指令（路径/语言/内容）', () => {
			const text = [
				'回答如下：',
				'### ishell:write src/app.ts',
				'```typescript',
				'export const a = 1;',
				'```',
			].join('\n');
			const instructions = parseInstructions(text);
			assert.strictEqual(instructions.length, 1);
			assert.strictEqual(instructions[0].kind, 'write-file');
			assert.strictEqual((instructions[0] as { path: string }).path, 'src/app.ts');
			assert.strictEqual((instructions[0] as { content: string }).content, 'export const a = 1;');
			assert.strictEqual((instructions[0] as { language?: string }).language, 'typescript');
		});

		test('路径两端的引号被剥除（避免文件名带引号无法直接打开）', () => {
			const cases: [string, string][] = [
				['"game.html"', 'game.html'],
				['`main.py`', 'main.py'],
				['“app.ts”', 'app.ts'],
				["'a.js'", 'a.js'],
			];
			for (const [raw, expected] of cases) {
				const instructions = parseInstructions(`### ishell:write ${raw}\n\`\`\`\nx\n\`\`\``);
				assert.strictEqual(instructions.length, 1, raw);
				assert.strictEqual((instructions[0] as { path: string }).path, expected, raw);
			}
		});

		test('解析 edit 指令（find/replace 两段）', () => {
			const text = [
				'### ishell:edit src/app.ts',
				'```ishell-edit',
				'find:',
				'const a = 1;',
				'replace:',
				'const a = 2;',
				'```',
			].join('\n');
			const instructions = parseInstructions(text);
			assert.strictEqual(instructions.length, 1);
			assert.strictEqual(instructions[0].kind, 'edit-file');
			const edit = instructions[0] as { find: string; replace: string };
			assert.strictEqual(edit.find, 'const a = 1;');
			assert.strictEqual(edit.replace, 'const a = 2;');
		});

		test('解析 terminal 指令', () => {
			const text = [
				'### ishell:terminal',
				'```bash',
				'npm run compile',
				'```',
			].join('\n');
			const instructions = parseInstructions(text);
			assert.strictEqual(instructions.length, 1);
			assert.strictEqual(instructions[0].kind, 'terminal');
			assert.strictEqual((instructions[0] as { command: string }).command, 'npm run compile');
		});

		test('多指令按出现顺序编号', () => {
			const text = [
				'### ishell:write a.ts',
				'```',
				'a',
				'```',
				'### ishell:terminal',
				'```',
				'ls',
				'```',
				'### ishell:write b.ts',
				'```',
				'b',
				'```',
			].join('\n');
			const instructions = parseInstructions(text);
			assert.strictEqual(instructions.length, 3);
			assert.deepStrictEqual(instructions.map(i => i.seq), [1, 2, 3]);
			assert.deepStrictEqual(instructions.map(i => i.kind), ['write-file', 'terminal', 'write-file']);
		});

		test('无效 edit 块（缺 replace:）丢弃且不占 seq', () => {
			const text = [
				'### ishell:edit a.ts',
				'```',
				'只有 find 没有标记',
				'```',
				'### ishell:terminal',
				'```',
				'ls',
				'```',
			].join('\n');
			const instructions = parseInstructions(text);
			assert.strictEqual(instructions.length, 1);
			assert.strictEqual(instructions[0].seq, 1);
		});

		test('空命令块丢弃；普通代码围栏不产生指令', () => {
			const text = [
				'### ishell:terminal',
				'```',
				'   ',
				'```',
				'说明文字里的示例：',
				'```ts',
				'const x = 1;',
				'```',
			].join('\n');
			assert.deepStrictEqual(parseInstructions(text), []);
		});

		test('未闭合围栏保留已收集内容', () => {
			const text = '### ishell:write a.ts\n```\nline1\nline2';
			const instructions = parseInstructions(text);
			assert.strictEqual(instructions.length, 1);
			assert.strictEqual((instructions[0] as { content: string }).content, 'line1\nline2');
		});
	});

	suite('parseCompletedInstructions（流式渐进执行）', () => {

		test('已闭合指令返回且 closed 为真', () => {
			const text = [
				'### ishell:write a.ts',
				'```',
				'const a = 1;',
				'```',
			].join('\n');
			const completed = parseCompletedInstructions(text);
			assert.strictEqual(completed.length, 1);
			assert.strictEqual(completed[0].closed, true);
			assert.strictEqual((completed[0] as { content: string }).content, 'const a = 1;');
		});

		test('流中途的未闭合块被跳过（半成品不落盘）', () => {
			const streaming = '### ishell:write a.ts\n```\nconst a = 1;\nconst b = 2;'; // 围栏未闭合：仍在生成
			const completed = parseCompletedInstructions(streaming);
			assert.strictEqual(completed.length, 0);
			// 终态兜底：全量解析仍能容错取到已收集内容
			assert.strictEqual(parseInstructions(streaming).length, 1);
		});

		test('闭合与未闭合混合：只执行已闭合的', () => {
			const text = [
				'### ishell:write a.ts',
				'```',
				'ok',
				'```',
				'### ishell:write b.ts',
				'```',
				'partial',
			].join('\n');
			const completed = parseCompletedInstructions(text);
			assert.strictEqual(completed.length, 1);
			assert.strictEqual(completed[0].kind, 'write-file');
		});
	});

	suite('extractCodeBlocks', () => {

		test('提取全部代码围栏（含语言标识）', () => {
			const text = '前\n```ts\nconst a = 1;\n```\n中\n```\nplain\n```\n';
			const blocks = extractCodeBlocks(text);
			assert.strictEqual(blocks.length, 2);
			assert.strictEqual(blocks[0].language, 'ts');
			assert.strictEqual(blocks[0].content, 'const a = 1;');
			assert.strictEqual(blocks[1].language, '');
			assert.strictEqual(blocks[1].content, 'plain');
		});
	});

	suite('planAutoSaveFromCodeBlocks', () => {

		test('优先采用正文提到的文件名', () => {
			const answer = ['把下面的游戏保存为 game.html：', '```html', '<html><body>hi</body></html>', '```'].join('\n');
			const files = planAutoSaveFromCodeBlocks(answer);
			assert.strictEqual(files.length, 1);
			assert.strictEqual(files[0].path, 'game.html');
			assert.strictEqual(files[0].content, '<html><body>hi</body></html>');
		});

		test('未提文件名时按语言约定命名', () => {
			const answer = ['```css', 'body { margin: 0; }', '```'].join('\n');
			assert.strictEqual(planAutoSaveFromCodeBlocks(answer)[0].path, 'style.css');
		});

		test('多个同语言代码块追加序号，避免互相覆盖', () => {
			const answer = ['```js', 'console.log(1);', '```', '```js', 'console.log(2);', '```'].join('\n');
			const files = planAutoSaveFromCodeBlocks(answer);
			assert.deepStrictEqual(files.map(f => f.path), ['script.js', 'script-1.js']);
		});

		test('无语言标记时按内容嗅探 HTML，无法识别的跳过', () => {
			const answer = ['```', '<!DOCTYPE html>', '```', '```bash', 'ls -la', '```'].join('\n');
			const files = planAutoSaveFromCodeBlocks(answer, new Set(['index.html']));
			assert.deepStrictEqual(files.map(f => f.path), ['index-1.html']);
		});
	});

	suite('parseWorkflowPlan', () => {

		test('解析思考与计划两块', () => {
			const raw = ['### ishell:think', '需要给游戏加计分板，改 game.html。', '### ishell:plan', '- 读取现有文件', '- 在顶栏加入分数显示', '- 更新计分逻辑'].join('\n');
			const plan = parseWorkflowPlan(raw);
			assert.strictEqual(plan.thinking, '需要给游戏加计分板，改 game.html。');
			assert.deepStrictEqual(plan.steps, ['读取现有文件', '在顶栏加入分数显示', '更新计分逻辑']);
		});

		test('思考内容被代码围栏包裹时自动剥离', () => {
			const raw = ['### ishell:think', '```', '分析需求：修复按钮点击无效。', '```', '### ishell:plan', '1. 检查事件绑定', '2. 修正监听器'].join('\n');
			const plan = parseWorkflowPlan(raw);
			assert.strictEqual(plan.thinking, '分析需求：修复按钮点击无效。');
			assert.deepStrictEqual(plan.steps, ['检查事件绑定', '修正监听器']);
		});

		test('缺少标记时返回空结果（调用方退化为直接执行）', () => {
			const plan = parseWorkflowPlan('这是一个普通回答，没有规划结构。');
			assert.strictEqual(plan.thinking, '');
			assert.deepStrictEqual(plan.steps, []);
		});
	});

	suite('slugify', () => {

		test('生成文件名友好短标签', () => {
			assert.strictEqual(slugify('Hello World! 你好'), 'hello-world');
			assert.strictEqual(slugify('---'), 'snippet');
			assert.strictEqual(slugify('a'.repeat(60), 10), 'a'.repeat(10));
		});
	});

	suite('shortHash', () => {

		test('8 位 base36 定长且稳定', () => {
			const h1 = shortHash('session-a');
			assert.strictEqual(h1, shortHash('session-a'));
			assert.notStrictEqual(h1, shortHash('session-b'));
			assert.match(h1, /^[0-9a-z]{8}$/);
		});
	});

	suite('normalizeModelCompletion', () => {

		test('剥掉模型包上的围栏', () => {
			assert.strictEqual(normalizeModelCompletion('```ts\nfoo();\n```', ''), 'foo();');
		});

		test('缩进对齐：剥除与当前行重复的缩进', () => {
			assert.strictEqual(normalizeModelCompletion('    bar();', '    foo'), 'bar();');
			assert.strictEqual(normalizeModelCompletion('bar();', '    foo'), 'bar();');
		});

		test('按行数截断', () => {
			const raw = ['a', 'b', 'c'].join('\n');
			assert.strictEqual(normalizeModelCompletion(raw, '', 2), 'a\nb');
		});

		test('空白输出返回空串（放弃补全）', () => {
			assert.strictEqual(normalizeModelCompletion('   \n  ', ''), '');
		});
	});
});
