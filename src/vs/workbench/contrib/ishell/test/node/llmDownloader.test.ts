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

/** 测试服务器行为开关（各用例按需设置后发起下载） */
const behaviors = {
	/** /flaky 前 N 次请求写一半即断开连接（模拟网络中断），之后正常服务 */
	flakyFailures: 0,
	/** /flaky 收到的 Range 请求头记录（断点续传验证） */
	flakyRangeHeaders: [] as (string | undefined)[],
	/** /missing 命中计数（验证 4xx 永久错误不重试） */
	missingHits: 0,
	/** /no-range 是否收到过 Range 头 */
	noRangeReceived: false,
};

/** 本地测试服务器：/file 全量；/redirect 302→/file；/missing 404；/api JSON；
 *  /flaky 可控断流+Range 续传；/truncate 声明的 Content-Length 大于实际内容；/no-range 忽略 Range；/range-rejected 有 Range 即 416 */
function startTestServer(): Promise<{ server: http.Server; port: number }> {
	return new Promise(resolve => {
		const body = Buffer.alloc(64 * 1024, 7); // 64KB 固定内容
		const firstHalf = body.subarray(0, body.length / 2);
		const secondHalf = body.subarray(body.length / 2);
		const rangeStart = (req: http.IncomingMessage): number | undefined => {
			const match = /^bytes=(\d+)-/.exec(req.headers.range ?? '');
			return match ? Number(match[1]) : undefined;
		};
		const server = http.createServer((req, res) => {
			const url = (req.url ?? '/').split('?')[0];
			if (url === '/file') {
				res.writeHead(200, { 'Content-Length': String(body.length) });
				res.end(body);
			} else if (url === '/redirect') {
				res.writeHead(302, { Location: '/file' });
				res.end();
			} else if (url === '/flaky') {
				behaviors.flakyRangeHeaders.push(req.headers.range);
				if (behaviors.flakyFailures > 0) {
					behaviors.flakyFailures--;
					res.writeHead(200, { 'Content-Length': String(body.length) });
					res.write(firstHalf, () => {
						// 写回调后 FIN：半包确定已交付客户端（立即 RST 会丢弃在途数据，无法触发续传）
						res.socket?.end();
					});
					return;
				}
				const start = rangeStart(req);
				if (start !== undefined) {
					res.writeHead(206, { 'Content-Length': String(body.length - start) });
					res.end(body.subarray(start));
				} else {
					res.writeHead(200, { 'Content-Length': String(body.length) });
					res.end(body);
				}
			} else if (url === '/truncate') {
				const start = rangeStart(req);
				if (start !== undefined) {
					res.writeHead(206, { 'Content-Length': String(body.length - start) });
					res.end(body.subarray(start));
				} else {
					// 声明全量长度但只发一半后正常结束 → 触发截断检测
					res.writeHead(200, { 'Content-Length': String(body.length) });
					res.end(firstHalf);
				}
			} else if (url === '/no-range') {
				behaviors.noRangeReceived = (req.headers.range ?? '') !== '' || behaviors.noRangeReceived;
				res.writeHead(200, { 'Content-Length': String(body.length) });
				res.end(body);
			} else if (url === '/range-rejected') {
				if (req.headers.range) {
					res.writeHead(416);
					res.end();
				} else {
					res.writeHead(200, { 'Content-Length': String(body.length) });
					res.end(body);
				}
			} else if (url === '/api') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, value: 42 }));
			} else if (url === '/api-error') {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'boom' }));
			} else {
				behaviors.missingHits++;
				res.writeHead(404);
				res.end('not found');
			}
		});
		// CL-mismatch 的挂起时长 = keepAliveTimeout + 1s，调低避免截断用例拖慢
		server.keepAliveTimeout = 1_000;
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

/** 重置行为开关（每个用例独立运行） */
function resetBehaviors(): void {
	behaviors.flakyFailures = 0;
	behaviors.flakyRangeHeaders = [];
	behaviors.missingHits = 0;
	behaviors.noRangeReceived = false;
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

	setup(() => resetBehaviors());

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

	test('HTTP 404 抛错且不残留 .part（永久错误不重试）', async function () {
		this.timeout(10_000);
		const dest = tempFile('missing');
		await assert.rejects(() => downloadFile({ url: `${baseUrl}/missing`, destPath: dest }), /404/);
		assert.strictEqual(behaviors.missingHits, 1, '4xx 永久错误应直接失败，不消耗重试');
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

	test('断流续传：连接中断后携 Range 重试并最终完整', async function () {
		this.timeout(20_000);
		behaviors.flakyFailures = 1;
		const dest = tempFile('flaky');
		const retries: number[] = [];
		await downloadFile({
			url: `${baseUrl}/flaky`,
			destPath: dest,
			maxRetries: 2,
			onRetry: attempt => retries.push(attempt),
		});
		const buf = await fsp.readFile(dest);
		assert.strictEqual(buf.length, 64 * 1024, '续传后应为全量内容');
		assert.ok(buf.every(b => b === 7), '内容应一致');
		assert.strictEqual(retries.length, 1, '应恰好自动重试一次');
		assert.strictEqual(retries[0], 1);
		assert.ok(behaviors.flakyRangeHeaders.length >= 2, '至少两次请求');
		assert.ok(behaviors.flakyRangeHeaders[1]?.startsWith(`bytes=${firstHalfLen()}-`), '重试应从断点续传');
		await fsp.rm(dest, { force: true });

		function firstHalfLen(): number {
			return 32 * 1024;
		}
	});

	test('截断检测：Content-Length 不符触发续传重试', async function () {
		this.timeout(20_000);
		const dest = tempFile('truncate');
		await downloadFile({ url: `${baseUrl}/truncate`, destPath: dest, maxRetries: 2 });
		const stat = await fsp.stat(dest);
		assert.strictEqual(stat.size, 64 * 1024, '截断后经续传应得到完整文件');
		await fsp.rm(dest, { force: true });
	});

	test('416 范围被拒：删除 .part 从零重下成功', async function () {
		this.timeout(20_000);
		const dest = tempFile('416');
		await fsp.writeFile(`${dest}.part`, Buffer.alloc(100, 9)); // 预置脏 .part，触发 Range → 416
		await downloadFile({ url: `${baseUrl}/range-rejected`, destPath: dest, maxRetries: 2 });
		const buf = await fsp.readFile(dest);
		assert.strictEqual(buf.length, 64 * 1024, '应从零重下全量');
		assert.ok(buf.every(b => b === 7), '不应残留 .part 旧内容');
		await fsp.rm(dest, { force: true });
	});

	test('Range 被忽略（200 全量）：不重复追加、内容完整', async function () {
		this.timeout(20_000);
		const dest = tempFile('no-range');
		await fsp.writeFile(`${dest}.part`, Buffer.alloc(100, 9)); // 预置 .part，服务端将无视 Range 返回 200
		await downloadFile({ url: `${baseUrl}/no-range`, destPath: dest, maxRetries: 0 });
		assert.ok(behaviors.noRangeReceived, '服务端应收到过 Range 头');
		const stat = await fsp.stat(dest);
		assert.strictEqual(stat.size, 64 * 1024, '200 重写模式不应叠加旧 .part');
		await fsp.rm(dest, { force: true });
	});

	test('重试耗尽：最终失败且清理 .part', async function () {
		this.timeout(30_000);
		behaviors.flakyFailures = 99;
		const dest = tempFile('exhaust');
		const retries: number[] = [];
		await assert.rejects(() => downloadFile({
			url: `${baseUrl}/flaky`,
			destPath: dest,
			maxRetries: 1,
			onRetry: attempt => retries.push(attempt),
		}), /截断|ECONNRESET|socket|aborted|连接中断/i);
		assert.strictEqual(retries.length, 1, 'maxRetries=1 应重试一次后失败');
		await assert.rejects(() => fsp.stat(`${dest}.part`), /ENOENT/, '最终失败应清理 .part');
		await assert.rejects(() => fsp.stat(dest), /ENOENT/, '最终失败不应产生目标文件');
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
