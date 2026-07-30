#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { FactStore } from "../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	flushReviewGraphPersist,
	getLastReviewGraphBuildAttempt,
} from "../clients/review-graph/builder.js";

function cwdArg(): string {
	const equals = process.argv.find((arg) => arg.startsWith("--cwd="));
	if (equals) return equals.slice("--cwd=".length);
	const index = process.argv.indexOf("--cwd");
	if (index >= 0) {
		const value = process.argv[index + 1];
		if (!value || value.startsWith("-")) throw new Error("--cwd requires a directory");
		return value;
	}
	return process.cwd();
}

function fail(reason: string): never {
	process.stderr.write(`pi-lens build-graph failed: ${reason}\n`);
	process.exit(1);
}

async function buildGraph(): Promise<void> {
	const cwd = path.resolve(cwdArg());
	let stat: fs.Stats;
	try {
		stat = fs.statSync(cwd);
	} catch (err) {
		fail(`cannot access cwd ${cwd}: ${(err as Error).message}`);
	}
	if (!stat.isDirectory()) fail(`cwd is not a directory: ${cwd}`);

	const startedAt = Date.now();
	const graph = await buildOrUpdateGraph(cwd, [], new FactStore());
	const attempt = getLastReviewGraphBuildAttempt(cwd);
	if (!attempt || attempt.outcome !== "succeeded" || attempt.reason) {
		fail(attempt?.reason ?? attempt?.outcome ?? "build produced no result");
	}

	const persisted = flushReviewGraphPersist(cwd);
	if (!persisted.ok) fail(persisted.reason ?? "graph snapshot was not persisted");

	const durationMs = Date.now() - startedAt;
	process.stdout.write(
		`pi-lens build-graph: files=${graph.fileNodes.size} nodes=${graph.nodes.size} ` +
			`edges=${graph.edges.length} elements=${persisted.elements} ` +
			`jsonBytes=${persisted.bytes} durationMs=${durationMs}\n`,
	);
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command !== "build-graph") {
		fail("usage: pi-lens build-graph [--cwd <dir>]");
	}
	await buildGraph();
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
