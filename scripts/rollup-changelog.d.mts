export const CHANGELOG_SECTIONS: readonly string[];
export function parseEntry(text: string, file?: string): { section: string; entry: string };
export function rollupChangelog(
  version: string,
  options?: { rootDir?: string },
): { version: string; files: string[]; changelogPath: string };
