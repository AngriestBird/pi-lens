/**
 * #4484 round 3: where a line of one version of a file sits in the next.
 *
 * A recorded blocker names a line of the bytes it was recorded on. After a
 * write, the same finding sits on that line only if nothing above it moved,
 * and an unrelated match of the same rule can sit anywhere. So the carry asks
 * where the recorded line is now (R2 in PR #4491's round-3 table): it aligns
 * the two versions by per-line content hash and maps the recorded line
 * through the alignment. An edited or deleted line maps nowhere.
 *
 * The alignment is a Myers shortest edit script over the lines between the
 * common prefix and suffix, bounded by {@link MAX_ALIGNMENT_EDITS}. A rewrite
 * larger than that has no alignment, and the caller falls back to the
 * recorded line number.
 */
import { lineContentHash } from "./read-guard.js";

/** Lines beyond which no alignment is attempted (the whole-file hash cap is 2 MiB). */
export const MAX_ALIGNMENT_LINES = 100_000;
/** Insertions plus deletions beyond which a change has no alignment. */
export const MAX_ALIGNMENT_EDITS = 1_000;

/**
 * What a file's last applied inline verdict analysed (#4484 round 3): the
 * per-line hashes of its bytes, which the recorded blockers' lines refer to,
 * and per runner that reached no verdict, the lines still owed to it (R4),
 * in those bytes.
 */
export interface AnalysisAnchor {
	readonly lineHashes: readonly string[] | undefined;
	/** Per runner id, the lines owed to it. */
	readonly owedRanges: ReadonlyMap<
		string,
		ReadonlyArray<{ start: number; end: number }>
	>;
}

/** 1-based line in the old version to 1-based line in the new one, or undefined when edited or deleted. */
export type LineMap = (line: number) => number | undefined;

/** Per-line hashes of `text`, the same whitespace-stripped hash the read guard stores. */
export function lineHashesOf(text: string): string[] | undefined {
	const lines = text.split(/\r?\n/);
	if (lines.length > MAX_ALIGNMENT_LINES) return undefined;
	return lines.map((line) => lineContentHash(line));
}

/**
 * Align `before` to `after` (per-line hashes). Returns undefined when the
 * change exceeds `maxEdits` insertions plus deletions.
 */
export function alignLines(
	before: readonly string[],
	after: readonly string[],
	maxEdits: number = MAX_ALIGNMENT_EDITS,
): LineMap | undefined {
	const n = before.length;
	const m = after.length;
	let prefix = 0;
	while (prefix < n && prefix < m && before[prefix] === after[prefix])
		prefix += 1;
	let suffix = 0;
	while (
		suffix < n - prefix &&
		suffix < m - prefix &&
		before[n - 1 - suffix] === after[m - 1 - suffix]
	)
		suffix += 1;
	const a = before.slice(prefix, n - suffix);
	const b = after.slice(prefix, m - suffix);
	const middle = myersMatches(a, b, maxEdits);
	if (middle === undefined) return undefined;
	return (line: number) => {
		const index = line - 1;
		if (!Number.isInteger(index) || index < 0 || index >= n) return undefined;
		if (index < prefix) return line;
		if (index >= n - suffix) return index + (m - n) + 1;
		const target = middle[index - prefix] ?? -1;
		return target === -1 ? undefined : prefix + target + 1;
	};
}

/**
 * For each index of `a`, the index of `b` it is matched to on a shortest edit
 * script, or -1. Undefined when more than `maxEdits` edits are needed.
 */
function myersMatches(
	a: readonly string[],
	b: readonly string[],
	maxEdits: number,
): Int32Array | undefined {
	const n = a.length;
	const m = b.length;
	const matches = new Int32Array(n).fill(-1);
	if (n === 0 || m === 0) return matches;
	const limit = Math.min(n + m, maxEdits);
	const offset = limit + 1;
	const v = new Int32Array(2 * limit + 3);
	// Every index read below lies inside `v`; `?? 0` only narrows the type.
	const furthest = (k: number) => v[offset + k] ?? 0;
	// trace[d] is v over k in [-(d+1), d+1] before step d.
	const trace: Int32Array[] = [];
	for (let d = 0; d <= limit; d += 1) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && furthest(k - 1) < furthest(k + 1))
					? furthest(k + 1)
					: furthest(k - 1) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				backtrack(trace, n, m, matches);
				return matches;
			}
		}
	}
	return undefined;
}

function backtrack(
	trace: readonly Int32Array[],
	n: number,
	m: number,
	matches: Int32Array,
): void {
	let x = n;
	let y = m;
	for (const [d, v] of [...trace.entries()].reverse()) {
		// Every k read below lies in [-(d+1), d+1]; `?? 0` only narrows the type.
		const at = (k: number) => v[k + d + 1] ?? 0;
		const k = x - y;
		const prevK =
			k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x -= 1;
			y -= 1;
			matches[x] = y;
		}
		if (d > 0) {
			x = prevX;
			y = prevY;
		}
	}
}

/** Every line `ranges` cover (1-based, inclusive ends). */
export function linesOfRanges(
	ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): number[] {
	const lines: number[] = [];
	for (const { start, end } of ranges)
		for (let line = start; line <= end; line += 1) lines.push(line);
	return lines;
}

/** The fewest ranges that cover exactly `lines`, in order. */
export function rangesOfLines(
	lines: Iterable<number>,
): { start: number; end: number }[] {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	const ranges: { start: number; end: number }[] = [];
	for (const line of sorted) {
		const last = ranges.at(-1);
		if (last && line === last.end + 1) last.end = line;
		else ranges.push({ start: line, end: line });
	}
	return ranges;
}

/**
 * #4484 round 3 (R4): the lines each runner is owed after a dispatch. A
 * runner that reached no verdict (`noVerdict`) and is not still in flight is
 * owed what it was handed: the edit's range plus its earlier owed lines, or
 * the whole file when the dispatch had no range. An in-flight runner settles
 * on its own, and a runner with a verdict is owed nothing. A run that may not
 * deliver (`delivers: false`, an unauthored run, #3226) discharges nothing:
 * every earlier owed line stays owed.
 */
export function owedRangesAfterDispatch(input: {
	noVerdict: readonly string[];
	collectLater: readonly string[];
	modifiedRanges: ReadonlyArray<{ start: number; end: number }> | undefined;
	owed: ReadonlyMap<string, ReadonlyArray<{ start: number; end: number }>>;
	lineCount: () => number;
	delivers: boolean;
}): Map<string, { start: number; end: number }[]> {
	const collectLater = new Set(input.collectLater);
	const owedRanges = new Map<string, { start: number; end: number }[]>();
	for (const runnerId of input.noVerdict) {
		if (collectLater.has(runnerId)) continue;
		const lineCount = input.modifiedRanges ? 0 : input.lineCount();
		const ranges = input.modifiedRanges
			? rangesOfLines([
					...linesOfRanges(input.modifiedRanges),
					...linesOfRanges(input.owed.get(runnerId) ?? []),
				])
			: lineCount > 0
				? [{ start: 1, end: lineCount }]
				: [];
		if (ranges.length > 0) owedRanges.set(runnerId, ranges);
	}
	if (!input.delivers) {
		for (const [runnerId, ranges] of input.owed) {
			owedRanges.set(
				runnerId,
				rangesOfLines([
					...linesOfRanges(owedRanges.get(runnerId) ?? []),
					...linesOfRanges(ranges),
				]),
			);
		}
	}
	return owedRanges;
}
