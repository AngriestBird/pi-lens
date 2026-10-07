// Provenance of tests/fixtures/review-graph-persist/released-ca7e89066 (#3913).
// Builds the corpus project through the built `clients/review-graph/builder.js`
// of the tree at <root> and copies the decompressed bodies the persist worker
// staged, one per site, to <out>. The committed corpus came from ca7e89066 (the
// worker structured-cloned the graph, then stringified it). The temp root and
// `builtAt` are masked, since both vary per run. Run it with TMPDIR outside any
// git checkout: a git repo changes `ignoredIdsHash`, and the test's temp dir
// is not one.
//
//   PI_LENS_HOME=$H/lens PILENS_DATA_DIR=$H/data \
//     node generate-released-writer.mjs <root> <out>
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import {
	CORPUS_CHECKPOINT_EVERY_FILES,
	CORPUS_FILES,
	CORPUS_MTIME_SECONDS,
} from "./corpus-project.mjs";

const treeRoot = process.argv[2];
const out = process.argv[3];
const builder = await import(
	pathToFileURL(path.join(treeRoot, "clients/review-graph/builder.js")).href
);
const { FactStore } = await import(
	pathToFileURL(path.join(treeRoot, "clients/dispatch/fact-store.js")).href
);

const project = fs.realpathSync(
	fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rg-corpus-")),
);
for (const [relative, content] of Object.entries(CORPUS_FILES)) {
	const file = path.join(project, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.utimesSync(file, CORPUS_MTIME_SECONDS, CORPUS_MTIME_SECONDS);
}

// Copy each staged body when the worker reports it, before the main thread
// promotes (and later deletes) the stage file.
const staged = { persist: [], checkpoint: [] };
const realOn = Worker.prototype.on;
Worker.prototype.on = function on(event, listener) {
	if (event !== "message") return realOn.call(this, event, listener);
	return realOn.call(this, event, (result) => {
		const site = path.basename(result.stagePath).includes(".checkpoint.")
			? "checkpoint"
			: "persist";
		staged[site].push(
			gunzipSync(fs.readFileSync(result.stagePath)).toString("utf-8"),
		);
		listener(result);
	});
};

const mask = (body) =>
	body.replaceAll(project, "<root>").replace(/"builtAt":"[^"]*"/g, '"builtAt":"<masked>"');

process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = CORPUS_CHECKPOINT_EVERY_FILES;
process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
await builder.buildOrUpdateGraph(project, [], new FactStore());
for (let waited = 0; waited < 300 && staged.persist.length === 0; waited++) {
	await new Promise((resolve) => setTimeout(resolve, 20));
}
await builder.waitForReviewGraphPersistsForTests();
// The worker serves both checkpoint strides concurrently, so their results
// arrive in either order; keep the first stride (two files folded in).
const firstStride = staged.checkpoint.find(
	(body) => JSON.parse(body).processedFiles.length === 2,
);
if (staged.persist.length !== 1 || firstStride === undefined) {
	throw new Error(
		`expected one persist stage and a first-stride checkpoint, got ${staged.persist.length} and ${staged.checkpoint.length}`,
	);
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "persist-body.json"), mask(staged.persist[0]));
fs.writeFileSync(path.join(out, "checkpoint-body.json"), mask(firstStride));
process.exit(0);
