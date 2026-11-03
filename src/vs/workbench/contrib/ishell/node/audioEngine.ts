/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { extract } from '../../../../base/node/zip.js';
import { downloadFile, getJson } from './llmDownloader.js';

// audio.cpp 预编译包（audiocpp_cli）发布在 GitHub Releases；与 llama.cpp 独立
const AUDIO_RELEASES = 'https://api.github.com/repos/0xShug0/audio.cpp/releases?per_page=10';
const GH_PROXY_PREFIX = 'https://gh-proxy.com/';

interface IGithubAsset {
	name: string;
	browser_download_url: string;
	size: number;
}

interface IGithubRelease {
	tag_name: string;
	assets: IGithubAsset[];
}

export interface IAudioEngineAsset {
	url: string;
	version: string;
	sizeBytes: number;
	assetName: string;
}

/** 在约定目录探测就位的 audiocpp_cli（深度 3 层，包内可能带 bin/ 子目录） */
export async function findAudioEngineExe(binDir: string): Promise<string | undefined> {
	const exeName = process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli';
	async function walk(dir: string, depth: number): Promise<string | undefined> {
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.toLowerCase() === exeName) {
				return join(dir, entry.name);
			}
		}
		if (depth <= 0) {
			return undefined;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const found = await walk(join(dir, entry.name), depth - 1);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	}
	return walk(binDir, 3);
}

/** 平台/架构匹配关键词（audio.cpp 资产命名可能随版本微调，采用宽匹配） */
function platformKeys(): { keys: string[]; archKeys: string[]; backendKeys: string[] } {
	if (process.platform === 'darwin') {
		return {
			keys: ['macos', 'darwin', 'osx'],
			archKeys: process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64'],
			backendKeys: ['metal'],
		};
	}
	if (process.platform === 'win32') {
		return {
			keys: ['windows', 'win-', 'win64'],
			archKeys: ['x64', 'x86_64', 'amd64'],
			backendKeys: ['cpu'],
		};
	}
	return {
		keys: ['ubuntu', 'linux'],
		archKeys: process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64'],
		backendKeys: ['cuda', 'cpu'],
	};
}

function scoreAsset(name: string): number {
	const lower = name.toLowerCase();
	if (!/\.(tar\.gz|zip)$/.test(lower)) {
		return -1;
	}
	const { keys, archKeys, backendKeys } = platformKeys();
	const hasPlatform = keys.some(k => lower.includes(k));
	const hasArch = archKeys.some(k => lower.includes(k));
	if (!hasPlatform || !hasArch) {
		return -1;
	}
	// 后端偏好：命中靠前的权重更高（darwin 仅 metal；linux cuda > cpu）
	const backendIndex = backendKeys.findIndex(k => lower.includes(k));
	let score = 10;
	if (backendIndex >= 0) {
		score += backendKeys.length - backendIndex;
	}
	// 避免误选调试/符号包或仅含动态库的包（优先可执行 bin 包）
	if (lower.includes('debug') || lower.includes('symbols') || /(^|[-_])lib([-_]|$)/.test(lower)) {
		score -= 5;
	}
	return score;
}

/** 按平台解析 audio.cpp 预编译资产（GitHub Releases） */
export async function resolveAudioEngineAsset(channel: 'direct' | 'ghproxy'): Promise<IAudioEngineAsset> {
	const releases = await getJson<IGithubRelease[]>(AUDIO_RELEASES, {
		'User-Agent': 'ishell',
		'Accept': 'application/vnd.github+json',
	});
	for (const release of releases) {
		let best: { asset: IGithubAsset; score: number } | undefined;
		for (const asset of release.assets) {
			const score = scoreAsset(asset.name);
			if (score > (best?.score ?? -1)) {
				best = { asset, score };
			}
		}
		if (best) {
			return {
				url: channel === 'ghproxy' ? GH_PROXY_PREFIX + best.asset.browser_download_url : best.asset.browser_download_url,
				version: release.tag_name,
				sizeBytes: best.asset.size,
				assetName: best.asset.name,
			};
		}
	}
	const checked = releases.flatMap(r => r.assets.map(a => `${r.tag_name}/${a.name}`)).slice(0, 12);
	throw new Error(`未找到当前平台（${process.platform}-${process.arch}）的 audio.cpp 预编译包。已检查：${checked.join(', ')}`);
}

/**
 * 下载并安装 audio.cpp 引擎 → binDir/audio/<tag>/ → 定位 audiocpp_cli。
 */
export async function installAudioEngine(options: {
	channel: 'direct' | 'ghproxy';
	binDir: string;
	onProgress?: (receivedBytes: number, totalBytes: number) => void;
	token?: CancellationToken;
}): Promise<{ enginePath: string; version: string; sizeBytes: number }> {
	const asset = await resolveAudioEngineAsset(options.channel);
	const isWindows = process.platform === 'win32';
	const archivePath = join(options.binDir, `audio-engine-${asset.version}${isWindows ? '.zip' : '.tar.gz'}`);
	const extractDir = join(options.binDir, 'audio', asset.version);

	await fsp.mkdir(options.binDir, { recursive: true });
	await downloadFile({
		url: asset.url,
		destPath: archivePath,
		headers: { 'User-Agent': 'ishell' },
		onProgress: options.onProgress,
		token: options.token,
	});

	await fsp.rm(extractDir, { recursive: true, force: true });
	await fsp.mkdir(extractDir, { recursive: true });
	if (asset.assetName.toLowerCase().endsWith('.zip')) {
		await extract(archivePath, extractDir, { overwrite: true }, options.token ?? CancellationToken.None);
	} else {
		// macOS / Linux 资产为 tar.gz，用系统 tar 解压（保留符号链接与执行位）
		await new Promise<void>((resolve, reject) => {
			const child = spawn('tar', ['-xzf', archivePath, '-C', extractDir], { windowsHide: true });
			child.once('error', reject);
			child.once('exit', code => code === 0 ? resolve() : reject(new Error(`tar 解压失败（code ${code}）`)));
		});
	}
	await fsp.rm(archivePath, { force: true });

	const enginePath = await findAudioEngineExe(extractDir);
	if (!enginePath) {
		throw new Error('audio.cpp 引擎包解压完成，但未找到 audiocpp_cli 可执行文件');
	}
	if (!isWindows) {
		await fsp.chmod(enginePath, 0o755).catch(() => undefined);
	}
	return { enginePath, version: asset.version, sizeBytes: asset.sizeBytes };
}
