import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph, saveCallGraph } from "../../clients/call-graph.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { moduleReport, renderCompactModuleReport } from "../../clients/module-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	extractSymbolsAndRefsFromGraph,
	getCachedReviewGraph,
	getReviewGraphCacheIdentity,
} from "../../clients/review-graph/builder.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

const FIXTURE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures/call-graph",
);

interface FixtureCase {
	directory: string;
	target: string;
	callerFile: string;
	caller: string;
	callee: string;
	callerLine: number;
	calleeLine: number;
}

// These are committed, multi-file fixtures. The test copies them to an isolated
// project only so the production graph builder can treat them as a workspace.
const CALL_FIXTURES: FixtureCase[] = [
	{
		directory: "typescript",
		target: "callee.ts",
		callerFile: "caller.ts",
		caller: "caller",
		callee: "helper",
		callerLine: 3,
		calleeLine: 1,
	},
	{
		directory: "tsx",
		target: "callee.tsx",
		callerFile: "caller.tsx",
		caller: "caller",
		callee: "helper",
		callerLine: 3,
		calleeLine: 1,
	},
	{
		directory: "javascript",
		target: "callee.js",
		callerFile: "caller.cjs",
		caller: "caller",
		callee: "helper",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		directory: "python",
		target: "callee.py",
		callerFile: "caller.py",
		caller: "caller",
		callee: "helper",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		directory: "go",
		target: "callee.go",
		callerFile: "caller.go",
		caller: "caller",
		callee: "helper",
		callerLine: 3,
		calleeLine: 3,
	},
	{
		directory: "rust",
		target: "callee.rs",
		callerFile: "caller.rs",
		caller: "caller",
		callee: "helper",
		callerLine: 1,
		calleeLine: 1,
	},
];

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
});

function makeFixtureProject(directory: string) {
	const env = setupTestEnvironment(`pi-lens-module-call-graph-${directory}-`);
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	const project = path.join(env.tmpDir, "project");
	fs.cpSync(path.join(FIXTURE_ROOT, directory), project, { recursive: true });
	cleanups.push(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	});
	const targetByDirectory: Record<string, string> = {
		typescript: "callee.ts",
		tsx: "callee.tsx",
		javascript: "callee.js",
		python: "callee.py",
		go: "callee.go",
		rust: "callee.rs",
		java: "Callee.java",
		kotlin: "Callee.kt",
	};
	return {
		project,
		target: path.join(project, targetByDirectory[directory] ?? "callee.ts"),
	};
}

/** Build the canonical graph, then the production derived projection seam. */
async function warmCallGraph(cwd: string) {
	const reviewGraph = await buildOrUpdateGraph(cwd, [], new FactStore());
	const identity = getReviewGraphCacheIdentity(cwd, reviewGraph);
	expect(identity).toBeDefined();
	const extracted = extractSymbolsAndRefsFromGraph(reviewGraph);
	const callGraph = buildCallGraph(
		extracted.allSymbols,
		extracted.allRefs,
		extracted.coverage,
	);
	saveCallGraph(cwd, callGraph, {
		reviewGraphVersion: identity!.version,
		reviewGraphSignature: identity!.signature,
	});
	return { reviewGraph, callGraph };
}

describe("module_report derived callGraph (#1073)", () => {
	for (const fixture of CALL_FIXTURES) {
		it(`exposes production callers/callees with identity and source locations for ${fixture.directory}`, async () => {
			const env = makeFixtureProject(fixture.directory);
			const { reviewGraph } = await warmCallGraph(env.project);
			const report = await moduleReport(fixture.target, env.project, {
				callGraph: true,
			});

			expect(report.callGraph).toMatchObject({
				available: true,
				truncated: false,
				coverage: { status: "complete", complete: true },
			});
			const caller = report.callGraph!.callers.find(
				(entry) => entry.symbol === fixture.caller,
			);
			expect(caller).toMatchObject({
				file: fixture.callerFile,
				symbol: fixture.caller,
				kind: "function",
				line: fixture.callerLine,
			});
			expect(caller?.symbolId).toBe(
				`${normalizeMapKey(path.join(env.project, fixture.callerFile))}:${fixture.caller}:function:${fixture.callerLine}`,
			);
			expect(caller?.targetSymbolId).toBe(
				`${normalizeMapKey(path.join(env.project, path.basename(fixture.target)))}:${fixture.callee}:function:${fixture.calleeLine}`,
			);
			const calleeReport = await moduleReport(
				path.join(env.project, fixture.callerFile),
				env.project,
				{ callGraph: true },
			);
			const callee = calleeReport.callGraph!.callees.find(
				(entry) => entry.symbol === fixture.callee,
			);
			expect(callee).toMatchObject({
				file: path.basename(fixture.target),
				symbol: fixture.callee,
				kind: "function",
				line: fixture.calleeLine,
			});
			expect(callee?.symbolId).toBe(
				`${normalizeMapKey(path.join(env.project, path.basename(fixture.target)))}:${fixture.callee}:function:${fixture.calleeLine}`,
			);
			expect(callee?.targetSymbolId).toBe(
				`${normalizeMapKey(path.join(env.project, fixture.callerFile))}:${fixture.caller}:function:${fixture.callerLine}`,
			);
			expect(calleeReport.graphBuiltAt).toBe(reviewGraph.builtAt);
		});
	}

	it("keeps callers/callees bounded and preserves usedBy separately", async () => {
		const env = makeFixtureProject("javascript");
		await warmCallGraph(env.project);
		const report = await moduleReport(path.join(env.project, "callee.js"), env.project, {
			callGraph: true,
			maxCallGraphEntries: 2,
		});

		expect(report.callGraph?.callers.length).toBeLessThanOrEqual(2);
		expect(report.callGraph?.callees).toHaveLength(0);
		expect(report.callGraph?.truncated).toBe(true);
		expect(report.callGraph?.coverage.totalEvidence).toBeGreaterThanOrEqual(4);
		// usedBy remains the import/reference surface, not a replacement for
		// callers/callees. It has the reference shape and no call-graph identity.
		const helper = report.api.find((entry) => entry.name === "helper");
		expect(helper?.usedBy?.length).toBeGreaterThan(0);
		expect(
			helper?.usedBy?.every((entry) => !("targetSymbolId" in entry)),
		).toBe(true);
		expect(report.provenance?.callGraph).toBe("cached-call-graph");
	});

	it("preserves the call section in summary and compact views", async () => {
		const env = makeFixtureProject("typescript");
		await warmCallGraph(env.project);

		const summary = await moduleReport(env.target, env.project, {
			callGraph: true,
			view: "summary",
		});
		expect(summary.callGraph).toMatchObject({ available: true, truncated: false });
		expect(summary.api[0]?.usedBy).toBeUndefined();
		expect(summary.callbacks).toHaveLength(0);

		const compact = await moduleReport(env.target, env.project, {
			callGraph: true,
			view: "compact",
		});
		const rendered = renderCompactModuleReport(compact);
		expect(rendered).toContain("CALL GRAPH:");
		expect(rendered).toContain("callers: 1");
		expect(rendered).toContain("coverage: complete");
	});

	it("reports a derived projection as partial without hiding its usable edges", async () => {
		const env = makeFixtureProject("typescript");
		const { reviewGraph, callGraph } = await warmCallGraph(env.project);
		const identity = getReviewGraphCacheIdentity(env.project, reviewGraph)!;
		saveCallGraph(
			env.project,
			{
				...callGraph,
				coverage: { ...callGraph.coverage!, complete: false },
			},
			{
				reviewGraphVersion: identity.version,
				reviewGraphSignature: identity.signature,
			},
		);

		const report = await moduleReport(env.target, env.project, { callGraph: true });
		expect(report.callGraph).toMatchObject({
			available: true,
			coverage: { status: "partial", complete: false },
		});
		expect(report.callGraph?.callers).toHaveLength(1);
	});

	it("keeps Java and Kotlin type-only fixture references out of concrete calls", async () => {
		for (const directory of ["java", "kotlin"]) {
			const env = makeFixtureProject(directory);
			await warmCallGraph(env.project);
			const report = await moduleReport(env.target, env.project, { callGraph: true });

			expect(report.callGraph).toMatchObject({ available: true });
			expect(report.callGraph?.callers).toHaveLength(0);
			expect(report.callGraph?.callees).toHaveLength(0);
			expect(report.callGraph?.coverage.typeOnlyEvidence).toBeGreaterThan(0);
		}
	});

	it("is read-only and honest on a cold cache", async () => {
		const env = makeFixtureProject("typescript");
		const before = getCachedReviewGraph(env.project);
		const report = await moduleReport(env.target, env.project, { callGraph: true });
		const after = getCachedReviewGraph(env.project);

		expect(before).toBeUndefined();
		expect(after).toBeUndefined();
		expect(report.callGraph).toMatchObject({
			available: false,
			reason: "review-graph-missing",
			coverage: { status: "unavailable", complete: false },
		});
		expect(renderCompactModuleReport(report)).toContain("unavailable (review-graph-missing)");
	});

	it("rejects a derived cache with an identity mismatch without hiding the graph", async () => {
		const env = makeFixtureProject("typescript");
		const { reviewGraph, callGraph } = await warmCallGraph(env.project);
		const identity = getReviewGraphCacheIdentity(env.project, reviewGraph)!;
		saveCallGraph(env.project, callGraph, {
			reviewGraphVersion: identity.version,
			reviewGraphSignature: `${identity.signature}-stale`,
		});

		const report = await moduleReport(env.target, env.project, { callGraph: true });
		expect(report.graphBuiltAt).toBe(reviewGraph.builtAt);
		expect(report.callGraph).toMatchObject({
			available: false,
			reason: "stale",
			coverage: { status: "unavailable", complete: false },
		});
	});
});
