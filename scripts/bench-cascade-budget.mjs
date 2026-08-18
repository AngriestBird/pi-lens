#!/usr/bin/env node
/**
 * Cascade neighbour-budget sizing bench (#1462).
 *
 * Replays the 2026-08-15 dogfood cascade timings through the real derivation in
 * `clients/cascade-budget.js` and reports, per scenario, what the walk costs
 * under the flat 40-neighbour cap versus the derived budget.
 *
 * The walk cost is a MODEL, not a fresh measurement: neighbour touches fan out
 * in parallel, so the number that matters is the marginal wall-clock cost of one
 * more neighbour under LSP contention. That is calibrated on the issue's own
 * measurements — 3.88 s at nbr=40 and 3.71 s at nbr=38, both ~97 ms per
 * neighbour — and the preludes are the measured graph-build / reverse-deps
 * refresh times from the same window. Override with --cost-ms=<n>.
 *
 * Usage: npm run bench:cascade-budget [-- --cost-ms=97 --settle-ms=5000]
 */

import { deriveCascadeNeighbourBudget } from "../clients/cascade-budget.js";

const arg = (name, fallback) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : Number(hit.split("=")[1]);
};

const MEASURED_COST_MS = arg("cost-ms", 97);
const SETTLE_MS = arg("settle-ms", 5000);
const CEILING = 40;

// [label, prelude ms before the walk is sized, eligible neighbours]
const SCENARIOS = [
	["median cascade (30 ms, nbr=1)", 30, 1],
	["cline-headers.ts (1.33 s prelude, nbr=3)", 1330, 3],
	["warm hub (500 ms prelude, nbr=40)", 500, 40],
	["constants.ts (nbr=40, no cache refresh)", 30, 40],
	["logger.ts + reverse_deps refresh (2046 ms, nbr=38)", 2046, 38],
	["cold hub + slow graph build (3500 ms, nbr=40)", 3500, 40],
	["window already blown (6000 ms, nbr=40)", 6000, 40],
];

const walkMs = (n) => Math.round(n * MEASURED_COST_MS);
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

console.log(
	`settle window ${SETTLE_MS} ms | ceiling ${CEILING} | marginal cost ${MEASURED_COST_MS} ms/neighbour\n`,
);
console.log(
	`${pad("scenario", 52)}${padL("nbr", 4)}${padL("flat", 6)}${padL("total", 8)}${padL("fits", 6)}${padL("drv", 6)}${padL("total", 8)}${padL("fits", 6)}`,
);
console.log("-".repeat(96));

let flatOverruns = 0;
let derivedOverruns = 0;
let narrowedFastPath = 0;

for (const [label, preludeMs, eligible] of SCENARIOS) {
	const { budget } = deriveCascadeNeighbourBudget({
		elapsedMs: preludeMs,
		settleWaitMs: SETTLE_MS,
		ceiling: CEILING,
		perNeighbourMs: MEASURED_COST_MS,
	});

	const flatWalked = Math.min(eligible, CEILING);
	const derivedWalked = Math.min(eligible, budget);
	const flatTotal = preludeMs + walkMs(flatWalked);
	const derivedTotal = preludeMs + walkMs(derivedWalked);
	const flatFits = flatTotal <= SETTLE_MS;
	const derivedFits = derivedTotal <= SETTLE_MS;

	if (!flatFits) flatOverruns++;
	if (!derivedFits) derivedOverruns++;
	if (flatFits && derivedWalked < flatWalked) narrowedFastPath++;

	console.log(
		pad(label, 52) +
			padL(eligible, 4) +
			padL(flatWalked, 6) +
			padL(`${flatTotal}ms`, 8) +
			padL(flatFits ? "yes" : "NO", 6) +
			padL(derivedWalked, 6) +
			padL(`${derivedTotal}ms`, 8) +
			padL(derivedFits ? "yes" : "NO", 6),
	);
}

console.log(
	`\nruns overrunning the settle window: flat ${flatOverruns}/${SCENARIOS.length}, derived ${derivedOverruns}/${SCENARIOS.length}`,
);
console.log(
	`runs that fit under the flat cap and were narrowed anyway: ${narrowedFastPath}`,
);

const ITERATIONS = 1_000_000;
const start = process.hrtime.bigint();
let sink = 0;
for (let i = 0; i < ITERATIONS; i++) {
	sink += deriveCascadeNeighbourBudget({ elapsedMs: i % 6000 }).budget;
}
const nsPerCall = Number(process.hrtime.bigint() - start) / ITERATIONS;
console.log(
	`\nderivation cost: ${nsPerCall.toFixed(0)} ns/call over ${ITERATIONS.toLocaleString("en-US")} calls (checksum ${sink})`,
);
