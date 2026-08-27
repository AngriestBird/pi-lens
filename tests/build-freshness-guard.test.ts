/**
 * Unit test for the build-freshness guard (#198). The guard runs as a vitest
 * globalSetup; if it ever silently stopped detecting staleness it would
 * reintroduce the exact bug it exists to prevent (tests passing against stale
 * in-place compiled `.js`), so its detection logic is exercised here against a
 * controlled temp fixture with explicit mtimes.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import checkBuildFreshness, {
	findResidueCompiledTestSources,
	findStaleCompiledSources,
} from "./support/check-build-freshness.js";

let root: string;
const older = new Date("2020-01-01T00:00:00Z");
const newer = new Date("2020-01-02T00:00:00Z");

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lens-freshness-"));
	const clients = join(root, "clients");
	mkdirSync(clients, { recursive: true });

	const write = (rel: string, ts: Date) => {
		const p = join(root, rel);
		writeFileSync(p, "");
		utimesSync(p, ts, ts);
	};

	// fresh: .js newer than .ts → not stale
	write("clients/fresh.ts", older);
	write("clients/fresh.js", newer);
	// stale: .ts newer than .js → stale
	write("clients/stale.js", older);
	write("clients/stale.ts", newer);
	// missing: source with no compiled .js → stale
	write("clients/missing.ts", newer);
	// must be ignored (not compiled in place)
	write("clients/thing.test.ts", newer);
	write("clients/thing.d.ts", newer);
	// root file, fresh
	write("index.js", newer);
	write("index.ts", older);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findStaleCompiledSources (#198 build-freshness guard)", () => {
	const run = () =>
		findStaleCompiledSources({
			root,
			dirs: ["clients"],
			rootFiles: ["index.ts"],
		}).map((p) => p.replace(/\\/g, "/"));

	it("flags a source whose compiled .js is older", () => {
		expect(run().some((p) => p.endsWith("clients/stale.ts"))).toBe(true);
	});

	it("flags a source with no compiled .js", () => {
		expect(run().some((p) => p.endsWith("clients/missing.ts"))).toBe(true);
	});

	it("does not flag a fresh source (.js newer than .ts)", () => {
		const r = run();
		expect(r.some((p) => p.endsWith("clients/fresh.ts"))).toBe(false);
		expect(r.some((p) => p.endsWith("index.ts"))).toBe(false);
	});

	it("ignores .test.ts and .d.ts (excluded from the in-place build)", () => {
		const r = run();
		expect(r.some((p) => p.includes("thing.test.ts"))).toBe(false);
		expect(r.some((p) => p.includes("thing.d.ts"))).toBe(false);
	});
});

describe("findResidueCompiledTestSources (#2232 stale test-support residue guard)", () => {
	let residueRoot: string;

	beforeAll(() => {
		residueRoot = mkdtempSync(join(tmpdir(), "pi-lens-test-residue-"));
		const support = join(residueRoot, "tests", "support");
		mkdirSync(support, { recursive: true });
		const write = (rel: string) => writeFileSync(join(residueRoot, rel), "");

		// tests/ is never built, so ANY .js sibling of a tests/**/*.ts is residue,
		// regardless of mtime — unlike findStaleCompiledSources above.
		write("tests/support/shadowed.ts");
		write("tests/support/shadowed.js");
		// no sibling .js: clean, must not be flagged.
		write("tests/support/clean.ts");
		// .d.ts is never a real test-support module: must not be flagged even
		// with a .js sibling.
		write("tests/support/types.d.ts");
		write("tests/support/types.js");
	});

	afterAll(() => rmSync(residueRoot, { recursive: true, force: true }));

	it("flags a .ts file that has a compiled .js sibling", () => {
		const r = findResidueCompiledTestSources({ root: residueRoot }).map((p) =>
			p.replace(/\\/g, "/"),
		);
		expect(r.some((p) => p.endsWith("tests/support/shadowed.js"))).toBe(true);
	});

	it("does not flag a .ts file with no compiled sibling", () => {
		const r = findResidueCompiledTestSources({ root: residueRoot });
		expect(r.some((p) => p.includes("clean"))).toBe(false);
	});

	it("ignores .d.ts even when a same-stem .js sits beside it", () => {
		const r = findResidueCompiledTestSources({ root: residueRoot });
		expect(r.some((p) => p.includes("types.js"))).toBe(false);
	});
});

describe("check-build-freshness setup() end-to-end (#2232)", () => {
	// The real repo root, exactly as the globalSetup module computes it —
	// proves the guard fires against the ACTUAL tests/ tree the whole suite
	// runs from, not just an isolated fixture.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const probeTs = join(repoRoot, "tests", "support", "__2232-residue-probe.ts");
	const probeJs = join(repoRoot, "tests", "support", "__2232-residue-probe.js");

	afterAll(() => {
		for (const p of [probeTs, probeJs]) {
			try {
				unlinkSync(p);
			} catch {
				// already absent
			}
		}
	});

	it("throws a loud error naming a planted stale-residue file", () => {
		writeFileSync(probeTs, "");
		writeFileSync(probeJs, "");
		expect(() => checkBuildFreshness()).toThrow(/__2232-residue-probe\.js/);
	});
});
