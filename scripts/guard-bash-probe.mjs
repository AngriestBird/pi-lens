#!/usr/bin/env node

/**
 * Differential probe for the real PreToolUse Bash hook (#4071).
 * Matrix paths are intentionally data-only: the hook remains the oracle.
 */
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOOK = join(ROOT, "scripts", "hooks", "guard-bash.mjs");

function die(message) {
	console.error(`guard-bash-probe: ${message}`);
	process.exitCode = 1;
}

export function makeFixtures() {
	const root = mkdtempSync(join(tmpdir(), "guard-bash-probe-"));
	const main = join(root, "main");
	const linked = join(root, "linked");
	const real = join(root, "real");
	mkdirSync(join(main, "node_modules"), { recursive: true });
	mkdirSync(join(linked, "scripts"), { recursive: true });
	mkdirSync(real, { recursive: true });
	mkdirSync(join(real, "node_modules"));
	writeFileSync(join(linked, "package.json"), "{}\n");
	writeFileSync(join(real, "package.json"), "{}\n");
	symlinkSync(join(main, "node_modules"), join(linked, "node_modules"));
	return {
		root,
		main,
		linked,
		real,
		values: {
			"{{MAIN}}": main,
			"{{LANE}}": linked,
			"{{REAL}}": real,
			"{{TMPDIR}}": root,
		},
	};
}

export function materialize(value, values) {
	let result = value;
	for (const [needle, replacement] of Object.entries(values))
		result = result.replaceAll(needle, replacement);
	return result;
}

export function hookVerdict(hook, command, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [hook], {
			cwd: ROOT,
			env: { ...process.env, PI_LENS_HOME: join(cwd, ".probe-home") },
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) =>
			resolve({
				verdict: status === 2 ? "deny" : "allow",
				status,
				stderr: stderr.trim(),
			}),
		);
		child.stdin.end(
			JSON.stringify({
				tool_name: "Bash",
				tool_input: { command },
				cwd,
			}),
		);
	});
}

export function hookForRef(ref, fixtureRoot) {
	if (!ref) return HOOK;
	const hook = join(
		fixtureRoot,
		`hook-${ref.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}.mjs`,
	);
	const shown = gitExecFileSync(
		["show", `${ref}:scripts/hooks/guard-bash.mjs`],
		{
			cwd: ROOT,
			encoding: "utf8",
		},
	);
	writeFileSync(hook, shown);
	return hook;
}

function readMatrix(path) {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line, index) => {
			try {
				const row = JSON.parse(line);
				if (!row || typeof row.command !== "string")
					throw new Error("missing command");
				if (row.expect !== "allow" && row.expect !== "deny")
					throw new Error("expect must be allow or deny");
				return { ...row, _index: index + 1 };
			} catch (error) {
				throw new Error(`${path}:${index + 1}: ${error.message}`);
			}
		});
}

function rowsForLane(rows, lane) {
	return rows.flatMap((row) => {
		const lanes =
			row.lane === "both" || row.lane === undefined
				? ["linked", "real"]
				: [row.lane];
		if (lane === "both")
			return lanes.map((fixtureLane) => ({ ...row, fixtureLane }));
		return lanes.includes(lane) ? [{ ...row, fixtureLane: lane }] : [];
	});
}

export async function runMatrix(
	matrixPath,
	{ base, lane = "both", quiet = false } = {},
) {
	const rows = rowsForLane(readMatrix(matrixPath), lane);
	const fixtures = makeFixtures();
	const candidateHook = HOOK;
	const baseHook = base ? hookForRef(base, fixtures.root) : null;
	const results = [];
	const checked = await Promise.all(
		rows.map(async (row) => {
			const command = materialize(row.command, fixtures.values);
			const cwd = materialize(
				row.cwd ?? `{{${row.fixtureLane.toUpperCase()}}}`,
				fixtures.values,
			);
			const candidate = await hookVerdict(candidateHook, command, cwd);
			const actual = baseHook
				? await hookVerdict(baseHook, command, cwd)
				: null;
			const changed = actual && actual.verdict !== candidate.verdict;
			return { row, command, cwd, candidate, base: actual, changed };
		}),
	);
	results.push(...checked);
	const printed = baseHook
		? results.filter((result) => result.changed)
		: results;
	if (!quiet) {
		for (const result of printed) {
			const suffix = result.row.reason ? ` — ${result.row.reason}` : "";
			const before = result.base ? `${result.base.verdict} -> ` : "";
			console.log(
				`${result.row._index}\t${before}${result.candidate.verdict}\texpect ${result.row.expect}\t${result.command}${suffix}`,
			);
		}
		const counts = (items) =>
			Object.fromEntries(
				["allow", "deny"].map((v) => [
					v,
					items.filter((r) => r.candidate.verdict === v).length,
				]),
			);
		console.log(
			`counts\trows=${results.length}\tallow=${counts(results).allow}\tdeny=${counts(results).deny}${baseHook ? `\tchanged=${printed.length}` : ""}`,
		);
	}
	const failures = results.filter(
		(result) =>
			result.row.expect === "deny" && result.candidate.verdict !== "deny",
	);
	rmSync(fixtures.root, { recursive: true, force: true });
	return { results, failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const matrixPath = args.find((arg) => !arg.startsWith("--"));
	if (!matrixPath) {
		die(
			"usage: scripts/guard-bash-probe.mjs <matrix.jsonl> [--base <ref>] [--lane linked|real|both]",
		);
	} else {
		const baseIndex = args.indexOf("--base");
		const laneIndex = args.indexOf("--lane");
		try {
			const { failures } = await runMatrix(matrixPath, {
				base: baseIndex >= 0 ? args[baseIndex + 1] : undefined,
				lane: laneIndex >= 0 ? args[laneIndex + 1] : "both",
			});
			if (failures.length) {
				console.error(
					`guard-bash-probe: ${failures.length} expected DENY row(s) allowed`,
				);
				process.exitCode = 1;
			}
		} catch (error) {
			die(error.message);
		}
	}
}
