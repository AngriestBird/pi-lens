/**
 * #799: a push-only server marked `silentOnClean` (`server-strategies.ts`)
 * publishes NOTHING on a clean file — there is no pull fallback and (unlike
 * typescript's tsserver sync commands, `tsserver-sync.ts`) no active
 * sync-confirm protocol either, so a clean touch used to burn its FULL wait
 * budget with zero signal either way and get reported `inconclusive`
 * (`diagnosticsTimedOut`), never `demonstratedReady`.
 *
 * `touchFile`'s generic clean-confirm gate (`clients/lsp/index.ts`, next to
 * the tsserver-specific sync-confirm block) closes that gap: a single-server
 * primary-scope touch whose notify write succeeded, whose wait ran its full
 * budget with no publish, and whose live capability snapshot classifies as
 * `tier3-silent` (`classifyCascadeWaitTier`, #458 — push-only AND
 * `silentOnClean`) is now CONFIRMED clean, not inconclusive. These tests
 * exercise that gate directly via `touchFile`, using marksman's real
 * strategy (silentOnClean since #799) as the concrete example.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeServer(id: string, ext: string, root: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * A push-only client that NEVER publishes diagnostics (mirrors a clean
 * markdown file against marksman) — `waitForDiagnostics` always resolves
 * `undefined` right at its deadline, exactly like a real client's wait
 * timing out with nothing having arrived.
 */
function makeSilentPushOnlyClient(serverId: string, root: string) {
	const waitCalls: Array<{ filePath: string; ms: number }> = [];
	return {
		client: {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			getLaunchVariant: () => undefined,
			serverId,
			root,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				waitCalls.push({ filePath, ms });
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, ms);
					t.unref?.();
				});
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		},
		waitCalls,
	};
}

describe("touchFile silent-clean push-only confirm (#799)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-silent-clean-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	it("(a) a silent-clean push-only server (marksman) resolves quickly as CONFIRMED clean (0 diagnostics), not inconclusive", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client, waitCalls } = makeSilentPushOnlyClient("marksman", tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test",
		});

		// Confirmed clean: an empty array, and NOT flagged inconclusive.
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(0);
		expect((result as { inconclusive?: boolean }).inconclusive).toBeUndefined();

		// Marksman's own strategy budget (1500ms, server-strategies.ts) is what
		// the wait actually paid — not some other unrelated ceiling.
		expect(waitCalls.length).toBe(1);
		expect(waitCalls[0]!.ms).toBe(1500);

		// A confirmed-clean touch marks the server demonstratedReady — proven
		// indirectly via ensureWarmForSweep treating a subsequent sweep as a
		// no-op (this is the #799 fix that stops repeat-sweep re-payment).
		const warmup = await service.ensureWarmForSweep(filePath);
		expect(warmup.performedWarmup).toBe(false);
		expect(warmup.failedServerIds).toEqual([]);
	});

	it("a non-primary/multi-server touch does NOT take the silent-clean shortcut (stays inconclusive, matching pre-#799 behavior)", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
			return makeSilentPushOnlyClient(opts.serverId, tmp).client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "test",
		});

		// Multi-server touches are deliberately excluded from the fast path
		// (see the gate's `spawned.length === 1` condition) — a partial timeout
		// across servers must stay cautious, so this still reports inconclusive.
		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
	});
});
