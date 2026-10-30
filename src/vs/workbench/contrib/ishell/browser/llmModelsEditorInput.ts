/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/** 厂家过滤：'all' 或 vendorId */
export type LlmVendorFilter = 'all' | string;

/**
 * 本地模型广场编辑器输入（单例语义：全工作台复用同一实例，厂家切换复用同一标签页）。
 * 左侧边栏（厂家导航）点击厂家 -> 切换本输入的 vendorId -> 编辑器重渲卡片。
 */
export class LlmModelsEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.ishellLlmModels';
	static readonly EDITOR_ID = 'ishell.llmModelsEditor';

	private _vendorId: LlmVendorFilter = 'all';

	private readonly _onDidChangeVendor = this._register(new Emitter<LlmVendorFilter>());
	readonly onDidChangeVendor = this._onDidChangeVendor.event;

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
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal;
	}

	override getName(): string {
		return localize('ishell.llm.modelsEditorName', "本地模型");
	}

	get vendorId(): LlmVendorFilter {
		return this._vendorId;
	}

	setVendor(vendorId: LlmVendorFilter): void {
		if (this._vendorId === vendorId) {
			return;
		}
		this._vendorId = vendorId;
		this._onDidChangeVendor.fire(vendorId);
	}

	override matches(other: unknown): boolean {
		return other instanceof LlmModelsEditorInput;
	}
}

/**
 * 打开（或复用）本地模型广场编辑器页，并定位到指定厂家分组。
 * 左侧厂家导航与命令入口共用本函数。
 */
export async function openLlmModelsEditor(
	editorService: IEditorService,
	instantiationService: IInstantiationService,
	vendorId: LlmVendorFilter = 'all'
): Promise<void> {
	const disposables = new DisposableStore();
	try {
		const existing = editorService.editors.find((e): e is LlmModelsEditorInput => e instanceof LlmModelsEditorInput);
		const input = existing ?? instantiationService.createInstance(LlmModelsEditorInput);
		input.setVendor(vendorId);
		await editorService.openEditor(input, { pinned: true });
	} finally {
		disposables.dispose();
	}
}
