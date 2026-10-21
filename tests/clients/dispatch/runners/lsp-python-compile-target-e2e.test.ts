// flake-shape: in-process-mock — the behaviour under test is the post-write
// runner's own admission of a server answer, so the LSP service is doubled at
// its capability seam and everything downstream of it is production code.
/**
 * #4638 review (post-write lane), driven through the real `lspRunner`: a jedi
 * `compile` row is not evidence about a project that declares Python 3.14, and
 * the runner that delivers jedi's answer after a write must drop it exactly as
 * the probe does, record the same bounded degradation, and keep every other
 * server's finding.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { removeTempDirSync } from "../../test-utils.js";

const COMPILE_MESSAGE =
	"SyntaxError: multiple exception types must be parenthesized";
const PYRIGHT_MESSAGE = 'Cannot access attribute "value" for class "object"';

function jediCompile() {
	return {
		severity: 1,
		message: COMPILE_MESSAGE,
		source: "compile",
		code: "syntax",
		serverId: "python-jedi",
		range: {
			start: { line: 2, character: 8 },
			end: { line: 2, character: 20 },
		},
	};
}

function pyrightFinding() {
	return {
		severity: 1,
		message: PYRIGHT_MESSAGE,
		source: "pyright",
		code: "reportAttributeAccessIssue",
		serverId: "pyright",
		range: {
			start: { line: 5, character: 4 },
			end: { line: 5, character: 9 },
		},
	};
}

const mocked = vi.hoisted(() => ({
	service: undefined as unknown,
}));

vi.mock("../../../../clients/lsp/capabilities.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../clients/lsp/capabilities.js")
	>("../../../../clients/lsp/capabilities.js");
	return { ...actual, getLSPService: () => mocked.service };
});

import lspRunner from "../../../../clients/dispatch/runners/lsp.js";

let cwd: string;
let filePath: string;

function declareRequiresPython(specifier: string): void {
	fs.writeFileSync(
		path.join(cwd, "pyproject.toml"),
		`[project]\nname = "demo"\nrequires-python = "${specifier}"\n`,
	);
}

async function run(
	diags: Array<Record<string, unknown>>,
): Promise<Array<{ message: string }>> {
	mocked.service = makeLspServiceDouble({
		supportsLSP: vi.fn(() => true),
		touchFile: vi.fn(async () => ({ diags })),
	});
	const result = await lspRunner.run(
		makeRunnerCtx(filePath, cwd, { kind: "python" }),
	);
	return result.diagnostics;
}

function compileDrops() {
	return getDegradationSummary().filter(
		(entry) => entry.kind === "python-compile-target-mismatch",
	);
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-postwrite-"));
	filePath = path.join(cwd, "app.py");
	fs.writeFileSync(
		filePath,
		[
			"def run() -> None:",
			"\ttry:",
			"\t\tpass",
			"\texcept ValueError, TypeError:",
			"\t\tpass",
			"",
		].join("\n"),
	);
	resetDegradationLedger();
});

afterEach(() => {
	resetDegradationLedger();
	removeTempDirSync(cwd);
});

describe("post-write jedi answer under a declared syntax level (#4638)", () => {
	it("drops the compile row at 3.14 and keeps the real finding", async () => {
		declareRequiresPython(">=3.14");

		const diagnostics = await run([jediCompile(), pyrightFinding()]);

		expect(diagnostics.map((entry) => entry.message)).toEqual([
			PYRIGHT_MESSAGE,
		]);
		const drops = compileDrops();
		expect(drops).toHaveLength(1);
		expect(drops[0]?.latestReasons[0]?.reason).toContain(
			"1 jedi compile finding dropped",
		);
	});

	it("delivers the compile row at 3.13", async () => {
		declareRequiresPython(">=3.13");

		const diagnostics = await run([jediCompile(), pyrightFinding()]);

		expect(diagnostics.map((entry) => entry.message)).toEqual([
			COMPILE_MESSAGE,
			PYRIGHT_MESSAGE,
		]);
		expect(compileDrops()).toHaveLength(0);
	});
});
