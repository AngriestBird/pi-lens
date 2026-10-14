/**
 * Vitest globalSetup: fetch every missing tree-sitter grammar wasm ONCE, in
 * parallel, before any worker process spawns.
 *
 * `clients/tree-sitter-client.ts`'s `ensureGrammar()` de-duplicates a fetch only
 * WITHIN one process. Vitest runs worker PROCESSES in parallel, each with its own
 * singleton, so a grammar missing from disk would be fetched by every worker
 * that needs it, at the same moment, from the same CDN URL. Fetching here, once,
 * before any worker exists, removes that race.
 *
 * The set is `GRAMMARS` from `scripts/download-grammars.ts` (the download list),
 * not a hand list. Earlier revisions prewarmed only `CORE` and left the long tail
 * to a lazy fetch inside the test. That was measured to cost a 5 s test timeout:
 * under a cold cache with a stalled CDN, 13 default-project files went red with
 * about 42 timed-out tests (#4342). Prewarming the full set moves that failure to
 * one error here, naming the grammar.
 *
 * Measured with a bundled timing harness calling `setup()` directly, Linux, network up, 3 runs each
 * (cold = `grammars/` absent; warm = every file present):
 *   CORE only (12 files, before):  cold 1039 / 908 / 1442 ms;  warm 0.2 / 0.2 / 0.2 ms
 *   GRAMMARS  (26 files, after):   cold 874 / 438 / 457 ms;  warm 0.5 / 0.5 / 0.6 ms
 * The warm path is one existence check per grammar, so it stays cheap on every run.
 *
 * Each fetch is bounded by PREFETCH_TIMEOUT_MS. A stall or a failure throws one
 * error that names every grammar it could not fetch, so the run stops at setup
 * rather than degrading tests silently or timing them out one by one. The cost is
 * that an offline cold cache now refuses to start the suite; a warm cache, which
 * `npm run prepare` and any earlier run leave behind, is unaffected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadGrammar } from "../../clients/grammar-source.js";
import { GRAMMARS } from "../../scripts/download-grammars.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const grammarsDir = path.join(repoRoot, "grammars");

/**
 * Per-grammar bound on the prefetch. A healthy wasm lands well inside it; a
 * stalled response fails the run here instead of hanging it (#4342).
 */
export const PREFETCH_TIMEOUT_MS = 30_000;

type FetchOutcome = "ok" | "timeout" | "download failed";

async function fetchBounded(filename: string): Promise<FetchOutcome> {
	let timer: NodeJS.Timeout | undefined;
	const stalled = new Promise<FetchOutcome>((resolve) => {
		timer = setTimeout(() => resolve("timeout"), PREFETCH_TIMEOUT_MS);
	});
	const landed = downloadGrammar(grammarsDir, filename).then(
		(ok): FetchOutcome => (ok ? "ok" : "download failed"),
	);
	try {
		return await Promise.race([landed, stalled]);
	} finally {
		clearTimeout(timer);
	}
}

export default async function setup(): Promise<void> {
	const missing = GRAMMARS.filter(
		(filename) => !fs.existsSync(path.join(grammarsDir, filename)),
	);
	if (missing.length === 0) return;

	const started = performance.now();
	console.error(
		`[pi-lens test setup] pre-fetching ${missing.length} missing tree-sitter grammar(s) once, in parallel, before test workers spawn: ${missing.join(", ")}`,
	);
	const outcomes = await Promise.all(
		missing.map(async (filename) => ({
			filename,
			outcome: await fetchBounded(filename),
		})),
	);
	const failed = outcomes.filter(({ outcome }) => outcome !== "ok");
	if (failed.length > 0) {
		const named = failed
			.map(({ filename, outcome }) => `${filename} (${outcome})`)
			.join(", ");
		throw new Error(
			`[pi-lens test setup] could not pre-fetch ${failed.length} of ${missing.length} tree-sitter grammar(s): ${named}. Each fetch is bounded to ${PREFETCH_TIMEOUT_MS} ms. Check the network or the CDN, or place the files in ${grammarsDir}. See #4342.`,
		);
	}
	console.error(
		`[pi-lens test setup] pre-fetched ${missing.length} grammar(s) in ${Math.round(performance.now() - started)} ms`,
	);
}
