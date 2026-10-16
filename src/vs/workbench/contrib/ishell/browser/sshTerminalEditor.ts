/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { SshTerminalEditorInput } from './sshTerminalEditorInput.js';

/**
 * SSH 终端编辑器宿主：
 * 终端实例（xterm + shell 通道）挂在 EditorInput 上，跨组拖拽/分屏复用不中断；
 * 本类只负责容器挂载与布局转发。
 */
export class SshTerminalEditor extends EditorPane {

	private _container: HTMLElement | undefined;
	private _editorInput: SshTerminalEditorInput | undefined;
	private _lastDimension: dom.Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(SshTerminalEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	override async setInput(newInput: SshTerminalEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this._editorInput = newInput;
		await super.setInput(newInput, options, context, token);
		if (this._container) {
			newInput.attachToElement(this._container);
		}
		if (this._lastDimension) {
			this.layout(this._lastDimension);
		}
	}

	override clearInput(): void {
		super.clearInput();
		this._editorInput?.detachFromElement();
		this._editorInput = undefined;
	}

	override focus(): void {
		super.focus();
		this._editorInput?.focus();
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	protected createEditor(parent: HTMLElement): void {
		this._container = dom.$('.ishell-terminal-editor');
		parent.appendChild(this._container);
	}

	layout(dimension: dom.Dimension): void {
		this._lastDimension = dimension;
		this._editorInput?.layout();
	}
}
