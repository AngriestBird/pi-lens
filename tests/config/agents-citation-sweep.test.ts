/**
 * Check C8 of the agent-contract audit (#4361): every `AGENTS.md "<section>"`
 * or `AGENTS.md, "<section>"` citation in tests/, scripts/, .github/, docs/,
 * clients/, .changelog/ and the repo-root config files must name a live heading
 * in AGENTS.md. The repo-root files read are dotfiles and config-extension files
 * (.toml, .json, .yml, .yaml, .cjs, .mjs); root markdown (AGENTS, HISTORY,
 * CHANGELOG, README) is not read. Compiled `.js` and `.d.ts` next to a `.ts`
 * source are skipped, since `npm run build` writes them in place.
 *
 * Recurrence this prevents: PLAN_4361 (2026-10-18) measured five headings that
 * the agent docs still cited after AGENTS.md had moved them: "Probe hygiene",
 * "Detectors match code, not prose", "Runner process model", "Session-start
 * critical path" and "Test assessment and removal". Twelve call sites pointed
 * at them. A reader that follows a dangling pointer lands on no rule, so the
 * pointer silently stops enforcing anything.
 *
 * Per-needle policy: the citation is prose or a string literal, not code, so
 * the scan reads the raw text. It does not blank comments or strings, because
 * the comment or string IS the citation. A quoted section that wraps onto the
 * next comment line still counts, since the scan joins up to two continuation
 * lines before it matches; in markdown the continuation is the next prose
 * line. Two exclusions are deliberate: tests/fixtures/ holds
 * recorded probe and CI captures that must stay byte-true, and this file quotes
 * the citation form in its own header. A string-literal line in code never
 * joins onto the next line, so `" + "` concatenation is not read as a name.
 * An unquoted mention such as
 * `AGENTS.md Probe hygiene` is outside the form and is not swept.
 *
 * Fail closed: a citation whose section is not a heading reds, and so does an
 * empty sweep (a dead sweep passes everything).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, listSourceFiles } from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SELF = path.relative(REPO_ROOT, import.meta.filename);
const SWEEP_ROOTS = [
	"tests",
	"scripts",
	".github",
	"docs",
	"clients",
	".changelog",
];
const ROOT_CONFIG_EXTENSIONS = new Set([
	".toml",
	".json",
	".yml",
	".yaml",
	".cjs",
	".mjs",
]);
const EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".js",
	".mjs",
	".cjs",
	".md",
	".yml",
	".yaml",
	".json",
	".toml",
	".sh",
	".txt",
]);
const CITATION = /AGENTS\.md,?[ \t]+(["'])([^\n]+?)\1/g;
const COMMENT_PREFIX = /^[ \t]*(?:\/\/+|\*|#)[ \t]?/;

/** A compiled `.js` or `.d.ts` emitted next to its `.ts` source by the build. */
function isBuildOutput(dir: string, name: string): boolean {
	const source = name.endsWith(".d.ts")
		? name.replace(/\.d\.ts$/, ".ts")
		: name.endsWith(".js")
			? name.replace(/\.js$/, ".ts")
			: undefined;
	return source !== undefined && fs.existsSync(path.join(dir, source));
}

/**
 * Every swept source: the shared walker (`listSourceFiles`, which skips
 * `.git`, `node_modules`, `.claude` and `.probe-home`) over each root, then
 * the citation filters layered on top: fixture captures, build output and
 * this file are out.
 */
function sweptSources(): string[] {
	const files: string[] = [];
	for (const root of SWEEP_ROOTS) {
		const dir = path.join(REPO_ROOT, root);
		if (fs.existsSync(dir)) {
			files.push(
				...listSourceFiles(dir, {
					extensions: [...EXTENSIONS],
					skipDeclarations: false,
				}),
			);
		}
	}
	files.push(...rootConfigFiles());
	return files.filter((file) => {
		const rel = path.relative(REPO_ROOT, file);
		return (
			rel !== SELF &&
			!rel.split(path.sep).includes("fixtures") &&
			!isBuildOutput(path.dirname(file), path.basename(file))
		);
	});
}

/** Repo-root config files: dotfiles and config-extension files, not root markdown. */
function rootConfigFiles(): string[] {
	return fs
		.readdirSync(REPO_ROOT, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				(entry.name.startsWith(".") ||
					ROOT_CONFIG_EXTENSIONS.has(path.extname(entry.name))),
		)
		.map((entry) => path.join(REPO_ROOT, entry.name));
}

function liveHeadings(): Set<string> {
	const text = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
	const headings = new Set<string>();
	for (const line of text.split("\n")) {
		const match = /^#{1,6}[ \t]+(.+?)[ \t]*$/.exec(line);
		if (match) headings.add(match[1]);
	}
	return headings;
}

/**
 * The text a wrapped citation continues onto: the next comment line in code
 * (`// `, ` * `, `# `), or the next prose line in markdown. A string-literal
 * line in code (`"... " +`) is not a continuation, so `" + "` never reads as a
 * section name.
 */
function continuation(next: string, markdown: boolean): string | undefined {
	if (next.trim() === "") return undefined;
	const comment = COMMENT_PREFIX.exec(next);
	if (comment) return next.slice(comment[0].length);
	return markdown ? next.trim() : undefined;
}

/** Every quoted AGENTS.md section cited from a line, with its file and line. */
function citationsIn(file: string): { line: number; name: string }[] {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const markdown = file.endsWith(".md");
	const found: { line: number; name: string }[] = [];
	lines.forEach((line, index) => {
		if (!line.includes("AGENTS.md")) return;
		const tail: string[] = [];
		for (const next of lines.slice(index + 1, index + 3)) {
			const text = continuation(next, markdown);
			if (text === undefined) break;
			tail.push(text);
		}
		const joined = [line, ...tail].join(" ");
		for (const match of joined.matchAll(CITATION)) {
			if ((match.index ?? 0) < line.length) {
				found.push({
					line: index + 1,
					name: match[2].replace(/\s+/g, " ").trim(),
				});
			}
		}
	});
	return found;
}

/**
 * The resolver: the citations whose quoted name is not a live heading. The
 * real sweep and the planted case both call this, so a change to either the
 * matcher or the resolver is seen by the planted case.
 */
function danglingCitations(
	citations: { file: string; line: number; name: string }[],
	headings: Set<string>,
): string[] {
	return citations
		.filter((hit) => !headings.has(hit.name))
		.map((hit) => `${hit.file}:${hit.line} AGENTS.md "${hit.name}"`);
}

describe("AGENTS.md section citations resolve (#4361 C8)", () => {
	it(
		"every quoted AGENTS.md section cited under the swept roots is a live heading",
		() => {
			const headings = liveHeadings();
			const sweptFiles = sweptSources();
			const citations = sweptFiles.flatMap((file) =>
				citationsIn(file).map((hit) => ({
					file: path.relative(REPO_ROOT, file),
					...hit,
				})),
			);

			// A dead sweep passes everything: the headings, the files and the
			// citations must all be read. The citation floor catches a matcher
			// neutered to match nothing, which the other two floors cannot see.
			assertNonEmptyScan("AGENTS.md headings read", headings.size, 20);
			assertNonEmptyScan("citation sweep files", sweptFiles.length, 500);
			assertNonEmptyScan("AGENTS.md citations read", citations.length, 15);

			expect(
				danglingCitations(citations, headings),
				"dangling AGENTS.md section citations",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence (CodeRabbit, PR 4767 round 3): C8 derives its population from
	// the tree. A matcher or resolver that silently reports nothing keeps the
	// real sweep green, and the citation-count floor only catches zero matches.
	// This planted file carries one dangling and one live citation in both quote
	// spellings. The same matcher and resolver must report exactly the dangling
	// two, or the guard is not proven to red on a real miss.
	it("reports a planted dangling citation through the same matcher and resolver", () => {
		const headings = liveHeadings();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c8-planted-"));
		try {
			const planted = path.join(dir, "planted.ts");
			fs.writeFileSync(
				planted,
				[
					'// see AGENTS.md "No Such Planted Heading" for the rule',
					"// and AGENTS.md 'Another Missing Heading' too",
					'// live: AGENTS.md "Test requirements" still resolves',
					"",
				].join("\n"),
			);
			const hits = citationsIn(planted).map((hit) => ({
				file: "planted.ts",
				...hit,
			}));
			expect(hits.map((hit) => hit.name)).toEqual([
				"No Such Planted Heading",
				"Another Missing Heading",
				"Test requirements",
			]);
			expect(danglingCitations(hits, headings)).toEqual([
				'planted.ts:1 AGENTS.md "No Such Planted Heading"',
				'planted.ts:2 AGENTS.md "Another Missing Heading"',
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
