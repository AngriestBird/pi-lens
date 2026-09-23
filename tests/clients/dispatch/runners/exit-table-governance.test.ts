/**
 * Governance ratchet for the #3292 recurrence: a runner must not silently
 * accept an undocumented nonzero exit class as a completed analysis.
 *
 * The code scan uses comment/string-blanked source.  The documentation scan
 * deliberately uses raw comments only, so prose or a string literal cannot
 * manufacture an exit table.  Finding-carrying codes also need a matrix cell
 * in the runner's tests; the registry below names the cell file explicitly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	codeMatches,
	stripSource,
} from "../../../support/sweep-kit.js";

const RUNNERS_DIR = fileURLToPath(
	new URL("../../../../clients/dispatch/runners", import.meta.url),
);
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));

const EXEMPT: Record<string, string> = {
	// PR #3291 owns these files and has not merged yet.  Keep the pin named so
	// the exception must disappear when that migration lands.
	"ktlint.ts": "PR #3291, not merged",
	"php-lint.ts": "PR #3291, not merged",
};

const MATRIX: Record<string, string> = {
	"actionlint.ts": "runner-outcome-actionlint-credo.test.ts",
	"cpp-check.ts": "compiler-outcome-runners.test.ts",
	"credo.ts": "runner-outcome-actionlint-credo.test.ts",
	"dart-analyze.ts": "secondary-language-runners.test.ts",
	"dotnet-build.ts": "compiler-outcome-runners-javac-dotnet.test.ts",
	"elixir-check.ts": "secondary-language-runners.test.ts",
	"eslint.ts": "runner-outcome-eslint-golangci.test.ts",
	"golangci-lint.ts": "runner-outcome-eslint-golangci.test.ts",
	"javac.ts": "compiler-outcome-runners-javac-dotnet.test.ts",
	"rubocop.ts": "runner-status-semantics.test.ts",
	"ruff.ts": "ruff.test.ts",
	"tflint.ts": "terraform-kotlin-runners.test.ts",
	"zig-check.ts": "secondary-language-runners.test.ts",
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
		const codes = [...match[1].matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
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

	it("requires every parseToolRun runner to declare and document ran codes", () => {
		const failures: string[] = [];
		for (const name of runnerFiles()) {
			if (name in EXEMPT) continue;
			const source = read(name);
			const tables = exitTables(source);
			if (tables.length !== 1 || tables[0].codes.length === 0) {
				failures.push(
					`${name}: exactly one explicit exitCodes.ran table required`,
				);
				continue;
			}
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

	it("keeps documented finding codes represented by a test matrix cell", () => {
		const failures: string[] = [];
		for (const name of runnerFiles()) {
			const source = read(name);
			const table = exitTables(source)[0];
			if (!table || !MATRIX[name]) continue;
			const docs = documentationFor(source, table.line);
			const testSource = fs.readFileSync(
				path.join(TESTS_DIR, MATRIX[name]),
				"utf8",
			);
			for (const code of table.codes) {
				// The status-property needle must be executable code. A test title
				// is the only string-evidence exception: codeMatches still requires
				// its enclosing `it(...)` call to begin in code.
				const hasStatusCell =
					codeMatches(testSource, new RegExp(`\\bstatus\\s*:\\s*${code}\\b`))
						.length > 0;
				const hasNamedTestCell =
					codeMatches(
						testSource,
						new RegExp(`\\bit\\s*\\([^\\n]*\\b${code}\\b`),
					).length > 0;
				if (hasStatusCell) continue;
				const finding = new RegExp(
					`\\b${code}\\b[^\\n]*(?:finding|diagnostic|issue|offense)`,
					"i",
				).test(docs);
				if (
					finding &&
					!hasNamedTestCell &&
					!codeMatches(
						testSource,
						new RegExp(`it\\([^\\n]*\\b${code}\\b|status\\s*:\s*${code}\\b`),
					).length
				)
					failures.push(
						`${name}: finding-carrying code ${code} has no matrix cell in ${MATRIX[name]}`,
					);
			}
		}
		expect(failures).toEqual([]);
	});
});
