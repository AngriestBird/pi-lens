import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	MODEL_COSTS_FILE,
	formatShardBalance,
	listModelConfigs,
	loadModelCosts,
	selectConfigs,
} from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// #3918: the required `TLA+ models` check is an aggregate job over a
// `check-tla-models.mjs --shard i/N` matrix. Each assertion names the
// regression it keeps out.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	env?: Record<string, string>;
	permissions?: Record<string, string>;
	strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
	steps?: Step[];
};

const JOBS = (
	yaml.load(
		readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
	) as {
		jobs: Record<string, Job>;
	}
).jobs;
const asList = (needs: string | string[] | undefined) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

describe("#3918 sharded TLA+ models workflow contract", () => {
	// Recurrence: a required check that is SKIPPED (its `needs` failed) counts
	// as passing in branch protection. An aggregate that drops the shard job
	// from `needs`, loses `if: always()`, or exits 0 on a non-success result
	// turns a red or cancelled shard into a green `TLA+ models`.
	//
	// #4672: the aggregate's verdict is now the shared
	// `scripts/check-shard-verdict.mjs` seam (it distinguishes a shard
	// cancelled AFTER its model check finished from one cancelled during it),
	// so this pin no longer reads a shell comparison. What it keeps pinning is
	// the property that comparison carried: the aggregate reads the shard job's
	// own result, hands it to the seam, and the seam is the only thing that can
	// exit 0. The classification itself is pinned from fixtures in
	// tests/scripts/check-shard-verdict.test.ts.
	it("keeps exactly one check named `TLA+ models`: an always() aggregate over the shard job, classified by the shared shard-verdict seam", () => {
		const named = Object.entries(JOBS).filter(
			([, job]) => job.name === "TLA+ models",
		);
		expect(named.map(([id]) => id)).toEqual(["tla-models"]);
		const aggregate = JOBS["tla-models"];
		expect(asList(aggregate.needs)).toEqual(["tla-shards"]);
		expect(aggregate.if).toBe("always()");
		expect(aggregate.env?.SHARDS_RESULT).toBe("${{ needs.tla-shards.result }}");
		const step = aggregate.steps?.find(
			(entry) => entry.name === "Require every TLA+ models shard to succeed",
		);
		const run = String(step?.run);
		// The shard job's result reaches the seam, and the seam decides.
		expect(step?.env?.SHARDS_RESULT ?? aggregate.env?.SHARDS_RESULT).toBe(
			"${{ needs.tla-shards.result }}",
		);
		expect(run).toMatch(
			/^\s*node scripts\/check-shard-verdict\.mjs \\\n\s*--label "TLA\+ models" \\\n\s*--result "\$\{SHARDS_RESULT\}"/m,
		);
		// The shard population this aggregate classifies is the `tla-shards`
		// matrix's own rows, matched by name, never a list of job ids.
		expect(step?.env?.SHARD_JOB_PATTERN).toMatch(/\^TLA\\\+ models \\\(shard/);
		// And the verdict runs on the row's real work step: a cancelled shard is
		// a pass only when THIS step concluded success (#4672).
		expect(step?.env?.SHARD_CHECK_STEP).toBe(
			"Model-check formal/ against each config's expected verdict",
		);
		// No `exit 0` shortcut and no swallowing step beside it: the seam's own
		// exit code is the job's verdict.
		expect(run).not.toMatch(/exit 0/);
		// Reading this run's job list needs the actions scope; nothing else was
		// widened (#4672).
		expect(aggregate.permissions).toEqual({
			contents: "read",
			actions: "read",
		});
	});

	// Recurrence: a literal shard count beside a matrix edit (`--shard k/3`
	// with four matrix entries) silently runs a fraction of the models nowhere.
	// The count has ONE source, `strategy.job-total`, in the job name and the
	// `--shard` denominator, and the matrix is exactly 1..N.
	it("derives the shard denominator from the matrix, never a literal", () => {
		const shard = JOBS["tla-shards"];
		const shards = shard.strategy?.matrix?.shard ?? [];
		expect(shards).toEqual(
			Array.from({ length: shards.length }, (_, index) => index + 1),
		);
		expect(shards.length).toBeGreaterThan(1);
		expect(shard.strategy?.["fail-fast"]).toBe(false);
		expect(shard.name).toBe(
			"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
		);
		const run = shard.steps?.map((entry) => entry.run ?? "").join("\n") ?? "";
		expect(run).toMatch(
			/^\s*node scripts\/check-tla-models\.mjs --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\s*$/m,
		);
	});

	// Recurrence: the pre-#3918 single job ran every config in one runner and
	// hit its 12-minute cap at 514 configs. A shard that quietly runs all
	// configs again (a malformed or dropped `--shard`) would reintroduce that.
	it("runs every config in exactly one shard, for the workflow's own shard count", () => {
		const all = listModelConfigs(ROOT);
		assertNonEmptyScan("TLA+ model configs", all.length, 74);
		const total = JOBS["tla-shards"].strategy?.matrix?.shard?.length ?? 0;
		const owners = new Map<string, number[]>();
		for (let index = 1; index <= total; index += 1) {
			const picked = selectConfigs(["--shard", `${index}/${total}`], ROOT);
			// A shard with nothing to run is a dead runner; keep them all busy.
			expect(picked.length, `shard ${index}/${total} is empty`).toBeGreaterThan(
				0,
			);
			for (const config of picked) {
				owners.set(config, [...(owners.get(config) ?? []), index]);
			}
		}
		const problems = all.flatMap((config) => {
			const shards = owners.get(config) ?? [];
			return shards.length === 1
				? []
				: [`${config}: in shards [${shards.join(", ")}]`];
		});
		expect(problems).toEqual([]);
		expect(owners.size).toBe(all.length);
	});

	// Recurrence: a partition that is only correct for the workflow's current N
	// would go wrong at the next matrix edit. Re-check across a range of N.
	it.each([1, 2, 3, 5, 7, 8])(
		"partitions into %i shards with no config skipped or doubled",
		(total) => {
			const all = listModelConfigs(ROOT);
			const picked = Array.from({ length: total }, (_, index) =>
				selectConfigs(["--shard", `${index + 1}/${total}`], ROOT),
			).flat();
			expect([...picked].sort()).toEqual([...all].sort());
		},
	);

	// #4672: the shipped split is by MEASURED COST, and this is the guard that
	// the measured table plus the workflow's shard count actually keeps the work
	// even. It reads the committed table itself, computes the per-shard summed
	// cost independently of the production code, and asserts the spread the old
	// count-based split lost: that one put 28% / 22% / 13% / 37% of the TLC
	// seconds in shards 1-4 (2.9x), which is how shard 4 came to be cancelled at
	// 735 s against a 720 s cap with every step `success`.
	it("packs the measured per-config TLC seconds evenly across the workflow's shard count", () => {
		const total = JOBS["tla-shards"].strategy?.matrix?.shard?.length ?? 0;
		expect(total).toBeGreaterThan(1);
		const table = loadModelCosts(ROOT);
		const byShard = Array.from({ length: total }, (_, index) =>
			selectConfigs(["--shard", `${index + 1}/${total}`], ROOT).reduce(
				(sum, config) => {
					const relative = resolve(config).slice(ROOT.length + 1);
					return sum + (table.files[relative] ?? table.max);
				},
				0,
			),
		);
		assertNonEmptyScan("measured shard costs", byShard.length, 2);
		const heaviest = Math.max(...byShard);
		const lightest = Math.min(...byShard);
		// Greedy LPT on 811 configs lands within a few seconds of the ideal; 5%
		// admits one regenerated table's rounding without admitting a real tail.
		expect(heaviest / lightest).toBeLessThan(1.05);
		// And the counterfactual the fix exists for: the count-based round-robin
		// over the same table is NOT balanced, so this assertion cannot be
		// satisfied by a table that ignores the costs.
		const roundRobin = Array.from({ length: total }, (_, index) =>
			listModelConfigs(ROOT)
				.filter((_, position) => position % total === index)
				.reduce((sum, config) => {
					const relative = resolve(config).slice(ROOT.length + 1);
					return sum + (table.files[relative] ?? table.max);
				}, 0),
		);
		expect(
			Math.max(...roundRobin) / Math.min(...roundRobin),
			"the count-based split this PR replaced should still be measurably worse; if it is not, the table or the corpus changed shape and the note in ci.yml is stale",
		).toBeGreaterThan(1.5);
	});

	// A cost row for a config that no longer exists is a table that was not
	// regenerated: it hides a deleted or renamed model behind a stale balance.
	it("carries a cost row for every formal config and none for a vanished one", () => {
		const table = loadModelCosts(ROOT);
		const live = new Set(
			listModelConfigs(ROOT).map((config) =>
				resolve(config).slice(ROOT.length + 1),
			),
		);
		const stale = Object.keys(table.files).filter((id) => !live.has(id));
		expect(
			stale,
			`${MODEL_COSTS_FILE} has rows for configs that do not exist; rerun scripts/gen-tla-model-costs.mjs`,
		).toEqual([]);
		assertNonEmptyScan("model cost rows", Object.keys(table.files).length, 100);
	});

	// #4672 cap sizing: the old 12-minute cap sat AT the measured maximum (735 s
	// against 720 s on run 39380875926), so a slower runner turned finished work
	// into `cancelled`. The cap is the second mechanism behind the partition, and
	// it must keep the margin the file records.
	it("sizes the shard cap from the measured worst shard, with margin", () => {
		const shard = JOBS["tla-shards"];
		const cap = Number(
			(shard as Job & { "timeout-minutes"?: number })["timeout-minutes"],
		);
		// The projected worst shard after the cost-weighted partition is ~505 s
		// (1538 s of TLC work at the measured 3.05 s work per second of wall);
		// the worst shard ever observed at the old partition was 724 s.
		expect(cap).toBe(20);
		expect(cap * 60).toBeGreaterThanOrEqual(1.5 * 724);
		const file = readFileSync(
			resolve(ROOT, ".github/workflows/ci.yml"),
			"utf8",
		);
		const block = file.slice(
			file.indexOf("#4672 cap sizing"),
			file.indexOf("#4672 cap sizing") + 1600,
		);
		// The comment carries the measured tail and the margin, not a guess.
		expect(block).toContain("735 s against 720 s");
		expect(block).toContain("685/700 s");
	});

	// The balance line is the shard's own record of the split; without it a
	// stale table is invisible until a timeout 12 minutes later.
	it("prints the per-shard measured balance, and names every unmeasured config", () => {
		const costs = resolveCostsFixture();
		const configs = listModelConfigs(ROOT).slice(0, 4);
		const line = formatShardBalance({ configs, total: 4, costs });
		expect(line).toContain("all shards:");
		expect(line).toContain("heaviest/lightest = ");
		expect(line).toContain("have no row in");
		expect(line).toContain("scripts/gen-tla-model-costs.mjs");
	});
});

/**
 * The real table, then a copy with one config removed, so the unmeasured branch
 * of the balance line is exercised without touching the committed file.
 */
function resolveCostsFixture() {
	const table = loadModelCosts(ROOT);
	const files = { ...table.files };
	delete files[Object.keys(files)[0]];
	return { root: ROOT, files, max: table.max };
}
