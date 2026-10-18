/**
 * #4589: a test that starts a real listening server must close it, and await
 * the close, before the case or file ends.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * binds a port or a socket path, and a later case in the same worker finds it
 * held. Rule A (`test-env-restore-gate.ts`) covers unrestored environment
 * writes; this module covers the listener.
 *
 * ## The start population is derived, and it fails closed (shape 69)
 *
 * A start is any `.listen(...)` call: that is the act that binds the handle,
 * whatever the receiver was built from, and the receiver may be an identifier,
 * a chain, or an optional chain. The detector resolves the receiver to a
 * binding set; every server construction the file contains (`createServer`,
 * `net.createServer`, `http.createServer`, `new WebSocketServer`, ... — any
 * call or constructor whose name ends in `Server`) must either be one of those
 * resolved bindings or be reported. A construction the detector did not
 * classify therefore reds instead of passing, and a new spelling of "start a
 * server" cannot slip through as clean.
 *
 * The seeds and the close are matched through AST identity, not through a list
 * of spellings: the receiver is an identifier; `C.push(receiver)` links it to
 * an array container whose elements are closed in a loop or callback; a
 * `let server; server = local` alias joins the same binding set; a `finally`,
 * an `afterEach`/`afterAll` callback, or the start's own function are the
 * accepted teardown placements.
 *
 * ## Awaiting is structural, not proximity
 *
 * A close settled by an `await` ancestor counts. A close inside a
 * `new Promise(executor)` counts only when that promise expression is settled
 * in turn: an `await` above it, or a callback whose invocation is awaited
 * (`await Promise.all(C.map((server) => new Promise(...)))`), or a file-local
 * helper whose every call site is. A close reached through a returned `close`
 * closure is reported as `helper` rather than credited: the detector does not
 * follow a handle across a function's return value.
 *
 * ## Declared gaps (fail-open directions, each named)
 *
 * - **Name-based identity.** Two bindings that share a name in different
 *   scopes are one identity: a close of the sibling's `server` credits this
 *   start. The tree's files are small and one-server-per-file; a future file
 *   with a shadowed receiver needs the detector extended, not just admitted.
 * - **Returned handles.** A factory that returns `{ close }` is reported as
 *   `helper`, never followed into its callers. Every caller awaiting
 *   `handle.close()` is a reason to admit the row, not a proof.
 * - **Cross-file helpers.** A start or a close inside an imported helper is
 *   invisible; a `tests/support/` helper that closes its own listener is a
 *   start and a close in the same function, so it is clean.
 * - **Timers.** This gate decides listeners only. `setInterval`/`setTimeout`
 *   ownership is a different seam with its own ownership rules.
 */

import { Lang, parse } from "@ast-grep/napi";

import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { stripSource } from "./sweep-kit.js";

/** Why a start is not provably closed and awaited. */
export type ServerTeardownVerdict =
	/** No close call reaches the started binding. */
	| "unclosed"
	/** A close runs, but its promise is never awaited. */
	| "unawaited"
	/** A settled close runs somewhere no teardown rule accepts. */
	| "misplaced"
	/** A settled close lives in a returned closure the detector does not follow. */
	| "helper"
	/** The receiver, or a server construction, is not readable here. */
	| "unresolvable";

/** Where the close evidence sits, for the admission guard (#4589 shape 38). */
export type ServerTeardownMechanism =
	| "teardown"
	| "finally"
	| "helper"
	| "none";

/** One started server that is not provably closed and awaited. */
export interface ServerTeardownFinding {
	/** Repo-relative path, supplied by the caller. */
	file: string;
	/** The receiver's binding identity, or a construction's callee. */
	server: string;
	/** 1-based line of the start (or of the unclassified construction). */
	line: number;
	verdict: ServerTeardownVerdict;
	/** The close evidence's own placement, re-checked by the admissions guard. */
	mechanism: ServerTeardownMechanism;
	text: string;
	reason: string;
}

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
]);

/** Callbacks whose body runs as a test or a hook (not a transparent callback). */
const HOOK_CALLEES = new Set([
	"it",
	"test",
	"describe",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
]);

const TEARDOWN_HOOKS = new Set(["afterEach", "afterAll"]);

/** Two wrappers over the same AST node (ast-grep returns a new object each). */
const sameNode = (
	left: SgNode | undefined,
	right: SgNode | undefined,
): boolean => {
	if (!left || !right) return false;
	const a = left.range();
	const b = right.range();
	return a.start.index === b.start.index && a.end.index === b.end.index;
};

/** The identifier a binding or parameter pattern names. */
function bindingName(node: SgNode | undefined): string | undefined {
	if (!node) return undefined;
	if (node.kind() === "identifier") return node.text();
	const pattern = node.field("pattern") ?? node.field("name");
	return pattern?.kind() === "identifier" ? pattern.text() : undefined;
}

const within = (inner: SgNode, outer: SgNode): boolean =>
	outer.range().start.index <= inner.range().start.index &&
	inner.range().end.index <= outer.range().end.index;

/** Does an expression name the identifier `name` as a whole token? */
function referencesName(text: string, name: string): boolean {
	const tokens = text.split(/[^\w$]+/);
	return tokens.includes(name);
}

function isFunction(node: SgNode): boolean {
	return FUNCTION_KINDS.has(String(node.kind()));
}

/** The call a callback function is the argument of, if it is one. */
function invokingCall(fn: SgNode): SgNode | undefined {
	const parent = fn.parent();
	if (parent?.kind() === "arguments") {
		const owner = parent.parent();
		if (owner?.kind() === "call_expression") return owner;
		// `new Promise((resolve) => ...)`: the executor is invoked by the
		// constructor, so the promise expression is the invocation site.
		if (owner?.kind() === "new_expression") return owner;
	}
	return undefined;
}

/** The nearest call whose callee is `name` (a member call counts). */
function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression") {
		const object = fn.field("object");
		const objectName = object?.kind() === "identifier" ? object.text() : "";
		if (HOOK_CALLEES.has(objectName)) return objectName;
		return fn.field("property")?.text();
	}
	if (fn?.kind() === "call_expression") return calleeName(fn);
	return undefined;
}

/** The name a function binds, or the variable it is assigned to. */
function functionName(fn: SgNode): string | undefined {
	if (fn.kind() === "function_declaration") return fn.field("name")?.text();
	if (fn.kind() !== "arrow_function" && fn.kind() !== "function_expression")
		return fn.field("name")?.text();
	const parent = fn.parent();
	if (parent?.kind() !== "variable_declarator") return undefined;
	const name = parent.field("name");
	return name?.kind() === "identifier" ? name.text() : undefined;
}

/** The object property a function expression is the value of, if it is one. */
function propertyKey(fn: SgNode): string | undefined {
	const parent = fn.parent();
	if (parent?.kind() !== "pair") return undefined;
	const key = parent.field("key");
	return key ? key.text() : undefined;
}

/**
 * The function a node's body belongs to: its test/hook callback when there is
 * one, else the nearest named function. A `new Promise(...)` executor or a
 * `.map(...)` callback is not an owner; it runs inside one.
 */
function ownerFunction(node: SgNode): SgNode | undefined {
	const hook = enclosingHook(node);
	if (hook) return hook;
	let fallback: SgNode | undefined;
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			fallback ??= current;
			if (functionName(current)) return current;
		}
		current = current.parent();
	}
	return fallback;
}

/** `new Promise(...)`: the expression whose completion a close can be awaited on. */
function isPromiseConstruction(node: SgNode): boolean {
	if (node.kind() !== "new_expression") return false;
	const ctor = node.field("constructor");
	return ctor?.kind() === "identifier" && /Promise$/.test(ctor.text());
}

/**
 * The promise a close call is wrapped in, crossing only its own executor.
 * `server.close()` returns the server, so awaiting the CALL settles nothing:
 * only the callback form, wrapped in a promise, has a completion to await.
 */
function enclosingPromise(node: SgNode): SgNode | undefined {
	let current = node;
	for (;;) {
		const parent = current.parent();
		if (!parent) return undefined;
		if (isFunction(parent)) {
			const call = invokingCall(parent);
			return call && isPromiseConstruction(call) ? call : undefined;
		}
		current = parent;
	}
}

/**
 * The nearest enclosing test or hook callback, crossing callbacks the start
 * does not have to wait on (`new Promise(...)` executors, `.map(...)`
 * callbacks). A function declaration at file scope is not a hook.
 */
function enclosingHook(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			const call = invokingCall(current);
			if (call?.kind() === "call_expression") {
				const name = calleeName(call);
				if (name && HOOK_CALLEES.has(name)) return current;
			}
			if (call) {
				current = call.parent();
				continue;
			}
		}
		current = current.parent();
	}
	return undefined;
}

/** Does a `finally` clause enclose the node inside its own function? */
function insideFinally(node: SgNode): boolean {
	let current = node.parent();
	while (current) {
		if (current.kind() === "finally_clause") return true;
		if (isFunction(current)) return false;
		current = current.parent();
	}
	return false;
}

interface Binding {
	name: string;
	value: SgNode;
}

/** The construction forms a start may be built from (a morphological rule). */
function isServerConstruction(node: SgNode): boolean {
	if (node.kind() === "call_expression") {
		const name = calleeName(node);
		return name !== undefined && /create\w*Server$|^createServer$/.test(name);
	}
	if (node.kind() === "new_expression") {
		const ctor = node.field("constructor");
		const name =
			ctor?.kind() === "identifier"
				? ctor.text()
				: ctor?.kind() === "member_expression"
					? (ctor.field("property")?.text() ?? "")
					: "";
		return /Server$/.test(name);
	}
	return false;
}

/** The callee text of a construction, for a report that names it. */
function constructionName(node: SgNode): string {
	if (node.kind() === "call_expression") return calleeName(node) ?? node.text();
	const ctor = node.field("constructor");
	return ctor?.text().replace(/\s+/g, "") ?? node.text().replace(/\s+/g, "");
}

interface CloseEvidence {
	node: SgNode;
	settled: boolean;
	/** The close lives in a returned closure (a handle the detector cannot follow). */
	helper: boolean;
	placements: Set<
		"teardown" | "finally" | "same-function" | "helper" | "other"
	>;
}

/** A binding set's scalar name plus every identifier joined to it by `=`. */
function identityNames(
	receiver: string,
	bindings: readonly Binding[],
): string[] {
	const names = new Set([receiver]);
	for (let pass = 0; pass < 4; pass++) {
		for (const binding of bindings) {
			const right = binding.value;
			if (right?.kind() !== "identifier") continue;
			const other = right.text();
			if (names.has(binding.name)) names.add(other);
			if (names.has(other)) names.add(binding.name);
		}
	}
	return [...names];
}

export function findUnclosedServerStarts(
	file: string,
	source: string,
): ServerTeardownFinding[] {
	const blanked = stripSource(source);
	// Cheap admission: no listener and no construction means nothing to parse.
	if (!/\blisten\b/.test(blanked) && !/\b\w*Server\s*\(/.test(blanked)) {
		return [];
	}

	const root = parse(Lang.TypeScript, source).root();
	const calls = root.findAll({ rule: { kind: "call_expression" } });
	const news = root.findAll({ rule: { kind: "new_expression" } });
	const lines = source.split("\n");

	const bindings: Binding[] = [];
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (name?.kind() === "identifier" && value) {
			bindings.push({ name: name.text(), value });
		}
	}
	for (const assignment of root.findAll({
		rule: { kind: "assignment_expression" },
	})) {
		const left = assignment.field("left");
		const right = assignment.field("right");
		if (left?.kind() === "identifier" && right) {
			bindings.push({ name: left.text(), value: right });
		}
	}

	const starts: Array<{ receiver: SgNode; node: SgNode }> = [];
	for (const call of calls) {
		const fn = call.field("function");
		if (fn?.kind() !== "member_expression") continue;
		if (fn.field("property")?.text() !== "listen") continue;
		const receiver = fn.field("object");
		if (receiver) starts.push({ receiver, node: call });
	}
	const constructions = [...calls, ...news].filter(isServerConstruction);

	// Every construction a resolved start was built from is accounted for; the
	// rest are reported below, so a start spelling the detector cannot read is
	// never counted clean (shape 69). Keyed by range: two walks return distinct
	// wrapper objects for the same node.
	const covered = new Set<string>();
	const rangeKey = (node: SgNode): string => {
		const range = node.range();
		return `${range.start.index}:${range.end.index}`;
	};
	const findings: ServerTeardownFinding[] = [];

	const closeCalls: SgNode[] = [];
	for (const call of calls) {
		const fn = call.field("function");
		if (fn?.kind() !== "member_expression") continue;
		if (fn.field("property")?.text() !== "close") continue;
		const receiver = fn.field("object");
		if (receiver?.kind() === "identifier") closeCalls.push(call);
	}
	/** Every function parameter or loop binding fed by a container. */
	function elementBindings(container: string): string[] {
		const names: string[] = [];
		for (const call of calls) {
			const fn = call.field("function");
			if (fn?.kind() !== "member_expression") continue;
			const object = fn.field("object");
			if (!object || !referencesName(object.text(), container)) continue;
			const args = call.field("arguments")?.namedChildren() ?? [];
			for (const arg of args) {
				if (!isFunction(arg)) continue;
				const parameter = bindingName(
					arg.field("parameters")?.namedChildren()[0],
				);
				if (parameter) names.push(parameter);
			}
		}
		for (const loop of root.findAll({ rule: { kind: "for_in_statement" } })) {
			const right = loop.field("right");
			if (!right || !referencesName(right.text(), container)) continue;
			const left = loop.field("left");
			const binding =
				left?.kind() === "identifier"
					? left
					: left?.kind() === "variable_declaration"
						? left
								.namedChildren()
								.find((child) => child.kind() === "variable_declarator")
						: undefined;
			const name =
				binding?.kind() === "identifier"
					? binding.text()
					: binding?.field("name")?.text();
			if (name) names.push(name);
		}
		return names;
	}

	function containersFedBy(names: readonly string[]): string[] {
		const containers: string[] = [];
		for (const call of calls) {
			const fn = call.field("function");
			if (fn?.kind() !== "member_expression") continue;
			const property = fn.field("property")?.text();
			if (property !== "push" && property !== "unshift") continue;
			const receiver = fn.field("object");
			if (receiver?.kind() !== "identifier") continue;
			const args = call.field("arguments")?.namedChildren() ?? [];
			const feeds = args.some(
				(arg) => arg.kind() === "identifier" && names.includes(arg.text()),
			);
			if (feeds) containers.push(receiver.text());
		}
		return containers;
	}

	function settleFrom(
		node: SgNode,
		depth: number,
	): { settled: boolean; helper: boolean } {
		let current = node;
		for (;;) {
			const parent = current.parent();
			if (!parent) return { settled: false, helper: false };
			if (parent.kind() === "await_expression")
				return { settled: true, helper: false };
			if (isFunction(parent)) {
				const call = invokingCall(parent);
				if (call) {
					current = call;
					continue;
				}
				if (propertyKey(parent)) return { settled: false, helper: true };
				const name = functionName(parent);
				if (!name) return { settled: false, helper: false };
				if (depth >= 2) return { settled: false, helper: false };
				const sites = calls.filter((call) => {
					const fn = call.field("function");
					return (
						fn?.kind() === "identifier" &&
						fn.text() === name &&
						!within(call, parent)
					);
				});
				if (sites.length === 0) return { settled: false, helper: false };
				return {
					settled: sites.every((site) => settleFrom(site, depth + 1).settled),
					helper: false,
				};
			}
			current = parent;
		}
	}

	function settlementsOf(
		node: SgNode,
		depth: number,
	): { settled: boolean; helper: boolean } {
		const promise = enclosingPromise(node);
		if (!promise) return { settled: false, helper: false };
		return settleFrom(promise, depth);
	}

	function placementsOf(
		node: SgNode,
		startFunction: SgNode | undefined,
		depth: number,
	): CloseEvidence["placements"] {
		const placements: CloseEvidence["placements"] = new Set();
		const hook = enclosingHook(node);
		if (hook) {
			const call = invokingCall(hook);
			const name =
				call?.kind() === "call_expression" ? calleeName(call) : undefined;
			if (name && TEARDOWN_HOOKS.has(name)) {
				placements.add("teardown");
				return placements;
			}
		}
		if (insideFinally(node)) {
			placements.add("finally");
			return placements;
		}
		let current = node;
		for (;;) {
			const parent = current.parent();
			if (!parent) {
				placements.add("other");
				return placements;
			}
			if (!isFunction(parent)) {
				current = parent;
				continue;
			}
			if (sameNode(parent, startFunction)) {
				placements.add("same-function");
				return placements;
			}
			const call = invokingCall(parent);
			if (call) {
				current = call;
				continue;
			}
			// A returned `close` closure: a helper the detector does not follow.
			if (propertyKey(parent)) {
				placements.add("helper");
				return placements;
			}
			const name = functionName(parent);
			if (name && depth < 2) {
				const sites = calls.filter((site) => {
					const fn = site.field("function");
					return (
						fn?.kind() === "identifier" &&
						fn.text() === name &&
						!within(site, parent)
					);
				});
				for (const site of sites) {
					for (const placement of placementsOf(site, startFunction, depth + 1))
						placements.add(placement);
				}
				if (placements.size > 0) return placements;
			}
			placements.add("other");
			return placements;
		}
	}

	for (const start of starts) {
		const receiver = start.receiver;
		const line = start.node.range().start.line + 1;
		const text = lines[line - 1]?.trim() ?? "";
		if (receiver.kind() !== "identifier") {
			// The receiver itself is reported, and any construction it wraps is
			// part of that same report (no second row for one defect).
			covered.add(rangeKey(receiver));
			findings.push({
				file,
				server: receiver.text().replace(/\s+/g, ""),
				line,
				verdict: "unresolvable",
				mechanism: "none",
				text,
				reason: `the listener's receiver is not a plain identifier (${receiver.text().replace(/\s+/g, " ")}), so no close can be attributed to it`,
			});
			continue;
		}
		const names = identityNames(receiver.text(), bindings);
		const built = bindings.filter(
			(binding) =>
				names.includes(binding.name) && isServerConstruction(binding.value),
		);
		if (built.length === 0) {
			findings.push({
				file,
				server: receiver.text(),
				line,
				verdict: "unresolvable",
				mechanism: "none",
				text,
				reason: `receiver \`${receiver.text()}\` is bound to ${
					bindings
						.find((binding) => binding.name === receiver.text())
						?.value.text()
						.replace(/\s+/g, " ") ?? "nothing declared here"
				}, which this detector cannot read as a server construction`,
			});
			continue;
		}
		for (const binding of built) covered.add(rangeKey(binding.value));

		const containers = containersFedBy(names);
		const elements = containers.flatMap((container) =>
			elementBindings(container),
		);
		const receivers = new Set([...names, ...elements]);
		const startOwner = ownerFunction(start.node);
		const candidates: CloseEvidence[] = closeCalls
			.filter((call) => {
				const fn = call.field("function");
				if (fn?.kind() !== "member_expression") return false;
				const object = fn.field("object");
				return object?.kind() === "identifier" && receivers.has(object.text());
			})
			.map((call) => ({
				node: call,
				...settlementsOf(call, 0),
				placements: placementsOf(call, startOwner, 0),
			}))
			.filter((evidence) => {
				// A close is this start's evidence when it is a teardown/finally (it
				// applies to the whole file or describe), when a helper chain reaches
				// it from the start's own function, or when it lives in that function.
				// A closure inside an unrelated named function closes THAT function's
				// server, not this one, even when the binding name is the same.
				if (
					evidence.placements.has("teardown") ||
					evidence.placements.has("finally") ||
					evidence.placements.has("same-function")
				)
					return true;
				const evidenceOwner = ownerFunction(evidence.node);
				if (!evidenceOwner || !functionName(evidenceOwner)) return true;
				return sameNode(evidenceOwner, startOwner);
			});

		const acceptedPlacement = (evidence: CloseEvidence): boolean =>
			evidence.placements.has("teardown") ||
			evidence.placements.has("finally") ||
			evidence.placements.has("same-function");
		const accepted = candidates.find(
			(evidence) => evidence.settled && acceptedPlacement(evidence),
		);
		if (accepted) continue;

		const mechanismOf = (evidence: CloseEvidence): ServerTeardownMechanism => {
			if (evidence.placements.has("teardown")) return "teardown";
			if (evidence.placements.has("finally")) return "finally";
			if (evidence.placements.has("helper")) return "helper";
			return "none";
		};
		const settledElsewhere = candidates.find((evidence) => evidence.settled);
		const helper = candidates.find(
			(evidence) => evidence.helper || evidence.placements.has("helper"),
		);
		const mechanism = helper
			? mechanismOf(helper)
			: settledElsewhere
				? mechanismOf(settledElsewhere)
				: candidates.length > 0
					? mechanismOf(candidates[0])
					: "none";
		const verdict: ServerTeardownVerdict = helper
			? "helper"
			: settledElsewhere
				? "misplaced"
				: candidates.length > 0
					? "unawaited"
					: "unclosed";
		const reason =
			verdict === "helper"
				? `\`${receiver.text()}.close()\` runs inside a returned closure; the detector does not follow the handle into its callers, so the row needs an admission that names the caller`
				: verdict === "misplaced"
					? `\`${receiver.text()}.close()\` is settled, but not in a teardown hook, a \`finally\`, the start's own function, or a helper every call site settles`
					: verdict === "unawaited"
						? `\`${receiver.text()}.close()\` runs, but its promise is never awaited, so the handle can outlive the case`
						: `no \`close\` call reaches \`${receiver.text()}\``;
		findings.push({
			file,
			server: receiver.text(),
			line,
			verdict,
			mechanism,
			text,
			reason,
		});
	}

	// Fail closed on a construction the detector never attributed to a start:
	// `new WebSocketServer({ port })` binds without a `.listen` call, and a
	// factory the binding scan misread must report rather than pass.
	for (const construction of constructions) {
		if (covered.has(rangeKey(construction))) continue;
		const line = construction.range().start.line + 1;
		findings.push({
			file,
			server: constructionName(construction),
			line,
			verdict: "unresolvable",
			mechanism: "none",
			text: lines[line - 1]?.trim() ?? "",
			reason:
				"a server construction with no resolvable start: either it never calls `.listen` here (a port the detector cannot see) or the binding is not readable, so it needs an admission",
		});
	}

	return findings;
}

/** One row's identity: the file and the started binding. Never a line. */
export function serverTeardownKey(finding: ServerTeardownFinding): string {
	return `${finding.file}:${finding.server}`;
}

/** Escapes a row key so a computed construction name cannot break the guard. */
export function escapeRowKey(key: string): string {
	return key.replace(/%/g, "%25").replace(/\s+/g, "%20");
}

/**
 * The close evidence a file's findings sit on, re-derived from the source. The
 * admissions guard requires the admitted mechanism to be one of these, so a
 * row cannot claim `teardown` for a close that only appears in a `helper`.
 */
export function serverTeardownMechanisms(
	source: string,
	findings: readonly ServerTeardownFinding[],
): ServerTeardownMechanism[] {
	const fresh = findUnclosedServerStarts("probe.test.ts", source);
	const servers = new Set(findings.map((finding) => finding.server));
	const mechanisms = new Set<ServerTeardownMechanism>();
	for (const finding of fresh) {
		if (servers.has(finding.server)) mechanisms.add(finding.mechanism);
	}
	for (const finding of fresh) {
		if (servers.has(finding.server) && finding.mechanism === "none") {
			mechanisms.add("none");
		}
	}
	return [...mechanisms].sort();
}
