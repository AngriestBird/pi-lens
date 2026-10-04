/**
 * #3968 — the `covers` field path of the runner-coverage seam.
 *
 * `LSPServerInfo.covers` is the CONFIG-declared channel (`lsp.servers.<id>.covers`);
 * its config-side producer is the stacked PR. This file pins the SEAM half
 * now so the field cannot silently stop being read: the mock stands in for
 * the registered-server projection exactly once, carries the shape that
 * producer will emit, and asserts the builtin fact table does NOT mask it
 * (and carries no gate commands for a config-declared lane — the config
 * channel owns its availability story).
 *
 * Everything else about the seam (builtin facts, no-lsp, primary selection)
 * is covered over the real registry and real config in
 * `runner-helpers.test.ts` — this file must never widen to assert those.
 */
import { describe, expect, it, vi } from "vitest";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

vi.mock("../../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/lsp/config.js")
	>()),
	getServersForFileWithConfig,
}));

async function seam() {
	const { lspPrimaryCoversFile } =
		await import("../../../../clients/dispatch/runners/utils/runner-helpers.js");
	return lspPrimaryCoversFile;
}

describe("runner coverage seam — config-declared covers field path (#3968)", () => {
	it("honors a primary's own covers declaration over the builtin facts table", async () => {
		// The shape the stacked PR's config channel will produce: a custom
		// `shuck2` server claiming the shellcheck runner without any builtin
		// fact row.
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "shuck2",
				role: "language",
				covers: ["shellcheck"],
			},
		]);
		const lspPrimaryCoversFile = await seam();
		const cover = lspPrimaryCoversFile(
			{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
			"shellcheck",
		);
		expect(cover?.serverId).toBe("shuck2");
		// No builtin fact → no gate commands; the config channel owns the
		// availability story for the lane it declares.
		expect(cover?.gateCommands).toEqual([]);
	});

	it("a covers declaration naming a different runner never matches", async () => {
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "shuck2",
				role: "language",
				covers: ["shellcheck"],
			},
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
				"taplo",
			),
		).toBeUndefined();
	});

	it("an entry with covers undefined (still builtin-shaped) never matches on its own", async () => {
		// bash has a BUILTIN fact, but a row WITHOUT one and WITHOUT covers —
		// e.g. python — must not answer true for any runner id.
		getServersForFileWithConfig.mockReturnValue([
			{ id: "python", role: "language" },
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.py", pi: { getFlag: () => false } } as never,
				"shellcheck",
			),
		).toBeUndefined();
	});
});
