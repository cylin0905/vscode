/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileIO } from './connectionStore.js';

export type HostKeyVerificationResult = 'known' | 'unknown' | 'mismatch';

interface IKnownHostsFile {
	version: 1;
	entries: Record<string, { algorithm: string; fingerprint: string }>;
}

/**
 * known_hosts 指纹存储（TOFU：首次确认后记住；变更时硬阻断）。
 * 纯逻辑类，不直接触碰 fs。
 */
export class KnownHostsStore {

	private entries: Record<string, { algorithm: string; fingerprint: string }> = {};

	constructor(private readonly io: IFileIO) { }

	async load(): Promise<void> {
		const raw = await this.io.readFile();
		if (raw === undefined || raw.trim() === '') {
			this.entries = {};
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<IKnownHostsFile>;
			this.entries = (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object')
				? parsed.entries
				: {};
		} catch {
			this.entries = {};
		}
	}

	private async persist(): Promise<void> {
		const content: IKnownHostsFile = { version: 1, entries: this.entries };
		await this.io.writeFile(JSON.stringify(content, null, '\t'));
	}

	private key(host: string, port: number): string {
		return `${host.toLowerCase()}:${port}`;
	}

	verify(host: string, port: number, fingerprint: string): HostKeyVerificationResult {
		const entry = this.entries[this.key(host, port)];
		if (entry === undefined) {
			return 'unknown';
		}
		return entry.fingerprint === fingerprint ? 'known' : 'mismatch';
	}

	/** 记录（首次确认后调用；已存在则覆盖） */
	async record(host: string, port: number, algorithm: string, fingerprint: string): Promise<void> {
		this.entries[this.key(host, port)] = { algorithm, fingerprint };
		await this.persist();
	}

	/** 清除指定主机指纹（用于"指纹变更后重新信任"流程） */
	async remove(host: string, port: number): Promise<void> {
		delete this.entries[this.key(host, port)];
		await this.persist();
	}
}
