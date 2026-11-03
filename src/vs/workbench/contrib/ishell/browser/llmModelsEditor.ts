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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
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
	ILlmAudioEngineInfo, ILlmDownloadProgress, ILlmEngineInfo, ILlmModelCatalogEntry, ILlmModelParams, ILlmModelRecord,
	ILlmMusicProgress, ILlmMusicResult,
	ILlmNetworkFile, ILlmNetworkModel, ILlmSourceConfig, ILlmSystemInfo, IIshellLlmService,
	LLM_NETWORK_PAGE_SIZE, LlmEngineState, LlmModelKind, LlmVendorIcon, networkModelCatalogId, resolveModelCategories, resolveModelKind
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

/** 下载源去重键：kind + endpoint */
function sourceKeyOf(source: ILlmSourceConfig): string {
	return `${source.kind}|${source.endpoint}`;
}

/** 模型广场 Tab：本地模型（目录 + 已下载）、网络模型（可下载仓库）、音乐生成（audio.cpp） */
type LlmModelTab = 'local' | 'network' | 'music';

/** 参数面板字段描述（数值输入 / 下拉选择；min/max 仅数值字段使用） */
interface IParamsField {
	section: 'load' | 'generate';
	key: keyof ILlmModelParams;
	label: string;
	min?: number;
	max?: number;
	step?: number;
	integer?: boolean;
	select?: { value: string; label: string }[];
}

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
	/** 已应用的下载源（kind|endpoint），用于忽略重复的源变更通知 */
	private appliedSourceKey = '';
	private engine: ILlmEngineInfo = { state: 'missing' };
	private readonly downloads = new Map<string, ILlmDownloadProgress>();

	private logsOpen = false;
	private logsDrawerEl: HTMLElement | undefined;
	private logsToggleEl: HTMLButtonElement | undefined;

	private toolbarEl: HTMLElement | undefined;
	private syslineEl: HTMLElement | undefined;
	private cardsEl: HTMLElement | undefined;

	// 搜索（持久元素：进度事件频繁重建 cards，搜索框固定在网络分区头部不丢焦点）
	private searchEl: HTMLInputElement | undefined;
	private sysinfoEl: HTMLElement | undefined;
	private searchQuery = '';

	// 分类 Tab：本地模型 / 网络模型 / 音乐生成（切换时只渲染并加载对应列表）
	private activeTab: LlmModelTab = 'local';
	private tabsEl: HTMLElement | undefined;
	/** 网络分区头部（可下载仓库标题 + 搜索框）：固定不随卡片重渲染 */
	private networkHeaderEl: HTMLElement | undefined;
	private networkTitleEl: HTMLElement | undefined;
	private networkHintEl: HTMLElement | undefined;
	/** 网络列表是否已按当前关键词加载完成（避免 Tab 反复切换时重复搜索） */
	private networkLoaded = false;

	// 网络模型搜索（防抖 + 请求序号防过期；结果以卡片展示并可直接下载）
	private networkResults: ILlmNetworkModel[] = [];
	private networkLoading = false;
	private networkTimer: ReturnType<typeof setTimeout> | undefined;
	private networkSeq = 0;
	/** 最近一次已完成的网络搜索关键词（用于区分"搜索中"与"无结果"） */
	private networkQuery = '';
	/** 仓库 → 最小量化体积（-1 表示未取到；用于卡片展示大小） */
	private readonly networkSizes = new Map<string, number>();
	/** 体积查询在途的仓库（避免重复请求） */
	private readonly networkSizePending = new Set<string>();
	/** 体积查询代次（切换下载源后丢弃旧源在途结果） */
	private networkSizeSeq = 0;
	/** 正在选择量化/开始下载的仓库（按钮置忙） */
	private readonly networkBusy = new Set<string>();
	/** 仓库 → 已开始的下载 id（用于展示进度条） */
	private readonly networkDownloadIds = new Map<string, string>();

	// 卡片内量化下拉：文件缓存/加载/错误 + 当前选择
	private readonly networkFiles = new Map<string, ILlmNetworkFile[]>();
	private readonly networkFilesLoading = new Set<string>();
	private readonly networkFileErrors = new Map<string, string>();
	private readonly networkFileSelection = new Map<string, string>();
	/** 无可用 GGUF 文件的仓库：对应卡片不展示 */
	private readonly networkNoFiles = new Set<string>();
	/** 卡片内量化下拉弹出的浮层（全局仅一个） */
	private quantMenuEl: HTMLElement | undefined;
	private readonly quantMenuDisposables = this._register(new DisposableStore());
	/** 模型参数配置浮层（全局仅一个） */
	private paramsPanelEl: HTMLElement | undefined;
	private readonly paramsPanelDisposables = this._register(new DisposableStore());
	/** 卡片内悬停提示（随卡片重建释放） */
	private readonly cardHoverDisposables = this._register(new DisposableStore());
	/** 文件列表请求代次（切换下载源后丢弃旧源在途结果） */
	private networkFileSeq = 0;
	/** 网络卡片体积补全的可见性观察器 */
	private networkSizeObserver: IntersectionObserver | undefined;

	// 音乐生成（audio.cpp / Yue2）
	private musicModels: ILlmModelRecord[] = [];
	private audioEngine: ILlmAudioEngineInfo = { state: 'missing' };
	private musicSelectedModelId = '';
	private musicTitle = '';
	private musicLyrics = '';
	private musicStyle = '';
	private musicCotMode: 'off' | 'melody' | 'full' = 'off';
	private musicSteps = 8;
	private musicSeed = -1;
	private musicThreads = 0;
	private musicBackend: 'auto' | 'metal' | 'cuda' | 'cpu' = 'auto';
	private musicGenerating = false;
	private musicRequestId = '';
	private musicProgress: ILlmMusicProgress | undefined;
	private musicResult: ILlmMusicResult | undefined;
	private musicStatusEl: HTMLElement | undefined;
	private musicProgressFillEl: HTMLElement | undefined;
	private musicPercentEl: HTMLElement | undefined;
	private musicGenerateBtn: HTMLButtonElement | undefined;
	private musicCancelBtn: HTMLButtonElement | undefined;
	private musicAudioEl: HTMLAudioElement | undefined;
	private musicResultEl: HTMLElement | undefined;
	private musicAudioUrl = '';
	private musicDuration = 0;
	private musicStartedAt: number | undefined;
	private musicElapsedEl: HTMLElement | undefined;
	private musicElapsedTimer: number | undefined;
	private musicGraphEl: HTMLElement | undefined;
	private musicEdgesSvg: SVGSVGElement | undefined;
	private musicGraphObserver: ResizeObserver | undefined;
	/** 节点画布布局（拖动 / 缩放后的位置与尺寸，重建 UI 时保留） */
	private readonly musicNodeLayout = new Map<string, { x: number; y: number; width?: number; height?: number }>();
	/** 各节点内容自然宽度（作为最小宽度，缩放时不挤压控件） */
	private readonly musicNodeMinWidths = new Map<string, number>();
	/** 各节点内容自然高度（作为最小高度，缩放 / 重建节点时不裁切、不重叠） */
	private readonly musicNodeMinHeights = new Map<string, number>();
	/** 最小高度测量时的节点宽度（宽度变化后重新量取） */
	private readonly musicNodeHeightBases = new Map<string, number>();
	/** 新渲染的节点待测量自然宽度 */
	private musicMinWidthsPending = false;
	/** 连线弯曲量（拖动曲线手柄调整） */
	private readonly musicEdgeBend = new Map<string, number>();
	/** 节点叠放次序（拖动时置顶） */
	private musicZIndex = 10;

	// 网络结果分页：滚动到底自动追加下一页，直到取完
	private networkPage = 0;
	private networkHasMore = false;
	private networkLoadingMore = false;
	/** 当前网络卡片列表容器（滚动位置保持在重渲染时复用） */
	private networkListEl: HTMLElement | undefined;
	/** 卡片区外层滚动容器（重渲染时保留滚动位置） */
	private cardsScrollEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHoverService private readonly hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
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
		this.inputListeners.add(newInput.onDidChangeCategory(() => this.renderCards()));
		this.inputListeners.add(newInput.onDidRequestLocal(() => this.showLocalTab()));
		this.renderCards();
	}

	override clearInput(): void {
		super.clearInput();
		this.inputListeners.clear();
		this.editorInput = undefined;
	}

	override dispose(): void {
		this.stopMusicElapsed();
		this.musicGraphObserver?.disconnect();
		this.musicGraphObserver = undefined;
		super.dispose();
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	protected createEditor(parent: HTMLElement): void {
		this.container = dom.$('.ishell-llm-models-editor');
		parent.appendChild(this.container);

		this.toolbarEl = dom.$('.ishell-llm-models-toolbar');
		this.container.appendChild(this.toolbarEl);

		this.syslineEl = dom.$('.ishell-llm-sysline');
		this.container.appendChild(this.syslineEl);

		// 模型搜索框（创建一次；网络 Tab 下固定在「可下载仓库」标题旁，输入不丢焦点）
		this.searchEl = document.createElement('input');
		this.searchEl.type = 'text';
		this.searchEl.classList.add('ishell-llm-search');
		this.searchEl.placeholder = localize('ishell.llm.searchPlaceholder', '搜索模型（名称 / 描述 / 厂家）');
		this.searchEl.title = localize('ishell.llm.searchTooltip', '按模型名称、描述或厂家过滤');
		this.searchEl.addEventListener('input', () => {
			this.searchQuery = this.searchEl?.value ?? '';
			this.renderCards();
			// 本地 Tab 下仅过滤本地卡片；网络 Tab 下才触发网络搜索
			if (this.activeTab === 'network') {
				this.scheduleNetworkSearch();
			}
		});

		// 系统信息（左侧对齐，单行省略）
		this.sysinfoEl = dom.$('.ishell-llm-sysinfo.ishell-llm-dim');
		this.syslineEl.appendChild(this.sysinfoEl);

		// 本地模型 / 网络模型分类 Tab（切换时只渲染对应列表）
		this.tabsEl = dom.$('.ishell-llm-tabs');
		this.container.appendChild(this.tabsEl);

		// 网络分区头部：可下载仓库标题 + 数量提示 + 搜索框（仅网络 Tab 显示）
		this.networkHeaderEl = dom.$('.ishell-llm-cards-section.ishell-llm-network-header');
		const networkIcon = document.createElement('span');
		networkIcon.classList.add('codicon', `codicon-${Codicon.cloud.id}`);
		this.networkTitleEl = dom.$('.ishell-llm-cards-section-title');
		this.networkHintEl = dom.$('.ishell-llm-cards-section-hint.ishell-llm-dim');
		this.networkHeaderEl.append(networkIcon, this.networkTitleEl, this.networkHintEl, this.searchEl);
		this.networkHeaderEl.style.display = 'none';
		this.container.appendChild(this.networkHeaderEl);

		const cardsScroll = dom.$('.ishell-llm-cards-scroll');
		this.cardsScrollEl = cardsScroll;
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
				for (const [repo, downloadId] of this.networkDownloadIds) {
					if (downloadId === e.id) {
						this.networkDownloadIds.delete(repo);
					}
				}
				if (e.state === 'failed' && e.error) {
					this.notificationService.error(localize('ishell.llm.downloadFailed', "下载失败：{0}", e.error));
				}
				this.refreshAll();
				return;
			}
			// 进度事件约 200ms 一次：仅就进度条就地更新，避免频繁重建卡片导致闪烁
			const known = this.downloads.has(e.id);
			this.downloads.set(e.id, e);
			if (e.id === 'engine') {
				this.updateToolbarProgress(e);
			} else if (known) {
				this.updateDownloadProgressInPlace(e);
			} else {
				// 首次进度事件：卡片需从「正在启动下载…」切换为进度条，只做一次全量渲染
				this.renderCards();
			}
		}));
		this.listeners.add(this.llmService.onDidChangeModels(() => this.refreshModels()));
		this.listeners.add(this.llmService.onDidChangeEngine(engine => {
			this.engine = engine;
			this.renderToolbar();
			this.renderCards();
		}));
		// 下载源可能从工具栏或命令面板切换：统一在此刷新标题/列表
		this.listeners.add(this.llmService.onDidChangeSource(source => this.applySource(source)));
		// 音乐生成：引擎/附属文件下载进度与推理日志
		this.listeners.add(this.llmService.onDidMusicProgress(e => this.applyMusicProgress(e)));

		// 默认停留在本地 Tab：网络列表在首次切到网络 Tab 时才加载
		this.refreshAll();
	}

	private async refreshAll(): Promise<void> {
		const [catalog, systemInfo, models, source, engine, audioEngine] = await Promise.all([
			this.llmService.getModelCatalog(),
			this.llmService.getSystemInfo(),
			this.llmService.getModels(),
			this.llmService.getSource(),
			this.llmService.getEngineInfo(),
			this.llmService.getAudioEngineInfo(),
		]);
		this.catalog = catalog;
		this.systemInfo = systemInfo;
		this.models = models;
		this.musicModels = models.filter(m => resolveModelKind(m) === 'music');
		this.source = source;
		this.appliedSourceKey = sourceKeyOf(source);
		this.engine = engine;
		this.audioEngine = audioEngine;
		this.renderToolbar();
		this.renderSysline();
		this.renderTabs();
		this.renderCards();
	}

	private async refreshModels(): Promise<void> {
		// 目录中的网络下载条目由已下载记录反推，删除记录后必须同步重取目录，否则卡片残留
		const [catalog, models] = await Promise.all([
			this.llmService.getModelCatalog(),
			this.llmService.getModels(),
		]);
		this.catalog = catalog;
		this.models = models;
		this.musicModels = models.filter(m => resolveModelKind(m) === 'music');
		this.renderTabs();
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
			ver.textContent = ` ${localize('ishell.llm.engineVersion', '引擎版本')} ${this.engine.version}`;
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
			root.appendChild(this.button(localize('ishell.llm.stopModel', '停止模型'), 'ishell-llm-btn-danger', async () => {
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
		sourceBtn.textContent = this.source ? `${localize('ishell.llm.switchSource', '下载源')} · ${this.sourceShortName()}` : localize('ishell.llm.switchSource', '下载源');
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

	// ==== 分类 Tab ====

	/** 渲染「本地模型 / 网络模型」Tab（数量徽章随列表变化） */
	private renderTabs(): void {
		const root = this.tabsEl;
		if (!root) {
			return;
		}
		root.innerText = '';
		const tabs: { id: LlmModelTab; label: string; count: number }[] = [
			{ id: 'local', label: localize('ishell.llm.tabLocal', '本地模型'), count: this.catalog.length },
			{ id: 'network', label: localize('ishell.llm.tabNetwork', '网络模型'), count: this.visibleNetworkModels().length },
			{ id: 'music', label: localize('ishell.llm.tabMusic', '音乐生成'), count: this.musicModels.length },
		];
		for (const tab of tabs) {
			const btn = document.createElement('button');
			btn.classList.add('ishell-llm-tab');
			btn.dataset.tab = tab.id;
			btn.classList.toggle('active', this.activeTab === tab.id);
			btn.addEventListener('click', () => this.selectTab(tab.id));
			const label = document.createElement('span');
			label.textContent = tab.label;
			btn.appendChild(label);
			if (tab.count > 0) {
				const count = document.createElement('span');
				count.classList.add('ishell-llm-tab-count');
				count.textContent = String(tab.count);
				btn.appendChild(count);
			}
			root.appendChild(btn);
		}
	}

	/** 切换 Tab：只渲染对应分类；首次进入网络 Tab 时才发起网络搜索 */
	private selectTab(tab: LlmModelTab): void {
		if (this.activeTab === tab) {
			return;
		}
		if (this.activeTab === 'network' && tab !== 'network') {
			this.resetSearch();
		}
		this.activeTab = tab;
		this.networkListEl = undefined;
		this.renderTabs();
		this.renderCards();
		if (tab === 'network' && (!this.networkLoaded || this.networkQuery !== this.searchQuery.trim())) {
			this.scheduleNetworkSearch();
		}
		if (tab === 'music') {
			void this.refreshAudioEngine();
		}
	}

	/** 左侧分类导航点击：强制切回本地模型 Tab（可能在网络/音乐生成 Tab） */
	private showLocalTab(): void {
		if (this.activeTab === 'network') {
			this.resetSearch();
		}
		if (this.activeTab !== 'local') {
			this.activeTab = 'local';
			this.networkListEl = undefined;
			this.renderTabs();
		}
		this.renderCards();
	}

	/** 离开网络 Tab 时清空搜索（搜索框仅在该分区可见，避免本地列表被隐藏条件过滤） */
	private resetSearch(): void {
		if (this.searchQuery === '') {
			return;
		}
		this.searchQuery = '';
		if (this.searchEl) {
			this.searchEl.value = '';
		}
	}

	/** 进入音乐区时探测音频引擎状态（不自动下载） */
	private async refreshAudioEngine(): Promise<void> {
		try {
			this.audioEngine = await this.llmService.getAudioEngineInfo();
		} catch {
			this.audioEngine = { state: 'missing' };
		}
		if (this.activeTab === 'music' && !this.musicGenerating) {
			this.renderCards();
		}
	}

	// ==== 模型卡片 ====

	private renderCards(): void {
		const root = this.cardsEl;
		if (!root) {
			return;
		}
		// 重渲染前记录滚动位置，避免下载进度/体积补全等刷新把列表弹回顶部
		const listScroll = this.networkListEl?.scrollTop ?? 0;
		const pageScroll = this.cardsScrollEl?.scrollTop ?? 0;
		this.networkListEl = undefined;
		this.closeQuantMenu();
		this.closeParamsPanel();
		this.cardHoverDisposables.clear();
		// 音乐区元素随 cards 重建：重置引用避免更新已移除节点
		this.musicStatusEl = undefined;
		this.musicProgressFillEl = undefined;
		this.musicPercentEl = undefined;
		this.musicGenerateBtn = undefined;
		this.musicCancelBtn = undefined;
		this.musicAudioEl = undefined;
		this.musicResultEl = undefined;
		this.musicElapsedEl = undefined;
		this.musicGraphEl = undefined;
		this.musicEdgesSvg = undefined;
		root.innerText = '';
		// 网络 Tab 使用整高列表：避免 60vh 上限在列表底部留下大片空白
		this.cardsEl?.classList.toggle('ishell-llm-cards-network', this.activeTab === 'network');
		// 网络分区头部只在网络 Tab 显示（标题/搜索框固定在列表上方）
		if (this.networkHeaderEl) {
			this.networkHeaderEl.style.display = this.activeTab === 'network' ? '' : 'none';
		}
		// 网络 Tab：只渲染可下载仓库列表（内部独立滚动，分页懒加载）
		if (this.activeTab === 'network') {
			const networkList = this.renderNetworkSection(root);
			if (networkList && listScroll > 0) {
				networkList.scrollTop = listScroll;
			}
			return;
		}
		// 音乐 Tab：音乐模型选择 + 歌词/风格 + 参数 + 生成与播放器
		if (this.activeTab === 'music') {
			root.appendChild(this.renderMusicSection());
			return;
		}
		const vendorId: LlmVendorFilter = this.editorInput?.vendorId ?? 'all';
		const categoryId = this.editorInput?.categoryId ?? 'all';
		const query = this.searchQuery.trim().toLowerCase();
		// 三重过滤：厂家导航 + 分类导航 + 搜索关键词（名称 / 描述 / 厂家，忽略大小写）
		const entries = this.catalog.filter(e => {
			if (vendorId !== 'all' && e.vendorId !== vendorId) {
				return false;
			}
			if (categoryId !== 'all' && !resolveModelCategories(e).includes(categoryId)) {
				return false;
			}
			if (query !== '' && !`${e.name} ${e.description} ${e.vendorName}`.toLowerCase().includes(query)) {
				return false;
			}
			return true;
		});
		for (const entry of entries) {
			root.appendChild(this.renderModelCard(entry));
		}
		if (entries.length === 0) {
			const empty = document.createElement('div');
			empty.classList.add('ishell-llm-cards-empty', 'ishell-llm-dim');
			empty.textContent = query !== ''
				? localize('ishell.llm.noLocalMatch', '本地目录无匹配模型')
				: categoryId !== 'all'
					? localize('ishell.llm.noCategoryModels', '该分类暂无本地模型，可在「网络模型」Tab 搜索并下载')
					: localize('ishell.llm.noMatch', '未找到匹配的模型');
			root.appendChild(empty);
		}
		// 网络模型不在此处渲染：由「网络模型」Tab 独立展示，避免与本地目录混淆
		if (this.cardsScrollEl && pageScroll > 0) {
			this.cardsScrollEl.scrollTop = pageScroll;
		}
	}

	// ==== 音乐生成区 ====

	private renderMusicSection(): HTMLElement {
		const root = document.createElement('div');
		root.classList.add('ishell-llm-music');

		const header = document.createElement('div');
		header.classList.add('ishell-llm-music-header');
		const title = document.createElement('span');
		title.classList.add('ishell-llm-music-title');
		title.textContent = localize('ishell.llm.musicTitle', '音乐生成（audio.cpp · Yue2）');
		header.appendChild(title);
		const hint = document.createElement('span');
		hint.classList.add('ishell-llm-music-header-hint', 'ishell-llm-dim');
		hint.textContent = localize('ishell.llm.musicWorkflowHint', '节点式工作流：模型 → 歌词 → 风格与参数 → 结果');
		header.appendChild(hint);
		root.appendChild(header);

		const engineLabel: Record<ILlmAudioEngineInfo['state'], string> = {
			missing: localize('ishell.llm.audioEngineMissing', '音频引擎未安装'),
			downloading: localize('ishell.llm.audioEngineDownloading', '音频引擎下载中'),
			ready: localize('ishell.llm.audioEngineReady', '音频引擎已就绪'),
			failed: localize('ishell.llm.audioEngineFailed', '音频引擎下载失败'),
		};
		const engineRow = document.createElement('div');
		engineRow.classList.add('ishell-llm-music-engine');
		const badge = document.createElement('span');
		badge.classList.add('ishell-llm-badge', `ishell-llm-badge-${this.audioEngine.state === 'ready' ? 'ready' : this.audioEngine.state === 'downloading' ? 'downloading' : 'missing'}`);
		badge.textContent = engineLabel[this.audioEngine.state] ?? this.audioEngine.state;
		if (this.audioEngine.version) {
			badge.textContent += ` · ${this.audioEngine.version}`;
		}
		engineRow.appendChild(badge);
		if (this.audioEngine.state === 'missing' || this.audioEngine.state === 'failed') {
			engineRow.appendChild(this.button(localize('ishell.llm.downloadAudioEngine', '下载音频引擎'), 'ishell-llm-btn-primary', async () => {
				this.audioEngine = { state: 'downloading' };
				this.updateMusicStatusUI();
				try {
					await this.llmService.downloadAudioEngine();
					this.audioEngine = await this.llmService.getAudioEngineInfo();
				} catch (err) {
					this.audioEngine = { state: 'failed', detail: (err as Error).message };
					this.notificationService.error((err as Error).message);
				}
				if (this.activeTab === 'music') {
					this.renderCards();
				}
			}));
		}

		if (this.musicModels.length === 0) {
			const empty = document.createElement('div');
			empty.classList.add('ishell-llm-cards-empty', 'ishell-llm-dim');
			empty.textContent = localize('ishell.llm.musicNoModel', '暂无已下载的音乐模型。请先在「本地模型」或「网络模型」中下载 Yue2 音乐模型。');
			root.appendChild(empty);
			const goLocal = this.button(localize('ishell.llm.musicGoLocal', '前往本地模型'), '', () => this.selectTab('local'));
			root.appendChild(goLocal);
			return root;
		}

		if (this.musicSelectedModelId === '' || !this.musicModels.some(m => m.id === this.musicSelectedModelId)) {
			this.musicSelectedModelId = this.musicModels[0].id;
			this.syncMusicParamsFromModel(this.musicModels[0]);
		}

		// ==== 节点式画布：模型加载 → 歌词 → 风格与参数 → 结果 ====
		const graph = document.createElement('div');
		graph.classList.add('ishell-llm-music-graph');
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.classList.add('ishell-llm-music-edges');
		graph.appendChild(svg);

		const modelNode = this.musicNode('model', 'ishell-llm-music-node-model', localize('ishell.llm.musicNodeModel', '模型加载'), localize('ishell.llm.musicNodeModelSub', '引擎 · 模型 · 后端'));
		const lyricsNode = this.musicNode('lyrics', 'ishell-llm-music-node-lyrics', localize('ishell.llm.musicNodeLyrics', '歌词'), localize('ishell.llm.musicNodeLyricsSub', '[verse] / [chorus] 段落标记'));
		const styleNode = this.musicNode('style', 'ishell-llm-music-node-style', localize('ishell.llm.musicNodeStyle', '风格描述及参数'), localize('ishell.llm.musicNodeStyleSub', '风格 · CoT · 步数 · 种子 · 时长'));
		const resultNode = this.musicNode('result', 'ishell-llm-music-node-result', localize('ishell.llm.musicNodeResult', '生成结果及耗时'), localize('ishell.llm.musicNodeResultSub', '输出 WAV · 播放 · 定位'));
		graph.append(modelNode.root, lyricsNode.root, styleNode.root, resultNode.root);

		// 模型选择
		const modelRow = document.createElement('label');
		modelRow.classList.add('ishell-llm-music-row');
		const modelLabel = document.createElement('span');
		modelLabel.classList.add('ishell-llm-music-label');
		modelLabel.textContent = localize('ishell.llm.musicModel', '音乐模型');
		const modelSelect = document.createElement('select');
		modelSelect.classList.add('ishell-llm-params-select', 'ishell-llm-music-select');
		for (const model of this.musicModels) {
			const option = document.createElement('option');
			option.value = model.id;
			option.textContent = `${model.name}${model.file ? ` · ${model.file}` : ''}`;
			modelSelect.appendChild(option);
		}
		modelSelect.value = this.musicSelectedModelId;
		modelSelect.addEventListener('change', () => {
			const model = this.musicModels.find(m => m.id === modelSelect.value);
			if (!model) {
				return;
			}
			this.musicSelectedModelId = model.id;
			this.syncMusicParamsFromModel(model);
			if (this.activeTab === 'music' && !this.musicGenerating) {
				this.renderCards();
			}
		});
		modelRow.append(modelLabel, modelSelect);
		modelNode.body.append(engineRow, modelRow);

		// 歌词
		const titleRow = document.createElement('label');
		titleRow.classList.add('ishell-llm-music-row');
		const titleLabel = document.createElement('span');
		titleLabel.classList.add('ishell-llm-music-label');
		titleLabel.textContent = localize('ishell.llm.musicTitle', '歌名');
		const titleInput = document.createElement('input');
		titleInput.type = 'text';
		titleInput.classList.add('ishell-llm-music-input', 'ishell-llm-music-title-input');
		titleInput.placeholder = localize('ishell.llm.musicTitlePlaceholder', '未填写时按时间命名文件');
		titleInput.value = this.musicTitle;
		// 歌名同时用作输出 WAV 的文件名
		titleInput.addEventListener('input', () => this.musicTitle = titleInput.value);
		titleRow.append(titleLabel, titleInput);

		const lyrics = document.createElement('textarea');
		lyrics.classList.add('ishell-llm-music-textarea', 'ishell-llm-music-lyrics');
		lyrics.rows = 7;
		lyrics.placeholder = localize('ishell.llm.musicLyricsPlaceholder', '[verse]\n夜色落在窗台\n[chorus]\n让风带走所有不安');
		lyrics.value = this.musicLyrics;
		// 高度跟随节点缩放（CSS flex 填充），内容超出时内部滚动
		lyrics.addEventListener('input', () => {
			this.musicLyrics = lyrics.value;
		});
		lyricsNode.body.append(titleRow, lyrics);

		// 风格
		const styleRow = document.createElement('label');
		styleRow.classList.add('ishell-llm-music-style-field');
		const styleLabel = document.createElement('span');
		styleLabel.classList.add('ishell-llm-music-label');
		styleLabel.textContent = localize('ishell.llm.musicStyle', '风格描述');
		const style = document.createElement('textarea');
		style.classList.add('ishell-llm-music-textarea', 'ishell-llm-music-style-input');
		style.rows = 2;
		style.placeholder = localize('ishell.llm.musicStylePlaceholder', 'pop, female vocal, dreamy');
		style.value = this.musicStyle;
		// 风格描述随节点高度一起拉伸，避免缩放后大片留白
		style.addEventListener('input', () => this.musicStyle = style.value);
		styleRow.append(styleLabel, style);
		styleNode.body.appendChild(styleRow);

		// 生成参数：CoT / 步数 / 种子 / 时长
		const paramsRow = document.createElement('div');
		paramsRow.classList.add('ishell-llm-music-params');

		const cotField = this.musicField(localize('ishell.llm.musicCot', 'CoT 模式'), () => {
			const select = document.createElement('select');
			select.classList.add('ishell-llm-params-select');
			for (const value of ['off', 'melody', 'full']) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = value;
				select.appendChild(option);
			}
			select.value = this.musicCotMode;
			select.addEventListener('change', () => this.musicCotMode = select.value as 'off' | 'melody' | 'full');
			return select;
		});

		const stepsField = this.musicField(localize('ishell.llm.musicSteps', '推理步数'), () => {
			const input = this.musicNumberInput(this.musicSteps, 1, 200);
			input.addEventListener('input', () => {
				const value = Number(input.value);
				if (Number.isFinite(value) && value >= 1 && value <= 200) {
					this.musicSteps = Math.round(value);
				}
			});
			return input;
		});

		const seedField = this.musicField(localize('ishell.llm.musicSeed', '随机种子'), () => {
			const input = this.musicNumberInput(this.musicSeed, -1, 2147483647);
			input.addEventListener('input', () => {
				const value = Number(input.value);
				if (Number.isFinite(value) && value >= -1) {
					this.musicSeed = Math.round(value);
				}
			});
			return input;
		});

		const threadsField = this.musicField(localize('ishell.llm.musicThreads', '线程数（0 = 自动）'), () => {
			const input = this.musicNumberInput(this.musicThreads, 0, 256);
			input.addEventListener('input', () => {
				const value = Number(input.value);
				if (Number.isFinite(value) && value >= 0 && value <= 256) {
					this.musicThreads = Math.round(value);
				}
			});
			return input;
		});

		const backendField = this.musicField(localize('ishell.llm.musicBackend', '推理后端'), () => {
			const select = document.createElement('select');
			select.classList.add('ishell-llm-params-select');
			for (const value of ['auto', 'metal', 'cuda', 'cpu'] as const) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = value;
				select.appendChild(option);
			}
			select.value = this.musicBackend;
			select.addEventListener('change', () => this.musicBackend = select.value as 'auto' | 'metal' | 'cuda' | 'cpu');
			return select;
		});

		const durationField = this.musicField(localize('ishell.llm.musicDuration', '时长（秒，0 = 自动）'), () => {
			const input = this.musicNumberInput(this.musicDuration, 0, 600);
			input.addEventListener('input', () => {
				const value = Number(input.value);
				if (Number.isFinite(value) && value >= 0 && value <= 600) {
					this.musicDuration = Math.round(value);
				}
			});
			return input;
		});

		paramsRow.append(cotField, stepsField, seedField, durationField);
		styleNode.body.appendChild(paramsRow);

		const loadParams = document.createElement('div');
		loadParams.classList.add('ishell-llm-music-params');
		loadParams.append(threadsField, backendField);
		modelNode.body.appendChild(loadParams);

		// 操作
		const actions = document.createElement('div');
		actions.classList.add('ishell-llm-music-actions');
		this.musicGenerateBtn = this.button(localize('ishell.llm.musicGenerate', '生成音乐'), 'ishell-llm-btn-primary', () => this.startMusicGeneration());
		this.musicCancelBtn = this.button(localize('ishell.llm.musicCancel', '取消生成'), 'ishell-llm-btn-danger', async () => {
			if (this.musicRequestId !== '') {
				await this.llmService.cancelMusicGeneration(this.musicRequestId);
			}
		});
		actions.append(this.musicGenerateBtn, this.musicCancelBtn);
		resultNode.body.appendChild(actions);

		// 状态 + 耗时 + 进度条（原日志行改为进度条，百分比单独显示）
		const statusRow = document.createElement('div');
		statusRow.classList.add('ishell-llm-music-status-row');
		const status = document.createElement('div');
		status.classList.add('ishell-llm-music-status');
		this.musicStatusEl = status;
		const elapsed = document.createElement('div');
		elapsed.classList.add('ishell-llm-music-elapsed', 'ishell-llm-dim');
		this.musicElapsedEl = elapsed;
		statusRow.append(status, elapsed);
		const progressRow = document.createElement('div');
		progressRow.classList.add('ishell-llm-music-progress-row');
		const progress = document.createElement('div');
		progress.classList.add('ishell-llm-music-progress');
		const fill = document.createElement('div');
		fill.classList.add('ishell-llm-music-progress-fill');
		progress.appendChild(fill);
		this.musicProgressFillEl = fill;
		const percent = document.createElement('span');
		percent.classList.add('ishell-llm-music-percent', 'ishell-llm-dim');
		this.musicPercentEl = percent;
		progressRow.append(progress, percent);
		resultNode.body.append(statusRow, progressRow);

		// 结果
		const result = document.createElement('div');
		result.classList.add('ishell-llm-music-result');
		this.musicResultEl = result;
		resultNode.body.appendChild(result);

		// 连线端口（模型 → 歌词 → 参数 → 结果）
		this.musicPort(modelNode.root, 'model-out', 'right');
		this.musicPort(modelNode.root, 'model-bottom', 'bottom');
		this.musicPort(lyricsNode.root, 'lyrics-in', 'left');
		this.musicPort(lyricsNode.root, 'lyrics-bottom', 'bottom');
		this.musicPort(styleNode.root, 'style-top', 'top');
		this.musicPort(styleNode.root, 'style-out', 'right');
		this.musicPort(resultNode.root, 'result-top', 'top');
		this.musicPort(resultNode.root, 'result-in', 'left');
		root.appendChild(graph);
		this.musicMinWidthsPending = true;

		this.musicGraphEl = graph;
		this.musicEdgesSvg = svg;
		this.musicGraphObserver?.disconnect();
		this.musicGraphObserver = new ResizeObserver(() => this.layoutMusicGraph());
		this.musicGraphObserver.observe(graph);
		for (const node of Array.from(graph.querySelectorAll<HTMLElement>('.ishell-llm-music-node'))) {
			this.musicGraphObserver.observe(node);
		}
		requestAnimationFrame(() => this.layoutMusicGraph());

		if (this.musicResult) {
			elapsed.style.display = '';
			elapsed.textContent = localize('ishell.llm.musicElapsedFinal', '耗时 {0}', formatClock(this.musicResult.elapsedMs / 1000));
		} else if (!this.musicGenerating) {
			elapsed.style.display = 'none';
		}

		this.updateMusicStatusUI();
		this.updateMusicResultUI();
		return root;
	}

	/** 创建节点外壳（标题 + 副标题 + 内容区 + 缩放把手），后期可在此扩展自定义节点 */
	private musicNode(nodeId: string, cls: string, title: string, subtitle: string): { root: HTMLElement; body: HTMLElement } {
		const root = document.createElement('div');
		root.classList.add('ishell-llm-music-node', cls);
		root.dataset.nodeId = nodeId;
		const head = document.createElement('div');
		head.classList.add('ishell-llm-music-node-head');
		const dot = document.createElement('span');
		dot.classList.add('ishell-llm-music-node-dot');
		const titleEl = document.createElement('span');
		titleEl.classList.add('ishell-llm-music-node-title');
		titleEl.textContent = title;
		const sub = document.createElement('span');
		sub.classList.add('ishell-llm-music-node-sub', 'ishell-llm-dim');
		sub.textContent = subtitle;
		head.append(dot, titleEl, sub);
		const body = document.createElement('div');
		body.classList.add('ishell-llm-music-node-body');
		root.append(head, body);

		// 右下角把手调整节点尺寸
		const resize = document.createElement('div');
		resize.classList.add('ishell-llm-music-resize');
		resize.title = localize('ishell.llm.musicNodeResize', '拖动调整节点大小');
		root.appendChild(resize);
		// 标题栏拖动移动节点
		this.bindMusicNodeDrag(root, nodeId, head, 'move');
		this.bindMusicNodeDrag(root, nodeId, resize, 'resize');
		return { root, body };
	}

	private bindMusicNodeDrag(root: HTMLElement, nodeId: string, grip: HTMLElement, mode: 'move' | 'resize'): void {
		grip.addEventListener('pointerdown', (ev: PointerEvent) => {
			if (ev.button !== 0 || (ev.target as HTMLElement).closest('button, input, select, textarea')) {
				return;
			}
			const state = this.musicNodeLayout.get(nodeId);
			if (!state) {
				return;
			}
			ev.preventDefault();
			const startX = ev.clientX;
			const startY = ev.clientY;
			const base = { x: state.x, y: state.y, width: root.offsetWidth, height: root.offsetHeight };
			this.musicZIndex += 1;
			root.style.zIndex = String(this.musicZIndex);
			root.classList.add('ishell-llm-music-node-dragging');
			const onMove = (move: PointerEvent) => {
				const dx = move.clientX - startX;
				const dy = move.clientY - startY;
				if (mode === 'move') {
					state.x = Math.max(0, base.x + dx);
					state.y = Math.max(0, base.y + dy);
					root.style.left = `${state.x}px`;
					root.style.top = `${state.y}px`;
				} else {
					// 最小宽度按内容自然宽度限制，缩放时控件不被挤压变形
					const minWidth = Math.max(260, parseInt(getComputedStyle(root).minWidth, 10) || 0);
					state.width = Math.max(minWidth, base.width + dx);
					root.style.width = `${state.width}px`;
					// 宽度变化会改变参数行换行数：按当前宽度重新量取最小高度，避免内容重叠
					const minHeight = this.measureMusicNodeMinHeight(root);
					state.height = Math.max(minHeight, base.height + dy);
					root.style.height = `${state.height}px`;
				}
				this.layoutMusicGraph();
			};
			const onUp = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				root.classList.remove('ishell-llm-music-node-dragging');
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
		});
	}

	private musicPort(node: HTMLElement, id: string, position: 'left' | 'right' | 'top' | 'bottom'): void {
		const port = document.createElement('span');
		port.classList.add('ishell-llm-music-port', `ishell-llm-music-port-${position}`);
		port.dataset.port = id;
		node.appendChild(port);
	}

	/** 按内容自然宽度设置各节点最小宽度（模型节点按最长文件名自适应） */
	private applyMusicNodeMinWidths(): void {
		const graph = this.musicGraphEl;
		if (!graph) {
			return;
		}
		for (const node of Array.from(graph.querySelectorAll<HTMLElement>('.ishell-llm-music-node'))) {
			const nodeId = node.dataset.nodeId ?? '';
			const prevWidth = node.style.width;
			node.style.minWidth = '0';
			node.style.width = 'max-content';
			// max-content 会把标签、下拉选项（模型文件名）一起算进去
			const natural = Math.ceil(node.getBoundingClientRect().width);
			node.style.width = prevWidth;
			const minWidth = Math.max(nodeId === 'model' ? 340 : 280, Math.min(760, natural));
			node.style.minWidth = `${minWidth}px`;
			this.musicNodeMinWidths.set(nodeId, minWidth);
		}
	}

	/** 在当前宽度下量取节点内容自然高度，写入 minHeight 并返回（宽度变化会改变参数行换行数） */
	private measureMusicNodeMinHeight(node: HTMLElement): number {
		const prevHeight = node.style.height;
		const prevMinHeight = node.style.minHeight;
		node.style.minHeight = '0';
		node.style.height = 'max-content';
		const natural = Math.ceil(node.getBoundingClientRect().height);
		node.style.height = prevHeight;
		node.style.minHeight = prevMinHeight;
		const minHeight = Math.max(160, natural);
		node.style.minHeight = `${minHeight}px`;
		const nodeId = node.dataset.nodeId ?? '';
		this.musicNodeMinHeights.set(nodeId, minHeight);
		this.musicNodeHeightBases.set(nodeId, node.clientWidth);
		return minHeight;
	}

	/** 应用各节点最小高度；宽度变化时重新量取，节点重建后自动补回 */
	private syncMusicNodeMinHeights(): void {
		const graph = this.musicGraphEl;
		if (!graph) {
			return;
		}
		for (const node of Array.from(graph.querySelectorAll<HTMLElement>('.ishell-llm-music-node'))) {
			const nodeId = node.dataset.nodeId ?? '';
			const base = this.musicNodeHeightBases.get(nodeId);
			let minHeight = this.musicNodeMinHeights.get(nodeId);
			if (base === undefined || Math.abs(base - node.clientWidth) > 1 || minHeight === undefined) {
				minHeight = this.measureMusicNodeMinHeight(node);
			} else {
				node.style.minHeight = `${minHeight}px`;
			}
			const state = this.musicNodeLayout.get(nodeId);
			if (state && state.height !== undefined && state.height < minHeight) {
				state.height = minHeight;
				node.style.height = `${minHeight}px`;
			}
		}
	}


	/** 首次渲染按两列摆放节点；之后沿用用户拖动 / 缩放的结果 */
	private ensureMusicNodeLayout(): void {
		const graph = this.musicGraphEl;
		if (!graph) {
			return;
		}
		const ids = ['model', 'lyrics', 'style', 'result'];
		if (ids.every(id => this.musicNodeLayout.has(id))) {
			return;
		}
		const model = graph.querySelector<HTMLElement>('[data-node-id="model"]');
		const lyrics = graph.querySelector<HTMLElement>('[data-node-id="lyrics"]');
		if (!model || !lyrics) {
			return;
		}
		const gap = 48;
		const half = Math.max(260, Math.floor((graph.clientWidth - gap) / 2));
		// 模型节点按模型名称长度铺开；其余节点保持较紧凑但不至于挤压内容
		const modelWidth = Math.max(340, Math.min(760, this.musicNodeMinWidths.get('model') ?? half));
		const styleWidth = Math.max(420, this.musicNodeMinWidths.get('style') ?? half);
		const rightX = modelWidth + gap;
		const maxRight = Math.max(300, graph.clientWidth - rightX - 8);
		const lyricsWidth = Math.min(Math.max(420, this.musicNodeMinWidths.get('lyrics') ?? half), maxRight);
		const resultWidth = Math.min(Math.max(380, this.musicNodeMinWidths.get('result') ?? half), maxRight);
		const rowY = Math.max(model.offsetHeight, lyrics.offsetHeight) + 56;
		this.musicNodeLayout.set('model', { x: 0, y: 0, width: modelWidth });
		this.musicNodeLayout.set('lyrics', { x: rightX, y: 0, width: lyricsWidth });
		this.musicNodeLayout.set('style', { x: 0, y: rowY, width: styleWidth });
		this.musicNodeLayout.set('result', { x: rightX, y: rowY, width: resultWidth });
	}

	private applyMusicNodeLayout(): void {
		const graph = this.musicGraphEl;
		if (!graph) {
			return;
		}
		for (const node of Array.from(graph.querySelectorAll<HTMLElement>('.ishell-llm-music-node'))) {
			const state = this.musicNodeLayout.get(node.dataset.nodeId ?? '');
			if (!state) {
				continue;
			}
			node.style.left = `${state.x}px`;
			node.style.top = `${state.y}px`;
			if (state.width !== undefined) {
				node.style.width = `${state.width}px`;
			}
			if (state.height !== undefined) {
				node.style.height = `${state.height}px`;
			}
		}
	}

	/** 画布高度随节点分布自适应（绝对定位不会自动撑开父级） */
	private updateMusicGraphSize(): number {
		const graph = this.musicGraphEl;
		if (!graph) {
			return 0;
		}
		let bottom = 0;
		for (const node of Array.from(graph.querySelectorAll<HTMLElement>('.ishell-llm-music-node'))) {
			const state = this.musicNodeLayout.get(node.dataset.nodeId ?? '');
			if (state) {
				bottom = Math.max(bottom, state.y + node.offsetHeight);
			}
		}
		const height = bottom + 24;
		graph.style.height = `${height}px`;
		return height;
	}

	/** 按端口实际位置绘制连线：可拖动曲线手柄弯曲，窄容器下退化为单列并隐藏连线 */
	private layoutMusicGraph(): void {
		const graph = this.musicGraphEl;
		const svg = this.musicEdgesSvg;
		if (!graph || !svg || !graph.isConnected) {
			return;
		}
		const width = graph.clientWidth;
		const narrow = width < 640;
		graph.classList.toggle('ishell-llm-music-graph-narrow', narrow);
		svg.replaceChildren();
		if (narrow) {
			svg.style.display = 'none';
			graph.style.height = '';
			return;
		}
		// 首次布局先测量各节点自然宽度（模型节点默认按最长文件名自适应）
		if (this.musicMinWidthsPending) {
			this.musicMinWidthsPending = false;
			this.applyMusicNodeMinWidths();
		}
		this.ensureMusicNodeLayout();
		this.applyMusicNodeLayout();
		this.syncMusicNodeMinHeights();
		svg.style.display = '';
		svg.setAttribute('viewBox', `0 0 ${width} ${this.updateMusicGraphSize()}`);
		svg.setAttribute('width', String(width));
		svg.setAttribute('height', '100%');

		const graphRect = graph.getBoundingClientRect();
		const edges = [
			{ from: 'model-out', to: 'lyrics-in', axis: 'h' as const, accent: 'lyrics' },
			{ from: 'model-bottom', to: 'style-top', axis: 'v' as const, accent: 'style' },
			{ from: 'lyrics-bottom', to: 'result-top', axis: 'v' as const, accent: 'result' },
			{ from: 'style-out', to: 'result-in', axis: 'h' as const, accent: 'style' },
		];
		for (const edge of edges) {
			const from = graph.querySelector<HTMLElement>(`[data-port="${edge.from}"]`);
			const to = graph.querySelector<HTMLElement>(`[data-port="${edge.to}"]`);
			if (!from || !to) {
				continue;
			}
			const fromRect = from.getBoundingClientRect();
			const toRect = to.getBoundingClientRect();
			const sx = fromRect.left - graphRect.left + fromRect.width / 2;
			const sy = fromRect.top - graphRect.top + fromRect.height / 2;
			const tx = toRect.left - graphRect.left + toRect.width / 2;
			const ty = toRect.top - graphRect.top + toRect.height / 2;
			const key = `${edge.from}->${edge.to}`;
			const bend = this.musicEdgeBend.get(key) ?? 0;
			let c1x: number;
			let c1y: number;
			let c2x: number;
			let c2y: number;
			if (edge.axis === 'h') {
				const mx = (sx + tx) / 2 + bend;
				c1x = mx | 0; c1y = sy | 0; c2x = mx | 0; c2y = ty | 0;
			} else {
				const my = (sy + ty) / 2 + bend;
				c1x = sx | 0; c1y = my | 0; c2x = tx | 0; c2y = my | 0;
			}
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.classList.add('ishell-llm-music-edge');
			path.dataset.accent = edge.accent;
			path.setAttribute('d', `M ${sx | 0} ${sy | 0} C ${c1x} ${c1y} ${c2x} ${c2y} ${tx | 0} ${ty | 0}`);
			svg.appendChild(path);

			// 曲线中点手柄：拖动可自由弯曲连线
			const grip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			grip.classList.add('ishell-llm-music-edge-handle');
			grip.dataset.accent = edge.accent;
			grip.setAttribute('cx', String((sx + 3 * c1x + 3 * c2x + tx) / 8));
			grip.setAttribute('cy', String((sy + 3 * c1y + 3 * c2y + ty) / 8));
			grip.setAttribute('r', '5');
			grip.setAttribute('pointer-events', 'all');
			grip.addEventListener('pointerdown', (ev: PointerEvent) => {
				ev.preventDefault();
				ev.stopPropagation();
				const start = edge.axis === 'h' ? ev.clientX : ev.clientY;
				const base = this.musicEdgeBend.get(key) ?? 0;
				const onMove = (move: PointerEvent) => {
					const delta = (edge.axis === 'h' ? move.clientX : move.clientY) - start;
					this.musicEdgeBend.set(key, base + delta);
					this.layoutMusicGraph();
				};
				const onUp = () => {
					window.removeEventListener('pointermove', onMove);
					window.removeEventListener('pointerup', onUp);
				};
				window.addEventListener('pointermove', onMove);
				window.addEventListener('pointerup', onUp);
			});
			svg.appendChild(grip);
		}
	}

	private startMusicElapsed(): void {
		this.stopMusicElapsed();
		this.musicStartedAt = Date.now();
		this.updateMusicElapsed();
		this.musicElapsedTimer = window.setInterval(() => this.updateMusicElapsed(), 1000);
	}

	private stopMusicElapsed(): void {
		if (this.musicElapsedTimer !== undefined) {
			window.clearInterval(this.musicElapsedTimer);
			this.musicElapsedTimer = undefined;
		}
	}

	private updateMusicElapsed(): void {
		if (!this.musicElapsedEl || this.musicStartedAt === undefined) {
			return;
		}
		this.musicElapsedEl.style.display = '';
		this.musicElapsedEl.textContent = localize('ishell.llm.musicElapsedLive', '已用时 {0}', formatClock((Date.now() - this.musicStartedAt) / 1000));
		this.updateMusicPercentUI();
	}

	/**
	 * 引擎生成期间只上报 0%：按已用时估算一个单调递增的百分比，
	 * 避免进度条来回滚动；引擎若给出真实进度则优先使用。
	 */
	private estimateMusicPercent(): number {
		if (this.musicStartedAt === undefined) {
			return 0;
		}
		const elapsed = Date.now() - this.musicStartedAt;
		// Metal 约为 CPU 的 1.5 倍速；按目标时长（0 时按 30 秒）估算总耗时
		const metal = this.musicBackend !== 'cpu';
		const target = this.musicDuration > 0 ? this.musicDuration : 30;
		const expectedMs = (metal ? 5 : 8) * target * 1000 + (metal ? 60 : 120) * 1000;
		const ratio = elapsed / expectedMs;
		// 前段快、后段慢；引擎不回报真实进度，估算值最多到 95%，避免提前显示"快完成"
		return ratio <= 1
			? Math.round(90 * (1 - (1 - ratio) * (1 - ratio)))
			: Math.min(95, Math.round(90 + 5 * (1 - Math.exp(1 - ratio))));
	}

	private updateMusicPercentUI(): void {
		const realPercent = this.musicProgress?.percent;
		if (!this.musicGenerating || (realPercent !== undefined && realPercent > 0)) {
			return;
		}
		const percent = this.estimateMusicPercent();
		if (this.musicPercentEl) {
			this.musicPercentEl.textContent = `${percent}%`;
		}
		if (this.musicProgressFillEl) {
			this.musicProgressFillEl.style.width = `${percent}%`;
		}
	}

	private musicField(label: string, createControl: () => HTMLElement): HTMLElement {
		const field = document.createElement('label');
		field.classList.add('ishell-llm-music-field');
		const text = document.createElement('span');
		text.classList.add('ishell-llm-music-label');
		text.textContent = label;
		field.append(text, createControl());
		return field;
	}

	private musicNumberInput(value: number, min: number, max: number): HTMLInputElement {
		const input = document.createElement('input');
		input.classList.add('ishell-llm-music-input');
		input.type = 'number';
		input.min = String(min);
		input.max = String(max);
		input.step = '1';
		input.value = String(value);
		return input;
	}

	private syncMusicParamsFromModel(model: ILlmModelRecord): void {
		const params = model.params ?? {};
		this.musicCotMode = params.cotMode ?? 'off';
		this.musicSteps = params.numInferenceSteps ?? 8;
		this.musicSeed = params.seed ?? -1;
		this.musicThreads = params.threads ?? 0;
		this.musicBackend = params.audioBackend ?? 'auto';
		this.musicDuration = params.durationSeconds ?? 0;
	}

	private async startMusicGeneration(): Promise<void> {
		// 防止重渲染后按钮恢复可用时重复触发（多个引擎同时加载模型会耗尽内存）
		if (this.musicGenerating) {
			return;
		}
		const model = this.musicModels.find(m => m.id === this.musicSelectedModelId);
		if (!model) {
			this.notificationService.error(localize('ishell.llm.musicSelectModel', '请先选择音乐模型'));
			return;
		}
		if (this.musicLyrics.trim() === '') {
			this.notificationService.error(localize('ishell.llm.musicLyricsRequired', '请先填写歌词'));
			return;
		}
		// 引擎不接受空的 style= 取值（会直接退出），风格描述必填
		if (this.musicStyle.trim() === '') {
			this.notificationService.error(localize('ishell.llm.musicStyleRequired', '请先填写风格描述（如 pop, female vocal, dreamy）'));
			return;
		}
		this.musicGenerating = true;
		this.musicRequestId = '';
		this.musicResult = undefined;
		this.musicAudioUrl = '';
		this.musicProgress = { requestId: '', modelId: model.id, state: 'preparing', message: localize('ishell.llm.musicPreparing', '准备生成…') };
		this.startMusicElapsed();
		this.updateMusicStatusUI();
		this.updateMusicResultUI();
		try {
			const result = await this.llmService.generateMusic({
				modelId: model.id,
				title: this.musicTitle.trim(),
				lyrics: this.musicLyrics,
				style: this.musicStyle,
				cotMode: this.musicCotMode,
				steps: this.musicSteps,
				seed: this.musicSeed,
				threads: this.musicThreads,
				audioBackend: this.musicBackend,
				durationSeconds: this.musicDuration,
			});
			this.musicResult = result;
			this.updateMusicResultUI();
			try {
				const base64 = await this.llmService.readMusicAudio(result.filePath);
				// data URL 在较长音频（>2MB）上会被浏览器拒载，改用 Blob URL
				if (this.musicAudioUrl.startsWith('blob:')) {
					URL.revokeObjectURL(this.musicAudioUrl);
				}
				this.musicAudioUrl = wavBlobUrl(base64);
				if (this.musicAudioEl) {
					this.musicAudioEl.src = this.musicAudioUrl;
					void this.musicAudioEl.play().catch(() => undefined);
				}
			} catch (err) {
				this.notificationService.error((err as Error).message);
			}
			this.notificationService.info(localize('ishell.llm.musicDone', '音乐生成完成：{0}', result.filePath));
		} catch (err) {
			if (this.musicProgress?.state !== 'canceled') {
				this.notificationService.error((err as Error).message);
			}
		} finally {
			this.musicGenerating = false;
			this.stopMusicElapsed();
			if (this.musicElapsedEl) {
				if (this.musicResult) {
					this.musicElapsedEl.style.display = '';
					this.musicElapsedEl.textContent = localize('ishell.llm.musicElapsedFinal', '耗时 {0}', formatClock(this.musicResult.elapsedMs / 1000));
				} else {
					// 取消 / 失败后不再保留计时文案，避免看起来仍在生成
					this.musicElapsedEl.style.display = 'none';
				}
			}
			this.updateMusicStatusUI();
		}
	}

	private applyMusicProgress(progress: ILlmMusicProgress): void {
		if (progress.requestId === 'audio-engine') {
			// 音频引擎下载（手动或生成前自动）：同步引擎徽章；生成中同时展示状态/进度
			this.audioEngine = progress.state === 'downloading-engine'
				? { state: 'downloading', detail: progress.message }
				: this.audioEngine;
			if (this.musicGenerating) {
				this.musicProgress = progress;
			}
			this.updateMusicStatusUI();
			return;
		}
		if (progress.requestId !== this.musicRequestId && !this.musicGenerating) {
			// 非本次生成的进度（例如另一窗口触发的引擎下载）：仅同步引擎状态
			if (progress.state === 'downloading-engine') {
				this.audioEngine = { state: 'downloading', detail: progress.message };
			}
			return;
		}
		if (progress.requestId !== '') {
			this.musicRequestId = progress.requestId;
		}
		this.musicProgress = progress;
		if (progress.state === 'downloading-engine') {
			this.audioEngine = { state: 'downloading', detail: progress.message };
		}
		if (progress.state === 'completed' || progress.state === 'failed' || progress.state === 'canceled') {
			this.musicGenerating = false;
		}
		this.updateMusicStatusUI();
	}

	private updateMusicStatusUI(): void {
		const generating = this.musicGenerating;
		if (this.musicGenerateBtn) {
			this.musicGenerateBtn.disabled = generating;
			this.musicGenerateBtn.classList.toggle('ishell-llm-btn-busy', generating);
		}
		if (this.musicCancelBtn) {
			this.musicCancelBtn.style.display = generating ? '' : 'none';
			this.musicCancelBtn.disabled = this.musicRequestId === '';
		}
		const progress = this.musicProgress;
		const realPercent = progress?.percent;
		const percent = realPercent !== undefined && realPercent > 0
			? realPercent
			: (generating ? this.estimateMusicPercent() : undefined);
		if (this.musicProgressFillEl) {
			this.musicProgressFillEl.style.width = `${Math.min(100, Math.max(0, percent ?? 0))}%`;
		}
		if (this.musicPercentEl) {
			this.musicPercentEl.textContent = percent !== undefined ? `${Math.round(percent)}%` : '';
		}
		if (this.musicStatusEl) {
			if (!progress) {
				this.musicStatusEl.textContent = localize('ishell.llm.musicIdle', '填写歌词与风格后点击「生成音乐」');
			} else {
				// 逐行日志型进度不带 message，生成中回落到固定文案；此时不拼接百分比，避免出现「正在生成音乐… · 0%」
				const message = progress.message ?? (progress.state === 'generating'
					? localize('ishell.llm.musicGenerating', '正在生成音乐…')
					: '');
				const percent = progress.message && progress.percent !== undefined && progress.percent > 0 ? ` · ${Math.round(progress.percent)}%` : '';
				this.musicStatusEl.textContent = `${message}${percent}`;
				this.musicStatusEl.title = message;
			}
		}
	}

	private updateMusicResultUI(): void {
		const box = this.musicResultEl;
		if (!box) {
			return;
		}
		box.innerText = '';
		if (!this.musicResult) {
			box.style.display = 'none';
			this.musicAudioEl = undefined;
			return;
		}
		box.style.display = '';
		const head = document.createElement('div');
		head.classList.add('ishell-llm-music-result-head');
		const title = document.createElement('span');
		title.textContent = localize('ishell.llm.musicResultTitle', '输出文件');
		const reveal = this.button(localize('ishell.llm.musicReveal', '在文件夹中显示'), '', async () => {
			if (this.musicResult) {
				await this.llmService.revealMusicFile(this.musicResult.filePath);
			}
		});
		head.append(title, reveal);
		box.appendChild(head);

		const path = document.createElement('div');
		path.classList.add('ishell-llm-music-path', 'ishell-llm-dim');
		path.textContent = this.musicResult.filePath;
		path.title = this.musicResult.filePath;
		box.appendChild(path);

		const meta = document.createElement('div');
		meta.classList.add('ishell-llm-music-meta', 'ishell-llm-dim');
		const elapsedText = document.createElement('span');
		elapsedText.textContent = localize('ishell.llm.musicElapsedFinal', '耗时 {0}', formatClock(this.musicResult.elapsedMs / 1000));
		const lengthText = document.createElement('span');
		lengthText.textContent = localize('ishell.llm.musicAudioLength', '音频时长 --:--');
		meta.append(elapsedText, lengthText);
		box.appendChild(meta);

		const audio = document.createElement('audio');
		audio.classList.add('ishell-llm-music-audio');
		audio.preload = 'metadata';
		if (this.musicAudioUrl !== '') {
			audio.src = this.musicAudioUrl;
		}
		this.musicAudioEl = audio;

		// 自绘播放器：原生 <audio controls> 是白色控件，与深色主题不协调
		const player = document.createElement('div');
		player.classList.add('ishell-llm-music-player');
		const toggle = document.createElement('button');
		toggle.classList.add('ishell-llm-music-player-toggle');
		const icon = document.createElement('span');
		const playIcon = `codicon-${Codicon.play.id}`;
		const pauseIcon = `codicon-${Codicon.debugPause.id}`;
		icon.classList.add('codicon', playIcon);
		toggle.appendChild(icon);
		toggle.title = localize('ishell.llm.musicPlay', '播放');
		const seek = document.createElement('input');
		seek.type = 'range';
		seek.min = '0';
		seek.max = '1000';
		seek.value = '0';
		seek.classList.add('ishell-llm-music-seek');
		seek.style.setProperty('--ishell-seek', '0%');
		const time = document.createElement('span');
		time.classList.add('ishell-llm-music-time', 'ishell-llm-dim');
		time.textContent = '00:00 / 00:00';
		player.append(toggle, seek, time);
		box.append(player, audio);

		const setPlaying = (playing: boolean) => {
			icon.classList.toggle(playIcon, !playing);
			icon.classList.toggle(pauseIcon, playing);
			toggle.title = playing
				? localize('ishell.llm.musicPause', '暂停')
				: localize('ishell.llm.musicPlay', '播放');
		};
		toggle.addEventListener('click', () => {
			if (audio.paused) {
				void audio.play().catch(() => setPlaying(false));
			} else {
				audio.pause();
			}
		});
		audio.addEventListener('play', () => setPlaying(true));
		audio.addEventListener('pause', () => setPlaying(false));
		audio.addEventListener('ended', () => setPlaying(false));
		seek.addEventListener('input', () => {
			const ratio = Number(seek.value) / 1000;
			seek.style.setProperty('--ishell-seek', `${ratio * 100}%`);
			if (Number.isFinite(audio.duration) && audio.duration > 0) {
				audio.currentTime = audio.duration * ratio;
				time.textContent = `${formatClock(audio.duration * ratio)} / ${formatClock(audio.duration)}`;
			}
		});
		audio.addEventListener('loadedmetadata', () => {
			const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
			time.textContent = `00:00 / ${formatClock(duration)}`;
			lengthText.textContent = localize('ishell.llm.musicAudioLength', '音频时长 {0}', formatClock(duration));
		});
		audio.addEventListener('timeupdate', () => {
			const duration = audio.duration;
			if (!Number.isFinite(duration) || duration <= 0) {
				return;
			}
			const ratio = Math.min(1, audio.currentTime / duration);
			seek.value = String(Math.round(ratio * 1000));
			seek.style.setProperty('--ishell-seek', `${ratio * 100}%`);
			time.textContent = `${formatClock(audio.currentTime)} / ${formatClock(duration)}`;
		});
	}

	// ==== 网络模型分区（搜索结果 → 可下载卡片） ====

	/** 分区标题（通栏）+ 搜索中/空态提示 + 结果卡片；返回网络卡片列表容器（无结果时 undefined） */
	private renderNetworkSection(root: HTMLElement): HTMLElement | undefined {
		const query = this.searchQuery.trim();
		// 标题与搜索框是固定节点（见 createEditor），这里只更新文案
		if (this.networkTitleEl) {
			this.networkTitleEl.textContent = localize('ishell.llm.networkSection', '可下载仓库（{0}）', this.networkSourceName());
		}
		if (this.networkHintEl) {
			this.networkHintEl.textContent = this.networkHintText();
		}
		this.networkHeaderEl?.style.removeProperty('display');

		if (this.networkResults.length === 0) {
			const note = document.createElement('div');
			note.classList.add('ishell-llm-cards-note', 'ishell-llm-dim');
			if (this.networkLoading || this.networkQuery !== query) {
				note.textContent = localize('ishell.llm.networkSearchingHint', '正在搜索网络模型…');
			} else {
				note.textContent = localize('ishell.llm.networkEmpty', '网络搜索无结果（或网络不可达）');
			}
			root.appendChild(note);
			return undefined;
		}
		// 全部结果放入独立滚动区：滚动到底自动加载下一页，直到源站取完
		const list = document.createElement('div');
		list.classList.add('ishell-llm-network-list');
		for (const model of this.visibleNetworkModels()) {
			list.appendChild(this.renderNetworkCard(model));
		}
		list.appendChild(this.buildNetworkFooter());
		list.addEventListener('scroll', () => {
			if (this.networkHasMore && !this.networkLoadingMore
				&& list.scrollTop + list.clientHeight >= list.scrollHeight - 240) {
				void this.loadMoreNetworkModels(list);
			}
		});
		root.appendChild(list);
		this.networkListEl = list;
		// 体积异步补全：滚动到可视区后再请求，取到后仅刷新该卡片规格行
		this.observeNetworkSizes(list);
		return list;
	}

	private buildNetworkFooter(): HTMLElement {
		const footer = document.createElement('div');
		footer.classList.add('ishell-llm-network-note', 'ishell-llm-dim');
		footer.textContent = this.networkFooterText();
		return footer;
	}

	/** 可见的网络模型（排除已确认无 GGUF 文件的仓库） */
	private visibleNetworkModels(): ILlmNetworkModel[] {
		return this.networkResults.filter(m => !this.networkNoFiles.has(m.id));
	}

	private networkHintText(): string {
		if (this.networkLoading) {
			return localize('ishell.llm.networkSearching', '正在搜索…');
		}
		const count = this.visibleNetworkModels().length;
		if (count === 0) {
			return '';
		}
		return this.networkHasMore
			? localize('ishell.llm.networkCountMore', '已加载 {0} 个，滚动继续', String(count))
			: localize('ishell.llm.networkCount', '{0} 个可下载仓库', String(count));
	}

	private updateNetworkHint(): void {
		if (this.networkHintEl) {
			this.networkHintEl.textContent = this.networkHintText();
		}
	}

	private networkFooterText(): string {
		if (this.networkLoadingMore) {
			return localize('ishell.llm.networkLoadingMore', '正在加载更多…');
		}
		const count = this.visibleNetworkModels().length;
		if (this.networkHasMore) {
			return localize('ishell.llm.networkScrollMore', '滚动到底继续加载（已加载 {0} 个）', String(count));
		}
		return localize('ishell.llm.networkAllLoaded', '已加载全部 {0} 个仓库', String(count));
	}

	private updateNetworkFooter(): void {
		const footer = this.networkListEl?.querySelector<HTMLElement>('.ishell-llm-network-note');
		if (footer) {
			footer.textContent = this.networkFooterText();
		}
	}

	/** 加载下一页并按追加方式插入（保持当前滚动位置） */
	private async loadMoreNetworkModels(list: HTMLElement): Promise<void> {
		if (this.networkLoadingMore || !this.networkHasMore || this.networkLoading) {
			return;
		}
		const query = this.searchQuery.trim();
		const seq = this.networkSeq;
		this.networkLoadingMore = true;
		this.updateNetworkFooter();
		try {
			const page = await this.llmService.searchNetworkModels(query, this.networkPage + 1);
			if (seq !== this.networkSeq || this.searchQuery.trim() !== query) {
				return;
			}
			this.networkPage++;
			const seen = new Set(this.networkResults.map(m => m.id));
			const fresh = page.filter(m => !seen.has(m.id));
			this.networkResults.push(...fresh);
			this.networkHasMore = page.length >= LLM_NETWORK_PAGE_SIZE;
			if (this.networkListEl === list && list.isConnected) {
				const footer = list.querySelector<HTMLElement>('.ishell-llm-network-note');
				for (const model of fresh.filter(m => !this.networkNoFiles.has(m.id))) {
					list.insertBefore(this.renderNetworkCard(model), footer ?? null);
				}
				this.observeNetworkSizes(list);
			} else {
				this.renderCards();
			}
		} catch {
			this.networkHasMore = false;
		} finally {
			this.networkLoadingMore = false;
			this.updateNetworkFooter();
			this.updateNetworkHint();
		}
	}

	/** 网络卡片滚动进入可视区后再补全体积（避免一次并发大量请求触发源站限流） */
	private observeNetworkSizes(list: HTMLElement): void {
		this.networkSizeObserver?.disconnect();
		this.networkSizeObserver = undefined;
		if (typeof IntersectionObserver === 'undefined') {
			for (const model of this.networkResults.slice(0, 3)) {
				void this.ensureNetworkSize(model.id);
			}
			return;
		}
		const observer = new IntersectionObserver(entries => {
			for (const entry of entries) {
				if (!entry.isIntersecting) {
					continue;
				}
				observer.unobserve(entry.target);
				const repo = (entry.target as HTMLElement).dataset.repo;
				if (repo) {
					void this.ensureNetworkSize(repo);
				}
			}
		}, { root: list, rootMargin: '160px 0px' });
		for (const card of Array.from(list.children)) {
			if (card instanceof HTMLElement && card.dataset.repo) {
				observer.observe(card);
			}
		}
		this.networkSizeObserver = observer;
	}

	/** 查询单个仓库最小 GGUF 体积（失败记 -1 不再重试） */
	private async ensureNetworkSize(repoId: string | undefined): Promise<void> {
		if (!repoId || this.networkSizes.has(repoId) || this.networkSizePending.has(repoId)) {
			return;
		}
		this.networkSizePending.add(repoId);
		const seq = this.networkSizeSeq;
		try {
			const files = await this.llmService.listNetworkModelFiles(repoId);
			if (seq !== this.networkSizeSeq) {
				return;
			}
			const known = files.filter(f => f.sizeBytes !== undefined && f.sizeBytes > 0).map(f => f.sizeBytes as number);
			this.networkSizes.set(repoId, known.length > 0 ? Math.min(...known) : -1);
			this.networkFiles.set(repoId, files);
			this.networkFileErrors.delete(repoId);
			if (files.length === 0) {
				// 无可用 GGUF 文件：该仓库不展示
				this.removeNetworkCard(repoId);
				return;
			}
		} catch (err) {
			if (seq !== this.networkSizeSeq) {
				return;
			}
			this.networkSizes.set(repoId, -1);
			this.networkFileErrors.set(repoId, (err as Error).message);
		} finally {
			this.networkSizePending.delete(repoId);
		}
		if (seq === this.networkSizeSeq) {
			this.updateNetworkCardSpec(repoId);
			this.refreshNetworkCardActions(repoId);
		}
	}

	/** 无可用 GGUF 文件的仓库：标记为不展示并移除已渲染的卡片 */
	private removeNetworkCard(repoId: string): void {
		if (this.networkNoFiles.has(repoId)) {
			return;
		}
		this.networkNoFiles.add(repoId);
		this.closeQuantMenu();
		const list = this.networkListEl;
		if (list) {
			for (const card of Array.from(list.querySelectorAll<HTMLElement>('.ishell-llm-card-network'))) {
				if (card.dataset.repo === repoId) {
					card.remove();
				}
			}
			if (list.querySelectorAll('.ishell-llm-card-network').length === 0) {
				const note = document.createElement('div');
				note.classList.add('ishell-llm-cards-note', 'ishell-llm-dim');
				note.textContent = localize('ishell.llm.networkNoVisible', '当前搜索结果的仓库均无可用 GGUF 文件');
				list.insertBefore(note, list.firstChild);
			}
		}
		this.updateNetworkHint();
		this.updateNetworkFooter();
		this.renderTabs();
	}

	/** 文件列表到达后就地刷新该卡片的量化下拉（不整页重渲染，保持滚动位置） */
	private refreshNetworkCardActions(repoId: string): void {
		if (!this.cardsEl || this.networkBusy.has(repoId) || this.networkDownloadIds.has(repoId)) {
			return;
		}
		const model = this.networkResults.find(m => m.id === repoId);
		if (!model) {
			return;
		}
		for (const card of Array.from(this.cardsEl.querySelectorAll<HTMLElement>('.ishell-llm-card-network'))) {
			if (card.dataset.repo !== repoId) {
				continue;
			}
			const actions = card.querySelector<HTMLElement>('.ishell-llm-card-actions');
			if (!actions) {
				continue;
			}
			actions.innerText = '';
			this.renderQuantPicker(actions, model);
		}
	}

	/** 仅刷新单张卡片的规格行，避免整页重渲染 */
	private updateNetworkCardSpec(repoId: string): void {
		const size = this.networkSizes.get(repoId);
		const model = this.networkResults.find(m => m.id === repoId);
		if (size === undefined || !model || !this.cardsEl) {
			return;
		}
		for (const card of Array.from(this.cardsEl.querySelectorAll<HTMLElement>('.ishell-llm-card-network'))) {
			if (card.dataset.repo !== repoId) {
				continue;
			}
			const spec = card.querySelector<HTMLElement>('.ishell-llm-card-spec');
			if (spec) {
				spec.textContent = localize('ishell.llm.networkSpec', "下载 {0} · 赞 {1} · 体积 {2}",
					formatDownloads(model.downloads), formatDownloads(model.likes), size > 0 ? formatSize(size) : '—');
			}
		}
	}

	private renderNetworkCard(model: ILlmNetworkModel): HTMLElement {
		const downloaded = this.models.filter(m => m.repo === model.id);
		const busy = this.networkBusy.has(model.id);
		const downloadId = this.networkDownloadIds.get(model.id);
		const progress = downloadId ? this.downloads.get(downloadId) : undefined;

		const card = document.createElement('div');
		card.classList.add('ishell-llm-card', 'ishell-llm-card-network');
		card.dataset.repo = model.id;

		const head = document.createElement('div');
		head.classList.add('ishell-llm-card-head');
		head.appendChild(renderBrandIcon(networkBrandOf(model), 'lg', Codicon.remote, model.id));
		const name = document.createElement('span');
		name.classList.add('ishell-llm-card-name');
		name.textContent = model.name;
		name.title = model.id;
		head.appendChild(name);
		if (downloaded.length > 0) {
			const badge = document.createElement('span');
			badge.classList.add('ishell-llm-badge', 'ishell-llm-badge-downloaded');
			badge.textContent = localize('ishell.llm.downloaded', '已下载');
			head.appendChild(badge);
		}
		const tag = document.createElement('span');
		tag.classList.add('ishell-llm-card-tag', 'ishell-llm-card-tag-network');
		tag.textContent = localize('ishell.llm.networkTag', '网络');
		head.appendChild(tag);
		card.appendChild(head);

		const desc = document.createElement('div');
		desc.classList.add('ishell-llm-card-desc', 'ishell-llm-dim');
		desc.textContent = model.id;
		card.appendChild(desc);

		// 已下载的量化文件：直接标注在卡片上（量化标签 + 实际体积，悬停显示完整文件名）
		if (downloaded.length > 0) {
			const quants = document.createElement('div');
			quants.classList.add('ishell-llm-card-quants');
			for (const record of downloaded) {
				const file = record.file ?? '';
				const chip = document.createElement('span');
				chip.classList.add('ishell-llm-card-quant');
				chip.textContent = `${quantLabelOf(file)} · ${formatSize(record.sizeBytes)}`;
				chip.title = localize('ishell.llm.downloadedFile', '已下载：{0}', file);
				quants.appendChild(chip);
			}
			card.appendChild(quants);
		}

		const size = this.networkSizes.get(model.id);
		const spec = document.createElement('div');
		spec.classList.add('ishell-llm-card-spec', 'ishell-llm-dim');
		spec.textContent = localize('ishell.llm.networkSpec', "下载 {0} · 赞 {1} · 体积 {2}",
			formatDownloads(model.downloads), formatDownloads(model.likes), size !== undefined && size > 0 ? formatSize(size) : '—');
		card.appendChild(spec);

		const actions = document.createElement('div');
		actions.classList.add('ishell-llm-card-actions');
		if (progress && progress.state === 'downloading') {
			actions.appendChild(this.buildProgressBar(progress, true));
			actions.appendChild(this.iconButton(Codicon.stopCircle, localize('ishell.llm.cancelDownload', '取消下载'), async () => {
				await this.llmService.cancelDownload(progress.id);
			}));
		} else if (busy) {
			const wait = this.button(localize('ishell.llm.networkQuerying', '正在启动下载…'), '', () => undefined);
			wait.disabled = true;
			actions.appendChild(wait);
		} else {
			this.renderQuantPicker(actions, model);
		}
		card.appendChild(actions);
		return card;
	}

	/** 卡片内量化下拉：加载中 / 失败 / 无文件 / 文件选择 + 下载按钮 */
	private renderQuantPicker(actions: HTMLElement, model: ILlmNetworkModel): void {
		const files = this.networkFiles.get(model.id);
		const error = this.networkFileErrors.get(model.id);

		if (error) {
			const note = document.createElement('span');
			note.classList.add('ishell-llm-card-desc', 'ishell-llm-dim');
			note.textContent = localize('ishell.llm.quantLoadFailed', '量化文件加载失败');
			note.title = error;
			actions.appendChild(note);
			actions.appendChild(this.button(localize('ishell.llm.retry', '重试'), '', () => {
				this.networkFileErrors.delete(model.id);
				void this.loadNetworkFiles(model, true);
			}));
			return;
		}
		if (!files) {
			const wait = this.button(localize('ishell.llm.networkQuerying', '加载量化中…'), '', () => undefined);
			wait.disabled = true;
			actions.appendChild(wait);
			return;
		}
		if (files.length === 0) {
			// 空结果会在 loadNetworkFiles 中折叠为无文件提示，此处兜底展示说明
			const note = document.createElement('span');
			note.classList.add('ishell-llm-card-desc', 'ishell-llm-dim');
			note.textContent = localize('ishell.llm.networkNoFiles', '该仓库无可用 GGUF 文件');
			actions.appendChild(note);
			return;
		}

		// 自绘下拉触发器：量化标签 + 内存状态徽标（原生 select 无法逐项着色/悬停提示）
		const availableBytes = this.availableMemoryBytes();
		const trigger = document.createElement('button');
		trigger.type = 'button';
		trigger.classList.add('ishell-llm-quant-trigger');
		const labelEl = document.createElement('span');
		labelEl.classList.add('ishell-llm-quant-label');
		const statusEl = document.createElement('span');
		statusEl.classList.add('ishell-llm-quant-status');
		const chevron = document.createElement('span');
		chevron.classList.add('codicon', `codicon-${Codicon.chevronDown.id}`, 'ishell-llm-quant-chevron');
		trigger.append(labelEl, statusEl, chevron);
		actions.appendChild(trigger);

		let current = this.selectedFileOf(model, files);
		const paint = (): void => {
			const status = this.quantMemoryStatus(current, availableBytes);
			labelEl.textContent = `${quantLabelOf(current.file)} · ${this.sizeTextOf(current)}`;
			labelEl.title = current.file;
			statusEl.textContent = status.badge;
			statusEl.className = `ishell-llm-quant-status ${status.kind}`;
		};
		paint();

		// 悬停触发器：按当前选中文件给出内存说明（工作台主题提示，非弹窗）
		this.cardHoverDisposables.add(this.hoverService.setupDelayedHover(trigger, () => ({
			content: this.quantMemoryStatus(current, availableBytes).detail,
		})));

		trigger.addEventListener('click', () => {
			this.openQuantMenu(trigger, files, current, file => {
				current = file;
				this.networkFileSelection.set(model.id, file.file);
				paint();
			});
		});

		actions.appendChild(this.button(localize('ishell.llm.startDownload', '下载'), 'ishell-llm-btn-primary', () => {
			void this.downloadNetworkFile(model, current.file);
		}));
	}

	/** 当前可用内存（字节）；取不到系统信息时返回 undefined */
	private availableMemoryBytes(): number | undefined {
		const info = this.systemInfo;
		if (!info || info.availableMemGb <= 0) {
			return undefined;
		}
		return info.availableMemGb * 1024 * 1024 * 1024;
	}

	/** 量化下拉中已选中的文件（缺省取第一个，按体积升序） */
	private selectedFileOf(model: ILlmNetworkModel, files: ILlmNetworkFile[]): ILlmNetworkFile {
		const selected = this.networkFileSelection.get(model.id);
		const file = (selected ? files.find(f => f.file === selected) : undefined) ?? files[0];
		this.networkFileSelection.set(model.id, file.file);
		return file;
	}

	private sizeTextOf(file: ILlmNetworkFile): string {
		return file.sizeBytes !== undefined && file.sizeBytes > 0 ? formatSize(file.sizeBytes) : localize('ishell.llm.sizeUnknown', '未知体积');
	}

	/** 量化文件的内存状态：颜色徽标 + 悬停说明 */
	private quantMemoryStatus(file: ILlmNetworkFile, availableBytes: number | undefined): { kind: 'risk' | 'ok' | 'unknown'; badge: string; detail: string } {
		const info = this.systemInfo;
		if (!file.sizeBytes || file.sizeBytes <= 0 || !availableBytes) {
			return {
				kind: 'unknown',
				badge: localize('ishell.llm.memUnknownBadge', '体积未知'),
				detail: localize('ishell.llm.memUnknownDetail', '未获取到该量化文件的体积，无法评估内存占用。'),
			};
		}
		const totalText = info ? `${info.totalMemGb} GB` : '未知';
		if (file.sizeBytes > availableBytes) {
			return {
				kind: 'risk',
				badge: localize('ishell.llm.memRiskBadge', '内存不足'),
				detail: localize('ishell.llm.memRiskDetail2',
					'此模型可能需要约 {0} 内存，超过当前可用内存（约 {1}，总内存 {2}）。\n下载后可能无法加载，或运行时出现卡顿、被系统强制终止。建议选择体积更小的量化版本，或先释放其他程序占用的内存。',
					formatSize(file.sizeBytes), formatSize(availableBytes), totalText),
			};
		}
		return {
			kind: 'ok',
			badge: localize('ishell.llm.memOkBadge', '内存充足'),
			detail: localize('ishell.llm.memOkDetail',
				'此模型可能需要约 {0} 内存，低于当前可用内存（约 {1}，总内存 {2}），通常可以正常加载。',
				formatSize(file.sizeBytes), formatSize(availableBytes), totalText),
		};
	}

	/** 打开量化下拉浮层：每行带状态徽标与悬停说明，选中即回写当前值 */
	private openQuantMenu(trigger: HTMLElement, files: ILlmNetworkFile[], current: ILlmNetworkFile, onSelect: (file: ILlmNetworkFile) => void): void {
		this.closeQuantMenu();
		const availableBytes = this.availableMemoryBytes();
		const menu = document.createElement('div');
		menu.classList.add('ishell-llm-quant-menu');
		for (const file of files) {
			const status = this.quantMemoryStatus(file, availableBytes);
			const row = document.createElement('div');
			row.classList.add('ishell-llm-quant-option');
			row.classList.toggle('selected', file.file === current.file);
			const name = document.createElement('span');
			name.classList.add('ishell-llm-quant-option-label');
			name.textContent = quantLabelOf(file.file);
			const size = document.createElement('span');
			size.classList.add('ishell-llm-quant-option-size');
			size.textContent = this.sizeTextOf(file);
			const badge = document.createElement('span');
			badge.classList.add('ishell-llm-quant-status', status.kind);
			badge.textContent = status.badge;
			row.append(name, size, badge);
			row.addEventListener('click', () => {
				onSelect(file);
				this.closeQuantMenu();
			});
			this.quantMenuDisposables.add(this.hoverService.setupDelayedHover(row, () => ({ content: status.detail })));
			menu.appendChild(row);
		}
		// 挂到工作台根容器内：与悬停提示同一层叠上下文，z-index 低于 hover（2576）才不会被浮层压住
		const host = document.querySelector<HTMLElement>('.monaco-workbench') ?? document.body;
		host.appendChild(menu);

		// 浮层挂在 body 上做固定定位，避免被列表滚动容器裁切；空间不足时向上翻转
		const rect = trigger.getBoundingClientRect();
		const menuRect = menu.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
		const top = rect.bottom + menuRect.height + 8 > window.innerHeight
			? Math.max(8, rect.top - menuRect.height - 4)
			: rect.bottom + 4;
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
		this.quantMenuEl = menu;

		this.quantMenuDisposables.add(dom.addDisposableListener(document, 'mousedown', (e: MouseEvent) => {
			if (!menu.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
				this.closeQuantMenu();
			}
		}, true));
		this.quantMenuDisposables.add(dom.addDisposableListener(document, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.closeQuantMenu();
			}
		}, true));
		// 列表滚动时关闭浮层；但浮层自身的滚动/拖动滚动条不关闭
		this.quantMenuDisposables.add(dom.addDisposableListener(document, 'scroll', (e: Event) => {
			const target = e.target;
			if (target instanceof Node && menu.contains(target)) {
				return;
			}
			this.closeQuantMenu();
		}, true));
	}

	private closeQuantMenu(): void {
		this.quantMenuDisposables.clear();
		this.quantMenuEl?.remove();
		this.quantMenuEl = undefined;
	}

	/** 全局默认参数（未在模型上单独配置时使用） */
	private defaultParams(kind: LlmModelKind): Partial<Record<keyof ILlmModelParams, number>> {
		if (kind === 'music') {
			return {
				threads: 0,
				numInferenceSteps: 24,
				seed: -1,
				durationSeconds: 0,
			};
		}
		return {
			contextSize: this.configurationService.getValue<number>('ishell.llm.contextSize') ?? 4096,
			gpuLayers: this.configurationService.getValue<number>('ishell.llm.gpuLayers') ?? 0,
			apiPort: this.configurationService.getValue<number>('ishell.llm.apiPort') ?? 1234,
		};
	}

	/** 参数面板字段描述：聊天（llama.cpp）/ 音乐（audio.cpp） */
	private paramsFields(kind: LlmModelKind): IParamsField[] {
		if (kind === 'music') {
			return [
				{ section: 'load', key: 'threads', label: localize('ishell.llm.paramsThreads', 'CPU 线程数（0 = 自动）'), min: 0, max: 256, integer: true },
				{ section: 'load', key: 'audioBackend', label: localize('ishell.llm.paramsAudioBackend', '音频推理后端'), select: ['auto', 'metal', 'cuda', 'cpu'].map(v => ({ value: v, label: v })) },
				{ section: 'load', key: 'vaeType', label: localize('ishell.llm.paramsVaeType', 'VAE 精度'), select: ['f16', 'f32'].map(v => ({ value: v, label: v })) },
				{ section: 'generate', key: 'numInferenceSteps', label: localize('ishell.llm.paramsMusicSteps', '推理步数'), min: 1, max: 200, integer: true },
				{ section: 'generate', key: 'durationSeconds', label: localize('ishell.llm.paramsMusicDuration', '目标时长（秒，0 = 自动）'), min: 0, max: 600, integer: true },
				{ section: 'generate', key: 'cotMode', label: localize('ishell.llm.paramsMusicCot', 'CoT 模式'), select: ['off', 'melody', 'full'].map(v => ({ value: v, label: v })) },
				{ section: 'generate', key: 'seed', label: localize('ishell.llm.paramsSeed', '随机种子（-1 = 随机）'), min: -1, max: 2147483647, integer: true },
			];
		}
		const cacheTypes = ['f16', 'f32', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl'];
		const select = (values: string[]) => [{ value: '', label: localize('ishell.llm.paramsAuto', '自动（默认）') }, ...values.map(v => ({ value: v, label: v }))];
		return [
			{ section: 'load', key: 'contextSize', label: localize('ishell.llm.paramsContext', '上下文长度（tokens）'), min: 256, max: 1048576, integer: true },
			{ section: 'load', key: 'gpuLayers', label: localize('ishell.llm.paramsGpu', 'GPU 层数（0 = 纯 CPU）'), min: 0, max: 999, integer: true },
			{ section: 'load', key: 'threads', label: localize('ishell.llm.paramsThreads', 'CPU 线程数（0 = 自动）'), min: 0, max: 256, integer: true },
			{ section: 'load', key: 'batchSize', label: localize('ishell.llm.paramsBatch', '提示词批处理大小'), min: 32, max: 8192, integer: true },
			{ section: 'load', key: 'ubatchSize', label: localize('ishell.llm.paramsUbatch', '微批处理大小'), min: 16, max: 4096, integer: true },
			{ section: 'load', key: 'flashAttention', label: localize('ishell.llm.paramsFlashAttn', 'Flash Attention'), select: select(['auto', 'on', 'off']) },
			{ section: 'load', key: 'cacheTypeK', label: localize('ishell.llm.paramsCacheK', 'K 缓存量化'), select: select(cacheTypes) },
			{ section: 'load', key: 'cacheTypeV', label: localize('ishell.llm.paramsCacheV', 'V 缓存量化'), select: select(cacheTypes) },
			{ section: 'load', key: 'apiPort', label: localize('ishell.llm.paramsPort', 'API 端口'), min: 1024, max: 65535, integer: true },
			{ section: 'generate', key: 'temperature', label: localize('ishell.llm.paramsTemperature', '温度（0 ~ 2）'), min: 0, max: 2, step: 0.1 },
			{ section: 'generate', key: 'topP', label: localize('ishell.llm.paramsTopP', 'Top-P（0 ~ 1）'), min: 0, max: 1, step: 0.01 },
			{ section: 'generate', key: 'topK', label: localize('ishell.llm.paramsTopK', 'Top-K（0 = 不限制）'), min: 0, max: 1000, integer: true },
			{ section: 'generate', key: 'repeatPenalty', label: localize('ishell.llm.paramsRepeat', '重复惩罚（1.0 = 不惩罚）'), min: 0.5, max: 2, step: 0.05 },
			{ section: 'generate', key: 'maxTokens', label: localize('ishell.llm.paramsMaxTokens', '最大输出 tokens'), min: 1, max: 1048576, integer: true },
			{ section: 'generate', key: 'seed', label: localize('ishell.llm.paramsSeed', '随机种子（-1 = 随机）'), min: -1, max: 2147483647, integer: true },
		];
	}

	/** 打开模型参数配置浮层：保存后若该模型正在运行则自动重新加载 */
	private openParamsPanel(anchor: HTMLElement, model: ILlmModelRecord): void {
		this.closeQuantMenu();
		this.closeParamsPanel();
		const kind = resolveModelKind(model);
		const defaults = this.defaultParams(kind);
		const panel = document.createElement('div');
		panel.classList.add('ishell-llm-params');

		const title = document.createElement('div');
		title.classList.add('ishell-llm-params-title');
		title.textContent = kind === 'music'
			? localize('ishell.llm.paramsTitleMusic', '音乐模型参数')
			: localize('ishell.llm.paramsTitle', '模型参数');
		panel.appendChild(title);

		const fields = this.paramsFields(kind);
		const inputs = new Map<keyof ILlmModelParams, HTMLInputElement | HTMLSelectElement>();
		const sections: { key: 'load' | 'generate'; label: string }[] = kind === 'music'
			? [
				{ key: 'load', label: localize('ishell.llm.paramsSectionAudio', '音频引擎参数（下次生成生效）') },
				{ key: 'generate', label: localize('ishell.llm.paramsSectionMusic', '音乐生成参数（下次生成生效）') },
			]
			: [
				{ key: 'load', label: localize('ishell.llm.paramsSectionLoad', '加载参数（修改后重新加载模型生效）') },
				{ key: 'generate', label: localize('ishell.llm.paramsSectionGenerate', '生成参数（对话采样时生效）') },
			];
		for (const section of sections) {
			const header = document.createElement('div');
			header.classList.add('ishell-llm-params-section');
			header.textContent = section.label;
			panel.appendChild(header);
			for (const field of fields.filter(f => f.section === section.key)) {
				const row = document.createElement('label');
				row.classList.add('ishell-llm-params-row');
				const labelText = document.createElement('span');
				labelText.classList.add('ishell-llm-params-label');
				labelText.textContent = field.label;
				const current = model.params?.[field.key];
				let input: HTMLInputElement | HTMLSelectElement;
				if (field.select) {
					const el = document.createElement('select');
					el.classList.add('ishell-llm-params-select');
					for (const opt of field.select) {
						const option = document.createElement('option');
						option.value = opt.value;
						option.textContent = opt.label;
						el.appendChild(option);
					}
					const hasEmptyOption = field.select.some(opt => opt.value === '');
					el.value = current !== undefined
						? String(current)
						: (hasEmptyOption ? '' : (field.select[0]?.value ?? ''));
					input = el;
				} else {
					const el = document.createElement('input');
					el.classList.add('ishell-llm-params-input');
					el.type = 'number';
					if (field.min !== undefined) {
						el.min = String(field.min);
					}
					if (field.max !== undefined) {
						el.max = String(field.max);
					}
					el.step = String(field.step ?? (field.integer ? 1 : 0.01));
					el.value = current !== undefined ? String(current) : '';
					el.placeholder = (defaults as Partial<Record<keyof ILlmModelParams, number>>)[field.key] !== undefined
						? localize('ishell.llm.paramsDefault', '默认 {0}', String((defaults as Partial<Record<keyof ILlmModelParams, number>>)[field.key]))
						: localize('ishell.llm.paramsAutoPlaceholder', '自动');
					input = el;
				}
				row.append(labelText, input);
				panel.appendChild(row);
				inputs.set(field.key, input);
			}
		}

		const actions = document.createElement('div');
		actions.classList.add('ishell-llm-params-actions');
		const cancelBtn = this.button(localize('ishell.llm.paramsCancel', '取消'), '', () => this.closeParamsPanel());
		const saveBtn = this.button(localize('ishell.llm.paramsSave', '保存'), 'ishell-llm-btn-primary', async () => {
			const params: ILlmModelParams = {};
			for (const field of fields) {
				const raw = inputs.get(field.key)?.value.trim() ?? '';
				if (raw === '') {
					continue;
				}
				if (field.select) {
					if (!field.select.some(opt => opt.value === raw)) {
						this.notificationService.error(localize('ishell.llm.paramsInvalidSelect', '{0} 取值无效', field.label));
						return;
					}
					(params as Record<string, unknown>)[field.key] = raw;
					continue;
				}
				const value = Number(raw);
				const min = field.min ?? Number.NEGATIVE_INFINITY;
				const max = field.max ?? Number.POSITIVE_INFINITY;
				if (!Number.isFinite(value) || (field.integer && !Number.isInteger(value)) || value < min || value > max) {
					this.notificationService.error(localize(
						'ishell.llm.paramsInvalid',
						'{0} 需为 {1} ~ {2} 之间的{3}',
						field.label,
						String(min),
						String(max),
						field.integer ? localize('ishell.llm.paramsInteger', '整数') : localize('ishell.llm.paramsNumber', '数值')
					));
					return;
				}
				(params as Record<string, unknown>)[field.key] = value;
			}
			try {
				const running = this.engine.state === 'running' || this.engine.state === 'starting';
				await this.llmService.updateModelParams(model.id, params);
				this.closeParamsPanel();
				this.notificationService.info(running && this.engine.runningModelId === model.id
					? localize('ishell.llm.paramsSavedReload', '参数已保存，正在重新加载模型…')
					: localize('ishell.llm.paramsSaved', '参数已保存'));
			} catch (err) {
				this.notificationService.error((err as Error).message);
			}
		});
		actions.append(saveBtn, cancelBtn);
		panel.appendChild(actions);

		const host = document.querySelector<HTMLElement>('.monaco-workbench') ?? document.body;
		host.appendChild(panel);
		const rect = anchor.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelRect.width - 8));
		const top = rect.bottom + panelRect.height + 8 > window.innerHeight
			? Math.max(8, rect.top - panelRect.height - 4)
			: rect.bottom + 4;
		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;
		this.paramsPanelEl = panel;

		this.paramsPanelDisposables.add(dom.addDisposableListener(document, 'mousedown', (e: MouseEvent) => {
			if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
				this.closeParamsPanel();
			}
		}, true));
		this.paramsPanelDisposables.add(dom.addDisposableListener(document, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.closeParamsPanel();
			}
		}, true));
		// 面板内点击保存/取消后再关闭，避免与外部点击判断冲突
		panel.addEventListener('mousedown', e => e.stopPropagation());
	}

	private closeParamsPanel(): void {
		this.paramsPanelDisposables.clear();
		this.paramsPanelEl?.remove();
		this.paramsPanelEl = undefined;
	}

	/** 拉取仓库 GGUF 列表（缓存；force=true 用于失败重试） */
	private async loadNetworkFiles(model: ILlmNetworkModel, force = false): Promise<void> {
		if (this.networkFilesLoading.has(model.id) || (!force && this.networkFiles.has(model.id))) {
			return;
		}
		const seq = this.networkFileSeq;
		this.networkFilesLoading.add(model.id);
		this.renderCards();
		try {
			const files = await this.llmService.listNetworkModelFiles(model.id);
			if (seq !== this.networkFileSeq) {
				return;
			}
			this.networkFiles.set(model.id, files);
			this.networkFileErrors.delete(model.id);
			if (files.length === 0) {
				// 无可用 GGUF 文件：隐藏该卡片
				this.removeNetworkCard(model.id);
			}
		} catch (err) {
			if (seq !== this.networkFileSeq) {
				return;
			}
			this.networkFileErrors.set(model.id, (err as Error).message);
		} finally {
			if (seq === this.networkFileSeq) {
				this.networkFilesLoading.delete(model.id);
				this.renderCards();
			}
		}
	}

	/** 搜索输入防抖（250ms）：空关键词也搜索当前源默认 GGUF 列表 */
	private scheduleNetworkSearch(): void {
		if (this.networkTimer) {
			clearTimeout(this.networkTimer);
			this.networkTimer = undefined;
		}
		this.networkLoading = true;
		this.networkLoaded = false;
		this.renderCards();
		this.networkTimer = setTimeout(() => {
			this.networkTimer = undefined;
			void this.runNetworkSearch(this.searchQuery.trim());
		}, 250);
	}

	private async runNetworkSearch(query: string): Promise<void> {
		const seq = ++this.networkSeq;
		let models: ILlmNetworkModel[] = [];
		try {
			models = await this.llmService.searchNetworkModels(query);
		} catch {
			models = []; // 网络异常按空结果展示，不影响本地目录
		}
		// 过期守卫：输入已变化 / 已被新一轮搜索取代
		if (seq !== this.networkSeq || this.searchQuery.trim() !== query) {
			return;
		}
		this.networkResults = models;
		this.networkQuery = query;
		this.networkLoaded = true;
		this.networkPage = 0;
		this.networkHasMore = models.length >= LLM_NETWORK_PAGE_SIZE;
		this.networkLoading = false;
		this.networkListEl = undefined; // 新搜索：列表从顶部开始
		this.renderTabs();
		this.renderCards();
	}

	/** 卡片内选定量化后直接开始下载（进度流入卡片） */
	private async downloadNetworkFile(model: ILlmNetworkModel, file: string): Promise<void> {
		if (this.networkBusy.has(model.id)) {
			return;
		}
		const catalogId = networkModelCatalogId(model.id, file);
		if (this.downloads.has(catalogId)) {
			this.notificationService.info(localize('ishell.llm.networkDownloading', '该文件正在下载中'));
			return;
		}
		if (this.models.some(m => m.catalogId === catalogId)) {
			this.notificationService.info(localize('ishell.llm.networkAlreadyDownloaded',
				'该文件已下载：{0}', file));
			return;
		}
		this.networkBusy.add(model.id);
		this.networkDownloadIds.set(model.id, catalogId);
		this.renderCards();
		try {
			const started = this.llmService.downloadNetworkModel(model.id, file);
			this.notificationService.info(localize('ishell.llm.networkDownloadStarted',
				'已开始下载：{0}', file));
			await started;
		} catch (err) {
			this.notificationService.error((err as Error).message);
		} finally {
			this.networkBusy.delete(model.id);
			this.renderCards();
		}
	}

	private renderModelCard(entry: ILlmModelCatalogEntry): HTMLElement {
		const model = this.models.find(m => m.catalogId === entry.id);
		const download = this.downloads.get(entry.id);
		const recommended = this.systemInfo?.recommendedModelIds.includes(entry.id) ?? false;
		const running = this.engine.state === 'running' && this.engine.runningModelId === model?.id;
		const kind = resolveModelKind({ repo: entry.repo, file: entry.file, name: entry.name, catalogId: entry.id, kind: model?.kind });

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
		tag.classList.add('ishell-llm-card-tag', `ishell-llm-card-tag-${type.kind}`);
		tag.textContent = type.label;
		head.appendChild(tag);
		card.appendChild(head);

		const desc = document.createElement('div');
		desc.classList.add('ishell-llm-card-desc', 'ishell-llm-dim');
		desc.textContent = entry.description;
		card.appendChild(desc);

		// 已下载的量化文件：展示仓库内文件名（网络下载模型，含子目录时省略显示）
		if (entry.file) {
			const file = document.createElement('div');
			file.classList.add('ishell-llm-card-file', 'ishell-llm-dim');
			file.textContent = localize('ishell.llm.cardFile', '量化文件：{0}', entry.file);
			file.title = entry.file;
			card.appendChild(file);
		}

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
			if (kind === 'music') {
				// 音乐模型：不启动 llama-server，直接进入音乐生成区
				actions.appendChild(this.button(localize('ishell.llm.musicGenerateShort', '生成音乐'), 'ishell-llm-btn-primary', () => {
					this.musicSelectedModelId = model.id;
					this.syncMusicParamsFromModel(model);
					this.selectTab('music');
				}));
			} else if (running || this.engine.state === 'starting' && this.engine.runningModelId === model.id) {
				actions.appendChild(this.button(localize('ishell.llm.stopModel', '停止模型'), 'ishell-llm-btn-danger', async () => {
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
			const paramsBtn = this.button(localize('ishell.llm.params', '参数'), '', () => this.openParamsPanel(paramsBtn, model));
			actions.appendChild(paramsBtn);
			actions.appendChild(this.iconButton(Codicon.trash, localize('ishell.llm.deleteModel', '删除模型'), async () => {
				try {
					await this.llmService.deleteModel(model.id);
				} catch (err) {
					this.notificationService.error((err as Error).message);
				}
			}, true));
		} else {
			const downloadBtn = this.button(localize('ishell.llm.download', '下载'), 'ishell-llm-btn-primary', async () => {
				try {
					await this.llmService.downloadModel(entry.id);
				} catch (err) {
					this.notificationService.error((err as Error).message);
				}
			});
			// 大体积模型：悬停提示可用内存不足（不弹窗、不阻塞下载）
			const memoryWarn = this.memoryWarningText(entry.sizeBytes, entry.name);
			if (memoryWarn) {
				downloadBtn.classList.add('ishell-llm-btn-risk');
				this.cardHoverDisposables.add(this.hoverService.setupDelayedHover(downloadBtn, () => ({ content: memoryWarn })));
			}
			actions.appendChild(downloadBtn);
		}
		card.appendChild(actions);
		return card;
	}

	/** 内存不足提示文案：体积超过当前可用内存时返回警告文本，否则 undefined（仅用于悬停提示） */
	private memoryWarningText(sizeBytes: number | undefined, label: string): string | undefined {
		const info = this.systemInfo;
		if (!sizeBytes || sizeBytes <= 0 || !info || info.availableMemGb <= 0) {
			return undefined;
		}
		const availableBytes = info.availableMemGb * 1024 * 1024 * 1024;
		if (sizeBytes <= availableBytes) {
			return undefined;
		}
		return localize('ishell.llm.memRiskHoverLocal',
			'模型「{0}」需要约 {1} 存储空间，当前设备可用内存约 {2}（总内存 {3} GB）。\n可能因内存不足导致加载失败或运行时卡顿，建议先关闭其他占用内存的程序，或选择体积更小的量化版本。',
			label, formatSize(sizeBytes), formatSize(availableBytes), String(info.totalMemGb));
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

	private iconButton(icon: { id: string }, title: string, onClick: () => void, danger = false): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.classList.add('ishell-llm-btn-icon');
		if (danger) {
			btn.classList.add('ishell-llm-btn-icon-danger');
		}
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
		if (progress) {
			wrap.dataset.downloadId = progress.id;
		}
		const bar = document.createElement('div');
		bar.classList.add('ishell-llm-progress-bar');
		const fill = document.createElement('div');
		fill.classList.add('ishell-llm-progress-fill');
		bar.appendChild(fill);
		wrap.appendChild(bar);
		const label = document.createElement('div');
		label.classList.add('ishell-llm-progress-label');
		wrap.appendChild(label);
		this.applyProgressToElement(wrap, progress, showSpeed);
		return wrap;
	}

	/** 就地刷新进度条百分比与文案（不重建卡片/列表） */
	private applyProgressToElement(wrap: HTMLElement, progress: ILlmDownloadProgress | undefined, showSpeed = true): void {
		const fill = wrap.querySelector<HTMLElement>('.ishell-llm-progress-fill');
		const label = wrap.querySelector<HTMLElement>('.ishell-llm-progress-label');
		if (!progress) {
			if (label) {
				label.textContent = localize('ishell.llm.preparing', '准备中…');
			}
			return;
		}
		const pct = progress.totalBytes > 0 ? Math.floor(progress.receivedBytes / progress.totalBytes * 100) : 0;
		if (fill) {
			fill.style.width = `${pct}%`;
		}
		if (label) {
			const speed = showSpeed && progress.speedBytesPerSec > 0 ? ` · ${formatSize(progress.speedBytesPerSec)}/s` : '';
			label.textContent = `${pct}%（${formatSize(progress.receivedBytes)} / ${formatSize(progress.totalBytes)}${speed}）`;
		}
	}

	/** 模型下载进度：只更新对应进度条，避免 200ms 一次的全量重建造成闪烁 */
	private updateDownloadProgressInPlace(progress: ILlmDownloadProgress): void {
		const root = this.cardsEl;
		if (!root) {
			return;
		}
		for (const wrap of Array.from(root.querySelectorAll<HTMLElement>('.ishell-llm-progress'))) {
			if (wrap.dataset.downloadId === progress.id) {
				this.applyProgressToElement(wrap, progress);
			}
		}
	}

	/** 引擎下载进度：就地更新工具行进度条（缺失时补一次工具行渲染） */
	private updateToolbarProgress(progress: ILlmDownloadProgress): void {
		const bar = this.toolbarEl?.querySelector<HTMLElement>('.ishell-llm-toolbar-progress');
		if (!bar) {
			this.renderToolbar();
			return;
		}
		this.applyProgressToElement(bar, progress);
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
				{ label: localize('ishell.llm.srcModelScope', '魔搭社区（ModelScope）'), description: '国内模型社区，GGUF 资源丰富', kind: 'modelscope' as const },
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
			this.applySource(await this.llmService.getSource());
		} catch (err) {
			this.notificationService.error((err as Error).message);
		}
	}

	/** 应用下载源变更（工具栏与命令面板入口共用；同一源重复通知直接忽略） */
	private applySource(source: ILlmSourceConfig): void {
		const key = sourceKeyOf(source);
		if (key === this.appliedSourceKey) {
			return;
		}
		this.appliedSourceKey = key;
		this.source = source;
		// 切换源：丢弃旧源结果与在途请求，重新拉取当前源默认列表
		this.networkSeq++;
		this.networkSizeSeq++;
		this.networkResults = [];
		this.networkQuery = '';
		this.networkLoaded = false;
		this.networkLoading = false;
		this.networkPage = 0;
		this.networkHasMore = false;
		this.networkLoadingMore = false;
		this.networkListEl = undefined;
		this.networkSizes.clear();
		this.networkSizePending.clear();
		this.networkDownloadIds.clear();
		this.networkBusy.clear();
		this.networkFileSeq++;
		this.networkFiles.clear();
		this.networkFilesLoading.clear();
		this.networkFileErrors.clear();
		this.networkFileSelection.clear();
		this.renderToolbar();
		this.renderTabs();
		this.renderCards();
		// 仅在网络 Tab 下才重新搜索，本地 Tab 不做无谓网络请求
		if (this.activeTab === 'network') {
			this.scheduleNetworkSearch();
		}
	}

	private networkSourceName(): string {
		switch (this.source?.kind) {
			case 'modelscope': return localize('ishell.llm.srcNameModelScope', '魔搭 ModelScope');
			case 'custom': return localize('ishell.llm.srcNameCustom', '自定义源');
			default: return 'HuggingFace';
		}
	}

	private sourceShortName(): string {
		switch (this.source?.kind) {
			case 'official': return localize('ishell.llm.srcShortOfficial', '官方');
			case 'mirror': return localize('ishell.llm.srcShortMirror', '镜像');
			case 'modelscope': return localize('ishell.llm.srcShortModelScope', '魔搭');
			case 'custom': return localize('ishell.llm.srcShortCustom', '自定义');
			default: return '';
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

/** 模型类型 → 图标与标签（按 tags 优先级：music > code > reasoning > chat） */
function modelTypeOf(entry: ILlmModelCatalogEntry): { kind: 'music' | 'code' | 'reasoning' | 'chat'; icon: ThemeIcon; label: string } {
	if (entry.tags.includes('music')) {
		return { kind: 'music', icon: Codicon.music, label: localize('ishell.llm.typeMusic', '音乐') };
	}
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

/** 网络仓库 → 品牌图标（仅支持本地已打包的品牌资源） */
function networkBrandOf(model: ILlmNetworkModel): LlmVendorIcon | undefined {
	const id = model.id.toLowerCase();
	if (id.includes('qwen')) {
		return 'qwen';
	}
	if (id.includes('deepseek')) {
		return 'deepseek';
	}
	if (id.includes('llama')) {
		return 'llama';
	}
	return undefined;
}

/** 下载量 / 点赞数紧凑显示（如 12.3k） */
function formatDownloads(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}m`;
	}
	if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	return String(count);
}

/** GGUF 文件名 → 量化标签（如 q4_k_m → Q4_K_M；无量化标识时用文件名） */
function quantLabelOf(file: string): string {
	const base = (file.split('/').pop() ?? file).replace(/\.gguf$/i, '');
	const match = /(i?q\d+[_a-z0-9]*|f16|bf16|f32|fp16)/i.exec(base);
	return match ? match[1].toUpperCase() : base;
}

/** base64 WAV → Blob URL（data URL 有长度上限，较长音频无法被 <audio> 加载） */
function wavBlobUrl(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/** 秒数 → mm:ss */
function formatClock(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds)) {
		return '--:--';
	}
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
	const ss = String(seconds % 60).padStart(2, '0');
	return `${mm}:${ss}`;
}
