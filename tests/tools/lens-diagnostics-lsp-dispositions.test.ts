/**
 * #3088 (folds #3047, and the `source: "lsp"` remainder of #3041): the
 * `lens_diagnostics` `source=lsp` probe lane — the lane
 * `skills/pi-lens-lsp-navigation` steers agents to as PRIMARY — returned raw
 * LSP findings with no disposition filter, no `.pi-lens.json`
 * `rules.<id>.disable`/`select` policy and no inline `pi-lens-ignore`
 * suppression, while `mode: "delta"` and `mode: "full"` applied all three. An
 * agent that marked a finding `false-positive` and re-verified on this lane saw
 * it re-reported every turn, and the probe's own footer reconcile
 * (`reconcileWidgetFromLspResult`, which writes the pre-filter set per the #571
 * note) overwrote the mark-time demotion `reconcileWidgetDisposition` applied.
 *
 * Every case here drives the PRODUCTION tool (`createLensDiagnosticsTool` with
 * `source: "lsp"`, and the legacy `lsp_diagnostics` tool) against a real mark
 * written by the production `lens_diagnostic_mark` tool.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const MESSAGE = "Type 'string' is not assignable to type 'number'.";
const FILE_BODY = "const value: number = 'bad';\nexport const other = 1;\n";

let cwd: string;
let filePath: string;
let previousDataDir: string | undefined;

function makeService(severity = 2) {
	return {
		touchFile: vi.fn(async () => undefined),
		getDiagnostics: vi.fn(async () => [
			{
				severity,
				message: MESSAGE,
				source: "typescript",
				code: 2322,
				range: {
					start: { line: 0, character: 6 },
					end: { line: 0, character: 11 },
				},
			},
		]),
		getCapabilitySnapshots: vi.fn(async () => []),
	};
}

function makeCacheManager() {
	return { readCache: vi.fn(() => undefined) } as never;
}

async function probe(service: ReturnType<typeof makeService>) {
	const tool = createLensDiagnosticsTool(
		makeCacheManager(),
		() => cwd,
		() => service as never,
	);
	return (await tool.execute(
		"diag-3088",
		{ source: "lsp", scope: "paths", paths: [filePath] },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

async function legacyProbe(service: ReturnType<typeof makeService>) {
	const tool = createLspDiagnosticsTool(
		undefined,
		undefined,
		() => service as never,
	);
	return (await tool.execute(
		"lsp-3088",
		{ path: filePath },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

async function mark(params: Record<string, unknown>) {
	const markTool = createLensDiagnosticMarkTool(() => cwd);
	return markTool.execute("mark-3088", params, undefined, () => {}, { cwd });
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3088-"));
	filePath = path.join(cwd, "app.ts");
	fs.writeFileSync(filePath, FILE_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(cwd, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("lens_diagnostics source=lsp honors dispositions (#3088)", () => {
	it("drops a finding marked false-positive", async () => {
		const service = makeService();
		const before = await probe(service);
		expect(before.content[0].text).toContain(MESSAGE);

		const marked = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			rule: "typescript:2322",
			tool: "lsp",
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
		expect(after.details?.totalDiagnostics).toBe(0);
	});

	it("drops a non-blocking finding marked suppress (weak anchor)", async () => {
		const service = makeService(2);
		await probe(service);
		const marked = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			rule: "typescript:2322",
			tool: "lsp",
			disposition: "suppress",
		});
		expect(marked.isError).toBeFalsy();
		// The suppress writer inserts an inline comment, which shifts the finding;
		// re-point the service at the new line so the probe result is about the
		// disposition, not the edit.
		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});

	it("keeps a BLOCKING finding under a weak suppress mark (#1625 F1)", async () => {
		const service = makeService(1);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			rule: "typescript:2322",
			tool: "lsp",
			disposition: "defer",
		});
		const after = await probe(service);
		expect(after.content[0].text).toContain(MESSAGE);
	});

	it("drops a deferred non-blocking finding for the session", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			rule: "typescript:2322",
			tool: "lsp",
			disposition: "defer",
		});
		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});

	it("applies the same filter on the legacy lsp_diagnostics tool", async () => {
		const service = makeService();
		await legacyProbe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			rule: "typescript:2322",
			tool: "lsp",
			disposition: "false-positive",
		});
		const after = await legacyProbe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});
});

describe("lens_diagnostics source=lsp honors project rule policy (#3088)", () => {
	it("drops a finding whose rule is disabled in .pi-lens.json", async () => {
		const service = makeService();
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { disable: ["typescript:2322"] } } }),
		);
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});

	it("drops a finding outside a .pi-lens.json select allowlist", async () => {
		const service = makeService();
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { select: ["typescript:9999"] } } }),
		);
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});
});

describe("lens_diagnostics source=lsp honors inline pi-lens-ignore (#3088)", () => {
	it("drops a finding suppressed by an inline comment on the line above", async () => {
		const service = makeService();
		fs.writeFileSync(
			filePath,
			`// pi-lens-ignore: typescript:2322\n${FILE_BODY}`,
		);
		service.getDiagnostics = vi.fn(async () => [
			{
				severity: 2,
				message: MESSAGE,
				source: "typescript",
				code: 2322,
				range: {
					start: { line: 1, character: 6 },
					end: { line: 1, character: 11 },
				},
			},
		]);
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});
});

describe("the source=lsp footer reconcile respects mark-time demotion (#3088)", () => {
	it("does not re-arm a disposed finding in the widget footer", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			rule: "typescript:2322",
			tool: "lsp",
			disposition: "false-positive",
		});
		const demoted = getFileDiagnostics(filePath) ?? [];
		expect(
			demoted.some((d) => d.disposition === "false-positive"),
		).toBe(true);

		await probe(service);

		const afterProbe = getFileDiagnostics(filePath) ?? [];
		expect(
			afterProbe.filter(
				(d) => d.message === MESSAGE && d.disposition === undefined,
			),
		).toHaveLength(0);
	});
});
