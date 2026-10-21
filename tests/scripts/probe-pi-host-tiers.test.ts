// lane: dev-box-only (the real spread is a maintainer's manual/nightly run;
// this file holds the script's own logic and drives it on the installed host).
// flake-shape: none — this file spawns nothing. The one child the script
// spawns (a Vitest run of a tier suite against one host) is the injected
// `runTierSuite` seam below, because a nested Vitest would run the whole
// config inside a worker of the outer run. The real invocation is quoted in
// the PR body from a manual `node scripts/probe-pi-host-tiers.mjs` run.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../../scripts/probe-pi-host-tiers.mjs";
import {
	EXIT,
	HOST_PACKAGE,
	certifiedHosts,
	compareVersions,
	discoverInstalledHosts,
	exitCodeForSpread,
	hostPackageCandidates,
	parseCliArgs,
	parseVerifiedHostRows,
	renderHostLine,
	renderSpreadSummary,
	resolveHostPackage,
	runSpread,
	tierVerdict,
} from "../../scripts/lib/pi-host-spread.mjs";
import type {
	SpreadRow,
	TierResult,
	TierSuite,
} from "../../scripts/lib/pi-host-spread.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const BASELINE_DOC = path.join(REPO_ROOT, "docs", "release-qa-baseline.md");
const REPO_HOST_ROOT = path.join(REPO_ROOT, "node_modules");
const BASELINE_TEXT = fs.readFileSync(BASELINE_DOC, "utf8");

/**
 * The host this repo installs, resolved the way a `--host-root` resolves it —
 * so the version the cases below report is read from the installed package,
 * never typed here.
 */
const installedHost = resolveHostPackage(REPO_HOST_ROOT);

/**
 * Three versions for the spread cases: two this box does not carry, and the one
 * it does, so both branches of `runSpread` are exercised.
 */
const certified = ["0.86.1", "0.87.1", installedHost?.version].filter(
	(version): version is string => typeof version === "string",
);
const hosts = installedHost ? [installedHost] : [];

/** A tier result the injected seam returns; no Vitest run is involved. */
function tierResult(ok: boolean): TierResult {
	return { ok, passed: ok ? 4 : 1, total: 4 };
}

describe("certified hosts come from the baseline doc, fail-closed (#4632 acceptance 9)", () => {
	it("reads the doc's verified-host table as the certified set", () => {
		const { versions, unparseable } = certifiedHosts(BASELINE_TEXT);
		expect(unparseable).toEqual([]);
		// The table is the owner: at least the floor host and the newest host,
		// every one a three-part version, in ascending order.
		expect(versions.length).toBeGreaterThan(1);
		expect(versions.every((version) => /^\d+\.\d+\.\d+$/.test(version))).toBe(
			true,
		);
		expect([...versions].sort(compareVersions)).toEqual(versions);
		expect(versions).toContain("0.86.1");
	});

	it("reports a row it cannot read instead of dropping it", () => {
		// Recurrence (#4688 R2 F2): a row spelled `| 1.4 |` was a host the
		// ratchet did not carry and the window excluded, and a reader that drops
		// it turns an unreadable certified set into a shorter green one.
		const doc = [
			"### Verified hosts",
			"",
			"| host | date | pi-lens commit | result |",
			"| --- | --- | --- | --- |",
			"| 1.3.0 | 2026-10-16 | abc1234 | pass |",
			"| 1.4 | 2026-10-20 | abc1234 | pass |",
			"",
			"## Next section",
			"",
			"| 9.9.9 | not a host row |",
		].join("\n");
		const { versions, unparseable } = certifiedHosts(doc);
		expect(versions).toEqual(["1.3.0"]);
		expect(unparseable).toEqual(["| 1.4 | 2026-10-20 | abc1234 | pass |"]);
		// The table stops at the next `## ` heading, so a later table is not one.
		expect(parseVerifiedHostRows(doc).map((row) => row.version)).toEqual([
			"1.3.0",
			null,
		]);
	});

	it("orders versions numerically, not lexically", () => {
		expect(["1.10.0", "1.9.3", "0.99.2"].sort(compareVersions)).toEqual([
			"0.99.2",
			"1.9.3",
			"1.10.0",
		]);
	});
});

describe("host installs are found by version, in every layout", () => {
	it("this repo's node_modules is one of the layouts", () => {
		expect(installedHost?.dir).toBe(path.join(REPO_HOST_ROOT, HOST_PACKAGE));
		expect(installedHost?.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it.each([
		["a node_modules root", () => REPO_HOST_ROOT],
		["the package directory", () => path.join(REPO_HOST_ROOT, HOST_PACKAGE)],
		["a versioned install prefix", () => path.join(REPO_ROOT, "unused-prefix")],
		["an npm global prefix", () => path.join(REPO_ROOT, "unused-global")],
	])("resolves %s", (_name, candidate) => {
		const root = candidate();
		const resolved = resolveHostPackage(root);
		if (root.includes("unused-")) {
			// The prefixed layout is spelled by the candidate list itself: a
			// prefix that holds no install resolves to nothing, never to a guess.
			expect(resolved).toBeUndefined();
			expect(hostPackageCandidates(root)).toContain(
				path.join(root, "lib", "node_modules", HOST_PACKAGE),
			);
			expect(hostPackageCandidates(root)).toContain(
				path.join(root, "node_modules", HOST_PACKAGE),
			);
			return;
		}
		expect(resolved?.version).toBe(installedHost?.version);
	});

	it("refuses a directory whose manifest names another package", () => {
		// A directory that holds SOME package's manifest is not a host: without
		// the name check, `node_modules/vitest` would report host version 5.0.5
		// and the spread would probe a tier suite against Vitest itself.
		expect(
			resolveHostPackage(path.join(REPO_HOST_ROOT, "vitest")),
		).toBeUndefined();
		// And a directory with no manifest at all resolves to nothing either.
		expect(resolveHostPackage(path.join(REPO_ROOT, "clients"))).toBeUndefined();
		// The real install still resolves, so the two refusals above are not the
		// candidate list failing to reach it.
		expect(
			resolveHostPackage(path.join(REPO_HOST_ROOT, HOST_PACKAGE))?.dir,
		).toBe(path.join(REPO_HOST_ROOT, HOST_PACKAGE));
	});

	it("reports a root that holds no host at all", () => {
		const { hosts, unreadable } = discoverInstalledHosts([
			path.join(REPO_ROOT, "clients"),
			REPO_HOST_ROOT,
		]);
		expect(unreadable).toEqual([path.join(REPO_ROOT, "clients")]);
		expect(hosts.map((host) => host.version)).toEqual([installedHost?.version]);
	});
});

describe("the spread probes the installed certified host and reports the rest", () => {
	it("prints one line per certified host, naming host and version", async () => {
		const calls: Array<{
			host: { version: string; dir: string };
			suite: TierSuite;
		}> = [];
		const spread = await runSpread({
			certified,
			hosts,
			runTierSuite: async (input) => {
				calls.push(input);
				return tierResult(true);
			},
		});
		expect(calls.map((call) => call.suite.tier)).toEqual(["tier1", "tier2"]);
		expect(spread.rows).toHaveLength(certified.length);
		expect(spread.rows[0]).toMatchObject({
			version: "0.86.1",
			installed: false,
			failed: false,
		});
		const lines = spread.rows.map(renderHostLine);
		expect(lines[0]).toBe(`${HOST_PACKAGE} 0.86.1: not installed`);
		const installedLine = lines.find((line) =>
			line.startsWith(`${HOST_PACKAGE} ${installedHost?.version} (`),
		);
		expect(installedLine).toBeDefined();
		expect(installedLine).toContain("tier1 pass 4/4");
		expect(installedLine).toContain("tier2 pass 4/4");
		expect(renderSpreadSummary(spread)).toBe(
			"certified hosts: 1 installed, 2 not installed, 0 failed",
		);
		// Missing hosts do not fail a run that did not demand them.
		expect(exitCodeForSpread(spread)).toBe(EXIT.ok);
		expect(exitCodeForSpread(spread, { requireAll: true })).toBe(
			EXIT.hostMissing,
		);
	});

	it("fails the run when an installed host fails a tier", async () => {
		const spread = await runSpread({
			certified,
			hosts,
			runTierSuite: async ({ suite }) => tierResult(suite.tier === "tier1"),
		});
		expect(spread.failed).toEqual([installedHost?.version]);
		const last = spread.rows[spread.rows.length - 1] as SpreadRow;
		expect(renderHostLine(last)).toContain("tier2 FAIL");
		expect(exitCodeForSpread(spread)).toBe(EXIT.tiersFailed);
		// A failing host outranks a missing one: the flag's exit code never
		// hides a red tier behind "not installed".
		expect(exitCodeForSpread(spread, { requireAll: true })).toBe(
			EXIT.tiersFailed,
		);
	});
});

describe("a tier's verdict is fail-closed", () => {
	/** A summary shape as `parseVitestSummary` returns it on a green run. */
	const green = { testsPassed: 4, testsFailed: null, testsSkipped: null };

	it("passes a green run and counts its tests", () => {
		expect(tierVerdict({ status: 0, summary: green })).toEqual({
			ok: true,
			passed: 4,
			total: 4,
			timedOut: false,
		});
		expect(
			tierVerdict({ status: 0, summary: { ...green, testsSkipped: 2 } }).total,
		).toBe(6);
	});

	it.each([
		[
			"a failing test",
			{ status: 1, summary: { ...green, testsFailed: 1, testsPassed: 3 } },
		],
		["a non-zero exit with no red", { status: 1, summary: green }],
		[
			"a run that collected nothing",
			{
				status: 0,
				summary: { testsPassed: 0, testsFailed: 0, testsSkipped: 0 },
			},
		],
		[
			"a transcript with no counts at all",
			{
				status: 0,
				summary: { testsPassed: null, testsFailed: null, testsSkipped: null },
			},
		],
		[
			"a child killed by its timeout",
			{ status: null, timedOut: true, summary: { ...green, testsPassed: 0 } },
		],
	])("fails %s", (_name, input) => {
		expect(tierVerdict(input).ok).toBe(false);
	});
});

describe("the CLI's own decisions (no child spawned)", () => {
	/** Collect the two streams and record every tier call. */
	function runCli(argv: string[], boundaries: Record<string, unknown> = {}) {
		const out: string[] = [];
		const err: string[] = [];
		const calls: unknown[] = [];
		const mainStreams = {
			write: (text: string) => out.push(text),
			warn: (text: string) => err.push(text),
			runTierSuite: async (input: unknown) => {
				calls.push(input);
				return tierResult(true);
			},
		};
		return {
			calls,
			out,
			err,
			promise: main(argv, { ...mainStreams, ...boundaries }),
		};
	}

	it("prints the usage on --help and spawns nothing", async () => {
		const cli = runCli(["--help"]);
		expect(await cli.promise).toBe(EXIT.ok);
		expect(cli.out.join("")).toContain("--require-all");
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses an unknown flag before it reads anything", async () => {
		const cli = runCli(["--requireall"]);
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain('unknown argument "--requireall"');
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses a missing build and names the command", async () => {
		const cli = runCli([], {
			extensionEntry: path.join(REPO_ROOT, "no-such-index.js"),
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("npm run build");
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses a missing Vitest entry", async () => {
		const cli = runCli([], {
			vitestEntry: path.join(REPO_ROOT, "no-such-vitest.mjs"),
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("devDependencies");
	});

	it("refuses a certified set it cannot read, naming the row", async () => {
		const doc = [
			"### Verified hosts",
			"",
			"| host | date |",
			"| --- | --- |",
			"| 1.4 | 2026-10-20 |",
		].join("\n");
		const cli = runCli([], {
			readFile: () => doc,
			baselineDoc: "synthetic.md",
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("| 1.4 | 2026-10-20 |");
		expect(cli.err.join("")).toContain("unreadable");
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses a doc that names no certified host", async () => {
		const doc = [
			"### Verified hosts",
			"",
			"| host | date |",
			"| --- | --- |",
		].join("\n");
		const cli = runCli([], {
			readFile: () => doc,
			baselineDoc: "synthetic.md",
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("names no certified host");
	});

	it("warns about a root that holds no host and keeps probing", async () => {
		const cli = runCli([
			"--host-root",
			path.join(REPO_ROOT, "clients"),
			"--host-root",
			REPO_HOST_ROOT,
		]);
		expect(await cli.promise).toBe(EXIT.ok);
		expect(cli.err.join("")).toContain(`holds no ${HOST_PACKAGE}`);
		// One line per certified host (this case reads the real doc), plus the
		// header and the summary line.
		const docCertified = certifiedHosts(BASELINE_TEXT).versions;
		const lines = cli.out.join("").trimEnd().split("\n");
		expect(lines).toHaveLength(1 + docCertified.length + 1);
		expect(
			lines.some((line) =>
				line.startsWith(`${HOST_PACKAGE} ${installedHost?.version} (`),
			),
		).toBe(true);
		expect(lines.at(-1)).toBe(
			`certified hosts: ${hosts.length} installed, ${docCertified.length - hosts.length} not installed, 0 failed`,
		);
	});

	it("prints a failed tier's transcript and exits 1", async () => {
		const cli = runCli(["--host-root", REPO_HOST_ROOT], {
			runTierSuite: async ({ suite }: { suite: TierSuite }) =>
				suite.tier === "tier1"
					? tierResult(true)
					: { ok: false, passed: 1, total: 2, detail: "boom from the child" },
		});
		expect(await cli.promise).toBe(EXIT.tiersFailed);
		const out = cli.out.join("");
		expect(out).toContain("tier2 FAIL 1/2");
		expect(out).toContain("boom from the child");
	});

	it("exits 3 when --require-all demands a host this box lacks", async () => {
		// A certified list with one version no install carries: the spread still
		// runs the installed host and then refuses the answer.
		const cli = runCli(["--require-all", "--host-root", REPO_HOST_ROOT], {
			readFile: (file: string) =>
				file === "synthetic.md"
					? ["### Verified hosts", "", "| host |", "| --- |", "| 9.9.9 |"].join(
							"\n",
						)
					: BASELINE_TEXT,
			baselineDoc: "synthetic.md",
		});
		expect(await cli.promise).toBe(EXIT.hostMissing);
		expect(cli.out.join("")).toContain(`${HOST_PACKAGE} 9.9.9: not installed`);
	});
});

describe("argv is parsed fail-closed", () => {
	it("parses the supported flags", () => {
		expect(
			parseCliArgs([
				"--host-root",
				"/a",
				"--host-root",
				"/b",
				"--require-all",
				"--timeout-ms",
				"1000",
			]),
		).toEqual({
			hostRoots: [path.resolve("/a"), path.resolve("/b")],
			requireAll: true,
			timeoutMs: 1000,
			help: false,
		});
		expect(parseCliArgs([])).toEqual({
			hostRoots: [],
			requireAll: false,
			timeoutMs: 300_000,
			help: false,
		});
	});

	it.each([
		["an unknown flag", ["--requireall"]],
		["a value-less flag", ["--host-root"]],
		["a flag swallowed as a value", ["--host-root", "--require-all"]],
		["a malformed timeout", ["--timeout-ms", "5s"]],
	])("refuses %s", (_name, argv) => {
		expect(() => parseCliArgs(argv)).toThrow();
	});
});
