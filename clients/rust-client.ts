/**
 * Rust Client for pi-lens
 *
 * Provides Rust type checking and linting via cargo check and clippy.
 *
 * Requires: cargo (rustup)
 * Docs: https://doc.rust-lang.org/cargo/
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as path from "node:path";
import {
	type AvailabilityCause,
	createAvailabilityLatch,
	logAvailabilityDecision,
} from "./dispatch/runners/utils/availability-policy.js";
import { probeAvailabilityCandidates } from "./dispatch/runners/utils/candidate-probe.js";

// --- Types ---

export interface RustDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "note" | "help";
	message: string;
	code?: string;
	file: string;
}

// --- Common install paths ---

const CARGO_WINDOWS_PATHS = [
	path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe"),
	path.join(process.env.SYSTEMDRIVE || "C:", "\\cargo", "bin", "cargo.exe"),
	"cargo.exe", // PATH
];

/** Budget for the PATH candidate's `cargo --version` probe, ms. */
const PROBE_TIMEOUT_MS = 3_000;

const CARGO_UNIX_PATHS = [
	path.join(process.env.HOME || "", ".cargo", "bin", "cargo"),
	"/usr/local/cargo/bin/cargo",
	"/usr/bin/cargo",
	"cargo", // PATH
];

// --- Client ---

export class RustClient {
	/**
	 * Availability memo, behind the shared transient-aware latch (#1476). The
	 * PATH candidate is resolved by spawning `cargo --version` with a 3 s budget,
	 * so a host stall could latch "no cargo" for the session and silently disable
	 * every Rust diagnostic until restart.
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	private cargoPath: string | null = null;
	/** Classification of the candidate sweep, for the retry decision. */
	private sweepSawTransient = false;
	private sweepTransientCause: AvailabilityCause = "probe-timeout";
	private sweepHostStallMs = 0;
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? createSubsystemLogger("rust")
			: () => {};
	}

	/**
	 * Find cargo executable path (async — probes PATH candidates off the event loop).
	 */
	async findCargoPathAsync(): Promise<string | null> {
		if (this.cargoPath) return this.cargoPath;

		const paths =
			process.platform === "win32" ? CARGO_WINDOWS_PATHS : CARGO_UNIX_PATHS;
		const sweep = await probeAvailabilityCandidates(
			paths,
			["--version"],
			PROBE_TIMEOUT_MS,
		);
		this.sweepSawTransient = sweep.sawTransient;
		this.sweepTransientCause = sweep.transientCause;
		this.sweepHostStallMs = sweep.hostStallMs;
		if (sweep.foundPath) this.cargoPath = sweep.foundPath;
		return sweep.foundPath;
	}

	/**
	 * Check if cargo is installed (cached)
	 */
	async isAvailableAsync(): Promise<boolean> {
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
		const found = (await this.findCargoPathAsync()) !== null;
		if (found) {
			this.availabilityLatch.noteAvailable();
			this.log(`Cargo found: ${this.cargoPath}`);
			logAvailabilityDecision({
				tool: "cargo",
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
		// A timed-out `cargo --version` is evidence about this moment, not about
		// whether the toolchain is installed; it expires instead of latching.
		const outcome = this.sweepSawTransient ? "transient" : "missing";
		const cause = this.sweepSawTransient
			? this.sweepTransientCause
			: "not-found";
		const retryAfterMs = this.availabilityLatch.noteUnavailable(outcome, cause);
		logAvailabilityDecision({
			tool: "cargo",
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
	 * Check if a file is a Rust file
	 */
	isRustFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".rs";
	}

}
