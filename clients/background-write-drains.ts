/**
 * Process-wide registry of "settle my deferred writes" functions, one per
 * evaluation of a module that owns a module-scope deferred writer (#4937).
 *
 * WHY. pi loads the built extension through its own jiti loader with
 * `moduleCache: false`, so a tier-2 test process holds a second, private copy of
 * every `clients/` module: the extension's. A deferred writer in that copy (a
 * worker snapshot persist, a debounced cache flush) is invisible to the test
 * side's own `import`, and its write lands after the fixture root was removed,
 * re-creating it. Master run 40967488612 leaked
 * `pi-lens-pi-session-yB7mpc` that way. Each such module registers its drain
 * here when it loads; the harness joins every copy's drain before it removes
 * the root (`tests/support/pi-session.ts`).
 *
 * STATIC IMPORTS: none, deliberately: a dependency leaf, so any module with a
 * deferred writer can register without a cycle.
 *
 * STATE. Keyed on `globalThis` with `Symbol.for`, not on module scope (the
 * module is itself evaluated once per copy) and not in `process-singletons`
 * (its test reset would drop the registration of a copy that is already
 * loaded). Entries are held strongly, in a plain Set: a drain is a module-level
 * function that its module keeps alive anyway, and no `WeakRef` is constructed
 * at module load (a test that stubs the global `WeakRef` counts every
 * construction, and `clients/dependency-checker.ts` imports the installer).
 *
 * STRICT DRAINS. A drain resolves only when its writer has nothing left to
 * land, and rejects when it cannot get there: a bounded wait or a scheduled
 * retry that read as "settled" would let the write land after the root was
 * removed, the defect this registry exists to close. A registering module
 * therefore registers a wrapper that checks its own pending state, not a bare
 * bounded helper.
 */

const REGISTRY_KEY = Symbol.for("pi-lens.background-write-drains.v1");

type Drain = () => Promise<unknown>;

const host = globalThis as typeof globalThis & { [key: symbol]: unknown };

function registry(): Set<Drain> {
	const existing = host[REGISTRY_KEY];
	if (existing instanceof Set) return existing as Set<Drain>;
	const fresh = new Set<Drain>();
	host[REGISTRY_KEY] = fresh;
	return fresh;
}

/**
 * Register `drain` for this module evaluation. It must resolve only once the
 * module's writer has nothing left to land, and reject when it cannot.
 */
export function registerBackgroundWriteDrain(drain: Drain): void {
	registry().add(drain);
}

/**
 * Test-only: run every registered drain, in registration order, and return
 * once all have settled. A drain that rejects rejects the pass: a teardown
 * that cannot settle a writer should fail its file loudly, not remove the root
 * under it.
 */
export async function drainRegisteredBackgroundWritesForTests(): Promise<void> {
	for (const drain of registry()) await drain();
}
