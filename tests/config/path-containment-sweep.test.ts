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
 * - a `path.relative` result handed to another FUNCTION, tested there
 *   (live population 2, both in `tests/support/`:
 *   `vi-mock-export-gate.ts#isProductionModulePath` and
 *   `module-instance-scan.ts#isBuildCompiled`, each already pairing
 *   `path.isAbsolute`). The population the ratchet governs is a `relative`
 *   result reaching the predicate in the SAME file, which is every one of the
 *   19 baseline rows; a cross-file hand-off stays unreported.
 * - a value stored on an object or array and read back later
 *   (`records[i].rel.startsWith("..")`), a reassigned `let`
 *   (`let rel = f(); rel = path.relative(a, b)`), a destructured read, or a
 *   `relative` callee re-exported from another module under another name.
 * - a prefix held in a named constant or a RegExp (`rel.startsWith(UP)`,
 *   `/^\.\./.test(rel)`, `rel.indexOf("..") === 0`). Measured on the authoring
 *   head: no `..`-only constant or `..`-anchored RegExp exists in the scanned
 *   trees, so the live population is 0.
 * - a relative result read through a member chain whose method returns
 *   something unrelated (`rel.split("/").length`), which the fail-closed
 *   reading reports rather than drops.
 *
 * SCOPE: `clients/`, `tools/`, `mcp/`, `index.ts` (the trees
 * `path-identity-sweep` already scans) plus `tests/support/`, where the #4878
 * F1 site shipped. `tests/config/` is out of scope by this lane's decision; its
 * own `startsWith("..")` population is 0 by grep at the authoring head
 * (`grep -rn 'startsWith("\.\.' tests/config` finds only prose and one fixture
 * STRING, which is not code).
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

/** The trees this lane scans: the shipped runtime, plus the test support tree. */
const SCAN_TREES = ["clients", "tools", "mcp", "tests/support"] as const;

/**
 * Half the live file count per tree, so a moved root or a dropped tree reds
 * instead of reading as a clean population (defect shape 10). Live on the
 * authoring head: 512 `clients/`, 16 `tools/`, 6 `mcp/`, 124 `tests/support/`.
 */
const FILE_FLOORS: Readonly<Record<string, number>> = {
	clients: 256,
	tools: 8,
	mcp: 3,
	"tests/support": 60,
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
 * named symbol, so a SECOND containment test inside an admitted function
 * reds (a duplicate row key is refused by the audit) and a removed one reds as
 * stale. The baseline only shrinks: nothing here is fixed in this lane, because
 * no site is reproduced through a production call path (principles §1,
 * speculative robustness) — the #2556 comment names them as a member list, not
 * as findings.
 *
 * Two members the issue's hand census (16: 6 without an isAbsolute arm, 10
 * with) did not list are here too, because the structural detector finds them:
 * `go-vet.ts` spells the call as a named `relative` import, and `mcp/server.ts`
 * sits outside the census's grep roots. Both are the same shape; leaving them
 * unlisted would make the ratchet red on the head it ships.
 */
const BASELINE: Readonly<Record<string, string>> = {
	"clients/actionable-warnings.ts#legacyActionableWarningId": `${CROSS_DRIVE} A cross-drive relative reads as an in-tree file, so a legacy finding id keeps a relative component for a path outside the project; it fails toward a duplicate id, never toward a dropped finding.`,
	"clients/cache-manager.ts#toTurnStateKey": `${CROSS_DRIVE} A cross-drive relative reads as an in-tree key, so the turn-state key for a file outside cwd stays relative instead of falling back to the absolute form.`,
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
	"clients/lsp/client-registry.ts#resolveServerRoot": `${DOTDOT_NAME} A root under a directory named \`..foo\` reads as outside its ancestor key, so the root chain stops one level early. Paired with \`pathApi.isAbsolute\` in the same expression.`,
	"clients/lsp/server.ts#cargoWorkspaceDeclaresMember": `${CROSS_DRIVE} A cross-drive relative reads as inside the manifest dir, so a cargo workspace member outside it is accepted and its crates are swept into the wrong root.`,
	"clients/lsp/server.ts#isSameOrWithin": `${DOTDOT_NAME} A candidate under a directory named \`..foo\` reads as outside the root, so an in-root workspace member is not grouped with its workspace. Paired with \`pathApi.isAbsolute\` in the same expression.`,
	"clients/lsp/workspace-diagnostics-cache.ts#clearWorkspaceDiagnosticsCacheAtAndAbove": `${DOTDOT_NAME} A root under a directory named \`..foo\` reads as outside the ceiling, so the cache prune stops at an ancestor the root is not under.`,
	"clients/path-utils.ts#inside": `${DOTDOT_NAME} A third containment predicate inside the seam's own module (\`toProjectRelativePath\`): a file under a directory named \`..foo\` reads as outside the root, so no project-relative path is derived for it. Baselined rather than folded because this lane changes no production site; moving it onto \`isWithinForm\` is #2556's remainder.`,
	"clients/project-lens-config.ts#findNestedProjectMutationValue": `${DOTDOT_NAME} A directory whose name starts with \`..\` reads as outside the project root, so a nested config section under it is not read.`,
	"clients/python-environment.ts#isUvWorkspaceMember": `${DOTDOT_NAME} A member under a directory named \`..foo\` reads as outside the workspace root, so its uv settings are not inherited: the over-inheritance #4847 guarded against, in the other direction.`,
	"clients/python-environment.ts#isWithinProjectRoot": `${DOTDOT_NAME} An ambient environment root under a directory named \`..foo\` reads as outside the project, so it is not borrowed. Template-literal spelling, missed by the hand census.`,
	"clients/test-runner-client.ts#isExcludedTestTarget": `${DOTDOT_NAME} A target under a directory named \`..foo\` reads as outside the project, so the fail-closed exclusion path runs for an in-tree file.`,
	"clients/test-runner-client.ts#relativeSourceDir": `${DOTDOT_NAME} A source directory whose name starts with \`..\` reads as outside cwd, so the mirrored test-tree candidate is not computed for it.`,
	"mcp/server.ts#isWithinServerWorkspace": `${DOTDOT_NAME} A cwd under a directory named \`..foo\` reads as outside the server's workspace, so an in-workspace route is rejected. Outside the roots the issue's hand census grepped.`,
	"tests/support/v8-coverage.ts#fileFromScriptUrl": `${CROSS_DRIVE} A cross-drive relative reads as inside the coverage root, so a script outside \`include\` is reported as a covered file. The only member in \`tests/support/\`, the tree the #4878 F1 site shipped in.`,
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
		...SCAN_TREES.flatMap((tree) =>
			listSourceFiles(path.join(REPO_ROOT, tree)),
		),
		path.join(REPO_ROOT, "index.ts"),
	];
	for (const file of files) {
		const rel = relativePosix(REPO_ROOT, file);
		const tree = SCAN_TREES.find((root) => rel.startsWith(`${root}/`)) ?? rel;
		const source = readWalkedFile(file);
		// Shape 81: a native tree is freed only when the event loop turns, so
		// yield once per file instead of holding every parsed tree to the end.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (source === undefined) continue;
		scanned.set(tree, (scanned.get(tree) ?? 0) + 1);
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
			for (const tree of SCAN_TREES)
				assertNonEmptyScan(
					`path containment sweep: ${tree} files scanned`,
					scanned.get(tree) ?? 0,
					FILE_FLOORS[tree] ?? 1,
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
					FILE_FLOORS.clients +
					FILE_FLOORS.tools +
					FILE_FLOORS.mcp +
					(FILE_FLOORS["tests/support"] ?? 0) +
					1,
				// Live population on the authoring head: 19 sites.
				minFlagged: 15,
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
