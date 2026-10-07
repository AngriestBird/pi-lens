/**
 * #3965: the registered `lens_diagnostics` tool documents `paths` as "Files
 * or directories to filter", but on the `source=lsp` route a directory entry
 * reached the per-file collector verbatim — `collectFileDiagnosticResult`
 * rejected it with "not a file" and counted one `failed` outcome, silently
 * dropping the directory's whole subtree (1 "file" checked, 0 findings).
 *
 * These cases drive the production entry (`createLensDiagnosticsTool`, the
 * factory behind both `lens_diagnostics` and `pilens_diagnostics`) on a real
 * on-disk tree. Only the external language-server process is doubled
 * (`makeLspServiceDouble`): the bounded walk, the exclusion rules, the
 * outcome tally, and the widget store are real.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

type ToolResult = {
	isError?: boolean;
	content: { type: string; text: string }[];
	details: {
		mode?: string;
		filesChecked?: number;
		capped?: boolean;
		outcomes?: { file: string; outcome: string }[];
		outcomeCounts?: Record<string, number>;
		directoriesWithoutFiles?: string[];
	};
};

function text(result: ToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

function makeService(findingFiles: string[]) {
	const findings = new Set(findingFiles.map((file) => path.resolve(file)));
	return makeLspServiceDouble({
		// `undefined` is what the real `touchFile` resolves to when it resolves
		// no client; the tool then falls through to `getDiagnostics`, where this
		// double's per-file findings live (the shape
		// tests/tools/lsp-diagnostics.test.ts established for the same reason).
		touchFile: vi.fn(async () => undefined),
		getDiagnostics: vi.fn(async (file: string) =>
			findings.has(path.resolve(file))
				? [
						{
							severity: 1,
							message: `finding in ${path.basename(file)}`,
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
							source: "ts",
						},
					]
				: [],
		),
		getDiagnosticsHealth: vi.fn(() => undefined),
		getCapabilitySnapshots: vi.fn(async () => []),
	});
}

async function runTool(
	service: unknown,
	ws: string,
	params: Record<string, unknown>,
): Promise<ToolResult> {
	const tool = createLensDiagnosticsTool(
		{ readCache: vi.fn(() => undefined) } as any,
		() => ws,
		() => service as any,
	);
	return (await tool.execute("3965", params, undefined, null, {
		cwd: ws,
	})) as unknown as ToolResult;
}

/** Files the batch actually checked, in result order. */
function checkedFiles(result: ToolResult): string[] {
	return (result.details.outcomes ?? []).map((entry) => entry.file);
}

/** Files whose outcome was a real finding. */
function findingFiles(result: ToolResult): string[] {
	return (result.details.outcomes ?? [])
		.filter((entry) => entry.outcome === "findings")
		.map((entry) => entry.file)
		.sort();
}

function writeFindingFiles(ws: string, relativePaths: string[]): string[] {
	return relativePaths.map((relative) => {
		const file = path.join(ws, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "const value: number = 'bad';\n");
		return file;
	});
}

describe("lens_diagnostics source=lsp paths directories (#3965)", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});

	it("expands a directory entry into its eligible files, nested directories included", async () => {
		const env = setupTestEnvironment("pi-lens-3965-dir-");
		const ws = env.tmpDir;
		try {
			const [bad, nestedBad] = writeFindingFiles(ws, [
				"src/bad.ts",
				"src/nested/deep/also-bad.ts",
			]);
			const [sibling] = writeFindingFiles(ws, ["outside.ts"]);
			fs.writeFileSync(path.join(ws, "src", "clean.ts"), "export {};\n");
			const service = makeService([bad, nestedBad, sibling]);

			const result = await runTool(service, ws, {
				source: "lsp",
				mode: "full",
				paths: [path.join(ws, "src")],
				severity: "all",
			});

			expect(result.isError).toBeFalsy();
			expect(result.details.mode).toBe("batch");
			expect(result.details.filesChecked).toBe(3);
			expect(result.details.outcomeCounts?.failed).toBe(0);
			expect(findingFiles(result)).toEqual([bad, nestedBad].sort());
			// A sibling outside the requested directory is not scanned.
			expect(checkedFiles(result)).not.toContain(sibling);
			// The pre-fix under-scan: the directory itself was "checked" and
			// rejected, and its subtree was never reached.
			expect(text(result)).not.toContain("not a file");
			// A full expansion is not a truncation: no cap record.
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "lsp-diagnostics-paths-cap",
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("covers a mix of explicit files and directories", async () => {
		const env = setupTestEnvironment("pi-lens-3965-mix-");
		const ws = env.tmpDir;
		try {
			const [outside, inDir] = writeFindingFiles(ws, [
				"outside.ts",
				"src/in-dir.ts",
			]);
			const service = makeService([outside, inDir]);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [outside, path.join(ws, "src")],
				severity: "all",
			});

			expect(result.details.filesChecked).toBe(2);
			expect(result.details.outcomeCounts?.failed).toBe(0);
			expect(findingFiles(result)).toEqual([inDir, outside].sort());
		} finally {
			env.cleanup();
		}
	});

	it("honors the exclusion rules: a node_modules subtree is never expanded", async () => {
		const env = setupTestEnvironment("pi-lens-3965-excluded-");
		const ws = env.tmpDir;
		try {
			const [app] = writeFindingFiles(ws, ["app/bad.ts"]);
			const [vendored] = writeFindingFiles(ws, ["node_modules/pkg/bad.ts"]);
			const service = makeService([app, vendored]);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [ws],
				severity: "all",
			});

			expect(result.details.outcomeCounts?.failed).toBe(0);
			expect(checkedFiles(result)).toEqual([app]);
			expect(checkedFiles(result)).not.toContain(vendored);

			// Naming the excluded directory ITSELF is the owner's existing rule —
			// the walker never ignore-tests its own root, the same "an explicitly
			// named entry is meant" semantics the scalar `path` route has — so the
			// expansion inherits it instead of re-deriving an exclusion rule here.
			const namedRoot = await runTool(service, ws, {
				source: "lsp",
				paths: [path.join(ws, "node_modules", "pkg")],
				severity: "all",
			});
			expect(checkedFiles(namedRoot)).toEqual([vendored]);
		} finally {
			env.cleanup();
		}
	});

	it("reports a directory with no eligible file as an empty result, not a failure", async () => {
		const env = setupTestEnvironment("pi-lens-3965-empty-");
		const ws = env.tmpDir;
		try {
			const empty = path.join(ws, "empty");
			fs.mkdirSync(empty);
			const service = makeService([]);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [empty],
				severity: "all",
			});

			expect(result.isError).toBeFalsy();
			expect(result.details.filesChecked).toBe(0);
			expect(result.details.outcomes).toBeUndefined();
			expect(text(result)).toContain(
				`No supported source files found in: ${empty}`,
			);
			expect(text(result)).not.toContain("not a file");

			// The list rendering is bounded: at most five directories are named.
			const manyEmpty = Array.from({ length: 6 }, (_, index) => {
				const directory = path.join(ws, `empty-${index}`);
				fs.mkdirSync(directory);
				return directory;
			});
			const bounded = await runTool(service, ws, {
				source: "lsp",
				paths: manyEmpty,
				severity: "all",
			});
			expect(bounded.details.filesChecked).toBe(0);
			expect(bounded.details.directoriesWithoutFiles).toHaveLength(5);
			expect(text(bounded)).toContain("(+1 more)");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a nonexistent entry a failure", async () => {
		const env = setupTestEnvironment("pi-lens-3965-missing-");
		const ws = env.tmpDir;
		try {
			const missing = path.join(ws, "gone.ts");
			const service = makeService([]);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [missing],
				severity: "all",
			});

			expect(result.details.filesChecked).toBe(1);
			expect(result.details.outcomeCounts?.failed).toBe(1);
			expect(text(result)).toContain(`${missing}: path not found`);
		} finally {
			env.cleanup();
		}
	});

	it("caps a directory expansion at the walker's file bound and discloses it", async () => {
		const env = setupTestEnvironment("pi-lens-3965-cap-");
		const ws = env.tmpDir;
		try {
			const big = path.join(ws, "big");
			fs.mkdirSync(big);
			const files: string[] = [];
			for (let i = 0; i < 105; i += 1) {
				const file = path.join(big, `f${String(i).padStart(3, "0")}.ts`);
				fs.writeFileSync(file, "const value: number = 'bad';\n");
				files.push(file);
			}
			const service = makeService(files);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [big],
				severity: "all",
			});

			expect(result.details.filesChecked).toBe(100);
			expect(result.details.capped).toBe(true);
			expect(findingFiles(result)).toHaveLength(100);
			expect(text(result)).toContain("(capped at 100)");
			// The bounded record that makes the truncation observable off-surface,
			// once per workspace (the real ledger, read back).
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "lsp-diagnostics-paths-cap",
				)?.count,
			).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("shares the file bound across explicit files and directories", async () => {
		const env = setupTestEnvironment("pi-lens-3965-budget-");
		const ws = env.tmpDir;
		try {
			// 99 explicit entries + 1 directory entry = the 100-entry cap; the
			// directory's two files can only contribute one, and that truncation
			// must be disclosed rather than silently dropped.
			const explicit: string[] = [];
			for (let i = 0; i < 99; i += 1) {
				const file = path.join(
					ws,
					"explicit",
					`e${String(i).padStart(3, "0")}.ts`,
				);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, "export {};\n");
				explicit.push(file);
			}
			const dir = path.join(ws, "tail");
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "a.ts"), "export {};\n");
			fs.writeFileSync(path.join(dir, "b.ts"), "export {};\n");
			const service = makeService([]);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [...explicit, dir],
				severity: "all",
			});

			expect(result.details.filesChecked).toBe(100);
			expect(result.details.capped).toBe(true);
			expect(
				checkedFiles(result).filter((file) => file.startsWith(dir)),
			).toHaveLength(1);
			expect(text(result)).toContain("(capped at 100)");
		} finally {
			env.cleanup();
		}
	});

	it("returns the same finding set for the scalar path route and a one-element paths list", async () => {
		const env = setupTestEnvironment("pi-lens-3965-parity-");
		const ws = env.tmpDir;
		try {
			const [bad, nestedBad] = writeFindingFiles(ws, [
				"src/bad.ts",
				"src/nested/also-bad.ts",
			]);
			fs.writeFileSync(path.join(ws, "src", "clean.ts"), "export {};\n");
			const service = makeService([bad, nestedBad]);

			const viaPaths = await runTool(service, ws, {
				source: "lsp",
				paths: [path.join(ws, "src")],
				severity: "all",
			});
			const viaScalarPath = await runTool(service, ws, {
				source: "lsp",
				path: path.join(ws, "src"),
				severity: "all",
			});

			expect(checkedFiles(viaPaths).sort()).toEqual(
				checkedFiles(viaScalarPath).sort(),
			);
			expect(findingFiles(viaPaths)).toEqual(findingFiles(viaScalarPath));
		} finally {
			env.cleanup();
		}
	});

	it("keeps explicit duplicate entries and checks an overlapping file once", async () => {
		const env = setupTestEnvironment("pi-lens-3965-overlap-");
		const ws = env.tmpDir;
		try {
			const [bad] = writeFindingFiles(ws, ["src/bad.ts"]);
			fs.writeFileSync(path.join(ws, "src", "clean.ts"), "export {};\n");
			const service = makeService([bad]);

			const duplicates = await runTool(service, ws, {
				source: "lsp",
				paths: [bad, bad],
				severity: "all",
			});
			expect(duplicates.details.filesChecked).toBe(2);

			const overlap = await runTool(service, ws, {
				source: "lsp",
				paths: [path.join(ws, "src"), bad],
				severity: "all",
			});
			expect(overlap.details.filesChecked).toBe(2);
			expect(overlap.details.outcomeCounts?.failed).toBe(0);
			expect(checkedFiles(overlap).filter((file) => file === bad)).toHaveLength(
				1,
			);
			expect(findingFiles(overlap)).toEqual([bad]);
		} finally {
			env.cleanup();
		}
	});

	it("expands a directory through the non-TypeScript family's extensions", async () => {
		const env = setupTestEnvironment("pi-lens-3965-python-");
		const ws = env.tmpDir;
		try {
			const py = path.join(ws, "py", "mod.py");
			fs.mkdirSync(path.dirname(py), { recursive: true });
			fs.writeFileSync(py, "x: int = 'bad'\n");
			const service = makeService([py]);

			const result = await runTool(service, ws, {
				source: "lsp",
				paths: [path.join(ws, "py")],
				severity: "all",
			});

			expect(result.details.filesChecked).toBe(1);
			expect(findingFiles(result)).toEqual([py]);
		} finally {
			env.cleanup();
		}
	});
});
