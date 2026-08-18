#!/usr/bin/env node
/**
 * Lane 1 (#1605): real-host PSScriptAnalyzer `-File` classification smoke.
 *
 * Classifiers that parse tool stderr are built against synthetic samples;
 * real host formats drift. #1540 fixed the primary gap (a durable
 * `-ExecutionPolicy Restricted`/`AllSigned` block on `-File` was previously
 * invisible -- see `clients/dispatch/runners/psscriptanalyzer.ts`'s
 * `policyDenied` regex, `securityerror` + one of `execution polic(y|ies)` /
 * `running scripts is disabled` / `unauthorizedaccess`). #1604 is the open
 * follow-up worry: PowerShell 7 (`pwsh`)'s default `$ErrorView =
 * 'ConciseView'` OMITS the `CategoryInfo: SecurityError` block that stderr
 * pairing was written against (verified live only on Windows PowerShell 5.1
 * -- see `tests/clients/dispatch/runners/psscriptanalyzer-availability.test.ts`'s
 * fixture). This script is the real-host check: it drives the ACTUAL
 * `psScriptAnalyzerRunner.run()` against a real, spawned `pwsh`/`powershell`
 * under a real execution-policy block, and asserts the availability decision
 * it writes to `latency.log`. If pwsh's ConciseView stderr evades the
 * pairing, this lane goes RED -- that is the point (see #1604; this script
 * does not change the classifier regex, only proves whether it holds).
 *
 * Mechanism: PowerShell's "Process" execution-policy scope is stored in the
 * `PSExecutionPolicyPreference` environment variable (NOT
 * `__PSExecutionPolicyPreference` -- verified live against a real Windows
 * host: `$env:PSExecutionPolicyPreference` is what `Get-ChildItem Env:`
 * actually shows after `Set-ExecutionPolicy -Scope Process`). Child processes
 * inherit environment variables, so setting it on THIS script's env before
 * spawning the real runner forces the exact `-File` block a Restricted host
 * would produce, without ever passing `-ExecutionPolicy` on the runner's own
 * argv (the runner never does -- that asymmetry between the `-Command`
 * probes, which the policy doesn't gate, and the `-File` run, which it does,
 * is the whole #1540 defect shape).
 *
 * Legs (each its own child `node` process -- the runner's latches are
 * process-lifetime module singletons, so legs must not share state):
 *   - "pwsh"              -- if `pwsh` resolves on PATH: the real #1604 leg.
 *   - "powershell-forced" -- Windows PowerShell 5.1, reached by hiding pwsh's
 *                            directory from the child's PATH so
 *                            `resolvePowerShellCmd`'s pwsh->powershell
 *                            fallback naturally selects it. Only run when a
 *                            SEPARATE `powershell.exe` exists (windows-latest
 *                            always ships both).
 *   - "healthy"           -- no execution-policy override: a negative control
 *                            so a mis-classifying script can't pass by always
 *                            reporting policy-denied.
 *
 * Usage: node scripts/smoke-psscriptanalyzer-classification.mjs
 * Exit codes: 0 all legs classified correctly; 1 a real-host classification
 * mismatch (the defect this lane exists to catch); 2 infra failure (no
 * PowerShell present at all, or the dist build is missing).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const LEG_ENV = "PI_LENS_SMOKE_PSA_LEG";
const SCRATCH_ENV = "PI_LENS_SMOKE_PSA_SCRATCH";
const RESULT_MARKER = "PI_LENS_SMOKE_RESULT ";

async function runChildLeg(legName) {
	const scratch = process.env[SCRATCH_ENV];
	const runnerEntry = pathToFileURL(
		path.join(
			repoRoot,
			"dist",
			"clients",
			"dispatch",
			"runners",
			"psscriptanalyzer.js",
		),
	).href;
	const { default: runner } = await import(runnerEntry);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-psa-smoke-"));
	const filePath = path.join(cwd, "repro.ps1");
	fs.writeFileSync(filePath, "Write-Output 'hi'\n");

	let runnerResult;
	let runnerError = null;
	try {
		runnerResult = await runner.run({ cwd, filePath });
	} catch (err) {
		runnerError = err instanceof Error ? err.message : String(err);
	}

	const latencyLogPath = path.join(scratch, "latency.log");
	let decisions = [];
	if (fs.existsSync(latencyLogPath)) {
		decisions = fs
			.readFileSync(latencyLogPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(
				(e) =>
					e &&
					e.phase === "availability_decision" &&
					e.metadata?.tool === "psscriptanalyzer-exec",
			);
	}
	const last = decisions.at(-1) ?? null;

	console.log(
		RESULT_MARKER +
			JSON.stringify({
				leg: legName,
				runnerStatus: runnerResult?.status ?? null,
				runnerError,
				decision: last
					? {
							verdict: last.metadata.verdict,
							outcome: last.metadata.outcome,
							cause: last.metadata.cause,
							latched: last.metadata.latched,
						}
					: null,
				decisionCount: decisions.length,
			}),
	);
}

function findOnPath(binName) {
	const finder = process.platform === "win32" ? "where" : "which";
	const res = spawnSync(finder, [binName], { encoding: "utf8" });
	if (res.status !== 0) return null;
	const lines = res.stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return lines[0] ?? null;
}

function pathWithoutDirOf(binPath) {
	const dir = path.dirname(binPath);
	const sep = path.delimiter;
	const entries = (process.env.PATH ?? "").split(sep);
	return entries
		.filter((e) => path.resolve(e || ".") !== path.resolve(dir))
		.join(sep);
}

function runLeg(legName, envOverrides) {
	const scratch = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-psa-smoke-scratch-${legName}-`),
	);
	const env = {
		...process.env,
		[LEG_ENV]: legName,
		[SCRATCH_ENV]: scratch,
		PI_LENS_HOME: scratch,
		...envOverrides,
	};
	const res = spawnSync(process.execPath, [__filename], {
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	fs.rmSync(scratch, { recursive: true, force: true });
	if (res.error) {
		return { leg: legName, infra: `child spawn failed: ${res.error.message}` };
	}
	const line = (res.stdout ?? "")
		.split("\n")
		.find((l) => l.startsWith(RESULT_MARKER));
	if (!line) {
		return {
			leg: legName,
			infra: `no result marker in child output (status ${res.status}); stderr: ${(res.stderr ?? "").slice(0, 500)}`,
		};
	}
	try {
		return JSON.parse(line.slice(RESULT_MARKER.length));
	} catch (err) {
		return { leg: legName, infra: `unparseable child result: ${err.message}` };
	}
}

function assertLeg(result, expected) {
	const problems = [];
	if (result.infra) {
		return {
			pass: false,
			id: result.leg,
			problems: [`INFRA: ${result.infra}`],
		};
	}
	if (result.runnerError) {
		problems.push(`runner threw: ${result.runnerError}`);
	}
	if (result.runnerStatus !== expected.runnerStatus) {
		problems.push(
			`runner status: expected ${expected.runnerStatus}, got ${result.runnerStatus}`,
		);
	}
	if (!result.decision) {
		problems.push(
			"no availability_decision record was written for psscriptanalyzer-exec",
		);
	} else {
		for (const key of ["outcome", "cause", "latched"]) {
			if (result.decision[key] !== expected.decision[key]) {
				problems.push(
					`decision.${key}: expected ${JSON.stringify(expected.decision[key])}, got ${JSON.stringify(result.decision[key])}`,
				);
			}
		}
	}
	return { pass: problems.length === 0, id: result.leg, problems };
}

async function main() {
	if (process.platform !== "win32") {
		console.log(
			"skip: PSScriptAnalyzer real-host classification is Windows-only.",
		);
		process.exit(0);
	}

	const runnerEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"dispatch",
		"runners",
		"psscriptanalyzer.js",
	);
	if (!fs.existsSync(runnerEntry)) {
		console.error(
			`dist build missing: ${runnerEntry}\nRun \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}

	const pwshPath = findOnPath("pwsh");
	const powershellPath = findOnPath("powershell");
	if (!pwshPath && !powershellPath) {
		console.error(
			"INFRA FAILURE: neither pwsh nor powershell resolves on PATH.",
		);
		process.exit(2);
	}

	const legs = [];
	if (pwshPath) {
		legs.push({
			name: "pwsh-restricted",
			env: { PSExecutionPolicyPreference: "Restricted" },
			expected: {
				runnerStatus: "skipped",
				decision: {
					outcome: "non-installable",
					cause: "policy-denied",
					latched: true,
				},
			},
		});
	}
	if (powershellPath) {
		const env = { PSExecutionPolicyPreference: "Restricted" };
		if (pwshPath) {
			// Force the fallback so this leg exercises powershell.exe (5.1) even
			// when pwsh is also present -- resolvePowerShellCmd tries pwsh first.
			env.PATH = pathWithoutDirOf(pwshPath);
		}
		legs.push({
			name: pwshPath ? "powershell-forced" : "powershell",
			env,
			expected: {
				runnerStatus: "skipped",
				decision: {
					outcome: "non-installable",
					cause: "policy-denied",
					latched: true,
				},
			},
		});
	}
	// Negative control: no policy override, whatever PowerShell is naturally
	// present should run cleanly. Guards against a lane that always reports
	// policy-denied regardless of real host behavior (defect shape 7).
	legs.push({
		name: "healthy",
		env: {},
		expected: {
			runnerStatus: "succeeded",
			// `latched` here means "the verdict is memoized for reuse", which is
			// also true of a successful probe (`notePsDecision` sets
			// `latched: verdict.available || isLatchingOutcome(outcome)`) --
			// only a still-cooling TRANSIENT failure would read `false`.
			decision: { outcome: "success", cause: "ok", latched: true },
		},
	});

	console.log(`legs: ${legs.map((l) => l.name).join(", ")}`);
	const outcomes = [];
	for (const leg of legs) {
		const result = runLeg(leg.name, leg.env);
		const verdict = assertLeg(result, leg.expected);
		outcomes.push(verdict);
		console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.id}`);
		for (const p of verdict.problems) console.log(`         ${p}`);
	}

	const anyInfra = outcomes.some((o) =>
		o.problems.some((p) => p.startsWith("INFRA:")),
	);
	const allPass = outcomes.every((o) => o.pass);
	console.log(
		`\n${allPass ? "ALL LEGS CLASSIFIED CORRECTLY" : "CLASSIFICATION MISMATCH DETECTED"}`,
	);
	if (allPass) process.exit(0);
	process.exit(
		anyInfra &&
			outcomes.every(
				(o) => !o.pass || o.problems.every((p) => p.startsWith("INFRA:")),
			)
			? 2
			: 1,
	);
}

if (process.env[LEG_ENV]) {
	runChildLeg(process.env[LEG_ENV]).then(
		() => process.exit(0),
		(err) => {
			console.error(err);
			process.exit(2);
		},
	);
} else {
	main().catch((err) => {
		console.error("smoke-psscriptanalyzer-classification.mjs crashed:", err);
		process.exit(2);
	});
}
