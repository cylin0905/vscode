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

export type LlmSourceKind = 'official' | 'mirror' | 'modelscope' | 'custom';

export interface ILlmSourceConfig {
	id: string;
	kind: LlmSourceKind;
	/** 显示名（官方源 / 国内镜像 / 魔搭 / 自定义） */
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

/** 网络搜索分页大小（每页条数；滚动到底继续加载下一页直到取完） */
export const LLM_NETWORK_PAGE_SIZE = 100;

/** 网络仓库中的可下载 GGUF 文件 */
export interface ILlmNetworkFile {
	/** 仓库内路径（如 model-q4_k_m.gguf 或 sub/model.gguf） */
	file: string;
	sizeBytes?: number;
}

/** 网络模型下载键 / 目录 id：由仓库与文件名稳定派生（小写、特殊字符归一） */
export function networkModelCatalogId(repo: string, file: string): string {
	const slug = (text: string) => text
		.toLowerCase()
		.replace(/\.gguf$/i, '')
		.replace(/[^a-z0-9._]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '');
	const id = `${slug(repo)}--${slug(file)}`;
	return id === '--' ? 'network-model' : id;
}

// ==== 模型种类 ====

/** 模型种类：对话模型（llama.cpp）或音乐模型（audio.cpp / Yue2） */
export type LlmModelKind = 'chat' | 'music';

/** 音乐模型仓库/命名特征（兼容历史记录，无需迁移） */
export function resolveModelKind(input: {
	repo?: string;
	file?: string;
	name?: string;
	catalogId?: string;
	kind?: LlmModelKind;
}): LlmModelKind {
	if (input.kind) {
		return input.kind;
	}
	const repo = (input.repo ?? '').toLowerCase();
	if (repo.startsWith('audio-cpp/') || repo.includes('audiocpp')) {
		return 'music';
	}
	const text = `${input.name ?? ''} ${input.file ?? ''} ${input.catalogId ?? ''}`.toLowerCase();
	if (/yue2|yue-?2|音乐/.test(text)) {
		return 'music';
	}
	return 'chat';
}

// ==== 模型分类（左侧导航按类别展示 / 模型广场按类别过滤） ====

/** 模型分类元数据：类别尽量全覆盖，便于后期按类别下载与筛选 */
export interface ILlmModelCategory {
	/** 分类 id（同时作为目录条目 tags 中的类别标记） */
	id: string;
	/** 显示名 */
	label: string;
	/** codicon 图标名（不含 codicon- 前缀） */
	codicon: string;
	/** 识别关键词（小写；命中名称/描述/仓库/文件名即归入该分类） */
	keywords: string[];
	/** 额外匹配规则（小写文本；用于 `vl` 这类需要词边界的短标记） */
	pattern?: RegExp;
}

export const LLM_MODEL_CATEGORIES: readonly ILlmModelCategory[] = [
	{ id: 'chat', label: '对话', codicon: 'comment-discussion', keywords: ['chat', 'instruct', 'assistant', 'completion', '对话', '聊天'] },
	{ id: 'reasoning', label: '推理', codicon: 'lightbulb', keywords: ['reasoning', 'thinking', 'cot', 'distill', '推理', '思维链'], pattern: /(^|[^a-z0-9])r1([^a-z0-9]|$)/ },
	{ id: 'code', label: '代码', codicon: 'code', keywords: ['coder', 'code', 'sql', '代码', '编程'] },
	{ id: 'vision', label: '视觉', codicon: 'eye', keywords: ['vision', 'visual', 'llava', '图像理解', '视觉', '看图'], pattern: /(^|[^a-z0-9])vl([^a-z0-9]|$)/ },
	{ id: 'video', label: '视频', codicon: 'device-camera-video', keywords: ['video', 'cogvideo', 'hunyuanvideo', 'wan2', 'cosmos', '视频'] },
	{ id: 'music', label: '音乐', codicon: 'music', keywords: ['music', 'musicgen', 'ace-step', 'yue2', 'yue-2', 'audiocpp', 'audio-cpp', '音乐', '作曲'] },
	{ id: 'audio', label: '语音', codicon: 'mic', keywords: ['speech', 'tts', 'asr', 'whisper', 'voice', 'vocoder', 'parler', '语音', '朗读', '播报'] },
	{ id: 'image', label: '图像生成', codicon: 'file-media', keywords: ['diffusion', 'sdxl', 'stable-diffusion', 'flux', 'lumina', '图像生成', '文生图', '绘图'] },
	{ id: 'embedding', label: '嵌入', codicon: 'symbol-array', keywords: ['embedding', 'embed', 'bge', 'reranker', 'retrieval', '嵌入', '向量', '检索'] },
	{ id: 'multimodal', label: '多模态', codicon: 'layers', keywords: ['multimodal', 'multi-modal', 'omni', 'vlm', '多模态'] },
];

/** 解析条目所属分类：显式 tags 优先；仅有通用 'chat' 标签或未打标签时按关键词推断；未识别归入「对话」 */
export function resolveModelCategories(input: {
	tags?: readonly string[];
	name?: string;
	description?: string;
	repo?: string;
	file?: string;
	id?: string;
}): string[] {
	const tags = new Set((input.tags ?? []).map(tag => tag.toLowerCase()));
	const tagged = LLM_MODEL_CATEGORIES.filter(category => tags.has(category.id));
	// 存在具体类别标签（代码/推理/音乐等）时以标签为准，避免「代码模型也进对话」的重复归类
	if (tagged.length > 0 && tagged.some(category => category.id !== 'chat')) {
		return tagged.map(category => category.id);
	}
	const text = `${input.name ?? ''} ${input.description ?? ''} ${input.repo ?? ''} ${input.file ?? ''} ${input.id ?? ''}`.toLowerCase();
	const result = new Set<string>(tagged.map(category => category.id));
	for (const category of LLM_MODEL_CATEGORIES) {
		if (category.keywords.some(keyword => text.includes(keyword))
			|| (category.pattern !== undefined && category.pattern.test(text))) {
			result.add(category.id);
		}
	}
	if (result.size === 0) {
		result.add('chat');
	}
	return [...result];
}

// ==== 已下载模型 ====

export interface ILlmModelRecord {
	id: string;
	/** 对应预置目录 id（网络下载模型为 networkModelCatalogId） */
	catalogId: string;
	name: string;
	/** GGUF 绝对路径 */
	filePath: string;
	sizeBytes: number;
	downloadedAt: number;
	/** 网络模型来源仓库（预置目录模型为空） */
	repo?: string;
	/** 网络模型来源文件名（预置目录模型为空） */
	file?: string;
	/** 展示用描述（缺省由目录/仓库生成） */
	description?: string;
	/** 推荐最低内存（GB，网络模型按体积估算） */
	minRamGb?: number;
	/** 下载来源（网络模型记录来源源类型；预置目录模型为空） */
	source?: LlmSourceKind;
	/** 该模型的加载参数（覆盖全局配置；缺省字段使用全局默认值） */
	params?: ILlmModelParams;
	/** 模型种类（下载时写入；历史记录由 resolveModelKind 兜底） */
	kind?: LlmModelKind;
}

/** 模型加载 / 生成参数（每个模型独立配置，保存后生效；缺省字段使用全局默认值） */
export interface ILlmModelParams {
	/** 上下文长度（tokens） */
	contextSize?: number;
	/** 卸载到 GPU 的层数（0 = 纯 CPU） */
	gpuLayers?: number;
	/** CPU 线程数（0 = 引擎自动） */
	threads?: number;
	/** 提示词批处理大小 */
	batchSize?: number;
	/** 微批处理大小（显存紧张时调小） */
	ubatchSize?: number;
	/** Flash Attention：auto / on / off */
	flashAttention?: 'auto' | 'on' | 'off';
	/** K 缓存量化类型（f16 / q8_0 / q4_0 等） */
	cacheTypeK?: string;
	/** V 缓存量化类型（f16 / q8_0 / q4_0 等） */
	cacheTypeV?: string;
	/** OpenAI 兼容 API 端口 */
	apiPort?: number;
	/** 采样温度（0 ~ 2） */
	temperature?: number;
	/** Top-P 采样（0 ~ 1） */
	topP?: number;
	/** Top-K 采样（0 = 不限制） */
	topK?: number;
	/** 重复惩罚系数（1.0 = 不惩罚） */
	repeatPenalty?: number;
	/** 单次生成的最大 token 数 */
	maxTokens?: number;
	/** 随机种子（-1 = 每次随机） */
	seed?: number;
	/** 音频推理后端（auto = macOS 用 metal、其他平台 cpu） */
	audioBackend?: 'auto' | 'metal' | 'cuda' | 'cpu';
	/** 音乐 VAE 精度（f16 体积小 / f32 精度高） */
	vaeType?: 'f16' | 'f32';
	/** 音乐推理步数（缺省 24） */
	numInferenceSteps?: number;
	/** 音乐 CoT 模式（缺省 off） */
	cotMode?: 'off' | 'melody' | 'full';
	/** 目标时长（秒；0 = 引擎自动） */
	durationSeconds?: number;
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
	/** 当前可用内存（GB，一位小数）：用于下载前的内存不足提示 */
	availableMemGb: number;
	cpuModel: string;
	cpuCores: number;
	/** 按内存分档推荐适配的目录 id 列表 */
	recommendedModelIds: string[];
}

// ==== 日志 ====

export type LlmLogLevel = 'info' | 'warn' | 'error';

export type LlmLogSource = 'system' | 'engine-download' | 'model-download' | 'engine' | 'gateway' | 'chat' | 'music';

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
export interface ILlmChatOptions {
	/** 单次生成的最大 token 数（缺省由服务端决定） */
	maxTokens?: number;
	/** 采样温度（0 ~ 2；缺省由引擎决定） */
	temperature?: number;
	/** Top-P 采样（0 ~ 1；缺省由引擎决定） */
	topP?: number;
	/** Top-K 采样（缺省由引擎决定） */
	topK?: number;
	/** 重复惩罚系数（缺省由引擎决定） */
	repeatPenalty?: number;
	/** 随机种子（-1 = 每次随机） */
	seed?: number;
}

export interface ILlmChatProvider {
	/** Provider 标识（'local'；未来 'openai' / 'anthropic' 等） */
	readonly id: string;
	isReady(): Promise<boolean>;
	/** 流式对话：每收到一段增量文本回调 onChunk，结束时 resolve；signal 中止 */
	chatStream(messages: ILlmChatMessage[], onChunk: (delta: string) => void, signal: AbortSignal, options?: ILlmChatOptions): Promise<void>;
}

/**
 * 退化重复检测：小模型常在同一段结构上无限复读（如仅编号递增的 CSS 规则）。
 * 取输出尾部窗口，按行归一化（去除数字/多余空白）后统计同一行出现次数，超过阈值即判定为重复。
 */
export function detectDegenerateRepetition(text: string, threshold = 8, windowChars = 2000): boolean {
	const tail = text.slice(-windowChars);
	const counts = new Map<string, number>();
	for (const raw of tail.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length < 8) {
			continue; // 极短行（}、空行等）不参与判定，避免误报
		}
		const key = line.replace(/\d+/g, '#').replace(/\s+/g, ' ');
		const count = (counts.get(key) ?? 0) + 1;
		if (count >= threshold) {
			return true;
		}
		counts.set(key, count);
	}
	return false;
}

export interface ILlmChatChunkEvent {
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

// ==== 音乐生成（audio.cpp / Yue2） ====

export type LlmMusicState = 'preparing' | 'downloading-engine' | 'downloading-model' | 'generating' | 'completed' | 'failed' | 'canceled';

export interface ILlmMusicRequest {
	/** 模型记录 id */
	modelId: string;
	/** 歌名（用于输出文件名；缺省按时间命名） */
	title?: string;
	/** 歌词（多行；Yue2 支持 [verse] / [chorus] 等段落标记，按原文透传） */
	lyrics: string;
	/** 风格描述（如 "pop, female vocal, dreamy"） */
	style: string;
	/** 覆盖模型参数；缺省读 model.params */
	cotMode?: 'off' | 'melody' | 'full';
	steps?: number;
	seed?: number;
	threads?: number;
	audioBackend?: 'auto' | 'metal' | 'cuda' | 'cpu';
	/** 目标时长（秒；0 = 引擎自动） */
	durationSeconds?: number;
}

export interface ILlmMusicProgress {
	requestId: string;
	modelId: string;
	state: LlmMusicState;
	/** 人类可读阶段说明（准备引擎 / 下载附属文件 3/5 / 推理中…） */
	message?: string;
	/** 0~100，未知时 undefined */
	percent?: number;
	/** 引擎最新一行日志（音乐日志区展示） */
	logLine?: string;
}

export interface ILlmMusicResult {
	requestId: string;
	modelId: string;
	modelName: string;
	filePath: string;
	fileName: string;
	elapsedMs: number;
}

export type LlmAudioEngineState = 'missing' | 'downloading' | 'ready' | 'failed';

export interface ILlmAudioEngineInfo {
	state: LlmAudioEngineState;
	enginePath?: string;
	version?: string;
	detail?: string;
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
	/** 网络模型搜索（跟随当前下载源：官方/镜像/魔搭/自定义；page 从 0 开始分页） */
	searchNetworkModels(query: string, page?: number): Promise<ILlmNetworkModel[]>;
	/** 列出网络仓库中可下载的 GGUF 文件（按体积升序，便于挑选量化） */
	listNetworkModelFiles(repoId: string): Promise<ILlmNetworkFile[]>;
	/** 下载网络仓库中的指定 GGUF（进度 id = networkModelCatalogId(repoId, file)） */
	downloadNetworkModel(repoId: string, file: string): Promise<void>;

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
	/** 保存模型加载参数；若该模型正在运行则自动重新加载使其生效 */
	updateModelParams(modelId: string, params: ILlmModelParams): Promise<void>;
	/** 停止模型（关闭网关与引擎进程） */
	stopModel(): Promise<void>;

	// ---- 对话 ----

	/** 发起流式对话，返回 requestId（增量经 onDidChatChunk 推送）；sessionId 用于产物归档分组 */
	sendChat(messages: ILlmChatMessage[], sessionId?: string): Promise<string>;
	/** 中止指定请求的生成 */
	cancelChat(requestId: string): Promise<void>;

	// ---- 音乐生成（audio.cpp / Yue2） ----

	/** 音频引擎状态（进入音乐区时探测，不自动下载） */
	getAudioEngineInfo(): Promise<ILlmAudioEngineInfo>;
	/** 下载 audio.cpp 引擎（进度经 onDidMusicProgress 推送） */
	downloadAudioEngine(): Promise<void>;
	/** 生成音乐；自动准备引擎/附属文件，完成后返回 WAV 路径 */
	generateMusic(request: ILlmMusicRequest): Promise<ILlmMusicResult>;
	/** 读取 WAV 为 base64（渲染层拼 data URL 播放） */
	readMusicAudio(filePath: string): Promise<string>;
	cancelMusicGeneration(requestId: string): Promise<void>;
	/** 在系统文件管理器中定位生成结果 */
	revealMusicFile(filePath: string): Promise<void>;

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
	/** 下载源变化（任意入口切换后通知所有已打开界面刷新） */
	readonly onDidChangeSource: Event<ILlmSourceConfig>;
	/** 聊天流式增量 */
	readonly onDidChatChunk: Event<ILlmChatChunkEvent>;
	/** 音乐生成进度（引擎/附属文件下载 + 推理日志） */
	readonly onDidMusicProgress: Event<ILlmMusicProgress>;
	/** 日志追加（实时） */
	readonly onDidAppendLog: Event<ILlmLogEntry>;
	/** Skill 列表变化（注册 / 卸载 / 目录热加载） */
	readonly onDidChangeSkills: Event<void>;
}
