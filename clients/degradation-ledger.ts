/** Bounded, process-local telemetry for behavior degraded during one session. */

export type DegradationKind =
	| "trust-refusal"
	| "mode-suppression"
	| "ts-idle-eviction"
	| "spawn-failure"
	| "formatter-skip"
	| "grammar-blocked";

export interface DegradationRecord {
	kind: DegradationKind;
	subject: string;
	reason: string;
}

export interface DegradationGroup {
	kind: DegradationKind;
	/** Exact number recorded, including events no longer retained. */
	count: number;
	/** Number omitted from latestReasons by the per-kind bound. */
	droppedCount: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}

const ENTRIES_PER_KIND = 20;
const groups = new Map<
	DegradationKind,
	{ count: number; entries: Array<{ subject: string; reason: string }> }
>();

export function recordDegradation(record: DegradationRecord): void {
	let group = groups.get(record.kind);
	if (!group) {
		group = { count: 0, entries: [] };
		groups.set(record.kind, group);
	}
	group.count += 1;
	group.entries.push({ subject: record.subject, reason: record.reason });
	if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
}

/** Detached snapshot, grouped in first-seen kind order. */
export function getDegradationSummary(): DegradationGroup[] {
	return [...groups.entries()].map(([kind, group]) => ({
		kind,
		count: group.count,
		droppedCount: group.count - group.entries.length,
		latestReasons: group.entries.map((entry) => ({ ...entry })),
	}));
}

export function renderDegradationLines(summary = getDegradationSummary()): string[] {
	if (summary.length === 0) return [];
	return [
		"Degradations:",
		...summary.map((group) => {
			const latest = group.latestReasons.at(-1);
			return `  ⚠ ${group.kind}: ${group.count}${latest ? ` — ${latest.subject}: ${latest.reason}` : ""}`;
		}),
	];
}

/** Session-boundary/test reset. */
export function resetDegradationLedger(): void {
	groups.clear();
}

export const DEGRADATION_ENTRIES_PER_KIND = ENTRIES_PER_KIND;
