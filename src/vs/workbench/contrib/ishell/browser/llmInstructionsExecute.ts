/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IIshellLlmService, inferLanguageFromPath } from '../common/llm.js';
import { ILlmInstruction, ILlmWriteFileInstruction, ILlmEditFileInstruction, LlmInstructionKind, planAutoSaveFromCodeBlocks } from '../common/llmInstructions.js';
import { merge3Way } from '../common/llmMerge.js';
import { applyDiagnosticsToMarkers } from './llmDiagnostics.js';
import { SshTerminalEditorInput } from './sshTerminalEditorInput.js';

// #########################################################################
// ##     iShell 指令跟随执行器（渲染层）                                   ##
// ##  - write-file：自动写入工作区（自动保存），改写前落版本快照            ##
// ##  - edit-file ：锚点替换；锚点缺失时基于历史基准做三方合并              ##
// ##  - 冲突检测：编辑器脏缓冲 / 三方合并失败 → 不覆盖，交用户裁决           ##
// ##  - 写入后自动触发静态诊断（Markers + 报告归档）                        ##
// ##  - terminal：仅渲染确认按钮，绝不自动执行（安全红线）                  ##
// #########################################################################

export type LlmInstructionOutcome = 'created' | 'updated' | 'merged' | 'auto-fixed' | 'conflict' | 'failed' | 'pending-confirm';

export interface ILlmInstructionExecResult {
	seq: number;
	kind: LlmInstructionKind;
	outcome: LlmInstructionOutcome;
	message: string;
	/** 工作区相对路径（用于展示） */
	filePath?: string;
	/** terminal 指令的命令文本 */
	command?: string;
	/** 冲突时的用户裁决按钮参数：[相对路径, 覆盖内容] */
	forceArgs?: [string, string];
	/** 写入后的诊断摘要 */
	diagnostics?: { errors: number; warnings: number; infos: number; score: number };
	/** 自动审查排错实际执行的修复轮数（>0 表示触发过「诊断 → 模型修复 → 复检」循环） */
	autoFixRounds?: number;
}

/** 工作区基准目录（供指令解析与命令使用） */
export function getWorkspaceBase(accessor: ServicesAccessor): URI | undefined {
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	return workspaceContextService.getWorkspace().folders[0]?.uri;
}

/** 相对路径解析（工作区基准；绝对路径原样） */
export function resolveWorkspacePath(base: URI | undefined, path: string): URI | undefined {
	const trimmed = path.trim();
	if (trimmed === '') {
		return undefined;
	}
	if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('file://')) {
		return URI.file(trimmed.replace(/^file:\/\//, ''));
	}
	if (!base) {
		return undefined;
	}
	return joinPath(base, trimmed.replace(/\\/g, '/').replace(/^\.\//, ''));
}

export class LlmInstructionExecutor {

	private readonly base: URI | undefined;

	constructor(
		base: URI | undefined,
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		this.base = base ?? workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	/** 按序执行指令序列（上下文关联：后续指令可基于前面写入的文件做诊断/合并） */
	async run(instructions: ILlmInstruction[]): Promise<ILlmInstructionExecResult[]> {
		const results: ILlmInstructionExecResult[] = [];
		for (const instruction of instructions) {
			switch (instruction.kind) {
				case 'write-file':
					results.push(await this.applyWriteFile(instruction));
					break;
				case 'edit-file':
					results.push(await this.applyEditFile(instruction));
					break;
				case 'terminal':
					results.push({
						seq: instruction.seq,
						kind: 'terminal',
						outcome: 'pending-confirm',
						command: instruction.command,
						message: localize('ishell.llm.instructions.terminalPending', '终端命令已生成，等待用户确认插入（不会自动执行）'),
					});
					break;
			}
		}
		return results;
	}

	// ==== 自动审查排错：写入不等于结束，error 级诊断自动交回模型修复 ====

	/**
	 * 对本轮写入且存在 error 级诊断的文件执行「重新诊断 → 模型修复 → 复检」循环：
	 * 每轮把 error 明细（行号 + 消息 + 建议）交回本地模型重写，写盘前落版本快照，
	 * 复检通过或达轮数上限为止；进展经 onProgress 即时回报到 Chat。
	 */
	async autoReviewAndFix(results: ILlmInstructionExecResult[], onProgress?: (message: string) => void): Promise<ILlmInstructionExecResult[]> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.autoFix') ?? true;
		if (!enabled) {
			return results;
		}
		const maxRounds = Math.max(0, Math.min(5, this.configurationService.getValue<number>('ishell.llm.instructions.autoFixMaxRounds') ?? 2));
		const seen = new Set<string>();
		for (const result of results) {
			if (!result.filePath || !result.diagnostics || result.diagnostics.errors <= 0) {
				continue; // 仅审查写入类产出；无 error 不触发修复
			}
			if (result.outcome === 'failed' || result.outcome === 'conflict' || result.outcome === 'pending-confirm') {
				continue;
			}
			const target = resolveWorkspacePath(this.base, result.filePath);
			if (!target || seen.has(target.toString())) {
				continue; // 同一文件多条指令只按最终状态审查一轮
			}
			seen.add(target.toString());
			try {
				let content = await this.readCurrent(target);
				if (content === undefined) {
					continue;
				}
				const language = inferLanguageFromPath(target.path);
				let report = await this.llmService.analyzeCode(content, language, target.fsPath);
				let rounds = 0;
				while (report.summary.errors > 0 && rounds < maxRounds) {
					rounds++;
					const problems = report.diagnostics
						.filter(d => d.severity === 'error')
						.map(d => localize('ishell.llm.instructions.autoFixProblem', "第 {0} 行：{1}（建议：{2}）", String(d.line), d.message, d.suggestion));
					onProgress?.(localize('ishell.llm.instructions.autoFixRound', "自动审查发现 {0} 个错误，交回模型修复（第 {1}/{2} 轮）：{3}",
						String(report.summary.errors), String(rounds), String(maxRounds), result.filePath));
					const fixed = await this.llmService.applyModelFix({
						content,
						language,
						problems,
						instruction: localize('ishell.llm.instructions.autoFixInstruction', '修复以上全部问题。除修复处外其余内容必须逐字保留，不要增删无关代码，输出修复后的完整文件。'),
					});
					if (fixed.trim() === '' || fixed === content) {
						break; // 模型没给出有效修改：保留现状，避免反复空转
					}
					await this.recordVersion(target, content);
					await this.fileService.writeFile(target, VSBuffer.fromString(fixed));
					content = fixed;
					report = await this.llmService.analyzeCode(content, language, target.fsPath);
				}
				if (rounds > 0) {
					applyDiagnosticsToMarkers(this.markerService, target, report);
					result.diagnostics = { errors: report.summary.errors, warnings: report.summary.warnings, infos: report.summary.infos, score: report.summary.score };
					result.autoFixRounds = rounds;
					onProgress?.(report.summary.errors === 0
						? localize('ishell.llm.instructions.autoFixClean', '自动排错完成：{0} 的全部错误已修复', result.filePath)
						: localize('ishell.llm.instructions.autoFixLeft', "自动排错完成：{0} 修复 {1} 轮后仍剩 {2} 个错误，可继续对话让模型处理", result.filePath, String(rounds), String(report.summary.errors)));
				}
			} catch (err) {
				this.logService.warn(`[ishell-llm] 自动审查排错失败(${result.filePath}): ${(err as Error)?.message ?? err}`);
			}
		}
		return results;
	}

	// ==== 普通代码块自动保存：模型未用指令协议时，把回答里的代码块直接写入当前目录 ====

	/**
	 * 代码块自动落盘：回答中未出现 write/edit 指令但包含可识别语言的代码块时，
	 * 按「正文提到的文件名 → 语言约定名」规划文件名，直接写入工作区当前目录（无需用户手动保存）。
	 * 同名文件已存在时追加序号，绝不静默覆盖用户已有文件。
	 */
	async autoSaveCodeBlocks(answer: string, overwritePaths?: ReadonlySet<string>): Promise<ILlmInstructionExecResult[]> {
		const results: ILlmInstructionExecResult[] = [];
		for (const file of planAutoSaveFromCodeBlocks(answer)) {
			// 之前会话/本轮消息点名过的文件：视为迭代修改，直接更新原文件（先落版本快照）
			const unique = overwritePaths?.has(file.path)
				? (() => {
					const uri = resolveWorkspacePath(this.base, file.path);
					return uri ? { uri, displayPath: file.path } : undefined;
				})()
				: await this.uniquePath(file.path);
			if (!unique) {
				results.push({
					seq: results.length + 1, kind: 'write-file', outcome: 'failed', filePath: file.path,
					message: localize('ishell.llm.instructions.autoSaveNoPath', '无法解析保存路径（未打开工作区）'),
				});
				continue;
			}
			try {
				const current = await this.readCurrent(unique.uri);
				if (current !== undefined) {
					await this.recordVersion(unique.uri, current);
				}
				await this.fileService.writeFile(unique.uri, VSBuffer.fromString(file.content));
				const diagnostics = await this.runDiagnostics(unique.uri, file.content, file.language ?? inferLanguageFromPath(unique.uri.path));
				results.push({
					seq: results.length + 1,
					kind: 'write-file',
					// 由 uniquePath 返回的新路径一定是新建；命中 overwrite 则可能是更新
					outcome: current === undefined ? 'created' : 'updated',
					filePath: unique.displayPath,
					message: current === undefined
						? localize('ishell.llm.instructions.autoSaved', '已将代码块自动保存到当前目录')
						: localize('ishell.llm.instructions.autoUpdated', '已按本轮改动更新文件并自动保存（旧版本已存档）'),
					diagnostics,
				});
			} catch (err) {
				results.push({
					seq: results.length + 1, kind: 'write-file', outcome: 'failed', filePath: unique.displayPath,
					message: `${localize('ishell.llm.instructions.autoSaveFailed', '自动保存失败')}: ${(err as Error)?.message ?? err}`,
				});
			}
		}
		return results;
	}

	/** 为自动保存选取不冲突的目标路径（同名存在时追加 -1/-2…） */
	private async uniquePath(relativePath: string): Promise<{ uri: URI; displayPath: string } | undefined> {
		const slash = relativePath.lastIndexOf('/');
		const dir = slash === -1 ? '' : relativePath.slice(0, slash + 1);
		const fileName = slash === -1 ? relativePath : relativePath.slice(slash + 1);
		const dot = fileName.lastIndexOf('.');
		const stem = dot === -1 ? fileName : fileName.slice(0, dot);
		const suffix = dot === -1 ? '' : fileName.slice(dot);
		for (let i = 0; i < 100; i++) {
			const candidate = `${dir}${i === 0 ? fileName : `${stem}-${i}${suffix}`}`;
			const uri = resolveWorkspacePath(this.base, candidate);
			if (!uri) {
				return undefined;
			}
			if (!(await this.fileService.exists(uri))) {
				return { uri, displayPath: candidate };
			}
		}
		return undefined;
	}

	// ==== write-file：自动保存 + 版本快照 + 诊断联动 ====

	private async applyWriteFile(instruction: ILlmWriteFileInstruction): Promise<ILlmInstructionExecResult> {
		const target = resolveWorkspacePath(this.base, instruction.path);
		if (!target) {
			return this.failed(instruction, localize('ishell.llm.instructions.noPath', '缺少可解析的文件路径，且无打开的工作区'));
		}
		try {
			const current = await this.readCurrent(target);
			if (current !== undefined) {
				// 覆盖前落版本快照（可回溯 + 三方合并基准）
				await this.recordVersion(target, current);
				if (this.isDirtyOpen(target)) {
					return {
						seq: instruction.seq,
						kind: 'write-file',
						outcome: 'conflict',
						filePath: instruction.path,
						message: localize('ishell.llm.instructions.dirtyConflict', '文件已在编辑器中打开且存在未保存修改，为防止丢失用户改动，已跳过自动写入'),
						forceArgs: [instruction.path, instruction.content],
					};
				}
			}
			// 自动保存：直接写盘（打开的编辑器模型随文件事件自动重载）
			await this.fileService.writeFile(target, VSBuffer.fromString(instruction.content));
			const language = instruction.language ?? inferLanguageFromPath(target.path);
			const diagnostics = await this.runDiagnostics(target, instruction.content, language);
			return {
				seq: instruction.seq,
				kind: 'write-file',
				outcome: current === undefined ? 'created' : 'updated',
				filePath: instruction.path,
				message: current === undefined
					? localize('ishell.llm.instructions.created', '已创建文件并自动保存')
					: localize('ishell.llm.instructions.updated', '已覆盖写入并自动保存（旧版本已存档）'),
				diagnostics,
			};
		} catch (err) {
			return this.failed(instruction, `${localize('ishell.llm.instructions.writeFailed', '写入失败')}: ${(err as Error)?.message ?? err}`);
		}
	}

	// ==== edit-file：锚点替换 / 三方合并 ====

	private async applyEditFile(instruction: ILlmEditFileInstruction): Promise<ILlmInstructionExecResult> {
		const target = resolveWorkspacePath(this.base, instruction.path);
		if (!target) {
			return this.failed(instruction, localize('ishell.llm.instructions.noPath', '缺少可解析的文件路径，且无打开的工作区'));
		}
		try {
			const current = await this.readCurrent(target);
			if (current === undefined) {
				return this.failed(instruction, localize('ishell.llm.instructions.editMissing', '目标文件不存在，无法应用修改'));
			}
			// 修改前落版本快照
			await this.recordVersion(target, current);
			if (this.isDirtyOpen(target)) {
				return {
					seq: instruction.seq,
					kind: 'edit-file',
					outcome: 'conflict',
					filePath: instruction.path,
					message: localize('ishell.llm.instructions.dirtyConflict', '文件已在编辑器中打开且存在未保存修改，为防止丢失用户改动，已跳过自动写入'),
				};
			}
			if (current.includes(instruction.find)) {
				// 锚点命中：首处替换
				const updated = current.replace(instruction.find, instruction.replace);
				await this.fileService.writeFile(target, VSBuffer.fromString(updated));
				const diagnostics = await this.runDiagnostics(target, updated, inferLanguageFromPath(target.path));
				return {
					seq: instruction.seq,
					kind: 'edit-file',
					outcome: 'updated',
					filePath: instruction.path,
					message: localize('ishell.llm.instructions.editApplied', '已按锚点完成替换并自动保存'),
					diagnostics,
				};
			}
			// 锚点缺失：基于最近版本快照做三方合并（base=历史基准，ours=磁盘现状，theirs=模型改写）
			const versions = await this.llmService.getFileVersions(target.fsPath);
			const lastVersion = versions.length > 0 ? versions[versions.length - 1] : undefined;
			const baseContent = lastVersion ? await this.llmService.readFileVersion(lastVersion.id) : undefined;
			if (baseContent === undefined || !baseContent.includes(instruction.find)) {
				// 模型自行思考回退：把当前文件与修改意图交回模型重写
				const rethought = await this.rethinkFix(target, current, instruction,
					localize('ishell.llm.instructions.rethinkMissing', '未找到要修改的原文'));
				if (rethought !== undefined) {
					return rethought;
				}
				return {
					seq: instruction.seq,
					kind: 'edit-file',
					outcome: 'conflict',
					filePath: instruction.path,
					message: localize('ishell.llm.instructions.anchorMissing', '未找到要修改的原文（文件在模型生成后已被外部修改），且无历史基准可自动合并'),
				};
			}
			const theirs = baseContent.replace(instruction.find, instruction.replace);
			const merge = merge3Way(baseContent, current, theirs);
			if (merge.conflicts === 0) {
				await this.fileService.writeFile(target, VSBuffer.fromString(merge.merged));
				const diagnostics = await this.runDiagnostics(target, merge.merged, inferLanguageFromPath(target.path));
				return {
					seq: instruction.seq,
					kind: 'edit-file',
					outcome: 'merged',
					filePath: instruction.path,
					message: localize('ishell.llm.instructions.merged', '文件已被外部修改，已基于历史版本自动完成三方合并'),
					diagnostics,
				};
			}
			// 合并冲突：先让模型基于当前文件自行重新完成修改，失败才交用户裁决
			const rethought = await this.rethinkFix(target, current, instruction,
				localize('ishell.llm.instructions.rethinkConflict', '文件已被外部修改，存在合并冲突'));
			if (rethought !== undefined) {
				return rethought;
			}
			return {
				seq: instruction.seq,
				kind: 'edit-file',
				outcome: 'conflict',
				filePath: instruction.path,
				message: localize('ishell.llm.instructions.mergeConflict', '检测到内容冲突：模型修改与你本地的改动重叠，无法自动合并'),
				forceArgs: [instruction.path, merge.merged], // 写入带冲突标记的合并稿，交由用户手动裁决
			};
		} catch (err) {
			return this.failed(instruction, `${localize('ishell.llm.instructions.editFailed', '修改失败')}: ${(err as Error)?.message ?? err}`);
		}
	}

	/** 模型自行思考回退：把当前文件与修改意图交回本地模型重写（autoRethink 关闭/失败返回 undefined） */
	private async rethinkFix(target: URI, current: string, instruction: ILlmEditFileInstruction, hint: string): Promise<ILlmInstructionExecResult | undefined> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.instructions.autoRethink') ?? true;
		if (!enabled) {
			return undefined;
		}
		try {
			const fixed = await this.llmService.applyModelFix({
				content: current,
				language: inferLanguageFromPath(target.path),
				problems: [instruction.find],
				instruction: `${hint}：把片段\n${instruction.find}\n替换为\n${instruction.replace}。若片段不存在请理解意图完成等价修改，除该修改外其余内容逐字保留。`,
			});
			if (fixed.trim() === '' || fixed === current) {
				return undefined; // 模型没给出有效修改：退回冲突出口
			}
			await this.fileService.writeFile(target, VSBuffer.fromString(fixed));
			const diagnostics = await this.runDiagnostics(target, fixed, inferLanguageFromPath(target.path));
			return {
				seq: instruction.seq,
				kind: 'edit-file',
				outcome: 'auto-fixed',
				filePath: instruction.path,
				message: localize('ishell.llm.instructions.autoFixed', '已让模型基于当前文件内容重新完成修改并自动保存（修改前版本已存档）'),
				diagnostics,
			};
		} catch (err) {
			this.logService.warn(`[ishell-llm] 模型重写回退失败: ${(err as Error)?.message ?? err}`);
			return undefined;
		}
	}

	// ==== 公共小工具 ====

	private failed(instruction: ILlmInstruction, message: string): ILlmInstructionExecResult {
		this.logService.warn(`[ishell-llm] 指令执行失败(${instruction.kind}#${instruction.seq}): ${message}`);
		const filePath = 'path' in instruction ? instruction.path : undefined;
		return { seq: instruction.seq, kind: instruction.kind, outcome: 'failed', message, filePath };
	}

	private async readCurrent(target: URI): Promise<string | undefined> {
		try {
			const data = await this.fileService.readFile(target);
			return data.value.toString();
		} catch {
			return undefined; // 文件不存在
		}
	}

	private isDirtyOpen(target: URI): boolean {
		return this.textFileService.files.get(target)?.isDirty() ?? false;
	}

	private async recordVersion(target: URI, content: string): Promise<void> {
		try {
			await this.llmService.recordFileVersion(target.fsPath, content);
		} catch (err) {
			this.logService.warn(`[ishell-llm] 版本快照失败: ${(err as Error)?.message ?? err}`);
		}
	}

	/** 写入后诊断联动：分析 + Markers 上屏；返回摘要 */
	private async runDiagnostics(target: URI, content: string, language: string): Promise<{ errors: number; warnings: number; infos: number; score: number } | undefined> {
		const enabled = this.configurationService.getValue<boolean>('ishell.llm.diagnostics.enabled') ?? true;
		if (!enabled) {
			return undefined;
		}
		try {
			const report = await this.llmService.analyzeCode(content, language, target.fsPath);
			applyDiagnosticsToMarkers(this.markerService, target, report);
			return { errors: report.summary.errors, warnings: report.summary.warnings, infos: report.summary.infos, score: report.summary.score };
		} catch (err) {
			this.logService.warn(`[ishell-llm] 写入后诊断失败: ${(err as Error)?.message ?? err}`);
			return undefined;
		}
	}
}

// ==== 指令相关命令（聊天确认按钮 / 强制覆盖入口） ====

/** 聊天按钮：把建议命令插入当前 SSH 终端（用户点击 = 确认；不自动执行） */
class InsertTerminalCommandAction extends Action2 {

	static readonly ID = 'ishell.llm.insertTerminalCommand';

	constructor() {
		super({
			id: InsertTerminalCommandAction.ID,
			title: localize2('ishell.llm.insertTerminalCommand.title', '将命令插入 SSH 终端'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, command?: string): Promise<void> {
		if (typeof command !== 'string' || command.trim() === '') {
			return;
		}
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const active = editorService.activeEditor;
		if (active instanceof SshTerminalEditorInput) {
			active.sendText(command);
			await editorService.openEditor(active);
			notificationService.info(localize('ishell.llm.insertTerminalCommand.inserted', '命令已插入终端（按回车执行）'));
		} else {
			notificationService.info(localize('ishell.llm.insertTerminalCommand.noTerminal', '未找到活动的 SSH 终端，请先打开一个终端标签页'));
		}
	}
}

/** 聊天按钮：冲突裁决 —— 强制写入（覆盖磁盘 / 写入带冲突标记的合并稿） */
class ForceApplyInstructionAction extends Action2 {

	static readonly ID = 'ishell.llm.instructions.forceApply';

	constructor() {
		super({
			id: ForceApplyInstructionAction.ID,
			title: localize2('ishell.llm.forceApply.title', '强制应用 iShell 指令写入'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, path?: string, content?: string): Promise<void> {
		if (typeof path !== 'string' || typeof content !== 'string') {
			return;
		}
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const target = resolveWorkspacePath(getWorkspaceBase(accessor), path);
		if (!target) {
			notificationService.error(localize('ishell.llm.forceApply.noPath', '无法解析目标路径（未打开工作区）'));
			return;
		}
		try {
			await fileService.writeFile(target, VSBuffer.fromString(content));
			notificationService.info(localize('ishell.llm.forceApply.done', '已强制写入：{0}', path));
		} catch (err) {
			notificationService.error(localize('ishell.llm.forceApply.failed', '强制写入失败：{0}', (err as Error)?.message ?? String(err)));
		}
	}
}

export function registerLlmInstructionActions(): void {
	registerAction2(InsertTerminalCommandAction);
	registerAction2(ForceApplyInstructionAction);
}
