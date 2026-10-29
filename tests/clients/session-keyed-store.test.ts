import { describe, expect, it } from "vitest";
import { SessionKeyedStore } from "../../clients/session-keyed-store.js";

// #4965 (shape 72): three stores hand-rolled this partition and each decided
// retirement and reset on its own. These tests pin the two verbs the seam
// states once: retire drops ONE session, clear drops them ALL.
describe("SessionKeyedStore", () => {
	it("retires one session's entry and leaves every other session's", () => {
		const store = new SessionKeyedStore<number>();
		store.set("primary", 1);
		store.set("secondary", 2);
		expect(store.retire("secondary")).toBe(true);
		expect(store.get("secondary")).toBeUndefined();
		expect(store.get("primary")).toBe(1);
		expect(store.retire("secondary")).toBe(false);
	});

	it("clear drops every session's entry (the primary's reset)", () => {
		const store = new SessionKeyedStore<number>();
		store.set("primary", 1);
		store.set("secondary", 2);
		store.clear();
		expect(store.size).toBe(0);
		expect(store.has("primary")).toBe(false);
	});

	it("getOrCreate builds an entry once per session and shares it", () => {
		const store = new SessionKeyedStore<string[]>();
		let built = 0;
		const init = () => {
			built += 1;
			return [] as string[];
		};
		store.getOrCreate("a", init).push("x");
		expect(store.getOrCreate("a", init)).toEqual(["x"]);
		expect(store.getOrCreate("b", init)).toEqual([]);
		expect(built).toBe(2);
	});

	it("evicts the oldest session past maxSessions (fifo: a read does not refresh)", () => {
		const store = new SessionKeyedStore<number>({ maxSessions: 2 });
		store.set("a", 1);
		store.set("b", 2);
		store.get("a");
		store.set("c", 3);
		expect(store.has("a")).toBe(false);
		expect([store.has("b"), store.has("c")]).toEqual([true, true]);
	});

	it("lru: a read refreshes the session, so the unused one is evicted", () => {
		const store = new SessionKeyedStore<number>({
			maxSessions: 2,
			recency: "lru",
		});
		store.set("a", 1);
		store.set("b", 2);
		store.get("a");
		store.set("c", 3);
		expect(store.has("b")).toBe(false);
		expect([store.has("a"), store.has("c")]).toEqual([true, true]);
	});

	it("holds every session when no maxSessions is given", () => {
		const store = new SessionKeyedStore<number>();
		for (let i = 0; i < 500; i++) store.set(`s${i}`, i);
		expect(store.size).toBe(500);
	});
});
