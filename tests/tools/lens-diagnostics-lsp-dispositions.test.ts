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

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));

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

/**
 * A single LSP finding as a real server publishes it: `source`/`code` are the
 * identity the probe's own `formatDiag` renders, `serverId` is what the
 * workspace-diagnostics cache requires before it will persist an entry.
 */
function makeService(severity = 2) {
	const touchFile = vi.fn(async () => ({
		diags: [
			{
				severity,
				message: MESSAGE,
				source: "typescript",
				code: 2322,
				serverId: "typescript",
				range: {
					start: { line: 0, character: 6 },
					end: { line: 0, character: 11 },
				},
			},
		],
	}));
	return {
		touchFile,
		getDiagnostics: vi.fn(async () => []),
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

/** The canonical spelling: what the widget footer / mode=full / mode=delta
 * render, and therefore the spelling of a mark made anywhere else. */
const CANONICAL_MARK = { rule: "typescript:2322", tool: "lsp" };

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3088-"));
	filePath = path.join(cwd, "app.ts");
	fs.writeFileSync(filePath, FILE_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(cwd, "data");
	logLatency.mockReset();
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
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
		expect(after.details?.totalDiagnostics).toBe(0);
	});

	it("states the drop as a visible count instead of rendering clean (#1616)", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = await probe(service);
		expect(after.content[0].text).toContain(
			"suppressed by disposition: 1 finding(s)",
		);
		expect(after.details?.dispositionSuppressed).toBe(1);
	});

	it("records one bounded lsp_probe_disposition_filter phase per filtered file", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		logLatency.mockReset();

		await probe(service);

		const phases = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.filter((entry) => entry.phase === "lsp_probe_disposition_filter");
		expect(phases).toHaveLength(1);
		expect(phases[0]?.metadata).toMatchObject({ suppressed: 1, total: 1 });
		expect(phases[0]?.filePath).toBe(filePath);
	});

	it("emits no filter phase when nothing was dropped", async () => {
		const service = makeService();
		await probe(service);
		expect(
			logLatency.mock.calls.filter(
				([entry]) =>
					(entry as { phase?: string }).phase ===
					"lsp_probe_disposition_filter",
			),
		).toHaveLength(0);
	});

	it("drops a non-blocking finding held only by a weak suppress mark", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "suppress",
		});
		// `suppress` also writes an inline `pi-lens-ignore` comment. Restore the
		// original bytes so the ONLY thing that can drop the finding is the
		// weak-anchored store entry — otherwise this case would pass on the
		// inline filter and say nothing about the disposition.
		fs.writeFileSync(filePath, FILE_BODY);

		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});

	it("keeps a BLOCKING finding under a weak defer mark (#1625 F1)", async () => {
		const service = makeService(1);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "defer",
		});
		const after = await probe(service);
		expect(after.content[0].text).toContain(MESSAGE);
	});

	it("drops a deferred non-blocking finding, and resurfaces it after a session reset", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "defer",
		});
		expect((await probe(service)).content[0].text).not.toContain(MESSAGE);

		_resetDeferredForTests();
		expect((await probe(service)).content[0].text).toContain(MESSAGE);
	});

	it("applies the same filter on the legacy lsp_diagnostics tool", async () => {
		const service = makeService();
		await legacyProbe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const after = await legacyProbe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});
});

/**
 * AGENTS.md shape 26 / #3088 AC6. The probe's own text render is
 * `[<source>] (<code>)`, while the widget footer and `mode=full` render the
 * canonical `tool: "lsp"` / `rule: "<source>:<code>"`, and
 * `lens_diagnostic_mark`'s `tool` parameter is optional. A filter that matched
 * only ONE of those spellings honored a mark made on one surface while
 * re-reporting the identical finding when the mark came from another.
 */
describe("marks converge across every spelling the surfaces render (#3088)", () => {
	const spellings: Array<[string, Record<string, unknown>]> = [
		["canonical (widget footer / mode=full)", CANONICAL_MARK],
		["probe render — [source] (code)", { tool: "typescript", rule: "2322" }],
		["rule-only, tool omitted", { rule: "typescript:2322" }],
	];

	for (const [label, identity] of spellings) {
		it(`converges for a false-positive marked with the ${label} identity`, async () => {
			const service = makeService();
			await probe(service);
			const marked = await mark({
				filePath,
				line: 1,
				message: MESSAGE,
				...identity,
				disposition: "false-positive",
			});
			expect(marked.isError).toBeFalsy();

			const after = await probe(service);
			expect(after.content[0].text).not.toContain(MESSAGE);
		});
	}
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
		service.touchFile = vi.fn(async () => ({
			diags: [
				{
					severity: 2,
					message: MESSAGE,
					source: "typescript",
					code: 2322,
					serverId: "typescript",
					range: {
						start: { line: 1, character: 6 },
						end: { line: 1, character: 11 },
					},
				},
			],
		}));
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});
});

/**
 * #3088 AC5. The batch sweep's workspace-diagnostics cache (#671) replays an
 * earlier observation without touching the server again. That replay is served
 * to the agent exactly like a fresh probe, so it passes the same filter — the
 * strict (`false-positive`) branch included, which needs the file's content to
 * re-derive its line hash.
 */
describe("cache-replay probes honor marks like fresh ones (#3088)", () => {
	it("drops a false-positive finding on a replay that never re-touched the server", async () => {
		const service = makeService();
		await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});

	// The cache entry records the INLINE-suppressed set, never the
	// disposition-filtered one: a mark can be revoked at any moment, and an
	// entry that baked the mark in would keep the finding hidden until the file
	// itself changed — the #571 class of stale hidden state. Mutation: record
	// `effectiveRawDiags` (already policy-filtered at that point) instead of
	// `policy.inlineKept` and this case reds.
	it("resurfaces a finding on a replay once its mark is gone from the store", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect((await probe(service)).content[0].text).not.toContain(MESSAGE);

		fs.rmSync(
			path.join(
				process.env.PILENS_DATA_DIR as string,
				...fs
					.readdirSync(process.env.PILENS_DATA_DIR as string)
					.map((slug) => path.join(slug, "cache")),
				"diagnostic-dispositions.json",
			),
		);
		_resetStateCacheForTests();

		const after = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(after.content[0].text).toContain(MESSAGE);
	});

	it("drops a weak-marked finding on a replay with no content read at all", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "defer",
		});

		const after = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(after.content[0].text).not.toContain(MESSAGE);
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
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const demoted = getFileDiagnostics(filePath) ?? [];
		expect(demoted.some((d) => d.disposition === "false-positive")).toBe(true);

		await probe(service);

		const afterProbe = getFileDiagnostics(filePath) ?? [];
		expect(
			afterProbe.filter(
				(d) => d.message === MESSAGE && d.disposition === undefined,
			),
		).toHaveLength(0);
	});
});
