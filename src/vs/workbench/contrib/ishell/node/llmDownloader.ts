/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createWriteStream, promises as fsp } from 'fs';
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
}

const MAX_REDIRECTS = 10;
const CONNECT_TIMEOUT_MS = 30_000;
const PROGRESS_THROTTLE_MS = 200;

/**
 * 通用流式文件下载（引擎 zip / GGUF 模型共用）：
 * - 30x 重定向跟随（HF resolve → CDN 场景）
 * - 进度节流回调 + CancellationToken 取消（自动清理 .part）
 * - 落盘 <destPath>.part → 原子 rename
 */
export async function downloadFile(options: IDownloadOptions): Promise<void> {
	const { url, destPath, headers, onProgress, token } = options;
	const partPath = `${destPath}.part`;

	await fsp.mkdir(dirname(destPath), { recursive: true });

	try {
		await doDownload(url, partPath, headers, onProgress, token, 0);
		await fsp.rename(partPath, destPath);
	} catch (err) {
		await fsp.rm(partPath, { force: true });
		throw err;
	}
}

function doDownload(
	url: string,
	partPath: string,
	headers: Record<string, string> | undefined,
	onProgress: ((received: number, total: number) => void) | undefined,
	token: CancellationToken | undefined,
	redirectCount: number,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (token?.isCancellationRequested) {
			reject(new Error('下载已取消'));
			return;
		}

		if (redirectCount > MAX_REDIRECTS) {
			reject(new Error('重定向次数过多'));
			return;
		}

		const client = url.startsWith('http://') ? http : https;
		const req = client.get(url, { headers }, res => {
			const status = res.statusCode ?? 0;

			// 重定向：跟随 Location（相对地址补全）
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				const nextUrl = new URL(res.headers.location, url).toString();
				req.destroy();
				doDownload(nextUrl, partPath, headers, onProgress, token, redirectCount + 1).then(resolve, reject);
				return;
			}

			if (status !== 200) {
				res.resume();
				req.destroy();
				reject(new Error(`下载失败：HTTP ${status}（${url}）`));
				return;
			}

			const totalBytes = Number(res.headers['content-length'] ?? 0);
			let received = 0;
			let lastNotify = 0;

			const cancelSub = token?.onCancellationRequested(() => {
				req.destroy(new Error('下载已取消'));
			});

			const file = createWriteStream(partPath);
			res.on('data', (chunk: Buffer) => {
				received += chunk.length;
				const now = Date.now();
				if (onProgress && (now - lastNotify >= PROGRESS_THROTTLE_MS || received === totalBytes)) {
					lastNotify = now;
					onProgress(received, totalBytes);
				}
			});
			res.on('error', err => {
				cancelSub?.dispose();
				file.destroy();
				reject(err);
			});
			file.on('error', err => {
				cancelSub?.dispose();
				req.destroy();
				reject(err);
			});
			file.on('finish', () => {
				cancelSub?.dispose();
				if (token?.isCancellationRequested) {
					reject(new Error('下载已取消'));
				} else {
					resolve();
				}
			});
			res.pipe(file);
		});

		req.setTimeout(CONNECT_TIMEOUT_MS, () => {
			req.destroy(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）：${url}`));
		});
		req.on('error', err => reject(err));
	});
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

