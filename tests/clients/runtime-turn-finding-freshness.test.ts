/**
 * turn_end freshness gate over the cached scanner stores — #1622.
 *
 * The live case: gitleaks flagged src:397, the agent edited that file, and the
 * STOP blocker kept citing 397 for the rest of the 30-minute TTL. The #1460
 * existence gate could not see it — the file was still there.
 *
 * The asymmetry under test is the security contract. A DELETED path drops. An
 * EDITED path demotes: it leaves the blocker tier and loses its line number, but
 * it is still surfaced. If an edit could drop it, touching a file would mute a
 * real credential.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

const SCANNED_AT_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCANNED_AT = new Date(SCANNED_AT_MS).toISOString();

/**
 * A turn whose edited file still exists, so `validateAdvisoryProvenance` says
 * "current" — exactly the condition under which #1622's replay was invisible.
 */
function setupSecretTurn(prefix: string) {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: "freshness-session" });
	const cacheManager = new CacheManager(false);
	const editedFile = path.join(env.tmpDir, "src/edited.ts");
	fs.mkdirSync(path.dirname(editedFile), { recursive: true });
	fs.writeFileSync(editedFile, "export const value = 1;\n");
	cacheManager.addModifiedRange(
		editedFile,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		"freshness-session",
	);
	return { env, runtime, cacheManager };
}

/** Write a secret-bearing file and stamp its mtime relative to the scan. */
function writeSecretFile(cwd: string, relative: string, mtimeMs: number): string {
	const file = path.join(cwd, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "const k = 'AKIA...';\n");
	const when = new Date(mtimeMs);
	fs.utimesSync(file, when, when);
	return file;
}

async function turnEndContent(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): Promise<string> {
	await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, { ctxCwd: cwd }));
	return consumeTurnEndFindings(cacheManager, cwd)?.messages?.[0]?.content ?? "";
}

// ── gitleaks ─────────────────────────────────────────────────────────────────

describe("turn_end gitleaks stale-line freshness gate (#1622)", () => {
	it("DEMOTES a finding whose file was edited after the scan — kept, no line", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gl-stale-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/config.ts",
				SCANNED_AT_MS + 5_000,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "aws-access-token",
							file: secretFile,
							startLine: 397,
							description: "AWS key",
						},
					],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// Still surfaced — an edit must never silence a real secret.
			expect(content).toContain("src/config.ts");
			expect(content).toContain("stale");
			// Demoted out of the blocker tier.
			expect(content).not.toContain("hardcoded secrets detected");
			// And without the coordinate the edit invalidated.
			expect(content).not.toContain("src/config.ts:397");
			expect(content).not.toContain(":397");
		} finally {
			env.cleanup();
		}
	});

	it("keeps an unmodified file's finding as a full-severity blocker", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gl-fresh-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/config.ts",
				SCANNED_AT_MS - 5_000,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "aws-access-token",
							file: secretFile,
							startLine: 397,
							description: "AWS key",
						},
					],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/config.ts:397");
			expect(content).not.toContain("stale");
		} finally {
			env.cleanup();
		}
	});

	it("still drops a finding whose file was deleted after the scan (#1460 holds)", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gl-dead-");
		try {
			const deadFile = writeSecretFile(
				env.tmpDir,
				"scratch/sources.json",
				SCANNED_AT_MS - 5_000,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "generic-api-key",
							file: deadFile,
							startLine: 1341,
							description: "Detected a Generic API Key",
						},
					],
				},
				env.tmpDir,
			);
			fs.rmSync(path.dirname(deadFile), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain("sources.json");
			expect(content).not.toContain("generic-api-key");
		} finally {
			env.cleanup();
		}
	});
});

// ── trivy secrets (criterion 4) ──────────────────────────────────────────────

describe("turn_end trivy-secrets stale-line freshness gate (#1622 criterion 4)", () => {
	function writeTrivyCache(
		cacheManager: CacheManager,
		cwd: string,
		secrets: Array<{ ruleId: string; file: string; line: number }>,
	) {
		cacheManager.writeCache(
			"trivy",
			{
				success: true,
				scannedAt: SCANNED_AT,
				findings: [],
				secrets,
				licenses: [],
			},
			cwd,
		);
	}

	it("DEMOTES a trivy secret whose file was edited after the scan", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-tv-stale-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/creds.ts",
				SCANNED_AT_MS + 5_000,
			);
			writeTrivyCache(cacheManager, env.tmpDir, [
				{ ruleId: "aws-access-key-id", file: secretFile, line: 234 },
			]);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("src/creds.ts");
			expect(content).toContain("stale");
			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain(":234");
		} finally {
			env.cleanup();
		}
	});

	it("keeps an unmodified trivy secret as a full-severity blocker", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-tv-fresh-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/creds.ts",
				SCANNED_AT_MS - 5_000,
			);
			writeTrivyCache(cacheManager, env.tmpDir, [
				{ ruleId: "aws-access-key-id", file: secretFile, line: 234 },
			]);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/creds.ts:234");
		} finally {
			env.cleanup();
		}
	});

	it("drops a trivy secret whose file was deleted after the scan", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-tv-dead-");
		try {
			const deadFile = writeSecretFile(
				env.tmpDir,
				"scratch/creds.ts",
				SCANNED_AT_MS - 5_000,
			);
			writeTrivyCache(cacheManager, env.tmpDir, [
				{ ruleId: "aws-access-key-id", file: deadFile, line: 234 },
			]);
			fs.rmSync(path.dirname(deadFile), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain("creds.ts");
			expect(content).not.toContain("aws-access-key-id");
		} finally {
			env.cleanup();
		}
	});
});

// ── govulncheck (sibling sweep) ──────────────────────────────────────────────

describe("turn_end govulncheck stale call-site gate (#1622 sibling sweep)", () => {
	function writeGovCache(
		cacheManager: CacheManager,
		cwd: string,
		filename: string,
	) {
		cacheManager.writeCache(
			"govulncheck",
			{
				success: true,
				scannedAt: SCANNED_AT,
				findings: [
					{
						osv: "GO-2024-1234",
						module: "example.com/mod",
						fixedVersion: "v1.2.3",
						trace: [{ filename, line: 88 }],
					},
				],
			},
			cwd,
		);
	}

	it("strips the cached call-site line when the file was edited after the scan", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gov-stale-");
		try {
			const goFile = writeSecretFile(
				env.tmpDir,
				"cmd/main.go",
				SCANNED_AT_MS + 5_000,
			);
			writeGovCache(cacheManager, env.tmpDir, goFile);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// The CVE is still real after an edit — it is never dropped.
			expect(content).toContain("GO-2024-1234");
			expect(content).toContain("stale");
			expect(content).not.toContain(":88");
		} finally {
			env.cleanup();
		}
	});

	it("keeps the call-site line for an unmodified file", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gov-fresh-");
		try {
			const goFile = writeSecretFile(
				env.tmpDir,
				"cmd/main.go",
				SCANNED_AT_MS - 5_000,
			);
			writeGovCache(cacheManager, env.tmpDir, goFile);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("GO-2024-1234");
			expect(content).toContain("cmd/main.go:88");
			expect(content).not.toContain("stale");
		} finally {
			env.cleanup();
		}
	});
});
