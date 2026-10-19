/**
 * #4629: a `.py` file's primary group runs the Pyright language server and the
 * `pyright` CLI runner together (`clients/language-policy.ts`, `mode: "all"`).
 * The server publishes `source: "Pyright"` (`"basedpyright"` for that fork) and
 * `convertLspDiagnostics` renders its rule `<source>:<code>`; the CLI prints the
 * bare code. One finding therefore reached the agent twice, and a bare Pyright
 * code in `rules.<id>.disable` hid only the CLI copy.
 *
 * The inputs are real bytes (`tests/fixtures/lsp-cli-copies/*.captured.json`,
 * one `app.py` through `pyright --outputjson` and through the language server's
 * `textDocument/publishDiagnostics`, pyright 1.1.414 and basedpyright 1.40.2).
 * Everything after the process boundary is production code: the real
 * `convertLspDiagnostics`, `parsePyrightOutput`, the primary group, and
 * `dispatchForFile` with its dedupe, rule policy and delta.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { parsePyrightOutput } from "../../../clients/dispatch/runners/pyright.js";
import pyrightRunner from "../../../clients/dispatch/runners/pyright.js";
import lspRunner from "../../../clients/dispatch/runners/lsp.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import { getPrimaryDispatchGroup } from "../../../clients/language-policy.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { removeTempDirSync } from "../test-utils.js";

interface Capture {
	provenance: { tool: string; version: string };
	text: string;
	cli: { stdout: string };
	lsp: { diagnostics: LSPDiagnostic[] };
}

const FLAVOURS = [
	{ fixture: "pyright.captured.json", source: "Pyright" },
	{ fixture: "basedpyright.captured.json", source: "basedpyright" },
] as const;

function loadCapture(fixture: string): Capture {
	return JSON.parse(
		fs.readFileSync(
			path.join(__dirname, "../../fixtures/lsp-cli-copies", fixture),
			"utf8",
		),
	) as Capture;
}

/** One `line:column:code` per finding, from the CLI's own bytes (1-based). */
function expectedFindings(capture: Capture): string[] {
	const parsed = JSON.parse(capture.cli.stdout) as {
		generalDiagnostics: {
			rule: string;
			range: { start: { line: number; character: number } };
		}[];
	};
	return parsed.generalDiagnostics
		.map(
			(d) =>
				`${d.range.start.line + 1}:${d.range.start.character + 1}:${d.rule}`,
		)
		.sort();
}

let tmpDir: string;
let file: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pyright-copies-"));
	file = path.join(tmpDir, "app.py");
	resetProjectLensConfigCache();
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
});

/**
 * Dispatch the file through the production python group. The two runner shells
 * keep their real id, kinds and priority; only `run` answers with the captured
 * bytes, converted by the real converter and parser.
 */
async function dispatchCopies(
	capture: Capture,
	lanes: { lsp?: LSPDiagnostic[]; cliStdout?: string } = {},
) {
	const lspDiagnostics = convertLspDiagnostics(
		lanes.lsp ?? capture.lsp.diagnostics,
		file,
	);
	const cliDiagnostics = parsePyrightOutput(
		JSON.parse(lanes.cliStdout ?? capture.cli.stdout),
		file,
	).map((d) => ({ ...d, filePath: file }));
	const registry = new RunnerRegistry();
	const answer = (diagnostics: typeof cliDiagnostics) => async () => ({
		status: "succeeded" as const,
		diagnostics,
		semantic: diagnostics.some((d) => d.semantic === "blocking")
			? ("blocking" as const)
			: ("warning" as const),
	});
	registry.register({ ...lspRunner, run: answer(lspDiagnostics) });
	registry.register({ ...pyrightRunner, run: answer(cliDiagnostics) });
	const group = getPrimaryDispatchGroup("python", true);
	if (!group) throw new Error("python has no primary dispatch group");
	const ctx = createDispatchContext(
		file,
		tmpDir,
		{ getFlag: () => false },
		new FactStore(),
	);
	return dispatchForFile(ctx, [group], registry);
}

function findings(
	diagnostics: { line?: number; column?: number; rule?: string }[],
) {
	return diagnostics
		.map(
			(d) => `${d.line}:${d.column}:${(d.rule ?? "").replace(/^[^:]+:/, "")}`,
		)
		.sort();
}

describe.each(FLAVOURS)(
	"$source language server and the pyright CLI report one file (#4629)",
	({ fixture, source }) => {
		const capture = loadCapture(fixture);

		it("names the same findings in both lanes, under two spellings of each rule", () => {
			// The premise: the lanes agree on what is wrong and disagree only on
			// how the rule is spelled, which is the identity the dedupe reads.
			const lsp = convertLspDiagnostics(capture.lsp.diagnostics, file);
			const cli = parsePyrightOutput(JSON.parse(capture.cli.stdout), file);
			expect(findings(lsp)).toEqual(findings(cli));
			expect(lsp.every((d) => d.rule?.startsWith(`${source}:`))).toBe(true);
			expect(cli.some((d) => d.rule?.includes(":"))).toBe(false);
		});

		it("lists each finding once when both lanes report it", async () => {
			const result = await dispatchCopies(capture);
			expect(findings(result.diagnostics)).toEqual(expectedFindings(capture));
		});

		it("keeps the language server's copy of each finding", async () => {
			const result = await dispatchCopies(capture);
			expect(new Set(result.diagnostics.map((d) => d.tool))).toEqual(
				new Set(["lsp"]),
			);
			expect(
				result.diagnostics.every((d) => d.rule?.startsWith(`${source}:`)),
			).toBe(true);
		});

		it("counts each error once in the STOP header the agent reads", async () => {
			const errors = (
				JSON.parse(capture.cli.stdout) as {
					generalDiagnostics: { severity: string }[];
				}
			).generalDiagnostics.filter((d) => d.severity === "error").length;
			const result = await dispatchCopies(capture);
			expect(result.output).toContain(
				`STOP — ${errors} issue(s) must be fixed`,
			);
		});

		it("lists the CLI's findings when the language server publishes nothing", async () => {
			const result = await dispatchCopies(capture, { lsp: [] });
			expect(findings(result.diagnostics)).toEqual(expectedFindings(capture));
			expect(new Set(result.diagnostics.map((d) => d.tool))).toEqual(
				new Set(["pyright"]),
			);
		});

		it("lists the language server's findings when the CLI reports nothing", async () => {
			const result = await dispatchCopies(capture, {
				cliStdout: JSON.stringify({ generalDiagnostics: [] }),
			});
			expect(findings(result.diagnostics)).toEqual(expectedFindings(capture));
			expect(new Set(result.diagnostics.map((d) => d.tool))).toEqual(
				new Set(["lsp"]),
			);
		});

		it("keeps another server's same-named code beside the CLI copy (the prefix list is closed)", async () => {
			// `ty` is the opt-in Python fallback server (clients/lsp/server.ts). A
			// code it shares with Pyright's is another analyzer's finding.
			const foreign = capture.lsp.diagnostics
				.filter((d) => d.code === "reportAssignmentType")
				.map((d) => ({ ...d, source: "ty" }));
			expect(foreign).toHaveLength(1);
			const result = await dispatchCopies(capture, { lsp: foreign });
			expect(
				result.diagnostics
					.filter((d) => d.line === 15)
					.map((d) => d.rule)
					.sort(),
			).toEqual(["reportAssignmentType", "ty:reportAssignmentType"]);
		});

		it("hides both copies of a rule listed by its bare code in rules.<id>.disable", async () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"pyright-assignment": { disable: ["reportAssignmentType"] },
					},
				}),
			);
			const result = await dispatchCopies(capture);
			const expected = expectedFindings(capture).filter(
				(f) => !f.endsWith(":reportAssignmentType"),
			);
			expect(findings(result.diagnostics)).toEqual(expected);
			expect(result.output).not.toContain("declared type");
		});
	},
);
