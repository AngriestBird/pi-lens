/**
 * #4638 outcome: a project that declares Python 3.14 no longer receives jedi's
 * spurious `compile` verdict, on a fresh probe and on the workspace-cache
 * replay, while every other server's verdict and the file itself stay visible.
 *
 * The cases drive the PRODUCTION probe tool (`createLensDiagnosticsTool`,
 * `source: "lsp"`) against hand-built server answers, so the seam under test is
 * the real `applyProbeFindingPolicy` with the real degradation ledger, the real
 * workspace-diagnostics cache, and the real widget store. No helper re-implements
 * the drop.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const COMPILE_MESSAGE =
	"SyntaxError: multiple exception types must be parenthesized";
const COMPILE_MESSAGE_2 =
	"SyntaxError: expected an indented block after exception handler";
const PYRIGHT_MESSAGE = 'Cannot access attribute "value" for class "object"';

let cwd: string;
let filePath: string;

function jediCompile(overrides: Record<string, unknown> = {}) {
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
		...overrides,
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

/**
 * Seed from the shared `LSPService` double (#2582) and override only the answer
 * under test: the probe's own server selection sees the shape a real service
 * has, so the route under test is the production one. `supportsLSP`/`hasLSP`
 * stay absent, the older-host shape the probe treats as "route through
 * `touchFile`".
 */
function makeService(diags: Array<Record<string, unknown>>) {
	return makeLspServiceDouble(
		{ touchFile: vi.fn(async () => ({ diags })) },
		{ omit: ["supportsLSP", "hasLSP"] },
	);
}

type ServiceDouble = ReturnType<typeof makeService>;

async function probe(service: ServiceDouble) {
	const tool = createLensDiagnosticsTool(
		{ readCache: vi.fn(() => undefined) } as never,
		() => cwd,
		() => service as never,
	);
	return (await tool.execute(
		"diag-4638",
		{ source: "lsp", scope: "paths", paths: [filePath] },
		new AbortController().signal,
		null,
		{ cwd },
	)) as {
		isError?: boolean;
		content: Array<{ text: string }>;
		details?: {
			totalDiagnostics?: number;
			dispositionSuppressed?: number;
		};
	};
}

function declareRequiresPython(specifier: string): string {
	const pyproject = path.join(cwd, "pyproject.toml");
	fs.writeFileSync(
		pyproject,
		`[project]\nname = "demo"\nrequires-python = "${specifier}"\n`,
	);
	return pyproject;
}

function compileDrops() {
	return getDegradationSummary().filter(
		(entry) => entry.kind === "python-compile-target-mismatch",
	);
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-probe-"));
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
	clearWidgetState();
});

afterEach(() => {
	resetDegradationLedger();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("source=lsp drops jedi's compile verdict under a declared 3.14 (#4638)", () => {
	it("drops it while the real pyright finding stays delivered", async () => {
		const declarationFile = declareRequiresPython(">=3.14");
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.isError).toBe(false);
		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(result.content[0].text).toContain(PYRIGHT_MESSAGE);
		// Counts, text, and the widget come from one filtered set.
		expect(result.details?.totalDiagnostics).toBe(1);
		expect(result.details?.dispositionSuppressed).toBeUndefined();
		expect(getFileDiagnostics(filePath)?.map((entry) => entry.message)).toEqual(
			[PYRIGHT_MESSAGE],
		);

		const drops = compileDrops();
		expect(drops).toHaveLength(1);
		expect(drops[0]?.count).toBe(1);
		const reason = drops[0]?.latestReasons[0]?.reason ?? "";
		expect(reason).toContain("declared Python 3.14 (requires-python)");
		expect(reason).toContain(declarationFile);
		expect(reason).toContain("1 jedi compile finding dropped");
	});

	it("drops it again on a cache replay, and keeps it revocable there", async () => {
		declareRequiresPython(">=3.14");
		const service = makeService([jediCompile(), pyrightFinding()]);

		await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);

		const replay = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(replay.content[0].text).not.toContain("multiple exception types");
		expect(compileDrops()).toHaveLength(1);

		// The replay re-decides against the declaration current at the read: the
		// cached inline set still holds the row, so lowering the declaration (a
		// file the cache never keys on) brings it back without a re-touch.
		declareRequiresPython(">=3.12");
		const lowered = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(lowered.content[0].text).toContain("multiple exception types");
	});

	it("drops only jedi's compile rows, not every compile row", async () => {
		declareRequiresPython(">=3.14");
		const service = makeService([
			jediCompile(),
			jediCompile({ message: COMPILE_MESSAGE_2 }),
			pyrightFinding(),
		]);

		const result = await probe(service);

		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(result.content[0].text).not.toContain("expected an indented block");
		expect(compileDrops()[0]?.latestReasons[0]?.reason).toContain(
			"2 jedi compile findings dropped",
		);
	});
});

describe("source=lsp keeps every verdict below a declared 3.14 (#4638)", () => {
	it("delivers jedi's compile verdict at a declared 3.13", async () => {
		declareRequiresPython(">=3.13");
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(result.details?.totalDiagnostics).toBe(2);
		expect(compileDrops()).toHaveLength(0);
	});

	it("delivers jedi's compile verdict when the project declares nothing", async () => {
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(result.details?.totalDiagnostics).toBe(2);
		expect(compileDrops()).toHaveLength(0);
	});

	it("delivers jedi's compile verdict when the declaration is unusable", async () => {
		declareRequiresPython("<4");
		const service = makeService([jediCompile()]);

		const result = await probe(service);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(compileDrops()).toHaveLength(0);
	});
});
