import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import { _resetSharedTreeSitterClientForTests } from "../../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "../test-utils.js";

// #1935: `scanAstGrepFile` (scanner.ts) parses through ast-grep-napi's own
// `lang.parse()`, a separate native engine from `TreeSitterClient`'s WASM
// `TreeCache`. A cache_stats record for the `project_diagnostics_ast_grep_scan`
// scope can never carry a real signal — it reads all-zero no matter what the
// scan does — so the scanner must never emit one. Wrap the real logger (not a
// bare `vi.fn()`) so this test proves the SCOPE the scanner emits, not just
// that logging happened.
const calls = vi.hoisted(() => [] as Array<{ scope: string }>);

vi.mock("../../../clients/tree-sitter-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/tree-sitter-logger.js")
		>();
	return {
		...actual,
		logTreeSitterCacheStats: (
			options: Parameters<typeof actual.logTreeSitterCacheStats>[0],
		) => {
			calls.push({ scope: options.scope });
			return actual.logTreeSitterCacheStats(options);
		},
	};
});

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-castscope-"));
	calls.length = 0;
});

afterEach(() => {
	removeTempDirSync(tmp);
	_resetSharedTreeSitterClientForTests();
});

describe("scanProjectDiagnostics cache_stats scopes (#1935)", () => {
	it("never emits a cache_stats record for the ast-grep scope, which never touches the tree cache", async () => {
		fs.writeFileSync(path.join(tmp, "a.ts"), "export const v = 1;\n");

		await scanProjectDiagnostics({ cwd: tmp, tier: "all" });

		const scopes = calls.map((c) => c.scope);
		// The real, informative record still fires.
		expect(scopes).toContain("project_diagnostics_scan");
		// The vacuous, always-zero record must not.
		expect(scopes).not.toContain("project_diagnostics_ast_grep_scan");
	}, 30000);
});
