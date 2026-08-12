/**
 * Synchronous locked read-modify-write commit seam for behavior-gating JSON
 * stores shared by multiple pi-lens processes.
 *
 * The authoritative read happens only after the bounded PID lock is held; the
 * caller merges only its delta, publication is a throwing atomic replacement,
 * and success telemetry runs only after publication succeeds.
 *
 * The installer probe cache deliberately retains its richer, older lock. Its
 * quarantine recovery and install-lifetime ageing semantics predate this seam;
 * folding that protocol is follow-up work under #1212, not a safe mechanical
 * substitution for these short synchronous commits.
 */

import * as fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.js";
import { acquireBoundedPidFileLock } from "./bounded-pid-file-lock.js";

interface DurableStoreCommitBase<T> {
	path: string;
	deserialize: (contents: string | undefined) => T;
	merge: (current: T) => T;
	serialize: (value: T) => string | Uint8Array;
	waitMs: number;
	retryMs: number;
	timeoutMessage: string;
	afterWriteLocked?: (value: T) => void;
}

function readLocked(path: string): string | undefined {
	try {
		return fs.readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function commitDurableStore<T>(
	options: DurableStoreCommitBase<T> & { onContention?: "throw" },
): T;
export function commitDurableStore<T>(
	options: DurableStoreCommitBase<T> & {
		onContention: "skip-log";
		logContention: () => void;
	},
): T | undefined;
export function commitDurableStore<T>(
	options: DurableStoreCommitBase<T> & (
		| { onContention?: "throw" }
		| { onContention: "skip-log"; logContention: () => void }
	),
): T | undefined {
	const release =
		options.onContention === "skip-log"
			? acquireBoundedPidFileLock(`${options.path}.lock`, {
					waitMs: options.waitMs,
					retryMs: options.retryMs,
					timeoutMessage: options.timeoutMessage,
					onContention: "skip-log",
					logContention: options.logContention,
				})
			: acquireBoundedPidFileLock(`${options.path}.lock`, {
					waitMs: options.waitMs,
					retryMs: options.retryMs,
					timeoutMessage: options.timeoutMessage,
					onContention: "throw",
				});
	if (!release) return undefined;
	let committed: T;
	try {
		const current = options.deserialize(readLocked(options.path));
		committed = options.merge(current);
		writeFileAtomic(options.path, options.serialize(committed), {
			bestEffort: false,
		});
		options.afterWriteLocked?.(committed);
	} finally {
		release();
	}
	return committed;
}
