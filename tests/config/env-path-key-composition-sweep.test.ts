/**
 * #4590 — env composition lint for the platform `PATH` key.
 *
 * Windows' environment block is CASE-INSENSITIVE, while a Node
 * `NodeJS.ProcessEnv` object is not. So an env object that writes the path
 * variable under two spellings (`PATH` and `Path`) hands the child two names
 * for one variable, and one of them shadows the other in the block the child
 * actually receives. Writing only `PATH` over a base that already carries
 * `Path` (`{ ...process.env, PATH: next }`) has the same effect, because the
 * spread is what supplied the other spelling.
 *
 * The shape has already redded a release lane: #4566 round 9 (Greptile
 * `4302492421`, "Child lookups use wrong PATH") found a trust-scoped env that
 * READ `Path` and WROTE `PATH`, and the round-10 fix
 * (`a82a09699`) replaced the dual-spelling literals with one setter that picks
 * the key per platform. The round-14 threads the issue names
 * (`4303887682`, `4304149666`) are the same PR's launcher cells failing on
 * Windows. The literal the round-10 fix removed is still on master today
 * (`clients/lsp/launch.ts`), which is why this sweep ships with a seeded
 * baseline rather than a clean tree.
 *
 * ## The rule
 *
 * One sanctioned composition: a FRESH object literal that writes the path
 * variable under exactly one spelling, with nothing inherited into it. Every
 * other write is a finding, with the reason it is one:
 *
 * - `dual-spelling` — the composition writes both spellings. That is the
 *   defect itself, and it is also why the "cover both spellings" idiom loses:
 *   the second write is what shadows the first.
 * - `spread-override` — the literal writes one spelling over a spread
 *   (`{ ...base, PATH: next }`). The base is what supplied the other spelling
 *   on Windows, so the composition still carries two names.
 * - `live-process-env` — a `process.env.PATH = …` write. `process.env` is the
 *   base of every child env, so the write has the same inheritance problem and
 *   reaches the HOST process besides.
 * - `unclassified-spelling` — a member write on a base whose contents this
 *   sweep cannot see (`env["PATH"] = …` on a parameter), or a path-folded
 *   spelling it does not recognise inside an env-identified composition. This
 *   is the fail-closed arm: an env-key write the classifier cannot place is a
 *   finding, never a silent pass (AGENTS.md shape 69).
 *
 * ## There is no helper to point at
 *
 * The remedy the issue names is "use the platform PATH-key helper". No such
 * export exists: `clients/safe-spawn.ts` has the private
 * `getWindowsEnvironmentValue`, which only READS case-insensitively, and
 * `clients/package-manager.ts` on the #4566 branch has `setTrustScopedPath`,
 * which is not on master. This lane adds the detector and does not invent a
 * production helper to satisfy it, so every current non-fresh composition is
 * seeded in {@link SEEDED_OFFENDERS} as debt with its reason. When a shared
 * composer lands, its call sites leave the baseline and the rows go stale —
 * which this test reds on.
 *
 * ## SWEEP_HEURISTIC_LIMITS
 *
 * 1. A lone `path:` (all-lowercase) key write is NOT flagged. It is
 *    indistinguishable from the `{ path: … }` DATA key that appears throughout
 *    the tree (telemetry records, route descriptors, tool payloads), and
 *    flagging that population would bury the signal. A lowercase `path` write
 *    is still counted as a PARTICIPANT when the same composition also writes
 *    `PATH` or `Path`, so a three-spelling composition is still one finding.
 * 2. The fail-closed arm needs an env-identified composition: a literal bound
 *    with a `ProcessEnv` annotation, a literal in an `env:` position, a
 *    literal spreading `process.env`, or a member write on `process.env`. A
 *    path-folded spelling in an object this sweep cannot identify as an env is
 *    not flagged, because "this key is an env PATH" is exactly what it cannot
 *    see. An env assembled by a helper in another module is out of the
 *    population for the same reason.
 * 3. A key computed at run time from a value this file does not hold
 *    (`env[await pathKey()] = …`) is invisible. A literal-const alias
 *    (`const KEY = "PATH"; env[KEY] = …`) IS resolved, because it is one
 *    binding away and costs nothing.
 * 4. The READ side is out of scope. `base.PATH ?? base.Path` and
 *    `Path`-before-`PATH` read order are the round-9 defect's shape, but a read
 *    chain is legal in both orders and this sweep does not have a verdict to
 *    offer. Reads are grepped by the reviewer, not censused here.
 * 5. A single-spelling `process.env.PATH = …` in a `tests/**` file is a harness
 *    PATH stub (set, exercise, restore), not a shipped composition, and the
 *    sweep does not census it: measured at authoring time, 92 of the tree's 94
 *    live-env writes are that stub, and a ratchet that reds on every new PATH
 *    stub would be reverted before it caught anything. Both spellings in one
 *    stub, and every literal composition, stay in scope there — the two
 *    shipped live-env writes (`clients/lsp/server.ts`, a smoke script) stay in
 *    scope too. The remedy is the same shared setter the production rows wait
 *    on; when it lands this limit can be deleted.
 *
 * Scanned trees are `clients/`, `scripts/`, `tests/` and `index.ts`, over
 * comment- and string-blanked source from the shared blanker
 * (`stripSource`): a needle inside a comment or a string can neither create a
 * finding nor launder one away. Quoted keys (`{ "PATH": … }`, `env["PATH"]`)
 * are recovered by reading the RAW text at the blanked key's own offsets.
 *
 * The seeded baseline below is 69 rows at authoring time — 13 in shipped
 * `clients/` and `scripts/` code (every dual-spelling composer in the tree:
 * `runner-helpers`, the installer's two envs, `lsp/launch`, `python-environment`)
 * and 56 in test fixtures that spawn a child with an augmented PATH. Each row
 * is keyed `file#declaration:lineHash#spelling` through the kit's own
 * `stableOccurrenceKey`, so the same spelling in another declaration, and a
 * rewritten line, are both new rows.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	lineOf,
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFiles,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** Why one env write is not the sanctioned fresh single-spelling literal. */
export type PathKeyReason =
	| "dual-spelling"
	| "spread-override"
	| "live-process-env"
	| "unclassified-spelling";

export interface PathKeyFinding {
	/** 1-based line of the key or property that writes the path variable. */
	line: number;
	/** The exact spelling written (`PATH`, `Path`, …). */
	spelling: string;
	reason: PathKeyReason;
	/** The composition the write belongs to, for a message that reads. */
	site: string;
}

/** One write of the path variable into an env object. */
interface RawWrite {
	index: number;
	spelling: string;
	kind: "literal" | "member";
	/** Grouping identity: the binding the write lands on, or the literal. */
	site: string;
	/** The composition spreads a base env, so it inherits the other spelling. */
	inheritsBase: boolean;
	/** The composition is identifiable as an env (see limit 2). */
	envIdentified: boolean;
	/** Member-write base text, normalized (`process.env`, `env`, …). */
	base?: string;
}

/** A case-insensitive match for the variable name itself. */
function foldsToPath(text: string): boolean {
	return text.toLowerCase() === "path";
}

/** The two spellings a Windows env block actually carries. */
function isCanonicalSpelling(text: string): boolean {
	return text === "PATH" || text === "Path";
}

/** `{` of the innermost object literal enclosing `index`, or -1. */
function innermostBrace(stripped: string, index: number): number {
	let depth = 0;
	for (let i = index - 1; i >= 0; i--) {
		const ch = stripped[i];
		if (ch === "}") depth++;
		else if (ch === "{") {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/**
 * Does the `{` at `open` open an object literal rather than a block?
 *
 * Decided from the token before it, the same way `stripSource` decides whether
 * a `/` opens a regex: a block follows `)`, another brace, `;`, `=>`, a class
 * or type header (`ProcessEnv> {`), or a statement keyword (`else`, `try`,
 * `finally`, `do`); an object literal stands where a VALUE may start
 * (`=`, `(`, `,`, `:`, `[`, `?`, `return`, `yield`). Without this a function
 * body reads as a literal, its `ProcessEnv` return type identifies it as an
 * env, and every spread inside the function joins the composition.
 */
function opensObjectLiteral(stripped: string, open: number): boolean {
	let i = open - 1;
	while (i >= 0 && /\s/.test(stripped[i] as string)) i--;
	if (i < 0) return false;
	const prev = stripped[i] as string;
	if ("=(,:[?".includes(prev)) return true;
	if (prev === ">") return false;
	if (!/[A-Za-z_$]/.test(prev)) return false;
	let start = i;
	while (start > 0 && /[\w$]/.test(stripped[start - 1] as string)) start--;
	const word = stripped.slice(start, i + 1);
	return word === "return" || word === "yield";
}

/**
 * Enclosing OBJECT LITERAL opens, innermost first, skipping block braces. Stops
 * when a candidate `{` does not actually close after the child, which is what a
 * sibling block looks like.
 */
function enclosingLiterals(stripped: string, index: number): number[] {
	const opens: number[] = [];
	let cursor = index;
	for (let depth = 0; depth < 12; depth++) {
		const open = innermostBrace(stripped, cursor);
		if (open < 0) break;
		const close = matchingCloseIndex(stripped, open, "{", "}");
		if (close < 0 || close < index) break;
		if (opensObjectLiteral(stripped, open)) opens.push(open);
		cursor = open;
	}
	return opens;
}

/** Literal-const aliases for the variable name, one binding away. */
function literalAliases(raw: string, stripped: string): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const match of stripped.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g,
	)) {
		const quoteIndex = (match.index ?? 0) + match[0].length;
		const quote = raw[quoteIndex];
		if (quote !== '"' && quote !== "'") continue;
		const end = raw.indexOf(quote, quoteIndex + 1);
		if (end < 0) continue;
		const value = raw.slice(quoteIndex + 1, end);
		if (foldsToPath(value)) aliases.set(match[1] as string, value);
	}
	return aliases;
}

interface Composition {
	label: string;
	open: number;
	close: number;
	envIdentified: boolean;
	inheritsBase: boolean;
	spreadNested: boolean;
}

/** Describe the object literal opening at `open`. */
function describeLiteral(stripped: string, open: number): Composition {
	const close = matchingCloseIndex(stripped, open, "{", "}");
	const window = stripped.slice(Math.max(0, open - 200), open);
	// The statement the literal opens: a previous statement's `ProcessEnv`
	// annotation must not identify this one.
	const cut = Math.max(
		window.lastIndexOf(";"),
		window.lastIndexOf("{"),
		window.lastIndexOf("}"),
	);
	const before = cut < 0 ? window : window.slice(cut + 1);
	const body = close < 0 ? "" : stripped.slice(open + 1, close);
	const binding = /([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*)?=\s*$/.exec(before);
	const assigned =
		/Object\s*\.\s*assign\s*\(\s*([A-Za-z_$][\w$.]*)\s*,\s*$/.exec(before);
	const label = binding
		? `bind:${binding[1]}`
		: assigned
			? `bind:${(assigned[1] as string).replace(/\s+/g, "")}`
			: `literal@${open}`;
	return {
		label,
		open,
		close,
		envIdentified:
			/ProcessEnv/.test(before) ||
			/\benv\s*:\s*$/.test(before) ||
			/\.\.\.\s*process\s*\.\s*env\b/.test(body),
		inheritsBase: /\.\.\./.test(body),
		// `...(cond ? { Path: next } : {})` composes INTO the enclosing literal:
		// the conditional object is not a composition of its own.
		spreadNested: /\.\.\.[^;{}]*[?:]\s*$/.test(before),
	};
}

/**
 * The composition `open` belongs to: the outermost enclosing literal that is
 * env-identified (a conditional spread inside `{ …mergedEnv, PATH }` is part of
 * that literal, not a composition of its own), else `open` itself.
 */
function rootComposition(
	stripped: string,
	open: number,
	cache: Map<number, Composition>,
): Composition {
	const chain = [
		open,
		...enclosingLiterals(stripped, open).filter((o) => o !== open),
	];
	const describe = (candidate: number): Composition => {
		let described = cache.get(candidate);
		if (described === undefined) {
			described = describeLiteral(stripped, candidate);
			cache.set(candidate, described);
		}
		return described;
	};
	let chosen = open;
	for (const [level, candidate] of chain.entries()) {
		const parent = chain[level - 1];
		if (parent !== undefined && describe(parent).spreadNested)
			chosen = candidate;
		if (describe(candidate).envIdentified) chosen = candidate;
	}
	return describe(chosen);
}

/** Object-literal keys that write the path variable. */
function literalKeyWrites(
	raw: string,
	stripped: string,
	aliases: ReadonlyMap<string, string>,
	cache: Map<number, Composition>,
): RawWrite[] {
	const writes: RawWrite[] = [];
	const push = (index: number, spelling: string): void => {
		const open = enclosingLiterals(stripped, index)[0];
		if (open === undefined) return;
		const composition = rootComposition(stripped, open, cache);
		writes.push({
			index,
			spelling,
			kind: "literal",
			site: composition.label,
			inheritsBase: composition.inheritsBase,
			envIdentified: composition.envIdentified,
		});
	};

	// `PATH:` — an identifier key, or a shorthand entry (`{ PATH }`).
	for (const match of stripped.matchAll(
		/([{,])(\s*)([A-Za-z_$][\w$]*)(\s*)(:?)/g,
	)) {
		const spelling = match[3] as string;
		if (!foldsToPath(spelling)) continue;
		const index = (match.index ?? 0) + match[1].length + match[2].length;
		// A shorthand entry (`{ PATH }`) writes the key under the spelling of its
		// own binding, so it takes the same verdict as a literal key.
		if (
			match[5] === ":" ||
			/^\s*[,}]/.test(stripped.slice((match.index ?? 0) + match[0].length))
		) {
			push(index, spelling);
		}
	}

	// `"PATH": …` — a quoted key. The blanker leaves the quotes and blanks the
	// content, so the key text is read from RAW at the same offsets.
	for (const match of stripped.matchAll(/([{,])([^\S\n]*)(["'])( *)\3/g)) {
		const quoteIndex = (match.index ?? 0) + match[1].length + match[2].length;
		const spelling = raw.slice(
			quoteIndex + 1,
			quoteIndex + 1 + match[4].length,
		);
		if (!foldsToPath(spelling)) continue;
		const after = stripped.slice((match.index ?? 0) + match[0].length);
		if (!/^\s*:/.test(after)) continue;
		push(quoteIndex + 1, spelling);
	}

	// `[PATH_KEY]: …` — a computed literal key, resolved through an alias.
	for (const match of stripped.matchAll(/([{,])([^\S\n]*)\[([^\]\n]*)\]/g)) {
		const expression = (match[3] as string).trim();
		const keyIndex = (match.index ?? 0) + match[1].length + match[2].length;
		const after = stripped.slice((match.index ?? 0) + match[0].length);
		if (!/^\s*:/.test(after)) continue;
		const alias = aliases.get(expression);
		// Fail-closed arm: an expression this file cannot resolve, naming the
		// variable. The group verdict decides whether the composition is an env
		// at all (limit 2), so a computed key in a `changes:` map stays clean.
		if (alias !== undefined) push(keyIndex + 1, alias);
		else if (/path/i.test(expression)) push(keyIndex + 1, expression);
	}

	return writes;
}

/** `x.PATH = …` / `x["PATH"] = …` member writes. */
function memberWrites(
	raw: string,
	stripped: string,
	aliases: ReadonlyMap<string, string>,
): RawWrite[] {
	const writes: RawWrite[] = [];
	for (const match of stripped.matchAll(
		/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[([^\]\n]*)\])\s*=(?!=)/g,
	)) {
		const base = (match[1] as string).replace(/\s+/g, "");
		const dotted = match[2];
		let spelling: string | undefined;
		if (dotted !== undefined) {
			if (foldsToPath(dotted)) spelling = dotted;
		} else {
			const bracketOpen = (match.index ?? 0) + match[0].indexOf("[");
			const bracketClose = (match.index ?? 0) + match[0].lastIndexOf("]");
			const key = raw
				.slice(bracketOpen + 1, bracketClose)
				.replace(/^[\s"']+|[\s"']+$/g, "");
			if (foldsToPath(key)) spelling = key;
			else {
				const alias = aliases.get(key.trim());
				if (alias !== undefined) spelling = alias;
			}
		}
		if (spelling === undefined) continue;
		writes.push({
			index: match.index ?? 0,
			spelling,
			kind: "member",
			site: `bind:${base}`,
			// A member write lands on a base this sweep cannot see; the member
			// arm below is what answers for it.
			inheritsBase: false,
			envIdentified: base === "process.env",
			base,
		});
	}
	return writes;
}

/**
 * Every path-variable env write in `source` with the reason it is not the
 * sanctioned fresh single-spelling literal. An empty array means the file
 * composes the variable safely (or does not touch it).
 */
export interface PathKeyOptions {
	/**
	 * `true` for a `tests/**` file: a single-spelling `process.env.PATH = …`
	 * there is a harness PATH stub (set, exercise, restore), not a shipped env
	 * composition, and this sweep does not census them (limit 5). The dual
	 * spelling and every literal composition stay in scope — a stub that writes
	 * BOTH spellings is the defect, not the stub.
	 */
	ambientStubAllowed?: boolean;
}

export function findPathKeyFindings(
	source: string,
	options: PathKeyOptions = {},
): PathKeyFinding[] {
	const stripped = stripSource(source, { strings: "blank" });
	const aliases = literalAliases(source, stripped);
	const cache = new Map<number, Composition>();
	const writes = [
		...literalKeyWrites(source, stripped, aliases, cache),
		...memberWrites(source, stripped, aliases),
	];

	const groups = new Map<string, RawWrite[]>();
	for (const write of writes) {
		const group = groups.get(write.site);
		if (group === undefined) groups.set(write.site, [write]);
		else group.push(write);
	}

	const findings: PathKeyFinding[] = [];
	for (const [site, group] of groups) {
		const reason = groupReason(group, options.ambientStubAllowed === true);
		if (reason === undefined) continue;
		for (const write of group) {
			findings.push({
				line: lineOf(source, write.index),
				spelling: write.spelling,
				reason,
				site,
			});
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

/** The sanctioned form is the only clean verdict; everything else names why. */
function groupReason(
	group: readonly RawWrite[],
	ambientStubAllowed: boolean,
): PathKeyReason | undefined {
	const spellings = new Set(group.map((write) => write.spelling));
	if (spellings.size > 1) return "dual-spelling";
	const only = [...spellings][0] as string;
	if (!isCanonicalSpelling(only)) {
		// Limit 1: a lone lowercase `path` write is a data key as often as an env
		// key. It still counts as a participant above, where the composition
		// itself proves what it is.
		return group.some((write) => write.envIdentified)
			? "unclassified-spelling"
			: undefined;
	}
	if (group.some((write) => write.base === "process.env")) {
		return ambientStubAllowed ? undefined : "live-process-env";
	}
	if (group.some((write) => write.inheritsBase)) return "spread-override";
	if (group.some((write) => write.kind === "member")) {
		return "unclassified-spelling";
	}
	return undefined;
}

// Real per-tree floors, set below the population at authoring time
// (506/184/1662 files) so ordinary growth never trips them while a tree
// dropped from the walk reliably does (the #1718 empty-sweep shape).
const SCAN_ROOTS: ReadonlyArray<{
	dir: string;
	extensions: string[];
	floor: number;
}> = [
	{ dir: "clients", extensions: [".ts"], floor: 380 },
	{ dir: "scripts", extensions: [".ts", ".mjs"], floor: 100 },
	{ dir: "tests", extensions: [".ts", ".mjs"], floor: 600 },
];

export interface PathKeyCensus {
	/** `file#declaration#spelling` → why it is a finding. */
	identities: Map<string, PathKeyReason>;
	findings: PathKeyFinding[];
	scanned: number;
}

export function censusPathKeyCompositions(): PathKeyCensus {
	const files: string[] = [];
	for (const { dir, extensions, floor } of SCAN_ROOTS) {
		const found = listSourceFiles(path.join(REPO_ROOT, dir), {
			extensions,
			skipDeclarations: true,
		});
		assertNonEmptyScan(`${dir}/`, found.length, floor);
		files.push(...found);
	}
	files.push(path.join(REPO_ROOT, "index.ts"));

	const identities = new Map<string, PathKeyReason>();
	const occurrences = new Map<string, number>();
	const findings: PathKeyFinding[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		const rel = relativePosix(REPO_ROOT, file);
		const lines = source.split("\n");
		for (const finding of findPathKeyFindings(source, {
			ambientStubAllowed: /\.test\.[cm]?ts$/.test(rel),
		})) {
			const base = `${stableOccurrenceKey(rel, lines, finding.line - 1)}#${finding.spelling}`;
			// Two byte-identical flagged lines inside one declaration share the
			// content key (a test that sets and restores the same env write). The
			// n-th occurrence is disambiguated by order within the file, which is
			// deterministic because findings are sorted by line; the pair keeps
			// distinct rows so neither can excuse the other.
			occurrences.set(base, (occurrences.get(base) ?? 0) + 1);
			const seen = occurrences.get(base) as number;
			const identity = seen === 1 ? base : `${base}~${seen}`;
			identities.set(identity, finding.reason);
			findings.push(finding);
		}
	}
	return { identities, findings, scanned: files.length };
}

/**
 * Current offenders, by `file#declaration#spelling`.
 *
 * Every row is DEBT, not an approved composition: the tree composes the path
 * variable under two spellings (or over an inherited base) where a child on
 * Windows receives one name for two variables. They are seeded, not fixed,
 * because the remedy is a shared platform-key composer that does not exist on
 * master yet — see the docstring's "There is no helper to point at". A row that
 * no longer matches a live finding is stale and reds, so a fix must delete its
 * row in the same change; a finding with no row reds, so a new offender cannot
 * join the debt silently.
 */
const SEEDED_OFFENDERS: Readonly<Record<string, PathKeyReason>> = {
	// --- shipped clients/ ----------------------------------------------
	"clients/dispatch/runners/utils/runner-helpers.ts#getManagedToolEnvironment:459c017b#PATH":
		"dual-spelling",
	"clients/dispatch/runners/utils/runner-helpers.ts#getManagedToolEnvironment:655252cf#Path":
		"dual-spelling",
	"clients/installer/index.ts#getToolEnvironment:2675e706#Path":
		"dual-spelling",
	"clients/installer/index.ts#getToolEnvironment:459c017b#PATH":
		"dual-spelling",
	"clients/installer/index.ts#installPipTool:89cff3da#PATH": "dual-spelling",
	"clients/installer/index.ts#installPipTool:8b19a5cf#Path": "dual-spelling",
	"clients/lsp/launch.ts#launchLSP:459c017b#PATH": "dual-spelling",
	"clients/lsp/launch.ts#launchLSP:d1a02f78#Path": "dual-spelling",
	"clients/lsp/server.ts#tryGemInstall:6891b8bb#PATH": "live-process-env",
	"clients/python-environment.ts#augmentPythonEnvironment:0f4140e0#Path":
		"dual-spelling",
	"clients/python-environment.ts#augmentPythonEnvironment:459c017b#PATH":
		"dual-spelling",
	// --- shipped scripts/ ----------------------------------------------
	"scripts/guard-bash-probe.mjs#childEnv:26482799#PATH": "spread-override",
	"scripts/smoke-availability-lifecycle.mjs#main:cc494592#PATH":
		"live-process-env",
	// --- test fixtures (tests/) ----------------------------------------
	// A deliberate FENCE, not debt: `testEnv` deletes every path-folded key from
	// the copied env and then writes ONE spelling. The sweep cannot see the
	// delete loop from the write, so it reads as unclassified.
	"tests/clients/installer/installer-lifecycle.integration.test.ts#testEnv:809cb69e#PATH":
		"unclassified-spelling",
	"tests/clients/installer/pip-pep668.test.ts#runInstaller:e5211340#PATH":
		"spread-override",
	"tests/clients/installer/pip-pep668.test.ts#runResolved:a18d7145#PATH":
		"spread-override",
	"tests/clients/installer/pip-pep668.test.ts#writeConstraintAwarePipx:f7d1c605#PATH":
		"spread-override",
	"tests/clients/installer/pip-pep668.test.ts#writeConstraintAwarePipx:f7d1c605#PATH~2":
		"spread-override",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:06098579#PATH":
		"dual-spelling",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:3061167c#PATH":
		"dual-spelling",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:7a36028d#Path":
		"dual-spelling",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:cc3ed082#path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#1e0c5e10#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#1e0c5e10#Path~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#70587e36#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#8601dcf0#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#8601dcf0#PATH~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#d8954296#PATH":
		"dual-spelling",
	// Fixtures that DELIBERATELY set both spellings, to test which one the
	// resolver picks (`{ PATH: "ambient-path", Path: "ambient-duplicate" }`).
	// The lint cannot tell a simulated Windows block from an accidental one, so
	// the rows are seeded; a fixture helper that names the intent can leave them.
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#PATH~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#PATH~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#Path~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#Path~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:becc49c4#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:becc49c4#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#PATH~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#PATH~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#Path~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#Path~3":
		"dual-spelling",
	"tests/clients/turn-scenarios.test.ts#knipUnavailableReason:8aacd496#PATH":
		"unclassified-spelling",
	"tests/real-harness/fixture-shape.test.ts#52f702aa#Path": "spread-override",
	"tests/real-harness/fixture-shape.test.ts#6040a859#PATH": "spread-override",
	"tests/real-harness/fixture-shape.test.ts#8475e62f#PATH": "spread-override",
	"tests/real-harness/fixture-shape.test.ts#b9fbf1c2#PATH": "spread-override",
	"tests/scripts/astgrep-self-scan.test.ts#d:9989b09e#PATH": "spread-override",
	"tests/scripts/check-pr-body.test.ts#existsBaseFixtures:bf4943de#PATH":
		"spread-override",
	"tests/scripts/ci-test-diff.test.ts#fixture:e9d36405#PATH": "spread-override",
	"tests/scripts/ci-verdict.test.ts#31e1b4f8#PATH": "spread-override",
	"tests/scripts/download-test-history-artifacts.test.ts#fakeGh:e5468918#PATH":
		"spread-override",
	"tests/scripts/floor-steps-executed.test.ts#runStep:3e111efd#PATH":
		"spread-override",
	"tests/scripts/install-smoke-handshake-steps.test.ts#bash:8c06ec3b#PATH":
		"spread-override",
	"tests/scripts/lane-check.test.ts#runLane:f2fe9f48#PATH": "spread-override",
	"tests/scripts/lint-js.test.ts#runNodeWithOxlint:e2627086#PATH":
		"spread-override",
	"tests/scripts/notify-install-smoke-drift.test.ts#EXISTING_TRACKER:7b47e8d1#PATH":
		"spread-override",
	"tests/scripts/notify-install-smoke-drift.test.ts#runReal:8e11d0c7#PATH":
		"spread-override",
	"tests/scripts/notify-tool-smoke-red.test.ts#GREEN_ENV:7b47e8d1#PATH":
		"spread-override",
	"tests/scripts/notify-tool-smoke-red.test.ts#runReal:8e11d0c7#PATH":
		"spread-override",
	"tests/scripts/npm-retry.test.ts#runCli:7b47e8d1#PATH": "spread-override",
	"tests/scripts/npm-retry.test.ts#runCli:7b47e8d1#PATH~2": "spread-override",
	"tests/scripts/pre-commit-hook.test.ts#enterFixture:13462f5c#PATH":
		"spread-override",
	"tests/scripts/red-on-base.test.ts#run:9af7db0a#PATH": "spread-override",
	"tests/scripts/release-qa.test.ts#row:11e81b7f#PATH": "spread-override",
	"tests/scripts/release-qa.test.ts#row:ca835e61#PATH": "spread-override",
	"tests/scripts/release-qa.test.ts#row:f4153f23#PATH": "spread-override",
	"tests/scripts/resolve-newest-in-range-host.test.ts#runCli:2b7ac868#PATH":
		"spread-override",
	"tests/scripts/resolve-newest-in-range-host.test.ts#runCli:7b47e8d1#PATH":
		"spread-override",
};

function compare(
	census: PathKeyCensus,
	seeded: Readonly<Record<string, PathKeyReason>>,
): { unseeded: string[]; stale: string[]; drifted: string[] } {
	const unseeded: string[] = [];
	const drifted: string[] = [];
	for (const [identity, reason] of census.identities) {
		const expected = seeded[identity];
		if (expected === undefined) {
			unseeded.push(`${identity} (${reason})`);
		} else if (expected !== reason) {
			drifted.push(`${identity}: seeded ${expected}, now ${reason}`);
		}
	}
	const stale = Object.keys(seeded).filter(
		(identity) => !census.identities.has(identity),
	);
	return { unseeded, stale, drifted };
}

const REMEDIATION =
	"Compose a child env as a FRESH object literal with ONE path spelling " +
	"(`{ PATH: next }`), or route the write through the shared platform-key " +
	"composer once one exists — then delete the baseline row in " +
	"tests/config/env-path-key-composition-sweep.test.ts. Refs #4590.";

describe("#4590 env PATH composition", () => {
	it("flags a composition that writes both PATH and Path", () => {
		const findings = findPathKeyFindings(
			[
				"const child = {",
				"\t...base,",
				"\tPATH: augmented,",
				"\t...(isWindows ? { Path: augmented } : {}),",
				"};",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PATH", "dual-spelling"],
			[4, "Path", "dual-spelling"],
		]);
	});

	it("flags a spread plus an override, and a helper-composed base", () => {
		const findings = findPathKeyFindings(
			[
				"export function scoped(env: NodeJS.ProcessEnv) {",
				"\treturn { ...env, PATH: next(env) };",
				"}",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[2, "PATH", "spread-override"],
		]);
	});

	it("resolves a computed key through a literal-const alias", () => {
		const findings = findPathKeyFindings(
			[
				'const PATH_KEY = "Path";',
				"const env = { ...base, [PATH_KEY]: next };",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[2, "Path", "spread-override"],
		]);
	});

	it("flags a live process.env write, and both spellings of it", () => {
		const single = findPathKeyFindings(
			"process.env.PATH = `${dir}${sep}PATH`;",
		);
		expect(single.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "live-process-env"],
		]);
		const both = findPathKeyFindings(
			[
				"process.env.PATH = updated;",
				"if (isWindows) process.env.Path = updated;",
			].join("\n"),
		);
		expect(both.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "dual-spelling"],
			[2, "Path", "dual-spelling"],
		]);
	});

	it("flags a member write on a base it cannot see, and an unrecognised spelling in an env", () => {
		const opaque = findPathKeyFindings(
			'function apply(env, value) { env["PATH"] = value; }',
		);
		expect(opaque.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "unclassified-spelling"],
		]);
		const odd = findPathKeyFindings(
			[
				"const env: NodeJS.ProcessEnv = {",
				"\t...base,",
				"\tPaTh: next,",
				"};",
			].join("\n"),
		);
		expect(odd.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PaTh", "unclassified-spelling"],
		]);
	});

	it("reads a quoted key from raw source and a shorthand entry from code", () => {
		const quoted = findPathKeyFindings(
			['const env = { ...base, "PATH": next };'].join("\n"),
		);
		expect(quoted.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "spread-override"],
		]);
		const shorthand = findPathKeyFindings(
			["const env = { ...base, PATH };", "env.Path = next;"].join("\n"),
		);
		expect(shorthand.map((f) => [f.line, f.reason])).toEqual([
			[1, "dual-spelling"],
			[2, "dual-spelling"],
		]);
	});

	/**
	 * Shape 69's other two plants: an INDIRECT call into the same binding
	 * (`Object.assign`), and a computed key that names a path expression in an
	 * object that is NOT an env — the fail-closed arm must not fire there.
	 */
	it("follows an indirect call into the same binding", () => {
		const findings = findPathKeyFindings(
			[
				"const env = { PATH: first };",
				"Object.assign(env, { Path: second });",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "dual-spelling"],
			[2, "Path", "dual-spelling"],
		]);
	});

	/**
	 * The block filter (`opensObjectLiteral`) is load-bearing: without it the
	 * enclosing function BODY reads as the composition, its `ProcessEnv` return
	 * type identifies it as an env, and two unrelated compositions in one
	 * function merge into a false dual spelling.
	 */
	it("keeps sibling compositions in one function apart", () => {
		const findings = findPathKeyFindings(
			[
				"export function build(seed: NodeJS.ProcessEnv): NodeJS.ProcessEnv {",
				'\tconst first = { PATH: "a" };',
				'\tconst second = { Path: "b" };',
				"\treturn second;",
				"}",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("leaves a computed key outside an env composition alone", () => {
		const findings = findPathKeyFindings(
			[
				"const changes = { [pathToFileURL(importPath).href]: [] };",
				"const labels = { [PathKey]: value };",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does not flag the needle inside a comment or a string", () => {
		const findings = findPathKeyFindings(
			[
				"// the old shape wrote { PATH: next, Path: next } here",
				'/* and env["PATH"] = next; in a block comment */',
				'const note = "const env = { ...base, PATH: next }; Path: next";',
				"const other = 'process.env.PATH = updated;';",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does not flag the sanctioned fresh single-spelling literal", () => {
		const findings = findPathKeyFindings(
			[
				'const probeEnv = { PATH: "/usr/bin:/bin", LC_ALL: "C" };',
				"const env: NodeJS.ProcessEnv = { PATH: next };",
				"const data = { path: filePath, target: other };",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	/**
	 * The #4566 round-14 shape, frozen from
	 * `git show c40ca054b^:clients/lsp/launch.ts` (lines 810-814): the dual
	 * spelling literal the round-10 fix replaced with `setTrustScopedPath`. The
	 * same literal is still on master in `clients/lsp/launch.ts`, which is why
	 * the baseline below carries it.
	 */
	it("flags the #4566 round-14 launcher env, frozen from the pre-fix commit", () => {
		const findings = findPathKeyFindings(
			[
				"\tconst env: NodeJS.ProcessEnv = {",
				"\t\t...mergedEnv,",
				"\t\tPATH: augmentedPath,",
				"\t\t...(isWindows ? { Path: augmentedPath } : {}),",
				"\t};",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PATH", "dual-spelling"],
			[4, "Path", "dual-spelling"],
		]);
	});

	it("keeps the seeded baseline exact in both directions", () => {
		const census = censusPathKeyCompositions();
		assertNonEmptyScan("env PATH composition scan", census.scanned, 600);
		const { unseeded, stale, drifted } = compare(census, SEEDED_OFFENDERS);
		expect(
			unseeded.map((identity) => `UNSEEDED ${identity}`),
			REMEDIATION,
		).toEqual([]);
		expect(
			stale.map((identity) => `STALE ${identity}`),
			`A baseline row that no longer matches a live finding is debt this ` +
				`sweep stopped tracking. The fix landed: delete the row. ${REMEDIATION}`,
		).toEqual([]);
		expect(
			drifted,
			"A seeded row changed its reason; re-read the site.",
		).toEqual([]);
	});
});
