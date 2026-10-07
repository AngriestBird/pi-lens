// flake-shape: never-settling-wait — the interrupt witness must keep a real child alive until the CLI sends SIGINT.
import { expect, it } from "vitest";

it("mutation fixture remains original", () => {
	// mutation-safe-marker
	expect("original").toBe("original");
});

it("mutation fixture has a failure marker", () => {
	expect("mutation-fail-marker").toBe("mutation-fail-marker");
});

it("mutation fixture can hold an interrupting run", async () => {
	if (!process.env.PI_LENS_MUTATION_RUN) {
		expect(true).toBe(true);
		return;
	}
	await new Promise(() => {});
});
