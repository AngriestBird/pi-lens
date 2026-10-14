/**
 * The one GitHub REST read the PR-metadata scripts share (#4371): the
 * GITHUB_TOKEN / GITHUB_API_URL / GITHUB_REPOSITORY env triple, a 10 s timeout
 * and the Bearer / Accept / API-version headers. It was copied into five
 * request sites. Rejects (never returns a partial request) when the env is
 * unset, so each caller keeps its own fail-closed or warn-and-skip policy.
 *
 * @param {string} path repository-relative, e.g. `/pulls/7/commits?page=1`
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response>}
 */
export async function githubGet(path, fetchImpl) {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const apiUrl = process.env.GITHUB_API_URL;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!apiUrl || !repository)
		throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
	return fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
		signal: AbortSignal.timeout(10_000),
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
}
