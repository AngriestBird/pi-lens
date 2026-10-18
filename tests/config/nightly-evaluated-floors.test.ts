import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { toPosix } from "../../clients/path-utils.js";
import { COMPLEXITY_ANALYZED_FILES_FLOOR } from "../../scripts/complexity-report.mjs";
import {
	countEvaluated,
	EVALUATED_DIR_ENV,
	EVALUATED_PRODUCERS,
} from "../../scripts/lib/assert-evaluated.mjs";
import type {
	CoERow,
	CoESite,
	CoEStatus,
} from "../support/continue-on-error-census.js";
import {
	floorProblems,
	liveRunText,
	readProducerCensus,
	rowProblems,
	stepIdentity,
	stripShellComments,
} from "../support/continue-on-error-census.js";
import {
	auditRegistry,
	stripSource,
	testDeclarations,
} from "../support/sweep-kit.js";
import { vitestCollects } from "../support/vitest-collection.js";

// Recurrence #4514 (retro P2): the four best-effort LSP producers exit 0 under
// continue-on-error, so the nightly read green while 41 captured servers fell
// to 16. A floor is a MEASURED constant: its measuring command and raw output
// are tracked (tests/fixtures/nightly-floors/measurements.json) and this file
// pins each floor between the degraded and the healthy measurement, so a floor
// raised past what a healthy runner reaches (a nightly red forever) and a
// floor lowered under the degraded night (a gate that would not have fired)
// both red here. It also pins the wiring: a producer that stops reporting, a
// floor step made continue-on-error, and a refresh PR that no longer asks
// whether the night evaluated anything.
const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const measurements = JSON.parse(
	read("tests/fixtures/nightly-floors/measurements.json"),
) as {
	producers: Record<
		string,
		Record<"healthy" | "degraded", { evaluated: number; lines: string[] }>
	>;
	lspHandshake: Record<
		"healthy" | "degraded",
		{ passed: number; line: string }
	>;
};

const lastInt = (line: string) => Number(/(\d+)\s*$/.exec(line)?.[1]);
const many = <T>(n: number, row: T) => Array.from({ length: n }, () => row);

/**
 * Why a `governed-by` row's named test proves nothing, or `[]` when it does.
 * AGENTS "Test requirements": a detector that decides a test exists counts live
 * declarations (`testDeclarations`) in a file vitest collects
 * (`vitestCollects`), never a path that merely exists (#4609 r2 F-1,
 * Greptile r4306428644: a directory and a declaration-free file both passed).
 */
const governedByTestProblems = (
	root: string,
	key: string,
	test: string,
): string[] => {
	const relative = toPosix(test);
	const absolute = resolve(root, relative);
	if (!existsSync(absolute) || !statSync(absolute).isFile())
		return [`${key}: ${test} is not a file`];
	const declared = testDeclarations(readFileSync(absolute, "utf8")).filter(
		(entry) => entry.live,
	);
	if (declared.length === 0) return [`${key}: ${test} declares no live test`];
	if (!vitestCollects(relative))
		return [`${key}: vitest does not collect ${test}`];
	return [];
};

/**
 * Whether this host can create a symlink. The Windows leg runs this file under
 * a runner without the privilege, so the symlink plant skips there; the
 * directory plant beside it covers the non-file branch on every platform.
 */
const symlinkSupported = (() => {
	const probe = mkdtempSync(join(tmpdir(), "pi-lens-coe-symlink-"));
	try {
		writeFileSync(join(probe, "target.yml"), "jobs: {}\n");
		symlinkSync("target.yml", join(probe, "link.yml"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

/**
 * The value each script hands writeEvaluatedRecord, rebuilt from the raw log
 * lines of a real night, plus rows the count must NOT include (a refused or
 * unclassified row). The count itself is EVALUATED_COUNTS, the one function the
 * script also calls, so a mutation of a count expression reds the derivation
 * below (the idle count read as `counts.total`, probe-clean-signal dropping its
 * `n/a (pull)` arm, characterize-lsp counting refused rows).
 */
const INPUT: Record<string, (lines: string[]) => unknown> = {
	"characterize-lsp": (lines) => [
		...many(lastInt(lines[0]), { mode: "pull" }),
		...many(lastInt(lines[1]), { mode: "push-only" }),
		...many(3, { mode: "unknown" }),
		...many(2, { mode: "refused: project trust is unknown" }),
	],
	"probe-clean-signal": (lines) => [
		...many(lastInt(lines[0]), { behavior: "publishes-versioned" }),
		...many(lastInt(lines[1]), { behavior: "publishes-unversioned" }),
		...many(lastInt(lines[2]), { behavior: "silent" }),
		...many(lastInt(lines[3]), { behavior: "n/a (pull)" }),
		...many(4, { behavior: "unknown" }),
	],
	"server-capabilities": ([line]) =>
		many(Number(/\((\d+) servers captured/.exec(line)?.[1]), {}),
	"measure-lsp-idle-eviction": ([line]) => {
		const m =
			/(\d+) registry servers: (\d+) eligible, (\d+) vetoed, (\d+) inconclusive, (\d+) unavailable/.exec(
				line,
			);
		return {
			total: Number(m?.[1]),
			eligible: Number(m?.[2]),
			vetoed: Number(m?.[3]),
			inconclusive: Number(m?.[4]),
			unavailable: Number(m?.[5]),
		};
	},
};
/** The identifier each script passes as `input`, pinned so it cannot pass a slice. */
const SCRIPT_INPUT: Record<string, string> = {
	"characterize-lsp": "rows",
	"probe-clean-signal": "rows",
	"server-capabilities": "rows",
	"measure-lsp-idle-eviction": "counts",
};

describe("nightly evaluated floors are measured, not guessed (#4514)", () => {
	it("registers exactly the producers that have a measurement", () => {
		expect(Object.keys(EVALUATED_PRODUCERS).sort()).toEqual(
			Object.keys(measurements.producers).sort(),
		);
		expect(Object.keys(INPUT).sort()).toEqual(
			Object.keys(EVALUATED_PRODUCERS).sort(),
		);
	});

	describe.each(Object.keys(EVALUATED_PRODUCERS))("%s", (producer) => {
		const spec = EVALUATED_PRODUCERS[producer];
		const { healthy, degraded } = measurements.producers[producer];

		it("derives each measurement's count from its raw log lines", () => {
			expect(countEvaluated(producer, INPUT[producer](healthy.lines))).toBe(
				healthy.evaluated,
			);
			expect(countEvaluated(producer, INPUT[producer](degraded.lines))).toBe(
				degraded.evaluated,
			);
		});

		it("sits above the degraded night and at or below the healthy one", () => {
			expect(spec.floor).toBeGreaterThan(degraded.evaluated);
			expect(spec.floor).toBeLessThanOrEqual(healthy.evaluated);
		});

		// A doc floor of 1 is the matrix's "not emptied" guard, a different unit.
		const docFloor = spec.doc && spec.doc.floor > 1 ? spec.doc.floor : 0;
		it.skipIf(docFloor === 0)(
			"holds a doc floor in the same band where the doc count is the same unit",
			() => {
				expect(docFloor).toBeGreaterThan(degraded.evaluated);
				expect(docFloor).toBeLessThanOrEqual(healthy.evaluated);
			},
		);

		it("is reported by its own script", () => {
			const code = stripSource(read(`scripts/${producer}.mjs`), {
				strings: "keep",
			});
			// The script hands over its rows, never a count of its own: the one
			// count function (EVALUATED_COUNTS) is what the test above derives.
			expect(code).toMatch(
				new RegExp(
					`writeEvaluatedRecord\\(\\{\\s*producer:\\s*"${producer}",\\s*input:\\s*${SCRIPT_INPUT[producer]},?\\s*\\}\\)`,
				),
			);
		});
	});
});

type Step = {
	name?: string;
	id?: string;
	if?: string;
	run?: string;
	uses?: string;
	"continue-on-error"?: unknown;
	"timeout-minutes"?: unknown;
};
type Job = {
	env?: Record<string, string>;
	steps?: Step[];
	outputs?: Record<string, string>;
	"continue-on-error"?: unknown;
};
const workflow = yaml.load(read(".github/workflows/tool-smoke.yml")) as {
	jobs: Record<string, Job>;
};
const smoke = workflow.jobs["tool-smoke"];
const prs = workflow.jobs["tool-smoke-prs"];
const step = (job: Job, needle: string) => {
	const found = (job.steps ?? []).find((s) => s.name?.includes(needle));
	if (!found) throw new Error(`no step named like "${needle}"`);
	return found;
};

describe("the floor step and the refresh guard are wired and gating (#4514)", () => {
	it("runs the floor as a step that cannot be continue-on-error, after every producer and layer", () => {
		const steps = smoke.steps ?? [];
		const floor = step(smoke, "LSP evaluated floor");
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.id).toBe("evaluated_floor");
		const run = liveRunText(floor);
		expect(run).toContain("scripts/assert-evaluated.mjs --records");
		// A doc-only loss (a matrix cell gone `unknown`) must red the step the
		// notifier reads, not only the refresh job that no tracker watches.
		expect(run).toMatch(/--records "\$\w+" --docs\b/);
		expect(run).toMatch(/^\s*set -o pipefail\s*$/m);
		const at = (name: string) => steps.indexOf(step(smoke, name));
		for (const earlier of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
			"Resolution layer",
		])
			expect(at("LSP evaluated floor"), earlier).toBeGreaterThan(at(earlier));
	});

	it("names the records directory once, in the job env the producers and the floor step share", () => {
		const dir = smoke.env?.[EVALUATED_DIR_ENV];
		expect(dir).toBeTruthy();
		expect(liveRunText(step(smoke, "LSP evaluated floor"))).toContain(
			`"$${EVALUATED_DIR_ENV}"`,
		);
	});

	it("keeps the four producers best-effort (the floor, not them, carries the verdict)", () => {
		for (const name of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
		])
			expect(step(smoke, name)["continue-on-error"], name).toBe(true);
	});

	it("gives the LSP handshake a --min-pass at or below what a healthy and a degraded night both passed", () => {
		const floor = floorOf(
			liveRunText(step(smoke, "LSP handshake layer")),
			/--min-pass=(\d+)/,
		);
		expect(floor).toBeGreaterThan(0);
		for (const night of ["healthy", "degraded"] as const)
			expect(floor).toBeLessThanOrEqual(
				measurements.lspHandshake[night].passed,
			);
		for (const night of ["healthy", "degraded"] as const)
			expect(measurements.lspHandshake[night].line).toContain(
				`${measurements.lspHandshake[night].passed} passed`,
			);
	});

	it("passes --min-pass from main() into the handshake layer (call-site pin)", () => {
		const code = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(code).toMatch(
			/runLspHandshake\(\{\s*langs,\s*install,\s*verbose,\s*minPass\s*\}\)/,
		);
	});

	it("opens no refresh PR before the regenerated docs are checked against HEAD", () => {
		const steps = prs.steps ?? [];
		const guard = step(prs, "Refuse a degraded refresh");
		expect(guard["continue-on-error"]).toBeUndefined();
		expect(liveRunText(guard)).toContain("scripts/assert-evaluated.mjs --docs");
		const guardAt = steps.indexOf(guard);
		expect(guardAt).toBeGreaterThan(steps.indexOf(step(prs, "Overlay")));
		for (const open of [
			"Open/update LSP-docs refresh PR",
			"Open/update idle-eviction promotion PR",
		])
			expect(steps.indexOf(step(prs, open)), open).toBeGreaterThan(guardAt);
	});
});

// Recurrence #4518 (retro P2, the rest of the audit): five more producers sat
// under continue-on-error with no proof of work (the APFS anchors, the Swift
// crash-watch, the PR-time LSP handshake, the complexity report, plus the
// mise-repro and lint jobs that carry a stated reason instead). The floors are
// MEASURED (tests/fixtures/nightly-floors/measurements.json, nonLspFloors) and
// pinned here in both directions: at or below what a healthy run reached (a
// floor above it is a job red forever) and within half of it (a floor of 1 is
// the "did anything run" guard the job already had, not a measured one).
const nonLsp = (
	measurements as unknown as {
		nonLspFloors: {
			"apfs-anchors": { healthy: { evaluated: number; line: string } };
			"install-smoke-lsp-handshake": {
				healthy: Array<{ passed: number; line: string }>;
			};
			"swift-crash-watch": { healthy: { evaluated: number } };
			"complexity-report": { healthy: { evaluated: number } };
			"windows-vitest": { healthy: { evaluated: number; line: string } };
		};
	}
).nonLspFloors;
const withinMeasured = (floor: number, measured: number, fraction = 0.5) => {
	expect(floor).toBeGreaterThan(0);
	expect(floor).toBeLessThanOrEqual(measured);
	expect(floor).toBeGreaterThanOrEqual(measured * fraction);
};
const loadWorkflow = (file: string) =>
	yaml.load(read(`.github/workflows/${file}`)) as {
		jobs: Record<string, Job>;
	};
const floorOf = (run: string | undefined, re: RegExp) =>
	Number(re.exec(run ?? "")?.[1]);

describe("the floors outside the LSP nightly are measured and wired (#4518)", () => {
	it("floors the APFS anchors on tests executed, in a step that cannot be continue-on-error", () => {
		const job = loadWorkflow("ci.yml").jobs["install-test"];
		const anchors = step(job, "POSIX case-insensitive anchors");
		const floor = step(job, "APFS anchors evaluated floor");
		// The results stay advisory; only "nothing ran" is gating.
		expect(anchors["continue-on-error"]).toBe(true);
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.if).toContain("macos-latest");
		expect(floor.if).toContain("!cancelled()");
		const steps = job.steps ?? [];
		expect(steps.indexOf(floor)).toBeGreaterThan(steps.indexOf(anchors));
		// The reporter file the vitest step writes is the file the floor reads.
		expect(anchors.run).toContain(
			'--reporter=json --outputFile.json="$RUNNER_TEMP/apfs-anchors.json"',
		);
		const floorRun = liveRunText(floor);
		expect(floorRun).toContain('"$RUNNER_TEMP/apfs-anchors.json"');
		expect(floorRun).toContain("j.numPassedTests+j.numFailedTests");
		expect(floorRun).toMatch(/--count "apfs-anchors=\$\{count\}"/);
		// 100 of the measured 223 is a decision (review r1 F5): the leg is
		// required, the step exists to catch a run that executed nothing, and a
		// 10% margin would red it on a legitimate removal of 24 tests.
		withinMeasured(
			floorOf(floorRun, /--floor (\d+)/),
			nonLsp["apfs-anchors"].healthy.evaluated,
			0.4,
		);
		expect(nonLsp["apfs-anchors"].healthy.line).toContain(
			`${nonLsp["apfs-anchors"].healthy.evaluated} passed`,
		);
	});

	it("turns exactly 'swift was not evaluated' into a red job, and says so when swift can be lifted", () => {
		const job = loadWorkflow("grammar-health.yml").jobs["swift-crash-watch"];
		const watch = step(job, "Force-load swift");
		const floor = step(job, "Swift crash-watch evaluated floor");
		expect(watch["continue-on-error"]).toBeUndefined();
		expect(floor["continue-on-error"]).toBeUndefined();
		const steps = job.steps ?? [];
		expect(steps.indexOf(floor)).toBeGreaterThan(steps.indexOf(watch));
		// check-grammar-load.mjs: 2 = runtime unavailable, 3 = grammar did not
		// load; both evaluated nothing. Exit 0 is the lift signal; any other
		// status is the known #423 crash and IS an evaluation.
		expect(watch.run).toMatch(/2\|3\)\s*\n\s*evaluated=0/);
		expect(watch.run).toMatch(/0\)\s*\n\s*evaluated=1/);
		expect(watch.run).toMatch(/\*\)\s*\n\s*evaluated=1/);
		expect(watch.run).toContain("::notice title=Swift crash-watch::");
		expect(watch.run).toContain(
			'echo "evaluated=${evaluated}" >> "$GITHUB_OUTPUT"',
		);
		expect((floor as { env?: Record<string, string> }).env?.EVALUATED).toBe(
			"${{ steps.swift.outputs.evaluated }}",
		);
		expect(liveRunText(floor)).toContain(
			'--count "swift-crash-watch=${EVALUATED}" --floor',
		);
		withinMeasured(
			floorOf(liveRunText(floor), /--floor (\d+)/),
			nonLsp["swift-crash-watch"].healthy.evaluated,
		);
	});

	it("gives the PR-time LSP handshake a --min-pass at or below both measured PR runs", () => {
		const job = loadWorkflow("install-smoke.yml").jobs["lsp-handshake"];
		const floor = floorOf(
			liveRunText(step(job, "LSP handshake layer")),
			/--min-pass=(\d+)/,
		);
		const passes = nonLsp["install-smoke-lsp-handshake"].healthy.map(
			(h) => h.passed,
		);
		withinMeasured(floor, Math.min(...passes));
		for (const h of nonLsp["install-smoke-lsp-handshake"].healthy)
			expect(h.line).toContain(`${h.passed} passed`);
	});

	it("hands the analysed-files floor to assertEvaluated and pins it under the measured count", () => {
		withinMeasured(
			COMPLEXITY_ANALYZED_FILES_FLOOR,
			nonLsp["complexity-report"].healthy.evaluated,
		);
	});

	it("floors the Windows subset on tests executed, in the step that already reds a failed outcome", () => {
		const job = loadWorkflow("ci.yml").jobs["unit-tests-windows"];
		const failStep = step(job, "under-executed");
		expect(failStep["continue-on-error"]).toBeUndefined();
		expect(liveRunText(failStep)).toContain(
			'--count "windows-vitest=${executed}"',
		);
		withinMeasured(
			floorOf(liveRunText(failStep), /--floor (\d+)/),
			nonLsp["windows-vitest"].healthy.evaluated,
		);
		expect(nonLsp["windows-vitest"].healthy.line).toContain(
			`${nonLsp["windows-vitest"].healthy.evaluated} passed`,
		);
	});

	it("states why each job without a floor needs none, directly above the job", () => {
		const lint = read(".github/workflows/lint.yml");
		for (const job of ["jscpd", "strictness", "yamllint", "typos", "taplo"]) {
			const at = lint.indexOf(`\n  ${job}:\n`);
			expect(at, job).toBeGreaterThan(0);
			const above = lint.slice(Math.max(0, at - 700), at);
			expect(above, job).toMatch(/# No floor \(#4518\): /);
		}
		const install = read(".github/workflows/install-smoke.yml");
		const miseAt = install.indexOf("\n  mise-repro:\n");
		expect(miseAt).toBeGreaterThan(0);
		expect(install.slice(miseAt, miseAt + 1500)).toMatch(
			/# No floor \(#4518\): /,
		);
	});

	it("keeps the pass-floor, census-plan and file-count comparisons in the one helper (net-count rule)", () => {
		const call = /\bassertEvaluated\(/;
		for (const file of [
			"scripts/smoke-tools.mjs",
			"scripts/ci-shuffle-census.mjs",
			"scripts/complexity-report.mjs",
		]) {
			const code = stripSource(read(file), { strings: "blank" });
			expect(code, file).toMatch(call);
		}
		// The ad hoc comparison the helper replaced must not come back beside it.
		const smoke = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(smoke).not.toMatch(/passed\s*>=\s*minPass/);
		const census = stripSource(read("scripts/ci-shuffle-census.mjs"), {
			strings: "blank",
		});
		expect(census).not.toMatch(/if\s*\(\s*missing\.length\s*>\s*0\s*\)/);
	});
});

// #4518's remainder: the r1 floors covered the sites the issue listed, and a
// sweep found the rest of the tree. A `continue-on-error` producer that
// evaluates nothing reads green, so every such site is registered in
// tests/fixtures/nightly-floors/continue-on-error-sites.json as `floored`
// (naming the gating step whose LIVE text carries the floor), `no-floor`
// (naming the reader that makes an empty result visible), or `governed-by`
// (naming the issue and the tests that own it). The population is DERIVED from
// the parsed files, so a new site, a site the parser stops seeing, and a file
// form the reader does not classify all red here instead of joining silently.
// Review r1 (#4609) found three holes this file now closes: the population
// stopped at `.github/workflows/*.yml` (F1), the floor check matched prose, so
// a comment or an `if: false` step satisfied it (F2), and `tool-smoke.yml` was
// excluded as a FILE, so a new non-LSP site in it was invisible (F4).
const COE_REGISTRY =
	"tests/fixtures/nightly-floors/continue-on-error-sites.json";
const coeRegistry = JSON.parse(read(COE_REGISTRY)) as {
	sites: Record<string, CoERow>;
};
const coeKeys = Object.keys(coeRegistry.sites).sort();
const census = readProducerCensus(ROOT);

describe("every continue-on-error site in the workflow and action tree is registered (#4518)", () => {
	it("reads every file under the producer roots, and classifies every form it finds", () => {
		// A reader that silently skips a file form is a guard with a hole in it
		// (#4609 r1 F1: a `.yaml` workflow and a composite action were both
		// outside the population and outside the old raw-key guard).
		expect(census.unclassified).toEqual([]);
		expect(census.problems).toEqual([]);
		const files = census.files.map((file) => file.path);
		expect(files).toEqual(
			expect.arrayContaining([
				".github/workflows/ci.yml",
				".github/workflows/tool-smoke.yml",
				".github/actions/tool-tree-cache/action.yml",
			]),
		);
		expect(census.files.length).toBeGreaterThanOrEqual(26);
	});

	it("accounts for every site as a floor, a stated reader, or a named owner", () => {
		const audit = auditRegistry({
			sweepName: "continue-on-error census",
			// A `no-floor` row is an admitted exemption with its own reason, so
			// the kit's stale-entry and reason-length checks cover it too.
			flagged: census.sites.map((site) => ({
				key: site.key,
				detail: `${site.file}:${site.scope}${site.step ? ` (${stepIdentity(site.step)})` : ""}`,
			})),
			registered: coeKeys.filter(
				(key) => coeRegistry.sites[key]?.status !== "no-floor",
			),
			exemptions: Object.fromEntries(
				coeKeys
					.filter((key) => coeRegistry.sites[key]?.status === "no-floor")
					.map((key) => [key, coeRegistry.sites[key]?.reason ?? ""]),
			),
			minFlagged: 52,
			scannedCount: census.files.length,
			minScanned: 26,
			remediation:
				"Register the site in tests/fixtures/nightly-floors/continue-on-error-sites.json: floored (a gating step whose live run text carries the floor), no-floor (the reader that makes an empty result visible), or governed-by (the issue and tests that own it).",
		});
		expect(audit.problems).toEqual([]);
	});

	it("registers exactly the sites the census reads, so an unregistered site and a stale row both red", () => {
		expect(census.sites.map((site) => site.key).sort()).toEqual(coeKeys);
	});

	it("gives every row a usable record, and names tests that exist", () => {
		expect(
			coeKeys.flatMap((key) => rowProblems(key, coeRegistry.sites[key])),
		).toEqual([]);
		expect(
			coeKeys.flatMap((key) => {
				const row = coeRegistry.sites[key];
				if (row.status !== "governed-by") return [];
				expect(row.tests?.length, key).toBeGreaterThan(0);
				return (row.tests ?? []).flatMap((test) =>
					governedByTestProblems(ROOT, key, test),
				);
			}),
		).toEqual([]);
	});

	it("gives every floored site a live gating step, after the site, whose run text carries its floor", () => {
		expect(
			census.sites.flatMap((site) =>
				floorProblems(
					site,
					coeRegistry.sites[site.key] ?? { status: "no-floor", reason: "" },
				),
			),
		).toEqual([]);
	});

	it("pins the six job headers the registry marks as human-facing copy", () => {
		const headered = coeKeys.filter((key) => coeRegistry.sites[key].header);
		expect(headered.length).toBe(6);
		const lint = read(".github/workflows/lint.yml");
		for (const job of ["jscpd", "strictness", "yamllint", "typos", "taplo"]) {
			const at = lint.indexOf(`\n  ${job}:\n`);
			expect(at, job).toBeGreaterThan(0);
			expect(lint.slice(Math.max(0, at - 700), at), job).toMatch(
				/# No floor \(#4518\): /,
			);
		}
		const install = read(".github/workflows/install-smoke.yml");
		const miseAt = install.indexOf("\n  mise-repro:\n");
		expect(miseAt).toBeGreaterThan(0);
		expect(install.slice(miseAt, miseAt + 1500)).toMatch(
			/# No floor \(#4518\): /,
		);
		// One header per marked row, in the file that row lives in: an orphan
		// header (no row) and a row with no header both red.
		for (const file of new Set(headered.map((key) => key.split("#")[0]))) {
			const text = read(file);
			expect(text.match(/# No floor \(#4518\): /g)?.length ?? 0, file).toBe(
				headered.filter((key) => key.startsWith(`${file}#`)).length,
			);
		}
	});

	it("registers the four producers #4514 floors one by one, so a new site in the LSP nightly reds", () => {
		const nightly = census.sites.filter(
			(site) => site.file === ".github/workflows/tool-smoke.yml",
		);
		for (const name of [
			"LSP capability matrix (characterize diagnostic mode per server)",
			"LSP clean-signal probe (Tier 2 vs 3 among push servers)",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
		]) {
			const site = nightly.find((entry) => entry.step?.name?.includes(name));
			expect(site, name).toBeDefined();
			const row = site ? coeRegistry.sites[site.key] : undefined;
			expect(row?.status, name).toBe("governed-by");
			expect(row?.governedBy, name).toBe("#4514");
		}
	});
});

// #4609 r1 F3: every fail-closed path above needs a checked-in plant a future
// edit cannot delete by accident. The trees are built per case, so a broken
// fixture never sits in the repository (where yamllint and the workflow sweeps
// would read it) and each plant names the one shape it exercises.
describe("the census fails closed on every producer surface and floor shape", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});
	const tree = (files: Record<string, string>): string => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-coe-census-"));
		roots.push(root);
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), body);
		}
		return root;
	};
	const PROBE = `"on": push
jobs:
  probe:
    runs-on: ubuntu-latest
`;

	it("reads a .yaml workflow and a composite action step, and finds them unaccounted without a row", () => {
		const root = tree({
			".github/workflows/zz-probe.yaml": `${PROBE}    continue-on-error: true
    steps:
      - name: best effort
        continue-on-error: true
        run: echo hi
`,
			".github/actions/probe/action.yaml": `name: probe
runs:
  using: composite
  steps:
    - name: composite best effort
      shell: bash
      continue-on-error: true
      run: echo hi
`,
		});
		const found = readProducerCensus(root);
		expect(found.problems).toEqual([]);
		expect(found.files.map((file) => file.kind).sort()).toEqual([
			"composite",
			"workflow",
		]);
		expect(found.sites.map((site) => site.key).sort()).toEqual([
			".github/actions/probe/action.yaml#composite best effort",
			".github/workflows/zz-probe.yaml#probe",
			".github/workflows/zz-probe.yaml#probe#best effort",
		]);
		const audit = auditRegistry({
			sweepName: "fixture",
			flagged: found.sites.map((site) => site.key),
			registered: [],
		});
		expect(audit.unaccounted.sort()).toEqual(
			found.sites.map((site) => site.key).sort(),
		);
	});

	it("reds on a file under a producer root that it does not classify", () => {
		const root = tree({
			".github/workflows/README.md": "# notes\n",
			".github/workflows/zz-probe.yml": `${PROBE}    steps: []
`,
			".github/actions/probe.yml": "name: stray\n",
			".github/actions/probe/README.md": "# notes\n",
		});
		const found = readProducerCensus(root);
		expect(found.files.map((file) => file.path)).toEqual([
			".github/workflows/zz-probe.yml",
		]);
		expect(found.problems.map((problem) => problem.split(":")[0])).toEqual([
			".github/workflows/README.md",
			".github/actions/probe.yml",
			".github/actions/probe/README.md",
		]);
		expect(found.problems[0]).toContain("does not classify");
	});

	it("reds on a directory named like a producer file instead of walking past it", () => {
		const root = tree({
			".github/workflows/real.yml": `${PROBE}    steps: []
`,
			".github/workflows/zz-dir.yml/notes.txt": "a nested file\n",
		});
		const found = readProducerCensus(root);
		expect(found.files.map((file) => file.path)).toEqual([
			".github/workflows/real.yml",
		]);
		expect(found.problems).toEqual([
			expect.stringContaining(".github/workflows/zz-dir.yml:"),
		]);
	});

	it.skipIf(!symlinkSupported)(
		"reds on a symlinked producer file instead of following it",
		() => {
			const root = tree({
				".github/workflows/real.yml": `${PROBE}    steps: []
`,
			});
			symlinkSync(
				join(root, ".github/workflows/real.yml"),
				join(root, ".github/workflows/link.yml"),
			);
			const found = readProducerCensus(root);
			// GitHub runs no symlinked workflow, and following the link could read
			// bytes outside the producer roots, so it is reported, never parsed.
			expect(found.files.map((file) => file.path)).toEqual([
				".github/workflows/real.yml",
			]);
			expect(found.problems).toEqual([
				expect.stringContaining(".github/workflows/link.yml:"),
			]);
		},
	);

	it("reds on an unparseable producer file instead of reading it as site-free", () => {
		const root = tree({
			".github/workflows/broken.yml":
				"jobs:\n  a:\n     steps:\n   - name: bad indentation\n",
		});
		expect(readProducerCensus(root).problems).toEqual([
			expect.stringContaining("unparseable producer file"),
		]);
	});

	it("reads a flow-style key and ignores the key spelled in a comment or a run heredoc", () => {
		const root = tree({
			".github/workflows/parser-smoke.yml": `${PROBE}    steps:
      # continue-on-error: true
      - {name: Flow-style unregistered producer, continue-on-error: true, run: echo hi}
      - name: Writes an example workflow
        run: |
          cat > example.yml <<'YAML'
          jobs:
            demo:
              continue-on-error: true
          YAML
      - name: Mentions the key in a comment
        run: |
          # continue-on-error: true
          echo hi
`,
		});
		const found = readProducerCensus(root);
		expect(found.problems).toEqual([]);
		expect(found.sites.map((site) => site.key)).toEqual([
			".github/workflows/parser-smoke.yml#probe#Flow-style unregistered producer",
		]);
	});

	it("reds on a continue-on-error key at a location that is not a job or a step", () => {
		const root = tree({
			".github/workflows/odd.yml": `${PROBE}    services:
      cache:
        image: redis
        continue-on-error: true
    steps: []
`,
		});
		const found = readProducerCensus(root);
		expect(found.sites).toEqual([]);
		expect(found.problems).toEqual([
			".github/workflows/odd.yml: continue-on-error at an unclassified location: jobs.probe.services.cache.continue-on-error",
		]);
	});

	// F2 plants: a floored row is satisfied only by a live line of a step the
	// runner executes.
	const KEY = ".github/workflows/floor.yml#probe#best effort";
	const flooredStep = (floor: string): string[] => {
		const root = tree({
			".github/workflows/floor.yml": `${PROBE}    steps:
      - name: best effort
        continue-on-error: true
        run: node scripts/producer.mjs
${floor}`,
		});
		const found = readProducerCensus(root);
		expect(found.problems).toEqual([]);
		const site = found.sites.find(
			(entry) => entry.step?.name === "best effort",
		);
		expect(site).toBeDefined();
		return floorProblems(site as CoESite, {
			status: "floored",
			floorStep: "evaluated floor",
			evidence: '--count "probe=',
			reason: "A fixture row; the reason only has to clear the length floor.",
		});
	};

	it("accepts a floor the runner reaches and reads as a command", () => {
		expect(
			flooredStep(`      - name: evaluated floor
        run: |
          set -o pipefail
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toEqual([]);
		// A heredoc earlier in the same step hides only its own body: the command
		// after the terminator is still the floor (the plant beside this case).
		expect(
			flooredStep(`      - name: evaluated floor
        run: |
          cat <<'EOF' > notes.txt
          a note that mentions --count "probe=$count"
          EOF
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toEqual([]);
	});

	it("reds when the only occurrence of the floor sits in a shell comment", () => {
		expect(
			flooredStep(`      - name: evaluated floor
        run: |
          # node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          echo "handshake layer disabled in this probe"
`),
		).toEqual([
			`${KEY}: "--count "probe=" is not on an executable line of that step's run text`,
		]);
	});

	it("reds when the runner skips the floor step", () => {
		// YAML source vs. the value the parser returns: `"!true"` needs its
		// quotes here, because a bare `!true` is a YAML tag, not a condition.
		for (const [source, value] of [
			["false", "false"],
			["${{ false }}", "${{ false }}"],
			['"!true"', "!true"],
			["${{ 1 > 2 }}", "${{ 1 > 2 }}"],
			["${{ 0 == 1 }}", "${{ 0 == 1 }}"],
			["${{ false && true }}", "${{ false && true }}"],
			// A live status function does not excuse a constant-false conjunct:
			// `always()` is true, so the runner still never reaches the step.
			["${{ always() && 1 > 2 }}", "${{ always() && 1 > 2 }}"],
		] as const) {
			const problems = flooredStep(`      - name: evaluated floor
        if: ${source}
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`);
			expect(problems, source).toContain(
				`${KEY}: its floor step may never run (if: ${value} is not a condition known to run), so the floor is unproven`,
			);
		}
	});

	it("accepts an if: that names a context or a status function the runner evaluates", () => {
		// The admitted list is deliberately short and fail-closed elsewhere: a
		// context the runner fills in cannot be proven false at rest, so it stays
		// live; everything else is unproven (#4609 r2 F-B, Greptile r4306472964).
		for (const source of [
			"${{ !cancelled() }}",
			"${{ always() }}",
			"${{ success() }}",
			"always()",
			"${{ !cancelled() && matrix.os == 'macos-latest' }}",
			"${{ github.event_name == 'push' }}",
			"${{ needs.scope.outputs.smoke == 'true' }}",
			"true",
		]) {
			expect(
				flooredStep(`      - name: evaluated floor
        if: ${source}
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
				source,
			).toEqual([]);
		}
	});

	it("reds when the floor evidence is shell data the runner never executes", () => {
		// The text is present, but the shell reads it as data (a heredoc body, a
		// quoted argument) or never reaches it (an unconditional `exit` above).
		// Each of these read [] before #4609 r2.
		for (const [shape, body] of [
			[
				"a heredoc body",
				`          cat <<'EOF' > /dev/null
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          EOF
`,
			],
			[
				"a quoted echo",
				`          echo 'node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3'
`,
			],
			[
				"an early exit",
				`          exit 0
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
		] as const) {
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				shape,
			).toEqual([
				`${KEY}: "--count "probe=" is not on an executable line of that step's run text`,
			]);
		}
	});

	it("reds when the floor step is itself continue-on-error", () => {
		expect(
			flooredStep(`      - name: evaluated floor
        continue-on-error: true
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toContain(
			`${KEY}: its floor step is continue-on-error, so the floor gates nothing`,
		);
	});

	it("reds when the floor step runs before the site it is meant to gate", () => {
		const root = tree({
			".github/workflows/floor.yml": `${PROBE}    steps:
      - name: evaluated floor
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
      - name: best effort
        continue-on-error: true
        run: node scripts/producer.mjs
`,
		});
		const found = readProducerCensus(root);
		const site = found.sites.find(
			(entry) => entry.step?.name === "best effort",
		);
		expect(site).toBeDefined();
		expect(
			floorProblems(site as CoESite, {
				status: "floored",
				floorStep: "evaluated floor",
				evidence: '--count "probe=',
				reason: "A fixture row; the reason only has to clear the length floor.",
			}),
		).toEqual([
			`${KEY}: its floor step runs before the site it is meant to gate`,
		]);
	});

	it("reds on a registry row whose fields do not match its status", () => {
		const reason = "A fixture reason, long enough to clear the length floor.";
		expect([
			...rowProblems("floored-x", { status: "floored", reason }),
			...rowProblems("governed-x", {
				status: "governed-by",
				governedBy: "4514",
				tests: [],
				reason,
			}),
			...rowProblems("no-floor-x", {
				status: "no-floor",
				floorStep: "a floor",
				reason,
			}),
			...rowProblems("status-x", {
				status: "waived" as CoEStatus,
				reason,
			}),
		]).toEqual([
			"floored-x: a floored row needs floorStep",
			"floored-x: a floored row needs evidence",
			"governed-x: a governed-by row needs tests",
			'governed-x: governed-by rows name an issue as "#<n>"',
			"no-floor-x: a no-floor row does not carry floorStep",
			'status-x: unknown status "waived"',
		]);
	});

	it("reds when a governed-by test is a path with no live test vitest collects", () => {
		const root = tree({
			"tests/config/live.test.ts":
				'import { it } from "vitest";\nit("runs", () => {});\n',
			"tests/config/skipped.test.ts":
				'import { it } from "vitest";\nit.skip("never runs", () => {});\n',
			"tests/support/helpers.ts": "export const helper = 1;\n",
			// A collected tree's excluded sibling: vitest never runs it (#4393).
			"tests/fixtures/probe.test.ts": 'it("fixture suite", () => {});\n',
		});
		// The only accepted proof: a live declaration in a file vitest collects.
		expect(
			governedByTestProblems(root, "k", "tests/config/live.test.ts"),
		).toEqual([]);
		expect(governedByTestProblems(root, "k", "tests/config")).toEqual([
			"k: tests/config is not a file",
		]);
		expect(
			governedByTestProblems(root, "k", "tests/config/missing.test.ts"),
		).toEqual(["k: tests/config/missing.test.ts is not a file"]);
		expect(
			governedByTestProblems(root, "k", "tests/support/helpers.ts"),
		).toEqual(["k: tests/support/helpers.ts declares no live test"]);
		expect(
			governedByTestProblems(root, "k", "tests/config/skipped.test.ts"),
		).toEqual(["k: tests/config/skipped.test.ts declares no live test"]);
		expect(
			governedByTestProblems(root, "k", "tests/fixtures/probe.test.ts"),
		).toEqual(["k: vitest does not collect tests/fixtures/probe.test.ts"]);
	});

	it("keeps a # that is an expansion or a quoted value when it strips comments", () => {
		expect(stripShellComments('echo "${v#p}" $# "a # b" # tail\n')).toBe(
			'echo "${v#p}" $# "a # b" \n',
		);
	});
});
