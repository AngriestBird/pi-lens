import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectInstallDiagnostics,
	formatInstallDiagnostics,
} from "../../clients/install-diagnostics.js";

/**
 * #3409: pi ships as a `bun build --compile` binary, whose runtime cannot
 * resolve a BARE package specifier (MODULE_NOT_FOUND) while an explicit file
 * subpath still resolves. Flipped per test; read lazily inside `resolve`, so it
 * applies to the `createRequire` this module already built at import time.
 */
const compiledHost = vi.hoisted(() => ({ bareSpecifiersThrow: false }));

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: (from: string | URL) => {
			const real = actual.createRequire(from);
			const resolve = ((id: string, options?: { paths?: string[] }) => {
				const bare = !id.startsWith(".") && !path.isAbsolute(id)
					? !(id.startsWith("@") ? id.split("/").slice(1).join("/") : id).includes("/")
					: false;
				if (compiledHost.bareSpecifiersThrow && bare) {
					const err = new Error(`Cannot find module '${id}'`) as Error & {
						code?: string;
					};
					err.code = "MODULE_NOT_FOUND";
					throw err;
				}
				return real.resolve(id, options as never);
			}) as NodeJS.Require["resolve"];
			resolve.paths = (id: string) => real.resolve.paths(id);
			return Object.assign((id: string) => real(id), real, {
				resolve,
			}) as NodeJS.Require;
		},
	};
});

describe("install-diagnostics", () => {
	afterEach(() => {
		compiledHost.bareSpecifiersThrow = false;
	});

	it("collects an environment fingerprint without throwing", () => {
		const d = collectInstallDiagnostics();
		expect(d.piLensVersion).toBeTruthy();
		expect(d.runtime).toMatch(/node|bun/);
		expect(d.platform).toContain("-");
		expect(d.deps.map((x) => x.name)).toContain("typescript");
		// In this repo's flat node_modules everything resolves.
		expect(d.deps.find((x) => x.name === "typescript")?.resolved).toBe(true);
	});

	it("formats a paste-able block with the cause and a report URL", () => {
		const out = formatInstallDiagnostics(
			collectInstallDiagnostics(),
			new Error("ResolveMessage: Cannot find package 'typescript'"),
		);
		expect(out).toContain("pi-lens install diagnostics");
		expect(out).toContain("LOAD ERROR: ResolveMessage");
		expect(out).toContain("runtime:");
		expect(out).toContain("install:");
		expect(out).toMatch(/github\.com\/apmantza\/pi-lens\/issues/);
	});

	it("still finds the bundled grammars when the runtime cannot resolve a bare specifier (#3409)", () => {
		expect(collectInstallDiagnostics().grammars).toBe(true);

		compiledHost.bareSpecifiersThrow = true;

		// The one report a user pastes when the whole long tail of grammars is
		// dead must not claim the grammars are missing on the very host that
		// breaks them: the probe answers through the same web-tree-sitter ladder
		// the client resolves its write dir with.
		expect(collectInstallDiagnostics().grammars).toBe(true);
	});

	it("flags a missing dep as FAIL in the rendered block", () => {
		const diag = collectInstallDiagnostics();
		diag.deps = [
			{
				name: "typescript",
				resolved: false,
				error: "ERR_MODULE_NOT_FOUND ...",
			},
		];
		diag.notes = ["unresolved deps note"];
		const out = formatInstallDiagnostics(diag);
		expect(out).toContain("FAIL typescript");
		expect(out).toContain("note: unresolved deps note");
	});
});
