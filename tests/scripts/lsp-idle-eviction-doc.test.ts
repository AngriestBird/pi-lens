/**
 * #3645: the durable artifact and the declared-versus-measured drift check.
 *
 * Recurrences these tests prevent:
 *  - a nightly artifact that changes on every run (raw RSS and milliseconds)
 *    opens a refresh PR every night and stops being reviewed; the document
 *    shows buckets, so two runs that differ inside a bucket must render the
 *    same text;
 *  - a coverage gap read as a clean zero: an unmeasured figure renders `n/a`,
 *    never `0`, and the header counts what was not measured;
 *  - a registry that evicts a server the measurement vetoes (the only `drift`),
 *    and its three inverse directions, which must NOT be drift.
 */
import { describe, expect, it } from "vitest";
import {
	bucketBytes,
	bucketMs,
	idleEvictionDrift,
	parseIdleEvictionDoc,
	renderIdleEvictionDoc,
	renderRawTable,
	summarizeRows,
	type IdleEvictionRow,
} from "../../scripts/lib/lsp-idle-eviction-doc.mjs";
import { compareGeneratedDocs } from "../../scripts/lib/md-matrix.mjs";

const MB = 1024 * 1024;
const declared = new Map([
	["alpha", "transparent"],
	["bravo", "unmeasured"],
	["charlie", "resident"],
	["delta", "unmeasured"],
	["echo", "unmeasured"],
]);

const eligible = (serverId: string, extra: Partial<IdleEvictionRow> = {}) =>
	({
		serverId,
		role: "primary",
		result: "eligible",
		initMs: 2_000,
		rssBytes: 150 * MB,
		respawn: "ok",
		coldStartMs: 4_000,
		coverage: "preserved",
		...extra,
	}) as IdleEvictionRow;

describe("buckets", () => {
	it("places each boundary in the upper bucket and labels overflow", () => {
		expect(
			[
				0, 999, 1_000, 2_999, 3_000, 9_999, 10_000, 29_999, 30_000, 59_999,
				60_000,
			].map(bucketMs),
		).toEqual([
			"<1s",
			"<1s",
			"1-3s",
			"1-3s",
			"3-10s",
			"3-10s",
			"10-30s",
			"10-30s",
			"30-60s",
			"30-60s",
			">60s",
		]);
		expect(
			[
				99 * MB,
				100 * MB,
				249 * MB,
				250 * MB,
				499 * MB,
				500 * MB,
				1023 * MB,
				1024 * MB,
			].map(bucketBytes),
		).toEqual([
			"<100 MB",
			"100-250 MB",
			"100-250 MB",
			"250-500 MB",
			"250-500 MB",
			"500 MB-1 GB",
			"500 MB-1 GB",
			">1 GB",
		]);
	});

	it("labels an unmeasured figure n/a, never a zero bucket", () => {
		for (const value of [undefined, null, Number.NaN, -1]) {
			expect(bucketMs(value as number)).toBe("n/a");
			expect(bucketBytes(value as number)).toBe("n/a");
		}
	});
});

describe("renderIdleEvictionDoc", () => {
	const rows: IdleEvictionRow[] = [
		eligible("bravo"),
		eligible("alpha"),
		{
			serverId: "delta",
			role: "primary",
			result: "unavailable",
			reason: "tool-unavailable",
		},
		{
			serverId: "echo",
			role: "primary",
			result: "unavailable",
			reason: "budget-exhausted",
		},
		{
			serverId: "charlie",
			role: "auxiliary",
			result: "vetoed",
			reason: "findings-narrowed",
			initMs: 1_500,
			rssBytes: null,
			respawn: "ok",
			coverage: "narrowed",
		},
	];
	const render = (r: IdleEvictionRow[], date = "2026-09-30") =>
		renderIdleEvictionDoc({ rows: r, declared, date, platform: "linux" });

	it("renders the same text for any row order", () => {
		expect(render([...rows].reverse())).toBe(render(rows));
	});

	it("renders identical text for two runs that differ only inside a bucket", () => {
		const noisy = rows.map((r) =>
			r.result === "eligible"
				? {
						...r,
						initMs: (r.initMs ?? 0) + 311,
						rssBytes: (r.rssBytes ?? 0) + 7 * MB,
						coldStartMs: (r.coldStartMs ?? 0) + 402,
					}
				: r,
		);
		expect(render(noisy)).toBe(render(rows));
		expect(
			compareGeneratedDocs(render(noisy, "2026-10-01"), render(rows)),
		).toBe(false);
	});

	it("changes the text when a server crosses a bucket", () => {
		const moved = rows.map((r) =>
			r.serverId === "alpha" ? { ...r, rssBytes: 600 * MB } : r,
		);
		expect(compareGeneratedDocs(render(moved), render(rows))).toBe(true);
	});

	it("discloses measured, vetoed, inconclusive, unavailable and budget-unreached counts", () => {
		expect(render(rows)).toContain(
			"5 registry servers: 2 eligible, 1 vetoed, 0 inconclusive, 2 unavailable (1 not reached: budget)",
		);
		expect(summarizeRows(rows)).toEqual({
			total: 5,
			eligible: 2,
			vetoed: 1,
			inconclusive: 0,
			unavailable: 2,
			budget: 1,
		});
	});

	it("renders unmeasured cells as n/a and never as zero", () => {
		const doc = render(rows);
		const delta = doc.split("\n").find((l) => l.startsWith("| delta |"));
		expect(delta).toBe(
			"| delta | primary | unmeasured | unavailable | tool-unavailable | n/a | n/a | n/a | n/a | n/a |",
		);
		const charlie = doc.split("\n").find((l) => l.startsWith("| charlie |"));
		expect(charlie).toContain("| 1-3s | n/a | ok | n/a | narrowed |");
	});

	it("round-trips the per-server rows through the parser", () => {
		expect(parseIdleEvictionDoc(render(rows))).toEqual([
			{
				serverId: "alpha",
				role: "primary",
				declared: "transparent",
				result: "eligible",
				reason: undefined,
			},
			{
				serverId: "bravo",
				role: "primary",
				declared: "unmeasured",
				result: "eligible",
				reason: undefined,
			},
			{
				serverId: "charlie",
				role: "auxiliary",
				declared: "resident",
				result: "vetoed",
				reason: "findings-narrowed",
			},
			{
				serverId: "delta",
				role: "primary",
				declared: "unmeasured",
				result: "unavailable",
				reason: "tool-unavailable",
			},
			{
				serverId: "echo",
				role: "primary",
				declared: "unmeasured",
				result: "unavailable",
				reason: "budget-exhausted",
			},
		]);
		expect(parseIdleEvictionDoc("# nothing here\n")).toBeNull();
	});

	it("keeps the raw figures out of the document and in the raw table", () => {
		expect(render(rows)).not.toContain("2000");
		expect(renderRawTable(rows)).toContain(
			"| alpha | eligible | · | 2000 | 150 | 4000 |",
		);
		expect(renderRawTable(rows)).toContain(
			"| charlie | vetoed | findings-narrowed | 1500 | n/a | n/a |",
		);
	});
});

describe("idleEvictionDrift", () => {
	const row = (
		serverId: string,
		result: IdleEvictionRow["result"],
		reason?: string,
	) => ({ serverId, result, reason }) as IdleEvictionRow;
	const kinds = (rows: IdleEvictionRow[]) =>
		idleEvictionDrift(rows, declared).map(
			(f) => `${f.serverId}:${f.kind}:${f.severity}`,
		);

	it("flags a transparent server the measurement vetoes as drift, for either veto reason", () => {
		expect(kinds([row("alpha", "vetoed", "respawn-failed")])).toEqual([
			"alpha:transparent-vetoed:drift",
		]);
		expect(kinds([row("alpha", "vetoed", "findings-narrowed")])).toEqual([
			"alpha:transparent-vetoed:drift",
		]);
	});

	it("does not call a transparent server drift when it is eligible", () => {
		expect(kinds([row("alpha", "eligible")])).toEqual([]);
	});

	it("reports a transparent server with no evidence this run as info, not drift", () => {
		expect(kinds([row("alpha", "unavailable", "tool-unavailable")])).toEqual([
			"alpha:transparent-unverified:info",
		]);
		expect(kinds([row("alpha", "inconclusive", "no-baseline")])).toEqual([
			"alpha:transparent-unverified:info",
		]);
	});

	it("proposes an unmeasured server that is eligible, and confirms one that is vetoed", () => {
		expect(kinds([row("bravo", "eligible")])).toEqual([
			"bravo:unmeasured-eligible:proposal",
		]);
		expect(kinds([row("bravo", "vetoed", "respawn-failed")])).toEqual([
			"bravo:unmeasured-vetoed:proposal",
		]);
	});

	it("says nothing about an unmeasured server with no evidence", () => {
		expect(
			kinds([
				row("bravo", "unavailable", "no-fixture"),
				row("delta", "inconclusive", "not-evicted"),
			]),
		).toEqual([]);
	});

	it("notes a resident server that measures eligible but never calls resident-vetoed drift", () => {
		expect(kinds([row("charlie", "eligible")])).toEqual([
			"charlie:resident-eligible:info",
		]);
		expect(kinds([row("charlie", "vetoed", "respawn-failed")])).toEqual([]);
	});

	it("ignores a server the registry no longer declares", () => {
		expect(kinds([row("ghost", "vetoed", "respawn-failed")])).toEqual([]);
	});

	it("puts the findings, or an explicit none, in the rendered document", () => {
		const clean = renderIdleEvictionDoc({
			rows: [],
			declared,
			date: "2026-09-30",
			platform: "linux",
		});
		expect(clean).toContain(
			"No divergence between declared policy and this run's measurement.",
		);
		const drifted = renderIdleEvictionDoc({
			rows: [row("alpha", "vetoed", "respawn-failed")],
			declared,
			date: "2026-09-30",
			platform: "linux",
		});
		expect(drifted).toContain(
			"- **alpha** [drift] declared transparent but the measurement vetoes it (respawn-failed)",
		);
	});
});
