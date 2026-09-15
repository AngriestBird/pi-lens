import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	callSites,
	codeMatches,
	stripSource,
} from "../support/sweep-kit.js";
import {
	KNOWN_FIXTURE_EMAILS,
	KNOWN_FIXTURE_NAMES,
} from "../support/git-config-guard.js";

const directGitSpawn =
	/\b(execSync|execFileSync|spawnSync|spawn|execFile|safeSpawnAsync)\s*\(\s*["'`]git\b/g;
const helperImport =
	/import\s*{([^}]+)}\s*from\s*["'`][^"'`]*git-fixture-env/gs;

const OWN_IMPLEMENTATION_FILES = [
	"tests/config/git-fixture-governance.test.ts",
	"tests/support/git-fixture-env.ts",
	"scripts/lib/git-fixture-env.mjs",
] as const;
// Scripts that drive the developer's REAL repository rather than a throwaway
// fixture repo. git-fixture-env exists to scrub GIT_* and pin
// GIT_CONFIG_GLOBAL at `<cwd>/gitconfig` so a fixture never reads the
// developer's config — exactly the wrong environment for a script whose whole
// job is to operate on this checkout (#2435: safe.directory, credential and
// alias config all have to apply).
const NOT_A_FIXTURE = [
	"scripts/pre-push-targeted-tests.mjs",
	"scripts/prune-agent-worktrees.mjs",
	// #2698: reads THIS checkout's own `git ls-files` state (untracked+
	// ignored .js siblings, tracked .ts sources) before `knip` runs — same
	// "drives the real repo" shape as the two scripts above, not a fixture.
	"scripts/lib/knip-sibling-purge.mjs",
	// #2758: runs `git diff` on the real CI checkout to find changed files
	// for Stryker mutation testing — drives the real checkout, not a fixture.
	"scripts/stryker-diff.mjs",
] as const;

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Every callee that can put a `git` process on the end of an argument list:
 * the raw child_process entry points {@link directGitSpawn} already knows,
 * plus the three git-fixture-env wrappers a compliant test uses. Anchored so
 * `spawn` cannot claim `spawnSync`'s call sites (sweep-kit requires the whole
 * simple name to match).
 */
const GIT_SPAWN_CALLEE =
	/^(?:gitExecFileSync|gitExecSync|gitFixtureSpawnAsync|execFileSync|execSync|spawnSync|safeSpawnAsync|execFile|spawn)$/;

/**
 * A LITERAL Git object name in argument position: 7-40 lowercase hex
 * characters that are not part of a longer word -- standing alone
 * (`["checkout", "ca26395", "--"]`) or carrying a `:path`/`^`/`~` suffix
 * (`["show", "20896a56b:tests/x.test.ts"]`).
 *
 * LITERAL is the whole discriminator. A fixture repo's own commit is read
 * back at RUNTIME (`rev-parse HEAD` into a variable) and reaches the spawn
 * as `${sha}`, which this needle deliberately does not match; only a sha
 * typed into the source can name an object in THIS repository's history.
 */
const LITERAL_COMMIT_ISH = /(?<![\w.$-])[0-9a-f]{7,40}(?![\w.$-])/g;

/**
 * Does this call site actually run `git`? Either the callee is one of the
 * git-fixture-env wrappers (which spawn nothing else), or the first argument
 * is a `git` command word -- `execFileSync("git", [...])`,
 * `execSync("git show ...")`, `execFileSync("/usr/bin/git", [...])`.
 */
function isGitSpawnSite(callee: string, argsText: string): boolean {
	if (callee.startsWith("git")) return true;
	return /^\s*["'`](?:[^"'`\s]*[\\/])?git(?:["'`]|\s)/.test(argsText);
}

/**
 * #3050 / #3066 round 1 (`ca26395`): a `git show <sha>:<path>` at MODULE
 * SCOPE in `tests/clients/pi-lens-home-hermeticity.test.ts`. `.github/
 * workflows/ci.yml`'s `test` job checks out with no `fetch-depth` override,
 * which is depth 1, so the object is unreachable on CI: the call throws
 * during collection and the whole file yields ZERO tests -- silently taking
 * three pre-existing #525 cases with it. The remedy round 2 shipped is to
 * commit the content as a fixture under `tests/fixtures/` and read it.
 *
 * Detector policy, per needle (AGENTS.md "Detectors match code, not prose"):
 * comments BLANKED, string contents KEPT. The evidence is itself a string
 * literal -- a commit-ish reaches a spawn only as a quoted argument -- so
 * the `"blank"` policy would erase the only thing there is to see, the same
 * reason the sibling `directGitSpawn` row in this file scans with
 * `strings: "keep"`. A sha QUOTED IN PROSE (`// like git show ca26395:x`)
 * is blanked and cannot flag: a comment never satisfies this guard, which is
 * the dangerous direction. The residual false positive -- a delimited 7-40
 * hex run inside some other string in a git spawn's own argument list --
 * reds loudly and is the safe direction.
 *
 * Named limits: a commit-ish assembled through a variable or a template
 * expression is invisible to a text needle (that spelling is also how a
 * legitimate FIXTURE sha arrives, so the needle cannot tell them apart from
 * text alone), and an UPPERCASE hex object name is not matched -- enumerating
 * spellings is its own defect shape, and git writes lowercase.
 */
export function findHistoricalCommitIshOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	const offenders: string[] = [];
	for (const { file, source } of files) {
		const relativeFile = repoRelative(file);
		if (
			OWN_IMPLEMENTATION_FILES.includes(
				relativeFile as (typeof OWN_IMPLEMENTATION_FILES)[number],
			)
		)
			continue;
		// Cheap admission: parsing every file under tests/ with ast-grep to
		// find call sites would cost hundreds of parses (and the peak RSS the
		// #3062 budget gate measures) for a needle almost no file carries.
		LITERAL_COMMIT_ISH.lastIndex = 0;
		if (!LITERAL_COMMIT_ISH.test(stripSource(source, { strings: "keep" })))
			continue;
		for (const site of callSites(source, GIT_SPAWN_CALLEE)) {
			if (!isGitSpawnSite(site.callee, site.argsText)) continue;
			const args = stripSource(site.argsText, { strings: "keep" });
			LITERAL_COMMIT_ISH.lastIndex = 0;
			for (const match of args.matchAll(LITERAL_COMMIT_ISH)) {
				offenders.push(`${relativeFile}:${site.line} ${match[0]}`);
			}
		}
	}
	return offenders;
}


function repoRelative(file: string): string {
	if (!path.isAbsolute(file)) return file.replaceAll("\\", "/");
	return path.relative(REPO_ROOT, file).replaceAll("\\", "/");
}

export function isExpectedScriptExemption(file: string): boolean {
	return NOT_A_FIXTURE.includes(
		repoRelative(file) as (typeof NOT_A_FIXTURE)[number],
	);
}

export function findGitSpawnOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	return files
		.filter(({ file, source }) => {
			directGitSpawn.lastIndex = 0;
			const relativeFile = repoRelative(file);
			if (
				OWN_IMPLEMENTATION_FILES.includes(
					relativeFile as (typeof OWN_IMPLEMENTATION_FILES)[number],
				)
			)
				return false;
			const sourceKeep = stripSource(source, { strings: "keep" });
			const imported = new Set<string>();
			for (const match of codeMatches(source, helperImport)) {
				for (const item of match[1].split(",")) {
					imported.add(item.trim().split(/\s+as\s+/)[0] ?? "");
				}
			}
			for (const match of sourceKeep.matchAll(directGitSpawn)) {
				if (!imported.has(match[1])) return true;
			}
			return false;
		})
		.map(({ file }) => file);
}

function fixtureIdentityWrites(
	files: ReadonlyArray<{ file: string; source: string }>,
): Array<{ file: string; kind: "name" | "email"; value: string }> {
	const writes: Array<{
		file: string;
		kind: "name" | "email";
		value: string;
	}> = [];
	const literal =
		/\buser\.(name|email)(?:["']\s*,\s*["']([^"']+)["']|\s+["']([^"']+)["']|\s+([^\s"'`,}\]]+))/g;
	for (const { file, source } of files) {
		for (const line of source.split(/\r?\n/)) {
			if (!/\bconfig\b/.test(line)) continue;
			literal.lastIndex = 0;
			for (const match of line.matchAll(literal)) {
				const value = match[2] ?? match[3] ?? match[4];
				if (value)
					writes.push({ file, kind: match[1] as "name" | "email", value });
			}
		}
	}
	return writes;
}

function walkFiles(
	root: string,
	matches: (name: string) => boolean,
): Array<{ file: string; source: string }> {
	const files: Array<{ file: string; source: string }> = [];
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (matches(entry.name))
				files.push({ file, source: fs.readFileSync(file, "utf8") });
		}
	}
	walk(root);
	return files;
}

function testFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".test.ts"));
}

/**
 * Every TypeScript file under tests/, not only the collected `*.test.ts`
 * ones: a module-scope spawn in a `tests/support/` helper collapses every
 * file that imports it, which is the same zero-collected-tests outcome
 * {@link findHistoricalCommitIshOffenders} exists to prevent.
 */
function testTypeScriptFiles(
	root: string,
): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".ts"));
}

/**
 * scripts/**\/*.mjs is a second population that can spawn a bare `git`
 * process (#2163 F7): standalone smoke/compat scripts, not vitest tests.
 * Walked separately because it lives outside tests/ and uses the .mjs
 * fixture helper (scripts/lib/git-fixture-env.mjs) rather than the .ts one.
 */
function scriptFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".mjs"));
}

describe("real Git fixture governance", () => {
	it("routes every direct Git spawn through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			testFiles(path.resolve(__dirname, "..")),
		);
		expect(
			offenders,
			`Bare Git spawns found:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("routes every direct Git spawn in scripts/**/*.mjs through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			scriptFiles(path.resolve(__dirname, "../../scripts")),
		);
		const REMAINING_OFFENDERS: string[] = [];
		const unexpected = offenders.filter(
			(file) =>
				!REMAINING_OFFENDERS.includes(repoRelative(file)) &&
				!isExpectedScriptExemption(file),
		);
		expect(
			unexpected,
			`Unexpected bare Git spawns found:\n${unexpected.join("\n")}`,
		).toEqual([]);
	});

	it("anchors script exemptions to the repository-relative path", () => {
		expect(
			isExpectedScriptExemption("scripts/pre-push-targeted-tests.mjs"),
		).toBe(true);
		expect(
			isExpectedScriptExemption("scripts/zzdir/pre-push-targeted-tests.mjs"),
		).toBe(false);
	});

	it("keeps every literal fixture Git identity in the guard sets", () => {
		const files = [
			...walkFiles(
				path.resolve(__dirname, ".."),
				(name) => name.endsWith(".ts") || name.endsWith(".mts"),
			),
			...walkFiles(path.resolve(__dirname, "../../scripts"), (name) =>
				name.endsWith(".mjs"),
			),
		];
		const unknown = fixtureIdentityWrites(files).filter(
			({ kind, value }) =>
				(kind === "name" ? KNOWN_FIXTURE_NAMES : KNOWN_FIXTURE_EMAILS).has(
					value,
				) === false,
		);
		expect(unknown).toEqual([]);
	});

	it("detects a synthetic bare Git offender", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: 'execFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("rejects a helper mention that does not import or call the helper", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: '// git-fixture-env\nexecFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("does not let a string literal import excuse a bare Git spawn", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						"const prose = \"import { execFileSync } from './git-fixture-env.js'\";\n" +
						"execFile" +
						'Sync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("does not let a commented-out import excuse a bare Git spawn", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'// import { execFileSync } from "./git-fixture-env.js";\n' +
						"execFile" +
						'Sync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("finds a real import after a commented-out import", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'// import { execFileSync } from "./git-fixture-env.js";\n' +
						'import { execFileSync } from "./git-fixture-env.js";\n' +
						"execFile" +
						'Sync("git", ["status"])',
				},
			]),
		).toEqual([]);
	});

	it("rejects a direct call when a different helper symbol is imported", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'import { gitExecSync } from "./git-fixture-env.js";\nexecFileSync("git", [])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("pins no historical commit-ish in any tests/ Git spawn", () => {
		const offenders = findHistoricalCommitIshOffenders(
			testTypeScriptFiles(path.resolve(__dirname, "..")),
		);
		expect(
			offenders,
			"A tests/ Git spawn names a commit from this repository's history.\n" +
				"CI checks out at depth 1 (.github/workflows/ci.yml's test job sets no\n" +
				"fetch-depth), so the object is unreachable there: at module scope the\n" +
				"call throws during collection and the file yields ZERO tests (#3066\n" +
				"round 1, ca26395). Commit the content as a fixture under tests/fixtures/\n" +
				"and read it back instead:\n" +
				offenders.join("\n"),
		).toEqual([]);
	});

	it("detects the #3066 round 1 shape: git show <sha>:<path> through the fixture wrapper", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'const PRE = gitExecFileSync("git", [\n' +
						'  "show",\n' +
						'  "20896a56b:tests/index-vanished-instance-wiring.test.ts",\n' +
						'], { cwd: REPO_ROOT, encoding: "utf8" });',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 20896a56b"]);
	});

	it("detects a bare commit-ish argument, not only the <sha>:<path> form", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'execFileSync("git", ["checkout", "ca2639524", "--", "clients/x.ts"]);',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 ca2639524"]);
	});

	it("does not let a comment INSIDE the argument list trip the guard", () => {
		// The shape the #3066 round 2 remedy leaves behind: the spawn is gone,
		// but a comment in the surviving call still quotes the sha the fixture
		// was taken at. A comment is prose, never an argument.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'gitExecFileSync("git", [\n' +
						'  "show",\n' +
						"  // was \"20896a56b:tests/index-vanished-instance-wiring.test.ts\"\n" +
						'  `${fixtureSha}:src/a.ts`,\n' +
						"]);",
				},
			]),
		).toEqual([]);
	});

	it("leaves a fixture repo's own runtime sha alone", () => {
		// The legitimate population this guard must not touch: a sha the test
		// itself created and read back at runtime is reachable everywhere,
		// depth-1 CI checkout included.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'const sha = gitExecSync("git rev-parse HEAD", { cwd: fixture }).trim();\n' +
						'gitExecFileSync("git", ["show", `${sha}:src/a.ts`], { cwd: fixture });',
				},
			]),
		).toEqual([]);
	});

	it("does not flag a hex argument to a spawn that is not git", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source: 'execFileSync("node", ["-e", "console.log(\'deadbeef1\')"]);',
				},
			]),
		).toEqual([]);
	});

	it("scans a non-empty tests/**/*.ts population, helpers included", () => {
		const files = testTypeScriptFiles(path.resolve(__dirname, "..")).map(
			({ file }) => repoRelative(file),
		);
		// Calibration: 400 is the same documented floor the *.test.ts walk
		// below uses; this population is a superset of it (#3050).
		assertNonEmptyScan("historical commit-ish sweep", files.length, 400);
		// The superset is the point, not an accident: a module-scope spawn in
		// a tests/support helper takes every file that imports it down with
		// it, so the walk must reach past the collected *.test.ts files.
		expect(files).toContain("tests/support/git-fixture-env.ts");
	});

	it("scans a non-empty source population", () => {
		const files = testFiles(path.resolve(__dirname, ".."));
		// Calibration: 807 *.test.ts files under tests/ on 2026-08-26 (fix round
		// 2). Half is 403.5; 400 is the documented floor so the walk still fails
		// loud if the tests/ tree collapses, without pinning to the exact count.
		assertNonEmptyScan("git fixture governance sweep", files.length, 400);
	});

	it("scans a non-empty scripts/**/*.mjs population", () => {
		const files = scriptFiles(path.resolve(__dirname, "../../scripts"));
		// Calibration: 60+ *.mjs files under scripts/ on 2026-08-26 (fix round
		// 2); 30 is a floor well below that, well above zero.
		assertNonEmptyScan(
			"git fixture governance scripts sweep",
			files.length,
			30,
		);
	});
});
