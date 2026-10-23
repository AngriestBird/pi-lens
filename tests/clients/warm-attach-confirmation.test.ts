/**
 * #1253 — the PRODUCER half of the warm-attach confirmation carriage.
 *
 * `WarmDiagnosticsResponse.confirmation` is the incumbent's own
 * `TouchFileResult.confirmation` re-surfaced as an explicit enumerable DTO
 * field. It exists because `inconclusive: false` is NOT the same evidence: a
 * `silentOnClean` server like marksman publishes nothing on a clean file, so
 * without the field an incumbent-served empty result is indistinguishable from
 * "never answered" on the far side and every clean Markdown file in a
 * warm-attached session renders unconfirmed.
 *
 * The consumer half is pinned in `tests/tools/lsp-diagnostics.test.ts` against a
 * mocked `tryWarmAttachedDiagnostics`, which means the field's ABSENCE degrades
 * correctly — but nothing pinned the incumbent actually emitting it. These tests
 * drive `serveRequest` directly (the socket wiring around it needs a bindable
 * unix socket, which is not available in every sandbox) and cover both
 * directions of the mixed-build contract:
 *
 *  - a confirmed touch emits `confirmation: "confirmed"`;
 *  - an unconfirmed touch OMITS the key entirely rather than serializing
 *    `undefined`, which is what makes an old client's `JSON.parse` see the same
 *    shape a pre-#1253 incumbent produces (safe-by-omission, no version bump).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	contentHash,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import type { WarmDiagnosticsResponse } from "../../clients/mcp/ipc.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { ENVIRONMENT_GAP_MARKER } from "../../clients/lsp/environment-gap.js";
import { INFERRED_PROJECT_MARKER } from "../../clients/lsp/inferred-project.js";
import { removeTempDirSync } from "./test-utils.js";

const touchFile = vi.fn();
const projectInfo = vi.fn();

const FILE = "C:/repo/notes.md";
const CONTENT = "# hi\n";

function request(
	file = FILE,
	deadlineAt = Date.now() + 60_000,
	cwd = "C:/repo",
) {
	return {
		route: "diagnostics" as const,
		version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
		file,
		cwd,
		content: CONTENT,
		contentHash: contentHash(CONTENT),
		// Generous by default: `serveRequest` rejects a request whose deadline has
		// already passed, and drops `fresh` when it serves after it.
		deadlineAt,
	};
}

async function serve(file = FILE, deadlineAt?: number, cwd?: string) {
	const { _serveWarmRequestForTests } =
		await import("../../clients/warm-attach.js");
	const served = await _serveWarmRequestForTests(
		request(file, deadlineAt, cwd),
	);
	expect(served.error).toBeUndefined();
	return served.result as WarmDiagnosticsResponse;
}

describe("#1253 — warm-attach serves the touch confirmation", () => {
	beforeEach(async () => {
		vi.resetModules();
		touchFile.mockReset();
		projectInfo.mockReset();
		projectInfo.mockResolvedValue({
			executed: false,
			reason: "no live client",
		});
		// The install re-evaluates the facade after `vi.resetModules()` so
		// `serve()` reuses the lifecycle containing this case's double (#2592).
		await installLspServiceDouble({
			touchFile,
			executeReadOnlyCommandOnLiveClient: projectInfo,
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("carries confirmation:'confirmed' for a confirmed clean touch", async () => {
		// The marksman shape: a clean file, nothing published, but the touch's
		// silent-clean gate confirmed it.
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

		const result = await serve();

		expect(result.confirmation).toBe("confirmed");
		expect(result.diagnostics).toEqual([]);
		expect(result.inconclusive).toBe(false);
		expect(result.fresh).toBe(true);
	});

	it("OMITS the key (not undefined) when the touch was not confirmed", async () => {
		touchFile.mockResolvedValue({ diags: [] });

		const result = await serve();

		// Omission is the mixed-build contract: the wire bytes must match what a
		// pre-#1253 incumbent produces, so an old consumer sees no new key and a
		// new consumer reads `undefined` → unconfirmed. `confirmation: undefined`
		// would serialize away to the same thing, but asserting on the key makes
		// the intent enforceable rather than incidental.
		expect("confirmation" in result).toBe(false);
		expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
			"confirmation",
		);
	});

	it("never fabricates a confirmation for an inconclusive touch", async () => {
		// An inconclusive touch is the case the field must not launder: the
		// server's silence is unexplained, so the far side has to stay unconfirmed.
		touchFile.mockResolvedValue({ diags: [], inconclusive: true });

		const result = await serve();

		expect(result.inconclusive).toBe(true);
		expect("confirmation" in result).toBe(false);
	});

	it("carries confirmation alongside real findings too", async () => {
		const diag = {
			severity: 1,
			message: "broken link",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 4 },
			},
		};
		touchFile.mockResolvedValue({ diags: [diag], confirmation: "confirmed" });

		const result = await serve();

		expect(result.confirmation).toBe("confirmed");
		expect(result.diagnostics).toHaveLength(1);
	});

	it("carries the NARROWED confirmation and the server ids across the wire (#1470)", async () => {
		// A partial touch is not inconclusive — the primary answered — so without
		// an explicit narrowed value the far side would read `confirmation` as
		// absent and be unable to tell "old incumbent" from "opengrep was cut off".
		touchFile.mockResolvedValue({
			diags: [],
			confirmation: "partial",
			unconfirmedServerIds: ["opengrep"],
		});

		const result = await serve();
		const overTheWire = JSON.parse(
			JSON.stringify(result),
		) as WarmDiagnosticsResponse;

		expect(overTheWire.confirmation).toBe("partial");
		expect(overTheWire.unconfirmedServerIds).toEqual(["opengrep"]);
		// The load-bearing consequence: every existing consumer tests
		// `=== "confirmed"`, so the narrowing fails closed for free.
		expect(overTheWire.confirmation).not.toBe("confirmed");
	});

	it("reads the coverage gap through touchCoverageGap, not off the confirmation string (#1470)", async () => {
		// `touchCoverageGap`'s own doc comment forbids re-deriving the rule from a
		// `confirmation` string literal. The producer sets both fields together
		// today, so a re-derivation passes every other test in this file — this one
		// hands the serve path a touch that names a coverage gap WITHOUT the
		// narrowed string, which is exactly what a second producer (or a widened
		// confirmation vocabulary) would look like. One reader, one rule.
		touchFile.mockResolvedValue({
			diags: [],
			unconfirmedServerIds: ["opengrep"],
		});

		const result = await serve();

		expect(result.confirmation).toBe("partial");
		expect(result.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	// #4645: only the incumbent owns the client that can answer membership;
	// attached readers must receive its demotion without starting another fleet.
	describe("inferred-project authority", () => {
		const file = "C:/repo/orphan.ts";
		const diagnostic = {
			severity: 1,
			message: "Type 'number' is not assignable to type 'string'.",
			source: "typescript",
			code: 2322,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 4 },
			},
		};
		const inferred = {
			executed: true,
			result: {
				success: true,
				body: { configFileName: "/dev/null/inferredProject1*" },
			},
		};

		beforeEach(() => {
			touchFile.mockResolvedValue({
				diags: [diagnostic],
				confirmation: "confirmed",
			});
		});

		it("serializes inferred-project errors as labelled warnings", async () => {
			projectInfo.mockResolvedValue(inferred);

			const result = JSON.parse(
				JSON.stringify(await serve(file)),
			) as WarmDiagnosticsResponse;

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].severity).toBe(2);
			expect(result.diagnostics[0].message).toContain(INFERRED_PROJECT_MARKER);
			expect(result.confirmation).toBe("confirmed");
			expect(result.fresh).toBe(true);
			expect(projectInfo).toHaveBeenCalledExactlyOnceWith(
				file,
				"typescript.tsserverRequest",
				["projectInfo", { file, needFileNameList: false }],
			);
		});

		it("preserves configured-project errors", async () => {
			projectInfo.mockResolvedValue({
				executed: true,
				result: {
					success: true,
					body: { configFileName: "C:/repo/tsconfig.json" },
				},
			});

			expect((await serve(file)).diagnostics).toEqual([diagnostic]);
		});

		it("preserves errors when membership is unavailable", async () => {
			expect((await serve(file)).diagnostics).toEqual([diagnostic]);
		});

		it("does not probe membership for clean diagnostics", async () => {
			touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

			expect((await serve(file)).diagnostics).toEqual([]);
			expect(projectInfo).not.toHaveBeenCalled();
		});

		// #4645 F1 recurrence: the membership probe used to be awaited with no bound
		// but its own 2.5 s leaf timeout, so a slow probe made `servedAt` pass
		// `deadlineAt`. The reply then read `fresh: false`, the client classified it
		// `stale-answer`, and `promoteToLocal` ended warm attach for the session.
		// The probe now shares the request's deadline and the raw rows go out.
		it("never lets a slow membership probe push the reply past the request deadline", async () => {
			await serve(file); // load the lazy service modules before the clock is faked
			vi.useFakeTimers();
			const deadlineAt = Date.now() + 1_000;
			projectInfo.mockImplementation(
				() => new Promise((resolve) => setTimeout(resolve, 4_000, inferred)),
			);

			const { _serveWarmRequestForTests } =
				await import("../../clients/warm-attach.js");
			const pending = _serveWarmRequestForTests(request(file, deadlineAt));
			await vi.advanceTimersByTimeAsync(5_000);
			const served = await pending;
			const result = served.result as WarmDiagnosticsResponse;

			expect(result.fresh).toBe(true);
			expect(result.servedAt).toBeLessThanOrEqual(deadlineAt);
			// No verdict inside the budget: the pre-#4645 answer, never a guess.
			expect(result.diagnostics).toEqual([diagnostic]);
			expect("demotedBlockingIndexes" in result).toBe(false);
		});

		// #4645 F4 recurrence: the incumbent called the inner membership step, so a
		// severity-1 ambient-gap row was consumed by the inferred-project rule and
		// told the operator to add a tsconfig glob, where the local path (the one
		// pipeline, `demoteLanguageServerRows`) says to install dependencies.
		it("gives an ambient-gap row the environment verdict the local path gives", async () => {
			const dir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-gap-")),
			);
			try {
				const gapFile = path.join(dir, "orphan.ts");
				touchFile.mockResolvedValue({
					diags: [
						{
							...diagnostic,
							message: "Cannot find name 'setTimeout'.",
							code: 2304,
						},
					],
					confirmation: "confirmed",
				});
				projectInfo.mockResolvedValue(inferred);

				const [row] = (await serve(gapFile, undefined, dir)).diagnostics;

				expect(row.severity).toBe(2);
				expect(row.message).toContain(ENVIRONMENT_GAP_MARKER);
				expect(row.message).not.toContain(INFERRED_PROJECT_MARKER);
			} finally {
				removeTempDirSync(dir);
			}
		});

		// #4645 F2 recurrence: a demoted row crossed the socket at severity 2, and
		// the attached runner selects code-action rows by severity 1, so the warm
		// session lost the quick fix the local path keeps. The field names the rows.
		it("names the rows it demoted from severity 1 as an enumerable field", async () => {
			const warning = { ...diagnostic, severity: 2, code: 6133 };
			touchFile.mockResolvedValue({
				diags: [warning, diagnostic],
				confirmation: "confirmed",
			});
			projectInfo.mockResolvedValue(inferred);

			const result = JSON.parse(
				JSON.stringify(await serve(file)),
			) as WarmDiagnosticsResponse;

			expect(result.diagnostics.map((d) => d.severity)).toEqual([2, 2]);
			expect(result.demotedBlockingIndexes).toEqual([1]);
		});

		it("omits the field when nothing was demoted (mixed-build safe)", async () => {
			projectInfo.mockResolvedValue({
				executed: true,
				result: {
					success: true,
					body: { configFileName: "C:/repo/tsconfig.json" },
				},
			});

			const result = await serve(file);

			expect("demotedBlockingIndexes" in result).toBe(false);
			expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
				"demotedBlockingIndexes",
			);
		});
	});

	it("survives the JSON round trip the socket actually performs", async () => {
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

		const result = await serve();
		// `startServer` writes `JSON.stringify(await serveRequest(req))` — a
		// non-enumerable side channel would vanish here (the #1179 shape-5 class).
		const overTheWire = JSON.parse(
			JSON.stringify(result),
		) as WarmDiagnosticsResponse;

		expect(overTheWire.confirmation).toBe("confirmed");
		expect(overTheWire.version).toBe(WARM_DIAGNOSTICS_SCHEMA_VERSION);
	});
});
