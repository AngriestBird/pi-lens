import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateTlaCoverage,
	loadCoverageMap,
	matchGlob,
	parseChangedFiles,
	validateCoverageMap,
} from "../../scripts/lib/tla-coverage.mjs";
import { lintLocalPrBody } from "../../scripts/check-pr-body.mjs";

// #3802 rule 2: a PR that changes a mapped runtime file must move its model
// (a .tla/.cfg under the family) or say "TLA+ unaffected: <family> — <reason>".
// The recurrence this prevents is #3524/#3525's class: a lifecycle seam changed
// while its TLA+ model kept describing the old behaviour, so TLC stayed green
// and proved nothing about the new code.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const map = loadCoverageMap(REPO_ROOT);

const READ_GUARD_MAP = {
	families: ["read-guard"],
	map: { "clients/read-guard.ts": ["read-guard"] },
};

const TWO_FAMILY_MAP = {
	families: ["read-guard", "session-lifecycle"],
	map: { "clients/read-guard.ts": ["read-guard", "session-lifecycle"] },
};

// A structurally valid PR body with no code citations and no test references,
// so the only error under test is the coverage rule.
const BASE_BODY = [
	"## Why",
	"The coverage rule keeps a model tied to the code it models.",
	"",
	"## Notes for the reviewer",
	"None.",
	"",
	"## Change outline",
	"- clients/read-guard.ts",
	"",
	"## Summary",
	"Extend the read guard.",
	"",
	"## Tests",
	"Targeted tests pass.",
	"",
	"## Blast radius",
	"clients/read-guard.ts.",
	"",
	"## Class sweep",
	"Swept the read-guard seam.",
	"",
	"## Observability",
	"No new failure path; no record added.",
].join("\n");

const READ_GUARD_DIFF = [
	"diff --git a/clients/read-guard.ts b/clients/read-guard.ts",
	"@@ -1,0 +1,1 @@",
	"+// touched",
].join("\n");

describe("TLA+ coverage map (#3802)", () => {
	it("checks in the audited population", () => {
		expect(map.families).toHaveLength(19);
		expect(Object.keys(map.map ?? {})).toHaveLength(78);
		expect(
			Object.values(map.map ?? {}).filter((value) => value === "unmodelled"),
		).toHaveLength(11);
		expect(Object.keys(map.excluded ?? {})).toHaveLength(5);
	});

	it("matches every glob to a file and every family to a model", () => {
		expect(validateCoverageMap(map, REPO_ROOT)).toEqual([]);
	});

	it("matches a nested ** glob to files under its directory", () => {
		expect(
			matchGlob(
				"clients/dispatch/runners/**",
				"clients/dispatch/runners/biome-check.ts",
			),
		).toBe(true);
		expect(
			matchGlob("clients/dispatch/runners/**", "clients/dispatch/runners"),
		).toBe(false);
	});

	it("keeps both sides of a rename as changed paths", () => {
		const diff =
			"diff --git a/clients/read-guard.ts b/clients/read-guard-branch.ts";
		expect(parseChangedFiles(diff).sort()).toEqual([
			"clients/read-guard-branch.ts",
			"clients/read-guard.ts",
		]);
	});
});

describe("TLA+ coverage rule", () => {
	it("errors on a mapped change with no model change and no body line", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("formal/read-guard/");
		expect(result.errors[0]).toContain("TLA+ unaffected: read-guard");
	});

	it("passes when a .cfg under the family changes", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/Guarded.cfg"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("passes when the PR body carries the unaffected line", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard — only a local helper moved.",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});

	it("does not accept an unaffected line with no reason", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts"],
			body: "TLA+ unaffected: read-guard — ",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("requires every family the changed file maps to", () => {
		const result = evaluateTlaCoverage({
			map: TWO_FAMILY_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/Guarded.cfg"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("session-lifecycle");
	});

	it("does not count a non-model file under the family directory", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/read-guard.ts", "formal/read-guard/README.md"],
			body: "",
		});
		expect(result.errors).toHaveLength(1);
	});

	it("reports unmodelled seams as advisories, never errors", () => {
		const result = evaluateTlaCoverage({
			map: { families: [], map: { "clients/lsp-mutation.ts": "unmodelled" } },
			changedFiles: ["clients/lsp-mutation.ts"],
			body: "",
		});
		expect(result.errors).toEqual([]);
		expect(result.advisories).toHaveLength(1);
		expect(result.advisories[0]).toContain("lsp-mutation.ts");
	});

	it("ignores an unmapped changed file", () => {
		const result = evaluateTlaCoverage({
			map: READ_GUARD_MAP,
			changedFiles: ["clients/other.ts"],
			body: "",
		});
		expect(result).toEqual({ errors: [], advisories: [] });
	});
});

describe("TLA+ coverage in the PR-body lint (#3802)", () => {
	it("fails a mapped runtime change with no model change and no body line", () => {
		const git = (args: string[]) =>
			args.includes("--name-only")
				? "clients/read-guard.ts\n"
				: READ_GUARD_DIFF;
		const result = lintLocalPrBody(BASE_BODY, REPO_ROOT, git as never);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("formal/read-guard/");
	});

	it("passes the same diff when the body carries the unaffected line", () => {
		const git = (args: string[]) =>
			args.includes("--name-only")
				? "clients/read-guard.ts\n"
				: READ_GUARD_DIFF;
		const body = `${BASE_BODY}\n\nTLA+ unaffected: read-guard — only a local helper moved.\nTLA+ unaffected: session-lifecycle — the change does not touch session state.`;
		const result = lintLocalPrBody(body, REPO_ROOT, git as never);
		expect(result.valid).toBe(true);
	});
});
