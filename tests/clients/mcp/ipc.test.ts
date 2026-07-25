/**
 * Warm side-channel client: path derivation, the request/response round-trip
 * against a stub server, and graceful "no server → undefined" fallback. Uses a
 * real net.Server stub on the derived endpoint (named pipe on Windows, Unix
 * socket on POSIX) — no real LSP.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpAnalyzeResult } from "../../../clients/mcp/analyze.js";
import {
	contentHash,
	diagnosticsIpcPathForCwd,
	ipcPathForCwd,
	requestWarmDiagnostics,
	requestWarmAnalyze,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "../../../clients/mcp/ipc.js";
import { removeTempDirSync } from "../test-utils.js";

const SENTINEL = {
	filePath: "/x/app.ts",
	cwd: "/x",
	fileKind: "jsts",
	durationMs: 7,
	hasBlockers: false,
	counts: { diagnostics: 0, blockers: 0, warnings: 0, fixed: 0 },
	diagnostics: [],
} as unknown as McpAnalyzeResult;

let activeServer: net.Server | undefined;

afterEach(() => {
	if (activeServer) {
		(
			activeServer as net.Server & { closeAllConnections?: () => void }
		).closeAllConnections?.();
		activeServer.close();
		activeServer = undefined;
	}
});

describe("requestWarmDiagnostics", () => {
	it("round-trips a versioned, content-bound response", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-diag-"));
		const pid = 99001;
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as { contentHash: string };
				socket.end(
					`${JSON.stringify({
						result: {
							route: "diagnostics",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
							diagnostics: [],
							contentHash: request.contentHash,
							servedAt: Date.now(),
							fresh: true,
							inconclusive: false,
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(diagnosticsIpcPathForCwd(cwd, pid), resolve),
		);
		const result = await requestWarmDiagnostics(
			cwd,
			pid,
			"/x/app.ts",
			"const x = 1;",
			1000,
		);
		expect(result.available).toBe(true);
		expect(result.available && result.response.contentHash).toBe(
			contentHash("const x = 1;"),
		);
		removeTempDirSync(cwd);
	});

	it("rejects schema skew and fails open on errors", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-skew-"));
		const pid = 99002;
		activeServer = net.createServer((socket) => {
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "diagnostics",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION + 1,
						},
					})}\n`,
				),
			);
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(diagnosticsIpcPathForCwd(cwd, pid), resolve),
		);
		await expect(
			requestWarmDiagnostics(cwd, pid, "/x/app.ts", "x", 1000),
		).resolves.toEqual({ available: false, reason: "schema-mismatch" });
		removeTempDirSync(cwd);
	});

	it("fails open when the incumbent misses the deadline", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-timeout-"));
		const pid = 99003;
		activeServer = net.createServer(() => {
			// Deliberately leave the request unanswered.
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(diagnosticsIpcPathForCwd(cwd, pid), resolve),
		);
		await expect(
			requestWarmDiagnostics(cwd, pid, "/x/app.ts", "x", 20),
		).resolves.toEqual({ available: false, reason: "timeout" });
		removeTempDirSync(cwd);
	});
});

describe("ipcPathForCwd", () => {
	it("is stable for the same cwd and differs across cwds", () => {
		expect(ipcPathForCwd("/a/b")).toBe(ipcPathForCwd("/a/b"));
		expect(ipcPathForCwd("/a/b")).not.toBe(ipcPathForCwd("/a/c"));
	});

	it("uses the platform-appropriate endpoint form", () => {
		const p = ipcPathForCwd(process.cwd());
		if (process.platform === "win32") {
			expect(p.startsWith("\\\\.\\pipe\\pi-lens-mcp-")).toBe(true);
		} else {
			expect(p.endsWith(".sock")).toBe(true);
		}
	});
});

describe("requestWarmAnalyze", () => {
	it("round-trips the request and returns the server's result", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-"));
		const endpoint = ipcPathForCwd(cwd);
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(endpoint);
			} catch {
				/* none */
			}
		}

		let received: unknown;
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const nl = buffer.indexOf("\n");
				if (nl === -1) return;
				received = JSON.parse(buffer.slice(0, nl));
				socket.end(`${JSON.stringify({ result: SENTINEL })}\n`);
			});
		});
		await new Promise<void>((resolve) => activeServer?.listen(endpoint, resolve));

		const result = await requestWarmAnalyze(cwd, "/x/app.ts");
		expect(result).toEqual(SENTINEL);
		expect(received).toEqual({ file: "/x/app.ts", cwd });

		removeTempDirSync(cwd);
	});

	it("resolves undefined when no server is listening (cold fallback)", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-none-"));
		const result = await requestWarmAnalyze(cwd, "/x/app.ts", 2000);
		expect(result).toBeUndefined();
		removeTempDirSync(cwd);
	});

	it("resolves undefined when the server returns an error", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-err-"));
		const endpoint = ipcPathForCwd(cwd);
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(endpoint);
			} catch {
				/* none */
			}
		}
		activeServer = net.createServer((socket) => {
			socket.on("data", () => socket.end(`${JSON.stringify({ error: "boom" })}\n`));
		});
		await new Promise<void>((resolve) => activeServer?.listen(endpoint, resolve));

		const result = await requestWarmAnalyze(cwd, "/x/app.ts");
		expect(result).toBeUndefined();
		removeTempDirSync(cwd);
	});
});
