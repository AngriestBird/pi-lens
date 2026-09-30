/**
 * Unknown-argument reporting for MCP `tools/call` (#3749).
 *
 * The MCP dispatcher used to hand the caller's raw `arguments` to a tool and
 * let the tool read the keys it knew. A mistyped key (`pilens_diagnostics
 * {"filePath": ...}` where the schema says `path`) was dropped without a
 * word, and the tool ran on defaults: an agent read `No issues in the current
 * turn delta.` as a clean file. This module is the one check the dispatcher
 * applies to every tool, driven by the `inputSchema` the tool already
 * advertises in `tools/list`:
 *
 *  - a key the schema does not declare is REPORTED (a leading warning line
 *    plus `structuredContent.ignoredArguments`), never silently dropped;
 *  - when such a key leaves a schema-`required` input missing, the call is an
 *    error instead of a run on defaults.
 *
 * Hard rejection of every unknown key is NOT done here: it would break
 * callers that pass extra keys today, and is owned by the #2418 stability
 * policy.
 */

/** The slice of a JSON-Schema object the check reads. */
export interface ToolInputSchemaLike {
	properties?: Record<string, unknown>;
	required?: readonly string[];
}

export interface IgnoredArgument {
	key: string;
	/** The nearest declared key, when one is plausibly what the caller meant. */
	suggestion?: string;
}

export interface ArgumentReport {
	ignored: IgnoredArgument[];
	/** Schema-required keys the caller did not send. */
	missingRequired: string[];
}

/** Keys named in the line / structured list; the rest are counted. */
export const MAX_REPORTED_KEYS = 8;
/** A reported key is cut here so one huge key cannot make a huge line. */
export const MAX_REPORTED_KEY_CHARS = 64;

/** Equal, or one character inserted, dropped or replaced. */
function withinOneEdit(a: string, b: string): boolean {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
	return a.length < b.length
		? a.slice(i) === b.slice(i + 1)
		: b.slice(i) === a.slice(i + 1);
}

/**
 * The declared key a caller most plausibly meant by `key`: one containing
 * (or contained in) the other once case and punctuation are folded away
 * (`filePath` for `path` or `file`; `FILE` for `file`), then a one-character
 * typo. `undefined` when nothing is near: a wrong suggestion is worse than
 * none.
 */
function nearestDeclaredKey(
	key: string,
	declared: readonly string[],
): string | undefined {
	const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
	const folded = fold(key);
	let best: { key: string; score: number } | undefined;
	for (const candidate of declared) {
		const other = fold(candidate);
		let score: number | undefined;
		if (
			Math.min(folded.length, other.length) >= 3 &&
			(folded.includes(other) || other.includes(folded))
		)
			score = 100 + Math.abs(folded.length - other.length);
		else if (withinOneEdit(folded, other)) score = 200;
		if (score !== undefined && (!best || score < best.score))
			best = { key: candidate, score };
	}
	return best?.key;
}

/**
 * Compare a call's arguments with the tool's declared schema. `undefined`
 * when every key is declared (the call is untouched). An own-property test,
 * not `in`: `constructor` and `toString` are not declared keys.
 */
export function findIgnoredArguments(
	schema: ToolInputSchemaLike,
	args: Record<string, unknown>,
): ArgumentReport | undefined {
	const properties = schema.properties ?? {};
	const declared = Object.keys(properties);
	const ignored = Object.keys(args)
		.filter((key) => !Object.hasOwn(properties, key))
		.map((key): IgnoredArgument => {
			const suggestion = nearestDeclaredKey(key, declared);
			return suggestion === undefined ? { key } : { key, suggestion };
		});
	if (ignored.length === 0) return undefined;
	const missingRequired = (schema.required ?? []).filter(
		(key) => !Object.hasOwn(args, key),
	);
	return { ignored, missingRequired };
}

function shown(key: string): string {
	return key.length > MAX_REPORTED_KEY_CHARS
		? `${key.slice(0, MAX_REPORTED_KEY_CHARS)}…`
		: key;
}

/** The leading line: names the ignored keys with the nearest valid key. */
export function ignoredArgumentsLine(
	tool: string,
	report: ArgumentReport,
): string {
	const listed = report.ignored.slice(0, MAX_REPORTED_KEYS).map((entry) => {
		const hint = entry.suggestion
			? ` (did you mean \`${entry.suggestion}\`?)`
			: "";
		return `\`${shown(entry.key)}\`${hint}`;
	});
	const more = report.ignored.length - listed.length;
	const tail = more > 0 ? ` and ${more} more` : "";
	return `Ignored unknown argument(s) for ${tool}: ${listed.join(", ")}${tail}. They had no effect on this call.`;
}

/** The structured payload: bounded key list plus the exact count. */
export function ignoredArgumentsStructured(report: ArgumentReport): {
	ignoredArguments: string[];
	ignoredArgumentCount: number;
} {
	return {
		ignoredArguments: report.ignored
			.slice(0, MAX_REPORTED_KEYS)
			.map((entry) => shown(entry.key)),
		ignoredArgumentCount: report.ignored.length,
	};
}

interface TextContentResult {
	content: { type: "text"; text: string }[];
}

/** Put the warning line first in a finished result and attach the payload. */
export function withIgnoredArguments<T extends TextContentResult>(
	result: T,
	tool: string,
	report: ArgumentReport,
): T & { structuredContent: ReturnType<typeof ignoredArgumentsStructured> } {
	const line = ignoredArgumentsLine(tool, report);
	const [first, ...rest] = result.content;
	return {
		...result,
		content: first
			? [{ ...first, text: `${line}\n\n${first.text}` }, ...rest]
			: [{ type: "text" as const, text: line }],
		structuredContent: ignoredArgumentsStructured(report),
	};
}

/**
 * The error that replaces a run on defaults when an ignored key leaves a
 * required input missing. `undefined` when nothing required is missing.
 */
export function missingRequiredResult(
	tool: string,
	report: ArgumentReport,
):
	| (TextContentResult & {
			isError: true;
			structuredContent: ReturnType<typeof ignoredArgumentsStructured>;
	  })
	| undefined {
	if (report.missingRequired.length === 0) return undefined;
	const missing = report.missingRequired.map((key) => `\`${key}\``).join(", ");
	return {
		content: [
			{
				type: "text",
				text: `${ignoredArgumentsLine(tool, report)}\nNot run: required argument(s) ${missing} missing.`,
			},
		],
		isError: true,
		structuredContent: ignoredArgumentsStructured(report),
	};
}
