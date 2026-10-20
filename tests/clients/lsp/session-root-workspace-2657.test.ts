/**
 * #2657: the session registers a WORKSPACE, not every edited file's directory.
 *
 * Recurrence it prevents: `ensureLSPConfigInitialized` was called with
 * `path.dirname(filePath)` from the `tool_call` seam, so every directory an
 * agent touched became a registered session root. The registry is FIFO(128), so
 * a session touching 128 directories cycled it and evicted the project root
 * itself — the entry that carries the operator's `lsp.disabledServers` denial —
 * and the denial failed open (`lsp-session-root-evicted`) until something
 * re-registered that root. `getConfigForFile` also walked a population sized by
 * directories touched rather than by workspaces, on every dispatch.
 *
 * Real: `handleToolCall` (the production call site), `resolveSessionConfigRoot`,
 * the real `initLSPConfig` loader and its session-root registry,
 * `disabledPrimaries` (the denial reader) and the real degradation ledger. No
 * module is mocked: the language server is never spawned on this path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAnalysisRoot } from "../../../clients/analysis-root.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	ClientRegistry,
	type ClientGenerationHooks,
} from "../../../clients/lsp/client-registry.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	disabledPrimaries,
	getSessionRootsForTelemetry,
	isSessionRootRegistered,
} from "../../../clients/lsp/session-roots.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../../clients/runtime-tool-call.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../../clients/lsp/service-singleton.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { runHandlerExpectingNoThrow } from "../../support/handler-verdict.js";
import { setupTestEnvironment } from "../test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let workspace: string;
let runtime: RuntimeCoordinator;

/** index.ts's per-cwd memo, without its registry re-check (same effect here). */
async function memoizedInit(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	if (initialized.has(key)) return;
	await initLSPConfig(key);
	initialized.add(key);
}
const initialized = new Set<string>();

/** One `tool_call` for `filePath`, through the production handler. */
async function readCall(filePath: string, index: number): Promise<void> {
	const deps = {
		event: {
			toolName: "read",
			toolCallId: `2657-${index}`,
			input: { path: filePath },
		},
		ctx: { cwd: workspace },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		// The production wrapper adds a per-cwd memo (index.ts
		// `ensureLSPConfigInitialized`), so a repeated root loads once; the loader
		// below is what registers, and the memo is reproduced here rather than
		// re-loading 200 times.
		ensureLSPConfigInitialized: memoizedInit,
		updateLspStatus: () => {},
		resetLSPService: () => {},
		sessionId: "pi-lens-2657-probe",
	} as unknown as Parameters<typeof handleToolCall>[0];
	await runHandlerExpectingNoThrow(() => handleToolCall(deps));
}

beforeEach(async () => {
	env = setupTestEnvironment("pi-lens-2657-session-root-");
	workspace = path.join(env.tmpDir, "workspace");
	fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
	fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
	// The operator's denial lives at the workspace root, which is the entry the
	// per-directory registrations used to evict.
	fs.writeFileSync(
		path.join(workspace, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: ["typescript"] } }),
	);
	resetLSPConfigStateForTests();
	resetDegradationLedger();
	initialized.clear();
	// The language server is the process boundary: a service double keeps this a
	// measurement of the registration rule, not of 200 server round trips.
	resetLSPService();
	const service = makeLspServiceDouble({ supportsLSP: () => false });
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service as Record<string, unknown>,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = workspace;
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-2657-probe" });
	runtime.beginTurn();
	await initLSPConfig(workspace);
});

afterEach(() => {
	resetLSPService();
	resetLSPConfigStateForTests();
	env.cleanup();
	for (const dir of adoptedRoots.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("a session root is a workspace (#2657)", () => {
	it("keeps one registry entry across 200 edited files in 200 directories", async () => {
		// 200 files in 200 directories, as the issue's probe names them. The files
		// need not exist: `tool_call` resolves the config root BEFORE it decides
		// whether the target is there, which is also the order a read of a path
		// about to be created takes.
		const files = Array.from({ length: 200 }, (_, index) =>
			path.join(workspace, "src", `pkg-${index}`, "deep", `file-${index}.ts`),
		);
		// The denial applies to a deep file BEFORE the probe …
		expect(disabledPrimaries(files[199]).disabledServerIds).toContain(
			"typescript",
		);

		for (const [index, file] of files.entries()) await readCall(file, index);

		// … the registry still holds exactly one root (the workspace) …
		expect(getSessionRootsForTelemetry(200)).toEqual([workspace]);
		expect(isSessionRootRegistered(workspace)).toBe(true);
		// … no directory was ever registered as its own root …
		expect(isSessionRootRegistered(path.dirname(files[199]))).toBe(false);
		// … nothing was evicted, so the cap was never reached …
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "lsp-session-root-evicted",
			),
		).toHaveLength(0);
		// … and the denial is still in force at the end of the probe.
		expect(disabledPrimaries(files[199]).disabledServerIds).toContain(
			"typescript",
		);
	}, 60_000);

	it("registers a nested config owner below the workspace root", async () => {
		const nested = path.join(workspace, "packages", "app");
		fs.mkdirSync(path.join(nested, "src"), { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
		fs.writeFileSync(
			path.join(nested, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: ["opengrep"] } }),
		);
		const file = path.join(nested, "src", "index.ts");
		fs.writeFileSync(file, "export const x = 1;\n");

		await readCall(file, 900);

		// The nested owner is registered so its own config keeps applying, and
		// the population stays O(config owners), not O(directories).
		expect(getSessionRootsForTelemetry(200)).toContain(nested);
		expect(isSessionRootRegistered(path.dirname(file))).toBe(false);
	});

	// #4532 round 3 (HIGH-3): registering the ADOPTED project root as a session
	// root answers `session` from `analysisRootModeForFile` for every file in
	// it — not only the one a call named — so `admitAdoptedRoot` is skipped and
	// AGENTS.md's "Analysis-root invariant" (separate registry, cap two, no
	// project-local executables) stops applying to the whole project. Red on
	// the pre-fix resolver, which returned the analysis root for out-of-session
	// files.
	it("registers nothing for an adopted project and keeps its adopted class", async () => {
		// The project sits beside the checkout, not inside the run's temp tree:
		// a path under the pi-owned OS-temp tree is the intended-skip class
		// (`isPiOwnedTempPath`), i.e. mode `none`, not an adopted project.
		const adopted = adoptedProject();
		fs.mkdirSync(path.join(adopted, "src"), { recursive: true });
		fs.writeFileSync(path.join(adopted, "package.json"), "{}\n");
		const file = path.join(adopted, "src", "index.ts");
		fs.writeFileSync(file, "export const x = 1;\n");
		// The sibling the call never names is the one the cap has to keep
		// covering: on the pre-fix head it was `session` too.
		const sibling = path.join(adopted, "src", "other.ts");
		fs.writeFileSync(sibling, "export const y = 1;\n");
		expect(resolveAnalysisRoot(file, workspace)).toBe("adopted");
		const before = getSessionRootsForTelemetry(200);

		await readCall(file, 901);

		// No root was declared: not the project, not the edited directory.
		expect(getSessionRootsForTelemetry(200)).toEqual(before);
		expect(isSessionRootRegistered(adopted)).toBe(false);
		expect(isSessionRootRegistered(path.dirname(file))).toBe(false);
		// The registry still classifies the file — and its unnamed sibling — as
		// adopted, so the adopted admission path is reached (it early-returns
		// false for every other mode).
		const registry = new ClientRegistry(noopHooks(), undefined, workspace);
		expect(registry.analysisRootModeForFile(file)).toBe("adopted");
		expect(registry.analysisRootModeForFile(sibling)).toBe("adopted");
		expect(admit(registry, adopted, file)).toBe(true);
	});

	// The other half of the same branch (Lane A: "linked-worktree → register the
	// worktree root"): a worktree of the session's own repository is a workspace
	// of its own, so exactly one root is declared for it and its files keep the
	// `linked-worktree` class. Green on the pre-fix head too — the old resolver
	// already answered the worktree root for a sibling path — so this cell pins
	// the narrowing rather than reding it: the adopted cell above is the red.
	it("registers exactly one root for a linked worktree and keeps it linked-worktree", async () => {
		const worktree = addLinkedWorktree(workspace, "wt");
		const file = path.join(worktree, "src", "index.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const x = 1;\n");
		expect(resolveAnalysisRoot(file, workspace)).toBe("linked-worktree");
		const before = getSessionRootsForTelemetry(200);

		await readCall(file, 902);

		const after = getSessionRootsForTelemetry(200);
		expect(after).toHaveLength(before.length + 1);
		expect(after).toContain(worktree);
		expect(isSessionRootRegistered(path.dirname(file))).toBe(false);
		const registry = new ClientRegistry(noopHooks(), undefined, workspace);
		expect(registry.analysisRootModeForFile(file)).toBe("linked-worktree");
	});

	it("records no session root for a refused (none) path", async () => {
		// A vendor path inside the session has no workspace to declare: the
		// analysis root refuses it (`none`), and Lane A's rule registers nothing.
		const file = path.join(workspace, "node_modules", "dep", "index.js");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "module.exports = 1;\n");
		expect(resolveAnalysisRoot(file, workspace)).toBe("none");
		const before = getSessionRootsForTelemetry(200);

		await readCall(file, 903);

		expect(getSessionRootsForTelemetry(200)).toEqual(before);
		expect(isSessionRootRegistered(path.dirname(file))).toBe(false);
	});
});

/**
 * A linked worktree of `repo`, laid out the way `git worktree add` writes it:
 * `<repo>/.git/worktrees/<name>/commondir`, and a `.git` FILE in the worktree
 * naming that gitdir. Plain files, no git process — the classifier reads files
 * only (`clients/review-graph/git-identity.ts`), the same fixture
 * `client-registry-direct.test.ts` uses for the linked-worktree class.
 */
function addLinkedWorktree(repo: string, name: string): string {
	const gitDir = path.join(repo, ".git", "worktrees", name);
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
	const worktree = path.join(repo, name);
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
	fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
	return worktree;
}

const adoptedRoots: string[] = [];

/**
 * A marked project beside the checkout — the shape `resolveAnalysisRoot` calls
 * `adopted` (the same `process.cwd()` fixture `analysis-root-writers.test.ts`
 * and `client-registry-direct.test.ts` use). It must NOT sit in the run's
 * pi-owned temp tree: `isPiOwnedTempPath` refuses that whole tree as mode
 * `none`, which is a different cell.
 */
function adoptedProject(): string {
	const root = fs.mkdtempSync(path.join(process.cwd(), ".probe-4532-adopted-"));
	adoptedRoots.push(root);
	return root;
}

/** The registry hooks are generation bookkeeping this cell never exercises. */
function noopHooks(): ClientGenerationHooks {
	const noop = () => {};
	return {
		releaseNotifyWrite: noop,
		forgetReadiness: noop,
		forgetNotifyBacklog: noop,
		clearStallDemotion: noop,
		rearmFirstContact: noop,
		noteDiagnosticsPublished: noop,
	};
}

/**
 * `admitAdoptedRoot` is private; the review's probe reads it through the same
 * cast `client-registry-direct.test.ts` uses. It answers `false` for every mode
 * except `adopted`, so `true` proves the adopted path was reached (cap, idle
 * window and the project-local-binary refusal all live behind it).
 */
const admit = (registry: ClientRegistry, root: string, file: string): boolean =>
	(
		registry as unknown as {
			admitAdoptedRoot(root: string, filePath: string): boolean;
		}
	).admitAdoptedRoot(root, file);
