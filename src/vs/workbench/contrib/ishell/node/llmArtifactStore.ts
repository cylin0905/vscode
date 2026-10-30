/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILlmArtifactMeta, LlmArtifactKind } from '../common/llm.js';
import { slugify } from '../common/llmInstructions.js';

// #########################################################################
// ##        iShell 模型产物持久化存储（主进程，文件系统）                  ##
// ##  - 全部模型输出（对话转录 / 代码块 / 诊断报告）自动落盘               ##
// ##  - 命名规则可配置：{date} {time} {sessionId} {requestId} {slug} {ext} ##
// ##  - 路径段净化（防穿越），原子写入（tmp + rename），索引限长            ##
// #########################################################################

export interface ILlmArtifactSaveInput {
	kind: LlmArtifactKind;
	sessionId: string;
	requestId: string;
	title: string;
	content: string;
	/** 文件扩展名（带点），如 '.md' '.ts' */
	ext: string;
}

/** 默认命名规则（配置键 ishell.llm.persistence.namingRule 空值时回退） */
export const DEFAULT_LLM_ARTIFACT_NAMING_RULE = '{date}/{sessionId}/{time}-{requestId}-{slug}{ext}';

/** 索引最大条目（仅裁剪索引，产物文件本身保留） */
const MAX_INDEX_ENTRIES = 500;

function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

export class LlmArtifactStore {

	private namingRule = DEFAULT_LLM_ARTIFACT_NAMING_RULE;
	private index: ILlmArtifactMeta[] = [];
	private loaded = false;

	constructor(
		/** 产物根目录（绝对路径） */
		public readonly rootDir: string,
	) { }

	/** 更新命名规则（空串回退默认） */
	setNamingRule(rule: string): void {
		const trimmed = rule.trim();
		this.namingRule = trimmed !== '' ? trimmed : DEFAULT_LLM_ARTIFACT_NAMING_RULE;
	}

	/** 展开命名规则令牌并净化为安全的相对路径（防目录穿越） */
	static expandNamingRule(rule: string, tokens: { date: string; time: string; sessionId: string; requestId: string; slug: string; ext: string }): string {
		const expanded = rule.replace(/\{(date|time|sessionId|requestId|slug|ext)\}/g, (_, key: string) => tokens[key as keyof typeof tokens]);
		return LlmArtifactStore.sanitizeRelativePath(expanded);
	}

	/** 相对路径净化：段内仅保留 [\w.-]，禁止 . / .. 空段；全空回退 'artifact' */
	static sanitizeRelativePath(input: string): string {
		const segments = input
			.split(/[\\/]+/)
			.map(raw => {
				let seg = raw.replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
				if (seg === '.' || seg === '..') {
					seg = '';
				}
				return seg.length > 80 ? seg.slice(0, 80) : seg;
			})
			.filter(seg => seg !== '');
		const joined = segments.join('/');
		return joined === '' ? 'artifact' : joined;
	}

	/** 保存一个产物并写入索引；返回元数据 */
	async save(input: ILlmArtifactSaveInput): Promise<ILlmArtifactMeta> {
		await this.ensureLoaded();
		const now = new Date();
		const meta: ILlmArtifactMeta = {
			id: generateUuid(),
			kind: input.kind,
			sessionId: input.sessionId,
			requestId: input.requestId,
			title: input.title,
			fileName: '',
			filePath: '',
			bytes: Buffer.byteLength(input.content, 'utf8'),
			createdAt: now.getTime(),
		};
		meta.fileName = LlmArtifactStore.expandNamingRule(this.namingRule, {
			date: `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
			time: `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`,
			sessionId: slugify(input.sessionId, 24),
			requestId: slugify(input.requestId, 12),
			slug: slugify(input.title, 48),
			ext: input.ext.startsWith('.') ? input.ext : `.${input.ext}`,
		});
		meta.filePath = join(this.rootDir, meta.fileName);

		// 原子写入：tmp + rename，崩溃不产生半截文件
		const tmpPath = `${meta.filePath}.tmp-${meta.id.slice(0, 8)}`;
		await fsp.mkdir(dirname(meta.filePath), { recursive: true });
		await fsp.writeFile(tmpPath, input.content, 'utf8');
		await fsp.rename(tmpPath, meta.filePath);

		this.index.unshift(meta);
		if (this.index.length > MAX_INDEX_ENTRIES) {
			this.index.length = MAX_INDEX_ENTRIES;
		}
		await this.persistIndex();
		return meta;
	}

	/** 产物列表（新→旧）；可按会话过滤 */
	async list(sessionId?: string): Promise<ILlmArtifactMeta[]> {
		await this.ensureLoaded();
		const items = sessionId ? this.index.filter(a => a.sessionId === sessionId) : this.index;
		return items.map(a => ({ ...a }));
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) {
			return;
		}
		try {
			const raw = await fsp.readFile(join(this.rootDir, 'index.json'), 'utf8');
			const parsed = JSON.parse(raw) as ILlmArtifactMeta[];
			this.index = Array.isArray(parsed) ? parsed : [];
		} catch {
			this.index = []; // 首次使用 / 损坏索引从零开始
		}
		this.loaded = true;
	}

	private async persistIndex(): Promise<void> {
		await fsp.mkdir(this.rootDir, { recursive: true });
		await fsp.writeFile(join(this.rootDir, 'index.json'), JSON.stringify(this.index, undefined, '\t'), 'utf8');
	}
}
