/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import Severity from '../../../../base/common/severity.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IIshellService } from '../common/ishell.js';
import { IshellService } from '../electron-sandbox/ishellService.js';
import { ConnectionsView, IshellConnectionsContextMenu, IshellConnectionsTitleMenu } from './connectionsView.js';
import { connectHost, deleteGroup, deleteHost, moveHostToGroup, pickAndDisconnect } from './connectionActions.js';
import { showConnectionWizard, showQuickConnect } from './connectionWizard.js';
import { SshTerminalEditor } from './sshTerminalEditor.js';
import { SshTerminalEditorInput } from './sshTerminalEditorInput.js';
import { newTerminalCommand, openTerminalForProfile, IShellTerminalServices } from './terminalActions.js';

// ==== 服务注册（渲染层代理 -> 主进程） ====

registerSingleton(IIshellService, IshellService, InstantiationType.Delayed);

// ==== 视图容器（活动栏"连接"） ====

const ishellViewIcon = registerIcon('ishell-view-icon', Codicon.plug, localize('ishell.viewIcon', 'iShell 连接视图图标'));

const VIEW_CONTAINER_ID = 'workbench.view.ishell';

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEW_CONTAINER_ID,
	title: localize2('ishell.activityTitle', "连接"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: ishellViewIcon,
	storageId: VIEW_CONTAINER_ID,
	order: 0,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: ConnectionsView.ID,
	name: localize2('ishell.connectionsView', "连接管理"),
	containerIcon: ishellViewIcon,
	ctorDescriptor: new SyncDescriptor(ConnectionsView),
	canToggleVisibility: false,
	canMoveView: false,
	openCommandActionDescriptor: {
		id: VIEW_CONTAINER_ID,
		mnemonicTitle: localize({ key: 'ishell.miFocus', comment: ['&& denotes a mnemonic'] }, "&&连接"),
		title: localize2('ishell.focusView', "连接管理"),
		order: 1,
	},
}], container);

// ==== 远程终端编辑器（M3：终端即编辑器标签） ====

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		SshTerminalEditor,
		SshTerminalEditorInput.EDITOR_ID,
		localize('ishell.terminalEditorName', 'iShell 终端')
	),
	[new SyncDescriptor(SshTerminalEditorInput)]
);

// ==== 配置 ====

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'ishell.connection',
	title: localize('ishell.configTitle', 'iShell 连接'),
	properties: {
		'ishell.connection.keepaliveIntervalSeconds': {
			type: 'number',
			default: 15,
			minimum: 1,
			description: localize('ishell.cfg.keepalive', 'SSH keepalive 探活间隔（秒），0 之外的值启用探活')
		},
		'ishell.connection.keepaliveCountMax': {
			type: 'number',
			default: 3,
			minimum: 1,
			description: localize('ishell.cfg.keepaliveMax', 'keepalive 连续无响应次数上限，超过即判定断线并触发自动重连')
		},
		'ishell.connection.connectTimeoutSeconds': {
			type: 'number',
			default: 15,
			minimum: 1,
			description: localize('ishell.cfg.timeout', '连接超时（秒）')
		},
		'ishell.connection.reconnectEnabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.cfg.reconnect', '连接意外断开后自动重连（指数退避）')
		},
		'ishell.connection.reconnectMaxRetries': {
			type: 'number',
			default: 10,
			minimum: 0,
			description: localize('ishell.cfg.retries', '自动重连最大次数（0 = 不限）')
		},
		'ishell.connection.reconnectMaxDelaySeconds': {
			type: 'number',
			default: 30,
			minimum: 1,
			description: localize('ishell.cfg.reconnectDelay', '自动重连最大间隔（秒）')
		},
	}
});

configurationRegistry.registerConfiguration({
	id: 'ishell.terminal',
	title: localize('ishell.terminalConfigTitle', 'iShell 终端'),
	properties: {
		'ishell.terminal.fontSize': {
			type: 'number',
			default: 12,
			minimum: 6,
			maximum: 64,
			description: localize('ishell.cfg.fontSize', '终端字号（像素）')
		},
		'ishell.terminal.fontFamily': {
			type: 'string',
			default: 'Consolas, "Courier New", monospace',
			description: localize('ishell.cfg.fontFamily', '终端字体（等宽字体），多个字体用逗号分隔')
		},
		'ishell.terminal.scrollback': {
			type: 'number',
			default: 1000,
			minimum: 0,
			description: localize('ishell.cfg.scrollback', '终端回滚缓冲行数')
		},
		'ishell.terminal.rightClickAction': {
			type: 'string',
			enum: ['copyPaste', 'menu', 'default'],
			default: 'copyPaste',
			enumDescriptions: [
				localize('ishell.cfg.rightClick.copyPaste', '有选区时复制，无选区时粘贴'),
				localize('ishell.cfg.rightClick.menu', '显示右键菜单'),
				localize('ishell.cfg.rightClick.default', '浏览器默认行为'),
			],
			description: localize('ishell.cfg.rightClick', '终端右键行为（Shift+右键始终为系统菜单）')
		},
	}
});

// ==== 命令辅助 ====

async function getConnectionView(viewsService: IViewsService): Promise<ConnectionsView | undefined> {
	const view = await viewsService.openView(ConnectionsView.ID, false);
	return view instanceof ConnectionsView ? view : undefined;
}

function wizardServices(accessor: ServicesAccessor) {
	return {
		ishellService: accessor.get(IIshellService),
		quickInput: accessor.get(IQuickInputService),
		notificationService: accessor.get(INotificationService),
	};
}

/** 终端命令所需服务（必须在命令 run() 同步段捕获，ServicesAccessor 不能跨 await） */
function terminalServices(accessor: ServicesAccessor): IShellTerminalServices {
	return {
		ishellService: accessor.get(IIshellService),
		quickInput: accessor.get(IQuickInputService),
		notificationService: accessor.get(INotificationService),
		editorService: accessor.get(IEditorService),
		instantiationService: accessor.get(IInstantiationService),
	};
}

// ==== 命令 ====

registerAction2(class NewConnectionAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.newConnection',
			title: localize2('ishell.newConnection', "新建连接"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.add,
			menu: [
				{ id: IshellConnectionsTitleMenu, group: 'navigation', order: 1 },
				{ id: MenuId.CommandPalette, when: undefined },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await showConnectionWizard(wizardServices(accessor));
	}
});

registerAction2(class QuickConnectAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.quickConnect',
			title: localize2('ishell.quickConnect', "快速连接"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.zap,
			menu: [
				{ id: IshellConnectionsTitleMenu, group: 'navigation', order: 2 },
				{ id: MenuId.CommandPalette, when: undefined },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await showQuickConnect(wizardServices(accessor));
	}
});

registerAction2(class NewGroupAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.newGroup',
			title: localize2('ishell.newGroup', "新建分组"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.newFolder,
			menu: [
				{ id: IshellConnectionsTitleMenu, group: 'navigation', order: 3 },
				{ id: MenuId.CommandPalette, when: undefined },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { ishellService, quickInput } = wizardServices(accessor);
		const name = await quickInput.input({
			placeHolder: localize('ishell.groupName', '分组名称'),
			validateInput: async v => v.trim().length === 0 ? localize('ishell.groupNameRequired', '分组名称不能为空') : undefined,
		});
		if (name === undefined) { return; }
		await ishellService.createGroup(name.trim());
	}
});

registerAction2(class ConnectAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.connect',
			title: localize2('ishell.connect', "连接"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.play,
			precondition: ContextKeyExpr.and(ConnectionsView.ctxHostFocused, ConnectionsView.ctxHostConnected.negate(), ConnectionsView.ctxHostBusy.negate()),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'connect', order: 1, when: ContextKeyExpr.and(ConnectionsView.ctxHostFocused, ConnectionsView.ctxHostConnected.negate(), ConnectionsView.ctxHostBusy.negate()) },
				{ id: MenuId.CommandPalette, when: ConnectionsView.ctxHostFocused },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const instantiationService = accessor.get(IInstantiationService);
		const view = await getConnectionView(viewsService);
		const host = view?.getFocusedHost();
		if (host) {
			await connectHost(instantiationService, host.profile);
		}
	}
});

registerAction2(class DisconnectAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.disconnect',
			title: localize2('ishell.disconnect', "断开连接"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.debugDisconnect,
			precondition: ContextKeyExpr.and(ConnectionsView.ctxHostFocused, ContextKeyExpr.or(ConnectionsView.ctxHostConnected, ConnectionsView.ctxHostBusy)),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'connect', order: 2, when: ContextKeyExpr.and(ConnectionsView.ctxHostFocused, ContextKeyExpr.or(ConnectionsView.ctxHostConnected, ConnectionsView.ctxHostBusy)) },
				{ id: MenuId.CommandPalette, when: ContextKeyExpr.and(ConnectionsView.ctxHostFocused, ContextKeyExpr.or(ConnectionsView.ctxHostConnected, ConnectionsView.ctxHostBusy)) },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const ishellService = accessor.get(IIshellService);
		const view = await getConnectionView(viewsService);
		const host = view?.getFocusedHost();
		if (host) {
			await ishellService.disconnect(host.profile.id);
		}
	}
});

registerAction2(class EditConnectionAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.edit',
			title: localize2('ishell.edit', "属性"),
			category: localize2('ishell.category', "iShell"),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'edit', order: 1, when: ConnectionsView.ctxHostFocused },
				{ id: MenuId.CommandPalette, when: ConnectionsView.ctxHostFocused },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const services = wizardServices(accessor);
		const view = await getConnectionView(viewsService);
		const host = view?.getFocusedHost();
		if (host) {
			await showConnectionWizard(services, host.profile);
		}
	}
});

registerAction2(class MoveToGroupAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.moveToGroup',
			title: localize2('ishell.moveToGroup', "移动到分组"),
			category: localize2('ishell.category', "iShell"),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'edit', order: 2, when: ConnectionsView.ctxHostFocused },
				{ id: MenuId.CommandPalette, when: ConnectionsView.ctxHostFocused },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const instantiationService = accessor.get(IInstantiationService);
		const view = await getConnectionView(viewsService);
		const host = view?.getFocusedHost();
		if (host) {
			await moveHostToGroup(instantiationService, host.profile);
		}
	}
});

registerAction2(class DeleteConnectionAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.delete',
			title: localize2('ishell.delete', "删除"),
			category: localize2('ishell.category', "iShell"),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'edit', order: 3, when: ConnectionsView.ctxHostFocused },
				{ id: MenuId.CommandPalette, when: ConnectionsView.ctxHostFocused },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const instantiationService = accessor.get(IInstantiationService);
		const view = await getConnectionView(viewsService);
		const host = view?.getFocusedHost();
		if (host) {
			await deleteHost(instantiationService, host.profile);
		}
	}
});

registerAction2(class RenameGroupAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.renameGroup',
			title: localize2('ishell.renameGroup', "重命名分组"),
			category: localize2('ishell.category', "iShell"),
			precondition: ContextKeyExpr.and(ConnectionsView.ctxGroupFocused, ConnectionsView.ctxGroupReal),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'group', order: 1, when: ContextKeyExpr.and(ConnectionsView.ctxGroupFocused, ConnectionsView.ctxGroupReal) },
				{ id: MenuId.CommandPalette, when: ContextKeyExpr.and(ConnectionsView.ctxGroupFocused, ConnectionsView.ctxGroupReal) },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const { ishellService, quickInput } = wizardServices(accessor);
		const view = await getConnectionView(viewsService);
		const group = view?.getFocusedGroup();
		if (group && group.group.id !== '__ungrouped__') {
			const name = await quickInput.input({
				placeHolder: localize('ishell.groupName', '分组名称'),
				value: group.group.name,
				validateInput: async v => v.trim().length === 0 ? localize('ishell.groupNameRequired', '分组名称不能为空') : undefined,
			});
			if (name === undefined) { return; }
			await ishellService.renameGroup(group.group.id, name.trim());
		}
	}
});

registerAction2(class DeleteGroupAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.deleteGroup',
			title: localize2('ishell.deleteGroup', "删除分组"),
			category: localize2('ishell.category', "iShell"),
			precondition: ContextKeyExpr.and(ConnectionsView.ctxGroupFocused, ConnectionsView.ctxGroupReal),
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'group', order: 2, when: ContextKeyExpr.and(ConnectionsView.ctxGroupFocused, ConnectionsView.ctxGroupReal) },
				{ id: MenuId.CommandPalette, when: ContextKeyExpr.and(ConnectionsView.ctxGroupFocused, ConnectionsView.ctxGroupReal) },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const instantiationService = accessor.get(IInstantiationService);
		const view = await getConnectionView(viewsService);
		const group = view?.getFocusedGroup();
		if (group) {
			await deleteGroup(instantiationService, group.group);
		}
	}
});

registerAction2(class DisconnectSessionAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.connections.disconnectSession',
			title: localize2('ishell.disconnectSession', "断开会话"),
			category: localize2('ishell.category', "iShell"),
			menu: [{ id: MenuId.CommandPalette, when: undefined }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await pickAndDisconnect(accessor.get(IInstantiationService));
	}
});

// ==== 远程终端命令（M3） ====

registerAction2(class NewTerminalAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.terminal.new',
			title: localize2('ishell.newTerminal', "新建终端"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.terminal,
			menu: [{ id: MenuId.CommandPalette, when: undefined }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await newTerminalCommand(terminalServices(accessor));
	}
});

registerAction2(class NewTerminalForHostAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.terminal.newForHost',
			title: localize2('ishell.newTerminalForHost', "新建终端"),
			category: localize2('ishell.category', "iShell"),
			icon: Codicon.terminal,
			precondition: ConnectionsView.ctxHostFocused,
			menu: [
				{ id: IshellConnectionsContextMenu, group: 'terminal', order: 1, when: ConnectionsView.ctxHostFocused },
				{ id: MenuId.CommandPalette, when: ConnectionsView.ctxHostFocused },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const services = terminalServices(accessor);
		const view = await getConnectionView(viewsService);
		const host = view?.getFocusedHost();
		if (host) {
			await openTerminalForProfile(services, host.profile);
		}
	}
});

// ==== 主机指纹确认（TOFU） ====

class IshellHostKeyHandler extends Disposable {

	static readonly ID = 'workbench.contrib.ishellHostKeyHandler';

	constructor(
		@IIshellService ishellService: IIshellService,
		@IDialogService dialogService: IDialogService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this._register(ishellService.onDidRequestHostKeyConfirm(async prompt => {
			if (!prompt) {
				// 防御：IPC 事件负载为空时忽略，避免空引用崩溃
				console.warn('[ishell] hostkey confirm prompt is undefined');
				return;
			}
			const { confirmed } = await dialogService.confirm({
				type: Severity.Warning,
				message: localize('ishell.hostkeyTitle', '无法确认主机 {0}:{1} 的真实性', prompt.host, prompt.port),
				detail: localize('ishell.hostkeyDetail',
					'首次连接到该服务器。\n\n密钥算法：{0}\n指纹（SHA256）：\n{1}\n\n信任并连接后，iShell 将记住该指纹；若日后指纹变化将硬阻断连接。',
					prompt.keyAlgorithm, prompt.fingerprint),
				primaryButton: localize({ key: 'ishell.trust', comment: ['&& denotes a mnemonic'] }, '&&信任并连接'),
				cancelButton: localize('ishell.reject', '取消连接'),
			});
			try {
				await ishellService.confirmHostKey(prompt.sessionId, confirmed);
			} catch (err) {
				notificationService.error(localize('ishell.hostkeyError', '指纹确认失败：{0}', (err as Error).message));
			}
		}));
	}
}

registerWorkbenchContribution2(IshellHostKeyHandler.ID, IshellHostKeyHandler, WorkbenchPhase.BlockRestore);
