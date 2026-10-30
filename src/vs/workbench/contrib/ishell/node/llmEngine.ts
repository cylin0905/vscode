/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fsp } from 'fs';
import { join } from 'path';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { extract } from '../../../../base/node/zip.js';
import { downloadFile, getJson } from './llmDownloader.js';

// 官方 latest release（vX.Y.Z 标记）不带预编译资产；预编译包在 bXXXX nightly releases
const GITHUB_RELEASES = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
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

export interface IEngineAsset {
	/** 实际下载 URL（已按通道拼接代理前缀） */
	url: string;
	version: string;
	sizeBytes: number;
}

/** 在约定目录探测就位的 llama-server.exe（深度 3 层，兼容 zip 内带 bin/ 子目录） */
export async function findEngineExe(binDir: string): Promise<string | undefined> {
	async function walk(dir: string, depth: number): Promise<string | undefined> {
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.toLowerCase() === 'llama-server.exe') {
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

/** 解析 llama.cpp nightly release 的 Windows CPU 资产（按 process.arch 精确匹配，排除 GPU 加速变体） */
export async function resolveEngineAsset(channel: 'direct' | 'ghproxy'): Promise<IEngineAsset> {
	const releases = await getJson<IGithubRelease[]>(GITHUB_RELEASES, {
		'User-Agent': 'ishell',
		'Accept': 'application/vnd.github+json',
	});
	const archKey = process.arch === 'arm64' ? 'arm64' : 'x64';
	// 官方命名固定：llama-bXXXX-bin-win-cpu-{arm64|x64}.zip
	const pattern = new RegExp(`^llama-b\\d+-bin-win-cpu-${archKey}\\.zip$`, 'i');
	for (const release of releases) {
		const asset = release.assets.find(a => pattern.test(a.name));
		if (asset) {
			return {
				url: channel === 'ghproxy' ? GH_PROXY_PREFIX + asset.browser_download_url : asset.browser_download_url,
				version: release.tag_name,
				sizeBytes: asset.size,
			};
		}
	}
	throw new Error(`未找到 Windows ${archKey} CPU 预编译包（已检查最近 ${releases.length} 个 releases）`);
}

/**
 * 下载并安装引擎：zip → binDir/<tag>/ 解压 → 定位 llama-server.exe。
 * 返回引擎路径与版本 tag。
 */
export async function installEngine(options: {
	channel: 'direct' | 'ghproxy';
	binDir: string;
	onProgress?: (receivedBytes: number, totalBytes: number) => void;
	token?: CancellationToken;
}): Promise<{ enginePath: string; version: string; sizeBytes: number }> {
	const asset = await resolveEngineAsset(options.channel);
	const zipPath = join(options.binDir, `engine-${asset.version}.zip`);
	const extractDir = join(options.binDir, asset.version);

	await downloadFile({
		url: asset.url,
		destPath: zipPath,
		headers: { 'User-Agent': 'ishell' },
		onProgress: options.onProgress,
		token: options.token,
	});

	await fsp.rm(extractDir, { recursive: true, force: true });
	await fsp.mkdir(extractDir, { recursive: true });
	await extract(zipPath, extractDir, { overwrite: true }, options.token ?? CancellationToken.None);
	await fsp.rm(zipPath, { force: true });

	const enginePath = await findEngineExe(options.binDir);
	if (!enginePath) {
		throw new Error('引擎包解压完成，但未找到 llama-server.exe');
	}
	return { enginePath, version: asset.version, sizeBytes: asset.sizeBytes };
}
