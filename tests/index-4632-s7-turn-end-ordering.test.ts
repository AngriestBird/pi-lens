/**
 * Slice 7 of #4632: the turn-end ordering on the REAL host.
 *
 * Every case here was moved out of a file that drove the hand-built pi double
 * (`tests/support/pi-mock.ts`), and every one of them pins the same ORDER: a
 * `tool_result` starts the cascade compute, `turn_end` composes its line, and
 * the NEXT model request carries it. The double could only check the payload
 * `index.ts` handed a handler; a case here reads the transcript pi actually
 * built and sent (`tests/support/pi-session.ts`, tier 2), so a break in the
 * order between those three hooks changes what the model receives.
 *
 * Moved from `tests/clients/cascade-unanswered-primary-4403.test.ts` (8 of its
 * 10 cases). Two STAY on the double, with the probe that keeps them there:
 *
 * - "delivers the line once: a section the cap cut, then the next turn" and
 *   "delivers the line once: the cascade section leads and the cap cuts it".
 *   CLASS: `internal-seam` — both script `RUNTIME_CONFIG.turnEnd.maxChars`,
 *   which `clients/runtime-config.ts` declares `as const` and
 *   `clients/runtime-turn.ts` reads from its OWN copy of that module. The
 *   loaded copy owns a second object, so a test-side mutation reaches nothing:
 *   probed by setting `maxChars` to 40 here and watching the whole section
 *   deliver anyway (the cap ran at 1000). A cap-bound claim needs a payload
 *   over 1000 chars, which no scripted provider can produce.
 *
 * Language servers are the host boundary, as in the file this moves from: each
 * server's command is a project override pointing at a shim that runs the
 * shared fake server, which answers every pull with no findings. A missing
 * server's command points at a path that does not exist. That is why this file
 * runs in the serialized `lsp-spawn-heavy` lane: real children, one of them
 * held 8 s before it answers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getLSPService, resetLSPService } from "../clients/lsp/index.js";
import { endTurn, step } from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiProviderRequest,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const fakeServer = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);

const FALLBACK_CAUSE =
	"it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting";
const DISABLED_CAUSE = "it is disabled in config by lsp.disabledServers";
const UNSTARTED_CAUSE = "it could not be started, or was still starting";

const cascadeLine = (ids: string, cause: string): string =>
	`⚠️ Cascade: no language server answered for neighbor files of ${ids} (${cause}), so their cross-file errors were not checked (not a clean result).`;

const UNSTARTED_LINE = cascadeLine("typescript", UNSTARTED_CAUSE);

type Case = {
	name: string;
	typescript: "working" | "slow" | "disabled" | "missing";
	deno: "missing" | "disabled";
	/** The cascade lines the first turn shows; later turns show none. */
	firstTurn: string[];
};

const CASES: readonly Case[] = [
	{
		name: "typescript working",
		typescript: "working",
		deno: "disabled",
		firstTurn: [],
	},
	// Still starting when b.ts is written: the cascade defers a cold server's
	// neighbours (clients/lsp/cascade-tier.ts) rather than naming it, so a
	// session's first edit does not report a server that is only warming up.
	{
		name: "typescript still starting",
		typescript: "slow",
		deno: "disabled",
		firstTurn: [],
	},
	{
		name: "typescript disabled, deno missing",
		typescript: "disabled",
		deno: "missing",
		firstTurn: [cascadeLine("deno, typescript", FALLBACK_CAUSE)],
	},
	{
		name: "typescript disabled, deno disabled",
		typescript: "disabled",
		deno: "disabled",
		// deno stands in only for a disabled typescript, so with both off
		// both are the file's disabled primaries.
		firstTurn: [cascadeLine("typescript, deno", DISABLED_CAUSE)],
	},
	{
		name: "typescript missing, deno disabled",
		typescript: "missing",
		deno: "disabled",
		firstTurn: [UNSTARTED_LINE],
	},
];

/**
 * a.ts and c.ts import b.ts, d.ts imports a.ts, and f.ts imports e.ts, which
 * nothing else touches. g.ts lacks the fake server's clean marker, so a
 * reporting typos (`typos: "reporting"`) gives it a blocker.
 */
const CLEAN = "// fake-lsp-clean\n";
const FILES: Record<string, (n: number) => string> = {
	a: (n) => `import { b } from "./b";\nexport const a = b + ${n};\n${CLEAN}`,
	b: (n) => `export const b = ${n};\n${CLEAN}`,
	c: (n) => `import { b } from "./b";\nexport const c = b + ${n};\n${CLEAN}`,
	d: (n) => `import { a } from "./a";\nexport const d = a + ${n};\n${CLEAN}`,
	e: (n) => `export const e = ${n};\n${CLEAN}`,
	f: (n) => `import { e } from "./e";\nexport const f = e + ${n};\n${CLEAN}`,
	g: (n) => `export const g = ${n};\n`,
};

/** One turn's writes, in order: a file name and the value it is given. */
type Turn = ReadonlyArray<readonly [name: string, n: number]>;

type Setup = Pick<Case, "name" | "typescript" | "deno"> & {
	/** typos answers a file without the clean marker with one error. */
	typos?: "reporting";
};

/**
 * The project this case runs in: its own directory under the file's ONE
 * fixture root (the helper refuses a second root), carrying the project LSP
 * config the loaded copy reads and the servers' shim scripts.
 */
function makeWorkspace(testCase: Setup, slug: string): string {
	const workspace = path.join(fixture.root, slug);
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	const shim = (serverId: string, delayMs = 0, reporting = false): string[] => {
		const file = path.join(workspace, `${serverId}-server.mjs`);
		fs.writeFileSync(
			file,
			[
				`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
				reporting ? "" : 'process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		return [process.execPath, file];
	};
	const missing = (serverId: string): string[] => [
		path.join(workspace, "missing", serverId),
		"--stdio",
	];
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4632-s7","private":true}\n',
	);
	for (const [name, content] of Object.entries(FILES))
		fs.writeFileSync(path.join(workspace, `${name}.ts`), content(1));
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				typescript: {
					command:
						testCase.typescript === "missing"
							? missing("typescript-language-server")
							: shim("typescript", testCase.typescript === "slow" ? 8_000 : 0),
				},
				deno: { command: missing("deno") },
				typos: {
					command: shim("typos", 0, testCase.typos === "reporting"),
				},
				opengrep: { command: shim("opengrep") },
			},
			disabledServers: [
				"ast-grep",
				"zizmor",
				...(testCase.typescript === "disabled" ? ["typescript"] : []),
				...(testCase.deno === "disabled" ? ["deno"] : []),
			],
			// A configured warm file that does not exist: session_start's
			// dominant-language warm-up would otherwise start servers early.
			warmFiles: ["no-such-warm-file.ts"],
		}),
	);
	return workspace;
}

/** Every text block of one request, as one string. */
function requestText(request: PiProviderRequest): string {
	return request
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: JSON.stringify(message.content),
		)
		.join("\n");
}

/**
 * The cascade lines a request carries, with how many times each appears.
 *
 * pi hands each request the WHOLE transcript, and an injected section stays in
 * it afterwards, so a request's own delivery is the INCREASE over the previous
 * request — the same reason `toolResults` reads the last transcript only.
 */
function cascadeCounts(request: PiProviderRequest): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of requestText(request)
		.split("\n")
		.map((entry) => entry.trim())) {
		if (!line.includes("Cascade")) continue;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return counts;
}

/** The lines a step DELIVERED: every line whose count grew, repeated per growth. */
function deliveredLines(
	before: Map<string, number>,
	after: Map<string, number>,
): string[] {
	const delivered: string[] = [];
	for (const [line, count] of after) {
		const added = count - (before.get(line) ?? 0);
		for (let index = 0; index < added; index += 1) delivered.push(line);
	}
	return delivered;
}

/** The read prompt that makes the next provider request; one per turn. */
const READ_TURN = "continue";

/**
 * Run `turns` through one real session and return, for each turn, the cascade
 * lines its NEXT model request carried.
 *
 * Every write is one scripted reply (at most one tool call per reply, so its
 * result lands before the next one — #4632 s4), and each turn closes with a
 * text-only reply. The read prompt then opens the next turn, and its first
 * request is the one pi-lens's `context_with_system` injection reaches.
 */
async function runTurns(
	testCase: Setup,
	slug: string,
	turns: readonly Turn[],
): Promise<string[][]> {
	const workspace = makeWorkspace(testCase, slug);
	const responses: PiFauxReply[] = [];
	const prompts: string[] = [];
	for (const [turnIndex, writes] of turns.entries()) {
		for (const [name, n] of writes) {
			responses.push(
				step(
					fauxToolCall("write", {
						path: path.join(workspace, `${name}.ts`),
						content: FILES[name](n),
					}),
					`writing ${name}`,
				),
			);
		}
		responses.push(endTurn(`turn ${turnIndex + 1} done`));
		responses.push(endTurn(`read ${turnIndex + 1}`));
		prompts.push(`turn ${turnIndex + 1}`, READ_TURN);
	}
	const session = await startPiSession({
		root: fixture.root,
		cwd: workspace,
		// The tier's defaults leave the language servers off; this claim IS the
		// turn-end line they produce, so the flag is turned off rather than
		// deleted (`false` removes it from the host's flag map, see `flagMap`).
		flags: new Map<string, boolean>([["no-lsp", false]]),
		responses,
	});
	for (const prompt of prompts) await session.prompt(prompt);
	const counts = session.requests.map(cascadeCounts);
	// Request 0 opens turn 1; each read prompt's request follows its write turn.
	const readIndices = prompts
		.map((prompt, index) => (prompt === READ_TURN ? index : -1))
		.filter((index) => index >= 0);
	expect(
		counts[0]?.size ?? 0,
		"the first request carries no cascade line",
	).toBe(0);
	expect(session.errors, "every handler resolved").toEqual([]);
	return readIndices.map((index, position) =>
		deliveredLines(
			position === 0
				? new Map()
				: (counts[readIndices[position - 1]] ?? new Map()),
			counts[index] ?? new Map(),
		),
	);
}

const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
const previousInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

beforeAll(() => {
	// A server the project config points at is never installed over: the
	// missing-server cases assert the "could not be started" line, which an
	// installer run would replace with an npm failure.
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
});

/**
 * One process-global LSP service (`clients/lsp/service-singleton.ts`, keyed on
 * `globalThis`) serves every activation, so the previous case's warm clients
 * and its project's config stay reachable to the next case's session. This is
 * the SAME reset the production `session_start`/`session_shutdown` handlers
 * call; it carries no assertion, and no case reads the service.
 */
afterEach(async () => {
	await getLSPService().shutdown();
	resetLSPService();
});

afterAll(() => {
	if (previousInstall === undefined)
		delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	else process.env.PI_LENS_DISABLE_LSP_INSTALL = previousInstall;
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
});

describe("a cascade neighbour no primary answered for, on the real host (#4403 N2)", () => {
	for (const [index, testCase] of CASES.entries()) {
		it(`${testCase.name}: ${testCase.firstTurn.length > 0 ? "one cause-named line, then none" : "no cascade line"}`, async () => {
			// Two writes of b.ts in the first turn: the first run is superseded
			// at turn_end, so the line must ride the second.
			const turns = await runTurns(testCase, `matrix-${index}`, [
				[
					["b", 2],
					["b", 3],
				],
				[["b", 4]],
				[["b", 5]],
			]);
			expect(turns).toEqual([testCase.firstTurn, [], []]);
		}, 180_000);
	}

	// Round 5 (V1): the server is marked once the line is delivered, so a run
	// that turn_end drops does not use the line up, and two runs that name the
	// same server in one turn show it once. typescript missing, deno disabled.
	const SCRIPTS: ReadonlyArray<{
		name: string;
		firstTurn: Turn;
		expected: string[][];
	}> = [
		{
			// b.ts's run is superseded by the write of its neighbour a.ts, and
			// a.ts's own run (neighbour d.ts) carries the line.
			name: "b.ts, then its neighbour a.ts",
			firstTurn: [
				["b", 2],
				["a", 2],
			],
			expected: [[UNSTARTED_LINE], [], []],
		},
		{
			// Both runs survive turn_end and both name typescript.
			name: "b.ts and an unrelated e.ts",
			firstTurn: [
				["b", 2],
				["e", 2],
			],
			expected: [[UNSTARTED_LINE], [], []],
		},
	];

	for (const [index, script] of SCRIPTS.entries()) {
		it(`delivers the line once: ${script.name}`, async () => {
			const turns = await runTurns(
				{
					name: script.name,
					typescript: "missing",
					deno: "disabled",
				},
				`script-${index}`,
				[script.firstTurn, [["b", 4]], [["b", 5]]],
			);
			// `runTurns` reports the lines each turn's next request ADDED; an
			// injected section stays in the transcript, so this is what the turn
			// delivered, not what a later request happens to repeat.
			expect(turns).toEqual(script.expected);
		}, 180_000);
	}
});
