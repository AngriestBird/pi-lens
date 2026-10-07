export interface ActionPin {
	action: string;
	sha: string;
	tag: string;
	file: string;
	line: number;
}

export function parseActionPins(text: string, file?: string): ActionPin[];
export function validatePins(
	pins: ActionPin[],
	resolveTag: (action: string, tag: string) => Promise<string>,
	exemptions?: Record<string, string>,
): Promise<string[]>;
export function resolveGithubTag(
	action: string,
	tag: string,
	fetchImpl?: typeof fetch,
	env?: NodeJS.ProcessEnv,
): Promise<string | undefined>;
export function checkActionPins(options?: {
	root?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
export function main(): Promise<void>;
