/**
 * #2657 / #4242 item 3: the CLASS decides what a session registers.
 *
 * Recurrence it prevents: the `tool_call` seam registered `path.dirname(
 * filePath)` — a raw directory answer, not an ownership one — and the #4532
 * shape that replaced it registered the resolved analysis root for EVERY
 * class. An adopted project therefore became a registered SESSION root, which
 * launders `adopted` into `session` for `ClientRegistry.analysisRootModeForFile`
 * (`clients/lsp/client-registry.ts`), skips the `admitAdoptedRoot` gate
 * (cap 2, 60 s idle, project-local-binary refusal) and spends the FIFO(128)
 * session budget instead. A linked worktree has the opposite requirement: it is
 * its own workspace with its own `.pi-lens.json`, and `resolveServerRoot`'s
 * #2052 gate refuses a file outside every registered root, so it MUST be
 * registered — as the worktree root, never as the edited file's directory.
 *
 * Real: `handleToolCall` (the production call site), `resolveSessionConfigRoot`,
 * the real `initLSPConfig` loader and its session-root registry, the real
 * `ClientRegistry` that answers `analysisRootModeForFile` and gates
 * `admitAdoptedRoot`. No module is mocked and no language server is spawned.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	resolveAnalysisRoot,
	resolveAnalysisRootPath,
} from "../../../clients/analysis-root.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { ClientRegistry } from "../../../clients/lsp/client-registry.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	getSessionRootsForTelemetry,
	isSessionRootRegistered,
	resetSessionRootsForTests,
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
let runtime: RuntimeCoordinator;
let scratchHomes: string[] = [];

/** index.ts's per-cwd memo, without its registry re-check (same effect here). */
const initialized = new Set<string>();
async function memoizedInit(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	if (initialized.has(key)) return;
	await initLSPConfig(key);
	initialized.add(key);
}

/** One `tool_call` for `filePath`, through the production handler. */
async function readCall(
	filePath: string,
	cwd: string,
	index: number,
): Promise<void> {
	const deps = {
		event: {
			toolName: "read",
			toolCallId: `class-2657-${index}`,
			input: { path: filePath },
		},
		ctx: { cwd },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: memoizedInit,
		updateLspStatus: () => {},
		resetLSPService: () => {},
		sessionId: "pi-lens-class-2657-probe",
	} as unknown as Parameters<typeof handleToolCall>[0];
	await runHandlerExpectingNoThrow(() => handleToolCall(deps));
}

/** The registry's answer, on a real ClientRegistry whose session is `cwd`. */
function registryFor(cwd: string): ClientRegistry {
	return new ClientRegistry(
		{
			releaseNotifyWrite: () => {},
			forgetReadiness: () => {},
			forgetNotifyBacklog: () => {},
			clearStallDemotion: () => {},
			rearmFirstContact: () => {},
			noteDiagnosticsPublished: () => {},
		},
		undefined,
		cwd,
	);
}

/**
 * A checkout with one linked worktree, written as git writes it: `<repo>/.git`
 * is a directory (the shared commondir), `<worktree>/.git` is a file holding
 * `gitdir: <repo>/.git/worktrees/<name>`, and that gitdir's `commondir` points
 * back at the shared `.git`. `resolveGitCheckout`/`resolveLinkedWorktreeOwner`
 * read exactly these files, so no `git` child is needed to classify the file.
 */
function writeLinkedWorktree(root: string): { repo: string; worktree: string } {
	const repo = path.join(root, "repo");
	const worktree = path.join(root, "repo-wt");
	const gitDir = path.join(repo, ".git");
	const linkedGitDir = path.join(gitDir, "worktrees", "repo-wt");
	fs.mkdirSync(linkedGitDir, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);
	fs.writeFileSync(path.join(linkedGitDir, "commondir"), "../..\n");
	return { repo, worktree };
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2657-registration-class-");
	resetLSPConfigStateForTests();
	resetSessionRootsForTests();
	resetDegradationLedger();
	initialized.clear();
	scratchHomes = [];
	// The language server is the process boundary: a service double keeps this a
	// measurement of the registration rule, not of a spawn.
	resetLSPService();
	const service = makeLspServiceDouble({ supportsLSP: () => false });
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service as Record<string, unknown>,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
	runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-class-2657-probe" });
	runtime.beginTurn();
});

afterEach(() => {
	resetLSPService();
	resetLSPConfigStateForTests();
	resetSessionRootsForTests();
	env.cleanup();
	for (const home of scratchHomes)
		fs.rmSync(home, { recursive: true, force: true });
	scratchHomes = [];
});

describe("the analysis-root class decides what a session registers (#2657, #4242)", () => {
	it("registers nothing for an adopted project and keeps it adopted (#4242 item 3)", async () => {
		// A fixture whose own marker makes it eligible to be adopted needs its
		// OWN home, so the $HOME ceiling is the fixture's, not the runner's
		// (#4230 D1: siblings below $HOME are adopted; $HOME and above are
		// refused). Kept under the repo, not the OS temp tree, so the temp-root
		// refusal is not what the case is measuring.
		const home = fs.mkdtempSync(
			path.join(process.cwd(), ".analysis-root-class-home-"),
		);
		scratchHomes.push(home);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		const session = path.join(home, "code", "a");
		const adopted = path.join(home, "code", "b");
		fs.mkdirSync(path.join(session, "src"), { recursive: true });
		fs.mkdirSync(path.join(adopted, "src"), { recursive: true });
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(adopted, "package.json"), "{}\n");
		const adoptedFile = path.join(adopted, "src", "foreign.ts");
		try {
			runtime.projectRoot = session;
			await initLSPConfig(session);
			const before = getSessionRootsForTelemetry(200);
			expect(before).toEqual([session]);
			// The classification this case is about, before any edit.
			expect(resolveAnalysisRoot(adoptedFile, session)).toBe("adopted");

			await readCall(adoptedFile, session, 1);

			// 1. The session registered NOTHING for the adopted project …
			expect(getSessionRootsForTelemetry(200)).toEqual(before);
			expect(isSessionRootRegistered(adopted)).toBe(false);
			// … 2. so the file's class is unchanged for the LSP …
			const registry = registryFor(session);
			expect(registry.analysisRootModeForFile(adoptedFile)).toBe("adopted");
			// … 3. which is exactly the gate `ClientRegistry.admitAdoptedRoot`
			// opens: it declines any file whose mode is not `adopted`. On the
			// #4532 registration shape this returns false because the adopted
			// root was registered as a session root and the mode read `session`.
			const adoptedRoot = resolveAnalysisRootPath(adoptedFile, session);
			expect(adoptedRoot).toBe(adopted);
			expect(
				(
					registry as unknown as {
						admitAdoptedRoot(root: string, filePath: string): boolean;
					}
				).admitAdoptedRoot(adoptedRoot as string, adoptedFile),
			).toBe(true);
			// The adopted class is not a session-bookkeeping population either.
			expect(
				getDegradationSummary().some(
					(group) => group.kind === "lsp-session-root-evicted",
				),
			).toBe(false);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("registers the worktree root for a linked-worktree file, never its directory", async () => {
		// A linked worktree of the session's checkout, written as the metadata git
		// itself writes (#2657): the worktree's `.git` is a FILE naming a
		// worktree-private gitdir, and that gitdir's `commondir` points at the
		// shared `.git`. No child process is needed, and the class assertion
		// below reds if the fixture ever stops resolving as a worktree. The
		// checkout is a DIRECT child of the temp root with no `pi-lens-` prefix:
		// a pi-owned temp path is refused as an analysis root, which is the
		// intended-skip class and not what this case measures (#4560).
		const checkoutRoot = path.join(
			env.tmpDir,
			"..",
			`capture-2657-worktree-${process.pid}`,
		);
		const { repo, worktree } = writeLinkedWorktree(checkoutRoot);
		const worktreeFile = path.join(worktree, "src", "sibling.ts");
		fs.mkdirSync(path.dirname(worktreeFile), { recursive: true });
		fs.writeFileSync(worktreeFile, "export const value = 1;\n");

		try {
			runtime.projectRoot = repo;
			await initLSPConfig(repo);
			expect(getSessionRootsForTelemetry(200)).toEqual([repo]);
			expect(resolveAnalysisRoot(worktreeFile, repo)).toBe("linked-worktree");

			await readCall(worktreeFile, repo, 2);

			// Exactly two roots: the session's own, and the worktree's.
			expect([...getSessionRootsForTelemetry(200)].sort()).toEqual(
				[repo, worktree].sort(),
			);
			expect(isSessionRootRegistered(worktree)).toBe(true);
			// The edited file's own directory is NOT a root: that was the #2657
			// population (one registration per directory touched).
			expect(isSessionRootRegistered(path.dirname(worktreeFile))).toBe(false);
			// The class survives registration, so dispatch, the writers and the
			// delivery rung keep treating it as a linked worktree.
			expect(registryFor(repo).analysisRootModeForFile(worktreeFile)).toBe(
				"linked-worktree",
			);
			// Nothing was evicted: the population is workspaces, not directories.
			expect(
				getDegradationSummary().filter(
					(group) => group.kind === "lsp-session-root-evicted",
				),
			).toHaveLength(0);
		} finally {
			fs.rmSync(checkoutRoot, { recursive: true, force: true });
		}
	});
});
