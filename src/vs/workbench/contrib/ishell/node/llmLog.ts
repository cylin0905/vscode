/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { ILlmLogEntry, LlmLogLevel, LlmLogSource } from '../common/llm.js';

/** 环形缓冲上限（超出丢弃最旧条目） */
const MAX_ENTRIES = 5000;

/**
 * 本地 LLM 运行日志：下载 / 引擎 / 网关 / 对话全流程。
 * 内存态环形缓冲，实时经 onDidAppendLog 推送渲染层；
 * 由上层（LlmMainService）负责双写到 logService。
 */
export class LlmLogStore {

	private entries: ILlmLogEntry[] = [];
	private nextSeq = 1;

	private readonly _onDidAppendLog = new Emitter<ILlmLogEntry>();
	readonly onDidAppendLog: Event<ILlmLogEntry> = this._onDidAppendLog.event;

	log(level: LlmLogLevel, source: LlmLogSource, message: string): void {
		const entry: ILlmLogEntry = { seq: this.nextSeq++, time: Date.now(), level, source, message };
		this.entries.push(entry);
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		}
		this._onDidAppendLog.fire(entry);
	}

	info(source: LlmLogSource, message: string): void {
		this.log('info', source, message);
	}

	warn(source: LlmLogSource, message: string): void {
		this.log('warn', source, message);
	}

	error(source: LlmLogSource, message: string): void {
		this.log('error', source, message);
	}

	getEntries(sinceSeq?: number): ILlmLogEntry[] {
		if (sinceSeq === undefined) {
			return this.entries.slice();
		}
		return this.entries.filter(e => e.seq > sinceSeq);
	}

	clear(): void {
		this.entries = [];
		// seq 继续自增，避免渲染层新旧序号混淆
	}

	/** 全量导出为纯文本（日志面板导出用） */
	exportText(): string {
		return this.entries
			.map(e => `${formatTime(e.time)} [${e.level.toUpperCase()}] [${e.source}] ${e.message}`)
			.join('\r\n');
	}

	dispose(): void {
		this._onDidAppendLog.dispose();
	}
}

function formatTime(time: number): string {
	const d = new Date(time);
	const pad = (n: number, len = 2) => String(n).padStart(len, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
