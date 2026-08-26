type GitOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	encoding?: BufferEncoding;
	stdio?: "ignore" | "pipe" | "inherit";
};

export function gitExecFileSync(
	args: string[],
	options?: GitOptions,
): Buffer | string;
export function gitExecSync(
	command: string,
	options?: GitOptions,
): Buffer | string;
