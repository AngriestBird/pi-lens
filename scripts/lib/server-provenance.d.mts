// Type declarations for server-provenance.mjs (untyped .mjs imported from .ts tests).

export function versionToken(output: unknown): string | undefined;

export function serverToolId(fixture: { tools?: string[] }): string | undefined;

export function readVersionFromBinary(
	binPath: string | undefined,
): string | undefined;

export function collectServerProvenance(
	fixtures: ReadonlyArray<{ lang: string; tools?: string[] }>,
	facts: {
		statuses: ReadonlyArray<{
			id: string;
			installed: boolean;
			source: string;
			path?: string;
		}>;
		readVersion?: (status: {
			id: string;
			installed: boolean;
			source: string;
			path?: string;
		}) => string | undefined;
	},
): Map<string, { install: string; version?: string }>;
