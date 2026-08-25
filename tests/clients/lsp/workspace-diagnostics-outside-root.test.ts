/**
 * #2052 fix round 1 (F3): a sweep over files outside every registered session
 * root must not report them as confirmed clean, and must not persist that
 * false clean into the workspace cache.
 *
 * `runWorkspaceDiagnostics` never read `touchFile`'s `skipReason`. A declined
 * foreign file therefore arrived as `timedOut: false` with an empty
 * `diagnostics` array — indistinguishable from a real clean answer. The record
 * loop then wrote that empty result into
 * `cache/lsp-workspace-diagnostics.json`, so the false clean replayed on every
 * later sweep even after the decline itself was working correctly.
 *
 * The decline now enters the unconfirmed lane as `outside_project_root`, which
 * is the same flag the cache write-back already uses to skip unconfirmed
 * results. One mechanism, not a second parallel filter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheKeyFor,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { resetWorkspaceDiagnosticsCacheSession } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

// Partial mock: the REAL registry predicate stays in play (that is the
// behavior under test), only server selection is stubbed so no language
// server is spawned.
vi.mock("../../../clients/lsp/config.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../../clients/lsp/config.js")
	>("../../../clients/lsp/config.js");
	return {
		...actual,
		getServersForFileWithConfig,
		getServerInitOverride: () => undefined,
	};
});
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

describe("#2052 sweep over a foreign root does not report or cache a clean", () => {
	let sessionDir: string;
	let foreignDir: string;
	let foreignFile: string;

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();

		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-2052-session-"));
		fs.mkdirSync(path.join(sessionDir, ".pi-lens"));
		// A sibling worktree with its OWN tsconfig — the exact shape from the
		// issue's evidence (a `pi-agent-*` temp worktree).
		foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-2052-foreign-"));
		fs.mkdirSync(path.join(foreignDir, ".pi-lens"));
		fs.writeFileSync(path.join(foreignDir, "tsconfig.json"), "{}\n");
		foreignFile = path.join(foreignDir, "app.ts");
		fs.writeFileSync(foreignFile, "export const a: number = 1;\n");

		const config = await import("../../../clients/lsp/config.js");
		config.resetLSPConfigStateForTests();
		// Only sessionDir is a session root. foreignDir is not.
		await config.initLSPConfig(sessionDir);

		const tsServer = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => foreignDir,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			root: foreignDir,
			getWorkspaceDiagnosticsSupport: () => ({ advertised: false }),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});
	});

	afterEach(async () => {
		const config = await import("../../../clients/lsp/config.js");
		config.resetLSPConfigStateForTests();
		removeTempDirSync(sessionDir);
		removeTempDirSync(foreignDir);
		resetWorkspaceDiagnosticsCacheSession();
	});

	it("marks the foreign file unconfirmed with reason outside_project_root", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(foreignDir);

		const result = results.find(
			(r) => cacheKeyFor(r.filePath) === cacheKeyFor(foreignFile),
		);
		expect(result).toBeDefined();
		// Pre-fix: timedOut was undefined and unconfirmedReason absent, i.e. a
		// CONFIRMED CLEAN verdict for a file nothing ever examined.
		expect(result?.timedOut).toBe(true);
		expect(result?.unconfirmedReason).toBe("outside_project_root");
	});

	it("does not write the declined file into the workspace cache", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(foreignDir);

		const cached =
			loadWorkspaceDiagnosticsCache(foreignDir)?.entries[
				cacheKeyFor(foreignFile)
			];
		// Probe for ABSENCE. Pre-fix the record loop persisted `count: 0` here,
		// so every later sweep replayed the false clean from disk.
		expect(cached).toBeUndefined();
	});
});
