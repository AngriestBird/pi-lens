/**
 * Warm side-channel for the push path. The MCP server is a long-lived process
 * with a warm LSP, but its stdio is owned by the MCP client — so the
 * PostToolUse-hook bin can't reach it that way. Instead the server listens on a
 * local IPC endpoint (Unix domain socket / Windows named pipe), and the hook
 * connects to it to get LSP-complete diagnostics from the warm process instead
 * of running its own cold analysis.
 *
 * This module is the CLIENT + the shared path derivation + the one-shot line
 * reader the server wires into its socket (deliberately light: node:net +
 * type-only result, so the bin can try the warm path WITHOUT loading the
 * dispatch graph). The analysis engine lives in mcp/server.ts. If the warm
 * path is unavailable, the client resolves `undefined` and the caller falls
 * back to cold local analysis.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { McpAnalyzeResult } from "./analyze.js";
import type { LSPCodeAction, LSPDiagnostic } from "../lsp/client.js";

export const WARM_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const WARM_CODE_ACTION_LOOKUP_LIMIT = 6;

/**
 * Stable per-workspace endpoint path. The server (from its launch cwd) and the
 * hook (from the PostToolUse cwd) must resolve the same path — both hash the
 * resolved root (lowercased for case-insensitive filesystems), so when they're
 * the same project they meet. Mismatch → the client just falls back to cold.
 */
export function ipcPathForCwd(cwd: string): string {
	const root = path.resolve(cwd).toLowerCase();
	// sha256 (not for security — just a stable short id for the IPC socket/pipe
	// name keyed by cwd; sha256 over sha1 keeps SonarCloud's weak-hash check quiet)
	const hash = crypto
		.createHash("sha256")
		.update(root)
		.digest("hex")
		.slice(0, 16);
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-lens-mcp-${hash}`;
	}
	return path.join(os.tmpdir(), `pi-lens-mcp-${hash}.sock`);
}

/** PID-scoped endpoint used by pi sessions. The legacy MCP analyze endpoint
 * remains workspace-scoped for compatibility with the PostToolUse hook. */
export function diagnosticsIpcPathForCwd(cwd: string, pid: number): string {
	const base = ipcPathForCwd(cwd);
	if (process.platform === "win32") return `${base}-diagnostics-${pid}`;
	return base.replace(/\.sock$/, `-diagnostics-${pid}.sock`);
}

export interface WarmDiagnosticsRequest {
	route: "diagnostics";
	version: number;
	file: string;
	cwd: string;
	content: string;
	contentHash: string;
	deadlineAt: number;
}

export interface WarmDiagnosticsResponse {
	route: "diagnostics";
	version: number;
	diagnostics: LSPDiagnostic[];
	contentHash: string;
	servedAt: number;
	fresh: boolean;
	inconclusive: boolean;
	/**
	 * #1253: the incumbent's `TouchFileResult.confirmation` — present only when
	 * that touch completed its configured diagnostics/confirmation policy (which
	 * includes the silent-clean gates a `silentOnClean` server like marksman
	 * depends on). `inconclusive: false` alone is NOT the same evidence, so the
	 * flag is carried explicitly rather than inferred. Optional: an incumbent
	 * built before this field simply omits it, and the consumer then falls back
	 * to today's unconfirmed handling.
	 */
	confirmation?: "confirmed";
}

export interface WarmCodeActionRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface WarmCodeActionsRequest {
	route: "code-actions";
	version: number;
	file: string;
	cwd: string;
	contentHash: string;
	ranges: WarmCodeActionRange[];
	deadlineAt: number;
}

export interface WarmCodeActionsResponse {
	route: "code-actions";
	version: number;
	contentHash: string;
	servedAt: number;
	actions: LSPCodeAction[][];
}

export type WarmCodeActionsResult =
	| { available: true; response: WarmCodeActionsResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

export type WarmDiagnosticsFailureReason =
	| "timeout"
	| "ipc-error"
	| "schema-mismatch"
	| "stale-answer";

export type WarmDiagnosticsResult =
	| { available: true; response: WarmDiagnosticsResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

export function contentHash(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

type WarmIpcOutcome<TResponse> =
	| { available: true; response: TResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

/**
 * Shared one-shot request/response transport for the warm-attach IPC routes
 * (#822): connect to the incumbent's PID-scoped endpoint, write one JSON
 * line, read one JSON line back, classify. The per-route `validate` callback
 * returns a failure reason for an on-time but unusable reply (schema skew,
 * staleness) or `undefined` to accept it; transport failures map uniformly to
 * timeout/ipc-error. One transport, N routes — the diagnostics and
 * code-action clients cannot drift apart.
 */
function requestOverWarmIpc<TResponse>(
	cwd: string,
	incumbentPid: number,
	timeoutMs: number,
	buildRequest: (deadlineAt: number) => unknown,
	validate: (
		result: TResponse,
		deadlineAt: number,
	) => WarmDiagnosticsFailureReason | undefined,
): Promise<WarmIpcOutcome<TResponse>> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: WarmIpcOutcome<TResponse>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const deadlineAt = Date.now() + timeoutMs;
		const socket = net.createConnection(
			diagnosticsIpcPathForCwd(cwd, incumbentPid),
		);
		socket.setEncoding("utf8");
		let buffer = "";
		const timer = setTimeout(
			() => finish({ available: false, reason: "timeout" }),
			timeoutMs,
		);
		timer.unref();
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(buildRequest(deadlineAt))}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const message = JSON.parse(buffer.slice(0, newline)) as {
					result?: TResponse;
					error?: string;
				};
				const result = message.result;
				if (message.error || !result) {
					finish({ available: false, reason: "ipc-error" });
					return;
				}
				const reason = validate(result, deadlineAt);
				if (reason === undefined) {
					finish({ available: true, response: result });
				} else {
					finish({ available: false, reason });
				}
			} catch {
				finish({ available: false, reason: "schema-mismatch" });
			}
		});
		socket.on("error", () =>
			finish({ available: false, reason: "ipc-error" }),
		);
		socket.on("close", () =>
			finish({ available: false, reason: "ipc-error" }),
		);
	});
}

export function requestWarmDiagnostics(
	cwd: string,
	incumbentPid: number,
	file: string,
	content: string,
	timeoutMs: number,
): Promise<WarmDiagnosticsResult> {
	const expectedHash = contentHash(content);
	return requestOverWarmIpc<WarmDiagnosticsResponse>(
		cwd,
		incumbentPid,
		timeoutMs,
		(deadlineAt): WarmDiagnosticsRequest => ({
			route: "diagnostics",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			file,
			cwd,
			content,
			contentHash: expectedHash,
			deadlineAt,
		}),
		(result, deadlineAt) => {
			if (
				result.route !== "diagnostics" ||
				result.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION
			) {
				return "schema-mismatch";
			}
			if (
				!result.fresh ||
				result.inconclusive ||
				result.contentHash !== expectedHash ||
				result.servedAt > deadlineAt
			) {
				return "stale-answer";
			}
			return undefined;
		},
	);
}

export function requestWarmCodeActions(
	cwd: string,
	incumbentPid: number,
	file: string,
	expectedContentHash: string,
	ranges: WarmCodeActionRange[],
	timeoutMs: number,
): Promise<WarmCodeActionsResult> {
	return requestOverWarmIpc<WarmCodeActionsResponse>(
		cwd,
		incumbentPid,
		timeoutMs,
		(deadlineAt): WarmCodeActionsRequest => ({
			route: "code-actions",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			file,
			cwd,
			contentHash: expectedContentHash,
			ranges,
			deadlineAt,
		}),
		(result, deadlineAt) => {
			if (
				result.route !== "code-actions" ||
				result.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION ||
				!Array.isArray(result.actions) ||
				result.actions.length !== ranges.length ||
				result.actions.some((actions) => !Array.isArray(actions))
			) {
				return "schema-mismatch";
			}
			if (
				result.contentHash !== expectedContentHash ||
				result.servedAt > deadlineAt
			) {
				return "stale-answer";
			}
			return undefined;
		},
	);
}

/** One IPC request: analyze a file in the warm server process. */
export interface WarmAnalyzeRequest {
	file: string;
	cwd: string;
}

/**
 * Ask the warm server to analyze a file. Resolves the server's result, or
 * `undefined` on ANY failure (no server, refused, stale socket, timeout, bad
 * response) so the caller transparently falls back to cold local analysis.
 */
export function requestWarmAnalyze(
	cwd: string,
	file: string,
	timeoutMs = 30_000,
): Promise<McpAnalyzeResult | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: McpAnalyzeResult | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const socket = net.createConnection(ipcPathForCwd(cwd));
		socket.setEncoding("utf8");
		let buffer = "";

		const timer = setTimeout(() => {
			socket.destroy();
			finish(undefined);
		}, timeoutMs);
		timer.unref();

		socket.on("connect", () => {
			const request: WarmAnalyzeRequest = { file, cwd };
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const message = JSON.parse(buffer.slice(0, newline)) as {
					result?: McpAnalyzeResult;
					error?: string;
				};
				finish(message.error ? undefined : message.result);
			} catch {
				finish(undefined);
			}
			socket.end();
		});
		// No server / connection refused / reset → cold fallback.
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
	});
}

/**
 * One-shot line reader for the warm IPC socket (#1219). The clients write
 * exactly one newline-terminated request per connection and read one reply, so
 * the server must dispatch at most one line and ignore anything after it — a
 * `data` handler that keeps re-reading the same buffered line re-dispatches
 * the request on stray bytes. Returns the handler to attach to the socket's
 * `data` event.
 */
export function createWarmIpcLineReader(
	onLine: (line: string) => void,
): (chunk: string) => void {
	let buffer = "";
	let dispatched = false;
	return (chunk: string) => {
		if (dispatched) return;
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		dispatched = true;
		onLine(buffer.slice(0, newline));
	};
}
