#!/usr/bin/env node
/**
 * Per-server save verdict (#3405 acceptance 4) — the measurement behind
 * `docs/lsp-capability-matrix.md`'s `## Save-triggered servers` table.
 *
 * The question: for a server that declares `textDocumentSync.save`, does the
 * seeded error reach the client WITHOUT a `textDocument/didSave`, or does only a
 * save make the server answer? #4768 answered it for five servers by hand and
 * read the rest of the population from each server's source; no command produced
 * the column, so nothing could re-measure it and no reader could reproduce a
 * cell.
 *
 * This driver answers it through the REAL client on the tool-smoke fixtures
 * (`LSP_FIXTURES`, the same population the nightly gate and the clean-signal
 * probe drive — no second fixture set, no second spawn path):
 *
 *   arm `noSave`     the fixture's seeded bytes with `saved: false` — didOpen
 *                    carries the error and no save is sent
 *   arm `silence`    an untriggered window of the same length, push servers only
 *   arm `saveAlone`  the SAME bytes with `saved: true`, so a publish here has the
 *                    save as its only new input
 *   arm `savedWrite` a diagnostic-neutral appended comment (bytes differ, the
 *                    finding set does not) with `saved: true` — the production
 *                    shape, and the only arm that can rescue a server which
 *                    compiles on a saved write
 *
 * `scripts/lib/save-verdict.mjs` owns the classification, the merge guard and
 * the cell wording; this file is the driver. The doc's three measurement columns
 * are rewritten for the rows this run reached and every other row is copied
 * verbatim, so a runner that could not install a server never blanks a measured
 * cell (#390).
 *
 *   node scripts/probe-save-verdict.mjs [lang ...] [--install]
 *       [--doc <path>] [--summary <path>] [--budget-seconds <n>] [--wait-ms <n>]
 *
 * Requires `npm run build:dist`. Exits 0 for any measurement outcome; it exits 1
 * only when the run measured NOTHING (no save-declaring server reached), so a
 * dead instrument cannot read green for six days (#4514's shape).
 *
 * Attribution limit, stated because it decides `inconclusive` vs `yes`: an
 * answer that arrives after an arm's window closed lands in the NEXT arm's
 * window. The untriggered `silence` window covers exactly that case for the
 * first arm, and any publish in it makes the row `inconclusive` rather than
 * crediting the save.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublishTraceDrainer } from "./lib/clean-signal.mjs";
import {
	adoptFixtureProjectTrust,
	bootstrapFixtureWorkspace,
	fixtureTrustRefusal,
	withScratchHome,
} from "./lib/lsp-fixture-workspace.mjs";
import { commentFor } from "./lib/probe-fixture.mjs";
import {
	orderByNeed,
	parseSaveVerdictRows,
	refreshSaveVerdictTable,
	SAVE_VERDICT_COMMAND,
	saveVerdictCells,
} from "./lib/save-verdict.mjs";
import { touchAnsweredDiagnostics } from "./lib/touch-result.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const argv = process.argv.slice(2);
const flagNames = new Set([
	"--doc",
	"--summary",
	"--budget-seconds",
	"--wait-ms",
]);
const flagValue = (name, fallback) => {
	const i = argv.indexOf(name);
	if (i < 0) return fallback;
	const value = argv[i + 1];
	return value === undefined || value.startsWith("--") ? fallback : value;
};
const install = argv.includes("--install");
const langs = argv.filter(
	(a, i) => !a.startsWith("--") && !flagNames.has(argv[i - 1]),
);
const docPath = path.resolve(
	repoRoot,
	flagValue("--doc", path.join("docs", "lsp-capability-matrix.md")),
);
const summaryPath = flagValue("--summary", undefined);
// The nightly job caps at 35 minutes and the steps before this one measure about
// 14. Stopping here leaves a disclosed `budget-exhausted` row for every server
// not reached, instead of letting the job timeout discard the whole run; the
// document keeps those rows verbatim.
const budgetMs = Number(flagValue("--budget-seconds", "600")) * 1000;
// One window per arm. #4768 measured clangd's didOpen answer at 97 ms and Expert
// needed 50 s of project activation, which is why this is a flag and not a
// constant: a slow-project probe passes a larger window, and every arm of one
// run shares it, so the arms stay comparable.
const waitMs = Math.max(500, Number(flagValue("--wait-ms", "6000")));
// Hard per-server cap: cold spawn + the arms + settle, with margin.
const PER_SERVER_TIMEOUT_MS = waitMs * 3 + 60000;
const CLIENT_WAIT_MS = 30000;
const SETTLE_MS = 400;
const src = process.env.CI ? "ci" : "dev";

// #2670/#2506-shape: pin PI_LENS_HOME/PILENS_DATA_DIR to a scratch temp dir
// BEFORE the first dist/ import below — dist/clients/latency-logger.js reads its
// log dir into a top-level const at module load, not lazily per write.
withScratchHome();
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

// Force the client's publish trace on so the probe can attribute a publish to the
// arm that produced it. Must be set BEFORE importing dist (read once at module
// load).
process.env.PILENS_PUB_DEBUG = "1";

const { LSP_FIXTURES, runFixtureSetup } = await imp("scripts/smoke-tools.mjs");
const { getLSPService, resetLSPService } = await imp(
	"dist/clients/lsp/index.js",
);
const { getServersForFileWithConfig, initLSPConfig } = await imp(
	"dist/clients/lsp/config.js",
);
const { normalizeMapKey } = await imp("dist/clients/path-utils.js");
const { isAuxiliary } = await imp("dist/clients/lsp/server-traits.js");
// #4514: this script is a standalone host, not pi. Adopt project trust before the
// first touch, or the launch gate refuses every project-local and
// project-code server and every row reads as unreachable.
await adoptFixtureProjectTrust({ repoRoot });
let ensureTool;
if (install) {
	({ ensureTool } = await imp("dist/clients/installer/index.js"));
}

// ---- publish capture ------------------------------------------------------
// The client writes its `[lsp-pub]` trace to PI_LENS_HOME/extension.log, not to
// console.error (#1333 moved the sink; #3310 is the probe that kept reading the
// old one and measured zero publishes for months). Read the sink the client
// actually writes, and scope every row to (server, THIS fixture's document):
// several live clients share a server id (#4615).
const PUB_LOG_PATH = path.join(
	process.env.PI_LENS_HOME ?? path.parse(process.cwd()).root,
	"extension.log",
);
function pubLogSize() {
	try {
		return fs.statSync(PUB_LOG_PATH).size;
	} catch {
		return 0;
	}
}
const drainPublishTrace = createPublishTraceDrainer({
	documentPathKey: normalizeMapKey,
	readLog(offset) {
		const size = pubLogSize();
		if (size === offset) return { size, read: () => null };
		return {
			size,
			read(start) {
				try {
					const fd = fs.openSync(PUB_LOG_PATH, "r");
					try {
						const buf = Buffer.alloc(size - start);
						const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
						return {
							chunk: buf.subarray(0, bytesRead).toString("utf8"),
							bytesRead,
						};
					} finally {
						fs.closeSync(fd);
					}
				} catch {
					return null;
				}
			},
		};
	},
});

const lsp = getLSPService();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server the probe measures for a fixture: its auxiliary, else its primary. */
function probeServerId(fx, servers) {
	const auxId = fx.auxiliaryServerIds?.[0];
	if (auxId) return auxId;
	return servers.find((server) => !isAuxiliary(server))?.id;
}

function withTimeout(promise, ms, row) {
	let timer;
	const guard = new Promise((_, reject) => {
		timer = setTimeout(() => {
			row.detail = `per-server timeout after ${ms}ms`;
			reject(new Error(`per-server timeout after ${ms}ms`));
		}, ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
const docRows = parseSaveVerdictRows(docText);

const fixtures = orderByNeed(
	langs.length
		? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
		: [...LSP_FIXTURES],
	docRows,
	(fx) => fx.serverId ?? fx.lang,
);

const startedAt = Date.now();
const rows = [];
const notMeasured = [];
let budgetExhausted = false;

for (const fx of fixtures) {
	if (Date.now() - startedAt > budgetMs) {
		budgetExhausted = true;
		notMeasured.push({ fixture: fx.lang, reason: "budget-exhausted" });
		continue;
	}
	const row = {
		fixture: fx.lang,
		server: undefined,
		save: undefined,
		mode: undefined,
		cells: undefined,
		detail: "",
	};
	try {
		await withTimeout(probeFixture(fx, row), PER_SERVER_TIMEOUT_MS, row);
	} catch (e) {
		row.detail = `error: ${e?.message ?? e}`;
	}
	if (row.cells) rows.push(row);
	else
		notMeasured.push({ fixture: fx.lang, reason: row.detail || "unreached" });
	console.error(
		`[${fx.lang}] server=${row.server ?? "?"} save=${row.save ?? "?"} verdict=${row.cells?.["publishes after save only"] ?? "not measured"} — ${row.detail}`,
	);
}

async function probeFixture(fx, row) {
	const { workspace, absFile, cleanup } = await bootstrapFixtureWorkspace(fx, {
		initLSPConfig,
		repoRoot,
		tmpPrefix: "save-verdict-",
	});
	try {
		if (install && ensureTool) {
			for (const tool of fx.tools ?? [])
				await ensureTool(tool).catch(() => undefined);
		}
		if (fx.setup) {
			const setup = runFixtureSetup(fx.setup, workspace, false);
			if (!setup.ok) {
				row.detail = `setup failed: ${setup.detail}`;
				return;
			}
		}
		if (!lsp.supportsLSP(absFile)) {
			row.detail = "no LSP server registered for this file";
			return;
		}
		row.server = probeServerId(fx, getServersForFileWithConfig(absFile));
		const auxIds = fx.auxiliaryServerIds ?? [];
		const touchOptions = {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: auxIds.length ? "with-auxiliary" : "primary",
			...(auxIds.length ? { auxiliaryServerIds: auxIds } : {}),
			maxClientWaitMs: CLIENT_WAIT_MS,
			source: "save-verdict",
		};
		const seed = fs.readFileSync(absFile, "utf8");
		const arm = async (saved, content, label) => {
			drainPublishTrace.reset(pubLogSize());
			const publishes = [];
			const armStartedAt = Date.now();
			let result;
			try {
				result = await lsp.touchFile(absFile, content, {
					...touchOptions,
					maxDiagnosticsWaitMs: waitMs,
					saved,
				});
			} catch (e) {
				row.detail = `${label}: ${e?.message ?? e}`;
			}
			const elapsed = Date.now() - armStartedAt;
			drainPublishTrace(publishes, row.server, absFile);
			const answered = touchAnsweredDiagnostics(result, touchOptions, lsp);
			return {
				label,
				ms: elapsed,
				nonEmptyPublishes: publishes.filter((p) => p.diags > 0).length,
				publishes: publishes.length,
				answeredDiags: answered?.length ?? 0,
				inconclusive: result?.inconclusive === true,
			};
		};

		// Arm 1 is also the first spawn, so it carries the cold budget. The
		// capabilities it produces decide whether this server is in the population
		// at all and whether the answer is a publish or a pull.
		const noSave = await arm(false, seed, "no-save");
		await sleep(SETTLE_MS);
		const snapshots = await lsp.getCapabilitySnapshots(absFile);
		const snapshot = snapshots.find((s) => s.serverId === row.server);
		if (!snapshot) {
			const refused = await fixtureTrustRefusal(repoRoot);
			row.detail = refused ?? "server never spawned (no capability snapshot)";
			return;
		}
		row.save = snapshot.textDocumentSave ?? "none";
		// Population: every server that DECLARES textDocumentSync.save. A server
		// that declares none is not in this table's population, so it gets no cell
		// — writing `no` there would claim a save behaviour for a save it never
		// receives.
		if (row.save !== "save" && row.save !== "save+text") {
			row.detail = `not in population: declares ${row.save}`;
			row.cells = undefined;
			return;
		}
		const support = await lsp.getWorkspaceDiagnosticsSupport(absFile);
		row.mode = support?.mode ?? "unknown";
		const armAnswer = (a) =>
			row.mode === "pull" ? a.answeredDiags : a.nonEmptyPublishes;
		const shape = (a) => ({
			nonEmpty: armAnswer(a),
			ms: armAnswer(a) > 0 ? a.ms : null,
		});

		// Arm 2 (push only): the same window with NO trigger. A publish here is a
		// late answer from arm 1 that belongs to no arm, so the row must not credit
		// the save that follows it.
		let silence = { nonEmpty: 0, ms: null };
		if (row.mode === "pull" || armAnswer(noSave) === 0) {
			if (row.mode !== "pull") {
				drainPublishTrace.reset(pubLogSize());
				const pubs = [];
				await sleep(waitMs);
				drainPublishTrace(pubs, row.server, absFile);
				silence = {
					nonEmpty: pubs.filter((p) => p.diags > 0).length,
					ms: null,
				};
			}
		}

		// Arm 3: the SAME bytes plus a save. `saved: true` is the only difference,
		// so a publish here has the save as its only new input — the clangd arm
		// #4527 and #4768 disagreed about.
		drainPublishTrace.reset(pubLogSize());
		const saveAlone = await arm(true, seed, "save-alone");
		await sleep(SETTLE_MS);

		// Arm 4: a diagnostic-neutral byte edit plus a save — the production shape.
		// Only reachable when nothing else answered, so a server that publishes on
		// open never pays for it.
		let savedWrite = { nonEmpty: 0, ms: null };
		if (
			armAnswer(noSave) === 0 &&
			silence.nonEmpty === 0 &&
			armAnswer(saveAlone) === 0
		) {
			const edited = `${seed}\n${commentFor(fx.file)} save-verdict probe edit\n`;
			fs.writeFileSync(absFile, edited);
			drainPublishTrace.reset(pubLogSize());
			const armResult = await arm(true, edited, "saved-write");
			savedWrite = shape(armResult);
		}

		row.cells = saveVerdictCells({
			server: snapshot.serverId ?? fx.serverId ?? fx.lang,
			save: row.save,
			mode: row.mode,
			fixture: fx,
			arms: {
				noSave: shape(noSave),
				silence,
				saveAlone: shape(saveAlone),
				savedWrite,
			},
			waitMs,
			src,
		});
		row.detail =
			`mode=${row.mode} no-save=${shape(noSave).nonEmpty} silence=${silence.nonEmpty}` +
			` save-alone=${shape(saveAlone).nonEmpty} saved-write=${savedWrite.nonEmpty}`;
	} finally {
		cleanup();
	}
}

// ---- report ---------------------------------------------------------------
const measured = rows.map((r) => r.cells);
console.log(
	`\nSave verdict (#3405): ${measured.length} measured, ${notMeasured.length} not measured` +
		`${budgetExhausted ? " (budget exhausted)" : ""} — window ${waitMs} ms per arm, src=${src}\n`,
);
console.log(
	`  ${"SERVER".padEnd(14)} ${"SAVE".padEnd(10)} ${"AFTER SAVE ONLY".padEnd(18)} DETAIL`,
);
for (const row of rows) {
	console.log(
		`  ${String(row.cells.server).padEnd(14)} ${String(row.cells["save as declared"]).padEnd(10)} ${String(row.cells["publishes after save only"]).padEnd(18)} ${row.detail}`,
	);
}
for (const skipped of notMeasured) {
	console.log(
		`  ${skipped.fixture.padEnd(14)} —                 not measured: ${skipped.reason}`,
	);
}

const refreshed = refreshSaveVerdictTable(docText, measured);
if (refreshed.changed) fs.writeFileSync(docPath, refreshed.text);
console.error(
	refreshed.reason
		? `save-verdict: ${refreshed.reason} (no doc written)`
		: `save-verdict: ${refreshed.changed ? "doc updated" : "doc unchanged"} — wrote ${refreshed.measured.length} row(s), kept ${refreshed.kept.length}` +
				(refreshed.notInTable.length
					? `, no table row for ${refreshed.notInTable.join(", ")}`
					: ""),
);

if (summaryPath) {
	try {
		fs.writeFileSync(
			summaryPath,
			JSON.stringify(
				{
					command: `${SAVE_VERDICT_COMMAND}${install ? " --install" : ""}`,
					src,
					waitMs,
					measured: rows.map((row) => row.cells),
					wrote: refreshed.measured,
					notInTable: refreshed.notInTable,
					kept: refreshed.kept,
					notMeasured,
					budgetExhausted,
				},
				null,
				2,
			),
		);
	} catch (e) {
		console.error(`save-verdict: summary not written (${e?.message ?? e})`);
	}
}

try {
	await resetLSPService?.({ fast: true });
} catch {}

// A night that wrote nothing is the #4514 shape: the instrument died and the
// table kept its old cells, so the step must red instead of reporting success.
if (refreshed.measured.length === 0) {
	console.error(
		"save-verdict: wrote NO row — the instrument is dead, or no save-declaring server was reached",
	);
	process.exit(1);
}
process.exit(0);
