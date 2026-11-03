/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $, getWindow } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILlmLogEntry, IIshellLlmService, LlmLogLevel, LlmLogSource } from '../common/llm.js';
import './llm.css';

const SOURCE_LABEL: Record<LlmLogSource, string> = {
	system: '系统',
	'engine-download': '引擎下载',
	'model-download': '模型下载',
	engine: '引擎',
	gateway: 'API 网关',
	chat: '对话',
	music: '音乐',
};

/** DOM 节点上限（超出移除最旧；全量数据仍可经导出获得） */
const MAX_DOM_ENTRIES = 1000;

/**
 * 本地模型运行日志嵌入式面板（本地模型视图右栏）：
 * 实时查看 / 级别与来源过滤 / 文本过滤 / 导出 / 清空。
 */
export class LlmLogsPanel extends Disposable {

	private readonly listeners = new DisposableStore();
	private entries: ILlmLogEntry[] = [];
	private filterLevel: LlmLogLevel | 'all' = 'all';
	private filterSource: LlmLogSource | 'all' = 'all';
	private filterText = '';

	private logList!: HTMLElement;
	private countLabel!: HTMLElement;
	private levelSelect!: HTMLSelectElement;
	private sourceSelect!: HTMLSelectElement;
	private textInput!: HTMLInputElement;

	constructor(
		parent: HTMLElement,
		@INotificationService private readonly notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IIshellLlmService private readonly llmService: IIshellLlmService,
	) {
		super();
		this.render(parent);
	}

	private render(parent: HTMLElement): void {
		const root = append(parent, $('.ishell-llm-logs'));

		// ---- 工具栏 ----
		const toolbar = append(root, $('.ishell-llm-logs-toolbar'));

		this.levelSelect = document.createElement('select');
		this.levelSelect.classList.add('ishell-llm-select');
		this.levelSelect.title = localize('ishell.llm.filterLevel', '按级别过滤');
		this.levelSelect.appendChild(option(localize('ishell.llm.allLevels', '全部级别'), 'all'));
		this.levelSelect.appendChild(option('INFO', 'info'));
		this.levelSelect.appendChild(option('WARN', 'warn'));
		this.levelSelect.appendChild(option('ERROR', 'error'));
		this.levelSelect.addEventListener('change', () => { this.filterLevel = this.levelSelect.value as LlmLogLevel | 'all'; this.rerender(); });
		toolbar.appendChild(this.levelSelect);

		this.sourceSelect = document.createElement('select');
		this.sourceSelect.classList.add('ishell-llm-select');
		this.sourceSelect.title = localize('ishell.llm.filterSource', '按来源过滤');
		this.sourceSelect.appendChild(option(localize('ishell.llm.allSources', '全部来源'), 'all'));
		for (const key of Object.keys(SOURCE_LABEL) as LlmLogSource[]) {
			this.sourceSelect.appendChild(option(SOURCE_LABEL[key], key));
		}
		this.sourceSelect.addEventListener('change', () => { this.filterSource = this.sourceSelect.value as LlmLogSource | 'all'; this.rerender(); });
		toolbar.appendChild(this.sourceSelect);

		this.textInput = document.createElement('input');
		this.textInput.classList.add('ishell-llm-logs-search');
		this.textInput.type = 'text';
		this.textInput.placeholder = localize('ishell.llm.filterText', '过滤文本…');
		this.textInput.addEventListener('input', () => { this.filterText = this.textInput.value.trim().toLowerCase(); this.rerender(); });
		toolbar.appendChild(this.textInput);

		const exportBtn = document.createElement('button');
		exportBtn.classList.add('ishell-llm-btn-icon');
		exportBtn.title = localize('ishell.llm.exportLogs', '导出日志');
		append(exportBtn, $('span.codicon.codicon-export'));
		exportBtn.addEventListener('click', async () => {
			const path = await this.llmService.exportLogs();
			if (path) {
				this.notificationService.info(localize('ishell.llm.exported', "日志已导出：{0}", path));
			}
		});
		toolbar.appendChild(exportBtn);

		const clearBtn = document.createElement('button');
		clearBtn.classList.add('ishell-llm-btn-icon');
		clearBtn.title = localize('ishell.llm.clearLogs', '清空日志');
		append(clearBtn, $('span.codicon.codicon-clear-all'));
		clearBtn.addEventListener('click', async () => {
			await this.llmService.clearLogs();
			this.entries = [];
			this.rerender();
		});
		toolbar.appendChild(clearBtn);

		this.countLabel = append(toolbar, $('.ishell-llm-logs-count.ishell-llm-dim'));

		// ---- 列表 ----
		this.logList = append(root, $('.ishell-llm-logs-list'));

		// ---- 右键菜单：复制选中日志 / 全选 ----
		// 右键按下默认会清空选区：已有选中文本时阻止默认行为，保证「选中 → 右键 → 复制」可用
		this.logList.addEventListener('mousedown', (event: MouseEvent) => {
			if (event.button === 2 && this.getSelectedLogText().length > 0) {
				event.preventDefault();
			}
		});
		this.logList.addEventListener('contextmenu', (event: MouseEvent) => {
			event.preventDefault();
			const selected = this.getSelectedLogText();
			this.contextMenuService.showContextMenu({
				getAnchor: () => new StandardMouseEvent(getWindow(this.logList), event),
				getActions: (): IAction[] => [
					{
						id: 'ishell.llm.logs.copy',
						label: localize('ishell.llm.logsCopy', '复制'),
						enabled: selected.length > 0,
						run: async () => { await this.clipboardService.writeText(selected); },
					},
					{
						id: 'ishell.llm.logs.selectAll',
						label: localize('ishell.llm.logsSelectAll', '全选'),
						enabled: this.logList.childElementCount > 0,
						run: () => this.selectAllLogs(),
					},
				],
			});
		});

		// ---- 事件 ----
		this._register(this.listeners);
		this.listeners.add(this.llmService.onDidAppendLog(entry => {
			this.entries.push(entry);
			if (this.passesFilter(entry)) {
				this.appendEntryDom(entry);
				this.trimDom();
				this.updateCount();
			}
		}));

		this.init();
	}

	private async init(): Promise<void> {
		this.entries = await this.llmService.getLogs();
		this.rerender();
	}

	private passesFilter(entry: ILlmLogEntry): boolean {
		if (this.filterLevel !== 'all' && entry.level !== this.filterLevel) {
			return false;
		}
		if (this.filterSource !== 'all' && entry.source !== this.filterSource) {
			return false;
		}
		if (this.filterText && !entry.message.toLowerCase().includes(this.filterText)) {
			return false;
		}
		return true;
	}

	private rerender(): void {
		this.logList.innerText = '';
		const filtered = this.entries.filter(e => this.passesFilter(e));
		const visible = filtered.slice(-MAX_DOM_ENTRIES);
		for (const entry of visible) {
			this.appendEntryDom(entry);
		}
		this.logList.scrollTop = this.logList.scrollHeight;
		this.updateCount();
	}

	private appendEntryDom(entry: ILlmLogEntry): void {
		const line = append(this.logList, $('.ishell-llm-log-line'));
		line.classList.add(`ishell-llm-log-${entry.level}`);
		const time = append(line, $('span.ishell-llm-log-time'));
		time.textContent = formatTime(entry.time);
		const level = append(line, $('span.ishell-llm-log-level'));
		level.textContent = entry.level.toUpperCase();
		const source = append(line, $('span.ishell-llm-log-source'));
		source.textContent = SOURCE_LABEL[entry.source];
		const message = append(line, $('span.ishell-llm-log-message'));
		message.textContent = entry.message;
		this.logList.scrollTop = this.logList.scrollHeight;
	}

	private trimDom(): void {
		while (this.logList.childElementCount > MAX_DOM_ENTRIES) {
			this.logList.firstElementChild?.remove();
		}
	}

	private updateCount(): void {
		this.countLabel.textContent = `${this.logList.childElementCount} 条`;
	}

	/** 当前在日志区域内选中的文本（无选中返回空字符串） */
	private getSelectedLogText(): string {
		const win = getWindow(this.logList);
		const selection = win.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return '';
		}
		const range = selection.getRangeAt(0);
		if (!this.logList.contains(range.commonAncestorContainer)) {
			return '';
		}
		return selection.toString();
	}

	private selectAllLogs(): void {
		const win = getWindow(this.logList);
		const range = win.document.createRange();
		range.selectNodeContents(this.logList);
		const selection = win.getSelection();
		if (selection) {
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}

	override dispose(): void {
		this.listeners.dispose();
		super.dispose();
	}
}

function option(label: string, value: string): HTMLOptionElement {
	const opt = document.createElement('option');
	opt.textContent = label;
	opt.value = value;
	return opt;
}

function formatTime(time: number): string {
	const d = new Date(time);
	const pad = (n: number, len = 2) => String(n).padStart(len, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
