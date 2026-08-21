/**
 * Registered-or-fail sweep: every `pi.on(...)` registration in `index.ts`
 * either goes through the central stale-ctx wrapper, or names the reason it
 * does not (#1925).
 *
 * #1924 guarded `agent_settled` inline. #1925 found four siblings with the
 * same shape, because nothing forced the next handler author to think about
 * an invalidated ctx. Prose in a module doc cannot force it; this sweep can.
 * A NEW `pi.on` registration now reds until its author either wraps it or
 * writes down why the handler cannot be reached by a dead ctx.
 *
 * The scan is CALL-SHAPED (the #1692 lesson, via `tests/support/sweep-kit.ts`):
 * it strips comments, finds `on("<event>"` calls, reads their balanced
 * argument text, and asks whether that text wraps the SAME event name — a
 * copy-pasted wrapper naming a different event would mislabel the ledger, so
 * it fails too.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertNonEmptyScan, auditRegistry, stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Handlers that deliberately stay unwrapped, each with the mechanism that
 * makes a stale ctx a non-event for it. An exemption whose site stops
 * matching is reported as stale, so a deleted or migrated handler cannot
 * leave a lie behind.
 */
const UNWRAPPED_HANDLER_REASONS: Readonly<Record<string, string>> = {
	resources_discover:
		"The handler takes `_event, _ctx` and reads neither, so there is no accessor for the SDK to invalidate.",
	session_before_fork:
		"Registered with no ctx parameter at all; it reads only pi-lens's own in-process state.",
	tool_call:
		"Delegates straight to handleToolCall, which already owns a total guard recording `tool-call-handler-throw` (clients/runtime-tool-call.ts); the registration body itself reads no ctx property.",
	session_start:
		"The ctx delivered here belongs to the session being announced, constructed moments earlier, so it cannot be one invalidated before delivery; the handler also has a total catch around every ctx read.",
	session_shutdown:
		"Every ctx read is already inside a try/catch or behind noteSessionShutdown's probe, and skipping teardown on an inconclusive probe would leak the LSP fleet.",
	context:
		"Its total catch already absorbs a stale read, and this handler must return the host's message list, so a wrapper short-circuiting to `undefined` would change what pi builds context from. The observability half is tracked in #1929.",
};

/** One `pi.on("<event>", ...)` registration found in index.ts. */
interface Registration {
	event: string;
	line: number;
	wrapped: boolean;
}

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

function scanRegistrations(): Registration[] {
	// Strings kept: the event name IS a string literal, so blanking contents
	// would blind the scan to the very thing it reads.
	const source = stripSource(
		fs.readFileSync(path.join(REPO_ROOT, "index.ts"), "utf8"),
		{ strings: "keep" },
	);
	const found: Registration[] = [];
	const opener = /(?<![A-Za-z0-9_$])on\s*\(\s*"([a-z_]+)"/g;
	let match = opener.exec(source);
	while (match !== null) {
		const event = match[1];
		const args = readBalancedArgs(source, source.indexOf("(", match.index));
		found.push({
			event,
			line: source.slice(0, match.index).split("\n").length,
			// The wrapper must name the SAME event, or the ledger subject lies.
			wrapped: args.includes(`wrapSessionEventHandler("${event}"`),
		});
		match = opener.exec(source);
	}
	return found;
}

describe("session-event stale-ctx guard sweep (#1925)", () => {
	const registrations = scanRegistrations();

	it("finds the real registrations, so a broken scan cannot pass vacuously", () => {
		assertNonEmptyScan("session-event registration scan", registrations.length, 10);
		expect(registrations.map((entry) => entry.event)).toContain("turn_end");
	});

	it("every pi.on registration is wrapped or has a stated reason", () => {
		const audit = auditRegistry({
			sweepName: "session-event stale-ctx guard sweep",
			flagged: registrations
				.filter((entry) => !entry.wrapped)
				.map((entry) => entry.event),
			registered: registrations
				.filter((entry) => entry.wrapped)
				.map((entry) => entry.event),
			exemptions: UNWRAPPED_HANDLER_REASONS,
			scannedCount: registrations.length,
			minScanned: 10,
			remediation:
				"Wrap it with wrapSessionEventHandler(<event>, handler, { dbg }) from clients/session-event-guard.ts, or add the event to UNWRAPPED_HANDLER_REASONS with the mechanism that makes a stale ctx unreachable for it.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("keeps the five known-reachable handlers wrapped", () => {
		// The population #1925 fixed, pinned by name: an unwrap shows up here
		// even if someone also adds a reason for it.
		const wrapped = new Set(
			registrations.filter((entry) => entry.wrapped).map((entry) => entry.event),
		);
		for (const event of [
			"tool_result",
			"turn_start",
			"agent_end",
			"turn_end",
			"agent_settled",
		]) {
			expect(wrapped, `${event} lost its stale-ctx wrapper`).toContain(event);
		}
	});
});
