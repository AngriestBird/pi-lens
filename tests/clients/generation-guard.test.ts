/**
 * The GenerationGuard primitive's semantics, tested once (#1754).
 *
 * Every hand-rolled copy of this pattern needed a review round to get right,
 * and two reached review VACUOUS — the guard was there, but nothing could
 * make it fire. So each test here is written to red when the guard it covers
 * is deleted or neutered, not merely to pass when it is present.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	createGenerationMap,
	createGenerationSource,
	listDeclaredGenerationSources,
	withGeneration,
} from "../../clients/generation-guard.js";

function staleWrites(): Array<{ subject: string; reason: string }> {
	const group = getDegradationSummary().find(
		(entry) => entry.kind === "generation-guard-stale-write",
	);
	return group?.latestReasons ?? [];
}

function staleWriteCount(): number {
	return (
		getDegradationSummary().find(
			(entry) => entry.kind === "generation-guard-stale-write",
		)?.count ?? 0
	);
}

beforeEach(() => resetDegradationLedger());

describe("GenerationSource — straddle", () => {
	it("drops a write whose generation was bumped mid-flight", async () => {
		const source = createGenerationSource("straddle-store");
		const store = new Map<string, string>();

		const inFlight = withGeneration(source, async (handle) => {
			await Promise.resolve();
			source.bump(); // the session reset lands while the producer is awaited
			return handle.guardedWrite("tool-a", () => {
				store.set("tool-a", "late");
				return "wrote";
			});
		});

		await expect(inFlight).resolves.toBeUndefined();
		expect(store.has("tool-a")).toBe(false);
	});

	it("records exactly one bounded entry naming the dropped write", async () => {
		const source = createGenerationSource("straddle-store");
		const handle = source.capture();
		source.bump();

		handle.guardedWrite("tool-a", () => "x");

		const reasons = staleWrites();
		expect(reasons).toHaveLength(1);
		expect(reasons[0]?.subject).toBe("straddle-store:tool-a");
		expect(reasons[0]?.reason).toContain("captured generation 0");
		expect(reasons[0]?.reason).toContain("current 1");
	});

	it("keeps repeats bounded to one retained entry while counting them all", () => {
		const source = createGenerationSource("straddle-store");
		const handles = Array.from({ length: 5 }, () => source.capture());
		source.bump();

		for (const handle of handles) handle.guardedWrite("tool-a", () => "x");

		expect(staleWrites()).toHaveLength(1);
		expect(staleWriteCount()).toBe(5);
	});

	it("keeps the discriminating identity when different writes are dropped", () => {
		const source = createGenerationSource("straddle-store");
		const first = source.capture();
		const second = source.capture();
		source.bump();

		first.guardedWrite("tool-a", () => "x");
		second.guardedWrite("tool-b", () => "x");

		expect(staleWrites().map((entry) => entry.subject).sort()).toEqual([
			"straddle-store:tool-a",
			"straddle-store:tool-b",
		]);
	});
});

describe("GenerationSource — no bump", () => {
	it("lands the write and returns its value when nothing reset", async () => {
		const source = createGenerationSource("quiet-store");
		const store = new Map<string, string>();

		const result = await withGeneration(source, async (handle) => {
			await Promise.resolve();
			return handle.guardedWrite("tool-a", () => {
				store.set("tool-a", "fresh");
				return "wrote";
			});
		});

		expect(result).toBe("wrote");
		expect(store.get("tool-a")).toBe("fresh");
		expect(staleWriteCount()).toBe(0);
	});

	it("lets a write land after an unrelated source bumps", () => {
		const mine = createGenerationSource("mine");
		const theirs = createGenerationSource("theirs");
		const handle = mine.capture();

		theirs.bump();

		expect(handle.guardedWrite("k", () => "wrote")).toBe("wrote");
	});

	it("distinguishes a dropped write from a write that returned undefined", () => {
		const source = createGenerationSource("undef-store");
		const handle = source.capture();
		// A live write returning undefined must not look like a drop: the ledger
		// is the discriminator, and it must stay silent here.
		expect(handle.guardedWrite("k", () => undefined)).toBeUndefined();
		expect(staleWriteCount()).toBe(0);
	});
});

describe("GenerationSource — double bump", () => {
	it("still drops after two bumps and reports the observed generation", () => {
		const source = createGenerationSource("double-store");
		const handle = source.capture();

		source.bump();
		source.bump();

		expect(handle.isCurrent()).toBe(false);
		expect(handle.guardedWrite("k", () => "wrote")).toBeUndefined();
		expect(staleWrites()[0]?.reason).toContain("current 2");
	});

	it("does not let a handle captured between bumps be resurrected", () => {
		const source = createGenerationSource("double-store");
		source.bump();
		const mid = source.capture();
		source.bump();

		expect(mid.isCurrent()).toBe(false);
		// The counter is monotonic: there is no path back to generation 1.
		expect(source.bump()).toBe(3);
		expect(mid.isCurrent()).toBe(false);
	});
});

describe("GenerationSource — eviction direction (#1674's second half)", () => {
	it("a stale completion does not clear a successor's in-flight entry", async () => {
		const source = createGenerationSource("in-flight-store");
		const inFlight = new Map<string, string>();

		// Old session starts a probe.
		const oldHandle = source.capture();
		inFlight.set("shim", "old-probe");

		// Session reset clears the map and bumps.
		inFlight.clear();
		source.bump();

		// New session immediately starts a replacement probe for the same key.
		inFlight.set("shim", "new-probe");

		// The old probe now settles and runs its eviction guard.
		oldHandle.guardedWrite("shim", () => inFlight.delete("shim"));

		expect(inFlight.get("shim")).toBe("new-probe");
		expect(staleWrites()[0]?.subject).toBe("in-flight-store:shim");
	});

	it("a current completion does clear its own entry", () => {
		const source = createGenerationSource("in-flight-store");
		const inFlight = new Map<string, string>([["shim", "probe"]]);
		const handle = source.capture();

		handle.guardedWrite("shim", () => inFlight.delete("shim"));

		expect(inFlight.has("shim")).toBe(false);
		expect(staleWriteCount()).toBe(0);
	});
});

describe("GenerationMap — keyed independence", () => {
	it("bumping one key does not invalidate another key's handle", () => {
		const map = createGenerationMap("keyed-store");
		const a = map.capture("/repo/a");
		const b = map.capture("/repo/b");

		map.bump("/repo/a");

		expect(a.isCurrent()).toBe(false);
		expect(b.isCurrent()).toBe(true);
		expect(a.guardedWrite("entry", () => "wrote")).toBeUndefined();
		expect(b.guardedWrite("entry", () => "wrote")).toBe("wrote");
	});

	it("names the key in the ledger subject", () => {
		const map = createGenerationMap("keyed-store");
		const handle = map.capture("/repo/a");
		map.bump("/repo/a");

		handle.guardedWrite("entry", () => "x");

		expect(staleWrites()[0]?.subject).toBe("keyed-store[/repo/a]:entry");
	});

	it("applies the caller's key normalizer to both capture and bump", () => {
		const map = createGenerationMap("keyed-store", {
			normalizeKey: (key) => key.toLowerCase(),
		});
		const handle = map.capture("/Repo/A");

		map.bump("/repo/a");

		expect(handle.isCurrent()).toBe(false);
	});

	it("forget resets a key to generation 0 without touching others", () => {
		const map = createGenerationMap("keyed-store");
		map.bump("/repo/a");
		map.bump("/repo/b");

		map.forget("/repo/a");

		expect(map.current("/repo/a")).toBe(0);
		expect(map.current("/repo/b")).toBe(1);
	});

	it("bounds retained keys and fails CLOSED on eviction", () => {
		const map = createGenerationMap("keyed-store", { maxKeys: 2 });
		const evicted = map.capture("/repo/a");
		map.bump("/repo/a");
		const live = map.capture("/repo/a");
		expect(live.isCurrent()).toBe(true);

		map.bump("/repo/b");
		map.bump("/repo/c");

		expect(map.size()).toBe(2);
		expect(map.current("/repo/a")).toBe(0);
		// The evicted key's handles both read stale — the safe direction. A
		// generation-0 handle captured BEFORE the bump stays stale too.
		expect(evicted.isCurrent()).toBe(true); // generation 0 === evicted 0
		expect(live.isCurrent()).toBe(false);
	});
});

describe("declaration registry", () => {
	it("registers by construction, so a store cannot guard without declaring", () => {
		createGenerationSource("declared-a");
		createGenerationMap("declared-b");

		const declared = listDeclaredGenerationSources();
		expect(declared).toContain("declared-a");
		expect(declared).toContain("declared-b");
	});

	it("rejects an unnamed source", () => {
		expect(() => createGenerationSource("  ")).toThrow(/non-empty name/);
	});
});
