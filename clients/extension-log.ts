/**
 * Terminal-safe diagnostic sink for the in-pi extension path (#1333).
 *
 * pi owns the terminal: it runs the TTY in raw mode and repaints with
 * cursor-addressed diffs, so ANY byte an extension writes to stdout/stderr
 * lands mid-frame and desyncs pi's model of the screen — the layout stays
 * broken until a full repaint. `clients/`, `tools/`, `index.ts` and `i18n.ts`
 * are all reachable from the extension entry, so none of them may call
 * `console.*` or `process.std*.write`. (`mcp/`, `scripts/` and `bin/` DO own
 * their stdout contract and keep their writes.)
 *
 * This module is the general-purpose replacement sink: one `createNdjsonLogger`
 * instance over `<global pi-lens dir>/extension.log`, per the single-writer
 * invariant in AGENTS.md. Subsystems that already own a log (tree-sitter,
 * review-graph, cascade, latency, sessionstart) route to THAT log instead —
 * this file is for the areas that had no sink at all.
 *
 * Three-channels rule (#482/#484/#485): everything written here is
 * LOG-audience. A genuinely user-facing degradation must ALSO reach the human
 * through the host's own render path (`ctx.ui.notify` / a display-only session
 * entry) — never a raw write.
 */

import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

export const EXTENSION_LOG_FILE = path.join(
	getGlobalPiLensDir(),
	"extension.log",
);

const writer = createNdjsonLogger({
	filePath: EXTENSION_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

/**
 * `error`/`warn` mirror the console methods they replaced; `debug` is the level
 * the previously verbose-gated client loggers write at (the gate is preserved
 * at the call site — see `createSubsystemLogger`).
 */
export type ExtensionLogLevel = "error" | "warn" | "debug";

export interface ExtensionLogEntry {
	/** Owning area, e.g. `dispatch`, `format`, `lens-config`. */
	subsystem: string;
	message: string;
	/** Defaults to `error` (the level every migrated ungated site wrote at). */
	level?: ExtensionLogLevel;
	metadata?: Record<string, unknown>;
}

export function logExtension(entry: ExtensionLogEntry): void {
	if (isTestMode()) return;
	writer.log({
		ts: new Date().toISOString(),
		pid: process.pid,
		level: entry.level ?? "error",
		subsystem: entry.subsystem,
		message: entry.message,
		...(entry.metadata ? { metadata: entry.metadata } : {}),
	});
}

/**
 * Drop-in replacement for the `verbose ? (msg) => console.error(...) : () => {}`
 * shape that ~20 clients hand-rolled. The returned value is CALLABLE (so the
 * `this.log = createSubsystemLogger("ruff")` migration is a one-line swap) and
 * also carries explicit `error`/`warn`/`debug` methods.
 *
 * Gating stays at the call site: `verbose ? createSubsystemLogger(x) : noop`
 * keeps the exact same "written only when verbose" semantics — what changed is
 * the SINK, not the gate, so turning verbose on can never corrupt the frame.
 */
export interface SubsystemLogger {
	(message: string, metadata?: Record<string, unknown>): void;
	error(message: string, metadata?: Record<string, unknown>): void;
	warn(message: string, metadata?: Record<string, unknown>): void;
	debug(message: string, metadata?: Record<string, unknown>): void;
}

export function createSubsystemLogger(
	subsystem: string,
	defaultLevel: ExtensionLogLevel = "debug",
): SubsystemLogger {
	const at =
		(level: ExtensionLogLevel) =>
		(message: string, metadata?: Record<string, unknown>): void => {
			logExtension({ subsystem, message, level, metadata });
		};
	const logger = at(defaultLevel) as SubsystemLogger;
	logger.error = at("error");
	logger.warn = at("warn");
	logger.debug = at("debug");
	return logger;
}

/** No-op with the `SubsystemLogger` shape, for the verbose-off branch. */
export function noopSubsystemLogger(): SubsystemLogger {
	const noop = (() => {}) as unknown as SubsystemLogger;
	noop.error = () => {};
	noop.warn = () => {};
	noop.debug = () => {};
	return noop;
}

export function getExtensionLogPath(): string {
	return EXTENSION_LOG_FILE;
}

/** Resolve once all enqueued extension-log writes are on disk (tests/shutdown). */
export function flushExtensionLog(): Promise<void> {
	return writer.flush();
}

/** Teardown-only: force queued entries to disk before the process exits. */
export function flushExtensionLogSync(): void {
	writer.flushSync();
}

// --- Defense in depth: the console reroute -----------------------------------

const CONSOLE_METHODS = [
	"log",
	"info",
	"warn",
	"error",
	"debug",
	"trace",
	"dir",
] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

let consoleGuardInstalled = false;

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			if (arg instanceof Error) return arg.stack ?? arg.message;
			try {
				return JSON.stringify(arg) ?? String(arg);
			} catch {
				return String(arg);
			}
		})
		.join(" ");
}

/**
 * Patch every console method on the extension entry path so a transitively
 * loaded dependency cannot write raw bytes into pi's frame — the pi-side
 * mirror of `mcp/server.ts`'s `console.log = console.error` guard, which
 * protects the JSON-RPC stdout channel for the same structural reason.
 *
 * This is a NET, not the fix: pi-lens's own sites are migrated to real sinks
 * with real schemas. Idempotent, and inert under test mode (vitest owns the
 * console) and under `PI_LENS_CONSOLE_GUARD=0`.
 *
 * Returns true when the patch was applied by this call.
 */
export function installConsoleGuard(): boolean {
	if (consoleGuardInstalled) return false;
	if (isTestMode()) return false;
	if (process.env.PI_LENS_CONSOLE_GUARD === "0") return false;
	consoleGuardInstalled = true;
	const target = console as unknown as Record<ConsoleMethod, unknown>;
	for (const method of CONSOLE_METHODS) {
		if (typeof target[method] !== "function") continue;
		target[method] = (...args: unknown[]): void => {
			logExtension({
				subsystem: "console",
				level:
					method === "warn" ? "warn" : method === "error" ? "error" : "debug",
				message: formatConsoleArgs(args),
				metadata: { method },
			});
		};
	}
	return true;
}

/** Test-only: forget that the guard was installed. */
export function _resetConsoleGuardForTests(): void {
	consoleGuardInstalled = false;
}
