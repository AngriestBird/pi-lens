/**
 * A real in-process pi session for tests whose observable is the provider
 * request, not a handler's return value (tier 2, #4632 pilot).
 *
 * `createAgentSessionServices` builds pi's real services (extension runner,
 * resource loader, model runtime); `createAgentSessionFromServices` builds the
 * real `AgentSession`; pi-ai's `fauxProvider` answers every request and records
 * the messages pi actually sent. That is the only seam that can express a
 * defect about the prompt-cache prefix (#4631): a handler-return assertion
 * cannot see the list the provider receives after the host's own
 * post-processing.
 *
 * The caller owns the environment: `piSessionEnv(root)` names the three
 * variables, and `vi.stubEnv` pins them so `vi.unstubAllEnvs()` in the file's
 * teardown restores them (#4589). `startPiSession` refuses to run unless they
 * are pinned to this root, so a forgetful caller fails loudly instead of
 * writing the maintainer home. The pinned data dir is what session state and
 * caches resolve at call time; loggers bind their path at module load, so a
 * file still runs under the harness's per-worker home (#3721).
 * - `PI_LENS_TEST_MODE=0`, matching `tests/index-3521-fork-tree-witness.test.ts`,
 *   so `session_start` runs its production writes; `dispose()` drains them
 *   before the fixture root is removed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type AgentSession,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	type FauxResponseStep,
	type Message,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { CacheManager } from "../../clients/cache-manager.js";
import { drainBackgroundWritesForTests } from "../clients/test-utils.js";

/** One provider request: the messages the model received, in order. */
export type PiProviderRequest = ReadonlyArray<Message>;

export interface PiSessionOptions {
	/**
	 * Fixture root. The helper creates `proj/` (with its `.git` marker),
	 * `agent/`, `sessions/` and `data/` under it.
	 */
	root: string;
	/** Scripted provider replies, one per expected request (pi-ai `fauxProvider`). */
	responses: readonly FauxResponseStep[];
	/** Extension factories pi runs, in order. */
	extensionFactories: ReadonlyArray<(pi: ExtensionAPI) => void | Promise<void>>;
	/** `pi.getFlag` values, for example pi-lens's `no-lsp`. */
	flags?: ReadonlyMap<string, boolean | string>;
}

export interface PiSessionHandle {
	session: AgentSession;
	/** Every provider request, in order, deep-cloned as pi sent it. */
	requests: ReadonlyArray<PiProviderRequest>;
	/** Errors pi reported from an extension handler. */
	errors: ReadonlyArray<unknown>;
	/** Run one prompt to completion (tool calls included). */
	prompt(text: string): Promise<void>;
	/** Stage one `session-start-guidance` payload for the next request to inject. */
	stageGuidance(text: string): void;
	/** Dispose the session, drain its background writes, and restore the env. */
	dispose(): Promise<void>;
}

const FAUX_MODEL = {
	id: "faux-1",
	name: "Faux",
	contextWindow: 200_000,
	maxTokens: 4_096,
};

/** The environment a pi session needs, pinned under the caller's fixture root. */
export function piSessionEnv(root: string): Record<string, string> {
	return {
		PI_LENS_HOME: path.join(root, "home"),
		PILENS_DATA_DIR: path.join(root, "data"),
		PI_LENS_TEST_MODE: "0",
	};
}

export async function startPiSession(
	options: PiSessionOptions,
): Promise<PiSessionHandle> {
	const cwd = path.join(options.root, "proj");
	const agentDir = path.join(options.root, "agent");
	const sessionsDir = path.join(options.root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });

	assertPinnedEnv(options.root);

	const faux = fauxProvider({ models: [FAUX_MODEL] });
	const requests: PiProviderRequest[] = [];
	faux.setResponses(
		options.responses.map((step) => (context, streamOptions, state, model) => {
			requests.push(context.messages.map((m) => structuredClone(m)));
			return typeof step === "function"
				? step(context, streamOptions, state, model)
				: structuredClone(step);
		}),
	);

	try {
		const modelRuntime = await ModelRuntime.create({
			modelsPath: null,
			refreshOnCreate: false,
			authPath: path.join(agentDir, "auth.json"),
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const model = modelRuntime.getModel("faux", FAUX_MODEL.id);
		if (!model) throw new Error("the faux provider registered no model");
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			extensionFlagValues: new Map(options.flags ?? []),
			resourceLoaderOptions: {
				extensionFactories: [...options.extensionFactories],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(cwd, sessionsDir),
			model,
		});
		const errors: unknown[] = [];
		await session.bindExtensions({
			onError: (error: unknown) => errors.push(error),
		});
		const cache = new CacheManager(false);
		let disposed = false;
		return {
			session,
			requests,
			errors,
			async prompt(text) {
				await session.prompt(text);
			},
			stageGuidance(text) {
				cache.writeCache("session-start-guidance", { content: text }, cwd);
			},
			async dispose() {
				if (disposed) return;
				disposed = true;
				session.dispose();
				await drainBackgroundWritesForTests();
			},
		};
	} catch (error) {
		throw error;
	}
}

/**
 * Fail closed on an unpinned environment: the session writes real project state,
 * so a caller that skipped `piSessionEnv` + `vi.stubEnv` would land it in the
 * worker home (or worse).
 */
function assertPinnedEnv(root: string): void {
	const expected = piSessionEnv(root);
	const missing = Object.entries(expected).filter(
		([key, value]) => process.env[key] !== value,
	);
	if (missing.length > 0)
		throw new Error(
			`pi-session: pin ${missing.map(([key]) => key).join(", ")} with vi.stubEnv(piSessionEnv(root)); unpinned env would write outside ${root}`,
		);
}
