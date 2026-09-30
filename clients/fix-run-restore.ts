/**
 * Restore agent edits that a whole-package fixer run overwrote (#3598).
 *
 * `cargo clippy --fix` and `dart fix --apply` rewrite every fixable file of the
 * crate or package, but the pipeline's hold on pi's file-mutation queue covers
 * only the edit's own target (#3541, #3506). An agent edit to a SIBLING file
 * that lands while the tool runs is then erased by the tool's write, because
 * the tool read that file before the edit.
 *
 * Maintainer decision on #3598 (option 3, detect and restore; options 1 and 2
 * were rejected because queueing every crate file breaks the single lock
 * order and running on a copy needs a per-file apply):
 *
 * 1. Before the run, hash the files the tool can rewrite ({@link beginFixRun}).
 * 2. During the run, capture the bytes of any of those files pi-lens observes
 *    an agent mutate ({@link noteAgentMutation}, called from the tool_result
 *    seam and from the mutation bridge that observed-mutation replays through).
 * 3. After the run, write the captured bytes back over the tool's write and
 *    record ONE degradation for the run ({@link FixRun.finish}).
 * 4. A file the tool created is not in the pre-run set and is left alone.
 * 5. A capture the tool overwrote before pi-lens read it cannot be restored;
 *    the file is reported LOST by name so the agent can re-apply the edit.
 *
 * ## The set is bounded to what the tool can rewrite
 *
 * The caller passes the project walk it already took for its changed-file diff
 * (ignored and vendor directories excluded, capped at its scan limit). This
 * module keeps only the files with the tool's source extension (`.rs`,
 * `.dart`), skips any file over {@link FIX_RUN_MAX_FILE_BYTES}, and stops
 * hashing at {@link FIX_RUN_HASH_BYTE_BUDGET}; a cut set is recorded, never
 * silent.
 *
 * ## Residual, stated
 *
 * - The restore is a compare-then-write outside pi's queue for that file.
 *   Taking a second queue while the pipeline holds the target's is the lock
 *   order break option 1 was rejected for. The window is one read and one
 *   write of a small file.
 * - An agent edit whose tool_result reaches pi-lens only after the run closed
 *   is not seen. That needs the whole fixer run to end within milliseconds of
 *   the agent's write, and the tool's write to fall in that gap.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { writeFileAtomicAsync } from "./atomic-write.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { normalizeMapKey } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";

/** A file over this size is not a hand-written source file; it is not covered. */
export const FIX_RUN_MAX_FILE_BYTES = 1024 * 1024;

/** Total bytes hashed before a run. Files past it are not covered. */
export const FIX_RUN_HASH_BYTE_BUDGET = 64 * 1024 * 1024;

const HASH_CONCURRENCY = 32;

/** What the agent's own tool result says it wrote, when it says. */
export interface AgentWriteExpectation {
	/** A `write`: the whole file. */
	content?: string;
	/** An `edit`: text every applied edit put in the file. */
	fragments?: readonly string[];
}

interface Capture {
	bytes: Buffer;
	/** False when the bytes read do not contain what the agent wrote. */
	verified: boolean;
}

interface CoveredFile {
	filePath: string;
	hash: string;
	capture?: Capture;
}

export interface FixRunReport {
	/** Files whose captured agent bytes were written back over the tool's. */
	restored: string[];
	/** Files whose agent edit could not be kept: named so it can be re-applied. */
	lost: string[];
	/** Files the agent mutated during the run, restored or not. */
	agentEdited: string[];
}

export interface FixRun {
	finish(): Promise<FixRunReport>;
}

/**
 * Run `run` (the fixer's spawn) with the pre-run hash set and the capture in
 * place, and settle the run whether `run` returns or throws: a tool that exits
 * nonzero or times out has usually already rewritten files.
 */
export async function runWithFixRestore<T>(
	args: Parameters<typeof beginFixRun>[0],
	run: () => Promise<T>,
): Promise<{ value: T; report: FixRunReport }> {
	const fixRun = await beginFixRun(args);
	let value: T;
	try {
		value = await run();
	} catch (failure) {
		await fixRun.finish();
		throw failure;
	}
	return { value, report: await fixRun.finish() };
}

interface Registry {
	active: Set<{ files: Map<string, CoveredFile> }>;
}

const REGISTRY_FAMILY = "fix-run-restore";
const REGISTRY_VERSION = 1;

function registry(): Registry {
	return getProcessSingleton<Registry>(
		REGISTRY_FAMILY,
		REGISTRY_VERSION,
		() => ({
			active: new Set(),
		}),
	);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hash the tool's rewritable files and start capturing agent mutations of
 * them. Never throws: a file that cannot be read is simply not covered.
 * Always pair with `finish()` in a `finally`, or the run stays registered.
 */
export async function beginFixRun(args: {
	tool: string;
	/** The tool's source extension, with the dot. */
	extension: string;
	/** Absolute paths the caller's project walk found under the root. */
	candidates: Iterable<string>;
	byteBudget?: number;
}): Promise<FixRun> {
	const files = new Map<string, CoveredFile>();
	const run = { files };
	const wanted: string[] = [];
	for (const candidate of args.candidates)
		if (candidate.endsWith(args.extension)) wanted.push(candidate);
	wanted.sort();
	let remaining = args.byteBudget ?? FIX_RUN_HASH_BYTE_BUDGET;
	let cut = 0;
	for (let i = 0; i < wanted.length; i += HASH_CONCURRENCY) {
		const batch = wanted.slice(i, i + HASH_CONCURRENCY);
		const read = await Promise.all(
			batch.map(async (candidate) => {
				try {
					const stat = await fs.promises.stat(candidate);
					if (stat.size > FIX_RUN_MAX_FILE_BYTES || stat.size > remaining)
						return undefined;
					remaining -= stat.size;
					return { candidate, bytes: await fs.promises.readFile(candidate) };
				} catch {
					return undefined;
				}
			}),
		);
		for (const entry of read) {
			if (!entry) {
				cut += 1;
				continue;
			}
			files.set(normalizeMapKey(entry.candidate), {
				filePath: entry.candidate,
				hash: sha256(entry.bytes),
			});
		}
	}
	if (cut > 0) {
		recordDegradationOnce({
			kind: "fix-run-scope-truncated",
			subject: args.tool,
			reason: `${cut} of ${wanted.length} ${args.extension} file(s) were not hashed (unreadable, over ${FIX_RUN_MAX_FILE_BYTES} bytes, or past the ${args.byteBudget ?? FIX_RUN_HASH_BYTE_BUDGET}-byte budget); an agent edit to one of them during the run is not protected`,
		});
	}
	const { active } = registry();
	active.add(run);
	return {
		async finish(): Promise<FixRunReport> {
			active.delete(run);
			return settle(args.tool, files);
		},
	};
}

async function settle(
	tool: string,
	files: Map<string, CoveredFile>,
): Promise<FixRunReport> {
	const report: FixRunReport = { restored: [], lost: [], agentEdited: [] };
	for (const file of files.values()) {
		const capture = file.capture;
		if (!capture) continue;
		report.agentEdited.push(file.filePath);
		if (!capture.verified) {
			report.lost.push(file.filePath);
			continue;
		}
		let current: Buffer | undefined;
		try {
			current = await fs.promises.readFile(file.filePath);
		} catch {
			current = undefined;
		}
		if (current?.equals(capture.bytes)) continue;
		try {
			await writeFileAtomicAsync(file.filePath, capture.bytes, {
				bestEffort: false,
			});
			report.restored.push(file.filePath);
		} catch {
			report.lost.push(file.filePath);
		}
	}
	if (report.restored.length > 0 || report.lost.length > 0) {
		// One record per run, however many files: `incrementDegradationCount`
		// keeps the subject's count equal to the number of runs affected.
		incrementDegradationCount({
			kind: "fix-run-agent-edit-overwritten",
			subject: tool,
			reason: `${tool} rewrote files an agent edited during the run: ${report.restored.length} restored, ${report.lost.length} lost (${[...report.restored, ...report.lost].slice(0, 5).join(", ")})`,
		});
	}
	return report;
}

/**
 * Called when pi-lens observes an agent mutation of `filePath`. Reads the
 * file's bytes right now for every active run that covers it. Synchronous on
 * purpose: the read has to land before the tool's next write, and it is only
 * paid for a path that is inside a live run's set.
 */
export function noteAgentMutation(
	filePath: string,
	expected?: AgentWriteExpectation,
): void {
	const { active } = registry();
	if (active.size === 0) return;
	let key: string | undefined;
	for (const run of active) {
		key ??= normalizeMapKey(filePath);
		const file = run.files.get(key);
		if (!file) continue;
		try {
			const bytes = fs.readFileSync(file.filePath);
			// Bytes equal to the pre-run bytes are not an agent change to protect.
			if (sha256(bytes) === file.hash) {
				delete file.capture;
				continue;
			}
			file.capture = { bytes, verified: contains(bytes, expected) };
		} catch {
			// An unreadable file has nothing to capture; the tool's write stands.
		}
	}
}

function contains(bytes: Buffer, expected?: AgentWriteExpectation): boolean {
	if (!expected) return true;
	const text = bytes.toString("utf8");
	if (expected.content !== undefined && text !== expected.content) return false;
	return (expected.fragments ?? []).every((fragment) =>
		text.includes(fragment),
	);
}

/** The loud report for files whose agent edit could not be kept. */
export function renderFixRunLoss(displayPaths: readonly string[]): string {
	const list = displayPaths
		.slice(0, 8)
		.map((file) => `  - ${file}`)
		.join("\n");
	const more =
		displayPaths.length > 8
			? `\n  - ... and ${displayPaths.length - 8} more`
			: "";
	return `⚠️ **An auto-fix run overwrote your edit to ${displayPaths.length === 1 ? "this file" : "these files"} while it ran, and pi-lens could not restore it. Re-read ${displayPaths.length === 1 ? "it" : "each"} and re-apply your change:**\n${list}${more}`;
}

/**
 * What a native write or edit says it put in the file, read from the EXECUTED
 * tool input: a `write`'s whole `content`, an `edit`'s non-empty `newText`s.
 * Anything else states nothing, and the capture is taken unverified.
 */
export function expectationFromToolInput(
	input: unknown,
	kind: "write" | "edit",
): AgentWriteExpectation | undefined {
	const args = input as
		| { content?: unknown; newText?: unknown; edits?: unknown }
		| undefined;
	if (kind === "write")
		return typeof args?.content === "string"
			? { content: args.content }
			: undefined;
	const edits = Array.isArray(args?.edits) ? args.edits : [args];
	const fragments = edits.flatMap((edit) => {
		const text = (edit as { newText?: unknown } | undefined)?.newText;
		return typeof text === "string" && text.length > 0 ? [text] : [];
	});
	return fragments.length > 0 ? { fragments } : undefined;
}
