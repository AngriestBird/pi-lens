import type { FetchFn, WardenPr } from "./merge-train-warden.d.mts";
import type { HeadRunHealth } from "./warden-run-health.d.mts";

export const TRAIN_APPROVED_LABEL: string;
export const TRAIN_SQUASH_LABEL: string;
export const ADVISORY_CHECKS: Set<string>;
export const CONCLUDED_STATUS: string;
export const PASSING_CONCLUSION: string;
export const BLOCKING_CONCLUSIONS: Set<string>;
export const MERGEABLE_STATES: Set<string>;
export const MERGE_GATE_REASON: Record<string, string>;

export interface MergeGateDecision {
	merge: boolean;
	silent: boolean;
	method: "squash" | "merge" | null;
	reason: string;
	detail: string;
}

export interface MergeLaneResult {
	number: number | null;
	url?: string;
	reason: string;
	detail?: string;
	method?: "squash" | "merge" | null;
	runHealth?: string;
	merged: boolean;
	errors: Array<{ message: string; benign: boolean }>;
}

export function evaluateMergeGate(
	pr: WardenPr,
	health: HeadRunHealth,
): MergeGateDecision;
export function laneCommentMarker(
	headSha: string | undefined,
	reason: string,
): string;
export function laneCommentBody(pr: WardenPr, gate: MergeGateDecision): string;
export function mergeFailureCommentBody(
	pr: WardenPr,
	gate: MergeGateDecision,
	status: number,
): string;
export function mergePullRequest(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	pr: WardenPr,
	method: string,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export function runMergeLane(options: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	now?: number;
}): Promise<MergeLaneResult[]>;
