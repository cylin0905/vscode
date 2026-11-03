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
import { ILlmModelCatalogEntry, ILlmNetworkFile, ILlmNetworkModel, ILlmSourceConfig, IIshellLlmService, LLM_MODEL_CATEGORIES, LlmVendorIcon, networkModelCatalogId, resolveModelCategories } from '../common/llm.js';
import { renderBrandIcon, renderModelIcon } from './llmModelsEditor.js';
import { openLlmModelsEditor, LlmModelsEditorFilter } from './llmModelsEditorInput.js';
import './llm.css';

/**
 * 本地模型侧边栏导航视图（左侧区域）：
 * 模型分类导航（对话、推理、代码、音乐、视频、视觉等）；
 * 点击分类在中间编辑器区域打开模型广场并只显示该类别的模型；
 * 对话复用 VSCode 内置 Chat（本地模型注册为其语言模型）。
 */
export class LlmModelsView extends ViewPane {

	static readonly ID = 'workbench.ishell.llmModels';
	static readonly LABEL = localize('ishell.llm.models', '本地模型');

	private container: HTMLElement | undefined;
	private readonly listeners = new DisposableStore();

	private catalog: ILlmModelCatalogEntry[] = [];
	private source: ILlmSourceConfig | undefined;
	private selectedCategory: 'all' | string = 'all';
	private searchQuery = '';

	private navEl: HTMLElement | undefined;

	// 网络搜索状态：防抖定时器 + 请求序号（过期结果丢弃）
	private networkSearchTimer: ReturnType<typeof setTimeout> | undefined;
	private networkSearchSeq = 0;
	/** 仓库 → 最小量化体积（-1 表示未取到） */
	private readonly networkSizes = new Map<string, number>();
	/** 体积查询在途的仓库（避免重复请求） */
	private readonly networkSizePending = new Set<string>();

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

		// 模型分类导航
		this.navEl = document.createElement('div');
		this.navEl.classList.add('ishell-llm-vendors');
		this.container.appendChild(this.navEl);

		this.listeners.add(this.llmService.onDidChangeModels(() => { void this.refreshAll(); }));
		// 下载源切换后同步标题并重新搜索（工具栏/命令面板均可触发）
		this.listeners.add(this.llmService.onDidChangeSource(source => {
			this.source = source;
			this.renderNav();
		}));

		this.refreshAll();
	}

	private async refreshAll(): Promise<void> {
		const [catalog, source] = await Promise.all([
			this.llmService.getModelCatalog(),
			this.llmService.getSource(),
		]);
		this.catalog = catalog;
		this.source = source;
		this.renderNav();
	}

	override getActionsContext(): unknown {
		return undefined;
	}

	// ==== 模型分类导航 ====

	/** 各分类下的模型数量（本地目录为空时全部为 0，仍保留分类入口便于后期下载） */
	private getCategoryCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const entry of this.catalog) {
			for (const categoryId of resolveModelCategories(entry)) {
				counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
			}
		}
		return counts;
	}

	private renderNav(): void {
		const root = this.navEl;
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

		const header = document.createElement('div');
		header.classList.add('ishell-llm-search-section');
		header.textContent = localize('ishell.llm.categorySection', '模型分类');
		root.appendChild(header);

		const all = document.createElement('div');
		all.classList.add('ishell-llm-vendor-item');
		if (this.selectedCategory === 'all') {
			all.classList.add('active');
		}
		const allIcon = document.createElement('span');
		allIcon.classList.add('codicon', `codicon-${Codicon.layers.id}`, 'ishell-llm-vendor-item-icon', 'ishell-llm-cat-all');
		all.appendChild(allIcon);
		all.appendChild(this.navLabel(localize('ishell.llm.allVendors', '全部模型'), this.catalog.length));
		all.addEventListener('click', () => this.selectCategory('all'));
		root.appendChild(all);

		const counts = this.getCategoryCounts();
		for (const category of LLM_MODEL_CATEGORIES) {
			const item = document.createElement('div');
			item.classList.add('ishell-llm-vendor-item');
			if (this.selectedCategory === category.id) {
				item.classList.add('active');
			}
			const icon = document.createElement('span');
			icon.classList.add('codicon', `codicon-${category.codicon}`, 'ishell-llm-vendor-item-icon', `ishell-llm-cat-${category.id}`);
			item.appendChild(icon);
			item.appendChild(this.navLabel(category.label, counts.get(category.id) ?? 0));
			item.addEventListener('click', () => this.selectCategory(category.id));
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
			item.addEventListener('click', () => this.openGallery({ vendorId: entry.vendorId }));
			root.appendChild(item);
		}

		const networkHeader = document.createElement('div');
		networkHeader.classList.add('ishell-llm-search-section');
		networkHeader.setAttribute('data-role', 'network-header');
		networkHeader.textContent = localize('ishell.llm.searchSectionNetwork', '网络模型（{0}）', this.sourceLabel());
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

	private sourceLabel(): string {
		switch (this.source?.kind) {
			case 'modelscope': return '魔搭 ModelScope';
			case 'custom': return '自定义源';
			default: return 'HuggingFace';
		}
	}

	private async refreshSourceLabel(): Promise<void> {
		try {
			this.source = await this.llmService.getSource();
		} catch {
			return;
		}
		const header = this.container?.querySelector<HTMLElement>('[data-role="network-header"]');
		if (header) {
			header.textContent = localize('ishell.llm.searchSectionNetwork', '网络模型（{0}）', this.sourceLabel());
		}
	}

	/** 执行网络搜索并填充结果区（过期请求 / UI 已重建则丢弃） */
	private async runNetworkSearch(query: string): Promise<void> {
		void this.refreshSourceLabel();
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
		const shown = models.slice(0, 20);
		for (const model of shown) {
			const item = document.createElement('div');
			item.classList.add('ishell-llm-vendor-item', 'ishell-llm-result-item');
			item.setAttribute('data-repo', model.id);
			item.title = `${model.id} · 下载 ${formatDownloads(model.downloads)} · 赞 ${formatDownloads(model.likes)}`;
			item.appendChild(renderBrandIcon(networkBrandOf(model), 'sm', Codicon.remote, model.id));
			const name = document.createElement('span');
			name.classList.add('ishell-llm-result-name');
			name.textContent = model.id;
			item.appendChild(name);
			// 体积：异步查询各仓库最小量化体积（未取到前显示省略号）
			const size = document.createElement('span');
			size.classList.add('ishell-llm-result-vendor', 'ishell-llm-result-size');
			const known = this.networkSizes.get(model.id);
			size.textContent = known === undefined ? '…' : known > 0 ? formatSize(known) : '—';
			item.appendChild(size);
			item.addEventListener('click', () => this.showNetworkModelActions(model));
			section.appendChild(item);
		}
		this.ensureNetworkSizes(shown);
	}

	/** 查询各仓库最小 GGUF 体积（每个仓库仅请求一次，失败记 -1 不再重试） */
	private ensureNetworkSizes(models: ILlmNetworkModel[]): void {
		const missing = models.filter(m => !this.networkSizes.has(m.id) && !this.networkSizePending.has(m.id));
		if (missing.length === 0) {
			return;
		}
		for (const model of missing) {
			this.networkSizePending.add(model.id);
		}
		void Promise.all(missing.map(async model => {
			let size = -1;
			try {
				const files: ILlmNetworkFile[] = await this.llmService.listNetworkModelFiles(model.id);
				const known = files.filter(f => f.sizeBytes !== undefined).map(f => f.sizeBytes as number);
				if (known.length > 0) {
					size = Math.min(...known);
				}
			} catch {
				// 网络异常：保持未知体积
			}
			this.networkSizes.set(model.id, size);
			this.networkSizePending.delete(model.id);
		})).then(() => this.updateNetworkSizeLabels());
	}

	/** 原地刷新列表项的体积文案（不重建列表，避免重复触发网络搜索） */
	private updateNetworkSizeLabels(): void {
		const section = this.container?.querySelector<HTMLElement>('.ishell-llm-network-section');
		if (!section) {
			return;
		}
		for (const item of section.querySelectorAll<HTMLElement>('.ishell-llm-result-item[data-repo]')) {
			const repo = item.getAttribute('data-repo') ?? '';
			const size = this.networkSizes.get(repo);
			if (size === undefined) {
				continue;
			}
			const label = item.querySelector<HTMLElement>('.ishell-llm-result-size');
			if (label) {
				label.textContent = size > 0 ? formatSize(size) : '—';
			}
		}
	}

	/**
	 * 网络模型操作：选量化直接下载（主操作）/ 打开模型主页 / 复制模型 ID。
	 * 点击即弹出可下载的 GGUF 列表（含体积），避免用户再去主页找文件。
	 */
	private async showNetworkModelActions(model: ILlmNetworkModel): Promise<void> {
		let base = 'https://huggingface.co';
		try {
			const source = await this.llmService.getSource();
			this.source = source;
			if (source.kind === 'mirror') {
				base = 'https://hf-mirror.com';
			} else if (source.kind === 'modelscope') {
				base = 'https://modelscope.cn/models';
			}
		} catch {
			// 源信息获取失败按官方站
		}
		const modelUrl = `${base}/${model.id}`;

		let files: ILlmNetworkFile[] = [];
		try {
			files = await this.llmService.listNetworkModelFiles(model.id);
		} catch {
			files = []; // 网络异常：退化为仅打开主页
		}
		const downloaded = this.catalog.some(e => e.repo === model.id);

		type NetworkAction = IQuickPickItem & { act: 'download' | 'open' | 'copy'; file?: string };
		const items: NetworkAction[] = files.map(file => ({
			label: `$(cloud-download) ${localize('ishell.llm.networkDownloadQuant', '下载 {0}', quantLabelOf(file.file))}`,
			description: file.sizeBytes !== undefined ? formatSize(file.sizeBytes) : undefined,
			detail: file.file,
			act: 'download' as const,
			file: file.file,
		}));
		if (items.length === 0) {
			items.push({ label: localize('ishell.llm.networkNoDirect', '该仓库无直接可下载的 GGUF 文件'), act: 'open' });
		}
		items.push(
			{ label: localize('ishell.llm.networkOpen', '打开模型主页'), detail: modelUrl, act: 'open' },
			{ label: localize('ishell.llm.networkCopy', '复制模型 ID'), detail: model.id, act: 'copy' },
		);

		const pick = await this.quickInput.pick(items, {
			placeHolder: localize('ishell.llm.networkPickHint', '{0}（下载 {1} · 赞 {2}{3}）',
				model.id, formatDownloads(model.downloads), formatDownloads(model.likes),
				downloaded ? localize('ishell.llm.networkHasDownloaded', ' · 已下载') : ''),
		});
		if (!pick) {
			return;
		}
		if (pick.act === 'download' && pick.file) {
			await this.downloadNetworkFile(model, pick.file);
		} else if (pick.act === 'open') {
			await this.openerService.open(URI.parse(modelUrl), { openExternal: true });
		} else {
			await this.clipboardService.writeText(model.id);
			this.notificationService.info(localize('ishell.llm.networkCopied', '已复制模型 ID：{0}', model.id));
		}
	}

	/** 下载指定仓库的 GGUF（进度由主进程推送，完成后模型进入本地目录卡片） */
	private async downloadNetworkFile(model: ILlmNetworkModel, file: string): Promise<void> {
		const catalogId = networkModelCatalogId(model.id, file);
		if (this.catalog.some(e => e.id === catalogId)) {
			this.notificationService.info(localize('ishell.llm.networkAlreadyDownloaded', '该文件已下载：{0}', file));
			return;
		}
		let started: Promise<void>;
		try {
			started = this.llmService.downloadNetworkModel(model.id, file);
		} catch (err) {
			this.notificationService.error((err as Error).message);
			return;
		}
		this.notificationService.info(localize('ishell.llm.networkDownloadStarted',
			'已开始下载：{0}\n下载完成后会出现在模型广场卡片中', file));
		try {
			await started;
			this.notificationService.info(localize('ishell.llm.networkDownloadDone', '下载完成：{0}', file));
			this.catalog = await this.llmService.getModelCatalog();
			this.renderNav();
		} catch (err) {
			this.notificationService.error((err as Error).message);
		}
	}

	private selectCategory(categoryId: 'all' | string): void {
		this.selectedCategory = categoryId;
		this.renderNav();
		this.openGallery({ categoryId });
	}

	private navLabel(name: string, count: number): HTMLElement {
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

	private openGallery(filter: LlmModelsEditorFilter, newTab = false): void {
		// 打开失败静默处理，不影响侧边栏
		openLlmModelsEditor(this.editorService, this.instantiationService, filter, { newTab }).catch(() => { });
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

/** 体积显示（GB / MB / KB） */
function formatSize(bytes: number): string {
	if (bytes >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	}
	if (bytes >= 1024 ** 2) {
		return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
	}
	return `${Math.round(bytes / 1024)} KB`;
}

/** GGUF 文件名 → 量化标签（如 q4_k_m → Q4_K_M） */
function quantLabelOf(file: string): string {
	const base = (file.split('/').pop() ?? file).replace(/\.gguf$/i, '');
	const match = /(i?q\d+[_a-z0-9]*|f16|bf16|f32|fp16)/i.exec(base);
	return match ? match[1].toUpperCase() : base;
}
