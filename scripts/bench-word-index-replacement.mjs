#!/usr/bin/env node
/**
 * Relative attribution smoke check for the synchronous per-edit word-index
 * replacement seam (#2067).
 *
 * The workload deliberately makes the edited document appear in a shared
 * posting list. It is not a reproduction of the issue's 2.2M-posting corpus
 * and its latency is not a cross-machine performance claim. Run after build:
 *
 *   node scripts/bench-word-index-replacement.mjs
 *
 * The inspector profile is self-sample based. It reports the replacement
 * latency distribution and the share attributed to normalizeEphemeralMapKey,
 * so the acceptance numbers can be reproduced without a machine-specific
 * `--prof-process` installation.
 */
import * as inspector from "node:inspector";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wordIndexUrl = pathToFileURL(
	path.join(root, "clients", "word-index.js"),
).href;
const { buildWordIndex, updateWordIndexDocument } = await import(wordIndexUrl);

const corpusSize = 2600;
const lineCount = 1600;
const targetPath = "src/bench-target.ts";
const corpus = Array.from({ length: corpusSize }, (_, file) => ({
	path: file === 0 ? targetPath : `src/bench-${file}.ts`,
	content: Array.from(
		{ length: file === 0 ? lineCount : 8 },
		(_, line) => `export function sharedPostingHandler${line}() {}`,
	).join("\n"),
}));
const index = buildWordIndex(corpus);
const session = new inspector.Session();
session.connect();

function post(method, params = {}) {
	return new Promise((resolve, reject) => {
		session.post(method, params, (error, result) =>
			error ? reject(error) : resolve(result),
		);
	});
}

await post("Profiler.enable");
await post("Profiler.start");
const durations = [];
for (let edit = 0; edit < 300; edit += 1) {
	const content = `${corpus[0].content}\nexport const edit${edit} = sharedPostingHandler0;`;
	const started = performance.now();
	if (!updateWordIndexDocument(index, { path: targetPath, content })) {
		throw new Error("word-index replacement was not available");
	}
	durations.push(performance.now() - started);
}
const { profile } = await post("Profiler.stop");
session.disconnect();

const samples = profile.samples ?? [];
const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
const parents = new Map();
for (const node of nodes.values()) {
	for (const childId of node.children ?? []) parents.set(childId, node.id);
}
const selfSamples = samples.length;
const normalizerSamples = samples.filter((sample) => {
	let nodeId = sample;
	while (nodeId !== undefined) {
		const node = nodes.get(nodeId);
		if (!node) break;
		if (node.callFrame?.functionName === "normalizeEphemeralMapKey")
			return true;
		nodeId = parents.get(nodeId);
	}
	return false;
}).length;
const sorted = [...durations].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.floor((sorted.length - 1) * p)];
const mean =
	durations.reduce((sum, value) => sum + value, 0) / durations.length;

console.log(`corpus documents: ${corpusSize}`);
console.log(`target bytes: ${Buffer.byteLength(corpus[0].content, "utf8")}`);
console.log(`replacement mean: ${mean.toFixed(3)} ms`);
console.log(`replacement p50: ${percentile(0.5).toFixed(3)} ms`);
console.log(`replacement p95: ${percentile(0.95).toFixed(3)} ms`);
console.log(`replacement max: ${Math.max(...durations).toFixed(3)} ms`);
console.log(
	`normalizeEphemeralMapKey: ${((100 * normalizerSamples) / Math.max(1, selfSamples)).toFixed(3)}% of samples`,
);
console.log(`profile samples: ${selfSamples}`);
