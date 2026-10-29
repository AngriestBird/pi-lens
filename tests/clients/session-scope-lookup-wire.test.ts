/**
 * #4965: the production side of the session lookup. index.ts's `session_start`
 * begins (or takes) the session's scope and binds it to the session's lookup
 * key; the scope's retirement unbinds it. Every scope-cell store reached by
 * session id (the cache observability, the memory sampler, the coordinator's
 * foreign turns) depends on that bind, and the unit cases in
 * `session-scope-lookup.test.ts` bind by hand, so only a real host proves it.
 *
 * The recurrence it prevents: a bind dropped from either `session_start` path
 * leaves every by-id store silently empty (a write is dropped and counted),
 * while every hand-bound unit test stays green.
 */
import { describe, expect, it } from "vitest";
import {
	scopeOfSession,
	sessionLookupKey,
} from "../../clients/session-scope.js";
import { piSessionFixture, startPiSession } from "../support/pi-session.js";

const fixture = piSessionFixture();

describe("session_start binds the session's scope to its lookup key (#4965)", () => {
	it("a primary start binds the coordinator's scope, and its end unbinds it", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: `${fixture.root}/bind-primary/proj`,
			startupMode: "quick",
			responses: [],
		});
		const key = sessionLookupKey(
			handle.session.sessionManager.getSessionId(),
			"primary",
		);
		const scope = scopeOfSession(key);
		expect({ role: scope?.role, live: scope?.isLive() }).toEqual({
			role: "primary",
			live: true,
		});

		await handle.dispose();

		expect(scopeOfSession(key)).toBeUndefined();
	});

	it("a concurrent secondary start binds its own scope, apart from the primary's", async () => {
		const primary = await startPiSession({
			root: fixture.root,
			cwd: `${fixture.root}/bind-two-a/proj`,
			startupMode: "quick",
			responses: [],
		});
		const secondary = await startPiSession({
			root: fixture.root,
			cwd: `${fixture.root}/bind-two-b/proj`,
			startupMode: "quick",
			responses: [],
		});
		const primaryScope = scopeOfSession(
			sessionLookupKey(
				primary.session.sessionManager.getSessionId(),
				"primary",
			),
		);
		const secondaryScope = scopeOfSession(
			sessionLookupKey(
				secondary.session.sessionManager.getSessionId(),
				"concurrent-secondary",
			),
		);
		expect({
			primary: primaryScope?.role,
			secondary: secondaryScope?.role,
			distinct: primaryScope !== secondaryScope,
		}).toEqual({ primary: "primary", secondary: "secondary", distinct: true });

		await secondary.dispose();
		await primary.dispose();
	});
});
