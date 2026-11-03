/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { detectDegenerateRepetition } from '../../common/llm.js';

suite('iShell/chatGuard', () => {

	suite('detectDegenerateRepetition', () => {

		test('仅编号递增的重复 CSS 规则被判为重复', () => {
			const blocks = Array.from({ length: 12 }, (_, i) => [
				`#target${i} {`,
				'\tposition: absolute;',
				'\twidth: 50px;',
				'\theight: 50px;',
				'\tbackground-color: red;',
				'\tborder-radius: 50%;',
				'}',
			].join('\n')).join('\n\n');
			assert.strictEqual(detectDegenerateRepetition(blocks), true);
		});

		test('多样化内容不误判', () => {
			const text = [
				'const a = computeWidth(layout);',
				'if (input.focused) { focusRing.style.opacity = 1; }',
				'await loadAssets({ cache: true, retries: 3 });',
				'renderScene(canvas, camera, lightSources);',
				'const colors = palette.map(entry => entry.hex);',
				'function resize(nextWidth, nextHeight) { plot.clear(); }',
				'socket.on("message", payload => queue.push(payload));',
				'export const THEME_MAP = { dark: 0, light: 1 };',
			].join('\n');
			assert.strictEqual(detectDegenerateRepetition(text), false);
		});

		test('阈值可调：阈值越大越宽容', () => {
			const text = Array.from({ length: 5 }, () => 'repeat this identical statement;').join('\n');
			assert.strictEqual(detectDegenerateRepetition(text, 4), true);
			assert.strictEqual(detectDegenerateRepetition(text, 6), false);
		});

		test('短行不参与判定（避免误报）', () => {
			const text = Array.from({ length: 30 }, () => '}').join('\n');
			assert.strictEqual(detectDegenerateRepetition(text), false);
		});
	});
});
