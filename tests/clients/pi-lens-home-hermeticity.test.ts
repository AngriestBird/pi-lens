/**
 * Regression guard for #525 (test hermeticity for ~/.pi-lens machine-global
 * state, the same class #515 fixed for config.json).
 *
 * Uses the REAL (unmocked) `getGlobalPiLensDir` — deliberately does NOT mock
 * `clients/file-utils.js` like tests/clients/instance-registry.test.ts does,
 * so this test proves the actual env-var routing end to end: every writer
 * under `~/.pi-lens` goes through `getGlobalPiLensDir()`, which now respects
 * `PI_LENS_HOME`. Dogfooding caught this live 2026-07-11: a test-fixture
 * instance (`Temp/pi-lens-turn-summary-*` projectRoot) survived in the
 * developer's REAL `~/.pi-lens/instances.json` for ~17h because tests
 * exercising `registerInstance` had no override and wrote straight into the
 * real homedir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	auditRegistry,
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";

const realGlobalDir = path.join(os.homedir(), ".pi-lens");
const realRegistryPath = path.join(realGlobalDir, "instances.json");

describe("machine-global writers route through PI_LENS_HOME, never the real homedir", () => {
	let overrideDir: string;

	beforeEach(() => {
		overrideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-home-override-"),
		);
		process.env.PI_LENS_HOME = overrideDir;
	});

	afterEach(() => {
		removeTempDirSync(overrideDir);
		delete process.env.PI_LENS_HOME;
	});

	it("getGlobalPiLensDir resolves to PI_LENS_HOME", async () => {
		const { getGlobalPiLensDir } = await import("../../clients/file-utils.js");
		expect(getGlobalPiLensDir()).toBe(path.resolve(overrideDir));
	});

	it("registerInstance writes instances.json under PI_LENS_HOME, never under the real homedir", async () => {
		const realHomeExistedBefore = fs.existsSync(realRegistryPath);
		const realHomeMtimeBefore = realHomeExistedBefore
			? fs.statSync(realRegistryPath).mtimeMs
			: undefined;

		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/some/override-routed/project");

		const overriddenPath = path.join(overrideDir, "instances.json");
		expect(fs.existsSync(overriddenPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(overriddenPath, "utf-8"));
		expect(parsed.instances).toHaveLength(1);
		expect(parsed.instances[0].projectRoot).toContain(
			"override-routed/project",
		);

		// The real ~/.pi-lens/instances.json must be untouched: either it still
		// doesn't exist, or (if a real pi-lens session happens to run on this
		// machine concurrently) its mtime did not change from this test's write.
		if (realHomeExistedBefore) {
			expect(fs.statSync(realRegistryPath).mtimeMs).toBe(realHomeMtimeBefore);
		} else {
			expect(fs.existsSync(realRegistryPath)).toBe(false);
		}
	});

	it("deregisterInstance operates only on the PI_LENS_HOME-scoped registry", async () => {
		const { registerInstance, deregisterInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/dereg/project");
		expect(await readInstanceRegistry()).toHaveLength(1);

		deregisterInstance();
		expect(await readInstanceRegistry()).toHaveLength(0);

		// Confirm it operated under the override, not the real homedir dir.
		expect(fs.existsSync(path.join(overrideDir, "instances.json"))).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// #3050: detect a tests/ file that drives the machine-global registry
// against the RUN-SHARED PI_LENS_HOME, rather than against the per-case
// override the suite above proves every writer respects.
//
// #3042's shape: `tests/support/vitest-setup.ts` pins ONE `PI_LENS_HOME`
// (`.probe-home`) for the whole vitest run, not a per-worker temp dir. Every
// writer under it — `clients/instance-registry.ts`'s `registerInstance` /
// `pruneDeadInstances`, `clients/instance-reaper.ts`'s orphan-backstop sweep
// — locks its target with a BEST-EFFORT primitive (`withInstanceRegistryLock`
// / `withInstanceRegistryLockSync` / `acquireQuarantinePidFileLock`): each
// gives up after a bounded wait and silently skips the write on contention,
// rather than blocking or throwing. A test that asserts such a write as a
// hard postcondition is racing every sibling Vitest fork over that ONE file —
// exactly how `tests/index-vanished-instance-wiring.test.ts` redded in CI on
// two unrelated dependabot heads (#3023, #3026) before touching the reaper,
// the registry, or the test itself.
//
// Two sweeps, reusing `tests/support/sweep-kit.ts`'s registered-or-fail
// machinery rather than a new lane:
//
//   1. The set of `clients/` modules that resolve a `getGlobalPiLensDir()`
//      path AND lock it with one of the best-effort primitives above stays a
//      NAMED, registered pair — so a third module adopting the same shape
//      cannot silently join the population sweep 2 depends on.
//   2. Every `tests/**/*.test.ts` file that reaches one of those modules (by
//      import specifier, `vi.mock`/`vi.doMock` target, or a direct
//      `getGlobalPiLensDir()` call) pins its own `PI_LENS_HOME` or mocks
//      `clients/file-utils.js`'s `getGlobalPiLensDir` — the two isolation
//      idioms this repo's registry-driving tests already use (a third,
//      giving a spawned child its own `PI_LENS_HOME` in its env, isolates the
//      CHILD process rather than the parent test file, so a parent that only
//      spawns such a child never touches the registry itself and is outside
//      this walk's population — `tests/clients/instance-registry-race.test.ts`).
//
// Both scans run over comment-and-string-blanked text (AGENTS.md "Detectors
// match code, not prose") — this docblock's own mentions of every symbol
// above must never be read as a hit.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CLIENTS_ROOT = path.join(REPO_ROOT, "clients");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

/** Best-effort lock primitives #3042's shape is built on: bounded wait, then
 *  silently skip rather than block or throw. */
const BEST_EFFORT_LOCK_CALLS = [
	"withInstanceRegistryLock(",
	"withInstanceRegistryLockSync(",
	"acquireQuarantinePidFileLock(",
] as const;

/** A module resolves a getGlobalPiLensDir()-rooted path AND locks it with a
 *  best-effort primitive — #3042's exact writer shape, not merely "uses
 *  getGlobalPiLensDir somewhere" (which alone would also catch read-only
 *  consumers like `clients/biome-client.ts`'s tools-dir path, never racy). */
function isBestEffortGlobalDirWriter(source: string): boolean {
	const code = stripSource(source, { strings: "blank" });
	const callsGlobalDir = /\bgetGlobalPiLensDir\s*\(/.test(code);
	const callsBestEffortLock = BEST_EFFORT_LOCK_CALLS.some((needle) =>
		code.includes(needle),
	);
	return callsGlobalDir && callsBestEffortLock;
}

const clientsFiles = listSourceFiles(CLIENTS_ROOT, { skipTests: true });
const producerModules = clientsFiles
	.filter((file) => isBestEffortGlobalDirWriter(fs.readFileSync(file, "utf8")))
	.map((file) => relativePosix(CLIENTS_ROOT, file))
	.sort();

describe("clients/ best-effort getGlobalPiLensDir() writers stay a named, registered set (#3042 recurrence)", () => {
	it("registry-or-fail: every module that locks a getGlobalPiLensDir() path with a best-effort primitive is named here", () => {
		assertNonEmptyScan(
			"clients/ best-effort global-dir writer scan",
			clientsFiles.length,
			300,
		);
		const audit = auditRegistry({
			sweepName: "clients/ best-effort global-dir writer registry",
			flagged: producerModules,
			registered: ["instance-registry.ts", "instance-reaper.ts"],
			scannedCount: clientsFiles.length,
			minScanned: 300,
			remediation:
				"A clients/ module now resolves a getGlobalPiLensDir() path and " +
				"locks it with a best-effort primitive that silently drops the " +
				"write under contention — #3042's exact writer shape. Name it in " +
				"the `registered` list above, then the test-file sweep below " +
				"(which derives its population FROM this list) starts covering " +
				"tests/ files that reach it.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("mutation-proof: dropping the best-effort-lock half of the predicate lets read-only getGlobalPiLensDir() consumers into the registry, reding the audit above", () => {
		// #3042's shape is "resolves the path AND locks it best-effort" — NOT
		// merely "calls getGlobalPiLensDir somewhere". clients/biome-client.ts,
		// clients/effective-config.ts and clients/runtime-session.ts all call
		// getGlobalPiLensDir() (a tools-dir join, a config resolution, an
		// atomic-write-stage sweep) with no lock at all — read-only or
		// single-writer paths, never the racy shape. A predicate that dropped
		// the lock half would sweep them in as unregistered producers.
		const naiveProducerModules = clientsFiles
			.filter((file) =>
				/\bgetGlobalPiLensDir\s*\(/.test(
					stripSource(fs.readFileSync(file, "utf8"), { strings: "blank" }),
				),
			)
			.map((file) => relativePosix(CLIENTS_ROOT, file))
			.sort();

		// The mutation really does find more than the real predicate — proof
		// the AND-condition is load-bearing, not decoration.
		expect(naiveProducerModules.length).toBeGreaterThan(producerModules.length);
		expect(naiveProducerModules).toEqual(
			expect.arrayContaining(["biome-client.ts", "effective-config.ts"]),
		);

		const mutatedAudit = auditRegistry({
			sweepName: "MUTATED (lock condition dropped) global-dir writer registry",
			flagged: naiveProducerModules,
			registered: ["instance-registry.ts", "instance-reaper.ts"],
			minFlagged: 1,
		});
		expect(mutatedAudit.problems.length).toBeGreaterThan(0);
		expect(mutatedAudit.unaccounted).toEqual(
			expect.arrayContaining(["biome-client.ts", "effective-config.ts"]),
		);
	});
});

// ── Hazardous EXPORTED symbols per producer module ──────────────────────────
//
// "Imports something from instance-registry.js" is not the same as "touches
// the racy registry file": many exports are pure functions over an
// already-provided `InstanceEntry[]` (`getInstanceRoots`, `mergeInstanceRoots`,
// `selectLivePeerInstances`, `computeResourceFootprint`) or module-load
// constants/types, and a first version of this sweep that flagged ANY
// specifier reference found 23 such false positives (`clients/warm-attach.
// test.ts` imports only a TYPE; `clients/shared-checkout-guard.test.ts` calls
// a pure selector; `clients/debug-handles.test.ts` calls `getGlobalPiLensDir`
// for an unrelated, non-racy log file). The population must be the functions
// that actually perform the best-effort-locked I/O.

/** Every top-level `function NAME(...) { ... }` in `strippedCode` (comments
 *  and strings already blanked, so brace-counting only ever sees REAL code
 *  braces — a template-literal `${...}` interpolation's own braces are left
 *  unblanked by `stripSource` for exactly this reason), keyed by name to its
 *  body text including the braces. Assumes column-0 top-level declarations,
 *  same as sweep-kit's `findEnclosingSymbol` already does for this repo. */
function topLevelFunctionBodies(strippedCode: string): Map<string, string> {
	const bodies = new Map<string, string>();
	const pattern =
		/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(strippedCode))) {
		const braceStart = strippedCode.indexOf("{", match.index + match[0].length);
		if (braceStart < 0) continue;
		let depth = 0;
		let end = -1;
		for (let i = braceStart; i < strippedCode.length; i++) {
			if (strippedCode[i] === "{") depth++;
			else if (strippedCode[i] === "}") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end < 0) continue;
		bodies.set(match[1], strippedCode.slice(braceStart, end + 1));
	}
	return bodies;
}

/** Fixed-point closure over one module's own top-level functions: every
 *  function whose body calls a best-effort lock primitive or
 *  `getGlobalPiLensDir(` directly, OR calls another function already in the
 *  set (same file only — `registerInstance` itself calls neither; it calls
 *  `registerInstanceNow`, which calls `writeRegistryWithRetry`, which calls
 *  `withInstanceRegistryLock`/`registryPath`, three hops down. A predicate
 *  that skipped this closure — checked live below — would miss
 *  `registerInstance` entirely), restricted to names the module EXPORTS. */
function hazardousExportedNames(strippedCode: string): string[] {
	const bodies = topLevelFunctionBodies(strippedCode);
	const callsPrimitiveDirectly = (body: string): boolean =>
		/\bgetGlobalPiLensDir\s*\(/.test(body) ||
		BEST_EFFORT_LOCK_CALLS.some((needle) => body.includes(needle));
	const hazardous = new Set<string>();
	for (const [name, body] of bodies) {
		if (callsPrimitiveDirectly(body)) hazardous.add(name);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, body] of bodies) {
			if (hazardous.has(name)) continue;
			for (const hazardousName of hazardous) {
				if (new RegExp(`\\b${escapeRegExp(hazardousName)}\\s*\\(`).test(body)) {
					hazardous.add(name);
					changed = true;
					break;
				}
			}
		}
	}
	const exported = new Set<string>();
	const exportPattern =
		/^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm;
	let exportMatch: RegExpExecArray | null;
	while ((exportMatch = exportPattern.exec(strippedCode))) {
		exported.add(exportMatch[1]);
	}
	return [...hazardous].filter((name) => exported.has(name)).sort();
}

const hazardousSymbols = new Set<string>();
for (const relFile of producerModules) {
	const stripped = stripSource(
		fs.readFileSync(path.join(CLIENTS_ROOT, relFile), "utf8"),
		{ strings: "blank" },
	);
	for (const name of hazardousExportedNames(stripped))
		hazardousSymbols.add(name);
}
// Cross-file addendum this same-file closure structurally cannot see:
// `instance-reaper.ts`'s exported `sweepOrphans` calls `instance-registry.ts`'s
// exported `readInstanceRegistry` — a DIFFERENT file, so it never enters
// `instance-reaper.ts`'s own closure above. Verified live below, every run,
// rather than trusted as a comment.
hazardousSymbols.add("sweepOrphans");

/** Hazardous symbols whose ENTIRE I/O is a registry READ (`readInstanceRegistry`
 *  itself, and `sweepOrphans`, which per the addendum above calls nothing else
 *  racy) — mocking `instance-registry.js`'s `readInstanceRegistry` fully
 *  neutralizes a test that calls ONLY these. A file that also calls a WRITER
 *  (`registerInstance`, `pruneDeadInstances`, ...) needs the stronger
 *  `file-utils.js`/`PI_LENS_HOME` idiom instead — `isIsolated` below checks
 *  this per file, not per call. */
const SYMBOLS_COVERED_BY_READ_MOCK = new Set([
	"readInstanceRegistry",
	"sweepOrphans",
]);

describe("clients/ hazardous exported registry symbols stay derived, not guessed (#3042 recurrence)", () => {
	it("the sweepOrphans -> readInstanceRegistry cross-file addendum is still true", () => {
		// If either half stops being true, the manual `hazardousSymbols.add(
		// "sweepOrphans")` above is a stale guess, not a verified fact.
		const reaperStripped = stripSource(
			fs.readFileSync(path.join(CLIENTS_ROOT, "instance-reaper.ts"), "utf8"),
			{ strings: "blank" },
		);
		expect(/^export async function sweepOrphans\(/m.test(reaperStripped)).toBe(
			true,
		);
		expect(/\breadInstanceRegistry\s*\(/.test(reaperStripped)).toBe(true);
	});

	it("mutation-proof: without the transitive closure, registerInstance (three calls from the lock) drops out of the hazardous set", () => {
		const registrySource = fs.readFileSync(
			path.join(CLIENTS_ROOT, "instance-registry.ts"),
			"utf8",
		);
		const stripped = stripSource(registrySource, { strings: "blank" });
		expect(hazardousExportedNames(stripped)).toContain("registerInstance");

		// MUTATION: direct-call check only, no fixed-point closure.
		const bodies = topLevelFunctionBodies(stripped);
		const direct = new Set<string>();
		for (const [name, body] of bodies) {
			if (
				/\bgetGlobalPiLensDir\s*\(/.test(body) ||
				BEST_EFFORT_LOCK_CALLS.some((needle) => body.includes(needle))
			) {
				direct.add(name);
			}
		}
		expect(direct.has("registerInstance")).toBe(false);
		// ...which would have let a test file calling ONLY registerInstance
		// (tests/clients/instance-registry.test.ts, among others) pass the
		// "touches a producer" check unflagged even with no isolation at all.
	});
});

/** Every `tests/**​/*.test.ts` file, repo-relative to `TESTS_ROOT`. */
const testFiles = listSourceFiles(TESTS_ROOT, {
	skipDeclarations: true,
}).filter((file) => file.endsWith(".test.ts"));

/** The literal target filenames the two registered producers write — the
 *  raw-`fs` idiom `tests/index-vanished-instance-wiring.test.ts` and
 *  `tests/clients/instance-reaper-backstop.test.ts` used, bypassing every
 *  producer SYMBOL entirely by reading `process.env.PI_LENS_HOME` (or
 *  `getGlobalPiLensDir()`) and joining the filename by hand. */
const TARGET_FILENAMES = [
	"instances.json",
	"orphan-backstop.json",
	"orphan-backstop.lock",
];

interface Touch {
	reason: "symbol" | "target-file";
	/** Empty for a "target-file" touch (no symbol call at all — a raw `fs` reach). */
	matchedSymbols: string[];
}

/** A test file resolves a producer's getGlobalPiLensDir() path when it CALLS
 *  (not merely imports, mocks, or type-references) one of the hazardous
 *  exported symbols above, OR when it names one of the producers' TARGET
 *  filenames in code together with any `PI_LENS_HOME`/`getGlobalPiLensDir(`
 *  reference — the raw-`fs` idiom neither symbol touches. */
function touchesGlobalDirRegistry(
	commentsBlankedStringsKept: string,
	stringsBlankedCode: string,
): Touch | undefined {
	const matchedSymbols = [...hazardousSymbols]
		.filter((name) =>
			new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(stringsBlankedCode),
		)
		.sort();
	if (matchedSymbols.length > 0) return { reason: "symbol", matchedSymbols };

	const namesTargetFile = TARGET_FILENAMES.some((filename) =>
		commentsBlankedStringsKept.includes(`"${filename}"`),
	);
	if (!namesTargetFile) return undefined;
	const referencesHome =
		/\bPI_LENS_HOME\b/.test(commentsBlankedStringsKept) ||
		/\bgetGlobalPiLensDir\s*\(/.test(stringsBlankedCode);
	return referencesHome
		? { reason: "target-file", matchedSymbols: [] }
		: undefined;
}

/** An ASSIGNMENT or object-literal KEY, never a bare reference — a plain
 *  `process.env.PI_LENS_HOME as string` (read-only) must not count, or this
 *  is exactly the false-clear the mutation test below demonstrates on
 *  `tests/index-vanished-instance-wiring.test.ts` itself. Matches
 *  `process.env.PI_LENS_HOME = x` (own-process pin) and an object literal's
 *  `PI_LENS_HOME: x` key (a spawned child's env, e.g.
 *  `tests/clients/instance-registry-race.test.ts`) without matching `===`. */
const PI_LENS_HOME_ASSIGNMENT = /\bPI_LENS_HOME\s*(?:=(?!=)|:)/;

/** The full, paren-matched text of a `vi.mock("...basename", factory)` /
 *  `vi.doMock(...)` call targeting `basename`, or `undefined` if the file
 *  never mocks it. */
function findMockCallText(
	commentsBlankedStringsKept: string,
	basename: string,
): string | undefined {
	const target = new RegExp(
		`\\bvi\\.(?:mock|doMock)\\(\\s*"[^"]*/${escapeRegExp(basename)}"`,
	).exec(commentsBlankedStringsKept);
	if (!target) return undefined;
	const openParenIndex = commentsBlankedStringsKept.indexOf("(", target.index);
	let depth = 0;
	let end = -1;
	for (let i = openParenIndex; i < commentsBlankedStringsKept.length; i++) {
		const ch = commentsBlankedStringsKept[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return undefined;
	return commentsBlankedStringsKept.slice(openParenIndex, end + 1);
}

/** True when the file mocks `basename` with a factory that OVERRIDES
 *  `symbolName` — names it as an object-literal key AND does not fall
 *  through to `actual.<symbolName>(` anywhere inside that mock call.
 *  `tests/clients/instance-reaper-registry-scan-escalation.test.ts`'s
 *  `readInstanceRegistry: async () => h.state.registry` qualifies (no
 *  `actual` at all); `tests/index-vanished-instance-wiring.test.ts`'s
 *  `sweepOrphans: async () => { await actual.sweepOrphans(); ... }` does
 *  NOT — it names the key but still calls straight through to the real,
 *  unpinned implementation, which is exactly why this repo's ONE real
 *  member of this sweep's population is caught rather than waved through by
 *  its incidental `vi.mock("../clients/instance-reaper.js", ...)`. */
function mockOverridesSymbol(
	commentsBlankedStringsKept: string,
	basename: string,
	symbolName: string,
): boolean {
	const callText = findMockCallText(commentsBlankedStringsKept, basename);
	if (callText === undefined) return false;
	if (!new RegExp(`\\b${escapeRegExp(symbolName)}\\s*:`).test(callText)) {
		return false;
	}
	return !new RegExp(`\\bactual\\.${escapeRegExp(symbolName)}\\s*\\(`).test(
		callText,
	);
}

/** Isolated when the file pins its own `PI_LENS_HOME`, overrides
 *  `file-utils.js`'s `getGlobalPiLensDir` (the universal isolator — every
 *  hazardous symbol's target path resolves through it), or — only when
 *  EVERY matched symbol is read-only — overrides `instance-registry.js`'s
 *  `readInstanceRegistry`. */
function isIsolated(
	commentsBlankedStringsKept: string,
	matchedSymbols: readonly string[],
): boolean {
	if (PI_LENS_HOME_ASSIGNMENT.test(commentsBlankedStringsKept)) return true;
	if (
		mockOverridesSymbol(
			commentsBlankedStringsKept,
			"file-utils.js",
			"getGlobalPiLensDir",
		)
	) {
		return true;
	}
	if (
		matchedSymbols.length > 0 &&
		matchedSymbols.every((name) => SYMBOLS_COVERED_BY_READ_MOCK.has(name)) &&
		mockOverridesSymbol(
			commentsBlankedStringsKept,
			"instance-registry.js",
			"readInstanceRegistry",
		)
	) {
		return true;
	}
	return false;
}

/** Exempted file (repo-relative to `tests/`) → reason. A reason is required
 *  and a stale one (the scan no longer flags it) fails loud — `auditRegistry`
 *  enforces both. */
const REGISTRY_ISOLATION_EXEMPTIONS: Readonly<Record<string, string>> = {
	"index-vanished-instance-wiring.test.ts":
		"#3042's own recurrence, the one this sweep exists to catch: no per-case " +
		"PI_LENS_HOME pin, so registerInstance/sweepOrphans race every sibling " +
		"Vitest fork over the run-shared registry — the exact CI reds on " +
		"#3023/#3026. Already fixed on PR #3048 " +
		"(apmantza/fix/3042-vanished-instance-dead-pid), open at the time this " +
		"sweep landed. Remove this entry the moment #3048 merges — an entry the " +
		"scan no longer flags is stale weight, not a screen (AGENTS.md).",
};

describe("no tests/**/*.test.ts file drives a producer's registry against the run-shared PI_LENS_HOME (#3042 recurrence)", () => {
	function scanFlagged(): string[] {
		const flagged: string[] = [];
		for (const file of testFiles) {
			const source = fs.readFileSync(file, "utf8");
			const commentsBlankedStringsKept = stripSource(source, {
				strings: "keep",
			});
			const stringsBlankedCode = stripSource(source, { strings: "blank" });
			const touch = touchesGlobalDirRegistry(
				commentsBlankedStringsKept,
				stringsBlankedCode,
			);
			if (!touch) continue;
			if (isIsolated(commentsBlankedStringsKept, touch.matchedSymbols))
				continue;
			flagged.push(relativePosix(TESTS_ROOT, file));
		}
		return flagged;
	}

	it("registered-or-fail: every unpinned reach into a producer's registry is named or exempted with a reason", () => {
		assertNonEmptyScan("tests/ registry-isolation walk", testFiles.length, 900);
		const flagged = scanFlagged();
		const audit = auditRegistry({
			sweepName: "tests/ registry isolation",
			flagged,
			registered: [],
			exemptions: REGISTRY_ISOLATION_EXEMPTIONS,
			// Zero is the HEALTHY steady state here (once #3048 merges, nothing
			// is flagged) — unlike a tagged-seam sweep, this floor would fail the
			// day the codebase is actually clean. `minScanned` below is what
			// still catches a broken walk (#1718's shape).
			minFlagged: 0,
			scannedCount: testFiles.length,
			minScanned: 900,
			remediation:
				"Pin this file's own process.env.PI_LENS_HOME in beforeEach/" +
				"afterEach (tests/clients/lsp-budget.test.ts's shape), or mock " +
				"clients/file-utils.js's getGlobalPiLensDir (tests/clients/" +
				"instance-registry.test.ts's shape) — see #3042/#3050.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("red-first proof: tests/index-vanished-instance-wiring.test.ts is caught by the walk (pre-#3048), not waved through by its exemption alone", () => {
		// The exemption above is what keeps the audit clean TODAY. This proves
		// the scan's OWN classification is what the exemption reasons about — not
		// that the exemption is silently doing all the work while the detector
		// itself is inert. Reads the file exactly as the main sweep does.
		const file = testFiles.find((candidate) =>
			candidate.endsWith("/index-vanished-instance-wiring.test.ts"),
		);
		expect(file, "fixture moved or renamed").toBeDefined();
		const source = fs.readFileSync(file as string, "utf8");
		const commentsBlankedStringsKept = stripSource(source, { strings: "keep" });
		const stringsBlankedCode = stripSource(source, { strings: "blank" });

		const touch = touchesGlobalDirRegistry(
			commentsBlankedStringsKept,
			stringsBlankedCode,
		);
		expect(touch).toBeDefined();
		expect(touch?.matchedSymbols).toEqual(["sweepOrphans"]);
		expect(
			isIsolated(commentsBlankedStringsKept, touch?.matchedSymbols ?? []),
		).toBe(false);

		// And with the exemption removed, the full audit reds and names exactly
		// this file — the actual "re-point at the run-shared home, paste the
		// red" proof (#3042's PR #3048 has not landed yet, so this IS that
		// file's real, unmodified, pre-fix content).
		const withoutExemption = auditRegistry({
			sweepName: "tests/ registry isolation (exemption removed)",
			flagged: scanFlagged(),
			registered: [],
			exemptions: {},
			minFlagged: 0,
		});
		expect(withoutExemption.problems.length).toBeGreaterThan(0);
		expect(withoutExemption.unaccounted).toContain(
			"index-vanished-instance-wiring.test.ts",
		);
	});

	it("mutation-proof: loosening the PI_LENS_HOME check to a bare reference falsely clears the known-bad file", () => {
		// tests/index-vanished-instance-wiring.test.ts's own
		// `path.join(process.env.PI_LENS_HOME as string, "instances.json")` is a
		// READ, not a pin — the exact false-clear this predicate must refuse.
		const file = testFiles.find((candidate) =>
			candidate.endsWith("/index-vanished-instance-wiring.test.ts"),
		);
		const source = fs.readFileSync(file as string, "utf8");
		const commentsBlankedStringsKept = stripSource(source, { strings: "keep" });

		expect(isIsolated(commentsBlankedStringsKept, ["sweepOrphans"])).toBe(
			false,
		);

		// MUTATION: drop the assignment/key requirement, match the bare
		// identifier instead — the naive version a first draft would reach for.
		const bareReferenceMatches = /\bPI_LENS_HOME\b/.test(
			commentsBlankedStringsKept,
		);
		expect(bareReferenceMatches).toBe(true); // the identifier IS present...
		// ...so a bare-reference check would WRONGLY call this file isolated,
		// reintroducing exactly the recurrence #3042 shipped.
		expect(bareReferenceMatches).not.toBe(
			PI_LENS_HOME_ASSIGNMENT.test(commentsBlankedStringsKept),
		);
	});

	it("mutation-proof: a mock naming a producer symbol but still falling through to `actual.<symbol>(` does not isolate", () => {
		// tests/index-vanished-instance-wiring.test.ts mocks instance-reaper.js
		// and NAMES sweepOrphans as a key — a naive check ("is this producer
		// mocked at all, with this key present") would clear it. Only the
		// pass-through check below refuses that.
		const file = testFiles.find((candidate) =>
			candidate.endsWith("/index-vanished-instance-wiring.test.ts"),
		);
		const source = fs.readFileSync(file as string, "utf8");
		const commentsBlankedStringsKept = stripSource(source, { strings: "keep" });

		const callText = findMockCallText(
			commentsBlankedStringsKept,
			"instance-reaper.js",
		);
		expect(callText).toBeDefined();
		expect(callText as string).toMatch(/\bsweepOrphans\s*:/);

		// MUTATION: drop the `actual.<symbol>(` pass-through check — "the key is
		// named" alone is treated as an override.
		const naiveOverridden = /\bsweepOrphans\s*:/.test(callText as string);
		expect(naiveOverridden).toBe(true);
		expect(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"instance-reaper.js",
				"sweepOrphans",
			),
		).toBe(false);
		expect(naiveOverridden).not.toBe(
			mockOverridesSymbol(
				commentsBlankedStringsKept,
				"instance-reaper.js",
				"sweepOrphans",
			),
		);
	});

	it("mutation-proof: a comment merely naming the isolation idioms and target files does not satisfy the walk (detectors match code, not prose)", () => {
		// This test file's OWN docblocks above name process.env.PI_LENS_HOME,
		// vi.mock("...file-utils.js"...), and every hazardous symbol in prose —
		// if the scan read comments, this describe block would trivially clear
		// or flag every file just by matching its own explanatory text.
		const commentOnly = [
			'// process.env.PI_LENS_HOME = "/pinned";',
			'// vi.mock("../../clients/file-utils.js", () => ({ getGlobalPiLensDir: () => dir }));',
			'// calls registerInstance("/x") and reads "instances.json"',
		].join("\n");
		const commentsBlankedStringsKept = stripSource(commentOnly, {
			strings: "keep",
		});
		const stringsBlankedCode = stripSource(commentOnly, { strings: "blank" });

		expect(isIsolated(commentsBlankedStringsKept, [])).toBe(false);
		expect(
			touchesGlobalDirRegistry(commentsBlankedStringsKept, stringsBlankedCode),
		).toBeUndefined();
	});
});
