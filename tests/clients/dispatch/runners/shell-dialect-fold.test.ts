/**
 * #3968 — the fold-verdict table, as executable arms.
 *
 * One table governs: real `dispatchForFile`, real shellcheck runner, real
 * runner registry, real covers-fact selection — and the skip reason carried
 * to the delivery surfaces (latency rows + the coverage-unavailable notice),
 * not just the runner's return value. An empty output must never read as
 * clean — every skip discloses its reason, and a lane-coverage loss discloses
 * the notice (the #3166 r2 / defect shape 10 direction).
 *
 * The five arms the PR body's table names:
 *
 * - builtin-bash-covered: `.sh` primary bash + tools → `covered-by-primary`.
 * - shuck-installed: `.zsh` primary shuck (bash's `.zsh` claim narrowed) +
 *   shuck on PATH → `covered-by-primary`.
 * - custom-covers: `.zsh` primary a config-registered server whose
 *   `lsp.servers.<id>.covers` claims shellcheck (the stacked config PR's
 *   channel; shuck disabled so the custom entry selects) →
 *   `covered-by-primary`. This is the arm that fails if the config
 *   projection drops the field.
 * - shuck-absent: `.zsh` primary shuck, shuck NOT probeable → the covering
 *   lane cannot run, so no covers skip — the dialect gate skips, and the
 *   dispatch surface discloses `coverage-unavailable` (never a silent clean).
 * - no-lsp: `no-lsp` set → the seam's kill switch; `.zsh` still skips
 *   dialect-unsupported, a shebang-less `.sh` still lints.
 *
 * The compile boundary (`safeSpawnAsync`) is mocked; everything above it —
 * config selection, covers facts, dialect resolution, dispatch assembly,
 * latency delivery — runs real. The `.zsh` fixtures carry zsh-only constructs
 * the pre-fix runner mis-analyzed into error-severity findings (real-binary
 * probe quoted in the PR body).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn((..._args: unknown[]) => ({
	error: null,
	status: 0,
	stdout: "[]",
	stderr: "",
}));
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawn,
	safeSpawnAsync,
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

const BARE_ZSH = "zmodload zsh/complist\nautoload -Uz compinit\n";
const SHEBANG_ZSH =
	"#!/usr/bin/env zsh\nzparseopts -D -E -F -- a=opts\nlocal -A counts\necho $undefined_var\n";
const PLAIN_SH = "F=1\necho $F\n";
const SHEBANG_SH = "#!/bin/sh\nF=1\necho $F\n";

describe("#3968 fold arms — dispatch-level delivery", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		logLatency.mockReset();
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
	});

	/** The fold seam: real registry + real runner + real covers selection. */
	async function fold() {
		const { makeRunnerCtx } = await import("../../../support/runner-ctx.js");
		const lspConfig = await import("../../../../clients/lsp/config.js");
		const {
			RunnerRegistry,
			dispatchForFile,
			clearLatencyReports,
			getLatencyReports,
		} = await import("../../../../clients/dispatch/dispatcher.js");
		const { registerDefaultRunners } =
			await import("../../../../clients/dispatch/runners/index.js");
		const registry = new RunnerRegistry();
		registerDefaultRunners(registry);
		return {
			makeRunnerCtx,
			dispatchForFile,
			registry,
			clearLatencyReports,
			getLatencyReports,
			initLSPConfig: lspConfig.initLSPConfig,
		};
	}

	async function arm(
		tmpDir: string,
		relFile: string,
		content: string,
		options: {
			present?: Record<string, boolean>;
			noLsp?: boolean;
			/** Run the real config funnel first, so custom servers register. */
			initLspConfig?: boolean;
		} = {},
	): Promise<Record<string, unknown>> {
		const {
			makeRunnerCtx,
			dispatchForFile,
			registry,
			clearLatencyReports,
			getLatencyReports,
			initLSPConfig,
		} = await fold();
		if (options.initLspConfig) await initLSPConfig(tmpDir);
		const filePath = path.join(tmpDir, relFile);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
		const present = options.present ?? {};
		const ctx = makeRunnerCtx(filePath, tmpDir, {
			kind: "shell",
			pi: { getFlag: (f: string) => options.noLsp === true && f === "no-lsp" },
			hasTool: async (t: string) => present[t] ?? true,
		});
		clearLatencyReports();
		const result = (await dispatchForFile(
			ctx as never,
			[{ mode: "all", runnerIds: ["shellcheck"] }],
			registry,
			undefined,
			{ dedupeCoverageNotice: false },
		)) as { output: string; warnings: Array<{ message: string }> };
		const latency = getLatencyReports().at(-1)?.runners.at(-1);
		return { result, latency, logLatency };
	}

	it("builtin-bash-covered arm: a .sh skip discloses covered-by-primary on the latency row", async () => {
		const env = setupTestEnvironment("pi-lens-fold-");
		try {
			const out = await arm(env.tmpDir, "deploy.sh", SHEBANG_SH);
			expect(out.latency).toMatchObject({
				runnerId: "shellcheck",
				status: "skipped",
				skipReason: "covered-by-primary",
			});
		} finally {
			env.cleanup();
		}
	});

	it("shuck-installed arm: a .zsh skip discloses covered-by-primary (shuck on PATH)", async () => {
		const env = setupTestEnvironment("pi-lens-fold-");
		try {
			const out = await arm(env.tmpDir, "dotfiles/zshrc.zsh", SHEBANG_ZSH, {
				present: {
					shuck: true,
					"bash-language-server": true,
					shellcheck: true,
				},
			});
			expect(out.latency).toMatchObject({
				status: "skipped",
				skipReason: "covered-by-primary",
			});
			// The runner row in the latency log carries the reason too — the
			// record the observability section names.
			const runnerRow = (out.logLatency as ReturnType<typeof vi.fn>).mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.find(
					(entry) => entry.type === "runner" && entry.runnerId === "shellcheck",
				);
			expect(runnerRow).toMatchObject({
				metadata: { skipReason: "covered-by-primary" },
			});
		} finally {
			env.cleanup();
		}
	});

	it("custom-covers arm: a config-declared covers claim on the selected primary defers the runner (covered-by-primary)", async () => {
		const env = setupTestEnvironment("pi-lens-fold-");
		try {
			// The stacked config PR's channel: a project `.pi-lens.json` registers
			// a custom zsh LSP that claims shellcheck, and disables the builtin
			// shuck row so the custom entry is the selected primary for `.zsh`
			// (builtin rows select first). The projection runs through the REAL
			// loader funnel above — this arm reds when it drops the field.
			fs.mkdirSync(env.tmpDir, { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({
					lsp: {
						servers: {
							zshz: {
								name: "zshz",
								extensions: [".zsh"],
								command: "zsh-language-server",
								covers: ["shellcheck"],
							},
						},
						disabledServers: ["shuck"],
					},
				}),
			);
			const out = await arm(env.tmpDir, "dotfiles/zshrc.zsh", SHEBANG_ZSH, {
				initLspConfig: true,
				present: { "bash-language-server": false, shellcheck: true },
			});
			expect(out.latency).toMatchObject({
				runnerId: "shellcheck",
				status: "skipped",
				skipReason: "covered-by-primary",
			});
			// A config-declared lane carries no gate commands: the skip is the
			// covers match, not a spawn — nothing reached the process boundary.
			expect(safeSpawn).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("shuck-absent arm: a .zsh still skips (dialect gate) and the dispatch surface discloses coverage-unavailable — never a silent clean", async () => {
		const env = setupTestEnvironment("pi-lens-fold-");
		try {
			const out = await arm(env.tmpDir, "bare.zsh", BARE_ZSH, {
				present: {
					shuck: false,
					"bash-language-server": false,
					shellcheck: true,
				},
			});
			expect(out.latency).toMatchObject({
				status: "skipped",
				skipReason: "dialect-unsupported",
			});
			// The no-coverage path is disclosed on the delivery surface, not
			// rendered clean.
			const result = out.result as { output: string };
			expect(result.output).toContain("analysis unavailable");
		} finally {
			env.cleanup();
		}
	});

	it("no-lsp arm: the kill switch drops the covers match, .zsh still skips dialect-unsupported, a bare .sh still lints", async () => {
		const env = setupTestEnvironment("pi-lens-fold-");
		try {
			const zshOut = await arm(env.tmpDir, "zshrc.zsh", BARE_ZSH, {
				noLsp: true,
			});
			expect(zshOut.latency).toMatchObject({
				status: "skipped",
				skipReason: "dialect-unsupported",
			});
			const shOut = await arm(env.tmpDir, "plain.sh", PLAIN_SH, {
				noLsp: true,
			});
			expect(shOut.latency).toMatchObject({ status: "succeeded" });
		} finally {
			env.cleanup();
		}
	});

	it("a shebang'd .sh with no covering lane still lints (override stays with shellcheck's own parsing)", async () => {
		const env = setupTestEnvironment("pi-lens-fold-");
		try {
			const out = await arm(env.tmpDir, "shebang.sh", SHEBANG_SH, {
				present: { "bash-language-server": false },
			});
			expect(out.latency).toMatchObject({ status: "succeeded" });
			// the lint spawn: the mocked process boundary's own call record; no
			// --shell for a shebang'd file (shellcheck parses the shebang itself)
			const lintCall = safeSpawn.mock.calls.at(-1) as
				| [string, string[]]
				| undefined;
			expect(lintCall, "expected a shellcheck spawn").toBeDefined();
			expect(lintCall![1]).not.toContain("--shell");
		} finally {
			env.cleanup();
		}
	});
});
