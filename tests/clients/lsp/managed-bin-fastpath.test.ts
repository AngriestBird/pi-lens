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
	ensureTool: vi.fn(async () => null as string | null),
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

/** availability_decision records emitted for `tool`, oldest first (#2140). */
function decisionsFor(tool: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter(
			(entry) =>
				entry?.phase === "availability_decision" &&
				(entry.metadata as Record<string, unknown> | undefined)?.tool === tool,
		);
}

function metadataOf(record: Record<string, unknown>): Record<string, unknown> {
	return record.metadata as Record<string, unknown>;
}

describe("resolveAndLaunch — managed-bin availability telemetry (#2140)", () => {
	beforeEach(() => {
		launchLSP.mockReset();
		findManagedToolBinary.mockReset();
		findManagedToolBinary.mockResolvedValue(undefined);
		ensureTool.mockReset();
		logLatency.mockClear();
	});

	it("emits exactly ONE availability_decision (verdict=available) when the managed binary is present", async () => {
		const managedPath = "/home/user/.pi-lens/bin/opengrep";
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "opengrep" ? managedPath : undefined,
		);
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: ["lsp"],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		const decisions = decisionsFor("opengrep");
		expect(decisions).toHaveLength(1);
		expect(metadataOf(decisions[0])).toMatchObject({
			verdict: "available",
			outcome: "success",
			cause: "ok",
			classifiedBy: "probe",
			evidence: { source: "managed-dir", binary: "opengrep" },
		});
	});

	it("does not swallow the negative case: unavailable then the install-path override both emit when the binary is absent", async () => {
		const installedPath = "/home/user/.pi-lens/bin/typos-lsp";
		// Absent at first resolution; present once the install below "lands" it.
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "typos-lsp" && ensureTool.mock.calls.length > 0
				? installedPath
				: undefined,
		);
		const toolNotFound = Object.assign(new Error("typos-lsp not found"), {
			kind: "tool-not-found" as const,
		});
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool.mockResolvedValueOnce(installedPath);

		const result = await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			true,
		);

		expect(result?.source).toBe("managed");
		const decisions = decisionsFor("typos-lsp");
		expect(decisions).toHaveLength(2);
		expect(metadataOf(decisions[0])).toMatchObject({
			verdict: "unavailable",
			outcome: "missing",
			cause: "not-found",
			classifiedBy: "probe",
		});
		expect(metadataOf(decisions[1])).toMatchObject({
			verdict: "available",
			outcome: "success",
			cause: "ok",
			classifiedBy: "caller",
			evidence: {
				install: "succeeded",
				binary: "typos-lsp",
				source: "managed-dir",
			},
		});
	});

	it("does not assert evidence.source when the install lands outside ~/.pi-lens/bin (npm/pip-strategy servers)", async () => {
		// findManagedToolBinary short-circuits to undefined for every non-github/
		// maven/archive strategy (installer/index.ts), before AND after install —
		// there is nothing to re-confirm, so the compensating row must not claim
		// managed-dir source it never derived (recurring-defect shape 13).
		findManagedToolBinary.mockResolvedValue(undefined);
		const toolNotFound = Object.assign(
			new Error("bash-language-server not found"),
			{
				kind: "tool-not-found" as const,
			},
		);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool.mockResolvedValueOnce(
			"/home/user/.pi-lens/tools/bash-language-server/bin/bash-language-server",
		);

		const result = await resolveAndLaunch(
			{
				candidates: ["bash-language-server"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "bash-language-server",
			},
			true,
		);

		expect(result?.source).toBe("managed");
		const decisions = decisionsFor("bash-language-server");
		expect(decisions).toHaveLength(2);
		expect(metadataOf(decisions[1]).evidence).not.toHaveProperty("source");
	});

	it("emits no availability_decision when a bare-PATH copy resolves and no managed binary exists", async () => {
		launchLSP.mockResolvedValueOnce(fakeProc);

		await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			false,
		);

		expect(decisionsFor("typos-lsp")).toHaveLength(0);
	});
});
