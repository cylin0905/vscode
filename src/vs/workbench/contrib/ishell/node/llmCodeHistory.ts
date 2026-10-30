/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILlmFileVersion } from '../common/llm.js';

// #########################################################################
// ##      iShell 代码版本历史（自动保存 / 冲突合并支撑，主进程）            ##
// ##  每次模型改写文件前先落盘一份快照：                                     ##
// ##   - 支撑三方合并的 base（模型上次看到的基准）                          ##
// ##   - 支撑版本回溯（限制保留条数，最旧先淘汰）                           ##
// ##  布局：rootDir/<sha256(path)[0:16]>/<versionId>.txt + 根 index.json   ##
// #########################################################################

/** 单个快照上限（超过则拒快照，交由冲突流程处理） */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

interface IPersistedIndex {
	[key: string]: ILlmFileVersion[];
}

export class LlmCodeHistoryStore {

	private index: IPersistedIndex = {};
	private loaded = false;
	private limitPerFile: number;

	constructor(
		public readonly rootDir: string,
		limitPerFile = 20,
	) {
		this.limitPerFile = Math.max(2, limitPerFile);
	}

	/** 动态调整保留条数（配置键 ishell.llm.autoSave.historyLimit） */
	setLimitPerFile(limitPerFile: number): void {
		this.limitPerFile = Math.max(2, limitPerFile);
	}

	private static keyOf(filePath: string): string {
		return createHash('sha256')
			.update(filePath.replace(/\\/g, '/').toLowerCase())
			.digest('hex')
			.slice(0, 16);
	}

	private snapshotPath(key: string, versionId: string): string {
		return join(this.rootDir, key, `${versionId}.txt`);
	}

	private get indexPath(): string {
		return join(this.rootDir, 'index.json');
	}

	/** 记录快照（与最近版本相同则去重返回既有版本） */
	async record(filePath: string, content: string): Promise<ILlmFileVersion> {
		await this.ensureLoaded();
		const key = LlmCodeHistoryStore.keyOf(filePath);
		const versions = this.index[key] ?? [];

		if (versions.length > 0) {
			const last = versions[versions.length - 1];
			if ((await this.read(last.id)) === content) {
				return last;
			}
		}
		const bytes = Buffer.byteLength(content, 'utf8');
		if (bytes > MAX_SNAPSHOT_BYTES) {
			throw new Error('文件过大，跳过版本快照');
		}

		const version: ILlmFileVersion = {
			id: generateUuid(),
			filePath,
			time: Date.now(),
			bytes,
			preview: content.slice(0, 120).replace(/\s+/g, ' ').trim(),
		};
		const snapshotFile = this.snapshotPath(key, version.id);
		await fsp.mkdir(dirname(snapshotFile), { recursive: true });
		await fsp.writeFile(snapshotFile, content, 'utf8');

		versions.push(version);
		while (versions.length > this.limitPerFile) {
			const dropped = versions.shift();
			if (dropped) {
				await fsp.rm(this.snapshotPath(key, dropped.id), { force: true }).catch(() => { });
			}
		}
		this.index[key] = versions;
		await this.persistIndex();
		return { ...version };
	}

	/** 指定文件的版本列表（旧→新） */
	async list(filePath: string): Promise<ILlmFileVersion[]> {
		await this.ensureLoaded();
		const versions = this.index[LlmCodeHistoryStore.keyOf(filePath)] ?? [];
		return versions.map(v => ({ ...v }));
	}

	/** 读取指定版本内容 */
	async read(versionId: string): Promise<string | undefined> {
		await this.ensureLoaded();
		for (const versions of Object.values(this.index)) {
			const version = versions.find(v => v.id === versionId);
			if (version) {
				try {
					return await fsp.readFile(this.snapshotPath(LlmCodeHistoryStore.keyOf(version.filePath), versionId), 'utf8');
				} catch {
					return undefined;
				}
			}
		}
		return undefined;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) {
			return;
		}
		try {
			const raw = await fsp.readFile(this.indexPath, 'utf8');
			const parsed = JSON.parse(raw) as IPersistedIndex;
			this.index = parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			this.index = {};
		}
		this.loaded = true;
	}

	private async persistIndex(): Promise<void> {
		await fsp.mkdir(this.rootDir, { recursive: true });
		await fsp.writeFile(this.indexPath, JSON.stringify(this.index, undefined, '\t'), 'utf8');
	}
}
