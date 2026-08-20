/**
 * One wording for a tool that produced no usable result, and the runner gate
 * that emits it to the degradation ledger (#1816).
 */
import { incrementDegradationCount } from "../../../degradation-ledger.js";
import { truncateForLedger } from "../../../ledger-bounds.js";
import type { RunnerResult } from "../../types.js";
import {
	type ClassifyRunOutcomeInput,
	classifyRunOutcome,
	firstOutputLine,
	type RunOutcome,
} from "./spawn-outcome.js";

export interface ToolFailureInput {
	/** The tool as a reader would name it: "vulture", "knip", "markdownlint". */
	tool: string;
	/** Process exit status, or `null` when none ever arrived. */
	status: number | null;
	/** Signal that killed the process. NAMED in the reason when present. */
	signal?: NodeJS.Signals | null;
	stderr?: string;
	stdout?: string;
	/** The tool's report artifact is absent, rather than its stdout empty. */
	reportMissing?: boolean;
	/**
	 * Extra discriminating identity to keep in the record — knip's binary
	 * source, the resolved command. Rendered as `key=value` inside the
	 * parenthesis after the tool name. Undefined values are dropped.
	 */
	fields?: Record<string, string | number | undefined>;
}

/**
 * One wording for "this tool did not produce a usable result" (#1816).
 *
 * Before this, five reason builders spelled the same sentence five ways and
 * twelve sites truncated with their own literal, and NONE of them named the
 * signal — so a SIGKILLed tool read exactly like a clean exit 0. The wording
 * here is fixed, the truncation is the ledger's own `LEDGER_FIELD_MAX` policy
 * applied once at the end, and the signal is always named when present.
 *
 * Shape: `tool (k=v, k=v) <what happened> with <what was missing>: <detail>`
 */
export function formatToolFailure(input: ToolFailureInput): string {
	const entries = Object.entries(input.fields ?? {}).filter(
		([, value]) => value !== undefined && value !== "",
	);
	const identity = entries.length
		? `${input.tool} (${entries.map(([key, value]) => `${key}=${value}`).join(", ")})`
		: input.tool;

	// A signal is the strongest available explanation, so it displaces the exit
	// status rather than sitting beside a `null` one.
	const what = input.signal
		? `was killed by ${input.signal}`
		: input.status === null
			? "did not run (spawn failure)"
			: `exited ${input.status}`;

	const missing = input.reportMissing ? "no report file" : "no output";
	const detail =
		firstOutputLine(input.stderr) || firstOutputLine(input.stdout) || "no stderr";

	return truncateForLedger(`${identity} ${what} with ${missing}: ${detail}`);
}

/**
 * `formatToolFailure` fed straight from a `classifyRunOutcome` verdict — the
 * path every migrated runner takes, so the outcome and the wording can never
 * disagree about the status or the signal.
 */
export function formatRunOutcomeFailure(
	tool: string,
	outcome: RunOutcome,
	fields?: ToolFailureInput["fields"],
): string {
	return formatToolFailure({
		tool,
		status: outcome.status,
		signal: outcome.signal,
		stderr: outcome.firstOutputLine,
		reportMissing: outcome.kind === "report-missing",
		fields: { outcome: outcome.kind, ...fields },
	});
}

/**
 * The migrated runners' one call: classify the spawn, and when the tool did
 * NOT run, record a bounded `runner-empty-result` row and hand back the
 * `skipped` verdict. Returns `null` when the tool ran, meaning "carry on and
 * parse".
 *
 * `incrementDegradationCount` keeps the record bounded — one latest-reason
 * entry per (kind, subject) with an exact event tally — so a permanently
 * broken tool costs one ledger row, not one per dispatched file. `subject` is
 * the tool id, which is the discriminating identity a reader needs: WHICH tool
 * is silently contributing nothing.
 */
export function skipUnlessToolRan(
	tool: string,
	input: ClassifyRunOutcomeInput,
	fields?: ToolFailureInput["fields"],
): RunnerResult | null {
	const outcome = classifyRunOutcome(input);
	if (outcome.kind === "ran") return null;
	incrementDegradationCount({
		kind: "runner-empty-result",
		subject: tool,
		reason: formatRunOutcomeFailure(tool, outcome, fields),
	});
	return { status: "skipped", diagnostics: [], semantic: "none" };
}
