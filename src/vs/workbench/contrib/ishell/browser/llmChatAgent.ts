/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ILlmChatMessage, IIshellLlmService } from '../common/llm.js';
import { parseCompletedInstructions, parseInstructions, shortHash } from '../common/llmInstructions.js';
import { LlmInstructionExecutor, ILlmInstructionExecResult } from './llmInstructionsExecute.js';

/** 系统提示词：基础人设 + iShell 指令块协议（指令跟随功能的模型侧约定） */
const AGENT_SYSTEM_PROMPT = [
	'你是 iShell 内置的本地 AI 助手，基于用户本地运行的模型提供帮助。请用简洁的中文回答；涉及代码时使用 Markdown 代码块。',
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
].join('\n');

/**
 * iShell 默认 Chat Agent：本产品不带 Copilot 扩展，内置 Chat 的默认参与者由本类贡献。
 * 对话逻辑：当前运行中的本地模型（llama.cpp）流式回答；模型未运行时给出引导提示。
 * 模型选择器中的"iShell 本地模型"即当前运行模型（见 llmChatModels.ts 的 provider 注册）。
 * 工程能力：
 * - Skill 注入：按用户消息命中触发词的 Skill 追加到 system 提示
 * - 指令跟随：回答中的 ### ishell:* 指令块自动解析执行（写文件 / 三方合并 / 终端确认按钮）
 * - 会话标识：同一会话的产物持久化到同一 sessionId 目录
 */
export class LlmChatAgent extends Disposable implements IChatAgentImplementation {

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const engine = await this.llmService.getEngineInfo();
		if (engine.state !== 'running') {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('ishell.llm.agentNotRunning',
					"本地模型未运行。请打开左侧**本地模型**视图，下载并启动一个模型后再对话。")),
			}]);
			return {};
		}

		// 组装对话历史：system（含指令协议 + 命中的 Skill）+ 历史轮次 + 当前提问
		const messages: ILlmChatMessage[] = [{ role: 'system', content: await this.buildSystemPrompt(request.message) }];
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

		// 会话标识：同一会话（sessionResource）的产物归档到同一目录
		const sessionId = shortHash(request.sessionResource.toString());
		const requestId = await this.llmService.sendChat(messages, sessionId);

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
				await this.followInstructions(acc, request, progress, executedSeqs);
			} catch (err) {
				this.logService.warn(`[ishell-llm] 指令跟随执行失败: ${(err as Error)?.message ?? err}`);
			}
			return {};
		} finally {
			listener.dispose();
			cancellation.dispose();
		}
	}

	/** system 提示组装：基础协议 + 按用户消息命中触发词的启用 Skill */
	private async buildSystemPrompt(userMessage: string): Promise<string> {
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
		return prompt;
	}

	/** 指令跟随（终态兜底）：执行流式期间未处理的指令（未闭合容错块/渐进执行关闭时为全量），已执行的跳过 */
	private async followInstructions(full: string, request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, executedSeqs: Set<number>): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.enabled') ?? true;
		if (!enabled) {
			return;
		}
		const instructions = parseInstructions(full).filter(i => !executedSeqs.has(i.seq));
		if (instructions.length === 0) {
			return; // 流式期间已全部执行：逐条反馈已即时给出，无需重复汇总
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

	constructor(
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
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
