import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import { lintPrBody, resolveLivePrBody } from "../../scripts/check-pr-body.mjs";

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

	it("does not let Fix round headings satisfy required sections", () => {
		expect(
			lintPrBody("## Fix round 1\nOnly review history here."),
		).toMatchObject({
			valid: false,
		});
	});

	it("rejects the unfilled template", () => {
		const template = readFileSync(".github/PULL_REQUEST_TEMPLATE.md", "utf8");
		expect(lintPrBody(template)).toMatchObject({ valid: false });
	});

	it("accepts case-insensitive fleet synonyms", () => {
		expect(
			lintPrBody(
				"## WHAT CHANGED AND WHY\nReal summary.\n\n## verification\nRan tests.\n\n## BLAST RADIUS\nNone.\n\n## CLASS SWEEP\nDone.\n\n## OBSERVABILITY\nRecorded.",
			),
		).toMatchObject({ valid: true });
	});

	it("ignores fenced headings and fenced template instructions", () => {
		expect(lintPrBody("```md\n## Tests\nInstructions\n```\n")).toMatchObject({
			valid: false,
		});
	});

	it("counts a fenced red-run transcript as Tests content", () => {
		const transcript = body.replace(
			"Targeted tests pass.",
			"```text\nFAIL tests/scripts/check-pr-body.test.ts\n```",
		);
		expect(lintPrBody(transcript)).toMatchObject({ valid: true });
	});

	it("does not count a fenced heading as a required section", () => {
		expect(
			lintPrBody(
				"Summary\nOpening context.\n\n```md\n## Tests\nquoted heading\n```\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.",
			),
		).toMatchObject({ valid: false });
	});

	it.each([
		["unchecked", "- [ ] item", false],
		["checked", "- [x] item", true],
	])("handles %s-only sections", (_name, item, valid) => {
		const result = lintPrBody(body.replace("Targeted tests pass.", item));
		expect(result.valid).toBe(valid);
	});

	it("accepts H3 and H4 section headings", () => {
		const h3 = body.replaceAll("## ", "### ");
		expect(lintPrBody(h3)).toMatchObject({ valid: true });
	});

	it("keeps headings before an unterminated fence visible", () => {
		const unclosed = body + "\n\n```text\nunterminated transcript";
		expect(lintPrBody(unclosed)).toMatchObject({ valid: true });
	});

	it("guards null body input", () => {
		const result = lintPrBody(null as unknown as string);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"PR body is missing a Summary section. See .github/PULL_REQUEST_TEMPLATE.md.",
		);
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

describe("live PR body resolution (#2085)", () => {
	const payloadPr = { number: 2085, body: "fallback" };

	afterEach(() => vi.unstubAllEnvs());

	it("uses the live body and API URL", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ body: "live" }), { status: 200 }),
			);
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toBe("live");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2085",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it.each([
		[
			"non-2xx",
			new Response("denied", { status: 403 }),
			"GitHub API returned 403",
		],
		[
			"malformed shape",
			new Response(JSON.stringify({ body: 42 }), { status: 200 }),
			"no body",
		],
	])("falls back and warns for %s", async (_name, response, reason) => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(response);
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toBe("fallback");
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining(reason));
		warning.mockRestore();
	});

	it("falls back without a token and does not fetch", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn();
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toBe("fallback");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("GITHUB_TOKEN is not set"),
		);
		warning.mockRestore();
	});
});
