import { describe, expect, it } from "vitest";
import { runTurnScenario } from "../support/turn-harness.js";

// #4617: a confirmed-clean check can resolve findings without a classified write.
describe("turn-end no-write provenance (#4617)", () => {
	it("keeps a confirmed-clean resolution current on a no-write turn", async () => {
		await runTurnScenario({
			id: "no-write-provenance",
			incident:
				"Live turn-end findings received the historical-provenance preamble",
			issue: "#4617",
			async run(h) {
				const file = h.write("src/value.ts", "export const value = 1;\n");
				h.runtime.beginTurn();
				h.blocker("src/value.ts", "L1: type mismatch");
				expect(
					h.runtime.retireInlineBlockerOnConfirmedClean(
						file,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					),
				).toBe(true);
				const view = await h.turnEnd();
				expect(view.text).toContain("confirmed clean");
				expect(view.text).not.toContain("Historical finding");
				expect(view.text).not.toContain("generation unknown");
			},
		});
	});
});
