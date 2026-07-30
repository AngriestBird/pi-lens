/**
 * Standalone review-graph builder. Spawns the in-place compiled CLI, so run
 * `npm run build` before this test.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binJs = path.join(repoRoot, "mcp", "cli.js");

function runCli(
	args: string[],
	dataDir: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [binJs, ...args], {
			env: {
				...process.env,
				PILENS_DATA_DIR: dataDir,
				PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS: "60000",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({ stdout, stderr, code: code ?? -1 }),
		);
	});
}

let tempRoot: string;
let projectDir: string;
let dataDir: string;

beforeAll(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-build-graph-cli-"));
	projectDir = path.join(tempRoot, "project");
	dataDir = path.join(tempRoot, "data");
	fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, "src", "a.ts"),
		"export const answer = 42;\n",
	);
	fs.writeFileSync(
		path.join(projectDir, "src", "b.ts"),
		'import { answer } from "./a.js";\nexport const doubled = answer * 2;\n',
	);
});

afterAll(() => removeTempDirSync(tempRoot));

describe("pi-lens build-graph CLI", () => {
	it("builds and persists a small project with a stats line", async () => {
		const result = await runCli(
			["build-graph", "--cwd", projectDir],
			dataDir,
		);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(
			/^pi-lens build-graph: files=\d+ nodes=\d+ edges=\d+ elements=\d+ jsonBytes=\d+ durationMs=\d+$/,
		);
		const snapshots = fs
			.readdirSync(dataDir, { recursive: true })
			.filter((entry) => String(entry).endsWith("review-graph.json"));
		expect(snapshots).toHaveLength(1);
	});

	it("fails loudly for an unsafe home root", async () => {
		const result = await runCli(
			["build-graph", `--cwd=${os.homedir()}`],
			dataDir,
		);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("pi-lens build-graph failed: unsafe_root");
	});
});
