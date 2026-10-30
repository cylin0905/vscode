/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// #########################################################################
// ##          iShell 三方合并（diff3 简化实现，按行粒度）                  ##
// ##  用途：模型改写文件时，磁盘内容（ours）与模型期望基准不一致的         ##
// ##  自动合并；无法干净合并时输出冲突标记供用户裁决。                      ##
// ##  base  = 版本历史中的最近快照（模型上次看到的基准）                    ##
// ##  ours  = 磁盘上的当前内容（用户可能手动改过）                          ##
// ##  theirs= 模型基于 base 生成的新内容                                    ##
// #########################################################################

export interface ILlmMergeResult {
	/** 合并结果（含冲突标记时 conflicts > 0） */
	merged: string;
	/** 冲突块数量 */
	conflicts: number;
}

export const MERGE_CONFLICT_LABEL_OURS = '<<<<<<< ishell（当前文件）';
export const MERGE_CONFLICT_LABEL_BASE = '||||||| ishell（基准版本）';
export const MERGE_CONFLICT_SEP = '=======';
export const MERGE_CONFLICT_LABEL_THEIRS = '>>>>>>> ishell（模型修改）';

function splitLines(text: string): string[] {
	return text.replace(/\r\n/g, '\n').split('\n');
}

/** LCS 匹配对（严格递增）：a[i] === b[j] 的对齐结果 */
function lcsMatchPairs(a: string[], b: string[]): { ai: number; bj: number }[] {
	const n = a.length;
	const m = b.length;
	// 大文件保护：超过 400 万单元格时退化为空匹配（冲突处理兜底）
	if ((n + 1) * (m + 1) > 4_000_000) {
		return [];
	}
	const dp = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * (m + 1) + j] = a[i] === b[j]
				? dp[(i + 1) * (m + 1) + (j + 1)] + 1
				: Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
		}
	}
	const pairs: { ai: number; bj: number }[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pairs.push({ ai: i, bj: j });
			i++;
			j++;
		} else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
}

function sameLines(a: string[], b: string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/** 三方合并一个不稳定区间：能自动裁决则自动，否则输出冲突块 */
function mergeRegion(base: string[], ours: string[], theirs: string[], out: string[]): number {
	if (sameLines(ours, theirs)) {
		out.push(...ours); // 双方一致改动
		return 0;
	}
	if (sameLines(ours, base)) {
		out.push(...theirs); // 仅 theirs 改动
		return 0;
	}
	if (sameLines(theirs, base)) {
		out.push(...ours); // 仅 ours 改动
		return 0;
	}
	// 真冲突：ours / base / theirs 并列输出冲突标记
	out.push(MERGE_CONFLICT_LABEL_OURS, ...ours, MERGE_CONFLICT_LABEL_BASE, ...base, MERGE_CONFLICT_SEP, ...theirs, MERGE_CONFLICT_LABEL_THEIRS);
	return 1;
}

/** 按行三方合并（diff3）。任一输入为空串表示该侧无内容。 */
export function merge3Way(base: string, ours: string, theirs: string): ILlmMergeResult {
	const baseLines = splitLines(base);
	const oursLines = splitLines(ours);
	const theirsLines = splitLines(theirs);

	// 两侧对 base 的 LCS 匹配（map: base 行号 -> 侧行号）
	const pairsA = lcsMatchPairs(baseLines, oursLines);
	const pairsB = lcsMatchPairs(baseLines, theirsLines);
	const mapA = new Map(pairsA.map(p => [p.ai, p.bj]));
	const mapB = new Map(pairsB.map(p => [p.ai, p.bj]));

	// 双侧同锚点（base 行在两侧都被匹配）且单调 → 稳定点
	const anchors: number[] = [];
	for (let b = 0; b < baseLines.length; b++) {
		if (mapA.has(b) && mapB.has(b)) {
			anchors.push(b);
		}
	}

	const out: string[] = [];
	let conflicts = 0;
	let baseIdx = 0;
	let oursIdx = 0;
	let theirsIdx = 0;

	for (const b of anchors) {
		const o = mapA.get(b)!;
		const t = mapB.get(b)!;
		// LCS 单调性保证 o >= oursIdx 且 t >= theirsIdx
		conflicts += mergeRegion(
			baseLines.slice(baseIdx, b),
			oursLines.slice(oursIdx, o),
			theirsLines.slice(theirsIdx, t),
			out,
		);
		out.push(baseLines[b]);
		baseIdx = b + 1;
		oursIdx = o + 1;
		theirsIdx = t + 1;
	}
	// 尾部区间
	conflicts += mergeRegion(
		baseLines.slice(baseIdx),
		oursLines.slice(oursIdx),
		theirsLines.slice(theirsIdx),
		out,
	);

	// 保留行尾换行：两侧内容任一以换行结尾即保留
	const endsWithNewline = ours.endsWith('\n') || theirs.endsWith('\n');
	let merged = out.join('\n');
	if (endsWithNewline && !merged.endsWith('\n')) {
		merged += '\n';
	}
	return { merged, conflicts };
}
