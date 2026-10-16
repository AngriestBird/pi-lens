#!/usr/bin/env node
/**
 * #4514: the dedicated, non-continue-on-error step behind the nightly's
 * best-effort LSP producers (scripts/lib/assert-evaluated.mjs has the why and
 * the record shape).
 *
 *   node scripts/assert-evaluated.mjs --records <dir>
 *       tool-smoke job: each producer's `<dir>/<producer>.json` against its
 *       floor, and against the count in HEAD's committed doc where it has one.
 *   node scripts/assert-evaluated.mjs --docs
 *       tool-smoke-prs job: the regenerated docs in the working tree against
 *       HEAD's, before any refresh PR opens.
 *
 * Exit 0 when every record is ok, 1 when any is not, 2 on a usage error.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import {
	assertEvaluated,
	EVALUATED_PRODUCERS,
	missingRecord,
	readEvaluatedRecord,
} from "./lib/assert-evaluated.mjs";

/** HEAD's committed text of a doc, or null when HEAD has none (the test seam). */
export function gitHeadText(docPath) {
	try {
		return gitExecFileSync(["show", `HEAD:${docPath}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

function headCount(doc, headText) {
	const text = headText(doc.path);
	return text === null ? null : doc.count(text);
}

/** Records mode: one record per producer. */
export function checkRecords(dir, headText = gitHeadText) {
	return Object.entries(EVALUATED_PRODUCERS).map(([producer, spec]) => {
		const previous = spec.doc ? headCount(spec.doc, headText) : null;
		const evaluated = readEvaluatedRecord(dir, producer);
		if (evaluated === null)
			return missingRecord(producer, spec.floor, previous);
		return assertEvaluated({
			producer,
			evaluated,
			expectedAtLeast: spec.floor,
			previous,
		});
	});
}

/**
 * Docs mode: one record per committed doc the refresh PR would carry. A doc
 * the regeneration left byte-identical to HEAD carries nothing, so it is not
 * judged: a promotion-only night must not be held by a doc an earlier degraded
 * refresh already merged.
 */
export function checkDocs(root = ".", headText = gitHeadText) {
	return Object.entries(EVALUATED_PRODUCERS)
		.filter(([, spec]) => spec.doc)
		.map(([producer, { doc }]) => {
			const previous = headCount(doc, headText);
			let text = null;
			try {
				text = fs.readFileSync(path.resolve(root, doc.path), "utf8");
			} catch {
				// An absent doc reads as no record below.
			}
			if (text !== null && text === headText(doc.path)) return null;
			const evaluated = text === null ? null : doc.count(text);
			if (evaluated === null)
				return missingRecord(`${producer}:${doc.path}`, doc.floor, previous);
			return assertEvaluated({
				producer: `${producer}:${doc.path}`,
				evaluated,
				expectedAtLeast: doc.floor,
				previous,
			});
		})
		.filter((record) => record !== null);
}

export function main(argv) {
	const recordsAt = argv.indexOf("--records");
	const records =
		recordsAt >= 0 && argv[recordsAt + 1]
			? checkRecords(argv[recordsAt + 1])
			: argv.includes("--docs")
				? checkDocs()
				: null;
	if (!records) {
		console.error(
			"usage: assert-evaluated.mjs --records <dir> | --docs (exit 0 ok, 1 below a floor, 2 usage)",
		);
		return 2;
	}
	for (const r of records) console.log(JSON.stringify(r));
	const failed = records.filter((r) => !r.ok);
	for (const r of failed) {
		console.error(
			`::error title=nightly evaluated floor::${r.producer}: ${r.reason}`,
		);
		// The shape smoke-tools.mjs's report() prints for a failing row, so the
		// red-night tracking issue (notify-tool-smoke-red.mjs) lists it.
		console.log(
			`✗  ${r.producer}  evaluated floor  ${r.evaluated}  ${r.reason}`,
		);
	}
	if (process.env.GITHUB_STEP_SUMMARY) {
		const table = records.map(
			(r) =>
				`| ${r.producer} | ${r.evaluated} | ${r.floor} | ${r.prevEvaluated ?? "n/a"} | ${r.ok ? "ok" : r.reason} |`,
		);
		fs.appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`## Nightly evaluated floor\n\n| producer | evaluated | floor | at HEAD | verdict |\n|---|---|---|---|---|\n${table.join("\n")}\n`,
		);
	}
	return failed.length > 0 ? 1 : 0;
}

// Run only when executed directly: tests import checkRecords/checkDocs/main.
if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exit(main(process.argv.slice(2)));
}
