/**
 * #1562 class-fix coverage: every runner that hands a DIRECTORY to an
 * external binary and lets THAT binary do its own tree walk (as opposed to
 * pi-lens's own `EXCLUDED_DIRS`-aware in-process walker feeding it a
 * pre-filtered file list) must thread the shared scratch-tree exclusion
 * policy (`scratch-tree-policy.ts`) through that tool's native exclude
 * mechanism.
 *
 * Sweep (grepped every `clients/*-client.ts` for a `safeSpawnAsync` call
 * whose args include `cwd`/`targetDir` as a bare positional — i.e. "the
 * binary walks the tree itself", #1562 root-cause shape):
 *   - gitleaks (`clients/gitleaks-client.ts`)  — covered: generated
 *     `--config` scoped allowlist + TS-side backstop
 *     (`gitleaks-scratch-exclusion.test.ts`).
 *   - trivy `fs` (`clients/trivy-client.ts`)    — covered below: `--skip-dirs`.
 *   - opengrep (`clients/opengrep-client.ts`)   — covered below: `--exclude`.
 *   - jscpd (`clients/jscpd-client.ts`)         — ALREADY wired (pre-#1562):
 *     `--ignore` built from `getExcludedDirGlobs()` + `getProjectIgnoreGlobs()`
 *     — not part of this defect.
 *   - vulture (`clients/dead-code-client.ts`)   — different shape (per-edit
 *     `--exclude`, not a session-scan secrets/CVE surface), but its
 *     `VULTURE_EXCLUDES` had independently DRIFTED from `EXCLUDED_DIRS` (a
 *     sibling single-source-of-truth defect found during this sweep) —
 *     covered below.
 *   - knip (`clients/knip-client.ts`)   — config/gitignore-driven, not a raw
 *     directory positional; knip respects `.gitignore` itself, which is
 *     ACCEPTABLE for a dead-code tool (unlike a secrets scanner, missing an
 *     ignored file's dead code is not a security gap) — deliberately left.
 *   - govulncheck (`clients/govulncheck-client.ts`) — Go-package-based
 *     (`-mode=source ./...`, via `go list`), not an arbitrary-byte tree walk;
 *     non-Go scratch content is invisible to it by construction — deliberately
 *     left.
 *   - trivy `config` (IaC misconfig, `clients/dispatch/runners/trivy-config.ts`)
 *     — per-EDIT dispatch runner over a single file already selected by the
 *     dispatch pipeline, not a directory scan — deliberately left.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getScratchTreeDirNames,
	getScratchTreeFnmatchPatterns,
	getScratchTreeGitleaksAllowlistPaths,
	getScratchTreeGlobPatterns,
	isUnderScratchTree,
} from "../../clients/scratch-tree-policy.js";
import { EXCLUDED_DIRS } from "../../clients/file-utils.js";

const { safeSpawnAsync, safeSpawn } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	safeSpawn: vi.fn(),
}));
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));

describe("scratch-tree-policy — single source of truth (#1562)", () => {
	it("every tool-format list is derived from (never a copy that can drift from) EXCLUDED_DIRS", () => {
		const literalNames = EXCLUDED_DIRS.filter(
			(n) => !n.includes("*") && !n.includes("?"),
		);
		expect(getScratchTreeDirNames()).toEqual(literalNames);
		expect(getScratchTreeGlobPatterns().length).toBe(EXCLUDED_DIRS.length);
		expect(getScratchTreeGitleaksAllowlistPaths().length).toBe(
			literalNames.length,
		);
		expect(getScratchTreeFnmatchPatterns().length).toBe(literalNames.length);
	});

	it("isUnderScratchTree matches .pi/greedysearch-sources/** (the #1562 fixture) and rejects an ordinary source path", () => {
		expect(
			isUnderScratchTree(".pi/greedysearch-sources/cline-docs.md"),
		).toBe(true);
		expect(isUnderScratchTree("src/config.ts")).toBe(false);
		// Must not false-positive on a filename that merely CONTAINS an
		// excluded name as a substring (e.g. "api.pipeline.ts" vs ".pi").
		expect(isUnderScratchTree("src/api.pipeline.ts")).toBe(false);
	});
});

describe("TrivyClient.scan — --skip-dirs threads the shared policy (#1562)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes a --skip-dirs flag for every scratch-tree glob", async () => {
		const { TrivyClient } = await import("../../clients/trivy-client.js");
		const client = new TrivyClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		await client.runScan("/repo");

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const args = safeSpawnAsync.mock.calls[0][1] as string[];
		for (const glob of getScratchTreeGlobPatterns()) {
			const idx = args.indexOf(glob);
			expect(idx).toBeGreaterThan(0);
			expect(args[idx - 1]).toBe("--skip-dirs");
		}
	});
});

describe("OpengrepClient.scan — --exclude threads the shared policy (#1562)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes an --exclude flag for every scratch-tree directory name", async () => {
		const { OpengrepClient } = await import("../../clients/opengrep-client.js");
		const client = new OpengrepClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		await client.runScan("/repo");

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const args = safeSpawnAsync.mock.calls[0][1] as string[];
		for (const name of getScratchTreeDirNames()) {
			const idx = args.indexOf(name);
			expect(idx).toBeGreaterThan(0);
			expect(args[idx - 1]).toBe("--exclude");
		}
	});
});
