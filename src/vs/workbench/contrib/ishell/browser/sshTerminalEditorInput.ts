/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal, ITheme as IXtermTheme } from '@xterm/xterm';
import { importAMDNodeModule } from '../../../../amdX.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import * as dom from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IAction } from '../../../../base/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorInput, IEditorCloseHandler } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { IIshellService } from '../common/ishell.js';

/** 终端覆盖层状态 */
type OverlayState = 'none' | 'waiting' | 'failed' | 'ended';

const TERMINAL_SCROLLBAR_WIDTH = 14;

/** 从 workbench 主题构建 xterm 主题（未定制终端色时回退编辑器色） */
function buildXtermTheme(theme: IColorTheme): IXtermTheme {
	const color = (id: string, fallback?: string): string | undefined => theme.getColor(id)?.toString() ?? fallback;
	const ansi = (id: string): string | undefined => theme.getColor(id)?.toString();
	return {
		foreground: color('terminal.foreground', theme.getColor('editor.foreground')?.toString()),
		background: color('terminal.background', theme.getColor('editor.background')?.toString()),
		cursor: color('terminalCursor.foreground', theme.getColor('editorCursor.foreground')?.toString()),
		cursorAccent: color('terminal.background', theme.getColor('editor.background')?.toString()),
		selectionBackground: color('terminal.selectionBackground', theme.getColor('editor.selectionBackground')?.toString()),
		black: ansi('terminal.ansiBlack'),
		red: ansi('terminal.ansiRed'),
		green: ansi('terminal.ansiGreen'),
		yellow: ansi('terminal.ansiYellow'),
		blue: ansi('terminal.ansiBlue'),
		magenta: ansi('terminal.ansiMagenta'),
		cyan: ansi('terminal.ansiCyan'),
		white: ansi('terminal.ansiWhite'),
		brightBlack: ansi('terminal.ansiBrightBlack'),
		brightRed: ansi('terminal.ansiBrightRed'),
		brightGreen: ansi('terminal.ansiBrightGreen'),
		brightYellow: ansi('terminal.ansiBrightYellow'),
		brightBlue: ansi('terminal.ansiBrightBlue'),
		brightMagenta: ansi('terminal.ansiBrightMagenta'),
		brightCyan: ansi('terminal.ansiBrightCyan'),
		brightWhite: ansi('terminal.ansiBrightWhite'),
	};
}

/**
 * SSH 远程终端编辑器输入：
 * - 生命周期绑定 xterm 实例与 shell 通道（terminalId），跨编辑器组拖拽不中断
 * - 断线时保留 xterm 缓冲并显示覆盖层；会话重连成功后自动重开通道并加分隔线
 */
export class SshTerminalEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly ID = 'workbench.editors.ishellTerminal';
	static readonly EDITOR_ID = 'ishell.terminalEditor';

	override readonly closeHandler = this;

	readonly sessionId: string;

	private _xterm: Terminal | undefined;
	private _wrapper: HTMLElement | undefined;
	private _overlay: HTMLElement | undefined;
	private _overlayState: OverlayState = 'none';
	private _terminalId: string | undefined;
	/** 通道死后是否可随会话重连自动重开（远端 exit / 会话失败终态后为 false） */
	private _canReopen = true;
	private _xtermReady: Promise<void> | undefined;

	private readonly _sessionDisposables = this._register(new DisposableStore());

	constructor(
		public override readonly resource: URI,
		sessionId: string,
		private readonly _label: string,
		@IIshellService private readonly _ishellService: IIshellService,
		@IThemeService private readonly _themeService: IThemeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
	) {
		super();
		this.sessionId = sessionId;
		this._registerListener();
	}

	override get typeId(): string {
		return SshTerminalEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return SshTerminalEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.CanDropIntoEditor | EditorInputCapabilities.ForceReveal;
	}

	override getName(): string {
		return this._label;
	}

	// ==== IEditorCloseHandler ====

	showConfirm(): boolean {
		return false;
	}

	async confirm(): Promise<ConfirmResult> {
		return ConfirmResult.DONT_SAVE;
	}

	// ==== 宿主（EditorPane）调用 ====

	/** 挂载到编辑器容器（跨组移动时复用同一 DOM） */
	attachToElement(container: HTMLElement): void {
		if (!this._wrapper) {
			this._wrapper = dom.$('.ishell-terminal-wrapper');
		}
		if (this._wrapper.parentElement !== container) {
			container.appendChild(this._wrapper);
		}
		void this.ensureXterm();
	}

	detachFromElement(): void {
		this._wrapper?.remove();
	}

	/** 按容器尺寸修正 cols/rows 并同步远端 PTY */
	layout(): void {
		this.fit();
	}

	focus(): void {
		this._xterm?.focus();
	}

	// ==== xterm 与通道生命周期 ====

	private async ensureXterm(): Promise<void> {
		if (this._xterm) {
			return;
		}
		if (!this._xtermReady) {
			this._xtermReady = (async () => {
				const TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
				if (this._store.isDisposed || !this._wrapper) {
					return;
				}
				const fontSize = this._configurationService.getValue<number>('ishell.terminal.fontSize');
				const fontFamily = this._configurationService.getValue<string>('ishell.terminal.fontFamily');
				const scrollback = this._configurationService.getValue<number>('ishell.terminal.scrollback');
				this._xterm = new TerminalCtor({
					cols: 80,
					rows: 24,
					fontSize: Math.max(6, Math.min(64, fontSize || 12)),
					fontFamily: fontFamily || 'Consolas, "Courier New", monospace',
					scrollback: Math.max(0, scrollback ?? 1000),
					cursorBlink: true,
					theme: buildXtermTheme(this._themeService.getColorTheme()),
					allowProposedApi: true,
				});

				const xterm = this._xterm;
				xterm.open(this._wrapper);
				this._overlay = dom.$('.ishell-terminal-overlay.hidden');
				this._overlay.textContent = '';
				this._wrapper.appendChild(this._overlay);

				// 输入 → 主进程
				this._sessionDisposables.add(xterm.onData(data => {
					if (this._terminalId !== undefined) {
						this._ishellService.writeTerminal(this._terminalId, data);
					}
				}));

				// 尺寸变化 → 远端 PTY
				this._sessionDisposables.add(xterm.onResize(({ cols, rows }) => {
					if (this._terminalId !== undefined) {
						this._ishellService.resizeTerminal(this._terminalId, cols, rows);
					}
				}));

				// Ctrl+Shift+C/V 复制粘贴（不阻塞其余按键，含 IME）
				xterm.attachCustomKeyEventHandler(event => {
					if (event.type !== 'keydown') {
						return true;
					}
					if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyC' && xterm.hasSelection()) {
						void this.copySelection();
						return false;
					}
					if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyV') {
						void this.paste();
						return false;
					}
					return true;
				});

				// 右键：copyPaste（默认，XShell 习惯）/ menu / default
				this._sessionDisposables.add(dom.addDisposableListener(this._wrapper, 'contextmenu', (event: MouseEvent) => {
					if (event.shiftKey) {
						return; // Shift+右键 = 浏览器原生菜单
					}
					const behavior = this._configurationService.getValue<string>('ishell.terminal.rightClickAction') || 'copyPaste';
					if (behavior === 'default') {
						return; // 浏览器默认行为
					}
					event.preventDefault();
					event.stopImmediatePropagation();
					if (behavior === 'copyPaste') {
						if (xterm.hasSelection()) {
							void this.copySelection();
							xterm.clearSelection();
						} else {
							void this.paste();
						}
					} else if (behavior === 'menu') {
						this._contextMenuService.showContextMenu({
						getAnchor: () => new StandardMouseEvent(dom.getWindow(this._wrapper!), event),
							getActions: () => [
								<IAction>{
									id: 'ishell.terminal.context.copy',
									label: localize('ishell.copyAction', "复制"),
									enabled: xterm.hasSelection(),
									run: () => this.copySelection(),
								},
								<IAction>{
									id: 'ishell.terminal.context.paste',
									label: localize('ishell.pasteAction', "粘贴"),
									run: () => this.paste(),
								},
							],
						});
					}
				}));

				this._register(this._themeService.onDidColorThemeChange(theme => {
					xterm.options.theme = buildXtermTheme(theme);
				}));

				this.fit();
				await this.ensureChannel(false);
			})();
		}
		await this._xtermReady;
	}

	/** 打开（或重连后重开）shell 通道 */
	private async ensureChannel(reconnect: boolean): Promise<void> {
		if (this._terminalId !== undefined || !this._canReopen || !this._xterm) {
			return;
		}
		const cols = this._xterm.cols;
		const rows = this._xterm.rows;
		try {
			this._terminalId = await this._ishellService.openTerminal(this.sessionId, { cols, rows });
			if (reconnect) {
				this._xterm.write('\r\n\x1b[33m─── ' + localize('ishell.reconnected', '已重新连接') + ' ───\x1b[0m\r\n');
			}
			this.setOverlay('none');
		} catch (err) {
			// 会话恰好又断了：保留覆盖层等待下一次 connected 快照重试
			this.setOverlay('waiting', localize('ishell.terminalOpenRetry', '通道打开失败，等待连接恢复后自动重试…'));
		}
	}

	/** 按容器尺寸与 xterm cell 尺寸计算 cols/rows */
	private fit(): void {
		const xterm = this._xterm;
		const wrapper = this._wrapper;
		if (!xterm || !wrapper || !wrapper.parentElement) {
			return;
		}
		const cell = xterm.dimensions?.css.cell;
		if (!cell || cell.width <= 0 || cell.height <= 0) {
			return;
		}
		const cols = Math.max(2, Math.floor((wrapper.clientWidth - TERMINAL_SCROLLBAR_WIDTH) / cell.width));
		const rows = Math.max(1, Math.floor(wrapper.clientHeight / cell.height));
		if (cols !== xterm.cols || rows !== xterm.rows) {
			xterm.resize(cols, rows);
		}
	}

	// ==== 主进程事件 ====

	private _registerListener(): void {
		// shell 输出 → xterm
		this._register(this._ishellService.onDidTerminalOutput(e => {
			if (e.terminalId === this._terminalId && this._xterm) {
				this._xterm.write(e.data);
			}
		}));

		// 通道关闭
		this._register(this._ishellService.onDidTerminalClose(e => {
			if (e.terminalId !== this._terminalId) {
				return;
			}
			this._terminalId = undefined;
			if (e.reason === 'session-closed') {
				// 会话断开：保留缓冲，等待重连（overlay 由连接快照驱动更新文案）
				this.setOverlay('waiting', localize('ishell.sessionDropped', '连接已断开，正在等待重连…'));
			} else if (e.reason === 'channel-closed') {
				this._canReopen = false;
				this.setOverlay('ended', localize('ishell.shellExited', '远程会话已结束（exit）'));
			}
			// 'user-closed'：自身发起，忽略
		}));

		// 会话状态变化 → 覆盖层文案 / 重连后自动重开通道
		this._register(this._ishellService.onDidChangeConnections(snapshot => {
			if (!snapshot || snapshot.id !== this.sessionId) {
				return;
			}
			switch (snapshot.status) {
				case 'connected': {
					if (this._overlayState === 'waiting') {
						this.setOverlay('none');
					}
					if (this._terminalId === undefined && this._canReopen) {
						void this.ensureChannel(true);
					}
					break;
				}
				case 'reconnecting': {
					const n = snapshot.retryCount ?? 0;
					this.setOverlay('waiting', localize('ishell.reconnectingN', '连接断开，正在重连（第 {0} 次）…', n + 1));
					break;
				}
				case 'failed': {
					this._canReopen = false;
					this.setOverlay('failed', localize('ishell.terminalFailed', '连接失败：{0}', snapshot.detail ?? snapshot.errorCode ?? '未知错误'));
					break;
				}
				case 'disconnected': {
					this._canReopen = false;
					this.setOverlay('failed', localize('ishell.terminalDisconnected', '连接已断开'));
					break;
				}
			}
		}));
	}

	// ==== 覆盖层 ====

	private setOverlay(state: OverlayState, text?: string): void {
		this._overlayState = state;
		const overlay = this._overlay;
		if (!overlay) {
			return;
		}
		if (state === 'none') {
			overlay.classList.add('hidden');
			return;
		}
		overlay.classList.remove('hidden');
		overlay.classList.toggle('failed', state === 'failed' || state === 'ended');
		overlay.textContent = text ?? '';
	}

	// ==== 剪贴板 ====

	private async copySelection(): Promise<void> {
		const selection = this._xterm?.getSelection();
		if (selection) {
			await this._clipboardService.writeText(selection);
		}
	}

	private async paste(): Promise<void> {
		const text = await this._clipboardService.readText();
		if (text && this._terminalId !== undefined) {
			await this._ishellService.writeTerminal(this._terminalId, text);
		}
	}

	// ==== 清理 ====

	override dispose(): void {
		if (this._terminalId !== undefined) {
			const terminalId = this._terminalId;
			this._terminalId = undefined;
			this._ishellService.closeTerminal(terminalId).catch(() => { /* shutdown 竞态时忽略 */ });
		}
		this._sessionDisposables.clear();
		this._xterm?.dispose();
		this._xterm = undefined;
		super.dispose();
	}
}
