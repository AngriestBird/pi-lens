/**
 * The #1754 ratchet: no NEW hand-rolled generation guard.
 *
 * ## What this can and cannot see
 *
 * Detecting a MISSING guard statically is not possible here. "This write
 * follows an await and the store it writes carries a generation" needs
 * type-level knowledge of every store, and the four historical sites wrote
 * through four different shapes (a module Map, a closure-captured cache, a
 * per-key Map on a state object, a sweep-local Set). Any regex claiming to
 * find those is a regex that lies.
 *
 * So the sweep is built the other way round, per #1741's charter direction:
 *
 * 1. **Declaration by construction.** A store that guards through the
 *    primitive appears in `listDeclaredGenerationSources()` because
 *    `createGenerationSource`/`createGenerationMap` register it. There is no
 *    way to use the primitive without declaring.
 * 2. **A closed list of the hand-rolled remainder.** The scanner below finds
 *    the syntactic signature every hand-rolled version shares — a `===`/`!==`
 *    against an identifier named for a generation, epoch, or sequence — and
 *    requires every file it flags to carry an explicit reason here. A new
 *    hand-rolled guard is therefore red until someone writes down why it is
 *    not using the primitive.
 * 3. **A reverse lock.** A file listed here that the scanner NO LONGER flags
 *    is also red, so a migration must delete its own entry and the list can
 *    only shrink.
 *
 * Known blind spots, stated rather than papered over:
 *
 * - Naming. A generation spelled `stamp`, `token`, `revision`, or `version` is
 *   invisible to the scanner. Declaration (1) is what actually covers new
 *   code; this list covers the code that predates the primitive.
 * - Cross-module generations passed as bare `number` parameters are seen only
 *   where the comparison itself lives.
 * - It flags guards that EXIST. A post-await write with no guard at all — the
 *   #1674 and #1669-N4 defect — is invisible to it, and is caught by the
 *   sites' own regression tests instead.
 */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import { listDeclaredGenerationSources } from "../../clients/generation-guard.js";
import {
	clientSourceFiles,
	clientsRelative,
	stripCommentsAndStrings,
} from "../support/session-state-scan.js";

/**
 * Every `clients/` file that still compares a generation/epoch/sequence by
 * hand instead of going through `clients/generation-guard.ts`, with the reason
 * it has not migrated.
 *
 * Adding a file here is a deliberate act with a written justification.
 * Removing one is what a migration does. Both directions are enforced below.
 */
const HAND_ROLLED_GENERATION_GUARDS: Readonly<Record<string, string>> = {
	"dispatch/runners/utils/runner-helpers.ts":
		"#1754 migrated the managed-verify and resolve/install write guards to the primitive; the remaining comparisons are the CHECKER-scoped ones (ensureCurrentGeneration, the sg latch), which do not guard a write — they trigger a cache clear on a staleness transition, a different shape the primitive deliberately does not model",
	"dispatch/runners/utils/availability-policy.ts":
		"install-retry latch compares the ledger's own generation to decide whether to re-arm; a transition trigger rather than a guarded write, same shape as runner-helpers' ensureCurrentGeneration",
	"dispatch/integration.ts":
		"reverse-dependency cache validity compares a PERSISTED graph build generation read off disk, not an in-process counter a reset seam owns; the primitive has no persisted form (#1754 left it out deliberately — see clients/lsp/workspace-diagnostics-cache.ts's #1669 review R2 note on inert persisted generations)",
	"review-graph/builder.ts":
		"the workspace-cache epoch, checkpoint and persist generations this primitive was modelled on; migration is real work on a large file and is tracked separately rather than smuggled into #1754's proof-of-two",
	"review-graph-logger.ts":
		"reads a persisted graph build generation for logging only; no write is guarded",
	"project-snapshot.ts":
		"per-key snapshot generations guarding persist-worker completions; a genuine GenerationMap candidate, deferred with review-graph/builder.ts",
	"lsp/client.ts":
		"#1682's per-(path, identifier) pull sequences and the pull generation; a genuine GenerationMap candidate, deferred out of #1754 because client.ts is the highest-traffic file in the repo and a behavior-identical proof there needs its own round",
	"lsp/index.ts":
		"generation handoff identity compares object references, not counters; the primitive models a counter",
	"mcp/analyze.ts":
		"warm word-index entries carry a generation checked alongside an identity compare; small, and its store is turn-scoped rather than owned by a reset seam",
	"runtime-coordinator.ts":
		"session generation compare used to answer a query, not to guard a write",
	"runtime-turn.ts":
		"turn-scoped generation compare; no post-await write behind it",
	"tree-sitter-client.ts":
		"trust-notification generation compare gating a log line, not a store write",
};

// The identifier must END at the generation-named word. Letting the match run
// on through `?.`/`.` accessors made `beforeFirstSequence?.truncated ===` look
// like a generation compare — noise that would have made this list unusable.
// A generation-named identifier on the LEFT of the comparison.
const GENERATION_LHS = /[\w$]*(?:generation|epoch|sequence)[\w$]*\s*(?:===|!==)/i;
// ...or on the RIGHT, where the left side is often a `map.get(key) ?? 0`.
const GENERATION_RHS =
	/(?:===|!==)\s*(?:[\w$]+[?.]+)*[\w$]*(?:generation|epoch|sequence)[\w$]*\s*(?:[;)&|,]|$)/im;

function comparesGenerationByHand(source: string): boolean {
	return GENERATION_LHS.test(source) || GENERATION_RHS.test(source);
}

/** `clients/`-relative paths that compare a generation by hand. */
function scanHandRolledGuards(): string[] {
	const flagged: string[] = [];
	for (const file of clientSourceFiles()) {
		const relative = clientsRelative(file);
		if (relative === "generation-guard.ts") continue;
		// Comments and strings must go first: several of these files carry long
		// doc comments that NAME the pattern, and matching those would make the
		// list unmaintainable noise.
		const source = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
		if (comparesGenerationByHand(source)) flagged.push(relative);
	}
	return flagged.sort();
}

describe("generation-guard ratchet (#1754)", () => {
	const flagged = scanHandRolledGuards();

	it("flags a non-trivial number of files, so the scanner cannot silently die", () => {
		// A regex change that matches nothing would make every assertion below
		// vacuously pass. This floor is the same guard the session-state sweep's
		// probe-count floor provides.
		expect(flagged.length).toBeGreaterThanOrEqual(8);
	});

	it("every hand-rolled generation guard carries a written reason", () => {
		const undeclared = flagged.filter(
			(file) => !(file in HAND_ROLLED_GENERATION_GUARDS),
		);
		expect(
			undeclared,
			`${undeclared.length} file(s) compare a generation/epoch/sequence by hand ` +
				"without going through clients/generation-guard.ts. Use the primitive " +
				"(createGenerationSource / createGenerationMap), or add the file to " +
				"HAND_ROLLED_GENERATION_GUARDS with the reason it cannot.",
		).toEqual([]);
	});

	it("every declared exception is still a real one", () => {
		const stale = Object.keys(HAND_ROLLED_GENERATION_GUARDS).filter(
			(file) => !flagged.includes(file),
		);
		expect(
			stale,
			`${stale.length} file(s) are listed as hand-rolled but no longer compare ` +
				"a generation by hand. Delete their entries — the list may only shrink.",
		).toEqual([]);
	});

	it("every reason is a real sentence, not a placeholder", () => {
		for (const [file, reason] of Object.entries(HAND_ROLLED_GENERATION_GUARDS)) {
			expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(60);
		}
	});
});

describe("generation-guard declaration registry (#1741 charter direction)", () => {
	it("both #1754 migrations declare themselves", async () => {
		await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		await import("../../clients/lsp/workspace-diagnostics-cache.js");
		expect(listDeclaredGenerationSources()).toEqual(
			expect.arrayContaining([
				"dispatch-availability",
				"workspace-diagnostics-cache",
			]),
		);
	});

	it("a migrated file drops out of the hand-rolled list", () => {
		// The reverse lock in action: workspace-diagnostics-cache.ts was flagged
		// before #1754 and must not be flagged after.
		expect(scanHandRolledGuards()).not.toContain(
			"lsp/workspace-diagnostics-cache.ts",
		);
	});
});
