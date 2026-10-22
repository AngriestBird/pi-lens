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
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

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
const SKIP_DIRS = new Set(["node_modules", ".git", "fixtures", ".probe-home"]);
const EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".md",
	".yml",
	".yaml",
]);
const CITATION = /AGENTS\.md,?[ \t]+"([^"]+)"/g;
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

function walk(dir: string, out: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
		} else if (
			EXTENSIONS.has(path.extname(entry.name)) &&
			!isBuildOutput(dir, entry.name)
		) {
			out.push(path.join(dir, entry.name));
		}
	}
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
					name: match[1].replace(/\s+/g, " ").trim(),
				});
			}
		}
	});
	return found;
}

describe("AGENTS.md section citations resolve (#4361 C8)", () => {
	it("every quoted AGENTS.md section cited under the swept roots is a live heading", () => {
		const headings = liveHeadings();
		const files: string[] = [];
		for (const root of SWEEP_ROOTS) {
			const dir = path.join(REPO_ROOT, root);
			if (fs.existsSync(dir)) walk(dir, files);
		}
		files.push(...rootConfigFiles());
		const sweptFiles = files.filter(
			(file) => path.relative(REPO_ROOT, file) !== SELF,
		);
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

		const dangling = citations
			.filter((hit) => !headings.has(hit.name))
			.map((hit) => `${hit.file}:${hit.line} AGENTS.md "${hit.name}"`);
		expect(dangling, "dangling AGENTS.md section citations").toEqual([]);
	});
});
