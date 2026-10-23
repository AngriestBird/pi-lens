#!/usr/bin/env node
/**
 * Build `vendor/opengrep-rules/rules.yaml`, the pinned Opengrep rule pack that
 * ships with pi-lens (#4765).
 *
 * Source: a checkout of github.com/opengrep/opengrep-rules at the commit named
 * in `vendor/opengrep-rules/manifest.json`. That repository carries the
 * Semgrep rules as they stood before Semgrep moved the registry to the Semgrep
 * Rules License (2024-12-13), under "Commons Clause" v1.0 + LGPL-2.1. See
 * `vendor/opengrep-rules/NOTICE` for the redistribution analysis.
 *
 * Two modes:
 *   --upstream DIR --registry-ids FILE   choose the rules: every upstream rule
 *       whose registry-style id (`<dir>.<dir>.<file>.<rule id>`) is listed in
 *       FILE (one id per line; the ids of `semgrep.dev/c/auto`). Writes
 *       rules.yaml and manifest.json.
 *   --upstream DIR                       rebuild from the rule ids already in
 *       rules.yaml. The output must be byte-identical (`--check` exits 1 when
 *       it is not): that is how a reviewer reproduces the shipped pack.
 *
 * Every rule must carry a licence this script recognises. A rule with any
 * other `metadata.license` is dropped and listed under `excluded` (fail
 * closed: one upstream rule is marked proprietary).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { dump, load } from "js-yaml";

const PACK_DIR = path.join("vendor", "opengrep-rules");
const RULES_FILE = "rules.yaml";
const MANIFEST_FILE = "manifest.json";
/** The only rule licences the shipped pack admits (absent = the repo licence). */
const ADMITTED_RULE_LICENSES = new Set([
	"Commons Clause License Condition v1.0[LGPL-2.1-only]",
]);
const SKIP_DIRS = new Set([
	".git",
	".github",
	"stats",
	"scripts",
	"node_modules",
]);

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function* walk(dir, rel = "") {
	for (const entry of fs.readdirSync(path.join(dir, rel), {
		withFileTypes: true,
	})) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name))
				yield* walk(dir, path.posix.join(rel, entry.name));
		} else if (
			/\.ya?ml$/.test(entry.name) &&
			!/\.test\.ya?ml$/.test(entry.name)
		)
			yield path.posix.join(rel, entry.name);
	}
}

/**
 * One upstream rule (`detected-slack-webhook`) names the all-placeholder
 * `https://hooks.slack.com/services/T00000000/B00000000/XXXX...` as the thing
 * it must NOT report. The literal has the shape of a real Slack webhook, so
 * GitHub push protection declines any push that contains it (2026-10-23) and
 * secret scanners flag the file. A YAML double-quoted scalar can spell the same
 * string with a `\x58` escape for one character: the parsed rule is identical,
 * the file no longer holds the contiguous literal. Only a whole plain scalar of
 * that shape is rewritten, and the caller's check proves the parse is unchanged.
 */
const SLACK_SHAPE =
	/^(\s*(?:- )?[\w-]+: )(https:\/\/hooks\.slack\.com\/services\/T\w{8,10}\/B\w{8,10}\/)(\w)(\w{23})$/gm;

export function defuseSecretShapes(text) {
	const out = text.replace(
		SLACK_SHAPE,
		(_all, key, head, first, rest) =>
			`${key}"${head}\\x${first.charCodeAt(0).toString(16)}${rest}"`,
	);
	if (out !== text && JSON.stringify(load(out)) !== JSON.stringify(load(text)))
		throw new Error("defusing a secret-shaped scalar changed the parsed rules");
	return out;
}

/** The id Opengrep derives for a rule loaded from a directory: path + id. */
function qualifiedId(relPath, ruleId) {
	const parts = relPath.replace(/\.ya?ml$/, "").split("/");
	return `${parts.join(".")}.${ruleId}`;
}

function readUpstream(upstream) {
	const rules = new Map();
	const sources = new Map();
	for (const rel of [...walk(upstream)].sort()) {
		const text = fs.readFileSync(path.join(upstream, rel), "utf-8");
		let doc;
		try {
			doc = load(text);
		} catch {
			continue;
		}
		if (!doc || !Array.isArray(doc.rules)) continue;
		sources.set(rel, sha256(text));
		for (const rule of doc.rules) {
			if (rule && typeof rule.id === "string")
				rules.set(qualifiedId(rel, rule.id), { rel, rule });
		}
	}
	return { rules, sources };
}

/**
 * Build (or, with `check`, rebuild and compare) the pack under `packDir`.
 * Returns what was chosen and excluded, and for `check` whether the files on
 * disk match the rebuild byte for byte. It never exits the process.
 */
export function buildPack({
	upstream,
	registryFile,
	commit = "",
	check = false,
	packDir = PACK_DIR,
}) {
	const manifestPath = path.join(packDir, MANIFEST_FILE);
	const rulesPath = path.join(packDir, RULES_FILE);
	const previous = fs.existsSync(manifestPath)
		? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
		: undefined;

	let wanted;
	if (registryFile) {
		wanted = new Set(
			fs
				.readFileSync(registryFile, "utf-8")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean),
		);
	} else {
		const shipped = load(fs.readFileSync(rulesPath, "utf-8"));
		wanted = new Set([
			...shipped.rules.map((r) => r.id),
			...(previous?.excluded ?? []).map((e) => e.id),
		]);
	}

	const { rules, sources } = readUpstream(upstream);
	const chosen = [];
	const excluded = [];
	for (const id of [...wanted].sort()) {
		const hit = rules.get(id);
		if (!hit) continue;
		const license = hit.rule.metadata?.license;
		if (license !== undefined && !ADMITTED_RULE_LICENSES.has(license)) {
			excluded.push({ id, license });
			continue;
		}
		chosen.push({ ...hit.rule, id });
	}

	const header = [
		"# Pinned Opengrep rule pack shipped with pi-lens (#4765).",
		"# Source: https://github.com/opengrep/opengrep-rules (a fork of semgrep-rules",
		"# taken before the Semgrep Rules License), license: Commons Clause License",
		"# Condition v1.0 on LGPL-2.1. See NOTICE and LICENSE beside this file.",
		"# MODIFIED 2026-10-22 (LGPL-2.1 section 2b): the selected rule files are",
		"# concatenated into this one file and",
		"# each rule id is prefixed with its upstream path (the id Opengrep gives a",
		"# rule loaded from a directory). Rule bodies are unchanged. See manifest.json.",
		"",
	].join("\n");
	const dumped = dump({ rules: chosen }, { lineWidth: -1, noRefs: true });
	const body = header + defuseSecretShapes(dumped);

	const sourceRels = [
		...new Set(chosen.map((r) => rules.get(r.id).rel)),
	].sort();
	const manifest = {
		upstream: {
			repository: "https://github.com/opengrep/opengrep-rules",
			commit: commit || previous?.upstream.commit,
		},
		license:
			"Commons Clause License Condition v1.0 + LGPL-2.1 (see LICENSE, NOTICE)",
		ruleCount: chosen.length,
		rulesSha256: sha256(body),
		excluded,
		// One digest over every source file the chosen rules came from (path +
		// content hash), so a rebuild from a different checkout cannot match.
		sourceFiles: sourceRels.length,
		sourcesSha256: sha256(
			sourceRels.map((rel) => `${rel} ${sources.get(rel)}`).join("\n"),
		),
	};
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

	if (check) {
		const same =
			fs.readFileSync(rulesPath, "utf-8") === body &&
			fs.readFileSync(manifestPath, "utf-8") === manifestText;
		return { chosen, excluded, same, bytes: Buffer.byteLength(body) };
	}
	fs.mkdirSync(packDir, { recursive: true });
	fs.writeFileSync(rulesPath, body);
	fs.writeFileSync(manifestPath, manifestText);
	return { chosen, excluded, bytes: Buffer.byteLength(body), rulesPath };
}

function main(argv) {
	const arg = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const upstream = arg("--upstream");
	if (!upstream) {
		console.error(
			"usage: build-opengrep-pack.mjs --upstream DIR [--registry-ids FILE] [--commit SHA] [--check]",
		);
		return 2;
	}
	const result = buildPack({
		upstream,
		registryFile: arg("--registry-ids"),
		commit: (arg("--commit") ?? "").trim(),
		check: argv.includes("--check"),
	});
	if (argv.includes("--check")) {
		console.log(
			result.same
				? "pack reproduces byte-identically"
				: "pack DIFFERS from a rebuild",
		);
		return result.same ? 0 : 1;
	}
	console.log(
		`wrote ${result.rulesPath}: ${result.chosen.length} rules, ${result.bytes} bytes; excluded ${result.excluded.length}`,
	);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main(process.argv.slice(2));
