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
	"dead-code-client.ts:ensureInFlight": "backlog: ensureAvailable family, #1753",
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

	// ── Not the primitive's shape: these hold no promise per key ──
	"project-report.ts:inFlightGraphBuilds":
		"exempt: a Set<string> re-entry guard, not a shared promise per key — " +
		"nothing joins a running build, the second caller simply skips",
	"runtime-coordinator.ts:_startupScansInFlight":
		"exempt: a Map<string, number> COUNTER of outstanding scans, not a " +
		"promise registry — it answers how many, never which promise to join",
	"runtime-tool-result.ts:inFlightPipelines":
		"exempt: a nested map of pipeline RECORDS (state a turn reads and " +
		"mutates), not a dedupe of concurrent callers onto one promise",
};

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
		const stale = Object.keys(EXEMPTIONS).filter((key) => !live.has(key));
		expect(stale, "these exemptions no longer match any declaration").toEqual(
			[],
		);
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
			(key) => key.startsWith("biome-client.ts:") || key.startsWith("sg-runner.ts:"),
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
			'const inFlightByCwd = new Map<string, Promise<void>>();\n',
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

	it("does not fire on a bare assignment to an existing field", () => {
		// `this.ensureInFlight = null` is the clear, not a new declaration.
		const found = findInFlightDeclarations(
			"fake.ts",
			"\t\t\tensureInFlight = null;\n",
		);
		expect(found).toEqual([]);
	});
});
