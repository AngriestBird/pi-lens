import { describe, expect, it } from "vitest";
import { lintPrBody } from "../../scripts/check-pr-body.mjs";

const body = `Summary\nOpening context.\n\n## Tests\nTargeted tests pass.\n\n## Blast radius\nNo runtime module touched.\n\n## Class sweep\nWhole-tree grep completed.\n\n## Observability\nThe advisory check run is the record.`;

describe("PR body lint (#1844)", () => {
	it("accepts the required sections", () => {
		expect(lintPrBody(body)).toEqual({ valid: true, errors: [] });
	});

	it.each(["Tests", "Blast radius", "Class sweep", "Observability"])(
		"rejects a missing %s section",
		(section) => {
			const result = lintPrBody(body.replace(`## ${section}\n`, ""));
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(`## ${section}`);
		},
	);

	it.each(["Tests", "Blast radius", "Class sweep", "Observability"])(
		"rejects an empty %s section",
		(section) => {
			const result = lintPrBody(
				body.replace(new RegExp(`## ${section}\\n[^#]*`), `## ${section}\n`),
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(`## ${section}`);
		},
	);

	it("accepts not applicable with a reason", () => {
		expect(
			lintPrBody(
				body.replace(
					"No runtime module touched.",
					"Not applicable: no runtime module changed.",
				),
			),
		).toMatchObject({ valid: true });
	});

	it("ignores fix-round sections", () => {
		expect(
			lintPrBody(`${body}\n\n## Fix round 2\nReview history.`),
		).toMatchObject({ valid: true });
	});

	it("accepts an opening paragraph instead of a Summary heading", () => {
		expect(
			lintPrBody(
				body.replace("Summary\nOpening context.\n\n", "Opening context.\n\n"),
			),
		).toMatchObject({ valid: true });
	});

	it("rejects a body with no Summary or opening paragraph", () => {
		expect(
			lintPrBody(body.replace("Summary\nOpening context.\n\n", "")),
		).toMatchObject({ valid: false });
	});
});
