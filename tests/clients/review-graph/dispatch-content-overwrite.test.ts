/**
 * #3552: the shared dispatch FactStore lets a concurrent same-file content read
 * overwrite `file.content` between the review graph's content read and its
 * import/function provider reads, so the graph extracts structural facts from
 * bytes other than the ones it hashed.
 *
 * The gate is the graph's own tier-3 `readFileSync`: once it returns the read
 * bytes, the test starts a real concurrent dispatch fact-derivation run for the
 * same file presenting different bytes. `clearFileFactsFor` + `runProviders` is
 * the exact fact seam `dispatchLintWithResult` wraps; the second case uses only
 * the synchronous dispatch prefix (the clear) to exercise the import-read
 * window, which a macrotask-bound writer cannot reach.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
	arm: undefined as { file: string; trigger: () => void } | undefined,
	writer: Promise.resolve() as Promise<void>,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
		const out = actual.readFileSync(...args);
		const arm = gate.arm;
		if (arm && String(args[0]) === arm.file) {
			gate.arm = undefined;
			arm.trigger();
		}
		return out;
	}) as typeof actual.readFileSync;
	return { ...actual, readFileSync };
});

import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { createDispatchContext } from "../../../clients/dispatch/dispatcher.js";
import { runProviders } from "../../../clients/dispatch/fact-runner.js";
import "../../../clients/dispatch/integration.js"; // registers providers
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { setupTestEnvironment } from "../test-utils.js";

const V_A =
	'import { alpha } from "./alpha.js";\nexport function beta() { return alpha(); }\n';
const V_B =
	'import { gamma } from "./gamma.js";\nexport function delta() { return gamma(); }\n';

/** Symbol names and import targets the graph recorded for one file. */
function graphFacts(
	graph: Awaited<ReturnType<typeof buildOrUpdateGraph>>,
	file: string,
): { symbolNames: string[]; importTargets: string[] } {
	const normalized = normalizeMapKey(file);
	return {
		symbolNames: [...graph.nodes.values()]
			.filter((node) => node.kind === "symbol" && node.filePath === normalized)
			.map((node) => node.symbolName ?? ""),
		importTargets: graph.edges
			.filter(
				(edge) => edge.from === `file:${normalized}` && edge.kind === "imports",
			)
			.map((edge) => edge.to),
	};
}

describe("review-graph vs concurrent dispatch file.content (#3552)", () => {
	afterEach(() => {
		gate.arm = undefined;
		gate.writer = Promise.resolve();
		clearReviewGraphWorkspaceCache();
	});

	it("keeps imports and functions on one version when a concurrent dispatch replaces file.content mid-parse", async () => {
		const env = setupTestEnvironment("pi-lens-3552-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, V_A);
			const store = new FactStore("3552-parse-race");
			const ctx = createDispatchContext(
				file,
				env.tmpDir,
				{ getFlag: () => false },
				store,
			);
			gate.arm = {
				file: normalizeMapKey(file),
				trigger: () => {
					fs.writeFileSync(file, V_B);
					// A real second dispatch resume: its sync prefix runs now, its
					// async fact derivation lands while the graph is in tree-sitter.
					gate.writer = (async () => {
						store.clearFileFactsFor(ctx.filePath);
						await runProviders(ctx);
						store.endDispatchFor(ctx.filePath);
					})();
				},
			};

			const graph = await buildOrUpdateGraph(env.tmpDir, [file], store);
			await gate.writer;

			expect(gate.arm).toBeUndefined(); // the gate fired
			expect(graphFacts(graph, file)).toEqual({
				symbolNames: ["beta"],
				importTargets: ["module:./alpha.js"],
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps imports when a concurrent dispatch clears file.content before the import read", async () => {
		const env = setupTestEnvironment("pi-lens-3552-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, V_A);
			const store = new FactStore("3552-import-race");
			gate.arm = {
				file: normalizeMapKey(file),
				trigger: () => {
					// The dispatch's synchronous start (clear + pin) resumed as a
					// microtask lands before the graph's dynamic-import continuation.
					queueMicrotask(() => {
						store.clearFileFactsFor(normalizeMapKey(file));
					});
				},
			};

			const graph = await buildOrUpdateGraph(env.tmpDir, [file], store);
			store.endDispatchFor(normalizeMapKey(file));

			expect(gate.arm).toBeUndefined(); // the gate fired
			expect(graphFacts(graph, file)).toEqual({
				symbolNames: ["beta"],
				importTargets: ["module:./alpha.js"],
			});
		} finally {
			env.cleanup();
		}
	});
});
