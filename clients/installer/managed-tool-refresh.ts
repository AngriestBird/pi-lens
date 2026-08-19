/**
 * Periodic version refresh for pi-lens's managed tools (#1730, #1747).
 *
 * #1730 covered the npm strategy. #1747 extends the SAME cadence, stamp file,
 * session budget and degradation kind to the other five rather than building a
 * second mechanism: github (27 entries), pip (6), archive (4), maven (1) and
 * gem (1) were all frozen at whatever the installer resolved on day one,
 * because `installTool` only runs when the tool is ABSENT. The only per-
 * strategy difference is the re-resolution step, which lives in
 * `installer/index.ts`'s `refreshManagedTool`.
 *
 * `~/.pi-lens/tools/package.json` records ranges, not versions — `npm install
 * knip` writes `"knip": "^6.4.1"` and a lockfile pinning 6.4.1. Nothing ever
 * re-resolved that range, so the managed copy stayed on the version present at
 * first install for the life of the machine. A managed knip 28 minors behind
 * produced 62 unused-export findings on a tree the same project's own knip
 * reported clean, and acting on those findings deletes live code. Every managed
 * npm tool drifts the same way; a stale pyright or biome is the same wrong
 * verdict, quieter.
 *
 * The policy, and the constraints each part answers:
 *
 * - Bounded. At most `maxPerSession` tools (default 1) are refreshed per
 *   session, and each tool is eligible again only once per `intervalMs`
 *   (default 7 days). A managed tools tree with 22 entries therefore costs at
 *   most one `npm update` spawn per session, never one per run and never a
 *   22-package burst.
 * - Off the hot path. `runManagedToolRefresh` is never awaited by a caller
 *   that serves a user request; `runtime-session.ts` schedules it on an
 *   unref'd background timer after `session_start` has already returned.
 * - Non-blocking for availability. A refresh failure never removes or hides
 *   the installed copy. `npm update` leaves the existing tree in place, and
 *   this module never touches `node_modules` itself, so the current version
 *   keeps serving.
 * - Re-armed per session, not per process. The per-session budget is keyed to
 *   the degradation ledger's session generation, so a long-lived process that
 *   serves many `/new` sessions re-checks eligibility each time — and the
 *   REAL cooldown lives in the persisted stamp, not in process memory, so a
 *   restart loop cannot turn a 7-day cadence into an every-launch one.
 * - Empty is not the same as errored. A missing stamp file means "never
 *   refreshed" and makes every tool eligible. An UNREADABLE stamp file means
 *   the cadence is unknown; the session degrades once and refreshes nothing,
 *   rather than treating unknown as fresh (drift forever) or as stale (a
 *   22-package burst on every session).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { commitDurableStoreAsync } from "../durable-store.js";
import {
	pmBinary,
	resolveNodePackageManager,
	updateArgs,
} from "../package-manager.js";
import { safeSpawnAsync } from "../safe-spawn.js";
import { logSessionStart } from "../sessionstart-logger.js";
import {
	getManagedToolsDir,
	getRefreshableManagedTools,
	isManagedToolPresent,
	type ManagedToolStrategy,
	npmToolNeedsPostinstall,
	refreshManagedTool,
} from "./index.js";
import {
	managedToolRefreshesThisSession,
	noteManagedToolRefreshAttempt,
} from "./managed-tool-refresh-session.js";

const STATE_FILENAME = ".refresh-state.json";
const STATE_VERSION = 1;

/** Default per-tool refresh cadence: once a week. */
const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Cooldown after a FAILED refresh. Shorter than the success cadence — a failure
 * is usually a transient network or registry problem worth retrying sooner —
 * but still a real cooldown, so a permanently offline machine spawns at most
 * one `npm update` per tool per day rather than one per session.
 */
const DEFAULT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_SESSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

function numericEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function refreshIntervalMs(): number {
	return numericEnv("PI_LENS_TOOL_REFRESH_INTERVAL_MS", DEFAULT_INTERVAL_MS);
}

function retryIntervalMs(): number {
	return numericEnv("PI_LENS_TOOL_REFRESH_RETRY_MS", DEFAULT_RETRY_INTERVAL_MS);
}

function maxPerSession(): number {
	return numericEnv(
		"PI_LENS_TOOL_REFRESH_MAX_PER_SESSION",
		DEFAULT_MAX_PER_SESSION,
	);
}

function refreshTimeoutMs(): number {
	return numericEnv("PI_LENS_INSTALL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

// --- Persisted state ---

export interface ManagedToolRefreshEntry {
	/** When this tool's refresh last ran, successful or not. */
	checkedAt: number;
	/** Version installed after that run, when it could be read. */
	version?: string;
	/**
	 * What the tool's coordinate resolved to at that run — a GitHub release tag,
	 * an archive URL, a Maven GAV (#1747). This is the field that makes "did
	 * anything move?" answerable WITHOUT downloading: a github refresh that sees
	 * the same tag, or an archive refresh that sees the same pinned URL, stops
	 * here. npm and pip/gem leave it unset; their package manager owns the
	 * comparison.
	 */
	resolutionId?: string;
	/**
	 * `ETag` from the last GitHub `releases/latest` response (#1747), replayed as
	 * `If-None-Match`. A 304 answer costs no rate-limit quota and no download,
	 * which is what keeps 27 release-installed tools cheap. Written only after a
	 * SUCCESSFUL refresh: replaying an ETag from a run whose download failed
	 * would turn the retry into a 304 and skip the install forever.
	 */
	etag?: string;
	/** The run failed; `retryIntervalMs` applies instead of `intervalMs`. */
	failed?: boolean;
}

export interface ManagedToolRefreshState {
	version: number;
	tools: Record<string, ManagedToolRefreshEntry>;
}

/**
 * Reading the stamp has three outcomes, and collapsing any two of them is the
 * bug: `empty` (no file yet — everything is genuinely due) must not read as
 * `unreadable` (cadence unknown — refresh nothing this session), and neither
 * may read as `ok` with an empty map.
 */
export type ManagedToolRefreshStateRead =
	| { status: "ok"; state: ManagedToolRefreshState }
	| { status: "empty"; state: ManagedToolRefreshState }
	| { status: "unreadable"; reason: string };

function emptyState(): ManagedToolRefreshState {
	return { version: STATE_VERSION, tools: {} };
}

export function getManagedToolRefreshStatePath(): string {
	return path.join(getManagedToolsDir(), STATE_FILENAME);
}

/** Coerce one parsed entry, dropping anything whose shape we cannot trust. */
function parseEntry(value: unknown): ManagedToolRefreshEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.checkedAt !== "number") return undefined;
	if (!Number.isFinite(candidate.checkedAt)) return undefined;
	return {
		checkedAt: candidate.checkedAt,
		...(typeof candidate.version === "string" && {
			version: candidate.version,
		}),
		...(typeof candidate.resolutionId === "string" && {
			resolutionId: candidate.resolutionId,
		}),
		...(typeof candidate.etag === "string" && { etag: candidate.etag }),
		...(candidate.failed === true && { failed: true }),
	};
}

function parseState(contents: string): ManagedToolRefreshState {
	const parsed: unknown = JSON.parse(contents);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("refresh-state root is not an object");
	}
	const rawTools = (parsed as { tools?: unknown }).tools;
	if (!rawTools || typeof rawTools !== "object" || Array.isArray(rawTools)) {
		throw new Error("refresh-state.tools is not an object");
	}
	const tools: Record<string, ManagedToolRefreshEntry> = {};
	for (const [toolId, value] of Object.entries(
		rawTools as Record<string, unknown>,
	)) {
		const entry = parseEntry(value);
		if (entry) tools[toolId] = entry;
	}
	return { version: STATE_VERSION, tools };
}

export async function readManagedToolRefreshState(): Promise<ManagedToolRefreshStateRead> {
	let contents: string;
	try {
		contents = await fs.readFile(getManagedToolRefreshStatePath(), "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ENOENT is the honest "never refreshed" answer. A permission error or a
		// directory in the file's place is NOT — that is unknown cadence.
		if (code === "ENOENT") return { status: "empty", state: emptyState() };
		return { status: "unreadable", reason: code ?? "read error" };
	}
	try {
		return { status: "ok", state: parseState(contents) };
	} catch (err) {
		return { status: "unreadable", reason: (err as Error).message };
	}
}

/**
 * Commit one tool's stamp under the durable-store lock, merging against
 * whatever a sibling pi-lens process wrote since this process read.
 *
 * A torn or corrupt file is recovered as empty HERE (rather than thrown) so a
 * later commit can replace it. The read path above still reports `unreadable`,
 * which is what suppresses the refresh; this side only has to make sure the
 * file becomes valid again instead of staying corrupt forever.
 */
async function writeRefreshStamp(
	toolId: string,
	entry: ManagedToolRefreshEntry,
): Promise<void> {
	try {
		await fs.mkdir(getManagedToolsDir(), { recursive: true });
		await commitDurableStoreAsync<ManagedToolRefreshState>({
			path: getManagedToolRefreshStatePath(),
			deserialize: (contents) => {
				if (contents === undefined) return emptyState();
				try {
					return parseState(contents);
				} catch {
					return emptyState();
				}
			},
			merge: (disk) => {
				disk.tools[toolId] = entry;
				return disk;
			},
			serialize: (disk) => JSON.stringify(disk, null, 2),
			waitMs: 2000,
			retryMs: 25,
			staleMs: 60_000,
			timeoutMessage: "Timed out waiting for managed-tool refresh-state lock",
			onContention: "skip-log",
			logContention: () => {
				logSessionStart(
					`managed-tool-refresh ${toolId}: stamp deferred because another process owns the lock`,
				);
			},
		});
	} catch (err) {
		// A stamp that cannot be written means this tool is eligible again next
		// session. That is noisier than intended but never wrong, so it degrades
		// rather than throwing into the background timer.
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: toolId,
			reason: `stamp write failed: ${(err as Error).message}`,
		});
		logSessionStart(
			`managed-tool-refresh ${toolId}: stamp write failed (${(err as Error).message})`,
		);
	}
}

/**
 * Record that a tool was just INSTALLED, so the cadence starts from the install
 * (#1747).
 *
 * An install has performed the freshest possible resolution, so leaving the
 * stamp absent would make the refresh treat a brand-new tool as never checked
 * and re-resolve it the moment the timer next fired. Recording the resolution
 * identity here is also what spares the archive and maven entries a redundant
 * re-download: their refresh compares the recorded pin against the registry's,
 * and an install writes exactly the pin it used.
 *
 * Called from `installer/index.ts`'s `finishInstallAttempt`, the one funnel all
 * six install strategies pass through.
 */
export async function stampManagedToolInstall(
	toolId: string,
	resolutionId?: string,
	now: number = Date.now(),
): Promise<void> {
	await writeRefreshStamp(toolId, {
		checkedAt: now,
		...(resolutionId !== undefined && { resolutionId }),
	});
}

// --- Per-session budget ---

/**
 * Refreshes still allowed in the CURRENT session. The counter itself lives in
 * `managed-tool-refresh-session.ts` because its reset has to be reachable from
 * `handleSessionStart`, and importing THIS module for it would drag the
 * installer registry onto the `session_start` path.
 */
function remainingSessionBudget(): number {
	return Math.max(0, maxPerSession() - managedToolRefreshesThisSession());
}

// --- Candidate selection ---

export interface RefreshCandidate {
	toolId: string;
	strategy: ManagedToolStrategy;
	/** npm/pip/gem only; github/maven/archive resolve from their own spec. */
	packageName?: string;
}

/**
 * Registry entries that are BOTH refreshable and actually installed where
 * pi-lens installs. An entry pi-lens has never installed has no version to
 * move, and `npm update`, `pip install -U` or a release download on one would
 * turn a refresh into an unrequested install.
 *
 * The presence check is filesystem-only for every strategy (#1747), so scanning
 * all 60-odd registry entries on a background timer costs no spawn and no
 * network.
 */
async function installedRefreshCandidates(): Promise<RefreshCandidate[]> {
	const candidates: RefreshCandidate[] = [];
	for (const tool of getRefreshableManagedTools()) {
		if (!(await isManagedToolPresent(tool.toolId))) continue;
		candidates.push({
			toolId: tool.toolId,
			strategy: tool.strategy,
			...(tool.packageName !== undefined && { packageName: tool.packageName }),
		});
	}
	return candidates;
}

/**
 * Which candidates are due, oldest stamp first. A tool with no stamp sorts
 * first (it has never been refreshed); ties break on toolId so the selection
 * is deterministic and a starved tool eventually reaches the front.
 */
export function selectStaleTools(
	candidates: readonly RefreshCandidate[],
	state: ManagedToolRefreshState,
	now: number,
): RefreshCandidate[] {
	const interval = refreshIntervalMs();
	const retry = retryIntervalMs();
	const due = candidates.filter((candidate) => {
		const entry = state.tools[candidate.toolId];
		if (!entry) return true;
		const cooldown = entry.failed ? retry : interval;
		return now - entry.checkedAt >= cooldown;
	});
	return due.sort((a, b) => {
		const aAt = state.tools[a.toolId]?.checkedAt ?? 0;
		const bAt = state.tools[b.toolId]?.checkedAt ?? 0;
		return aAt !== bAt ? aAt - bAt : a.toolId.localeCompare(b.toolId);
	});
}

// --- Refresh ---

/** Version recorded in an installed package's own `package.json`, if readable. */
async function readInstalledVersion(
	packageName: string,
): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(
			path.join(
				getManagedToolsDir(),
				"node_modules",
				packageName,
				"package.json",
			),
			"utf-8",
		);
		const parsed: unknown = JSON.parse(raw);
		const version = (parsed as { version?: unknown } | null)?.version;
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

export type ManagedToolRefreshSkipReason =
	| "disabled"
	| "session-budget"
	| "no-candidates"
	| "state-unreadable"
	| "nothing-due";

export interface ManagedToolRefreshResult {
	toolId: string;
	strategy: ManagedToolStrategy;
	packageName?: string;
	previousVersion?: string;
	currentVersion?: string;
	changed: boolean;
	ok: boolean;
}

export interface ManagedToolRefreshOutcome {
	skipped?: ManagedToolRefreshSkipReason;
	refreshed: ManagedToolRefreshResult[];
}

/**
 * Refresh one tool, choosing the mechanism its install strategy needs (#1747).
 *
 * npm stays here because it needs the package-manager resolver; every other
 * strategy delegates to `refreshManagedTool` in the installer, which owns the
 * GitHub release query, the `pip install -U` ladder, `gem install`, and the
 * pinned-coordinate comparison for maven/archive. Both halves share ONE budget,
 * ONE stamp file and ONE degradation kind, so adding five strategies does not
 * turn one spawn per session into six.
 */
async function refreshOne(
	candidate: RefreshCandidate,
	entry: ManagedToolRefreshEntry | undefined,
	now: number,
): Promise<ManagedToolRefreshResult> {
	return candidate.strategy === "npm"
		? refreshNpmOne(candidate, now)
		: refreshNonNpmOne(candidate, entry, now);
}

async function refreshNonNpmOne(
	candidate: RefreshCandidate,
	entry: ManagedToolRefreshEntry | undefined,
	now: number,
): Promise<ManagedToolRefreshResult> {
	const previousVersion = entry?.version;
	const startedAt = Date.now();
	const attempt = await refreshManagedTool(candidate.toolId, {
		...(entry?.resolutionId !== undefined && {
			resolutionId: entry.resolutionId,
		}),
		...(entry?.etag !== undefined && { etag: entry.etag }),
		...(previousVersion !== undefined && { version: previousVersion }),
	});
	const elapsedMs = Date.now() - startedAt;

	if (!attempt.ok) {
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: candidate.toolId,
			reason: `${candidate.strategy} refresh failed: ${attempt.reason ?? "unknown"}`,
		});
		logSessionStart(
			`managed-tool-refresh ${candidate.toolId}: ${candidate.strategy} refresh failed after ${elapsedMs}ms — keeping ${previousVersion ?? "installed"} (${attempt.reason ?? "unknown"})`,
		);
		await writeRefreshStamp(candidate.toolId, {
			checkedAt: now,
			failed: true,
			...(previousVersion !== undefined && { version: previousVersion }),
			...(entry?.resolutionId !== undefined && {
				resolutionId: entry.resolutionId,
			}),
			// Deliberately NOT carrying `entry.etag` forward: a stamp that replays
			// the validator of a run whose download failed would get a 304 next
			// time and skip the install that never happened.
		});
		return {
			toolId: candidate.toolId,
			strategy: candidate.strategy,
			...(candidate.packageName !== undefined && {
				packageName: candidate.packageName,
			}),
			previousVersion,
			currentVersion: previousVersion,
			changed: false,
			ok: false,
		};
	}

	const currentVersion = attempt.version;
	const changed = !attempt.unchanged;
	await writeRefreshStamp(candidate.toolId, {
		checkedAt: now,
		...(currentVersion !== undefined && { version: currentVersion }),
		...(attempt.resolutionId !== undefined && {
			resolutionId: attempt.resolutionId,
		}),
		...(attempt.etag !== undefined && { etag: attempt.etag }),
	});
	logSessionStart(
		changed
			? `managed-tool-refresh ${candidate.toolId}: ${previousVersion ?? "unknown"} → ${currentVersion ?? "unknown"} via ${candidate.strategy} (${elapsedMs}ms)`
			: `managed-tool-refresh ${candidate.toolId}: unchanged at ${currentVersion ?? previousVersion ?? "unknown"} via ${candidate.strategy} (${elapsedMs}ms)`,
	);
	return {
		toolId: candidate.toolId,
		strategy: candidate.strategy,
		...(candidate.packageName !== undefined && {
			packageName: candidate.packageName,
		}),
		previousVersion,
		currentVersion,
		changed,
		ok: true,
	};
}

async function refreshNpmOne(
	candidate: RefreshCandidate,
	now: number,
): Promise<ManagedToolRefreshResult> {
	const toolsDir = getManagedToolsDir();
	// Every npm candidate carries a packageName; `getRefreshableManagedTools`
	// drops the ones that do not.
	const packageName = candidate.packageName as string;
	const previousVersion = await readInstalledVersion(packageName);
	const pm = await resolveNodePackageManager(toolsDir);
	const testNpmScript =
		process.env.PI_LENS_TEST_MODE === "1"
			? process.env.PI_LENS_TEST_NPM_SCRIPT
			: undefined;
	const command = testNpmScript ? process.execPath : pmBinary(pm);
	const args = [
		...(testNpmScript ? [testNpmScript] : []),
		...updateArgs(pm, packageName, {
			ignoreScripts: !npmToolNeedsPostinstall(packageName),
		}),
	];

	const startedAt = Date.now();
	const spawned = await safeSpawnAsync(command, args, {
		cwd: toolsDir,
		timeout: refreshTimeoutMs(),
		ignoreAmbientSignal: true,
		lifetimeCoupled: true,
	});
	const elapsedMs = Date.now() - startedAt;

	if (spawned.status !== 0 || spawned.error) {
		const reason = (spawned.error?.message ?? spawned.stderr ?? "").slice(
			0,
			200,
		);
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: candidate.toolId,
			reason: `${pm} update failed: ${reason || "non-zero exit"}`,
		});
		logSessionStart(
			`managed-tool-refresh ${candidate.toolId}: ${pm} update failed after ${elapsedMs}ms — keeping ${previousVersion ?? "installed"} (${reason || "non-zero exit"})`,
		);
		await writeRefreshStamp(candidate.toolId, {
			checkedAt: now,
			failed: true,
			...(previousVersion !== undefined && { version: previousVersion }),
		});
		return {
			toolId: candidate.toolId,
			strategy: "npm",
			packageName,
			previousVersion,
			currentVersion: previousVersion,
			changed: false,
			ok: false,
		};
	}

	const currentVersion = await readInstalledVersion(packageName);
	const changed =
		currentVersion !== undefined && currentVersion !== previousVersion;
	await writeRefreshStamp(candidate.toolId, {
		checkedAt: now,
		...(currentVersion !== undefined && { version: currentVersion }),
	});
	// The observability row #1730 asks for: a wrong verdict from a managed tool
	// can be traced to the version that produced it, and to the moment it moved.
	logSessionStart(
		changed
			? `managed-tool-refresh ${candidate.toolId}: ${previousVersion ?? "unknown"} → ${currentVersion} via ${pm} update (${elapsedMs}ms)`
			: `managed-tool-refresh ${candidate.toolId}: unchanged at ${currentVersion ?? previousVersion ?? "unknown"} (${elapsedMs}ms)`,
	);
	return {
		toolId: candidate.toolId,
		strategy: "npm",
		packageName,
		previousVersion,
		currentVersion,
		changed,
		ok: true,
	};
}

/**
 * Run one session's worth of managed-tool refresh. Never throws: the caller is
 * a background timer with no one to report to.
 */
export async function runManagedToolRefresh(
	now: number = Date.now(),
): Promise<ManagedToolRefreshOutcome> {
	if (process.env.PI_LENS_DISABLE_TOOL_REFRESH === "1") {
		return { skipped: "disabled", refreshed: [] };
	}
	let budget = remainingSessionBudget();
	if (budget <= 0) return { skipped: "session-budget", refreshed: [] };

	const candidates = await installedRefreshCandidates();
	if (candidates.length === 0)
		return { skipped: "no-candidates", refreshed: [] };

	const read = await readManagedToolRefreshState();
	if (read.status === "unreadable") {
		// Unknown cadence. Refreshing nothing is the only answer that neither
		// drifts forever nor bursts every session; the ledger row is what makes
		// the suppressed cadence visible instead of silent.
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: "refresh-state",
			reason: `refresh state unreadable (${read.reason}); skipping refresh this session`,
		});
		logSessionStart(
			`managed-tool-refresh: state unreadable (${read.reason}) — no tool refreshed this session`,
		);
		return { skipped: "state-unreadable", refreshed: [] };
	}

	const stale = selectStaleTools(candidates, read.state, now);
	if (stale.length === 0) return { skipped: "nothing-due", refreshed: [] };

	const refreshed: ManagedToolRefreshResult[] = [];
	for (const candidate of stale) {
		if (budget <= 0) break;
		budget -= 1;
		// Count the ATTEMPT, not the success: a failing tool must not hand its
		// slot to the next candidate and turn one budget into 22 spawns.
		noteManagedToolRefreshAttempt();
		try {
			refreshed.push(
				await refreshOne(candidate, read.state.tools[candidate.toolId], now),
			);
		} catch (err) {
			recordDegradationOnce({
				kind: "managed-tool-refresh",
				subject: candidate.toolId,
				reason: `refresh threw: ${(err as Error).message}`,
			});
		}
	}
	return { refreshed };
}
