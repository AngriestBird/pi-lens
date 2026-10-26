/**
 * #2556 — path containment over a `path.relative` result has one owner.
 *
 * `clients/path-utils.ts` owns containment: `isUnderDir`, `isWithinForm` and
 * the home-ceiling predicate `isAtOrAboveHomeDir`. Every other containment test
 * is a copy of a rule that seam already owns (AGENTS.md shape 83), and the
 * copies are wrong in two measured ways:
 *
 * - **cross-drive (#4878 F1, HIGH):** `!rel.startsWith("..")` reads a
 *   `path.relative` result as "inside" whenever it does not begin with `..`.
 *   Across Windows drives `path.relative` returns an ABSOLUTE path, so a file
 *   on another drive reads as inside. `tests/support/vi-mock-export-gate.ts`
 *   shipped this and `Unit tests Windows` failed 26 cells on a head Linux CI
 *   and the local run called green.
 * - **`..`-name (#4835):** the prefix test reads a directory named `..foo`,
 *   which is INSIDE the root it belongs to, as outside.
 *
 * Neither shape has a tree-wide layer: `tests/config/path-identity-sweep.test.ts`
 * reads map keys and raw `realpath` calls, `path-key-fold-sweep` reads equality
 * folds, and `reported-path-attribution-sweep` deliberately drops a
 * `path.relative` result as a "fragment used for containment" (#4876 review r2
 * F5 records that blind spot). This ratchet is that layer, and the three stay
 * apart because each answers a different rule: a key, an equality, an
 * attribution, a containment. Folding them would make one detector depend on
 * another's needle vocabulary and would widen a frozen census instead of
 * governing the population it was built for.
 *
 * The detector is `tests/support/path-containment-scan.ts` and its own state
 * table is `tests/support/path-containment-scan.test.ts`; both parse the file,
 * so a comment is never code and a string is read only by its cooked value.
 *
 * KNOWN MISSED SHAPES (accepted floor — the needle cannot see them):
 * - a `path.relative` result handed to another FUNCTION and tested there, when
 *   the callee is in another module (live population 2, both in
 *   `tests/support/`: `vi-mock-export-gate.ts#isProductionModulePath` and
 *   `module-instance-scan.ts#isBuildCompiled`, each already pairing
 *   `path.isAbsolute`). A call that carries BOTH the relative value and a `..`
 *   literal IS reported (the argument hand-off reading), so this row is the
 *   cross-module case only.
 * - a value stored on an object or array and read back later
 *   (`records[i].rel.startsWith("..")`), a reassigned `let`
 *   (`let rel = f(); rel = path.relative(a, b)`), a destructured read, or a
 *   `relative` callee re-exported from another module under another name.
 * - a parent-segment literal carried through an OBJECT field or a function
 *   argument chain (`rel.startsWith(markers.parent)`). Named constants, RegExp
 *   literals and `indexOf`/`includes`/`match`/`test` readings are NOT in this
 *   list: #4882 review F1 proved the enumerated-predicate cut blind to them,
 *   and the derived reading now reports each.
 * - a relative result read through a member chain whose method returns
 *   something unrelated (`rel.split("/").length`), which the fail-closed
 *   reading reports rather than drops.
 * - a `switch (rel) { case "..": }`, which is not a comparison node. Measured
 *   on the authoring head: no such switch over a relative result exists in the
 *   scanned trees, so the live population is 0.
 *
 * SCOPE (defect shape 80, one verdict per root a containment test can be
 * written in — AGENTS.md "Evidence and reporting" names them): `clients/`,
 * `tools/`, `mcp/`, `index.ts`, `scripts/` (with `scripts/lib/` and
 * `scripts/hooks/`, `.ts` and `.mjs`), `tests/support/`, and `tests/` outside
 * `support/`. `tests/config/` is inside `tests/` and therefore scanned. The
 * only root left out is a fixture directory's own generated content, which is
 * data rather than a containment answer; its measured population is 0.
 *
 * POPULATION on the authoring head (measured, `PI_LENS_PRINT_PINS=1`): 43
 * sites — 42 baseline rows plus the seam's own admission. 25 of them sit in
 * the runtime trees the first cut scanned (24 rows + `isAtOrAboveHomeDir`),
 * 4 in `scripts/` and 13 in `tests/` outside `support/`, all four scripts/ and
 * eleven of the thirteen tests members measured by #4882 review F2; the other
 * two are the predicate half's widening (an `expect(…).toBe("../…")` and a
 * `toMatch(/^\.\./)` assertion), not new defects.
 */
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	scanPathContainmentSites,
	type PathContainmentSite,
} from "../support/path-containment-scan.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * The trees this lane scans. AGENTS.md "Evidence and reporting" names the
 * class-sweep roots: the shipped runtime (`clients/`, `tools/`, `mcp/`,
 * `index.ts`), the repository's own scripts (`scripts/`, `scripts/lib/`,
 * `scripts/hooks/`), and the test trees (`tests/support/` plus `tests/`
 * outside it). Defect shape 80: a census that reads one root while its subject
 * can be written in several answers "clean" from the wrong root, and #4882
 * review F2 measured 15 live members in the two roots the first cut omitted —
 * four in `scripts/` and eleven in `tests/` outside `support/`.
 *
 * `tests/support` is its own tree and `tests` excludes it, so every file is
 * counted once. `scripts/` is `.mjs`-heavy (193 files at the authoring head)
 * and its two `.ts` files are scans too, so it takes both extensions.
 */
interface ScanTree {
	root: string;
	extensions: readonly string[];
	/** Drop a file by its tree-relative posix path. */
	exclude?: (relativePath: string) => boolean;
}

const SCAN_ROOTS: readonly ScanTree[] = [
	{ root: "clients", extensions: [".ts"] },
	{ root: "tools", extensions: [".ts"] },
	{ root: "mcp", extensions: [".ts"] },
	{ root: "scripts", extensions: [".ts", ".mjs"] },
	{ root: "tests/support", extensions: [".ts", ".mjs"] },
	{
		root: "tests",
		extensions: [".ts"],
		exclude: (relativePath) => relativePath.startsWith("support/"),
	},
];

/**
 * Half the live file count per tree, so a moved root or a dropped tree reds
 * instead of reading as a clean population (defect shape 10). Live on the
 * authoring head: 512 `clients/`, 16 `tools/`, 6 `mcp/`, 195 `scripts/`,
 * 128 `tests/support/`, 1682 `tests/` outside `support/`.
 */
const FILE_FLOORS: Readonly<Record<string, number>> = {
	clients: 256,
	tools: 8,
	mcp: 3,
	scripts: 97,
	"tests/support": 64,
	tests: 841,
};

const CROSS_DRIVE =
	"cross-drive arm (#4878 F1): it tests only the `..` prefix and pairs no isAbsolute arm, so across Windows drives path.relative returns an absolute path that does not start with `..` and this site reads an out-of-tree target as INSIDE. Unreproduced on a production call path, so it stays baselined; folding it onto isUnderDir is #2556's remainder.";

const DOTDOT_NAME =
	"`..`-name arm (#4835): it tests the `..` PREFIX, so a directory named `..foo` — inside the root it belongs to — reads as outside. Unreproduced on a production call path and already paired with isAbsolute, so it stays baselined; pairing it with isWithinForm/isUnderDir is #2556's remainder.";

/**
 * The seam's own predicate. Containment is admitted ONLY through
 * `clients/path-utils.ts`, so this file's site is an admission with a reason,
 * not a baseline row: a second containment test inside it still reds as
 * unlisted, and `isUnderDir`/`isWithinForm` fold it in #2556's remainder.
 */
const SEAM_ADMISSIONS: Readonly<Record<string, string>> = {
	"clients/path-utils.ts#isAtOrAboveHomeDir": `${CROSS_DRIVE} This IS the home-ceiling predicate: it pairs !isAbsolute(rel), which the 16 hand-rolled copies mostly do not, and it is the shape #2544 round 2 collapsed onto one expression. The seam owns it until it is expressed through isWithinForm.`,
};

/**
 * The hand-rolled sites. Row = `<file>#<anchor>`; the anchor is the enclosing
 * named symbol, and a second predicate inside the SAME symbol carries an
 * ordinal (`… #2`), so every site keeps its own row and one row never excuses
 * two. The baseline only shrinks: nothing here is fixed in this lane, because
 * no site is reproduced through a production call path (principles §1,
 * speculative robustness) — the #2556 comment names them as a member list, not
 * as findings.
 *
 * Six members the issue's hand census (16: 6 without an isAbsolute arm, 10
 * with) did not list are here too, because the structural detector finds them:
 * `go-vet.ts` spells the callee as a named `relative` import, `mcp/server.ts`
 * sits outside the census's grep roots, three spell the test as a template or a
 * comparison, and `clients/path-utils.ts#inside` is the seam's own third
 * predicate. The four `scripts/` and thirteen `tests/` rows are the roots
 * #4882 review F2 measured; a `tests/` row is an assertion about a fixture's
 * own prefix, not a containment decision the product acts on, and says so.
 *
 * 42 rows plus the seam's one admission make the 43 sites this census prints.
 */
const BASELINE: Readonly<Record<string, string>> = {
	"clients/actionable-warnings.ts#legacyActionableWarningId": `${CROSS_DRIVE} A cross-drive relative reads as an in-tree file, so a legacy finding id keeps a relative component for a path outside the project; it fails toward a duplicate id, never toward a dropped finding.`,
	"clients/cache-manager.ts#CacheManager.toTurnStateKey": `${CROSS_DRIVE} A cross-drive relative reads as an in-tree key, so the turn-state key for a file outside cwd stays relative instead of falling back to the absolute form.`,
	"clients/dependency-checker.ts#isWithin": `${DOTDOT_NAME} A directory named \`..foo\` reads as outside \`target\`'s tree, so a check target under it is treated as out-of-tree. This is the \`isWithin\` duplicate that #2556's own acceptance deletes in favour of \`isUnderDir\`.`,
	"clients/dispatch/rule-ignores.ts#isRuleIgnoredForPath": `${DOTDOT_NAME} A directory named \`..foo\` reads as outside the root, so a file under it loses its root-relative display path and is matched as if it were absolute. Template-literal spelling the hand census did not see.`,
	"clients/dispatch/runner-context.ts#toRunnerDisplayPath": `${CROSS_DRIVE} A cross-drive relative reads as a display path, so a runner diagnostic for a file on another drive keeps an absolute form in a relative slot.`,
	"clients/dispatch/runners/go-vet.ts#run": `${CROSS_DRIVE} A cross-drive \`fileRel\` reads as under the module root, so \`./\` is prefixed to an absolute path and go vet's package argument names no package. The callee is a named \`relative\` import, which the hand census's \`path.relative\` grep did not reach.`,
	"clients/dispatch/runners/helm-lint.ts#isWithin": `${DOTDOT_NAME} A chart path under a directory named \`..foo\` reads as outside the chart root, so helm-lint skips a template it should lint. Spelled \`..\${path.sep}\`, which a \`startsWith("..")\` grep does not match.`,
	"clients/dispatch/runners/helm-render.ts#isWithin": `${DOTDOT_NAME} A chart path under a directory named \`..foo\` reads as outside the chart root, so helm-render skips a template it should render. The second member in this file, and a template-literal spelling the hand census missed.`,
	"clients/dispatch/runners/helm-render.ts#mapRenderedToSource": `${CROSS_DRIVE} A cross-drive relative reads as inside \`outputDir\`, so a rendered file outside it is mapped onto a chart path that does not exist instead of falling back to source mapping.`,
	"clients/finding-identity.ts#relativeFile": `${CROSS_DRIVE} A cross-drive relative reads as an in-tree file, so a finding id carries an absolute path where a relative component is expected: two ids for one file rather than a lost one.`,
	"clients/gitleaks-client.ts#isInsideNestedGitRepository": `${DOTDOT_NAME} A file under a directory named \`..foo\` reads as outside the root, so the nested-checkout verdict for it is wrong in the fail-open direction this helper deliberately keeps.`,
	"clients/knip-client.ts#classifyKnipBinary": `${DOTDOT_NAME} A binary under a directory named \`..foo\` reads as outside the project, so a project-local shim is classified \`global\` instead of \`project\`.`,
	"clients/lsp/client-registry.ts#ClientRegistry.resolveServerRoot": `${DOTDOT_NAME} A root under a directory named \`..foo\` reads as outside its ancestor key, so the root chain stops one level early. Paired with \`pathApi.isAbsolute\` in the same expression.`,
	"clients/lsp/server.ts#cargoWorkspaceDeclaresMember": `${CROSS_DRIVE} A cross-drive relative reads as inside the manifest dir, so a cargo workspace member outside it is accepted and its crates are swept into the wrong root.`,
	"clients/lsp/server.ts#isSameOrWithin": `${DOTDOT_NAME} A candidate under a directory named \`..foo\` reads as outside the root, so an in-root workspace member is not grouped with its workspace. Paired with \`pathApi.isAbsolute\` in the same expression.`,
	"clients/lsp/workspace-diagnostics-cache.ts#clearWorkspaceDiagnosticsCacheAtAndAbove": `${DOTDOT_NAME} A root under a directory named \`..foo\` reads as outside the ceiling, so the cache prune stops at an ancestor the root is not under.`,
	"clients/path-utils.ts#inside": `${DOTDOT_NAME} A third containment predicate inside the seam's own module (\`toProjectRelativePath\`): a file under a directory named \`..foo\` reads as outside the root, so no project-relative path is derived for it. Baselined rather than folded because this lane changes no production site; moving it onto \`isWithinForm\` is #2556's remainder.`,
	"clients/project-lens-config.ts#findNestedProjectMutationValue": `${DOTDOT_NAME} A directory whose name starts with \`..\` reads as outside the project root, so a nested config section under it is not read.`,
	"clients/python-environment.ts#isUvWorkspaceMember": `${DOTDOT_NAME} A member under a directory named \`..foo\` reads as outside the workspace root, so its uv settings are not inherited: the over-inheritance #4847 guarded against, in the other direction.`,
	"clients/python-environment.ts#isWithinProjectRoot": `${DOTDOT_NAME} An ambient environment root under a directory named \`..foo\` reads as outside the project, so it is not borrowed. Template-literal spelling, missed by the hand census.`,
	"clients/test-runner-client.ts#isExcludedTestTarget": `${DOTDOT_NAME} A target under a directory named \`..foo\` reads as outside the project, so the fail-closed exclusion path runs for an in-tree file.`,
	"clients/test-runner-client.ts#TestRunnerClient.relativeSourceDir": `${DOTDOT_NAME} A source directory whose name starts with \`..\` reads as outside cwd, so the mirrored test-tree candidate is not computed for it.`,
	"mcp/server.ts#isWithinServerWorkspace": `${DOTDOT_NAME} A cwd under a directory named \`..foo\` reads as outside the server's workspace, so an in-workspace route is rejected. Outside the roots the issue's hand census grepped.`,
	"scripts/hooks/guard-bash.mjs#hasNodeModulesSymlinkOutside": `${DOTDOT_NAME} Both arms are present — \`rel === ".."\` and \`rel.startsWith(".." + SEP)\` — plus \`isAbsolute(rel)\`, so this copy answers the seam's own question; it cannot fold because the hook is a bare-Node \`.mjs\` that Claude Code runs before any build, so it may not import a TypeScript seam. Baselined as the record that the copy was read.`,
	"scripts/hooks/guard-bash.mjs#isUnderTmpRoot": `${DOTDOT_NAME} Both arms are present and paired with \`isAbsolute(rel)\`, so the answer matches the seam's; the same bare-Node boundary (no build step, so no TypeScript seam import) is why it stays a copy.`,
	"scripts/lib/pr-worktree.mjs#nestedDestinationError": `${DOTDOT_NAME} Both arms plus \`pathApi.isAbsolute\`, on the same bare-Node boundary as the git guard: \`.mjs\` run by a script that cannot import the TypeScript seam.`,
	"scripts/lib/pr-worktree.mjs#deriveClosePlan": `${CROSS_DRIVE} It pairs no \`isAbsolute\` arm: on Windows a worktree path on another drive makes \`pathApi.relative\` return an absolute path, which is neither \`""\` nor \`".."\` nor a \`..\`-plus-separator prefix, so the close plan treats a path outside the worktrees root as inside. Unreproduced on a production call path this round, so it stays baselined; folding it is #2556's remainder.`,
	"tests/support/v8-coverage.ts#fileFromScriptUrl": `${CROSS_DRIVE} A cross-drive relative reads as inside the coverage root, so a script outside \`include\` is reported as a covered file. The only member in \`tests/support/\`, the tree the #4878 F1 site shipped in.`,
	"tests/clients/actionable-warnings-lsp-cache.test.ts#legacyActionableWarningIdForTest": `${CROSS_DRIVE} A test-local copy of \`clients/actionable-warnings.ts\`'s legacy-id helper, used as the INDEPENDENT expectation the production helper is compared against. Folding it onto the seam would make the cell restate the code it checks (principles §2, tautological test), so the copy is the point.`,
	"tests/clients/actionable-warnings.test.ts#legacyActionableWarningIdForTest": `${CROSS_DRIVE} The same test-local copy in the sibling cell: an independent expectation, so importing the production helper would make the comparison vacuous.`,
	"tests/clients/ignore-verdict-identity-4689.test.ts#does not read the rules of a sibling directory named `<root>\\outside`": `${CROSS_DRIVE} An assertion on the primitive's own answer (\`expect(path.relative(repo, outside)).toBe("../repo\\\\outside/x.log")\`), pinning that the sibling is outside by TEXT. It derives no containment decision; a cross-drive absolute \`rel\` fails this cell instead of acting on it, which is the direction a test should fail.`,
	"tests/clients/npx-child-env-isolation.test.ts#spawns npx without npm_config_* or a project-derived userconfig": `${CROSS_DRIVE} An assertion that the child's cwd sits outside the fixture tmp dir (\`toMatch(/^\\.\\./)\`): the test's own expectation about where a spawned child ran, not a containment answer the product acts on.`,
	"tests/clients/project-report.test.ts#preFixToDisplayPath": `${CROSS_DRIVE} The #4101 witness: it recomputes the PRE-FIX hand-rolled body to prove the fix is not equivalent to it, so the broken spelling is the thing under test. Folding it onto the seam would delete the witness.`,
	"tests/clients/worker-home-pin-hermeticity.test.ts#under": `${DOTDOT_NAME} A test-local containment helper over \`path.resolve\`d, case-folded spellings (the macOS home-case probe); folding it onto \`isUnderDir\` would follow links and change what the cell measures.`,
	"tests/index-3190-inline-blocker-deleted-path-witness.test.ts#scrub": `${DOTDOT_NAME} The witness derives a \`~\` form only for a path inside the probe home; a directory named \`..foo\` reads as outside, so the scrub falls back to its never-matching sentinel and the cell fails loudly.`,
	"tests/index-3290-actionable-warnings-witness.test.ts#tildeProbeHome": `${DOTDOT_NAME} The same home-relative probe in the actionable-warnings witness: a \`..foo\` directory reads as outside and the cell fails loudly instead of publishing a wrong \`~\` path.`,
	"tests/scripts/build-dist-tsc.test.ts#falls back to the isolated npm-exec path, unchanged, when no local binary is given": `${CROSS_DRIVE} An assertion on the primitive's own answer for a temp prefix (\`expect(path.relative(root, prefix).startsWith("..")).toBe(true)\`): it states where the fixture sits and derives no containment decision.`,
	"tests/scripts/bundle-dist.test.ts#spawns with cwd: root and a --prefix pointing outside root": `${CROSS_DRIVE} The same assertion in the sibling spawn cell: the prefix must be outside \`root\`, and a cross-drive absolute \`rel\` fails the cell rather than acting on a wrong answer.`,
	"tests/scripts/exec-isolation.test.ts#creates a fresh directory under the OS temp dir on every call": `${CROSS_DRIVE} Asserts the helper's own output is outside the tmp root by the primitive's answer; a wrong containment fails the cell instead of acting on it.`,
	"tests/scripts/exec-isolation.test.ts#returns a fresh, empty directory that is neither the project root, an ancestor of it, nor a descendant of it": `${CROSS_DRIVE} Asserts the created prefix is outside the project root in both directions (\`fromRoot\` and \`toRoot\`), by the primitive's own answer.`,
	"tests/scripts/exec-isolation.test.ts#returns a fresh, empty directory that is neither the project root, an ancestor of it, nor a descendant of it#2": `${CROSS_DRIVE} The ordinal row for the second arm in the same cell (\`toRoot\`), which the census keys separately so one row never excuses two sites.`,
	"tools/lens-diagnostics.ts#runnerRetirementDecision": `${DOTDOT_NAME} A file under a directory named \`..foo\` reads as outside a runner's coverage root, so its covered entry is skipped and the finding is retired by the id-only arm instead.`,
};

interface Occurrence {
	row: string;
	detail: string;
}

interface Census {
	scanned: Map<string, number>;
	occurrences: Occurrence[];
}

let cached: Promise<Census> | undefined;

async function runCensus(): Promise<Census> {
	const scanned = new Map<string, number>();
	const occurrences: Occurrence[] = [];
	const files = [
		...SCAN_ROOTS.flatMap((tree) =>
			listSourceFiles(path.join(REPO_ROOT, tree.root), {
				extensions: tree.extensions,
				exclude: tree.exclude,
			}).map((file) => ({ file, tree: tree.root })),
		),
		{ file: path.join(REPO_ROOT, "index.ts"), tree: "index.ts" },
	];
	for (const { file, tree } of files) {
		const rel = relativePosix(REPO_ROOT, file);
		const source = readWalkedFile(file);
		// Shape 81: a native tree is freed only when the event loop turns, so
		// yield once per file instead of holding every parsed tree to the end.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (source === undefined) continue;
		scanned.set(tree, (scanned.get(tree) ?? 0) + 1);
		// Cheap prefilter, and it can only skip WORK: every admitted form needs the
		// callee's name somewhere in the file (`relative`, or a name bound to it)
		// and a `..` literal, so a file holding neither holds no site. The walked
		// file still counts toward the tree's floor above.
		if (!source.includes("relative") || !source.includes("..")) continue;
		for (const site of scanPathContainmentSites(source))
			occurrences.push({
				row: rowOf(rel, site),
				detail: `${rel}:${site.line + 1} (${site.form})`,
			});
	}
	return { scanned, occurrences };
}

function rowOf(rel: string, site: PathContainmentSite): string {
	return `${rel}#${site.anchor}`;
}

function census(): Promise<Census> {
	return (cached ??= runCensus());
}

const total = (scanned: Map<string, number>): number =>
	[...scanned.values()].reduce((sum, count) => sum + count, 0);

describe("path containment sweep (#2556)", () => {
	it(
		"scans every tree the lane's scope names",
		async () => {
			const { scanned } = await census();
			for (const tree of SCAN_ROOTS)
				assertNonEmptyScan(
					`path containment sweep: ${tree.root} files scanned`,
					scanned.get(tree.root) ?? 0,
					FILE_FLOORS[tree.root] ?? 1,
				);
			assertNonEmptyScan(
				"path containment sweep: index.ts scanned",
				scanned.get("index.ts") ?? 0,
				1,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"admits no hand-rolled containment test over a path.relative result",
		async () => {
			const { scanned, occurrences } = await census();
			if (process.env.PI_LENS_PRINT_PINS === "1")
				for (const occurrence of occurrences)
					console.log(`ROW\t${occurrence.row}\t${occurrence.detail}`);

			const audited = auditRegistry({
				sweepName: "path containment sweep (#2556)",
				flagged: occurrences.map((occurrence) => ({
					key: occurrence.row,
					detail: occurrence.detail,
				})),
				// Nothing is admitted without a reason: a site folds onto the seam or
				// takes a baseline row, so this registry stays empty on purpose.
				registered: [],
				exemptions: { ...SEAM_ADMISSIONS, ...BASELINE },
				scannedCount: total(scanned),
				// The four per-tree floors above, summed: a walk that lost half its
				// input in every tree is not a population.
				minScanned:
					Object.values(FILE_FLOORS).reduce((sum, floor) => sum + floor, 0) + 1,
				// A DEAD-SCAN floor, not a population pin: a detector that stopped
				// matching reads here, while the population itself is held by the
				// shrink-only audit below (a lost site reds as a stale row, which is
				// exact where a floor is only a lower bound). Live: 43 sites.
				minFlagged: 21,
				minReasonLength: 80,
				remediation:
					"Fold the test onto clients/path-utils.ts (isUnderDir for two spellings or identities, isWithinForm for two paths already in one form), or add a baseline row `<file>#<anchor>` naming the reason it stays. Refs #2556.",
			});
			expect(audited.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	/**
	 * The spread prefix is not a parent segment, and the files that spell it must
	 * stay spellings this ratchet reads as clean. Each case has two halves: the
	 * file still carries the `...` test (so the cell cannot go vacuous), and the
	 * detector reports nothing in it.
	 */
	it("never reads a spread prefix as a parent segment", () => {
		for (const rel of [
			"clients/config-warn.ts",
			"clients/middle-man-analysis.ts",
			"tests/support/sweep-kit.ts",
		]) {
			const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
			expect(source, `${rel} still spells a spread prefix`).toContain(
				'startsWith("...")',
			);
			expect(scanPathContainmentSites(source), rel).toEqual([]);
		}
	});

	it("keeps the seam's own predicate out of the shrink-only baseline", () => {
		const overlap = Object.keys(SEAM_ADMISSIONS).filter((row) =>
			Object.hasOwn(BASELINE, row),
		);
		expect(overlap).toEqual([]);
		expect(Object.keys(SEAM_ADMISSIONS)).toEqual([
			"clients/path-utils.ts#isAtOrAboveHomeDir",
		]);
	});
});
