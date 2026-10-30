/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// #########################################################################
// ##                     iShell 本地 LLM 公共契约                          ##
// ##  本文件被渲染进程（browser/electron-sandbox）与主进程（electron-main） ##
// ##  共同引用，所有类型必须可 JSON 序列化（经 IPC 通道传输）。             ##
// ##  云端扩展：ILlmChatProvider 抽象先行，本地实现打样。                   ##
// #########################################################################

/** IPC 通道名（主进程 <-> 渲染进程） */
export const ISHELL_LLM_IPC_CHANNEL = 'ishellLlm';

// ==== 下载源 ====

export type LlmSourceKind = 'official' | 'mirror' | 'custom';

export interface ILlmSourceConfig {
	id: string;
	kind: LlmSourceKind;
	/** 显示名（官方源 / 国内镜像 / 自定义） */
	name: string;
	/** 模型下载端点，GGUF 直链 = endpoint/{repo}/resolve/main/{file} */
	endpoint: string;
	/** 引擎下载通道：direct = GitHub 直连；ghproxy = gh-proxy.com 加速 */
	engineChannel: 'direct' | 'ghproxy';
}

// ==== 预置模型目录 ====

/** 品牌本地图标键（静态资源存储于 browser/media/，禁止在线 URL） */
export type LlmVendorIcon = 'qwen' | 'deepseek' | 'llama';

export interface ILlmModelCatalogEntry {
	id: string;
	/** 显示名 */
	name: string;
	/** 厂家 id（分组导航用，如 'qwen'） */
	vendorId: string;
	/** 厂家显示名（如 'Qwen'） */
	vendorName: string;
	/** HuggingFace 仓库（如 Qwen/Qwen2.5-7B-Instruct-GGUF） */
	repo: string;
	/** GGUF 文件名 */
	file: string;
	/** 预估下载大小（字节） */
	sizeBytes: number;
	/** 中文一句话定位 */
	description: string;
	/** 推荐最低内存（GB） */
	minRamGb: number;
	tags: string[];
	/** 品牌本地图标（缺省回退内置 codicon 类型图标） */
	vendorIcon?: LlmVendorIcon;
}

// ==== 网络模型搜索（HuggingFace / hf-mirror） ====

export interface ILlmNetworkModel {
	/** 仓库全名（如 Qwen/Qwen2.5-7B-Instruct-GGUF） */
	id: string;
	/** 作者/组织（如 Qwen） */
	author: string;
	/** 模型名（id 去掉作者前缀） */
	name: string;
	/** 近 30 天下载量 */
	downloads: number;
	/** 点赞数 */
	likes: number;
	/** 任务标签（如 text-generation） */
	pipelineTag?: string;
	tags: string[];
}

// ==== 已下载模型 ====

export interface ILlmModelRecord {
	id: string;
	/** 对应预置目录 id */
	catalogId: string;
	name: string;
	/** GGUF 绝对路径 */
	filePath: string;
	sizeBytes: number;
	downloadedAt: number;
}

// ==== 下载进度（引擎 / 模型共用） ====

export type LlmDownloadState = 'downloading' | 'completed' | 'failed' | 'canceled';

export interface ILlmDownloadProgress {
	/** 'engine' 或 catalogId */
	id: string;
	kind: 'engine' | 'model';
	state: LlmDownloadState;
	receivedBytes: number;
	totalBytes: number;
	/** 平均速度（字节/秒） */
	speedBytesPerSec: number;
	error?: string;
}

// ==== 引擎状态 ====

export type LlmEngineState = 'missing' | 'downloading' | 'ready' | 'starting' | 'running' | 'stopped' | 'crashed';

export interface ILlmEngineInfo {
	state: LlmEngineState;
	/** 就位的 llama-server.exe 绝对路径（missing 时为空） */
	enginePath?: string;
	/** llama.cpp 版本 tag（如 b6000） */
	version?: string;
	/** 状态详情（错误信息等） */
	detail?: string;
	/** 当前加载的模型记录 id */
	runningModelId?: string;
	runningModelName?: string;
	/** OpenAI 兼容 API 端点（running 时有值，如 http://127.0.0.1:1234） */
	apiBaseUrl?: string;
}

// ==== 机器配置与推荐 ====

export interface ILlmSystemInfo {
	arch: string;
	totalMemGb: number;
	cpuModel: string;
	cpuCores: number;
	/** 按内存分档推荐适配的目录 id 列表 */
	recommendedModelIds: string[];
}

// ==== 日志 ====

export type LlmLogLevel = 'info' | 'warn' | 'error';

export type LlmLogSource = 'system' | 'engine-download' | 'model-download' | 'engine' | 'gateway' | 'chat';

export interface ILlmLogEntry {
	seq: number;
	/** epoch 毫秒 */
	time: number;
	level: LlmLogLevel;
	source: LlmLogSource;
	message: string;
}

// ==== 对话（Provider 抽象，本地先行、云端预留） ====

export type LlmChatRole = 'system' | 'user' | 'assistant';

export interface ILlmChatMessage {
	role: LlmChatRole;
	content: string;
}

/** 流式对话回调（主进程内 Provider 接口；渲染层经 IPC 事件接收增量） */
export interface ILlmChatProvider {
	/** Provider 标识（'local'；未来 'openai' / 'anthropic' 等） */
	readonly id: string;
	isReady(): Promise<boolean>;
	/** 流式对话：每收到一段增量文本回调 onChunk，结束时 resolve；signal 中止 */
	chatStream(messages: ILlmChatMessage[], onChunk: (delta: string) => void, signal: AbortSignal): Promise<void>;
}

export interface ILlmChatChunkEvent {
	requestId: string;
	/** 增量文本（done=true 时为空） */
	delta?: string;
	done: boolean;
	error?: string;
}

// ==== 模型产物持久化 ====

export type LlmArtifactKind = 'chat-transcript' | 'code-block' | 'diagnostic-report';

export interface ILlmArtifactMeta {
	id: string;
	kind: LlmArtifactKind;
	/** 归档会话标识（聊天会话 / 补全等场景的分组键） */
	sessionId: string;
	/** 触发该产物的对话请求 id */
	requestId: string;
	/** 展示标题（用户消息摘要 / 诊断目标等） */
	title: string;
	/** 相对产物根目录的文件名（可含子目录段） */
	fileName: string;
	/** 绝对路径 */
	filePath: string;
	bytes: number;
	/** epoch 毫秒 */
	createdAt: number;
}

/** 持久化配置快照（配置键：ishell.llm.persistence.*） */
export interface ILlmPersistOptions {
	enabled: boolean;
	/** 自定义保存根目录（空 = 默认 userData/ishell/llm/artifacts） */
	path: string;
	/** 实际生效的产物根目录 */
	resolvedDir: string;
	/** 命名规则，支持 {date} {time} {sessionId} {requestId} {slug} {ext} */
	namingRule: string;
	/** 响应内代码块另存为独立产物文件 */
	includeCodeBlocks: boolean;
}

// ==== 智能补全 ====

export interface ILlmCompletionOptions {
	/** 光标前文本（上下文） */
	prefix: string;
	/** 光标后文本 */
	suffix: string;
	filePath?: string;
	language?: string;
	maxTokens?: number;
}

/** 模型自动修复请求：把现有内容与问题交回本地模型重写（快速修复 / 指令回退"自行思考"共用） */
export interface ILlmFixOptions {
	/** 当前完整内容 */
	content: string;
	language: string;
	/** 问题清单（诊断建议 / 修改意图描述） */
	problems: string[];
	/** 修复目标（自然语言指令） */
	instruction: string;
	maxTokens?: number;
}

// ==== 静态诊断 ====

export type LlmDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export type LlmDiagnosticCategory = 'syntax' | 'logic' | 'bug' | 'performance' | 'style';

export interface ILlmDiagnostic {
	/** 命中的规则 id（如 js-loose-equality） */
	ruleId: string;
	severity: LlmDiagnosticSeverity;
	category: LlmDiagnosticCategory;
	message: string;
	/** 修复建议 */
	suggestion: string;
	/** 1-based 行号 */
	line: number;
	/** 1-based 列 */
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface ILlmDiagnosticReport {
	uri?: string;
	language: string;
	diagnostics: ILlmDiagnostic[];
	summary: { errors: number; warnings: number; infos: number; hints: number; score: number };
	/** 聚合的改进建议（按规则去重） */
	suggestions: string[];
	createdAt: number;
}

// ==== Skill 注册体系 ====

export type LlmSkillOrigin = 'builtin' | 'user' | 'extension';

export interface ILlmSkillManifest {
	id: string;
	name: string;
	description: string;
	version: string;
	/** 触发关键词：用户消息命中即注入该技能指令 */
	triggers: string[];
	/** 注入 system prompt 的指令片段 */
	instruction: string;
	origin: LlmSkillOrigin;
	extensionId?: string;
	enabled: boolean;
}

/** 注册入参（origin 由主进程按 extensionId 裁定） */
export interface ILlmSkillRegistration {
	id: string;
	name: string;
	description: string;
	version: string;
	triggers: string[];
	instruction: string;
	enabled?: boolean;
	extensionId?: string;
}

// ==== 代码版本历史（自动保存 / 冲突合并支撑） ====

export interface ILlmFileVersion {
	id: string;
	/** 快照对应的文件绝对路径 */
	filePath: string;
	time: number;
	bytes: number;
	/** 内容首行摘要 */
	preview: string;
}

/** 根据文件路径推断语言 id（用于规则引擎与诊断展示） */
export function inferLanguageFromPath(path: string): string {
	const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
	switch (ext) {
		case 'ts': return 'typescript';
		case 'tsx': return 'typescriptreact';
		case 'js': return 'javascript';
		case 'jsx': return 'javascriptreact';
		case 'mjs': case 'cjs': return 'javascript';
		case 'py': return 'python';
		case 'go': return 'go';
		case 'rs': return 'rust';
		case 'java': return 'java';
		case 'c': case 'h': return 'c';
		case 'cpp': case 'hpp': case 'cc': return 'cpp';
		case 'cs': return 'csharp';
		case 'php': return 'php';
		case 'rb': return 'ruby';
		case 'kt': return 'kotlin';
		case 'swift': return 'swift';
		case 'sh': case 'bash': case 'zsh': return 'shellscript';
		case 'ps1': return 'powershell';
		case 'sql': return 'sql';
		case 'json': return 'json';
		case 'yml': case 'yaml': return 'yaml';
		case 'html': return 'html';
		case 'css': return 'css';
		case 'md': return 'markdown';
		default: return 'plaintext';
	}
}

// ==== 服务接口 ====

export const IIshellLlmService = createDecorator<IIshellLlmService>('IIshellLlmService');

export interface IIshellLlmService {

	readonly _serviceBrand: undefined;

	// ---- 目录与推荐 ----

	/** 预置模型目录 */
	getModelCatalog(): Promise<ILlmModelCatalogEntry[]>;
	/** 机器配置 + 推荐模型 */
	getSystemInfo(): Promise<ILlmSystemInfo>;
	/** 网络模型搜索（HuggingFace API，跟随当前下载源：官方/镜像） */
	searchNetworkModels(query: string): Promise<ILlmNetworkModel[]>;

	// ---- 下载源 ----

	getSource(): Promise<ILlmSourceConfig>;
	/** 切换源（kind='custom' 时须传 endpoint） */
	setSource(kind: LlmSourceKind, customEndpoint?: string): Promise<ILlmSourceConfig>;
	/** 切换引擎下载通道（GitHub 直连 / gh-proxy 加速） */
	setEngineChannel(channel: 'direct' | 'ghproxy'): Promise<void>;

	// ---- 已下载模型 ----

	getModels(): Promise<ILlmModelRecord[]>;
	/** 下载预置模型（进度经 onDidDownloadProgress 推送） */
	downloadModel(catalogId: string): Promise<void>;
	/** 取消下载（引擎传 'engine'，模型传 catalogId） */
	cancelDownload(id: string): Promise<void>;
	deleteModel(modelId: string): Promise<void>;

	// ---- 引擎 ----

	getEngineInfo(): Promise<ILlmEngineInfo>;
	/** 下载 llama-server 引擎（进度经 onDidDownloadProgress 推送） */
	downloadEngine(): Promise<void>;

	// ---- 运行 ----

	/** 启动模型（加载到 llama-server，就绪后自动开启 API 网关） */
	startModel(modelId: string): Promise<void>;
	/** 停止模型（关闭网关与引擎进程） */
	stopModel(): Promise<void>;

	// ---- 对话 ----

	/** 发起流式对话，返回 requestId（增量经 onDidChatChunk 推送）；sessionId 用于产物归档分组 */
	sendChat(messages: ILlmChatMessage[], sessionId?: string): Promise<string>;
	/** 中止指定请求的生成 */
	cancelChat(requestId: string): Promise<void>;

	// ---- 模型产物持久化 ----

	/** 当前持久化配置（含实际生效目录） */
	getPersistOptions(): Promise<ILlmPersistOptions>;
	/** 产物列表（可按会话过滤） */
	getArtifacts(sessionId?: string): Promise<ILlmArtifactMeta[]>;
	/** 在资源管理器中打开产物目录 */
	openArtifactsFolder(): Promise<string | undefined>;

	// ---- 智能补全 ----

	/** 请求本地模型补全（非流式，主进程超时保护），返回补全文本 */
	sendCompletion(options: ILlmCompletionOptions): Promise<string>;

	// ---- 模型自动修复 ----

	/** 把现有内容与问题交回本地模型重写，返回修复后的完整内容（未运行/超时抛错） */
	applyModelFix(options: ILlmFixOptions): Promise<string>;

	// ---- 静态诊断 ----

	/** 规则引擎静态分析（报告自动归档为诊断产物） */
	analyzeCode(content: string, language: string, path?: string): Promise<ILlmDiagnosticReport>;

	// ---- Skill 注册体系 ----

	getSkills(): Promise<ILlmSkillManifest[]>;
	/** 注册 Skill（清单校验失败抛错）；extensionId 非空视为插件注册 */
	registerSkill(registration: ILlmSkillRegistration): Promise<ILlmSkillManifest>;
	/** 切换 Skill 启停（builtin 状态持久化于技能目录；user/extension 更新各自存储） */
	setSkillEnabled(id: string, enabled: boolean): Promise<ILlmSkillManifest>;
	unregisterSkill(id: string): Promise<void>;
	/** 打开 Skill 用户目录（放置 *.json 热加载） */
	openSkillsFolder(): Promise<string | undefined>;

	// ---- 代码版本历史 ----

	/** 记录版本快照（写文件前调用，支撑冲突检测与三方合并；autoSave.enabled 关闭时返回 undefined） */
	recordFileVersion(filePath: string, content: string): Promise<ILlmFileVersion | undefined>;
	getFileVersions(filePath: string): Promise<ILlmFileVersion[]>;
	/** 读取指定版本内容 */
	readFileVersion(versionId: string): Promise<string | undefined>;

	// ---- 日志 ----

	/** 取日志（sinceSeq 之后的条目；缺省取全部） */
	getLogs(sinceSeq?: number): Promise<ILlmLogEntry[]>;
	clearLogs(): Promise<void>;
	/** 导出日志到文件（主进程弹出保存对话框），返回写入路径或 undefined（取消） */
	exportLogs(): Promise<string | undefined>;

	// ---- 事件 ----

	/** 已下载模型列表变化 */
	readonly onDidChangeModels: Event<void>;
	/** 下载进度（引擎 + 模型） */
	readonly onDidDownloadProgress: Event<ILlmDownloadProgress>;
	/** 引擎状态变化（含网关端口信息） */
	readonly onDidChangeEngine: Event<ILlmEngineInfo>;
	/** 聊天流式增量 */
	readonly onDidChatChunk: Event<ILlmChatChunkEvent>;
	/** 日志追加（实时） */
	readonly onDidAppendLog: Event<ILlmLogEntry>;
	/** Skill 列表变化（注册 / 卸载 / 目录热加载） */
	readonly onDidChangeSkills: Event<void>;
}
