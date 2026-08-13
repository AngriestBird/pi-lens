import { beforeEach, describe, expect, it } from "vitest";
import {
	DEGRADATION_ENTRIES_PER_KIND,
	getDegradationSummary,
	recordDegradation,
	renderDegradationLines,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

beforeEach(resetDegradationLedger);

describe("session degradation ledger", () => {
	it("groups kinds and returns detached latest reasons", () => {
		recordDegradation({ kind: "spawn-failure", subject: "a", reason: "denied" });
		recordDegradation({ kind: "trust-refusal", subject: "b", reason: "untrusted" });
		recordDegradation({ kind: "spawn-failure", subject: "c", reason: "bad cwd" });
		const summary = getDegradationSummary();
		expect(summary.map(({ kind, count }) => ({ kind, count }))).toEqual([
			{ kind: "spawn-failure", count: 2 },
			{ kind: "trust-refusal", count: 1 },
		]);
		expect(summary[0].latestReasons.at(-1)).toEqual({ subject: "c", reason: "bad cwd" });
		summary[0].latestReasons[0].reason = "mutated";
		expect(getDegradationSummary()[0].latestReasons[0].reason).toBe("denied");
	});

	it("bounds retained entries per kind while counting beyond the cap", () => {
		for (let i = 0; i < DEGRADATION_ENTRIES_PER_KIND + 7; i++) {
			recordDegradation({ kind: "formatter-skip", subject: `f${i}`, reason: `r${i}` });
		}
		const [group] = getDegradationSummary();
		expect(group.count).toBe(DEGRADATION_ENTRIES_PER_KIND + 7);
		expect(group.droppedCount).toBe(7);
		expect(group.latestReasons).toHaveLength(DEGRADATION_ENTRIES_PER_KIND);
		expect(group.latestReasons[0].subject).toBe("f7");
	});

	it("renders a health section only when degraded", () => {
		expect(renderDegradationLines()).toEqual([]);
		recordDegradation({ kind: "grammar-blocked", subject: "swift.wasm", reason: "runtime unsafe" });
		expect(renderDegradationLines()).toEqual([
			"Degradations:",
			"  ⚠ grammar-blocked: 1 — swift.wasm: runtime unsafe",
		]);
	});

	// #1366 review: reasons carry arbitrary error text -- bounded at record
	// time so health lines and retained strings stay small.
	it("truncates oversized subjects and reasons at record time", () => {
		resetDegradationLedger();
		recordDegradation({
			kind: "trust-refusal",
			subject: "s".repeat(500),
			reason: "r".repeat(10_000),
		});
		const [group] = getDegradationSummary();
		const latest = group.latestReasons.at(-1)!;
		expect(latest.subject.length).toBeLessThanOrEqual(201);
		expect(latest.reason.length).toBeLessThanOrEqual(201);
		const lines = renderDegradationLines();
		expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(500);
	});
});

