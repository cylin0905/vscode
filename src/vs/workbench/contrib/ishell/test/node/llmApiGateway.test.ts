/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as http from 'http';
import { LlmApiGateway } from '../../node/llmApiGateway.js';
import { ILlmLogEntry, LlmLogLevel, LlmLogSource } from '../../common/llm.js';

/** 占一个临时端口（listen 0 分配后立即关闭，返回可用端口号） */
function reserveFreePort(): Promise<number> {
	return new Promise(resolve => {
		const server = http.createServer();
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

/** 持续占用指定端口的服务器（测端口冲突递增用） */
function occupyPort(port: number): Promise<http.Server> {
	return new Promise(resolve => {
		const server = http.createServer();
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise(resolve => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

/** 伪造上游 llama-server：POST /v1/chat/completions 回显固定 JSON 并记录请求体 */
interface IFakeUpstream {
	server: http.Server;
	port: number;
	lastBody: string;
}

function startFakeUpstream(): Promise<IFakeUpstream> {
	return new Promise(resolve => {
		const upstream: IFakeUpstream = { server: undefined!, port: 0, lastBody: '' };
		upstream.server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				upstream.lastBody = Buffer.concat(chunks).toString('utf8');
				if (req.method === 'POST' && req.url === '/v1/chat/completions') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好' } }] }));
				} else {
					res.writeHead(404);
					res.end('{}');
				}
			});
		});
		upstream.server.listen(0, '127.0.0.1', () => {
			upstream.port = (upstream.server.address() as { port: number }).port;
			resolve(upstream);
		});
	});
}

/** 发送 HTTP 请求并解析 JSON 响应 */
function requestJson(port: number, method: string, path: string, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: '127.0.0.1', port, path, method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : undefined },
			res => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString('utf8'),
				}));
			}
		);
		req.on('error', reject);
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

suite('ishell > LlmApiGateway', () => {

	let gateway: LlmApiGateway;
	let upstream: IFakeUpstream;
	let logs: ILlmLogEntry[];
	const log = (level: LlmLogLevel, source: LlmLogSource, message: string) => {
		logs.push({ seq: logs.length, time: Date.now(), level, source, message });
	};

	setup(async () => {
		logs = [];
		gateway = new LlmApiGateway(log);
		upstream = await startFakeUpstream();
	});

	teardown(async () => {
		gateway.dispose();
		await closeServer(upstream.server);
	});

	test('health 与 models 端点', async () => {
		const port = await gateway.start(await reserveFreePort(), upstream.port, 'test-model');
		assert.ok(gateway.running);
		assert.strictEqual(gateway.port, port);

		const health = await requestJson(port, 'GET', '/health');
		assert.strictEqual(health.status, 200);
		assert.strictEqual(JSON.parse(health.body).status, 'ok');

		const models = await requestJson(port, 'GET', '/v1/models');
		assert.strictEqual(models.status, 200);
		const list = JSON.parse(models.body);
		assert.strictEqual(list.object, 'list');
		assert.strictEqual(list.data[0].id, 'test-model');
		assert.strictEqual(list.data[0].owned_by, 'ishell');
	});

	test('CORS 预检返回 204 与开放头', async () => {
		const port = await gateway.start(await reserveFreePort(), upstream.port, 'test-model');
		const res = await requestJson(port, 'OPTIONS', '/v1/chat/completions');
		assert.strictEqual(res.status, 204);
		assert.strictEqual(res.headers['access-control-allow-origin'], '*');
		assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
	});

	test('POST /v1/chat/completions 透传上游', async () => {
		const port = await gateway.start(await reserveFreePort(), upstream.port, 'test-model');
		const payload = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
		const res = await requestJson(port, 'POST', '/v1/chat/completions', payload);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(JSON.parse(res.body).choices[0].message.content, '你好');
		// 上游收到原样请求体
		assert.strictEqual(upstream.lastBody, payload);
	});

	test('未知端点返回 404', async () => {
		const port = await gateway.start(await reserveFreePort(), upstream.port, 'test-model');
		const res = await requestJson(port, 'GET', '/v1/unknown');
		assert.strictEqual(res.status, 404);
		assert.ok(JSON.parse(res.body).error.message.includes('/v1/unknown'));
	});

	test('端口被占用时自动递增', async () => {
		const preferred = await reserveFreePort();
		const blocker = await occupyPort(preferred);
		try {
			const port = await gateway.start(preferred, upstream.port, 'test-model');
			assert.strictEqual(port, preferred + 1, '应改用下一个端口');
			assert.ok(logs.some(l => l.message.includes(String(preferred)) && l.message.includes(String(port))), '应记录端口迁移日志');
		} finally {
			await closeServer(blocker);
		}
	});

	test('stop 后停止监听且可再次启动', async () => {
		const port = await gateway.start(await reserveFreePort(), upstream.port, 'test-model');
		gateway.stop();
		assert.ok(!gateway.running);
		assert.strictEqual(gateway.port, undefined);
		// 端口已释放（请求应连接失败）
		await assert.rejects(() => requestJson(port, 'GET', '/health'), Error);
		// 可再次启动
		const port2 = await gateway.start(await reserveFreePort(), upstream.port, 'test-model');
		assert.ok(gateway.running);
		assert.strictEqual(port2, gateway.port);
	});
});
