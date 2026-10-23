/**
 * #4765: Opengrep never downloads rules at spawn. pi-lens always hands it a
 * local rule file, in this order: the repo's own rule file, then the refreshed
 * (cached) registry pack, then the pinned pack that ships with pi-lens.
 *
 * Recurrence these cases prevent: `--config auto` made every spawn download
 * about 1074 registry rules (about 8 s online, NO findings offline, measured in
 * the issue). The expected paths below are written out here, not read back from
 * the module under test, so a resolver that returns `auto`, or the wrong file,
 * cannot satisfy them by agreeing with itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "js-yaml";

import { OpengrepServer } from "../../clients/lsp/server.js";
import { resolveOpengrepConfig } from "../../clients/opengrep-config.js";
import { OpengrepClient } from "../../clients/opengrep-client.js";
import { stripPackRuleIdPrefix } from "../../clients/opengrep-rule-pack.js";
import * as safeSpawn from "../../clients/safe-spawn.js";
import { withEnv } from "../support/with-env.js";
import { pinFixtureHome, removeTempDirSync } from "./test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const PACK_DIR = path.join(repoRoot, "vendor", "opengrep-rules");
const SHIPPED = path.join(PACK_DIR, "rules.yaml");

let home: string;
let restoreHome: () => void;
let restoreEnv: () => void;
let project: string;
const tempDirs: string[] = [];

beforeEach(() => {
	({ home, restore: restoreHome } = pinFixtureHome("opengrep-pack-4765"));
	// `getGlobalPiLensDir()` reads PI_LENS_HOME at call time; the cached pack
	// lives under it, so the case owns it.
	restoreEnv = withEnv({ PI_LENS_HOME: home });
	project = path.join(home, "project");
	fs.mkdirSync(project, { recursive: true });
	tempDirs.push(project);
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
	restoreEnv();
	restoreHome();
	vi.restoreAllMocks();
});

/** What the refresh leaves behind: the documented cache location. */
function writeCachedPack(body = "rules:\n  - id: cached\n"): string {
	const cached = path.join(home, "rules", "opengrep-registry.yaml");
	fs.mkdirSync(path.dirname(cached), { recursive: true });
	fs.writeFileSync(cached, body);
	return cached;
}

describe("the pinned pack that ships with pi-lens", () => {
	// Recurrence: vendoring a pack nobody can audit. The manifest pins the
	// upstream commit, the rule count and the content digest, and the pack is
	// listed in the npm `files` so it reaches users.
	it("is a registry-id-qualified rule list whose manifest matches its bytes", async () => {
		const text = fs.readFileSync(SHIPPED, "utf-8");
		const manifest = JSON.parse(
			fs.readFileSync(path.join(PACK_DIR, "manifest.json"), "utf-8"),
		) as {
			upstream: { repository: string; commit: string };
			ruleCount: number;
			rulesSha256: string;
		};
		const { createHash } = await import("node:crypto");
		expect(createHash("sha256").update(text).digest("hex")).toBe(
			manifest.rulesSha256,
		);
		const doc = load(text) as { rules: Array<{ id: string }> };
		expect(doc.rules).toHaveLength(manifest.ruleCount);
		expect(manifest.ruleCount).toBeGreaterThan(900);
		expect(manifest.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
		const ids = doc.rules.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		// Opengrep's directory-loaded id: path segments, then the rule's own id.
		for (const id of ids) expect(id.split(".").length).toBeGreaterThan(2);
	});

	// Recurrence: redistributing a rule the upstream marks proprietary, or a
	// registry (Semgrep Rules License) rule, inside the npm package.
	it("carries only rules under the admitted upstream licence, with the licence texts beside it", () => {
		const doc = load(fs.readFileSync(SHIPPED, "utf-8")) as {
			rules: Array<{ metadata?: { license?: string } }>;
		};
		const licences = new Set(doc.rules.map((r) => r.metadata?.license));
		for (const licence of licences) {
			expect([
				undefined,
				"Commons Clause License Condition v1.0[LGPL-2.1-only]",
			]).toContain(licence);
		}
		// Rule bodies only: the file's own header names the Semgrep Rules License
		// to say the pack predates it.
		const bodies = JSON.stringify(doc.rules);
		expect(bodies).not.toMatch(/proprietary/i);
		expect(bodies).not.toMatch(/Semgrep Rules License/);
		const commons = fs.readFileSync(path.join(PACK_DIR, "LICENSE"), "utf-8");
		expect(commons).toContain("“Commons Clause” License Condition v1.0");
		expect(commons).toContain("License: LGPL 2.1");
		expect(
			fs.readFileSync(path.join(PACK_DIR, "LGPL-2.1.txt"), "utf-8"),
		).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
		expect(fs.existsSync(path.join(PACK_DIR, "NOTICE"))).toBe(true);
	});

	// Recurrence: GitHub push protection (GH013, 2026-10-23) declined the first
	// push because the Slack rule's `pattern-not` placeholder has the shape of a
	// real webhook. The builder spells it with a YAML escape; the rule must still
	// carry the same string once parsed.
	it("holds no webhook-shaped literal, and the Slack rule keeps its placeholder after parsing", () => {
		const text = fs.readFileSync(SHIPPED, "utf-8");
		expect(text).not.toMatch(
			/https:\/\/hooks\.slack\.com\/services\/T\w{8,10}\/B\w{8,10}\/\w{24}/,
		);
		const doc = load(text) as {
			rules: Array<{ id: string; patterns?: Array<Record<string, string>> }>;
		};
		const slack = doc.rules.find((r) =>
			r.id.endsWith("detected-slack-webhook"),
		);
		expect(slack?.patterns?.[1]?.["pattern-not"]).toBe(
			"https://hooks.slack.com/services/T00000000/B00000000/" + "X".repeat(24),
		);
	});

	// Recurrence: an unbounded pack. The shipped file stays under 2.5 MB.
	it("is size-bounded and published in the package files list", () => {
		expect(fs.statSync(SHIPPED).size).toBeLessThan(2.5 * 1024 * 1024);
		const pkg = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
		) as { files: string[] };
		expect(pkg.files).toContain("vendor/opengrep-rules/");
	});
});

describe("rule file order: repo file, then cached pack, then shipped pack", () => {
	it("with no repo file and no cached pack, hands opengrep the shipped file, never `auto`", () => {
		const resolved = resolveOpengrepConfig(project, { enabled: true });
		expect(resolved.configArg).toBe(SHIPPED);
		expect(resolved.source).toBe("pack");
		expect(fs.existsSync(resolved.configArg)).toBe(true);
	});

	it("a cached pack supersedes the shipped one", () => {
		const cached = writeCachedPack();
		const resolved = resolveOpengrepConfig(project, { enabled: true });
		expect(resolved.configArg).toBe(cached);
		expect(resolved.configArg).toBe(
			path.join(home, "rules", "opengrep-registry.yaml"),
		);
	});

	it("an empty cached file is not a pack: the shipped one answers", () => {
		writeCachedPack("");
		expect(resolveOpengrepConfig(project, { enabled: true }).configArg).toBe(
			SHIPPED,
		);
	});

	it("a repo rule file wins over both the cached and the shipped pack", () => {
		writeCachedPack();
		const repoRules = path.join(project, ".opengrep.yml");
		fs.writeFileSync(repoRules, "rules: []\n");
		const resolved = resolveOpengrepConfig(project, { enabled: true });
		expect(resolved.configArg).toBe(repoRules);
		expect(resolved.source).toBe("local");
	});

	it("a user who types `--lens-opengrep-config auto` still gets what they asked for", () => {
		writeCachedPack();
		expect(
			resolveOpengrepConfig(project, { enabled: true, config: "auto" })
				.configArg,
		).toBe("auto");
	});
});

describe.skipIf(process.platform === "win32")(
	"the spawn the language server and the CLI scan actually make",
	() => {
		const launched: Array<{ process: { process: { kill(): boolean } } }> = [];
		let restorePath: (() => void) | undefined;

		afterEach(() => {
			for (const server of launched.splice(0)) server.process.process.kill();
			restorePath?.();
			restorePath = undefined;
		});

		/**
		 * The real `OpengrepServer.spawn` launches a real child: a PATH stub named
		 * `opengrep` that only stays alive (the process boundary). What is under
		 * test is the initialization the server hands it.
		 */
		async function spawnInitialization(): Promise<{
			scan: { configuration: string[] };
		}> {
			const stubDir = path.join(home, "stub-bin");
			fs.mkdirSync(stubDir, { recursive: true });
			const stub = path.join(stubDir, "opengrep");
			fs.writeFileSync(stub, "#!/bin/sh\nexec sleep 60\n");
			fs.chmodSync(stub, 0o755);
			restorePath ??= withEnv({
				PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
			});
			const server = await OpengrepServer.spawn(project, {
				allowInstall: false,
			});
			launched.push(server as never);
			return server?.initialization as { scan: { configuration: string[] } };
		}

		// Recurrence: #4765. `opengrepInitialization` handed `auto` to every spawn.
		it("OpengrepServer.spawn initializes with one local, existing rule file", async () => {
			const init = await spawnInitialization();
			expect(init.scan.configuration).toEqual([SHIPPED]);
			expect(init.scan.configuration).not.toContain("auto");
			expect(fs.existsSync(init.scan.configuration[0] as string)).toBe(true);
		});

		it("OpengrepServer.spawn prefers a cached pack, and a repo file over it", async () => {
			const cached = writeCachedPack();
			expect((await spawnInitialization()).scan.configuration).toEqual([
				cached,
			]);
			const repoRules = path.join(project, ".semgrep.yml");
			fs.writeFileSync(repoRules, "rules: []\n");
			expect((await spawnInitialization()).scan.configuration).toEqual([
				repoRules,
			]);
		});

		// Recurrence: #4765. The CLI scan (`lens_diagnostics mode=full`) carried its
		// own `?? "auto"` fallback beside the server's.
		it("the CLI scan passes the same local rule file to `opengrep scan --config`", async () => {
			const client = new OpengrepClient();
			client.ensureAvailable = vi.fn().mockResolvedValue(true);
			let argv: string[] = [];
			vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
				async (_command, args: string[]) => {
					argv = args;
					fs.writeFileSync(
						args[args.indexOf("--json-output") + 1] as string,
						JSON.stringify({ results: [], paths: { scanned: [] } }),
					);
					return { status: 0, stdout: "", stderr: "" };
				},
			);
			await client.scan(project);
			expect(argv[argv.indexOf("--config") + 1]).toBe(SHIPPED);
			expect(argv).not.toContain("auto");
		});
	},
);

describe("rule ids the CLI scan reports for pi-lens's own packs", () => {
	// Recurrence: #4765's first cut handed the CLI a path, and Opengrep's CLI
	// prefixes every rule id loaded from a file with that file's directory, so
	// `lens_diagnostics mode=full` showed `opengrep:home.u..pi-lens.rules.python...`
	// (an install path in a rule id, different on every machine) where `auto`
	// gave `opengrep:python.lang...`. The pair below is verbatim from
	// `opengrep scan --config <abs path>/rules/opengrep-registry.yaml` on 1.30.0.
	it("strips the config directory Opengrep 1.30.0 prefixes onto a rule id", () => {
		expect(
			stripPackRuleIdPrefix(
				"home.akis..local.share.pi-lens-orchestrator.tmp.4765-opengrep-pinned-rules.e2e-home.rules.python.lang.security.audit.eval-detected.eval-detected",
				"/home/akis/.local/share/pi-lens-orchestrator/tmp/4765-opengrep-pinned-rules/e2e-home/rules/opengrep-registry.yaml",
			),
		).toBe("python.lang.security.audit.eval-detected.eval-detected");
		expect(
			stripPackRuleIdPrefix(
				"python.lang.security.audit.eval-detected.eval-detected",
				"/home/u/.pi-lens/rules/opengrep-registry.yaml",
			),
		).toBe("python.lang.security.audit.eval-detected.eval-detected");
	});

	async function scanReporting(checkId: string) {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				fs.writeFileSync(
					args[args.indexOf("--json-output") + 1] as string,
					JSON.stringify({
						results: [
							{
								check_id: checkId,
								path: "a.py",
								start: { line: 2, col: 1 },
								end: { line: 2, col: 8 },
								extra: { message: "eval", severity: "WARNING" },
							},
						],
						errors: [],
						paths: { scanned: ["a.py"] },
					}),
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		return (await client.scan(project)).findings.map((f) => f.checkId);
	}

	it("the CLI scan reports the registry-form id for a pack, and leaves a repo file's ids alone", async () => {
		// Opengrep's prefix for the shipped pack: its directory, dot-joined.
		const shippedDir = path
			.dirname(SHIPPED)
			.replace(/^\//, "")
			.replaceAll("/", ".");
		const bare = "python.lang.security.audit.eval-detected.eval-detected";
		expect(await scanReporting(`${shippedDir}.${bare}`)).toEqual([bare]);

		// A repo's own rule file keeps the ids Opengrep gives it, prefix included
		// (pre-existing behaviour users' dispositions may already key on).
		fs.writeFileSync(path.join(project, ".opengrep.yml"), "rules: []\n");
		const projectDir = project.replace(/^\//, "").replaceAll("/", ".");
		expect(await scanReporting(`${projectDir}.repo-eval`)).toEqual([
			`${projectDir}.repo-eval`,
		]);
	});
});
