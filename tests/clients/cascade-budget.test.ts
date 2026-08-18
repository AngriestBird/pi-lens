import { afterEach, describe, expect, it } from "vitest";
import {
	CASCADE_NEIGHBOUR_BUDGET,
	cascadeSettleWaitMs,
	deriveCascadeNeighbourBudget,
} from "../../clients/cascade-budget.js";

const ENV_KEYS = [
	"PI_LENS_CASCADE_SETTLE_WAIT_MS",
	"PI_LENS_CASCADE_NEIGHBOUR_COST_MS",
	"PI_LENS_CASCADE_NEIGHBOUR_FLOOR",
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});

describe("cascadeSettleWaitMs", () => {
	it("defaults to 5000 and accepts an explicit 0", () => {
		expect(cascadeSettleWaitMs()).toBe(5000);
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "0");
		expect(cascadeSettleWaitMs()).toBe(0);
	});

	it("falls back to the default for a non-numeric or negative value", () => {
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "soon");
		expect(cascadeSettleWaitMs()).toBe(5000);
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "-1");
		expect(cascadeSettleWaitMs()).toBe(5000);
	});
});

describe("deriveCascadeNeighbourBudget", () => {
	it("leaves the flat cap alone while the window is ample", () => {
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 0 })).toEqual({
			budget: CASCADE_NEIGHBOUR_BUDGET,
			ceiling: CASCADE_NEIGHBOUR_BUDGET,
			remainingMs: 5000,
		});
		// The measured median cascade — 30 ms of prelude buys nothing back.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 30 }).budget).toBe(
			CASCADE_NEIGHBOUR_BUDGET,
		);
		// 1000 ms of prelude still affords 40 at 100 ms each: the narrowing
		// starts only once the flat walk genuinely no longer fits.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 1000 }).budget).toBe(40);
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 1100 }).budget).toBe(39);
	});

	it("narrows the walk in step with the settle time already spent", () => {
		// The measured logger.ts prelude: a 2046 ms reverse-deps refresh.
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 2046 }).budget).toBe(29);
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4000 }).budget).toBe(10);
	});

	it("never narrows below the floor, however far the window is overspent", () => {
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 5000 }).budget).toBe(5);
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 60_000 })).toEqual({
			budget: 5,
			ceiling: CASCADE_NEIGHBOUR_BUDGET,
			remainingMs: -55_000,
		});
	});

	it("keeps the full cap when the settle wait is disabled", () => {
		// wait 0 means turn_end never blocks on this run — it is carried to the
		// next turn either way, so there is no window to fit inside.
		setEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", "0");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 30_000 }).budget).toBe(
			CASCADE_NEIGHBOUR_BUDGET,
		);
	});

	it("clamps a floor set above the ceiling down to the ceiling", () => {
		// A floor over the cap would make the derived budget LARGER than the flat
		// one it exists to bound.
		expect(
			deriveCascadeNeighbourBudget({
				elapsedMs: 60_000,
				ceiling: 8,
				floor: 40,
			}).budget,
		).toBe(8);
	});

	it("treats a non-finite or negative elapsed as no time spent", () => {
		expect(deriveCascadeNeighbourBudget({ elapsedMs: Number.NaN }).budget).toBe(
			CASCADE_NEIGHBOUR_BUDGET,
		);
		expect(deriveCascadeNeighbourBudget({ elapsedMs: -1000 }).budget).toBe(
			CASCADE_NEIGHBOUR_BUDGET,
		);
	});

	it("honours the per-neighbour cost and floor overrides from env", () => {
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "500");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 0 }).budget).toBe(10);
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_FLOOR", "12");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 60_000 }).budget).toBe(12);
	});

	it("falls back to the default cost when the env knob is unusable", () => {
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "0");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4000 }).budget).toBe(10);
		setEnv("PI_LENS_CASCADE_NEIGHBOUR_COST_MS", "fast");
		expect(deriveCascadeNeighbourBudget({ elapsedMs: 4000 }).budget).toBe(10);
	});
});
