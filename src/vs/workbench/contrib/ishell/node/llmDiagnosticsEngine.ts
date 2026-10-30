/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILlmDiagnostic, ILlmDiagnosticReport, LlmDiagnosticCategory, LlmDiagnosticSeverity } from '../common/llm.js';

// #########################################################################
// ##      iShell 内置静态代码分析引擎（规则驱动，多语言族支持）            ##
// ##  覆盖：语法（括号配对）、逻辑异常、潜在 bug、性能问题、代码风格        ##
// ##  规则按行正则 + 结构扫描（字符串/注释感知）实现，零依赖零网络，       ##
// ##  毫秒级完成，不依赖本地模型运行状态（性能保障）。                      ##
// #########################################################################

interface ILlmRule {
	id: string;
	category: LlmDiagnosticCategory;
	severity: LlmDiagnosticSeverity;
	message: string;
	suggestion: string;
	/** 适用语言（未定义 = 全部）；值先与语言族比较再与具体语言比较 */
	languages?: string[];
	/** 逐行匹配正则（勿用 g 标志） */
	linePattern?: RegExp;
	/** 结构扫描钩子 */
	scan?: (ctx: ILlmScanContext) => void;
}

interface ILlmScanContext {
	lines: string[];
	language: string;
	/** 语言族：'js' | 'c' | 'python' | '' */
	family: string;
	push(rule: ILlmRule, line: number, startColumn: number, endLine: number, endColumn: number): void;
}

// ---- 语言族划分（注释语法决定扫描器） ----

const JS_FAMILY = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
const C_FAMILY = ['c', 'cpp', 'csharp', 'java', 'go', 'rust', 'swift', 'kotlin', 'php', 'scala', 'objective-c'];
const PY_FAMILY = ['python'];

function familyOf(language: string): string {
	if (JS_FAMILY.includes(language)) {
		return 'js';
	}
	if (C_FAMILY.includes(language)) {
		return 'c';
	}
	if (PY_FAMILY.includes(language)) {
		return 'python';
	}
	return '';
}

// ---- 规则表 ----

const RULES: ILlmRule[] = [
	// ===== 通用 =====
	{
		id: 'todo-comment',
		category: 'style',
		severity: 'info',
		message: '遗留 TODO/FIXME 标记',
		suggestion: '清理遗留标记，或转为待办事项跟踪。',
		languages: undefined,
		linePattern: /\b(TODO|FIXME|HACK|XXX)\b/,
	},
	{
		id: 'long-line',
		category: 'style',
		severity: 'hint',
		message: '单行过长（超过 200 字符）',
		suggestion: '拆分长行以提升可读性。',
		languages: undefined,
		scan: ctx => {
			ctx.lines.forEach((line, idx) => {
				if (line.length > 200) {
					ctx.push(RULE_BY_ID['long-line']!, idx + 1, 1, idx + 1, line.length + 1);
				}
			});
		},
	},

	// ===== JS / TS 族 =====
	{
		id: 'js-loose-equality',
		category: 'bug',
		severity: 'warning',
		message: '使用了宽松相等（== / !=）',
		suggestion: '改用严格相等（=== / !==），避免隐式类型转换引发 bug。',
		languages: JS_FAMILY,
		linePattern: /[^=!<>]==[^=]|[^!<>=!]!=(?!=)/,
	},
	{
		id: 'js-var-declaration',
		category: 'style',
		severity: 'warning',
		message: '使用了 var 声明',
		suggestion: '改用 const / let 声明变量。',
		languages: JS_FAMILY,
		linePattern: /\bvar\s+[A-Za-z_$]/,
	},
	{
		id: 'js-assign-in-condition',
		category: 'logic',
		severity: 'error',
		message: '条件表达式中出现赋值（疑似漏写比较）',
		suggestion: '若确需赋值请加括号并二次确认；否则应改用比较运算符（===）。',
		languages: JS_FAMILY,
		linePattern: /\bif\s*\(\s*[A-Za-z_$][\w$.]*\s*=(?!=)/,
	},
	{
		id: 'js-empty-catch',
		category: 'bug',
		severity: 'warning',
		message: '空 catch 块吞掉了异常',
		suggestion: '至少记录异常或注释说明忽略原因。',
		languages: JS_FAMILY,
		linePattern: /catch\s*(\(\s*[^)]*\s*\))?\s*\{\s*\}/,
	},
	{
		id: 'js-eval-use',
		category: 'bug',
		severity: 'error',
		message: '使用了 eval（代码注入与性能风险）',
		suggestion: '移除 eval，改用安全的解析器或显式逻辑。',
		languages: JS_FAMILY,
		linePattern: /\beval\s*\(/,
	},
	{
		id: 'js-innerhtml-assign',
		category: 'bug',
		severity: 'warning',
		message: '直接赋值 innerHTML 存在 XSS 风险',
		suggestion: '改用 textContent 或对内容做转义。',
		languages: JS_FAMILY,
		linePattern: /\.innerHTML\s*=(?!=)/,
	},
	{
		id: 'js-console-log',
		category: 'style',
		severity: 'hint',
		message: '遗留 console 调试输出',
		suggestion: '移除调试输出或替换为正式日志。',
		languages: JS_FAMILY,
		linePattern: /\bconsole\.(log|debug)\s*\(/,
	},
	{
		id: 'js-debugger-statement',
		category: 'bug',
		severity: 'error',
		message: '遗留 debugger 语句',
		suggestion: '删除 debugger 断点语句。',
		languages: JS_FAMILY,
		linePattern: /^\s*debugger\s*(;|$)/,
	},
	{
		id: 'js-await-in-loop',
		category: 'performance',
		severity: 'warning',
		message: '循环内 await 串行等待（性能问题）',
		suggestion: '评估是否可并行（如 Promise.all 批量处理）。',
		languages: JS_FAMILY,
		scan: ctx => {
			const loopStarts: { line: number; indent: number }[] = [];
			const loopRe = /^\s*(for|while)\b/;
			const awaitRe = /\bawait\s/;
			ctx.lines.forEach((line, idx) => {
				const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
				if (loopRe.test(line)) {
					while (loopStarts.length > 0 && loopStarts[loopStarts.length - 1].indent >= indent) {
						loopStarts.pop();
					}
					loopStarts.push({ line: idx + 1, indent });
				} else if (awaitRe.test(line) && !/^\s*\/\//.test(line)) {
					if (loopStarts.some(loop => loop.indent < indent)) {
						ctx.push(RULE_BY_ID['js-await-in-loop']!, idx + 1, 1, idx + 1, line.length + 1);
					}
				}
			});
		},
	},

	// ===== Python 族 =====
	{
		id: 'py-bare-except',
		category: 'bug',
		severity: 'warning',
		message: '裸 except 捕获所有异常（含 Ctrl+C）',
		suggestion: '指定具体异常类型（如 except ValueError:）。',
		languages: PY_FAMILY,
		linePattern: /except\s*:\s*(#.*)?$/,
	},
	{
		id: 'py-mutable-default-arg',
		category: 'bug',
		severity: 'warning',
		message: '可变对象作为默认参数（跨调用共享状态）',
		suggestion: '默认值改用 None 并在函数体内初始化。',
		languages: PY_FAMILY,
		linePattern: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\s*\))/,
	},
	{
		id: 'py-eq-none',
		category: 'style',
		severity: 'hint',
		message: '用 == 比较 None',
		suggestion: '按 PEP8 惯例改用 is None / is not None。',
		languages: PY_FAMILY,
		linePattern: /==\s*None\b|!=\s*None\b/,
	},
	{
		id: 'py-print-debug',
		category: 'style',
		severity: 'hint',
		message: '遗留 print 调试输出',
		suggestion: '移除调试输出或改用 logging。',
		languages: PY_FAMILY,
		linePattern: /^\s*print\s*\(/,
	},
	{
		id: 'py-breakpoint-call',
		category: 'bug',
		severity: 'error',
		message: '遗留 breakpoint() 调试语句',
		suggestion: '删除 breakpoint() 断点语句。',
		languages: PY_FAMILY,
		linePattern: /\bbreakpoint\s*\(\s*\)/,
	},

	// ===== 其他语言专属 =====
	{
		id: 'rust-unwrap',
		category: 'bug',
		severity: 'warning',
		message: '使用 .unwrap() 直接解包（会 panic）',
		suggestion: '改用 match / expect / unwrap_or 处理 Err 分支。',
		languages: ['rust'],
		linePattern: /\.unwrap\s*\(\s*\)/,
	},
	{
		id: 'rust-dbg-macro',
		category: 'bug',
		severity: 'warning',
		message: '遗留 dbg! 调试宏',
		suggestion: '删除 dbg! 调试输出。',
		languages: ['rust'],
		linePattern: /\bdbg!\s*\(/,
	},
	{
		id: 'c-unsafe-str',
		category: 'bug',
		severity: 'error',
		message: '使用不安全的字符串函数（缓冲区溢出风险）',
		suggestion: '改用带长度限制的版本（如 strncpy / snprintf）。',
		languages: ['c', 'cpp'],
		linePattern: /\b(strcpy|gets|strcat)\s*\(/,
	},
	{
		id: 'sql-select-star',
		category: 'performance',
		severity: 'info',
		message: 'SELECT * 拉取全部列',
		suggestion: '按需列出列名，减少 IO 与网络开销。',
		languages: ['sql'],
		linePattern: /^\s*select\s+\*\s+from\b/i,
	},
];

const RULE_BY_ID: Record<string, ILlmRule> = Object.fromEntries(RULES.map(rule => [rule.id, rule]));

// ---- 括号配对扫描（字符串 / 注释感知） ----

interface IBalanceIssue {
	line: number;
	message: string;
}

function scanBracketBalance(lines: string[], family: string): IBalanceIssue | undefined {
	if (family !== 'js' && family !== 'c' && family !== 'python') {
		return undefined;
	}
	const stack: { ch: string; line: number }[] = [];
	let inBlockComment = false;
	let inTriple: string | undefined; // python 三引号
	let quote: string | undefined; // 单行字符串引号
	let escaped = false;

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		let i = 0;
		while (i < line.length) {
			const ch = line[i];
			const next = line[i + 1] ?? '';
			if (escaped) {
				escaped = false;
				i++;
				continue;
			}
			if (quote) {
				if (ch === '\\') {
					escaped = true;
				} else if (ch === quote) {
					quote = undefined;
				}
				i++;
				continue;
			}
			if (inTriple) {
				if (line.startsWith(inTriple, i)) {
					inTriple = undefined;
					i += 3;
					continue;
				}
				i++;
				continue;
			}
			if (inBlockComment) {
				if (ch === '*' && next === '/') {
					inBlockComment = false;
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			// 注释起始
			if ((family === 'js' || family === 'c') && ch === '/' && next === '/') {
				break; // 行注释余下内容跳过
			}
			if ((family === 'js' || family === 'c') && ch === '/' && next === '*') {
				inBlockComment = true;
				i += 2;
				continue;
			}
			if (family === 'python' && ch === '#') {
				break;
			}
			// 字符串起始
			if (family === 'python' && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
				inTriple = line.substr(i, 3);
				i += 3;
				continue;
			}
			if (ch === '"' || ch === "'" || (family === 'js' && ch === '`')) {
				quote = ch;
				i++;
				continue;
			}
			// 括号
			if (ch === '(' || ch === '[' || ch === '{') {
				stack.push({ ch, line: lineIdx + 1 });
			} else if (ch === ')' || ch === ']' || ch === '}') {
				const open = stack.pop();
				const expected = ch === ')' ? '(' : ch === ']' ? '[' : '{';
				if (!open || open.ch !== expected) {
					return { line: lineIdx + 1, message: `括号不配对：第 ${lineIdx + 1} 行的 '${ch}' 没有对应的 '${expected}'` };
				}
			}
			i++;
		}
		quote = undefined; // 单行字符串不跨行（python 三引号已单独处理）
	}
	if (inBlockComment || inTriple) {
		return { line: lines.length, message: '存在未闭合的块注释或三引号字符串' };
	}
	if (stack.length > 0) {
		const open = stack[0];
		return { line: open.line, message: `括号不配对：第 ${open.line} 行的 '${open.ch}' 未闭合` };
	}
	return undefined;
}

// 结构扫描专用规则（不在 RULES 表内注册行匹配，仅提供元数据）
const STRUCTURAL_RULES: Record<string, ILlmRule> = {
	'nested-loop-depth': {
		id: 'nested-loop-depth',
		category: 'performance',
		severity: 'warning',
		message: '三层及以上循环嵌套（O(n³) 风险）',
		suggestion: '重构数据结构或提前建立索引以降低嵌套层数。',
		languages: undefined,
	},
	'unbalanced-brackets': {
		id: 'unbalanced-brackets',
		category: 'syntax',
		severity: 'error',
		message: '括号不配对',
		suggestion: '补全或删除多余括号，使括号成对闭合。',
		languages: undefined,
	},
};

// ---- 循环嵌套深度扫描（性能） ----

function scanLoopDepth(ctx: ILlmScanContext): void {
	const loopRe = /^\s*(for|while|foreach)\b/;
	const stack: { line: number; indent: number }[] = [];
	ctx.lines.forEach((line, idx) => {
		if (!loopRe.test(line)) {
			return;
		}
		const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}
		stack.push({ line: idx + 1, indent });
		if (stack.length >= 3) {
			ctx.push(STRUCTURAL_RULES['nested-loop-depth']!, idx + 1, 1, idx + 1, line.length + 1);
		}
	});
}

/** 每条规则最多报 50 处，避免大文件诊断爆炸 */
const MAX_HITS_PER_RULE = 50;

/** 静态分析入口：返回诊断报告（毫秒级，无外部依赖） */
export function analyzeDiagnostics(content: string, language: string, path?: string): ILlmDiagnosticReport {
	const lines = content.split(/\r?\n/);
	const family = familyOf(language);
	const diagnostics: ILlmDiagnostic[] = [];
	const hits = new Map<string, number>();

	const pushDiag = (rule: ILlmRule, line: number, startColumn: number, endLine: number, endColumn: number) => {
		const count = hits.get(rule.id) ?? 0;
		if (count >= MAX_HITS_PER_RULE) {
			return;
		}
		hits.set(rule.id, count + 1);
		diagnostics.push({
			ruleId: rule.id,
			severity: rule.severity,
			category: rule.category,
			message: rule.message,
			suggestion: rule.suggestion,
			line: Math.max(1, line),
			startColumn: Math.max(1, startColumn),
			endLine: Math.max(1, endLine),
			endColumn: Math.max(2, endColumn),
		});
	};

	const ctx: ILlmScanContext = { lines, language, family, push: pushDiag };

	// 1) 行正则规则
	for (const rule of RULES) {
		if (!rule.linePattern) {
			continue;
		}
		if (rule.languages && !rule.languages.includes(language)) {
			continue;
		}
		for (let idx = 0; idx < lines.length; idx++) {
			const match = rule.linePattern.exec(lines[idx]);
			if (match) {
				pushDiag(rule, idx + 1, match.index + 1, idx + 1, match.index + match[0].length + 1);
			}
		}
	}

	// 2) 结构扫描：括号配对（js/c/python 族）
	if (family !== '') {
		const issue = scanBracketBalance(lines, family);
		if (issue) {
			pushDiag(STRUCTURAL_RULES['unbalanced-brackets']!, issue.line, 1, issue.line, (lines[issue.line - 1]?.length ?? 0) + 1);
			// 覆盖为具体消息
			diagnostics[diagnostics.length - 1].message = issue.message;
		}
	}

	// 3) 结构扫描：循环嵌套深度（性能）
	scanLoopDepth({ ...ctx, push: pushDiag });

	// 4) 结构扫描规则钩子
	for (const rule of RULES) {
		if (rule.scan && (!rule.languages || rule.languages.includes(language))) {
			rule.scan({ ...ctx, push: pushDiag });
		}
	}

	// 汇总
	diagnostics.sort((a, b) => (a.line - b.line) || (a.startColumn - b.startColumn));
	const summary = {
		errors: diagnostics.filter(d => d.severity === 'error').length,
		warnings: diagnostics.filter(d => d.severity === 'warning').length,
		infos: diagnostics.filter(d => d.severity === 'info').length,
		hints: diagnostics.filter(d => d.severity === 'hint').length,
		score: 0,
	};
	summary.score = Math.max(0, Math.round(100 - summary.errors * 10 - summary.warnings * 3 - summary.infos * 1 - summary.hints * 0.25));
	const suggestions = [...new Set(diagnostics.map(d => `[${d.ruleId}] ${d.suggestion}`))].slice(0, 8);

	return {
		uri: path,
		language,
		diagnostics,
		summary,
		suggestions,
		createdAt: Date.now(),
	};
}
