/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILlmEngineInfo, ILlmModelCatalogEntry, ILlmNetworkModel, IIshellLlmService, LlmEngineState, LlmVendorIcon } from '../common/llm.js';
import { renderBrandIcon, renderModelIcon } from './llmModelsEditor.js';
import { openLlmModelsEditor } from './llmModelsEditorInput.js';
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
 * 本地模型侧边栏导航视图（左侧区域）：
 * 引擎状态 + 厂家导航；点击厂家在中间编辑器区域打开模型广场（卡片）；
 * 对话复用 VSCode 内置 Chat（本地模型注册为其语言模型）。
 */
export class LlmModelsView extends ViewPane {

	static readonly ID = 'workbench.ishell.llmModels';
	static readonly LABEL = localize('ishell.llm.models', '本地模型');

	private container: HTMLElement | undefined;
	private readonly listeners = new DisposableStore();

	private catalog: ILlmModelCatalogEntry[] = [];
	private engine: ILlmEngineInfo = { state: 'missing' };
	private selectedVendor: 'all' | string = 'all';
	private searchQuery = '';

	private statusEl: HTMLElement | undefined;
	private vendorsEl: HTMLElement | undefined;
	private searchEl: HTMLInputElement | undefined;

	// 网络搜索状态：防抖定时器 + 请求序号（过期结果丢弃）
	private networkSearchTimer: ReturnType<typeof setTimeout> | undefined;
	private networkSearchSeq = 0;

	constructor(
		options: IViewletViewOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@IIshellLlmService private readonly llmService: IIshellLlmService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = document.createElement('div');
		this.container.classList.add('ishell-llm-models');
		parent.appendChild(this.container);

		// 引擎状态行
		this.statusEl = document.createElement('div');
		this.statusEl.classList.add('ishell-llm-models-status');
		this.container.appendChild(this.statusEl);

		// 模型搜索框（输入即过滤：结果替换厂家导航，点击跳转对应厂家广场）
		const searchWrap = document.createElement('div');
		searchWrap.classList.add('ishell-llm-models-search');
		this.searchEl = document.createElement('input');
		this.searchEl.type = 'text';
		this.searchEl.classList.add('ishell-llm-search');
		this.searchEl.placeholder = localize('ishell.llm.viewSearchPlaceholder', '搜索模型…');
		this.searchEl.addEventListener('input', () => {
			this.searchQuery = this.searchEl?.value ?? '';
			this.renderVendors();
		});
		searchWrap.appendChild(this.searchEl);
		this.container.appendChild(searchWrap);

		// 厂家导航 / 搜索结果（同一容器切换）
		this.vendorsEl = document.createElement('div');
		this.vendorsEl.classList.add('ishell-llm-vendors');
		this.container.appendChild(this.vendorsEl);

		// 引擎缺失时的快捷入口（主操作在中间模型广场页）
		const engineEntry = document.createElement('div');
		engineEntry.classList.add('ishell-llm-models-entry');
		const entryBtn = document.createElement('button');
		entryBtn.classList.add('ishell-llm-btn', 'ishell-llm-btn-primary');
		entryBtn.textContent = localize('ishell.llm.openGallery', '打开模型广场');
		entryBtn.addEventListener('click', () => this.openGallery(this.selectedVendor));
		engineEntry.appendChild(entryBtn);
		this.container.appendChild(engineEntry);

		this.listeners.add(this.llmService.onDidChangeEngine(engine => {
			this.engine = engine;
			this.renderStatus();
		}));

		this.refreshAll();
	}

	private async refreshAll(): Promise<void> {
		const [catalog, engine] = await Promise.all([
			this.llmService.getModelCatalog(),
			this.llmService.getEngineInfo(),
		]);
		this.catalog = catalog;
		this.engine = engine;
		this.renderStatus();
		this.renderVendors();

		// 打开侧边栏时自动在中间区域打开（或聚焦已打开的）模型广场
		this.openGallery(this.selectedVendor);
	}

	override getActionsContext(): unknown {
		return undefined;
	}

	// ==== 引擎状态行 ====

	private renderStatus(): void {
		const root = this.statusEl;
		if (!root) {
			return;
		}
		root.innerText = '';
		const badge = document.createElement('span');
		badge.classList.add('ishell-llm-badge', `ishell-llm-badge-${this.engine.state}`);
		badge.textContent = ENGINE_STATE_LABEL[this.engine.state] ?? this.engine.state;
		root.appendChild(badge);
		if (this.engine.state === 'running' && this.engine.runningModelName) {
			const name = document.createElement('span');
			name.classList.add('ishell-llm-dim');
			name.textContent = ` ${this.engine.runningModelName}`;
			root.appendChild(name);
		} else if (this.engine.version) {
			const ver = document.createElement('span');
			ver.classList.add('ishell-llm-dim');
			ver.textContent = ` ${this.engine.version}`;
			root.appendChild(ver);
		}
	}

	// ==== 厂家导航 ====

	private getVendors(): { id: string; name: string; count: number }[] {
		const seen = new Map<string, string>();
		for (const entry of this.catalog) {
			if (!seen.has(entry.vendorId)) {
				seen.set(entry.vendorId, entry.vendorName);
			}
		}
		return [...seen.entries()].map(([id, name]) => ({
			id,
			name,
			count: this.catalog.filter(e => e.vendorId === id).length,
		}));
	}

	private renderVendors(): void {
		const root = this.vendorsEl;
		if (!root) {
			return;
		}
		root.innerText = '';

		// 搜索模式：本地目录即时匹配 + 网络模型异步搜索（分组渲染）
		const query = this.searchQuery.trim();
		if (query !== '') {
			this.renderSearchResults(root, query.toLowerCase());
			this.scheduleNetworkSearch(query);
			return;
		}
		if (this.networkSearchTimer !== undefined) {
			clearTimeout(this.networkSearchTimer);
			this.networkSearchTimer = undefined;
		}
		this.networkSearchSeq++; // 清空搜索时丢弃在途网络结果

		const all = document.createElement('div');
		all.classList.add('ishell-llm-vendor-item');
		if (this.selectedVendor === 'all') {
			all.classList.add('active');
		}
		const allIcon = document.createElement('span');
		allIcon.classList.add('codicon', `codicon-${Codicon.layers.id}`, 'ishell-llm-vendor-item-icon');
		all.appendChild(allIcon);
		all.appendChild(this.vendorLabel(localize('ishell.llm.allVendors', '全部模型'), this.catalog.length));
		all.addEventListener('click', () => this.selectVendor('all'));
		root.appendChild(all);

		for (const vendor of this.getVendors()) {
			const item = document.createElement('div');
			item.classList.add('ishell-llm-vendor-item');
			if (this.selectedVendor === vendor.id) {
				item.classList.add('active');
			}
			// 厂家图标：取该厂家第一个模型的图标（网络图片优先，回退 codicon）
			const first = this.catalog.find(e => e.vendorId === vendor.id);
			if (first) {
				item.appendChild(renderModelIcon(first));
			}
			item.appendChild(this.vendorLabel(vendor.name, vendor.count));
			item.addEventListener('click', () => this.selectVendor(vendor.id));
			root.appendChild(item);
		}
	}

	/** 搜索结果：本地目录分组（同步即时）+ 网络模型分组容器（异步填充） */
	private renderSearchResults(root: HTMLElement, query: string): void {
		const localHeader = document.createElement('div');
		localHeader.classList.add('ishell-llm-search-section');
		localHeader.textContent = localize('ishell.llm.searchSectionLocal', '本地目录');
		root.appendChild(localHeader);

		const hits = this.catalog.filter(e => `${e.name} ${e.description} ${e.vendorName}`.toLowerCase().includes(query));
		if (hits.length === 0) {
			const empty = document.createElement('div');
			empty.classList.add('ishell-llm-vendor-item', 'ishell-llm-search-empty');
			empty.textContent = localize('ishell.llm.viewNoMatch', '未找到匹配的模型');
			root.appendChild(empty);
		}
		for (const entry of hits) {
			const item = document.createElement('div');
			item.classList.add('ishell-llm-vendor-item', 'ishell-llm-result-item');
			item.title = entry.description;
			item.appendChild(renderModelIcon(entry));
			const name = document.createElement('span');
			name.classList.add('ishell-llm-result-name');
			name.textContent = entry.name;
			item.appendChild(name);
			const vendor = document.createElement('span');
			vendor.classList.add('ishell-llm-result-vendor');
			vendor.textContent = entry.vendorName;
			item.appendChild(vendor);
			item.addEventListener('click', () => this.openGallery(entry.vendorId));
			root.appendChild(item);
		}

		const networkHeader = document.createElement('div');
		networkHeader.classList.add('ishell-llm-search-section');
		networkHeader.textContent = localize('ishell.llm.searchSectionNetwork', '网络模型（HuggingFace）');
		root.appendChild(networkHeader);

		// 网络区占位（loading / 结果由异步回调填充）
		const networkSection = document.createElement('div');
		networkSection.classList.add('ishell-llm-network-section');
		const loading = document.createElement('div');
		loading.classList.add('ishell-llm-vendor-item', 'ishell-llm-search-empty');
		loading.textContent = localize('ishell.llm.networkSearching', '正在搜索网络模型…');
		networkSection.appendChild(loading);
		root.appendChild(networkSection);
	}

	/** 网络搜索防抖：250ms 内连续输入只发一次请求 */
	private scheduleNetworkSearch(query: string): void {
		if (this.networkSearchTimer !== undefined) {
			clearTimeout(this.networkSearchTimer);
		}
		this.networkSearchTimer = setTimeout(() => {
			this.networkSearchTimer = undefined;
			this.runNetworkSearch(query);
		}, 250);
	}

	/** 执行网络搜索并填充结果区（过期请求 / UI 已重建则丢弃） */
	private async runNetworkSearch(query: string): Promise<void> {
		const seq = ++this.networkSearchSeq;
		const section = this.container?.querySelector<HTMLElement>('.ishell-llm-network-section') ?? undefined;
		if (!section) {
			return;
		}
		let models: ILlmNetworkModel[] = [];
		try {
			models = await this.llmService.searchNetworkModels(query);
		} catch {
			models = []; // 网络异常：显示空态，不影响本地匹配
		}
		// 过期守卫：输入已变化 / 视图已重建 / 搜索已清空
		if (seq !== this.networkSearchSeq || this.searchQuery.trim() !== query || !section.isConnected) {
			return;
		}
		this.renderNetworkResults(section, models);
	}

	/** 网络搜索结果列表：品牌图标 + 仓库全名 + 下载量 */
	private renderNetworkResults(section: HTMLElement, models: ILlmNetworkModel[]): void {
		section.innerText = '';
		if (models.length === 0) {
			const empty = document.createElement('div');
			empty.classList.add('ishell-llm-vendor-item', 'ishell-llm-search-empty');
			empty.textContent = localize('ishell.llm.networkNoMatch', '网络搜索无结果（或网络不可达）');
			section.appendChild(empty);
			return;
		}
		for (const model of models.slice(0, 20)) {
			const item = document.createElement('div');
			item.classList.add('ishell-llm-vendor-item', 'ishell-llm-result-item');
			item.title = model.id;
			item.appendChild(renderBrandIcon(networkBrandOf(model), 'sm', Codicon.remote, model.id));
			const name = document.createElement('span');
			name.classList.add('ishell-llm-result-name');
			name.textContent = model.id;
			item.appendChild(name);
			const downloads = document.createElement('span');
			downloads.classList.add('ishell-llm-result-vendor');
			downloads.textContent = formatDownloads(model.downloads);
			item.appendChild(downloads);
			item.addEventListener('click', () => this.showNetworkModelActions(model));
			section.appendChild(item);
		}
	}

	/** 网络模型操作：打开模型主页 / 复制模型 ID（主页跟随当前下载源：镜像或官方） */
	private async showNetworkModelActions(model: ILlmNetworkModel): Promise<void> {
		let base = 'https://huggingface.co';
		try {
			const source = await this.llmService.getSource();
			if (source.kind === 'mirror') {
				base = 'https://hf-mirror.com';
			}
		} catch {
			// 源信息获取失败按官方站
		}
		const modelUrl = `${base}/${model.id}`;
		const pick = await this.quickInput.pick<IQuickPickItem & { act: 'open' | 'copy' }>([
			{ label: localize('ishell.llm.networkOpen', '打开模型主页'), detail: modelUrl, act: 'open' },
			{ label: localize('ishell.llm.networkCopy', '复制模型 ID'), detail: model.id, act: 'copy' },
		], { placeHolder: localize('ishell.llm.networkPickHint', '{0}（下载 {1} · 赞 {2}）', model.id, formatDownloads(model.downloads), String(model.likes)) });
		if (!pick) {
			return;
		}
		if (pick.act === 'open') {
			await this.openerService.open(URI.parse(modelUrl), { openExternal: true });
		} else {
			await this.clipboardService.writeText(model.id);
			this.notificationService.info(localize('ishell.llm.networkCopied', '已复制模型 ID：{0}', model.id));
		}
	}

	private selectVendor(vendorId: 'all' | string): void {
		this.selectedVendor = vendorId;
		this.renderVendors();
		this.openGallery(vendorId);
	}

	private vendorLabel(name: string, count: number): HTMLElement {
		const wrap = document.createElement('div');
		wrap.classList.add('ishell-llm-vendor-label');
		const label = document.createElement('span');
		label.textContent = name;
		wrap.appendChild(label);
		const badge = document.createElement('span');
		badge.classList.add('ishell-llm-vendor-count');
		badge.textContent = String(count);
		wrap.appendChild(badge);
		return wrap;
	}

	// ==== 打开中间模型广场 ====

	private openGallery(vendorId: 'all' | string): void {
		// 打开失败静默处理，不影响侧边栏
		openLlmModelsEditor(this.editorService, this.instantiationService, vendorId).catch(() => { });
	}

	override dispose(): void {
		if (this.networkSearchTimer !== undefined) {
			clearTimeout(this.networkSearchTimer);
		}
		this.listeners.dispose();
		super.dispose();
	}
}

/** 网络模型 → 品牌图标键（按仓库全名包含关系匹配：qwen/deepseek/llama） */
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

/** 下载量紧凑显示（如 12.3k） */
function formatDownloads(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}m`;
	}
	if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	return String(count);
}
