/**
 * Biome Client for pi-lens
 *
 * All-in-one: formatting + linting for JS/TS/JSX/TSX/CSS/JSON
 * Replaces Prettier with 15-50x faster Rust-based tool.
 *
 * Requires: npm install @biomejs/biome (or npx @biomejs/biome)
 * Docs: https://biomejs.dev/
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { isFileKind } from "./file-kinds.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { findGlobalBinary } from "./package-manager.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { biomeConfigArgs } from "./tool-policy.js";
import { resolveManagedToolClient } from "./dispatch/runners/utils/runner-helpers.js";

// --- Types ---

export interface BiomeDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule?: string;
	category: "lint" | "format";
	fixable: boolean;
}

// --- Client ---

export class BiomeClient {
	private biomeAvailable: boolean | null = null;
	// Per-cwd cache of the resolved biome binary. Keying by cwd matters in
	// monorepos where different sub-packages each ship their own biome
	// installation; sharing one slot across the whole client would cause
	// the first resolution to win and stale across other packages.
	private localBinaryByCwd = new Map<string, string>();
	// The binary path written by `ensureTool("biome")` — genuinely global
	// (lives under ~/.pi-lens/tools), so it's stored separately from the
	// per-cwd cache and used as a final fallback before npx.
	private autoInstalledBinaryPath: string | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? createSubsystemLogger("biome")
			: () => {};
	}

	/**
	 * Resolve the fastest available biome binary for `cwd`.
	 * Prefers local node_modules/.bin/biome (skip npx overhead ~1s).
	 * Falls back to ~/.pi-lens/tools, then npx.
	 *
	 * In monorepos, callers should pass the project / sub-package root for the
	 * edited file (typically `path.dirname(absolutePath)`). Omitting `cwd`
	 * falls back to `process.cwd()`, which is wrong when pi is invoked from
	 * a different directory than the file being edited.
	 */
	private async getBiomeBinary(
		cwd?: string,
	): Promise<{ cmd: string; args: string[] }> {
		const resolveCwd = cwd ?? process.cwd();
		const cached = this.localBinaryByCwd.get(resolveCwd);
		if (cached) return { cmd: cached, args: [] };
		if (this.autoInstalledBinaryPath) {
			return { cmd: this.autoInstalledBinaryPath, args: [] };
		}

		// Walk up from cwd looking for node_modules/.bin/biome.
		// Also check ~/.pi-lens/tools (where ensureTool("biome") auto-installs),
		// so we avoid the ~1.5s `npx @biomejs/biome --version` fallback when
		// the tool is already installed but not in the project's node_modules.
		// On Windows prefer .cmd (native batch) over the sh wrapper — 2x faster.
		const isWin = process.platform === "win32";
		const piLensBin = path.join(
			getGlobalPiLensDir(),
			"tools",
			"node_modules",
			".bin",
		);
		const candidates = isWin
			? [
					path.join(resolveCwd, "node_modules", ".bin", "biome.cmd"),
					path.join(resolveCwd, "node_modules", ".bin", "biome"),
					path.join(piLensBin, "biome.cmd"),
					path.join(piLensBin, "biome"),
				]
			: [
					path.join(resolveCwd, "node_modules", ".bin", "biome"),
					path.join(resolveCwd, "node_modules", ".bin", "biome.cmd"),
					path.join(piLensBin, "biome"),
				];
		for (const p of candidates) {
			if (fs.existsSync(p)) {
				this.localBinaryByCwd.set(resolveCwd, p);
				return { cmd: p, args: [] };
			}
		}
		// Any package manager's global bin dir (npm/pnpm/yarn/bun) before npx —
		// catches `pnpm add -g @biomejs/biome` installs that PATH misses (#375).
		const global = await findGlobalBinary("biome");
		if (global) {
			this.localBinaryByCwd.set(resolveCwd, global);
			return { cmd: global, args: [] };
		}
		// Fallback: npx (slower but works anywhere)
		return { cmd: "npx", args: ["@biomejs/biome"] };
	}

	private async spawnBiomeAsync(
		args: string[],
		timeout = 15000,
		cwd?: string,
	) {
		const { cmd, args: prefix } = await this.getBiomeBinary(cwd);
		return safeSpawnAsync(cmd, [...prefix, ...args], { timeout, cwd });
	}

	/**
	 * Ensure Biome is available, auto-installing if necessary.
	 * Prefer this over isAvailable() for auto-install behavior.
	 *
	 * Re-entrancy safe: concurrent first-time callers share a single
	 * `ensureInFlight` promise so probing/auto-install isn't duplicated.
	 * Mirrors the dedupe pattern in `SgRunner` / `KnipClient` /
	 * `DependencyChecker`.
	 */
	async ensureAvailable(): Promise<boolean> {
		if (this.biomeAvailable !== null) return this.biomeAvailable;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		const outcome = await resolveManagedToolClient({
			toolId: "biome",
			cwd: process.cwd(),
			probe: async () => {
				const result = await this.spawnBiomeAsync(["--version"], 10000);
				return !result.error && result.status === 0
					? { outcome: "success" as const, value: true }
					: { outcome: "missing" as const };
			},
			acceptInstalled: (installedPath) => {
				this.autoInstalledBinaryPath = installedPath;
				return true;
			},
		});
		this.biomeAvailable = outcome.outcome === "success";
		return this.biomeAvailable;
	}

	/**
	 * Check if a file is supported by Biome
	 */
	isSupportedFile(filePath: string): boolean {
		return isFileKind(filePath, ["jsts", "json", "css"]);
	}

	/**
	 * Async auto-fix variant for pipeline use (non-blocking spawn).
	 * `cwd` is the dispatch language root (used for config discovery); when
	 * omitted it defaults to the file's directory.
	 */
	async fixFileAsync(
		filePath: string,
		cwd?: string,
	): Promise<{
		success: boolean;
		changed: boolean;
		fixed: number;
		error?: string;
	}> {
		if (!(await this.ensureAvailable())) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "Biome not available",
			};
		}

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "File not found",
			};
		}

		try {
			const before = await fs.promises.readFile(absolutePath, "utf-8");
			const configCwd = cwd ?? path.dirname(absolutePath);
			// Shared config-args seam (#1247): the lint runner consumes the same
			// builder, so `lint --write` can never drift to biome's default
			// config when a user config or the package fallback exists.
			const result = await this.spawnBiomeAsync(
				["lint", "--write", ...biomeConfigArgs(configCwd), absolutePath],
				15000,
				configCwd,
			);

			if (result.error) {
				return {
					success: false,
					changed: false,
					fixed: 0,
					error: result.error.message,
				};
			}

			const after = await fs.promises.readFile(absolutePath, "utf-8");
			const changed = before !== after;

			if (changed) {
				this.log(`Fixed issue(s) in ${path.basename(filePath)}`);
			}

			return { success: true, changed, fixed: changed ? 1 : 0 };
		} catch (err) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

}
