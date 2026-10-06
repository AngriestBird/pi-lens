/**
 * #3989: the nightly's idle-eviction promotion rule, the source edit it makes,
 * and the bookkeeping it keeps in the capability matrix's refresh state.
 *
 * Recurrences this prevents:
 *  - #3645 left `proposal` findings only in a step log: 18 servers measured
 *    eligible on 2026-10-06 and nothing acted on them. The rule is now code, so
 *    it is tested here, not remembered.
 *  - the #3622 shape: a policy flip with no per-server evidence. Every guard
 *    below (consecutive nights, RSS floor, cold-start cap, hold list) is the
 *    evidence the flip must carry; each has a case that goes red when it is
 *    neutered.
 *  - the #3401 shape: bookkeeping dropped by a sibling writer. The matrix
 *    refresh rewrites the whole refresh-state block, so a case here proves it
 *    carries the `idle-eviction` key through.
 *  - a factory-built server shares one `idleEviction` line; editing "its" line
 *    would flip every sibling. The edit fails closed on any line that is not
 *    provably the server's own.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	COLD_START_MAX_MS,
	IDLE_EVICTION_HOLD,
	IDLE_EVICTION_MIN_RSS_BYTES,
	PROMOTE_NIGHTS,
	addReasons,
	advanceNights,
	planPromotions,
	promoteDeclaration,
	selectPromotions,
	type NightState,
} from "../../scripts/lib/lsp-idle-eviction-promote.mjs";
import type { IdleEvictionRow } from "../../scripts/lib/lsp-idle-eviction-doc.mjs";
import {
	IDLE_EVICTION_KEY,
	type IdleEvictionNight,
	parseRefreshState,
	refreshCapabilityMatrix,
	setIdleEvictionState,
} from "../../scripts/lib/md-matrix.mjs";
import { promoteFromSummary } from "../../scripts/promote-lsp-idle-eviction.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const MB = 1024 * 1024;
const D1 = "2026-10-06";
const D2 = "2026-10-07";
const D3 = "2026-10-08";

function row(
	serverId: string,
	over: Partial<IdleEvictionRow> = {},
): IdleEvictionRow {
	return {
		serverId,
		declared: "unmeasured",
		result: "eligible",
		respawn: "ok",
		coverage: "preserved",
		rssBytes: 120 * MB,
		coldStartMs: 1500,
		...over,
	};
}

/** Run `advanceNights` over consecutive days, returning the last state. */
function nights(
	days: readonly string[],
	rowsFor: (day: string) => IdleEvictionRow[],
): NightState {
	let state: NightState | undefined;
	for (const day of days) state = advanceNights(state, rowsFor(day), day);
	return state as NightState;
}

describe("consecutive-night hysteresis (#3989)", () => {
	it("counts one qualifying night as pending, two as promotable", () => {
		const one = nights([D1], () => [row("rust")]);
		expect(one.rust.nights).toHaveLength(1);
		expect(selectPromotions(one).promote).toEqual([]);
		expect(selectPromotions(one).skipped[0].reason).toContain("1/2");
		const two = nights([D1, D2], () => [row("rust")]);
		expect(selectPromotions(two).promote.map((p) => p.serverId)).toEqual([
			"rust",
		]);
	});

	it("counts a night at exactly the RSS floor and at exactly the cold-start cap", () => {
		const state = nights([D1], () => [
			row("rust", {
				rssBytes: IDLE_EVICTION_MIN_RSS_BYTES,
				coldStartMs: COLD_START_MAX_MS,
			}),
		]);
		expect(state.rust.nights).toHaveLength(1);
	});

	it("counts two runs on one UTC day once (a manual dispatch is not a second night)", () => {
		const state = nights([D1, D1], () => [row("rust")]);
		expect(state.rust.nights).toHaveLength(1);
		expect(selectPromotions(state).promote).toEqual([]);
	});

	// An unavailable, inconclusive, vetoed, narrowed, or absent night is not a
	// consecutive eligible night: the count restarts, so a flapping server needs
	// two fresh good nights.
	it.each<[string, Partial<IdleEvictionRow> | null]>([
		["unavailable", { result: "unavailable", reason: "tool-unavailable" }],
		["inconclusive", { result: "inconclusive", reason: "no-baseline" }],
		["vetoed", { result: "vetoed", reason: "respawn-failed" }],
		["respawn failed", { respawn: "failed" }],
		["coverage narrowed", { coverage: "narrowed" }],
		["idle RSS below the floor", { rssBytes: IDLE_EVICTION_MIN_RSS_BYTES - 1 }],
		["idle RSS not measured", { rssBytes: null }],
		["cold start n/a", { coldStartMs: undefined }],
		["cold start over the cap", { coldStartMs: COLD_START_MAX_MS + 1 }],
		["no row at all", null],
	])("resets the count on a %s night", (_name, bad) => {
		const state = nights([D1, D2, D3], (day) =>
			day === D2 ? (bad ? [row("rust", bad)] : []) : [row("rust")],
		);
		expect(state.rust.nights).toHaveLength(1);
		expect(state.rust.nights[0].day).toBe(D3);
		expect(selectPromotions(state).promote).toEqual([]);
	});

	it("leaves a settled entry byte-identical on later nights, so the refresh PR does not churn", () => {
		const settled = nights([D1, D2], () => [row("rust")]);
		const later = advanceNights(
			settled,
			[row("rust", { rssBytes: 300 * MB, coldStartMs: 900 })],
			D3,
		);
		expect(later).toEqual(settled);
	});

	it("tracks and promotes only servers still declared unmeasured", () => {
		for (const declared of ["transparent", "resident"]) {
			expect(advanceNights(undefined, [row("x", { declared })], D1)).toEqual(
				{},
			);
		}
	});
});

describe("RSS floor, cold-start cap and hold list (#3989)", () => {
	const pair = (
		a: Partial<IdleEvictionNight>,
		b: Partial<IdleEvictionNight>,
	): NightState => ({
		rust: {
			nights: [
				{ day: D1, rssMb: 120, coldMs: 1500, ...a },
				{ day: D2, rssMb: 120, coldMs: 1500, ...b },
			],
		},
	});

	it("promotes at the floor and skips below it, judging the lower of the two nights", () => {
		const floorMb = IDLE_EVICTION_MIN_RSS_BYTES / MB;
		expect(selectPromotions(pair({ rssMb: floorMb }, {})).promote).toHaveLength(
			1,
		);
		const below = selectPromotions(pair({}, { rssMb: floorMb - 1 }));
		expect(below.promote).toEqual([]);
		expect(below.skipped[0].reason).toContain("below the 50 MB floor");
	});

	it("skips a server whose idle RSS was not measured on a night", () => {
		const out = selectPromotions(pair({ rssMb: null }, {}));
		expect(out.promote).toEqual([]);
		expect(out.skipped[0].reason).toContain("not measured");
	});

	it("promotes at the cold-start cap and skips above it, judging the worse of the two nights", () => {
		expect(
			selectPromotions(pair({ coldMs: COLD_START_MAX_MS }, {})).promote,
		).toHaveLength(1);
		const over = selectPromotions(
			pair({ coldMs: 1000 }, { coldMs: COLD_START_MAX_MS + 1 }),
		);
		expect(over.promote).toEqual([]);
		expect(over.skipped[0].reason).toContain("exceeds the 3000 ms cap");
		const first = selectPromotions(
			pair({ coldMs: COLD_START_MAX_MS + 1 }, { coldMs: 1000 }),
		);
		expect(first.promote).toEqual([]);
	});

	it("never promotes a held server, and names #3966", () => {
		expect([...IDLE_EVICTION_HOLD.keys()].sort()).toEqual([
			"docker",
			"docker-official",
			"expert",
			"python-jedi",
		]);
		for (const id of IDLE_EVICTION_HOLD.keys()) {
			const state = nights([D1, D2], () => [row(id)]);
			const out = selectPromotions(state);
			expect(out.promote, id).toEqual([]);
			expect(out.skipped[0].reason, id).toContain("#3966");
		}
	});
});

const FIXTURE_SERVER_TS = `export const RustServer: LSPServerInfo = {
\tid: "rust",
\tidleEviction: "unmeasured",
\tname: "rust-analyzer",
};

export const MarksmanServer: LSPServerInfo = {
\tid: "marksman",
\tidleEviction: "transparent",
\tname: "Marksman",
};

export const JavaServer = createInteractiveServer({
\tid: "java",
\tname: "JDT Language Server",
});

export const DupA: LSPServerInfo = {
\tid: "dup",
\tidleEviction: "unmeasured",
};

export const DupB: LSPServerInfo = {
\tid: "dup",
\tidleEviction: "unmeasured",
};

export const Reordered: LSPServerInfo = {
\tid: "reordered",
\tname: "Reordered",
\tidleEviction: "unmeasured",
};

function createInteractiveServer(spec: { id: string }): LSPServerInfo {
\treturn {
\t\tid: spec.id,
\t\tidleEviction: "unmeasured",
\t};
}
`;

describe("the structured declaration edit (#3989)", () => {
	it("flips exactly the server's own idleEviction line and nothing else", () => {
		const out = promoteDeclaration(FIXTURE_SERVER_TS, "rust");
		expect(out.ok).toBe(true);
		const before = FIXTURE_SERVER_TS.split("\n");
		const after = (out as { text: string }).text.split("\n");
		const changed = after.flatMap((l, i) => (l !== before[i] ? [i] : []));
		expect(changed).toEqual([2]);
		expect(after[2]).toBe('\tidleEviction: "transparent",');
		expect(after).toHaveLength(before.length);
	});

	it.each([
		[
			"a shared-factory server with no idleEviction line of its own",
			"java",
			"no `idleEviction:` line directly after",
		],
		["an ambiguous id (two definitions)", "dup", "ambiguous"],
		[
			"an idleEviction line that is not directly after the id",
			"reordered",
			"no `idleEviction:` line directly after",
		],
		["an id that is not defined", "ghost", 'no `id: "ghost",` definition'],
		[
			"a server already declared transparent",
			"marksman",
			"already declared transparent",
		],
	])("fails closed on %s", (_name, id, reason) => {
		const out = promoteDeclaration(FIXTURE_SERVER_TS, id);
		expect(out).toEqual({ ok: false, reason: expect.stringContaining(reason) });
	});

	it("never edits the factory's shared line", () => {
		const out = promoteDeclaration(FIXTURE_SERVER_TS, "spec.id");
		expect(out.ok).toBe(false);
	});

	// Real-shape witness: the edit is exercised on the shipped registry source,
	// not only the fixture, so a reshaped definition cannot silently turn every
	// promotion into a skip.
	it("locates a real direct definition, and refuses a real factory-built one", () => {
		const real = fs.readFileSync(
			path.join(repoRoot, "clients/lsp/server.ts"),
			"utf8",
		);
		const rust = promoteDeclaration(real, "rust");
		expect(rust.ok).toBe(true);
		const diff = real
			.split("\n")
			.flatMap((l, i) =>
				l !== (rust as { text: string }).text.split("\n")[i] ? [l] : [],
			);
		expect(diff).toEqual(['\tidleEviction: "unmeasured",']);
		expect(promoteDeclaration(real, "java")).toMatchObject({ ok: false });
		expect(promoteDeclaration(real, "typescript")).toEqual({
			ok: false,
			reason: "already declared transparent",
		});
	});
});

describe("the reasons-file edit (#3989)", () => {
	const real = fs.readFileSync(
		path.join(repoRoot, "tests/config/lsp-idle-eviction-reasons.json"),
		"utf8",
	);

	it("appends a reason in the file's own canonical format", () => {
		const out = addReasons(real, { rust: "because" });
		expect(out.ok).toBe(true);
		const text = (out as { text: string }).text;
		expect(JSON.parse(text)).toEqual({ ...JSON.parse(real), rust: "because" });
		expect(text.endsWith('"because"\n}\n')).toBe(true);
	});

	it("fails closed on a file it would reformat or cannot parse", () => {
		expect(addReasons(real.replaceAll("\t", "  "), { a: "b" })).toEqual({
			ok: false,
			reason: "reasons file is not canonically formatted",
		});
		expect(addReasons("{", { a: "b" })).toEqual({
			ok: false,
			reason: "reasons file is not valid JSON",
		});
	});
});

describe("planPromotions (#3989)", () => {
	const reasonsText = `{\n\t"typescript": "x"\n}\n`;
	const two = (rows: IdleEvictionRow[]) =>
		planPromotions({
			rows,
			prior: nights([D1], () => rows),
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText,
			runUrl: "https://example.test/run/1",
		});

	it("edits the source, adds the reason and renders both nights for a promoted server", () => {
		const plan = two([row("rust"), row("java")]);
		expect(plan.promoted.map((p) => p.serverId)).toEqual(["rust"]);
		expect(plan.skipped).toEqual([
			{
				serverId: "java",
				reason: expect.stringContaining("no `idleEviction:`"),
			},
		]);
		expect(plan.serverSource).toContain(
			'\tid: "rust",\n\tidleEviction: "transparent",',
		);
		expect(JSON.parse(plan.reasonsText).rust).toContain("#3989");
		expect(plan.body).toContain(
			"| rust | 2026-10-06, 120, 1500 | 2026-10-07, 120, 1500 | 2 |",
		);
		expect(plan.body).toContain("https://example.test/run/1");
		expect(plan.body).toContain("workflow_dispatch");
	});

	it("promotes nothing when the reasons file cannot be edited (the registry test would red)", () => {
		const plan = planPromotions({
			rows: [row("rust")],
			prior: nights([D1], () => [row("rust")]),
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText: "{}",
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.serverSource).toBe(FIXTURE_SERVER_TS);
		expect(plan.body).toBeNull();
	});

	it("is a no-op for a server already transparent and never demotes a vetoed one", () => {
		const plan = planPromotions({
			rows: [
				row("marksman", { declared: "transparent" }),
				row("typescript", {
					declared: "transparent",
					result: "vetoed",
					respawn: "failed",
				}),
			],
			prior: undefined,
			today: D2,
			serverSource: FIXTURE_SERVER_TS,
			reasonsText,
		});
		expect(plan.promoted).toEqual([]);
		expect(plan.serverSource).toBe(FIXTURE_SERVER_TS);
		expect(plan.state).toEqual({});
	});

	it("requires PROMOTE_NIGHTS to be the two the issue states", () => {
		expect(PROMOTE_NIGHTS).toBe(2);
	});
});

describe("the refresh-state seam (#3989)", () => {
	const MATRIX = [
		"# LSP capability matrix",
		"",
		"| lang | server | mode | clean-behavior | first-publish | tier | src |",
		"|---|---|---|---|---|---|---|",
		"| vue | @vue/language-server | push-only | unknown | direct | 2/3? | dev+ci |",
		"",
	].join("\n");
	const state: NightState = {
		rust: { nights: [{ day: D1, rssMb: 120, coldMs: 1500 }] },
	};

	it("round-trips through the shared block", () => {
		const text = setIdleEvictionState(MATRIX, state);
		expect(parseRefreshState(text)[IDLE_EVICTION_KEY]).toEqual(state);
		expect(setIdleEvictionState(text, {})).toBe(`${MATRIX.trimEnd()}\n`);
	});

	// #3401 shape: the matrix refresh rewrites the whole block every night, before
	// the promotion step reads it. Without the carry-through it would erase the
	// night memory each night and no server could ever reach two nights.
	it("survives the nightly matrix refresh that rewrites the block", () => {
		const text = setIdleEvictionState(MATRIX, state);
		const refreshed = refreshCapabilityMatrix(
			text,
			[{ lang: "vue", firstPublish: "direct" }],
			{ now: D2 },
		).text;
		expect(parseRefreshState(refreshed)[IDLE_EVICTION_KEY]).toEqual(state);
	});

	it("keeps the other keys when it writes, and drops malformed nights", () => {
		const withFp = refreshCapabilityMatrix(MATRIX, [], { now: D1 }).text;
		expect(parseRefreshState(withFp)["first-publish"]).toBeDefined();
		const text = setIdleEvictionState(withFp, {
			...state,
			junk: { nights: [{ day: "nope", rssMb: 1, coldMs: 1 }] },
			// biome-ignore lint: deliberately malformed
		} as never);
		const parsed = parseRefreshState(text);
		expect(parsed["first-publish"]).toBeDefined();
		expect(parsed[IDLE_EVICTION_KEY]).toEqual(state);
	});
});

describe("the nightly driver, end to end on files (#3989)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	function workspace() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-idle-promote-"));
		dirs.push(dir);
		const file = (name: string, text: string) => {
			fs.writeFileSync(path.join(dir, name), text);
			return path.join(dir, name);
		};
		return {
			dir,
			matrixPath: file(
				"matrix.md",
				"# m\n\n| lang | server |\n|---|---|\n| vue | v |\n",
			),
			serverPath: file("server.ts", FIXTURE_SERVER_TS),
			reasonsPath: file("reasons.json", `{\n\t"typescript": "x"\n}\n`),
			bodyPath: path.join(dir, "body.md"),
			summary: (rows: object[]) =>
				file("summary.json", JSON.stringify({ rows })),
		};
	}

	it("holds night one, promotes on night two, and leaves a vetoed night alone", () => {
		const ws = workspace();
		const rows = [row("rust"), row("marksman", { declared: "transparent" })];
		const run = (summaryPath: string | undefined, today: string) =>
			promoteFromSummary({
				summaryPath,
				bodyPath: ws.bodyPath,
				matrixPath: ws.matrixPath,
				serverPath: ws.serverPath,
				reasonsPath: ws.reasonsPath,
				today,
				log: () => {},
			});
		expect(run(ws.summary(rows), D1)).toEqual([]);
		expect(fs.readFileSync(ws.serverPath, "utf8")).toBe(FIXTURE_SERVER_TS);
		expect(
			parseRefreshState(fs.readFileSync(ws.matrixPath, "utf8"))[
				IDLE_EVICTION_KEY
			]?.rust.nights,
		).toHaveLength(1);

		expect(run(ws.summary(rows), D2)).toEqual(["rust"]);
		expect(fs.readFileSync(ws.serverPath, "utf8")).toContain(
			'\tid: "rust",\n\tidleEviction: "transparent",',
		);
		expect(
			JSON.parse(fs.readFileSync(ws.reasonsPath, "utf8")).rust,
		).toBeTruthy();
		expect(fs.readFileSync(ws.bodyPath, "utf8")).toContain("| rust |");
	});

	it("clears the night memory when the measurement left no summary", () => {
		const ws = workspace();
		const base = {
			bodyPath: ws.bodyPath,
			matrixPath: ws.matrixPath,
			serverPath: ws.serverPath,
			reasonsPath: ws.reasonsPath,
			log: () => {},
		};
		promoteFromSummary({
			...base,
			summaryPath: ws.summary([row("rust")]),
			today: D1,
		});
		promoteFromSummary({
			...base,
			summaryPath: path.join(ws.dir, "absent.json"),
			today: D2,
		});
		expect(
			parseRefreshState(fs.readFileSync(ws.matrixPath, "utf8"))[
				IDLE_EVICTION_KEY
			],
		).toBeUndefined();
		// night three is therefore night one again, not a second consecutive night.
		expect(
			promoteFromSummary({
				...base,
				summaryPath: ws.summary([row("rust")]),
				today: D3,
			}),
		).toEqual([]);
		expect(fs.readFileSync(ws.serverPath, "utf8")).toBe(FIXTURE_SERVER_TS);
	});

	it("never throws on an unreadable doc", () => {
		const logged: string[] = [];
		expect(
			promoteFromSummary({
				matrixPath: "/nonexistent/m.md",
				serverPath: "/nonexistent/s.ts",
				reasonsPath: "/nonexistent/r.json",
				today: D1,
				log: (l) => logged.push(l),
			}),
		).toEqual([]);
		expect(logged[0]).toContain("idle-eviction promotion:");
	});
});
