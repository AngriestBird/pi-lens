/**
 * #3552 round 2: `captureReviewGraphStructuralIr` may reuse a caller store's
 * derived facts as a READ-ONLY borrow, but only when that store's `file.content`
 * is the very bytes being captured. Derived facts computed from other bytes must
 * never enter the captured IR, and the borrowed store must never be written.
 *
 * Recurrence guarded: the round-1 graph read `file.imports` /
 * `file.functionSummaries` back from a store another writer could have replaced
 * (review F3), producing a node with imports from one version and symbols from
 * another; the old `hasFileFact` check alone had no notion of which bytes the
 * facts were derived from. Facts here come from the real dispatch providers
 * (`runProviders`), never hand-built.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDispatchContext } from "../../../clients/dispatch/dispatcher.js";
import { runProviders } from "../../../clients/dispatch/fact-runner.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { FunctionSummary } from "../../../clients/dispatch/facts/function-facts.js";
import "../../../clients/dispatch/integration.js"; // registers providers
import {
	captureReviewGraphStructuralIr,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { setupTestEnvironment } from "../test-utils.js";

const V_A =
	'import { alpha } from "./alpha.js";\nexport function beta() { return alpha(); }\n';
const V_B =
	'import { gamma } from "./gamma.js";\n\nfunction delta() {\n\treturn gamma();\n}\n';

/** A store holding the real dispatch-derived facts for `content`. */
async function storeDerivedFrom(
	file: string,
	cwd: string,
	content: string,
): Promise<FactStore> {
	const store = new FactStore("3552-borrow");
	fs.writeFileSync(file, content);
	const ctx = createDispatchContext(file, cwd, { getFlag: () => false }, store);
	store.clearFileFactsFor(ctx.filePath);
	await runProviders(ctx);
	store.endDispatchFor(ctx.filePath);
	return store;
}

function structuralOf(
	result: Awaited<ReturnType<typeof captureReviewGraphStructuralIr>>,
) {
	expect(result.complete).toBe(true);
	if (result.structural?.kind !== "jsts") throw new Error("no jsts IR");
	return result.structural;
}

describe("captureReviewGraphStructuralIr borrow (#3552)", () => {
	afterEach(() => clearReviewGraphWorkspaceCache());

	it("borrows the store's facts by reference when its file.content is the captured bytes", async () => {
		const env = setupTestEnvironment("pi-lens-3552-borrow-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			const store = await storeDerivedFrom(file, env.tmpDir, V_A);
			const held = store.getFileFact<FunctionSummary[]>(
				file,
				"file.functionSummaries",
			);

			const ir = structuralOf(
				await captureReviewGraphStructuralIr(file, env.tmpDir, V_A, store),
			);

			// Identity, not equality: a recompute would build a new array.
			expect(ir.functionSummaries).toBe(held);
			expect(ir.functionSummaries.map((fn) => fn.name)).toEqual(["beta"]);
		} finally {
			env.cleanup();
		}
	});

	it("does not take facts derived from other bytes, and does not write the borrowed store", async () => {
		const env = setupTestEnvironment("pi-lens-3552-borrow-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			// The store holds the facts a dispatch derived from version B.
			const store = await storeDerivedFrom(file, env.tmpDir, V_B);
			const heldSummaries = store.getFileFact<FunctionSummary[]>(
				file,
				"file.functionSummaries",
			);

			// The caller captures version A.
			const ir = structuralOf(
				await captureReviewGraphStructuralIr(file, env.tmpDir, V_A, store),
			);

			expect(ir.functionSummaries.map((fn) => fn.name)).toEqual(["beta"]);
			expect(ir.imports.map((entry) => entry.source)).toEqual(["./alpha.js"]);
			// Read-only: the borrowed store still holds version B, untouched.
			expect(store.getFileFact<string>(file, "file.content")).toBe(V_B);
			expect(store.getFileFact(file, "file.functionSummaries")).toBe(
				heldSummaries,
			);
		} finally {
			env.cleanup();
		}
	});

	it("derives into a run-local store when the caller's store holds nothing, leaving it empty", async () => {
		const env = setupTestEnvironment("pi-lens-3552-borrow-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, V_A);
			const store = new FactStore("3552-borrow-empty");

			const ir = structuralOf(
				await captureReviewGraphStructuralIr(file, env.tmpDir, V_A, store),
			);

			expect(ir.functionSummaries.map((fn) => fn.name)).toEqual(["beta"]);
			expect(store.hasFileFact(file, "file.content")).toBe(false);
			expect(store.hasFileFact(file, "file.imports")).toBe(false);
			expect(store.hasFileFact(file, "file.functionSummaries")).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
