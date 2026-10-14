/**
 * #4353: `McpHarness.dispose()` must leave no Unix socket behind, whatever the
 * length of the TMPDIR the harness runs under.
 *
 * Recurrence prevented: `tool-registry-governance` and `tool-roster-budget`
 * stranded `pi-lens-mcp-<hash>` sockets in the lane TMPDIR. The server binds
 * `pi-lens-mcp-<hash>.sock` under `os.tmpdir()`; once that path passes
 * `sun_path` Node silently cuts the bound file name (the `.sock` tail goes), the
 * harness removed only the full name, and its SIGKILL skips libuv's own unlink
 * of the bound file. Orchestrator lane TMPDIRs are long enough to hit this on
 * every run; a short CI TMPDIR never does, so the gate there stayed green.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { boundUnixSocketPath, McpHarness } from "./harness.js";

/** Sockets directly under `dir` (the file kind, not the name: the truncated
 *  name has no `.sock` suffix). */
function socketsIn(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter((name) => fs.lstatSync(path.join(dir, name)).isSocket());
}

describe("boundUnixSocketPath (#4353)", () => {
	const long = `/${"a".repeat(120)}/pi-lens-mcp-0123456789abcdef.sock`;

	it("cuts a Linux path to the 108 bytes sun_path holds", () => {
		const bound = boundUnixSocketPath(long, "linux");
		expect(Buffer.byteLength(bound)).toBe(108);
		expect(long.startsWith(bound)).toBe(true);
	});

	it("cuts a darwin path to 104 bytes", () => {
		expect(Buffer.byteLength(boundUnixSocketPath(long, "darwin"))).toBe(104);
	});

	it("leaves a path that fits, and every Windows pipe, unchanged", () => {
		const short = "/tmp/pi-lens-mcp-0123456789abcdef.sock";
		expect(boundUnixSocketPath(short, "linux")).toBe(short);
		expect(boundUnixSocketPath(long, "win32")).toBe(long);
	});
});

describe.skipIf(process.platform === "win32")(
	"McpHarness socket teardown under a long TMPDIR (#4353)",
	() => {
		it("removes the server's socket when the bound path was truncated", async () => {
			const { tmpDir } = setupTestEnvironment("pi-lens-hsock-");
			// Pad the root to 100 characters: the 33-character socket name then
			// crosses sun_path (108) inside the FILE name, so the bound path stays
			// creatable and truncated. A pad that cut inside a directory component
			// would make the bind fail with ENOENT and prove nothing; a short CI
			// TMPDIR gets the pad, a root already past 100 is used as is.
			const longTmp =
				tmpDir.length >= 100
					? tmpDir
					: path.join(tmpDir, "p".repeat(100 - tmpDir.length - 1));
			fs.mkdirSync(longTmp, { recursive: true });
			vi.stubEnv("TMPDIR", longTmp);
			try {
				const harness = new McpHarness();
				try {
					await harness.request(1, "initialize", {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "socket-teardown", version: "0" },
					});
					// Not vacuous: the server really bound a socket under the long
					// root, and it is the truncated name, not the `.sock` one.
					const bound = socketsIn(longTmp);
					expect(
						bound.length,
						`no socket bound under ${longTmp} (${longTmp.length} chars)`,
					).toBeGreaterThan(0);
					expect(bound.every((name) => !name.endsWith(".sock"))).toBe(true);
				} finally {
					harness.dispose();
				}
				expect(socketsIn(longTmp)).toEqual([]);
			} finally {
				vi.unstubAllEnvs();
			}
		}, 60_000);
	},
);
