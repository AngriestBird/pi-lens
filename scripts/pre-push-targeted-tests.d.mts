// Type declarations for pre-push-targeted-tests.mjs (untyped .mjs imported
// from .ts tests, so the selection logic can be pinned down directly). #1804.

export const MAX_SELECTED_TESTS: number;

export const TREE_SCANNING_GOVERNANCE_TESTS: string[];

export const TREE_SCANNING_GOVERNANCE_BUDGET_MS: number;

export function resolveDiffRange(): string;

export function changesProductionFile(file: string): boolean;

export function changedFiles(range: string): string[] | null;

export function collectTestFiles(dir: string, out?: string[]): string[];

export interface TargetedTestSelection {
	selected: string[];
	unmatched: string[];
	capped: boolean;
	totalBeforeCap: number;
}

export function selectTargetedTests(
	changed: string[],
	allTests: string[],
): TargetedTestSelection;

export function main(): Promise<number>;
