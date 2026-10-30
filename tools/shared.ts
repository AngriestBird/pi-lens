/**
 * Shared constants and helpers for tool definitions
 */

import * as path from "node:path";
import { resolveHostToolPath } from "../clients/path-utils.js";

/**
 * The `paths` cap every tool shares (#5041). Every entry becomes one walk,
 * batch slot or glob probe, so the list needs one bound; before #5041 each
 * tool carried its own (200 for ast-grep search, 100 for lens_diagnostics and
 * ast_grep_outline, none for ast_grep_replace and symbol_search). The shared
 * value is the smallest of them, so no tool admits a list the folded LSP probe
 * (`MAX_BATCH_FILES`) would refuse.
 */
export const MAX_PATHS_ENTRIES = 100;

/** The canonical single-file parameter (#5041), in precedence order. */
export const FILE_PATH_KEYS = ["path", "file", "filePath"] as const;

export interface FilePathRead {
	/** The caller's spelling, unresolved. "" when no spelling was sent. */
	path: string;
	/** Which spelling it came from, for messages. */
	key?: (typeof FILE_PATH_KEYS)[number];
	/** Set when the argument must be refused. */
	refusal?: string;
}

/**
 * Read the ONE single-file parameter (#5041): `path` is canonical, `file` and
 * `filePath` stay accepted so no caller breaks (#2418).
 *
 * Admitted: no spelling (the caller owns its own "required" message), one
 * spelling, or several spellings that name the same file. Refused, fail
 * closed: a non-string value, a blank value, or two spellings that name
 * different files — each would otherwise make this reader guess which file the
 * caller meant, and the tool would answer for a file the caller never named.
 */
export function readFilePath(
	params: Readonly<Record<string, unknown>>,
): FilePathRead {
	const sent: { key: (typeof FILE_PATH_KEYS)[number]; value: string }[] = [];
	for (const key of FILE_PATH_KEYS) {
		const raw = params[key];
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== "string")
			return { path: "", key, refusal: `\`${key}\` must be a string path` };
		if (!raw.trim())
			return { path: "", key, refusal: `\`${key}\` is blank — name a file` };
		sent.push({ key, value: raw });
	}
	const first = sent[0];
	if (!first) return { path: "" };
	if (new Set(sent.map((entry) => entry.value)).size > 1) {
		return {
			path: "",
			refusal: `${sent.map((entry) => `\`${entry.key}\`: ${entry.value}`).join(", ")} name different files — send one spelling`,
		};
	}
	return { path: first.value, key: first.key };
}

export interface PathsRead {
	/** Host-resolved entries. Empty when the caller sent no `paths`. */
	entries: string[];
	/** Set when the argument must be refused. */
	refusal?: string;
}

function describeEntryType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

/**
 * The one reader of a `paths` argument (#5041). Every tool calls it, so one
 * entry rule holds across the surface: a non-string, a blank entry, an empty
 * list and a list over {@link MAX_PATHS_ENTRIES} are refused, and every
 * admitted entry is resolved through the same host-path seam the read, edit,
 * write and ast-grep tools use (so `~`, `@` and unicode-space spellings behave
 * identically). A glob entry (`src/**\/*.ts`) resolves as a path-shaped glob, so
 * the glob matching a consumer does afterwards still sees a full pattern.
 *
 * Before #5041 each tool had its own copy: search refused a non-string entry,
 * outline and lens_diagnostics dropped it, replace never looked. The silenced
 * shapes made a wrong call read as "no match".
 *
 * `absent` is the caller's own default for an omitted `paths`: "cwd" gives the
 * session cwd, which is what an ast-grep child needs to receive an absolute
 * target (#4233 V3-HIGH-01) and is the only entry that gets NO host resolver
 * stage (#4577 R2-2: a generated cwd holding U+00A0 was folded to a sibling
 * directory that does not exist); "none" leaves the list empty so the caller's
 * own "no restriction" path runs.
 */
export function readPathsArgument(
	raw: unknown,
	options: { cwd: string | undefined; absent?: "none" | "cwd" },
): PathsRead {
	const base = options.cwd || ".";
	const absent = options.absent ?? "none";
	if (raw === undefined || raw === null) {
		return { entries: absent === "cwd" ? [path.resolve(base)] : [] };
	}
	if (!Array.isArray(raw))
		return { entries: [], refusal: "paths must be an array of strings" };
	if (raw.length === 0)
		return {
			entries: [],
			refusal:
				"paths is empty: it names no entry, so the call would widen to the tool's default. Omit `paths` to use that default.",
		};
	if (raw.length > MAX_PATHS_ENTRIES)
		return {
			entries: [],
			refusal: `paths must contain at most ${MAX_PATHS_ENTRIES} string entries, got ${raw.length}`,
		};
	const entries: string[] = [];
	for (const [index, entry] of raw.entries()) {
		if (typeof entry !== "string")
			return {
				entries: [],
				refusal: `paths entry ${index + 1} must be a string, not ${describeEntryType(entry)}`,
			};
		if (!entry.trim())
			return { entries: [], refusal: `paths entry ${index + 1} is blank` };
		entries.push(resolveHostToolPath(entry, base));
	}
	return { entries };
}

export const LANGUAGES = [
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"swift",
	"tsx",
	"typescript",
	"yaml",
] as const;

/**
 * #4687: the three ast-grep schemas carry `lang` as a plain string (the 24-id
 * enum cost ~240 bytes per tool per request), so this is the one check that
 * keeps an unknown id from reaching the CLI. It names every valid id, which is
 * what the enum used to tell the model.
 *
 * It reads the raw argument, not a typed one: the MCP route hands `execute`
 * the client's JSON without schema validation, so `lang` can be any JSON value
 * (#4723 F4). It admits only a string that is a known id, once one pair of
 * wrapping double quotes is stripped; absent or blank is "required" (or absent
 * when optional), and every other value is refused with `refusal`. An optional
 * `null` is absent, as at master, where the client built `--lang` only when the
 * value was truthy (#4723 N2); a required `null` is refused. `lang` is the
 * normalized id, or "" when there is none (blank included, so a blank optional
 * `lang` never reaches the CLI as `--lang " "`).
 */
export function readAstGrepLang(
	rawArg: unknown,
	required: boolean,
): { lang: string; refusal?: string } {
	const raw = rawArg === null && !required ? undefined : rawArg;
	const lang = typeof raw === "string" ? raw.replace(/^"|"$/g, "") : "";
	if (
		typeof raw === "string" &&
		(LANGUAGES as readonly string[]).includes(lang)
	)
		return { lang };
	const validIds = `valid ids: ${LANGUAGES.join(", ")}`;
	if (raw !== undefined && typeof raw !== "string")
		return { lang, refusal: `lang must be a string; ${validIds}` };
	if (!lang.trim())
		return required ? { lang: "", refusal: "lang is required" } : { lang: "" };
	return { lang, refusal: `unknown lang "${lang}"; ${validIds}` };
}
