#!/usr/bin/env node
/**
 * scripts/prune-actions-cache.mjs (#4358)
 *
 *   node scripts/prune-actions-cache.mjs [--apply] [--default-branch master]
 *
 * Plans, and with --apply performs, the removal of GitHub Actions caches that
 * can no longer be restored by anything useful. The repository cache is capped
 * at 10 GB; at the cap GitHub evicts by last access, so a freshly saved smoke
 * cache competes with stale CodeQL overlay databases and merged-PR npm caches.
 * Pruning those first keeps the cap free for the caches that still hit.
 *
 * Rules, in this order (a cache matches the first that applies):
 *   1. A pull-request ref (refs/pull/N/merge|head) whose PR is not open:
 *      nothing restores it again, because only that PR's own runs read it.
 *   2. A branch ref other than the default branch whose branch no longer
 *      exists: same reason.
 *   3. The default branch: the newest KEEP caches per key family survive and
 *      the rest are superseded. A family is the key with its content hashes and
 *      run ids replaced, so `codeql-overlay-base-database-1-<digest>-javascript-
 *      2.27.2-<sha>-<run>-<attempt>` is one family across commits. CodeQL's
 *      overlay base database is ~600 MB per copy and only the newest is read, so
 *      it keeps 1; every other family keeps 2.
 * Any other ref shape (a tag) is left alone.
 *
 * Dry run by default: it lists what --apply would delete and changes nothing.
 * A failed listing (caches, open pull requests or branches) exits 1 before any
 * delete, so an empty or partial list can never read as "everything is stale".
 * A failed delete is counted and the run exits 1 after the rest were tried.
 * Every deletion is printed with its reason, one line each, and a single
 * summary line closes the run.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_KEEP = 2;
/** Key-family prefix -> how many newest default-branch copies survive. */
export const KEEP_BY_PREFIX = Object.freeze({
	"codeql-overlay-base-database": 1,
});
/** `gh cache list --limit` ceiling; a list this long may be truncated. */
export const LIST_LIMIT = 1000;

/**
 * The key with every 16+ hex digest and trailing run id / attempt replaced, so
 * successive saves of one cache share a family.
 * @param {string} key
 */
export function cacheFamily(key) {
	return key
		.replace(/-[0-9a-f]{16,}(?=-|$)/gi, "-*")
		.replace(/-{1,2}\d{6,}-\d+$/, "-*");
}

/** @param {string} family */
function keepFor(family) {
	for (const [prefix, keep] of Object.entries(KEEP_BY_PREFIX))
		if (family.startsWith(prefix)) return keep;
	return DEFAULT_KEEP;
}

/**
 * @typedef {{ id: number, key: string, ref: string, sizeInBytes: number,
 *   createdAt: string }} CacheEntry
 * @param {{ caches: CacheEntry[], openPulls: Iterable<number>,
 *   branches: Iterable<string>, defaultBranch?: string }} input
 * @returns {Array<CacheEntry & { reason: string }>}
 */
export function planPrune({
	caches,
	openPulls,
	branches,
	defaultBranch = "master",
}) {
	const open = new Set(openPulls);
	const live = new Set(branches);
	const defaultRef = `refs/heads/${defaultBranch}`;
	/** @type {Array<CacheEntry & { reason: string }>} */
	const deletions = [];
	/** @type {Map<string, CacheEntry[]>} */
	const families = new Map();
	for (const cache of caches) {
		const pull = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(cache.ref);
		if (pull) {
			if (!open.has(Number(pull[1])))
				deletions.push({ ...cache, reason: `PR #${pull[1]} is not open` });
			continue;
		}
		if (cache.ref === defaultRef) {
			const family = cacheFamily(cache.key);
			families.set(family, [...(families.get(family) ?? []), cache]);
			continue;
		}
		const branch = /^refs\/heads\/(.+)$/.exec(cache.ref);
		if (branch && !live.has(branch[1]))
			deletions.push({ ...cache, reason: `branch ${branch[1]} is gone` });
	}
	for (const [family, members] of families) {
		const newestFirst = [...members].sort(
			(a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
		);
		for (const stale of newestFirst.slice(keepFor(family)))
			deletions.push({
				...stale,
				reason: `superseded in ${family} (keep ${keepFor(family)})`,
			});
	}
	return deletions;
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

/**
 * @param {(args: string[]) => string} gh
 * @param {{ apply: boolean, defaultBranch: string }} options
 * @returns {{ planned: number, total: number, bytes: number, failed: number }}
 */
export function prune(gh, { apply, defaultBranch }) {
	const caches = JSON.parse(
		gh([
			"cache",
			"list",
			"--limit",
			String(LIST_LIMIT),
			"--json",
			"id,key,ref,sizeInBytes,createdAt",
		]),
	);
	if (!Array.isArray(caches) || caches.length >= LIST_LIMIT)
		throw new Error(
			`cache listing is not a complete array (length ${caches?.length}); refusing to plan against it`,
		);
	const openPulls = JSON.parse(
		gh([
			"pr",
			"list",
			"--state",
			"open",
			"--limit",
			"1000",
			"--json",
			"number",
		]),
	).map((pr) => pr.number);
	const branches = gh([
		"api",
		"--paginate",
		"repos/{owner}/{repo}/branches",
		"--jq",
		".[].name",
	])
		.split("\n")
		.filter(Boolean);
	const plan = planPrune({ caches, openPulls, branches, defaultBranch });
	let failed = 0;
	for (const entry of plan) {
		let outcome = apply ? "deleted" : "would delete";
		if (apply) {
			try {
				gh(["cache", "delete", String(entry.id)]);
			} catch (error) {
				failed += 1;
				outcome = `FAILED (${String(error.message).split("\n")[0]})`;
			}
		}
		console.log(
			`${outcome} ${entry.id} ${entry.ref} ${entry.key} ${megabytes(entry.sizeInBytes)}: ${entry.reason}`,
		);
	}
	const bytes = plan.reduce((sum, entry) => sum + entry.sizeInBytes, 0);
	console.log(
		`cache-prune: ${apply ? "applied" : "dry-run"}, ${plan.length} of ${caches.length} caches, ${megabytes(bytes)} of ${megabytes(caches.reduce((sum, entry) => sum + entry.sizeInBytes, 0))}, ${failed} failed`,
	);
	return { planned: plan.length, total: caches.length, bytes, failed };
}

function main(argv) {
	const apply = argv.includes("--apply");
	const at = argv.indexOf("--default-branch");
	const defaultBranch = at >= 0 ? argv[at + 1] : "master";
	if (!defaultBranch || defaultBranch.startsWith("-")) {
		console.error("--default-branch needs a branch name");
		return 2;
	}
	const gh = (args) =>
		execFileSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 16 * 1024 * 1024,
		});
	try {
		return prune(gh, { apply, defaultBranch }).failed > 0 ? 1 : 0;
	} catch (error) {
		console.error(`cache-prune: ${error.message}`);
		return 1;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exit(main(process.argv.slice(2)));
