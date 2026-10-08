/** Pure public LSP config model for #2416 slice 1.
 *
 * This module is deliberately a consumer of config-core, not a loader. It
 * validates and normalizes inputs but never reads files, warns, caches, or
 * starts a process. Existing LSP consumers continue using their projection.
 */
import { LEGACY_ROOT_LSP_KEYS } from "../config-locations.js";
import { PI_LENS_CONFIG_SCHEMA } from "../config-schema.js";
import { resolveConfig, type RawConfigSource } from "../config-core/resolve.js";
import {
	migrationSubject,
	type MigrationRecord,
} from "../config-core/records.js";
import type { Provenance } from "../config-core/provenance.js";
import { customServerSpecsOf } from "./config.js";

export interface ResolvedLspServer {
	readonly kind: "custom" | "override";
	readonly name: string;
	readonly enabled: boolean;
	readonly role: "language" | "auxiliary";
	readonly command?: readonly [string, ...string[]];
	readonly args?: readonly string[];
	readonly extensions?: readonly string[];
	readonly rootMarkers?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly initializationOptions?: Readonly<Record<string, unknown>>;
	readonly covers?: readonly string[];
}

export interface ResolvedLspConfig {
	readonly enabled?: boolean;
	readonly warmFiles: readonly string[];
	readonly disabledServers: readonly string[];
	readonly servers: Readonly<Record<string, ResolvedLspServer>>;
	readonly provenance: ReadonlyMap<string, Provenance>;
}

export interface ResolveLspConfigOptions {
	readonly sources: readonly RawConfigSource[];
	readonly maxRecords?: number;
}

export interface ResolvedLspConfigResult {
	readonly value: ResolvedLspConfig;
	readonly records: readonly MigrationRecord[];
	readonly provenance: ReadonlyMap<string, Provenance>;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringItems(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.reduce<string[]>((out, item) => {
		if (typeof item === "string") out.push(item);
		return out;
	}, []);
}

function makeMigrationRecord(
	source: RawConfigSource,
	key: string,
	reason: string,
): MigrationRecord {
	return {
		code: "PILENS_CFG_0005",
		file: source.file ?? "",
		key,
		subject: migrationSubject(source.file ?? "", key),
		reason,
		tier: source.tier,
	};
}

function canonicalizeSource(source: RawConfigSource): {
	readonly source: RawConfigSource;
	readonly migrationKeys: readonly string[];
} {
	const input = object(source.value);
	if (!input) return { source, migrationKeys: [] };
	const legacy = Object.fromEntries(
		LEGACY_ROOT_LSP_KEYS.reduce<[string, unknown][]>((out, key) => {
			if (Object.hasOwn(input, key)) out.push([key, input[key]]);
			return out;
		}, []),
	);
	if (Object.keys(legacy).length === 0) return { source, migrationKeys: [] };
	const canonical = object(input.lsp) ?? {};
	const rest = { ...input };
	for (const key of Object.keys(legacy)) delete rest[key];
	const mergedLsp = { ...legacy, ...canonical };
	return {
		source: { ...source, value: { ...rest, lsp: mergedLsp } },
		migrationKeys: Object.keys(legacy),
	};
}

function normalizeServer(
	id: string,
	input: unknown,
	source: RawConfigSource,
	records: MigrationRecord[],
): ResolvedLspServer | undefined {
	const entry = object(input);
	if (!entry) {
		records.push(
			makeMigrationRecord(
				source,
				`/lsp/servers/${id}`,
				"server entry must be an object",
			),
		);
		return undefined;
	}
	const command = entry.command;
	let argv: readonly [string, ...string[]] | undefined;
	if (Array.isArray(command)) {
		if (
			command.length > 0 &&
			command.every((part) => typeof part === "string") &&
			command[0] !== ""
		) {
			argv = command as [string, ...string[]];
		} else {
			records.push(
				makeMigrationRecord(
					source,
					`/lsp/servers/${id}/command`,
					"command must be a non-empty argv array",
				),
			);
			return undefined;
		}
	} else if (typeof command === "string" && command.length > 0) {
		const args = entry.args === undefined ? ["--stdio"] : entry.args;
		if (
			!Array.isArray(args) ||
			!args.every((part) => typeof part === "string")
		) {
			records.push(
				makeMigrationRecord(
					source,
					`/lsp/servers/${id}/args`,
					"args must be an array of strings",
				),
			);
			return undefined;
		}
		argv = [command, ...args] as [string, ...string[]];
	} else if (command !== undefined) {
		records.push(
			makeMigrationRecord(
				source,
				`/lsp/servers/${id}/command`,
				"command must be a string or argv array",
			),
		);
		return undefined;
	}
	const extensions = entry.extensions;
	const rootMarkers = entry.rootMarkers;
	if (
		extensions !== undefined &&
		(!Array.isArray(extensions) ||
			!extensions.every((x) => typeof x === "string"))
	) {
		records.push(
			makeMigrationRecord(
				source,
				`/lsp/servers/${id}/extensions`,
				"extensions must be an array of strings",
			),
		);
		return undefined;
	}
	if (
		rootMarkers !== undefined &&
		(!Array.isArray(rootMarkers) ||
			!rootMarkers.every((x) => typeof x === "string"))
	) {
		records.push(
			makeMigrationRecord(
				source,
				`/lsp/servers/${id}/rootMarkers`,
				"rootMarkers must be an array of strings",
			),
		);
		return undefined;
	}
	const env = entry.env;
	const envObject = object(env);
	if (
		env !== undefined &&
		(!envObject || Object.values(envObject).some((x) => typeof x !== "string"))
	) {
		records.push(
			makeMigrationRecord(
				source,
				`/lsp/servers/${id}/env`,
				"env values must be strings",
			),
		);
		return undefined;
	}
	const initializationOptions = entry.initializationOptions;
	if (initializationOptions !== undefined && !object(initializationOptions)) {
		records.push(
			makeMigrationRecord(
				source,
				`/lsp/servers/${id}/initializationOptions`,
				"initializationOptions must be an object",
			),
		);
		return undefined;
	}
	return {
		kind: argv ? "custom" : "override",
		name:
			typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id,
		enabled: entry.enabled !== false,
		role: entry.role === "auxiliary" ? "auxiliary" : "language",
		...(argv ? { command: argv } : {}),
		...(Array.isArray(entry.args) ? { args: entry.args as string[] } : {}),
		...(extensions ? { extensions: extensions as string[] } : {}),
		...(rootMarkers ? { rootMarkers: rootMarkers as string[] } : {}),
		...(envObject ? { env: envObject as Record<string, string> } : {}),
		...(initializationOptions
			? {
					initializationOptions: initializationOptions as Record<
						string,
						unknown
					>,
				}
			: {}),
	};
}

export function resolveLspConfig(
	options: ResolveLspConfigOptions,
): ResolvedLspConfigResult {
	const prepared = options.sources.map(canonicalizeSource);
	const resolution = resolveConfig<Record<string, unknown>>({
		sources: prepared.map(({ source }) => source),
		schema: PI_LENS_CONFIG_SCHEMA,
		maxRecords: options.maxRecords,
	});
	const records = [...resolution.records];
	for (const [index, item] of prepared.entries()) {
		for (const key of item.migrationKeys) {
			records.push({
				code: "PILENS_CFG_0002",
				file: item.source.file ?? "",
				key,
				subject: migrationSubject(item.source.file ?? "", key),
				canonicalKey: `lsp.${key}`,
				reason: `deprecated LSP key; use lsp.${key}`,
				tier: item.source.tier,
			});
		}
		void index;
	}
	const lsp = object(resolution.resolved.value?.lsp) ?? {};
	const servers = object(lsp.servers) ?? {};
	const normalizedServers: Record<string, ResolvedLspServer> = {};
	for (const [id, entry] of Object.entries(servers)) {
		const normalized = normalizeServer(
			id,
			entry,
			options.sources[0] ?? { tier: "project", value: {} },
			records,
		);
		if (normalized) normalizedServers[id] = normalized;
	}
	// The existing covers projection is the one validator for runner identities.
	const covered = customServerSpecsOf({ lsp: { servers: normalizedServers } });
	for (const [id, server] of Object.entries(covered)) {
		if (server.covers)
			normalizedServers[id] = {
				...normalizedServers[id],
				covers: server.covers,
			};
	}
	const disabled = stringItems(lsp.disabledServers);
	const warmFiles = stringItems(lsp.warmFiles);
	return {
		value: {
			...(typeof lsp.enabled === "boolean" ? { enabled: lsp.enabled } : {}),
			warmFiles,
			disabledServers: disabled,
			servers: normalizedServers,
			provenance: resolution.resolved.provenance,
		},
		records,
		provenance: resolution.resolved.provenance,
	};
}
