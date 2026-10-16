/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** 指数退避重连策略（纯逻辑，可单测） */
export interface IReconnectPolicy {
	/** 首次重连延迟（毫秒） */
	initialDelayMs: number;
	/** 延迟上限（毫秒） */
	maxDelayMs: number;
	/** 退避因子 */
	factor: number;
	/** 最大重试次数（0 = 不限） */
	maxRetries: number;
}

export const DEFAULT_RECONNECT_POLICY: IReconnectPolicy = {
	initialDelayMs: 1000,
	maxDelayMs: 30000,
	factor: 2,
	maxRetries: 10,
};

export class BackoffController {

	private _attempts: number = 0;

	constructor(private readonly policy: IReconnectPolicy) { }

	reset(): void {
		this._attempts = 0;
	}

	get attempts(): number {
		return this._attempts;
	}

	/** 是否已耗尽重试次数 */
	get exhausted(): boolean {
		return this.policy.maxRetries > 0 && this._attempts >= this.policy.maxRetries;
	}

	/** 计算并预支下一次重连延迟（毫秒） */
	nextDelay(): number {
		const delay = Math.min(
			this.policy.initialDelayMs * Math.pow(this.policy.factor, this._attempts),
			this.policy.maxDelayMs
		);
		this._attempts++;
		return delay;
	}

	/** 不预支次数，仅查看下一次延迟 */
	peekDelay(): number {
		return Math.min(
			this.policy.initialDelayMs * Math.pow(this.policy.factor, this._attempts),
			this.policy.maxDelayMs
		);
	}
}
