import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_PROVIDED_PACKAGES } from "../../scripts/lib/host-provided-deps.mjs";
import {
	appendBounded,
	buildStubAliases,
	INSTALL_LOG_MAX_LINES,
	resolveJitiCacheDir,
	STUB_TARGET,
	warmSkipReason,
} from "../../scripts/lib/warm-loader-cache.mjs";

// #1926 remainder. pi loads pi-lens through jiti, which Babel-transforms the
// ~4MB dist bundle and caches the result. The first session after a `git:`
// install paid that transform: 4847ms of `module import`, against 138ms once
// warm. `prepare` now runs the same transform, writing the same cache entry.
// These tests pin the three things the warm has to agree with pi about — the
// cache directory, the entry path, and the best-effort posture — plus the
// prepare-chain ordering that keeps the load-bearing steps load-bearing.

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	scripts?: Record<string, string>;
	files?: string[];
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	pi?: { extensions?: string[] };
};
const warmScript = fs.readFileSync(
	path.join(root, "scripts", "warm-loader-cache.mjs"),
	"utf8",
);

describe("jiti cache directory mirrors pi's loader (#1926)", () => {
	const join = (a: string, b: string) => `${a}/${b}`;

	it("uses <tmpdir>/jiti, the branch pi's loader always lands on", () => {
		// pi creates its jiti from dist/core/extensions/loader.js, which has no
		// node_modules sibling, so jiti falls through to the tmpdir branch. A warm
		// that wrote anywhere else would build a private cache pi never reads.
		const dir = resolveJitiCacheDir({
			tmpdir: () => "/tmp",
			env: {},
			cwd: () => "/somewhere/else",
			join,
		});
		expect(dir).toBe("/tmp/jiti");
	});

	it("re-reads tmpdir with TMPDIR removed when TMPDIR is the cwd", () => {
		// jiti's own quirk, mirrored verbatim: when TMPDIR points at the current
		// directory it ignores it. Diverging here would put the warm's cache and
		// pi's cache in different places on exactly those machines.
		const env: Record<string, string | undefined> = { TMPDIR: "/work" };
		let call = 0;
		const dir = resolveJitiCacheDir({
			tmpdir: () => (++call === 1 ? "/work" : "/real-tmp"),
			env,
			cwd: () => "/work",
			join,
		});
		expect(dir).toBe("/real-tmp/jiti");
		expect(env.TMPDIR, "TMPDIR must be restored").toBe("/work");
	});

	it("honours JITI_RESPECT_TMPDIR_ENV, as jiti does", () => {
		const dir = resolveJitiCacheDir({
			tmpdir: () => "/work",
			env: { TMPDIR: "/work", JITI_RESPECT_TMPDIR_ENV: "1" },
			cwd: () => "/work",
			join,
		});
		expect(dir).toBe("/work/jiti");
	});

	it("the script passes the mirrored directory explicitly", () => {
		// Letting jiti derive the directory from this script's location would work
		// only while the script sits in a directory with no node_modules sibling.
		expect(warmScript).toContain("resolveJitiCacheDir");
		expect(warmScript).toContain("fsCache: cacheDir");
	});
});

describe("warm skip reasons (#1926)", () => {
	const ready = {
		env: {} as Record<string, string | undefined>,
		distEntryExists: true,
		jitiResolvable: true,
	};

	it("proceeds when the entry is built and jiti is installed", () => {
		expect(warmSkipReason(ready)).toBeNull();
	});

	it("skips on the PI_LENS_SKIP_WARM_CACHE opt-out", () => {
		expect(
			warmSkipReason({ ...ready, env: { PI_LENS_SKIP_WARM_CACHE: "1" } }),
		).toMatch(/PI_LENS_SKIP_WARM_CACHE/);
	});

	it("treats an empty opt-out value as not set", () => {
		expect(
			warmSkipReason({ ...ready, env: { PI_LENS_SKIP_WARM_CACHE: "" } }),
		).toBeNull();
	});

	it("skips when dist/index.js has not been built", () => {
		expect(warmSkipReason({ ...ready, distEntryExists: false })).toMatch(
			/dist\/index\.js/,
		);
	});

	it("skips when jiti is absent, because it is an optional dependency", () => {
		// `npm install --omit=optional`, or a failed optional install, leaves jiti
		// out. That is a skip with a reason, never an install failure.
		expect(warmSkipReason({ ...ready, jitiResolvable: false })).toMatch(/jiti/);
	});
});

describe("stub aliases derive from the host-provided list (#1926)", () => {
	it("aliases every host-provided package to an unresolvable path", () => {
		const alias = buildStubAliases(HOST_PROVIDED_PACKAGES);
		expect(Object.keys(alias).sort()).toEqual(
			[...HOST_PROVIDED_PACKAGES].sort(),
		);
		for (const value of Object.values(alias)) expect(value).toBe(STUB_TARGET);
	});

	it("keeps no second copy of the package list in the script", () => {
		// Single source of truth: a hand-written alias map in the script would
		// drift from what bundle-dist.mjs keeps external.
		expect(warmScript).toContain("HOST_PROVIDED_PACKAGES");
		for (const name of HOST_PROVIDED_PACKAGES) {
			expect(warmScript, `${name} must not be hardcoded`).not.toContain(
				`"${name}"`,
			);
		}
	});
});

describe("install log stays bounded (#1926)", () => {
	it("keeps the newest lines and drops the rest", () => {
		const existing = Array.from({ length: INSTALL_LOG_MAX_LINES }, (_, i) =>
			String(i),
		);
		const next = appendBounded(existing, "newest");
		expect(next).toHaveLength(INSTALL_LOG_MAX_LINES);
		expect(next.at(-1)).toBe("newest");
		expect(next[0]).toBe("1");
	});

	it("drops blank lines from a trailing newline", () => {
		expect(appendBounded(["a", ""], "b")).toEqual(["a", "b"]);
	});
});

describe("prepare chain keeps load-bearing steps load-bearing (#1926)", () => {
	const prepare = pkg.scripts?.prepare ?? "";

	it("runs the warm last, after the steps that must fail loudly", () => {
		// build:dist and download-grammars are what consumers install for. The
		// warm is an optimisation, so it runs after them and can never preempt
		// their failure.
		const build = prepare.indexOf("build:dist");
		const grammars = prepare.indexOf("download-grammars");
		const warm = prepare.indexOf("warm-loader-cache.mjs");
		expect(build).toBeGreaterThanOrEqual(0);
		expect(grammars).toBeGreaterThan(build);
		expect(warm).toBeGreaterThan(grammars);
		expect(
			prepare.slice(warm).includes("&&"),
			"nothing may run after the warm",
		).toBe(false);
	});

	it("never masks a real prepare failure with `|| true`", () => {
		// `|| true` on the chain would swallow a build:dist failure too. The
		// script owns its own errors instead — the setup-git-hooks split (#1804).
		expect(prepare).not.toContain("|| true");
	});

	it("the warm script never exits non-zero", () => {
		expect(warmScript).not.toMatch(/process\.exit\((?!0\))/);
		expect(warmScript).toContain("catch");
	});

	it("ships both warm modules in the tarball", () => {
		const files = pkg.files ?? [];
		expect(files).toContain("scripts/warm-loader-cache.mjs");
		expect(files).toContain("scripts/lib/warm-loader-cache.mjs");
	});
});

describe("jiti stays off the session path (#1926)", () => {
	it("is an optional dependency, never a runtime dependency", () => {
		// #1926's own lesson: a package vendored into the git install and
		// evaluated at import costs startup time. jiti is install-time only, so it
		// must never be reachable from the bundled entry.
		expect(Object.hasOwn(pkg.dependencies ?? {}, "jiti")).toBe(false);
		expect(Object.hasOwn(pkg.optionalDependencies ?? {}, "jiti")).toBe(true);
	});

	it("no extension source imports jiti", () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
				if (name.name === "node_modules" || name.name.startsWith(".")) continue;
				const full = path.join(dir, name.name);
				if (name.isDirectory()) {
					walk(full);
					continue;
				}
				if (!name.name.endsWith(".ts")) continue;
				const text = fs.readFileSync(full, "utf8");
				if (/from\s*["']jiti(\/|["'])/.test(text)) offenders.push(full);
			}
		};
		for (const dir of ["clients", "tools", "mcp"]) {
			const full = path.join(root, dir);
			if (fs.existsSync(full)) walk(full);
		}
		const entry = path.join(root, "index.ts");
		if (fs.existsSync(entry)) {
			expect(
				/from\s*["']jiti(\/|["'])/.test(fs.readFileSync(entry, "utf8")),
			).toBe(false);
		}
		expect(offenders).toEqual([]);
	});
});
