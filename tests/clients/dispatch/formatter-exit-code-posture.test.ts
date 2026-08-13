/**
 * Formatter exit-code posture guard (#1337, generalizing #1336).
 *
 * #1336: `ruff format` rejected invented `--indent-style` flags and exited 2.
 * Exit-code strictness was OPT-IN (`strictExitCode`) and ruff had not opted in,
 * so `formatFile` ignored the exit, read the untouched file back, and returned
 * `{ success: true, changed: false }` — byte-identical to "already formatted".
 * Every unconfigured Python file silently went unformatted for a release cycle.
 *
 * The flag was the accident; the DEFAULT was the defect. #1337 inverts it: the
 * seam is strict unless a formatter carries `lenientExitCode`, whose value is
 * the documented benign-nonzero evidence (a string, so the justification is
 * structurally required — an opt-out cannot be added without writing why).
 *
 * Two layers here:
 *  1. POSTURE — a static audit of every entry in ALL_FORMATTERS, pinning the
 *     lenient set so a new opt-out cannot ride in unnoticed.
 *  2. SEAM — the behavior itself: a nonzero exit from a formatter that has not
 *     opted out must never read as `{ success: true, changed: false }`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../test-utils.js";

const safeSpawnAsync = vi.fn();
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => null),
}));

async function loadFormatters() {
	return await import("../../../clients/formatters.ts");
}

/**
 * The ONLY formatters allowed a benign nonzero exit: lint-autofixers, which
 * report remaining offenses through the exit status AFTER a successful rewrite.
 * Everything else is a pure formatter — nonzero means the rewrite never
 * happened. Adding a name here requires per-tool evidence in the definition.
 */
const EXPECTED_LENIENT = new Set([
	"rubocop",
	"standardrb",
	"ktlint",
	"sqlfluff",
]);

describe("formatter exit-code posture (#1337)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("pins the exact set of formatters that opt out of exit-code strictness", async () => {
		const { ALL_FORMATTERS } = await loadFormatters();
		const lenient = ALL_FORMATTERS.filter((f) => f.lenientExitCode).map(
			(f) => f.name,
		);
		expect(new Set(lenient)).toEqual(EXPECTED_LENIENT);
	});

	it("requires a substantive justification on every opt-out", async () => {
		const { ALL_FORMATTERS } = await loadFormatters();
		for (const formatter of ALL_FORMATTERS.filter((f) => f.lenientExitCode)) {
			expect(
				(formatter.lenientExitCode ?? "").trim().length,
				`${formatter.name}: lenientExitCode must carry the documented benign-nonzero evidence, not a placeholder`,
			).toBeGreaterThan(40);
		}
	});

	it("keeps every other formatter strict", async () => {
		const { ALL_FORMATTERS } = await loadFormatters();
		const strict = ALL_FORMATTERS.filter((f) => !f.lenientExitCode).map(
			(f) => f.name,
		);
		// The audit covered the whole registry — no formatter is unclassified.
		expect(strict.length + EXPECTED_LENIENT.size).toBe(ALL_FORMATTERS.length);
		// ruff kept its #1336 strictness; gofmt/prettier/biome GAINED it here.
		expect(strict).toContain("ruff");
		expect(strict).toContain("gofmt");
		expect(strict).toContain("prettier");
		expect(strict).toContain("biome");
	});
});

describe("formatFile is strict by default at the seam (#1337)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	// The real-definition case, and the one that mutation-verifies the fix:
	// gofmt had NO strictExitCode before #1337. `gofmt -w` exits 2 on a file it
	// cannot parse (verified locally against Go's gofmt) and leaves it untouched.
	// Pre-fix, that returned { success: true, changed: false } — a syntax error
	// reported to the user as "already formatted".
	it("a nonzero exit from gofmt is a failure, not a clean no-op", async () => {
		const env = setupTestEnvironment("pi-lens-exit-posture-");
		try {
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\nfunc main( {\n");
			safeSpawnAsync.mockResolvedValue({
				status: 2,
				stdout: "",
				stderr: "main.go:2:12: expected ')', found '{'",
			});

			const { formatFile, gofmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, gofmtFormatter);

			expect(result).not.toEqual({ success: true, changed: false });
			expect(result.success).toBe(false);
			expect(result.changed).toBe(false);
			expect(result.error).toContain("expected");
		} finally {
			env.cleanup();
		}
	});

	// Whole-registry sweep. `resolveCommand` is stripped so the seam — not each
	// tool's binary discovery — is what is under test; every other field,
	// crucially `lenientExitCode`, comes from the real definition.
	it("every formatter without an opt-out reports failure on a nonzero exit", async () => {
		const { ALL_FORMATTERS, formatFile } = await loadFormatters();
		const env = setupTestEnvironment("pi-lens-exit-posture-all-");
		try {
			for (const definition of ALL_FORMATTERS) {
				const ext = definition.extensions[0] ?? "";
				const name = definition.filenames?.[0] ?? `probe${ext}`;
				const filePath = path.join(env.tmpDir, name);
				fs.writeFileSync(filePath, "a\n\tb\n");
				safeSpawnAsync.mockResolvedValue({
					status: 1,
					stdout: "",
					stderr: `${definition.name}: boom`,
				});

				const result = await formatFile(filePath, {
					...definition,
					resolveCommand: undefined,
				});

				if (definition.lenientExitCode) {
					expect(
						result.success,
						`${definition.name} opted out, so a nonzero exit stays non-fatal`,
					).toBe(true);
				} else {
					expect(
						result,
						`${definition.name}: a nonzero exit must not read as a clean unchanged file`,
					).not.toEqual({ success: true, changed: false });
					expect(result.success).toBe(false);
				}
			}
		} finally {
			env.cleanup();
		}
	});

	it("still reports a clean unchanged file when the exit is zero", async () => {
		const env = setupTestEnvironment("pi-lens-exit-posture-ok-");
		try {
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\n");
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const { formatFile, gofmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, gofmtFormatter);

			expect(result).toEqual({ success: true, changed: false });
		} finally {
			env.cleanup();
		}
	});
});
