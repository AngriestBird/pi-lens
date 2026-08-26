/**
 * Process singletons — state that must exist ONCE PER PROCESS, not once per
 * module evaluation (#2146).
 *
 * WHY THIS MODULE EXISTS. pi evaluates the pi-lens module graph more than once
 * in a single process: dogfood pass 3 measured one pid emitting `host_boot`
 * nine times, another four times. Source and compiled entries load through
 * separate module graphs, in-process subagent sessions re-enter the extension
 * loader, and vitest re-evaluates modules on `vi.resetModules()`. Every
 * module-scope `let` therefore exists N times, and any state whose CORRECTNESS
 * depends on being the process's only copy silently breaks:
 *
 *  - `session-lifecycle.ts`'s registered primary: evaluation 2 starts with an
 *    empty registration, classifies a subagent temp root as `primary`, and runs
 *    the full session_start battery the #473/#2129/#2133 guard exists to
 *    decline. Measured cost: three identical word-index full rebuilds in one
 *    90s burst, 240.8s of CPU for one index.
 *  - `instance-registry.ts`'s mutation tail: N tails are N concurrent
 *    read-modify-write cycles over one `instances.json`. Measured: three
 *    `instance-registry-corrupt` records in a 9s window, with two project roots
 *    and one live instance lost from the file.
 *
 * PRECEDENT, both in-repo and both cited rather than invented:
 *  - `clients/runtime-session.ts:1826` hangs `__piLensFirstSessionDone` /
 *    `__piLensWarmupScheduled` on `globalThis` for exactly this reason.
 *  - `clients/ndjson-logger.ts:125` does the versioned form: a
 *    `Symbol.for()` key, a schema string, a version number, and an explicit
 *    adopt-or-decline decision for a state written by a different build.
 *
 * This module generalizes the second one so each state family gets the same
 * treatment without re-deriving the protocol per site.
 *
 * WHAT BELONGS HERE. Only state that is WRONG when duplicated: process-wide
 * registrations, serialization points, and once-per-process latches. A memo or
 * cache that re-derives the same answer from a stable source (an env read, a
 * host probe) is merely wasteful when duplicated, not wrong, and stays at
 * module scope — see the class-sweep table in the #2146 PR body for the
 * per-family verdicts.
 *
 * VERSIONING AND THE OLDER-SHAPE FALLBACK. Two builds can meet in one process:
 * a stale `dist/` graph and a fresh source graph, or an extension reload after
 * an upgrade. Each family carries its own `version`. The rule is
 * adopt-if-compatible, reset otherwise:
 *
 *  - Same schema and same version -> ADOPT the existing value. This is the
 *    common case and the whole point of the module.
 *  - Anything else (missing schema, different schema, older version, NEWER
 *    version) -> do NOT adopt. A shape this build cannot read is not safely
 *    readable in either direction, so guessing is worse than starting clean.
 *    The cell is replaced with a fresh value from `create()` and ONE bounded
 *    `process-singleton-reset` degradation record is written per family
 *    (`recordDegradationOnce`, so a nine-evaluation process still records at
 *    most one row per family). Behavior after a reset is exactly today's
 *    module-scope behavior for that family, which is the fail-safe direction.
 *
 * The container key itself is versioned (`SINGLETON_HOST_KEY`). A future change
 * to the CONTAINER shape bumps the key, so an old container is simply not
 * found rather than mis-read.
 */

/**
 * STATIC IMPORTS: none, deliberately. This module must be a leaf.
 *
 * `instance-registry.ts` imports it, and the degradation ledger reaches
 * `instance-reaper.ts` (via extension-log -> file-utils -> git-tracked-ignore ->
 * safe-spawn -> resource-sampler), which imports the registry back. A static
 * `degradation-ledger.js` import here therefore closes a `no-client-cycles`
 * cycle, which CI's dependency-boundaries lane rejects. The ledger is reached
 * through a dynamic import instead — the escape `.dependency-cruiser.cjs`
 * sanctions by excluding `dynamic-import` from that rule. It also keeps the
 * door open for the ledger itself to adopt this module later (#2157 item 5).
 */

/** Bump only when the CONTAINER shape changes, never for a family's shape. */
const SINGLETON_HOST_KEY = Symbol.for("pi-lens.process-singletons.v1");

const SINGLETON_SCHEMA = "pi-lens.process-singletons";

/** Degradation kind emitted when an incompatible cell is discarded. */
export const PROCESS_SINGLETON_RESET_KIND = "process-singleton-reset";

interface SingletonCell {
	schema: string;
	version: number;
	value: unknown;
}

type SingletonContainer = Map<string, SingletonCell>;

const singletonHost = globalThis as typeof globalThis & {
	[key: symbol]: unknown;
};

/**
 * The process's one container. Deliberately created on first read rather than
 * at module scope of a single graph: whichever evaluation runs first wins, and
 * every later evaluation adopts it.
 */
function container(): SingletonContainer {
	const existing = singletonHost[SINGLETON_HOST_KEY];
	if (existing instanceof Map) return existing as SingletonContainer;
	const fresh: SingletonContainer = new Map();
	singletonHost[SINGLETON_HOST_KEY] = fresh;
	return fresh;
}

function isAdoptable(cell: unknown, version: number): cell is SingletonCell {
	if (!cell || typeof cell !== "object") return false;
	const candidate = cell as Partial<SingletonCell>;
	return (
		candidate.schema === SINGLETON_SCHEMA &&
		candidate.version === version &&
		candidate.value !== undefined
	);
}

/**
 * Write the bounded reset record through a dynamic import (see the no-static-
 * imports note at the top). Fire-and-forget and never throws: telemetry must
 * not break the path it observes, and this fires only when two incompatible
 * builds meet in one process.
 */
function recordIncompatibleCell(
	family: string,
	wantedVersion: number,
	found: Partial<SingletonCell>,
): void {
	const reason =
		`incompatible process singleton discarded (found schema=${String(found.schema)} ` +
		`version=${String(found.version)}, this build wants schema=${SINGLETON_SCHEMA} ` +
		`version=${wantedVersion})`;
	void import("./degradation-ledger.js")
		.then((ledger) => {
			ledger.recordDegradationOnce({
				kind: PROCESS_SINGLETON_RESET_KIND,
				subject: family,
				reason,
			});
		})
		.catch(() => {});
}

/**
 * Return the process-wide value for `family`, creating it on the first
 * evaluation that asks and adopting it on every later one.
 *
 * `version` describes the SHAPE of the value `create()` builds. Bump it when a
 * build changes that shape, so a graph carrying the old shape is discarded
 * instead of mis-read (see the module docstring's fallback rules).
 *
 * `create()` runs at most once per process per family, unless an incompatible
 * cell forced a reset.
 */
export function getProcessSingleton<T extends object>(
	family: string,
	version: number,
	create: () => T,
): T {
	const cells = container();
	const existing = cells.get(family);
	if (isAdoptable(existing, version)) return existing.value as T;
	if (existing !== undefined) {
		// An incompatible cell from another build. One bounded row per family:
		// nine evaluations must not write nine records (AGENTS.md's bounded-record
		// rule; `recordDegradationOnce` keys on kind + subject).
		recordIncompatibleCell(family, version, existing as Partial<SingletonCell>);
	}
	const value = create();
	cells.set(family, { schema: SINGLETON_SCHEMA, version, value });
	return value;
}

/**
 * Test-only: drop the process-wide container so the next
 * {@link getProcessSingleton} call rebuilds every family from `create()`.
 *
 * This clears the GLOBAL state, not a module-local copy — a reset that only
 * cleared module scope would be the very defect this module fixes, and would
 * make every suite that relies on isolation pass vacuously (catalog shape 7).
 */
export function _resetProcessSingletonsForTests(): void {
	singletonHost[SINGLETON_HOST_KEY] = new Map<string, SingletonCell>();
}

/**
 * Test-only: install a raw cell so a suite can exercise the older/newer-shape
 * fallback without needing two real builds in one process.
 */
export function _seedProcessSingletonCellForTests(
	family: string,
	cell: { schema?: string; version?: number; value?: unknown },
): void {
	container().set(family, cell as SingletonCell);
}

// --- Module-evaluation ordinal (#2146 observability) ---

const EVALUATION_ORDINAL_FAMILY = "module-evaluation-ordinal";
const EVALUATION_ORDINAL_VERSION = 1;

/**
 * How many times this process has evaluated the pi-lens module graph, 1-based.
 *
 * Called once, at module scope of `clients/startup-timing.ts`, so the number it
 * returns is the evaluation count of the graph that contains the extension
 * entry. It is carried on `host_boot.metadata.evaluationOrdinal` so a multi-eval
 * process is greppable from `latency.log` instead of having to be inferred by
 * counting `host_boot` lines per pid — the observability gap #2146 names.
 */
export function nextModuleEvaluationOrdinal(): number {
	const state = getProcessSingleton(
		EVALUATION_ORDINAL_FAMILY,
		EVALUATION_ORDINAL_VERSION,
		() => ({ evaluations: 0 }),
	);
	state.evaluations += 1;
	return state.evaluations;
}
