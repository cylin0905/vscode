/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { localize } from '../../../../nls.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeRenderer, ITreeNode } from '../../../../base/browser/ui/tree/tree.js';
import { IConnectionsData, IHostGroup, IHostProfile, ISshConnectionSnapshot } from '../common/ishell.js';

// ==== 树元素 ====

export class GroupElement {
	constructor(
		readonly group: IHostGroup,
		readonly hosts: readonly IHostProfile[],
		readonly snapshots: Map<string, ISshConnectionSnapshot>,
	) { }

	get children(): HostElement[] {
		return this.hosts
			.slice()
			.sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host))
			.map(h => new HostElement(h, this.snapshots.get(h.id)));
	}
}

export class HostElement {
	constructor(
		readonly profile: IHostProfile,
		readonly snapshot: ISshConnectionSnapshot | undefined,
	) { }
}

export type ConnectionTreeElement = GroupElement | HostElement;

export interface IConnectionsTreeInput {
	data: IConnectionsData;
	snapshots: Map<string, ISshConnectionSnapshot>;
}

export function isHostElement(e: unknown): e is HostElement {
	return e instanceof HostElement;
}

export function isGroupElement(e: unknown): e is GroupElement {
	return e instanceof GroupElement;
}

/** 未分组虚拟分组 */
export const UNGROUPED_ID = '__ungrouped__';
export const UNGROUPED_GROUP: IHostGroup = { id: UNGROUPED_ID, name: localize('ishell.ungrouped', '未分组') };

// ==== Delegate ====

export class ConnectionsDelegate implements IListVirtualDelegate<ConnectionTreeElement> {
	getHeight(_element: ConnectionTreeElement): number {
		return 22;
	}
	getTemplateId(element: ConnectionTreeElement): string {
		return element instanceof GroupElement ? GroupRenderer.TEMPLATE_ID : HostRenderer.TEMPLATE_ID;
	}
}

// ==== Identity ====

export class ConnectionsIdentityProvider implements IIdentityProvider<ConnectionTreeElement> {
	getId(element: ConnectionTreeElement): string {
		if (element instanceof GroupElement) {
			return `group:${element.group.id}`;
		}
		return `host:${element.profile.id}`;
	}
}

// ==== DataSource ====

export class ConnectionsDataSource implements IAsyncDataSource<IConnectionsTreeInput, ConnectionTreeElement> {

	constructor(private readonly input: IConnectionsTreeInput) { }

	hasChildren(element: IConnectionsTreeInput | ConnectionTreeElement): boolean {
		if (element instanceof GroupElement) {
			return true;
		}
		if (element instanceof HostElement) {
			return false;
		}
		return true; // root
	}

	async getChildren(element: IConnectionsTreeInput | ConnectionTreeElement): Promise<ConnectionTreeElement[]> {
		if (element instanceof GroupElement) {
			return element.children;
		}
		if (element instanceof HostElement) {
			return [];
		}
		const { data, snapshots } = this.input;
		const result: ConnectionTreeElement[] = [];
		for (const group of [...data.groups].sort((a, b) => a.name.localeCompare(b.name))) {
			const hosts = data.hosts.filter(h => h.groupId === group.id);
			result.push(new GroupElement(group, hosts, snapshots));
		}
		const ungrouped = data.hosts.filter(h => !h.groupId || !data.groups.some(g => g.id === h.groupId));
		if (ungrouped.length > 0) {
			result.push(new GroupElement(UNGROUPED_GROUP, ungrouped, snapshots));
		}
		return result;
	}
}

// ==== Renderers ====

export interface IHostTemplateData {
	statusDot: HTMLElement;
	label: IconLabel;
}

export class HostRenderer implements ITreeRenderer<HostElement, FuzzyScore, IHostTemplateData> {

	static readonly TEMPLATE_ID = 'ishell.host';

	get templateId(): string {
		return HostRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): IHostTemplateData {
		const row = document.createElement('div');
		row.classList.add('ishell-row');
		container.appendChild(row);

		const statusDot = document.createElement('span');
		statusDot.classList.add('ishell-status-dot');
		row.appendChild(statusDot);

		const icon = document.createElement('span');
		icon.classList.add('codicon', 'codicon-server', 'ishell-host-icon');
		row.appendChild(icon);

		const label = new IconLabel(row, { supportHighlights: true, supportDescriptionHighlights: true });
		return { statusDot, label };
	}

	renderElement(node: ITreeNode<HostElement, FuzzyScore>, _index: number, templateData: IHostTemplateData): void {
		const host = node.element;
		const status = host.snapshot?.status ?? 'disconnected';
		templateData.statusDot.className = `ishell-status-dot status-${status}`;

		const authLabel = host.profile.authMethod === 'password'
			? localize('ishell.authPassword', '密码认证')
			: host.profile.authMethod === 'key'
				? localize('ishell.authKey', '密钥认证')
				: localize('ishell.authAgent', 'Agent 认证');

		templateData.label.setLabel(
			host.profile.name || host.profile.host,
			`${host.profile.username}@${host.profile.host}:${host.profile.port}`,
			{
				title: host.snapshot?.detail
					? `${host.profile.name} — ${host.snapshot.detail}`
					: `${host.profile.name}（${authLabel}）`,
			}
		);
	}

	disposeTemplate(templateData: IHostTemplateData): void {
		templateData.label.dispose();
	}
}

export interface IGroupTemplateData {
	label: IconLabel;
}

export class GroupRenderer implements ITreeRenderer<GroupElement, FuzzyScore, IGroupTemplateData> {

	static readonly TEMPLATE_ID = 'ishell.group';

	get templateId(): string {
		return GroupRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): IGroupTemplateData {
		const row = document.createElement('div');
		row.classList.add('ishell-row');
		container.appendChild(row);

		const icon = document.createElement('span');
		icon.classList.add('codicon', 'codicon-folder', 'ishell-group-icon');
		row.appendChild(icon);

		const label = new IconLabel(row, { supportHighlights: true, supportDescriptionHighlights: true });
		return { label };
	}

	renderElement(node: ITreeNode<GroupElement, FuzzyScore>, _index: number, templateData: IGroupTemplateData): void {
		const group = node.element;
		const count = group.hosts.length;
		templateData.label.setLabel(group.group.name, count > 0 ? String(count) : undefined);
	}

	disposeTemplate(templateData: IGroupTemplateData): void {
		templateData.label.dispose();
	}
}

// ==== 导航/无障碍 ====

export class ConnectionsNaviLabelProvider implements IKeyboardNavigationLabelProvider<ConnectionTreeElement> {

	getKeyboardNavigationLabel(element: ConnectionTreeElement): { toString(): string } {
		if (element instanceof GroupElement) {
			return element.group.name;
		}
		return `${element.profile.name} ${element.profile.host} ${element.profile.username}`;
	}
}

export class ConnectionsAccessibilityProvider implements IListAccessibilityProvider<ConnectionTreeElement> {

	getWidgetAriaLabel(): string {
		return localize('ishell.connectionsTree', 'iShell 连接管理');
	}

	getAriaLabel(element: ConnectionTreeElement): string | null {
		if (element instanceof GroupElement) {
			return localize('ishell.groupAria', '分组 {0}', element.group.name);
		}
		const status = element.snapshot?.status ?? 'disconnected';
		const statusText: Record<string, string> = {
			connected: localize('ishell.stConnected', '已连接'),
			connecting: localize('ishell.stConnecting', '连接中'),
			reconnecting: localize('ishell.stReconnecting', '重连中'),
			failed: localize('ishell.stFailed', '连接失败'),
			disconnected: localize('ishell.stDisconnected', '未连接'),
		};
		return `${element.profile.name}，${statusText[status] ?? status}`;
	}
}
