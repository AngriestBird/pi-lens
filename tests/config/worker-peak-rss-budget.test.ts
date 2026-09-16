/**
 * Registered-or-fail guard for a test file's peak resident set (#3058).
 *
 * Recurrence this prevents: `tests/config/bounded-container-guard.test.ts`
 * merged on 2026-09-14 with a 9,226 MB peak — 4.5x the
 * `WORKER_PEAK_RSS_BUDGET_MB` the worker resolver divides the runner's memory
 * by — and nothing in the repo noticed. The suite's memory low-water fell
 * 8,532 MB and the Unit job's SIGKILL rate went 7.1% -> 30.4% over five days
 * before a human read the `[mem-file]` records by hand. `reportPeakRss` now
 * fails that file's own suite at the point the peak is measured; this file is
 * what keeps that gate honest.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_PEAK_RSS_BUDGET_MB } from "../../scripts/lib/worker-budget.mjs";
import {
	PEAK_RSS_ADMISSIONS,
	type PeakRssAdmission,
	peakRssProblem,
	reportPeakRss,
} from "../support/worker-peak-rss.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const OVER_BUDGET = WORKER_PEAK_RSS_BUDGET_MB + 1;

/** A record sink that keeps what the hook wrote. */
function capture(): { lines: string[]; write: (line: string) => void } {
	const lines: string[] = [];
	return { lines, write: (line) => lines.push(line) };
}

function reportOn(
	peakRssMb: number,
	options: {
		file?: string;
		platform?: NodeJS.Platform;
		admissions?: Readonly<Record<string, PeakRssAdmission>>;
	} = {},
): string[] {
	const sink = capture();
	reportPeakRss({
		file: options.file ?? "tests/fixture/heavy.test.ts",
		peakRssMb,
		heapUsedMb: 12,
		externalMb: 3,
		write: sink.write,
		platform: options.platform ?? "linux",
		admissions: options.admissions ?? {},
	});
	return sink.lines;
}

describe("#3058 per-file peak RSS is registered or fails", () => {
	it("fails a file over the budget and passes one under it", () => {
		expect(
			peakRssProblem("tests/fixture/heavy.test.ts", OVER_BUDGET, {}),
		).toContain(`over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget`);
		expect(
			peakRssProblem(
				"tests/fixture/heavy.test.ts",
				WORKER_PEAK_RSS_BUDGET_MB,
				{},
			),
		).toBeUndefined();
	});

	it("admits a measured peak and still fails growth past it", () => {
		const admissions = {
			"tests/fixture/heavy.test.ts": {
				peakRssMb: 4000,
				reason: "native grammar arenas, tracked by #3058",
			},
		};
		expect(
			peakRssProblem("tests/fixture/heavy.test.ts", 4000, admissions),
		).toBeUndefined();
		expect(
			peakRssProblem("tests/fixture/heavy.test.ts", 4001, admissions),
		).toContain("above its admitted 4000 MB ceiling");
		// The admission is content-keyed on the FILE: it never lifts the budget
		// for a sibling that merely runs next to it.
		expect(
			peakRssProblem("tests/fixture/other.test.ts", OVER_BUDGET, admissions),
		).toContain(`over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget`);
	});

	it("throws for an over-budget file on linux and records it either way", () => {
		expect(() => reportOn(OVER_BUDGET)).toThrow(
			`over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget`,
		);
		// The record is written before the throw, so the number that explains
		// the failure is in the log next to it.
		const sink = capture();
		expect(() =>
			reportPeakRss({
				file: "tests/fixture/heavy.test.ts",
				peakRssMb: OVER_BUDGET,
				heapUsedMb: 12,
				externalMb: 3,
				write: sink.write,
				platform: "linux",
				admissions: {},
			}),
		).toThrow();
		expect(sink.lines).toEqual([
			`[mem-file] peakRssMb=${OVER_BUDGET} heapUsedMb=12 externalMb=3 tests/fixture/heavy.test.ts\n`,
		]);
	});

	it("records but does not enforce off linux", () => {
		// worker-budget.mjs's provenance note calls the constant UNVALIDATED on
		// the ~3x heavier Windows profile, and that CI job is advisory over a
		// 40-file subset; the ubuntu Unit lane is the one the budget governs.
		expect(reportOn(OVER_BUDGET, { platform: "win32" })).toEqual([
			`[mem-file] peakRssMb=${OVER_BUDGET} heapUsedMb=12 externalMb=3 tests/fixture/heavy.test.ts\n`,
		]);
		expect(reportOn(10)).toEqual([
			"[mem-file] peakRssMb=10 heapUsedMb=12 externalMb=3 tests/fixture/heavy.test.ts\n",
		]);
	});

	it("emits the record shape the CI failure classifier parses", () => {
		// scripts/lib/ci-failure-classifier.mjs MEM_FILE_PEAK, copied from that
		// file: a format drift here silently blinds every #2042 post-mortem.
		const memFilePeak = /\[mem-file\] peakRssMb=(\d+)[^\r\n]*? (tests\/\S+)/;
		const [line] = reportOn(1234, { file: "tests/config/thing.test.ts" });
		const match = memFilePeak.exec(line ?? "");
		expect(match?.[1]).toBe("1234");
		expect(match?.[2]).toBe("tests/config/thing.test.ts");
	});

	it("keeps every live admission measured, reasoned and non-stale", () => {
		const problems: string[] = [];
		for (const [file, admission] of Object.entries(PEAK_RSS_ADMISSIONS)) {
			if (!fs.existsSync(path.join(REPO_ROOT, file)))
				problems.push(`${file}: admitted but the file does not exist`);
			if (!Number.isInteger(admission.peakRssMb))
				problems.push(`${file}: peakRssMb must be a measured whole number`);
			if (admission.peakRssMb <= WORKER_PEAK_RSS_BUDGET_MB)
				problems.push(
					`${file}: admitted at ${admission.peakRssMb} MB, at or under the ${WORKER_PEAK_RSS_BUDGET_MB} MB budget — delete the dead admission`,
				);
			if (!/#\d+/.test(admission.reason))
				problems.push(
					`${file}: reason names no issue — an admission must point at tracked work (#NNN)`,
				);
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("freezes the admissions table so a test cannot admit itself at runtime (#3067)", () => {
		// #3067 (#3062 review L1): PEAK_RSS_ADMISSIONS was typed Readonly<> but
		// never frozen. `peakRssProblem`'s default parameter reads this exact
		// live object, so a test running inside its own fork could do
		// `PEAK_RSS_ADMISSIONS["self"] = { peakRssMb: 999999, reason: "x" }` and
		// silently raise its own ceiling — the mutation compiled and ran clean.
		// Object.freeze makes that assignment throw instead (every module here
		// runs in ES module strict mode).
		expect(Object.isFrozen(PEAK_RSS_ADMISSIONS)).toBe(true);
		expect(() => {
			(PEAK_RSS_ADMISSIONS as Record<string, PeakRssAdmission>)[
				"tests/fixture/self-admit.test.ts"
			] = { peakRssMb: 999999, reason: "runtime self-admission probe" };
		}).toThrow(TypeError);
	});

	describe("registers the mem-report afterAll to run last (#3067, #3062 review L2)", () => {
		// Vitest's afterAll hooks run LIFO within a file: the LAST hook
		// registered runs FIRST. Verified empirically (not asserted from source)
		// by registering three plain afterAll() calls in a real vitest run in
		// this repo's own harness: registration order 1, 2, 3 reported
		// completion in the order 3, 2, 1. `process.resourceUsage().maxRSS` is a
		// running high-water mark, so a hook's reading of it can never reflect
		// an allocation another hook makes AFTER that reading was taken.
		//
		// tests/support/vitest-setup.ts registers four top-level afterAll
		// hooks: the mem-report one (reportPeakRss), the #3083 root-backstop
		// one (unadmittedRootBackstopEntries), the tmp-hygiene one
		// (tmpHygieneLeakReport), and the kill-guard one (killGuardReport). For
		// the mem reading to include what every other hook's teardown does, the
		// mem hook must be registered BEFORE (i.e. textually above) the other
		// three, so LIFO makes it run LAST. Before this fix it was registered
		// LAST (at the bottom of the file), so it ran FIRST — its own throw for
		// an over-budget file preempted the other three, including the
		// tmp-hygiene hook whose `[tmp-hygiene-trace]` diagnostic never printed
		// for that file (the #3062 review finding this guards against).
		//
		// A full runtime differential (spawn a real vitest subprocess and push
		// one of the other three hooks' own memory past the 2,048 MB budget) is
		// deliberately not built: none of the other three hooks allocates
		// meaningfully on its own, so forcing one to would mean adding
		// test-only allocation to production teardown code, and reproducing the
		// budget honestly would mean a real ~2 GB allocation in a test — the
		// exact failure mode this gate exists to catch. Registration order IS
		// what LIFO execution order is computed from, so this structural check
		// is a direct, real proxy for the runtime order it verified above.
		const setupSource = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		const memIndex = setupSource.indexOf("reportPeakRss({");
		const otherHooks: [name: string, marker: string][] = [
			["#3083 root-backstop", "unadmittedRootBackstopEntries()"],
			["tmp-hygiene", "tmpHygieneLeakReport()"],
			["kill-guard", "killGuardReport()"],
		];

		it("finds the mem-report call site", () => {
			expect(
				memIndex,
				"reportPeakRss({ call not found in tests/support/vitest-setup.ts",
			).toBeGreaterThanOrEqual(0);
		});

		it.each(otherHooks)(
			"is registered before the %s afterAll",
			(name, marker) => {
				const otherIndex = setupSource.indexOf(marker);
				expect(
					otherIndex,
					`${marker} call not found in tests/support/vitest-setup.ts`,
				).toBeGreaterThanOrEqual(0);
				expect(
					memIndex,
					`the mem-report afterAll must be registered BEFORE the ${name} afterAll — afterAll runs LIFO (registered-first runs last), so this is what makes the mem reading include ${name}'s teardown`,
				).toBeLessThan(otherIndex);
			},
		);
	});
});
