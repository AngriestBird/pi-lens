#!/usr/bin/env node
/**
 * Lane 2 (#1605): availability-lifecycle smoke -- the latch class
 * (#1490/#1494/#1495/#1496/#1537/#1535, #1556-F1).
 *
 * The arc's most recurrent shape: a transient failure gets recorded as
 * durable, latching a tool off for the rest of the session with no path
 * back. Every fix in that family was only ever proven with a MOCKED spawn
 * (`vi.fn()` on `safeSpawnAsync`); this script drives the same production
 * code path (`clients/zizmor-config.ts`'s `resolveZizmorGitHubToken`,
 * built on the shared `clients/dispatch/runners/utils/availability-policy.ts`
 * latch + `clients/degradation-ledger.ts`) against a REAL spawned process.
 *
 * Representative tool: the `gh auth token` probe zizmor's online-mode
 * resolver runs (#1535). Chosen over a plain "rename a linter binary"
 * scenario because a missing-binary ("missing"/"not-found") verdict is
 * DELIBERATELY session-durable by design (`isLatchingOutcome` -- see
 * `availability-policy.ts`) and only re-arms at `session_start`, not on a
 * cooldown; #1605's "restore -> advance past cooldown -> assert recovery"
 * wording describes a TRANSIENT verdict instead, and the gh-token probe's
 * timeout/host-stall path is exactly that: `classifyGhTokenFailure` keeps a
 * probe that never got a fair hearing as `transient`, which
 * `TRANSIENT_BASE_COOLDOWN_MS` (30s, capped at the module's own 120s
 * ceiling) genuinely expires.
 *
 * We never touch the real `gh` CLI. A FIXTURE `gh`/`gh.cmd` shim, written by
 * this script into a scratch directory prepended to PATH, shadows it only
 * for this process's children -- the system's real `gh` (if any) is
 * untouched. "Renaming a fixture-installed binary" from the binary's own
 * bin directory is exactly what phase 3 below does.
 *
 * Phases (one process -- the transient latch is meant to survive within a
 * process across a real cooldown, unlike lane 1's session-durable latches):
 *   1. Fixture `gh` HANGS past the probe budget -> `resolveZizmorGitHubToken()`
 *      times out -> assert transient/latched-false decision AND a degradation
 *      recorded via `incrementDegradationCount` (kind "mode-suppression",
 *      subject "zizmor").
 *   2. Immediate second call, still inside the cooldown -> assert it is
 *      served from cache (no new probe) and the SAME degradation entry's
 *      count increments (recordDegradationOnce/incrementDegradationCount
 *      semantics: one visible ledger entry, an accumulating count) --
 *      never a second row.
 *   3. Restore: rename the fixture `gh` away and write a working one that
 *      answers instantly with a fake token. Poll past the real cooldown
 *      (read `TRANSIENT_BASE_COOLDOWN_MS` from the built module rather than
 *      hardcoding it, and keep polling instead of a single fixed sleep, so an
 *      exponential-ladder bump lengthens the wait instead of failing this
 *      phase as "recovery failed").
 *   4. Assert a GENUINE re-probe happened (the fixture token is returned, not
 *      the cached `undefined`) and the decision log shows a fresh
 *      `available`/`success` record with no new degradation.
 *   5. The OTHER latch half this lane's real subject is: a `missing`
 *      ("not-found") verdict is process-lifetime durable by design
 *      (`isLatchingOutcome`) and does NOT expire on any cooldown -- remove
 *      the fixture entirely, confirm the verdict latches (two calls, same
 *      cached `undefined`, no new probe on the second), then call
 *      `resetZizmorTokenAvailability()` (the real `session_start` reset) and
 *      confirm THAT is what re-arms it, not time.
 *
 * Usage: node scripts/smoke-availability-lifecycle.mjs
 * Exit codes: 0 pass; 1 an assertion failed (the latch/cooldown defect this
 * lane exists to catch); 2 infra failure (dist build missing, can't write
 * the fixture).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const isWindows = process.platform === "win32";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const problems = [];
function assertEq(label, actual, expected) {
	if (actual !== expected) {
		problems.push(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
		return false;
	}
	console.log(`  [PASS] ${label} === ${JSON.stringify(expected)}`);
	return true;
}
function assertTrue(label, cond, detail) {
	if (!cond) {
		problems.push(`${label}${detail ? `: ${detail}` : ""}`);
		return false;
	}
	console.log(`  [PASS] ${label}`);
	return true;
}

function writeFixtureGh(binDir, mode) {
	const posixPath = path.join(binDir, "gh");
	const cmdPath = path.join(binDir, "gh.cmd");
	if (mode === "hang") {
		fs.writeFileSync(posixPath, "#!/bin/sh\nsleep 10\n");
		fs.writeFileSync(cmdPath, "@echo off\r\nping -n 11 127.0.0.1 >nul\r\n");
	} else if (mode === "ok") {
		fs.writeFileSync(posixPath, "#!/bin/sh\necho gh-fixture-token-recovered\n");
		fs.writeFileSync(
			cmdPath,
			"@echo off\r\necho gh-fixture-token-recovered\r\n",
		);
	} else {
		throw new Error(`unknown fixture mode ${mode}`);
	}
	if (!isWindows) fs.chmodSync(posixPath, 0o755);
}

/** Ambient system `gh`, if any -- so it can be excluded (not the WHOLE
 * system PATH) rather than stripping PATH down to just the fixture dir,
 * which would also break the fixture's OWN dependency on system utilities
 * (the "hang" mode shells out to `ping`/`cmd.exe` on Windows). */
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

function pathWithoutDirOf(fullPath, binPath) {
	const dir = path.dirname(binPath);
	const sep = path.delimiter;
	return fullPath
		.split(sep)
		.filter((e) => path.resolve(e || ".") !== path.resolve(dir))
		.join(sep);
}

function removeFixtureGh(binDir) {
	for (const name of ["gh", "gh.cmd"]) {
		const p = path.join(binDir, name);
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}
}

async function readDecisions(scratch, tool, flush) {
	// latency.log writes go through an async queue (`createNdjsonLogger`) --
	// flush it first so a read immediately after an `await` doesn't race a
	// still-pending write and miss (or misorder) the decision it just made.
	await flush();
	const latencyLogPath = path.join(scratch, "latency.log");
	if (!fs.existsSync(latencyLogPath)) return [];
	return fs
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
				e && e.phase === "availability_decision" && e.metadata?.tool === tool,
		);
}

async function main() {
	const distEntry = path.join(repoRoot, "dist", "clients", "zizmor-config.js");
	const ledgerEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"degradation-ledger.js",
	);
	if (!fs.existsSync(distEntry) || !fs.existsSync(ledgerEntry)) {
		console.error(
			`dist build missing under ${repoRoot}/dist -- run \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}

	const scratch = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-smoke-avail-"),
	);
	const binDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-smoke-avail-bin-"),
	);
	process.env.PI_LENS_HOME = scratch;
	// Exclude any REAL system `gh` directory (GitHub-hosted runners ship one
	// on PATH by default), don't strip PATH down to just the fixture dir --
	// phase 5 removes the fixture to reproduce a genuinely-absent `gh`
	// (ENOENT), and a bare "prepend the fixture dir" would silently fall
	// through to the real system `gh` the moment the fixture is deleted
	// (exactly the "never touch the real gh CLI" contract this lane
	// promises). Stripping the WHOLE system PATH instead would also break the
	// fixture's own "hang" mode, which shells out to `ping`/`cmd.exe` on
	// Windows -- so only the real gh's directory is excluded, everything else
	// stays.
	const realGhPath = findOnPath("gh");
	const pathSansRealGh = realGhPath
		? pathWithoutDirOf(process.env.PATH ?? "", realGhPath)
		: (process.env.PATH ?? "");
	process.env.PATH = `${binDir}${path.delimiter}${pathSansRealGh}`;
	// Never let a real ambient token short-circuit the fixture probe.
	delete process.env.GH_TOKEN;
	delete process.env.GITHUB_TOKEN;
	delete process.env.ZIZMOR_GITHUB_TOKEN;

	try {
		const { resolveZizmorGitHubToken, resetZizmorTokenAvailability } =
			await import(pathToFileURL(distEntry).href);
		const { getDegradationSummary } = await import(
			pathToFileURL(ledgerEntry).href
		);
		const { flushLatencyLog } = await import(
			pathToFileURL(path.join(repoRoot, "dist", "clients", "latency-logger.js"))
				.href
		);
		const { resetSafeSpawnWindowsCommandCache } = await import(
			pathToFileURL(path.join(repoRoot, "dist", "clients", "safe-spawn.js"))
				.href
		);
		const { TRANSIENT_BASE_COOLDOWN_MS } = await import(
			pathToFileURL(
				path.join(
					repoRoot,
					"dist",
					"clients",
					"dispatch",
					"runners",
					"utils",
					"availability-policy.js",
				),
			).href
		);
		resetZizmorTokenAvailability();

		console.log("phase 1: fixture gh hangs past the probe budget");
		writeFixtureGh(binDir, "hang");
		const t1 = await resolveZizmorGitHubToken();
		assertEq("phase1 token", t1, undefined);
		const d1 = (
			await readDecisions(scratch, "zizmor-gh-token", flushLatencyLog)
		).at(-1);
		assertTrue(
			"phase1 decision recorded",
			!!d1,
			"no availability_decision for zizmor-gh-token",
		);
		if (d1) {
			assertEq("phase1 decision.outcome", d1.metadata.outcome, "transient");
			assertEq("phase1 decision.latched", d1.metadata.latched, false);
		}
		let summary = getDegradationSummary();
		let group = summary.find((g) => g.kind === "mode-suppression");
		assertTrue(
			"phase1 degradation group exists",
			!!group,
			"no mode-suppression group in the ledger",
		);
		if (group) {
			assertEq("phase1 degradation count", group.count, 1);
			assertTrue(
				"phase1 degradation subject is zizmor",
				group.latestReasons.some((r) => r.subject === "zizmor"),
			);
		}

		console.log("\nphase 2: immediate re-call inside the cooldown (cache hit)");
		const t2 = await resolveZizmorGitHubToken();
		assertEq("phase2 token (still cached-unavailable)", t2, undefined);
		summary = getDegradationSummary();
		group = summary.find((g) => g.kind === "mode-suppression");
		assertTrue("phase2 degradation group still exists", !!group);
		if (group) {
			// recordDegradationOnce/incrementDegradationCount semantics: ONE
			// ledger entry (never a duplicate row), an ACCUMULATING count.
			assertEq(
				"phase2 degradation entry count (one visible row)",
				group.latestReasons.length,
				1,
			);
			assertEq("phase2 degradation tally", group.count, 2);
		}

		console.log("\nphase 3: restore the fixture");
		removeFixtureGh(binDir);
		writeFixtureGh(binDir, "ok");

		console.log("phase 4: poll past the real cooldown for a genuine re-probe");
		// `retryAtMs` is set INSIDE `noteUnavailable`, which only runs AFTER
		// phase 1's probe already failed -- the cooldown window starts counting
		// from THAT moment, not from when the probe began. So the real margin
		// here is the cooldown itself plus a couple of seconds, not "cooldown
		// minus however long the probe took" (that reasoning is backwards and
		// was this comment's own former bug). Poll rather than a single fixed
		// sleep so an exponential-ladder bump (attempts > 1 would double the
		// wait) lengthens this loop instead of failing the phase as "recovery
		// failed" -- bounded at 4x the base cooldown, matching the module's own
		// ZIZMOR_TOKEN_MAX_COOLDOWN_MS (120s) ceiling.
		const pollDeadlineMs = Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4;
		let t3;
		do {
			t3 = await resolveZizmorGitHubToken();
			if (t3 !== undefined) break;
			await sleep(2000);
		} while (Date.now() < pollDeadlineMs);
		assertEq(
			"phase4 token (real re-probe recovered)",
			t3,
			"gh-fixture-token-recovered",
		);
		const d4 = (
			await readDecisions(scratch, "zizmor-gh-token", flushLatencyLog)
		).at(-1);
		assertTrue(
			"phase4 decision recorded",
			!!d4,
			"no fresh availability_decision after recovery",
		);
		if (d4) {
			assertEq("phase4 decision.verdict", d4.metadata.verdict, "available");
			assertEq("phase4 decision.outcome", d4.metadata.outcome, "success");
		}
		// The poll loop above may have made more than one cache-hit call while
		// still cooling down (each one legitimately counts, same as phase 2), so
		// assert stability from THIS point rather than a fixed "2" -- one more
		// call now that the latch is a genuine `available` hit must add nothing.
		summary = getDegradationSummary();
		group = summary.find((g) => g.kind === "mode-suppression");
		const countAtRecovery = group?.count ?? 0;
		assertTrue(
			"phase4 degradation count reached recovery with at least phase 1+2's 2",
			countAtRecovery >= 2,
			`count: ${countAtRecovery}`,
		);
		await resolveZizmorGitHubToken();
		summary = getDegradationSummary();
		group = summary.find((g) => g.kind === "mode-suppression");
		assertEq(
			"phase4 no NEW degradation recorded once recovered",
			group?.count ?? 0,
			countAtRecovery,
		);

		console.log(
			"\nphase 5: the OTHER latch half -- a missing verdict is process-lifetime durable, not cooldown-bound",
		);
		// Phase 4 left the latch genuinely `available` -- that answer is cached
		// FOREVER by design (no cooldown ever applies to a success), so it would
		// keep being served even with the fixture removed. Start this phase's
		// own fresh "session" so `missing` is being tested from a clean latch,
		// not fighting phase 4's cached good answer.
		resetZizmorTokenAvailability();
		removeFixtureGh(binDir);
		const t5a = await resolveZizmorGitHubToken();
		assertEq("phase5 token (gh genuinely absent)", t5a, undefined);
		const d5a = (
			await readDecisions(scratch, "zizmor-gh-token", flushLatencyLog)
		).at(-1);
		assertTrue(
			"phase5 decision recorded",
			!!d5a,
			"no availability_decision for the missing-gh probe",
		);
		if (d5a) {
			assertEq("phase5 decision.outcome", d5a.metadata.outcome, "missing");
			assertEq("phase5 decision.latched", d5a.metadata.latched, true);
		}
		// No cooldown applies to a latching outcome (`isLatchingOutcome`) -- a
		// second immediate call must stay latched on the SAME cached verdict,
		// proving this is durable, not merely "not yet expired".
		const t5b = await resolveZizmorGitHubToken();
		assertEq("phase5 still latched without any wait", t5b, undefined);

		// Bring gh back AND simulate the real session_start reset -- that is
		// what re-arms a latching verdict, never elapsed time. A real
		// session_start fires MULTIPLE resets together (`clients/runtime-session.ts`);
		// besides the zizmor latch itself, `safe-spawn.ts` keeps its own
		// Windows PATH/PATHEXT resolution cache (`resetSafeSpawnWindowsCommandCache`,
		// also wired into `handleSessionStart`) that would otherwise keep
		// serving the "gh not found" answer it just cached in phase 5's
		// missing-verdict check above, on Windows, for up to its own
		// negative-cache TTL.
		writeFixtureGh(binDir, "ok");
		resetZizmorTokenAvailability();
		resetSafeSpawnWindowsCommandCache();
		const t5c = await resolveZizmorGitHubToken();
		assertEq(
			"phase5 resetZizmorTokenAvailability() re-probes and recovers",
			t5c,
			"gh-fixture-token-recovered",
		);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(binDir, { recursive: true, force: true });
	}

	console.log(
		`\n${problems.length === 0 ? "AVAILABILITY LIFECYCLE VERIFIED (latch + degradation + real recovery)" : "AVAILABILITY LIFECYCLE MISMATCH DETECTED"}`,
	);
	for (const p of problems) console.log(`  FAIL: ${p}`);
	process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("smoke-availability-lifecycle.mjs crashed:", err);
	process.exit(2);
});
