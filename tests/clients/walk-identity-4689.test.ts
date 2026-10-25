/**
 * #4689 item 6, the non-LSP half: the shared upward walk (`walkUpDirs`,
 * `findNearestContaining`, `findLocalToolConfig`) climbs the file's PATH
 * IDENTITY, and every other end of a walk (the home ceiling, a project root)
 * is compared on the axis the walk climbs.
 *
 * Shape (AGENTS.md shape 1, divergent path keys), the walk-start member: a
 * walk climbed from the spelling while the keys, the dispatch context and the
 * home it compared against were identities, or the reverse. `pkg-a/lib` is a
 * link to `pkg-b/lib` and `pkg-a/src/blink.ts` a link to `pkg-b/b.ts`; a walk
 * from either spelling reached `pkg-a`'s config for a file that is
 * `pkg-b`'s. A directory realpath does not follow a FILE link, so the walks
 * that start from a file take that file's identity.
 *
 * The walks that stay on the spelling by design (`configRootOnFileSpelling`,
 * the git checkout's `spelledRoot`, the project-local bin resolver and its
 * trust classifier) are pinned here or by their own suites (#4734, #3872).
 *
 * Every cell builds its tree from the #4689 symlinked-fixture family
 * (`createPathIdentityFixture`, `plantPackageLink`); a host that cannot create
 * symlinks skips visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { createDispatchContext } from "../../clients/dispatch/dispatcher.js";
import { AUXILIARY_LSP_PROFILES } from "../../clients/dispatch/auxiliary-lsp.js";
import { configSearchDirs } from "../../clients/config-locations.js";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";
import { resolvePiLensFlagWithSource } from "../../clients/lens-config.js";
import {
	type LensFlagSpec,
	getLensFlagSpec,
} from "../../clients/lens-flag-registry.js";
import {
	findLocalBinUpwards,
	isProjectLocalBinPath,
} from "../../clients/package-manager.js";
import {
	findLocalToolConfig,
	isAtOrAboveHomeDir,
} from "../../clients/path-utils.js";
import { runAutofix } from "../../clients/pipeline.js";
import {
	findNestedProjectMutationValue,
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	detectPythonEnvironment,
	detectPythonTargetVersion,
} from "../../clients/python-environment.js";
import { findLocalTyposConfig } from "../../clients/typos-config.js";
import { findGoverningTsconfigDir } from "../../clients/workspace-topology.js";
import {
	createPathIdentityFixture,
	plantPackageLink,
	setupTestEnvironment,
} from "./test-utils.js";

const spawned = vi.hoisted(() => ({ cwds: [] as string[] }));
// Process boundary only: `cargo` and `dart` are not on the CI image, so their
// `--version` probes answer "installed" and the fix run records its cwd.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: async (
			command: string,
			args: string[],
			options: { cwd?: string } = {},
		) => {
			if (command !== "cargo" && command !== "dart")
				return actual.safeSpawnAsync(command, args, options);
			if (args[0] !== "--version") spawned.cwds.push(options.cwd ?? "");
			return { status: 0, stdout: `${command} 1.0`, stderr: "" };
		},
	};
});

const noAutoformat = getLensFlagSpec("no-autoformat") as LensFlagSpec;
const real = (p: string): string => fs.realpathSync.native(p);

interface Tree {
	base: string;
	repo: string;
	alias: string;
	pkgA: string;
	pkgB: string;
	fileLink: string;
	realFile: string;
	dirLink: string;
	libFile: string;
	outLink: string;
	skipReason?: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	resetProjectLensConfigCache();
	resetProjectTrust();
	spawned.cwds.length = 0;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tree(prefix: string): Tree {
	const env = setupTestEnvironment(`pi-lens-4689-walk-${prefix}-`);
	cleanups.push(env.cleanup);
	const fx = createPathIdentityFixture(env.tmpDir);
	const pkg = plantPackageLink(fx.repo);
	const skipReason = fx.skipReason ?? pkg.skipReason;
	return {
		base: env.tmpDir,
		repo: fx.repo,
		alias: fx.aliasRoot,
		pkgA: pkg.pkgA,
		pkgB: pkg.pkgB,
		fileLink: pkg.fileLink,
		realFile: pkg.realFile,
		dirLink: pkg.dirLink,
		libFile: pkg.libFile,
		outLink: fx.outLink,
		...(skipReason !== undefined && { skipReason }),
	};
}

/** The same path spelled through the alias root. */
function viaAlias(t: Tree, p: string): string {
	return path.join(t.alias, path.relative(t.repo, p));
}

function writeConfig(dir: string, value: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(value));
}

/** A file in `pkg-a/src` that is a link to the same-named file in `pkg-b`. */
function linkIntoPkgB(t: Tree, name: string, body: string): string {
	fs.writeFileSync(path.join(t.pkgB, name), body);
	const link = path.join(t.pkgA, "src", name);
	fs.symlinkSync(path.join("..", "..", "pkg-b", name), link, "file");
	return link;
}

describe("#4689 item 6: the shared walk climbs the path identity", () => {
	it("a config finder reached through a directory link finds the target package's config", (ctx) => {
		// RECURRENCE GUARDED: `walkUpDirs` started at `path.resolve(startDir)`,
		// so a start spelled through `pkg-a/lib -> pkg-b/lib` climbed `pkg-a`
		// and returned `pkg-a`'s typos config for a directory of `pkg-b`.
		const t = tree("finder");
		if (t.skipReason) return ctx.skip(t.skipReason);
		fs.writeFileSync(path.join(t.pkgA, "typos.toml"), "# a\n");
		fs.writeFileSync(path.join(t.pkgB, "typos.toml"), "# b\n");
		const expected = path.join(real(t.pkgB), "typos.toml");
		expect({
			throughLink: findLocalTyposConfig(t.dirLink),
			throughTarget: findLocalTyposConfig(path.join(t.pkgB, "lib")),
		}).toEqual({ throughLink: expected, throughTarget: expected });
	});

	it("a link-spelled session root discovers the project config above the real root", (ctx) => {
		// RECURRENCE GUARDED: `configSearchDirs` climbed the alias's parents,
		// so a session opened through `elsewhere/alias -> mono/repo` never saw
		// `mono/.pi-lens.json`, which the real spelling of the same root reads.
		const env = setupTestEnvironment("pi-lens-4689-walk-mono-");
		cleanups.push(env.cleanup);
		const mono = path.join(env.tmpDir, "mono");
		const repo = path.join(mono, "repo");
		const alias = path.join(env.tmpDir, "elsewhere", "alias");
		fs.mkdirSync(repo, { recursive: true });
		fs.mkdirSync(path.dirname(alias), { recursive: true });
		try {
			fs.symlinkSync(repo, alias, "dir");
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		writeConfig(mono, { rules: { "high-complexity": { threshold: 3 } } });
		const threshold = (root: string) =>
			loadPiLensProjectConfig(root).rules["high-complexity"]?.threshold;
		expect({ real: threshold(repo), alias: threshold(alias) }).toEqual({
			real: 3,
			alias: 3,
		});
	});

	it("a write through a directory link dispatches in the target package", (ctx) => {
		// RECURRENCE GUARDED: `handleToolResult` derives the dispatch cwd with
		// `resolveLanguageRootForFile(spelling, workspace)`; a spelled walk gave
		// `pkg-a`, and `createDispatchContext` then clamped the identity's
		// `pkg-b` under it, so `ctx.cwd` (project config, the auxiliary
		// servers' blocking gate) was the other package's.
		const t = tree("dispatch-dir");
		if (t.skipReason) return ctx.skip(t.skipReason);
		fs.writeFileSync(path.join(t.pkgB, "typos.toml"), "# b\n");
		const spelled = path.join(t.dirLink, "lib.ts");
		const dispatched = createDispatchContext(
			spelled,
			resolveLanguageRootForFile(spelled, t.repo),
			{ getFlag: () => false },
			new FactStore("4689-walk"),
		);
		const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos");
		expect({
			cwd: dispatched.cwd,
			typosMayBlock: typos?.allowBlocking?.(dispatched.cwd),
		}).toEqual({ cwd: real(t.pkgB), typosMayBlock: true });
	});

	it("a write through a file link dispatches in the target package", (ctx) => {
		// RECURRENCE GUARDED: the directory of a FILE link is a real directory,
		// so a start realpath alone still climbs `pkg-a/src`; the language root
		// walk takes the file's identity before it takes the directory.
		const t = tree("dispatch-file");
		if (t.skipReason) return ctx.skip(t.skipReason);
		expect({
			throughLink: resolveLanguageRootForFile(t.fileLink, t.repo),
			throughTarget: resolveLanguageRootForFile(t.realFile, t.repo),
		}).toEqual({ throughLink: real(t.pkgB), throughTarget: real(t.pkgB) });
	});

	it("a nested mutation config applies to a file reached through a file link", (ctx) => {
		// RECURRENCE GUARDED: `findNestedProjectMutationValue` climbed the
		// link's directory, so `pkg-b`'s `format.enabled: false` did not stop
		// the formatter for `pkg-b/b.ts` written as `pkg-a/src/blink.ts`.
		const t = tree("nested-file");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.pkgB, { format: { enabled: false } });
		const nested = (file: string) =>
			findNestedProjectMutationValue(noAutoformat, file, t.repo);
		expect({
			throughLink: nested(t.fileLink),
			throughTarget: nested(t.realFile),
		}).toEqual({
			throughLink: { value: false, dir: real(t.pkgB) },
			throughTarget: { value: false, dir: real(t.pkgB) },
		});
	});

	it("a nested mutation config applies under a link-spelled project root", (ctx) => {
		// RECURRENCE GUARDED: the walk's root bound compared the climbed
		// directory with the root's spelling, so a file under an alias-spelled
		// root (or the reverse) was outside the root at its first step and its
		// package's config was never read.
		const t = tree("nested-alias");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.pkgB, { format: { enabled: false } });
		expect({
			realFileAliasRoot: findNestedProjectMutationValue(
				noAutoformat,
				t.realFile,
				t.alias,
			),
			aliasFileRealRoot: findNestedProjectMutationValue(
				noAutoformat,
				viaAlias(t, t.realFile),
				t.repo,
			),
		}).toEqual({
			realFileAliasRoot: { value: false, dir: real(t.pkgB) },
			aliasFileRealRoot: { value: false, dir: real(t.pkgB) },
		});
	});

	it("the root's own config keeps the project source under a link-spelled root", (ctx) => {
		// RECURRENCE GUARDED: `resolvePiLensFlagWithSource` labels a value found
		// at the project root `project` by comparing the walk's directory with
		// the root; an identity directory against an alias spelling read as a
		// nested project.
		const t = tree("nested-label");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.repo, { format: { enabled: false } });
		const resolved = resolvePiLensFlagWithSource(
			"no-autoformat",
			false,
			undefined,
			loadPiLensProjectConfig(t.alias),
			viaAlias(t, t.realFile),
			t.alias,
		);
		expect(resolved).toEqual({ value: true, source: "project" });
	});

	it("a python target version is read from the linked file's own project", async (ctx) => {
		// RECURRENCE GUARDED: `detectPythonTargetVersion` climbed the link's
		// directory and took `pkg-a`'s `requires-python` for a `pkg-b` module.
		const t = tree("python");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const pyproject = (v: string) =>
			`[project]\nname = "x"\nrequires-python = ">=${v}"\n`;
		fs.writeFileSync(path.join(t.pkgA, "pyproject.toml"), pyproject("3.9"));
		fs.writeFileSync(path.join(t.pkgB, "pyproject.toml"), pyproject("3.12"));
		const link = linkIntoPkgB(t, "m.py", "x = 1\n");
		const version = async (file: string) => {
			const found = await detectPythonTargetVersion(file);
			return found && `${found.major}.${found.minor}`;
		};
		expect({
			throughLink: await version(link),
			throughTarget: await version(path.join(t.pkgB, "m.py")),
		}).toEqual({ throughLink: "3.12", throughTarget: "3.12" });
	});

	it("a uv workspace member under a link-spelled root keeps its workspace environment", async (ctx) => {
		// RECURRENCE GUARDED: `detectPythonEnvironment` compares the walk's
		// nearest project with its own start (`isStartDir`); a start spelled
		// through the alias against a walk that climbs the identity never
		// matched, so the member lost the workspace `.venv`.
		const t = tree("uv");
		if (t.skipReason) return ctx.skip(t.skipReason);
		setProjectTrustState("trusted");
		fs.writeFileSync(
			path.join(t.repo, "pyproject.toml"),
			'[project]\nname = "ws"\n\n[tool.uv.workspace]\nmembers = ["pkg-b"]\n',
		);
		fs.writeFileSync(
			path.join(t.pkgB, "pyproject.toml"),
			'[project]\nname = "b"\n',
		);
		const venvBin = path.join(t.repo, ".venv", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		fs.writeFileSync(path.join(venvBin, "python"), "");
		const env = await detectPythonEnvironment(viaAlias(t, t.pkgB), t.base, {
			allowAmbient: false,
		});
		expect(env?.source).toBe("uv-workspace");
	});

	const wholePackageFixers: Array<[string, string, string, string]> = [
		["cargo clippy --fix", "Cargo.toml", '[package]\nname = "x"\n', "f.rs"],
		["dart fix --apply", "pubspec.yaml", "name: x\n", "f.dart"],
	];
	it.for(wholePackageFixers)(
		"%s for a linked file runs in the file's own package",
		async ([, manifest, body, name], ctx) => {
			// RECURRENCE GUARDED: `tryRustClippyFix` and `tryDartFix` found the
			// manifest from the link's directory, so the whole-package fixer
			// rewrote `pkg-a` for a `pkg-b` source written through `pkg-a/src`.
			const t = tree(manifest.replace(/\W/g, ""));
			if (t.skipReason) return ctx.skip(t.skipReason);
			fs.writeFileSync(path.join(t.pkgA, manifest), body);
			fs.writeFileSync(path.join(t.pkgB, manifest), body);
			const link = linkIntoPkgB(t, name, "main() {}\n");
			// The cwd `handleToolResult` hands the pipeline for this spelling.
			await runAutofix(
				link,
				resolveLanguageRootForFile(link, t.repo),
				() => false,
				() => {},
				{
					biomeClient: {} as never,
					ruffClient: {} as never,
					fixedThisTurn: new Set<string>(),
				},
				undefined,
				undefined,
				t.repo,
			);
			expect(spawned.cwds).toEqual([real(t.pkgB)]);
		},
	);
});

describe("#4689 item 6: a home ceiling is compared on the axis the walk climbs", () => {
	// RECURRENCE GUARDED: the walks start at an identity (the dispatch context
	// has carried one since #4712) while each compared the climbed directory
	// with the home's SPELLING. With `$HOME` a link (`home-link -> home-real`)
	// the identity walk never met the spelled home and read configs in and
	// above the real home: the #622/#625 adoption the ceiling exists to stop.
	function homeTree(ctx: { skip: (note?: string) => void }) {
		const env = setupTestEnvironment("pi-lens-4689-walk-home-");
		cleanups.push(env.cleanup);
		const homeReal = path.join(env.tmpDir, "home-real");
		const homeLink = path.join(env.tmpDir, "home-link");
		const src = path.join(homeReal, "proj", "src");
		fs.mkdirSync(src, { recursive: true });
		try {
			fs.symlinkSync(homeReal, homeLink, "dir");
		} catch (err) {
			ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		// One marker of each walk's kind at the home itself, none below it.
		fs.writeFileSync(path.join(homeReal, "typos.toml"), "");
		fs.writeFileSync(path.join(homeReal, "tsconfig.json"), "{}");
		fs.writeFileSync(
			path.join(homeReal, "pyproject.toml"),
			'[project]\nname = "h"\nrequires-python = ">=3.8"\n',
		);
		fs.writeFileSync(path.join(src, "m.py"), "x = 1\n");
		return { homeReal, homeLink, src };
	}

	/** Each row answers whether the walk reached the home or above it. */
	const rows: Array<
		[
			string,
			(start: string, home: string, homeReal: string) => Promise<boolean>,
		]
	> = [
		[
			"configSearchDirs",
			async (start, home, homeReal) =>
				configSearchDirs(start, home).some((dir) =>
					isAtOrAboveHomeDir(dir, real(homeReal)),
				),
		],
		[
			"findLocalToolConfig({ homeDir })",
			async (start, home) =>
				findLocalToolConfig(start, ["typos.toml"], { homeDir: home }) !==
				undefined,
		],
		[
			"findGoverningTsconfigDir (workspace topology)",
			async (start, home) =>
				findGoverningTsconfigDir(start, home) !== undefined,
		],
		[
			"detectPythonTargetVersion",
			async (start, home) =>
				(await detectPythonTargetVersion(path.join(start, "m.py"), home)) !==
				undefined,
		],
	];

	it.for(rows)(
		"%s stops at a link-spelled home under either start spelling",
		async ([, crossed], ctx) => {
			const { homeReal, homeLink, src } = homeTree(ctx);
			const viaLink = path.join(homeLink, path.relative(homeReal, src));
			expect({
				realStart: await crossed(src, homeLink, homeReal),
				linkStart: await crossed(viaLink, homeLink, homeReal),
			}).toEqual({ realStart: false, linkStart: false });
		},
	);
});

describe("#4689 item 6: the project-local bin resolver and its classifier stay on the spelling", () => {
	it("a project shim spelled through a link-spelled root is still project-local", (ctx) => {
		// RECURRENCE GUARDED: the resolver and the trust classifier must climb
		// on ONE axis (#2556 trust inputs). An identity bin directory holds
		// neither the alias spelling of `node_modules/.bin/tool` nor its
		// identity (the shim's target), so `isProjectLocalBinPath` answered
		// false for the project's own binary and the trust refusal that keys on
		// it stopped applying.
		const t = tree("bins");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const bin = path.join(t.repo, "node_modules", ".bin");
		const pkg = path.join(t.repo, "node_modules", "tool");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(path.join(pkg, "cli.js"), "#!/usr/bin/env node\n");
		fs.symlinkSync(path.join("..", "tool", "cli.js"), path.join(bin, "tool"));
		setProjectTrustState("trusted");
		const found = findLocalBinUpwards("tool", t.alias);
		expect({
			found,
			shimIsLocal: isProjectLocalBinPath(
				path.join(t.alias, "node_modules", ".bin", "tool"),
				t.alias,
			),
			foundIsLocal:
				typeof found === "string" && isProjectLocalBinPath(found, t.alias),
		}).toEqual({
			found: path.join(t.alias, "node_modules", ".bin", "tool"),
			shimIsLocal: true,
			foundIsLocal: true,
		});
	});
});
