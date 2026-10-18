/**
 * #2442: forbid a NEW hand-rolled evict-oldest program outside
 * `clients/bounded-cache.ts`.
 *
 * `clients/bounded-cache.ts` ships three small bounded collections —
 * `BoundedLruCache` (get() re-inserts), `BoundedFifoMap` (get() never
 * re-inserts, insertion-order eviction), and `BoundedSet` (the Set-shaped,
 * membership-only sibling, #2460) — built specifically so a call site never
 * has to hand-roll an eviction again. #2432's round-3 review named two such
 * hand-rolled sites; a repo-wide sweep found the idiom 27 times.
 *
 * ## The question is structural (#4606 S1)
 *
 * Five lexical spellings (#2442, #2460, #4570, #4580) each left a neighbour
 * invisible: a wrapped accessor chain, an alias, an indirect accessor, a
 * binding split across statements, destructured iterator results, an ordering
 * that finishes in a statement of its own. That is AGENTS.md shape 69: a
 * detector that lists the spellings it knows passes every spelling it does
 * not. So the eviction question moved to `tests/support/eviction-programs.ts`,
 * a recognizer over the TypeScript AST built on the S0 census seam
 * (`tests/support/ast-census.ts`): one parse per source text, one native
 * candidate query, and a semantic test for the four stages every eviction
 * program passes through — bound, order, selection, effect.
 *
 * The recognizer admits exactly four forms, each tabled in its module header
 * with the live member that needs it:
 *
 * | Form | Live members |
 * | --- | --- |
 * | `iterator-head` | `clients/lsp/index.ts`, `clients/lsp/client.ts`, `scripts/check-pr-body.mjs` |
 * | `ordered-victim` | the comparator family: `clients/dispatch/integration.ts`, `clients/lsp/client-registry.ts` ×2, `clients/mcp/analyze.ts`, `clients/project-snapshot.ts`, `clients/read-guard.ts` ×2, `clients/review-graph/builder.ts`, `clients/workspace-topology.ts` ×2, `clients/widget-state.ts#pruneInactiveFileRecords` |
 * | `ordered-scan` | `clients/debug-handles.ts`, `clients/lsp/document-drift.ts`, `clients/observed-mutation.ts`, `clients/resource-sampler.ts` |
 * | `count-truncation` | `clients/sgconfig.ts`, `clients/cache-manager.ts`, `clients/mutation-attribution.ts`, `clients/widget-state.ts` (retention cap), `clients/lens-map.ts`, `scripts/analyze-pi-lens-logs.mjs#pushTop` |
 *
 * Everything outside those forms refuses. A shape the recognizer cannot place
 * is not silently clean: the refused LIVE programs are tabled below
 * (`REFUSED_PROGRAMS`) with the stage each lacks and the policy that owns it,
 * and the accounting test re-reads each anchor from the real file and proves
 * the site is still unflagged (#4580 r5's intake, kept).
 *
 * ## Properties this sweep learned the hard way
 *
 * 1. **Per-OCCURRENCE, not per-FILE.** Exemptions used to name a file, so a
 *    NEW hand-rolled eviction appended to an already-exempted file passed
 *    silently — the exemption laundered it. Every flagged item is keyed by
 *    `stableOccurrenceKey` (`tests/support/sweep-kit.ts`), so an exemption
 *    excuses exactly one occurrence. `auditRegistry`'s
 *    `requireUniqueFlagged` (on by default) fails LOUD when two occurrences
 *    derive one key, so a real collision cannot ride through either.
 * 2. **Content-keyed, not line-keyed (#2475).** #2459, #2449, and #2474 each
 *    had to re-pin a line number inserted ABOVE a flagged site; the key is the
 *    occurrence's own text (enclosing declaration name plus a content hash of
 *    the flagged line), so moving a site without editing it is a no-op.
 * 3. **A tighter-LOOKING check can be narrower (#2460 round 3).** The bare
 *    `for…of` gate once required the delete to name the loop variable, which
 *    missed `oldest = v; …set.delete(oldest)` and `set?.delete(oldest)`; the
 *    structural form gates on the victim moving, not on the spelling.
 * 4. **Population is the DETECTOR's, not the tree's (#4580 r5, shape 69).**
 *    `EXEMPT_SITES` is every occurrence this sweep FLAGS. What it refuses is
 *    tabled and asserted, never described in prose.
 *
 * Built on `tests/support/sweep-kit.ts`, same as this repo's other
 * registered-or-fail sweeps. A NEW site this sweep flags must migrate to a
 * bounded class or be added to `EXEMPT_SITES` with a real reason.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { censusSourceFiles } from "../support/ast-census.js";
import {
	EVICTION_FORMS,
	findEvictionPrograms,
} from "../support/eviction-programs.js";
import {
	auditRegistry,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one file allowed to spell the idiom: the canonical implementation. */
const DEFINITION_FILE = "clients/bounded-cache.ts";

/**
 * `stableOccurrenceKey` output (`path#enclosingSymbol:contentHash`, or
 * `path#contentHash` with no enclosing symbol) → why this exact occurrence
 * stays hand-rolled.
 *
 * Every entry is a container shape no bounded class covers. #4606 S1 re-keyed
 * this table once, in the same change that replaced the lexical detector with
 * the structural one: 16 rows kept their reasons, the three rows that recorded
 * NON-members of the lexical overmatch were deleted (the structural recognizer
 * never flags them, so no exemption is needed), and the seven live programs
 * the lexical detector could not see joined with their own reasons.
 *
 * When a genuine edit to the flagged line invalidates a key, the failing
 * test's `audit.problems` output prints the new key the scan computes; paste
 * it in.
 */
const EXEMPT_SITES: Readonly<Record<string, string>> = {
	"clients/widget-state.ts#pruneInactiveFileRecords:15adad3b":
		"Only inactive files with no live diagnostic qualify; touchedAt orders " +
		"multiple victims until the soft cap is met. Neither bounded class " +
		"expresses eligibility partition plus external recency (document-drift class).",
	"clients/lsp/index.ts#LSPService:2676aced":
		"Frozen LSP source (#4580 r4): markTouched maintains write recency by " +
		"delete/set and trims oldest-first; reads must not promote. BoundedFifoMap " +
		"fits this count cap, but migration is deferred under the explicit LSP freeze.",
	"clients/lsp/document-drift.ts#DocumentDriftTracker:add9342e":
		"Not evict-OLDEST (#4503): the walk SKIPS every record whose document a " +
		"live server still holds and evicts the oldest one nobody holds, because " +
		"dropping a held document's record leaves its stale view with nothing " +
		"comparing disk against it. When every record is held, nothing is evicted " +
		"at all. BoundedFifoMap can only drop its head, so it cannot express a " +
		"skip-held victim policy, and growing it a skip policy to serve one caller " +
		"is the same trade the debug-handles entry below already declined.",
	"clients/debug-handles.ts#recordTrackedInit:3737b5dc":
		"Not evict-OLDEST: this walk deliberately SKIPS the first " +
		"TRACKER_PROTECTED_COUNT insertion-order entries and evicts the " +
		"oldest one after them, so the earliest-created handles (the ones " +
		"most likely to be the leak under investigation) are never the ones " +
		"dropped. A protected prefix is a policy neither BoundedFifoMap nor " +
		"BoundedLruCache expresses, and encoding it into a shared primitive " +
		"for one debug-only caller is not worth the surface.",
	"clients/lsp/client.ts#recordSentContent:1bb76b36":
		"Not evict-OLDEST (#4580 round 2, family 1 with the accessor chain " +
		"wrapped across lines): the loop is bounded on TWO axes at once " +
		"(retained entries and retained bytes) and SKIPS every path whose " +
		"binding no longer carries text before either counter moves, so it drops " +
		"the oldest TEXT-BEARING path. Neither bounded class holds a second axis " +
		"or a skip policy, and growing BoundedFifoMap one to serve this single " +
		"caller is the trade the two entries above already declined.",
	"clients/review-graph/builder.ts#setWorkspaceGraph:5d6480b6":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by an explicitly maintained `lastUsedAt`, and the " +
		"eviction clears the entry's armed idle timer. `BoundedLruCache` promotes " +
		"on `get`, which these caches do NOT do through their equality-checking " +
		"reads, so adopting it would change which entry is evicted under a " +
		"read-only workload; no bounded class carries an external recency stamp " +
		"or a per-entry timer.",
	"clients/dispatch/integration.ts#setReverseDepsEntry:cfec6940":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the explicitly maintained `lastUsedAt` that " +
		"`touchReverseDepsEntry` stamps, and the eviction clears the entry's " +
		"armed idle timer. `BoundedLruCache`'s `get` would promote on the " +
		"equality-checking reads this cache makes, changing eviction order; no " +
		"bounded class carries an external recency stamp or a per-entry timer.",
	"clients/project-snapshot.ts#enforceAuthoritativeSnapshotCap:c15ce8a2":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the explicitly maintained `lastUsedAt`, and the " +
		"eviction must clear the single timer `scheduleAuthoritativeSnapshotEviction` " +
		"armed for it. `BoundedLruCache` would promote on `get`, which this " +
		"cache's equality-checking reads must not do; no bounded class carries an " +
		"external recency stamp or a per-entry timer.",
	"clients/workspace-topology.ts#getDirectoryMarkers:d43899c7":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the `lastUsedAt` that `touchDirMarker` stamps, " +
		"and `deleteDirMarker` must clear that entry's idle timer. " +
		"`BoundedLruCache`'s `get` would promote on reads this cache makes without " +
		"touching the stamp, changing eviction order; no bounded class carries an " +
		"external recency stamp or a per-entry timer.",
	"clients/workspace-topology.ts#walkToNearestMatch:79da3cc7":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the `lastUsedAt` that `touchWalk` stamps, and " +
		"`deleteWalk` must clear that entry's idle timer. `BoundedLruCache`'s " +
		"`get` would promote on reads this cache makes without touching the " +
		"stamp, changing eviction order; no bounded class carries an external " +
		"recency stamp or a per-entry timer.",
	"clients/read-guard.ts#ReadGuard:61e2665a":
		"Consumed reads are evicted first, ordered by the separately maintained " +
		"fileLastUsed stamp. evictFile removes read/authorship/last-used state. " +
		"Neither bounded class expresses this eligibility partition plus external recency.",
	"clients/read-guard.ts#ReadGuard:fe37c09d":
		"Unconsumed reads are the second eligibility partition, ordered by " +
		"fileLastUsed only after consumed eviction. evictFile clears associated " +
		"read/authorship state; a single FIFO/LRU container cannot encode the two passes.",
	"clients/mcp/analyze.ts#enforceWarmWordIndexLruCap:625c660e":
		"Only unleased warm roots may be evicted; lastUsedAt orders eligible roots " +
		"and evictWarmWordIndex performs retirement. Neither bounded class has " +
		"lease eligibility plus explicitly maintained recency.",
	"clients/lsp/client-registry.ts#ClientRegistry:4d17a873":
		"Frozen LSP member: adopted roots are ordered by explicit recency, " +
		"excluding the root just normalized. Eviction also retires that root's " +
		"adopted clients. Neither bounded class expresses protected-root selection.",
	"clients/lsp/client-registry.ts#ClientRegistry:4fd64a7c":
		"Frozen LSP member: ceiling capacity counts live and in-flight clients. " +
		"Only alive, idle, unleased clients other than the requested key qualify; " +
		"the victim must be shut down asynchronously. A bounded map cannot own " +
		"that eligibility or shutdown lifecycle.",

	"scripts/check-pr-body.mjs#testCorpus:9825b2b8":
		"Tooling-only FIFO corpus memo; importing the shipped clients container " +
		"would cross the script/runtime dependency boundary. This admission names " +
		"one pre-existing bounded script cache, not a shipped runtime policy.",

	// #4606 S1: the seven live programs the lexical detector could not see.
	"clients/sgconfig.ts#enforceBaselineEntryCap:1ee0be8a":
		"Baseline artifacts on DISK, not map entries: eligibility is a keep-set " +
		"plus mtime recency over directory entries, the victim is removed with " +
		"`rmSync`, and its cached baseline is retired. No bounded class owns a " +
		"filesystem directory, and the survivor set is written by the tool the " +
		"eviction protects, not by this block.",
	"clients/cache-manager.ts#CacheManager:9b87dd70":
		"Persisted turn-state partitions: eligibility is the TTL filter, order is " +
		"the stored `lastUpdated` stamp, and the survivors are rebuilt with " +
		"`Object.fromEntries` and written back to a JSON cache. No bounded class " +
		"owns a persisted record with external recency, and dropping a partition " +
		"here also re-writes the envelope's writer identity.",
	"clients/mutation-attribution.ts#persistAttribution:497e44c7":
		"Persisted tool records: the cap keeps the freshest `lastSeen` tail of a " +
		"JSON record and writes the survivors back to disk. No bounded class owns " +
		"a persisted record keyed by an external recency stamp, and the file " +
		"rewrite is the point of the block.",
	"clients/widget-state.ts#retainSuppressedRows:8f784012":
		"Per-file suppressed-row retention ordered by the stored `observedAt`, " +
		"with one degradation record per capped file and re-emitted retained rows. " +
		"External recency plus a degradation record no bounded class carries; the " +
		"sibling policy in the same file is already an exemption.",
	"clients/lens-map.ts#aggregateGraphToFiles:140b5988":
		"Non-member: a degree-ranked render view capped for output (#679). Nothing " +
		"is evicted from a stored container — the graph keeps every file — so no " +
		"bounded class applies. The row stays because the structural recognizer " +
		"cannot distinguish a capped view from a capped retention without knowing " +
		"who owns the survivors, and a silent absence would read as a judgement.",
	"clients/observed-mutation.ts#budgetFor:44e908ca":
		"Minimum dead-turn scan (#4606): the victim is the smallest turn index " +
		"that is not live, with `Math.min(...keys())` as the all-live fallback, so " +
		"eviction is oldest-dead-first rather than insertion-ordered. BoundedFifoMap " +
		"drops its head and cannot express a live-predicate skip.",
	"clients/resource-sampler.ts#sampleProcessesWindows:42adf4b2":
		"Windows CPU-history trim: insertion order is irrelevant because the " +
		"victim is the entry with the smallest timestamp, scanned explicitly. A " +
		"bounded map cannot carry a per-entry timestamp scan, and the map also " +
		"drops entries on a 60 s age bound evaluated before this trim.",
	"scripts/analyze-pi-lens-logs.mjs#pushTop:26d430bd":
		"Tooling-only sorted top-N list: a script keeps its ranking bounded by " +
		"sorting and truncating in place, and importing the shipped clients " +
		"container into a log analyzer would cross the script/runtime boundary. " +
		"This is the same class as the corpus memo above, not a shipped policy.",
};

/**
 * Live programs the recognizer REFUSES, with the stage each lacks.
 *
 * The recognizer admits four forms; these are retention programs whose bound is
 * a runtime argument or whose order is plain insertion, so the stages they
 * share with a member do not prove an eviction. Each row is re-read from the
 * real file — the anchor must survive as CODE (`stripSource`, so a comment or
 * a string quoting it is prose) and the site must stay unflagged — so a row can
 * neither go stale nor claim a site that migrated, and a recognizer round that
 * starts catching one of these reds here instead of passing silently
 * (#4580 r5's intake, kept for the structural detector).
 */
const REFUSED_PROGRAMS: Readonly<
	Record<
		string,
		{ readonly file: string; readonly anchor: string; readonly count: number }
	>
> = {
	"insertion-order suffix retention, literal cap": {
		file: "clients/agent-behavior-client.ts",
		anchor: "this.toolHistory = this.toolHistory.slice(-50);",
		count: 1,
	},
	"insertion-order suffix retention, record field": {
		file: "clients/metrics-history.ts",
		anchor: "existing.history = existing.history.slice(-MAX_HISTORY_PER_FILE);",
		count: 2,
	},
	"array of edits scanned in order, no victim hand-off": {
		file: "clients/partial-edit-apply.ts",
		anchor:
			"const ordered = [...args.edits].sort((a, b) => a.spanStart - b.spanStart);",
		count: 1,
	},
	"line-window rendering, runtime line budget": {
		file: "clients/runtime-turn.ts",
		anchor: "if (lines.length > maxLines) {",
		count: 1,
	},
};

/** 0-based start offset of every line, for offset→line mapping. */
function lineStartOffsets(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

/** End of a balanced initializer or call in comment/string-blanked source. */
function balancedEnd(source: string, start: number, call = false): number {
	let depth = call ? 1 : 0;
	for (let index = start; index < source.length; index++) {
		const token = source[index];
		if (token === ";" && depth === 0) return index;
		if (token === "(" || token === "[" || token === "{") depth++;
		if (token === ")" || token === "]" || token === "}") {
			depth--;
			if (depth < 0 || (call && depth === 0)) return index + 1;
		}
	}
	return source.length;
}

/** 1-based line numbers where `anchor` survives as CODE in `source`. */
function liveAnchorLines(source: string, anchor: string): number[] {
	return stripSource(source)
		.split("\n")
		.flatMap((line, index) => (line.includes(anchor) ? [index + 1] : []));
}

/**
 * This sweep's own roots. The enumeration (and the `.js`-twin rule) lives in
 * `tests/support/ast-census.ts`; the container guard keeps its own root list
 * and the two populations never merge (#4606 S0).
 */
function shippedSourceFiles(): string[] {
	return censusSourceFiles(
		["clients", "tools", "mcp", "scripts", "tests/support", "index.ts"].map(
			(root) => path.join(REPO_ROOT, root),
		),
		{ extensions: [".ts", ".mjs", ".js"], skipTests: true },
	);
}

/** Every eviction program in one source text, as 1-based line numbers. */
export function findEvictionLines(stripped: string): number[] {
	return findEvictionPrograms(stripped).map((program) => program.line);
}

/** One flagged occurrence: its stable key plus a `file:line` diagnostic detail. */
interface FlaggedOccurrence {
	key: string;
	detail: string;
	form: string;
}

function findFlaggedOccurrences(): {
	occurrences: FlaggedOccurrence[];
	scanned: number;
} {
	const files = shippedSourceFiles();
	const occurrences: FlaggedOccurrence[] = [];
	for (const abs of files) {
		const rel = relativePosix(REPO_ROOT, abs);
		if (rel === DEFINITION_FILE) continue;
		const source = fs.readFileSync(abs, "utf8");
		const stripped = stripSource(source);
		const lines = stripped.split("\n");
		const starts = lineStartOffsets(stripped);
		for (const program of findEvictionPrograms(source)) {
			const line = program.line;
			occurrences.push({
				key: stableOccurrenceKey(
					rel,
					lines.map((text, index) => {
						// Same first line, different eligibility policy (#4580 r3):
						// hash the complete declaration, not its formatter's first line.
						if (index !== line - 1 || !/^\s*(?:const|let|var)\b/.test(text))
							return text;
						const start = starts[index] ?? 0;
						return stripped
							.slice(start, balancedEnd(stripped, start))
							.replace(/\s+/g, " ");
					}),
					line - 1,
				),
				detail: `${rel}:${line}`,
				form: program.form,
			});
		}
	}
	return { occurrences, scanned: files.length };
}

describe("#2442 no new hand-rolled evict-oldest program outside bounded-cache.ts", () => {
	const { occurrences, scanned } = findFlaggedOccurrences();
	const flagged = occurrences.map((o) => o.key);

	it("actually finds the family (a dead scan must not read as clean)", () => {
		// The registered population includes runtime eviction policies and two
		// tooling matches. The registry audit below rejects missing/stale entries.
		expect(flagged.length).toBeGreaterThanOrEqual(1);
	});

	// #4606 S1: one plant per ADMITTED FORM, plus the refusal that proves the
	// form's own gate. Each plant is a shape the lexical detector missed; the
	// red-first evidence (master's detector returns [] for every one of them) is
	// in the PR body, and the per-form mutation that reds these rows is quoted
	// there too.
	const FORM_PLANTS: Readonly<
		Record<
			string,
			{
				readonly plant: string;
				readonly line: number;
				readonly refused: string;
			}
		>
	> = {
		"iterator-head": {
			plant: [
				"function trim(m, CAP) {",
				"  while (m.size > CAP) {",
				"    const oldest = m.keys().next();",
				"    if (oldest.done) break;",
				"    m.delete(oldest.value);",
				"  }",
				"}",
			].join("\n"),
			line: 3,
			refused: [
				"function peek(m) {",
				"  const oldest = m.keys().next();",
				"  return oldest.done ? undefined : oldest.value;",
				"}",
			].join("\n"),
		},
		"ordered-victim": {
			plant: [
				"function trim(m, CAP) {",
				"  while (m.size > CAP) {",
				"    const victim = [...m.entries()].sort(cmp)[0];",
				"    if (!victim) break;",
				"    evictFile(victim[0]);",
				"  }",
				"}",
			].join("\n"),
			line: 3,
			refused: [
				"function rank(rows) {",
				"  const victim = [...rows].sort(cmp)[0];",
				"  return victim;",
				"}",
			].join("\n"),
		},
		"ordered-scan": {
			plant: [
				"function trim(m, CAP) {",
				"  while (m.size > CAP) {",
				"    let victim;",
				"    for (const key of m.keys()) if (pred(key)) victim = key;",
				"    m.delete(victim ?? Math.min(...m.keys()));",
				"  }",
				"}",
			].join("\n"),
			line: 4,
			refused: [
				"function sweep(m, CAP) {",
				"  while (m.size > CAP) {",
				"    for (const key of m.keys()) if (pred(key)) m.delete(key);",
				"  }",
				"}",
			].join("\n"),
		},
		"count-truncation": {
			plant: [
				"const MAX_TOOLS = 4;",
				"function persist(tools) {",
				"  tools.sort(byLastSeen);",
				"  const bounded = tools.slice(-MAX_TOOLS);",
				"  writeFileSync(path, JSON.stringify({ tools: bounded }));",
				"}",
			].join("\n"),
			line: 4,
			refused: [
				"const LIMIT = 12;",
				"function show(rows) {",
				"  const ranked = [...rows].sort(cmp);",
				"  const shown = ranked.slice(0, LIMIT);",
				"  console.log(shown);",
				"}",
			].join("\n"),
		},
	};

	it("tables every admitted form, and only those", () => {
		expect(Object.keys(FORM_PLANTS).sort()).toEqual([...EVICTION_FORMS].sort());
		// Every form the recognizer knows is exercised by a plant, and every plant
		// belongs to a form the recognizer knows: a new form without a plant, or a
		// plant for a form that no longer exists, reds here.
		expect(new Set(Object.keys(FORM_PLANTS)).size).toBe(EVICTION_FORMS.length);
	});

	it.each(EVICTION_FORMS)(
		"flags the %s plant and refuses the shape it gates",
		(form) => {
			const plan = FORM_PLANTS[form];
			if (plan === undefined) throw new Error(`no plant for form ${form}`);
			const found = findEvictionPrograms(plan.plant);
			expect(found.map((program) => program.line)).toEqual([plan.line]);
			expect(found[0]?.form).toBe(form);
			// The refusal is the same shape with ONE stage removed, so a gate that
			// stops gating turns this row red instead of quietly widening.
			expect(findEvictionPrograms(plan.refused)).toEqual([]);
		},
	);

	// Shape-69 spellings INSIDE an admitted form. Each resolves to the form that
	// owns it; a matcher anchored on one spelling would pass the others.
	it("resolves an alias, an indirect accessor, and a `$`-initial victim", () => {
		expect(
			findEvictionPrograms(
				[
					"const byCall = this.checked;",
					"while (byCall.size > CAP) {",
					"  const oldest = byCall.keys().next();",
					"  if (oldest.done) break;",
					"  byCall.delete(oldest.value);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([3]);
		expect(
			findEvictionPrograms(
				[
					"const iteratorOf = (container) => container.keys();",
					"while (m.size > CAP) {",
					"  const oldest = iteratorOf(m).next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([3]);
		expect(
			findEvictionPrograms(
				[
					"while (m.size > CAP) {",
					"  const $oldest = m.keys().next();",
					"  if ($oldest.done) break;",
					"  m.delete($oldest?.value);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([2]);
	});

	it("resolves a formatter wrap inside the accessor chain and after `=`", () => {
		// #4580 review F1: two live members were invisible to a line-anchored
		// matcher because the chain wrapped.
		expect(
			findEvictionPrograms(
				[
					"while (m.size > CAP) {",
					"  const oldest =",
					"    m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([2]);
		// The tombstone trim's shape: `.values()` on its own line, `.next()` on
		// the next.
		expect(
			findEvictionPrograms(
				[
					"while (evicted.size > CAP) {",
					"  const oldest = evicted",
					"    .values()",
					"    .next().value;",
					"  if (oldest === undefined) break;",
					"  evicted.delete(oldest);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([2]);
	});

	it("resolves destructured iterator results and a minimum scan", () => {
		// The Windows CPU-history trim: `for (const [key, entry] of map)` with an
		// explicit smallest-timestamp scan. The lexical detector required a bare
		// identifier loop variable, so a destructured result was invisible.
		expect(
			findEvictionPrograms(
				[
					"while (history.size > CAP) {",
					"  let oldestKey;",
					"  let oldestTs = Number.POSITIVE_INFINITY;",
					"  for (const [key, entry] of history) {",
					"    if (entry.ts < oldestTs) {",
					"      oldestKey = key;",
					"      oldestTs = entry.ts;",
					"    }",
					"  }",
					"  if (oldestKey === undefined) break;",
					"  history.delete(oldestKey);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([4]);
	});

	it("resolves comparator sources, transforms, and selectors", () => {
		// Shape 69: the ordering operation owns recognition, not its receiver, and
		// a transparent transform must not hide ordered removal.
		for (const source of [
			"[...m.keys()]",
			"[...m.values()]",
			"[...m.entries()]",
			"Array.from(m.entries())",
		]) {
			for (const order of ["sort(cmp)", "sort()", "toSorted(cmp)"]) {
				const found = findEvictionPrograms(
					[
						"function trim(m, CAP) {",
						"  while (m.size > CAP) {",
						`    const victim = ${source}.${order}[0];`,
						"    m.delete(victim);",
						"  }",
						"}",
					].join("\n"),
				);
				expect(
					found.map((program) => program.line),
					`${source}.${order}`,
				).toEqual([3]);
			}
		}
		for (const transform of [
			".filter(eligible)",
			".map(identity)",
			".slice(0)",
			".filter(([, e]) => { return eligible(e); }).map(identity)",
		]) {
			expect(
				findEvictionPrograms(
					[
						"function trim(m, CAP) {",
						"  while (m.size > CAP) {",
						`    const victim = [...m.entries()]${transform}.sort(cmp)[0];`,
						"    m.delete(victim[0]);",
						"  }",
						"}",
					].join("\n"),
				).map((program) => program.line),
				transform,
			).toEqual([3]);
		}
		for (const selector of [
			"[0]",
			".at(0)",
			".find(eligible)",
			".shift()",
			".pop()",
		]) {
			expect(
				findEvictionPrograms(
					[
						"function trim(m, CAP) {",
						"  while (m.size > CAP) {",
						`    const victim = [...m.entries()].sort(cmp)${selector};`,
						"    if (!victim) break;",
						"    m.delete(victim[0] ?? victim);",
						"  }",
						"}",
					].join("\n"),
				).map((program) => program.line),
				selector,
			).toEqual([3]);
		}
	});

	it("resolves the early-return complement, a ceiling call, and a length cap", () => {
		// The guard may stand OUTSIDE the program: a complement early return, a
		// ceiling read through a call, or an in-place truncation under its own
		// length cap all bound the same sequence.
		expect(
			findEvictionPrograms(
				[
					"function trim(m, CAP) {",
					"  if (m.size <= CAP) return;",
					"  const victim = [...m.entries()].sort(cmp)[0];",
					"  evictEntry(victim[0]);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([3]);
		expect(
			findEvictionPrograms(
				[
					"function trim(m, getCeiling) {",
					"  const occupied = occupiedKeys.size;",
					"  if (occupied < getCeiling()) return true;",
					"  const idle = [...m.entries()].sort(cmp);",
					"  const victim = idle[0];",
					"  const [key, client] = victim;",
					"  retireClient(key);",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([4]);
		expect(
			findEvictionPrograms(
				[
					"const MAX_ROWS = 8;",
					"function trim(rows) {",
					"  if (rows.length > MAX_ROWS) {",
					"    rows.sort(byAge);",
					"    rows.length = MAX_ROWS;",
					"  }",
					"}",
				].join("\n"),
			).map((program) => program.line),
		).toEqual([5]);
	});

	it("does NOT flag a peek, a ranking read, an unrelated delete, or prose", () => {
		// Each refusal removes exactly one stage from an admitted form.
		expect(
			findEvictionPrograms(
				[
					"export function getCurrentPhase() {",
					"  const oldest = liveBrackets.keys().next();",
					"  return oldest.done ? undefined : oldest.value;",
					"}",
				].join("\n"),
			),
			"a peek never removes",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function lastCandidates(candidates) {",
					"  candidates.sort(byPriority);",
					"  const selected = candidates[0];",
					"  return selected;",
					"}",
				].join("\n"),
			),
			"a ranking read evicts nothing",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"while (m.size > CAP) {",
					"  const oldest = m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(other.key);",
					"}",
				].join("\n"),
			),
			"the removal names a different key",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function sweep(m, CAP) {",
					"  while (m.size > CAP) {",
					"    for (const key of m.keys()) if (pred(key)) m.delete(key);",
					"  }",
					"}",
				].join("\n"),
			),
			"a filtered drain chooses no victim",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function trim(rows, CAP) {",
					"  if (rows.length > CAP) {",
					"    const victim = [...rows].sort(cmp)[0];",
					"    consume(victim);",
					"  }",
					"}",
				].join("\n"),
			),
			"an ordered ARRAY of values is scanned, not evicted",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function pick(m) {",
					"  const victim = [...m.entries()].sort(cmp)[0];",
					"  evictFile(victim[0]);",
					"}",
				].join("\n"),
			),
			"a hand-off with no cap at all is a ranking",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function drain(queue) {",
					"  while (queue.length > 0) {",
					"    const head = queue.keys().next();",
					"    if (head.done) break;",
					"    queue.delete(head.value);",
					"  }",
					"}",
				].join("\n"),
			),
			"a loop bounded by emptiness has no cap to exceed",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"// while (m.size > CAP) { const victim = [...m.entries()].sort(cmp)[0]; m.delete(victim[0]); }",
					'const note = "const oldest = m.keys().next(); m.delete(oldest.value);";',
					"const unrelated = 1;",
				].join("\n"),
			),
			"prose is not a program",
		).toEqual([]);
	});

	it("does NOT flag a count window or a display truncation", () => {
		// A count that states a size is not a cap, and a string window is never
		// eviction: both would otherwise ride the retention row.
		expect(
			findEvictionPrograms(
				[
					"const targets = [...docs]",
					"  .sort(bySize)",
					"  .slice(0, editCount);",
				].join("\n"),
			),
			"no cap, no retention",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function firstKeyChange(before, after) {",
					"  const added = [...after].filter((key) => !before.has(key)).sort();",
					"  if (added.length > 0) return `added ${added[0]}`;",
					"  return 'none';",
					"}",
				].join("\n"),
			),
			"a zero threshold is emptiness",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"function median(values) {",
					"  const sorted = [...values].sort((a, b) => a - b);",
					"  return sorted[Math.floor(sorted.length / 2)];",
					"}",
				].join("\n"),
			),
			"index arithmetic is not a truncation",
		).toEqual([]);
		expect(
			findEvictionPrograms(
				[
					"const TAIL_LINES = 5;",
					"function tail(output) {",
					"  const record = {",
					'    tail: output.split("\\n").slice(-TAIL_LINES).join("\\n"),',
					"  };",
					"  writeFileSync(path, JSON.stringify(record));",
					"}",
				].join("\n"),
			),
			"a string window is capped for display",
		).toEqual([]);
	});

	it("flags per OCCURRENCE, so an exemption cannot launder a new sibling", () => {
		// #2442 review F6: exemptions used to be file-level, so appending a NEW
		// eviction to an exempted file passed. Every flagged id carries a
		// content-derived key (#2475: `path#symbol:hash` or `path#hash`, never a
		// bare line number — see `stableOccurrenceKey`).
		for (const item of flagged) {
			expect(item).toMatch(
				/^[\w./-]+\.(?:ts|mjs|js)#(?:[A-Za-z_$][\w$]*:)?[0-9a-f]{8}$/,
			);
		}
		const exemptedFiles = new Set(
			Object.keys(EXEMPT_SITES).map((k) => k.split("#")[0]),
		);
		// Every exempted FILE still has exactly the occurrences named, no more:
		// a second, unexcused occurrence in the same file must show up as
		// unaccounted below rather than riding the file's exemption.
		for (const file of exemptedFiles) {
			const inFile = flagged.filter((f) => f.startsWith(`${file}#`));
			for (const occurrence of inFile) {
				expect(
					Object.hasOwn(EXEMPT_SITES, occurrence),
					`${occurrence} is in an exempted file but is not itself exempted`,
				).toBe(true);
			}
		}
	});

	// #2487 review F1: the test above ("flags per OCCURRENCE") is vacuous
	// against a real collision, because `expect(item).toBe(...)` compares the
	// SAME string to itself when two occurrences hash to one key — it cannot
	// distinguish "this occurrence is exempted" from "some occurrence sharing
	// this key is exempted". This test runs a REAL twin-collision fixture
	// through the actual detection pipeline, and proves `auditRegistry` itself
	// refuses to let one exemption cover both.
	it("ATTACK_TWIN_OCCURRENCE_COLLISION (#2487 review F1): two sibling methods with an identical flagged line cannot share one exemption", () => {
		const rel = "clients/__probe_twin_cache.ts";
		const source = [
			"class ProbeTwinCache {",
			"\tevictFirst() {",
			"\t\tlet victim;",
			"\t\twhile (this.map.size > CAP) {",
			"\t\t\tfor (const k of this.map.keys()) victim = k;",
			"\t\t\tthis.map.delete(victim);",
			"\t\t}",
			"\t}",
			"\tevictSecond() {",
			"\t\tlet victim;",
			"\t\twhile (this.map.size > CAP) {",
			"\t\t\tfor (const k of this.map.keys()) victim = k;",
			"\t\t\tthis.map.delete(victim);",
			"\t\t}",
			"\t}",
			"}",
		].join("\n");
		const evictionLines = findEvictionLines(source);
		expect(evictionLines).toEqual([5, 12]); // both flagged by the REAL detector
		const lines = source.split("\n");
		const twinOccurrences = evictionLines.map((line) => ({
			key: stableOccurrenceKey(rel, lines, line - 1),
			detail: `${rel}:${line}`,
		}));
		// Precondition: both really do collide on one key — same enclosing
		// symbol (the class), same flagged-line text.
		expect(twinOccurrences[0]?.key).toBe(twinOccurrences[1]?.key);

		// One exemption, keyed to the shared string: pre-guard this read clean
		// (laundered); the collision guard must refuse it.
		const laundered = auditRegistry({
			sweepName: "probe twin sweep",
			flagged: twinOccurrences,
			registered: [],
			exemptions: {
				[twinOccurrences[0]!.key]: "reviewed exemption for one occurrence",
			},
		});
		expect(laundered.problems.join("\n")).toContain("collide");

		// The remedy this sweep ships is the message's own instruction: a human
		// edits the flagged line's own text so its content hash genuinely
		// differs, which is what distinguishes two occurrences a mechanical scan
		// cannot tell apart on its own.
		const distinguishedSource = source.replace(
			"\tevictSecond() {\n\t\tlet victim;\n\t\twhile (this.map.size > CAP) {\n\t\t\tfor (const k of this.map.keys()) victim = k;",
			"\tevictSecond() {\n\t\tlet victim;\n\t\twhile (this.map.size > CAP) {\n\t\t\tfor (const key of this.map.keys()) victim = key;",
		);
		const distinguishedLines = distinguishedSource.split("\n");
		const distinguishedEvictionLines = findEvictionLines(distinguishedSource);
		expect(distinguishedEvictionLines).toEqual([5, 12]); // same lines...
		const distinguishedOccurrences = distinguishedEvictionLines.map((line) => ({
			key: stableOccurrenceKey(rel, distinguishedLines, line - 1),
			detail: `${rel}:${line}`,
		}));
		// ...but no longer the same KEY: `key` vs `k` changed the flagged
		// line's own text, so its content hash — not its position — differs.
		expect(distinguishedOccurrences[0]!.key).not.toBe(
			distinguishedOccurrences[1]!.key,
		);
		const properlyExempted = auditRegistry({
			sweepName: "probe twin sweep",
			flagged: distinguishedOccurrences,
			registered: [],
			exemptions: {
				[distinguishedOccurrences[0]!.key]:
					"reviewed exemption for evictFirst's occurrence",
				[distinguishedOccurrences[1]!.key]:
					"reviewed exemption for evictSecond's occurrence",
			},
		});
		expect(properlyExempted.problems).toEqual([]);
	});

	it("accounts for the live programs the recognizer refuses", () => {
		// The detector's population is not the tree's. Each refusal is proved a
		// miss against the REAL recognizer and its anchor is re-read from the real
		// file, so a row can neither go stale nor describe a site that migrated.
		const rows = Object.entries(REFUSED_PROGRAMS);
		expect(rows.length).toBeGreaterThanOrEqual(4);
		const witnesses: string[] = [];
		let anchorChecks = 0;
		for (const [spelling, row] of rows) {
			const source = fs.readFileSync(path.join(REPO_ROOT, row.file), "utf8");
			const anchors = liveAnchorLines(source, row.anchor);
			anchorChecks += 1;
			if (anchors.length !== row.count) {
				witnesses.push(
					`${row.file}: ${spelling} anchor ${JSON.stringify(row.anchor)} matched ${anchors.length} lines`,
				);
				continue;
			}
			if (findEvictionPrograms(source).some((p) => p.line === anchors[0])) {
				witnesses.push(
					`${row.file}: ${JSON.stringify(row.anchor)} is now flagged — delete or migrate the row`,
				);
			}
		}
		expect(witnesses).toEqual([]);
		expect(anchorChecks).toBe(rows.length);
	});

	it("every occurrence is the definition file, migrated, or exempted with a reason", () => {
		const audit = auditRegistry({
			sweepName: "bounded-eviction-idiom sweep",
			flagged: occurrences,
			registered: [],
			exemptions: EXEMPT_SITES,
			scannedCount: scanned,
			// Calibration: ~789 shipped files across clients/tools/mcp/scripts/
			// tests/support/index.ts as of #4606 S1; half rounded down is
			// comfortably under that.
			minScanned: 300,
			// The structural population is 24 programs: 16 the lexical detector also
			// saw, 8 it could not (7 from #4606's measurement plus the script-side
			// `pushTop` cap). A lost member must red, so the floor is the count.
			minFlagged: 24,
			remediation:
				"Migrate the site to BoundedLruCache (get() re-inserts — LRU), " +
				"BoundedFifoMap (get() never re-inserts — FIFO), or BoundedSet " +
				"(Set-shaped, membership-only — #2460) from " +
				"clients/bounded-cache.ts — all three return the evicted " +
				"key(s)/value(s) from set()/add(), so eviction-side bookkeeping " +
				"needs no hand-rolled block either — or add an EXEMPT_SITES entry " +
				"here (keyed by " +
				"`stableOccurrenceKey` from tests/support/sweep-kit.ts — " +
				"`path#symbol:hash` or `path#hash`, printed above) with a real " +
				"reason (see #2442's PR body verdict table for the shape of a " +
				"legitimate exemption). A shape the structural recognizer cannot " +
				"place is a REFUSED_PROGRAMS row: it names the stage the shape " +
				"lacks and the live site, never a silent pass.",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
		const byForm = new Map<string, number>();
		for (const occurrence of occurrences)
			byForm.set(occurrence.form, (byForm.get(occurrence.form) ?? 0) + 1);
		process.stdout.write(
			`bounded-eviction population: ${flagged.length} flagged, ${audit.problems.length} problems, ${REFUSED_PROGRAMS && Object.keys(REFUSED_PROGRAMS).length} refused live programs, ${scanned} source files\n` +
				`bounded-eviction stages: ${EVICTION_FORMS.map((form) => `${form} ${byForm.get(form) ?? 0}`).join(", ")}\n`,
		);
	});
});
