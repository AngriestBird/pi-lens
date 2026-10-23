/**
 * #1645 review F2: the per-edit runner must NOT probe project membership under
 * warm attach.
 *
 * Warm attach means diagnostics came from an already-running remote session over
 * IPC, with no local client for this file. Probing there forces a language-server
 * spawn to answer a render-path question, and the answer belongs to the freshly
 * spawned server rather than the warm session that produced the diagnostics.
 * Both make the probe worse than useless.
 *
 * #4645 split the contract across the pair: the INCUMBENT owns the live client,
 * so it makes the membership verdict (`tests/clients/warm-attach-confirmation.
 * test.ts` pins the producer) and this reader renders what arrives. It passes no
 * `service`, still runs the environment-gap rule, and asks the incumbent for a
 * quick fix on every row the incumbent reports as demoted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";
import { removeTempDirSync } from "../../test-utils.js";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
	attachedDiagnostics: vi.fn(),
	attachedCodeActions: vi.fn(),
}));

vi.mock("../../../../clients/warm-attach.js", () => ({
	isWarmAttached: () => true,
	tryWarmAttachedDiagnostics: (...args: unknown[]) =>
		mocked.attachedDiagnostics(...args),
	tryWarmAttachedCodeActions: (...args: unknown[]) =>
		mocked.attachedCodeActions(...args),
}));

import lspRunner from "../../../../clients/dispatch/runners/lsp.js";
import { ENVIRONMENT_GAP_MARKER } from "../../../../clients/lsp/environment-gap.js";
import { installLspService } from "../../../support/lsp-service-seam.js";

const INFERRED_BODY = { configFileName: "/dev/null/inferredProject1*" };

function makeService() {
	return makeLspServiceDouble({
		executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		})),
		executeCommand: vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		})),
		getAdvertisedCommands: vi.fn(async () => ["typescript.tsserverRequest"]),
		supportsLSP: vi.fn(() => true),
		codeAction: vi.fn(async () => []),
	});
}

/** The seven ambient-declaration gaps the reported session actually got. */
const ENVIRONMENT_GAP_ROWS = [
	"Cannot find module 'node:crypto' or its corresponding type declarations.",
	"Cannot find namespace 'NodeJS'.",
	"Cannot find name 'setTimeout'.",
	"Cannot find name 'clearTimeout'.",
	"Cannot find name 'setInterval'.",
	"Cannot find name 'clearInterval'.",
].map((message, index) => ({
	severity: 1,
	message,
	code: message.startsWith("Cannot find module")
		? 2307
		: message.startsWith("Cannot find namespace")
			? 2503
			: 2304,
	range: {
		start: { line: index, character: 0 },
		end: { line: index, character: 24 },
	},
	source: "ts",
	serverId: "typescript",
}));

describe("LSP dispatch runner — warm attach reader (#1645 F2, #4645)", () => {
	let cwd: string;

	beforeEach(() => {
		mocked.attachedDiagnostics.mockReset();
		mocked.attachedCodeActions.mockReset();
		mocked.attachedCodeActions.mockResolvedValue({ available: false });
		mocked.service = installLspService(makeService());
		cwd = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-attach-")),
		);
	});

	afterEach(() => {
		removeTempDirSync(cwd);
	});

	it("never probes project membership on the warm-attach path", async () => {
		const file = path.join(cwd, "orphan.test.ts");
		fs.writeFileSync(file, "describe('x', () => {});\n");
		mocked.attachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				diagnostics: [
					{
						severity: 1,
						message: "Cannot find name 'describe'.",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 8 },
						},
						source: "typescript",
						code: 2582,
					},
				],
			},
		});

		const result = await lspRunner.run({
			filePath: file,
			cwd,
			fileRole: "test",
			pi: { getFlag: () => undefined },
		} as never);

		// The finding still renders at the authority the incumbent sent…
		expect(result.diagnostics.length).toBeGreaterThan(0);
		// …but not one byte of probe traffic was spent to decide that.
		const service = mocked.service as ReturnType<typeof makeService>;
		expect(service.executeReadOnlyCommandOnLiveClient).not.toHaveBeenCalled();
		expect(service.executeCommand).not.toHaveBeenCalled();
		expect(service.getAdvertisedCommands).not.toHaveBeenCalled();
	});

	// #4532 round 4 (M2): the environment-gap demotion used to inherit #1645
	// F2's reason as well, and kept the reported `🔴 STOP` on this route while
	// the per-edit route was fixed. It asks ONE filesystem question about the
	// file's own directory — no server, no probe — so it holds here too and only
	// the membership probe stays gated.
	it("still demotes an ambient-declaration gap on the warm-attach path (#4532)", async () => {
		const file = path.join(cwd, "orphan.ts");
		fs.writeFileSync(file, "export const x = 1;\n");
		mocked.attachedDiagnostics.mockResolvedValue({
			available: true,
			response: { diagnostics: ENVIRONMENT_GAP_ROWS },
		});

		const result = await lspRunner.run({
			filePath: file,
			cwd,
			fileRole: "source",
			pi: { getFlag: () => undefined },
		} as never);

		// The gap is labelled and never blocking — the same verdict the per-edit
		// route gives the same rows.
		expect(result.semantic).toBe("warning");
		expect(result.diagnostics).toHaveLength(ENVIRONMENT_GAP_ROWS.length);
		expect(
			result.diagnostics.every((item) => item.semantic === "warning"),
		).toBe(true);
		expect(
			result.diagnostics.filter((item) =>
				item.message.includes(ENVIRONMENT_GAP_MARKER),
			),
		).toHaveLength(ENVIRONMENT_GAP_ROWS.length);
		// …and the membership probe is still skipped on this path.
		const service = mocked.service as ReturnType<typeof makeService>;
		expect(service.executeReadOnlyCommandOnLiveClient).not.toHaveBeenCalled();
	});

	// #4645 F2 recurrence: the incumbent now sends a demoted row at severity 2 and
	// this reader selected code-action rows by severity 1 alone, so an attached
	// session asked for no quick fix where the local path asks for one. The
	// incumbent names the rows it demoted; an older incumbent omits the field.
	describe("quick fixes for rows the incumbent demoted", () => {
		const demotedRow = {
			severity: 2,
			message: "Type 'number' is not assignable to type 'string'.",
			range: {
				start: { line: 3, character: 2 },
				end: { line: 3, character: 9 },
			},
			source: "typescript",
			code: 2322,
		};
		const warningRow = {
			...demotedRow,
			code: 6133,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 4 },
			},
		};
		let file: string;

		beforeEach(() => {
			file = path.join(cwd, "orphan.ts");
			fs.writeFileSync(file, "export const x: string = 1;\n");
		});

		async function run() {
			return lspRunner.run({
				filePath: file,
				cwd,
				fileRole: "source",
				pi: { getFlag: () => undefined },
			} as never);
		}

		it("requests a code action for a demoted row and attaches the suggestion", async () => {
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [warningRow, demotedRow],
					demotedBlockingIndexes: [1],
				},
			});
			mocked.attachedCodeActions.mockResolvedValue({
				available: true,
				response: {
					actions: [[{ title: "Change type to string", kind: "quickfix" }]],
				},
			});

			const result = await run();

			// Only the demoted row is asked about; the plain warning is not.
			expect(mocked.attachedCodeActions.mock.calls[0]?.[2]).toEqual([
				{ start: demotedRow.range.start, end: demotedRow.range.end },
			]);
			expect(
				result.diagnostics.find((d) => d.line === 4)?.fixSuggestion,
			).toContain("Change type to string");
		});

		it("asks for nothing from an older incumbent that omits the field", async () => {
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: { diagnostics: [warningRow, demotedRow] },
			});

			await run();

			expect(mocked.attachedCodeActions.mock.calls[0]?.[2]).toEqual([]);
		});

		it("ignores an index that names no row", async () => {
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [warningRow],
					demotedBlockingIndexes: [7, -1],
				},
			});

			await run();

			expect(mocked.attachedCodeActions.mock.calls[0]?.[2]).toEqual([]);
		});
	});
});
