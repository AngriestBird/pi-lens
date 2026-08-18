import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCueVetOutput } from "../../../clients/dispatch/runners/cue-vet.js";
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
	it("parses a single conflicting-value error, taking the first location", () => {
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
				line: 3,
				column: 4,
			},
		]);
	});

	it("parses a syntax error with no field-path prefix", () => {
		const raw = ["expected '}', found 'EOF':", "    .\\syntax.cue:2:6"].join(
			"\n",
		);
		expect(parseCueVetOutput(raw)).toEqual([
			{ message: "expected '}', found 'EOF'", line: 2, column: 6 },
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
		expect(errors[0].line).toBe(3);
		expect(errors[1].message).toContain("c: conflicting values");
		expect(errors[1].line).toBe(4);
	});

	it("returns a headerless entry (no location) for a summary-only failure, never zero", () => {
		// The exact message `-c=false` is meant to prevent, kept as a fallback
		// shape guard: a real vet failure must never parse to zero errors.
		const raw =
			"some instances are incomplete; use the -c flag to show errors or -c=false to allow incomplete instances";
		const errors = parseCueVetOutput(raw);
		expect(errors).toHaveLength(1);
		expect(errors[0].line).toBeUndefined();
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

		// Spawned with -c=false and scoped to the touched file only.
		const [cmd, args, opts] = safeSpawnAsync.mock.calls[0];
		expect(cmd).toBe("cue");
		expect(args).toEqual(["vet", "-c=false", "./bad.cue"]);
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
