/**
 * pi-lens-analyze bin — the push-half engine (PostToolUse hook + CLI). Spawns
 * the in-place-compiled bin and asserts its CLI, --hook envelope, clean-file
 * silence, the Claude Code PostToolUse stdin path, and the Stop-hook turn-end
 * mode against a stub warm server. Requires `npm run build`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	ipcPathForCwd,
	WARM_TURN_END_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binJs = path.join(repoRoot, "mcp", "analyze-cli.js");

const SMELLY = `export function f(x) {
\tif (x) { if (x.a) { if (x.b) { if (x.c) { return 1; } } } }
\tconsole.log("debug");
}
`;

function runBin(
	args: string[],
	stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [binJs, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout += c));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c: string) => (stderr += c));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("timeout"));
		}, 40_000);
		timer.unref();
		if (stdin !== undefined) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

let tmpDir: string;
let smellyFile: string;
let cleanFile: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-"));
	smellyFile = path.join(tmpDir, "smelly.ts");
	cleanFile = path.join(tmpDir, "clean.ts");
	fs.writeFileSync(smellyFile, SMELLY);
	fs.writeFileSync(cleanFile, "export const x = 1;\n");
});

afterAll(() => {
	removeTempDirSync(tmpDir);
});

// Spawns a real node subprocess that loads the engine (tree-sitter/native) and
// runs analysis. In the full 200+-file parallel suite this occasionally loses a
// CPU-starvation race and the child crashes at startup (non-zero exit / no
// output) — it passes every time in isolation. retry: 2 absorbs the transient
// contention spike (the established pattern for load-sensitive tests here).
describe("pi-lens-analyze bin", { retry: 2 }, () => {
	it("reports structural warnings in plain CLI mode", async () => {
		const { stdout, code } = await runBin([
			`--file=${smellyFile}`,
			`--cwd=${tmpDir}`,
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("pi-lens:");
		expect(stdout).toMatch(/deep-nesting|console-statement/);
	}, 45_000);

	it("emits a PostToolUse JSON envelope with --hook", async () => {
		const { stdout } = await runBin([
			`--file=${smellyFile}`,
			`--cwd=${tmpDir}`,
			"--hook",
		]);
		const parsed = JSON.parse(stdout) as {
			hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
		};
		expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
		expect(parsed.hookSpecificOutput?.additionalContext).toContain("pi-lens:");
	}, 45_000);

	it("stays silent (no output) on a clean file", async () => {
		const { stdout, code } = await runBin([
			`--file=${cleanFile}`,
			`--cwd=${tmpDir}`,
		]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
	}, 45_000);

	it("analyzes the file from a Claude Code PostToolUse stdin payload", async () => {
		const payload = JSON.stringify({
			tool_input: { path: smellyFile },
			cwd: tmpDir,
		});
		const { stdout } = await runBin([], payload);
		expect(stdout).toContain("pi-lens:");
		expect(stdout).toMatch(/deep-nesting|console-statement/);
	}, 45_000);
});

interface TurnEndStub {
	sockets: net.Socket[];
	requests: unknown[];
	close: () => Promise<void>;
}

function startTurnEndStub(
	cwd: string,
	response: Record<string, unknown>,
): Promise<TurnEndStub> {
	const endpoint = ipcPathForCwd(cwd);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			/* none */
		}
	}
	const sockets: net.Socket[] = [];
	const requests: unknown[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.setEncoding("utf8");
		socket.once("data", (chunk: string) => {
			requests.push(JSON.parse(chunk.trim()));
			socket.end(`${JSON.stringify({ result: response })}\n`);
		});
	});
	return new Promise((resolve) =>
		server.listen(endpoint, () =>
			resolve({
				sockets,
				requests,
				close: () =>
					new Promise<void>((done) => {
						(
							server as net.Server & { closeAllConnections?: () => void }
						).closeAllConnections?.();
						server.close(() => done());
					}),
			}),
		),
	);
}

const FRAMED_ADVISORY = `[pi-lens automated check — not a user request] Address 🔴 blockers before continuing; ℹ️ advisories are informational only.

🔴 knip: 2 unused exports in clients/thing.ts`;

describe("pi-lens-analyze turn-end mode", () => {
	let turnDir: string;
	let stub: TurnEndStub | undefined;

	beforeEach(() => {
		turnDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-turn-"));
	});

	afterEach(async () => {
		await stub?.close();
		stub = undefined;
		removeTempDirSync(turnDir);
	});

	it("renders the warm server's report without the injection framing", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: FRAMED_ADVISORY,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout).toContain("🔎 pi-lens turn-end");
		expect(stdout).toContain("🔴 knip: 2 unused exports");
		expect(stdout).toContain("Address 🔴 blockers before continuing");
		expect(stdout).not.toContain("not a user request");
		expect(stub.requests[0]).toEqual({
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: turnDir,
		});
	}, 20_000);

	it("stays silent when the warm pass found nothing", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
	}, 20_000);

	// No cold fallback: a cold pass has empty cascade runs and accumulators, so a
	// silent skip is honest where a local run would report a false clean.
	it("skips (stderr only) when no warm server is listening", async () => {
		const { stdout, stderr, code } = await runBin([
			"--turn-end",
			`--cwd=${turnDir}`,
		]);

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("turn-end skipped");
	}, 20_000);

	it("detects a Stop payload on stdin without the flag", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			tests: "[pi-lens automated check — not a user request] Test failures detected last turn — fix before continuing:\n\nsuite/thing.test.ts > it works",
		});
		const { stdout, code } = await runBin(
			[],
			JSON.stringify({ cwd: turnDir, hook_event_name: "Stop" }),
		);

		expect(code).toBe(0);
		expect(stdout).toContain("🔎 pi-lens turn-end");
		expect(stdout).toContain("suite/thing.test.ts > it works");
	}, 20_000);

	it("never dials the server on SubagentStop", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: FRAMED_ADVISORY,
		});
		const { stdout, code } = await runBin(
			[],
			JSON.stringify({ cwd: turnDir, hook_event_name: "SubagentStop" }),
		);

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
		expect(stub.sockets).toHaveLength(0);
	}, 20_000);

	it("never dials the server when another hook already blocked the stop", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: FRAMED_ADVISORY,
		});
		const { stdout, code } = await runBin(
			[],
			JSON.stringify({
				cwd: turnDir,
				hook_event_name: "Stop",
				stop_hook_active: true,
			}),
		);

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
		expect(stub.sockets).toHaveLength(0);
	}, 20_000);
});
