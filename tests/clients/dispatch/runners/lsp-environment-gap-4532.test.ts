/**
 * #4532 half 2: an environment gap is not a code defect.
 *
 * Recurrence it prevents: a pi session edited a file in a linked worktree that
 * had no `node_modules`. The `typescript` server rooted there published seven
 * severity-1 rows — TS2307 on `node:crypto`, TS2503 on `NodeJS`, and TS2304 for
 * the four timer globals — and pi-lens rendered them as `🔴 STOP — 7 issue(s)
 * must be fixed`. None of the seven was a defect in the edited file: the
 * worktree had no dependency install, so the server had no `@types/node`. The
 * agent cannot fix a missing install by editing code, and the blockers starved
 * the cascade (`cascade_skip reason=primary_has_blockers`).
 *
 * Real: the `lsp` dispatch runner, `convertLspDiagnostics`, the demotion seam
 * `clients/lsp/environment-gap.ts` sits in, and the runner's own result
 * semantics. Doubled only at the process boundary — the language server behind
 * `clients/lsp/capabilities.js`, installed through the real service lifecycle
 * seam rather than a module mock, so the runner's own `getLSPService()` call is
 * the one that runs.
 *
 * Fail-closed direction (AGENTS shape 69): the demotion admits a closed list of
 * (code, operand) pairs from the TypeScript server and refuses everything else,
 * so the cells below are half admitted forms and half refusals. A refusal cell
 * that demoted would hide a real type error, which is the harm this gate must
 * never cause.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lspRunner from "../../../../clients/dispatch/runners/lsp.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../../clients/lsp/capabilities.js";
import { ENVIRONMENT_GAP_MARKER } from "../../../../clients/lsp/environment-gap.js";
import { configureLspServiceLifecycle } from "../../../../clients/lsp/service-singleton.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";
import { setupTestEnvironment } from "../../test-utils.js";

type RawDiagnostic = {
	severity: number;
	message: string;
	code: number | string;
	source: string;
	serverId?: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
};

function atLine(line: number): RawDiagnostic["range"] {
	return {
		start: { line, character: 0 },
		end: { line, character: 24 },
	};
}

/** The seven rows the live session actually got, plus one real type error. */
function liveSessionRows(): RawDiagnostic[] {
	const ts = (code: number, message: string, line: number): RawDiagnostic => ({
		severity: 1,
		message,
		code,
		source: "ts",
		serverId: "typescript",
		range: atLine(line),
	});
	return [
		ts(
			2307,
			"Cannot find module 'node:crypto' or its corresponding type declarations.",
			3,
		),
		ts(2503, "Cannot find namespace 'NodeJS'.", 12),
		ts(2304, "Cannot find name 'setTimeout'.", 31),
		ts(2304, "Cannot find name 'clearTimeout'.", 32),
		ts(2304, "Cannot find name 'setInterval'.", 40),
		ts(2304, "Cannot find name 'clearInterval'.", 41),
		// The real defect in the same file: this one must keep blocking.
		ts(2322, "Type 'string' is not assignable to type 'number'.", 55),
	];
}

let env: { tmpDir: string; cleanup: () => void };
let root: string;
let file: string;
let rows: RawDiagnostic[];

function installService(): void {
	resetLSPService();
	const service = makeLspServiceDouble({
		supportsLSP: () => true,
		touchFile: async () => ({ diags: rows.map((row) => ({ ...row })) }),
		codeAction: async () => [],
	});
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service as Record<string, unknown>,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
}

async function run(): Promise<
	Awaited<ReturnType<typeof lspRunner.run>> extends infer T
		? T extends undefined
			? never
			: T
		: never
> {
	const result = await lspRunner.run({
		filePath: file,
		cwd: root,
		fileRole: "source",
		pi: { getFlag: () => undefined },
	} as never);
	if (!result) throw new Error("the lsp runner returned no result");
	return result as never;
}

function finding(
	result: Awaited<ReturnType<typeof run>>,
	rule: string,
): { severity: string; semantic: string; message: string } | undefined {
	return result.diagnostics.find((item) => item.rule === rule) as
		| { severity: string; semantic: string; message: string }
		| undefined;
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-env-gap-4532-");
	root = path.join(env.tmpDir, "worktree");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	file = path.join(root, "src", "admission-limiter.ts");
	fs.writeFileSync(file, "export const x = 1;\n");
	rows = liveSessionRows();
	resetDegradationLedger();
});

afterEach(() => {
	resetLSPService();
	env.cleanup();
});

describe("a worktree with no dependency install (#4532)", () => {
	it("demotes the known environment-gap codes with a visible label and keeps the real code blocking", async () => {
		installService();
		const result = await run();

		const cryptoGap = finding(result, "ts:2307");
		const namespaceGap = finding(result, "ts:2503");
		const timerGap = finding(result, "ts:2304");
		const realError = finding(result, "ts:2322");

		// Demoted, never hidden: the finding is still there, at warning
		// authority, and says why in its own text.
		expect(cryptoGap).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(cryptoGap?.message).toContain(ENVIRONMENT_GAP_MARKER);
		expect(namespaceGap).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(namespaceGap?.message).toContain(ENVIRONMENT_GAP_MARKER);
		expect(timerGap).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(timerGap?.message).toContain(ENVIRONMENT_GAP_MARKER);

		// Fail closed: the file's own real type error still blocks, so the
		// result the agent sees is a blocker it can act on.
		expect(realError).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(realError?.message).not.toContain(ENVIRONMENT_GAP_MARKER);
		expect(result.semantic).toBe("blocking");

		// One bounded record per admission kind: the ledger names what fired.
		const kinds = getDegradationSummary()
			.filter((group) => group.kind === "lsp-environment-gap-demoted")
			.flatMap((group) => group.latestReasons.map((entry) => entry.subject));
		expect(kinds).toContain("2307");
		expect(kinds).toContain("2503");
		expect(kinds).toContain("2304");
	});

	it("keeps every code blocking when the root resolves a dependency install", async () => {
		fs.mkdirSync(path.join(root, "node_modules", "@types", "node"), {
			recursive: true,
		});
		installService();
		const result = await run();

		expect(finding(result, "ts:2307")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(finding(result, "ts:2503")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(finding(result, "ts:2304")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps a namespace gap blocking when the namespace is not NodeJS", async () => {
		rows = [
			{
				severity: 1,
				message: "Cannot find namespace 'Deno'.",
				code: 2503,
				source: "ts",
				serverId: "typescript",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "ts:2503")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps a module gap blocking when the specifier is project-relative", async () => {
		rows = [
			{
				severity: 1,
				message:
					"Cannot find module './missing' or its corresponding type declarations.",
				code: 2307,
				source: "ts",
				serverId: "typescript",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "ts:2307")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps a missing name blocking when it is not a Node global", async () => {
		rows = [
			{
				severity: 1,
				message: "Cannot find name 'describe'.",
				code: 2304,
				source: "ts",
				serverId: "typescript",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "ts:2304")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps an environment-shaped code blocking when another server produced it", async () => {
		rows = [
			{
				severity: 1,
				message:
					"Cannot find module 'node:crypto' or its corresponding type declarations.",
				code: 2307,
				source: "opentofu-ls",
				serverId: "opentofu",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "opentofu-ls:2307")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});
});
