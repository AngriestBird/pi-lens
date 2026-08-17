/**
 * #1562: gitleaks scanned gitignored scratch (`.pi/greedysearch-sources/`,
 * a pi-ecosystem web-research cache) and served a placeholder curl-doc-example
 * (`-H "Authorization: Bearer YOUR_API_KEY"`) to the agent as a leaked secret.
 *
 * Two compounding defects, both covered here:
 *   1. Scope: gitleaks's own tree walk (`--source <dir>`) bypassed pi-lens's
 *      shared scratch/cache-tree exclusion (`EXCLUDED_DIRS`/`isExcludedDirName`
 *      in `file-utils.ts`) because it never routes through pi-lens's own
 *      walker — the generated `--config` (`writeScopedGitleaksConfig`) and the
 *      TS-side backstop (`classifyAndFilterFindings`) both close that gap.
 *   2. Placeholder recognition: `YOUR_API_KEY`-class values must be allowlisted
 *      even OUTSIDE scratch trees (a placeholder in a tracked example file is
 *      just as much a non-finding).
 *
 * The over-correction pin (#1562 design note): an untracked `.env` with a
 * REAL-shaped secret must still be reported — the fix must not become a
 * blanket "respect .gitignore".
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetTrackedFilesCacheForTests,
} from "../../clients/git-tracked-ignore.js";
import {
	classifyAndFilterFindings,
	type GitleaksFinding,
	PLACEHOLDER_SECRET_REGEXES,
	writeScopedGitleaksConfig,
} from "../../clients/gitleaks-client.js";
import { gitleaksFindingToProjectDiagnostic } from "../../clients/project-diagnostics/runner-adapters/gitleaks.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

function initGitRepo(cwd: string): void {
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
}

function finding(overrides: Partial<GitleaksFinding>): GitleaksFinding {
	return {
		ruleId: "generic-api-key",
		file: "src/config.ts",
		startLine: 1,
		...overrides,
	};
}

beforeEach(() => {
	_resetTrackedFilesCacheForTests();
});
afterEach(() => {
	_resetTrackedFilesCacheForTests();
});

describe("classifyAndFilterFindings — scratch-tree exclusion (#1562)", () => {
	it("drops a finding under .pi/greedysearch-sources/** (the doc-example fixture from the incident)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-scratch-");
		try {
			const findings = [
				finding({
					file: ".pi/greedysearch-sources/cline-api-docs.md",
					secret: "YOUR_API_KEY",
					match: '-H "Authorization: Bearer YOUR_API_KEY"',
				}),
			];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("drops findings under other shared scratch/cache trees (.claude/, node_modules/)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-scratch2-");
		try {
			const findings = [
				finding({ file: ".claude/scratch/notes.md" }),
				finding({ file: "node_modules/some-pkg/README.md" }),
			];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a finding in an untracked operational .env with a real-shaped secret (over-correction pin)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-env-");
		try {
			initGitRepo(env.tmpDir);
			fs.writeFileSync(
				path.join(env.tmpDir, ".env"),
				"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
			);
			// .env is untracked (never committed) — the exact case gitleaks must
			// still catch. No .gitignore entry either, so it's plain-untracked.
			const findings = [
				finding({
					file: ".env",
					ruleId: "aws-secret-key",
					secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				}),
			];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].file).toBe(".env");
			expect(result[0].pathStatus).toBe("untracked");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a finding in an untracked-but-gitignored .env and labels it 'ignored', not 'scratch'", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-env-ignored-");
		try {
			initGitRepo(env.tmpDir);
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), ".env\n");
			execFileSync("git", ["add", ".gitignore"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "add gitignore"], {
				cwd: env.tmpDir,
			});
			fs.writeFileSync(
				path.join(env.tmpDir, ".env"),
				"SOME_SERVICE_SECRET=not-a-real-secret-just-test-fixture-data\n",
			);
			const findings = [finding({ file: ".env", ruleId: "stripe-key" })];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBe("ignored");
		} finally {
			env.cleanup();
		}
	});

	it("labels a tracked finding 'tracked'", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-tracked-");
		try {
			initGitRepo(env.tmpDir);
			fs.writeFileSync(
				path.join(env.tmpDir, "config.ts"),
				"export const key = 'placeholder';\n",
			);
			execFileSync("git", ["add", "config.ts"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "add config"], {
				cwd: env.tmpDir,
			});
			const findings = [finding({ file: "config.ts" })];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBe("tracked");
		} finally {
			env.cleanup();
		}
	});

	it("leaves pathStatus undefined (fail-open) when git degrades (no repo)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-nogit-");
		try {
			// No `git init` — git ls-files fails, both sets resolve undefined.
			const findings = [finding({ file: "config.ts" })];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("gitleaksFindingToProjectDiagnostic — pathStatus observability (#1562)", () => {
	it("appends the git status to the diagnostic message when pathStatus is set", () => {
		const diag = gitleaksFindingToProjectDiagnostic(
			"/repo",
			finding({ file: ".env", pathStatus: "untracked" }),
		);
		expect(diag.message).toContain("[git: untracked]");
	});

	it("omits the status suffix when pathStatus is undefined (git degraded)", () => {
		const diag = gitleaksFindingToProjectDiagnostic("/repo", finding({}));
		expect(diag.message).not.toContain("[git:");
	});
});

describe("writeScopedGitleaksConfig — placeholder allowlist + scratch paths (#1562)", () => {
	let outDir: string;

	beforeEach(() => {
		outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gitleaks-cfg-"));
	});
	afterEach(() => {
		removeTempDirSync(outDir);
	});

	it("extends gitleaks defaults when no local .gitleaks.toml exists", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-nolocal-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).toContain("useDefault = true");
		} finally {
			env.cleanup();
		}
	});

	it("extends the project's own .gitleaks.toml by path when present", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-local-");
		try {
			const localConfigPath = path.join(env.tmpDir, ".gitleaks.toml");
			fs.writeFileSync(localConfigPath, "title = \"custom\"\n");
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).not.toContain("useDefault = true");
			expect(toml).toContain(JSON.stringify(localConfigPath));
		} finally {
			env.cleanup();
		}
	});

	it("includes an allowlist path pattern for every shared scratch-tree directory", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-paths-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).toContain("[allowlist]");
			expect(toml).toContain("paths = [");
			// Same source EXCLUDED_DIRS derives from — .pi is the #1562 dir.
			expect(toml).toMatch(/\\\.pi\(/);
		} finally {
			env.cleanup();
		}
	});

	it("includes placeholder-secret regexes covering the YOUR_API_KEY class", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-regex-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).toContain("regexes = [");
			for (const pattern of PLACEHOLDER_SECRET_REGEXES) {
				expect(toml).toContain(JSON.stringify(pattern));
			}
		} finally {
			env.cleanup();
		}
	});

	it("the placeholder-secret regex set matches the #1562 incident value and common variants, but never a real-shaped secret", () => {
		const stripped = PLACEHOLDER_SECRET_REGEXES.map((p) =>
			p.replace(/^\(\?i\)/, ""),
		);
		const regexes = stripped.map((p) => new RegExp(p, "i"));
		expect(regexes.some((r) => r.test("YOUR_API_KEY"))).toBe(true);
		expect(regexes.some((r) => r.test("<your-api-key>"))).toBe(true);
		expect(regexes.some((r) => r.test("xxxxxxxxxxxx"))).toBe(true);
		// Must NOT match a real-shaped secret.
		expect(
			regexes.some((r) => r.test("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")),
		).toBe(false);
	});
});
