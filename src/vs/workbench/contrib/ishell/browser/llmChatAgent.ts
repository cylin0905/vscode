/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ILlmChatMessage, IIshellLlmService, inferLanguageFromPath } from '../common/llm.js';
import { ILlmWriteFileInstruction, IWorkflowPlan, parseCompletedInstructions, parseInstructions, parseWorkflowPlan, shortHash } from '../common/llmInstructions.js';
import { LlmInstructionExecutor, ILlmInstructionExecResult, resolveWorkspacePath } from './llmInstructionsExecute.js';

/** 系统提示词：基础人设 + iShell 指令块协议（指令跟随功能的模型侧约定） */
const AGENT_SYSTEM_PROMPT = [
	'你是 iShell 内置的本地 AI 助手，基于用户本地运行的模型提供帮助。请用简洁的中文回答；涉及代码时使用 Markdown 代码块。',
	'',
	'重要输出约束：不要重复输出相同结构的代码。当需要大量相似元素时，改用循环或函数生成，不要逐个罗列。完整回答控制在必要长度内。',
	'',
	'当且仅当用户明确要求创建文件、修改文件或在终端执行命令时，在回答中使用 iShell 指令块协议输出（可多条、按出现顺序执行，路径使用工作区相对路径）：',
	'',
	'### ishell:write <工作区相对路径>',
	'```',
	'完整文件内容',
	'```',
	'',
	'### ishell:edit <工作区相对路径>',
	'```',
	'find:',
	'要替换的原文片段（应在文件中唯一）',
	'replace:',
	'替换后的内容',
	'```',
	'',
	'### ishell:terminal',
	'```',
	'建议执行的命令（仅当用户点击确认按钮后才会插入终端，不会自动执行）',
	'```',
	'',
	'如果只是给出代码而不写指令块，请在每个代码块前一行注明文件名（例如 game.html），系统会自动保存到当前目录。',
	'',
	'【必须遵守】当用户要求修复、优化、调整、增加或删掉功能（即要改动文件本身）时：',
	'- 禁止只给建议、分析或步骤说明，必须直接给出改动后的代码。',
	'- 首选 ### ishell:write <文件路径> 输出修改后的完整文件（小模型最不容易出错的方式）。',
	'- 只改局部时用 ### ishell:edit <文件路径> 的 find/replace，其余内容逐字保持。',
	'- 不要写「可以考虑…」「建议…」，不要在结尾省略「其余保持不变」之类的占位。',
].join('\n');

/** 阶段一/二（思考与规划）的系统提示：只分析与拆解，不产出代码 */
const PLANNER_SYSTEM_PROMPT = [
	'你是代码助手的前置分析器：先分析需求，再拆解执行计划。',
	'严格按如下格式输出，不要输出其它内容：',
	'### ishell:think',
	'（2-5 句话：用户想要什么、涉及哪些文件、关键改动点、可能的风险）',
	'### ishell:plan',
	'- 具体步骤 1',
	'- 具体步骤 2',
	'',
	'只做分析与规划：不要写代码，不要输出 ### ishell:write / ### ishell:edit / ### ishell:terminal 指令。',
].join('\n');

/**
 * iShell 默认 Chat Agent：本产品不带 Copilot 扩展，内置 Chat 的默认参与者由本类贡献。
 * 对话逻辑：本地模型（llama.cpp）流式回答；模型未运行时自动拉起最近下载的模型，
 * 无法拉起时给出引导提示（与模型选择器的自动启动行为一致，见 llmChatModels.ts）。
 * 工程能力：
 * - Skill 注入：按用户消息命中触发词的 Skill 追加到 system 提示
 * - 指令跟随：回答中的 ### ishell:* 指令块自动解析执行（写文件 / 三方合并 / 终端确认按钮）
 * - 会话标识：同一会话的产物持久化到同一 sessionId 目录
 */
export class LlmChatAgent extends Disposable implements IChatAgentImplementation {

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		// 模型未运行时自动拉起（与 Chat 模型选择器的自动启动行为一致）
		if (!await this.ensureEngineReady(progress, token)) {
			return {};
		}

		// 会话标识：同一会话（sessionResource）的产物归档到同一目录，也是文件上下文的作用域
		const sessionId = shortHash(request.sessionResource.toString());

		// 组装对话历史：system（含指令协议 + 命中的 Skill + 相关文件内容）+ 历史轮次 + 当前提问
		const contextFiles = await this.collectRelevantFiles(request, sessionId);
		// 阶段一/二：内部思考 + 任务规划（Trae 式前置阶段，失败自动退化为直接执行）
		const plan = await this.runPlanningPhase(request, contextFiles, sessionId, progress, token);
		const messages: ILlmChatMessage[] = [{ role: 'system', content: await this.buildSystemPrompt(request.message, contextFiles, plan) }];
		for (const entry of history) {
			messages.push({ role: 'user', content: entry.request.message });
			const text = entry.response
				.filter((r): r is Extract<typeof r, { kind: 'markdownContent' }> => r.kind === 'markdownContent')
				.map(r => r.content.value)
				.join('');
			if (text) {
				messages.push({ role: 'assistant', content: text });
			}
		}
		messages.push({ role: 'user', content: request.message });

		const requestId = await this.llmService.sendChat(messages, sessionId);
		// 阶段三：执行（状态行原地更新，不产生堆叠）
		this.renderProgress(progress, 'ishell-exec', plan?.steps.length ? '按计划执行中…' : '正在处理…', true);

		// 流式桥接：onDidChatChunk -> markdownContent 增量（chat model 会自动合并同 kind part）
		let acc = '';
		let lastSent = 0;
		let done = false;
		let errorMessage: string | undefined;
		const waiters: (() => void)[] = [];

		// 渐进式编辑状态（边思考边编辑：围栏闭合的指令立即执行，不等全流结束）
		const instructionsEnabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.enabled') ?? true;
		const streamingEnabled = instructionsEnabled && (this.configurationService.getValue<boolean>('ishell.llm.instructions.streaming') ?? true);
		const executor = this.instantiationService.createInstance(LlmInstructionExecutor, request.workingDirectory);
		const executedSeqs = new Set<number>();
		const execResults: ILlmInstructionExecResult[] = [];

		const listener = this.llmService.onDidChatChunk(chunk => {
			if (chunk.requestId !== requestId) {
				return;
			}
			if (chunk.delta) {
				acc += chunk.delta;
			}
			if (chunk.done) {
				done = true;
				errorMessage = chunk.error;
			}
			waiters.splice(0).forEach(wake => wake());
		});
		const cancellation = token.onCancellationRequested(() => {
			this.llmService.cancelChat(requestId).catch(() => { });
			done = true;
			waiters.splice(0).forEach(wake => wake());
		});

		const sendDelta = () => {
			if (acc.length > lastSent) {
				const delta = acc.slice(lastSent);
				lastSent = acc.length;
				progress([{ kind: 'markdownContent', content: new MarkdownString(delta) }]);
			}
		};

		/** 渐进式执行：新增的已闭合指令立即执行并即时反馈（版本快照 / 脏检测 / 合并照常生效） */
		const streamStep = async (): Promise<void> => {
			if (!streamingEnabled || acc.indexOf('### ishell:') === -1) {
				return; // 快速路径：无指令标题时不做解析
			}
			const fresh = parseCompletedInstructions(acc).filter(i => !executedSeqs.has(i.seq));
			for (const instruction of fresh) {
				executedSeqs.add(instruction.seq);
				const [result] = await executor.run([instruction]);
				if (!result) {
					continue;
				}
				execResults.push(result);
				const where = result.filePath ? ` \`${result.filePath}\`` : result.command ? ` \`${result.command}\`` : '';
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n\n> **iShell**：${result.message}${where}`),
				}]);
				this.renderResultButtons(result, progress);
			}
		};

		try {
			while (!done) {
				await new Promise<void>(resolve => waiters.push(resolve));
				sendDelta();
				await streamStep(); // 逐 chunk 推进：闭合指令即落盘（打断时已完成部分自动保留）
			}
			sendDelta();
			if (errorMessage) {
				return { errorDetails: { message: errorMessage } };
			}
			// 指令跟随：流结束后处理剩余指令（流式期间未执行/未闭合容错块），失败不影响已完成的回答
			try {
				execResults.push(...await this.followInstructions(acc, request, progress, executedSeqs));
			} catch (err) {
				this.logService.warn(`[ishell-llm] 指令跟随执行失败: ${(err as Error)?.message ?? err}`);
			}
			// 自动审查排错：写入不等于结束，error 级诊断自动交回模型修复并复检（进展即时回报）
			try {
				await executor.autoReviewAndFix(execResults, message => {
					progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n> **iShell**：${message}`) }]);
				});
			} catch (err) {
				this.logService.warn(`[ishell-llm] 自动审查排错失败: ${(err as Error)?.message ?? err}`);
			}
			// 代码块自动保存：模型没按指令协议写文件时，把回答里的代码直接落盘到当前目录（无需用户手动保存）
			const autoSaved = await this.autoSaveCodeBlocks(acc, request, execResults, progress);
			execResults.push(...autoSaved);
			// 兜底：用户明确要改文件、但模型只给了建议（既没指令也没代码块）→ 自动要求模型重写并落盘
			const forced = await this.forceRewriteIfNoChange(request, contextFiles, execResults, progress);
			execResults.push(...forced);
			// 记录本轮落盘的文件，供后续追问时带上下文（"继续优化"不再盲问）
			this.rememberTouchedFiles(sessionId, execResults);
			// 阶段收尾：把执行状态行更新为结果摘要（全程无保存确认弹窗，改动已直接落盘）
			const changed = Array.from(new Set(execResults
				.filter(r => (r.kind === 'write-file' || r.kind === 'edit-file') && r.outcome !== 'failed' && r.filePath)
				.map(r => r.filePath)));
			const remaining = execResults.filter(r => r.outcome === 'failed' || r.outcome === 'conflict').length;
			this.renderProgress(progress, 'ishell-exec',
				changed.length > 0
					? `执行完成：已自动保存 ${changed.length} 个文件（${changed.slice(0, 3).join('、')}${changed.length > 3 ? ' 等' : ''}）${remaining > 0 ? `，${remaining} 项需处理` : ''}`
					: '本轮未产生文件改动',
				false);
			return {};
		} finally {
			listener.dispose();
			cancellation.dispose();
		}
	}

	/** 代码块自动保存：仅在本轮没有任何 write/edit 指令落盘时触发，避免与指令协议重复写同一份内容 */
	private async autoSaveCodeBlocks(full: string, request: IChatAgentRequest, execResults: ILlmInstructionExecResult[], progress: (parts: IChatProgress[]) => void): Promise<ILlmInstructionExecResult[]> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.autoSaveCodeBlocks') ?? true;
		if (!enabled) {
			return [];
		}
		if (execResults.some(r => (r.kind === 'write-file' || r.kind === 'edit-file') && r.outcome !== 'failed')) {
			return []; // 已按指令协议落盘
		}
		try {
			const executor = this.instantiationService.createInstance(LlmInstructionExecutor, request.workingDirectory);
			// 本会话改过的文件 + 消息中点名的文件：本轮代码块视为「迭代更新原文件」，不另建新文件
			const overwritePaths = new Set<string>(this.touchedFiles.get(sessionId) ?? []);
			for (const name of this.extractMentionedPaths(request.message)) {
				overwritePaths.add(name);
			}
			const saved = (await executor.autoSaveCodeBlocks(full, overwritePaths)).filter(r => r.outcome !== 'failed');
			if (saved.length === 0) {
				return [];
			}
			const lines = saved.map(r => `- \`${r.filePath}\`：${r.message}`);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n**${localize('ishell.llm.instructions.autoSaveTitle', 'iShell 自动保存')}**\n${lines.join('\n')}`) }]);
			return saved;
		} catch (err) {
			this.logService.warn(`[ishell-llm] 代码块自动保存失败: ${(err as Error)?.message ?? err}`);
			return [];
		}
	}

	// ==== 只给建议不给改动的兜底：强制重写并落盘 ====

	private isModifyIntent(message: string): boolean {
		return /(修改|优化|修复|修好|改成|改为|换成|加上|增加|添加|删掉|删除|去掉|调整|重构|不能|无法|报错|错误|打不开|没反应|不工作|不动|卡住|闪退|bug|fix|modify|update|improve)/i.test(message);
	}

	/**
	 * 用户明确要求改动文件，但模型只回了建议（既无指令块也无代码块）时：
	 * 直接把「文件现状 + 用户要求」交给模型重写，并落盘覆盖原文件（旧版本留档可回溯）。
	 */
	private async forceRewriteIfNoChange(
		request: IChatAgentRequest,
		contextFiles: { displayPath: string; content: string }[],
		execResults: ILlmInstructionExecResult[],
		progress: (parts: IChatProgress[]) => void,
	): Promise<ILlmInstructionExecResult[]> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.autoRewriteOnAdviceOnly') ?? true;
		if (!enabled || contextFiles.length === 0 || !this.isModifyIntent(request.message)) {
			return [];
		}
		if (execResults.some(r => (r.kind === 'write-file' || r.kind === 'edit-file') && r.outcome !== 'failed')) {
			return []; // 已有改动落地，无需兜底
		}
		const primary = contextFiles[0];
		try {
			progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n> **iShell**：模型只给出了建议，正在按你的要求直接重写 \`${primary.displayPath}\`…`) }]);
			const rewritten = await this.llmService.applyModelFix({
				content: primary.content,
				language: inferLanguageFromPath(primary.displayPath),
				problems: [request.message],
				instruction: `直接按用户要求修改代码并输出完整文件内容，不要解释、不要建议：${request.message}`,
			});
			if (!rewritten || rewritten.trim() === '') {
				return [];
			}
			const executor = this.instantiationService.createInstance(LlmInstructionExecutor, request.workingDirectory);
			const instruction: ILlmWriteFileInstruction = { seq: 1, kind: 'write-file', path: primary.displayPath, content: rewritten, closed: true };
			const succeeded = (await executor.run([instruction])).filter(r => r.outcome !== 'failed');
			if (succeeded.length > 0) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n**iShell 已自动改好**：\`${primary.displayPath}\`（旧版本已存档，可随时回溯）`) }]);
			}
			return succeeded;
		} catch (err) {
			this.logService.warn(`[ishell-llm] 强制重写失败: ${(err as Error)?.message ?? err}`);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n> **iShell**：自动修改失败（${(err as Error)?.message ?? err}），请再说明具体要改哪里。`) }]);
			return [];
		}
	}

	// ==== 追问上下文：记住本会话动过的文件，追问时读磁盘现状给模型 ====

	private readonly touchedFiles = new Map<string, Set<string>>();

	/** 从用户消息中提取显式提到的文件路径（如 game.html、src/app.ts） */
	private extractMentionedPaths(message: string): string[] {
		return Array.from(message.matchAll(/(?:\.[/\w-]*\/)?[\w一-龥.-]+\.(?:html|htm|css|scss|less|js|mjs|cjs|ts|jsx|tsx|py|json|md|ya?ml|java|go|rs|c|cpp|cs|sql|xml|svg|toml|ini|vue|txt)\b/gi))
			.map(match => match[0]);
	}

	private rememberTouchedFiles(sessionId: string, results: ILlmInstructionExecResult[]): void {
		const set = this.touchedFiles.get(sessionId) ?? new Set<string>();
		for (const result of results) {
			if (result.filePath && (result.kind === 'write-file' || result.kind === 'edit-file') && result.outcome !== 'failed' && result.outcome !== 'conflict') {
				set.add(result.filePath);
			}
		}
		if (set.size > 0) {
			this.touchedFiles.set(sessionId, set);
		}
	}

	/** 收集本轮需要带给模型的文件：消息中显式提到的路径 → 本会话改过的文件 → 当前活动编辑器文件 */
	private async collectRelevantFiles(request: IChatAgentRequest, sessionId: string): Promise<{ displayPath: string; content: string }[]> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.context.files') ?? true;
		if (!enabled) {
			return [];
		}
		const maxFiles = Math.max(0, Math.min(10, this.configurationService.getValue<number>('ishell.llm.context.maxFiles') ?? 3));
		const maxCharsPerFile = Math.max(500, Math.min(20000, this.configurationService.getValue<number>('ishell.llm.context.maxFileChars') ?? 4000));
		if (maxFiles === 0) {
			return [];
		}
		// 总预算按运行模型实际上下文窗口估算（模型参数优先），避免文件内容挤爆上下文
		let contextSize = this.configurationService.getValue<number>('ishell.llm.contextSize') ?? 4096;
		const engine = await this.llmService.getEngineInfo();
		if (engine.runningModelId) {
			const running = (await this.llmService.getModels()).find(m => m.id === engine.runningModelId);
			contextSize = running?.params?.contextSize ?? contextSize;
		}
		const totalBudgetChars = Math.max(2000, Math.floor(contextSize * 2));
		const base = request.workingDirectory;
		const candidates: { displayPath: string; uri: URI }[] = [];

		// 1) 用户消息中显式提到的文件名/相对路径（优先级最高）
		const mentioned = this.extractMentionedPaths(request.message);
		for (const name of mentioned) {
			const uri = resolveWorkspacePath(base, name);
			if (uri) {
				candidates.push({ displayPath: name, uri });
			}
		}

		// 2) 本会话中写入/编辑过的文件（最近的优先）
		for (const path of Array.from(this.touchedFiles.get(sessionId) ?? []).reverse()) {
			const uri = resolveWorkspacePath(base, path);
			if (uri) {
				candidates.push({ displayPath: path, uri });
			}
		}

		// 3) 当前活动编辑器文件（用户正在看的代码通常就是追问对象）
		const active = this.editorService.activeEditor?.resource;
		if (active && base && isEqualOrParent(active, base) && active.scheme === Schemas.file) {
			const marker = active.path.slice(base.path.length + 1);
			candidates.push({ displayPath: marker || active.path, uri: active });
		}

		const files: { displayPath: string; content: string }[] = [];
		const seen = new Set<string>();
		let usedChars = 0;
		for (const candidate of candidates) {
			if (files.length >= maxFiles || usedChars >= totalBudgetChars) {
				break;
			}
			const key = candidate.uri.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			try {
				const data = await this.fileService.readFile(candidate.uri, { acceptTextOnly: true });
				const text = data.value.toString();
				if (text.trim() === '') {
					continue;
				}
				const allowed = Math.min(maxCharsPerFile, totalBudgetChars - usedChars);
				if (allowed < 500) {
					break; // 预算不足：宁可少带文件，也不挤掉用户问题
				}
				const totalLines = text.split('\n').length;
				const content = text.length > allowed
					? `${text.slice(0, allowed)}\n…（已截断，全文共 ${totalLines} 行）`
					: text;
				usedChars += content.length;
				files.push({ displayPath: candidate.displayPath, content });
			} catch {
				// 文件不存在/二进制/无权读取：跳过
			}
		}
		return files;
	}

	// ==== 阶段一/二：内部思考 + 任务规划（Trae 式分步工作流的前置环节） ====

	private renderProgress(progress: (parts: IChatProgress[]) => void, id: string, text: string, shimmer: boolean): void {
		progress([{ kind: 'progressMessage', id, shimmer, content: new MarkdownString(text) }]);
	}

	/** 思考流式渲染：同一 id 原地更新，避免逐帧堆叠状态行 */
	private renderThinking(raw: string, progress: (parts: IChatProgress[]) => void, streaming: boolean): void {
		const think = /###\s*ishell:think\s*([\s\S]*?)(?=###\s*ishell:|$)/i.exec(raw)?.[1] ?? raw;
		const text = think.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim();
		if (!text) {
			return;
		}
		progress([{ kind: 'progressMessage', id: 'ishell-thinking', shimmer: streaming, content: new MarkdownString(`**${streaming ? '思考中' : '思考'}**\n\n${text}`) }]);
	}

	/**
	 * 规划回合：先让模型只做分析与拆解（思考 + 计划），结果用于补齐执行回合的 system 提示，
	 * 并把计划作为可视化步骤展示在 Chat 里。失败（无输出/取消）时返回 undefined，链路退化为直接回答。
	 */
	private async runPlanningPhase(request: IChatAgentRequest, contextFiles: { displayPath: string; content: string }[], sessionId: string, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<IWorkflowPlan | undefined> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.workflow.stagedPlan') ?? true;
		if (!enabled || token.isCancellationRequested) {
			return undefined;
		}
		const showThinking = this.configurationService.getValue<boolean>('ishell.llm.workflow.showThinking') ?? true;
		const fileText = contextFiles.length > 0
			? '\n\n' + ['相关文件当前内容：', ...contextFiles.map(file => `\n=== 文件：${file.displayPath} ===\n${file.content}\n=== 文件结束 ===`)].join('\n')
			: '';
		const messages: ILlmChatMessage[] = [
			{ role: 'system', content: PLANNER_SYSTEM_PROMPT + fileText },
			{ role: 'user', content: request.message },
		];

		const planRequestId = await this.llmService.sendChat(messages, `${sessionId}-plan`);
		let raw = '';
		let done = false;
		let failure: string | undefined;
		const waiters: (() => void)[] = [];
		const listener = this.llmService.onDidChatChunk(chunk => {
			if (chunk.requestId !== planRequestId) {
				return;
			}
			if (chunk.delta) {
				raw += chunk.delta;
			}
			if (chunk.done) {
				done = true;
				failure = chunk.error;
			}
			waiters.splice(0).forEach(wake => wake());
		});
		const cancellation = token.onCancellationRequested(() => {
			this.llmService.cancelChat(planRequestId).catch(() => { });
			done = true;
			waiters.splice(0).forEach(wake => wake());
		});
		try {
			let lastShown = 0;
			while (!done) {
				await new Promise<void>(resolve => waiters.push(resolve));
				if (showThinking && raw.length - lastShown >= 80) {
					lastShown = raw.length;
					this.renderThinking(raw, progress, true);
				}
			}
		} finally {
			listener.dispose();
			cancellation.dispose();
		}
		if (failure || !raw.trim()) {
			this.logService.warn(`[ishell-llm] 规划阶段跳过：${failure ?? '模型无输出'}`);
			return undefined;
		}
		const plan = parseWorkflowPlan(raw);
		if (showThinking) {
			this.renderThinking(raw, progress, false);
		}
		if (plan.steps.length > 0) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n**执行计划**\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`) }]);
		}
		if (!plan.thinking && plan.steps.length === 0) {
			return undefined;
		}
		return plan;
	}

	/** system 提示组装：基础协议 + 按用户消息命中触发词的启用 Skill + 相关文件内容 + 本轮计划 */
	private async buildSystemPrompt(userMessage: string, files: { displayPath: string; content: string }[], plan?: IWorkflowPlan): Promise<string> {
		let prompt = AGENT_SYSTEM_PROMPT;
		try {
			const skills = (await this.llmService.getSkills()).filter(s => s.enabled);
			const message = userMessage.toLowerCase();
			const hits = skills.filter(s => s.triggers.some(t => message.includes(t.toLowerCase())));
			if (hits.length > 0) {
				prompt += '\n\n' + hits.map(s => `[Skill: ${s.name}]\n${s.instruction}`).join('\n\n');
			}
		} catch {
			// Skill 拉取失败不影响正常对话
		}
		// 追问上下文：把相关文件的当前内容一并给模型，支持「继续优化/再改一下」这类多轮迭代
		if (files.length > 0) {
			prompt += '\n\n' + [
				'以下是本轮相关的文件当前内容（磁盘最新状态）。',
				'本轮请直接修改文件而不是给建议：需要改已有文件时用 ### ishell:write <文件路径> 输出修改后的完整文件（首选），其余文件内容保持不变。',
				...files.map(file => `\n=== 文件：${file.displayPath} ===\n${file.content}\n=== 文件结束：${file.displayPath} ===`),
			].join('\n');
		}
		// 阶段一/二产出：把分析与计划带回执行回合，保证「思考 → 规划 → 执行」链路连贯
		if (plan) {
			if (plan.thinking) {
				prompt += `\n\n【本轮分析】\n${plan.thinking}`;
			}
			if (plan.steps.length > 0) {
				prompt += `\n\n【本轮执行计划】\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n请严格按该计划逐项执行，直接输出代码改动，不要再次解释计划。`;
			}
		}
		return prompt;
	}

	/** 指令跟随（终态兜底）：执行流式期间未处理的指令（未闭合容错块/渐进执行关闭时为全量），已执行的跳过；返回本轮全部执行结果 */
	private async followInstructions(full: string, request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, executedSeqs: Set<number>): Promise<ILlmInstructionExecResult[]> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.enabled') ?? true;
		if (!enabled) {
			return [];
		}
		const instructions = parseInstructions(full).filter(i => !executedSeqs.has(i.seq));
		if (instructions.length === 0) {
			return []; // 流式期间已全部执行：逐条反馈已即时给出，无需重复汇总
		}
		const executor = this.instantiationService.createInstance(LlmInstructionExecutor, request.workingDirectory);
		const results = await executor.run(instructions);

		const lines: string[] = [
			`**${localize('ishell.llm.instructions.summaryTitle', 'iShell 指令跟随')}**：${localize('ishell.llm.instructions.summaryCount', '已解析并执行 {0} 条指令', String(results.length))}`,
		];
		const buttons: IChatProgress[] = [];
		for (const result of results) {
			const where = result.filePath ? `\`${result.filePath}\`` : result.command ? `\`${result.command}\`` : '';
			const diag = result.diagnostics
				? `（${localize('ishell.llm.instructions.diagSummary', '诊断：{0} 错误 / {1} 警告，评分 {2}', String(result.diagnostics.errors), String(result.diagnostics.warnings), String(result.diagnostics.score))}）`
				: '';
			lines.push(`- ${where ? `${where}：` : ''}${result.message}${diag}`);
			this.renderResultButtons(result, parts => { buttons.push(...parts); });
		}
		progress([{ kind: 'markdownContent', content: new MarkdownString('\n\n' + lines.join('\n')) }]);
		if (buttons.length > 0) {
			progress(buttons);
		}
		return results;
	}

	/** 执行结果 → 交互按钮（终端命令确认 / 冲突强制覆盖） */
	private renderResultButtons(result: ILlmInstructionExecResult, progress: (parts: IChatProgress[]) => void): void {
		if (result.kind === 'terminal' && result.command) {
			progress([{
				kind: 'command',
				command: {
					id: 'ishell.llm.insertTerminalCommand',
					title: localize('ishell.llm.instructions.insertButton', '插入终端命令'),
					tooltip: result.command,
					arguments: [result.command],
				},
			}]);
		} else if (result.outcome === 'conflict' && result.forceArgs) {
			progress([{
				kind: 'command',
				command: {
					id: 'ishell.llm.instructions.forceApply',
					title: localize('ishell.llm.instructions.forceButton', '强制写入（覆盖本地修改）'),
					tooltip: result.message,
					arguments: [result.forceArgs[0], result.forceArgs[1]],
				},
			}]);
		}
	}

	/** 引擎/模型未就绪时自动拉起最近下载的模型；无法自动拉起时给出引导提示并返回 false */
	private async ensureEngineReady(progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<boolean> {
		let engine = await this.llmService.getEngineInfo();
		// 已有模型在启动中（如 UI 手动启动）：原地刷新进度提示并等待就绪（上限与引擎健康检查一致 5 分钟）
		let notifiedStarting = false;
		const waitStart = Date.now();
		while (engine.state === 'starting' && !token.isCancellationRequested && Date.now() - waitStart < 300_000) {
			notifiedStarting = true;
			progress([{ kind: 'progressMessage', id: 'ishell-model-starting', shimmer: true, content: new MarkdownString(localize('ishell.llm.agentStarting', '本地模型正在启动，请稍候…')) }]);
			await new Promise<void>(resolve => setTimeout(resolve, 500));
			engine = await this.llmService.getEngineInfo();
		}
		if (engine.state === 'running') {
			if (notifiedStarting) {
				progress([{ kind: 'progressMessage', id: 'ishell-model-starting', content: new MarkdownString(localize('ishell.llm.agentStarted', '模型已就绪。')) }]);
			}
			return true;
		}
		const models = await this.llmService.getModels();
		if (models.length === 0) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('ishell.llm.agentNoModel', "本地还没有已下载的模型。请打开左侧**本地模型**视图，下载一个模型后再对话。")) }]);
			return false;
		}
		if (engine.state === 'missing' || engine.state === 'downloading') {
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('ishell.llm.agentNoEngine', "本地推理引擎未就绪。请打开左侧**本地模型**视图，下载 llama-server 引擎后再对话。")) }]);
			return false;
		}
		// 引擎就绪但模型未运行：自动启动最近下载的模型
		const target = models.slice().sort((a, b) => b.downloadedAt - a.downloadedAt)[0];
		progress([{ kind: 'progressMessage', id: 'ishell-model-starting', shimmer: true, content: new MarkdownString(localize('ishell.llm.agentAutoStarting', "本地模型未运行，正在自动启动 **{0}**…", target.name)) }]);
		try {
			await this.llmService.startModel(target.id);
		} catch (err) {
			if (token.isCancellationRequested) {
				return false;
			}
			progress([{ kind: 'progressMessage', id: 'ishell-model-starting', content: new MarkdownString(localize('ishell.llm.agentAutoStartFailed', "自动启动模型失败：{0}", (err as Error).message)) }]);
			return false;
		}
		progress([{ kind: 'progressMessage', id: 'ishell-model-starting', content: new MarkdownString(localize('ishell.llm.agentStarted', '模型已就绪。')) }]);
		return true;
	}

	constructor(
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}
}

/** Chat 视图各模式的默认 agent 注册（Ask / Edit / Agent） */
export class LlmChatAgentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.ishellLlmChatAgent';

	private static readonly MODE_AGENTS: [id: string, name: string, mode: ChatModeKind][] = [
		['ishell.chat', 'ishell', ChatModeKind.Ask],
		['ishell.edit', 'ishell', ChatModeKind.Edit],
		['ishell.agent', 'ishell', ChatModeKind.Agent],
	];

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatAgentService chatAgentService: IChatAgentService,
	) {
		super();

		const agent = this._register(instantiationService.createInstance(LlmChatAgent));
		for (const [id, name, mode] of LlmChatAgentContribution.MODE_AGENTS) {
			this._register(chatAgentService.registerAgent(id, {
				id,
				name,
				isDefault: true,
				isCore: true,
				modes: [mode],
				slashCommands: [],
				disambiguation: [],
				locations: [ChatAgentLocation.Chat],
				description: localize('ishell.llm.agentDescription', "使用本地运行的模型对话"),
				metadata: {},
				extensionId: nullExtensionDescription.identifier,
				extensionVersion: undefined,
				extensionDisplayName: nullExtensionDescription.name,
				extensionPublisherId: nullExtensionDescription.publisher,
			}));
			this._register(chatAgentService.registerAgentImplementation(id, agent));
		}
	}
}
