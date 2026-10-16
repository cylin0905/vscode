/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { BackoffController, IReconnectPolicy } from '../../node/backoff.js';

suite('ishell > BackoffController', () => {

	function makePolicy(overrides: Partial<IReconnectPolicy> = {}): IReconnectPolicy {
		return { initialDelayMs: 1000, maxDelayMs: 30000, factor: 2, maxRetries: 3, ...overrides };
	}

	test('指数递增并封顶', () => {
		const c = new BackoffController(makePolicy());
		assert.strictEqual(c.nextDelay(), 1000);
		assert.strictEqual(c.nextDelay(), 2000);
		assert.strictEqual(c.nextDelay(), 4000);
		assert.strictEqual(c.nextDelay(), 8000);
		assert.strictEqual(c.nextDelay(), 16000);
		assert.strictEqual(c.nextDelay(), 30000); // 封顶
		assert.strictEqual(c.nextDelay(), 30000);
	});

	test('maxRetries=0 表示不限次数', () => {
		const c = new BackoffController(makePolicy({ maxRetries: 0 }));
		for (let i = 0; i < 50; i++) {
			c.nextDelay();
		}
		assert.ok(!c.exhausted);
	});

	test('达到最大重试次数后耗尽', () => {
		const c = new BackoffController(makePolicy({ maxRetries: 3 }));
		assert.ok(!c.exhausted);
		c.nextDelay();
		c.nextDelay();
		assert.ok(!c.exhausted);
		c.nextDelay();
		assert.ok(c.exhausted);
	});

	test('reset 后重新计数', () => {
		const c = new BackoffController(makePolicy());
		c.nextDelay();
		c.nextDelay();
		c.reset();
		assert.strictEqual(c.attempts, 0);
		assert.strictEqual(c.nextDelay(), 1000);
	});
});
