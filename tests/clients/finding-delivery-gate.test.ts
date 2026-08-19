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
 * For each seam hit, the tag binds to EXACTLY the immediately preceding
 * NON-BLANK raw line — no lookback window, no "nearest tag wins" (#1634
 * review round R1a: a 4-line lookback window let a NEW untagged seam
 * silently INHERIT the previous seam's tag — the most natural way someone
 * adds a new advisory without registering it: paste a second `push` call
 * right after an already-tagged one). Each tag LINE can bind at most one
 * seam — tracked in `consumedTagLines` — so two seams can never share one
 * tag comment.
 */
function tagsForSeams(
	rawSource: string,
	seams: SeamHit[],
): Array<{ seam: SeamHit; ids: string[] }> {
	const rawLines = rawSource.split("\n");
	const consumedTagLines = new Set<number>();
	return seams.map((seam) => {
		let i = seam.line - 2; // 0-based index of the raw line just above the seam
		while (i >= 0 && rawLines[i].trim() === "") i--;
		if (i < 0) return { seam, ids: [] };
		const m = TAG_RE.exec(rawLines[i]);
		if (!m || consumedTagLines.has(i)) return { seam, ids: [] };
		consumedTagLines.add(i);
		return { seam, ids: m[1].split(",").map((s) => s.trim()) };
	});
}

/** Every real seam in `rawSource`, paired with its (possibly empty) tag ids. */
function scanTaggedSeams(
	rawSource: string,
	seamPattern: RegExp,
): Array<{ seam: SeamHit; ids: string[] }> {
	const stripped = stripCommentsAndStrings(rawSource);
	const seams = findSeams(stripped, seamPattern);
	return tagsForSeams(rawSource, seams);
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
	const problems: string[] = [];
	for (const { seam, ids } of scanTaggedSeams(rawSource, seamPattern)) {
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

	// RED PROOF (R1a): reproduces the reviewer's exact "proximity laundering"
	// probe — a second seam pasted right after an already-tagged one, with no
	// tag of its own, must NOT inherit the first seam's tag. This is the
	// natural way someone adds a new advisory: copy-paste an existing
	// `push` call and edit the message, leaving the tag comment where it was.
	it("RED PROOF: a second untagged seam right after a tagged one does not inherit its tag", () => {
		const mutantSource = `
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:knip-advisory
	advisoryParts.push("the real, registered finding");
	advisoryParts.push("a brand-new finding pasted right after it — unregistered");
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBe(1);
		expect(problems[0]).toMatch(/untagged seam/);
		// Line 4 is the tagged (real) seam; line 5 is the untagged pasted-after
		// one — the failure must name line 5, not silently accept it via
		// inheritance from line 4's tag.
		expect(problems[0]).toContain("line 5:");
	});

	// RED PROOF (R1a): a blank-line gap between the tag and its seam still
	// binds correctly (blank lines are the only thing the lookback skips) —
	// and a SECOND seam after a blank gap does NOT reach back past the first
	// seam to re-use the same tag.
	it("RED PROOF: a tag cannot bind two seams even across a blank-line gap", () => {
		const mutantSource = `
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:knip-advisory

	advisoryParts.push("the real, registered finding");

	advisoryParts.push("a second finding, blank-line-separated, still unregistered");
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBe(1);
		// Line 5 is the tagged (real) seam; line 7 is the blank-separated
		// second seam, which must still be reported untagged on its own line.
		expect(problems[0]).toContain("line 7:");
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

// ── Evidence ground-truth (#1634 review F1, R1b, R2) ────────────────────────
//
// For each surface with `evidence.length > 0`, every declared string must
// occur — as a literal substring of the COMMENT-stripped source (STRINGS are
// kept verbatim, unlike the seam scan above, since a surface's evidence is
// often itself a string/template argument like `store: "gitleaks"` or the
// interpolated `${trivyAgeLabel}` fragment) — at least `evidenceMin` times,
// WITHIN THE RIGHT SCOPE:
//
//   - R1b ("valid-tag laundering"): for a `clients/runtime-turn.ts` surface
//     with its own tagged seam(s), the scope is that seam's OWN region
//     (a bounded window around the tag), not the whole file. Checking the
//     whole file let an ungated seam tagged with an EXISTING gated id pass,
//     because that id's real evidence exists somewhere else entirely — this
//     ties the proof to the SPECIFIC seam the tag claims to cover.
//   - R2 ("identity-stub laundering"): for a `gated` surface, an evidence
//     occurrence must sit within a tight line window of a CALL-SHAPED
//     occurrence of one of its declared `gates` (`name(`) — not just the
//     argument literal, which survives swapping the callee for an identity
//     stub while leaving `store: "gitleaks"` untouched.
//
// `lens-diagnostics.ts`'s function-tagged surfaces and the two hand-
// registered surfaces (widget-state footer, agent-nudge) keep a whole-file
// scope: their evidence genuinely lives inside a helper function called from
// (not merely near) the tagged line, and there are only a handful of such
// surfaces, so a file-wide search doesn't have the runtime-turn.ts push-seam
// pattern's "many one-line entries" laundering risk R1b targets.

/** Blanks `//` and `/* *\/` comments IN PLACE (newlines preserved, so line
 * numbers / line count stay aligned with the raw source) — unlike
 * `stripCommentsAndStrings`, string/template CONTENTS are left untouched,
 * since a surface's evidence is often itself a string/template argument. */
function stripCommentsOnly(source: string): string {
	const out = source.split("");
	const blank = (i: number) => {
		if (out[i] !== "\n") out[i] = " ";
	};
	let i = 0;
	const n = source.length;
	while (i < n) {
		const c = source[i];
		const c2 = source[i + 1];
		if (c === "/" && c2 === "/") {
			while (i < n && source[i] !== "\n") {
				blank(i);
				i++;
			}
			continue;
		}
		if (c === "/" && c2 === "*") {
			blank(i);
			blank(i + 1);
			i += 2;
			while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
				blank(i);
				i++;
			}
			if (i < n) {
				blank(i);
				blank(i + 1);
				i += 2;
			}
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			i++;
			while (i < n && source[i] !== quote) {
				i += source[i] === "\\" ? 2 : 1;
			}
			if (i < n) i++;
			continue;
		}
		i++;
	}
	return out.join("");
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

/** 0-based line indexes in `lines` where `needle` occurs. */
function findLineIndexes(lines: string[], needle: string): number[] {
	const out: number[] = [];
	lines.forEach((l, i) => {
		if (l.includes(needle)) out.push(i);
	});
	return out;
}

/**
 * True when some line within `proximity` of `lineIdx` (0-based) contains a
 * call-shaped occurrence of `calleeName` — R2's defense: the evidence
 * ARGUMENT alone (e.g. `store: "gitleaks"`) survives an identity-stubbed
 * callee; requiring the callee within a tight window of that SPECIFIC
 * argument occurrence is what a stub cannot fake without un-stubbing.
 */
function hasNearbyCallSite(
	lines: string[],
	lineIdx: number,
	calleeName: string,
	proximity: number,
): boolean {
	const start = Math.max(0, lineIdx - proximity);
	const end = Math.min(lines.length, lineIdx + proximity + 1);
	for (let i = start; i < end; i++) {
		if (lines[i].includes(`${calleeName}(`)) return true;
	}
	return false;
}

const REGION_BACK_WINDOW = 150;
const REGION_FORWARD_WINDOW = 10;
const CALLEE_PROXIMITY_LINES = 3;

/**
 * id -> every [startLine, endLine] (1-based, inclusive) region from each
 * INDIVIDUAL seam in `rawSource` tagged with that id — kept as SEPARATE
 * entries, never merged into one union. A union would let a rogue seam
 * "hide" behind a legitimate seam's real evidence elsewhere in the file: if
 * evidence only had to appear ANYWHERE across the combined regions, a second
 * seam tagged with the same (real) id but with no real gate nearby would
 * still pass, because the FIRST seam's region still carries the evidence.
 * #1634 review round R1b requires each TAGGED SEAM to independently prove
 * its own evidence — see the per-entry test below, which checks every
 * region in this list separately rather than their concatenation.
 */
function regionsById(
	rawSource: string,
	seamPattern: RegExp,
	back: number,
	forward: number,
): Map<string, Array<[number, number]>> {
	const totalLines = rawSource.split("\n").length;
	const out = new Map<string, Array<[number, number]>>();
	for (const { seam, ids } of scanTaggedSeams(rawSource, seamPattern)) {
		for (const id of ids) {
			const region: [number, number] = [
				Math.max(1, seam.line - back),
				Math.min(totalLines, seam.line + forward),
			];
			const arr = out.get(id) ?? [];
			arr.push(region);
			out.set(id, arr);
		}
	}
	return out;
}

/**
 * Checks one surface's evidence against `scopeRawLines` (either its own seam
 * region(s), or a whole file) and returns problem strings — used both by the
 * real per-entry tests below AND the red-proof tests against fixtures.
 */
function checkEvidenceInScope(
	id: string,
	entry: DeliverySurfaceEntry,
	scopeRawLines: string[],
	scopeLabel: string,
): string[] {
	const problems: string[] = [];
	const scopeStripped = stripCommentsOnly(scopeRawLines.join("\n"));
	const scopeStrippedLines = scopeStripped.split("\n");
	const min = entry.evidenceMin ?? 1;
	for (const needle of entry.evidence) {
		const count = countOccurrences(scopeStripped, needle);
		if (count < min) {
			problems.push(
				`"${id}": expected ${scopeLabel} to contain "${needle}" at least ${min}x (comment-stripped), found ${count}`,
			);
			continue;
		}
		// R2 applies only to ARGUMENT-shaped evidence (e.g. `store: "gitleaks"`)
		// — a needle that is already call-shaped itself (contains "(", e.g.
		// "applyDeltaFreshnessGate(" or "sweepInlineBlockerFreshness(runtime,
		// cwd)") is its own callee proof and needs no separate proximity check.
		if (entry.mode === "gated" && !needle.includes("(")) {
			const occurrenceLines = findLineIndexes(scopeStrippedLines, needle);
			const satisfied = occurrenceLines.some((lineIdx) =>
				entry.gates.some((gate) =>
					hasNearbyCallSite(scopeStrippedLines, lineIdx, gate, CALLEE_PROXIMITY_LINES),
				),
			);
			if (!satisfied) {
				problems.push(
					`"${id}": expected "${needle}" to sit within ${CALLEE_PROXIMITY_LINES} lines of ` +
						`a call-shaped ${entry.gates.join("/")}( in ${scopeLabel} — found the argument ` +
						`but not the callee (possible identity-stub)`,
				);
			}
		}
	}
	return problems;
}

describe("finding-delivery-gate evidence ground-truth (#1634 review F1/R1b/R2)", () => {
	const runtimeTurnRaw = source("clients/runtime-turn.ts");
	const runtimeTurnRawLines = runtimeTurnRaw.split("\n");
	const runtimeTurnRegions = regionsById(
		runtimeTurnRaw,
		RUNTIME_TURN_SEAM_PATTERN,
		REGION_BACK_WINDOW,
		REGION_FORWARD_WINDOW,
	);

	for (const [id, entry] of Object.entries(DELIVERY_SURFACES)) {
		if (entry.evidence.length === 0) continue;
		const seamRegions =
			entry.file === "clients/runtime-turn.ts" ? runtimeTurnRegions.get(id) : undefined;

		if (!seamRegions) {
			it(`"${id}" evidence is present in ${entry.file} (comments stripped)`, () => {
				const scopeRawLines = source(entry.file).split("\n");
				const problems = checkEvidenceInScope(id, entry, scopeRawLines, entry.file);
				expect(problems, problems.join("\n")).toEqual([]);
			});
			continue;
		}

		// R1b: EVERY individually-tagged seam must independently satisfy the
		// evidence — checked per region, never merged into one union (see
		// `regionsById`'s doc for why a union would let a rogue seam hide
		// behind a legitimate sibling seam's real evidence).
		seamRegions.forEach((region, seamIndex) => {
			const label =
				seamRegions.length > 1
					? `"${id}" evidence is present within tagged seam #${seamIndex + 1}'s region (line ~${region[0] + REGION_BACK_WINDOW}) (R1b/R2)`
					: `"${id}" evidence is present within its own seam's region (R1b/R2)`;
			it(label, () => {
				const scopeRawLines = runtimeTurnRawLines.slice(region[0] - 1, region[1]);
				const problems = checkEvidenceInScope(
					id,
					entry,
					scopeRawLines,
					`surface "${id}" seam #${seamIndex + 1}'s region`,
				);
				expect(problems, problems.join("\n")).toEqual([]);
			});
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

	// RED PROOF (R1b): "valid-tag laundering" — an ungated seam tagged with an
	// EXISTING gated id must NOT pass just because that id's real evidence
	// exists somewhere ELSE in the file. Reproduced with a self-contained
	// fixture large enough that the real evidence sits OUTSIDE the rogue
	// seam's region.
	it("RED PROOF: a rogue seam tagged with a real id, far from that id's real evidence, is caught", () => {
		const filler = Array.from({ length: REGION_BACK_WINDOW + 20 }, (_, i) => `// filler ${i}`);
		const rogueEntry = DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"];
		const rogueLines = [
			...filler,
			// The real evidence, far above the rogue seam below.
			'const gitleaksGate = gateFindingsByPathFreshness({ store: "gitleaks" });',
			...filler,
			// The rogue seam: tagged with a REAL, registered id, but nothing near
			// it actually gates anything.
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("a rogue finding wearing a real tag");',
		];
		const rogueSeamLine = rogueLines.length; // 1-based: the push is the last line
		const region: [number, number] = [
			Math.max(1, rogueSeamLine - REGION_BACK_WINDOW),
			rogueSeamLine + REGION_FORWARD_WINDOW,
		];
		const scopeRawLines = rogueLines.slice(region[0] - 1, region[1]);
		const problems = checkEvidenceInScope(
			"runtime-turn:secrets-gitleaks",
			rogueEntry,
			scopeRawLines,
			"the rogue seam's region",
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("store");
	});

	// RED PROOF (R2): "identity-stub laundering" — the reviewer's exact
	// mutant: keep `store: "gitleaks"` (the argument) but replace the callee
	// `gateFindingsByPathFreshness` with an identity stub. The argument
	// literal alone must NOT satisfy a `gated` surface's evidence.
	it("RED PROOF: identity-stubbing the callee while keeping the argument literal is caught", () => {
		const stubbedLines = [
			"function identityStub(x) { return x; }",
			'const gitleaksGate = identityStub({ store: "gitleaks", findings: [] });',
		];
		const problems = checkEvidenceInScope(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			stubbedLines,
			"the stubbed fixture",
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	it("control: the real (un-stubbed) call site satisfies both the argument and the callee-proximity check", () => {
		const realLines = [
			"const gitleaksGate = gateFindingsByPathFreshness({",
			'  store: "gitleaks",',
			"  findings: [],",
			"});",
		];
		const problems = checkEvidenceInScope(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			realLines,
			"the real fixture",
		);
		expect(problems).toEqual([]);
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
