/**
 * Which rule file pi-lens hands Opengrep when the repo carries none (#4765).
 *
 * Opengrep used to start with `--config auto`, which downloads about 1074
 * registry rules on every spawn: about 8 s online, no findings at all offline.
 * pi-lens now always passes a local file, in this order (the repo's own rule
 * file wins first, in `resolveOpengrepConfig`):
 *
 *   1. the CACHED pack: the registry pack a background refresh downloaded,
 *      validated and swapped in (`refreshOpengrepRulePack` in
 *      `installer/managed-tool-refresh.ts`);
 *   2. the SHIPPED pack: `vendor/opengrep-rules/rules.yaml`, a pinned snapshot
 *      of opengrep/opengrep-rules (see its NOTICE for the licence).
 *
 * Presence of the cached file IS its validity: the refresh writes it only by an
 * atomic rename of a file that parsed and passed `opengrep --validate`, and
 * leaves the previous file in place on every failure. A cached pack therefore
 * always supersedes the shipped one, which predates the registry's move to the
 * Semgrep Rules License (2024-12-13). The cached rules are the user's own copy
 * of the registry and are never redistributed.
 *
 * This module is a leaf (no installer, no spawn) because the config resolver and
 * the LSP spawn path both import it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";
import { resolvePackagePath } from "./package-root.js";

export type OpengrepPackSource = "cached" | "shipped";

/** The registry rule set `--config auto` resolved to; fetched by the refresh. */
export const OPENGREP_REGISTRY_PACK_URL = "https://semgrep.dev/c/auto";

/** The pack that ships in the npm package. */
export function shippedOpengrepPackPath(): string {
	return resolvePackagePath(
		import.meta.url,
		"vendor",
		"opengrep-rules",
		"rules.yaml",
	);
}

/** Where the refresh keeps the validated registry pack, next to nothing it deletes. */
export function cachedOpengrepPackPath(): string {
	return path.join(getGlobalPiLensDir(), "rules", "opengrep-registry.yaml");
}

/** The pack to pass as `--config` when the repo has no rule file. */
export function resolveOpengrepRulePack(): {
	path: string;
	source: OpengrepPackSource;
} {
	const cached = cachedOpengrepPackPath();
	try {
		if (fs.statSync(cached).size > 0) return { path: cached, source: "cached" };
	} catch {
		// none: no cached pack yet (ENOENT on a fresh or offline machine) is the
		// normal state; the shipped pack answers.
	}
	return { path: shippedOpengrepPackPath(), source: "shipped" };
}

/**
 * Opengrep's CLI prefixes the id of every rule loaded from a local file with
 * that file's directory (`/home/u/.pi-lens/rules/x.yaml` turns
 * `python.lang.eval` into `home.u..pi-lens.rules.python.lang.eval`; measured on
 * 1.30.0, absolute POSIX paths). The language server does not. A rule id that
 * names the install path varies per machine, so the CLI scan strips it for the
 * packs pi-lens owns and reports the registry-form id the server reports and
 * the `auto` set used to. An id without the prefix is returned unchanged.
 * Windows drive paths are unmeasured; a mismatch there leaves the id as
 * Opengrep wrote it.
 */
export function stripPackRuleIdPrefix(
	checkId: string,
	packPath: string,
): string {
	const prefix = `${path
		.dirname(packPath)
		.replace(/^[\\/]+/, "")
		.replace(/[\\/:]+/g, ".")}.`;
	return checkId.startsWith(prefix) ? checkId.slice(prefix.length) : checkId;
}
