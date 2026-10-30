/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILlmNetworkModel, ILlmSourceConfig } from '../common/llm.js';

// #########################################################################
// ##            网络模型搜索（HuggingFace 兼容 API）                       ##
// ##  官方源走 huggingface.co，国内镜像走 hf-mirror.com，两者 API 同构。   ##
// ##  仅检索 GGUF 库（本地引擎只消费 GGUF），按下载量降序取前 30 条。      ##
// #########################################################################

/** 单次搜索返回条数上限 */
const SEARCH_LIMIT = 30;
/** 请求超时（毫秒） */
const SEARCH_TIMEOUT_MS = 8000;

/** 由下载源推导 API 基址：镜像源换用 hf-mirror.com，其余取源端点 origin */
export function apiBaseOfSource(source: ILlmSourceConfig): string {
	if (source.kind === 'mirror') {
		return 'https://hf-mirror.com';
	}
	try {
		return new URL(source.endpoint).origin;
	} catch {
		return 'https://huggingface.co';
	}
}

/** 构建搜索请求 URL（library=gguf 过滤本地引擎可消费的量化格式） */
export function buildSearchUrl(apiBase: string, query: string): string {
	const params = new URLSearchParams({
		search: query,
		library: 'gguf',
		limit: String(SEARCH_LIMIT),
		sort: 'downloads',
		direction: '-1',
	});
	return `${apiBase}/api/models?${params.toString()}`;
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

/** 联网搜索网络模型（主进程调用；超时或网络异常返回空列表不抛错） */
export async function fetchNetworkModels(query: string, source: ILlmSourceConfig): Promise<ILlmNetworkModel[]> {
	const trimmed = query.trim();
	if (trimmed === '') {
		return [];
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const response = await fetch(buildSearchUrl(apiBaseOfSource(source), trimmed), {
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
