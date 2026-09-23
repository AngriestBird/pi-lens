/**
 * Governance ratchet for the #3292 recurrence: three exit-table misses landed
 * in one day (#3252, #3280, and #3291's `php -l` 255), each because a runner
 * accepted an undocumented nonzero exit class as a completed analysis.
 *
 * Three scans, three deliberately different evidence policies:
 *
 * 1. **Source shape** — comment/string-blanked (`stripSource`), so prose or a
 *    string literal cannot manufacture an exit table.
 * 2. **Annotation** — raw `//` lines only, because the documentation IS a
 *    comment; code cannot satisfy it.
 * 3. **Matrix cell** — EXECUTABLE test text only: every character of the match
 *    must survive comment and string blanking. `codeMatches` is not strong
 *    enough here, because its `matchIsCode` passes when ANY character of the
 *    span lies in code — an `it(` prefix supplies one, so a test TITLE naming
 *    the status stood in for the deleted fixture (#3298 verify round 2,
 *    MEDIUM-2).
 *
 * `DOCUMENTED_RAN` pins every governed runner's `ran` set EXACTLY, in both
 * directions. A code ADDED reds until its matrix cell and its pin row land
 * together; a code REMOVED reds too, which the previous ratchet missed because
 * it only validated the codes still present, so deleting one silently shrank
 * the governed population (#3298 verify round 2, MEDIUM-3). Changing a
 * runner's exit contract therefore has to edit this table in the same change,
 * where review sees it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, stripSource } from "../../../support/sweep-kit.js";

const RUNNERS_DIR = fileURLToPath(
	new URL("../../../../clients/dispatch/runners", import.meta.url),
);
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Temporary admissions, each keyed by file with the reason it is admitted.
 *
 * Empty, and it stays that way unless an in-flight migration owns a runner.
 * #3291's `ktlint.ts` and `php-lint.ts` sat here until that PR merged; the
 * expiry assertion below is what makes such a row impossible to forget.
 */
const EXEMPT: Record<string, string> = {};

/**
 * The exact documented `ran` set per governed runner. Shrink-and-grow ratchet:
 * the population scan finds the runner, this table says what it is allowed to
 * treat as a completed analysis, and any divergence in either direction reds.
 */
const DOCUMENTED_RAN: Record<string, number[]> = {
	"actionlint.ts": [1, 2],
	"cpp-check.ts": [1, 2],
	"credo.ts": [1, 2],
	"dart-analyze.ts": [1, 2],
	"detekt.ts": [1, 2],
	"dotnet-build.ts": [1, 2],
	"elixir-check.ts": [1, 2],
	"eslint.ts": [1, 2],
	"golangci-lint.ts": [1, 2, 3, 4, 5],
	"hadolint.ts": [1, 2],
	"htmlhint.ts": [1, 2],
	"javac.ts": [1, 2],
	"ktlint.ts": [1, 2, 3],
	"markdownlint.ts": [1],
	"mypy.ts": [1, 2],
	"oxlint.ts": [1, 2],
	"php-lint.ts": [1, 255],
	"phpstan.ts": [1],
	"rubocop.ts": [1, 2],
	"ruff.ts": [1, 2],
	"spellcheck.ts": [2],
	"sqlfluff.ts": [1],
	"stylelint.ts": [1, 2],
	"swiftlint.ts": [1, 2],
	"taplo.ts": [1],
	"tflint.ts": [1, 2],
	"vale.ts": [1, 2],
	"yamllint.ts": [1, 2],
	"zig-check.ts": [1, 2],
};

/**
 * Runner file -> the test file whose EXECUTABLE status fixtures drive it.
 * Every governed runner needs a row, and every code in its `DOCUMENTED_RAN`
 * pin needs a cell in that file unless it is admitted in {@link UNWITNESSED}.
 */
const MATRIX: Record<string, string> = {
	"actionlint.ts": "runner-outcome-actionlint-credo.test.ts",
	"cpp-check.ts": "compiler-outcome-runners.test.ts",
	"credo.ts": "runner-outcome-actionlint-credo.test.ts",
	"dart-analyze.ts": "secondary-language-runners.test.ts",
	"detekt.ts": "parsed-nothing.test.ts",
	"dotnet-build.ts": "compiler-outcome-runners-javac-dotnet.test.ts",
	"elixir-check.ts": "secondary-language-runners.test.ts",
	"eslint.ts": "runner-outcome-eslint-golangci.test.ts",
	"golangci-lint.ts": "runner-outcome-eslint-golangci.test.ts",
	"hadolint.ts": "nonzero-exit-no-output.test.ts",
	"htmlhint.ts": "htmlhint.test.ts",
	"javac.ts": "compiler-outcome-runners-javac-dotnet.test.ts",
	"ktlint.ts": "runner-outcome-ktlint-php-lint.test.ts",
	"markdownlint.ts": "exit-blind-runners.test.ts",
	"mypy.ts": "exit-blind-runners.test.ts",
	"oxlint.ts": "oxlint.test.ts",
	"php-lint.ts": "runner-outcome-ktlint-php-lint.test.ts",
	"phpstan.ts": "parsed-nothing.test.ts",
	"rubocop.ts": "runner-status-semantics.test.ts",
	"ruff.ts": "ruff.test.ts",
	"spellcheck.ts": "exit-blind-runners.test.ts",
	"sqlfluff.ts": "exit-blind-runners.test.ts",
	"stylelint.ts": "exit-blind-runners.test.ts",
	"swiftlint.ts": "exit-blind-runners.test.ts",
	"taplo.ts": "taplo.test.ts",
	"tflint.ts": "terraform-kotlin-runners.test.ts",
	"vale.ts": "exit-blind-runners.test.ts",
	"yamllint.ts": "exit-blind-runners.test.ts",
	"zig-check.ts": "compiler-outcome-runners.test.ts",
};

/**
 * `runner.ts:code` -> the reason that documented code has no executable cell
 * yet. Registered, not silenced: the assertion below reds again the moment a
 * cell DOES appear (promote the row out) or the code leaves the pin, so an
 * admission cannot outlive its reason the way #3291's exemptions nearly did.
 */
const UNWITNESSED: Record<string, string> = {
	"hadolint.ts:2":
		"no fixture drives hadolint's documented error exit; #3292 follow-up",
	"htmlhint.ts:2":
		"no fixture drives HTMLHint's documented error exit; #3292 follow-up",
};

function runnerFiles(): string[] {
	return fs
		.readdirSync(RUNNERS_DIR)
		.filter((name) => name.endsWith(".ts"))
		.filter((name) => !["index.ts", "utils.ts"].includes(name))
		.filter((name) => callsParseToolRun(read(name)))
		.sort();
}

function read(name: string): string {
	return fs.readFileSync(path.join(RUNNERS_DIR, name), "utf8");
}

function callsParseToolRun(source: string): boolean {
	return /\bparseToolRun(?:\s*<[^>]*>)?\s*\(/.test(stripSource(source));
}

type ExitTable = { line: number; codes: number[] };

function exitTables(source: string): ExitTable[] {
	const stripped = stripSource(source);
	const lines = stripped.split(/\r?\n/);
	const tables: ExitTable[] = [];
	for (let line = 0; line < lines.length; line++) {
		if (
			!/\bexitCodes\s*:/.test(lines[line]) &&
			!/\bToolExitCodes\s*=/.test(lines[line]) &&
			!/\b[A-Z][A-Z0-9_]*_EXIT_CODES\s*=/.test(lines[line])
		)
			continue;
		const window = lines.slice(line, line + 8).join(" ");
		const match = window.match(/\bran\s*:\s*\[([^\]]*)\]/);
		if (!match) continue;
		const codes = [...match[1].matchAll(/\d+/g)].map((m) => Number(m[0]));
		tables.push({ line, codes });
	}
	return tables;
}

function documentationFor(source: string, line: number): string {
	const lines = source.split(/\r?\n/);
	return lines
		.slice(Math.max(0, line - 12), line + 1)
		.filter((item) => /^\s*\/\//.test(item))
		.join(" ");
}

/**
 * Every exit status this test file drives EXECUTABLY.
 *
 * The scan runs over comment- and string-blanked source, so a test TITLE
 * (`it("... status 2 ...")`), a `// status: 2` comment and a bare string
 * literal contribute nothing — `codeMatches` was not enough here, because its
 * `matchIsCode` passes when ANY character of the span lies in code, and an
 * `it(` prefix supplies one (#3298 verify round 2, MEDIUM-2).
 *
 * Two accepted shapes, both of which the fixtures in this directory use:
 *
 * - a `status:` / `exitCode:` property carrying the numeric status, which is
 *   what a `safeSpawn` double returns; and
 * - a numeric array literal within three lines of a `status`/`statuses`
 *   identifier — the table-driven form, e.g.
 *   `it.each(tool === "ktlint" ? [1, 2, 3] : [1, 255])` whose parameter is
 *   named `status`, and `const statuses = ... [1, 3, 4, 5]`. A property-only
 *   needle misses these, which is how ktlint 3, php-lint 255 and golangci 3-5
 *   read as uncovered while real fixtures drove them.
 *
 * An index expression (`codes[1]`) is excluded by the preceding-character
 * guard, so it cannot manufacture a cell.
 */
function executableStatusCells(testSource: string): Set<number> {
	const lines = stripSource(testSource, { strings: "blank" }).split(/\r?\n/);
	const cells = new Set<number>();
	for (let index = 0; index < lines.length; index++) {
		for (const match of lines[index].matchAll(
			/\b(?:status|exitCode)\s*:\s*(\d+)\b/g,
		))
			cells.add(Number(match[1]));
		const arrays = [
			...lines[index].matchAll(
				/(?<![A-Za-z0-9_$)\]])\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g,
			),
		];
		if (arrays.length === 0) continue;
		const window = lines
			.slice(Math.max(0, index - 3), index + 4)
			.join(" ");
		if (!/\bstatus(?:es)?\b/i.test(window)) continue;
		for (const array of arrays)
			for (const value of array[1].split(",")) cells.add(Number(value.trim()));
	}
	return cells;
}

function sorted(codes: number[]): string {
	return JSON.stringify([...codes].sort((a, b) => a - b));
}

describe("documented runner exit-table ratchet (#3292)", () => {
	it("has a non-vacuous parseToolRun population", () => {
		const count = runnerFiles().length;
		assertNonEmptyScan("#3292 parseToolRun runners", count, 20);
		expect(count).toBeGreaterThanOrEqual(20);
	});

	it("expires temporary exemptions when their runner adopts parseToolRun", () => {
		const stale = Object.keys(EXEMPT).filter((name) => {
			const source = read(name);
			return callsParseToolRun(source) || exitTables(source).length > 0;
		});
		expect(stale).toEqual([]);
	});

	it("pins every governed runner's documented ran set exactly", () => {
		const failures: string[] = [];
		const population = runnerFiles();
		for (const name of population) {
			if (Object.hasOwn(EXEMPT, name)) continue;
			const tables = exitTables(read(name));
			if (tables.length !== 1 || tables[0].codes.length === 0) {
				failures.push(
					`${name}: exactly one explicit exitCodes.ran table required`,
				);
				continue;
			}
			if (!Object.hasOwn(DOCUMENTED_RAN, name)) {
				failures.push(
					`${name}: no DOCUMENTED_RAN pin for ran ${sorted(tables[0].codes)}`,
				);
				continue;
			}
			if (sorted(tables[0].codes) !== sorted(DOCUMENTED_RAN[name]))
				failures.push(
					`${name}: ran ${sorted(tables[0].codes)} does not match its pin ${sorted(DOCUMENTED_RAN[name])}`,
				);
		}
		for (const name of Object.keys(DOCUMENTED_RAN))
			if (!population.includes(name) || Object.hasOwn(EXEMPT, name))
				failures.push(`${name}: stale DOCUMENTED_RAN pin`);
		expect(failures).toEqual([]);
	});

	it("requires every parseToolRun runner to document its ran codes", () => {
		const failures: string[] = [];
		for (const name of runnerFiles()) {
			if (Object.hasOwn(EXEMPT, name)) continue;
			const source = read(name);
			const tables = exitTables(source);
			if (tables.length !== 1) continue;
			const docs = documentationFor(source, tables[0].line);
			if (
				!/(?:EXIT TABLE|exit contract)/i.test(docs) ||
				!/(https?:\/\/|(?:undocumented;\s*)?measured\s+(?:fixture|evidence)|\b(?:documented|documents|observed|observes|captured)\b)/i.test(
					docs,
				)
			)
				failures.push(
					`${name}: table needs a pinned upstream URL or measured-undocumented annotation`,
				);
			if (!/\b(?:rejected|error|fatal)\b/i.test(docs))
				failures.push(`${name}: annotation needs a rejected/error class`);
			for (const code of tables[0].codes) {
				if (!new RegExp(`\\b${code}\\b`).test(docs))
					failures.push(`${name}: annotation omits ran code ${code}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("witnesses every documented ran code with an executable matrix cell", () => {
		const failures: string[] = [];
		const population = runnerFiles().filter(
			(name) => !Object.hasOwn(EXEMPT, name),
		);
		const cellCache = new Map<string, Set<number>>();
		const cellsOf = (file: string): Set<number> => {
			let cells = cellCache.get(file);
			if (!cells) {
				cells = executableStatusCells(
					fs.readFileSync(path.join(TESTS_DIR, file), "utf8"),
				);
				cellCache.set(file, cells);
			}
			return cells;
		};
		const pinnedKeys = new Set<string>();
		for (const name of population) {
			const table = exitTables(read(name))[0];
			if (!table) continue;
			const cellFile = MATRIX[name];
			if (!cellFile) {
				failures.push(`${name}: no MATRIX row naming its status fixtures`);
				continue;
			}
			const cells = cellsOf(cellFile);
			for (const code of table.codes) {
				const key = `${name}:${code}`;
				pinnedKeys.add(key);
				if (cells.has(code)) {
					if (Object.hasOwn(UNWITNESSED, key))
						failures.push(
							`${key}: stale UNWITNESSED admission; ${cellFile} now drives it`,
						);
					continue;
				}
				if (Object.hasOwn(UNWITNESSED, key)) continue;
				failures.push(
					`${key}: documented ran code has no executable matrix cell in ${cellFile}`,
				);
			}
		}
		for (const name of Object.keys(MATRIX))
			if (!population.includes(name))
				failures.push(`${name}: stale MATRIX row`);
		for (const key of Object.keys(UNWITNESSED))
			if (!pinnedKeys.has(key))
				failures.push(`${key}: stale UNWITNESSED admission; no such pinned code`);
		expect(failures).toEqual([]);
	});
});
