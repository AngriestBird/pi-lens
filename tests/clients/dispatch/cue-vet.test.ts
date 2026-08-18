import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	filterToTouchedFile,
	parseCueVetOutput,
} from "../../../clients/dispatch/runners/cue-vet.js";
import type { DispatchContext } from "../../../clients/dispatch/types.js";

// ── appliesTo ────────────────────────────────────────────────────────────────

describe("cue-vet appliesTo", () => {
	it("applies only to cue", async () => {
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		expect(cueVetRunner.appliesTo).toEqual(["cue"]);
	});
});

// ── parseCueVetOutput — the real cue v0.17.1 output shapes ──────────────────

describe("parseCueVetOutput", () => {
	it("parses a single conflicting-value error with both its locations", () => {
		const raw = [
			'a: conflicting values int and "hello" (mismatched types int and string):',
			"    .\\bad.cue:3:4",
			"    .\\bad.cue:3:10",
		].join("\n");
		const errors = parseCueVetOutput(raw);
		expect(errors).toEqual([
			{
				message:
					'a: conflicting values int and "hello" (mismatched types int and string)',
				locations: [
					{ file: ".\\bad.cue", line: 3, column: 4 },
					{ file: ".\\bad.cue", line: 3, column: 10 },
				],
			},
		]);
	});

	it("parses a syntax error with no field-path prefix", () => {
		const raw = ["expected '}', found 'EOF':", "    .\\syntax.cue:2:6"].join(
			"\n",
		);
		expect(parseCueVetOutput(raw)).toEqual([
			{
				message: "expected '}', found 'EOF'",
				locations: [{ file: ".\\syntax.cue", line: 2, column: 6 }],
			},
		]);
	});

	it("parses multiple independent errors in one run", () => {
		const raw = [
			'a: conflicting values int and "hello" (mismatched types int and string):',
			"    .\\multi.cue:3:4",
			"    .\\multi.cue:3:10",
			"c: conflicting values string and 5 (mismatched types string and int):",
			"    .\\multi.cue:4:4",
			"    .\\multi.cue:4:13",
		].join("\n");
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(2);
		expect(errors[0].message).toContain("a: conflicting values");
		expect(errors[0].locations[0].line).toBe(3);
		expect(errors[1].message).toContain("c: conflicting values");
		expect(errors[1].locations[0].line).toBe(4);
	});

	// F1 (review round 1): a cross-file conflict names locations in TWO
	// different files — verified against real cue v0.17.1 on a package where
	// bad-values.cue's field conflicts with schema.cue's constraint.
	it("parses a cross-file error's locations across different files", () => {
		const raw = [
			"badField.name: conflicting values 5 and string (mismatched types int and string):",
			"    .\\bad-values.cue:3:11",
			"    .\\bad-values.cue:4:8",
			"    .\\schema.cue:4:8",
		].join("\n");
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(1);
		expect(errors[0].locations).toEqual([
			{ file: ".\\bad-values.cue", line: 3, column: 11 },
			{ file: ".\\bad-values.cue", line: 4, column: 8 },
			{ file: ".\\schema.cue", line: 4, column: 8 },
		]);
	});

	it("returns a headerless entry (no locations) for a summary-only failure, never zero", () => {
		// The exact message `-c=false` is meant to prevent, kept as a fallback
		// shape guard: a real vet failure must never parse to zero errors.
		const raw =
			"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances";
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(1);
		expect(errors[0].locations).toEqual([]);
	});
});

// ── filterToTouchedFile — the F1 fix: package-scoped vet, file-scoped report ─

describe("filterToTouchedFile (#1522 review round 1, F1)", () => {
	it("keeps an error whose location names the touched file", () => {
		const errors = parseCueVetOutput(
			[
				'a: conflicting values int and "hello" (mismatched types int and string):',
				"    .\\bad.cue:3:4",
				"    .\\bad.cue:3:10",
			].join("\n"),
		);
		const diagnostics = filterToTouchedFile(errors, "bad.cue");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics?.[0].line).toBe(3);
		expect(diagnostics?.[0].column).toBe(4);
	});

	// The regression itself: `values.cue` referencing `schema.cue`'s
	// `#Service` used to be vetted ALONE and reported a false
	// `reference "#Service" not found`. Package-scoped vet no longer produces
	// that error at all (real cue: exit 0, empty output on the valid
	// two-file package — see tests/fixtures/tool-smoke/cue-vet/valid-package),
	// so there is nothing to filter — this asserts the empty-input case is
	// itself the fix, not a masking layer.
	it("produces zero findings when the package-wide vet already found nothing", () => {
		expect(filterToTouchedFile([], "values.cue")).toBeUndefined();
	});

	it("filters out an error whose ONLY location is a sibling file (the missed-finding tradeoff)", () => {
		const errors = parseCueVetOutput(
			[
				"otherField: conflicting values 5 and string (mismatched types int and string):",
				"    .\\sibling.cue:3:11",
				"    .\\sibling.cue:4:8",
			].join("\n"),
		);
		expect(filterToTouchedFile(errors, "values.cue")).toEqual([]);
	});

	it("keeps a cross-file error when the touched file is ANY of its locations, at that location", () => {
		const errors = parseCueVetOutput(
			[
				"badField.name: conflicting values 5 and string (mismatched types int and string):",
				"    .\\bad-values.cue:3:11",
				"    .\\bad-values.cue:4:8",
				"    .\\schema.cue:4:8",
			].join("\n"),
		);
		// Touching the primary offender.
		expect(filterToTouchedFile(errors, "bad-values.cue")).toEqual([
			expect.objectContaining({ filePath: "bad-values.cue", line: 3, column: 11 }),
		]);
		// Touching the implicated sibling — still a real signal, at ITS location.
		expect(filterToTouchedFile(errors, "schema.cue")).toEqual([
			expect.objectContaining({ filePath: "schema.cue", line: 4, column: 8 }),
		]);
		// An unrelated third file in the same package sees neither.
		expect(filterToTouchedFile(errors, "unrelated.cue")).toEqual([]);
	});

	it("falls back to undefined (never false-clean) when nothing in the output could be file-attributed", () => {
		const errors = parseCueVetOutput(
			"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances",
		);
		expect(filterToTouchedFile(errors, "values.cue")).toBeUndefined();
	});
});

// ── run() — mocked spawn, real parser ───────────────────────────────────────

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => "cue",
	}),
	resolveAvailableOrInstall: async () => "cue",
}));

const cueCwd = path.join(os.tmpdir(), "pi-lens-cue-vet-test");
const cueFile = path.join(cueCwd, "bad.cue");
const valuesFile = path.join(cueCwd, "values.cue");

function createCtx(filePath: string, cwd: string): DispatchContext {
	return {
		filePath,
		cwd,
		kind: "cue",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		hasTool: async () => true,
		log: () => {},
	} as unknown as DispatchContext;
}

describe("cue-vet run() — real binary output shapes, mocked spawn", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("reports a BLOCKING diagnostic for a real conflicting-value error", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				'a: conflicting values int and "hello" (mismatched types int and string):\n    .\\bad.cue:3:4\n    .\\bad.cue:3:10\n',
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].line).toBe(3);
		expect(result.diagnostics[0].column).toBe(4);
		expect(result.diagnostics[0].tool).toBe("cue-vet");

		// F1: spawned with -c=false against the whole PACKAGE (the touched
		// file's directory), not the file alone.
		const [cmd, args, opts] = safeSpawnAsync.mock.calls[0];
		expect(cmd).toBe("cue");
		expect(args).toEqual(["vet", "-c=false", "."]);
		expect(opts.cwd).toBe(cueCwd);
	});

	it("reports clean (no findings) on a real successful vet (exit 0, empty output)", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
	});

	// F1's actual regression: touching `values.cue` in a valid split-schema
	// package used to false-positive because the pre-fix single-file
	// invocation never loaded `schema.cue`. Real cue vets the DIRECTORY
	// clean (exit 0), so this is really just the exit-0 path again — proving
	// it from the values.cue side specifically, since that was the exact
	// file the reviewer's probe caught failing.
	it("F1: a valid split-schema/values package reports zero findings for the touched values.cue", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(valuesFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
		const [, args] = safeSpawnAsync.mock.calls[0];
		// The directory, never the single file — that was the bug.
		expect(args).toEqual(["vet", "-c=false", "."]);
	});

	// F1: a real error exists in the package, but only in a SIBLING file —
	// touching values.cue must not surface it (filtered), and must not
	// crash or misreport it as blocking values.cue.
	it("F1: an error confined to a sibling file is filtered out for the touched file", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				"otherField: conflicting values 5 and string (mismatched types int and string):\n    .\\sibling.cue:3:11\n    .\\sibling.cue:4:8\n",
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(valuesFile, cueCwd));
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toEqual([]);
	});

	// F1: a real error whose location IS the touched file still reports,
	// even though vet now runs against the whole package.
	it("F1: an error in the touched file still reports when vetting the whole package", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout:
				"myField: conflicting values 5 and string (mismatched types int and string):\n    .\\values.cue:3:11\n    .\\schema.cue:4:8\n",
			stderr: "",
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(valuesFile, cueCwd));
		expect(result.status).toBe("failed");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].line).toBe(3);
		expect(result.diagnostics[0].column).toBe(11);
	});

	it("skips (never reports false-clean) when cue could not run at all", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout: "",
			stderr: "",
			error: new Error("ENOENT"),
		});
		const cueVetRunner = (
			await import("../../../clients/dispatch/runners/cue-vet.js")
		).default;
		const result = await cueVetRunner.run(createCtx(cueFile, cueCwd));
		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
	});
});
