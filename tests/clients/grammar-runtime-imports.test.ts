/**
 * #3996: a grammar wasm may import a symbol web-tree-sitter's main module does
 * not export. Loading succeeds (the loader hands the grammar a stub), and the
 * first parse that reaches the call throws `TypeError: resolved is not a
 * function` out of wasm. The tree-sitter-wasms@0.1.13 bash wasm imported
 * `isalpha`; every `[ a == b ]` threw, and the parser stayed dead. This sweep
 * reads each shipped grammar's import section and the runtime's export section
 * and reds on any function import the runtime cannot resolve. It needs no
 * parse, so it covers constructs no fixture thought of.
 *
 * Population: every `*.wasm` in `vendor/grammars/`, the bundled `grammars/` and
 * the lazily fetched `web-tree-sitter/grammars/`, one per name in that order. A grammar absent on this
 * machine (not fetched yet) is not scanned; the floor below keeps an empty
 * population from passing, and the visible count is asserted.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const requireFromRepo = createRequire(import.meta.url);

/**
 * Imports a grammar may name without the runtime exporting them. Each entry is
 * an admission with its reason: the call sits on an assertion or abort path
 * that already ends the parse, so an unresolved stub there changes nothing the
 * runtime was going to do. Reviewed per grammar when a grammar is bumped.
 */
const ADMITTED_UNRESOLVED_IMPORTS: Readonly<Record<string, string>> = {
	__assert_fail: "C assert(): only reached after an invariant already broke",
	abort: "C abort(): the grammar ends the process deliberately",
};

// `WebAssembly` is a runtime global the build's `lib` does not declare.
// SAFETY: every supported Node runtime defines `WebAssembly.Module` with the
// static `imports` / `exports` introspection calls; the cast names only those.
interface WasmModuleHandle {
	readonly compiled?: never;
}
type WasmModuleApi = {
	new (bytes: Uint8Array): WasmModuleHandle;
	imports(
		module: WasmModuleHandle,
	): Array<{ module: string; name: string; kind: string }>;
	exports(module: WasmModuleHandle): Array<{ name: string; kind: string }>;
};
const wasm = (
	globalThis as unknown as { WebAssembly: { Module: WasmModuleApi } }
).WebAssembly;

function runtimeExports(): Set<string> {
	const runtimeDir = path.dirname(requireFromRepo.resolve("web-tree-sitter"));
	const module = new wasm.Module(
		fs.readFileSync(path.join(runtimeDir, "tree-sitter.wasm")),
	);
	return new Set(wasm.Module.exports(module).map((entry) => entry.name));
}

/** One file per grammar name, first directory wins: the order the client
 * resolves them in (`grammarSourceDirs`), so a stale shadowed copy is not
 * scanned in place of the one a parse would load. */
function grammarFiles(): string[] {
	const runtimeDir = path.dirname(requireFromRepo.resolve("web-tree-sitter"));
	const dirs = [
		path.join(repoRoot, "vendor", "grammars"),
		path.join(repoRoot, "grammars"),
		path.join(runtimeDir, "grammars"),
	];
	const byName = new Map<string, string>();
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			if (name.endsWith(".wasm") && !byName.has(name)) {
				byName.set(name, path.join(dir, name));
			}
		}
	}
	return [...byName.values()];
}

/** Function imports from `env` that the runtime does not export. */
function unresolvedImports(file: string, exported: Set<string>): string[] {
	const module = new wasm.Module(fs.readFileSync(file));
	return wasm.Module.imports(module)
		.filter((entry) => entry.kind === "function" && entry.module === "env")
		.map((entry) => entry.name)
		.filter((name) => !exported.has(name) && !exported.has(`_${name}`));
}

describe("shipped grammars import only symbols the runtime exports (#3996)", () => {
	const exported = runtimeExports();
	const files = grammarFiles();

	it("scans a non-empty grammar population including bash", () => {
		// Recurrence: a sweep over an empty directory passes vacuously.
		assertNonEmptyScan("shipped grammar wasm files", files.length, 12);
		expect(files.map((file) => path.basename(file))).toContain(
			"tree-sitter-bash.wasm",
		);
	});

	it("resolves every function import of every grammar, or admits it with a reason", () => {
		// Recurrence: #3996, tree-sitter-wasms@0.1.13 bash wasm importing
		// `isalpha`, which web-tree-sitter 0.25 does not export.
		const offenders = files.flatMap((file) =>
			unresolvedImports(file, exported)
				.filter((name) => !(name in ADMITTED_UNRESOLVED_IMPORTS))
				.map((name) => `${path.basename(file)} imports ${name}`),
		);

		expect(offenders).toEqual([]);
	});
});
