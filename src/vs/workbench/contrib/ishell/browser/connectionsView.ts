/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, IContextKey, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenEvent, WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITreeContextMenuEvent } from '../../../../base/browser/ui/tree/tree.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IIshellService } from '../common/ishell.js';
import { ConnectionTreeElement, ConnectionsAccessibilityProvider, ConnectionsDataSource, ConnectionsDelegate, ConnectionsIdentityProvider, ConnectionsNaviLabelProvider, GroupElement, GroupRenderer, HostElement, HostRenderer, IConnectionsTreeInput, isHostElement, UNGROUPED_ID } from './connectionTree.js';
import { connectHost } from './connectionActions.js';
import './ishell.css';

/** 视图标题栏工具栏菜单 */
export const IshellConnectionsTitleMenu = new MenuId('ishell.connections.title');
/** 树节点右键菜单 */
export const IshellConnectionsContextMenu = new MenuId('ishell.connections.context');

export class ConnectionsView extends ViewPane {

	static readonly ID = 'workbench.ishell.connections';
	static readonly LABEL = localize('ishell.connections', '连接管理');

	static readonly ctxHostFocused = new RawContextKey<boolean>('ishell.hostFocused', false);
	static readonly ctxGroupFocused = new RawContextKey<boolean>('ishell.groupFocused', false);
	static readonly ctxGroupReal = new RawContextKey<boolean>('ishell.groupReal', false);
	static readonly ctxHostConnected = new RawContextKey<boolean>('ishell.hostConnected', false);
	static readonly ctxHostBusy = new RawContextKey<boolean>('ishell.hostBusy', false);

	private tree!: WorkbenchAsyncDataTree<IConnectionsTreeInput, ConnectionTreeElement, FuzzyScore>;
	private readonly treeInput: IConnectionsTreeInput = { data: { version: 1, groups: [], hosts: [] }, snapshots: new Map() };
	private emptyHint: HTMLElement | undefined;
	private readonly listeners = new DisposableStore();

	private readonly ctxHostFocused: IContextKey<boolean>;
	private readonly ctxGroupFocused: IContextKey<boolean>;
	private readonly ctxGroupReal: IContextKey<boolean>;
	private readonly ctxHostConnected: IContextKey<boolean>;
	private readonly ctxHostBusy: IContextKey<boolean>;

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
		@IIshellService private readonly ishellService: IIshellService,
	) {
		super({ ...options, titleMenuId: IshellConnectionsTitleMenu }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.ctxHostFocused = ConnectionsView.ctxHostFocused.bindTo(contextKeyService);
		this.ctxGroupFocused = ConnectionsView.ctxGroupFocused.bindTo(contextKeyService);
		this.ctxGroupReal = ConnectionsView.ctxGroupReal.bindTo(contextKeyService);
		this.ctxHostConnected = ConnectionsView.ctxHostConnected.bindTo(contextKeyService);
		this.ctxHostBusy = ConnectionsView.ctxHostBusy.bindTo(contextKeyService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.emptyHint = document.createElement('div');
		this.emptyHint.classList.add('ishell-empty-hint');
		this.emptyHint.textContent = localize('ishell.emptyHint', '还没有可用的连接。\n使用标题栏的 "+" 新建连接，或使用快速连接（不保存）。');
		this.emptyHint.style.whiteSpace = 'pre';
		parent.appendChild(this.emptyHint);

		const treeContainer = document.createElement('div');
		treeContainer.classList.add('ishell-connections-tree');
		parent.appendChild(treeContainer);

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<IConnectionsTreeInput, ConnectionTreeElement, FuzzyScore>,
			'ishellConnections',
			treeContainer,
			new ConnectionsDelegate(),
			[this.instantiationService.createInstance(HostRenderer), this.instantiationService.createInstance(GroupRenderer)],
			new ConnectionsDataSource(this.treeInput),
			{
				identityProvider: new ConnectionsIdentityProvider(),
				accessibilityProvider: new ConnectionsAccessibilityProvider(),
				keyboardNavigationLabelProvider: new ConnectionsNaviLabelProvider(),
				multipleSelectionSupport: false,
				expandOnlyOnTwistieClick: true,
				horizontalScrolling: false,
			}
		);

		this.listeners.add(this.tree.onContextMenu(e => this.onContextMenu(e)));
		this.listeners.add(this.tree.onDidOpen(e => this.onOpen(e)));
		this.listeners.add(this.tree.onDidChangeSelection(() => this.updateContextKeys()));
		this.listeners.add(this.tree.onDidChangeFocus(() => this.updateContextKeys()));

		this.listeners.add(this.ishellService.onDidChangeProfiles(() => this.refresh()));
		this.listeners.add(this.ishellService.onDidChangeConnections(() => this.refresh()));

		this.refresh();
	}

	private onContextMenu(e: ITreeContextMenuEvent<ConnectionTreeElement | null>): void {
		// 右键未选中项时先选中，保证命令作用于目标节点
		if (e.element && !this.tree.getSelection().includes(e.element)) {
			this.tree.setSelection([e.element]);
			this.updateContextKeys();
		}
		this.contextMenuService.showContextMenu({
			menuId: IshellConnectionsContextMenu,
			contextKeyService: this.tree.contextKeyService,
			getAnchor: () => e.anchor,
		});
	}

	private async onOpen(e: IOpenEvent<ConnectionTreeElement | undefined>): Promise<void> {
		const element = e.element;
		if (element && isHostElement(element)) {
			await connectHost(this.instantiationService, element.profile);
		}
	}

	private updateContextKeys(): void {
		const target = this.tree.getSelection().find(e => isHostElement(e) || e instanceof GroupElement)
			?? this.tree.getFocus()[0];
		if (target && isHostElement(target)) {
			this.ctxHostFocused.set(true);
			this.ctxGroupFocused.set(false);
			this.ctxGroupReal.set(false);
			const status = target.snapshot?.status ?? 'disconnected';
			this.ctxHostConnected.set(status === 'connected');
			this.ctxHostBusy.set(status === 'connecting' || status === 'reconnecting');
		} else if (target && target instanceof GroupElement) {
			this.ctxHostFocused.set(false);
			this.ctxGroupFocused.set(true);
			this.ctxGroupReal.set(target.group.id !== UNGROUPED_ID);
			this.ctxHostConnected.set(false);
			this.ctxHostBusy.set(false);
		} else {
			this.ctxHostFocused.set(false);
			this.ctxGroupFocused.set(false);
			this.ctxGroupReal.set(false);
			this.ctxHostConnected.set(false);
			this.ctxHostBusy.set(false);
		}
	}

	/** 获取当前聚焦/选中的主机（供命令使用） */
	getFocusedHost(): HostElement | undefined {
		const selection = this.tree.getSelection().filter(isHostElement);
		if (selection.length > 0) {
			return selection[0];
		}
		const [focused] = this.tree.getFocus();
		return focused && isHostElement(focused) ? focused : undefined;
	}

	/** 获取当前聚焦/选中的分组 */
	getFocusedGroup(): GroupElement | undefined {
		const selection = this.tree.getSelection();
		for (const e of selection) {
			if (e instanceof GroupElement) {
				return e;
			}
		}
		const [focused] = this.tree.getFocus();
		return focused && focused instanceof GroupElement ? focused : undefined;
	}

	async refresh(): Promise<void> {
		if (!this.tree) {
			return;
		}
		const [data, snapshots] = await Promise.all([
			this.ishellService.getProfiles(),
			this.ishellService.getConnections(),
		]);
		this.treeInput.data = data;
		this.treeInput.snapshots = new Map(snapshots.map(s => [s.id, s]));
		if (this.emptyHint) {
			this.emptyHint.style.display = data.hosts.length === 0 ? '' : 'none';
		}
		await this.tree.setInput(this.treeInput);
		this.updateContextKeys();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override dispose(): void {
		this.listeners.dispose();
		this.tree?.dispose();
		super.dispose();
	}
}
