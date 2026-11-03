/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import { createServer, Server } from 'net';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { timeout } from '../../../../base/common/async.js';
import { LlmLogLevel, LlmLogSource } from '../common/llm.js';

export interface ILlamaServerOptions {
	enginePath: string;
	modelPath: string;
	modelName: string;
	contextSize: number;
	gpuLayers: number;
	/** CPU 线程数（0 或缺省 = 引擎自动） */
	threads?: number;
	/** 提示词批处理大小（缺省 = 引擎默认 2048） */
	batchSize?: number;
	/** 微批处理大小（缺省 = 引擎默认） */
	ubatchSize?: number;
	/** Flash Attention（缺省 = 引擎自动判断） */
	flashAttention?: 'auto' | 'on' | 'off';
	/** K 缓存量化类型 */
	cacheTypeK?: string;
	/** V 缓存量化类型 */
	cacheTypeV?: string;
}

/** 引擎就绪的等待上限（大模型首次加载可能需要数分钟） */
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_INTERVAL_MS = 500;

/**
 * llama-server 子进程托管：
 * - 自动分配空闲内部端口（127.0.0.1 仅本机可达）
 * - /health 轮询就绪探测
 * - stdout/stderr 按行转发日志回调
 * - Windows 下 taskkill 进程树兜底清理
 */
export class LlamaServerController extends Disposable {

	private child: ChildProcess | undefined;
	private internalPort: number | undefined;

	private readonly _onDidExit = this._register(new Emitter<{ code: number | null }>());
	readonly onDidExit: Event<{ code: number | null }> = this._onDidExit.event;

	constructor(
		private readonly log: (level: LlmLogLevel, source: LlmLogSource, message: string) => void
	) {
		super();
	}

	get running(): boolean {
		return this.child !== undefined && this.child.exitCode === null;
	}

	get port(): number | undefined {
		return this.internalPort;
	}

	/** 启动引擎并等待模型就绪，返回内部端口 */
	async start(options: ILlamaServerOptions): Promise<number> {
		if (this.running) {
			throw new Error('引擎已在运行，请先停止当前模型');
		}
		const port = await allocateFreePort();
		const args = [
			'-m', options.modelPath,
			'--host', '127.0.0.1',
			'--port', String(port),
			'-c', String(options.contextSize),
			'-ngl', String(options.gpuLayers),
			// 抑制小模型陷入同一段内容无限复读（llama.cpp 默认 repeat-penalty 为 1.0，几乎不生效）
			'--repeat-penalty', '1.15',
			'--repeat-last-n', '256',
		];
		// 可选加载参数：仅在模型上显式配置时才下发，避免覆盖引擎默认值
		if (options.threads !== undefined && options.threads > 0) {
			args.push('-t', String(options.threads));
		}
		if (options.batchSize !== undefined && options.batchSize > 0) {
			args.push('-b', String(options.batchSize));
		}
		if (options.ubatchSize !== undefined && options.ubatchSize > 0) {
			args.push('-ub', String(options.ubatchSize));
		}
		if (options.flashAttention !== undefined) {
			args.push('--flash-attn', options.flashAttention);
		}
		if (options.cacheTypeK) {
			args.push('--cache-type-k', options.cacheTypeK);
		}
		if (options.cacheTypeV) {
			args.push('--cache-type-v', options.cacheTypeV);
		}
		this.log('info', 'engine', `启动 llama-server（端口 ${port}，模型 ${options.modelName}）`);
		const child = this.child = spawn(options.enginePath, args, { windowsHide: true });
		this.internalPort = port;

		const pendingErr: string[] = [];
		const onLine = (level: LlmLogLevel, line: string) => {
			const text = line.trimEnd();
			if (text) {
				pendingErr.push(text);
				if (pendingErr.length > 20) {
					pendingErr.shift();
				}
				this.log(level, 'engine', text);
			}
		};
		watchLines(child.stdout, line => onLine('info', line));
		watchLines(child.stderr, line => onLine('warn', line));

		const exited = new Promise<{ code: number | null }>(resolve => {
			child.once('exit', code => resolve({ code }));
		});
		const healthReady = this.waitUntilHealthy(port, HEALTH_TIMEOUT_MS);

		const result = await Promise.race([
			healthReady.then(() => 'ready' as const),
			exited.then(({ code }) => `exited:${code}` as const),
		]);

		if (result !== 'ready') {
			this.child = undefined;
			this.internalPort = undefined;
			this._onDidExit.fire({ code: child.exitCode });
			const tail = pendingErr.slice(-8).join(' | ');
			throw new Error(`引擎进程提前退出（code ${child.exitCode}）${tail ? `：${tail}` : ''}`);
		}

		child.once('exit', code => {
			this.log('warn', 'engine', `llama-server 进程退出（code ${code}）`);
			this.child = undefined;
			this.internalPort = undefined;
			this._onDidExit.fire({ code });
		});

		this.log('info', 'engine', `模型就绪：${options.modelName}（http://127.0.0.1:${port}）`);
		return port;
	}

	/** 停止引擎（进程树清理），幂等 */
	async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.internalPort = undefined;
		if (!child || child.exitCode !== null) {
			return;
		}
		const pid = child.pid;
		if (pid === undefined) {
			return;
		}
		await new Promise<void>(resolve => {
			child.once('exit', () => resolve());
			if (process.platform === 'win32') {
				// /T 终结整棵进程树，避免句柄残留
				spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
					.once('exit', () => resolve())
					.once('error', () => { child.kill(); resolve(); });
			} else {
				child.kill('SIGTERM');
				setTimeout(resolve, 2000);
			}
		});
	}

	private waitUntilHealthy(port: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		return new Promise<void>((resolve, reject) => {
			const probe = () => {
				if (this.child === undefined || this.child.exitCode !== null) {
					reject(new Error('引擎进程已退出'));
					return;
				}
				if (Date.now() > deadline) {
					reject(new Error(`模型加载超时（${Math.round(timeoutMs / 60000)} 分钟）`));
					return;
				}
				const req = http.get(`http://127.0.0.1:${port}/health`, res => {
					res.resume();
					if (res.statusCode === 200) {
						resolve();
					} else {
						scheduleNext();
					}
				});
				req.on('error', () => scheduleNext());
				req.setTimeout(2000, () => { req.destroy(); scheduleNext(); });
			};
			const scheduleNext = () => {
				timeout(HEALTH_INTERVAL_MS).then(probe, reject);
			};
			probe();
		});
	}

	override dispose(): void {
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null && child.pid !== undefined) {
			if (process.platform === 'win32') {
				spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
			} else {
				child.kill('SIGKILL');
			}
		}
		super.dispose();
	}
}

/** 分配一个空闲 TCP 端口（listen(0) 后立即释放，存在极小竞态窗口） */
export function allocateFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address !== null ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

function watchLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
	if (!stream) {
		return;
	}
	let buffer = '';
	stream.on('data', (chunk: Buffer) => {
		buffer += chunk.toString('utf8');
		let idx: number;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			onLine(buffer.slice(0, idx));
			buffer = buffer.slice(idx + 1);
		}
	});
	stream.on('end', () => {
		if (buffer) {
			onLine(buffer);
		}
	});
}
