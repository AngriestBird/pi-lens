/**
 * Coverage guard for the #1634 finding-delivery gate.
 *
 * Review round F1/F2 findings on the first version of this file:
 *   - F1: `expect(src).toContain(gateName)` matched the IMPORT line and a doc
 *     comment mentioning the gate by name — stubbing the three real gate
 *     calls to identity and deleting the age interpolations left the guard
 *     19/19 green.
 *   - F2: `DELIVERY_SURFACES` and `EXPECTED_SURFACE_IDS` were two hand lists
 *     that only checked each other — a brand-new ungated `advisoryParts.push`
 *     seam passed silently.
 *
 * Fix: (1) every gate/label claim is checked against a literal, comment/
 * string-STRIPPED `evidence` substring declared per surface (see
 * clients/finding-delivery-gate.ts's `DeliverySurfaceEntry.evidence` doc) —
 * chosen to be surface-specific so a stub of a DIFFERENT surface's call to
 * the same shared gate function cannot satisfy it. (2) `clients/runtime-turn.ts`
 * and `tools/lens-diagnostics.ts` are REALLY scanned for their render-seam
 * shapes (`blockerParts.push`/`advisoryParts.push`/`staleSecretParts.push`,
 * and `format*Mode` function definitions) and every seam found must carry an
 * `@delivery-surface: <id>` tag naming a real registry entry — an untagged
 * seam fails the suite, exactly the session-state sweep's "registered or
 * fail" pattern.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import {
	assertNoDeliveryBypass,
	DELIVERY_SURFACES,
	formatCacheAgeLabel,
	type DeliverySurfaceEntry,
} from "../../clients/finding-delivery-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

function readSource(relativeFile: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
}

const sourceCache = new Map<string, string>();
function source(file: string): string {
	let cached = sourceCache.get(file);
	if (cached === undefined) {
		cached = readSource(file);
		sourceCache.set(file, cached);
	}
	return cached;
}

const EXPECTED_SURFACE_IDS = [
	"runtime-turn:secrets-gitleaks",
	"runtime-turn:secrets-trivy",
	"runtime-turn:govulncheck-advisory",
	"runtime-turn:unresolved-inline-blocker",
	"runtime-turn:stale-secrets-tier",
	"runtime-turn:trivy-critical-blocker",
	"runtime-turn:trivy-cve-advisory",
	"runtime-turn:trivy-license-advisory",
	"runtime-turn:dead-code-advisory",
	"runtime-turn:knip-blocker",
	"runtime-turn:knip-advisory",
	"runtime-turn:actionable-warnings-advisory",
	"runtime-turn:code-quality-warnings-advisory",
	"runtime-turn:disposition-suppressed-notice",
	"runtime-turn:cascade-blocker",
	"runtime-turn:cascade-coverage-advisory",
	"runtime-turn:call-graph-advisory",
	"lens-diagnostics:mode-full",
	"lens-diagnostics:mode-all",
	"lens-diagnostics:mode-delta",
	"widget-state:footer",
	"agent-nudge:context-message",
	"project-diagnostics:persisted-snapshot",
].sort();

// ── Real seam scan (#1634 review F2) ────────────────────────────────────────
//
// `stripCommentsAndStrings` blanks comments/string contents IN PLACE (same
// line count, same column layout for anything left) — the same tool the
// session-state sweep uses to avoid mis-lexing a commented-out declaration as
// a real one. We reuse it here so a seam-shaped call inside a comment or a
// string literal (e.g. this very file's own doc comments) is never counted
// as a real seam, and a REAL seam hidden inside a template string is never
// missed either.

const TAG_RE = /@delivery-surface:\s*([\w:,-]+)/;

/** One call-shaped seam found in the STRIPPED source, 1-based line number. */
interface SeamHit {
	line: number;
	text: string;
}

function findSeams(strippedSource: string, pattern: RegExp): SeamHit[] {
	const lines = strippedSource.split("\n");
	const hits: SeamHit[] = [];
	lines.forEach((text, index) => {
		if (pattern.test(text)) hits.push({ line: index + 1, text: text.trim() });
	});
	return hits;
}

/**
 * For each seam hit, look up to `window` lines BACKWARD in the RAW (unstripped)
 * source for an `@delivery-surface:` tag comment. Returns, per seam, the tag
 * ids found (comma-separated in one tag = multiple ids) or `[]` if untagged.
 */
function tagsForSeams(
	rawSource: string,
	seams: SeamHit[],
	window = 4,
): Array<{ seam: SeamHit; ids: string[] }> {
	const rawLines = rawSource.split("\n");
	return seams.map((seam) => {
		const start = Math.max(0, seam.line - 1 - window);
		const slice = rawLines.slice(start, seam.line - 1);
		for (let i = slice.length - 1; i >= 0; i--) {
			const m = TAG_RE.exec(slice[i]);
			if (m) return { seam, ids: m[1].split(",").map((s) => s.trim()) };
		}
		return { seam, ids: [] };
	});
}

/**
 * Scanner entry point, exported so the red-proof tests below can run it
 * against a synthetic FIXTURE string (an untagged/mistagged mutant) without
 * touching the real repo files.
 */
function scanUntaggedOrMistaggedSeams(
	rawSource: string,
	seamPattern: RegExp,
	registryIds: ReadonlySet<string>,
): string[] {
	const stripped = stripCommentsAndStrings(rawSource);
	const seams = findSeams(stripped, seamPattern);
	const tagged = tagsForSeams(rawSource, seams);
	const problems: string[] = [];
	for (const { seam, ids } of tagged) {
		if (ids.length === 0) {
			problems.push(`line ${seam.line}: untagged seam — ${seam.text}`);
			continue;
		}
		for (const id of ids) {
			if (!registryIds.has(id)) {
				problems.push(
					`line ${seam.line}: tagged "${id}", which is not in DELIVERY_SURFACES — ${seam.text}`,
				);
			}
		}
	}
	return problems;
}

const RUNTIME_TURN_SEAM_PATTERN =
	/\b(blockerParts|advisoryParts|staleSecretParts)\.push\(/;
const LENS_DIAGNOSTICS_MODE_FN_PATTERN = /^(?:async\s+)?function\s+format\w*Mode\(/;

describe("finding-delivery-gate real seam scan (#1634 review F2)", () => {
	const registryIds = new Set(Object.keys(DELIVERY_SURFACES));

	it("every blockerParts/advisoryParts/staleSecretParts push in runtime-turn.ts is tagged and registered", () => {
		const problems = scanUntaggedOrMistaggedSeams(
			source("clients/runtime-turn.ts"),
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("every mode=<x> report function in lens-diagnostics.ts is tagged and registered", () => {
		const problems = scanUntaggedOrMistaggedSeams(
			source("tools/lens-diagnostics.ts"),
			LENS_DIAGNOSTICS_MODE_FN_PATTERN,
			registryIds,
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("found at least one real seam in each scanned file (the scan itself is not a false negative)", () => {
		const runtimeTurnStripped = stripCommentsAndStrings(source("clients/runtime-turn.ts"));
		const lensDiagStripped = stripCommentsAndStrings(source("tools/lens-diagnostics.ts"));
		expect(findSeams(runtimeTurnStripped, RUNTIME_TURN_SEAM_PATTERN).length).toBeGreaterThan(15);
		expect(findSeams(lensDiagStripped, LENS_DIAGNOSTICS_MODE_FN_PATTERN).length).toBeGreaterThanOrEqual(3);
	});

	// RED PROOF (F2): reproduces the reviewer's exact mutant — a brand-new
	// ungated `advisoryParts.push` seam with no tag — against a FIXTURE, not
	// the real file, so this test's own correctness never depends on nobody
	// breaking the real file later.
	it("RED PROOF: a new untagged advisoryParts.push seam is flagged, not silently accepted", () => {
		const mutantSource = `
function handleTurnEnd() {
	// a brand-new surface nobody registered
	advisoryParts.push("some new finding with no freshness gate");
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/untagged seam/);
	});

	it("RED PROOF: a tag naming an id absent from the registry is flagged", () => {
		const mutantSource = `
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:totally-made-up-id
	advisoryParts.push(report);
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/not in DELIVERY_SURFACES/);
	});

	it("RED PROOF: a seam-shaped call inside a COMMENT is not mistaken for a real seam", () => {
		// If the scanner didn't strip comments, this single-line comment would
		// register as an untagged seam and the test would fail even though
		// nothing here actually renders anything.
		const mutantSource = `
function handleTurnEnd() {
	// see also advisoryParts.push(x) in the sibling module for reference
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems).toEqual([]);
	});
});

describe("finding-delivery-gate enumeration (#1634)", () => {
	it("registers exactly the surfaces enumerated from the render seams", () => {
		expect(Object.keys(DELIVERY_SURFACES).sort()).toEqual(EXPECTED_SURFACE_IDS);
	});

	it("every registered surface passes the no-bypass validator", () => {
		expect(() => assertNoDeliveryBypass()).not.toThrow();
	});

	it("RED PROOF: a surface with a third mode is rejected, not silently accepted", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			// @ts-expect-error deliberately malformed for the red-proof
			"synthetic:bypass": { mode: "bypass", file: "nowhere.ts", description: "x", evidence: [] },
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/synthetic:bypass/);
	});

	it("RED PROOF: a gated surface that names zero gates is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:empty-gate": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: [],
				evidence: ["x"],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/synthetic:empty-gate/);
	});

	it("RED PROOF: a gated surface that names zero evidence is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:no-evidence": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: ["someGate"],
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/names no evidence/);
	});

	it("RED PROOF: a labeled surface missing reason/ageSource is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:bare-label": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "",
				ageSource: "",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/synthetic:bare-label/);
	});

	it("RED PROOF: a non-live labeled surface with no evidence is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:label-no-evidence": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "some reason",
				ageSource: "SomeCache.scannedAt",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/names no evidence/);
	});

	it("RED PROOF: status=partial with no partialReason is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:partial-no-reason": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "some reason",
				ageSource: "live",
				evidence: [],
				status: "partial",
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/status=partial/);
	});
});

// ── Evidence ground-truth (#1634 review F1) ─────────────────────────────────
//
// For each surface with `evidence.length > 0`, every declared string must
// occur — as a literal substring of the COMMENT-stripped source — at least
// `evidenceMin` (default 1) times. Comments are stripped (STRINGS are kept
// verbatim, unlike the seam scan above) so a doc comment MENTIONING a gate by
// name (exactly what fooled the original version of this guard) cannot
// satisfy the check, while an evidence string that is itself a literal
// call/template argument (e.g. `store: "gitleaks"`, or the interpolated
// `${trivyAgeLabel}` fragment inside a template literal) still matches —
// `stripCommentsAndStrings` would blank those out too, which is correct for
// SEAM detection (avoid matching push-shaped text inside an unrelated
// string) but wrong here, where the surface's own evidence often IS a string
// literal argument.
function stripCommentsOnly(source: string): string {
	let out = "";
	let i = 0;
	const n = source.length;
	while (i < n) {
		const c = source[i];
		const c2 = source[i + 1];
		if (c === "/" && c2 === "/") {
			while (i < n && source[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && c2 === "*") {
			i += 2;
			while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out += c;
			i++;
			while (i < n && source[i] !== quote) {
				if (source[i] === "\\") {
					out += source[i];
					i++;
					if (i < n) {
						out += source[i];
						i++;
					}
					continue;
				}
				out += source[i];
				i++;
			}
			if (i < n) {
				out += source[i];
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

describe("finding-delivery-gate evidence ground-truth (#1634 review F1)", () => {
	const strippedCache = new Map<string, string>();
	function stripped(file: string): string {
		let cached = strippedCache.get(file);
		if (cached === undefined) {
			cached = stripCommentsOnly(source(file));
			strippedCache.set(file, cached);
		}
		return cached;
	}

	for (const [id, entry] of Object.entries(DELIVERY_SURFACES)) {
		if (entry.evidence.length === 0) continue;
		it(`"${id}" evidence is call-shaped and present in ${entry.file} (comments/strings stripped)`, () => {
			const src = stripped(entry.file);
			const min = entry.evidenceMin ?? 1;
			for (const needle of entry.evidence) {
				const count = countOccurrences(src, needle);
				expect(
					count,
					`expected ${entry.file} to contain "${needle}" at least ${min}x for surface ${id} (comment-stripped), found ${count}`,
				).toBeGreaterThanOrEqual(min);
			}
		});
	}

	// RED PROOF (F1): the reviewer's exact stub — the real evidence-bearing
	// code is gone, but a DOC COMMENT still mentions the gate's name with an
	// open paren, e.g. "the code calls gateFindingsByPathFreshness(...) here".
	// Against a fixture: strip-then-search must NOT find it.
	it("RED PROOF: a stub that removes the real call but keeps a comment mention is caught", () => {
		const stubbedFixture = `
// this surface used to call formatCacheAgeLabel(scannedAt) but no longer does
const trivyAgeLabel = "";
let report = "CRITICAL dependency CVEs (trivy). Upgrade before shipping:\\n";
`;
		const strippedFixture = stripCommentsOnly(stubbedFixture);
		const evidence = "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}";
		expect(countOccurrences(strippedFixture, evidence)).toBe(0);
	});

	it("control: the SAME evidence string is found once real interpolation is present", () => {
		const fixedFixture = `
const trivyAgeLabel = formatCacheAgeLabel(scannedAt);
let report = \`CRITICAL dependency CVEs (trivy, \${trivyAgeLabel}). Upgrade before shipping:\\n\`;
`;
		const strippedFixture = stripCommentsOnly(fixedFixture);
		const evidence = "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}";
		expect(countOccurrences(strippedFixture, evidence)).toBeGreaterThanOrEqual(1);
	});
});

describe("formatCacheAgeLabel (#1634)", () => {
	it("renders a whole-minute age for a recent scan", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 12, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 12m ago");
	});

	it("renders an exact-hour age past 60 minutes", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 4, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 0, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 3h ago");
	});

	// F5: a naive Math.round(minutes / 60) reported "1h" at 89 minutes.
	it("does not round UP to the next hour before the hour is complete (F5)", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 8, 29, 0); // 89 minutes later
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 1h 29m ago");
	});

	it("degrades to an honest unknown label on an empty/unparseable timestamp", () => {
		expect(formatCacheAgeLabel("")).toBe("scan age unknown");
		expect(formatCacheAgeLabel(undefined)).toBe("scan age unknown");
		expect(formatCacheAgeLabel("not-a-date")).toBe("scan age unknown");
	});

	it("never reports a negative age on clock skew", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 6, 59, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned <1m ago");
	});
});
