/**
 * Regression coverage for #1127 (opengrep respawn churn, #1122 Phase C).
 *
 * `LSPService`'s circuit breaker (`clients/lsp/index.ts`) only counted
 * spawn/initialize FAILURES toward `failureCounts` → exponential cooldown →
 * permanent disable after BROKEN_PERMANENT_AFTER. A server whose spawn
 * SUCCEEDS but then exits shortly after (opengrep's post-init "Unhandled
 * message" crash) hit the "dead client — needs respawn" path instead, which
 * never touched the breaker: 37 respawns in one real session, never
 * converging.
 *
 * The fix adds a parallel `runtimeExitCounts` counter, fed only by EARLY
 * (uptime < RUNTIME_EXIT_UPTIME_THRESHOLD_MS) non-intentional exits, sharing
 * the same cooldown formula and the same `state.broken`/`permanentlyBroken`
 * maps as the existing breaker. Deliberate teardowns (`shutdown()` called by
 * pi-lens itself — session reset, #743 notify-backpressure eviction) set
 * `shutdownRequested` and must never count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

/** A fake client whose `isAlive()`/`wasShutdownIntentional()` the test drives directly. */
function makeFakeClient(serverId: string) {
	const fake = {
		alive: true,
		intentional: false,
		serverId,
		isAlive: () => fake.alive,
		wasShutdownIntentional: () => fake.intentional,
		shutdown: vi.fn().mockImplementation(async () => {
			fake.intentional = true; // mirrors clientShutdown() setting shutdownRequested
		}),
	};
	return fake;
}

function makeSpawnServer(id: string) {
	let spawnCount = 0;
	const spawn = vi.fn(async () => {
		spawnCount++;
		return {
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1000 + spawnCount,
			},
		};
	});
	return {
		id,
		name: id,
		extensions: [".fake"],
		root: async () => "C:/repo",
		spawn,
		getSpawnCount: () => spawnCount,
	};
}

describe("LSPService circuit breaker — post-init runtime exits (#1127)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("converges: N+1 early crash-loop respawns stop re-attaching and give up (fails on pre-fix unbounded respawn)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number>; clients: Map<string, unknown> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = "C:/repo/main.fake";
		const key = "opengrep:C:/repo";
		const BROKEN_PERMANENT_AFTER = 5;

		// Initial spawn — no existing (dead) client yet, so this goes straight
		// through spawnClient() and never touches the breaker.
		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();
		clients.at(-1)!.alive = false; // post-init crash — never called shutdown()

		// A generous bound so an unbounded-respawn regression fails the test
		// instead of looping forever: on pre-fix master this loop runs past
		// BROKEN_PERMANENT_AFTER without ever converging (permanentlyBroken never
		// gets set), and the final assertions below catch that.
		const MAX_CYCLES = BROKEN_PERMANENT_AFTER + 5;

		for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
			// Each crash cycle is two calls: the first detects the dead client
			// (counts the failure, sets the cooldown, and — because the cooldown
			// it JUST set is checked in that same call — returns undefined even
			// though the count itself moved). Simulate the cooldown elapsing
			// before it (real wall-clock waits, up to 5 minutes at the cap, would
			// make this test glacial) and confirm no respawn happens yet.
			internal.state.broken.delete(key);
			const detect = await service.getClientForFile(file);
			expect(detect).toBeUndefined();

			if (internal.permanentlyBroken.has(key)) {
				// Converged: give-up latched on this detection. No further spawn
				// attempt happens even though nothing else changed.
				break;
			}

			// Still within budget — clear the (just-set) cooldown again to reach
			// the actual respawn attempt, then kill the fresh client immediately.
			internal.state.broken.delete(key);
			const respawn = await service.getClientForFile(file);
			expect(respawn).toBeDefined();
			clients.at(-1)!.alive = false;
		}

		expect(internal.permanentlyBroken.has(key)).toBe(true);
		expect(internal.runtimeExitCounts.get(key)).toBe(BROKEN_PERMANENT_AFTER);
		// Exactly BROKEN_PERMANENT_AFTER spawns happened before give-up — the
		// breaker converged instead of respawning on every remaining iteration.
		expect(server.getSpawnCount()).toBe(BROKEN_PERMANENT_AFTER);

		// Further calls stay given-up: no new spawn, no new client.
		const spawnCountAtGiveUp = server.getSpawnCount();
		internal.state.broken.delete(key); // even if cooldown "elapses" again
		const after = await service.getClientForFile(file);
		expect(after).toBeUndefined();
		expect(server.getSpawnCount()).toBe(spawnCountAtGiveUp);
	});

	it("does NOT count a deliberate shutdown()-driven restart toward the breaker", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = "C:/repo/main.fake";
		const key = "opengrep:C:/repo";

		// Simulate 8 deliberate restarts (well past BROKEN_PERMANENT_AFTER=5) —
		// e.g. a resync/reopen-style path that calls shutdown() itself before
		// the client goes dead. None of these should count as failures.
		for (let i = 0; i < 8; i++) {
			internal.state.broken.delete(key);
			const result = await service.getClientForFile(file);
			expect(result).toBeDefined();
			const last = clients.at(-1)!;
			// Deliberate: our own shutdown() marks it intentional (mirrors #743
			// notify-backpressure eviction / session reset paths), and only THEN
			// does the client go dead — matches the real ordering where
			// clientShutdown() sets shutdownRequested before the process exits.
			await last.shutdown();
			last.alive = false;
		}

		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
		expect(server.getSpawnCount()).toBe(8);
	});

	it("does not count a runtime exit past the early-exit uptime threshold", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const client = makeFakeClient("opengrep");
		createLSPClient.mockResolvedValue(client);

		const file = "C:/repo/main.fake";
		const key = "opengrep:C:/repo";

		const first = await service.getClientForFile(file);
		expect(first).toBeDefined();

		// Backdate clientSpawnedAt so the "crash" reads as a long, healthy
		// uptime (well past the 60s early-exit threshold) rather than an
		// immediate post-init death.
		internal.state.clientSpawnedAt.set(key, Date.now() - 5 * 60_000);
		client.alive = false;

		internal.state.broken.delete(key);
		const second = await service.getClientForFile(file);
		expect(second).toBeDefined();

		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});
});
