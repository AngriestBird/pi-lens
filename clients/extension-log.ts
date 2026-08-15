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

import { AsyncLocalStorage } from "node:async_hooks";
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

type ConsoleFn = (...args: unknown[]) => void;

let consoleGuardInstalled = false;
/** The console methods captured before the patch, for an exact restore. */
const originalConsoleMethods = new Map<ConsoleMethod, ConsoleFn>();
/** The replacements this module installed, so uninstall never clobbers a later patch. */
const installedConsoleMethods = new Map<ConsoleMethod, ConsoleFn>();

/**
 * The async capture window (#1434).
 *
 * The guard must catch pi-lens's own writes without swallowing the host's. pi's
 * one-shot CLI commands print through `console.log`, so a permanent global
 * reroute makes `pi list` print nothing in any project whose cwd loads the
 * extension first. The store answers "is pi-lens executing right now?" and
 * `AsyncLocalStorage` carries that answer into every promise, timer and
 * callback created inside the window — so an async handler still captures after
 * an `await`, while host code outside the window keeps its real sink.
 */
const consoleCaptureStorage = new AsyncLocalStorage<true>();

/**
 * Module evaluation is the one window `AsyncLocalStorage` cannot wrap: the
 * module graph is evaluated by the loader, not by a pi-lens call. It is
 * synchronous, so a plain flag is enough (#1333's original concern — a
 * transitively loaded dependency writing during its own init).
 */
let moduleLoadWindowOpen = false;

/** True while pi-lens owns execution, so console writes belong in the log. */
export function isConsoleCaptureActive(): boolean {
	return moduleLoadWindowOpen || consoleCaptureStorage.getStore() === true;
}

/**
 * Open the module-evaluation window. Called by `clients/console-guard-install.ts`
 * before any other pi-lens module evaluates.
 *
 * The window closes explicitly at the end of `index.ts`. The backstop below
 * closes it anyway if that never runs (an import throws, or the entry changes
 * shape), because a leaked window would capture the host's output — the very
 * bug this design fixes. Module evaluation is synchronous, so the end of the
 * current macrotask is always past it. The timer is unref'd, so it can never
 * hold a one-shot CLI process open (defect shape 4).
 */
export function openModuleLoadConsoleWindow(): void {
	if (moduleLoadWindowOpen) return;
	moduleLoadWindowOpen = true;
	const backstop = setImmediate(() => {
		moduleLoadWindowOpen = false;
	});
	backstop.unref?.();
}

/** Close the module-evaluation window. Idempotent. */
export function closeModuleLoadConsoleWindow(): void {
	moduleLoadWindowOpen = false;
}

/**
 * Run `fn` inside a capture window. Console writes from `fn`, and from anything
 * `fn` schedules, go to the extension log instead of the terminal.
 */
export function runInConsoleCaptureWindow<T>(fn: () => T): T {
	return consoleCaptureStorage.run(true, fn);
}

function inCaptureWindow<T extends ConsoleFn | ((...args: never[]) => unknown)>(
	fn: T,
): T {
	return function (this: unknown, ...args: unknown[]): unknown {
		return runInConsoleCaptureWindow(() =>
			(fn as (...a: unknown[]) => unknown).apply(this, args),
		);
	} as unknown as T;
}

/**
 * Wrap the host extension API so every pi-lens entry point runs in a capture
 * window.
 *
 * pi calls our event handlers and tool bodies from its own async context, so a
 * window opened during registration does not reach them. Wrapping the two
 * registration seams — `on` and `registerTool` — covers every current and
 * future handler from one place, instead of a hand-maintained list of call
 * sites. Everything else forwards untouched.
 */
export function withConsoleCaptureWindows<T extends object>(api: T): T {
	const proxy: T = new Proxy(api, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			const method = value as (...args: unknown[]) => unknown;
			// A host that returns `this` for chaining would hand back the raw API,
			// so a chained `on(...).on(...)` would register an unwrapped handler.
			// Keep the proxy on the chain.
			const keepProxy = (result: unknown): unknown =>
				result === target ? proxy : result;
			if (prop === "on") {
				return (...args: unknown[]): unknown => {
					const wrapped = args.map((arg) =>
						typeof arg === "function" ? inCaptureWindow(arg as ConsoleFn) : arg,
					);
					return keepProxy(method.apply(target, wrapped));
				};
			}
			if (prop === "registerTool") {
				return (...args: unknown[]): unknown => {
					const tool = args[0] as { execute?: unknown } | undefined;
					// Mutate in place: a spread copy would drop non-enumerable or
					// prototype-carried members of the tool definition (defect shape 5).
					// These tool objects are pi-lens's own, built just above the call.
					if (tool && typeof tool.execute === "function") {
						tool.execute = inCaptureWindow(
							tool.execute as (...a: never[]) => unknown,
						);
					}
					return keepProxy(method.apply(target, args));
				};
			}
			return value;
		},
	});
	return proxy;
}

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
 * The patch is a DISPATCHER, not a permanent reroute (#1434). It sends a write
 * to the extension log only while pi-lens owns execution; every other write
 * goes to the original console method. pi's own one-shot CLI commands print
 * through `console.log`, so an unconditional reroute silenced them: `pi list`
 * exited 0 with no output in any project whose cwd loaded the extension first.
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
		const original = target[method];
		if (typeof original !== "function") continue;
		const originalFn = original as ConsoleFn;
		originalConsoleMethods.set(method, originalFn);
		const replacement: ConsoleFn = (...args: unknown[]): void => {
			if (!isConsoleCaptureActive()) {
				originalFn.apply(console, args);
				return;
			}
			logExtension({
				subsystem: "console",
				level:
					method === "warn" ? "warn" : method === "error" ? "error" : "debug",
				message: formatConsoleArgs(args),
				metadata: { method },
			});
		};
		installedConsoleMethods.set(method, replacement);
		target[method] = replacement;
	}
	return true;
}

/**
 * Restore the exact console methods captured at install time.
 *
 * A method someone else patched after us is left alone — restoring it would
 * clobber their replacement. Returns true when this call uninstalled.
 */
export function uninstallConsoleGuard(): boolean {
	if (!consoleGuardInstalled) return false;
	consoleGuardInstalled = false;
	const target = console as unknown as Record<ConsoleMethod, unknown>;
	for (const [method, original] of originalConsoleMethods) {
		if (target[method] === installedConsoleMethods.get(method)) {
			target[method] = original;
		}
	}
	originalConsoleMethods.clear();
	installedConsoleMethods.clear();
	return true;
}

/** Test-only: uninstall the guard and close every open capture window. */
export function _resetConsoleGuardForTests(): void {
	uninstallConsoleGuard();
	consoleGuardInstalled = false;
	moduleLoadWindowOpen = false;
}
