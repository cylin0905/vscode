/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILlmNetworkFile, ILlmNetworkModel, ILlmSourceConfig, LLM_NETWORK_PAGE_SIZE } from '../common/llm.js';
import { MODELSCOPE_ENDPOINT } from './llmModelStore.js';

// #########################################################################
// ##            网络模型搜索（HuggingFace / ModelScope）                   ##
// ##  官方源走 huggingface.co，国内镜像走 hf-mirror.com（API 同构）；       ##
// ##  魔搭走 modelscope.cn 的 dolphin 接口（PUT 搜索 + repo/files 列表）。   ##
// ##  仅检索 GGUF 库（本地引擎只消费 GGUF），按下载量降序分页取（每页 100） ##
// #########################################################################

/** 请求超时（毫秒） */
const SEARCH_TIMEOUT_MS = 8000;
/** ModelScope 分片 GGUF 命名（如 xxx-00001-of-00004.gguf）：不进入可选列表，避免只下载单个分片 */
const MODELSCOPE_SPLIT_SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/i;
/** 辅助 GGUF（mmproj 视觉投影 / imatrix 量化校准）：不能作为主模型加载（引擎报 CLIP cannot be used as main model） */
const AUXILIARY_GGUF_RE = /mmproj|imatrix/i;

/** 非量化/全精度 GGUF（bf16 / f16 / f32 等）：体积大且不适合普通设备，排在量化选项之后 */
const NON_QUANT_GGUF_RE = /[-_.](?:bf16|fp16|fp32|f16|f32|fp8|f8)(?:[-_.]|$)/i;

/** 是否为辅助 GGUF 文件（不能作为主模型启动） */
export function isAuxiliaryGgufFile(name: string): boolean {
	return AUXILIARY_GGUF_RE.test(name);
}

/** 是否为非量化（全精度）GGUF 文件 */
export function isNonQuantGgufFile(name: string): boolean {
	return NON_QUANT_GGUF_RE.test(name);
}

/** GGUF 排序：量化优先（按体积升序），非量化全精度文件后置 */
function compareGgufFiles(a: ILlmNetworkFile, b: ILlmNetworkFile): number {
	const aNonQuant = isNonQuantGgufFile(a.file) ? 1 : 0;
	const bNonQuant = isNonQuantGgufFile(b.file) ? 1 : 0;
	if (aNonQuant !== bNonQuant) {
		return aNonQuant - bNonQuant;
	}
	return (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
}

/** 由下载源推导 API 基址：镜像源换用 hf-mirror.com，魔搭固定 modelscope.cn，其余取源端点 origin */
export function apiBaseOfSource(source: ILlmSourceConfig): string {
	if (source.kind === 'mirror') {
		return 'https://hf-mirror.com';
	}
	if (source.kind === 'modelscope') {
		return MODELSCOPE_ENDPOINT;
	}
	try {
		return new URL(source.endpoint).origin;
	} catch {
		return 'https://huggingface.co';
	}
}

/** 构建 HuggingFace 搜索请求 URL（library=gguf 过滤本地引擎可消费的量化格式；offset 为已取条数） */
export function buildSearchUrl(apiBase: string, query: string, offset = 0): string {
	const params = new URLSearchParams({
		search: query,
		library: 'gguf',
		limit: String(LLM_NETWORK_PAGE_SIZE),
		sort: 'downloads',
		direction: '-1',
	});
	if (offset > 0) {
		params.set('skip', String(offset));
	}
	return `${apiBase}/api/models?${params.toString()}`;
}

/** 构建 ModelScope 模型搜索请求地址（PUT） */
export function buildModelScopeSearchUrl(apiBase: string): string {
	return `${apiBase}/api/v1/dolphin/models`;
}

/** 构建 ModelScope 搜索请求体（Criterion 按 libraries=gguf 过滤，下载量降序；page 从 1 开始） */
export function buildModelScopeSearchBody(query: string, page = 1): Record<string, unknown> {
	return {
		PageSize: LLM_NETWORK_PAGE_SIZE,
		PageNumber: page,
		SortBy: 'DownloadsCount',
		Name: query.trim(),
		Target: '',
		Criterion: [{ category: 'libraries', predicate: 'contains', values: ['gguf'] }],
	};
}

/** 解析 HF /api/models 响应条目 → ILlmNetworkModel（容错：缺字段条目跳过） */
export function parseNetworkModels(payload: unknown): ILlmNetworkModel[] {
	if (!Array.isArray(payload)) {
		return [];
	}
	const models: ILlmNetworkModel[] = [];
	for (const raw of payload) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const item = raw as Record<string, unknown>;
		const id = typeof item.id === 'string' ? item.id : '';
		if (id === '' || !id.includes('/')) {
			continue;
		}
		const author = id.slice(0, id.indexOf('/'));
		models.push({
			id,
			author,
			name: id.slice(id.indexOf('/') + 1),
			downloads: typeof item.downloads === 'number' ? item.downloads : 0,
			likes: typeof item.likes === 'number' ? item.likes : 0,
			pipelineTag: typeof item.pipeline_tag === 'string' ? item.pipeline_tag : undefined,
			tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
		});
	}
	return models;
}

/** 解析 ModelScope dolphin/models 响应 → ILlmNetworkModel（仅保留 GGUF 仓库） */
export function parseModelScopeModels(payload: unknown): ILlmNetworkModel[] {
	if (typeof payload !== 'object' || payload === null) {
		return [];
	}
	const data = (payload as Record<string, unknown>).Data;
	if (typeof data !== 'object' || data === null) {
		return [];
	}
	const model = (data as Record<string, unknown>).Model;
	if (typeof model !== 'object' || model === null) {
		return [];
	}
	const rawList = (model as Record<string, unknown>).Models;
	if (!Array.isArray(rawList)) {
		return [];
	}
	const models: ILlmNetworkModel[] = [];
	for (const raw of rawList) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const item = raw as Record<string, unknown>;
		const author = typeof item.Path === 'string' ? item.Path.trim() : '';
		const name = typeof item.Name === 'string' ? item.Name.trim() : '';
		if (author === '' || name === '') {
			continue;
		}
		const libraries = Array.isArray(item.Libraries) ? item.Libraries.filter((t): t is string => typeof t === 'string') : [];
		// 服务端已按 libraries=gguf 过滤；客户端再兜底，防止接口版本差异漏过滤
		if (!libraries.some(lib => lib.toLowerCase() === 'gguf') && !/gguf/i.test(name)) {
			continue;
		}
		const tasks = Array.isArray(item.Tasks) ? item.Tasks : [];
		const firstTask = typeof tasks[0] === 'object' && tasks[0] !== null ? tasks[0] as Record<string, unknown> : undefined;
		models.push({
			id: `${author}/${name}`,
			author,
			name,
			downloads: typeof item.Downloads === 'number' ? item.Downloads : 0,
			likes: typeof item.Stars === 'number' ? item.Stars : 0,
			pipelineTag: firstTask && typeof firstTask.Name === 'string' ? firstTask.Name : undefined,
			tags: libraries,
		});
	}
	return models;
}

/** 联网搜索网络模型（主进程调用；page 从 0 开始；超时或网络异常返回空列表不抛错） */
export async function fetchNetworkModels(query: string, source: ILlmSourceConfig, page = 0): Promise<ILlmNetworkModel[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		if (source.kind === 'modelscope') {
			const response = await fetch(buildModelScopeSearchUrl(apiBaseOfSource(source)), {
				method: 'PUT',
				signal: controller.signal,
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify(buildModelScopeSearchBody(query, page + 1)),
			});
			if (!response.ok) {
				return [];
			}
			return parseModelScopeModels(await response.json());
		}
		const response = await fetch(buildSearchUrl(apiBaseOfSource(source), query.trim(), page * LLM_NETWORK_PAGE_SIZE), {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		if (!response.ok) {
			return [];
		}
		return parseNetworkModels(await response.json());
	} catch {
		return []; // 网络不可达 / 超时：静默回退为空结果
	} finally {
		clearTimeout(timer);
	}
}

// #########################################################################
// ##            网络仓库文件列表（下载模型卡片用）                         ##
// ##  HF 走 /api/models/{repo}/tree/main；ModelScope 走 repo/files。        ##
// ##  只保留 .gguf，按体积升序返回。                                        ##
// #########################################################################

/** 构建 HF 仓库文件树请求 URL（主分支） */
export function buildModelFilesUrl(apiBase: string, repoId: string): string {
	return `${apiBase}/api/models/${repoId}/tree/main`;
}

/** 仓库路径逐段编码（保留斜杠分隔） */
function encodeRepoPath(repoId: string): string {
	return repoId.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/** 构建 ModelScope 仓库文件列表请求 URL（递归拉取全部分支文件） */
export function buildModelScopeFilesUrl(apiBase: string, repoId: string): string {
	return `${apiBase}/api/v1/models/${encodeRepoPath(repoId)}/repo/files?Revision=master&Recursive=True`;
}

/** 解析 HF 文件树响应 → 可下载 GGUF 文件列表（容错：缺字段条目跳过） */
export function parseNetworkModelFiles(payload: unknown): ILlmNetworkFile[] {
	if (!Array.isArray(payload)) {
		return [];
	}
	const files: ILlmNetworkFile[] = [];
	for (const raw of payload) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const item = raw as Record<string, unknown>;
		if (item.type !== 'file' || typeof item.path !== 'string' || !/\.gguf$/i.test(item.path) || isAuxiliaryGgufFile(item.path)) {
			continue;
		}
		const lfs = typeof item.lfs === 'object' && item.lfs !== null ? item.lfs as Record<string, unknown> : undefined;
		const size = typeof item.size === 'number'
			? item.size
			: (lfs && typeof lfs.size === 'number' ? lfs.size : undefined);
		files.push({ file: item.path, sizeBytes: size });
	}
	return files.sort(compareGgufFiles);
}

/** 解析 ModelScope repo/files 响应 → 可下载 GGUF 文件列表（排除分片，量化优先 + 体积升序） */
export function parseModelScopeModelFiles(payload: unknown): ILlmNetworkFile[] {
	if (typeof payload !== 'object' || payload === null) {
		return [];
	}
	const data = (payload as Record<string, unknown>).Data;
	if (typeof data !== 'object' || data === null) {
		return [];
	}
	const rawFiles = (data as Record<string, unknown>).Files;
	if (!Array.isArray(rawFiles)) {
		return [];
	}
	const files: ILlmNetworkFile[] = [];
	for (const raw of rawFiles) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const item = raw as Record<string, unknown>;
		const type = typeof item.Type === 'string' ? item.Type : '';
		const path = typeof item.Path === 'string' ? item.Path : '';
		if ((type !== 'blob' && type !== 'file') || !/\.gguf$/i.test(path) || MODELSCOPE_SPLIT_SHARD_RE.test(path) || isAuxiliaryGgufFile(path)) {
			continue;
		}
		files.push({ file: path, sizeBytes: typeof item.Size === 'number' ? item.Size : undefined });
	}
	return files.sort(compareGgufFiles);
}

/** 联网读取仓库内 GGUF 文件列表（超时/异常返回空列表） */
export async function fetchNetworkModelFiles(repoId: string, source: ILlmSourceConfig): Promise<ILlmNetworkFile[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const isModelScope = source.kind === 'modelscope';
		const url = isModelScope
			? buildModelScopeFilesUrl(apiBaseOfSource(source), repoId)
			: buildModelFilesUrl(apiBaseOfSource(source), repoId);
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		if (!response.ok) {
			return [];
		}
		const payload = await response.json();
		return isModelScope ? parseModelScopeModelFiles(payload) : parseNetworkModelFiles(payload);
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}
