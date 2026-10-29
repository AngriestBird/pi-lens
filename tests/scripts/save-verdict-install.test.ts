/**
 * #4999 R3-1: a FAILED install must reach the save-verdict row as a cause.
 *
 * The driver (`scripts/probe-save-verdict.mjs`) wraps `ensureTool` in a
 * `try/catch`, and the round-2 case pinned that path with the string
 * `"install failed for clangd: getaddrinfo EAI_AGAIN"` — a throw the installer
 * does not produce. `ensureTool` answers `undefined` on every install failure it
 * owns (failed download, policy decline, held lock), so the catch never fired,
 * `row.failures` stayed empty, and the fixture was filed as
 * `server never spawned (no capability snapshot)`. On the 2026-10 run that line
 * covered nine fixtures a night with no way to tell an absent toolchain from a
 * failed download from a crashed server.
 *
 * These cases drive the REAL installer (`clients/installer/index.js`, the same
 * artifact the driver's `dist/` build comes from) with only the spawn boundary
 * mocked, and assert the exact cause line the driver records — so the guard is
 * proven against the failure mode it was written for, not against a fabricated
 * throw (#4999 R3-1; AGENTS shape 50).
 *
 * Limit, named: the driver itself is not spawned here, because it imports
 * `dist/`, which the Unit shards job does not build. The driver's install block
 * is one call to `installCauses` plus a join of its result, so the decision
 * under test is the one below.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCauses } from "../../scripts/lib/save-verdict.mjs";
import { withEnv } from "../support/with-env.js";

// `clients/safe-spawn` is pi-lens's single child-process seam, so the mocked
// call stands in for the spawned `npm` and needs no admission (AGENTS.md "Test
// requirements"). No child is spawned, no timer is real, and the installer under
// test is the real module.
const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal()),
	safeSpawnAsync,
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
	isCommandAvailableAsync: vi.fn(async () => false),
}));

const FIXTURE = { lang: "fish", tools: ["fish-lsp"] };

const npmOk = { stdout: "", stderr: "", status: 0 };
const npmFailed = {
	stdout: "",
	stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/fish-lsp",
	status: 1,
};

let piLensHome: string;
let restoreEnv: () => void;

/** The real installer, loaded fresh so its tools dir picks up `PI_LENS_HOME`. */
async function installer(): Promise<
	typeof import("../../clients/installer/index.js")
> {
	vi.resetModules();
	return import("../../clients/installer/index.js");
}

/** Plant the binary a successful npm install is expected to leave behind. */
function plantFishLspBinary(): void {
	const binDir = path.join(piLensHome, "tools", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const names =
		process.platform === "win32" ? ["fish-lsp.cmd", "fish-lsp"] : ["fish-lsp"];
	for (const name of names) {
		fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
	}
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	piLensHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sv-install-"));
	restoreEnv = withEnv({
		PI_LENS_HOME: piLensHome,
		PI_LENS_DISABLE_TOOL_INSTALL: undefined,
	});
});

afterEach(async () => {
	(await import("../../clients/project-trust.js")).resetProjectTrust();
	restoreEnv();
	fs.rmSync(piLensHome, { recursive: true, force: true });
});

describe("installCauses: the cause a failed ensureTool leaves (#4999 R3-1)", () => {
	it("records the installer's own failure, which never throws", async () => {
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();

		// The pre-round shape: a throw is the only thing the driver's catch sees.
		await expect(ensureTool("fish-lsp")).resolves.toBeUndefined();
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("failed");

		const causes = await installCauses(FIXTURE, {
			ensureTool,
			getInstallAttempt,
		});
		expect(causes).toHaveLength(1);
		expect(causes[0]).toMatch(/^install failed for fish-lsp: .*404/);
		// The registry's own text, not the generic fallback: an operator reading
		// the nightly line can tell a 404 from a refused connection.
		expect(causes[0]).toContain("registry.npmjs.org/fish-lsp");
	});

	it("records a policy decline, which also resolves nothing", async () => {
		const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		try {
			safeSpawnAsync.mockResolvedValue(npmFailed);
			const { ensureTool, getInstallAttempt } = await installer();

			await ensureTool("fish-lsp");
			const causes = await installCauses(FIXTURE, {
				ensureTool,
				getInstallAttempt,
			});
			expect(causes).toHaveLength(1);
			expect(causes[0]).toContain("install declined for fish-lsp:");
			expect(causes[0]).toContain("PI_LENS_DISABLE_TOOL_INSTALL");
		} finally {
			restore();
		}
	});

	it("blames nothing when the toolchain resolved, whatever the attempt says", async () => {
		// A resolved path is the answer to "is the toolchain here?" — the arms can
		// run on it. `ensureTool` records `declined` on its trust-gated DISCOVERY
		// branch and still returns the binary it found, so reading the attempt
		// alone would suppress a measurement the run actually made.
		safeSpawnAsync.mockImplementation(async () => {
			plantFishLspBinary();
			return npmOk;
		});
		const { ensureTool, getInstallAttempt } = await installer();

		// One call, the driver's own shape: `installCauses` is the only caller.
		expect(
			await installCauses(FIXTURE, { ensureTool, getInstallAttempt }),
		).toEqual([]);
		// The install genuinely ran and succeeded, so this is the guard's real
		// cell: an attempt record exists and still blames nothing.
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("succeeded");
	});

	it("still records a throw, which is the only path the old case covered", async () => {
		const causes = await installCauses(FIXTURE, {
			ensureTool: async () => {
				throw new Error("getaddrinfo EAI_AGAIN");
			},
			getInstallAttempt: () => undefined,
		});
		expect(causes).toEqual([
			"install failed for fish-lsp: getaddrinfo EAI_AGAIN",
		]);
	});
});
