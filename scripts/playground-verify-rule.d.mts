// Type declarations for playground-verify-rule.mjs (untyped .mjs imported
// from .ts tests). #1679.

export interface RunCdpOptions {
	scriptPath?: string;
	timeoutMs?: number;
}

export function runCdp(
	args: string[],
	options?: RunCdpOptions,
): Promise<string>;

export interface RunChromeOptions {
	scriptPath?: string;
	timeoutMs?: number;
}

export function runChrome(
	cmd: string,
	options?: RunChromeOptions,
): Promise<void>;

// #2208.
export function buildPlaygroundUrl(
	ruleYaml: string,
	code: string,
	lang: string,
): string;
