/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// #########################################################################
// ##                     iShell 指令跟随：指令块解析                       ##
// ##  纯文本协议（本地小模型友好），由 Chat Agent 写出、渲染层解析执行：      ##
// ##    ### ishell:write <工作区内相对路径>                                 ##
// ##    ```<语言>                                                          ##
// ##    ...完整文件内容...                                                  ##
// ##    ```                                                                ##
// ##    ### ishell:edit <工作区内相对路径>                                  ##
// ##    ```ishell-edit                                                      ##
// ##    find:                                                              ##
// ##    ...要查找的原文本（可多行）...                                      ##
// ##    replace:                                                           ##
// ##    ...替换后的文本（可多行）...                                        ##
// ##    ```                                                                ##
// ##    ### ishell:terminal                                                ##
// ##    ```bash                                                            ##
// ##    ...建议的命令（绝不自动执行，仅渲染确认按钮）...                     ##
// ##    ```                                                                ##
// #########################################################################

export type LlmInstructionKind = 'write-file' | 'edit-file' | 'terminal';

export interface ILlmInstructionBase {
	/** 在响应中的出现序（指令序列执行顺序） */
	seq: number;
	kind: LlmInstructionKind;
	/** 指令块围栏是否已闭合（流式渐进执行：仅执行闭合完整的指令，避免半成品落盘） */
	closed: boolean;
}

export interface ILlmWriteFileInstruction extends ILlmInstructionBase {
	kind: 'write-file';
	/** 工作区内相对路径（可空：执行器回退当前编辑器文件） */
	path: string;
	/** 围栏语言标识（如 typescript） */
	language?: string;
	content: string;
}

export interface ILlmEditFileInstruction extends ILlmInstructionBase {
	kind: 'edit-file';
	path: string;
	find: string;
	replace: string;
}

export interface ILlmTerminalInstruction extends ILlmInstructionBase {
	kind: 'terminal';
	command: string;
}

export type ILlmInstruction = ILlmWriteFileInstruction | ILlmEditFileInstruction | ILlmTerminalInstruction;

const HEADING_RE = /^#{1,6}\s*ishell:(write|edit|terminal)\b[ \t]*(\S+)?[ \t]*$/i;
const FENCE_OPEN_RE = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

/** 剥掉模型在路径两端自作主张包上的引号 / 反引号（含中文全角引号），避免文件名带引号导致无法直接打开 */
function stripPathQuotes(raw: string | undefined): string {
	return (raw ?? '').trim().replace(/^["'`“”‘’]+/, '').replace(/["'`‘’“”]+$/, '');
}

/** 解析模型响应中的全部指令块（按出现顺序编号）；无指令返回空数组 */
export function parseInstructions(text: string): ILlmInstruction[] {
	const lines = text.split(/\r?\n/);
	const result: ILlmInstruction[] = [];
	let seq = 0;
	let pending: { kind: 'write' | 'edit' | 'terminal'; path?: string } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const heading = HEADING_RE.exec(lines[i]);
		if (heading) {
			pending = { kind: heading[1].toLowerCase() as 'write' | 'edit' | 'terminal', path: stripPathQuotes(heading[2]) };
			continue;
		}
		if (!pending) {
			continue;
		}
		const fence = FENCE_OPEN_RE.exec(lines[i]);
		if (!fence) {
			continue; // 标题与围栏之间允许说明文字，继续等待围栏
		}
		const language = fence[1]?.toLowerCase() ?? '';
		const body: string[] = [];
		let closed = false;
		for (let j = i + 1; j < lines.length; j++) {
			if (FENCE_CLOSE_RE.test(lines[j])) {
				closed = true;
				i = j;
				break;
			}
			body.push(lines[j]);
		}
		if (!closed) {
			i = lines.length; // 未闭合围栏：吞到结尾（保留已收集内容）
		}
		const content = body.join('\n');
		seq++;
		if (pending.kind === 'write') {
			result.push({ seq, kind: 'write-file', path: pending.path ?? '', language: language || undefined, content, closed });
		} else if (pending.kind === 'edit') {
			const parsed = parseFindReplace(content);
			if (!parsed || parsed.find.trim() === '') {
				seq--; // 无效 edit 块丢弃
			} else {
				result.push({ seq, kind: 'edit-file', path: pending.path ?? '', find: parsed.find, replace: parsed.replace, closed });
			}
		} else {
			const command = content.trim();
			if (command === '') {
				seq--; // 空命令块丢弃
			} else {
				result.push({ seq, kind: 'terminal', command, closed });
			}
		}
		pending = undefined;
	}
	return result;
}

/**
 * 流式渐进执行用：只返回围栏已闭合的完整指令（未闭合的半成品块被跳过）。
 * 流结束后仍可用 parseInstructions 全量容错解析（未闭合块保留已收集内容）。
 */
export function parseCompletedInstructions(text: string): ILlmInstruction[] {
	return parseInstructions(text).filter(instruction => instruction.closed);
}

/** 解析 ```ishell-edit 围栏体的 find:/replace: 两段结构 */
function parseFindReplace(content: string): { find: string; replace: string } | undefined {
	const lines = content.split('\n');
	let findStart = -1;
	let replaceStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (findStart === -1 && lines[i].trim() === 'find:') {
			findStart = i;
			continue;
		}
		if (findStart !== -1 && replaceStart === -1 && lines[i].trim() === 'replace:') {
			replaceStart = i;
			break;
		}
	}
	if (findStart === -1 || replaceStart === -1) {
		return undefined;
	}
	return {
		find: lines.slice(findStart + 1, replaceStart).join('\n'),
		replace: lines.slice(replaceStart + 1).join('\n'),
	};
}

// ==== 通用文本工具（产物命名 / 补全清洗共用） ====

export interface ILlmCodeBlock {
	language: string;
	content: string;
}

/** 提取响应中全部普通代码围栏块（用于产物另存）；不要求 ishell 指令标题 */
export function extractCodeBlocks(text: string): ILlmCodeBlock[] {
	const lines = text.split(/\r?\n/);
	const blocks: ILlmCodeBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const fence = FENCE_OPEN_RE.exec(lines[i]);
		if (!fence) {
			continue;
		}
		const body: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (FENCE_CLOSE_RE.test(lines[j])) {
				blocks.push({ language: fence[1]?.toLowerCase() ?? '', content: body.join('\n') });
				i = j;
				break;
			}
			body.push(lines[j]);
		}
	}
	return blocks;
}

/** 工作流规划：前置思考与步骤拆解（Trae 式「思考 → 规划 → 执行」中的前两阶段） */
export interface IWorkflowPlan {
	thinking: string;
	steps: string[];
}

/** 去掉整体包裹的代码围栏（模型常把思考/计划也放进 ``` 里） */
function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith('```')) {
		return trimmed;
	}
	const firstNewline = trimmed.indexOf('\n');
	if (firstNewline === -1) {
		return '';
	}
	const body = trimmed.slice(firstNewline + 1);
	return (body.endsWith('```') ? body.slice(0, -3) : body).trim();
}

/**
 * 解析规划回合输出：
 * ### ishell:think 内为分析推理，### ishell:plan 内为步骤清单（- 或 1. 开头）。
 * 两块都缺失时返回空结果，调用方据此退化为直接执行。
 */
export function parseWorkflowPlan(text: string): IWorkflowPlan {
	const thinkMatch = /###\s*ishell:think\s*([\s\S]*?)(?=###\s*ishell:|$)/i.exec(text);
	const planMatch = /###\s*ishell:plan\s*([\s\S]*?)(?=###\s*ishell:|$)/i.exec(text);
	const thinking = stripCodeFence(thinkMatch?.[1] ?? '');
	const steps = (planMatch?.[1] ?? '')
		.split(/\r?\n/)
		.map(line => line.trim())
		.map(line => line.replace(/^[-*]\s*(\[[^\]]*\]\s*)?/, '').replace(/^\d+[.、)]\s*/, '').trim())
		.filter(line => line.length > 0)
		.slice(0, 8);
	return { thinking, steps };
}

/** 可直接落盘的代码块（普通 Markdown 围栏，非 ishell 指令） */
export interface IAutoSaveFile {
	/** 工作区相对路径 */
	path: string;
	language?: string;
	content: string;
}

/** 围栏语言 → 文件扩展名 */
const LANGUAGE_TO_EXT: Record<string, string> = {
	html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
	js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
	ts: 'ts', typescript: 'ts', tsx: 'tsx', py: 'py', python: 'py',
	json: 'json', md: 'md', markdown: 'md',
	yml: 'yml', yaml: 'yml', java: 'java', go: 'go', rust: 'rs', rs: 'rs',
	c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cs: 'cs', sql: 'sql',
	xml: 'xml', svg: 'svg', toml: 'toml', ini: 'ini', vue: 'vue', txt: 'txt',
};

/** 扩展名 → 默认文件名（模型未给出文件名时按语言约定命名） */
const EXT_TO_DEFAULT_NAME: Record<string, string> = {
	html: 'index.html', css: 'style.css', scss: 'style.scss', less: 'style.less',
	js: 'script.js', jsx: 'App.jsx', ts: 'main.ts', tsx: 'App.tsx',
	py: 'main.py', json: 'data.json', md: 'notes.md',
	yml: 'config.yml', java: 'Main.java', go: 'main.go', rs: 'main.rs',
	c: 'main.c', h: 'main.h', cpp: 'main.cpp', cs: 'Program.cs', sql: 'query.sql',
	xml: 'data.xml', svg: 'icon.svg', toml: 'config.toml', ini: 'config.ini', vue: 'App.vue', txt: 'snippet.txt',
};

/** 无语言标记时按内容嗅探可落盘的扩展名（只做高置信判断） */
function sniffExtension(content: string): string | undefined {
	const head = content.trimStart().slice(0, 200).toLowerCase();
	if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
		return 'html';
	}
	if (head.startsWith('<?xml') || head.startsWith('<svg')) {
		return 'xml';
	}
	return undefined;
}

/**
 * 把回答中的普通代码块规划为自动保存文件：
 * - 仅保留可识别语言的代码块（示例片段/日志等无法识别的语言跳过）
 * - 文件名优先取回答正文中提到的文件名（如「保存为 game.html」），否则按语言约定命名
 * - 同名重复自动追加序号，避免块间互相覆盖
 */
export function planAutoSaveFromCodeBlocks(text: string, excludeNames?: ReadonlySet<string>): IAutoSaveFile[] {
	const used = new Set<string>(excludeNames ?? []);
	const mentioned = Array.from(text.matchAll(/[\w\u4e00-\u9fff-]+\.(?:html|htm|css|scss|less|js|mjs|ts|jsx|tsx|py|json|md|ya?ml|java|go|rs|c|h|cpp|cs|sql|xml|svg|toml|ini|vue|txt)\b/gi))
		.map(match => match[0]);
	const files: IAutoSaveFile[] = [];
	for (const block of extractCodeBlocks(text)) {
		if (block.content.trim() === '') {
			continue;
		}
		const ext = LANGUAGE_TO_EXT[block.language] ?? sniffExtension(block.content);
		if (!ext) {
			continue;
		}
		const hinted = mentioned.find(name => name.toLowerCase().endsWith(`.${ext}`) && !used.has(name));
		const suggested = hinted ?? EXT_TO_DEFAULT_NAME[ext] ?? `snippet.${ext}`;
		const dot = suggested.lastIndexOf('.');
		const stem = dot === -1 ? suggested : suggested.slice(0, dot);
		const suffix = dot === -1 ? `.${ext}` : suggested.slice(dot);
		let name = suggested;
		for (let i = 1; used.has(name) && i < 100; i++) {
			name = `${stem}-${i}${suffix}`;
		}
		used.add(name);
		files.push({ path: name, language: block.language || ext, content: block.content });
	}
	return files;
}

/** 生成文件名友好的短标签：仅 [a-z0-9-]，超长截断 */
export function slugify(text: string, maxLength = 48): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, maxLength)
		.replace(/-+$/g, '');
	return slug !== '' ? slug : 'snippet';
}

/** FNV-1a 32 位短哈希（base36，8 位定长；用于会话标识/文件名去重） */
export function shortHash(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(8, '0').slice(-8);
}

/**
 * 清洗模型补全输出为可直接插入的内联补全文本：
 * - 剥掉模型自作主张包上的 Markdown 围栏
 * - 按行数/字符数上限截断
 * - 与当前行已有前缀保持缩进对齐（剥除重复基础缩进）
 * 返回空串表示放弃本次补全。
 */
export function normalizeModelCompletion(raw: string, currentLinePrefix: string, maxLines = 12, maxChars = 400): string {
	let text = raw.replace(/\r\n/g, '\n').trimEnd();
	// 剥围栏：```lang\n...\n``` 或 ```...```
	const fence = /^```[\w+#.-]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fence) {
		text = fence[1];
	}
	text = text.trimEnd();
	if (text.trim() === '') {
		return '';
	}
	let lines = text.split('\n');
	if (lines.length > maxLines) {
		lines = lines.slice(0, maxLines);
	}
	// 缩进对齐：若模型重复了当前行的缩进，剥掉一层
	const indent = currentLinePrefix.match(/^[ \t]*/)?.[0] ?? '';
	if (indent !== '' && lines.length > 0) {
		lines = lines.map(line => line.startsWith(indent) ? line.slice(indent.length) : line);
	}
	text = lines.join('\n').slice(0, maxChars);
	return text.trim() === '' ? '' : text;
}
