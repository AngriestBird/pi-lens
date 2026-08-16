/**
 * Go Client for pi-lens
 *
 * Provides Go type checking and linting via gopls and go vet.
 *
 * Requires: gopls (go install golang.org/x/tools/gopls@latest)
 * Docs: https://pkg.go.dev/golang.org/x/tools/gopls
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "./safe-spawn.js";
import {
	type AvailabilityCause,
	classifyProbeFailure,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";

// --- Types ---

export interface GoDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info";
	message: string;
	rule?: string;
	file: string;
}

// --- Common install paths ---

const GO_WINDOWS_PATHS = [
	"C:\\Program Files\\Go\\bin\\go.exe",
	"C:\\Go\\bin\\go.exe",
	"go.exe", // PATH
];

/** Budget for the PATH candidate's `go version` probe, ms. */
const PROBE_TIMEOUT_MS = 3_000;

const GO_UNIX_PATHS = [
	"/usr/local/go/bin/go",
	"/usr/bin/go",
	"go", // PATH
];

// --- Client ---

export class GoClient {
	/**
	 * Availability memo, behind the shared transient-aware latch (#1476). The
	 * PATH candidate is resolved by spawning `go version` with a 3 s budget, so
	 * a host stall could latch "no Go toolchain" for the whole session and
	 * silently disable every Go diagnostic until restart.
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	private goPath: string | null = null;
	/** Classification of the candidate sweep, for the retry decision. */
	private sweepSawTransient = false;
	private sweepTransientCause: AvailabilityCause = "probe-timeout";
	private sweepHostStallMs = 0;
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? createSubsystemLogger("go")
			: () => {};
	}

	/**
	 * Find go executable path (async — probes PATH candidates off the event loop).
	 */
	async findGoPathAsync(): Promise<string | null> {
		if (this.goPath) return this.goPath;

		const paths =
			process.platform === "win32" ? GO_WINDOWS_PATHS : GO_UNIX_PATHS;
		this.sweepSawTransient = false;
		this.sweepTransientCause = "probe-timeout";
		this.sweepHostStallMs = 0;

		for (const p of paths) {
			try {
				if (p.includes("\\") || p.includes("/")) {
					// Absolute path - check if exists
					if (fs.existsSync(p)) {
						this.goPath = p;
						return p;
					}
				} else {
					// Relative (PATH) - try running it. The 3 s budget is enforced by a
					// HOST-side timer, so measure the loop stall that overlapped it and
					// let the shared policy tell "no Go" from "the host was busy".
					const sampler = startHostStallSampler();
					let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
					let hostStallMs: number;
					try {
						result = await safeSpawnAsync(p, ["version"], {
							timeout: PROBE_TIMEOUT_MS,
						});
					} finally {
						hostStallMs = sampler.stop();
						this.sweepHostStallMs += hostStallMs;
					}
					if (!result.error && result.status === 0) {
						this.goPath = p;
						return p;
					}
					const { outcome, cause } = classifyProbeFailure(result, {
						hostStallMs,
					});
					if (outcome === "transient") {
						this.sweepSawTransient = true;
						this.sweepTransientCause = cause;
					}
				}
			} catch (err) {
				void err;
			}
		}

		return null;
	}

	/**
	 * Check if Go is installed (cached)
	 */
	async isGoAvailableAsync(): Promise<boolean> {
		// `read()` returns null when the last verdict was transient and its
		// cooldown expired, which re-enters the candidate sweep (#1476).
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		// Now that a verdict can expire, concurrent callers arriving just after a
		// cooldown must share ONE sweep rather than each spawning their own.
		if (this.ensureInFlight) return this.ensureInFlight;
		this.ensureInFlight = this.resolveAvailability();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async resolveAvailability(): Promise<boolean> {
		const startedAt = Date.now();
		const found = (await this.findGoPathAsync()) !== null;
		if (found) {
			this.availabilityLatch.noteAvailable();
			this.log(`Go found: ${this.goPath}`);
			logAvailabilityDecision({
				tool: "go",
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs: Date.now() - startedAt,
				latched: true,
				hostStallMs: this.sweepHostStallMs,
				budgetMs: PROBE_TIMEOUT_MS,
			});
			return true;
		}
		// A timed-out `go version` is evidence about this moment, not about
		// whether the toolchain is installed; it expires instead of latching.
		const outcome = this.sweepSawTransient ? "transient" : "missing";
		const cause = this.sweepSawTransient
			? this.sweepTransientCause
			: "not-found";
		const retryAfterMs = this.availabilityLatch.noteUnavailable(outcome, cause);
		logAvailabilityDecision({
			tool: "go",
			verdict: "unavailable",
			outcome,
			cause,
			elapsedMs: Date.now() - startedAt,
			latched: outcome !== "transient",
			hostStallMs: this.sweepHostStallMs,
			...(retryAfterMs > 0 && { retryAfterMs }),
			budgetMs: PROBE_TIMEOUT_MS,
		});
		return false;
	}

	/**
	 * Check if a file is a Go file
	 */
	isGoFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".go";
	}

}
