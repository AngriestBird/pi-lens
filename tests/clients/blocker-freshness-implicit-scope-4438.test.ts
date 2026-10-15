/**
 * #4438: the inline-blocker freshness sweep judged an LSP blocker by its own
 * file and its static imports only, so a fix that landed in a file F depends
 * on with no import statement left the blocker authoritative. The #4430
 * review drove the production sweep with a real RuntimeCoordinator and kept
 * three of four blockers after their fixes landed: a Go package peer, an
 * ambient `.d.ts` and a dynamic-import target.
 *
 * The sweep now asks the diagnostics cache's implicit scope
 * (`clients/lsp/implicit-scope.ts`): the Go package clock for a Go file, the
 * mutation receipts whose file feeds the global scope for a JS/TS file, and
 * the import query also captures `import("x")` and `require("x")`.
 *
 * Every case runs the production sweep, its default resolver (real
 * tree-sitter) and a real RuntimeCoordinator. Red on base ff67dd428.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepInlineBlockerFreshness } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string, files: Record<string, string>): string {
	const env = setupTestEnvironment(`pi-lens-blocker-implicit-${prefix}-`);
	cleanups.push(env.cleanup);
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(env.tmpDir, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return env.tmpDir;
}

/** A later write: one minute past every baseline, clear of the tolerance. */
function later(target: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(target, future, future);
}

/**
 * Record a blocker through the production seam with the content baseline the
 * pipeline captures, so the own file is judged by its bytes.
 */
function block(
	runtime: RuntimeCoordinator,
	filePath: string,
	sources: readonly string[] = ["lsp"],
	recordedAtMs?: number,
): void {
	const content = fs.readFileSync(filePath);
	const at = runtime.recordInlineBlockers(
		filePath,
		"🔴 L1: probe blocker",
		1,
		sources,
		undefined,
		{
			size: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		},
		undefined,
		undefined,
		recordedAtMs,
	);
	if (at === undefined) throw new Error("record superseded");
}

function stale(runtime: RuntimeCoordinator): boolean | undefined {
	return runtime.getInlineBlockersSnapshot()[0]?.stale;
}

describe("inline-blocker sweep: Go package peers (#4438)", () => {
	it("demotes a Go blocker when a package peer is edited", async () => {
		const dir = project("go-edit", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Z = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"));
		fs.writeFileSync(path.join(dir, "b.go"), "package p\n\nconst Y = 1\n");
		later(path.join(dir, "b.go"));

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a Go blocker when a package peer is created", async () => {
		const dir = project("go-create", { "a.go": "package p\n\nvar X = Y\n" });
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"));
		fs.writeFileSync(path.join(dir, "c.go"), "package p\n\nconst Y = 1\n");
		later(path.join(dir, "c.go"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a Go blocker when a package peer is deleted", async () => {
		const dir = project("go-delete", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Y = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"));
		fs.rmSync(path.join(dir, "b.go"));
		// The deletion's only trace is the directory's mtime.
		later(dir);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	// Recurrence the package check would add: the own file's mtime is in the
	// package's, so a `touch` of the blocker's own Go file would demote a
	// verdict whose bytes the content axis just confirmed unchanged.
	it("keeps a Go blocker when only its own file is touched", async () => {
		const dir = project("go-touch", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Z = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"));
		later(path.join(dir, "a.go"));

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	it("keeps a Go blocker when a Go file in another package is edited", async () => {
		const dir = project("go-other", {
			"p/a.go": "package p\n\nvar X = 1\n",
			"q/b.go": "package q\n\nconst Y = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "p", "a.go"));
		later(path.join(dir, "q", "b.go"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a tree-sitter blocker on a Go file when a peer is edited", async () => {
		const dir = project("go-self-axis", {
			"a.go": "package p\n\nvar X = 1\n",
			"b.go": "package p\n\nconst Y = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["tree-sitter"]);
		later(path.join(dir, "b.go"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});
});

describe("inline-blocker sweep: ambient files (#4438)", () => {
	const verdictAgo = (): number => Date.now() - 10_000;

	it("demotes a JS/TS blocker when an ambient declaration file is written after it", async () => {
		const dir = project("ambient-create", {
			"use.ts": "export const u: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.d.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-write" });

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a JS/TS blocker when a global script is edited after it", async () => {
		const dir = project("ambient-edit", {
			"use.ts": "export const u: number = FOO;\n",
			"globals.ts": "declare const BAR: number;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-edit" });

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	it("keeps a JS/TS blocker when the file written after it is a module", async () => {
		const dir = project("ambient-module", {
			"use.ts": "export const u: number = FOO;\n",
			"mod.ts": "export const m = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "mod.ts"),
			source: "agent-edit",
		});

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a JS/TS blocker recorded after the ambient write", async () => {
		const dir = project("ambient-older", {
			"use.ts": "export const u: number = FOO;\n",
			"globals.d.ts": "declare const FOO: number;\n",
		});
		const runtime = new RuntimeCoordinator();
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.d.ts"),
			source: "agent-write",
		});
		block(runtime, path.join(dir, "use.ts"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a Python blocker when an ambient file is written after it", async () => {
		const dir = project("ambient-python", {
			"app.py": "x = FOO\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "app.py"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.d.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-write" });

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// The bound on the per-turn parse work: the receipts are read newest first,
	// and past the budget an older receipt is not read, so the blocker is left
	// as it is and the sweep counts the cut.
	it("leaves a blocker alone and counts the cut once the parse budget is spent", async () => {
		const files: Record<string, string> = {
			"use.ts": "export const u: number = FOO;\n",
			"globals.ts": "declare const FOO: number;\n",
		};
		for (let i = 0; i < 40; i++) {
			files[`m${i}.ts`] = `export const m${i} = 1;\n`;
		}
		const dir = project("ambient-budget", files);
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.ts"),
			source: "agent-edit",
		});
		for (let i = 0; i < 40; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, `m${i}.ts`),
				source: "agent-edit",
			});
		}

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.truncatedImports).toBe(1);
	});

	// The receipt ring is bounded; a receipt it evicted may be the fix, so a
	// window with evictions after the verdict is counted, not read as clean.
	it("counts the cut when the receipt ring evicted receipts after the verdict", async () => {
		const dir = project("ambient-evicted", {
			"use.ts": "export const u: number = FOO;\n",
			"globals.d.ts": "declare const FOO: number;\n",
			"notes.md": "notes\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.d.ts"),
			source: "agent-write",
		});
		for (let i = 0; i < 512; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, "notes.md"),
				source: "agent-edit",
			});
		}
		expect(runtime.droppedMutationReceiptCount).toBe(1);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.truncatedImports).toBe(1);
	});
});

describe("inline-blocker sweep: dynamic imports (#4438)", () => {
	it("demotes a blocker when a dynamic-import target is edited", async () => {
		const dir = project("dyn-edit", {
			"use.ts": 'export const f = () => import("./dyn");\n',
			"dyn.ts": "export const d = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"));
		later(path.join(dir, "dyn.ts"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a blocker when a dynamic-import target is created", async () => {
		const dir = project("dyn-create", {
			"use.ts": 'export const f = () => import("./dyn");\n',
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"));
		fs.writeFileSync(path.join(dir, "dyn.ts"), "export const d = 1;\n");
		later(path.join(dir, "dyn.ts"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	it("demotes a blocker when a require target is edited", async () => {
		const dir = project("require-edit", {
			"use.js": 'const r = require("./req");\nmodule.exports = r;\n',
			"req.js": "module.exports = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.js"));
		later(path.join(dir, "req.js"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});
});
