/**
 * #4689 batch 5: the project ignore verdict is one answer per FILE, whichever
 * way the file or the root is spelled.
 *
 * Shape (AGENTS.md shape 1, divergent path keys), the ignore-verdict member:
 * `getProjectIgnoreMatcher` rooted a matcher at the spelling it was handed and
 * judged a file by `path.relative(root, spelling)`. A file reached through the
 * other spelling of the same project (`repo-alias/a.log` against the real
 * `repo`, or the reverse) read as "outside the root" and was never ignored, so
 * a gitignored file got dispatched, and the instant eviction a pi-authored
 * nested `.gitignore` write owes (`invalidateProjectIgnoreMatcherForPath`)
 * missed the cache entry it named by another spelling.
 *
 * The first cell drives the production `tool_result` handler (the gate at
 * `runtime-tool-result.ts` "skipping gitignored file"); the root is the
 * identity `RuntimeCoordinator.projectRoot` holds, the file path is the
 * spelling the model typed. The matcher cells use the call shape of the
 * spelled-root callers (`runtime-agent-end.ts` passes the host `ctx.cwd`).
 *
 * Every cell builds its tree from the #4689 symlinked-fixture family
 * (`createPathIdentityFixture`); a host that cannot create symlinks skips
 * visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	invalidateProjectIgnoreMatcherForPath,
	isPathIgnoredByProject,
} from "../../clients/file-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { runPipeline } from "../../clients/pipeline.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	createPathIdentityFixture,
	pinFixtureHome,
	setupTestEnvironment,
} from "./test-utils.js";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

interface Tree {
	/** The real project. */
	repo: string;
	/** A directory link to `repo`: the other spelling of every file in it. */
	alias: string;
	/** `repo/sub`, which carries its own `.gitignore`. */
	sub: string;
	/** A directory link to `repo/sub`: a spelled root INSIDE the repository. */
	subLink: string;
	/** A project-looking sibling no `.gitignore` here governs. */
	outside: string;
	cleanup: () => void;
}

/** A git root (`.git`, `*.log`), one nested `.gitignore` (`*.tmp`) and links. */
function plantTree(slug: string): Tree | undefined {
	const env = setupTestEnvironment(`pi-lens-${slug}-`);
	const home = pinFixtureHome(slug);
	const fixture = createPathIdentityFixture(env.tmpDir);
	if (fixture.skipReason !== undefined) {
		home.restore();
		env.cleanup();
		return undefined;
	}
	const sub = path.join(fixture.repo, "sub");
	fs.mkdirSync(path.join(fixture.repo, ".git"), { recursive: true });
	fs.mkdirSync(sub, { recursive: true });
	fs.writeFileSync(path.join(fixture.repo, ".gitignore"), "*.log\n");
	fs.writeFileSync(path.join(sub, ".gitignore"), "*.tmp\n");
	const subLink = path.join(env.tmpDir, "sub-link");
	fs.symlinkSync(path.join("repo", "sub"), subLink, "dir");
	return {
		repo: fixture.repo,
		alias: fixture.aliasRoot,
		sub,
		subLink,
		outside: path.dirname(fixture.outsideFile),
		cleanup: () => {
			home.restore();
			env.cleanup();
		},
	};
}

describe("project ignore verdict by path identity (#4689)", () => {
	beforeEach(() => {
		vi.mocked(runPipeline).mockReset();
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
	});

	it("tool_result skips a gitignored file whichever way the path is spelled", async () => {
		const tree = plantTree("ignore-identity-tool-result");
		if (tree === undefined) return;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = tree.repo;
			fs.writeFileSync(path.join(tree.repo, "a.log"), "noise\n");
			for (const spelled of [
				path.join(tree.repo, "a.log"),
				path.join(tree.alias, "a.log"),
			]) {
				vi.mocked(runPipeline).mockClear();
				const dbg = vi.fn();
				await handleToolResult({
					event: {
						toolName: "write",
						input: { path: spelled, content: "noise\n" },
						content: [],
					},
					getFlag: () => false,
					dbg,
					runtime,
					cacheManager: new CacheManager(false),
					biomeClient: {},
					ruffClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as never);
				expect(dbg).toHaveBeenCalledWith(
					`tool_result: skipping gitignored file ${spelled}`,
				);
				expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
			}
		} finally {
			tree.cleanup();
		}
	});

	it("answers one verdict for the root and the file in any spelling pair", () => {
		const tree = plantTree("ignore-identity-pairs");
		if (tree === undefined) return;
		try {
			for (const root of [tree.repo, tree.alias]) {
				for (const base of [tree.repo, tree.alias]) {
					const where = `root ${root} file under ${base}`;
					expect(
						isPathIgnoredByProject(path.join(base, "a.log"), root),
						`${where}: root rule`,
					).toBe(true);
					expect(
						isPathIgnoredByProject(path.join(base, "sub", "b.tmp"), root),
						`${where}: nested rule`,
					).toBe(true);
					expect(
						isPathIgnoredByProject(path.join(base, "sub", "keep.ts"), root),
						`${where}: kept file`,
					).toBe(false);
				}
			}
		} finally {
			tree.cleanup();
		}
	});

	it("does not ignore a file that is in neither spelling of the root", () => {
		const tree = plantTree("ignore-identity-outside");
		if (tree === undefined) return;
		try {
			for (const root of [tree.repo, tree.alias]) {
				expect(
					isPathIgnoredByProject(path.join(tree.outside, "a.log"), root),
				).toBe(false);
			}
		} finally {
			tree.cleanup();
		}
	});

	it("applies the repository's rules to a root that is a link into a subdirectory", () => {
		const tree = plantTree("ignore-identity-sublink");
		if (tree === undefined) return;
		try {
			const real = path.join(tree.sub, "a.log");
			expect(isPathIgnoredByProject(real, tree.repo)).toBe(true);
			expect(isPathIgnoredByProject(real, tree.subLink)).toBe(true);
			expect(
				isPathIgnoredByProject(path.join(tree.subLink, "a.log"), tree.repo),
			).toBe(true);
			expect(
				isPathIgnoredByProject(path.join(tree.subLink, "a.log"), tree.subLink),
			).toBe(true);
		} finally {
			tree.cleanup();
		}
	});

	it("a pi-authored nested .gitignore write evicts the verdict through another spelling", async () => {
		const tree = plantTree("ignore-identity-invalidate");
		if (tree === undefined) return;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = tree.repo;
			const tmpFile = path.join(tree.sub, "x.tmp");
			// Prime: the verdict is memoized and the nested rules are frozen for the
			// cadence window, so only an eviction can change the answer inside it.
			expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(true);
			fs.writeFileSync(path.join(tree.sub, ".gitignore"), "# cleared\n");
			await handleToolResult({
				event: {
					toolName: "write",
					input: { path: path.join(tree.alias, "sub", ".gitignore") },
					content: [],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);
			expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(false);
		} finally {
			tree.cleanup();
		}
	});

	it("evicts the verdicts of a spelled root the write named by the real path", () => {
		const tree = plantTree("ignore-identity-invalidate-reverse");
		if (tree === undefined) return;
		try {
			const tmpViaAlias = path.join(tree.alias, "sub", "x.tmp");
			expect(isPathIgnoredByProject(tmpViaAlias, tree.alias)).toBe(true);
			fs.writeFileSync(path.join(tree.sub, ".gitignore"), "# cleared\n");
			invalidateProjectIgnoreMatcherForPath(path.join(tree.sub, ".gitignore"));
			expect(isPathIgnoredByProject(tmpViaAlias, tree.alias)).toBe(false);
		} finally {
			tree.cleanup();
		}
	});

	it("evicts a nested verdict when the write names the directory through a link into it", () => {
		const tree = plantTree("ignore-identity-invalidate-sublink");
		if (tree === undefined) return;
		try {
			const tmpFile = path.join(tree.sub, "x.tmp");
			expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(true);
			fs.writeFileSync(path.join(tree.sub, ".gitignore"), "# cleared\n");
			invalidateProjectIgnoreMatcherForPath(
				path.join(tree.subLink, ".gitignore"),
			);
			expect(isPathIgnoredByProject(tmpFile, tree.repo)).toBe(false);
		} finally {
			tree.cleanup();
		}
	});
});
