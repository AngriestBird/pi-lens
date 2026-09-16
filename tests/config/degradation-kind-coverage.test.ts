/**
 * #3071 — every `DegradationKind` literal emitted at a `recordDegradationOnce`
 * / `incrementDegradationCount` / `logDurableDegradation` call site is a
 * declared member of the `DegradationKind` union.
 *
 * ## The defect this guards
 *
 * `DegradationRecord.kind` is typed `unknown` and `DegradationGroup.kind` is
 * typed plain `string` (`clients/degradation-ledger.ts`) — nothing in the type
 * system ties a call site's `kind:` literal back to the union declared just
 * above them. `tests/config/degradation-kind-order.test.ts` pins the union's
 * own ALPHABETICAL order, but never checks that order against what call sites
 * actually emit, so a kind spelled at a call site with no matching union
 * member compiles clean and is silently unreachable by any reader (`pilens
 * degradation`, the durable ledger dashboard, a future exhaustive `switch`)
 * that trusts the union as the complete vocabulary.
 *
 * Measured on 4ff36009f (#3071's filing): declared 138, literal kinds at call
 * sites 112, undeclared 13. Measured again for this change (master had moved:
 * two more record sites were added in the interim — `lsp-document-drift`,
 * `lsp-probe-finding-policy`) — see the PR body for the exact 15-name list
 * this sweep found and `clients/degradation-ledger.ts` now declares.
 *
 * ## Scope, stated rather than silently narrowed
 *
 * This walks `clients/`, `index.ts`, `mcp/` and `tools/` (`commands/` too,
 * were it to exist) for a CALL EXPRESSION whose simple callee is one of the
 * three names, exactly like {@link
 * import("../support/sweep-kit.js").createCallSiteScanner} resolves any other
 * sweep's call sites — comments and string CONTENTS are blanked first
 * (`stripSource`) so a callee named only in prose is not a call. `scripts/`
 * is not walked: nothing there calls these three names directly (one bench
 * script only READS `getDegradationSummary()`), and record sites are 100%
 * inside the four scanned trees today (`stableOccurrenceKey`'s `#file:hash`
 * details below say exactly which file supplied each one).
 *
 * `kindLiteralsInOptions` extracts the STRING literal(s) the call's own
 * `kind:` property evaluates to, TEXTUALLY, and knows two shapes:
 * - a bare literal (`kind: "actionable-warnings-cap"`);
 * - a two-armed ternary between two literals (`clients/deadline-utils.ts`:
 *   `kind: fired === "deadline" ? "hook-await-exceeded" :
 *   "hook-await-abandoned"`) — both arms are returned, and the ternary's own
 *   CONDITION (here, the literal `"deadline"` being compared against) is
 *   deliberately excluded: only text after the `?` counts as a produced kind.
 *
 * A `kind` written as an identifier or a property access — a pass-through
 * parameter (`bounded-telemetry.ts`'s `options.ledgerKind`,
 * `bundled-resource-health.ts`'s `kind` parameter, `config-warn.ts`'s
 * `degradationKindFor(...)` classifier call, `instance-reaper.ts`'s
 * `options.kind`) or a whole record object built earlier and passed by name
 * (`index.ts`'s `incrementDegradationCount(degradation)`) — contributes NO
 * literal here: the literal, if any, lives at THAT function's own callers,
 * outside this scan's three names. This is a stated, not a silent, limit
 * (the "sweep is only as good as its needles" self-test below pins the
 * distinction), and it costs nothing for #3071's purpose: every one of those
 * pass-through sites resolves (by inspection, recorded in the PR body) to an
 * ALREADY-declared kind — `auditRegistry` treats a declared-but-unflagged
 * union member as fine by design (registries routinely cover state a
 * mechanical heuristic cannot see), so this sweep stays honest without
 * chasing multi-hop parameter forwarding.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	assertNonEmptyScan,
	callSites,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const LEDGER_FILE = "clients/degradation-ledger.ts";

/** The three functions every durable degradation record goes through. */
const RECORD_CALLEES =
	/^(recordDegradationOnce|incrementDegradationCount|logDurableDegradation)$/;

/** Every tree that could hold a call site for the three names above. */
const SCAN_ROOTS = ["clients", "index.ts", "mcp", "tools", "commands"];

/**
 * The STRING literal(s) a call site's `kind:` property evaluates to,
 * textually. See the module header for the two shapes recognized and why a
 * pass-through identifier/property-access value returns `[]` rather than
 * being chased through its own callers.
 */
function kindLiteralsInOptions(optionsLiteral: string): string[] {
	// Comments blanked, string CONTENTS blanked too: this pass only needs the
	// STRUCTURE (brace/paren depth, the key name, the `,`/`}` that ends the
	// value) — the literal content itself is read from the ORIGINAL text below,
	// by the same offsets, since `stripSource` preserves length and layout.
	const structure = stripSource(optionsLiteral, { strings: "blank" });
	const keyMatch = /(?<![\w$])kind(?![\w$])\s*:/.exec(structure);
	if (!keyMatch) return [];

	// Depth just BEFORE the match must be exactly 1 — inside the object
	// literal's own `{` and nothing else — so a `kind` spelled inside a
	// NESTED object (e.g. a hypothetical `metadata: { kind: ... }`) is never
	// mistaken for the record's own top-level property.
	let depth = 0;
	for (let i = 0; i < keyMatch.index; i++) {
		const ch = structure[i];
		if (ch === "{" || ch === "[" || ch === "(") depth++;
		else if (ch === "}" || ch === "]" || ch === ")") depth--;
	}
	if (depth !== 1) return [];

	// The value's own text runs from just after the colon to the next
	// SAME-DEPTH `,` (the property separator) or the object's own closing `}`
	// (when `kind` is the last property) — bracket/paren-depth aware, so a
	// value like `fired === "deadline" ? "a" : "b"` is not cut short by
	// anything inside it.
	let valueDepth = 0;
	let end = structure.length;
	for (
		let i = keyMatch.index + keyMatch[0].length;
		i < structure.length;
		i++
	) {
		const ch = structure[i];
		if (ch === "{" || ch === "[" || ch === "(") valueDepth++;
		else if (ch === "}" || ch === "]" || ch === ")") {
			if (valueDepth === 0) {
				end = i;
				break;
			}
			valueDepth--;
		} else if (ch === "," && valueDepth === 0) {
			end = i;
			break;
		}
	}

	const valueText = optionsLiteral.slice(
		keyMatch.index + keyMatch[0].length,
		end,
	);
	const STR = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
	const unquote = (raw: string) => raw.slice(1, -1).replace(/\\(.)/g, "$1");

	// A two-armed ternary: only the text AFTER the `?` is a produced value —
	// the condition before it (which may itself compare against a string
	// literal, as `deadline-utils.ts` does) is never returned.
	const ternary = new RegExp(
		`^\\s*[\\s\\S]*?\\?\\s*${STR}\\s*:\\s*${STR}\\s*$`,
	).exec(valueText);
	if (ternary) return [unquote(ternary[1]), unquote(ternary[2])];

	// A bare literal: the whole value, trimmed, is one string.
	const bare = new RegExp(`^\\s*${STR}\\s*$`).exec(valueText);
	return bare ? [unquote(bare[1])] : [];
}

/** Every member the `DegradationKind` union declares, in file order. */
function declaredKinds(): string[] {
	const source = readWalkedFile(path.join(REPO_ROOT, LEDGER_FILE));
	const body = source?.match(
		/export type DegradationKind =([\s\S]*?)\n\nexport interface DegradationRecord/,
	)?.[1];
	return [...(body ?? "").matchAll(/\| "([^"]+)"/g)].map((match) => match[1]);
}

interface KindOccurrence {
	kind: string;
	/** `stableOccurrenceKey` over the RAW source — content-derived, survives
	 *  an unrelated line inserted elsewhere in the file. */
	detail: string;
}

/** Every `kind` literal found at a {@link RECORD_CALLEES} call site. */
function scanCallSites(): { occurrences: KindOccurrence[]; scannedFiles: number } {
	const files = SCAN_ROOTS.flatMap((root) => {
		const abs = path.join(REPO_ROOT, root);
		if (!fs.existsSync(abs)) return [];
		if (!fs.statSync(abs).isDirectory()) return [abs];
		return listSourceFiles(abs, { extensions: [".ts"], skipTests: true });
	});

	const occurrences: KindOccurrence[] = [];
	let scannedFiles = 0;
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		scannedFiles++;
		const relPath = relativePosix(REPO_ROOT, file);
		const lines = source.split("\n");
		for (const site of callSites(source, RECORD_CALLEES)) {
			if (!site.optionsLiteral) continue;
			for (const kind of kindLiteralsInOptions(site.optionsLiteral)) {
				occurrences.push({
					kind,
					detail: stableOccurrenceKey(relPath, lines, site.line - 1),
				});
			}
		}
	}
	return { occurrences, scannedFiles };
}

describe("DegradationKind call-site literal extraction (#3071)", () => {
	// The sweep is only as good as its needles (`tests/support/sweep-kit.ts`
	// module header's own convention) — pin each shape against a minimal
	// fixture rather than trusting the production scan to exercise all of
	// them.
	it("extracts a bare literal", () => {
		expect(
			kindLiteralsInOptions('{ kind: "config-deprecated", subject: file }'),
		).toEqual(["config-deprecated"]);
	});

	it("extracts both arms of a ternary and never its condition", () => {
		// Named recurrence: an earlier draft of this sweep matched ANY quoted
		// string inside the value text, so `fired === "deadline" ? "a" : "b"`
		// flagged a phantom third kind, `"deadline"` — the ternary's own
		// CONDITION, never assigned to `kind` at all. This fixture is that
		// exact shape (`clients/deadline-utils.ts`'s call site).
		expect(
			kindLiteralsInOptions(
				'{ kind: fired === "deadline" ? "hook-await-exceeded" : "hook-await-abandoned", subject: x }',
			),
		).toEqual(["hook-await-exceeded", "hook-await-abandoned"]);
	});

	it("returns nothing for a pass-through identifier or property access", () => {
		expect(kindLiteralsInOptions("{ kind: options.ledgerKind, subject: x }")).toEqual(
			[],
		);
		expect(kindLiteralsInOptions("{ kind, subject: x }")).toEqual([]);
		expect(
			kindLiteralsInOptions("{ kind: degradationKindFor(a, b), subject: x }"),
		).toEqual([]);
	});

	it("ignores a kind spelled inside a nested object, not the record's own", () => {
		// Depth guard: a literal named "kind" inside `metadata` (or any nested
		// object) must never be read as the record's OWN kind.
		expect(
			kindLiteralsInOptions(
				'{ kind: "real-kind", subject: x, metadata: { kind: "decoy" } }',
			),
		).toEqual(["real-kind"]);
	});

	it("strips a comment inside the object literal before matching", () => {
		expect(
			kindLiteralsInOptions('{ /* kind: "decoy" */ kind: "real-kind" }'),
		).toEqual(["real-kind"]);
	});
});

describe("DegradationKind union coverage (#3071)", () => {
	it("declares every kind literal emitted at a recordDegradationOnce / incrementDegradationCount / logDurableDegradation call site", () => {
		const { occurrences, scannedFiles } = scanCallSites();
		// #1718 shape: a walk that resolved to nothing would read as a clean
		// sweep. 400 is comfortably under the ~470 TypeScript files these four
		// trees held at authoring time, so ordinary churn does not trip it.
		assertNonEmptyScan("DegradationKind call-site coverage (files)", scannedFiles, 400);
		// 100 is comfortably under the 118 distinct kinds / 169 occurrences
		// measured at authoring time.
		assertNonEmptyScan(
			"DegradationKind call-site coverage (occurrences)",
			occurrences.length,
			100,
		);

		const declared = declaredKinds();
		expect(declared.length).toBeGreaterThan(0);

		// One flagged entry per DISTINCT kind — many call sites legitimately
		// share one kind, which is expected and not a `stableOccurrenceKey`
		// collision; the first occurrence's key is kept as the readable detail.
		const byKind = new Map<string, string>();
		for (const occurrence of occurrences) {
			if (!byKind.has(occurrence.kind)) {
				byKind.set(occurrence.kind, occurrence.detail);
			}
		}
		const flagged = [...byKind.entries()].map(([kind, detail]) => ({
			key: kind,
			detail,
		}));

		const audit = auditRegistry({
			sweepName: "DegradationKind call-site coverage",
			flagged,
			registered: declared,
			scannedCount: scannedFiles,
			minScanned: 400,
			minFlagged: 100,
			remediation:
				"Add the kind to the DegradationKind union in " +
				`${LEDGER_FILE} (alphabetically — ` +
				"tests/config/degradation-kind-order.test.ts enforces the order) " +
				"before shipping a call site that emits it (#3071).",
		});

		expect(audit.problems).toEqual([]);
	});
});
