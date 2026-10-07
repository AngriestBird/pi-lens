import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// flake-shape: real-process-spawn — only a real gh child boundary can prove that a transient API failure is retried and a persistent failure stays fatal.

const roots: string[] = [];
const script = path.resolve(
	import.meta.dirname,
	"../../scripts/download-test-history-artifacts.mjs",
);

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ persistent = false } = {}) {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-history-download-"),
	);
	roots.push(root);
	const bin = path.join(root, "bin");
	const output = path.join(root, "artifacts");
	fs.mkdirSync(bin);
	const state = path.join(root, "calls");
	fs.writeFileSync(
		path.join(bin, "gh"),
		`#!/bin/sh
state=${JSON.stringify(state)}
count=0
[ -f "$state" ] && count=$(cat "$state")
count=$((count + 1))
printf '%s' "$count" > "$state"
case "$*" in
  *actions/artifacts?name=*)
    printf '%s\\n' '{"id":101,"created_at":"2026-10-07T00:00:00Z","expired":false}'
    ;;
  */zip)
	  ${persistent ? "printf '%s\\n' 'gh: HTTP 503' >&2; exit 1" : "if [ \"$count\" -lt 4 ]; then printf '%s\\n' 'gh: HTTP 503' >&2; exit 1; fi; printf 'zip-bytes'"}
    ;;
esac
`,
	);
	fs.chmodSync(path.join(bin, "gh"), 0o755);
	return { root, bin, output, state };
}

describe("download-test-history-artifacts process boundary", () => {
	it("retries a transient 5xx and succeeds on the bounded final attempt", () => {
		// Recurrence #4030: the nightly exited on one transient GitHub 503
		// instead of retrying the artifact download.
		const { bin, output, state } = fixture();
		execFileSync(
			process.execPath,
			[
				script,
				"--repository",
				"o/r",
				"--artifact-name",
				"unit-test-results-linux",
				"--output-dir",
				output,
			],
			{
				env: {
					...process.env,
					GITHUB_REPOSITORY: "o/r",
					PATH: `${bin}:${process.env.PATH}`,
					TEST_HISTORY_RETRY_DELAY_MS: "0",
				},
			},
		);
		// One list request plus three ZIP attempts before recovery.
		expect(Number(fs.readFileSync(state, "utf8"))).toBe(4);
		expect(fs.readFileSync(path.join(output, "101.zip"), "utf8")).toBe(
			"zip-bytes",
		);
	});

	it("fails after the retry bound on a persistent 5xx", () => {
		const { bin, output, state } = fixture({ persistent: true });
		expect(() =>
			execFileSync(
				process.execPath,
				[
					script,
					"--repository",
					"o/r",
					"--artifact-name",
					"unit-test-results-linux",
					"--output-dir",
					output,
				],
				{
					env: {
						...process.env,
						GITHUB_REPOSITORY: "o/r",
						PATH: `${bin}:${process.env.PATH}`,
						TEST_HISTORY_RETRY_DELAY_MS: "0",
					},
					stdio: "pipe",
				},
			),
		).toThrow();
		// One list request plus four bounded ZIP attempts.
		expect(Number(fs.readFileSync(state, "utf8"))).toBe(5);
		expect(fs.existsSync(path.join(output, "101.zip"))).toBe(false);
	});
});
