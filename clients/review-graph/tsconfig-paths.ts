import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findGoverningTsconfigDir } from "../workspace-topology.js";

export interface TsconfigPathMatcher {
	pattern: string;
	prefix: string;
	suffix: string;
	targets: string[];
}

interface TsconfigJson {
	extends?: string;
	compilerOptions?: {
		baseUrl?: string;
		paths?: Record<string, string[]>;
	};
}

interface ParsedConfig {
	baseUrl: string;
	paths?: Record<string, string[]>;
}

const cache = new Map<string, TsconfigPathMatcher[]>();

/** Strip JSONC comments and trailing commas without touching string contents. */
function parseJsonc(content: string): unknown {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		const next = content[i + 1];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
		} else if (char === "/" && next === "/") {
			while (i < content.length && content[i] !== "\n") i++;
			output += "\n";
		} else if (char === "/" && next === "*") {
			i += 2;
			while (
				i < content.length &&
				!(content[i] === "*" && content[i + 1] === "/")
			)
				i++;
			i++;
		} else {
			output += char;
		}
	}
	return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"));
}

function resolveExtends(configPath: string, value: string): string | undefined {
	if (!value.startsWith(".")) return undefined;
	const resolved = path.resolve(path.dirname(configPath), value);
	return resolved.toLowerCase().endsWith(".json")
		? resolved
		: `${resolved}.json`;
}

function readConfig(
	configPath: string,
	seen: Set<string>,
): ParsedConfig | undefined {
	const normalized = path.resolve(configPath);
	if (seen.has(normalized)) return undefined;
	seen.add(normalized);
	let json: TsconfigJson;
	try {
		json = parseJsonc(fs.readFileSync(normalized, "utf8")) as TsconfigJson;
	} catch {
		return undefined;
	}
	let inherited: ParsedConfig | undefined;
	if (typeof json.extends === "string") {
		const parentPath = resolveExtends(normalized, json.extends);
		if (parentPath) inherited = readConfig(parentPath, seen);
	}
	const options = json.compilerOptions;
	const baseUrl =
		typeof options?.baseUrl === "string"
			? path.resolve(path.dirname(normalized), options.baseUrl)
			: inherited?.baseUrl ?? path.dirname(normalized);
	const paths =
		options?.paths && typeof options.paths === "object"
			? Object.fromEntries(
					Object.entries(options.paths).map(([pattern, targets]) => [
						pattern,
						Array.isArray(targets)
							? targets.map((target) => path.resolve(baseUrl, target))
							: targets,
					]),
				)
			: inherited?.paths;
	return { baseUrl, paths };
}

/** Find and parse the nearest governing tsconfig, cached per importer directory. */
export function parseTsconfigPaths(
	cwd: string,
	homeDir = os.homedir(),
): TsconfigPathMatcher[] {
	const key = path.resolve(cwd);
	const cached = cache.get(key);
	if (cached) return cached;
	// Home-guarding is enforced inside findGoverningTsconfigDir's walk itself
	// (via workspace-topology's shared isAtOrAboveHomeDir ceiling), so a hit
	// here is never at/above homeDir.
	const configDir = findGoverningTsconfigDir(key, homeDir);
	if (!configDir) {
		cache.set(key, []);
		return [];
	}
	const parsed = readConfig(path.join(configDir, "tsconfig.json"), new Set());
	const matchers = Object.entries(parsed?.paths ?? {})
		.filter(
			(entry): entry is [string, string[]] =>
				Array.isArray(entry[1]) &&
				entry[1].every((target) => typeof target === "string"),
		)
		.map(([pattern, targets]) => {
			const star = pattern.indexOf("*");
			return {
				pattern,
				prefix: star === -1 ? pattern : pattern.slice(0, star),
				suffix: star === -1 ? "" : pattern.slice(star + 1),
				targets,
			};
		})
		.sort((a, b) => b.prefix.length - a.prefix.length);
	cache.set(key, matchers);
	return matchers;
}

/** Apply the longest matching paths pattern and substitute its single `*`. */
export function aliasedImportTargets(
	specifier: string,
	importerDir: string,
): string[] {
	for (const matcher of parseTsconfigPaths(importerDir)) {
		if (
			!specifier.startsWith(matcher.prefix) ||
			!specifier.endsWith(matcher.suffix)
		)
			continue;
		const wildcard = specifier.slice(
			matcher.prefix.length,
			specifier.length - matcher.suffix.length,
		);
		if (!matcher.pattern.includes("*") && wildcard) continue;
		return matcher.targets.map((target) => target.replaceAll("*", wildcard));
	}
	return [];
}

export function clearTsconfigPathsCache(): void {
	cache.clear();
}
