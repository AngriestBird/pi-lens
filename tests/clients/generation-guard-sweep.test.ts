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
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { listDeclaredGenerationSources } from "../../clients/generation-guard.js";
import {
	clientSourceFiles,
	clientsRelative,
	repoRoot,
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
	// --- Migration backlog: these ARE the capture-before-await/check-before-
	// write shape the primitive models. Each is a real candidate, deferred for
	// a stated reason, not exempted on principle. ---
	"lsp/client.ts":
		"#1682's per-(path, identifier) pull sequences: claimed at request time, re-checked at write time. A GenerationMap candidate, deferred because client.ts is the highest-traffic file in the repo and a behavior-identical proof there needs its own round",
	"review-graph/builder.ts":
		"the workspace-cache epoch this primitive was modelled on, plus checkpoint and persist generations that gate post-await promotions (see the `_persistGenerations.get(key) !== result.generation` guard). A GenerationMap candidate; migrating a file this size is real work, not a rider on #1754's proof-of-two",
	"project-snapshot.ts":
		"per-key snapshot generations gating a post-await stage promotion and the exit-hook drain — a superseded save must not promote over a fresher body. Same GenerationMap shape as review-graph/builder.ts, deferred with it",
	"runtime-turn.ts":
		"the turn_end test-runner path captures testRunGeneration before awaiting the runners and re-reads the persisted generation before writing failures, so this IS the guarded-write shape. Deferred because the generation lives in a persisted cache entry rather than an in-process counter, which the primitive does not model yet",
	"runtime-coordinator.ts":
		"clearStartupScanInFlight guards a DELETE on the in-flight map with the generation that owns the entry — the eviction direction, the same guard #1674's F5 round added by hand. A GenerationSource candidate, deferred so #1754 lands with two migrations rather than five",
	"mcp/analyze.ts":
		"the warm word-index idle eviction captures a per-entry generation before its timer fires and re-checks it in the callback, alongside an entry-identity compare. The eviction direction again, on a per-entry counter rather than a keyed map; a migration candidate once GenerationMap gains an entry-scoped form",

	// --- Not the shape: a generation is compared, but no post-await write
	// hangs on the answer. ---
	"dispatch/runners/utils/runner-helpers.ts":
		"#1754 migrated this file's guarded WRITES (the managed-verify verdict memo, both in-flight evictions). What is left is ensureCurrentGeneration and the ast-grep latch, which clear a cache on a staleness transition rather than guard a write — a different shape the primitive deliberately does not model",
	"dispatch/runners/utils/availability-policy.ts":
		"syncInstallGeneration folds in any resetInstallRetryLatches() since the last touch by clearing the attempt count and cooldown on a mismatch. Clear-on-transition, the same shape as runner-helpers' ensureCurrentGeneration, not a guarded write",
	"tree-sitter-client.ts":
		"the trust-notification set is cleared on a trust-generation transition before the set is consulted (lazy clear-on-transition, #1363). Clear-on-transition again: the generation decides whether to reset state, not whether a pending write may land",
	"dispatch/integration.ts":
		"reverse-dependency reuse eligibility compares a PERSISTED graph build generation read off disk against a cached index's, to decide whether a one-step import delta is contiguous. A read-side eligibility test, and the primitive has no persisted form — see workspace-diagnostics-cache.ts's #1669 review R2 note on why an inert persisted generation was reverted there",
	"review-graph-logger.ts":
		"copies a persisted graph build generation into log metadata. Nothing is guarded; the value is a field in a record",
	"lsp/index.ts":
		"the generation handoff compares PROMISE IDENTITY to decide whether the slot it is clearing is still its own. That is the eviction direction, but keyed on object identity rather than a counter, which is what the primitive models; a counter would add state where an identity compare already answers exactly",

	// --- Permanent: migrating would be circular. ---
	"single-flight.ts":
		"the #1753 singleFlight primitive OWNS its generation compare. It is GenerationGuard's sibling, not its caller: routing singleFlight's own share-branch check through GenerationGuard would make two primitives depend on each other for the property each exists to provide. Permanent, not backlog. Listed at FILE level so it survives #1762's restructuring of that comparison",
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
		// A file that is not in the tree at all is not a stale entry: an
		// exemption may be written for a file arriving on another branch (this
		// list is file-keyed precisely so it survives that). The reverse lock
		// applies to files that EXIST and no longer compare a generation.
		const stale = Object.keys(HAND_ROLLED_GENERATION_GUARDS).filter(
			(file) =>
				!flagged.includes(file) &&
				fs.existsSync(path.join(repoRoot, "clients", file)),
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
