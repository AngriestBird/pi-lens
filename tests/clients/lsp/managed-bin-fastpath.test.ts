/**
 * #2140 (LSP-server remainder): `resolveAndLaunch`'s candidate walk resolves
 * a bare command (`candidates: ["opengrep"]`) through the OS's own PATH
 * lookup only. A release-managed binary (opengrep, marksman, typos-lsp,
 * zizmor — every `installStrategy: "github"` tool) installed under
 * `~/.pi-lens/bin` with no PATH entry therefore ENOENTs every direct
 * candidate first, only for the `ensureTool()` step further down to find the
 * very same binary a few hundred ms later — the paired
 * unavailable-then-available shape #2140's evidence quotes. `SecurityScanClient`
 * (gitleaks/trivy/govulncheck/opengrep's CLI-scan path) already got this fix
 * in PR #2148/#2137; this is the sibling for the LSP-server launch path,
 * `OpengrepServer`/`MarksmanServer`/`TyposLspServer`/`ZizmorServer`'s shared
 * `resolveAndLaunch` call site.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
const { findManagedToolBinary, ensureTool } = vi.hoisted(() => ({
	findManagedToolBinary: vi.fn(
		async (_toolId: string) => undefined as string | undefined,
	),
	ensureTool: vi.fn(async () => null),
}));
vi.mock("../../../clients/lsp/launch.js", () => ({ launchLSP }));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));
vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment: () => ({}),
	findManagedToolBinary,
}));

import { resolveAndLaunch } from "../../../clients/lsp/server.js";

const fakeProc = { stdout: {}, stderr: {} } as never;

describe("resolveAndLaunch — managed-bin fast path (#2140)", () => {
	beforeEach(() => {
		launchLSP.mockReset();
		findManagedToolBinary.mockReset();
		findManagedToolBinary.mockResolvedValue(undefined);
		ensureTool.mockReset();
	});

	it("tries the managed release binary BEFORE the bare PATH candidate", async () => {
		const managedPath = "/home/user/.pi-lens/bin/opengrep";
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "opengrep" ? managedPath : undefined,
		);
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: ["lsp", "--experimental"],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		// The managed path must be the FIRST (and here, only-needed) candidate
		// tried — never a bare-PATH ENOENT first.
		expect(launchLSP).toHaveBeenCalledTimes(1);
		expect(launchLSP).toHaveBeenCalledWith(
			managedPath,
			["lsp", "--experimental"],
			expect.anything(),
		);
	});

	it("does not duplicate the bare candidate when it already equals the managed path", async () => {
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "marksman" ? "marksman" : undefined,
		);
		// #2140 fix-round F2: EVERY attempt rejects (tool-not-found), so
		// resolveAndLaunch walks its whole candidate list rather than
		// short-circuiting on the first success. Without the dedup guard, the
		// prepended managed path ("marksman") and the original bare candidate
		// ("marksman") would both be tried — two identical, both-failing
		// attempts instead of one. A `mockResolvedValueOnce` on the first call
		// would mask that: resolveAndLaunch returns after the first SUCCESS
		// regardless of whether a duplicate entry was ever reached.
		const toolNotFound = Object.assign(new Error("marksman not found"), {
			kind: "tool-not-found" as const,
		});
		launchLSP.mockRejectedValue(toolNotFound);

		await resolveAndLaunch(
			{
				candidates: ["marksman"],
				args: ["server"],
				cwd: "/tmp/proj",
				managedToolId: "marksman",
			},
			false,
		);

		expect(launchLSP).toHaveBeenCalledTimes(1);
	});

	it("falls back to the bare PATH candidate when no managed binary is resolved", async () => {
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		expect(launchLSP).toHaveBeenCalledWith("typos-lsp", [], expect.anything());
	});
});
