/**
 * Call-shaped scanner for `logAvailabilityDecision` emission sites (#2131).
 *
 * Dogfood pass 5 on #2131 measured the gap this pins: over 8.76h of baseline,
 * 33 of 75 `cause: "ok"` availability decisions (44%) carried no
 * `classifiedBy`, while every `not-found` and `fast-path` decision carried it
 * 100%. The shape was mechanical — the failure arm sets `classifiedBy`, the
 * success (`cause: "ok"`) arm next to it does not.
 *
 * Same call-shaped-scan discipline as `bounded-telemetry-scan.ts` (#1743): a
 * bare `cause: "ok"` grep would also match a comment or an unrelated object
 * literal, so this finds CALLS to `logAvailabilityDecision`, balances their
 * parentheses, and reads `cause` and `classifiedBy` out of the call's own
 * argument text.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { stripSource } from "./sweep-kit.js";

export interface AvailabilityDecisionSite {
	/** Repo-relative path, forward slashes, so findings read the same on any OS. */
	file: string;
	line: number;
	/** True when the call's `cause` argument is the literal `"ok"`. */
	causeOk: boolean;
	/** True when the call's own arguments set `classifiedBy`. */
	hasClassifiedBy: boolean;
}

/** Directories scanned. Compiled output and tests are not sources of truth. */
export const SCAN_ROOTS = ["clients"];

const CALLEE = "logAvailabilityDecision";

/** Collect every `logAvailabilityDecision` call site under `SCAN_ROOTS`. */
export function scanAvailabilityDecisionSites(
	repoRoot: string,
): AvailabilityDecisionSite[] {
	const sites: AvailabilityDecisionSite[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of listTypeScriptFiles(path.join(repoRoot, root))) {
			const relative = path.relative(repoRoot, file).split(path.sep).join("/");
			sites.push(...scanSource(fs.readFileSync(file, "utf8"), relative));
		}
	}
	return sites;
}

/** Exported for the sweep's own self-test: scan one source string. */
export function scanSource(raw: string, file: string): AvailabilityDecisionSite[] {
	// `strings: "keep"` (as in bounded-telemetry-scan.ts): the `cause`/
	// `classifiedBy` values this scanner reads ARE string literals, so blanking
	// string contents would blind it to the very thing it exists to check.
	const source = stripSource(raw, { strings: "keep" });
	const sites: AvailabilityDecisionSite[] = [];
	// `\b` alone would let `fakeLogAvailabilityDecision(` match; require the
	// callee to start at a non-identifier boundary on both sides, and require
	// it to be a bare call (not `foo.logAvailabilityDecision(`) so the
	// function's own declaration line reads no differently from a call — its
	// argument text never contains a `cause: "ok"` literal, so it never flags.
	const opener = new RegExp(`(?<![A-Za-z0-9_$.])${CALLEE}\\s*\\(`, "g");
	let match = opener.exec(source);
	while (match !== null) {
		const openIndex = source.indexOf("(", match.index);
		const argsText = readBalancedArgs(source, openIndex);
		sites.push({
			file,
			line: source.slice(0, match.index).split("\n").length,
			causeOk: /(?:^|[\s{,])cause\s*:\s*"ok"/.test(argsText),
			hasClassifiedBy: /(?:^|[\s{,])classifiedBy\s*:/.test(argsText),
		});
		match = opener.exec(source);
	}
	return sites.sort((a, b) => a.line - b.line);
}

/** Argument text between `(` at `openIndex` and its matching `)`. */
function readBalancedArgs(source: string, openIndex: number): string {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openIndex + 1, i);
		}
	}
	return source.slice(openIndex + 1);
}

function listTypeScriptFiles(target: string): string[] {
	const stat = fs.statSync(target);
	if (stat.isFile()) return target.endsWith(".ts") ? [target] : [];
	const found: string[] = [];
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "deps" || entry.name === "node_modules") continue;
			found.push(...listTypeScriptFiles(child));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			found.push(child);
		}
	}
	return found;
}
