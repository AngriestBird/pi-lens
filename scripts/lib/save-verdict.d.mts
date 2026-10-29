// Type declarations for save-verdict.mjs (untyped .mjs imported from .ts tests).

export const SAVE_VERDICT_MARKER: string;
export const SAVE_VERDICT_COLUMN: string;
export const SAVE_VERDICT_VALUES: Set<string>;
export const SAVE_VERDICT_COMMAND: string;

export interface SaveArm {
	nonEmpty?: number;
	ms?: number | null;
}

export const SILENT_ARM: Readonly<Required<SaveArm>>;

export interface SaveVerdictArms {
	mode?: string;
	noSave?: SaveArm;
	silence?: SaveArm;
	saveAlone?: SaveArm;
	savedWrite?: SaveArm;
}

export interface SaveVerdict {
	verdict: string;
	reason: string;
}

export function classifySaveVerdict(input: SaveVerdictArms): SaveVerdict;

export function describeArm(arm: SaveArm | undefined, waitMs: number): string;

export function fixturePolicy(fixture: {
	auxiliaryServerIds?: string[];
	lspGate?: boolean;
	lspGateExempt?: string;
}): string;

export function saveVerdictCells(row: {
	server: string;
	save: string;
	mode: string;
	fixture: {
		lang: string;
		auxiliaryServerIds?: string[];
		lspGate?: boolean;
		lspGateExempt?: string;
	};
	arms: SaveVerdictArms;
	waitMs: number;
	src: string;
}): Record<string, string>;

export function refreshSaveVerdictTable(
	text: string,
	measured: Array<Record<string, string>>,
	opts?: { marker?: string },
): {
	text: string;
	changed: boolean;
	measured: string[];
	kept: string[];
	notInTable: string[];
	reason?: string;
};

export interface SaveVerdictRow {
	server: string;
	save: string;
	verdict: string;
}

export function parseSaveVerdictRows(
	text: string,
	opts?: { marker?: string },
): SaveVerdictRow[];

export function orderByNeed<F extends { lang: string }>(
	fixtures: F[],
	rows: Array<{ server: string; verdict: string }>,
	serverOf: (fixture: F) => string,
	alreadyMeasured?: Iterable<string>,
): F[];
