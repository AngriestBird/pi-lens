import { describe, expect, it } from "vitest";
import {
	DependencyChecker,
	type CircularDep,
} from "../../clients/dependency-checker.js";

describe("DependencyChecker.formatScanResult cycle-key comparator (#2155, #2165 class)", () => {
	it("dedupes the same cycle reported from two anchors by a code-unit key, immune to a comparator that answers inconsistently across calls", () => {
		const checker = new DependencyChecker();
		// The same two-file cycle, reported once per anchor file — the exact
		// "same member set, different anchor" shape `formatScanResult`'s dedupe
		// exists for.
		const circular: CircularDep[] = [
			{ file: "a.ts", path: ["a.ts", "b.ts"] },
			{ file: "b.ts", path: ["b.ts", "a.ts"] },
		];

		const realLocaleCompare = String.prototype.localeCompare;
		let call = 0;
		try {
			// Simulate a locale-dependent comparator that answers the SAME
			// question differently across the two cycles' key computations —
			// exactly what two OS locales (or a locale change mid-session) can
			// do to real `localeCompare`. A comparator this unstable must not
			// affect the dedupe key at all.
			String.prototype.localeCompare = function (
				this: string,
				that: string,
			) {
				call++;
				if (this === "a.ts" && that === "b.ts") return call <= 1 ? -1 : 1;
				if (this === "b.ts" && that === "a.ts") return call <= 1 ? 1 : -1;
				return realLocaleCompare.call(this, that);
			};

			const output = checker.formatScanResult(circular);
			const cycleLines = output
				.split("\n")
				.filter((line) => line.includes("→"));
			expect(cycleLines).toHaveLength(1);
		} finally {
			String.prototype.localeCompare = realLocaleCompare;
		}
	});
});
