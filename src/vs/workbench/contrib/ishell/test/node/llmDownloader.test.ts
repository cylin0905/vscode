/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as http from 'http';
import { promises as fsp } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { downloadFile, getJson, withTimeout } from '../../node/llmDownloader.js';

/** 本地测试服务器：/file 返回固定内容；/redirect 302 → /file；/missing 404；/api 返回 JSON */
function startTestServer(): Promise<{ server: http.Server; port: number }> {
	return new Promise(resolve => {
		const body = Buffer.alloc(64 * 1024, 7); // 64KB 固定内容
		const server = http.createServer((req, res) => {
			const url = (req.url ?? '/').split('?')[0];
			if (url === '/file') {
				res.writeHead(200, { 'Content-Length': String(body.length) });
				res.end(body);
			} else if (url === '/redirect') {
				res.writeHead(302, { Location: '/file' });
				res.end();
			} else if (url === '/api') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, value: 42 }));
			} else if (url === '/api-error') {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'boom' }));
			} else {
				res.writeHead(404);
				res.end('not found');
			}
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise(resolve => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

function tempFile(name: string): string {
	return join(os.tmpdir(), `ishell-llm-test-${process.pid}-${name}.bin`);
}

suite('ishell > LlmDownloader', () => {

	let server: http.Server;
	let port: number;
	let baseUrl: string;

	suiteSetup(async () => {
		({ server, port } = await startTestServer());
		baseUrl = `http://127.0.0.1:${port}`;
	});

	suiteTeardown(async () => {
		await closeServer(server);
	});

	test('基本下载：内容一致且 .part 已清理', async () => {
		const dest = tempFile('basic');
		await downloadFile({ url: `${baseUrl}/file`, destPath: dest });
		const stat = await fsp.stat(dest);
		assert.strictEqual(stat.size, 64 * 1024);
		const buf = await fsp.readFile(dest);
		assert.strictEqual(buf[0], 7);
		assert.strictEqual(buf[buf.length - 1], 7);
		await assert.rejects(() => fsp.stat(`${dest}.part`), /ENOENT/, '完成后 .part 应被重命名');
		await fsp.rm(dest, { force: true });
	});

	test('进度回调：最终收到全量字节数', async () => {
		const dest = tempFile('progress');
		let lastReceived = 0;
		let lastTotal = 0;
		await downloadFile({
			url: `${baseUrl}/file`,
			destPath: dest,
			onProgress: (received, total) => {
				lastReceived = received;
				lastTotal = total;
			},
		});
		assert.strictEqual(lastReceived, 64 * 1024);
		assert.strictEqual(lastTotal, 64 * 1024);
		await fsp.rm(dest, { force: true });
	});

	test('302 重定向跟随', async () => {
		const dest = tempFile('redirect');
		await downloadFile({ url: `${baseUrl}/redirect`, destPath: dest });
		const stat = await fsp.stat(dest);
		assert.strictEqual(stat.size, 64 * 1024);
		await fsp.rm(dest, { force: true });
	});

	test('HTTP 404 抛错且不残留 .part', async () => {
		const dest = tempFile('missing');
		await assert.rejects(() => downloadFile({ url: `${baseUrl}/missing`, destPath: dest }), /404/);
		await assert.rejects(() => fsp.stat(dest), /ENOENT/, '失败时目标文件不应存在');
		await assert.rejects(() => fsp.stat(`${dest}.part`), /ENOENT/, '失败时 .part 应被清理');
	});

	test('预先取消的 token 直接拒绝', async () => {
		const cts = new CancellationTokenSource();
		cts.cancel();
		const dest = tempFile('canceled');
		await assert.rejects(() => downloadFile({ url: `${baseUrl}/file`, destPath: dest, token: cts.token }), /取消/);
		await fsp.rm(dest, { force: true });
	});

	test('getJson 解析 200 响应', async () => {
		const data = await getJson<{ ok: boolean; value: number }>(`${baseUrl}/api`);
		assert.strictEqual(data.ok, true);
		assert.strictEqual(data.value, 42);
	});

	test('getJson 非 200 抛错', async () => {
		await assert.rejects(() => getJson(`${baseUrl}/api-error`), /500/);
	});

	test('withTimeout 正常返回与超时抛错', async () => {
		assert.strictEqual(await withTimeout(Promise.resolve('ok'), 1000, '不应超时'), 'ok');
		await assert.rejects(
			() => withTimeout(new Promise<string>(() => { /* 永不 resolve */ }), 50, '等待超时'),
			/等待超时/
		);
	});
});
