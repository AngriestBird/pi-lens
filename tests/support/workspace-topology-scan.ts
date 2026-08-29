/**
 * Topology-derived cache consumer scan — #2294.
 *
 * `registerWorkspaceTopologyReset` (`clients/workspace-topology.ts`) is a
 * PUSH-ONLY registry: a module that memoizes results derived from topology
 * probe seams registers a downstream reset only by calling it. There is no
 * pull-side authority that notices a NEW consumer forgot to register. Three
 * modules wire this today (`startup-scan.ts`, `review-graph/tsconfig-paths.ts`,
 * `language-profile.ts`); the registry cannot tell whether that list is
 * complete.
 *
 * This scan is the compensating, pull-side guard. It ENUMERATES the modules
 * under `clients/` that IMPORT a topology probe seam, then the conformance
 * test asserts each is either registered (the file calls
 * `registerWorkspaceTopologyReset(`) or carries a documented freshness-key
 * exemption. A future consumer that memoizes from a seam without registering
 * shows up as an unaccounted item, exactly like a session-state file that
 * forgets `handleSessionStart`.
 *
 * ## Population rule: IMPORT-aware binding detection
 *
 * The population is scoped to the CANONICAL SOURCE MODULES that export the
 * governed probe seams — `workspace-topology.js` for its probe exports and
 * `startup-scan.js` for `findNearestProjectRoot` — and detected by IMPORT
 * binding, not by call shape. A module is a consumer when a governed probe
 * enters its scope through any of:
 *
 * - a named import: `import { getDirectoryMarkers } from "..."`;
 * - an ALIASED named import: `import { getDirectoryMarkers as markers }` —
 *   the imported name is still the governed probe, so this belongs to the
 *   population even though the call site spells `markers(...)` (the defect a
 *   call-shaped sweep misses);
 * - a NAMESPACE import of a canonical module:
 *   `import * as topo from "workspace-topology.js"` — the namespace makes
 *   every governed probe of that module reachable as `topo.<probe>`.
 *
 * A BARE import of a governed probe enters the population even when the local
 * binding is never called — importing the seam is the act that can feed a
 * memo. Stateless imports that hold no derived cache are documented
 * exemptions, exactly like the call-shaped population's per-run consumers.
 *
 * Crucially, an UNRELATED same-name LOCAL function or module does NOT enter
 * the population: `function getDirectoryMarkers() {}` in a file that never
 * imports the seam is not a topology consumer, and a call-shaped detector
 * would flag it. Import-scoped binding detection is what keeps that out.
 *
 * Multiline named imports and namespace imports are supported; both a default
 * and a named binding in one statement are handled. Side-effect-only imports
 * of a canonical module (`import "workspace-topology.js"`) carry no probe
 * binding and do not enter the population.
 *
 * ## The probe-seam list (the canonical set)
 *
 * The seams that READ the shared marker/walk index and could feed a derived
 * memo. Lifecycle helpers (`resetWorkspaceTopology`,
 * `registerWorkspaceTopologyReset`, `releaseWorkspaceTopologyIdleTimers`) are
 * deliberately excluded — they are the reset/teardown mechanism, not a read
 * whose result a consumer memoizes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listSourceFiles, relativePosix, stripSource } from "./sweep-kit.js";
import { repoRoot } from "./session-state-scan.js";

const CLIENTS_ROOT = path.join(repoRoot, "clients");

/** The seam module that OWNS the reset mechanism — never a consumer.
 *  It is excluded structurally so its own re-export of the governed names is
 *  not read as a consumption. */
export const TOPOLOGY_OWNER = "workspace-topology.ts";

/**
 * The canonical source modules and the governed probe seam each exports.
 *
 * A module is a topology consumer when one of these names ENTERS its scope via
 * an import from the listed source file. `findNearestProjectRoot` lives in
 * `startup-scan.ts`, NOT `workspace-topology.ts` — it is EXCLUDED from the
 * latter's export set, so a consumer importing it from workspace-topology
 * (a mistake) would not be falsely governed by the wrong module.
 */
export const GOVERNED_PROBES_BY_MODULE: Readonly<
	Record<string, readonly string[]>
> = {
	"workspace-topology.js": [
		"getDirectoryMarkers",
		"findNearestDirWithMarker",
		"findNearestDirWithAnyBasename",
		"findPiLensConfigMarkerInDir",
		"findGoverningTsconfigDir",
		"getWorkspaceManifestMarkers",
	],
	"startup-scan.js": ["findNearestProjectRoot"],
};

/** Flat union of every governed probe, for documentation and the test's
 *  canonical-list pin. */
export const TOPOLOGY_PROBE_SEAMS: readonly string[] = Object.values(
	GOVERNED_PROBES_BY_MODULE,
).flat();

/** Call-shaped needle that proves a module REGISTERED a downstream reset. */
const REGISTER_CALL = /\bregisterWorkspaceTopologyReset\(/;

/** Every `.ts` file under `dir` (default `clients/`), minus declarations. */
export function topologyScanSourceFiles(dir = CLIENTS_ROOT): string[] {
	return listSourceFiles(dir, { extensions: [".ts"], skipTests: true });
}

/** `module` relative to `clients/` for message clarity in registration counts. */
function moduleRelative(dir: string, absolute: string): string {
	return relativePosix(path.resolve(dir), absolute);
}

/**
 * Which canonical module a specifier resolves to, by last path segment.
 * `"../workspace-topology.js"`, `"./workspace-topology.js"` and
 * `"../../workspace-topology.js"` all resolve to `workspace-topology.js`.
 */
function canonicalModuleForSpec(spec: string): string | undefined {
	const basename = spec.split(/[\\/]/).pop();
	return basename && Object.hasOwn(GOVERNED_PROBES_BY_MODULE, basename)
		? basename
		: undefined;
}

export interface TopologyImport {
	/** The governed probe(s) that entered scope through this import. */
	probes: string[];
	/** 1-based line of the import statement. */
	line: number;
	/** True when this was a namespace import (`import * as X`). */
	namespace: boolean;
}

/**
 * The governed-probe imports in `source`, found by binding shape.
 *
 * Run on comment-stripped source with STRING CONTENTS KEPT (so the module
 * specifier `"workspace-topology.js"` is readable) but comments and literals
 * blanked (so a comment or assertion string that merely names the seam is not
 * an import). Named imports split the import clause against the governed
 * export set; aliases contribute their IMPORTED name (the alias is a local
 * spelling, not the governed identity); namespace imports of a canonical
 * module contribute that module's full probe set; a default+binding mix and
 * multiline `{ ... }` clauses are both handled.
 */
export function scanGovernedImports(strippedSource: string): TopologyImport[] {
	const out: TopologyImport[] = [];
	// Named import (optionally preceded by a default binding), multiline-safe
	// because the `{ ... }` clause is non-greedy over `[\s\S]`.
	const NAMED =
		/^\s*import\s+(?:type\s+)?(?:(?:[\w$]+)\s*,\s*)?\s*\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/gm;
	// (namespace handled separately below so the named regex never consumes it)

	let m: RegExpExecArray | null;
	NAMED.lastIndex = 0;
	while ((m = NAMED.exec(strippedSource)) !== null) {
		const module = canonicalModuleForSpec(m[2]);
		if (!module) continue;
		// The clause's imported names, honoring aliases (`x as y` → x).
		const importedNames = m[1]
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0)
			.map((part) => {
				const asIndex = part.search(/\s+as\s+/);
				return asIndex === -1 ? part : part.slice(0, asIndex).trim();
			});
		const governed = importedNames.filter((name) =>
			(GOVERNED_PROBES_BY_MODULE[module] as readonly string[]).includes(name),
		);
		if (governed.length === 0) continue;
		out.push({
			probes: governed,
			line: lineOf(strippedSource, m.index),
			namespace: false,
		});
		NAMED.lastIndex = m.index + m[0].length;
	}

	const NS_RE =
		/^\s*import\s+\*\s*as\s+[\w$]+(?:\s*,\s*\{[\s\S]*?\})?\s+from\s+["']([^"']+)["']/gm;
	NS_RE.lastIndex = 0;
	while ((m = NS_RE.exec(strippedSource)) !== null) {
		const module = canonicalModuleForSpec(m[1]);
		if (!module) continue;
		out.push({
			probes: [...GOVERNED_PROBES_BY_MODULE[module]],
			line: lineOf(strippedSource, m.index),
			namespace: true,
		});
		NS_RE.lastIndex = m.index + m[0].length;
	}

	return out;
}

/** 1-based line number of a 0-based character offset. */
function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === "\n") line++;
	}
	return line;
}

export interface TopologyConsumer {
	/** `clients/`-relative posix path (or dir-relative when a fixture dir is passed). */
	file: string;
	/** 1-based lines of the governed imports that entered scope. */
	importLines: number[];
}

/**
 * Every module under `dir` that IMPORTED a governed topology probe, sorted by
 * file. Excludes the seam owner (`workspace-topology.ts`) structurally.
 */
export function scanTopologyConsumers(dir = CLIENTS_ROOT): TopologyConsumer[] {
	const out: TopologyConsumer[] = [];
	for (const absolute of topologyScanSourceFiles(dir)) {
		const rel = moduleRelative(dir, absolute);
		if (rel === TOPOLOGY_OWNER) continue;
		// Comment-stripped with STRINGS KEPT — the module specifier is itself a
		// string literal we must read, while a comment that names the seam must
		// not count as an import. (sweep-kit `stripSource`, `strings:"keep"`.)
		const keptSource = stripSource(fs.readFileSync(absolute, "utf8"), {
			strings: "keep",
		});
		const imports = scanGovernedImports(keptSource);
		if (imports.length === 0) continue;
		out.push({
			file: rel,
			importLines: imports.map((i) => i.line).sort((a, b) => a - b),
		});
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The registered consumer set, DERIVED from source rather than a copied list —
 * a module is registered only when its OWN source calls
 * `registerWorkspaceTopologyReset(`. This is the anti-drift half: a module
 * that imports the register but never calls it is not registered. Registration
 * is deliberately CALL-shaped and source-scoped (it is the one act that PROVES
 * a downstream clear was wired), so the import detection above does not apply.
 */
export function registeredTopologyConsumers(dir = CLIENTS_ROOT): Set<string> {
	const registered = new Set<string>();
	for (const absolute of topologyScanSourceFiles(dir)) {
		const rel = moduleRelative(dir, absolute);
		if (rel === TOPOLOGY_OWNER) continue;
		const blankSource = stripSource(fs.readFileSync(absolute, "utf8"), {
			strings: "blank",
		});
		if (REGISTER_CALL.test(blankSource)) registered.add(rel);
	}
	return registered;
}
