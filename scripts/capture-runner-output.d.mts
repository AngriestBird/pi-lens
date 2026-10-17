// Types for the (plain-JS) real-bytes capture primitive, so TS consumers — the
// unit tests in tests/scripts/ — can import its helpers.

/** Placeholder substituted for the capture workspace inside captured bytes. */
export const WORKSPACE_TOKEN: string;

/**
 * The first `major.minor` token in a `--version` banner, or "" when the banner
 * carries none. The caller refuses to write a fixture on "", so a failed spawn's
 * error text can never be recorded as a tool version.
 */
export function extractVersion(banner: string | undefined): string;

/**
 * `text` with every spelling of `workspace` — native, POSIX, backslash, and
 * JSON-escaped — replaced by `WORKSPACE_TOKEN`.
 */
export function redactWorkspace(
	text: string | undefined,
	workspace: string,
): string;

/**
 * `argv` with every `WORKSPACE_TOKEN` argument replaced by `workspace`, so a
 * capture can hand its tool the absolute workspace path while the recorded argv
 * stays machine-neutral.
 */
export function expandWorkspaceArgs(
	argv: readonly string[],
	workspace: string,
): string[];

/**
 * `text` with the capture host's home directory collapsed to `~`, so a tool that
 * names its own install path in its probe output does not commit a maintainer's
 * absolute path.
 */
export function redactHomePath(text: string | undefined): string;

/** Whether this spawn needs a shell (a Windows npm shim, never a real .exe). */
export function needsShell(bin: string, platform?: NodeJS.Platform): boolean;

/**
 * One argv entry quoted per the CommandLineToArgvW rules, including the
 * backslash-run doubling a naive quote-escape gets wrong.
 */
export function quoteForShell(arg: string): string;

/** An executable path normalised and quoted for whichever shell receives it. */
export function shellBinPath(bin: string): string;

/** One recorded availability probe: what the checker sent, and what came back. */
export interface AvailabilityRecord {
	/** The command as the checker spawns it. */
	command: string;
	/** Arguments after the command. */
	argv: string[];
	/** The binary that answered, from its own version banner. */
	version: string;
	/** The real exit status; a rejected probe records its non-zero code. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** A real clean run of the same invocation in a workspace whose input is clean. */
export interface CleanRecord {
	/** Repo-relative workspace the clean run happened in. */
	workspace: string;
	/** The analysed path, relative to that workspace. */
	file: string;
	/** The invocation, unchanged from the fixture's own. */
	argv: string[];
	version: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Shape one availability record. `run` is a `spawnSync` result (or anything with
 * `status`/`stdout`/`stderr`), so a test can drive it without spawning.
 */
export function buildAvailability(
	command: string,
	argv: readonly string[],
	version: string,
	run: { status?: number | null; stdout?: string; stderr?: string } | undefined,
): AvailabilityRecord;

/**
 * Merge availability/clean records into an existing fixture envelope without
 * touching the recorded work bytes.
 */
export function mergeRecords(
	dest: string,
	patch: {
		availability?: AvailabilityRecord[];
		clean?: CleanRecord;
		versionArgv?: string[];
	},
): Record<string, unknown>;
