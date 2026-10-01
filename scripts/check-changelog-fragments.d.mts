export declare function addedChangelogFragments(options?: {
	base?: string;
	cwd?: string;
	git?: (
		args: string[],
		options: { cwd: string; encoding: "utf8" },
	) => string | Buffer;
}): string[] | null;

export declare function checkChangelogFragments(options?: {
	base?: string;
	cwd?: string;
	git?: (
		args: string[],
		options: { cwd: string; encoding: "utf8" },
	) => string | Buffer;
	rootDir?: string;
}): { valid: boolean; fragments: string[] | null; message: string };
