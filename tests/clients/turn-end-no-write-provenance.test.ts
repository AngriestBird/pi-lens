// flake-shape: service-double — the late-auxiliary cell: a real auxiliary client is an external child process, so the LSP service seam answers its cached publication (#4617)
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recordDeliveredCascadeNeighbor,
	resetCascadePendingNeighbors,
	resetCascadeUnansweredPrimariesDelivered,
} from "../../clients/cascade-format.js";
import { MAX_ADVISORY_AFFECTED_FILES } from "../../clients/advisory-provenance.js";
import type { CascadeRun } from "../../clients/cascade-types.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	markPendingAuxiliaryCoverage,
	resetPendingAuxiliaryCoverage,
} from "../../clients/lsp/pending-aux-coverage.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { runTurnScenario } from "../support/turn-harness.js";

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());

// Recurrence (#4617): the turn-end advisory of a turn that wrote no file
// carried no provenance stamp the gate could read, so findings captured in
// the current turn reached the model labelled "Historical finding; workspace
// changed since capture". A bash-only turn is about 85% of a session.
const HISTORICAL = "Historical finding";
const UNKNOWN_STAMP = "generation unknown";

beforeEach(async () => {
	await installLspServiceDouble({
		readCachedDiagnosticsForServers,
		observeLateAuxiliaryAnswer: async () => undefined,
	});
	readCachedDiagnosticsForServers.mockReset();
});

afterEach(() => {
	resetCascadePendingNeighbors();
	resetCascadeUnansweredPrimariesDelivered();
	resetPendingAuxiliaryCoverage();
});

function neighborError(filePath: string): Diagnostic {
	return {
		id: "lsp:cascade:1",
		message: "type mismatch",
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "cascade:test",
	};
}

/** A cascade run no section renders: the trigger that lets a bash-only turn
 *  reach the composer without citing any file itself. */
function silentRun(filePath: string): CascadeRun {
	return {
		filePath,
		result: undefined,
		neighborCount: 0,
		diagnosticCount: 0,
		skipReason: "clean",
	};
}

function indeterminateRun(filePath: string): CascadeRun {
	return {
		filePath,
		result: undefined,
		neighborCount: 0,
		diagnosticCount: 0,
		skipReason: "indeterminate",
		indeterminate: {
			reason: "graph_degraded",
			detail: "review graph unavailable",
		},
	};
}

describe.each([false, true])(
	"bash-only turn provenance, --lens-guard %s (#4617)",
	(guard) => {
		const flags = { "lens-guard": guard };

		it("keeps a confirmed-clean resolution current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-clean-${guard}`,
				incident:
					"Live turn-end findings received the historical-provenance preamble",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					expect(
						h.runtime.retireInlineBlockerOnConfirmedClean(
							file,
							h.runtime.nextWriteOrderToken(),
							["lsp"],
						),
					).toBe(true);
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("confirmed clean");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a cascade coverage advisory current (indeterminate run)", async () => {
			await runTurnScenario({
				id: `no-write-provenance-indeterminate-${guard}`,
				incident: "A coverage advisory cites no edited file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(indeterminateRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps an unconfirmed-neighbour advisory current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unconfirmed-${guard}`,
				incident: "A coverage advisory cites no edited file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: undefined,
						neighborCount: 1,
						diagnosticCount: 0,
						unconfirmed: {
							count: 1,
							servers: [{ serverId: "ts", waitMs: 500, paths: [neighbor] }],
						},
					});
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("no answer arrived");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps an unanswered-primary line beside a clean neighbour current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unanswered-${guard}`,
				incident: "A cascade section with no neighbour error to cite",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: {
							filePath: primary,
							impact: {
								filePath: primary,
								changedSymbols: [],
								directImporters: [neighbor],
								directCallers: [],
								neighborFiles: [neighbor],
								riskFlags: [],
							},
							neighbors: [
								{
									filePath: neighbor,
									reason: "imports",
									lspTouched: false,
									diagnostics: [],
								},
							],
							formatted: "No language server answered for a.ts",
							unansweredPrimaries: {
								notes: [
									{
										serverIds: ["pyrefly"],
										line: "No language server answered for a.ts",
									},
								],
								formattedWithoutNotes: "",
							},
						},
						neighborCount: 1,
						diagnosticCount: 0,
					});
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("No language server answered");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a pending-neighbour line current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-pending-${guard}`,
				incident:
					"The pending-error lines name a neighbour, not an edited file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					recordDeliveredCascadeNeighbor(
						neighbor,
						[neighborError(neighbor)],
						1,
						Date.now() + 60_000,
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(silentRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("error(s) unresolved");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a late auxiliary finding current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-aux-${guard}`,
				incident: "A late auxiliary part cites a file the turn did not edit",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const auxFile = h.write("src/aux.ts", "export const aux = 1;\n");
					const past = new Date(Date.now() - 10_000);
					fs.utimesSync(auxFile, past, past);
					markPendingAuxiliaryCoverage(
						auxFile,
						["opengrep"],
						Date.now() - 2000,
					);
					readCachedDiagnosticsForServers.mockImplementation(
						async () =>
							new Map([
								[
									"opengrep",
									{
										diags: [
											{
												range: {
													start: { line: 0, character: 0 },
													end: { line: 0, character: 10 },
												},
												severity: 2,
												code: "rule-x",
												source: "opengrep",
												message: "late scanner finding",
											},
										],
										publishedAt: Date.now(),
									},
								],
							]),
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(silentRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("late scanner finding");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Negative cells: the fix must not drop the label. A stamp taken at this
		// turn end still flips to historical once the workspace moves on, or
		// once the session that took it is over.
		it("labels a resolution historical when its file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-older-file-${guard}`,
				incident: "A stamped advisory from an older turn must stay labelled",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					h.runtime.retireInlineBlockerOnConfirmedClean(
						file,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					);
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(file, "export const value = 'changed';\n");
						},
					});
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a coverage advisory historical when its cited file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-older-cited-${guard}`,
				incident: "A stamped advisory from an older turn must stay labelled",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(indeterminateRun(primary));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(primary, "export const a = 2;\n");
						},
					});
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Fail closed on a stamp that cannot name every file the advisory cites
		// (`truncated-provenance`): a partial stamp must not read as current.
		it("labels a coverage advisory historical when it cites more files than a stamp holds", async () => {
			await runTurnScenario({
				id: `no-write-provenance-over-cap-${guard}`,
				incident: "A stamp over the first files of a larger citation set",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbors = Array.from(
						{ length: MAX_ADVISORY_AFFECTED_FILES },
						(_, i) => h.write(`src/n${i}.ts`, `export const n${i} = 1;\n`),
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: undefined,
						neighborCount: neighbors.length,
						diagnosticCount: 0,
						unconfirmed: {
							count: neighbors.length,
							servers: [{ serverId: "ts", waitMs: 500, paths: neighbors }],
						},
					});
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("no answer arrived");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The turn's own edited-file list is capped before the stamp sees it, so
		// the stamp must carry that loss forward (`affectedFilesTruncated`).
		it("labels a write turn historical when its edited files exceed the stamp cap", async () => {
			await runTurnScenario({
				id: `no-write-provenance-edited-over-cap-${guard}`,
				incident: "A stamp over the first files of a larger edit set",
				issue: "#4617",
				async run(h) {
					for (let i = 0; i <= MAX_ADVISORY_AFFECTED_FILES; i += 1) {
						h.edit(`src/e${i}.ts`, `export const e${i} = 1;\n`);
					}
					h.blocker("src/e0.ts", "L1: type mismatch");
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("type mismatch");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a resolution historical when the stamping session is over", async () => {
			await runTurnScenario({
				id: `no-write-provenance-older-session-${guard}`,
				incident: "A stamped advisory from an older session must stay labelled",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					h.runtime.retireInlineBlockerOnConfirmedClean(
						file,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					);
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							h.runtime.setTelemetryIdentity({ sessionId: "a-later-session" });
						},
					});
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});
	},
);
