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
	createWarmIpcLineReader,
	createWarmIpcRequestQueue,
	diagnosticsIpcPathForCwd,
	ipcPathForCwd,
	readTurnEndStatus,
	recordTurnEndOutcome,
	requestWarmCodeActions,
	requestWarmDiagnostics,
	requestWarmAnalyze,
	requestWarmTurnEnd,
	turnEndStatusPathForCwd,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
	WARM_TURN_END_SCHEMA_VERSION,
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

	// #1108 shape-5 (side-channel copy-loss). `inconclusive` rides the touchFile
	// result as a NON-enumerable side-channel; it CANNOT survive the IPC socket's
	// JSON round-trip on the diagnostics array. warm-attach re-surfaces it as an
	// EXPLICIT enumerable response field precisely so the flag crosses the boundary
	// intact — this guards that the client consumer still HONORS it (an inconclusive
	// answer is not a confirmed clean, #571/#1093). Fail-then-pass: drop the
	// `result.inconclusive` disqualifier in ipc.ts and this passes an inconclusive
	// answer through as available.
	it("rejects an inconclusive answer carried as an enumerable IPC field", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-inconc-"));
		const pid = 99011;
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
							inconclusive: true,
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(diagnosticsIpcPathForCwd(cwd, pid), resolve),
		);
		await expect(
			requestWarmDiagnostics(cwd, pid, "/x/app.ts", "const x = 1;", 1000),
		).resolves.toEqual({ available: false, reason: "stale-answer" });
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

describe("requestWarmCodeActions", () => {
	it("round-trips versioned code actions bound to the diagnostics hash", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-actions-"));
		const pid = 99004;
		const expectedHash = contentHash("const x = 1;");
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as {
					route: string;
					contentHash: string;
					ranges: unknown[];
				};
				expect(request.route).toBe("code-actions");
				expect(request.ranges).toHaveLength(1);
				socket.end(
					`${JSON.stringify({
						result: {
							route: "code-actions",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
							contentHash: request.contentHash,
							servedAt: Date.now(),
							actions: [[{ title: "Fix it", kind: "quickfix" }]],
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(diagnosticsIpcPathForCwd(cwd, pid), resolve),
		);
		const result = await requestWarmCodeActions(
			cwd,
			pid,
			"/x/app.ts",
			expectedHash,
			[
				{
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			],
			1000,
		);
		expect(result.available).toBe(true);
		expect(result.available && result.response.actions[0]?.[0]?.title).toBe(
			"Fix it",
		);
		removeTempDirSync(cwd);
	});

	it("rejects code-action schema skew", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-actions-skew-"),
		);
		const pid = 99005;
		activeServer = net.createServer((socket) => {
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "code-actions",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION + 1,
							actions: [],
						},
					})}\n`,
				),
			);
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(diagnosticsIpcPathForCwd(cwd, pid), resolve),
		);
		await expect(
			requestWarmCodeActions(cwd, pid, "/x/app.ts", "hash", [], 1000),
		).resolves.toEqual({ available: false, reason: "schema-mismatch" });
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

// --- #3255: the case axis of the workspace rendezvous id --------------------
//
// Recurrence these cases prevent: `workspaceHash` lowercased its input
// UNCONDITIONALLY, so on a case-sensitive host `/repo/Alpha` and `/repo/alpha`
// — two different directories — derived ONE warm-IPC socket, one pid-scoped
// diagnostics socket and one `pi-lens-turn-end-<hash>.json`. A PostToolUse or
// Stop hook in one workspace then reached the other workspace's warm server
// and its turn-end counters. The fold must survive on the platforms whose
// filesystem folds case (win32, darwin), where the two spellings are ONE
// directory and the server's `--cwd=` spelling can legitimately differ from
// the hook payload's.

/** The 16 hex characters every per-workspace name embeds. */
function workspaceIdIn(derivedPath: string): string {
	const found = /pi-lens-(?:mcp|turn-end)-([0-9a-f]{16})/.exec(derivedPath);
	if (!found) throw new Error(`no workspace id in ${derivedPath}`);
	return found[1];
}

/**
 * MEASURED, not asserted: create one directory and ask the filesystem whether
 * the other spelling already exists. The sibling fixture in the cases below is
 * created only after this says the host really keeps the two apart, so the
 * skip can never be an `EEXIST` waiting to happen on someone's APFS box.
 */
const TMPDIR_IS_CASE_SENSITIVE = (() => {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-Case-"));
	try {
		return !fs.existsSync(
			probe.replace("pi-lens-ipc-Case-", "pi-lens-ipc-case-"),
		);
	} finally {
		removeTempDirSync(probe);
	}
})();

/** Sibling of `dir` differing ONLY in the case of the fixture prefix. */
function caseVariantSibling(dir: string, prefix: string): string {
	const sibling = dir.replace(prefix, prefix.toLowerCase());
	expect(sibling).not.toBe(dir);
	fs.mkdirSync(sibling);
	return sibling;
}

// lane: Unit tests (ubuntu) — and any other case-sensitive host. Skipped on a
// case-insensitive filesystem because there the two spellings ARE one
// directory, so there is no second workspace to keep apart.
describe.skipIf(!TMPDIR_IS_CASE_SENSITIVE)(
	"case-distinct workspaces on a case-sensitive host (#3255)",
	() => {
		it("does not serve one workspace's warm analysis to its case-variant sibling", async () => {
			const served = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-ipc-Leak-"),
			);
			const sibling = caseVariantSibling(served, "pi-lens-ipc-Leak-");
			try {
				await listenOnWorkspaceEndpoint(served, (socket) => {
					socket.setEncoding("utf8");
					socket.once("data", () =>
						socket.end(`${JSON.stringify({ result: SENTINEL })}\n`),
					);
				});

				// Control: the stub really is reachable from the workspace it serves.
				await expect(
					requestWarmAnalyze(served, "/x/app.ts", 2000),
				).resolves.toEqual(SENTINEL);

				// The defect: the sibling workspace must NOT reach that server. Cold
				// fallback (`undefined`) is the correct answer for a workspace with no
				// warm server of its own.
				await expect(
					requestWarmAnalyze(sibling, "/x/app.ts", 2000),
				).resolves.toBeUndefined();
			} finally {
				removeTempDirSync(sibling);
				removeTempDirSync(served);
			}
		});

		it("does not merge two case-variant workspaces into one turn-end status file", () => {
			const recorded = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-ipc-Turnstat-"),
			);
			const sibling = caseVariantSibling(recorded, "pi-lens-ipc-Turnstat-");
			try {
				recordTurnEndOutcome(recorded, { ran: true });

				// Control: the writer's own workspace reads its own counters back.
				expect(readTurnEndStatus(recorded)).toMatchObject({ ran: 1 });

				// The defect: `pilens_health` for the sibling reported the other
				// workspace's turn-end activity under its own name.
				expect(readTurnEndStatus(sibling)).toBeUndefined();
			} finally {
				fs.rmSync(turnEndStatusPathForCwd(recorded), { force: true });
				fs.rmSync(turnEndStatusPathForCwd(sibling), { force: true });
				removeTempDirSync(sibling);
				removeTempDirSync(recorded);
			}
		});
	},
);

// Platform is an injected ARGUMENT (the seam `normalizePathEntry` uses in
// clients/lsp/launch.ts), so every arm below runs on every lane — no
// `skipIf(process.platform …)` and no Windows-only assertion.
describe("workspace id under an injected platform (#3255)", () => {
	const ALPHA = "/repo/Alpha";
	const LOWER = "/repo/alpha";

	// Case-INSENSITIVE by default: the two spellings name one directory, so
	// folding is what makes the server and the hook meet.
	it.each<NodeJS.Platform>(["win32", "darwin"])(
		"folds case on %s, where the filesystem folds it",
		(platform) => {
			expect(ipcPathForCwd(ALPHA, platform)).toBe(
				ipcPathForCwd(LOWER, platform),
			);
			expect(turnEndStatusPathForCwd(ALPHA, platform)).toBe(
				turnEndStatusPathForCwd(LOWER, platform),
			);
			expect(diagnosticsIpcPathForCwd(ALPHA, 4242, platform)).toBe(
				diagnosticsIpcPathForCwd(LOWER, 4242, platform),
			);
		},
	);

	// Case-SENSITIVE: two spellings are two directories and must not collide.
	it.each<NodeJS.Platform>(["linux", "freebsd"])(
		"keeps case on %s, where the filesystem keeps it",
		(platform) => {
			expect(ipcPathForCwd(ALPHA, platform)).not.toBe(
				ipcPathForCwd(LOWER, platform),
			);
			expect(turnEndStatusPathForCwd(ALPHA, platform)).not.toBe(
				turnEndStatusPathForCwd(LOWER, platform),
			);
			expect(diagnosticsIpcPathForCwd(ALPHA, 4242, platform)).not.toBe(
				diagnosticsIpcPathForCwd(LOWER, 4242, platform),
			);
		},
	);

	// The four derivation sites of the table in PR #3257 / the `workspaceHash`
	// doc comment: every per-workspace name must carry the SAME id, or a future
	// edit to one of them splits the rendezvous silently.
	it.each<NodeJS.Platform>(["win32", "darwin", "linux"])(
		"gives every per-workspace name the same id on %s",
		(platform) => {
			const ids = [
				workspaceIdIn(ipcPathForCwd(ALPHA, platform)),
				workspaceIdIn(diagnosticsIpcPathForCwd(ALPHA, 4242, platform)),
				workspaceIdIn(turnEndStatusPathForCwd(ALPHA, platform)),
			];
			expect(new Set(ids).size).toBe(1);
		},
	);

	it.each<[NodeJS.Platform, boolean]>([
		["win32", true],
		["linux", false],
		["darwin", false],
	])(
		"uses the %s endpoint form for the injected platform",
		(platform, pipe) => {
			const endpoint = ipcPathForCwd(ALPHA, platform);
			expect(endpoint.startsWith("\\\\.\\pipe\\pi-lens-mcp-")).toBe(pipe);
			expect(endpoint.endsWith(".sock")).toBe(!pipe);
			expect(
				diagnosticsIpcPathForCwd(ALPHA, 4242, platform).endsWith(
					pipe ? "-diagnostics-4242" : "-diagnostics-4242.sock",
				),
			).toBe(true);
		},
	);
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
		await new Promise<void>((resolve) =>
			activeServer?.listen(endpoint, resolve),
		);

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
			socket.on("data", () =>
				socket.end(`${JSON.stringify({ error: "boom" })}\n`),
			);
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(endpoint, resolve),
		);

		const result = await requestWarmAnalyze(cwd, "/x/app.ts");
		expect(result).toBeUndefined();
		removeTempDirSync(cwd);
	});
});

function listenOnWorkspaceEndpoint(
	cwd: string,
	handler: (socket: net.Socket) => void,
): Promise<string> {
	const endpoint = ipcPathForCwd(cwd);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			/* none */
		}
	}
	activeServer = net.createServer(handler);
	return new Promise<string>((resolve) =>
		activeServer?.listen(endpoint, () => resolve(endpoint)),
	);
}

describe("requestWarmTurnEnd", () => {
	it("round-trips a versioned turn-end response over the workspace endpoint", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-turn-"));
		let received: unknown;
		let connections = 0;
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			connections++;
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as { route?: string };
				if (connections === 1) {
					received = request;
					socket.end(
						`${JSON.stringify({
							result: {
								route: "turn-end",
								version: WARM_TURN_END_SCHEMA_VERSION,
								turnEnd: "TURN ADVISORY",
								tests: "TESTS FAILED",
								deliveryId: "delivery-1",
							},
						})}\n`,
					);
				} else {
					expect(request).toMatchObject({
						route: "turn-end-ack",
						deliveryId: "delivery-1",
					});
					socket.end(
						`${JSON.stringify({
							result: {
								route: "turn-end-ack",
								version: WARM_TURN_END_SCHEMA_VERSION,
								acknowledged: true,
							},
						})}\n`,
					);
				}
			});
		});

		const result = await requestWarmTurnEnd(cwd, 2000);
		expect(result.available).toBe(true);
		expect(result.available && result.response.turnEnd).toBe("TURN ADVISORY");
		expect(received).toEqual({
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd,
		});
		removeTempDirSync(cwd);
	});

	it("does not report delivery success when the receipt acknowledgement times out (#1218)", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-turn-ack-timeout-"),
		);
		let connections = 0;
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			connections++;
			socket.setEncoding("utf8");
			socket.once("data", () => {
				connections === 1
					? socket.end(
							`${JSON.stringify({
								result: {
									route: "turn-end",
									version: WARM_TURN_END_SCHEMA_VERSION,
									turnEnd: "DURABLE FINDING",
									deliveryId: "delivery-timeout",
								},
							})}\n`,
						)
					: undefined;
				// Never answer the acknowledgement connection: the client deadline
				// must report timeout while the server retains its delivery.
			});
		});
		await expect(requestWarmTurnEnd(cwd, 20)).resolves.toEqual({
			available: false,
			reason: "timeout",
		});
		removeTempDirSync(cwd);
	});

	it("reports ipc-error when no warm server is listening", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-turn-none-"),
		);
		await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
			available: false,
			reason: "ipc-error",
		});
		removeTempDirSync(cwd);
	});

	// Old server + new client: the tagged request is blind-cast to an analyze
	// request, `analyzeFile(undefined, …)` throws, and the reply is `{error}`.
	// The bin must read that as "no usable warm server", not as a clean turn.
	it("degrades to ipc-error against a server that predates the route", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-turn-old-"));
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			socket.on("data", () =>
				socket.end(`${JSON.stringify({ error: "boom" })}\n`),
			);
		});
		await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
			available: false,
			reason: "ipc-error",
		});
		removeTempDirSync(cwd);
	});

	it("rejects turn-end schema skew", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-turn-skew-"),
		);
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "turn-end",
							version: WARM_TURN_END_SCHEMA_VERSION + 1,
						},
					})}\n`,
				),
			);
		});
		await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
			available: false,
			reason: "schema-mismatch",
		});
		removeTempDirSync(cwd);
	});
});

describe("createWarmIpcLineReader", () => {
	it("dispatches exactly one line for one request followed by stray bytes (#1219)", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line));
		handler(`${JSON.stringify({ file: "/x/a.ts" })}\n`);
		// Pre-fix, the socket handler kept the consumed line in its buffer and
		// re-dispatched it on any further data event — stray bytes after the
		// request re-ran the whole warm analyze pass.
		handler("stray");
		handler("more");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ file: "/x/a.ts" });
	});

	it("ignores a second newline-terminated request (one-shot per connection)", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line));
		handler(`${JSON.stringify({ file: "/x/a.ts" })}\n`);
		handler(`${JSON.stringify({ file: "/x/b.ts" })}\n`);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).file).toBe("/x/a.ts");
	});

	it("dispatches only the first request when two arrive in one chunk (#1219)", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line));
		handler(
			`${JSON.stringify({ file: "/x/a.ts" })}\n${JSON.stringify({ file: "/x/b.ts" })}\n`,
		);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).file).toBe("/x/a.ts");
	});

	it("assembles a request split across chunks before dispatching", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line));
		handler('{"file":');
		handler('"/x/a.ts"}\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).file).toBe("/x/a.ts");
	});

	it("does not dispatch when no newline ever arrives", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line));
		handler("partial");
		expect(lines).toHaveLength(0);
	});
});

describe("createWarmIpcRequestQueue", () => {
	it("orders analyze and turn-end work even when the client disconnects", async () => {
		const queue = createWarmIpcRequestQueue();
		let releaseAnalyze: (() => void) | undefined;
		const events: string[] = [];
		const analyze = queue.enqueue(
			() =>
				new Promise<void>((resolve) => {
					events.push("analyze-start");
					releaseAnalyze = resolve;
				}),
		);
		const turnEnd = queue.enqueue(async () => {
			events.push("turn-end");
		});

		await Promise.resolve();
		expect(events).toEqual(["analyze-start"]);
		releaseAnalyze?.();
		await Promise.all([analyze, turnEnd]);
		expect(events).toEqual(["analyze-start", "turn-end"]);
	});

	it("keeps serving requests after a queued operation rejects", async () => {
		const queue = createWarmIpcRequestQueue();
		await expect(
			queue.enqueue(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
	});
});
