/**
 * #1488 recurrence detector: an INLINED auxiliary-role predicate.
 *
 * The shipped defect this prevents is #1488 itself. `LSPServerInfo.role` was
 * optional, so 44 sites across `clients/`, `tools/` and `scripts/` answered
 * "is this server an auxiliary?" with their own comparison against the role
 * literal — `role === "auxiliary"` and `role !== "auxiliary"`, in both
 * polarities — and a second vocabulary (`PromiseDescriptor.role`'s
 * `"primary" | "auxiliary"`) was bridged to the first by one inline ternary at
 * the `getDiagnostics` descriptor build. Because the default was expressed as a
 * NEGATION, adding a third role would have classified it as a language server
 * at every one of those sites with no compile error and no failing test,
 * surfacing later as a server waited on the wrong lane.
 *
 * The sanctioned spelling is `isAuxiliary(<bearer>)` from
 * `clients/lsp/server-traits.ts`, whose exhaustive switch over
 * `LspServerRole` is the one place a new role trips the compiler. This sweep
 * counts the opposite: every site that still answers the question itself, and
 * every site that re-declares the vocabulary or re-implements the
 * classification.
 *
 * Detector hygiene (AGENTS.md defect shape 38): the scan runs over
 * comment-blanked source with STRINGS KEPT, because the needle's evidence IS a
 * string literal — the per-needle policy `stripSource` documents. A comment
 * quoting the needle can therefore neither create a finding nor launder one
 * away. The kept-string direction is the loud one: a string literal that
 * happens to spell the needle reds this sweep rather than passing it, which is
 * the cheaper error.
 *
 * The needle matches SEMANTIC STRUCTURE, not a list of receivers (shape 34):
 * an `"auxiliary"` literal with a comparison operator adjacent on either side
 * whose other operand ends in the member `role`. `POSITIVE_CONTROLS` includes
 * spellings that occur nowhere in the tree — loose `==`/`!=`, reversed operand
 * order, an optional-chain receiver, an indexed receiver — so a receiver-shaped
 * regex that happened to cover today's sites cannot pass.
 */

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * The population: every production source root AGENTS.md's class-sweep rule
 * names, plus the host adapter. Test files are excluded — a fixture
 * legitimately spells a role value to build a server double — and the doubles
 * that matter are reached from the other direction by
 * `tests/config/lsp-server-trait-table.test.ts`, which derives the auxiliary
 * population from the registry rather than from source text.
 */
const POPULATION_ROOTS = ["clients", "tools", "mcp", "scripts"] as const;
const POPULATION_FILES = ["index.ts"] as const;
const POPULATION_EXTENSIONS = [".ts", ".mjs"] as const;

/** Floor on the scanned population, so a renamed root cannot empty it (#1718). */
const POPULATION_FLOOR = 400;

/**
 * The seam's own module. Its exhaustive `switch` and its `ROLE_MEMBERS` record
 * are the ONE place the literal is classified and the union declared, so this
 * file is exempt from every needle by path — not by a needle that skips it,
 * which a second module could copy.
 */
const OWNER = "clients/lsp/server-traits.ts";

/**
 * Registered admissions, shrink-only, each with the reason it is an admission
 * rather than a fold. A new row needs a reason; a row whose file stops holding
 * a site must be deleted here or this sweep reds.
 *
 * All three are measurement drivers.
 * `scripts/lib/lsp-idle-eviction-probe.mjs` projects the role into its own
 * measurement row and `scripts/bench-lsp.mjs` reads that row back, so most of
 * their sites classify a RECORD field whose published spelling is the eviction
 * matrix's `role` column rather than a live server. Re-spelling that column is
 * a durable-record change belonging to #1756's record-policy stage, not to a
 * behaviour-preserving vocabulary fold. `scripts/lib/clean-signal.mjs` imports
 * no `clients/` module at all — `scripts/probe-clean-signal.mjs` loads it
 * through a dynamic-import wrapper — so wiring it to the predicate would give a
 * probe driver a build-order dependency it does not otherwise have.
 *
 * The per-file reason lives here; the shrink-only SITE census over the same
 * three files is the next test, so a driver that folds lowers the count and a
 * new inlined site raises it into a red.
 */
const ADMITTED: Readonly<Record<string, string>> = {
	"scripts/bench-lsp.mjs":
		"Reads the eviction probe's own measurement row back, whose published `role` column spells the non-auxiliary value `primary`; re-spelling a durable record column is #1756's record-policy stage, not this fold.",
	"scripts/lib/clean-signal.mjs":
		"Imports no clients/ module — probe-clean-signal.mjs loads it through a dynamic-import wrapper — so the predicate would give a probe driver a build-order dependency it does not otherwise have.",
	"scripts/lib/lsp-idle-eviction-probe.mjs":
		"Produces the eviction matrix's `role` record column (`auxiliary` / `primary`); a durable-record spelling change, not a server classification.",
};

/** The same three files, as the shrink-only site census below scans them. */
const SCRIPT_DRIVERS = Object.keys(ADMITTED).sort() as readonly string[];
const SCRIPT_DRIVER_SITE_CEILING = 8;

const COMPARISON = "(?:===|!==|==|!=)";
/** Any receiver spelling: dotted, optional-chained, indexed, or none. */
const RECEIVER = String.raw`[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]+\])*`;
/** An operand whose last member is `role`, or a bare `role` identifier. */
const ROLE_OPERAND = String.raw`(?:${RECEIVER}\s*\.\s*role|(?<![\w$.])role)\b`;
const NEEDLES: ReadonlyArray<readonly [RegExp, string]> = [
	[
		new RegExp(String.raw`${ROLE_OPERAND}\s*${COMPARISON}\s*"auxiliary"`, "g"),
		"inlined role predicate",
	],
	[
		new RegExp(String.raw`"auxiliary"\s*${COMPARISON}\s*${ROLE_OPERAND}`, "g"),
		"inlined role predicate (reversed operands)",
	],
	[/case\s+"auxiliary"\s*:/g, "second exhaustive role classification"],
	[/"(?:language|primary)"\s*\|\s*"auxiliary"/g, "second role vocabulary"],
];

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly needle: string;
	readonly text: string;
}

function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === "\n") line++;
	}
	return line;
}

/**
 * Every needle hit in one file. Comments are blanked first; strings are kept
 * because the needle's evidence is a string literal.
 */
function scanSource(relative: string, rawSource: string): Finding[] {
	const source = stripSource(rawSource, { strings: "keep" });
	const findings: Finding[] = [];
	for (const [needle, label] of NEEDLES) {
		needle.lastIndex = 0;
		for (
			let match = needle.exec(source);
			match !== null;
			match = needle.exec(source)
		) {
			findings.push({
				file: relative,
				line: lineAt(source, match.index),
				needle: label,
				text: match[0].replace(/\s+/g, " ").trim().slice(0, 120),
			});
			if (match.index === needle.lastIndex) needle.lastIndex++;
		}
	}
	return findings;
}

function scanFile(absolute: string): Finding[] {
	return scanSource(
		relativePosix(REPO_ROOT, absolute),
		readFileSync(absolute, "utf8"),
	);
}

function population(): string[] {
	const fromRoots = POPULATION_ROOTS.flatMap((root) =>
		listSourceFiles(path.resolve(REPO_ROOT, root), {
			extensions: POPULATION_EXTENSIONS,
			skipTests: true,
		}),
	);
	const standalone = POPULATION_FILES.map((file) =>
		path.resolve(REPO_ROOT, file),
	).filter((absolute) => statSync(absolute).isFile());
	// Each root must contribute: a renamed directory would otherwise shrink the
	// population silently and read as clean.
	for (const root of POPULATION_ROOTS) {
		assertNonEmptyScan(
			`population root ${root}`,
			fromRoots.filter((absolute) =>
				absolute.startsWith(path.resolve(REPO_ROOT, root) + path.sep),
			).length,
			1,
		);
	}
	return [...fromRoots, ...standalone].sort();
}

const PREDICATE_NEEDLES = [
	"inlined role predicate",
	"inlined role predicate (reversed operands)",
] as const;

describe("#1488 — one auxiliary-role predicate, one vocabulary", () => {
	it("finds no inlined role predicate outside the seam and its admissions", () => {
		const files = population();
		assertNonEmptyScan(
			"role-predicate population",
			files.length,
			POPULATION_FLOOR,
		);

		const scanned = files.flatMap((absolute) => {
			const relative = relativePosix(REPO_ROOT, absolute);
			return { relative, findings: scanFile(absolute) };
		});
		const governed = scanned.filter(
			(entry) =>
				entry.relative !== OWNER && ADMITTED[entry.relative] === undefined,
		);

		expect(
			governed.flatMap((entry) => entry.findings),
			"An inlined auxiliary-role predicate, a second role vocabulary, or a " +
				"second exhaustive classification reappeared. Ask isAuxiliary() from " +
				"clients/lsp/server-traits.ts, declare the union there, or register " +
				"the file in ADMITTED with a reason (#1488).",
		).toEqual([]);

		// Every admission is still load-bearing: a driver that folds onto the
		// predicate deletes its row rather than leaving a stale reason behind.
		expect(
			Object.keys(ADMITTED).filter(
				(file) =>
					scanned.find((entry) => entry.relative === file)?.findings.length ===
					0,
			),
			"An ADMITTED file no longer holds a site; delete its row.",
		).toEqual([]);
	});

	it("admits the measurement drivers as a shrink-only site count", () => {
		const sites = SCRIPT_DRIVERS.flatMap((relative) =>
			scanSource(
				relative,
				readFileSync(path.resolve(REPO_ROOT, relative), "utf8"),
			),
		).filter((finding) =>
			(PREDICATE_NEEDLES as readonly string[]).includes(finding.needle),
		);

		assertNonEmptyScan("script-driver role sites", sites.length, 1);
		expect(sites.length).toBeLessThanOrEqual(SCRIPT_DRIVER_SITE_CEILING);
	});

	it("detects every spelling of an inlined predicate, including unlisted ones", () => {
		const POSITIVE_CONTROLS = [
			// The two spellings that shipped.
			'if (info.role === "auxiliary") { spawn(); }',
			'if (info.role !== "auxiliary") { continue; }',
			// Loose equality: occurs nowhere in the tree.
			'servers.filter((s) => s.role != "auxiliary");',
			'servers.filter((s) => s.role == "auxiliary");',
			// Reversed operands: occurs nowhere in the tree.
			'if ("auxiliary" === server.role) { wait(); }',
			// Optional-chain and indexed receivers.
			'const aux = entry?.info.role === "auxiliary";',
			'const aux = spawned[i].info.role === "auxiliary";',
			// A bare local, and whitespace a formatter could introduce.
			'while (role === "auxiliary") { break; }',
			'if (info\n\t.role\n\t=== "auxiliary") { wait(); }',
		];
		for (const sample of POSITIVE_CONTROLS) {
			expect(
				scanSource("sample.ts", sample).filter((finding) =>
					(PREDICATE_NEEDLES as readonly string[]).includes(finding.needle),
				),
				sample,
			).not.toEqual([]);
		}

		const NEGATIVE_CONTROLS = [
			// Prose must not satisfy the needle (the self-excuse direction). A
			// real comment, in both spellings the lexer recognizes.
			'// info.role === "auxiliary" was the pre-#1488 spelling',
			[
				"/**",
				' * Mirrors the `role !== "auxiliary"` filter getClientForFile applies.',
				" */",
				"export const x = 1;",
			].join("\n"),
			// The sanctioned seam, and a plain row declaration.
			"if (isAuxiliary(info)) { wait(); }",
			"servers.filter((s) => !isAuxiliary(s));",
			'role: "auxiliary",',
			// A different member compared against the same literal is not a role.
			'if (info.kind === "auxiliary") { wait(); }',
			'if (descriptor.scope === "auxiliary") { wait(); }',
			// A `role`-suffixed member is not `role`.
			'if (info.sessionRole === "auxiliary") { wait(); }',
		];
		for (const sample of NEGATIVE_CONTROLS) {
			expect(
				scanSource("sample.ts", sample).filter((finding) =>
					(PREDICATE_NEEDLES as readonly string[]).includes(finding.needle),
				),
				sample,
			).toEqual([]);
		}
	});

	it("keeps string literals as the loud direction, not a laundering path", () => {
		// `strings: "keep"` is what makes the needle able to see its own evidence
		// at all, and the price is that a STRING literal spelling the predicate
		// also matches. That is deliberate: a false positive reds loudly and is
		// fixed by rewording the string, whereas blanking strings would let a
		// real comparison hide behind a quote the scanner swallowed. Pinned so the
		// trade-off is a decision on the record rather than a surprise.
		const template =
			'const note = `ask isAuxiliary, not role === "auxiliary"`;';
		expect(
			scanSource("sample.ts", template).filter((finding) =>
				(PREDICATE_NEEDLES as readonly string[]).includes(finding.needle),
			),
		).not.toEqual([]);
	});

	it("detects a re-forked vocabulary and a second exhaustive classification", () => {
		expect(
			scanSource("sample.ts", 'type R = "primary" | "auxiliary";'),
		).not.toEqual([]);
		expect(
			scanSource("sample.ts", 'type R = "language" | "auxiliary";'),
		).not.toEqual([]);
		expect(
			scanSource(
				"sample.ts",
				'switch (info.role) { case "auxiliary": return true; }',
			),
		).not.toEqual([]);
		// The owner is exempt BY PATH, so its own declaration and switch are the
		// seam rather than a recurrence — the exemption cannot be copied by
		// another module spelling the same code.
		expect(
			scanSource(
				OWNER,
				'export type LspServerRole = "language" | "auxiliary";',
			),
		).not.toEqual([]);
	});
});
