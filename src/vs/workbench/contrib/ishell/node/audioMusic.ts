/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { basename, dirname, join } from 'path';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILlmModelRecord, ILlmMusicRequest, ILlmSourceConfig } from '../common/llm.js';
import { downloadFile } from './llmDownloader.js';
import { MIRROR_ENDPOINT, MODELSCOPE_ENDPOINT, OFFICIAL_ENDPOINT } from './llmModelStore.js';

export interface IMusicPrepareContext {
	modelsDir: string;
	source: ILlmSourceConfig;
	/** token 用于取消下载 */
	token?: CancellationToken;
	onProgress: (message: string, percent?: number) => void;
	onLog: (line: string) => void;
}

/** 音乐模型必需附属文件（audio.cpp 以 --model 目录自动读取） */
const YUE2_SIDECARS = [
	'sidecars/yue2-model-config.json',
	'sidecars/yue2-generation-config.json',
	'sidecars/yue2-qwen.tiktoken',
	'sidecars/yue2-vae-config.json',
];

function isModelScopeSource(source: ILlmSourceConfig): boolean {
	return source.kind === 'modelscope';
}

/** 仓库内文件下载地址（魔搭走 FilePath 302；其余走 resolve/main） */
function fileUrls(source: ILlmSourceConfig, repo: string, file: string): string[] {
	const repoPath = repo.split('/').map(segment => encodeURIComponent(segment)).join('/');
	if (isModelScopeSource(source)) {
		return [`${MODELSCOPE_ENDPOINT}/api/v1/models/${repoPath}/repo?Revision=master&FilePath=${encodeURIComponent(file)}`];
	}
	const direct = `${source.endpoint}/${repo}/resolve/main/${file}`;
	if (source.kind === 'official') {
		return [direct, `${MIRROR_ENDPOINT}/${repo}/resolve/main/${file}`];
	}
	if (source.kind === 'mirror') {
		return [direct, `${OFFICIAL_ENDPOINT}/${repo}/resolve/main/${file}`];
	}
	return [direct];
}

async function exists(path: string): Promise<boolean> {
	try {
		await fsp.access(path);
		return true;
	} catch {
		return false;
	}
}

/** 主 GGUF 以仓库原文件名就位：同目录直接复用，否则链接（失败回退复制） */
async function ensureMainGguf(model: ILlmModelRecord, modelDir: string): Promise<string> {
	const mainFile = model.file ?? basename(model.filePath);
	const target = join(modelDir, mainFile);
	if (await exists(target)) {
		return mainFile;
	}
	await fsp.mkdir(dirname(target), { recursive: true });
	// 源文件若已是目标路径（同一文件），无需链接
	if (model.filePath === target) {
		return mainFile;
	}
	try {
		await fsp.symlink(model.filePath, target);
	} catch {
		await fsp.copyFile(model.filePath, target);
	}
	return mainFile;
}

/**
 * 确保音乐模型目录完整：
 * <modelsDir>/music/<catalogId>/ 下包含主 GGUF（原文件名）、VAE 与 sidecars。
 * 缺失文件按当前下载源自动补齐（幂等）。
 */
export async function prepareMusicModel(model: ILlmModelRecord, ctx: IMusicPrepareContext): Promise<{
	modelDir: string;
	mainFile: string;
	vaeFile: string;
}> {
	const repo = model.repo ?? '';
	if (!repo) {
		throw new Error(`音乐模型缺少来源仓库信息，无法补齐附属文件：${model.name}`);
	}
	const modelDir = join(ctx.modelsDir, 'music', model.catalogId);
	await fsp.mkdir(modelDir, { recursive: true });

	const vaeType = model.params?.vaeType ?? 'f16';
	const vaeFile = `yue2-vae-${vaeType}.gguf`;
	const mainFile = await ensureMainGguf(model, modelDir);

	const required = [vaeFile, ...YUE2_SIDECARS];
	for (let i = 0; i < required.length; i++) {
		const rel = required[i];
		const dest = join(modelDir, rel);
		if (await exists(dest)) {
			ctx.onProgress(`附属文件已就绪（${i + 1}/${required.length}）：${rel}`, Math.round(((i + 1) / required.length) * 100));
			continue;
		}
		ctx.onLog(`下载附属文件（${i + 1}/${required.length}）：${rel}`);
		ctx.onProgress(`下载附属文件（${i + 1}/${required.length}）：${rel}`, Math.round((i / required.length) * 100));
		await fsp.mkdir(dirname(dest), { recursive: true });
		const urls = fileUrls(ctx.source, repo, rel);
		let lastErr: Error | undefined;
		for (const url of urls) {
			if (ctx.token?.isCancellationRequested) {
				throw new Error('已取消');
			}
			try {
				await downloadFile({ url, destPath: dest, headers: { 'User-Agent': 'ishell' }, token: ctx.token });
				lastErr = undefined;
				break;
			} catch (err) {
				lastErr = err as Error;
				ctx.onLog(`附属文件下载失败（${rel}）：${(err as Error).message}`);
			}
		}
		if (lastErr) {
			throw new Error(`附属文件下载失败：${rel}（${lastErr.message}）`);
		}
		ctx.onProgress(`附属文件已就绪（${i + 1}/${required.length}）：${rel}`, Math.round(((i + 1) / required.length) * 100));
	}

	ctx.onProgress('模型文件已就绪', 100);
	return { modelDir, mainFile, vaeFile };
}

/** 构造 audiocpp_cli 参数数组（值中的空格由 spawn 参数数组保证安全） */
export function buildMusicArgs(options: {
	modelDir: string;
	mainFile: string;
	vaeFile: string;
	request: Required<Pick<ILlmMusicRequest, 'lyrics' | 'style'>> & {
		cotMode: 'off' | 'melody' | 'full';
		steps: number;
		seed: number;
		threads: number;
		audioBackend: 'auto' | 'metal' | 'cuda' | 'cpu';
		durationSeconds: number;
	};
	outPath: string;
}): string[] {
	const backend = options.request.audioBackend === 'auto'
		? (process.platform === 'darwin' ? 'metal' : 'cpu')
		: options.request.audioBackend;
	const args = [
		'--task', 'gen',
		'--family', 'yue2',
		'--model', options.modelDir,
		'--backend', backend,
	];
	// threads = 0 表示交给引擎自动决定，不传该参数
	if (options.request.threads > 0) {
		args.push('--threads', String(options.request.threads));
	}
	args.push(
		'--text', options.request.lyrics,
		'--request-option', `style=${options.request.style}`,
		'--request-option', `cot=${options.request.cotMode}`,
	);
	// seed 只接受无符号整数；-1 表示随机，此时在本地生成一个随机种子
	const seed = options.request.seed >= 0
		? options.request.seed
		: Math.floor(Math.random() * 2147483647);
	args.push('--request-option', `seed=${seed}`);
	args.push(
		'--request-option', `num_inference_steps=${options.request.steps}`,
	);
	// durationSeconds = 0 表示由引擎自动决定时长
	if (options.request.durationSeconds > 0) {
		args.push('--duration-seconds', String(options.request.durationSeconds));
	}
	args.push(
		'--session-option', `yue2.model_gguf=${options.mainFile}`,
		'--session-option', `yue2.vae_gguf=${options.vaeFile}`,
		'--out', options.outPath,
		'--log',
	);
	return args;
}
