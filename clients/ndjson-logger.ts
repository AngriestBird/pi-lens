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
import { normalizeFilePath } from "./path-utils.js";
import { redactSecrets } from "./redact/secrets.js";

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
	/** Serialize `obj`, redact secrets, and enqueue one NDJSON line. */
	log(obj: unknown): void;
	/** Redact and enqueue a serialized line without a trailing newline. */
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

function runBestEffort(operation: () => void): void {
	try {
		operation();
	} catch {
		return;
	}
}

// One shared exit handler flushes every logger — avoids an EventEmitter
// MaxListeners warning once more than ~10 loggers exist (we ship eight, plus
// diagnostic + test instances). No child spawning at teardown (#234).
//
// Keep the registry on globalThis as well as in module state. Vitest can
// re-evaluate this module after vi.resetModules(), and pi can load the source
// and compiled entry through separate module graphs; a module-local guard then
// registers one process listener per graph and recreates the warning. Symbol.for
// gives those graphs one process-wide state without exposing a public global
// property name.
interface NdjsonWriterState {
	file: string;
	maxBytes?: number;
	backupPath?: string;
	queue: QueueItem[];
	drainPromise: Promise<void> | null;
	inFlightBatch: QueueItem[] | null;
	ensuredDir: boolean;
	/** One canonical exit flusher per file, never one per logger facade. */
	exitFlusher: () => void;
}

interface NdjsonGlobalState {
	writers: Map<string, NdjsonWriterState>;
	exitFlushers: Set<() => void>;
	exitHandlerRegistered: boolean;
	registeredLogFiles: Set<string>;
}

const NDJSON_GLOBAL_STATE_KEY = Symbol.for("pi-lens.ndjson-logger.state");
const globalStateHost = globalThis as typeof globalThis & {
	[key: symbol]: NdjsonGlobalState | undefined;
};
const existingGlobalState = globalStateHost[NDJSON_GLOBAL_STATE_KEY];
const ndjsonGlobalState =
	existingGlobalState ??
	(globalStateHost[NDJSON_GLOBAL_STATE_KEY] = {
		writers: new Map(),
		exitFlushers: new Set(),
		exitHandlerRegistered: false,
		registeredLogFiles: new Set(),
	});
// Keep any state created by an older module graph rather than replacing it.
// In particular, its already-registered exit handler must retain its flusher
// set so queued lines cannot disappear during a hot reload.
ndjsonGlobalState.writers ??= new Map();
ndjsonGlobalState.exitFlushers ??= new Set();
ndjsonGlobalState.registeredLogFiles ??= new Set();
const exitFlushers = ndjsonGlobalState.exitFlushers;
const registeredLogFiles = ndjsonGlobalState.registeredLogFiles;

/** Test-only view of the canonical per-file exit flushers (see ndjson-logger.test.ts). */
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
/** Every absolute path registered by a static-filePath createNdjsonLogger instance. */
export function getRegisteredLogFiles(): ReadonlySet<string> {
	return registeredLogFiles;
}

/** Test-only reset — each test file gets a clean registry (see ndjson-logger.test.ts). */
export function _resetRegisteredLogFilesForTest(): void {
	registeredLogFiles.clear();
}

function registerWriter(state: NdjsonWriterState): void {
	if (!exitFlushers.has(state.exitFlusher)) exitFlushers.add(state.exitFlusher);
	if (!ndjsonGlobalState.exitHandlerRegistered) {
		ndjsonGlobalState.exitHandlerRegistered = true;
		process.on("exit", () => {
			for (const flush of exitFlushers) runBestEffort(flush);
		});
	}
}

function normalizeLogPath(file: string): string {
	return normalizeFilePath(path.resolve(file));
}

function flushStateSync(state: NdjsonWriterState): void {
	// Drain the in-memory queue synchronously — safe at process exit.
	// The in-flight async batch is INCLUDED even though its appendFile may
	// also land: if the process dies before the threadpool issues that
	// write, skipping the prefix would drop the whole batch. The per-line
	// writer deliberately traded duplicate lines at exit for never-drops
	// (#935 review) — keep that trade. The drain-loop completion handler
	// only shifts items still at the queue head (identity-checked), so a
	// queue emptied here is simply left alone by the async loop.
	while (state.queue.length > 0) {
		const item = state.queue.shift() as QueueItem;
		ensureDir(state);
		runBestEffort(() => {
			if (item.kind === "truncate") {
				fs.writeFileSync(state.file, "");
			} else {
				rotateIfNeeded(state);
				fs.appendFileSync(state.file, item.line);
			}
		});
	}
}

function createWriterState(
	file: string,
	maxBytes?: number,
	backupPath?: string,
): NdjsonWriterState {
	const existing = ndjsonGlobalState.writers.get(file);
	if (existing) {
		// A partially initialized global state from another graph still needs to
		// be enrolled, but it must never get a second queue or exit flusher.
		if (!exitFlushers.has(existing.exitFlusher)) registerWriter(existing);
		return existing;
	}

	const state = {} as NdjsonWriterState;
	state.file = file;
	state.maxBytes = maxBytes;
	state.backupPath = backupPath;
	state.queue = [];
	state.drainPromise = null;
	state.inFlightBatch = null;
	state.ensuredDir = false;
	state.exitFlusher = () => flushStateSync(state);
	ndjsonGlobalState.writers.set(file, state);
	registerWriter(state);
	return state;
}

function ensureDir(state: NdjsonWriterState): void {
	if (state.ensuredDir) return;
	runBestEffort(() => {
		fs.mkdirSync(path.dirname(state.file), { recursive: true });
		state.ensuredDir = true;
	});
}

function rotateIfNeeded(state: NdjsonWriterState): void {
	if (state.maxBytes === undefined) return;
	try {
		const size = fs.statSync(state.file).size;
		if (size < state.maxBytes) return;
		const backup = state.backupPath ?? `${state.file}.1`;
		runBestEffort(() => fs.rmSync(backup, { force: true }));
		fs.renameSync(state.file, backup);
	} catch {
		// no file yet, or rename raced — nothing to rotate
	}
}

async function drainLoop(state: NdjsonWriterState): Promise<void> {
	// Peek, write, then remove — an item stays in the queue until it is on
	// disk, so a teardown flushSync (which abandons this async loop) never
	// drops an item this loop had already dequeued but not yet written.
	while (state.queue.length > 0) {
		const item = state.queue[0];
		ensureDir(state);
		const truncateIndex =
			item.kind === "line"
				? state.queue.findIndex((queued) => queued.kind === "truncate")
				: 0;
		const pendingEnd = truncateIndex === -1 ? state.queue.length : truncateIndex;
		const pending =
			item.kind === "truncate"
				? [item]
				: state.queue.slice(0, pendingEnd);
		state.inFlightBatch = pending;
		try {
			if (item.kind === "truncate") {
				await fs.promises.writeFile(state.file, "");
			} else {
				rotateIfNeeded(state);
				await fs.promises.appendFile(
					state.file,
					pending
						.map((queued) => (queued as { kind: "line"; line: string }).line)
						.join(""),
				);
			}
		} catch {
			// telemetry is best-effort
		}
		for (const written of pending) {
			// flushSync may have drained this prefix while the append is in
			// flight. Never remove newer items from a later enqueue.
			if (state.queue[0] !== written) break;
			state.queue.shift();
		}
		if (state.inFlightBatch === pending) state.inFlightBatch = null;
	}
}

function drain(state: NdjsonWriterState): Promise<void> {
	// Serialize: a single in-flight drain owns the canonical per-file queue.
	// This guard lives in global state, so module re-evaluation cannot create a
	// second drainer for the same path.
	if (!state.drainPromise) {
		state.drainPromise = Promise.resolve()
			.then(() => drainLoop(state))
			.finally(() => {
				state.drainPromise = null;
			});
	}
	return state.drainPromise;
}

export function createNdjsonLogger(options: NdjsonLoggerOptions): NdjsonLogger {
	const states = new Set<NdjsonWriterState>();

	function stateForCall(): NdjsonWriterState {
		const file = normalizeLogPath(resolve(options.filePath));
		const backupPath =
			options.maxBytes !== undefined && options.backupPath
				? normalizeLogPath(resolve(options.backupPath))
				: undefined;
		const state = createWriterState(file, options.maxBytes, backupPath);
		states.add(state);
		return state;
	}

	if (typeof options.filePath === "string") {
		const state = stateForCall();
		registeredLogFiles.add(state.file);
	}

	function enqueue(item: QueueItem): void {
		const state = stateForCall();
		state.queue.push(item);
		void drain(state);
	}

	return {
		log(obj: unknown): void {
			const serialized = String(JSON.stringify(obj));
			enqueue({
				kind: "line",
				line: `${redactSecrets(serialized)}\n`,
			});
		},
		append(line: string): void {
			enqueue({ kind: "line", line: `${redactSecrets(line)}\n` });
		},
		truncate(): void {
			enqueue({ kind: "truncate" });
		},
		async flush(): Promise<void> {
			await Promise.all([...states].map((state) => drain(state)));
		},
		flushSync(): void {
			for (const state of states) flushStateSync(state);
		},
	};
}
