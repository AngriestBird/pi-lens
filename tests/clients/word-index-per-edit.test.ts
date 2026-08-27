/**
 * #348 phase 2 — the per-edit seam (`computeCascadeForFile`'s `wordIndex`/
 * `fileContent`/`onWordIndexUpdated` options) that updates the warm in-memory
 * word index at the SAME call site as the review-graph rebuild, and the
 * cold-session handoff rule: no index loaded yet ⇒ documented no-op (phase 1's
 * lifecycle/background build owns "cold", never this seam).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewGraph } from "../../clients/review-graph/types.js";
import {
	buildWordIndex,
	WORD_INDEX_MAX_BYTES,
	wordIndexPostingHits,
} from "../../clients/word-index.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { setupTestEnvironment } from "./test-utils.js";

const mocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(() => ({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	})),
	formatImpactCascade: vi.fn(),
	getLSPService: vi.fn(),
}));

vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: mocks.getLSPService,
}));

function emptyGraph(): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

function noNeighbors(filePath: string) {
	return {
		filePath,
		changedSymbols: [],
		directImporters: [],
		directCallers: [],
		neighborFiles: [],
		riskFlags: [],
	};
}

describe("computeCascadeForFile — word-index per-edit seam (#348 phase 2)", () => {
	beforeEach(async () => {
		vi.resetModules();
		mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
		mocks.computeImpactCascade.mockReset().mockImplementation(noNeighbors);
		mocks.computeTransitiveImpact.mockReset().mockReturnValue({
			seedFile: "",
			hits: [],
			truncated: false,
			maxDepthReached: 0,
		});
		mocks.formatImpactCascade.mockReset().mockReturnValue(undefined);
		mocks.getLSPService.mockReset().mockReturnValue({
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			touchFile: vi.fn(),
			getDiagnostics: vi.fn(),
		});
		const { resetDispatchBaselines } =
			await import("../../clients/dispatch/integration.js");
		resetDispatchBaselines();
	}, 30_000);

	it("updates the in-memory index with the edited file's content", async () => {
		const env = setupTestEnvironment("word-index-per-edit-update-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = "export function renderWidget() { return 1; }";
			fs.writeFileSync(filePath, content);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function oldWidget() {}" },
			]);
			expect(wordIndex.postings.has("oldwidget")).toBe(true);
			expect(wordIndex.postings.has("renderwidget")).toBe(false);

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.postings.has("oldwidget")).toBe(false);
			expect(
				wordIndexPostingHits(wordIndex, "renderwidget").some(
					(h) => h.file === filePath,
				),
			).toBe(true);
			expect(onWordIndexUpdated).toHaveBeenCalledWith(wordIndex);
			// The broader runtime.wordIndex -> memory_sample seam remains a remainder:
			// this PR does not fix the dogfood wordIndex:null observation.
		} finally {
			env.cleanup();
		}
	});

	it("cold-session handoff: wordIndex null is a no-op (never synchronously builds)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-cold-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = "export function renderWidget() {}";
			fs.writeFileSync(filePath, content);

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			// wordIndex omitted entirely (undefined), matching a cold session where
			// runtime.wordIndex is still null and nothing is threaded through.
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				onWordIndexUpdated,
			});

			expect(onWordIndexUpdated).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("no-op when the index has no forward map (pre-phase-2 / deserialized-old-shape)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-noforward-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = "export function renderWidget() {}";
			fs.writeFileSync(filePath, content);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function oldWidget() {}" },
			]);
			delete wordIndex.forward; // simulate a pre-phase-2 index shape

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				wordIndex,
				onWordIndexUpdated,
			});

			// Untouched — no incremental update attempted on a forward-index-less index.
			expect(wordIndex.postings.has("oldwidget")).toBe(true);
			expect(onWordIndexUpdated).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("no-op when fileContent is undefined (deleted/unreadable file)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-nocontent-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export function renderWidget() {}");

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function oldWidget() {}" },
			]);
			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				// fileContent intentionally omitted (undefined)
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.postings.has("oldwidget")).toBe(true);
			expect(onWordIndexUpdated).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it(
		"never holds the event loop for the whole replacement (#2067 AC4)",
		{ retry: 2, timeout: 120_000 },
		async () => {
			const env = setupTestEnvironment("word-index-per-edit-occupancy-");
			try {
				// Few distinct tokens, many characters: the yieldable halves (posting
				// scan, tokenization) dominate, and the atomic publish — which cannot
				// yield and never could — stays small, so the measurement is about the
				// occupancy this change owns.
				const body = (tag: string, lines: number) =>
					Array.from(
						{ length: lines },
						() =>
							`export const ${tag}Handler = ${tag}ProjectSnapshotStore.${tag}ResolveDocumentEntry(${tag}RequestContext, ${tag}IndexShard, ${tag}WordPosting);`,
					).join("\n");

				const filePath = path.join(env.tmpDir, "src", "target.ts");
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				// Just under the shared size cap, so the seam replaces rather than drops.
				const content = body("updated", 3_000);
				expect(Buffer.byteLength(content, "utf-8")).toBeLessThan(
					WORD_INDEX_MAX_BYTES,
				);
				fs.writeFileSync(filePath, content);

				// High-document-frequency corpus: the removal half has to walk the
				// posting list of every token the old document carried.
				const wordIndex = buildWordIndex([
					{ path: filePath, content: body("original", 3_000) },
					...Array.from({ length: 400 }, (_, doc) => ({
						path: path.join(env.tmpDir, "src", `peer${doc}.ts`),
						content: body("original", 200),
					})),
				]);

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const maxBlockMs = await measureMaxSyncBlockMs(() =>
					computeCascadeForFile(filePath, env.tmpDir, {
						turnSeq: 1,
						writeSeq: 1,
						fileContent: content,
						wordIndex,
					}),
				);

				// The synchronous variant this seam used to call held the loop for the
				// whole replacement: 40-42 ms on this fixture, against 9-16 ms for the
				// cooperative one, which gives the loop back on its 8 ms budget. The
				// bound sits between them with room for the non-yieldable atomic
				// publish and a loaded CI box.
				expect(maxBlockMs).toBeLessThan(30);
				// Not vacuous: the replacement really happened.
				expect(
					wordIndexPostingHits(wordIndex, "updatedhandler").some(
						(hit) => hit.file === filePath,
					),
				).toBe(true);
				expect(wordIndex.postings.has("originalhandler")).toBe(true);
				expect(
					wordIndexPostingHits(wordIndex, "originalhandler").some(
						(hit) => hit.file === filePath,
					),
				).toBe(false);
			} finally {
				env.cleanup();
			}
		},
	);

	it("removes (not partially indexes) a file over the shared size cap", async () => {
		const env = setupTestEnvironment("word-index-per-edit-oversize-");
		try {
			const filePath = path.join(env.tmpDir, "src", "huge.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const hugeContent = "x".repeat(WORD_INDEX_MAX_BYTES + 1024);
			fs.writeFileSync(filePath, hugeContent);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function smallHuge() {}" },
			]);
			expect(wordIndex.docLengths.has(filePath)).toBe(true);

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: hugeContent,
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.docLengths.has(filePath)).toBe(false);
			expect(wordIndex.forward?.has(filePath)).toBe(false);
			expect(onWordIndexUpdated).toHaveBeenCalledWith(wordIndex);
		} finally {
			env.cleanup();
		}
	});
});
