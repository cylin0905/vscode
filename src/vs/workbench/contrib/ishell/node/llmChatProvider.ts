/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { ILlmChatMessage, ILlmChatOptions, ILlmChatProvider } from '../common/llm.js';

/**
 * 本地聊天 Provider：请求本机 API 网关的 /v1/chat/completions（SSE 流式），
 * 解析增量文本回调 onChunk。云端模型未来按同接口实现并注册即可无缝接入。
 */
export class LocalChatProvider implements ILlmChatProvider {

	readonly id = 'local';

	/** 注入网关端口获取器（未运行时返回 undefined） */
	constructor(private readonly getGatewayPort: () => number | undefined) { }

	async isReady(): Promise<boolean> {
		return this.getGatewayPort() !== undefined;
	}

	chatStream(messages: ILlmChatMessage[], onChunk: (delta: string) => void, signal: AbortSignal, options?: ILlmChatOptions): Promise<void> {
		const port = this.getGatewayPort();
		if (port === undefined) {
			return Promise.reject(new Error('本地模型未运行，请先在模型管理中启动模型'));
		}
		const body = JSON.stringify({
			model: 'local',
			messages,
			stream: true,
			...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
			...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
			...(options?.topP !== undefined ? { top_p: options.topP } : {}),
			...(options?.topK !== undefined ? { top_k: options.topK } : {}),
			...(options?.repeatPenalty !== undefined ? { repeat_penalty: options.repeatPenalty } : {}),
			...(options?.seed !== undefined ? { seed: options.seed } : {}),
		});
		return new Promise<void>((resolve, reject) => {
			const req = http.request({
				host: '127.0.0.1',
				port,
				path: '/v1/chat/completions',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
				},
			}, res => {
				if (res.statusCode !== 200) {
					const chunks: Buffer[] = [];
					res.on('data', (c: Buffer) => chunks.push(c));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						let message = text;
						try {
							const parsed = JSON.parse(text) as { error?: { message?: string } };
							message = parsed.error?.message ?? text;
						} catch {
							// 非 JSON 原样展示
						}
						reject(new Error(`对话请求失败（HTTP ${res.statusCode}）：${message.slice(0, 300)}`));
					});
					return;
				}
				// SSE 增量解析
				let buffer = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk;
					let idx: number;
					while ((idx = buffer.indexOf('\n')) !== -1) {
						const line = buffer.slice(0, idx).trim();
						buffer = buffer.slice(idx + 1);
						if (!line.startsWith('data:')) {
							continue;
						}
						const payload = line.slice(5).trim();
						if (payload === '[DONE]') {
							req.destroy();
							resolve();
							return;
						}
						try {
							const delta = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
							const content = delta.choices?.[0]?.delta?.content;
							if (content) {
								onChunk(content);
							}
						} catch {
							// 忽略无法解析的心跳行
						}
					}
				});
				res.on('end', () => resolve());
				res.on('error', err => reject(err));
			});
			req.on('error', err => {
				if (signal.aborted) {
					resolve();
				} else {
					reject(err);
				}
			});
			signal.addEventListener('abort', () => {
				req.destroy();
				resolve();
			});
			req.end(body);
		});
	}
}
