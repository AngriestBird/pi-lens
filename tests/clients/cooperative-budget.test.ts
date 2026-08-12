import { describe, expect, it } from "vitest";
import {
	createDeadline,
	forEachCooperatively,
	yieldIfOverBudget,
} from "../../clients/cooperative-budget.js";

describe("cooperative work budget (#1215)", () => {
	it("uses a resettable monotonic deadline", async () => {
		const deadline = createDeadline(0);
		expect(deadline.expired()).toBe(true);
		expect(await yieldIfOverBudget(deadline)).toBe(true);
	});

	it("bounds abort checks by the same budget as yields", async () => {
		let checks = 0;
		await expect(
			forEachCooperatively(
				Array.from({ length: 100 }, (_, i) => i),
				() => {},
				{
					budgetMs: 0,
					shouldContinue: () => ++checks < 3,
					abortMessage: "superseded",
				},
			),
		).rejects.toThrow("superseded");
		expect(checks).toBe(3);
	});
});
