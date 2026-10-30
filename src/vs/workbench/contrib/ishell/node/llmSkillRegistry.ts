/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { join } from 'path';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILlmSkillManifest, ILlmSkillRegistration, LlmSkillOrigin } from '../common/llm.js';

// #########################################################################
// ##        iShell Skill 注册体系（可扩展插件 / 能力注册中心）             ##
// ##  三个来源：                                                            ##
// ##   builtin  — 代码内置（随版本分发，不可卸载）                          ##
// ##   user     — skillsDir 目录热加载（*.json 清单，用户/团队自定义）      ##
// ##   extension— 通过命令接口注册（扩展宿主调用，持久化到 registered.json)##
// ##  渲染层在每次对话时按触发关键词将启用技能的 instruction 注入 prompt。 ##
// #########################################################################

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const MAX_TRIGGERS = 16;

/** 内置 Skill（对齐开发规划 S1-S3 场景 + 诊断） */
export const BUILTIN_SKILLS: ILlmSkillManifest[] = [
	{
		id: 'ishell.generate-code',
		name: '代码生成',
		description: '生成 / 实现代码文件，自动写入工作区并落盘版本历史。',
		version: '1.0.0',
		triggers: ['生成', '实现', '写一个', '新建文件', 'create', 'implement', 'generate'],
		instruction: '用户要求生成或实现代码时：给出简短设计说明，随后使用指令块协议输出完整文件（### ishell:write <相对路径> + 代码围栏），文件内容必须完整可编译、符合项目现有代码风格。',
		origin: 'builtin',
		enabled: true,
	},
	{
		id: 'ishell.explain-code',
		name: '代码讲解',
		description: '解释代码逻辑、结构与依赖关系。',
		version: '1.0.0',
		triggers: ['解释', '讲解', '这段代码', '是什么意思', 'explain', 'how does'],
		instruction: '用户要求解释代码时：先给一句话结论，再按结构分段讲解（入口/数据流/关键算法），指出潜在坑点。不修改代码。',
		origin: 'builtin',
		enabled: true,
	},
	{
		id: 'ishell.diagnose',
		name: '问题诊断',
		description: '排查报错 / 异常行为，输出原因与修复建议。',
		version: '1.0.0',
		triggers: ['诊断', '排查', '报错', '为什么错', '修复', 'diagnose', 'error', 'fix', 'bug'],
		instruction: '用户描述报错或异常时：1) 列出可能原因（按概率排序）；2) 给出定位手段（日志/断点/最小复现）；3) 使用 ishell:edit 指令块给出修复改动；4) 提醒用户可运行命令面板中的 iShell 诊断获取静态分析结果。',
		origin: 'builtin',
		enabled: true,
	},
	{
		id: 'ishell.command-gen',
		name: '命令生成',
		description: '自然语言生成 shell 命令（安全红线：仅建议，绝不自动执行）。',
		version: '1.0.0',
		triggers: ['命令', '怎么执行', '如何安装', '帮我执行', 'command', 'shell'],
		instruction: '用户需要操作命令时：使用 ### ishell:terminal 指令块输出建议命令并解释每个参数的作用；危险命令（rm -rf / sudo / 权限变更等）必须明确标注风险，等待用户在聊天中手动确认插入。',
		origin: 'builtin',
		enabled: true,
	},
	{
		id: 'ishell.optimize-code',
		name: '性能优化',
		description: '识别性能问题并给出改写方案。',
		version: '1.0.0',
		triggers: ['优化', '性能', '变慢', '卡顿', 'optimize', 'performance', 'refactor'],
		instruction: '用户要求优化时：先定位热点（算法复杂度/IO/内存），量化说明预期收益，再使用 ishell:edit 指令块给出改写；无把握的优化要说明权衡。',
		origin: 'builtin',
		enabled: true,
	},
	{
		id: 'ishell.review-code',
		name: '代码审查',
		description: '对代码进行 review，按严重度输出问题清单。',
		version: '1.0.0',
		triggers: ['审查', 'review', '检查代码', '代码质量'],
		instruction: '用户要求 review 时：按【严重/建议/风格】三级输出问题清单（文件:行号 + 问题 + 建议），仅对明确要改的点使用 ishell:edit 指令块。',
		origin: 'builtin',
		enabled: true,
	},
];

/** 校验注册入参（JSON 反序列化后的未知对象）；返回错误列表（空 = 通过） */
export function validateSkillRegistration(input: unknown): { errors: string[]; value?: ILlmSkillRegistration } {
	const errors: string[] = [];
	if (typeof input !== 'object' || input === null) {
		return { errors: ['清单必须是 JSON 对象'] };
	}
	const obj = input as Record<string, unknown>;
	const id = obj.id;
	const name = obj.name;
	const description = obj.description;
	const version = obj.version;
	const triggers = obj.triggers;
	const instruction = obj.instruction;

	if (typeof id !== 'string' || !SKILL_ID_RE.test(id)) {
		errors.push('id 必须是 3-64 位的 [a-z0-9._-]（以字母或数字开头）');
	}
	if (typeof name !== 'string' || name.trim() === '' || name.length > 64) {
		errors.push('name 必须是 1-64 字符的非空字符串');
	}
	if (typeof description !== 'string' || description.trim() === '') {
		errors.push('description 必须是非空字符串');
	}
	if (typeof version !== 'string' || !VERSION_RE.test(version)) {
		errors.push('version 必须形如 1 / 1.0 / 1.0.0');
	}
	if (!Array.isArray(triggers) || triggers.length === 0 || triggers.length > MAX_TRIGGERS || triggers.some(t => typeof t !== 'string' || t.trim() === '')) {
		errors.push(`triggers 必须是 1-${MAX_TRIGGERS} 个非空字符串关键词`);
	}
	if (typeof instruction !== 'string' || instruction.trim() === '' || instruction.length > 8000) {
		errors.push('instruction 必须是 1-8000 字符的注入指令');
	}
	if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
		errors.push('enabled 可选，但必须为布尔值');
	}
	if (obj.extensionId !== undefined && typeof obj.extensionId !== 'string') {
		errors.push('extensionId 可选，但必须为字符串');
	}
	if (errors.length > 0) {
		return { errors };
	}
	return {
		errors: [],
		value: {
			id: (id as string).toLowerCase(),
			name: (name as string).trim(),
			description: (description as string).trim(),
			version: version as string,
			triggers: (triggers as string[]).map(t => t.trim()).filter(t => t !== ''),
			instruction: instruction as string,
			enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
			extensionId: typeof obj.extensionId === 'string' ? obj.extensionId : undefined,
		},
	};
}

/** 已持久化的扩展注册项（registered.json 一行一项） */
interface IPersistedSkill {
	manifest: ILlmSkillManifest;
}

export class LlmSkillRegistry {

	private skills = new Map<string, ILlmSkillManifest>();
	private persisted: IPersistedSkill[] = [];
	private loaded = false;

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** 内置 Skill 禁用清单（启停状态持久化；目录加载时跳过该文件） */
	private readonly builtinDisabledPath: string;
	private static readonly BUILTIN_DISABLED_FILE = 'builtin-disabled.json';

	constructor(
		/** 用户自定义 Skill 目录（*.json 热加载） */
		public readonly skillsDir: string,
		/** 扩展注册项持久化文件 */
		public readonly persistedPath: string,
	) {
		this.builtinDisabledPath = join(this.skillsDir, LlmSkillRegistry.BUILTIN_DISABLED_FILE);
	}

	/** 全量加载：内置 → 目录 → 内置禁用清单 → 扩展注册项（后者覆盖前者） */
	async load(): Promise<void> {
		this.skills.clear();
		for (const skill of BUILTIN_SKILLS) {
			this.skills.set(skill.id, { ...skill });
		}
		await this.loadFromDirectory();
		try {
			const raw = JSON.parse(await fsp.readFile(this.builtinDisabledPath, 'utf8')) as unknown;
			const disabled = Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : [];
			for (const id of disabled) {
				const skill = this.skills.get(id);
				if (skill?.origin === 'builtin') {
					skill.enabled = false;
				}
			}
		} catch {
			// 无禁用清单：内置全部启用
		}
		try {
			const raw = await fsp.readFile(this.persistedPath, 'utf8');
			const parsed = JSON.parse(raw) as IPersistedSkill[];
			this.persisted = Array.isArray(parsed) ? parsed : [];
		} catch {
			this.persisted = [];
		}
		for (const entry of this.persisted) {
			const check = validateSkillRegistration({ ...entry.manifest, extensionId: entry.manifest.extensionId });
			if (check.value) {
				this.skills.set(check.value.id, { ...entry.manifest, origin: 'extension', enabled: entry.manifest.enabled });
			}
		}
		this.loaded = true;
		this._onDidChange.fire();
	}

	private async loadFromDirectory(): Promise<void> {
		let files: string[] = [];
		try {
			files = (await fsp.readdir(this.skillsDir)).filter(f => f.toLowerCase().endsWith('.json') && f !== LlmSkillRegistry.BUILTIN_DISABLED_FILE);
		} catch {
			return; // 目录不存在：无用户 Skill
		}
		for (const file of files) {
			try {
				const raw = await fsp.readFile(join(this.skillsDir, file), 'utf8');
				const check = validateSkillRegistration(JSON.parse(raw));
				if (check.value) {
					this.skills.set(check.value.id, { ...check.value, origin: 'user', enabled: check.value.enabled ?? true });
				}
			} catch {
				// 单个坏文件跳过，不影响其他 Skill 加载
			}
		}
	}

	list(): ILlmSkillManifest[] {
		return [...this.skills.values()].map(s => ({ ...s }));
	}

	get(id: string): ILlmSkillManifest | undefined {
		const skill = this.skills.get(id);
		return skill ? { ...skill } : undefined;
	}

	/** 注册（校验失败抛错）。user 来源写入 skillsDir；extension 来源写入持久化文件。 */
	async register(registration: unknown): Promise<ILlmSkillManifest> {
		await this.ensureLoaded();
		const check = validateSkillRegistration(registration);
		if (!check.value) {
			throw new Error(`Skill 清单校验失败：${check.errors.join('；')}`);
		}
		const input = check.value;
		const origin: LlmSkillOrigin = input.extensionId ? 'extension' : 'user';
		const manifest: ILlmSkillManifest = {
			id: input.id,
			name: input.name,
			description: input.description,
			version: input.version,
			triggers: input.triggers,
			instruction: input.instruction,
			origin,
			extensionId: input.extensionId,
			enabled: input.enabled ?? true,
		};

		const existing = this.skills.get(manifest.id);
		if (existing?.origin === 'builtin') {
			throw new Error(`不允许覆盖内置 Skill：${manifest.id}`);
		}

		if (origin === 'user') {
			await fsp.mkdir(this.skillsDir, { recursive: true });
			await fsp.writeFile(join(this.skillsDir, `${manifest.id}.json`), JSON.stringify(manifest, undefined, '\t'), 'utf8');
		} else {
			this.persisted = this.persisted.filter(e => e.manifest.id !== manifest.id || (e.manifest.extensionId ?? '') !== (manifest.extensionId ?? ''));
			this.persisted.push({ manifest });
			await fsp.writeFile(this.persistedPath, JSON.stringify(this.persisted, undefined, '\t'), 'utf8');
		}
		this.skills.set(manifest.id, manifest);
		this._onDidChange.fire();
		return { ...manifest };
	}

	/**
	 * 切换启停（三个来源各自持久化）：
	 * builtin 写入禁用清单；user 更新目录 JSON；extension 更新 registered.json。
	 */
	async setEnabled(id: string, enabled: boolean): Promise<ILlmSkillManifest> {
		await this.ensureLoaded();
		const existing = this.skills.get(id);
		if (!existing) {
			throw new Error(`Skill 不存在：${id}`);
		}
		existing.enabled = enabled;
		if (existing.origin === 'builtin') {
			const disabledIds = [...this.skills.values()].filter(s => s.origin === 'builtin' && !s.enabled).map(s => s.id);
			await fsp.mkdir(this.skillsDir, { recursive: true });
			await fsp.writeFile(this.builtinDisabledPath, JSON.stringify(disabledIds, undefined, '\t'), 'utf8');
		} else if (existing.origin === 'user') {
			const files = (await fsp.readdir(this.skillsDir)).filter(f => f.toLowerCase().endsWith('.json') && f !== LlmSkillRegistry.BUILTIN_DISABLED_FILE);
			for (const file of files) {
				try {
					const filePath = join(this.skillsDir, file);
					const raw = JSON.parse(await fsp.readFile(filePath, 'utf8')) as Record<string, unknown>;
					if (raw.id === id) {
						raw.enabled = enabled;
						await fsp.writeFile(filePath, JSON.stringify(raw, undefined, '\t'), 'utf8');
					}
				} catch {
					// 坏文件跳过（状态仍生效于内存）
				}
			}
		} else {
			for (const entry of this.persisted) {
				if (entry.manifest.id === id && (entry.manifest.extensionId ?? '') === (existing.extensionId ?? '')) {
					entry.manifest.enabled = enabled;
				}
			}
			await fsp.writeFile(this.persistedPath, JSON.stringify(this.persisted, undefined, '\t'), 'utf8');
		}
		this._onDidChange.fire();
		return { ...existing };
	}

	/** 卸载：builtin 拒绝；user 删除目录文件；extension 移除持久化项 */
	async unregister(id: string): Promise<void> {
		await this.ensureLoaded();
		const existing = this.skills.get(id);
		if (!existing) {
			throw new Error(`Skill 不存在：${id}`);
		}
		if (existing.origin === 'builtin') {
			throw new Error('内置 Skill 不可卸载');
		}
		if (existing.origin === 'user') {
			try {
				const files = (await fsp.readdir(this.skillsDir)).filter(f => f.toLowerCase().endsWith('.json'));
				for (const file of files) {
					try {
						const raw = JSON.parse(await fsp.readFile(join(this.skillsDir, file), 'utf8')) as Record<string, unknown>;
						if (raw.id === id) {
							await fsp.rm(join(this.skillsDir, file), { force: true });
						}
					} catch {
						// 坏文件跳过
					}
				}
			} catch {
				// 目录不存在
			}
		} else {
			this.persisted = this.persisted.filter(e => e.manifest.id !== id || (e.manifest.extensionId ?? '') !== (existing.extensionId ?? ''));
			await fsp.writeFile(this.persistedPath, JSON.stringify(this.persisted, undefined, '\t'), 'utf8');
		}
		this.skills.delete(id);
		this._onDidChange.fire();
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) {
			await this.load();
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
