/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';
import { arch, cpus, freemem, totalmem } from 'os';
import { ILlmModelCatalogEntry, ILlmSystemInfo } from '../common/llm.js';

/**
 * 预置模型目录（GGUF，全部为主流仓库的 Q4_K_M 量化）+ 机器配置检测与推荐。
 * 目录 id 同时作为下载文件名与推荐键。
 */
export const LLM_MODEL_CATALOG: ILlmModelCatalogEntry[] = [
	{
		id: 'qwen2.5-1.5b-instruct-q4km',
		name: 'Qwen2.5 1.5B Instruct',
		vendorId: 'qwen',
		vendorName: 'Qwen',
		repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
		file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
		sizeBytes: 1_117_320_736,
		description: '轻量入门首选，速度快、内存占用低',
		minRamGb: 6,
		tags: ['chat'],
		vendorIcon: 'qwen',
	},
	{
		id: 'qwen2.5-3b-instruct-q4km',
		name: 'Qwen2.5 3B Instruct',
		vendorId: 'qwen',
		vendorName: 'Qwen',
		repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
		file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
		sizeBytes: 2_104_932_768,
		description: '日常对话均衡之选，中英双语优秀',
		minRamGb: 8,
		tags: ['chat'],
		vendorIcon: 'qwen',
	},
	{
		id: 'llama-3.2-3b-instruct-q4km',
		name: 'Llama 3.2 3B Instruct',
		vendorId: 'meta',
		vendorName: 'Meta',
		repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
		file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
		sizeBytes: 2_019_377_696,
		description: 'Meta 轻量模型，英文任务表现优秀',
		minRamGb: 8,
		tags: ['chat'],
		vendorIcon: 'llama',
	},
	{
		id: 'qwen2.5-7b-instruct-q4km',
		name: 'Qwen2.5 7B Instruct',
		vendorId: 'qwen',
		vendorName: 'Qwen',
		repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
		file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
		sizeBytes: 4_683_074_240,
		description: '高质量中文对话，综合能力全面',
		minRamGb: 12,
		tags: ['chat'],
		vendorIcon: 'qwen',
	},
	{
		id: 'qwen2.5-coder-7b-q4km',
		name: 'Qwen2.5 Coder 7B',
		vendorId: 'qwen',
		vendorName: 'Qwen',
		repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
		file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
		sizeBytes: 4_683_074_336,
		description: '代码专精模型，补全/解释/重构皆宜',
		minRamGb: 12,
		tags: ['code'],
		vendorIcon: 'qwen',
	},
	{
		id: 'deepseek-r1-7b-q4km',
		name: 'DeepSeek R1 Distill 7B',
		vendorId: 'deepseek',
		vendorName: 'DeepSeek',
		repo: 'unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF',
		file: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',
		sizeBytes: 4_683_073_248,
		description: '推理链模型，数学与逻辑推理强化',
		minRamGb: 12,
		tags: ['reasoning'],
		vendorIcon: 'deepseek',
	},
];

export function getCatalogEntry(catalogId: string): ILlmModelCatalogEntry | undefined {
	return LLM_MODEL_CATALOG.find(m => m.id === catalogId);
}

/**
 * 当前可用内存（字节）。
 * macOS 的 freemem() 只统计完全空闲页（常用于文件缓存后极低，实测仅 ~100MB），
 * 需要叠加 inactive + speculative 可回收页；其余平台直接用 freemem()。
 */
function availableMemoryBytes(): number {
	if (process.platform === 'darwin') {
		try {
			const out = execSync('vm_stat', { encoding: 'utf8' });
			const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 0);
			const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)\\.`).exec(out)?.[1] ?? 0);
			const reclaimable = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
			if (pageSize > 0 && reclaimable > 0) {
				// 可回收页并非全部立即可用，按 80% 保守估计
				return reclaimable * pageSize * 0.8;
			}
		} catch {
			// vm_stat 不可用时回退 freemem
		}
	}
	return freemem();
}

/** 读取机器配置并按内存分档生成推荐（minRamGb <= 总内存） */
export function getLlmSystemInfo(): ILlmSystemInfo {
	const totalMemGb = Math.round(totalmem() / 1024 / 1024 / 1024);
	// 可用内存保留一位小数：模型体积接近可用内存时的提示更有意义
	const availableMemGb = Math.round(availableMemoryBytes() / 1024 / 1024 / 1024 * 10) / 10;
	const cpuList = cpus();
	const nodeArch = arch();
	return {
		arch: nodeArch,
		totalMemGb,
		availableMemGb,
		cpuModel: cpuList.length > 0 ? cpuList[0].model : 'unknown',
		cpuCores: cpuList.length,
		recommendedModelIds: LLM_MODEL_CATALOG
			.filter(m => m.minRamGb <= totalMemGb)
			.map(m => m.id),
	};
}
