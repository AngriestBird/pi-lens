/**
 * #4402: find every worker, child-process and IPC `message` handler in a
 * source text and derive whether it is contained. The ratchet that runs this
 * over the shipped trees is tests/clients/worker-message-boundary-ratchet.test.ts;
 * its header holds the state table this rule implements.
 *
 * Recurrence (#4400): the project-snapshot host typed its worker `message`
 * listener as the result it expected and passed `result.stagePath` to
 * `fs.rmSync`. A message without that field threw inside the listener, which
 * is an uncaught exception, and pi exited. Nothing mechanical required the
 * listener to check the message or to keep a throw inside it.
 *
 * What a site is: a call `<receiver>.<on|once|addListener|prependListener|
 * prependOnceListener|addEventListener>("message", handler)` or an
 * assignment `<receiver>.onmessage = handler`, for any receiver (a `Worker`,
 * `parentPort`, a `MessagePort`, `process`, a forked child).
 *
 * The rule, derived and never a hand list:
 * - Shape: the message parameter is typed `unknown` and never cast (`as`,
 *   `<T>`). The type checker then refuses every field read until a check has
 *   narrowed it, so "reads only shape-checked fields" is tsc's verdict.
 * - Containment: the handler body is one `try` with a `catch` that does not
 *   rethrow, and the try block lets no promise rejection out (a `.then`
 *   without `.catch`, or an async IIFE whose own body is not contained). A
 *   body that only delegates (`(m: unknown) => handle(m)`, `void (async () =>
 *   {…})()`) is contained when the function it delegates to is.
 * - A handler the scan cannot follow (an imported function, a factory call)
 *   is `unresolved`, which fails loud: it is never counted as contained.
 *
 * The scan parses comment-blanked source (`stripSource`, strings kept,
 * because the event name `"message"` is itself a string literal: the
 * per-needle policy). A `try` written in a comment is blank before the parse,
 * and one written in a string is a string node, so neither can satisfy the
 * rule.
 *
 * Known limits, named: a catch or finally body is the containment boundary
 * and is trusted not to throw beyond an explicit `throw`; a callback a
 * handler schedules (`fs.rm(p, cb)`, a timer) runs outside its try and is
 * shape 53's hand screen; an event name held in a variable is not a site.
 */

import { Lang, parse } from "@ast-grep/napi";
import { findEnclosingSymbol, stripSource } from "./sweep-kit.js";

/** The napi node type is untyped, exactly as the socket sweep walks it. */
// oxlint-disable-next-line typescript/no-explicit-any
type SgNode = any;

const LISTENER_METHODS = new Set([
	"on",
	"once",
	"addListener",
	"prependListener",
	"prependOnceListener",
	"addEventListener",
]);

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

export type MessageHandlerVerdict = "contained" | "uncontained" | "unresolved";

export interface MessageHandlerSite {
	/** `<file>#<enclosing symbol> <receiver>.<method>`: stable under line churn. */
	key: string;
	/** 1-based line of the registration. */
	line: number;
	verdict: MessageHandlerVerdict;
	/** Why the verdict is not `contained`; empty when it is. */
	problems: string[];
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

/** `"message"`, `'message'` or a substitution-free `` `message` ``. */
function isMessageLiteral(node: SgNode | undefined): boolean {
	if (!node) return false;
	if (node.kind() !== "string" && node.kind() !== "template_string") {
		return false;
	}
	const parts = node.namedChildren();
	return (
		parts.length === 1 &&
		parts[0].kind() === "string_fragment" &&
		parts[0].text() === "message"
	);
}

/** Named functions in the file: declarations and `const f = (…) => …`. */
function functionIndex(root: SgNode): Map<string, SgNode[]> {
	const index = new Map<string, SgNode[]>();
	const add = (name: string | undefined, fn: SgNode) => {
		if (!name) return;
		index.set(name, [...(index.get(name) ?? []), fn]);
	};
	walk(root, (node: SgNode) => {
		if (node.kind() === "function_declaration") {
			add(node.field("name")?.text(), node);
		} else if (node.kind() === "variable_declarator") {
			const value = node.field("value");
			if (value && FUNCTION_KINDS.has(value.kind())) {
				add(node.field("name")?.text(), value);
			}
		}
	});
	return index;
}

function unwrapParens(node: SgNode | undefined): SgNode | undefined {
	let current = node;
	while (current?.kind() === "parenthesized_expression") {
		current = current.namedChildren()[0];
	}
	return current;
}

interface Parameter {
	name: string | undefined;
	type: string | undefined;
}

function parameters(fn: SgNode): Parameter[] {
	const single = fn.field("parameter");
	if (single) return [{ name: single.text(), type: undefined }];
	return (fn.field("parameters")?.namedChildren() ?? []).map((p: SgNode) => {
		const pattern = p.field("pattern") ?? p.namedChildren()[0];
		const annotation = p.field("type");
		return {
			name: pattern?.kind() === "identifier" ? pattern.text() : undefined,
			type: annotation?.namedChildren()[0]?.text(),
		};
	});
}

class Judge {
	private readonly visiting = new Set<SgNode>();
	unresolved = false;

	constructor(private readonly index: Map<string, SgNode[]>) {}

	resolve(node: SgNode | undefined): SgNode | undefined {
		const target = unwrapParens(node);
		if (!target) return undefined;
		if (FUNCTION_KINDS.has(target.kind())) return target;
		if (target.kind() !== "identifier") return undefined;
		const found = this.index.get(target.text()) ?? [];
		return found.length === 1 ? found[0] : undefined;
	}

	/** Problems for `fn` receiving the message as parameter `position`. */
	handler(fn: SgNode, position: number): string[] {
		if (this.visiting.has(fn)) return [];
		this.visiting.add(fn);
		const problems: string[] = [];
		const param = parameters(fn)[position];
		if (param !== undefined) {
			const label = param.name ?? "<pattern>";
			if (param.type !== "unknown") {
				problems.push(
					`message parameter "${label}" is typed ${param.type ? `"${param.type}"` : "implicitly"}; type it unknown so tsc requires a shape check before any field read (#4400)`,
				);
			}
			if (param.name !== undefined) {
				walk(fn, (node: SgNode) => {
					const kind = node.kind();
					if (
						(kind === "as_expression" || kind === "type_assertion") &&
						node
							.namedChildren()
							.some(
								(child: SgNode) =>
									child.kind() === "identifier" && child.text() === param.name,
							)
					) {
						problems.push(
							`message parameter "${param.name}" is cast (${node.text()}); a cast skips the shape check`,
						);
					}
				});
			}
		}
		problems.push(...this.body(fn.field("body"), param?.name));
		return problems;
	}

	private body(body: SgNode | undefined, param: string | undefined): string[] {
		if (!body) return ["handler has no body to judge"];
		if (body.kind() !== "statement_block") return this.delegation(body, param);
		const statements = body.namedChildren();
		if (statements.length === 1) {
			const only = statements[0];
			if (only.kind() === "try_statement") return this.tryStatement(only);
			if (
				only.kind() === "expression_statement" ||
				only.kind() === "return_statement"
			) {
				const expression = only.namedChildren()[0];
				if (expression) return this.delegation(expression, param);
			}
		}
		return [
			"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
		];
	}

	private delegation(expression: SgNode, param: string | undefined): string[] {
		let call = unwrapParens(expression);
		if (
			call?.kind() === "unary_expression" &&
			call.child(0)?.text() === "void"
		) {
			call = unwrapParens(call.namedChildren()[0]);
		}
		if (call?.kind() !== "call_expression") {
			return [
				"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
			];
		}
		const callee = unwrapParens(call.field("function"));
		const args = call.field("arguments")?.namedChildren() ?? [];
		if (callee && FUNCTION_KINDS.has(callee.kind()) && args.length === 0) {
			// An IIFE: its body runs as this handler's body.
			return this.body(callee.field("body"), param);
		}
		const target =
			callee?.kind() === "identifier" ? this.resolve(callee) : undefined;
		const position = args.findIndex(
			(arg: SgNode) => arg.kind() === "identifier" && arg.text() === param,
		);
		if (!target) {
			this.unresolved = true;
			return [
				`delegates to ${callee?.text() ?? "an expression"}, which this file does not define; the scan cannot follow it`,
			];
		}
		return this.handler(
			target,
			position < 0 ? Number.MAX_SAFE_INTEGER : position,
		);
	}

	private tryStatement(statement: SgNode): string[] {
		const problems: string[] = [];
		const handler = statement
			.namedChildren()
			.find((child: SgNode) => child.kind() === "catch_clause");
		if (!handler) {
			problems.push("try has no catch: a throw still leaves the listener");
		} else {
			walkOwnBody(handler, (node: SgNode) => {
				if (node.kind() === "throw_statement") {
					problems.push(`catch rethrows (${node.text()})`);
				}
			});
		}
		const block = statement.field("body");
		if (block) {
			walkOwnBody(block, (node: SgNode) => {
				if (node.kind() !== "call_expression") return;
				const fn = node.field("function");
				if (
					fn?.kind() === "member_expression" &&
					fn.field("property")?.text() === "then" &&
					!caughtAfter(node)
				) {
					problems.push(
						`a .then() chain without .catch() lets a rejection out of the try (${firstLine(node.text())})`,
					);
				}
				const callee = unwrapParens(fn);
				if (
					callee &&
					FUNCTION_KINDS.has(callee.kind()) &&
					callee.child(0)?.text() === "async"
				) {
					problems.push(...this.body(callee.field("body"), undefined));
				}
			});
		}
		return problems;
	}
}

/** Is this `.then(…)` call the object of a later `.catch(…)` call? */
function caughtAfter(thenCall: SgNode): boolean {
	let current = thenCall;
	for (;;) {
		const member = current.parent();
		if (member?.kind() !== "member_expression") return false;
		const call = member.parent();
		if (call?.kind() !== "call_expression") return false;
		if (member.field("property")?.text() === "catch") return true;
		current = call;
	}
}

function firstLine(text: string): string {
	return text.split("\n")[0].trim();
}

/** Every `message` handler in one source text, with its derived verdict. */
export function scanMessageHandlers(
	source: string,
	relPath = "<source>",
): MessageHandlerSite[] {
	const stripped = stripSource(source, { strings: "keep" });
	if (!/["'`]message["'`]|\bonmessage\b/.test(stripped)) return [];
	const root = parse(Lang.TypeScript, stripped).root();
	const index = functionIndex(root);
	const lines = source.split("\n");
	const sites: MessageHandlerSite[] = [];
	const judgeSite = (
		node: SgNode,
		receiver: SgNode,
		method: string,
		handler: SgNode | undefined,
	) => {
		const line = node.range().start.line;
		const symbol = findEnclosingSymbol(lines, line) ?? `line-${line + 1}`;
		const judge = new Judge(index);
		const fn = judge.resolve(handler);
		const problems = fn
			? judge.handler(fn, 0)
			: [
					`handler ${handler?.text() ?? "<missing>"} is not a function this file defines; the scan cannot follow it`,
				];
		const unresolved = !fn || judge.unresolved;
		sites.push({
			key: `${relPath}#${symbol} ${receiver.text().replace(/\s+/g, "")}.${method}`,
			line: line + 1,
			verdict:
				problems.length === 0
					? "contained"
					: unresolved
						? "unresolved"
						: "uncontained",
			problems,
		});
	};
	walk(root, (node: SgNode) => {
		if (node.kind() === "call_expression") {
			const fn = node.field("function");
			if (fn?.kind() !== "member_expression") return;
			const method = fn.field("property")?.text() ?? "";
			if (!LISTENER_METHODS.has(method)) return;
			const args = node.field("arguments")?.namedChildren() ?? [];
			if (!isMessageLiteral(args[0])) return;
			judgeSite(node, fn.field("object"), method, args[1]);
		} else if (node.kind() === "assignment_expression") {
			const left = node.field("left");
			if (
				left?.kind() !== "member_expression" ||
				left.field("property")?.text() !== "onmessage"
			) {
				return;
			}
			judgeSite(node, left.field("object"), "onmessage", node.field("right"));
		}
	});
	return sites;
}
