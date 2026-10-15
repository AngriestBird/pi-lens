/**
 * Whether vitest collects a file, read from the repo's own `vitest.config.ts`
 * (#4393). A detector that decides a test exists must not count a file the
 * suite never runs: a support module, or a `*.test.ts` under an excluded tree
 * such as `tests/fixtures/` (#4399 verify r2 F3). The include and exclude
 * lists come from the config itself, so a change there moves this answer
 * with it; nothing here restates a glob. `vitestCollector` reads any config
 * of that shape; the shuffle census test runs it over fixtures and over the
 * real config evaluated without `npm_lifecycle_event` (#4405).
 */
import { Minimatch } from "minimatch";
import { configDefaults } from "vitest/config";
// The live config source, not the build's gitignored `vitest.config.js`,
// which can lag it (same rule as lsp-spawn-heavy-coverage.test.ts).
// Allowlisted in module-instance-coverage.test.ts.
import vitestConfig from "../../vitest.config.ts";

/** One pattern list: plain paths match by equality, the rest as globs. */
interface Matcher {
	paths: Set<string>;
	globs: RegExp[];
}

interface ProjectGlobs {
	include: Matcher;
	exclude: Matcher;
}

const GLOB_CHARACTER = /[*?[\]{}()!]/;

function compile(patterns: readonly string[]): Matcher {
	const paths = new Set<string>();
	const globs: RegExp[] = [];
	for (const pattern of patterns) {
		const glob = GLOB_CHARACTER.test(pattern)
			? new Minimatch(pattern, { dot: true }).makeRe()
			: false;
		if (glob) globs.push(glob);
		else paths.add(pattern);
	}
	return { paths, globs };
}

const matches = (matcher: Matcher, relativePath: string): boolean =>
	matcher.paths.has(relativePath) ||
	matcher.globs.some((glob) => glob.test(relativePath));

/** The `test` block of a vitest config, as far as collection reads it. */
export interface VitestTestBlock {
	include?: readonly string[];
	exclude?: readonly string[];
	projects?: readonly unknown[];
	[key: string]: unknown;
}

/** Keys that move where a project collects from; this reader does not model them. */
const UNREAD_KEYS = ["dir", "root", "includeSource"] as const;

function refuseUnread(where: string, test: VitestTestBlock): void {
	for (const key of UNREAD_KEYS)
		if (test[key] !== undefined)
			throw new Error(`vitest-collection: ${where} sets test.${key}`);
}

/** A project's list: the root's entries and its own, as vitest merges them (#4405 r5, probed with `vitest list`). */
function merged(
	rootList: readonly string[] | undefined,
	ownList: readonly string[] | undefined,
	fallback: readonly string[],
): readonly string[] {
	if (rootList === undefined && ownList === undefined) return fallback;
	return [...(rootList ?? []), ...(ownList ?? [])];
}

/**
 * Whether some project of `config` collects a path (POSIX, from the config's
 * root). An inline project takes the root's `include` and `exclude` in
 * addition to its own (probed with `vitest list`: a root exclude still drops
 * a file from a project that sets its own). A shape this does not read (a
 * project given as a path, `extends`, `dir`, `root`, `includeSource`) throws,
 * so it never reads as collecting nothing, or everything.
 */
export function vitestCollector(config: {
	test?: VitestTestBlock;
}): (relativePath: string) => boolean {
	const root = config.test ?? {};
	refuseUnread("the root", root);
	const tests = (root.projects ?? [{ test: {} }]).map((entry) => {
		const project =
			typeof entry === "object" && entry !== null
				? (entry as { test?: unknown; extends?: unknown })
				: {};
		const test = project.test;
		if (typeof test !== "object" || test === null || "extends" in project)
			throw new Error(
				`vitest-collection: unreadable project ${JSON.stringify(entry)}`,
			);
		const block = test as VitestTestBlock;
		refuseUnread(`project ${String(block.name)}`, block);
		return block;
	});
	const projects: ProjectGlobs[] = tests.map((test) => ({
		include: compile(
			merged(root.include, test.include, configDefaults.include),
		),
		exclude: compile(
			merged(root.exclude, test.exclude, configDefaults.exclude),
		),
	}));
	return (relativePath) =>
		projects.some(
			(project) =>
				matches(project.include, relativePath) &&
				!matches(project.exclude, relativePath),
		);
}

let repoCollector: ((relativePath: string) => boolean) | undefined;

/** Does some vitest project of this repo collect `relativePath` (POSIX, from the repo root)? */
export function vitestCollects(relativePath: string): boolean {
	repoCollector ??= vitestCollector(vitestConfig as { test?: VitestTestBlock });
	return repoCollector(relativePath);
}
