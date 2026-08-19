import { describe, expect, it } from "vitest";

import {
	findInFlightDeclarations,
	scanInFlightDeclarations,
} from "../../tests/support/single-flight-scan.js";

/**
 * Every hand-rolled in-flight declaration `clients/` still carries, and why.
 *
 * `clients/single-flight.ts` (#1753) owns the share, the clear-in-finally, the
 * successor check, and the trailing-rerun bit. Two sites are converted; these
 * are not. A NEW entry has to be added here on purpose, with a reason someone
 * reads — which is the whole ratchet. "Not migrated yet" is an acceptable
 * reason; silence is not.
 *
 * Keys are `clients/`-relative-path:symbol.
 */
const EXEMPTIONS: Record<string, string> = {
	// ── The `ensureInFlight` availability family: #1753's migration backlog ──
	// Identical shape to the two converted sites (biome-client, sg-runner):
	// a latch short-circuit, then at-most-one probe/auto-install. #1753 converts
	// two as proof and burns the rest down opportunistically.
	"dead-code-client.ts:ensureInFlight":
		"backlog: ensureAvailable family, #1753",
	"dependency-checker.ts:ensureInFlight":
		"backlog: ensureAvailable family, #1753",
	"knip-client.ts:ensureInFlight": "backlog: ensureAvailable family, #1753",
	"security-scan-client.ts:ensureInFlight":
		"backlog: ensureAvailable family, #1753",
	"installer/index.ts:ensureInFlight":
		"backlog: ensureTool's per-tool install map, #1753",

	// ── Per-key result-sharing maps: same primitive, different payload ──
	"dead-code-client.ts:inFlight": "backlog: per-cwd analyze dedupe, #1753",
	"dependency-checker.ts:checkInFlight": "backlog: per-key check dedupe, #1753",
	"dependency-checker.ts:scanInFlight": "backlog: per-root scan dedupe, #1753",
	"knip-client.ts:inFlight": "backlog: per-cwd analyze dedupe, #1753",
	"security-scan-client.ts:inFlight": "backlog: per-cwd scan dedupe, #1753",
	"jscpd-client.ts:inFlight": "backlog: per-cwd analyze dedupe, #1753",
	"dispatch/runners/helm-lint.ts:inFlightByChartRoot":
		"backlog: per-chart-root dedupe, #1753",
	"dispatch/runners/helm-render.ts:inFlightByChartRoot":
		"backlog: per-chart-root dedupe, #1753",
	"dispatch/runners/utils/lazy-installer.ts:inFlight":
		"backlog: per-tool install dedupe, #1753",
	"dispatch/runners/utils/runner-helpers.ts:managedVerifyInFlight":
		"backlog: #1674's generation-guarded verify map, #1753",
	"dispatch/runners/utils/runner-helpers.ts:resolveInstallInFlightByCwd":
		"backlog: #1674's per-cwd install map, #1753",
	"dispatch/runners/utils/runner-helpers.ts:sgAvailableInFlight":
		"backlog: ast-grep availability dedupe, #1753",
	"lsp/config.ts:configInFlight": "backlog: per-workspace config load, #1753",
	"lsp/jvm-runtime.ts:inFlightJavaProbe": "backlog: single JVM probe, #1753",
	"mcp/session.ts:inFlightIpcTurnEnds":
		"backlog: per-cwd Stop-hook pass (#1274), #1753",
	"package-manager.ts:inFlightProbes":
		"backlog: per-package-manager probe dedupe, #1753",
	"installer/index.ts:_probeCacheWriteInFlight":
		"backlog: single probe-cache flush, #1753",
	// Found by review round 1's widened regex: an interface member, which the
	// modifier-only version of this scan never saw. `lsp/index.ts:2675-2702` is
	// the primitive's shape line for line, identity-checked clear included —
	// the highest-value migration left on this list.
	"lsp/index.ts:inFlight":
		"backlog: LSP spawn dedupe keyed serverId:root, with an " +
		"identity-checked clear at lsp/index.ts:2701 — hand-rolled " +
		"singleFlight, #1753",

	// ── Not the primitive's shape: these hold no promise per key ──
	"ndjson-logger.ts:inFlightBatch":
		"exempt: the BATCH of queue items one writer is currently flushing, not " +
		"a per-key promise registry — there is one writer per file and nothing " +
		"joins it",
	"project-report.ts:inFlightGraphBuilds":
		"exempt: a Set<string> re-entry guard, not a shared promise per key — " +
		"nothing joins a running build, the second caller simply skips",
	"runtime-coordinator.ts:_startupScansInFlight":
		"exempt: a Map<string, number> COUNTER of outstanding scans, not a " +
		"promise registry — it answers how many, never which promise to join",
	"runtime-tool-result.ts:inFlightPipelines":
		"exempt: a nested map of pipeline RECORDS (state a turn reads and " +
		"mutates), not a dedupe of concurrent callers onto one promise",

	// ── Forward-declared: see FORWARD_DECLARED below ──
	"installer/managed-tool-refresh.ts:refreshInFlight":
		"backlog: #1730's managed-tool refresh guard — hand-rolled with an " +
		"identity-checked clear, migrate to singleFlight, #1753",
};

/**
 * Exemptions written for declarations that are not on this branch YET.
 *
 * Normally an exemption naming a declaration that does not exist is a lie the
 * next reader would trust, and the stale check fails it. This set is the one
 * narrow exception: PR #1746 declares `refreshInFlight` in
 * `installer/managed-tool-refresh.ts` and merges BEFORE this branch. Writing
 * its entry ahead of time means neither PR has to be held for the other, and
 * neither author has to notice the interaction.
 *
 * The cost is real and bounded: for exactly these keys, "the exemption still
 * describes something" is unverified until the declaration lands. Keep the set
 * empty in steady state. An entry that never lands is dead weight, and the only
 * thing catching that is a person reading this comment.
 */
const FORWARD_DECLARED = new Set([
	"installer/managed-tool-refresh.ts:refreshInFlight",
]);

describe("singleFlight ratchet (#1753)", () => {
	it("flags every hand-rolled in-flight declaration outside the primitive", () => {
		const unexplained = scanInFlightDeclarations().filter(
			(d) => !EXEMPTIONS[d.key],
		);
		expect(
			unexplained.map((d) => `${d.file}:${d.line} ${d.symbol}`),
			"New at-most-one-in-flight state must use createSingleFlight() from " +
				"clients/single-flight.ts (#1753). If it genuinely is not that shape, " +
				"add it to EXEMPTIONS in this file with a reason that says why.",
		).toEqual([]);
	});

	it("has no stale exemptions", () => {
		// A site that gets migrated (or deleted) must take its entry with it.
		// Otherwise the list rots into a lie, and the next reader trusts it.
		const live = new Set(scanInFlightDeclarations().map((d) => d.key));
		const stale = Object.keys(EXEMPTIONS).filter(
			(key) => !live.has(key) && !FORWARD_DECLARED.has(key),
		);
		expect(stale, "these exemptions no longer match any declaration").toEqual(
			[],
		);
	});

	it("keeps every forward declaration listed in EXEMPTIONS", () => {
		// A forward declaration only suppresses the stale check. It must still
		// carry a reason like any other entry, or it would be a bare hole.
		const orphans = [...FORWARD_DECLARED].filter((key) => !EXEMPTIONS[key]);
		expect(orphans).toEqual([]);
	});

	it("gives every exemption a reason", () => {
		const thin = Object.entries(EXEMPTIONS).filter(
			([, reason]) => reason.trim().length < 20,
		);
		expect(thin.map(([key]) => key)).toEqual([]);
	});

	it("does not exempt the two converted sites", () => {
		// biome-client and sg-runner are the #1753 proof migrations. If either
		// reappears here, the conversion was reverted and this list would quietly
		// bless it.
		const converted = Object.keys(EXEMPTIONS).filter(
			(key) =>
				key.startsWith("biome-client.ts:") || key.startsWith("sg-runner.ts:"),
		);
		expect(converted).toEqual([]);
	});
});

describe("singleFlight ratchet — the scan itself", () => {
	it("catches a hand-rolled class field", () => {
		const found = findInFlightDeclarations(
			"fake-client.ts",
			[
				"export class FakeClient {",
				"\tprivate ensureInFlight: Promise<boolean> | null = null;",
				"}",
			].join("\n"),
		);
		expect(found.map((d) => d.symbol)).toEqual(["ensureInFlight"]);
		expect(found[0].key).toBe("fake-client.ts:ensureInFlight");
		expect(found[0].line).toBe(2);
	});

	it("catches a hand-rolled module-level map", () => {
		const found = findInFlightDeclarations(
			"fake.ts",
			"const inFlightByCwd = new Map<string, Promise<void>>();\n",
		);
		expect(found.map((d) => d.symbol)).toEqual(["inFlightByCwd"]);
	});

	it("does not fire on a comment or a string that merely names one", () => {
		// The false-positive mode `session-state-scan.ts` documents: a doc
		// comment naming a field must not read as a declaration of it.
		const found = findInFlightDeclarations(
			"fake.ts",
			[
				"/** const ensureInFlight: Promise<boolean> | null = null; */",
				'const label = "const ensureInFlight = null;";',
			].join("\n"),
		);
		expect(found).toEqual([]);
	});

	it("catches a modifier-less class field that carries a type annotation", () => {
		// Review round 1's finding: the migrated sites' exact field minus the
		// word `private`. A modifier-only regex sails past it.
		const found = findInFlightDeclarations(
			"fake-client.ts",
			[
				"export class FakeClient {",
				"\tprobeInFlight: Promise<void> | null = null;",
				"}",
			].join("\n"),
		);
		expect(found.map((d) => d.symbol)).toEqual(["probeInFlight"]);
	});

	it("catches an optional modifier-less field", () => {
		const found = findInFlightDeclarations(
			"fake.ts",
			"interface State {\n\tinFlight?: Map<string, Promise<void>>;\n}\n",
		);
		expect(found.map((d) => d.symbol)).toEqual(["inFlight"]);
	});

	it("catches a #private class field", () => {
		const found = findInFlightDeclarations(
			"fake-client.ts",
			"class C {\n\t#ensureInFlight = new Map<string, Promise<void>>();\n}\n",
		);
		expect(found.map((d) => d.symbol)).toEqual(["ensureInFlight"]);
	});

	it("does not fire on a bare assignment to an existing field", () => {
		// `this.ensureInFlight = null` is the clear, not a new declaration.
		const found = findInFlightDeclarations(
			"fake.ts",
			"\t\t\tensureInFlight = null;\n",
		);
		expect(found).toEqual([]);
	});
});
