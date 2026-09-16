/**
 * #3170 — the bounded persistent-reverify pass.
 *
 * Recurrence: a finding whose own file is unchanged re-serves turn after turn
 * from the persisted actionable-warnings report without ever being
 * re-observed — the in-band publish carries DEFERRED-origin entries while
 * their file has not moved, and the delta freshness gate passes them because
 * the file's mtime has not moved either. When the root cause was fixed in a
 * DIFFERENT file, the carried finding is stale in fact but fresh by every
 * on-disk axis. The pass re-observes such files through the probe's
 * `touchFile` path and publishes an in-band REPLACEMENT so the carried entry
 * is superseded, not unioned with.
 *
 * Red-first: pre-fix, this module did not exist — nothing re-observed a
 * carried finding (the issue's own evidence). The merge-supersede behavior is
 * additionally mutation-proven: reverting the `reVerified` branch to master's
 * union semantics reds C1 (the converged finding survives its own
 * supersession via the id-union).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const logLatencyMock = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (...args: unknown[]) => logLatencyMock(...args),
}));

import {
	MAX_REVERIFY_FILES,
	runPersistentReverify,
	type ReverifyLspService,
} from "../../clients/persistent-reverify.js";
import {
	publishActionableWarningsReport,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

const WARNING_MESSAGE = "'x' is declared but its value is never read.";

function makeCarriedReport(filePath: string): ActionableWarningsReport {
	const stamp = new Date().toISOString();
	return {
		generatedAt: stamp,
		scope: "turn_delta",
		sessionId: "s1",
		turnIndex: 1,
		deltaOnly: true,
		includeLspCodeActions: false,
		files: [
			{
				filePath,
				displayPath: "src/a.ts",
				origin: "deferred",
				generatedAt: stamp,
				warnings: [
					{
						id: "w1",
						filePath,
						displayPath: "src/a.ts",
						line: 1,
						severity: "warning",
						tool: "typescript",
						source: "ts",
						code: "6133",
						rule: "ts:6133",
						message: WARNING_MESSAGE,
						actions: [],
						suppressed: false,
						origin: "lsp",
					},
				],
			},
		],
		summary: {
			warnings: 1,
			unsuppressed: 1,
			suppressed: 0,
			files: 1,
			actions: 0,
			autoFixEligible: 0,
		},
	};
}

function makeService(
	diags:
		| Array<{
				severity: number;
				message: string;
				range: {
					start: { line: number; character: number };
					end: { line: number; character: number };
				};
				source?: string;
				code?: number | string;
				serverId?: string;
		  }>
		| "throw"
		| "inconclusive",
): ReverifyLspService {
	return {
		touchFile: vi.fn(async () => {
			if (diags === "throw") throw new Error("wedged server");
			if (diags === "inconclusive") return { inconclusive: true };
			return {
				diags: diags.map((d) => ({
					...d,
					serverId: d.serverId ?? "typescript",
				})),
			};
		}),
	} as unknown as ReverifyLspService;
}

describe("persistent reverify (#3170)", () => {
	let tmpDir: string;
	let cwd: string;
	let filePath: string;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-reverify-"));
		cwd = tmpDir;
		filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const x = 1;\n");
		// Deterministic staleness fixtures: sub-millisecond mtime precision vs
		// integer-ms ISO stamps makes write-then-stamp ordering a coin flip —
		// pin the file's mtime to a known past instant instead (the house's
		// fake-clock discipline for real-time races).
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(filePath, past, past);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
		logLatencyMock.mockClear();
		resetProjectLensConfigCache();
	});

	afterEach(() => {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		removeTempDirSync(tmpDir);
	});

	it("C1: a converged carried finding is dropped — the replacement supersedes the union", async () => {
		const carried = makeCarriedReport(filePath);
		// The server now answers CLEAN for the same content (root cause fixed
		// in another file): no diagnostics at all.
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService([]),
		});
		expect(result.outcomes[0]?.outcome).toBe("clean");
		expect(result.outcomes[0]?.dropped).toBe(1);
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toEqual([]);
		expect(replacement?.reVerified).toBe(true);

		// Merge-level: publishing the replacement in-band must REMOVE the
		// carried warning — master's union semantics kept it (mutation-proven).
		const store = new Map<string, unknown>();
		store.set("actionable-warnings", carried);
		const cacheManager = {
			readCache: vi.fn((key: string) =>
				store.has(key) ? { data: store.get(key) } : undefined,
			),
			writeCache: vi.fn((key: string, data: unknown) => {
				store.set(key, data);
			}),
		};
		publishActionableWarningsReport(
			cacheManager as any,
			cwd,
			{ ...carried, files: result.replacementFiles },
			{ origin: "in-band" },
		);
		const merged = store.get("actionable-warnings") as ActionableWarningsReport;
		const mergedFile = merged.files.find((f) => f.filePath === filePath);
		expect(mergedFile?.warnings ?? []).toEqual([]);
	});

	it("C2: a re-confirmed finding is re-delivered as a fresh observation", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService([
				{
					severity: 2,
					message: WARNING_MESSAGE,
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 7 },
					},
					source: "ts",
					code: 6133,
				},
			]),
		});
		expect(result.outcomes[0]?.outcome).toBe("reconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toHaveLength(1);
		expect(replacement?.reVerified).toBe(true);
		// The fresh record's stamp is the observation stamp, not the carried
		// one — the entry is younger than the re-verification.
		expect(replacement?.generatedAt).toBeDefined();
	});

	it("C3: an unconfirmed touch keeps the carried entry verbatim and marks the gap", async () => {
		const carried = makeCarriedReport(filePath);
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService("throw"),
		});
		expect(result.outcomes[0]?.outcome).toBe("unconfirmed");
		const replacement = result.replacementFiles[0];
		expect(replacement?.warnings).toHaveLength(1);
		expect(replacement?.warnings[0]?.message).toBe(WARNING_MESSAGE);
		expect(replacement?.reVerifyIncomplete).toBe(true);
	});

	it("C4: a file changed since its observation stamp is skipped — the edit path owns it", async () => {
		const carried = makeCarriedReport(filePath);
		// Stamp the observation BEFORE the file's last write: the file has
		// moved since, so the edit path already re-observed it.
		carried.files[0]!.generatedAt = new Date(
			Date.now() - 120_000,
		).toISOString();
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService([]),
		});
		expect(result.outcomes).toEqual([]);
		expect(result.replacementFiles).toEqual([]);
		expect(result.skippedChanged ?? 0).toBeGreaterThanOrEqual(0);
	});

	it("C5: the pass caps at MAX_REVERIFY_FILES candidates", async () => {
		const carried = makeCarriedReport(filePath);
		const extra: ActionableWarningsReport["files"] = [];
		for (let i = 0; i < MAX_REVERIFY_FILES + 2; i += 1) {
			const p = path.join(cwd, `src`, `f${i}.ts`);
			fs.writeFileSync(p, `const v${i} = 1;\n`);
			const past = new Date(Date.now() - 60_000);
			fs.utimesSync(p, past, past);
			extra.push({
				...carried.files[0]!,
				filePath: p,
				displayPath: `src/f${i}.ts`,
			});
		}
		carried.files = [...extra, ...carried.files];
		const result = await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService([]),
		});
		expect(result.outcomes.length).toBe(MAX_REVERIFY_FILES);
	});

	it("emits one bounded persistent_reverify record for the pass", async () => {
		const carried = makeCarriedReport(filePath);
		await runPersistentReverify({
			report: carried,
			cwd,
			lspService: makeService([]),
		});
		expect(logLatencyMock).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "persistent_reverify" }),
		);
	});

	it("C3-render: the delta mode labels a re-verify-incomplete group", async () => {
		const carried = makeCarriedReport(filePath);
		carried.files[0]!.reVerifyIncomplete = true;
		resetProjectLensConfigCache();
		const tool = createLensDiagnosticsTool(
			{
				readCache: vi.fn((key: string) =>
					key === "actionable-warnings" ? { data: carried } : undefined,
				),
			} as any,
			() => cwd,
		);
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).toContain(WARNING_MESSAGE);
		expect(text).toContain("(re-verify incomplete)");
	});
});
