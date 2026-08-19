/**
 * #1667: multi-identifier pull diagnostics.
 *
 * A server may register `textDocument/diagnostic` several times, each with its
 * own `registerOptions.identifier` — Roslyn registers "syntax", "semantic" and
 * "analyzers" as separate diagnostic sources; vtsls does the same. Before this
 * fix `dynamicRegistrations` stored only the METHOD name, so every identifier
 * was discarded and the pull path issued exactly ONE bare
 * `textDocument/diagnostic`. Whole diagnostic categories were silently missed.
 *
 * These are connection-double tests: `state.connection.sendRequest` is a mock,
 * not a wire-protocol server. A real fake server is deliberately out of scope
 * (#1660).
 */

import { describe, expect, it, vi } from "vitest";
import {
	applyDynamicCapabilities,
	clearDiagnosticsForPath,
	clientWaitForDiagnostics,
	type LSPClientState,
	type LSPDiagnostic,
	setupIncomingHandlers,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.cs";
const TEST_KEY = normalizeMapKey(TEST_FILE);

function pullState(): LSPClientState {
	return createMockState({
		serverId: "csharp",
		root: "/project",
		workspaceDiagnosticsSupport: {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "dynamic",
		},
		staticDiagnosticsMode: "push-only",
	});
}

function diagnostic(line: number, message: string): LSPDiagnostic {
	return {
		severity: 1,
		message,
		range: {
			start: { line, character: 0 },
			end: { line, character: 5 },
		},
	} as LSPDiagnostic;
}

/**
 * Drive the real `client/registerCapability` handler, so the test exercises the
 * production registration-capture path rather than poking `dynamicRegistrations`
 * by hand.
 */
async function register(
	state: LSPClientState,
	registrations: Array<{
		id: string;
		method: string;
		registerOptions?: Record<string, unknown>;
	}>,
): Promise<void> {
	setupIncomingHandlers(state, undefined);
	const onRequest = state.connection.onRequest as unknown as {
		mock: { calls: Array<[string, (params: unknown) => unknown]> };
	};
	const entry = onRequest.mock.calls.find(
		(call) => call[0] === "client/registerCapability",
	);
	if (!entry) throw new Error("registerCapability handler not installed");
	await entry[1]({ registrations });
}

/**
 * Install a typed `textDocument/diagnostic` responder on the connection double
 * and hand back the mock so the test can read the requests that were sent.
 * The single cast is confined here: `MessageConnection.sendRequest` is
 * overloaded, so a precisely typed handler needs one bridge to assign.
 */
function installSendRequest(
	state: LSPClientState,
	handler: (method: string, params: unknown) => Promise<unknown>,
) {
	const mock = vi.fn(handler);
	state.connection.sendRequest =
		mock as unknown as typeof state.connection.sendRequest;
	return mock;
}

const identifierOf = (params: unknown): string | undefined =>
	(params as { identifier?: string } | undefined)?.identifier;

const sentIdentifiers = (sendRequest: ReturnType<typeof vi.fn>) =>
	sendRequest.mock.calls
		.filter((call) => call[0] === "textDocument/diagnostic")
		.map((call) => identifierOf(call[1]));

describe("#1667 registration capture", () => {
	it("keeps identifier and workspaceDiagnostics from registerOptions", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax", workspaceDiagnostics: false },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic", workspaceDiagnostics: true },
			},
		]);

		expect(state.dynamicRegistrations.get("syntax-1")).toMatchObject({
			method: "textDocument/diagnostic",
			identifier: "syntax",
			workspaceDiagnostics: false,
		});
		expect(state.dynamicRegistrations.get("semantic-1")).toMatchObject({
			method: "textDocument/diagnostic",
			identifier: "semantic",
			workspaceDiagnostics: true,
		});
	});

	it("derives workspace-pull support from the registration flag, not the method name", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic", workspaceDiagnostics: true },
			},
		]);

		// Only `textDocument/diagnostic` was ever registered — the method-name
		// check can never see "workspace/diagnostic" here, so a true reading can
		// only come from `registerOptions.workspaceDiagnostics`.
		expect(state.workspaceDiagnosticsSupport.workspaceDiagnostics).toBe(true);
	});

	it("reports no workspace pull when every registration declares workspaceDiagnostics false", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax", workspaceDiagnostics: false },
			},
		]);
		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		expect(state.workspaceDiagnosticsSupport.workspaceDiagnostics).toBe(false);
	});
});

describe("#1667 multi-identifier pull fan-out", () => {
	it("pulls EVERY registered identifier and delivers the union", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		const sendRequest = installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === "syntax") {
				return {
					kind: "full",
					resultId: "syn-1",
					items: [diagnostic(1, "CS1002: ; expected")],
				};
			}
			if (id === "semantic") {
				return {
					kind: "full",
					resultId: "sem-1",
					items: [diagnostic(9, "CS0103: name 'foo' does not exist")],
				};
			}
			// The bare pull (no identifier) returns the server's default set,
			// which here overlaps the syntax source — the union must dedupe it.
			return {
				kind: "full",
				resultId: "bare-1",
				items: [diagnostic(1, "CS1002: ; expected")],
			};
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 1000, { pullOnly: true });

		const identifiers = sentIdentifiers(sendRequest);
		expect(identifiers).toContain("syntax");
		expect(identifiers).toContain("semantic");
		expect(identifiers).toContain(undefined);

		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual([
			"CS0103: name 'foo' does not exist",
			"CS1002: ; expected",
		]);
	});

	it("answers on the first useful result and merges the slow identifier in the background", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		const SLOW_MS = 400;
		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === "syntax") {
				return {
					kind: "full",
					resultId: "syn-1",
					items: [diagnostic(1, "fast syntax finding")],
				};
			}
			if (id === "semantic") {
				await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
				return {
					kind: "full",
					resultId: "sem-1",
					items: [diagnostic(9, "slow semantic finding")],
				};
			}
			return { kind: "full", resultId: "bare-1", items: [] };
		});

		const startedAt = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		const elapsed = Date.now() - startedAt;

		// The fast identifier's answer is delivered immediately — no wait-for-all,
		// no post-match settle delay (the #1112/#1407 latency shape).
		expect(elapsed).toBeLessThan(SLOW_MS / 2);
		expect(
			(state.documentPullDiagnostics.get(TEST_KEY) ?? []).map((d) => d.message),
		).toContain("fast syntax finding");

		// The slow loser is not dropped: it lands in the pull cache in the
		// background, so the NEXT read for this file sees it.
		await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 200));
		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual(["fast syntax finding", "slow semantic finding"]);
	});
});

describe("#1667 previousResultId inheritance is per identifier", () => {
	it("echoes each identifier's OWN previous resultId and never crosses them", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		const resultIds: Record<string, string> = {
			syntax: "syn-1",
			semantic: "sem-1",
			bare: "bare-1",
		};
		const sendRequest = installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params) ?? "bare";
			return {
				kind: "full",
				resultId: resultIds[id],
				items: [diagnostic(id === "syntax" ? 1 : 9, `${id} finding`)],
			};
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		// Let every fan-out branch finish storing before the second round.
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Round two: each identifier must echo the resultId IT was given.
		sendRequest.mockClear();
		const echoed: Array<{ id: string | undefined; previous: unknown }> = [];
		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			echoed.push({
				id,
				previous: (params as { previousResultId?: unknown }).previousResultId,
			});
			// "syntax" is unchanged and inherits its own stored findings;
			// "semantic" is recomputed fresh in the SAME round.
			if (id === "syntax") return { kind: "unchanged", resultId: "syn-1" };
			if (id === "semantic") {
				return {
					kind: "full",
					resultId: "sem-2",
					items: [diagnostic(9, "semantic finding v2")],
				};
			}
			return { kind: "unchanged", resultId: "bare-1" };
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		await new Promise((resolve) => setTimeout(resolve, 50));

		const byIdentifier = new Map(echoed.map((e) => [e.id, e.previous]));
		expect(byIdentifier.get("syntax")).toBe("syn-1");
		expect(byIdentifier.get("semantic")).toBe("sem-1");
		expect(byIdentifier.get(undefined)).toBe("bare-1");

		// The "unchanged" syntax source kept its own finding; the freshly pulled
		// semantic source replaced only ITS finding. Nothing was wiped by the
		// other source's report.
		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual([
			"bare finding",
			"semantic finding v2",
			"syntax finding",
		]);
	});

	it("a resync clears every identifier's resultId basis, not just the bare one", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params) ?? "bare";
			return { kind: "full", resultId: `${id}-1`, items: [] };
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect([...state.pullResultIds.values()].sort()).toEqual([
			"bare-1",
			"semantic-1",
			"syntax-1",
		]);

		clearDiagnosticsForPath(state, TEST_KEY);

		expect([...state.pullResultIds.keys()]).toEqual([]);
	});
});
