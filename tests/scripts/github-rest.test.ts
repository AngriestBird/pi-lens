import { afterEach, describe, expect, it, vi } from "vitest";
import { githubGet } from "../../scripts/lib/github-rest.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

// #4371 (#4422 review F3): five request sites each copied this env triple,
// timeout and header set. The sites keep their own failure policy; these pin
// the one shared request.
describe("githubGet", () => {
	const env = () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
	};

	it("sends the repository-relative path with the token, accept and version headers", async () => {
		env();
		const fetchImpl = vi.fn().mockResolvedValue(new Response("[]"));

		const response = await githubGet("/pulls/7/files?per_page=100", fetchImpl);

		expect(await response.text()).toBe("[]");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/7/files?per_page=100",
			{
				signal: expect.any(AbortSignal),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: "Bearer test-token",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
	});

	it.each([
		["GITHUB_TOKEN", "GITHUB_TOKEN is not set"],
		["GITHUB_API_URL", "GITHUB_API_URL or GITHUB_REPOSITORY is missing"],
		["GITHUB_REPOSITORY", "GITHUB_API_URL or GITHUB_REPOSITORY is missing"],
	])(
		"rejects without calling fetch when %s is unset",
		async (name, message) => {
			env();
			vi.stubEnv(name, "");
			const fetchImpl = vi.fn();

			await expect(githubGet("/pulls/7", fetchImpl)).rejects.toThrow(message);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});
