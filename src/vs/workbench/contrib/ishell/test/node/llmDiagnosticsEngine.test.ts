/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { analyzeDiagnostics } from '../../node/llmDiagnosticsEngine.js';

suite('iShell/llmDiagnosticsEngine', () => {

	test('干净代码：零诊断，评分 100', () => {
		const content = [
			'const greet = (name: string): string => {',
			'\treturn `hello ${name}`;',
			'};',
			'export { greet };',
		].join('\n');
		const report = analyzeDiagnostics(content, 'typescript', 'a.ts');
		assert.deepStrictEqual(report.diagnostics, []);
		assert.strictEqual(report.summary.score, 100);
		assert.strictEqual(report.summary.errors, 0);
		assert.strictEqual(report.summary.warnings, 0);
	});

	test('条件中赋值：error 级逻辑异常', () => {
		const report = analyzeDiagnostics('if (count = 10) {\n\tconsole.log(count);\n}\n', 'javascript');
		const hit = report.diagnostics.find(d => d.ruleId === 'js-assign-in-condition');
		assert.ok(hit);
		assert.strictEqual(hit.severity, 'error');
		assert.strictEqual(hit.category, 'logic');
		assert.strictEqual(hit.line, 1);
		assert.ok(hit.suggestion.length > 0);
		assert.ok(report.summary.errors >= 1);
	});

	test('debugger 与宽松相等：error / warning 各一', () => {
		const report = analyzeDiagnostics('debugger;\nif (a == b) {\n\tvar c = 1;\n}\n', 'javascript');
		assert.ok(report.diagnostics.some(d => d.ruleId === 'js-debugger-statement' && d.severity === 'error'));
		assert.ok(report.diagnostics.some(d => d.ruleId === 'js-loose-equality' && d.severity === 'warning'));
		assert.ok(report.diagnostics.some(d => d.ruleId === 'js-var-declaration'));
	});

	test('括号不配对：syntax 类 error', () => {
		const report = analyzeDiagnostics('function broken() {\n\treturn 1;', 'typescript');
		const hit = report.diagnostics.find(d => d.ruleId === 'unbalanced-brackets');
		assert.ok(hit);
		assert.strictEqual(hit.severity, 'error');
		assert.strictEqual(hit.category, 'syntax');
	});

	test('字符串与注释内的括号不误报', () => {
		const content = [
			'const s = "(()("; // comment {',
			'/* block ) */',
			'export const x = 1;',
		].join('\n');
		const report = analyzeDiagnostics(content, 'typescript');
		assert.ok(!report.diagnostics.some(d => d.ruleId === 'unbalanced-brackets'));
	});

	test('三层循环嵌套：performance warning', () => {
		const content = [
			'for (let i = 0; i < 3; i++) {',
			'\tfor (let j = 0; j < 3; j++) {',
			'\t\tfor (let k = 0; k < 3; k++) {',
			'\t\t\tawait step(i, j, k);',
			'\t\t}',
			'\t}',
			'}',
		].join('\n');
		const report = analyzeDiagnostics(content, 'javascript');
		assert.ok(report.diagnostics.some(d => d.ruleId === 'nested-loop-depth' && d.category === 'performance'));
		assert.ok(report.diagnostics.some(d => d.ruleId === 'js-await-in-loop'));
	});

	test('Python 规则按语言生效', () => {
		const py = [
			'try:',
			'\tvalue = int(text)',
			'except:',
			'\tvalue = 0',
		].join('\n');
		const report = analyzeDiagnostics(py, 'python', 'a.py');
		assert.ok(report.diagnostics.some(d => d.ruleId === 'py-bare-except'));
		// 同样内容按 javascript 分析不应触发 python 规则
		const jsReport = analyzeDiagnostics('except:\n', 'javascript');
		assert.ok(!jsReport.diagnostics.some(d => d.ruleId === 'py-bare-except'));
	});

	test('TODO 标记：info 级提示', () => {
		const report = analyzeDiagnostics('// TODO: 后续补充\nexport const a = 1;\n', 'typescript');
		const hit = report.diagnostics.find(d => d.ruleId === 'todo-comment');
		assert.ok(hit);
		assert.strictEqual(hit.severity, 'info');
		assert.strictEqual(hit.category, 'style');
	});

	test('评分公式：errors*10 + warnings*3 加权扣分', () => {
		const report = analyzeDiagnostics('debugger;\n', 'javascript');
		assert.strictEqual(report.summary.errors, 1);
		assert.strictEqual(report.summary.score, 90);
	});

	test('建议清单去重且排序输出', () => {
		const report = analyzeDiagnostics('debugger;\ndebugger;\n', 'javascript');
		assert.ok(report.suggestions.length >= 1);
		const unique = new Set(report.suggestions);
		assert.strictEqual(unique.size, report.suggestions.length);
	});
});
