/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { ILlmModelParams, ILlmModelRecord, ILlmSourceConfig, LlmSourceKind } from '../common/llm.js';
import { IFileIO } from './connectionStore.js';

/** 预置下载源端点 */
export const OFFICIAL_ENDPOINT = 'https://huggingface.co';
export const MIRROR_ENDPOINT = 'https://hf-mirror.com';
export const MODELSCOPE_ENDPOINT = 'https://modelscope.cn';

interface ILlmStoreData {
	version: 1;
	/** 当前源（kind + 自定义端点） */
	sourceKind: LlmSourceKind;
	customEndpoint: string;
	/** 引擎下载通道：direct = GitHub 直连；ghproxy = gh-proxy.com 加速 */
	engineChannel: 'direct' | 'ghproxy';
	/** 已安装引擎版本 tag（下载完成时记录） */
	engineVersion: string;
	models: ILlmModelRecord[];
}

const EMPTY_DATA: ILlmStoreData = {
	version: 1,
	sourceKind: 'mirror',
	customEndpoint: '',
	engineChannel: 'ghproxy',
	engineVersion: '',
	models: [],
};

/** 每次返回全新对象（models 数组独立），避免实例间共享可变默认值 */
function freshData(): ILlmStoreData {
	return { ...EMPTY_DATA, models: [] };
}

const SOURCE_NAMES: Record<LlmSourceKind, string> = {
	official: '国外官方源（HuggingFace）',
	mirror: '国内镜像源（hf-mirror.com）',
	modelscope: '魔搭社区（ModelScope）',
	custom: '自定义源',
};

/**
 * 本地 LLM 状态存储：llm.json（源配置 / 引擎通道 / 已下载模型）。
 * 纯逻辑类，不直接触碰 fs / electron（IFileIO 注入）。
 */
export class LlmModelStore {

	private data: ILlmStoreData = freshData();

	constructor(private readonly io: IFileIO) { }

	async load(): Promise<void> {
		const raw = await this.io.readFile();
		if (raw === undefined || raw.trim() === '') {
			this.data = freshData();
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<ILlmStoreData>;
			this.data = {
				version: 1,
				sourceKind: (['official', 'mirror', 'modelscope', 'custom'] as const).includes(parsed.sourceKind as LlmSourceKind) ? parsed.sourceKind as LlmSourceKind : 'mirror',
				customEndpoint: typeof parsed.customEndpoint === 'string' ? parsed.customEndpoint : '',
				engineChannel: parsed.engineChannel === 'direct' || parsed.engineChannel === 'ghproxy' ? parsed.engineChannel : 'ghproxy',
				engineVersion: typeof parsed.engineVersion === 'string' ? parsed.engineVersion : '',
				models: Array.isArray(parsed.models) ? parsed.models.filter(m => m && typeof m.id === 'string' && typeof m.filePath === 'string') : [],
			};
		} catch {
			throw new Error('llm.json 解析失败（文件损坏）');
		}
	}

	getSource(): ILlmSourceConfig {
		const kind = this.data.sourceKind;
		return {
			id: kind,
			kind,
			name: SOURCE_NAMES[kind],
			endpoint: kind === 'official' ? OFFICIAL_ENDPOINT
				: kind === 'mirror' ? MIRROR_ENDPOINT
					: kind === 'modelscope' ? MODELSCOPE_ENDPOINT
						: this.data.customEndpoint,
			engineChannel: this.data.engineChannel,
		};
	}

	async setSource(kind: LlmSourceKind, customEndpoint?: string): Promise<ILlmSourceConfig> {
		if (kind === 'custom') {
			const endpoint = (customEndpoint ?? '').trim().replace(/\/+$/, '');
			if (!/^https?:\/\//.test(endpoint)) {
				throw new Error('自定义源地址必须以 http:// 或 https:// 开头');
			}
			this.data.customEndpoint = endpoint;
		}
		this.data.sourceKind = kind;
		await this.persist();
		return this.getSource();
	}

	getEngineChannel(): 'direct' | 'ghproxy' {
		return this.data.engineChannel;
	}

	async setEngineChannel(channel: 'direct' | 'ghproxy'): Promise<void> {
		this.data.engineChannel = channel;
		await this.persist();
	}

	getEngineVersion(): string {
		return this.data.engineVersion;
	}

	async setEngineVersion(version: string): Promise<void> {
		this.data.engineVersion = version;
		await this.persist();
	}

	getModels(): ILlmModelRecord[] {
		return JSON.parse(JSON.stringify(this.data.models));
	}

	async addModel(record: Omit<ILlmModelRecord, 'id' | 'downloadedAt'>): Promise<ILlmModelRecord> {
		const model: ILlmModelRecord = {
			...record,
			id: generateUuid(),
			downloadedAt: Date.now(),
		};
		this.data.models.push(model);
		await this.persist();
		return JSON.parse(JSON.stringify(model));
	}

	async removeModel(modelId: string): Promise<ILlmModelRecord | undefined> {
		const idx = this.data.models.findIndex(m => m.id === modelId);
		if (idx === -1) {
			return undefined;
		}
		const [removed] = this.data.models.splice(idx, 1);
		await this.persist();
		return removed;
	}

	async updateModelParams(modelId: string, params: ILlmModelParams): Promise<ILlmModelRecord | undefined> {
		const model = this.data.models.find(m => m.id === modelId);
		if (!model) {
			return undefined;
		}
		model.params = params;
		await this.persist();
		return JSON.parse(JSON.stringify(model));
	}

	getModelByCatalogId(catalogId: string): ILlmModelRecord | undefined {
		return this.data.models.find(m => m.catalogId === catalogId);
	}

	private async persist(): Promise<void> {
		await this.io.writeFile(JSON.stringify(this.data, null, '\t'));
	}
}
