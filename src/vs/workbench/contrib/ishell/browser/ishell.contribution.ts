/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import Severity from '../../../../base/common/severity.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IIshellService } from '../common/ishell.js';
import { IIshellLlmService } from '../common/llm.js';
import { IshellService } from '../electron-sandbox/ishellService.js';
import { IshellLlmService } from '../electron-sandbox/llmService.js';
import { ConnectionsView, IshellConnectionsContextMenu, IshellConnectionsTitleMenu } from './connectionsView.js';
import { connectHost, deleteGroup, deleteHost, moveHostToGroup, pickAndDisconnect } from './connectionActions.js';
import { showConnectionWizard, showQuickConnect } from './connectionWizard.js';
import { SshTerminalEditor } from './sshTerminalEditor.js';
import { SshTerminalEditorInput, DEFAULT_TERMINAL_FONT_SIZE, getTerminalFontSize, setTerminalFontSize } from './sshTerminalEditorInput.js';
import { newTerminalCommand, openTerminalForProfile, IShellTerminalServices } from './terminalActions.js';
import { LlmModelsView } from './llmModelsView.js';
import { LlmModelsEditor } from './llmModelsEditor.js';
import { LlmModelsEditorInput } from './llmModelsEditorInput.js';
import { LlmChatModelsContribution } from './llmChatModels.js';
import { LlmChatAgentContribution } from './llmChatAgent.js';
import { registerLlmCompletionContribution } from './llmCompletion.js';
import { LlmDiagnosticsContribution, registerLlmDiagnosticsActions } from './llmDiagnostics.js';
import { registerLlmFixContribution } from './llmFix.js';
import { registerLlmHistoryActions } from './llmHistory.js';
import { registerLlmInstructionActions } from './llmInstructionsExecute.js';
import { registerLlmActions } from './llmActions.js';
import { registerLlmSkillActions } from './llmSkills.js';

// ==== 服务注册（渲染层代理 -> 主进程） ====

registerSingleton(IIshellService, IshellService, InstantiationType.Delayed);
registerSingleton(IIshellLlmService, IshellLlmService, InstantiationType.Delayed);

const ishellViewIcon = registerIcon('ishell-view-icon', Codicon.terminal, localize('ishell.viewIcon', 'iShell 连接视图图标'));
const ishellLlmModelsViewIcon = registerIcon('ishell-llm-models-view-icon', Codicon.sparkle, localize('ishell.llm.modelsViewIcon', 'iShell 本地模型视图图标'));

// ==== 视图容器（活动栏"连接"） ====

const VIEW_CONTAINER_ID = 'workbench.view.ishell';

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEW_CONTAINER_ID,
	title: localize2('ishell.activityTitle', "连接"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: ishellViewIcon,
	storageId: VIEW_CONTAINER_ID,
	order: 2,
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

// ==== 视图容器（活动栏"本地模型"，与"连接"平级并列；侧边栏厂家导航 + 中间模型广场 + 内置 Chat 对话） ====

const LLM_MODELS_VIEW_CONTAINER_ID = 'workbench.view.ishellLlmModels';

const llmModelsContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: LLM_MODELS_VIEW_CONTAINER_ID,
	title: localize2('ishell.llmModels.activityTitle', "本地模型"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [LLM_MODELS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: ishellLlmModelsViewIcon,
	storageId: LLM_MODELS_VIEW_CONTAINER_ID,
	order: 1,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

// 本地模型管理视图（独立顶级容器的单视图：引擎状态/下载源/推荐/模型管理）
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: LlmModelsView.ID,
	name: localize2('ishell.llmModelsView', "本地模型"),
	containerIcon: ishellLlmModelsViewIcon,
	ctorDescriptor: new SyncDescriptor(LlmModelsView),
	canToggleVisibility: false,
	canMoveView: false,
	openCommandActionDescriptor: {
		id: LLM_MODELS_VIEW_CONTAINER_ID,
		mnemonicTitle: localize({ key: 'ishell.llm.miFocusModels', comment: ['&& denotes a mnemonic'] }, "本地&&模型"),
		title: localize2('ishell.llm.focusModelsView', "本地模型管理"),
		order: 1,
	},
}], llmModelsContainer);

// ==== 本地模型广场编辑器（中间编辑器区域的模型卡片页） ====

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		LlmModelsEditor,
		LlmModelsEditorInput.EDITOR_ID,
		localize('ishell.llm.modelsEditorName', '模型管理')
	),
	[new SyncDescriptor(LlmModelsEditorInput)]
);

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

/** 内置终端字体列表（设置下拉 + 字体切换命令共用；未安装的字体自动回退到链上备选） */
const TERMINAL_FONT_CHOICES: { label: string; value: string; description: string }[] = [
	{ label: 'Consolas', value: 'Consolas, "Courier New", monospace', description: localize('ishell.font.consolas', 'Windows 经典等宽字体') },
	{ label: 'Cascadia Mono', value: '"Cascadia Mono", Consolas, "Courier New", monospace', description: localize('ishell.font.cascadiaMono', 'Windows 11 默认终端字体') },
	{ label: 'Cascadia Code', value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', description: localize('ishell.font.cascadiaCode', '支持连字（ligatures）') },
	{ label: 'JetBrains Mono', value: '"JetBrains Mono", Consolas, "Courier New", monospace', description: localize('ishell.font.jetbrainsMono', 'JetBrains 系默认字体') },
	{ label: 'Fira Code', value: '"Fira Code", Consolas, "Courier New", monospace', description: localize('ishell.font.firaCode', '支持连字') },
	{ label: 'Source Code Pro', value: '"Source Code Pro", Consolas, "Courier New", monospace', description: localize('ishell.font.sourceCodePro', 'Adobe 等宽字体') },
	{ label: 'Sarasa Mono SC', value: '"Sarasa Mono SC", Consolas, "Courier New", monospace', description: localize('ishell.font.sarasa', '中英双宽对齐等宽') },
	{ label: 'Courier New', value: '"Courier New", monospace', description: localize('ishell.font.courier', '通用衬线等宽') },
];

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
	id: 'ishell.llm',
	title: localize('ishell.llmConfigTitle', 'iShell 本地模型'),
	properties: {
		'ishell.llm.apiPort': {
			type: 'number',
			default: 1234,
			minimum: 1024,
			maximum: 65535,
			description: localize('ishell.llm.cfg.apiPort', '本地 OpenAI 兼容 API 端口（LM Studio 规范，默认 1234；被占用时自动递增）')
		},
		'ishell.llm.contextSize': {
			type: 'number',
			default: 4096,
			minimum: 512,
			maximum: 131072,
			description: localize('ishell.llm.cfg.contextSize', '模型上下文窗口大小（token 数，越大内存占用越高）')
		},
		'ishell.llm.gpuLayers': {
			type: 'number',
			default: 0,
			minimum: 0,
			maximum: 999,
			description: localize('ishell.llm.cfg.gpuLayers', '卸载到 GPU/NPU 的层数（0 = 纯 CPU 推理；llama.cpp -ngl 参数）')
		},
		'ishell.llm.chat.maxTokens': {
			type: 'number',
			default: 2048,
			minimum: 128,
			maximum: 32768,
			description: localize('ishell.llm.cfg.chatMaxTokens', '单次对话最多生成的 token 数（防止小模型陷入无限复读；生成文件过大时可调高）')
		},
		'ishell.llm.chat.repeatGuardThreshold': {
			type: 'number',
			default: 8,
			minimum: 0,
			maximum: 50,
			description: localize('ishell.llm.cfg.repeatGuard', '重复检测阈值：同一段内容（忽略数字）连续出现的行数达到该值时自动中止生成（0 = 关闭检测）')
		},
		'ishell.llm.context.files': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.contextFiles', '追问上下文：对话时自动读取相关文件（用户提到的文件 / 本会话改过的文件 / 当前编辑器文件）的当前内容提供给模型，支持「继续优化」类多轮迭代')
		},
		'ishell.llm.context.maxFiles': {
			type: 'number',
			default: 3,
			minimum: 0,
			maximum: 10,
			description: localize('ishell.llm.cfg.contextMaxFiles', '单轮最多附带多少个文件的内容（0 = 不附带）')
		},
		'ishell.llm.context.maxFileChars': {
			type: 'number',
			default: 4000,
			minimum: 500,
			maximum: 20000,
			description: localize('ishell.llm.cfg.contextMaxFileChars', '单个文件最多附带的字符数（超出部分截断；总量还会按上下文窗口再收敛）')
		},
		'ishell.llm.enginePath': {
			type: 'string',
			default: '',
			description: localize('ishell.llm.cfg.enginePath', '自定义 llama-server.exe 路径（留空 = 使用应用下载的引擎）')
		},
		'ishell.llm.modelDirectory': {
			type: 'string',
			default: '',
			description: localize('ishell.llm.cfg.modelDirectory', '模型存储目录（留空 = 使用默认目录）')
		},
		'ishell.llm.persistence.enabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.persistenceEnabled', '自动持久化本地模型的输出产物（对话转录 Markdown 与代码块文件，原子写入）')
		},
		'ishell.llm.persistence.path': {
			type: 'string',
			default: '',
			description: localize('ishell.llm.cfg.persistencePath', '产物保存目录（留空 = 用户数据目录 ishell/llm/artifacts；支持绝对路径或工作区相对路径）')
		},
		'ishell.llm.persistence.namingRule': {
			type: 'string',
			default: '{date}/{sessionId}/{time}-{requestId}-{slug}{ext}',
			description: localize('ishell.llm.cfg.namingRule', '自定义产物命名规则。占位符：{date} 日期、{sessionId} 会话、{time} 时刻、{requestId} 请求 id、{slug} 内容摘要、{ext} 扩展名')
		},
		'ishell.llm.persistence.includeCodeBlocks': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.includeCodeBlocks', '除转录外，把回答中的每个代码块另存为独立文件（按语言推断扩展名）')
		},
		'ishell.llm.instructions.enabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.instructionsEnabled', '指令跟随：自动解析并执行回答中的 ### ishell:write / ishell:edit 指令块（终端命令始终需手动确认，不受此开关影响）')
		},
		'ishell.llm.workflow.stagedPlan': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.stagedPlan', '分步工作流：回答前先让模型产出「内部思考 + 任务计划」，再进入代码执行阶段（Trae 式思考 → 规划 → 执行；模型较小会增加一轮耗时，可关闭）')
		},
		'ishell.llm.workflow.showThinking': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.showThinking', '展示思考过程：在 Chat 中实时可视化模型的内部思考（流式原地刷新）')
		},
		'ishell.llm.instructions.autoRethink': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.autoRethink', '模型自行思考：编辑指令未命中原文或合并冲突时，自动把当前文件与修改意图交回本地模型重写（失败才转为人工裁决）')
		},
		'ishell.llm.instructions.autoSaveCodeBlocks': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.autoSaveCodeBlocks', '代码块自动保存：回答中没有 ishell:write 指令时，把回答里的代码块按文件名/语言约定自动保存到当前工作目录（无需手动保存）')
		},
		'ishell.llm.instructions.autoRewriteOnAdviceOnly': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.autoRewriteOnAdviceOnly', '强制落地修改：用户要求修复/优化文件但模型只给了建议时，自动要求模型重写完整文件并保存（避免「只提建议不改代码」）')
		},
		'ishell.llm.instructions.autoFix': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.autoFix', '自动审查排错：模型写入文件后自动运行静态诊断，发现 error 级问题时自动交回模型修复并复检（而非直接结束对话）')
		},
		'ishell.llm.instructions.autoFixMaxRounds': {
			type: 'number',
			default: 2,
			minimum: 0,
			maximum: 5,
			description: localize('ishell.llm.cfg.autoFixMaxRounds', '自动排错每个文件最多尝试的修复轮数（0 表示只审查报告，不做修复）')
		},
		'ishell.llm.instructions.streaming': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.streaming', '边思考边编辑：回答仍在流式生成时，一旦指令块闭合立即执行并落盘（每次写盘自动落版本快照；关闭则等回答结束后统一执行）')
		},
		'ishell.llm.autoSave.enabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.autoSaveEnabled', '模型写入/修改文件前自动落版本快照（供回溯与三方合并；关闭后冲突场景将无法自动合并）')
		},
		'ishell.llm.autoSave.historyLimit': {
			type: 'number',
			default: 20,
			minimum: 1,
			maximum: 200,
			description: localize('ishell.llm.cfg.historyLimit', '每个文件保留的版本快照上限（超出自动清理最旧版本）')
		},
		'ishell.llm.diagnostics.enabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.diagnosticsEnabled', '内置静态代码分析（语法错误 / 逻辑异常 / 潜在 bug / 性能问题，结果进问题面板）')
		},
		'ishell.llm.diagnostics.onSave': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.diagnosticsOnSave', '文件保存后自动触发静态分析（1.5 秒去抖，仅分析文本文件）')
		},
		'ishell.llm.fix.enabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.fixEnabled', '模型自动修复：问题灯泡 / 命令面板"用本地模型自动修复"一键让模型改代码（编辑器内可 Ctrl+Z 撤销；写盘自动落版本快照）')
		},
		'ishell.llm.fix.maxTokens': {
			type: 'number',
			default: 2048,
			minimum: 128,
			maximum: 8192,
			description: localize('ishell.llm.cfg.fixMaxTokens', '自动修复单次生成的 token 上限（大文件需要更大值）')
		},
		'ishell.llm.completion.enabled': {
			type: 'boolean',
			default: true,
			description: localize('ishell.llm.cfg.completionEnabled', '本地模型智能代码补全（仅模型运行中生效；失败自动回退默认补全，不干扰输入）')
		},
		'ishell.llm.completion.maxTokens': {
			type: 'number',
			default: 96,
			minimum: 16,
			maximum: 512,
			description: localize('ishell.llm.cfg.completionMaxTokens', '补全生成 token 上限（越大越慢，建议 32-128）')
		},
		'ishell.llm.completion.maxContextLines': {
			type: 'number',
			default: 80,
			minimum: 10,
			maximum: 400,
			description: localize('ishell.llm.cfg.completionContextLines', '补全时携带光标前上下文的行数（含当前文件前缀）')
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
			default: TERMINAL_FONT_CHOICES[0].value,
			enum: TERMINAL_FONT_CHOICES.map(f => f.value),
			enumDescriptions: TERMINAL_FONT_CHOICES.map(f => f.label),
			description: localize('ishell.cfg.fontFamily', '终端字体（等宽字体），未安装的字体自动回退到备选字体')
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

// ==== 终端外观（字号缩放 / 字体切换） ====

registerAction2(class FontSizeIncreaseAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.terminal.fontSizeIncrease',
			title: localize2('ishell.fontSizeIncrease', "终端：放大字号"),
			category: localize2('ishell.category', "iShell"),
			menu: [{ id: MenuId.CommandPalette, when: undefined }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await setTerminalFontSize(configurationService, getTerminalFontSize(configurationService) + 1);
	}
});

registerAction2(class FontSizeDecreaseAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.terminal.fontSizeDecrease',
			title: localize2('ishell.fontSizeDecrease', "终端：缩小字号"),
			category: localize2('ishell.category', "iShell"),
			menu: [{ id: MenuId.CommandPalette, when: undefined }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await setTerminalFontSize(configurationService, getTerminalFontSize(configurationService) - 1);
	}
});

registerAction2(class FontSizeResetAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.terminal.fontSizeReset',
			title: localize2('ishell.fontSizeReset', "终端：重置字号"),
			category: localize2('ishell.category', "iShell"),
			menu: [{ id: MenuId.CommandPalette, when: undefined }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await setTerminalFontSize(configurationService, DEFAULT_TERMINAL_FONT_SIZE);
	}
});

registerAction2(class SelectTerminalFontAction extends Action2 {
	constructor() {
		super({
			id: 'ishell.terminal.selectFont',
			title: localize2('ishell.selectTerminalFont', "终端：切换字体"),
			category: localize2('ishell.category', "iShell"),
			menu: [{ id: MenuId.CommandPalette, when: undefined }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const current = configurationService.getValue<string>('ishell.terminal.fontFamily');
		const items = TERMINAL_FONT_CHOICES.map(f => ({ label: f.label, description: f.description, picked: f.value === current }));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('ishell.pickFont', '选择终端字体（需本机已安装，未安装自动回退）'),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}
		const choice = TERMINAL_FONT_CHOICES.find(f => f.label === picked.label);
		if (choice && choice.value !== current) {
			await configurationService.updateValue('ishell.terminal.fontFamily', choice.value);
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

// ==== 本地 LLM（M-L4） ====

registerLlmActions();
registerLlmInstructionActions();
registerLlmDiagnosticsActions();
registerLlmSkillActions();
registerLlmHistoryActions();

// 本地模型注册为内置 Chat 的语言模型（引擎 running 时注册，stopped 时注销）
registerWorkbenchContribution2(LlmChatModelsContribution.ID, LlmChatModelsContribution, WorkbenchPhase.AfterRestored);

// 本地模型贡献内置 Chat 的默认参与者（本产品无 Copilot 扩展，缺此注册 Chat 无法发送消息）
registerWorkbenchContribution2(LlmChatAgentContribution.ID, LlmChatAgentContribution, WorkbenchPhase.AfterRestored);

// 静态代码诊断：文件保存后自动分析 + 结果进问题面板（去抖，不影响保存性能）
registerWorkbenchContribution2(LlmDiagnosticsContribution.ID, LlmDiagnosticsContribution, WorkbenchPhase.AfterRestored);

// 模型自动修复：诊断问题灯泡一键让模型改代码（Quick Fix + fixFile 命令）
registerLlmFixContribution();

// 智能代码补全：本地模型运行中提供上下文感知内联补全（失败静默回退）
registerLlmCompletionContribution();
