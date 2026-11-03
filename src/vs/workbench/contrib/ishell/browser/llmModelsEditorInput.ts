/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/** 厂家过滤：'all' 或 vendorId */
export type LlmVendorFilter = 'all' | string;

/** 分类过滤：'all' 或模型分类 id（见 LLM_MODEL_CATEGORIES） */
export type LlmCategoryFilter = 'all' | string;

/** 模型广场过滤器：厂家与分类可叠加，'all' 表示不过滤 */
export interface LlmModelsEditorFilter {
	vendorId?: LlmVendorFilter;
	categoryId?: LlmCategoryFilter;
}

/**
 * 本地模型广场编辑器输入（默认复用已有标签页；可通过 openLlmModelsEditor 的 newTab 选项独立打开）。
 * 左侧边栏（分类导航）点击分类 -> 切换本输入的 categoryId -> 编辑器重渲卡片。
 */
export class LlmModelsEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.ishellLlmModels';
	static readonly EDITOR_ID = 'ishell.llmModelsEditor';

	private _vendorId: LlmVendorFilter = 'all';
	private _categoryId: LlmCategoryFilter = 'all';

	private readonly _onDidChangeVendor = this._register(new Emitter<LlmVendorFilter>());
	readonly onDidChangeVendor = this._onDidChangeVendor.event;

	private readonly _onDidChangeCategory = this._register(new Emitter<LlmCategoryFilter>());
	readonly onDidChangeCategory = this._onDidChangeCategory.event;

	/** 请求编辑器切回「本地模型」Tab（左侧分类导航点击时触发） */
	private readonly _onDidRequestLocal = this._register(new Emitter<void>());
	readonly onDidRequestLocal = this._onDidRequestLocal.event;

	override readonly resource: URI = URI.parse('ishell-llm://models');

	constructor() {
		super();
	}

	override get typeId(): string {
		return LlmModelsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return LlmModelsEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.ForceReveal;
	}

	override getName(): string {
		return localize('ishell.llm.modelsEditorName', "模型管理");
	}

	get vendorId(): LlmVendorFilter {
		return this._vendorId;
	}

	get categoryId(): LlmCategoryFilter {
		return this._categoryId;
	}

	setVendor(vendorId: LlmVendorFilter): void {
		if (this._vendorId === vendorId) {
			return;
		}
		this._vendorId = vendorId;
		this._onDidChangeVendor.fire(vendorId);
	}

	setCategory(categoryId: LlmCategoryFilter): void {
		if (this._categoryId === categoryId) {
			return;
		}
		this._categoryId = categoryId;
		this._onDidChangeCategory.fire(categoryId);
	}

	override matches(other: unknown): boolean {
		return this === other;
	}

	/** 通知编辑器定位到本地模型列表 */
	requestLocal(): void {
		this._onDidRequestLocal.fire();
	}
}

/**
 * 打开（或复用）本地模型广场编辑器页，并定位到指定厂家/分类。
 * 左侧分类导航与命令入口共用本函数；newTab 为 true 时独立打开新标签页。
 */
export async function openLlmModelsEditor(
	editorService: IEditorService,
	instantiationService: IInstantiationService,
	filter: LlmModelsEditorFilter = {},
	options?: { newTab?: boolean }
): Promise<void> {
	let input: LlmModelsEditorInput;
	if (options?.newTab) {
		input = instantiationService.createInstance(LlmModelsEditorInput);
	} else {
		const existing = editorService.editors.find((e): e is LlmModelsEditorInput => e instanceof LlmModelsEditorInput);
		input = existing ?? instantiationService.createInstance(LlmModelsEditorInput);
	}
	input.setVendor(filter.vendorId ?? 'all');
	input.setCategory(filter.categoryId ?? 'all');
	await editorService.openEditor(input, { pinned: true });
	input.requestLocal();
}
