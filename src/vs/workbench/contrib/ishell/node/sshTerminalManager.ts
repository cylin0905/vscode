/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ITerminalCloseEvent, ITerminalOutputEvent } from '../common/ishell.js';
import { ISshChannelLike } from './sshSession.js';
import { SshConnectionPool } from './sshConnectionPool.js';

/** 输出批量合并参数：防 top/vim 高频输出打爆 IPC */
const FLUSH_INTERVAL_MS = 4;
const FLUSH_MAX_PENDING_BYTES = 32 * 1024;

interface IManagedTerminal {
	sessionId: string;
	channel: ISshChannelLike;
	/** 待 flush 的输出缓冲（UTF-8 可能跨 Buffer 断裂，flush 时安全切分） */
	pending: Buffer[];
	pendingBytes: number;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 计算缓冲区中最后一个完整 UTF-8 序列结束位置（截掉尾部不完整的多字节序列）。
 * 例如 3 字节中文只收到前 2 字节时，返回 buf.length - 2。
 */
export function completeUtf8Length(buf: Buffer): number {
	for (let back = 1; back <= Math.min(4, buf.length); back++) {
		const b = buf[buf.length - back];
		if ((b & 0xC0) === 0x80) {
			continue; // 续字节，继续回看
		}
		if (b < 0x80) {
			return buf.length; // ASCII 起始字节：尾部序列完整
		}
		const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
		return back === need ? buf.length : buf.length - back;
	}
	return buf.length; // 全是续字节（异常输入），保守全部发送
}

/**
 * SSH 终端通道管理器（运行于主进程）。
 * - 在连接池会话上按需打开 shell 通道（单连接多通道复用）
 * - 通道输出按 4ms/32KB 批量合并后经事件推送渲染层（UTF-8 安全切分）
 * - 会话断开/失败时批量关闭该会话全部通道并通知渲染层（渲染层保留 xterm 缓冲等待重连）
 */
export class SshTerminalManager extends Disposable {

	private readonly terminals = new Map<string, IManagedTerminal>();
	private nextSeq = 1;

	private readonly _onDidOutput = new Emitter<ITerminalOutputEvent>();
	readonly onDidOutput: Event<ITerminalOutputEvent> = this._onDidOutput.event;

	private readonly _onDidClose = new Emitter<ITerminalCloseEvent>();
	readonly onDidClose: Event<ITerminalCloseEvent> = this._onDidClose.event;

	constructor(private readonly pool: SshConnectionPool) {
		super();
		// 会话状态离开 connected/connecting（断线、重连中、失败、主动断开）→ 该会话全部通道已死，立即通知渲染层
		this._register(pool.onDidChange(snapshot => {
			if (!snapshot) {
				return;
			}
			if (snapshot.status !== 'connected' && snapshot.status !== 'connecting') {
				this.closeSessionTerminals(snapshot.id, 'session-closed');
			}
		}));
	}

	/** 在已连接会话上打开 shell 通道，返回 terminalId */
	async open(sessionId: string, cols: number, rows: number): Promise<string> {
		const session = this.pool.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在：${sessionId}`);
		}
		if (!session.connected) {
			throw new Error('会话未连接，无法打开终端通道');
		}
		const channel = await session.openShell(cols, rows);
		const terminalId = `${sessionId}#${this.nextSeq++}`;
		const terminal: IManagedTerminal = { sessionId, channel, pending: [], pendingBytes: 0, flushTimer: undefined };
		this.terminals.set(terminalId, terminal);

		channel.on('data', (data: Buffer) => {
			terminal.pending.push(data);
			terminal.pendingBytes += data.length;
			if (terminal.pendingBytes >= FLUSH_MAX_PENDING_BYTES) {
				this.flush(terminalId);
			} else if (terminal.flushTimer === undefined) {
				terminal.flushTimer = setTimeout(() => {
					terminal.flushTimer = undefined;
					this.flush(terminalId);
				}, FLUSH_INTERVAL_MS);
			}
		});

		channel.on('error', () => {
			// 通道级错误：等 close 事件统一收尾（ssh2 错误后必然 close）
		});

		channel.on('close', () => {
			if (!this.terminals.has(terminalId)) {
				return; // 已被主动关闭（用户/会话级收尾）
			}
			this.disposeTerminal(terminalId);
			this._onDidClose.fire({ terminalId, reason: 'channel-closed' });
		});

		return terminalId;
	}

	/** 渲染层输入写入 shell 通道 */
	write(terminalId: string, data: string): void {
		const terminal = this.terminals.get(terminalId);
		if (terminal) {
			try {
				terminal.channel.write(data);
			} catch {
				// 通道已死：忽略写入，close 事件负责收尾
			}
		}
	}

	/** PTY 窗口尺寸变化 */
	resize(terminalId: string, cols: number, rows: number): void {
		const terminal = this.terminals.get(terminalId);
		if (terminal) {
			try {
				terminal.channel.setWindow(rows, cols, 0, 0);
			} catch {
				// ignore
			}
		}
	}

	/** 用户关闭终端标签 */
	close(terminalId: string): void {
		if (!this.terminals.has(terminalId)) {
			return; // 幂等
		}
		this.disposeTerminal(terminalId);
		// 渲染层自己发起的关闭，不再回发事件（'user-closed' 保留给多终端订阅场景）
	}

	private flush(terminalId: string): void {
		const terminal = this.terminals.get(terminalId);
		if (!terminal || terminal.pending.length === 0) {
			return;
		}
		if (terminal.flushTimer !== undefined) {
			clearTimeout(terminal.flushTimer);
			terminal.flushTimer = undefined;
		}
		const merged = Buffer.concat(terminal.pending);
		const complete = completeUtf8Length(merged);
		const data = merged.subarray(0, complete).toString('utf8');
		const rest = merged.subarray(complete);
		terminal.pending = rest.length > 0 ? [rest] : [];
		terminal.pendingBytes = rest.length;
		if (data.length > 0) {
			this._onDidOutput.fire({ terminalId, data });
		}
	}

	private disposeTerminal(terminalId: string): void {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) {
			return;
		}
		this.flush(terminalId); // 关闭前冲刷残留输出（此时仍在 Map 中，flush 生效）
		this.terminals.delete(terminalId);
		if (terminal.flushTimer !== undefined) {
			clearTimeout(terminal.flushTimer);
			terminal.flushTimer = undefined;
		}
		try {
			terminal.channel.close();
		} catch {
			// ignore
		}
		try {
			terminal.channel.destroy();
		} catch {
			// ignore
		}
	}

	/** 会话级收尾：关闭该会话全部通道并通知渲染层 */
	private closeSessionTerminals(sessionId: string, reason: 'session-closed' | 'user-closed'): void {
		for (const [terminalId, terminal] of [...this.terminals]) {
			if (terminal.sessionId === sessionId) {
				this.disposeTerminal(terminalId);
				this._onDidClose.fire({ terminalId, reason });
			}
		}
	}

	override dispose(): void {
		for (const [terminalId, terminal] of [...this.terminals]) {
			if (terminal.flushTimer !== undefined) {
				clearTimeout(terminal.flushTimer);
			}
			try {
				terminal.channel.close();
			} catch {
				// ignore
			}
			this.terminals.delete(terminalId);
		}
		this._onDidOutput.dispose();
		this._onDidClose.dispose();
		super.dispose();
	}
}
