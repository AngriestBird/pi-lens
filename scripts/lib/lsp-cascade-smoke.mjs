/**
 * Live cascade cover for the four priority servers (#1712).
 *
 * The cascade (`computeCascadeForFile`) is the path an agent's write takes to
 * learn that it broke an importer. Every unit test drives a double of the
 * server; #4495/#4812 added a classic-tsserver live twin that CI skips. This
 * module owns the pure half of the nightly `--lsp-cascade` lane in
 * scripts/smoke-tools.mjs: the fixtures, the verdict on one cascade run, and
 * the telemetry row. The runner that spawns the servers is `runLspCascade`
 * there.
 *
 * A fixture is a 3-file project with a real import edge: an exporter, and two
 * importers that call it. The lane breaks the exporter's signature and asks
 * the production cascade about the importers. A neighbour is CONCLUSIVE when
 * the run observed it (`observedNeighborPaths`: clean or with findings) and
 * did not list it under `unconfirmed`. `expectFindings` pins that the verdict
 * is the right one: a server that concludes "clean" on a neighbour whose
 * import is now broken is the stale-importer defect (#4485) in its quiet form.
 */
import * as path from "node:path";

/** Default time, from the exporter's write, for every neighbour to conclude. */
export const CASCADE_CONCLUSIVE_DEADLINE_MS = 60_000;
/** Default time for a cold server to answer its first warm-up touch. */
export const CASCADE_WARM_DEADLINE_MS = 90_000;
/** Pause between cascade attempts that ended with a neighbour unconfirmed. */
export const CASCADE_RETRY_INTERVAL_MS = 2_000;

/**
 * The fixtures. `lang` names the LSP_FIXTURES row whose `tools`, `setup`,
 * `serverHint`, `expectLaunchVariant` and handshake-census entry this lane
 * reuses; `dir`, `file` (the exporter) and the rest are the cascade project.
 *
 * `symbol` is the exported function the edit breaks; each neighbour calls it.
 *
 * `provisionedBy: "<ENV>"` marks a server pi-lens cannot install itself
 * (jdtls has no managed installer, #3400): the workflow step provisions it and
 * hands the lane its path in that variable. The handshake census, which ran
 * without it, is not consulted: the variable set means the server MUST answer
 * (a miss is red), unset means it was not provisioned here (a warning).
 *
 * `expectInconclusive: "<reason>"` declares that this server is known not to
 * conclude within the deadline, with the reason. The lane then passes only
 * while the neighbours stay unconfirmed, and fails when they conclude, so the
 * declaration cannot outlive the defect it records. None is declared today.
 */
export const CASCADE_FIXTURES = [
	{
		// typescript-go (native `tsc --lsp --stdio`, pull diagnostics).
		lang: "typescript7",
		dir: "tests/fixtures/lsp-cascade/typescript7",
		file: "src/a.ts",
		symbol: "foo",
		neighbours: ["src/b.ts", "src/c.ts"],
		edit: { from: "(x: number): number", to: "(x: string): string" },
		expectFindings: "is not assignable",
	},
	{
		lang: "rust",
		dir: "tests/fixtures/lsp-cascade/rust",
		file: "src/a.rs",
		symbol: "foo",
		neighbours: ["src/b.rs", "src/c.rs"],
		edit: { from: "(x: i32) -> i32", to: "(x: &str) -> String" },
		expectFindings: "E0308|expected .* found",
	},
	{
		lang: "go",
		dir: "tests/fixtures/lsp-cascade/go",
		file: "lib/lib.go",
		symbol: "Foo",
		neighbours: ["app/app.go", "tool/tool.go"],
		edit: { from: "(x int) int", to: "(x string) string" },
		expectFindings: "cannot use",
	},
	{
		lang: "java",
		dir: "tests/fixtures/lsp-cascade/java",
		file: "src/lib/Lib.java",
		symbol: "foo",
		neighbours: ["src/app/B.java", "src/app/C.java"],
		edit: { from: "int foo(int x)", to: "String foo(String x)" },
		expectFindings: "not applicable|mismatch|cannot convert",
		warmDeadlineMs: 180_000,
		provisionedBy: "JDTLS_PATH",
	},
];

const posix = (p) => p.split(path.sep).join("/");

/**
 * The verdict for one neighbour of one cascade run: `unconfirmed` (the server
 * asked gave no answer within the run's bound, or the run never reached it),
 * `findings` (observed, and the cascade output carries a diagnostics block for
 * it) or `clean` (observed, no block).
 *
 * `workspace` and `rel` are matched through `path.resolve`, because the run
 * names paths in the host's normalised form.
 */
export function neighbourVerdict(run, workspace, rel) {
	const abs = path.resolve(workspace, rel);
	const same = (p) => path.resolve(p) === abs;
	if ((run?.unconfirmed?.servers ?? []).some((s) => s.paths.some(same)))
		return "unconfirmed";
	if (!(run?.observedNeighborPaths ?? []).some(same)) return "unconfirmed";
	const formatted = run?.result?.formatted ?? "";
	return formatted.includes(`<diagnostics file="${posix(rel)}"`)
		? "findings"
		: "clean";
}

/**
 * Does the cascade output carry the expected finding text inside the
 * neighbour's own diagnostics block (the block header ends at `>`, then the
 * first lines are the server's message).
 */
export function neighbourShowsFinding(run, rel, pattern) {
	const block = new RegExp(
		`<diagnostics file="${posix(rel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>\\n[^<]*(?:${pattern})`,
		"i",
	);
	return block.test(run?.result?.formatted ?? "");
}

/**
 * Classify one cascade run against a fixture.
 *
 * - `conclusive`: every neighbour observed, none unconfirmed, and (when the
 *   fixture declares `expectFindings`) each shows the expected finding.
 * - `wrong-verdict`: every neighbour concluded but one does not show the
 *   expected finding: the server answered, and answered stale.
 * - `inconclusive`: a neighbour is unconfirmed, or the run carries a skip
 *   reason that means the cascade never asked.
 */
export function classifyCascadeRun(run, fx, workspace) {
	const neighbours = Object.fromEntries(
		fx.neighbours.map((rel) => [rel, neighbourVerdict(run, workspace, rel)]),
	);
	const unasked = [
		"blockers",
		"non_code",
		"no_neighbors",
		"indeterminate",
		"error",
	];
	if (unasked.includes(run?.skipReason)) {
		return {
			state: "inconclusive",
			neighbours,
			detail: `cascade skipped: ${run.skipReason}`,
		};
	}
	const open = fx.neighbours.filter((rel) => neighbours[rel] === "unconfirmed");
	if (open.length > 0) {
		return {
			state: "inconclusive",
			neighbours,
			detail: `${open.join(", ")} unconfirmed`,
		};
	}
	if (fx.expectFindings) {
		const stale = fx.neighbours.filter(
			(rel) => !neighbourShowsFinding(run, rel, fx.expectFindings),
		);
		if (stale.length > 0) {
			return {
				state: "wrong-verdict",
				neighbours,
				detail: `${stale.join(", ")} concluded without a /${fx.expectFindings}/ finding (importer of a broken export read ${stale.map((rel) => neighbours[rel]).join(", ")})`,
			};
		}
	}
	return {
		state: "conclusive",
		neighbours,
		detail: "all neighbours concluded",
	};
}

/**
 * The lane row from the measurements of one fixture.
 *
 * `answered` is false when the warm-up never got an answer from the server;
 * `handshook` is the handshake-census verdict for the same server (`true`
 * pass, `false` anything else, `undefined` no census). A server that handshook
 * and then never answered is a regression (fail); one that never handshook,
 * or with no census to say, is unavailable on this runner (skip).
 */
export function cascadeRow(fx, m) {
	const base = {
		lang: fx.lang,
		runner: fx.serverHint ?? fx.lang,
		diags: Object.values(m.neighbours ?? {}).filter((v) => v === "findings")
			.length,
	};
	if (!m.answered) {
		return m.handshook === true
			? {
					...base,
					state: "fail",
					detail: `expected to answer (handshake passed or provisioned here) but never answered a touch in ${m.warmMs} ms`,
				}
			: {
					...base,
					state: "skip",
					detail: `${base.runner} unavailable (no answer in ${m.warmMs} ms${m.handshook === false ? "; not provisioned, or the handshake did not complete" : ""})`,
				};
	}
	if (m.concluded?.state === "conclusive") {
		return fx.expectInconclusive
			? {
					...base,
					state: "fail",
					detail: `declared inconclusive (${fx.expectInconclusive}) but concluded in ${m.timeToConclusiveMs} ms: remove the declaration`,
				}
			: {
					...base,
					state: "pass",
					detail: `neighbours concluded in ${m.timeToConclusiveMs} ms (attempt ${m.attempts}; first cascade ${m.firstCascadeMs} ms)`,
				};
	}
	const why = `${m.concluded?.detail ?? "no cascade ran"} after ${m.attempts} attempt(s), ${m.elapsedMs} ms`;
	if (m.concluded?.state === "inconclusive" && fx.expectInconclusive) {
		return {
			...base,
			state: "pass",
			detail: `expected inconclusive (${fx.expectInconclusive}): ${why}`,
		};
	}
	return { ...base, state: "fail", detail: why };
}

/** The telemetry record the lane writes with `--times-out`. */
export function cascadeTimesRecord(rows, measurements, env = process.env) {
	return {
		schema: 1,
		command:
			"node scripts/smoke-tools.mjs --lsp-cascade --install --times-out=<file>",
		date: new Date().toISOString().slice(0, 10),
		runner: {
			os: process.platform,
			arch: process.arch,
			node: process.version,
			ci: env.GITHUB_ACTIONS === "true",
			runId: env.GITHUB_RUN_ID ?? null,
			image: env.ImageVersion ?? null,
		},
		rows: rows.map((row) => {
			const m = measurements[row.lang] ?? {};
			return {
				lang: row.lang,
				server: row.runner,
				state: row.state,
				warmMs: m.warmMs ?? null,
				firstCascadeMs: m.firstCascadeMs ?? null,
				timeToConclusiveMs:
					m.concluded?.state === "conclusive" ? m.timeToConclusiveMs : null,
				attempts: m.attempts ?? null,
				neighbours: m.neighbours ?? null,
			};
		}),
	};
}
