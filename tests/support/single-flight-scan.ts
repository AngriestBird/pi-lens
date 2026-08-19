/**
 * Ratchet scan for hand-rolled at-most-one-in-flight state — #1753.
 *
 * `clients/single-flight.ts` owns the four guards that the ten hand-rolled
 * copies kept getting wrong (#1690, #1674, #1687, #1722). A primitive nobody
 * reaches for is a primitive that decays, so this scan makes the NEXT copy
 * argue for itself: any new module-level or class-field declaration whose name
 * contains `inFlight` fails until it is either built on the primitive or listed
 * with a reason.
 *
 * It is a ratchet, not a migration. Everything the scan finds today is listed;
 * the list is the burn-down backlog, and each entry says why it is still there.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	clientSourceFiles,
	clientsRelative,
	stripCommentsAndStrings,
} from "./session-state-scan.js";

/** One `inFlight`-named declaration the scan found. */
export interface InFlightDeclaration {
	/** `clients/`-relative posix path. */
	file: string;
	/** The declared identifier. */
	symbol: string;
	/** 1-based line number in the original source. */
	line: number;
	/** `file:symbol` — the key exemptions are written against. */
	key: string;
}

/**
 * Declarations this scan can see, and the two it cannot.
 *
 * IN: module-level `const`/`let`/`var` at column 0, and class fields carrying an
 * accessibility or `readonly`/`static` modifier at any indent. Those are the
 * two places durable in-flight state actually lives.
 *
 * OUT, stated rather than papered over:
 *
 * 1. state closed over inside a factory function (`createChecker`'s
 *    `inFlightByCwd` in `runner-helpers.ts`) — indistinguishable from a plain
 *    function local by shape alone, and flagging every local named `inFlight`
 *    would make the ratchet noise rather than signal;
 * 2. in-flight state whose name does not contain `inFlight`
 *    (`refreshRepullRunning` in `lsp/client.ts` is exactly that, which is part
 *    of why #1687 went unnoticed).
 *
 * Both are FALSE NEGATIVES. The ratchet still catches the common case, which
 * is the copy someone writes by pattern-matching a sibling client.
 */
export const SCAN_HEURISTIC_LIMITS = [
	"closure-scoped state inside factory functions is not seen",
	"in-flight state not named /[iI]nFlight/ is not seen",
] as const;

const DECLARATION =
	/^(?:(?:export\s+)?(?:const|let|var)\s+|[\t ]+(?:(?:private|protected|public|static|readonly|abstract)\s+)+)([\w$]*[iI]nFlight[\w$]*)\s*[:=]/gm;

/** Find every `inFlight`-named module-state declaration in one source text. */
export function findInFlightDeclarations(
	file: string,
	source: string,
): InFlightDeclaration[] {
	// Comments and strings are blanked first, length-preserving, so a doc
	// comment that merely NAMES a field cannot be read as a declaration of it —
	// the same false-positive mode `session-state-scan.ts` documents.
	const stripped = stripCommentsAndStrings(source);
	const found: InFlightDeclaration[] = [];
	DECLARATION.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DECLARATION.exec(stripped)) !== null) {
		const symbol = match[1];
		found.push({
			file,
			symbol,
			line: stripped.slice(0, match.index).split("\n").length,
			key: `${file}:${symbol}`,
		});
	}
	return found;
}

/** The module that owns the primitive, which is exempt by definition. */
export const PRIMITIVE_MODULE = "single-flight.ts";

/** Scan every `clients/` source for hand-rolled in-flight declarations. */
export function scanInFlightDeclarations(): InFlightDeclaration[] {
	return clientSourceFiles()
		.map((absolute) => ({
			file: clientsRelative(absolute),
			source: fs.readFileSync(absolute, "utf8"),
		}))
		.filter(({ file }) => path.posix.basename(file) !== PRIMITIVE_MODULE)
		.flatMap(({ file, source }) => findInFlightDeclarations(file, source));
}
