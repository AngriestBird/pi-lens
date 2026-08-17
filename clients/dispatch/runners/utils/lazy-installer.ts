/**
 * The one lazy-install seam (#1537).
 *
 * Best-effort installs of language-specific tools, triggered when a runner or a
 * formatter finds its tool absent. There were two copies of this — the
 * `attempted` Set here and `formatters.ts`'s `_lazyInstallAttempts` — and both
 * carried the same defect: the key went in BEFORE the install ran and never came
 * out. A `gem install rubocop` that died on a network blip was therefore never
 * retried for the rest of the session, and the tool stayed skipped.
 *
 * The guard itself is right, and it stays: an install storm is worse than a
 * missed install, and these spawns are up to 3 minutes each. What was wrong is
 * that a transient failure and a genuine refusal were recorded identically, with
 * no expiry on either. So the record is now written AFTER the install, and it
 * carries the outcome:
 *
 *   * `succeeded` — nothing more to do this session.
 *   * `failed`, transient (timed out, killed, EAGAIN) — retried after a
 *     cooldown, at most LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS times, then held.
 *   * `failed`, durable (the package MANAGER is not on this machine) — held for
 *     the session. No cooldown can conjure a `gem`.
 *
 * The vocabulary is #1534's `InstallAttemptFact`, so `describeInstallAttempt`
 * turns this record straight into the `availability_decision` install evidence
 * (#1500) — which is what makes "we tried and the network failed" tellable from
 * "this tool cannot be installed here".
 *
 * A trust denial is deliberately NOT recorded: `assertInstallAllowed` is
 * re-evaluated per call and a later grant must retry (#1350).
 */

import { safeSpawnAsync } from "../../../safe-spawn.js";
import { assertInstallAllowed } from "../../../project-trust.js";
import { logExtension } from "../../../extension-log.js";
import {
	classifyProbeFailure,
	type InstallAttemptFact,
} from "./availability-policy.js";

export type LazyInstallTool =
	| "golangci-lint"
	| "rubocop"
	| "rust-clippy"
	| "rustfmt";

interface LazyInstallSpec {
	command: string;
	args: string[];
	/**
	 * Whether the install survives an ambient cancellation.
	 *
	 * Per-tool because that is what the two merged copies actually did, and
	 * unifying it would change cancellation semantics for a 3-minute spawn — a
	 * behaviour change that does not belong in this fix. The formatter copy opted
	 * in (a half-finished `gem install` is worse than a slow one); the runner copy
	 * never did.
	 */
	ignoreAmbientSignal: boolean;
	/** Label for the trust gate's audit line. */
	label: string;
}

const LAZY_INSTALL_SPECS: Record<LazyInstallTool, LazyInstallSpec> = {
	"golangci-lint": {
		command: "go",
		args: ["install", "github.com/golangci/golangci-lint/cmd/golangci-lint@latest"],
		ignoreAmbientSignal: false,
		label: "runner lazy install: golangci-lint",
	},
	rubocop: {
		command: "gem",
		args: ["install", "rubocop", "--no-document"],
		ignoreAmbientSignal: false,
		label: "runner lazy install: rubocop",
	},
	"rust-clippy": {
		command: "rustup",
		args: ["component", "add", "clippy"],
		ignoreAmbientSignal: false,
		label: "runner lazy install: rust-clippy",
	},
	rustfmt: {
		command: "rustup",
		args: ["component", "add", "rustfmt"],
		ignoreAmbientSignal: true,
		label: "formatter lazy install: rustfmt",
	},
};

/**
 * `formatters.ts` reached these two through its own copy, with its own trust
 * label and `ignoreAmbientSignal: true`. Merging the copies must not silently
 * change either, so the formatter-facing overrides live here.
 */
const FORMATTER_SPEC_OVERRIDES: Partial<
	Record<LazyInstallTool, Partial<LazyInstallSpec>>
> = {
	rubocop: {
		ignoreAmbientSignal: true,
		label: "formatter lazy install: rubocop",
	},
	rustfmt: {
		ignoreAmbientSignal: true,
		label: "formatter lazy install: rustfmt",
	},
};

const LAZY_INSTALL_TIMEOUT_MS = 180_000;

/**
 * The retry ladder, calibrated for an INSTALL and not for a probe.
 *
 * The shared probe ladder (`transientRetryDelayMs`, 30 s base) is sized for a
 * 1.5–5 s version check. Applied to a 3-minute `go install` on a host where it
 * reliably times out, that is a compile every 30 seconds — the #1497 shape. So:
 * 5 min base, doubling, 30 min cap, and at most three attempts before the
 * verdict is terminal for the session.
 *
 * The caller's cadence is the other half of this. Both entry points are reached
 * per save (and #1539 made a degraded formatter selection re-detect on every
 * pass), so the window has to be far longer than a save interval or the guard
 * is decorative.
 *
 * When #1514 lands, its `INSTALL_TRANSIENT_*` constants and
 * `noteUnavailable({ operationClass: "install" })` are the intended common home
 * for this ladder; the numbers here match it deliberately so folding them is a
 * deletion rather than a re-decision.
 */
export const LAZY_INSTALL_BASE_COOLDOWN_MS = 300_000;
export const LAZY_INSTALL_MAX_COOLDOWN_MS = 1_800_000;
export const LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS = 3;

export function lazyInstallRetryDelayMs(transientAttempts: number): number {
	const exponent = Math.max(0, transientAttempts - 1);
	return Math.min(
		LAZY_INSTALL_MAX_COOLDOWN_MS,
		LAZY_INSTALL_BASE_COOLDOWN_MS * 2 ** Math.min(exponent, 10),
	);
}

interface LazyInstallState {
	fact: InstallAttemptFact;
	/** Epoch ms a retry becomes allowed. 0 means held for the session. */
	retryAtMs: number;
	transientAttempts: number;
}

const attempts = new Map<string, LazyInstallState>();

function key(cwd: string, tool: LazyInstallTool): string {
	return `${cwd}:${tool}`;
}

/**
 * What the last lazy install for this tool+cwd did, in #1534's vocabulary.
 *
 * Feed it to `describeInstallAttempt` to put the install evidence beside the
 * availability verdict it produced. `undefined` means nothing was attempted,
 * which `describeInstallAttempt` renders as `not-attempted` rather than
 * inventing a failure.
 */
export function getLazyInstallAttempt(
	tool: LazyInstallTool,
	cwd: string,
): InstallAttemptFact | undefined {
	return attempts.get(key(cwd, tool))?.fact;
}

/**
 * Drop every lazy-install verdict, so the next call may try again.
 *
 * Wired into the session reset (`clearFormatterRuntimeState`). Without it a
 * durable hold outlives the session that justified it — the #1494
 * permanent-latch shape. The runner copy had no reset at all.
 */
export function resetLazyInstallAttempts(): void {
	attempts.clear();
}

/** Why a call declined to spawn, when it declined. */
type Suppression = "succeeded" | "cooling" | "held";

function suppressionFor(state: LazyInstallState | undefined): Suppression | null {
	if (!state) return null;
	if (state.fact.outcome === "succeeded") return "succeeded";
	if (state.retryAtMs === 0) return "held";
	return Date.now() < state.retryAtMs ? "cooling" : null;
}

async function runLazyInstall(
	tool: LazyInstallTool,
	cwd: string,
	spec: LazyInstallSpec,
): Promise<boolean> {
	const k = key(cwd, tool);
	const previous = attempts.get(k);
	const suppressed = suppressionFor(previous);
	if (suppressed !== null) {
		logExtension({
			subsystem: "install",
			message: `lazy-install ${tool} suppressed (${suppressed})`,
			metadata: {
				tool,
				cwd,
				suppressed,
				outcome: previous?.fact.outcome,
				...(previous?.fact.reason && { reason: previous.fact.reason }),
				...(suppressed === "cooling" && {
					retryAfterMs: Math.max(0, (previous?.retryAtMs ?? 0) - Date.now()),
				}),
			},
		});
		return false;
	}

	let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
	try {
		result = await safeSpawnAsync(spec.command, spec.args, {
			timeout: LAZY_INSTALL_TIMEOUT_MS,
			cwd,
			...(spec.ignoreAmbientSignal && { ignoreAmbientSignal: true }),
		});
	} catch (err) {
		// A throw from the spawn boundary is not evidence that the tool cannot be
		// installed, so it is transient like any other failure to get a fair run.
		result = {
			stdout: "",
			stderr: (err as Error)?.message ?? String(err),
			status: null,
			error: err as Error,
			failure: "spawn",
		} as Awaited<ReturnType<typeof safeSpawnAsync>>;
	}

	if (!result.error && result.status === 0) {
		attempts.set(k, {
			fact: { outcome: "succeeded" },
			retryAtMs: 0,
			transientAttempts: 0,
		});
		return true;
	}

	// `classifyProbeFailure` owns the transient taxonomy (timeout, kill, EAGAIN)
	// and the one durable case that matters here: `tool-not-found` on the package
	// MANAGER. Everything else RAN and exited nonzero, which for an install is
	// the retry candidate — a network failure and a nonexistent package are
	// indistinguishable from the exit code, so the attempt CEILING is what stops
	// the second one from retrying forever, not a guess at the cause.
	const classified = classifyProbeFailure(result, {
		command: spec.command,
		unclassifiedFailureOutcome: "transient",
	});
	const durable = classified.outcome === "missing";
	const reason = (
		result.error?.message ??
		result.stderr ??
		`exit ${result.status}`
	)
		.trim()
		.slice(0, 200);

	const transientAttempts = durable ? 0 : (previous?.transientAttempts ?? 0) + 1;
	const exhausted =
		!durable && transientAttempts >= LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS;
	const retryAtMs =
		durable || exhausted
			? 0
			: Date.now() + lazyInstallRetryDelayMs(transientAttempts);

	attempts.set(k, {
		fact: { outcome: "failed", reason },
		retryAtMs,
		transientAttempts,
	});
	logExtension({
		subsystem: "install",
		message: `lazy-install ${tool} failed: ${reason}`,
		metadata: {
			tool,
			cwd,
			command: spec.command,
			cause: classified.cause,
			durable,
			transientAttempts,
			held: retryAtMs === 0,
			...(retryAtMs > 0 && { retryAfterMs: retryAtMs - Date.now() }),
			evidence: classified.evidence,
		},
	});
	return false;
}

/**
 * Best-effort lazy install for language-specific linters.
 *
 * Returns true only when an install just ran and succeeded — a suppressed call
 * returns false rather than repeating the previous answer, so a caller cannot
 * mistake "already handled" for "just installed".
 */
export async function tryLazyInstall(
	tool: LazyInstallTool,
	cwd: string,
): Promise<boolean> {
	const spec = LAZY_INSTALL_SPECS[tool];
	if (!assertInstallAllowed(spec.label)) return false;
	return runLazyInstall(tool, cwd, spec);
}

/**
 * The formatter-facing entry point, kept distinct only for its spawn options and
 * trust label (see `FORMATTER_SPEC_OVERRIDES`). The state, the classification
 * and the ladder are shared — this was a two-copy shape and a fix in one copy is
 * not a fix (#1537).
 */
export async function tryLazyInstallForFormatter(
	tool: "rubocop" | "rustfmt",
	cwd: string,
): Promise<boolean> {
	const spec = { ...LAZY_INSTALL_SPECS[tool], ...FORMATTER_SPEC_OVERRIDES[tool] };
	if (!assertInstallAllowed(spec.label)) return false;
	return runLazyInstall(tool, cwd, spec);
}
