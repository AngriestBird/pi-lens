// Dependency-free coverage-map seam for #3802 rule 2.
//
// `scripts/check-pr-body.mjs` runs in the `PR body (advisory)` job, which
// checks out the repo and runs plain Node with NO `npm install`. Everything
// this module imports must therefore come from `node:` only -- `minimatch` and
// the other glob packages are unavailable on that lane.
//
// A PR that changes a file the checked-in `formal/coverage-map.json` maps to a
// model family must also change a `.tla`/`.cfg` under that family's
// `formal/<family>/`, or carry a `TLA+ unaffected: <family> — <reason>` line in
// the PR body. `unmodelled` entries are advisory and never fail. #3802.
import fs from "node:fs";
import path from "node:path";

/** Repo-relative location of the checked-in coverage map. */
const COVERAGE_MAP_PATH = "formal/coverage-map.json";

/** Map value for a lifecycle seam no family models yet. */
const UNMODELLED = "unmodelled";

/** A coverage file whose change proves the family's model moved with the code. */
const MODEL_FILE = /\.(?:tla|cfg)$/;

function toPosix(value) {
	return String(value).replaceAll("\\", "/");
}

/**
 * Translate the glob forms the map actually uses -- `*` (one path segment),
 * `**` (any number of segments), `?` (one non-separator character) -- into an
 * anchored RegExp over a repo-relative posix path. Character classes and brace
 * alternation are intentionally NOT expanded: the map carries none, and a
 * hand-rolled brace parser is more likely to be wrong than a future map row is
 * to use one. A literal `[`/`{` still matches itself.
 */
export function globToRegExp(glob) {
	const source = String(glob);
	let pattern = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "*") {
			if (source[index + 1] === "*") {
				index += 1;
				if (source[index + 1] === "/") {
					index += 1;
					pattern += "(?:[^/]+/)*";
				} else {
					pattern += ".*";
				}
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else if (/[.+^$()|\\[\]{}]/.test(char)) {
			pattern += `\\${char}`;
		} else {
			pattern += char;
		}
	}
	return new RegExp(`^${pattern}$`);
}

/** True when `filePath` (repo-relative, posix or not) matches `glob`. */
export function matchGlob(glob, filePath) {
	return globToRegExp(glob).test(toPosix(filePath));
}

/** Read and parse the checked-in map. Throws when it is absent or malformed. */
export function loadCoverageMap(rootDir = process.cwd()) {
	const mapPath = path.isAbsolute(COVERAGE_MAP_PATH)
		? COVERAGE_MAP_PATH
		: path.join(rootDir, COVERAGE_MAP_PATH);
	let raw;
	try {
		raw = fs.readFileSync(mapPath, "utf8");
	} catch (error) {
		throw new Error(
			`cannot read ${COVERAGE_MAP_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`cannot parse ${COVERAGE_MAP_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Every repo-relative path a unified diff touches, from each `diff --git`
 * header. Both the pre-image and post-image path are kept, so a rename away
 * from a mapped file still counts as touching it.
 */
export function parseChangedFiles(diff = "") {
	const paths = new Set();
	for (const line of String(diff).split(/\r?\n/)) {
		const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (!header) continue;
		for (const side of [header[1], header[2]]) paths.add(toPosix(side));
	}
	return [...paths];
}

/** Directory a glob is rooted at, or `null` when it is a literal path. */
function globStaticDir(glob) {
	const parts = toPosix(glob).split("/");
	const staticParts = [];
	for (const part of parts) {
		if (/[*?]/.test(part)) return staticParts.join("/");
		staticParts.push(part);
	}
	return null;
}

function walkFiles(rootDir, relativeDir, found) {
	if (found.length > 50_000) return;
	const absolute = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
	let entries;
	try {
		entries = fs.readdirSync(absolute, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walkFiles(rootDir, relative, found);
		else found.push(relative);
	}
}

/** Whether `glob` matches at least one file under `rootDir`. */
function globMatchesAnyFile(glob, rootDir = process.cwd()) {
	const staticDir = globStaticDir(glob);
	if (staticDir === null) {
		return fs.existsSync(path.join(rootDir, toPosix(glob)));
	}
	const found = [];
	walkFiles(rootDir, staticDir, found);
	return found.some((file) => matchGlob(glob, file));
}

/**
 * Structural validation of the map itself: every glob matches at least one
 * file, every named family exists under `formal/` with at least one
 * `.tla`/`.cfg`, and every value is `unmodelled` or a known-family array.
 * Returns error strings (empty when the map is sound).
 */
export function validateCoverageMap(map, rootDir = process.cwd()) {
	const errors = [];
	if (!map || typeof map !== "object") return ["coverage map is not an object"];
	const families = Array.isArray(map.families) ? map.families : [];
	if (!families.length) errors.push("coverage map has no families");
	for (const family of families) {
		let entries = [];
		try {
			entries = fs.readdirSync(path.join(rootDir, "formal", family));
		} catch {
			errors.push(`formal/${family}/ is missing`);
			continue;
		}
		if (!entries.some((entry) => MODEL_FILE.test(entry)))
			errors.push(`formal/${family}/ has no .tla/.cfg`);
	}
	const known = new Set(families);
	for (const [glob, value] of Object.entries(map.map ?? {})) {
		if (!globMatchesAnyFile(glob, rootDir))
			errors.push(`glob ${glob} matches no file`);
		if (value === UNMODELLED) continue;
		if (!Array.isArray(value) || !value.length) {
			errors.push(
				`map.${glob} must be "${UNMODELLED}" or a non-empty family array`,
			);
			continue;
		}
		for (const family of value)
			if (!known.has(family))
				errors.push(`map.${glob} names unknown family ${family}`);
	}
	for (const glob of Object.keys(map.excluded ?? {})) {
		if (!globMatchesAnyFile(glob, rootDir))
			errors.push(`excluded glob ${glob} matches no file`);
	}
	return errors;
}

function bodyNamesFamily(lines, family) {
	const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`^\\s*(?:[-*+]\\s+)?\\**TLA\\+ unaffected:\\s*${escaped}\\s*[—–-]\\s*\\S`,
	);
	return lines.some((line) => pattern.test(line));
}

/**
 * The rule itself. Given the parsed map, the diff's changed paths, and the PR
 * body, return `{ errors, advisories }`. Errors are the unmet requirements;
 * advisories keep `unmodelled` seams visible without gating.
 */
export function evaluateTlaCoverage({ map, changedFiles = [], body = "" }) {
	const changed = changedFiles.map(toPosix).sort();
	const formalChanged = changed.filter((file) => file.startsWith("formal/"));
	const lines = String(body ?? "").split(/\r?\n/);
	const errors = new Set();
	const advisories = new Set();
	const families = new Set(Array.isArray(map?.families) ? map.families : []);
	for (const [glob, value] of Object.entries(map?.map ?? {})) {
		const matched = changed.filter((file) => matchGlob(glob, file));
		if (!matched.length) continue;
		if (value === UNMODELLED) {
			for (const file of matched)
				advisories.add(
					`TLA+ unmodelled: ${file} has no formal family yet; leave the gap visible in ${COVERAGE_MAP_PATH}.`,
				);
			continue;
		}
		const list = Array.isArray(value) ? value : [];
		if (!list.length) {
			errors.add(
				`coverage map row ${glob} is neither "${UNMODELLED}" nor a family list`,
			);
			continue;
		}
		for (const family of list) {
			if (!families.has(family)) {
				errors.add(`coverage map row ${glob} names unknown family ${family}`);
				continue;
			}
			const modelMoved = formalChanged.some(
				(file) => file.startsWith(`formal/${family}/`) && MODEL_FILE.test(file),
			);
			if (modelMoved || bodyNamesFamily(lines, family)) continue;
			errors.add(
				`Changed file ${matched[0]} is modelled by formal/${family}/: change a .tla/.cfg there, or add "TLA+ unaffected: ${family} \u2014 <reason>" to the PR body.`,
			);
		}
	}
	return { errors: [...errors].sort(), advisories: [...advisories].sort() };
}
