import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStaleDistFiles } from "../../scripts/pre-push-targeted-tests.mjs";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = os.tmpdir();
	const unique = path.join(
		root,
		`pi-lens-dist-freshness-${Date.now()}-${Math.random()}`,
	);
	mkdirSync(path.join(unique, "clients/lsp"), { recursive: true });
	mkdirSync(path.join(unique, "dist/clients/lsp"), { recursive: true });
	writeFileSync(path.join(unique, "clients/lsp/server-traits.ts"), "source");
	roots.push(unique);
	return unique;
}

describe("dist freshness (#4239)", () => {
	it("reports a missing bundled dependency", () => {
		const root = fixture();
		expect(findStaleDistFiles(root)).toEqual([
			{
				source: "clients/lsp/server-traits.ts",
				output: "dist/clients/lsp/server-traits.js",
				reason: "missing",
			},
		]);
	});

	it("reports a bundled dependency older than its source", () => {
		const root = fixture();
		const output = path.join(root, "dist/clients/lsp/server-traits.js");
		writeFileSync(output, "built");
		const source = path.join(root, "clients/lsp/server-traits.ts");
		const now = Date.now() / 1000;
		utimesSync(output, now - 10, now - 10);
		utimesSync(source, now, now);
		expect(findStaleDistFiles(root)[0]?.reason).toBe("stale");
	});
});
