export declare function lintPrBody(
	body?: string,
	options?: { requireTestAssessment?: boolean },
): {
	valid: boolean;
	errors: string[];
};
export declare function resolveLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl?: typeof fetch,
): Promise<string>;
export declare function resolveTouchesTests(
	payloadPr: { number: number },
	fetchImpl?: typeof fetch,
): Promise<boolean | null>;
