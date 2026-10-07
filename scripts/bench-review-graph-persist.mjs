#!/usr/bin/env node
/**
 * Review-graph persist bench (#3913, follow-up of #3789).
 *
 * Measures what the review graph's two worker-persist sites cost the host,
 * through the production entry point (`buildOrUpdateGraph`):
 *
 *   - "persist": the debounced authoritative persist (`writePending`);
 *   - "checkpoint": the mid-build resume checkpoint (`writeReviewGraphCheckpoint`).
 *
 * Two axes per persist, on the same workload:
 *
 *   - main-thread time: the sum of the phases that hand the graph to the
 *     worker, each timed around its own call (a big `JSON.stringify`, a big
 *     `TextEncoder.encode`, and `Worker.prototype.postMessage`). Before the fix
 *     that is the structured clone inside `postMessage`; after, it is the
 *     stringify plus the encode plus a near-free transfer. The persist site
 *     also reports the worst event-loop gap over the timer callback;
 *   - RSS jump: peak process RSS (sampled every ~1 ms from a SEPARATE thread, so
 *     a blocked main thread cannot hide a peak) minus the RSS right before the
 *     hand-off, up to the moment the promoted stage file lands.
 *
 * MATERIALITY THRESHOLD, fixed before the first measurement (#3648): moving
 * `JSON.stringify` to the main thread is a regression only if, at a site, the
 * after-tree median main-thread time per persist exceeds 1.5x the before-tree
 * median AND the absolute increase is more than 100 ms. Either condition alone
 * is noise on a shared box. If that fires the change must not ship.
 *
 * Run after `npm run build`; one fresh child per site so one site's heap never
 * colours the other:
 *
 *   node scripts/bench-review-graph-persist.mjs \
 *     [--sites persist,checkpoint] [--files 3600] [--persists 5] \
 *     [--label <tree>] [--out <file.json>]
 *
 * The committed artifact `tests/fixtures/review-graph-persist-measurement.json`
 * is this script's raw output for the before and after trees;
 * `tests/clients/review-graph-persist-measurement.test.ts` pins it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const MB = 1024 * 1024;
const round = (n, digits = 1) => Number(n.toFixed(digits));
const epochNow = () => performance.timeOrigin + performance.now();
const BIG = 2_000_000;
const CHECKPOINT_STRIDE = 1000;
const CHECKPOINT_WINDOW_MS = 1800;
const SERIES_CAPACITY = 6_000_000;

/** Deterministic synthetic TypeScript tree: `fileCount` modules, each with a
 * dozen functions that call into sibling and imported modules. */
export function writeSyntheticTree(cwd, fileCount) {
	const perFile = 12;
	let state = 0x2545f491;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
	const dirOf = (i) => `src/d${Math.floor(i / 40)}`;
	const fileOf = (i) => `${dirOf(i)}/m${i}.ts`;
	for (let i = 0; i < fileCount; i++) {
		const imports = Array.from({ length: 4 }, () =>
			Math.floor(next() * fileCount),
		).filter((j) => j !== i);
		const lines = [];
		for (const j of new Set(imports)) {
			const rel = path
				.relative(dirOf(i), fileOf(j))
				.replace(/\\/g, "/")
				.replace(/\.ts$/, ".js");
			lines.push(
				`import { f${j}_0, f${j}_1 } from "${rel.startsWith(".") ? rel : `./${rel}`}";`,
			);
		}
		lines.push("");
		for (let k = 0; k < perFile; k++) {
			const imported = imports.length
				? `f${imports[k % imports.length]}_${k % 2}(x)`
				: "x";
			const sibling = k > 0 ? `f${i}_${k - 1}(x)` : "x";
			lines.push(
				`export function f${i}_${k}(x: number): number {`,
				`\treturn ${sibling} + ${imported} + ${k};`,
				"}",
				"",
			);
		}
		const file = path.join(cwd, fileOf(i));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, lines.join("\n"));
	}
	return path.join(cwd, fileOf(0));
}

function startRssSampler() {
	const series = new Float64Array(new SharedArrayBuffer(8 * SERIES_CAPACITY));
	// control: [0] stop flag, [1] the word the sampler sleeps on, [2] doubles written.
	const control = new Int32Array(new SharedArrayBuffer(12));
	const code = `
		const { workerData } = require("node:worker_threads");
		const { performance } = require("node:perf_hooks");
		const series = workerData.series;
		const control = workerData.control;
		let n = 0;
		while (Atomics.load(control, 0) === 0 && n + 2 <= series.length) {
			series[n++] = performance.timeOrigin + performance.now();
			series[n++] = process.memoryUsage.rss();
			Atomics.store(control, 2, n);
			Atomics.wait(control, 1, 0, 1);
		}
	`;
	const worker = new Worker(code, {
		eval: true,
		workerData: { series, control },
	});
	return {
		snapshot: () => ({ series, length: Atomics.load(control, 2) }),
		stop: async () => {
			Atomics.store(control, 0, 1);
			await new Promise((resolve) => worker.once("exit", resolve));
		},
	};
}

/** Peak RSS in [from, to] minus the RSS of the last sample at or before `from`. */
function rssJumpMB(sampled, from, to) {
	let baseline;
	let peak = 0;
	for (let i = 0; i < sampled.length; i += 2) {
		const t = sampled.series[i];
		const rss = sampled.series[i + 1];
		if (t <= from) baseline = rss;
		else if (t <= to) peak = Math.max(peak, rss);
	}
	if (baseline === undefined) return undefined;
	return round((Math.max(peak, baseline) - baseline) / MB);
}

function installProbes(events) {
	const originalPost = Worker.prototype.postMessage;
	Worker.prototype.postMessage = function postMessage(message, transfer) {
		if (message && typeof message.stagePath === "string") {
			const t0 = epochNow();
			const result = originalPost.call(this, message, transfer);
			const t1 = epochNow();
			events.push({
				kind: "post",
				site: path.basename(message.stagePath).includes(".checkpoint.")
					? "checkpoint"
					: "persist",
				t0,
				t1,
				isBytes: message.data instanceof Uint8Array,
				stagePath: message.stagePath,
			});
			return result;
		}
		return originalPost.call(this, message, transfer);
	};
	const originalStringify = JSON.stringify;
	JSON.stringify = function stringify(...callArgs) {
		const t0 = epochNow();
		const result = originalStringify.apply(this, callArgs);
		const t1 = epochNow();
		if (typeof result === "string" && result.length > BIG) {
			events.push({ kind: "stringify", t0, t1, length: result.length });
		}
		return result;
	};
	const originalEncode = TextEncoder.prototype.encode;
	TextEncoder.prototype.encode = function encode(input) {
		const t0 = epochNow();
		const result = originalEncode.call(this, input);
		const t1 = epochNow();
		if (result.byteLength > BIG) {
			events.push({ kind: "encode", t0, t1, bytes: result.byteLength });
		}
		return result;
	};
}

/** Group the probe events into per-persist hand-offs: each `post` closes the
 * stringify and encode events since the previous `post`. */
function handOffs(events) {
	const out = [];
	let pending = [];
	for (const event of events) {
		if (event.kind !== "post") {
			pending.push(event);
			continue;
		}
		const phases = pending;
		pending = [];
		const start = phases.length ? phases[0].t0 : event.t0;
		out.push({
			site: event.site,
			isBytes: event.isBytes,
			stagePath: event.stagePath,
			startedAt: start,
			postMs: event.t1 - event.t0,
			stringifyMs: phases
				.filter((p) => p.kind === "stringify")
				.reduce((sum, p) => sum + (p.t1 - p.t0), 0),
			encodeMs: phases
				.filter((p) => p.kind === "encode")
				.reduce((sum, p) => sum + (p.t1 - p.t0), 0),
			jsonChars: phases.find((p) => p.kind === "stringify")?.length,
			postedAt: event.t1,
		});
	}
	return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runChild(site, fileCount, persists) {
	const homeDir = process.env.PILENS_DATA_DIR;
	if (!homeDir) throw new Error("child requires a pinned PILENS_DATA_DIR");
	const cwd = path.join(homeDir, "bench-project");
	fs.mkdirSync(cwd, { recursive: true });
	// The default 1,000-file cap would skip the build; raise it to the tree size.
	process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = String(fileCount * 2);
	const touched = writeSyntheticTree(cwd, fileCount);
	// The tree sits under the worktree's ignored `.probe-home/`; its own repo keeps
	// the source walk from inheriting that ignore rule.
	spawnSync("git", ["init", "-q"], { cwd });
	const builderUrl = pathToFileURL(
		path.join(root, "clients", "review-graph", "builder.js"),
	).href;
	const storeUrl = pathToFileURL(
		path.join(root, "clients", "dispatch", "fact-store.js"),
	).href;
	const fileUtilsUrl = pathToFileURL(
		path.join(root, "clients", "file-utils.js"),
	).href;
	const { buildOrUpdateGraph, waitForReviewGraphPersistsForTests } =
		await import(builderUrl);
	const { FactStore } = await import(storeUrl);
	const { getProjectDataDir } = await import(fileUtilsUrl);
	const cacheDir = path.join(getProjectDataDir(cwd), "cache");
	const graphPath = path.join(cacheDir, "review-graph.json.gz");
	const stampOf = (file) => {
		try {
			const stat = fs.statSync(file);
			return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return "";
		}
	};
	const settle = async (ms) => {
		await sleep(ms);
		globalThis.gc?.();
		await sleep(50);
	};
	const events = [];
	installProbes(events);
	const sampler = startRssSampler();
	const gaps = [];
	let lastTick = performance.now();
	const stallTimer = setInterval(() => {
		const now = performance.now();
		const gap = now - lastTick - 1;
		lastTick = now;
		if (gap > 5) gaps.push({ at: epochNow(), gap });
	}, 1);
	const factStore = new FactStore();
	const base = { site, fileCount };
	const runs = [];
	if (site === "persist") {
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = "1000000000";
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		await buildOrUpdateGraph(cwd, [], factStore);
		await waitForReviewGraphPersistsForTests();
		for (let waited = 0; !fs.existsSync(graphPath) && waited < 600; waited++) {
			await sleep(100);
		}
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "1500";
		for (let n = 1; n <= persists; n++) {
			fs.appendFileSync(touched, `export const bump${n} = ${n};\n`);
			const before = stampOf(graphPath);
			events.length = 0;
			await buildOrUpdateGraph(cwd, [touched], factStore);
			await settle(300);
			const rssBeforeMB = round(process.memoryUsage.rss() / MB);
			const settledAt = epochNow();
			const started = performance.now();
			let doneAt;
			while (performance.now() - started < 120_000) {
				if (stampOf(graphPath) !== before) {
					doneAt = epochNow();
					break;
				}
				await sleep(5);
			}
			if (doneAt === undefined) throw new Error("persist did not land");
			await sleep(150);
			const handOff = handOffs(events).find((h) => h.site === "persist");
			if (!handOff) throw new Error("no persist hand-off observed");
			runs.push({
				persist: n,
				isBytes: handOff.isBytes,
				stringifyMs: round(handOff.stringifyMs),
				encodeMs: round(handOff.encodeMs),
				postMessageMs: round(handOff.postMs),
				mainThreadMs: round(
					handOff.stringifyMs + handOff.encodeMs + handOff.postMs,
				),
				worstLoopStallMs: round(
					Math.max(
						0,
						...gaps
							.filter((g) => g.at >= settledAt && g.at <= doneAt + 100)
							.map((g) => g.gap),
					),
				),
				persistWallMs: round(doneAt - handOff.startedAt),
				rssBeforeMB,
				rssJumpMB: rssJumpMB(sampler.snapshot(), settledAt, doneAt),
				jsonChars: handOff.jsonChars,
				gzBytes: fs.statSync(graphPath).size,
			});
		}
	} else {
		const stride =
			site === "checkpoint-control" ? 1_000_000_000 : CHECKPOINT_STRIDE;
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = String(stride);
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		const buildStartedAt = epochNow();
		await buildOrUpdateGraph(cwd, [], factStore);
		const buildEndedAt = epochNow();
		await waitForReviewGraphPersistsForTests();
		await sleep(300);
		const sampled = sampler.snapshot();
		// The build keeps the main thread busy, so a checkpoint's promotion lands
		// late and cannot close its RSS window; a fixed window covers the worker's
		// whole stringify/gzip instead.
		for (const [index, handOff] of handOffs(events)
			.filter((h) => h.site === "checkpoint")
			.entries()) {
			runs.push({
				persist: index + 1,
				isBytes: handOff.isBytes,
				stringifyMs: round(handOff.stringifyMs),
				encodeMs: round(handOff.encodeMs),
				postMessageMs: round(handOff.postMs),
				mainThreadMs: round(
					handOff.stringifyMs + handOff.encodeMs + handOff.postMs,
				),
				rssJumpMB: rssJumpMB(
					sampled,
					handOff.startedAt,
					handOff.startedAt + CHECKPOINT_WINDOW_MS,
				),
				jsonChars: handOff.jsonChars,
			});
		}
		// Background drift: the same window slid across the build, which is what
		// the build alone does while a checkpoint is in flight.
		const drift = [];
		for (
			let from = buildStartedAt;
			from + CHECKPOINT_WINDOW_MS <= buildEndedAt;
			from += CHECKPOINT_WINDOW_MS
		) {
			drift.push(rssJumpMB(sampled, from, from + CHECKPOINT_WINDOW_MS));
		}
		base.buildMs = round(buildEndedAt - buildStartedAt);
		base.backgroundRssDriftMB = drift.filter((v) => v !== undefined);
	}
	clearInterval(stallTimer);
	await sampler.stop();
	const graph = JSON.parse(
		gunzipSync(fs.readFileSync(graphPath)).toString("utf-8"),
	);
	return {
		...base,
		persistedNodes: graph.nodes.length,
		persistedEdges: graph.edges.length,
		elements: graph.nodes.length + graph.edges.length,
		runs,
	};
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(child) {
	const defined = (key) =>
		child.runs.map((r) => r[key]).filter((v) => v !== undefined);
	const summary = { persists: child.runs.length };
	if (child.runs.length > 0) {
		summary.medianMainThreadMs = round(median(defined("mainThreadMs")));
		summary.maxMainThreadMs = round(Math.max(...defined("mainThreadMs")));
		summary.medianRssJumpMB = round(median(defined("rssJumpMB")));
		summary.maxRssJumpMB = round(Math.max(...defined("rssJumpMB")));
	}
	if (child.site === "persist") {
		summary.medianWorstLoopStallMs = round(median(defined("worstLoopStallMs")));
	}
	if (child.backgroundRssDriftMB?.length) {
		summary.medianBackgroundRssDriftMB = round(
			median(child.backgroundRssDriftMB),
		);
		summary.maxBackgroundRssDriftMB = round(
			Math.max(...child.backgroundRssDriftMB),
		);
	}
	return summary;
}

async function main() {
	if (args.includes("--child")) {
		const site = readArg("--child", "persist");
		const result = await runChild(
			site,
			Number(readArg("--files", "3600")),
			Number(readArg("--persists", "5")),
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(0);
	}
	const sites = readArg("--sites", "persist,checkpoint").split(",");
	const fileCount = Number(readArg("--files", "3600"));
	const persists = Number(readArg("--persists", "5"));
	const baseHome = path.resolve(
		readArg("--home", path.join(root, ".probe-home", "bench-review-graph")),
	);
	const results = [];
	for (const site of sites) {
		const home = path.join(baseHome, site);
		fs.rmSync(home, { recursive: true, force: true });
		fs.mkdirSync(home, { recursive: true });
		const loadavg1mAtStart = round(os.loadavg()[0], 2);
		const child = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				fileURLToPath(import.meta.url),
				"--child",
				site,
				"--files",
				String(fileCount),
				"--persists",
				String(persists),
			],
			{
				encoding: "utf8",
				maxBuffer: 64 * MB,
				env: {
					...process.env,
					HOME: path.join(home, "home"),
					PI_LENS_HOME: path.join(home, "lens"),
					PILENS_DATA_DIR: path.join(home, "data"),
				},
			},
		);
		if (child.status !== 0) {
			throw new Error(`bench child ${site} failed: ${child.stderr}`);
		}
		const parsed = JSON.parse(child.stdout.trim().split("\n").pop());
		results.push({ ...parsed, loadavg1mAtStart, summary: summarize(parsed) });
	}
	const report = {
		schemaVersion: 1,
		measuredAt: new Date().toISOString().slice(0, 10),
		command: `node scripts/bench-review-graph-persist.mjs --sites ${sites.join(",")} --files ${fileCount} --persists ${persists}`,
		node: process.version,
		platform: `${os.platform()} ${os.release()} ${os.arch()}`,
		cpus: os.cpus().length,
		label: readArg("--label", ""),
		results,
	};
	const out = readArg("--out", "");
	const text = `${JSON.stringify(report, null, 2)}\n`;
	if (out) fs.writeFileSync(path.resolve(out), text);
	process.stdout.write(text);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
