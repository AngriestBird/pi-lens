/**
 * Unit test for the tests/-shadow guard (#2232). The guard runs as a vitest
 * globalSetup; if it ever silently stopped detecting a stray compiled `.js`
 * under `tests/`, that residue would go on shadowing its `.ts` source with no
 * signal (surfaced when a PR #2226 verify-round probe of a FIXED file
 * reproduced pre-fix behavior because of exactly this). Exercised here
 * against a controlled temp fixture, never the real tests/ tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findShadowedTestSources } from "./support/check-tests-js-shadow.js";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lens-tests-shadow-"));
	const support = join(root, "support");
	mkdirSync(support, { recursive: true });

	const write = (rel: string) => writeFileSync(join(root, rel), "");

	// shadowed: a stray compiled .js sibling of a .ts test-support source.
	write("support/availability-classifiedby-scan.ts");
	write("support/availability-classifiedby-scan.js");
	// clean: a .ts source with no compiled sibling.
	write("support/clean.ts");
	// must be ignored: fixture/live-project dirs carry their own toolchain's
	// real compiled output, not residue from this repo's build.
	mkdirSync(join(root, "fixtures"), { recursive: true });
	write("fixtures/tool-smoke.ts");
	write("fixtures/tool-smoke.js");
	mkdirSync(join(root, "native-ts7-live-1234"), { recursive: true });
	write("native-ts7-live-1234/control.ts");
	write("native-ts7-live-1234/control.js");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findShadowedTestSources (#2232 tests/ shadow guard)", () => {
	const run = () =>
		findShadowedTestSources({ root }).map((p) => p.replace(/\\/g, "/"));

	it("names the .ts source shadowed by a stray compiled .js sibling", () => {
		expect(
			run().some((p) =>
				p.endsWith("support/availability-classifiedby-scan.ts"),
			),
		).toBe(true);
	});

	it("does not flag a .ts source with no compiled sibling", () => {
		expect(run().some((p) => p.endsWith("support/clean.ts"))).toBe(false);
	});

	it("skips fixtures/ and native-ts7-live-*/ (own toolchain's real output)", () => {
		const r = run();
		expect(r.some((p) => p.includes("fixtures/"))).toBe(false);
		expect(r.some((p) => p.includes("native-ts7-live-"))).toBe(false);
	});
});
