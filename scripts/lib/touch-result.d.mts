export interface TouchDiagnostic {
	message?: string;
	source?: string;
	severity?: number;
}
export declare function touchAnsweredDiagnostics(
	touched:
		| readonly TouchDiagnostic[]
		| { diags?: TouchDiagnostic[]; inconclusiveReason?: string }
		| undefined,
	options?: { auxiliary?: boolean },
): readonly TouchDiagnostic[] | undefined;
