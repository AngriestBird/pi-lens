export declare function resolveJitiCacheDir(deps: {
	tmpdir: () => string;
	env: Record<string, string | undefined>;
	cwd: () => string;
	join: (a: string, b: string) => string;
}): string;

export declare function buildStubAliases(
	hostProvidedPackages: readonly string[],
): Record<string, string>;

export declare const STUB_TARGET: string;

export declare function warmSkipReason(state: {
	env: Record<string, string | undefined>;
	distEntryExists: boolean;
	jitiResolvable: boolean;
}): string | null;

export declare function appendBounded(
	existingLines: string[],
	line: string,
	max?: number,
): string[];

export declare const INSTALL_LOG_MAX_LINES: number;
