/**
 * #5014 (shape 10): `unansweredPrimaries` is the one rule every collecting LSP
 * read (touchFile, getDiagnostics) uses to name the primaries that did not
 * answer. Recurrence it prevents: it returned "none missing" whenever ANY
 * non-auxiliary server was acquired, so python-jedi (a `fallbackFor: "python"`
 * alternate) answering beside a trust-refused or failed `python` made the file
 * read "Primary LSP (python): confirmed clean."
 *
 * Pure table: the acquired set and the roots the attempt resolved are the
 * inputs, no process is spawned. The end-to-end rows (real MCP server, real
 * spawn failure, adopted-root refusal) live in tests/mcp/server.smoke.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { registerLSPConfig } from "../../../clients/lsp/config.js";
import { unansweredPrimaries } from "../../../clients/lsp/index.js";
import {
	resetSessionRootsForTests,
	setSessionRootConfig,
} from "../../../clients/lsp/session-roots.js";
import {
	DenoServer,
	OpengrepServer,
	PythonJediServer,
	PythonServer,
} from "../../../clients/lsp/server.js";
import type { LSPServerInfo } from "../../../clients/lsp/server.js";

const FILE = "/proj/pkg/probe.py";
const acquired = (...infos: LSPServerInfo[]) =>
	infos.map((info) => ({ info, client: {} as never }));
const roots = (...ids: string[]) =>
	new Map(ids.map((id) => [id, "/proj"] as const));

afterEach(() => resetSessionRootsForTests());

describe("unansweredPrimaries names the owner a fallback stood in for (#5014)", () => {
	it.each([
		{
			name: "owner rooted and not acquired, fallback acquired: the owner is missing",
			spawned: [PythonJediServer],
			rooted: ["python", "python-jedi"],
			expected: ["python"],
		},
		{
			name: "fallback beside an auxiliary, owner not acquired: still missing",
			spawned: [PythonJediServer, OpengrepServer],
			rooted: ["python", "python-jedi"],
			expected: ["python"],
		},
		{
			name: "the owner itself acquired: nothing missing",
			spawned: [PythonServer],
			rooted: ["python"],
			expected: [],
		},
		{
			name: "owner and fallback both acquired: the owner answered",
			spawned: [PythonServer, PythonJediServer],
			rooted: ["python", "python-jedi"],
			expected: [],
		},
		{
			name: "nothing acquired: every rooted primary is missing",
			spawned: [],
			rooted: ["python", "python-jedi"],
			expected: ["python", "python-jedi"],
		},
		{
			name: "only an auxiliary acquired: every rooted primary is missing",
			spawned: [OpengrepServer],
			rooted: ["python", "python-jedi"],
			expected: ["python", "python-jedi"],
		},
		{
			// The deno shape: the owner (typescript) found no root, so it never
			// resolved one and the alternate is the file's only candidate.
			name: "owner resolved no root, fallback acquired: nothing is missing",
			spawned: [DenoServer],
			rooted: ["deno"],
			expected: [],
		},
	])("$name", ({ spawned, rooted, expected }) => {
		expect(
			unansweredPrimaries(acquired(...spawned), roots(...rooted), FILE)
				.serverIds,
		).toEqual(expected);
	});

	it("carries the unstarted cause for a missing owner a fallback replaced", () => {
		expect(
			unansweredPrimaries(
				acquired(PythonJediServer),
				roots("python", "python-jedi"),
				FILE,
			).cause,
		).toBe("unstarted");
	});

	it("admits a fallback standing in for an owner the operator turned off", () => {
		// The operator chose jedi: its answer is the file's primary answer.
		setSessionRootConfig(
			"/proj",
			registerLSPConfig({ disabledServers: ["python"] }),
		);
		expect(
			unansweredPrimaries(
				acquired(PythonJediServer),
				roots("python-jedi"),
				FILE,
			).serverIds,
		).toEqual([]);
	});

	it("still names a disabled owner whose fallback did not answer either", () => {
		setSessionRootConfig(
			"/proj",
			registerLSPConfig({ disabledServers: ["python"] }),
		);
		const result = unansweredPrimaries(acquired(), roots("python-jedi"), FILE);
		expect(result.serverIds).toEqual(["python-jedi", "python"]);
		expect(result.cause).toBe("disabledFallback");
	});
});
