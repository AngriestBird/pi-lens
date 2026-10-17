/**
 * #4596: find every `catch` handler in a source text and derive whether a
 * failure it swallows is still observable. The ratchet that runs this over the
 * shipped trees is `tests/config/silent-catch-sweep.test.ts`; its header holds
 * the state table this rule implements.
 *
 * Recurrence (AGENTS.md shape 31, "pull-only observability"; the 2026-10-18
 * audit of 53 merged fixes): a runtime failure path ended in a bare
 * `catch { return "unknown" }`, `catch { continue; }` or
 * `.catch(() => {})`, so the shipped failure left no row in any log. Two of
 * them recorded an event that never happened: `deleted: 1` for a file that
 * still existed, and `failureKind: "success"` for a rejected save.
 *
 * What a site is:
 * - a `catch` clause of a `try` statement, and
 * - the handler of a `<expr>.catch(…)` call.
 *
 * The rule, derived and never a hand list:
 * - A handler that calls a record seam is `recorded`. A record seam is a call
 *   whose simple callee follows the repo's `record…`/`log…`/`increment…`
 *   naming convention (`recordDegradationOnce`, `incrementDegradationCount`,
 *   `logLatency`, `logCascade`, `logKnipRow`, and their siblings).
 * - A handler that throws is `rethrows`: the failure leaves it and reaches
 *   the caller, which is where the observable path already is.
 * - Any other handler is `silent` unless a comment inside the site carries
 *   `none: <reason>`, which makes it `declared-none` and states why the
 *   failure needs no row (a deliberate skip, an idempotent teardown).
 * - A `.catch(…)` handler that is not a function this file defines and not a
 *   bare identifier (a call, a `new` expression) is `unclassified`, which
 *   fails loud in the ratchet and is never counted as recorded.
 *
 * The scan parses comment-and-string-blanked source (`stripSource`, the
 * default `strings: "blank"` policy): a `catch` written in a comment is blank
 * before the parse, and a call named inside a string is not a call. The
 * `none:` marker is read from the RAW source and only counts where BOTH
 * strippings blanked the character, so a marker inside a string or in code is
 * not a comment.
 *
 * Known limits, named: a record seam passed but never called
 * (`{ onError: logX }`) does not count, because only call expressions are
 * read; a handler that delegates to an identifier is followed to a
 * same-file function declaration or function-valued `const`, and a delegation
 * to an import is `silent` rather than `recorded`, so a delegation the scan
 * cannot follow always asks for a `none:` line.
 */

import { Lang, parse } from "@ast-grep/napi";
import { stripSource } from "./sweep-kit.js";

/** The napi node type is untyped, exactly as the sibling sweeps walk it. */
// oxlint-disable-next-line typescript/no-explicit-any
type SgNode = any;

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

/**
 * The repo's record-seam naming convention: `recordDegradationOnce`,
 * `incrementDegradationCount`, `logLatency`, `logCascade`, a logger's
 * `logX`. Deliberately a convention, not a hand list of the tree's exporters
 * (shape 34): a logger added tomorrow is admitted without editing this file,
 * and a handler that calls one publishes instead of swallowing.
 */
const RECORD_SEAM = /^(?:record|log|increment)[A-Z]\w*$/;

/** `// none: <reason>` or a block-comment `none: <reason>`. */
const NONE_MARKER = /\/\/\s*none:\s*\S|\/\*\s*none:\s*\S/g;

export type CatchVerdict =
	/** The handler calls a record seam. */
	| "recorded"
	/** The handler rethrows: the failure reaches the caller. */
	| "rethrows"
	/** The handler carries a `none: <reason>` comment. */
	| "declared-none"
	/** The handler swallows with no record and no stated reason. */
	| "silent"
	/** The handler is not a form this scan can follow. */
	| "unclassified";

export interface CatchSite {
	/** 1-based line of the `catch` keyword or the `.catch` property. */
	line: number;
	form: "catch-clause" | "promise-catch";
	verdict: CatchVerdict;
	/** Record-seam callees the handler calls, in source order. */
	records: string[];
	/** First line of the handler, for a census a reader can act on. */
	snippet: string;
	/** Why the site is `unclassified`; absent otherwise. */
	problem?: string;
}

function walk(node: SgNode, visit: (node: SgNode) => void): void {
	visit(node);
	for (const child of node.children()) walk(child, visit);
}

/** Descendants of `node`, not descending into nested functions. */
function walkOwnBody(node: SgNode, visit: (node: SgNode) => void): void {
	for (const child of node.children()) {
		visit(child);
		if (!FUNCTION_KINDS.has(child.kind())) walkOwnBody(child, visit);
	}
}

/** The simple callee name of a call, for a plain or member call. */
function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression")
		return fn.field("property")?.text() ?? undefined;
	return undefined;
}

/**
 * Whether this handler lets the failure out on every path its own body takes.
 * A `throw` beside a `return` or a `continue` is a PARTIAL rethrow: the other
 * branch swallows, so the handler is not judged by its throw. The approximate
 * clause rule is deliberate (this scan has no control-flow graph) and it errs
 * toward `silent`, which asks for a record or a `none:` line.
 */
function rethrows(body: SgNode): boolean {
	let throws = false;
	let swallows = false;
	walkOwnBody(body, (child: SgNode) => {
		const kind = child.kind();
		if (kind === "throw_statement") throws = true;
		else if (kind === "return_statement") swallows = true;
		else if (kind === "continue_statement" || kind === "break_statement")
			swallows = true;
	});
	return throws && !swallows;
}

/**
 * Whether the raw span `[start, end)` carries a `none: <reason>` marker at a
 * COMMENT position. Both strippings blank a comment and nothing else in
 * common, so a marker blanked in both is a comment: one inside a string
 * survives the `strings: "keep"` pass and is refused.
 */
function declaredNone(
	raw: string,
	commentsBlanked: string,
	stringsBlanked: string,
	start: number,
	end: number,
): boolean {
	const span = raw.slice(start, end);
	NONE_MARKER.lastIndex = 0;
	let match: RegExpExecArray | null = NONE_MARKER.exec(span);
	while (match !== null) {
		const at = start + (match.index ?? 0);
		if (commentsBlanked[at] === " " && stringsBlanked[at] === " ") return true;
		match = NONE_MARKER.exec(span);
	}
	return false;
}

interface Strippings {
	raw: string;
	commentsBlanked: string;
	stringsBlanked: string;
}

/** The same-file function an identifier handler names, when there is one. */
function resolveHandler(
	handler: SgNode,
	index: ReadonlyMap<string, SgNode>,
): SgNode | undefined {
	if (handler.kind() !== "identifier") return undefined;
	const declaration = index.get(handler.text());
	if (!declaration) return undefined;
	const value =
		declaration.kind() === "variable_declarator"
			? declaration.field("value")
			: declaration;
	return value && FUNCTION_KINDS.has(value.kind()) ? value : undefined;
}

/** Every named function this file declares, by name. */
function functionIndex(root: SgNode): Map<string, SgNode> {
	const index = new Map<string, SgNode>();
	walk(root, (node: SgNode) => {
		if (node.kind() === "function_declaration") {
			const name = node.field("name")?.text();
			if (name !== undefined) index.set(name, node);
		} else if (node.kind() === "variable_declarator") {
			const name = node.field("name");
			const value = node.field("value");
			if (
				name?.kind() === "identifier" &&
				value &&
				FUNCTION_KINDS.has(value.kind())
			)
				index.set(name.text(), node);
		}
	});
	return index;
}

function firstLine(text: string): string {
	return text.split("\n")[0].trim();
}

/** Judge one handler body over the raw span a `none:` marker may live in. */
function judge(
	body: SgNode | undefined,
	span: { start: number; end: number },
	strippings: Strippings,
): { verdict: CatchVerdict; records: string[] } {
	const records: string[] = [];
	if (body) {
		const visitCall = (node: SgNode) => {
			if (node.kind() !== "call_expression") return;
			const name = calleeName(node);
			if (name !== undefined && RECORD_SEAM.test(name)) records.push(name);
		};
		// An arrow handler's body may BE the expression (`(e) => logX(e)`), not a
		// block holding it, so the body node is judged as well as its children.
		visitCall(body);
		walkOwnBody(body, visitCall);
	}
	if (records.length > 0) return { verdict: "recorded", records };
	if (body && rethrows(body)) return { verdict: "rethrows", records };
	if (
		declaredNone(
			strippings.raw,
			strippings.commentsBlanked,
			strippings.stringsBlanked,
			span.start,
			span.end,
		)
	)
		return { verdict: "declared-none", records };
	return { verdict: "silent", records };
}

/** Every `catch` handler in one source text, with its derived verdict. */
export function scanSilentCatches(source: string): CatchSite[] {
	const stringsBlanked = stripSource(source, { strings: "blank" });
	const commentsBlanked = stripSource(source, { strings: "keep" });
	const root = parse(Lang.TypeScript, stringsBlanked).root();
	const index = functionIndex(root);
	const strippings: Strippings = {
		raw: source,
		commentsBlanked,
		stringsBlanked,
	};
	const sites: CatchSite[] = [];
	walk(root, (node: SgNode) => {
		if (node.kind() === "catch_clause") {
			const body = node.field("body");
			const judged = judge(
				body,
				{
					start: node.range().start.index,
					end: node.range().end.index,
				},
				strippings,
			);
			sites.push({
				line: node.range().start.line + 1,
				form: "catch-clause",
				...judged,
				snippet: firstLine(body?.text() ?? node.text()),
			});
			return;
		}
		if (node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (fn?.kind() !== "member_expression") return;
		const property = fn.field("property");
		if (property?.text() !== "catch") return;
		const handler = node.field("arguments")?.namedChildren()[0];
		const line = property.range().start.line + 1;
		if (!handler) {
			sites.push({
				line,
				form: "promise-catch",
				verdict: "unclassified",
				records: [],
				snippet: firstLine(node.text()),
				problem: "`.catch()` names no handler at all",
			});
			return;
		}
		const resolved = resolveHandler(handler, index);
		const target = resolved ?? handler;
		if (
			!FUNCTION_KINDS.has(target.kind()) &&
			target.kind() !== "identifier" &&
			target.kind() !== "member_expression"
		) {
			sites.push({
				line,
				form: "promise-catch",
				verdict: "unclassified",
				records: [],
				snippet: firstLine(node.text()),
				problem: `handler \`${firstLine(handler.text())}\` is not a function literal or a bare identifier the scan can follow`,
			});
			return;
		}
		const body = FUNCTION_KINDS.has(target.kind())
			? target.field("body")
			: undefined;
		const judged = judge(
			body,
			{ start: property.range().start.index, end: node.range().end.index },
			strippings,
		);
		sites.push({
			line,
			form: "promise-catch",
			...judged,
			snippet: firstLine(handler.text()),
		});
	});
	return sites;
}
