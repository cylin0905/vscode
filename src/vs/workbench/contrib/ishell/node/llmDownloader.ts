/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createWriteStream, promises as fsp, type WriteStream } from 'fs';
import { dirname } from 'path';
import * as http from 'http';
import * as https from 'https';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export interface IDownloadOptions {
	url: string;
	/** 最终落盘路径（下载到 <destPath>.part，完成后原子重命名） */
	destPath: string;
	headers?: Record<string, string>;
	/** 进度回调（约 200ms 节流一次；totalBytes 可能为 0 = 未知大小） */
	onProgress?: (receivedBytes: number, totalBytes: number) => void;
	token?: CancellationToken;
	/** 同一 URL 失败后的自动重试次数（默认 2，重试基于 .part 断点续传） */
	maxRetries?: number;
	/** 自动重试回调（attempt 从 1 开始），用于 UI/日志提示 */
	onRetry?: (attempt: number, error: Error) => void;
}

/** 下载错误附加标记：permanent = 无需重试；restartFromScratch = 需删除 .part 从零重下 */
interface IDownloadError extends Error {
	permanent?: boolean;
	restartFromScratch?: boolean;
}

const MAX_REDIRECTS = 10;
/** 连接超时：迟迟未收到响应头即失败，尽快触发重试/备用源切换（对无响应主机快速止损） */
const CONNECT_TIMEOUT_MS = 15_000;
/** 传输停滞超时：响应已建立但持续无数据则中断（容忍 CDN 抖动，区别于连接超时） */
const TRANSFER_IDLE_TIMEOUT_MS = 60_000;
/** 默认 User-Agent：部分 CDN（如魔搭）拒绝无 UA 的请求（HTTP 403） */
const DEFAULT_USER_AGENT = 'iShell';
const PROGRESS_THROTTLE_MS = 200;
const RETRY_BACKOFF_MS = 1_000;

/**
 * 通用流式文件下载（引擎 zip / GGUF 模型共用）：
 * - 30x 重定向跟随（HF resolve → CDN 场景，跨重定向保留 Range）
 * - 自动重试 + 断点续传（.part 保留，Range: bytes=N- 续传；服务器忽略 Range 按 200 全量重写）
 * - 连接超时（15s）与传输停滞超时（60s）分阶段把关
 * - 完整性校验：totalBytes 已知且收满才落定，截断连接自动续传重试
 * - 4xx（非 416）永久错误不重试；416 范围失效自动从零重下
 * - 进度节流回调 + CancellationToken 取消（最终失败/取消清理 .part）
 */
export async function downloadFile(options: IDownloadOptions): Promise<void> {
	const { url, destPath, headers, onProgress, token, maxRetries = 2, onRetry } = options;
	const partPath = `${destPath}.part`;

	await fsp.mkdir(dirname(destPath), { recursive: true });

	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (token?.isCancellationRequested) {
			break;
		}
		try {
			const startOffset = await statSize(partPath);
			await doDownload(url, partPath, headers, onProgress, token, startOffset, 0);
			await fsp.rename(partPath, destPath);
			return;
		} catch (err) {
			lastErr = err as Error;
			if ((err as IDownloadError).restartFromScratch) {
				await fsp.rm(partPath, { force: true });
			}
			if (token?.isCancellationRequested || (err as IDownloadError).permanent) {
				break;
			}
			if (attempt < maxRetries) {
				onRetry?.(attempt + 1, err as Error);
				await new Promise<void>(resolve => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
			}
		}
	}

	await fsp.rm(partPath, { force: true });
	if (token?.isCancellationRequested) {
		throw new Error('下载已取消');
	}
	throw lastErr ?? new Error('下载失败');
}

/** .part 已有字节数（不存在返回 0），用于断点续传起点 */
async function statSize(file: string): Promise<number> {
	try {
		return (await fsp.stat(file)).size;
	} catch {
		return 0;
	}
}

function doDownload(
	url: string,
	partPath: string,
	headers: Record<string, string> | undefined,
	onProgress: ((received: number, total: number) => void) | undefined,
	token: CancellationToken | undefined,
	startOffset: number,
	redirectCount: number,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (token?.isCancellationRequested) {
			reject(new Error('下载已取消'));
			return;
		}

		if (redirectCount > MAX_REDIRECTS) {
			reject(markError(new Error('重定向次数过多'), { permanent: true }));
			return;
		}

		// 断点续传：携带已下载字节的 Range；服务器可忽略（→200 全量重写）或拒绝（→416 从零重下）
		const effectiveHeaders: Record<string, string> = { ...headers };
		if (!Object.keys(effectiveHeaders).some(key => key.toLowerCase() === 'user-agent')) {
			effectiveHeaders['User-Agent'] = DEFAULT_USER_AGENT;
		}
		if (startOffset > 0) {
			effectiveHeaders['Range'] = `bytes=${startOffset}-`;
		}

		const client = url.startsWith('http://') ? http : https;

		// 单次请求的收口状态：标记 settled 防止 finish/error 多路重复结算
		let settled = false;
		let activeRes: http.IncomingMessage | undefined;
		let activeFile: WriteStream | undefined;
		let cancelSub: { dispose(): void } | undefined;

		/** 失败收口（流已损坏/尚未建立时）：直接 reject */
		const failNoFlush = (err: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cancelSub?.dispose();
			reject(err);
		};

		/** 失败收口：先把已收数据落盘（供重试断点续传），再 reject */
		const fail = (err: Error): void => {
			if (settled) {
				return;
			}
			if (activeFile && !activeFile.writableEnded && !activeFile.destroyed) {
				settled = true;
				cancelSub?.dispose();
				activeRes?.unpipe(activeFile);
				activeFile.end(() => reject(err));
			} else {
				failNoFlush(err);
			}
		};

		const req = client.get(url, { headers: effectiveHeaders }, res => {
			const status = res.statusCode ?? 0;

			// 重定向：跟随 Location（相对地址补全），保留含 Range 的请求头
			if (status >= 300 && status < 400 && res.headers.location) {
				settled = true; // 当前请求作废，交由递归调用收口
				res.resume();
				req.destroy();
				doDownload(new URL(res.headers.location, url).toString(), partPath, effectiveHeaders, onProgress, token, startOffset, redirectCount + 1).then(resolve, reject);
				return;
			}

			if (status === 416) {
				failNoFlush(markError(new Error(`范围请求被拒（HTTP 416）：${url}`), { restartFromScratch: true }));
				res.resume();
				req.destroy();
				return;
			}

			if (status !== 200 && status !== 206) {
				failNoFlush(markError(new Error(`下载失败：HTTP ${status}（${url}）`), { permanent: status >= 400 && status < 500 }));
				res.resume();
				req.destroy();
				return;
			}

			// 206 且带 Range → 从 startOffset 续传；200 → 服务器忽略 Range，从零重写
			const resuming = status === 206 && startOffset > 0;
			const contentLength = Number(res.headers['content-length'] ?? 0);
			const totalBytes = resuming ? startOffset + contentLength : contentLength;
			let received = resuming ? startOffset : 0;
			let lastNotify = 0;

			// 响应已建立：连接超时升级为传输停滞超时（容忍 CDN 波动，避免误杀慢速突发的合法传输）
			req.setTimeout(TRANSFER_IDLE_TIMEOUT_MS, () => {
				req.destroy(new Error(`传输停滞（${TRANSFER_IDLE_TIMEOUT_MS / 1000} 秒）：${url}`));
			});

			activeRes = res;
			cancelSub = token?.onCancellationRequested(() => {
				req.destroy(new Error('下载已取消'));
			});

			const file = createWriteStream(partPath, { flags: resuming ? 'a' : 'w' });
			activeFile = file;
			res.on('data', (chunk: Buffer) => {
				received += chunk.length;
				const now = Date.now();
				if (onProgress && (now - lastNotify >= PROGRESS_THROTTLE_MS || received === totalBytes)) {
					lastNotify = now;
					onProgress(received, totalBytes);
				}
			});
			res.on('error', err => fail(err));
			file.on('error', err => {
				cancelSub?.dispose();
				req.destroy();
				failNoFlush(err);
			});
			file.on('finish', () => {
				cancelSub?.dispose();
				if (token?.isCancellationRequested) {
					fail(new Error('下载已取消'));
				} else if (totalBytes > 0 && received < totalBytes) {
					// 连接中断导致内容截断：保留 .part 供重试续传，不能当作完成
					fail(new Error(`下载被截断（已收 ${received}/${totalBytes} 字节）：${url}`));
				} else {
					// 收满（或大小未知）：成功收口（若 fail() 已在等待落盘回调，此处先 resolve 决定结果）
					settled = true;
					resolve();
				}
			});
			res.pipe(file);
		});

		req.setTimeout(CONNECT_TIMEOUT_MS, () => {
			req.destroy(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）：${url}`));
		});
		req.on('error', err => fail(err));
	});
}

function markError(err: Error, marks: { permanent?: boolean; restartFromScratch?: boolean }): IDownloadError {
	const marked = err as IDownloadError;
	marked.permanent = marks.permanent;
	marked.restartFromScratch = marks.restartFromScratch;
	return marked;
}

/** JSON GET（GitHub API 等小请求，非流式） */
export async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const client = url.startsWith('http://') ? http : https;
		const req = client.get(url, { headers }, res => {
			const status = res.statusCode ?? 0;
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if (status !== 200) {
					reject(new Error(`请求失败：HTTP ${status} ${body.slice(0, 200)}`));
					return;
				}
				try {
					resolve(JSON.parse(body) as T);
				} catch (err) {
					reject(err);
				}
			});
		});
		req.setTimeout(CONNECT_TIMEOUT_MS, () => {
			req.destroy(new Error(`请求超时：${url}`));
		});
		req.on('error', err => reject(err));
	});
}

/** 等待一个异步操作，超时抛错（不中断操作本身） */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
