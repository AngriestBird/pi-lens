// flake-shape: in-process-mock — #1712: the language server and the cascade compute are the process boundary for the nightly lane's runner; the lane's own runner, fixtures and verdict code are real, and the real servers are driven by `node scripts/smoke-tools.mjs --lsp-cascade` in .github/workflows/tool-smoke.yml.
/**
 * #1712: the nightly `--lsp-cascade` lane. Its live half runs only in the
 * nightly; this file pins what must not drift without a server: the verdict on
 * one cascade run, the row a measurement turns into, the fixtures' shape, and
 * the runner's exit status when a server never concludes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CASCADE_FIXTURES,
	type CascadeFixture,
	type CascadeMeasurement,
	type CascadeRunLike,
	cascadeRow,
	cascadeTimesRecord,
	classifyCascadeRun,
	describeLastTouch,
	neighbourShowsFinding,
	neighbourVerdict,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";
import { LSP_FIXTURES, runLspCascade } from "../../scripts/smoke-tools.mjs";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WS = "/work/space";
const fx: CascadeFixture = {
	lang: "demo",
	dir: "unused",
	file: "src/a.ts",
	symbol: "foo",
	neighbours: ["src/b.ts", "src/c.ts"],
	edit: { from: "x", to: "y" },
	expectFindings: "is not assignable",
};

const block = (rel: string, message: string) =>
	`<diagnostics file="${rel}" reason="references">\n  line 2, col 1 rule=x: ${message}\n</diagnostics>\n`;

/** A run as `computeCascadeForFile` shapes it after a live typescript-go edit. */
function liveRun(over: Partial<CascadeRunLike> = {}): CascadeRunLike {
	return {
		observedNeighborPaths: [`${WS}/src/c.ts`, `${WS}/src/b.ts`],
		result: {
			formatted:
				block("src/b.ts", "Type 'string' is not assignable to type 'number'.") +
				block("src/c.ts", "Type 'string' is not assignable to type 'number'."),
		},
		...over,
	};
}

describe("classifyCascadeRun (#1712)", () => {
	it("reads both importers concluded with the server's own finding", () => {
		expect(classifyCascadeRun(liveRun(), fx, WS)).toEqual({
			state: "conclusive",
			neighbours: { "src/b.ts": "findings", "src/c.ts": "findings" },
			detail: "all neighbours concluded",
		});
	});

	it("reads a neighbour the run never observed as unconfirmed", () => {
		// Recurrence: #4485, classic neighbours deferred and never asked, so the
		// run read as a leaf's all-clear. An unobserved neighbour is not clean.
		const run = liveRun({ observedNeighborPaths: [`${WS}/src/b.ts`] });
		expect(classifyCascadeRun(run, fx, WS)).toMatchObject({
			state: "inconclusive",
			neighbours: { "src/b.ts": "findings", "src/c.ts": "unconfirmed" },
		});
	});

	it("reads a neighbour listed under unconfirmed as unconfirmed even when observed", () => {
		// Recurrence: #4485, `unconfirmed` is the run's own word for "asked, no
		// answer in the bound", and outranks a path that was merely selected.
		const run = liveRun({
			unconfirmed: { servers: [{ paths: [`${WS}/src/c.ts`] }] },
		});
		expect(neighbourVerdict(run, WS, "src/c.ts")).toBe("unconfirmed");
		expect(classifyCascadeRun(run, fx, WS).state).toBe("inconclusive");
	});

	it("reads a skip reason as a cascade that never asked", () => {
		// Recurrence: #4485, `no_neighbors` (a leaf's all-clear) returned for an
		// edit that broke its importers.
		expect(
			classifyCascadeRun({ skipReason: "no_neighbors" }, fx, WS),
		).toMatchObject({
			state: "inconclusive",
			detail: "cascade skipped: no_neighbors",
		});
	});

	it("refuses a clean verdict on an importer of a broken export", () => {
		// Recurrence: measured on 2026-10-30, rust-analyzer started without cargo
		// loads no workspace and answered clean for both importers of a broken
		// export. Concluded is not correct: the stale importer is the defect.
		const run = liveRun({ result: { formatted: "" } });
		const verdict = classifyCascadeRun(run, fx, WS);
		expect(verdict.state).toBe("wrong-verdict");
		expect(verdict.neighbours).toEqual({
			"src/b.ts": "clean",
			"src/c.ts": "clean",
		});
	});

	it("takes a clean verdict when the fixture declares no expected finding", () => {
		const run = liveRun({ result: { formatted: "" } });
		expect(
			classifyCascadeRun(run, { ...fx, expectFindings: undefined }, WS).state,
		).toBe("conclusive");
	});

	it("matches the finding text inside the neighbour's own block only", () => {
		// A finding in src/b.ts must not satisfy src/c.ts.
		const run = liveRun({
			result: { formatted: block("src/b.ts", "is not assignable") },
		});
		expect(neighbourShowsFinding(run, "src/b.ts", "is not assignable")).toBe(
			true,
		);
		expect(neighbourShowsFinding(run, "src/c.ts", "is not assignable")).toBe(
			false,
		);
	});
});

describe("cascadeRow (#1712)", () => {
	const concluded = (
		state: "conclusive" | "inconclusive" | "wrong-verdict",
		detail = "x",
	) => ({ state, detail, neighbours: {} });
	const m = (over: Partial<CascadeMeasurement> = {}): CascadeMeasurement => ({
		answered: true,
		warmMs: 10,
		attempts: 1,
		firstCascadeMs: 80,
		timeToConclusiveMs: 93,
		elapsedMs: 93,
		concluded: concluded("conclusive"),
		...over,
	});

	it("passes a conclusive run and names the time", () => {
		expect(cascadeRow(fx, m())).toMatchObject({
			state: "pass",
			detail: expect.stringContaining("93 ms"),
		});
	});

	it("reds a server that handshook and never answered the warm-up", () => {
		// Recurrence: #1712, a server that never answers within budget must red
		// the lane, not read as unavailable.
		expect(
			cascadeRow(fx, m({ answered: false, handshook: true, warmMs: 120000 })),
		).toMatchObject({ state: "fail" });
	});

	it("warns, not reds, for a server that never handshook or has no census", () => {
		expect(cascadeRow(fx, m({ answered: false, handshook: false })).state).toBe(
			"skip",
		);
		expect(cascadeRow(fx, m({ answered: false })).state).toBe("skip");
	});

	it("reds a run that never concluded inside the deadline", () => {
		const row = cascadeRow(
			fx,
			m({
				concluded: concluded("inconclusive", "src/c.ts unconfirmed"),
				attempts: 40,
				elapsedMs: 90000,
			}),
		);
		expect(row.state).toBe("fail");
		expect(row.detail).toContain("src/c.ts unconfirmed");
	});

	it("passes a declared-inconclusive run while it stays inconclusive", () => {
		const declared = { ...fx, expectInconclusive: "server never pushes" };
		const row = cascadeRow(
			declared,
			m({ concluded: concluded("inconclusive", "src/c.ts unconfirmed") }),
		);
		expect(row.state).toBe("pass");
		expect(row.detail).toContain("server never pushes");
	});

	it("reds a declared-inconclusive run that concluded (a stale declaration)", () => {
		// Recurrence: an expected-inconclusive declaration that outlives the
		// defect it records would hide a regression behind it.
		const row = cascadeRow({ ...fx, expectInconclusive: "reason" }, m());
		expect(row.state).toBe("fail");
		expect(row.detail).toContain("remove the declaration");
	});

	it("does not let a declaration excuse a wrong verdict", () => {
		const row = cascadeRow(
			{ ...fx, expectInconclusive: "reason" },
			m({ concluded: concluded("wrong-verdict", "read clean") }),
		);
		expect(row.state).toBe("fail");
	});
});

describe("describeLastTouch (#1712)", () => {
	// Lines as latency.log writes them for a jdtls that never launched.
	const file = "/ws/src/lib/Lib.java";
	const line = (phase: string, metadata: object, filePath = file) =>
		JSON.stringify({ type: "phase", phase, filePath, metadata });
	const log = [
		line("lsp_client_selected", { serverId: "java", outcome: "spawn-failure" }),
		line("lsp_touch_file", {
			failureKind: "no_clients_none_spawning",
			candidates: [{ serverId: "java", clientFound: "none" }],
		}),
		line("lsp_touch_file", { failureKind: "other-file" }, "/ws/other.java"),
		"not json at all",
	].join("\n");

	it("names the launch outcome and the touch failure of the file", () => {
		// Recurrence: #1712 CI run 41019475461, a jdtls red that said only
		// "never answered a touch" and left the cause in a runner log.
		expect(describeLastTouch(log, file)).toBe(
			"client java: spawn-failure; touch no_clients_none_spawning",
		);
	});

	it("adds the launcher's spawn classification for a process that never started", () => {
		const extension = JSON.stringify({
			message: "spawn failure classified",
			metadata: {
				kind: "tool-not-found",
				command: "/runner/pi-lens-jdtls/bin/jdtls",
				cwd: "/ws",
			},
		});
		expect(describeLastTouch(log, file, extension)).toBe(
			"client java: spawn-failure; touch no_clients_none_spawning; spawn tool-not-found (jdtls)",
		);
		// A failure in another workspace is not this file's.
		expect(
			describeLastTouch(log, file, extension.replace("/ws", "/elsewhere")),
		).not.toContain("spawn tool-not-found");
	});

	it("says nothing for a file the log never mentions", () => {
		expect(describeLastTouch(log, "/ws/missing.java")).toBe("");
	});

	it("puts the reason into the red row", () => {
		const row = cascadeRow(
			{ ...fx, provisionedBy: "X" },
			{
				answered: false,
				handshook: true,
				warmMs: 5,
				attempts: 0,
				why: "client java: spawn-failure",
			},
		);
		expect(row.detail).toContain("(client java: spawn-failure)");
	});
});

describe("cascade fixtures (#1712)", () => {
	const baseLangs = new Set(LSP_FIXTURES.map((f: { lang: string }) => f.lang));

	it("covers the four priority servers", () => {
		// The four servers of #1712's remainder: typescript-go (the typescript7
		// row), rust-analyzer, gopls, jdtls.
		expect(CASCADE_FIXTURES.map((f) => f.lang)).toEqual([
			"typescript7",
			"rust",
			"go",
			"java",
		]);
	});

	it.each(CASCADE_FIXTURES.map((f) => [f.lang, f] as const))(
		"%s: reuses a handshake row and is a real import edge",
		(_lang, f) => {
			expect(baseLangs.has(f.lang)).toBe(true);
			const read = (rel: string) =>
				fs.readFileSync(path.join(REPO_ROOT, f.dir, rel), "utf8");
			const primary = read(f.file);
			// The edit applies once and changes the exporter.
			expect(primary.split(f.edit.from).length - 1).toBe(1);
			expect(primary.replace(f.edit.from, f.edit.to)).not.toBe(primary);
			expect(primary).toContain(f.symbol);
			// Two importers, each calling the symbol the edit breaks.
			expect(f.neighbours).toHaveLength(2);
			for (const rel of f.neighbours)
				expect(read(rel)).toContain(`${f.symbol}(`);
			expect(() => new RegExp(f.expectFindings ?? "")).not.toThrow();
		},
	);

	it("declares no expected-inconclusive server without a reason", () => {
		for (const f of CASCADE_FIXTURES)
			if ("expectInconclusive" in f)
				expect(String(f.expectInconclusive).length).toBeGreaterThan(10);
	});
});

describe("runLspCascade (#1712)", () => {
	const dirs: string[] = [];
	const savedHome = process.env.PI_LENS_HOME;
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
	});

	/** A workspace holding the real fixture files, as bootstrap would leave it. */
	function workspaceFor(f: CascadeFixture) {
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cascade-lane-"),
		);
		dirs.push(workspace);
		fs.cpSync(path.join(REPO_ROOT, f.dir), workspace, { recursive: true });
		return workspace;
	}

	async function runLane(opts: {
		fixture?: Partial<CascadeFixture>;
		census?: string;
		answers?: boolean;
		launchVariant?: string;
		run: (workspace: string, attempt: number) => CascadeRunLike;
	}) {
		const base = CASCADE_FIXTURES[0];
		const fixture = {
			...base,
			// The deadline is below one retry interval: one attempt, no sleeping.
			conclusiveDeadlineMs: 10,
			warmDeadlineMs: 10,
			serverHint: "probe-server",
			...opts.fixture,
		};
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cascade-home-"),
		);
		dirs.push(home);
		process.env.PI_LENS_HOME = home;
		if (opts.census)
			fs.writeFileSync(
				path.join(home, "lsp-handshake-census.json"),
				JSON.stringify({ [fixture.lang]: { state: opts.census } }),
			);
		const timesOut = path.join(home, "times.json");
		const workspace = workspaceFor(fixture);
		let attempt = 0;
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a) =>
			output.push(a.join(" ")),
		);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const touchFile = vi.fn(async () =>
			opts.answers === false ? undefined : { diags: [] },
		);
		const deps = {
			fixtures: [fixture],
			touchFile,
			getLSPService: () =>
				makeLspServiceDouble({
					touchFile,
					getCapabilitySnapshots: vi.fn(async () => [
						{ launchVariant: opts.launchVariant ?? "native-ts7" },
					]),
					shutdown: vi.fn(async () => undefined),
				}),
			computeCascadeForFile: vi.fn(async () => opts.run(workspace, ++attempt)),
			initLSPConfig: vi.fn(async () => undefined),
			ensureTool: vi.fn(async () => "/mock/tool"),
			getInstallAttempt: vi.fn(),
			adoptProjectTrustFromContext: vi.fn(),
			bootstrapFixtureWorkspace: vi.fn(async () => ({
				workspace,
				absFile: path.join(workspace, fixture.file),
				cleanup: vi.fn(),
			})),
		};
		const failures = await runLspCascade({
			langs: [fixture.lang],
			install: false,
			verbose: false,
			timesOut,
			deps,
		});
		const times = fs.existsSync(timesOut)
			? JSON.parse(fs.readFileSync(timesOut, "utf8"))
			: undefined;
		return { failures, times, output: output.join("\n"), deps, workspace };
	}

	const concludes = (workspace: string) =>
		liveRun({
			observedNeighborPaths: [
				path.join(workspace, "src/b.ts"),
				path.join(workspace, "src/c.ts"),
			],
		});

	it("passes and records the time when both importers conclude", async () => {
		const { failures, times, output, deps } = await runLane({
			census: "pass",
			run: concludes,
		});
		expect(failures).toBe(0);
		expect(output).toContain("✓  typescript7");
		// The edit reached disk before the cascade asked.
		expect(deps.computeCascadeForFile).toHaveBeenCalledOnce();
		expect(times.rows[0]).toMatchObject({
			lang: "typescript7",
			state: "pass",
			attempts: 1,
			timeToConclusiveMs: expect.any(Number),
			neighbours: { "src/b.ts": "findings", "src/c.ts": "findings" },
		});
		expect(times.schema).toBe(1);
	});

	it("reds when a server that handshook never concludes an importer", async () => {
		// Recurrence: #1712, the quiet shape: a cascade that never concludes
		// every night while the handshake layer stays green.
		const { failures, times, output } = await runLane({
			census: "pass",
			run: (workspace) =>
				liveRun({
					observedNeighborPaths: [path.join(workspace, "src/b.ts")],
					unconfirmed: {
						servers: [{ paths: [path.join(workspace, "src/c.ts")] }],
					},
				}),
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("✗  typescript7");
		expect(output).toContain("src/c.ts unconfirmed");
		expect(times.rows[0]).toMatchObject({
			state: "fail",
			timeToConclusiveMs: null,
		});
	});

	it("reds an importer that concluded clean after the export broke", async () => {
		const { failures, output } = await runLane({
			census: "pass",
			run: (workspace) => ({
				...concludes(workspace),
				result: { formatted: "" },
			}),
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("concluded without a");
	});

	it("reds a server that handshook and answered nothing here", async () => {
		const { failures, output, deps } = await runLane({
			census: "pass",
			answers: false,
			run: concludes,
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("never answered a touch");
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("warns for a server whose handshake never passed", async () => {
		const { output, deps } = await runLane({
			census: "skip",
			answers: false,
			run: concludes,
		});
		expect(output).toContain("⚠  typescript7");
		// Recurrence: a missing server made the lane wait out its whole warm-up
		// deadline (4.5 minutes for two absent servers, measured 2026-10-30).
		expect(deps.touchFile).not.toHaveBeenCalled();
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("takes a provisioned server's availability from its env var, not the census", async () => {
		// Recurrence: #1712/#3400, jdtls has no managed installer, so the nightly's
		// handshake step never starts it and its census row says skip every night.
		// A lane that read that row would skip java forever; one that ignored an
		// unset variable would red a developer's machine.
		const fixture = { provisionedBy: "PI_LENS_TEST_PROVISIONED_SERVER" };
		const savedVar = process.env[fixture.provisionedBy];
		try {
			delete process.env[fixture.provisionedBy];
			const missing = await runLane({
				census: "skip",
				fixture,
				answers: false,
				run: concludes,
			});
			expect(missing.output).toContain("⚠  typescript7");
			expect(missing.deps.touchFile).not.toHaveBeenCalled();

			process.env[fixture.provisionedBy] = "/opt/server/bin/server";
			const present = await runLane({
				census: "skip",
				fixture,
				answers: false,
				run: concludes,
			});
			expect(present.failures).toBeGreaterThan(0);
			expect(present.output).toContain("never answered a touch");
			expect(present.deps.touchFile).toHaveBeenCalled();
		} finally {
			if (savedVar === undefined) delete process.env[fixture.provisionedBy];
			else process.env[fixture.provisionedBy] = savedVar;
		}
	});

	it("reds a silent fallback to the classic server", async () => {
		// Recurrence: #530, native and classic TypeScript share one server id, so
		// a cascade that concluded through the wrong server proves nothing about
		// typescript-go.
		const { failures, output, deps } = await runLane({
			census: "pass",
			launchVariant: "classic",
			run: concludes,
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("silent fallback");
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("reds a fixture whose edit no longer applies", async () => {
		const { failures, output, deps } = await runLane({
			census: "pass",
			fixture: { edit: { from: "no such text", to: "x" } },
			run: concludes,
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("fixture drift");
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("applies the edit to the exporter before the cascade asks", async () => {
		const seen: string[] = [];
		await runLane({
			census: "pass",
			run: (workspace) => {
				seen.push(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"));
				return concludes(workspace);
			},
		});
		expect(seen).toEqual([
			"export function foo(x: string): string {\n\treturn x;\n}\n",
		]);
	});
});

describe("cascadeTimesRecord (#1712)", () => {
	it("keeps null for a time that was not measured", () => {
		const record = cascadeTimesRecord(
			[
				{
					lang: "go",
					runner: "gopls",
					state: "skip",
					detail: "unavailable",
					diags: 0,
				},
			],
			{},
			{ GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "42" },
		);
		expect(record.runner).toMatchObject({ ci: true, runId: "42" });
		expect(record.rows[0]).toMatchObject({
			lang: "go",
			warmMs: null,
			timeToConclusiveMs: null,
		});
	});
});
