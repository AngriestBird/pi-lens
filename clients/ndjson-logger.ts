/**
 * Shared write-plumbing for the hand-rolled NDJSON debug loggers in clients/.
 *
 * One buffered async writer replaces eight drifting copies of append+rotate.
 * `log()`/`append()` are synchronous-call, async-write: they enqueue a
 * serialized line and a single in-flight `fs.promises.appendFile` drains the
 * queue — no `appendFileSync` on the per-edit hot path (latency-logger alone
 * fired ~10–20 sync appends per edit, #454/#361/#368).
 *
 * Errors are swallowed best-effort, matching every current logger. A
 * best-effort SYNC flush is registered on `process.on("exit")` (appendFileSync
 * is fine at exit — not the hot path; no child spawning, #234).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** A queued write ("line") or an in-band truncate op (latency clear). */
type QueueItem = { kind: "line"; line: string } | { kind: "truncate" };

export interface NdjsonLoggerOptions {
	/** Absolute log file path, or a lazy resolver (diagnostic-logger keys on the date). */
	filePath: string | (() => string);
	/**
	 * Rotation threshold in bytes. Absent = never rotate (preserves the loggers
	 * that don't rotate today). At/above the threshold the file is renamed to
	 * `<filePath>.1` (previous backup removed first, Windows-safe).
	 */
	maxBytes?: number;
	/** Backup path for rotation. Defaults to `<filePath>.1`. Ignored without maxBytes. */
	backupPath?: string | (() => string);
}

export interface NdjsonLogger {
	/** Serialize `obj` to one NDJSON line and enqueue it (async write). */
	log(obj: unknown): void;
	/** Enqueue an already-serialized line (must NOT include the trailing newline). */
	append(line: string): void;
	/** Enqueue a truncate op in the same serialized queue (clear-without-racing). */
	truncate(): void;
	/** Resolves once everything enqueued so far is on disk. */
	flush(): Promise<void>;
	/** Best-effort SYNC flush of any buffered lines — safe to call at process exit. */
	flushSync(): void;
}

function resolve(v: string | (() => string)): string {
	return typeof v === "function" ? v() : v;
}

// One shared exit handler flushes every logger — avoids an EventEmitter
// MaxListeners warning once more than ~10 loggers exist (we ship eight, plus
// diagnostic + test instances). No child spawning at teardown (#234).
const exitFlushers = new Set<() => void>();
let exitHandlerRegistered = false;

/** Test-only view of the registered exit flushers (see ndjson-logger.test.ts). */
export function _exitFlushersForTest(): ReadonlySet<() => void> {
	return exitFlushers;
}

// Auto-derived retention coverage (clients/log-cleanup.ts): every *static*
// filePath a createNdjsonLogger instance is constructed with self-registers
// here at module-load time — the moment latency-logger.ts, bus-events-logger.ts,
// etc. call createNdjsonLogger(), the sweep in log-cleanup.ts picks the file up
// automatically. No second hand-maintained list to forget (the exact mistake
// that left actionable-warnings/ast-grep-tools/dead-code, then bus-events.log,
// unrotated — see log-cleanup.ts's module doc).
//
// A *lazy* filePath (a resolver function, e.g. diagnostic-logger's date-keyed
// `logs/{date}.jsonl`) is deliberately NOT registered: those already live
// under the `logs/` subdirectory and are covered by log-cleanup's separate
// `*.jsonl` daily-log sweep, not the single-file rotation list.
const registeredLogFiles = new Set<string>();

/** Every absolute path registered by a static-filePath createNdjsonLogger instance. */
export function getRegisteredLogFiles(): ReadonlySet<string> {
	return registeredLogFiles;
}

/** Test-only reset — each test file gets a clean registry (see ndjson-logger.test.ts). */
export function _resetRegisteredLogFilesForTest(): void {
	registeredLogFiles.clear();
}

function registerExitFlusher(flushSync: () => void): void {
	exitFlushers.add(flushSync);
	if (!exitHandlerRegistered) {
		exitHandlerRegistered = true;
		process.on("exit", () => {
			for (const flush of exitFlushers) {
				try {
					flush();
				} catch {}
			}
		});
	}
}

export function createNdjsonLogger(options: NdjsonLoggerOptions): NdjsonLogger {
	if (typeof options.filePath === "string") {
		registeredLogFiles.add(options.filePath);
	}

	const queue: QueueItem[] = [];
	let drainPromise: Promise<void> | null = null;
	let inFlightBatch: QueueItem[] | null = null;
	let ensuredDir = false;

	function ensureDir(file: string): void {
		if (ensuredDir) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			ensuredDir = true;
		} catch {}
	}

	function rotateIfNeeded(file: string): void {
		if (options.maxBytes === undefined) return;
		try {
			const size = fs.statSync(file).size;
			if (size < options.maxBytes) return;
			const backup = options.backupPath
				? resolve(options.backupPath)
				: `${file}.1`;
			try {
				fs.rmSync(backup, { force: true });
			} catch {}
			fs.renameSync(file, backup);
		} catch {
			// no file yet, or rename raced — nothing to rotate
		}
	}

	async function drainLoop(): Promise<void> {
		// Peek, write, then remove — an item stays in the queue until it is on
		// disk, so a teardown flushSync (which abandons this async loop) never
		// drops an item this loop had already dequeued but not yet written.
		while (queue.length > 0) {
			const item = queue[0];
			const file = resolve(options.filePath);
			ensureDir(file);
			const truncateIndex =
				item.kind === "line"
					? queue.findIndex((queued) => queued.kind === "truncate")
					: 0;
			const pending =
				item.kind === "truncate"
					? [item]
					: queue.slice(
							0,
							truncateIndex === -1 ? queue.length : truncateIndex,
						);
			inFlightBatch = pending;
			try {
				if (item.kind === "truncate") {
					await fs.promises.writeFile(file, "");
				} else {
					rotateIfNeeded(file);
					await fs.promises.appendFile(
						file,
						pending
							.map(
								(queued) =>
									(queued as { kind: "line"; line: string }).line,
							)
							.join(""),
					);
				}
			} catch {
				// telemetry is best-effort
			}
			for (const written of pending) {
				// flushSync may have drained this prefix while the append was in
				// flight. Never remove newer items from a later enqueue.
				if (queue[0] !== written) break;
				queue.shift();
			}
			if (inFlightBatch === pending) inFlightBatch = null;
		}
	}

	function drain(): Promise<void> {
		// Serialize: a single in-flight drain owns the queue. flush() awaits this
		// same promise, so it never resolves before pending writes land. The loop
		// re-checks queue.length, so items enqueued mid-drain are picked up before
		// the promise settles — no stranded item, no second concurrent drainer.
		if (!drainPromise) {
			drainPromise = Promise.resolve().then(drainLoop).finally(() => {
				drainPromise = null;
			});
		}
		return drainPromise;
	}

	function enqueue(item: QueueItem): void {
		queue.push(item);
		void drain();
	}

	function flushSync(): void {
		// Drain the in-memory queue synchronously — safe at process exit.
		// The in-flight async batch is INCLUDED even though its appendFile may
		// also land: if the process dies before the threadpool issues that
		// write, skipping the prefix would drop the whole batch. The per-line
		// writer deliberately traded duplicate lines at exit for never-drops
		// (#935 review) — keep that trade. The drain-loop completion handler
		// only shifts items still at the queue head (identity-checked), so a
		// queue emptied here is simply left alone by the async loop.
		while (queue.length > 0) {
			const item = queue.shift() as QueueItem;
			const file = resolve(options.filePath);
			ensureDir(file);
			try {
				if (item.kind === "truncate") {
					fs.writeFileSync(file, "");
				} else {
					rotateIfNeeded(file);
					fs.appendFileSync(file, item.line);
				}
			} catch {}
		}
	}

	// Best-effort teardown flush of anything still buffered, via the single
	// shared exit handler. appendFileSync is fine here — not the hot path.
	registerExitFlusher(flushSync);

	return {
		log(obj: unknown): void {
			enqueue({ kind: "line", line: `${JSON.stringify(obj)}\n` });
		},
		append(line: string): void {
			enqueue({ kind: "line", line: `${line}\n` });
		},
		truncate(): void {
			enqueue({ kind: "truncate" });
		},
		async flush(): Promise<void> {
			await drain();
		},
		flushSync,
	};
}
