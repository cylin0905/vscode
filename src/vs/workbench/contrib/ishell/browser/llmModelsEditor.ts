/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { FileAccess } from '../../../../base/common/network.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import {
	ILlmDownloadProgress, ILlmEngineInfo, ILlmModelCatalogEntry, ILlmModelRecord,
	ILlmSourceConfig, ILlmSystemInfo, IIshellLlmService, LlmEngineState, LlmVendorIcon
} from '../common/llm.js';
import { LlmLogsPanel } from './llmLogsPanel.js';
import { LlmModelsEditorInput, LlmVendorFilter } from './llmModelsEditorInput.js';
import './llm.css';

const ENGINE_STATE_LABEL: Record<LlmEngineState, string> = {
	missing: '未安装',
	downloading: '下载中',
	ready: '已就绪',
	starting: '启动中',
	running: '运行中',
	stopped: '已停止',
	crashed: '异常退出',
};

/**
 * 本地模型广场编辑器（中间编辑器区域）：
 * 工具行（引擎状态/下载源/日志）+ 系统信息 + 模型卡片网格 + 底部日志抽屉；
 * 厂家过滤来自 LlmModelsEditorInput.vendorId（左侧边栏厂家导航驱动）；
 * 对话复用内置 Chat（本地模型已注册为其语言模型）。
 */
export class LlmModelsEditor extends EditorPane {

	private container: HTMLElement | undefined;
	private editorInput: LlmModelsEditorInput | undefined;
	private readonly inputListeners = this._register(new DisposableStore());
	private readonly listeners = this._register(new DisposableStore());

	private catalog: ILlmModelCatalogEntry[] = [];
	private systemInfo: ILlmSystemInfo | undefined;
	private models: ILlmModelRecord[] = [];
	private source: ILlmSourceConfig | undefined;
	private engine: ILlmEngineInfo = { state: 'missing' };
	private readonly downloads = new Map<string, ILlmDownloadProgress>();

	private logsOpen = false;
	private logsDrawerEl: HTMLElement | undefined;
	private logsToggleEl: HTMLButtonElement | undefined;

	private toolbarEl: HTMLElement | undefined;
	private syslineEl: HTMLElement | undefined;
	private cardsEl: HTMLElement | undefined;

	// 搜索（持久元素：进度事件频繁重建 toolbar/cards，搜索框独立于此行不丢焦点）
	private searchEl: HTMLInputElement | undefined;
	private sysinfoEl: HTMLElement | undefined;
	private searchQuery = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IIshellLlmService private readonly llmService: IIshellLlmService,
	) {
		super(LlmModelsEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	// ==== 生命周期 ====

	override async setInput(newInput: LlmModelsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.editorInput = newInput;
		await super.setInput(newInput, options, context, token);
		this.inputListeners.clear();
		this.inputListeners.add(newInput.onDidChangeVendor(() => this.renderCards()));
		this.renderCards();
	}

	override clearInput(): void {
		super.clearInput();
		this.inputListeners.clear();
		this.editorInput = undefined;
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	protected createEditor(parent: HTMLElement): void {
		this.container = dom.$('.ishell-llm-models-editor');
		parent.appendChild(this.container);

		this.toolbarEl = dom.$('.ishell-llm-models-toolbar');
		this.container.appendChild(this.toolbarEl);

		this.syslineEl = dom.$('.ishell-llm-sysline');
		this.container.appendChild(this.syslineEl);

		// 模型搜索框（创建一次；输入即过滤卡片，与厂家导航叠加）
		this.searchEl = document.createElement('input');
		this.searchEl.type = 'text';
		this.searchEl.classList.add('ishell-llm-search');
		this.searchEl.placeholder = localize('ishell.llm.searchPlaceholder', '搜索模型（名称 / 描述 / 厂家）');
		this.searchEl.title = localize('ishell.llm.searchTooltip', '按模型名称、描述或厂家过滤');
		this.searchEl.addEventListener('input', () => {
			this.searchQuery = this.searchEl?.value ?? '';
			this.renderCards();
		});
		this.syslineEl.appendChild(this.searchEl);

		// 系统信息（右侧弹性省略）
		this.sysinfoEl = dom.$('.ishell-llm-sysinfo.ishell-llm-dim');
		this.syslineEl.appendChild(this.sysinfoEl);

		const cardsScroll = dom.$('.ishell-llm-cards-scroll');
		this.container.appendChild(cardsScroll);
		this.cardsEl = dom.$('.ishell-llm-cards');
		cardsScroll.appendChild(this.cardsEl);

		// 底部日志抽屉（默认收起）
		this.logsDrawerEl = dom.$('.ishell-llm-logs-drawer');
		this.logsDrawerEl.style.display = 'none';
		this.container.appendChild(this.logsDrawerEl);
		this._register(this.instantiationService.createInstance(LlmLogsPanel, this.logsDrawerEl));

		this.listeners.add(this.llmService.onDidDownloadProgress(e => {
			if (e.state === 'completed' || e.state === 'failed' || e.state === 'canceled') {
				this.downloads.delete(e.id);
				if (e.state === 'failed' && e.error) {
					this.notificationService.error(localize('ishell.llm.downloadFailed', "下载失败：{0}", e.error));
				}
				this.refreshModels();
			} else {
				this.downloads.set(e.id, e);
			}
			this.renderToolbar();
			this.renderCards();
		}));
		this.listeners.add(this.llmService.onDidChangeModels(() => this.refreshModels()));
		this.listeners.add(this.llmService.onDidChangeEngine(engine => {
			this.engine = engine;
			this.renderToolbar();
			this.renderCards();
		}));

		this.refreshAll();
	}

	private async refreshAll(): Promise<void> {
		const [catalog, systemInfo, models, source, engine] = await Promise.all([
			this.llmService.getModelCatalog(),
			this.llmService.getSystemInfo(),
			this.llmService.getModels(),
			this.llmService.getSource(),
			this.llmService.getEngineInfo(),
		]);
		this.catalog = catalog;
		this.systemInfo = systemInfo;
		this.models = models;
		this.source = source;
		this.engine = engine;
		this.renderToolbar();
		this.renderSysline();
		this.renderCards();
	}

	private async refreshModels(): Promise<void> {
		this.models = await this.llmService.getModels();
		this.renderCards();
	}

	override focus(): void {
		super.focus();
		this.container?.focus();
	}

	layout(dimension: dom.Dimension): void {
		// flex 布局自适应，无需手动尺寸
	}

	// ==== 工具行 ====

	private renderToolbar(): void {
		const root = this.toolbarEl;
		if (!root) {
			return;
		}
		root.innerText = '';

		const badge = document.createElement('span');
		badge.classList.add('ishell-llm-badge', `ishell-llm-badge-${this.engine.state}`);
		badge.textContent = ENGINE_STATE_LABEL[this.engine.state] ?? this.engine.state;
		root.appendChild(badge);
		if (this.engine.version) {
			const ver = document.createElement('span');
			ver.classList.add('ishell-llm-dim');
			ver.textContent = ` ${this.engine.version}`;
			root.appendChild(ver);
		}
		if (this.engine.state === 'running' && this.engine.apiBaseUrl) {
			const api = document.createElement('span');
			api.classList.add('ishell-llm-dim');
			api.textContent = ` · ${this.engine.apiBaseUrl}/v1`;
			root.appendChild(api);
		}

		if (this.engine.state === 'missing') {
			root.appendChild(this.button(localize('ishell.llm.downloadEngine', '下载引擎'), 'ishell-llm-btn-primary', () => this.pickEngineChannelAndDownload()));
		}
		if (this.engine.state === 'running' || this.engine.state === 'starting') {
			root.appendChild(this.button(localize('ishell.llm.stopModel', '停止模型'), '', async () => {
				try {
					await this.llmService.stopModel();
				} catch (err) {
					this.notificationService.error((err as Error).message);
				}
			}));
		}

		const spacer = document.createElement('span');
		spacer.style.flex = '1';
		root.appendChild(spacer);

		const sourceBtn = this.button(localize('ishell.llm.switchSource', '下载源'), '', () => this.pickSource());
		sourceBtn.title = `${this.source?.name ?? ''}（${this.source?.endpoint ?? ''}）`;
		root.appendChild(sourceBtn);

		this.logsToggleEl = this.button(localize('ishell.llm.logs', '日志'), '', () => this.toggleLogs());
		if (this.logsOpen) {
			this.logsToggleEl.classList.add('ishell-llm-btn-active');
		}
		root.appendChild(this.logsToggleEl);

		if (this.engine.state === 'downloading') {
			const progress = this.downloads.get('engine');
			const bar = this.buildProgressBar(progress, true);
			bar.classList.add('ishell-llm-toolbar-progress');
			root.appendChild(bar);
		} else if (this.engine.detail) {
			const detail = document.createElement('span');
			detail.classList.add('ishell-llm-dim', 'ishell-llm-toolbar-detail');
			detail.title = this.engine.detail;
			detail.textContent = this.engine.detail;
			root.appendChild(detail);
		}
	}

	private renderSysline(): void {
		const root = this.sysinfoEl;
		if (!root) {
			return;
		}
		if (!this.systemInfo) {
			root.textContent = '';
			return;
		}
		const info = this.systemInfo;
		root.textContent = localize('ishell.llm.sysline',
			"{0} · {1} 核 · 内存 {2} GB · 标有\"推荐\"的模型适配当前内存",
			info.cpuModel, String(info.cpuCores), String(info.totalMemGb));
		root.title = `${info.arch}`;
	}

	// ==== 模型卡片 ====

	private renderCards(): void {
		const root = this.cardsEl;
		if (!root) {
			return;
		}
		root.innerText = '';
		const vendorId: LlmVendorFilter = this.editorInput?.vendorId ?? 'all';
		const query = this.searchQuery.trim().toLowerCase();
		// 双重过滤：厂家导航 + 搜索关键词（名称 / 描述 / 厂家，忽略大小写）
		const entries = this.catalog.filter(e => {
			if (vendorId !== 'all' && e.vendorId !== vendorId) {
				return false;
			}
			if (query !== '' && !`${e.name} ${e.description} ${e.vendorName}`.toLowerCase().includes(query)) {
				return false;
			}
			return true;
		});
		if (entries.length === 0) {
			const empty = document.createElement('div');
			empty.classList.add('ishell-llm-cards-empty', 'ishell-llm-dim');
			empty.textContent = localize('ishell.llm.noMatch', '未找到匹配的模型');
			root.appendChild(empty);
			return;
		}
		for (const entry of entries) {
			root.appendChild(this.renderModelCard(entry));
		}
	}

	private renderModelCard(entry: ILlmModelCatalogEntry): HTMLElement {
		const model = this.models.find(m => m.catalogId === entry.id);
		const download = this.downloads.get(entry.id);
		const recommended = this.systemInfo?.recommendedModelIds.includes(entry.id) ?? false;
		const running = this.engine.state === 'running' && this.engine.runningModelId === model?.id;

		const card = document.createElement('div');
		card.classList.add('ishell-llm-card');
		if (running) {
			card.classList.add('ishell-llm-card-running');
		}

		const head = document.createElement('div');
		head.classList.add('ishell-llm-card-head');
		// 模型图标：网络图片优先（失败回退类型 codicon）
		head.appendChild(renderModelIcon(entry, 'lg'));
		const type = modelTypeOf(entry);
		const name = document.createElement('span');
		name.classList.add('ishell-llm-card-name');
		name.textContent = entry.name;
		head.appendChild(name);
		if (recommended && !model) {
			const star = document.createElement('span');
			star.classList.add('ishell-llm-badge', 'ishell-llm-badge-recommend');
			star.textContent = localize('ishell.llm.recommended', '推荐');
			head.appendChild(star);
		}
		if (running) {
			const run = document.createElement('span');
			run.classList.add('ishell-llm-badge', 'ishell-llm-badge-running');
			run.textContent = localize('ishell.llm.running', '运行中');
			head.appendChild(run);
		}
		const tag = document.createElement('span');
		tag.classList.add('ishell-llm-card-tag');
		tag.textContent = type.label;
		head.appendChild(tag);
		card.appendChild(head);

		const desc = document.createElement('div');
		desc.classList.add('ishell-llm-card-desc', 'ishell-llm-dim');
		desc.textContent = entry.description;
		card.appendChild(desc);

		const spec = document.createElement('div');
		spec.classList.add('ishell-llm-card-spec', 'ishell-llm-dim');
		spec.textContent = localize('ishell.llm.cardSpec', "{0} · 最低内存 {1} GB · {2}", formatSize(entry.sizeBytes), String(entry.minRamGb), entry.vendorName);
		card.appendChild(spec);

		const actions = document.createElement('div');
		actions.classList.add('ishell-llm-card-actions');

		if (download && download.state === 'downloading') {
			actions.appendChild(this.buildProgressBar(download, true));
			actions.appendChild(this.iconButton(Codicon.stopCircle, localize('ishell.llm.cancelDownload', '取消下载'), async () => {
				await this.llmService.cancelDownload(entry.id);
			}));
		} else if (model) {
			if (running || this.engine.state === 'starting' && this.engine.runningModelId === model.id) {
				actions.appendChild(this.button(localize('ishell.llm.stopModel', '停止模型'), '', async () => {
					try {
						await this.llmService.stopModel();
					} catch (err) {
						this.notificationService.error((err as Error).message);
					}
				}));
				actions.appendChild(this.button(localize('ishell.llm.chat', '对话'), 'ishell-llm-btn-primary', () => this.openChat()));
			} else {
				actions.appendChild(this.button(localize('ishell.llm.startModel', '启动'), 'ishell-llm-btn-primary', async () => {
					try {
						await this.llmService.startModel(model.id);
						this.openChat();
					} catch (err) {
						this.notificationService.error((err as Error).message);
					}
				}));
			}
			actions.appendChild(this.iconButton(Codicon.trash, localize('ishell.llm.deleteModel', '删除模型'), async () => {
				try {
					await this.llmService.deleteModel(model.id);
				} catch (err) {
					this.notificationService.error((err as Error).message);
				}
			}));
		} else {
			actions.appendChild(this.button(localize('ishell.llm.download', '下载'), 'ishell-llm-btn-primary', async () => {
				try {
					await this.llmService.downloadModel(entry.id);
				} catch (err) {
					this.notificationService.error((err as Error).message);
				}
			}));
		}
		card.appendChild(actions);
		return card;
	}

	// ==== 对话 / 日志入口 ====

	/** 对话复用内置 Chat：本地模型已注册为其语言模型，在模型选择器中选择即可 */
	private openChat(): void {
		this.commandService.executeCommand('workbench.action.chat.open').catch(err => {
			this.notificationService.error((err as Error).message);
		});
	}

	private toggleLogs(): void {
		this.logsOpen = !this.logsOpen;
		if (this.logsDrawerEl) {
			this.logsDrawerEl.style.display = this.logsOpen ? '' : 'none';
		}
		this.logsToggleEl?.classList.toggle('ishell-llm-btn-active', this.logsOpen);
	}

	// ==== 控件 ====

	private button(text: string, extraClass: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.classList.add('ishell-llm-btn', ...(extraClass ? [extraClass] : []));
		btn.textContent = text;
		btn.addEventListener('click', onClick);
		return btn;
	}

	private iconButton(icon: { id: string }, title: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.classList.add('ishell-llm-btn-icon');
		btn.title = title;
		const iconEl = document.createElement('span');
		iconEl.classList.add('codicon', `codicon-${icon.id}`);
		btn.appendChild(iconEl);
		btn.addEventListener('click', onClick);
		return btn;
	}

	private buildProgressBar(progress: ILlmDownloadProgress | undefined, showSpeed: boolean): HTMLElement {
		const wrap = document.createElement('div');
		wrap.classList.add('ishell-llm-progress');
		const bar = document.createElement('div');
		bar.classList.add('ishell-llm-progress-bar');
		const fill = document.createElement('div');
		fill.classList.add('ishell-llm-progress-fill');
		const pct = progress && progress.totalBytes > 0 ? Math.floor(progress.receivedBytes / progress.totalBytes * 100) : 0;
		fill.style.width = `${pct}%`;
		bar.appendChild(fill);
		wrap.appendChild(bar);
		const label = document.createElement('div');
		label.classList.add('ishell-llm-progress-label');
		if (progress) {
			const speed = showSpeed && progress.speedBytesPerSec > 0 ? ` · ${formatSize(progress.speedBytesPerSec)}/s` : '';
			label.textContent = `${pct}%（${formatSize(progress.receivedBytes)} / ${formatSize(progress.totalBytes)}${speed}）`;
		} else {
			label.textContent = localize('ishell.llm.preparing', '准备中…');
		}
		wrap.appendChild(label);
		return wrap;
	}

	// ==== 交互 ====

	private async pickEngineChannelAndDownload(): Promise<void> {
		const pick = await this.quickInputService.pick(
			[
				{ label: localize('ishell.llm.channelGhproxy', '国内加速（gh-proxy.com）'), description: '推荐国内网络使用', channel: 'ghproxy' as const },
				{ label: localize('ishell.llm.channelDirect', 'GitHub 官方直连'), description: '海外网络使用', channel: 'direct' as const },
			],
			{ placeHolder: localize('ishell.llm.pickChannel', '选择引擎下载通道') }
		);
		if (!pick) {
			return;
		}
		try {
			await this.llmService.setEngineChannel(pick.channel);
			await this.llmService.downloadEngine();
		} catch (err) {
			this.notificationService.error((err as Error).message);
		}
	}

	private async pickSource(): Promise<void> {
		const pick = await this.quickInputService.pick(
			[
				{ label: localize('ishell.llm.srcMirror', '国内镜像源（hf-mirror.com）'), description: '推荐国内网络使用', kind: 'mirror' as const },
				{ label: localize('ishell.llm.srcOfficial', '国外官方源（HuggingFace）'), description: '海外网络使用', kind: 'official' as const },
				{ label: localize('ishell.llm.srcCustom', '自定义源…'), description: '输入自定义下载端点', kind: 'custom' as const },
			],
			{ placeHolder: localize('ishell.llm.pickSource', '选择模型下载源') }
		);
		if (!pick) {
			return;
		}
		try {
			let endpoint: string | undefined;
			if (pick.kind === 'custom') {
				endpoint = await this.quickInputService.input({
					placeHolder: localize('ishell.llm.customEndpointHint', '输入自定义源地址（http:// 或 https:// 开头）'),
					validateInput: async value => value.trim().startsWith('http://') || value.trim().startsWith('https://') ? undefined : localize('ishell.llm.endpointInvalid', '地址必须以 http:// 或 https:// 开头'),
				});
				if (endpoint === undefined) {
					return;
				}
			}
			await this.llmService.setSource(pick.kind, endpoint);
			this.source = await this.llmService.getSource();
			this.renderToolbar();
		} catch (err) {
			this.notificationService.error((err as Error).message);
		}
	}
}

/** 品牌本地图标 URI（静态资源随构建拷贝，无网络请求、无跨域） */
const VENDOR_ICON_URIS: Record<LlmVendorIcon, string> = {
	qwen: FileAccess.asBrowserUri('vs/workbench/contrib/ishell/browser/media/qwen.png').toString(true),
	deepseek: FileAccess.asBrowserUri('vs/workbench/contrib/ishell/browser/media/deepseek.jpg').toString(true),
	llama: FileAccess.asBrowserUri('vs/workbench/contrib/ishell/browser/media/llama.png').toString(true),
};

/**
 * 品牌图标元素：本地静态资源（qwen/deepseek/llama），加载失败或未配置回退 codicon。
 * 供模型卡片 / 侧边栏厂家导航 / 网络搜索结果共用。
 */
export function renderBrandIcon(brand: LlmVendorIcon | undefined, size: 'sm' | 'lg', fallbackIcon: ThemeIcon, fallbackTitle: string): HTMLElement {
	const wrap = document.createElement('span');
	wrap.classList.add('ishell-llm-icon', size === 'lg' ? 'ishell-llm-icon-lg' : 'ishell-llm-icon-sm');
	const fallback = document.createElement('span');
	fallback.classList.add('codicon', `codicon-${fallbackIcon.id}`, 'ishell-llm-icon-fallback');
	fallback.title = fallbackTitle;
	wrap.appendChild(fallback);
	if (brand) {
		const img = document.createElement('img');
		img.classList.add('ishell-llm-icon-img');
		img.alt = fallbackTitle;
		img.draggable = false;
		img.addEventListener('load', () => {
			fallback.remove();
			wrap.appendChild(img);
		});
		img.src = VENDOR_ICON_URIS[brand];
	}
	return wrap;
}

/**
 * 模型图标元素（模型广场卡片 / 侧边栏导航共用）：
 * vendorIcon 品牌本地图标，缺省回退内置 codicon 类型图标。
 */
export function renderModelIcon(entry: ILlmModelCatalogEntry, size: 'sm' | 'lg' = 'sm'): HTMLElement {
	const type = modelTypeOf(entry);
	if (entry.vendorIcon) {
		return renderBrandIcon(entry.vendorIcon, size, type.icon, type.label);
	}
	const wrap = document.createElement('span');
	wrap.classList.add('ishell-llm-icon', size === 'lg' ? 'ishell-llm-icon-lg' : 'ishell-llm-icon-sm');
	const fallback = document.createElement('span');
	fallback.classList.add('codicon', `codicon-${type.icon.id}`, 'ishell-llm-icon-fallback', `ishell-llm-card-icon-${type.kind}`);
	fallback.title = type.label;
	wrap.appendChild(fallback);
	return wrap;
}

/** 模型类型 → 图标与标签（按 tags 优先级：code > reasoning > chat） */
function modelTypeOf(entry: ILlmModelCatalogEntry): { kind: 'code' | 'reasoning' | 'chat'; icon: ThemeIcon; label: string } {
	if (entry.tags.includes('code')) {
		return { kind: 'code', icon: Codicon.code, label: localize('ishell.llm.typeCode', '代码') };
	}
	if (entry.tags.includes('reasoning')) {
		return { kind: 'reasoning', icon: Codicon.lightbulb, label: localize('ishell.llm.typeReasoning', '推理') };
	}
	return { kind: 'chat', icon: Codicon.commentDiscussion, label: localize('ishell.llm.typeChat', '对话') };
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	}
	if (bytes >= 1024 ** 2) {
		return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
	}
	return `${Math.round(bytes / 1024)} KB`;
}
