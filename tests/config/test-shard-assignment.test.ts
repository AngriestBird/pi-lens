import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BalancedShardSequencer } from "../../scripts/lib/balanced-shard-sequencer.mjs";
import {
	assignShards,
	loadShardWeights,
	SHARD_WEIGHTS_FILE,
	specCost,
} from "../../scripts/lib/test-shard-assignment.mjs";
import { repoRoot } from "../support/flake-shape-scan.js";
import { testSourceFiles } from "../support/module-instance-scan.js";
// The REAL config object (explicit `.ts`: the `.js` spelling is the stale
// compiled twin), so the wiring test reads what vitest actually loads.
import vitestConfig from "../../vitest.config.ts";

// #3771 / #3801: Unit tests shards are packed by recorded duration. Each
// shard job recomputes the assignment on its own, so the recurrences below are
// all "two shards disagree" or "a file runs nowhere / twice", plus the
// original defect: vitest's equal-count sha1 cut left five shards 107 s to
// 252 s apart (PR #3756's run 36763517105).

type Spec = {
	moduleId: string;
	project: { name: string; config: { maxWorkers: number } };
};

const ROOT = repoRoot;
const weightsPath = path.join(ROOT, SHARD_WEIGHTS_FILE);

/** The real population: every `*.test.ts` under tests/ (vitest's own include). */
function realTestFiles(): string[] {
	return testSourceFiles()
		.filter((file) => /\.test\.(?:ts|mts)$/.test(file))
		.map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
		.sort();
}

function specsFor(files: string[], maxWorkers = 3): Spec[] {
	return files.map((file) => ({
		moduleId: path.join(ROOT, file),
		project: { name: "default", config: { maxWorkers } },
	}));
}

function sequencerFor(index: number, count: number, log: string[] = []) {
	const ctx = {
		config: { root: ROOT, shard: { index, count } },
		logger: { log: (line: string) => log.push(line) },
	};
	return new BalancedShardSequencer(ctx as never);
}

async function shardSlices(specs: Spec[], count: number) {
	const slices: string[][] = [];
	for (let index = 1; index <= count; index += 1) {
		const mine = await sequencerFor(index, count).shard(specs as never[]);
		slices.push(mine.map((spec) => (spec as unknown as Spec).moduleId));
	}
	return slices;
}

describe("#3771 duration-balanced Unit tests shards", () => {
	// Recurrence: a shard cut that loses a file (a test that runs nowhere) or
	// repeats one. Checked over the REAL test-file population for the counts
	// the matrix could plausibly take, through the real sequencer class.
	it.each([2, 3, 4, 5, 7])(
		"puts every real test file in exactly one of %i shards",
		async (count) => {
			const files = realTestFiles();
			expect(files.length).toBeGreaterThan(1000);
			const specs = specsFor(files);
			const slices = await shardSlices(specs, count);
			const all = slices.flat();
			expect(all).toHaveLength(specs.length);
			expect(new Set(all).size).toBe(specs.length);
			expect(new Set(all)).toEqual(new Set(specs.map((spec) => spec.moduleId)));
			for (const slice of slices) expect(slice.length).toBeGreaterThan(0);
		},
	);

	// Recurrence: each shard job computes the assignment on its own runner, so
	// a result that depends on spec order (vitest's spec discovery order is not
	// a contract) makes two shards disagree and run one file twice or nowhere.
	it("gives the same slices for any spec order", async () => {
		const specs = specsFor(realTestFiles());
		const reversed = [...specs].reverse();
		const rotated = [...specs.slice(500), ...specs.slice(0, 500)];
		const base = await shardSlices(specs, 4);
		for (const order of [reversed, rotated]) {
			const again = await shardSlices(order, 4);
			for (let shard = 0; shard < 4; shard += 1) {
				expect(new Set(again[shard])).toEqual(new Set(base[shard]));
			}
		}
	});

	// Recurrence: #3771's original defect, sha1-by-count imbalance (1.5x between
	// the fastest and slowest of five shards). The pack is judged by the same
	// cost model the sequencer uses, over the real weights.
	it("packs the recorded durations within 5% of the mean load", () => {
		const { files: seconds, median } = loadShardWeights(weightsPath);
		const items = realTestFiles().map((id) => ({
			id,
			cost: specCost(seconds[id] ?? median, 3),
		}));
		for (const count of [3, 4, 5]) {
			const assignment = assignShards(items, count);
			const loads = Array.from({ length: count }, () => 0);
			for (const item of items)
				loads[assignment.get(item.id)! - 1] += item.cost;
			const mean = loads.reduce((a, b) => a + b, 0) / count;
			expect(Math.max(...loads) / mean).toBeLessThan(1.05);
		}
	});

	// Recurrence: a new test file has no recorded duration. It must still land in
	// exactly one shard with no config edit (NaN cost would scramble the sort
	// and therefore every shard's slice).
	it("places a file with no recorded duration exactly once, at the median cost", async () => {
		const specs = specsFor([
			...realTestFiles(),
			"tests/planted/brand-new-slow.test.ts",
		]);
		const slices = await shardSlices(specs, 4);
		const hits = slices.filter((slice) =>
			slice.includes(path.join(ROOT, "tests/planted/brand-new-slow.test.ts")),
		);
		expect(hits).toHaveLength(1);
		expect(slices.flat()).toHaveLength(specs.length);
	});

	// Recurrence: a serialized project's file costs its full seconds, a
	// maxWorkers:3 file a third, so the same seconds weigh differently.
	it("costs a serialized file at full seconds and a parallel file at seconds over workers", () => {
		expect(specCost(9, 1)).toBe(9);
		expect(specCost(9, 3)).toBe(3);
		expect(specCost(9, "50%")).toBe(9);
		expect(specCost(9, undefined)).toBe(9);
	});

	// Recurrence: a stale snapshot. Renames and additions slowly un-model the
	// suite, and the pack degrades silently back toward count-balancing.
	// Regenerate with scripts/gen-test-shard-weights.mjs when this reds.
	it("keeps the weights snapshot within 15% of the live file set", () => {
		const { files: seconds } = loadShardWeights(weightsPath);
		const live = new Set(realTestFiles());
		const unmodeled = [...live].filter((id) => seconds[id] === undefined);
		const stale = Object.keys(seconds).filter((id) => !live.has(id));
		expect(unmodeled.length / live.size).toBeLessThan(0.15);
		expect(stale.length / live.size).toBeLessThan(0.15);
	});

	// Recurrence: a missing or malformed snapshot silently degrading to a
	// count-balanced cut. Every shard reads the same checkout, so this is a
	// repository defect and must be loud in every shard.
	it("refuses a missing, malformed or negative snapshot instead of guessing", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-shard-weights-"),
		);
		try {
			expect(() => loadShardWeights(path.join(dir, "absent.json"))).toThrow(
				/unreadable/,
			);
			const bad = path.join(dir, "bad.json");
			fs.writeFileSync(bad, "{not json");
			expect(() => loadShardWeights(bad)).toThrow(/unreadable/);
			const negative = path.join(dir, "negative.json");
			fs.writeFileSync(
				negative,
				JSON.stringify({ files: { "tests/a.test.ts": -1 } }),
			);
			expect(() => loadShardWeights(negative)).toThrow(/non-negative/);
			const noFiles = path.join(dir, "nofiles.json");
			fs.writeFileSync(noFiles, JSON.stringify({}));
			expect(() => loadShardWeights(noFiles)).toThrow(/"files" object/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// Recurrence: the pack silently drifting (stale weights) with no number in
	// the shard's own log to show it. One record per shard per run.
	it("logs one balance line per shard naming its planned load and the unmodeled count", async () => {
		const log: string[] = [];
		await sequencerFor(2, 4, log).shard(
			specsFor([
				...realTestFiles(),
				"tests/planted/brand-new.test.ts",
			]) as never[],
		);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatch(
			/^\[shard-balance\] shard 2\/4: \d+ of \d+ files, planned \d+s against a \d+s mean \(slowest shard \d+s, \d+ files without a recorded duration\)$/,
		);
		expect(log[0]).toMatch(/, [1-9]\d* files without a recorded duration\)$/);
	});

	// Recurrence: the pack written and never wired (`sequence.sequencer` dropped
	// from the config leaves vitest's equal-count cut in every shard with every
	// other test here green), and a sequencer that also replaced `sort()` would
	// drop the groupOrder phase ordering.
	it("is the config's sequencer and overrides only shard()", () => {
		expect(
			(vitestConfig as { test?: { sequence?: { sequencer?: unknown } } }).test
				?.sequence?.sequencer,
		).toBe(BalancedShardSequencer);
		expect(
			Object.getOwnPropertyNames(BalancedShardSequencer.prototype).sort(),
		).toEqual(["constructor", "shard"]);
	});
});
