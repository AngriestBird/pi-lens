/**
 * Pure helpers for `scripts/warm-loader-cache.mjs` (#1926).
 *
 * pi loads an extension through jiti (`createJiti(..., { moduleCache: false,
 * alias: … })` in `@earendil-works/pi-coding-agent`'s
 * `dist/core/extensions/loader.js`). jiti transforms the entry with Babel and
 * stores the result in a filesystem cache. pi-lens's `dist/index.js` is a ~4MB
 * esbuild bundle, so that transform costs seconds: the first session after a
 * `git:` install or update measured 4847ms of `module import`, against a 138ms
 * steady state once the cache is warm (#1926 field report).
 *
 * The fix is to pay that transform at install time instead of in the first
 * interactive session. `prepare` already builds `dist/`, so the last step of
 * the chain runs the same transform through the same jiti, writing the same
 * cache file pi will later read.
 *
 * WHY THE WARM PRODUCES A HIT FOR THE REAL LOADER
 *
 * jiti keys a cache entry on the transformed file, not on the jiti instance
 * (see `getCache` in `jiti/dist/jiti.cjs`):
 *
 *   <basename(dirname(file))>-<basename(file) up to the first dot>
 *   + "+map" if sourceMaps + ".i" if interopDefault
 *   + "." + md5(file).slice(0, 8)
 *   + ".mjs" for an async import, ".cjs" otherwise
 *
 * and it validates the stored body against a trailing
 * ` /* v<TRANSFORM_VERSION>-<md5(source).slice(0,16)> *\/` marker. So the warm
 * has to agree with pi on three things only: the absolute path of the entry,
 * the cache directory, and the transform itself. Everything else — the alias
 * map, `moduleCache`, which package the jiti instance was created from — is
 * outside the key AND outside the transform. Measured, not assumed: running
 * this warm over the dogfood install's `dist/index.js` produced a cache file
 * byte-identical to the one pi had written, both with pi's alias map and with
 * no alias map at all.
 *
 * The marker is also the safety net. If pi ships a jiti whose transform version
 * or Babel output differs, pi recomputes the marker, does not match, and simply
 * re-transforms. A mismatched warm costs the install a few seconds and buys
 * nothing; it can never hand pi the wrong code.
 */

/**
 * Mirror of jiti's `prepareCacheDir` fallback branch.
 *
 * jiti picks `<dir of the file that created the jiti instance>/node_modules/
 * .cache/jiti` when that `node_modules` exists, and `<tmpdir>/jiti` otherwise.
 * pi creates its instance from `dist/core/extensions/loader.js` inside the
 * installed `@earendil-works/pi-coding-agent`, which has no `node_modules`
 * sibling, so pi always lands on the tmpdir branch. The warm therefore passes
 * `<tmpdir>/jiti` EXPLICITLY rather than letting jiti derive a directory from
 * this repo's layout: `scripts/` has no `node_modules` sibling today, but a
 * script moved one level up would silently start filling a private cache that
 * pi never reads.
 *
 * The TMPDIR dance below is jiti's, kept verbatim so the two agree on machines
 * where TMPDIR is set to the current directory.
 *
 * @param {object} deps
 * @param {() => string} deps.tmpdir
 * @param {Record<string, string | undefined>} deps.env
 * @param {() => string} deps.cwd
 * @param {(a: string, b: string) => string} deps.join
 * @returns {string}
 */
export function resolveJitiCacheDir({ tmpdir, env, cwd, join }) {
	let dir = tmpdir();
	if (env.TMPDIR && dir === cwd() && !env.JITI_RESPECT_TMPDIR_ENV) {
		const saved = env.TMPDIR;
		delete env.TMPDIR;
		dir = tmpdir();
		env.TMPDIR = saved;
	}
	return join(dir, "jiti");
}

/**
 * Alias every host-provided specifier to a path that cannot exist.
 *
 * The warm only needs the TRANSFORM of `dist/index.js`; jiti writes the cache
 * entry before it evaluates the module. Evaluation then walks the bundle's
 * external imports, none of which resolve outside pi. Pointing the
 * host-provided ones at a stub makes that walk stop at the first one instead of
 * resolving unrelated packages first, so the warm does the least work it can
 * and always ends the same way. Derived from the shared host-provided list so
 * it cannot drift from what `bundle-dist.mjs` keeps external.
 *
 * @param {readonly string[]} hostProvidedPackages
 * @returns {Record<string, string>}
 */
export function buildStubAliases(hostProvidedPackages) {
	/** @type {Record<string, string>} */
	const alias = {};
	for (const name of hostProvidedPackages) {
		alias[name] = STUB_TARGET;
	}
	return alias;
}

/** A path no filesystem resolves, so aliased imports fail immediately. */
export const STUB_TARGET = "/__pi-lens-warm-cache-stub__";

/**
 * Decide whether the warm can run, and say why not when it cannot.
 *
 * Every reason is a skip, never a failure: `prepare` also builds `dist/` and
 * downloads grammars, and those steps MUST fail loudly. Cache warming is an
 * optimisation, so it runs last and reports rather than throws — the same
 * posture as `scripts/setup-git-hooks.mjs` (#1804).
 *
 * @param {object} state
 * @param {Record<string, string | undefined>} state.env
 * @param {boolean} state.distEntryExists
 * @param {boolean} state.jitiResolvable
 * @returns {string | null} skip reason, or null to proceed
 */
export function warmSkipReason({ env, distEntryExists, jitiResolvable }) {
	const optOut = env.PI_LENS_SKIP_WARM_CACHE;
	if (typeof optOut === "string" && optOut.length > 0) {
		return "PI_LENS_SKIP_WARM_CACHE is set";
	}
	if (!distEntryExists) {
		return "dist/index.js is missing — nothing to warm";
	}
	if (!jitiResolvable) {
		// jiti is an optionalDependency, so `--omit=optional` (or a failed
		// optional install) legitimately leaves it absent.
		return "jiti is not installed — install ran without optional dependencies";
	}
	return null;
}

/**
 * Keep the install log bounded: one line per install, newest last.
 *
 * @param {string[]} existingLines
 * @param {string} line
 * @param {number} [max]
 * @returns {string[]}
 */
export function appendBounded(
	existingLines,
	line,
	max = INSTALL_LOG_MAX_LINES,
) {
	const lines = [...existingLines.filter((l) => l.trim().length > 0), line];
	return lines.slice(Math.max(0, lines.length - max));
}

/** Cap for `~/.pi-lens/install.log`. */
export const INSTALL_LOG_MAX_LINES = 100;
