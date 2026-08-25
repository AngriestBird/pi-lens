export declare function lintPrBody(body?: string): {
	valid: boolean;
	errors: string[];
};
export declare function resolveLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl?: typeof fetch,
): Promise<string>;
