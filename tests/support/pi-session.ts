/**
 * Tier 2 of the real-host test seam (#4632): the BUILT pi-lens extension inside
 * a real pi `AgentSession`, with a scripted model at the provider boundary. No
 * child process, no network, in process.
 *
 * What the seam is. `createAgentSessionServices` builds pi's real services and
 * runs pi's OWN extension loader over `index.js` (`additionalExtensionPaths` →
 * `discoverAndLoadExtensions`, the same call `tests/support/pi-runner.ts`
 * makes); `createAgentSessionFromServices` builds the real `AgentSession`;
 * pi-ai's `fauxProvider` answers every provider request and records the
 * messages pi actually sent. `tests/support/pi-mock.ts` records what
 * `index.ts` PASSED to a handler; this tier records what the host and the
 * model actually GOT.
 *
 * ONE FIXTURE ROOT PER FILE, one live session per case. The loaded copy
 * resolves `PI_LENS_HOME` once per process and later copies keep the first
 * answer (`clients/probe-home-state.ts`), so `startPiSession` refuses a second
 * root; a case that needs another project root passes another `cwd` under the
 * same root. A session started while another is still live in a different
 * root is classified by pi-lens as a concurrent secondary and its full start
 * is declined, so dispose a handle before starting the next session.
 *
 * What it pins, and what it does not. It pins the session loop's own flow —
 * `session_start`, a turn, a tool-call round trip, the transcript the provider
 * receives, resume from the persisted session file, and manual compaction —
 * so a case asserts an effect of the extension's registered behaviour rather
 * than the shape of a handler's return value. It does NOT pin event payload
 * shapes: for those `pi-mock.ts`'s `emit` stays the cheaper tool, and tier 1's
 * `pi-runner.ts` owns registration questions.
 *
 * FIVE CONSEQUENCES OF LOADING THROUGH PI'S OWN LOADER, all relied on below:
 *
 * 1. pi loads the entry with jiti and `moduleCache: false`, so the factory runs
 *    against its OWN copies of `clients/*` — never the copies this test
 *    process imported. Assert on what leaves the copy (provider requests, pi's
 *    session entries, files under the pinned root, process-wide registries),
 *    never on a module object identity.
 * 2. The copy reads `PI_LENS_HOME` / `PILENS_DATA_DIR` at its own load, so both
 *    are pinned here BEFORE the load, saved in a module-scope record and put
 *    back in `afterAll` (`tests/config/test-env-restore-sweep.test.ts`'s
 *    accepted shape). `PI_LENS_TEST_MODE=0` matches
 *    `tests/index-3521-fork-tree-witness.test.ts`: the start runs its
 *    production writes instead of the test-mode shortcuts.
 * 3. `PI_LENS_STARTUP_MODE=full` pins the start shape. A quick start (the
 *    production default for a process's first `session_start`) arms an
 *    unref'd 2 s warmup timer (`clients/runtime-session.ts`,
 *    `PI_LENS_WARMUP_DELAY_MS ?? 2000`) whose project-snapshot persist lands
 *    AFTER this fixture root is gone — measured: the root is re-created at
 *    `<root>/data/<project>/cache/project-snapshot.meta.json` ~0.4–2 s later
 *    (the accepted `p3` residual below). A full start does that work inline,
 *    so `bindExtensions` resolving is a real end of the start: measured twice,
 *    nothing writes after the root is removed. A case that must observe the
 *    quick/warmup shape passes `startupMode: "quick"` and owns that residual.
 * 4. The load builds jiti's transform cache at `path.join(os.tmpdir(), "jiti")`,
 *    so `os.tmpdir()` is aimed inside the fixture for the load only — tier 1's
 *    `withFixtureTmpdir` (#4641 F1: a direct child of the shared tmp root is a
 *    fixture sibling to the tmp-hygiene census).
 * 5. Teardown does NOT pretend to reach the loaded copy's internals. Two seams
 *    are real and are used:
 *      - pi's `ExtensionRunner.emit` AWAITS every handler
 *        (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`),
 *        and pi-lens's `session_shutdown` handler RETURNS its writer-drain
 *        promise (`index.ts`: `const ndjsonDrain = bounded(flushAllNdjsonWriters(), …)`,
 *        returned at the end of the handler), so emitting `session_shutdown`
 *        drains the copy's NDJSON sinks FROM INSIDE its own graph;
 *      - the NDJSON writer map is process-global
 *        (`clients/ndjson-logger.ts`, `Symbol.for("pi-lens.ndjson-logger.state")`),
 *        so `flushAllNdjsonWriters()` from this side reaches the copy's sinks
 *        too (probed: 13 writers, all under the pinned home).
 *    The copy's module-scope persist queues (`clients/project-snapshot.ts`,
 *    `clients/review-graph/builder.ts`) have no such seam: they are reachable
 *    only through the copy's own module objects, which nothing here holds.
 *    That is the `p3` residual documented in the PR body, NOT a silence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	type FauxResponseStep,
	type Message,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { afterAll } from "vitest";
import { flushAllNdjsonWriters } from "../../clients/ndjson-logger.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "../clients/test-utils.js";

/** The built extension every case loads: `npm run build` writes this twin. */
const EXTENSION_ENTRY = fileURLToPath(
	new URL("../../index.js", import.meta.url),
);

const TMP_PREFIX = "pi-lens-pi-session-";

const FAUX_MODEL = {
	id: "faux-1",
	name: "Faux",
	contextWindow: 200_000,
	maxTokens: 4_096,
};

/**
 * The flag set a case runs with unless it overrides it: the same six the
 * repo's other real-session drivers pin (`tests/index-3521-fork-tree-witness.test.ts`,
 * `tests/index-integration.test.ts`), plus `no-complexity`. The complexity
 * baseline is an analyzer pull fired by a `read`/`edit` tool call
 * (`clients/runtime-tool-call.ts`), i.e. asynchronous work this tier neither
 * observes nor can drain; a case that needs it deletes the flag.
 */
const DEFAULT_FLAGS: ReadonlyArray<[string, boolean]> = [
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
	["no-complexity", true],
];

/** One provider request: the messages the model received, in order. */
export type PiProviderRequest = ReadonlyArray<Message>;

export interface PiSessionOptions {
	/** Fixture root, created by `setupTestEnvironment(TMP_PREFIX)` below. */
	root: string;
	/** Scripted provider replies, one per expected request (pi-ai `fauxProvider`). */
	responses: readonly FauxResponseStep[];
	/**
	 * Project directory the session runs in. Defaults to `<root>/proj`, which
	 * the helper marks with `.git`; passing this checkout would make every
	 * project-state write land in it. A second session may name any other
	 * directory UNDER `root` (that is how a multi-root case runs two roots); a
	 * second ROOT is refused — see `pinEnv`.
	 */
	cwd?: string;
	/** `pi.getFlag` values; defaults to {@link DEFAULT_FLAGS}. */
	flags?: ReadonlyMap<string, boolean | string>;
	/** Session store. Defaults to `<root>/sessions`. */
	sessionsDir?: string;
	/**
	 * Startup shape pinned through `PI_LENS_STARTUP_MODE`. `"full"` (the
	 * default) settles the start inside `bindExtensions`; `"quick"` leaves the
	 * warmup timer armed (see the header, point 3).
	 */
	startupMode?: "full" | "quick";
}

export interface PiSession {
	/** pi's real session. Its `extensionRunner` is the loaded copy's host. */
	readonly session: AgentSession;
	/** Absolute project directory the session runs in. */
	readonly cwd: string;
	/** Every provider request, in order, deep-cloned as pi sent it. */
	readonly requests: PiProviderRequest[];
	/** Errors pi reported from an extension handler (`runner.onError`). */
	readonly errors: unknown[];
	/** The persisted session file, once pi has written one. */
	sessionFile(): string | undefined;
	/** Run one prompt to completion (tool calls included). */
	prompt(text: string): Promise<void>;
	/** Manual compaction, pi's `/compact` entry point. */
	compact(instructions?: string): Promise<unknown>;
	/**
	 * Reopen this session's persisted file in a NEW session with a new provider
	 * script — the resume path a restarted process takes.
	 */
	resume(responses: readonly FauxResponseStep[]): Promise<PiSession>;
	/** Settle the loaded copy, dispose the session, drain. Idempotent. */
	dispose(): Promise<void>;
}

/** The values this file replaced, saved before the first pin (`afterAll` restores). */
const savedEnv: Record<string, string | undefined> = {};

/** The one fixture root this file pinned; a second root is refused (see below). */
let pinnedRoot: string | undefined;

/** Fixtures this file still owns; removed with the environment in `afterAll`. */
const liveFixtures: Array<() => void> = [];

const PINNED_KEYS = [
	"PI_LENS_HOME",
	"PILENS_DATA_DIR",
	"PI_LENS_TEST_MODE",
	"PI_LENS_STARTUP_MODE",
] as const;

/** The one-root rule (see `startPiSession`): a second root cannot be observed. */
function assertOneRoot(root: string): void {
	// ONE ROOT PER FILE. The loaded copy resolves `PI_LENS_HOME` once per
	// process and later copies keep the first answer (its own
	// `clients/probe-home-state.ts` resolution memo), so a second root would
	// pin the environment somewhere the copy never reads: measured — after a
	// session under `<root>/a`, a session under `<root>/b` wrote
	// `<root>/a/home/latency.log` and nothing under `<root>/b`. Sessions that
	// need a different project root pass a different `cwd` UNDER this root.
	if (pinnedRoot !== undefined && pinnedRoot !== root)
		throw new Error(
			`pi-session: one fixture root per test file — this file already pinned ${pinnedRoot}, so the loaded copy keeps that home and ${root} would observe nothing (pass a different cwd under ${pinnedRoot} instead)`,
		);
	pinnedRoot = root;
}

/**
 * Run `load` with `os.tmpdir()` aimed inside the fixture: pi's loader builds
 * jiti's transform cache as `path.join(os.tmpdir(), "jiti")`, and an in-process
 * load otherwise leaves that directory at the shared tmp root (#4641 F1).
 */
async function withFixtureTmpdir<T>(
	root: string,
	load: () => Promise<T>,
): Promise<T> {
	const isolate = path.join(root, "tmp");
	fs.mkdirSync(isolate, { recursive: true });
	const previous = {
		TMPDIR: process.env.TMPDIR,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
	};
	process.env.TMPDIR = isolate;
	process.env.TEMP = isolate;
	process.env.TMP = isolate;
	try {
		return await load();
	} finally {
		if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous.TMPDIR;
		if (previous.TEMP === undefined) delete process.env.TEMP;
		else process.env.TEMP = previous.TEMP;
		if (previous.TMP === undefined) delete process.env.TMP;
		else process.env.TMP = previous.TMP;
	}
}

/** A model runtime whose only provider is the scripted one. */
async function buildModelRuntime(
	agentDir: string,
	responses: readonly FauxResponseStep[],
	requests: PiProviderRequest[],
): Promise<{ modelRuntime: ModelRuntime; model: unknown }> {
	const faux = fauxProvider({ models: [FAUX_MODEL] });
	// Every scripted step is wrapped so the request it answered is recorded
	// before the reply is produced: `requests.length` is then the count of
	// provider round trips pi actually made.
	faux.setResponses(
		responses.map((step) => (context, options, state, model) => {
			requests.push(
				context.messages.map((message) => structuredClone(message)),
			);
			return typeof step === "function"
				? step(context, options, state, model)
				: structuredClone(step);
		}),
	);
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		authPath: path.join(agentDir, "auth.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const model = modelRuntime.getModel("faux", FAUX_MODEL.id);
	if (!model) throw new Error("the faux provider registered no model");
	return { modelRuntime, model };
}

/**
 * Build one session against the pinned environment. `sessionManager` decides
 * whether this is a new session (`SessionManager.create`) or a resume
 * (`SessionManager.open`).
 */
async function buildSession(args: {
	root: string;
	cwd: string;
	agentDir: string;
	responses: readonly FauxResponseStep[];
	flags: ReadonlyMap<string, boolean | string>;
	sessionManager: () => SessionManager;
}): Promise<PiSession> {
	const requests: PiProviderRequest[] = [];
	const { modelRuntime, model } = await buildModelRuntime(
		args.agentDir,
		args.responses,
		requests,
	);
	const services = await withFixtureTmpdir(args.root, () =>
		createAgentSessionServices({
			cwd: args.cwd,
			agentDir: args.agentDir,
			modelRuntime,
			extensionFlagValues: new Map(args.flags),
			resourceLoaderOptions: {
				additionalExtensionPaths: [EXTENSION_ENTRY],
			},
		}),
	);
	const loadErrors = services.resourceLoader.getExtensions().errors;
	if (loadErrors.length > 0) {
		throw new Error(
			`pi failed to load ${EXTENSION_ENTRY}: ${JSON.stringify(loadErrors.map((entry) => String(entry.error)))}`,
		);
	}
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: args.sessionManager(),
		model: model as never,
	});
	const errors: unknown[] = [];
	await session.bindExtensions({
		onError: (error: unknown) => errors.push(error),
	});
	let disposed = false;
	const handle: PiSession = {
		session,
		cwd: args.cwd,
		requests,
		errors,
		sessionFile: () => session.sessionManager.getSessionFile(),
		async prompt(text) {
			await session.prompt(text);
		},
		async compact(instructions) {
			return session.compact(instructions);
		},
		async resume(responses) {
			const file = session.sessionManager.getSessionFile();
			if (!file || !fs.existsSync(file))
				throw new Error(
					`pi-session: nothing to resume — the session wrote no file under ${args.root}/sessions`,
				);
			await handle.dispose();
			return buildSession({
				...args,
				responses,
				sessionManager: () => SessionManager.open(file, path.dirname(file)),
			});
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			// The in-graph drain: pi awaits each handler, and pi-lens's
			// `session_shutdown` handler returns its writer-drain promise.
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			} as never);
			session.dispose();
			// The same process-global writer map the loaded copy registered into.
			await flushAllNdjsonWriters();
			await drainBackgroundWritesForTests();
		},
	};
	return handle;
}

/**
 * Start a real session over the built extension for one fixture. Call it once
 * per test file and keep the handle: the fixture, the load (~0.2 s) and the
 * session belong to the file, and `afterAll` below removes them.
 */
export async function startPiSession(
	options: PiSessionOptions,
): Promise<PiSession> {
	const cwd = options.cwd ?? path.join(options.root, "proj");
	const agentDir = path.join(options.root, "agent");
	const sessionsDir =
		options.sessionsDir ?? path.join(options.root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	assertOneRoot(options.root);
	// Save before pinning: the loaded copy reads these at its own load, so the
	// pin must precede `createAgentSessionServices`.
	for (const key of PINNED_KEYS) {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	}
	process.env.PI_LENS_HOME = path.join(options.root, "home");
	process.env.PILENS_DATA_DIR = path.join(options.root, "data");
	process.env.PI_LENS_TEST_MODE = "0";
	process.env.PI_LENS_STARTUP_MODE = options.startupMode ?? "full";
	return buildSession({
		root: options.root,
		cwd,
		agentDir,
		responses: options.responses,
		flags: options.flags ?? new Map(DEFAULT_FLAGS),
		sessionManager: () => SessionManager.create(cwd, sessionsDir),
	});
}

/**
 * Create the file's fixture root. The caller owns the handle for the file's
 * lifetime; `afterAll` below removes it after the drain.
 */
export function piSessionFixture(): { root: string; cleanup: () => void } {
	const fixture = setupTestEnvironment(TMP_PREFIX);
	liveFixtures.push(fixture.cleanup);
	return { root: fixture.tmpDir, cleanup: fixture.cleanup };
}

/**
 * Put the environment back, then remove every fixture root this file owns. The
 * drain first covers this process's writers; the loaded copy's NDJSON sinks
 * were already settled by `dispose()`'s in-graph `session_shutdown` and
 * `flushAllNdjsonWriters()`. The copy's module-scope persist queues stay
 * unreachable (header, point 5).
 */
afterAll(async () => {
	await drainBackgroundWritesForTests();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const cleanup of liveFixtures.splice(0)) cleanup();
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});
