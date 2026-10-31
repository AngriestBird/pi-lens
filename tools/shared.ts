/**
 * Shared constants and helpers for tool definitions
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	isAtOrAboveHomeDir,
	realpathOrResolve,
	resolveHostToolPath,
} from "../clients/path-utils.js";

/**
 * Resolve the `paths` argument of an ast-grep tool against the session cwd.
 *
 * The ast-grep CLI runs from a pi-lens-owned tools directory when its npx
 * fallback wins (#4193), so a relative target would otherwise resolve under
 * that directory and silently match nothing. Every ast-grep tool resolves here
 * before it dispatches, through the same host-path seam the read/edit/write
 * tools use (so `~`, `@` and unicode-space spellings behave identically); the
 * defaulted (no `paths`) case resolves the cwd itself, so the child always
 * receives an absolute target (#4233 V3-HIGH-01).
 *
 * #4577 R2-2: with no `paths` the target is the session cwd — a path pi-lens
 * generated, not one a model typed. An internally generated path gets no host
 * resolver stage: running the cwd through those stages folded its bytes (a cwd
 * holding U+00A0 became the sibling `proj x`, which does not exist, and the
 * child then failed with `No such file or directory`). It only needs to be
 * absolute.
 */
export function resolveAstGrepPaths(
	paths: readonly string[] | undefined,
	cwd: string | undefined,
): string[] {
	const base = cwd || ".";
	if (!paths?.length) return [path.resolve(base)];
	return paths.map((p) => resolveHostToolPath(p, base));
}

/**
 * The refusal a defaulted-target ast-grep tool returns when the session cwd
 * resolves at or above `$HOME`, or `undefined` when the call may proceed.
 *
 * #747/#250 guarded `ast_grep_search` only, with an inline copy; #5039 found
 * the mutating `ast_grep_replace` had no guard at all, so the same cwd served a
 * dry-run preview and an apply over the whole home tree. One seam now decides
 * it for both, and the inline copy is gone (net-count rule). Only the
 * DEFAULTED case is guarded: explicit `paths` are exactly what the caller
 * asked to touch and are never second-guessed. Both sides compare by real path
 * (#4911), so a cwd or a `$HOME` spelled through a link is refused too.
 *
 * `reason` is the terse code the tool log records as `errorRaw`; `text` is what
 * the model reads.
 */
export function defaultedCwdHomeRefusal(
	paths: readonly string[] | undefined,
	cwd: string | undefined,
): { reason: string; text: string } | undefined {
	if (paths?.length) return undefined;
	const spelling = cwd || ".";
	if (
		!isAtOrAboveHomeDir(
			realpathOrResolve(spelling),
			realpathOrResolve(os.homedir()),
		)
	)
		return undefined;
	return {
		reason: "defaulted cwd resolves at or above home directory",
		text: `Refused: no \`paths\` given and the working directory (${spelling}) resolves at or above the home directory — this would reach every unrelated tree under your home. Pass explicit \`paths\`, or run from a project directory.`,
	};
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
