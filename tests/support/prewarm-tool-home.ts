// Global setup: seed a shared managed-tools template once per suite run.
//
// Every worker gets a fresh empty PI_LENS_HOME (vitest-setup.ts), so any test
// that drives the real analyze pipeline (mcp/analyze-cli, the MCP server
// smokes) used to pay a cold `ensureTool("oxlint")` npm install PER WORKER —
// seconds each, network-dependent, and the source of wild run-to-run variance
// (one analyze-cli file run measured 14s vs 47s on install luck alone). Build
// the install once into a lockfile-keyed template under os.tmpdir() and hand
// workers its probe-cache.json; ensureTool's probe-cache fast path then
// resolves the template's binaries (read-only, safe to share) with zero
// spawns. If the seed fails (offline), workers just fall back to the old
// cold-install behavior.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeTempDirSync } from "../clients/test-utils.js";

// Under the installer's 24h probe-cache TTL so a handed-out cache is never
// already expired mid-run.
const TEMPLATE_STALE_MS = 20 * 60 * 60 * 1000;

export default function prewarmToolHome(): void {
	const repoRoot = process.cwd();
	let lockKey = "nolock";
	try {
		lockKey = createHash("sha256")
			.update(fs.readFileSync(path.join(repoRoot, "package-lock.json")))
			.digest("hex")
			.slice(0, 12);
	} catch {
		// keyless template still works; it just never invalidates on dep bumps
	}
	const template = path.join(os.tmpdir(), `pi-lens-test-tools-${lockKey}`);
	const probeCache = path.join(template, "probe-cache.json");

	try {
		if (Date.now() - fs.statSync(probeCache).mtimeMs < TEMPLATE_STALE_MS) {
			process.env.PI_LENS_TEST_TOOLS_TEMPLATE = template;
			return;
		}
	} catch {
		// no template yet — build one below
	}

	const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tools-seed-"));
	try {
		const fixture = path.join(seedDir, "seed.ts");
		fs.writeFileSync(fixture, "console.log(1);\n");
		const runSeed = () =>
			spawnSync(
				process.execPath,
				[
					path.join(repoRoot, "mcp", "analyze-cli.js"),
					`--file=${fixture}`,
					`--cwd=${seedDir}`,
				],
				{
					env: {
						...process.env,
						PI_LENS_HOME: template,
						PI_LENS_CONFIG_PATH: "/nonexistent-pi-lens-tests/config.json",
					},
					timeout: 120_000,
					stdio: "ignore",
				},
			);
		runSeed();
		// The installer's probe-cache flush is a 300ms unref'd debounce, so a
		// fast exit can drop it; a second (now warm, discovery-only) run rewrites
		// the entries and stays alive past the flush.
		if (!fs.existsSync(probeCache)) runSeed();
		if (fs.existsSync(probeCache)) {
			process.env.PI_LENS_TEST_TOOLS_TEMPLATE = template;
		} else {
			console.warn(
				"[prewarm-tool-home] seed analyze produced no probe-cache; workers run with cold tool homes",
			);
		}
	} finally {
		removeTempDirSync(seedDir);
	}
}
