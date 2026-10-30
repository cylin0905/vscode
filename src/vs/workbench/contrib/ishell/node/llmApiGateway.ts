/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { LlmLogLevel, LlmLogSource } from '../common/llm.js';

const MAX_PORT_ATTEMPTS = 10;

/**
 * LM Studio 规范（OpenAI 兼容）本地 API 网关：
 * - GET  /v1/models          → 运行中模型清单
 * - POST /v1/chat/completions、/v1/completions、/v1/embeddings → 透传 llama-server（SSE 流式原样转发）
 * - GET  /health             → 网关自身健康检查
 * - CORS 全开放，便于第三方 Web 工具直连
 * 模型启动后自动监听（端口冲突自动 +1 递增），模型停止即关闭。
 */
export class LlmApiGateway extends Disposable {

	private server: http.Server | undefined;
	private _port: number | undefined;

	/** 上游 llama-server 内部端口（启动时注入） */
	private upstreamPort: number | undefined;
	private modelName: string | undefined;

	constructor(
		private readonly log: (level: LlmLogLevel, source: LlmLogSource, message: string) => void
	) {
		super();
	}

	get running(): boolean {
		return this.server !== undefined;
	}

	get port(): number | undefined {
		return this._port;
	}

	/** 启动网关（端口冲突自动递增），返回实际监听端口 */
	async start(preferredPort: number, upstreamPort: number, modelName: string): Promise<number> {
		if (this.running) {
			throw new Error('API 网关已在运行');
		}
		this.upstreamPort = upstreamPort;
		this.modelName = modelName;

		const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.handleRequest(req, res);
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
			const port = preferredPort + attempt;
			try {
				this.server = await this.listen(port, handler);
				this._port = port;
				this.log('info', 'gateway', `API 网关已启动：http://127.0.0.1:${port}/v1（模型 ${modelName}）`);
				if (port !== preferredPort) {
					this.log('warn', 'gateway', `默认端口 ${preferredPort} 被占用，已改用 ${port}`);
				}
				return port;
			} catch (err) {
				lastError = err;
				this.server = undefined;
			}
		}
		throw new Error(`API 网关启动失败（${preferredPort}-${preferredPort + MAX_PORT_ATTEMPTS - 1} 均被占用）：${(lastError as Error).message}`);
	}

	private listen(port: number, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
		return new Promise((resolve, reject) => {
			const server = http.createServer(handler);
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => resolve(server));
		});
	}

	stop(): void {
		if (this.server) {
			this.server.close();
			this.server.closeAllConnections?.();
			this.server = undefined;
			this._port = undefined;
			this.log('info', 'gateway', 'API 网关已停止');
		}
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const started = Date.now();
		const url = (req.url ?? '/').split('?')[0];

		// CORS 预检与响应头
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		const finishLog = (status: number) => {
			this.log(status < 400 ? 'info' : 'warn', 'gateway', `${req.method} ${url} → ${status}（${Date.now() - started}ms）`);
		};

		if (req.method === 'GET' && url === '/health') {
			const body = JSON.stringify({ status: 'ok', model: this.modelName });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(body);
			finishLog(200);
			return;
		}

		if (req.method === 'GET' && url === '/v1/models') {
			const body = JSON.stringify({
				object: 'list',
				data: [{
					id: this.modelName ?? 'local-model',
					object: 'model',
					created: Math.floor(Date.now() / 1000),
					owned_by: 'ishell',
				}],
			});
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(body);
			finishLog(200);
			return;
		}

		// 推理端点：原样透传 llama-server（含 SSE 流式）
		const passthrough = (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/completions' || url === '/v1/embeddings'));
		if (passthrough && this.upstreamPort !== undefined) {
			const upstreamHeaders = { ...req.headers, host: `127.0.0.1:${this.upstreamPort}` };
			const upstream = http.request(
				{ host: '127.0.0.1', port: this.upstreamPort, path: req.url, method: req.method, headers: upstreamHeaders },
				upstreamRes => {
					res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
					upstreamRes.pipe(res);
					upstreamRes.on('end', () => finishLog(upstreamRes.statusCode ?? 502));
				}
			);
			upstream.on('error', err => {
				if (!res.headersSent) {
					res.writeHead(502, { 'Content-Type': 'application/json' });
				}
				res.end(JSON.stringify({ error: { message: `上游引擎不可达：${err.message}` } }));
				finishLog(502);
			});
			req.pipe(upstream);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: `未知端点：${req.method} ${url}` } }));
		finishLog(404);
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
