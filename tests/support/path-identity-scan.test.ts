/**
 * The path identity detector's own state table (#4689): one named case per
 * admitted form, per refused form, and per plant its author did not design
 * for (an alias, an indirect call, a value reached through another binding;
 * AGENTS.md shape 69). The census over `clients/` is
 * `tests/config/path-identity-sweep.test.ts`.
 *
 * Recurrence guarded: a sweep that cannot see a spelling passes the defect it
 * exists to catch. Each `site` row is a form that once reached, or could
 * reach, a raw identity derivation outside `clients/path-utils.ts`; each
 * `clean` row is a form the sweep must not report, so a widened needle that
 * buries the population is caught here too.
 */
import { describe, expect, it } from "vitest";
import {
	type PathIdentityNeedle,
	scanPathIdentitySites,
} from "./path-identity-scan.js";

function needles(source: string): PathIdentityNeedle[] {
	return scanPathIdentitySites(source).map((site) => site.needle);
}

const SITE_ROWS: ReadonlyArray<[string, string, PathIdentityNeedle[]]> = [
	// raw-realpath, admitted forms
	["fs.realpathSync member call", "fs.realpathSync(p);", ["raw-realpath"]],
	["realpathSync.native", "fs.realpathSync.native(p);", ["raw-realpath"]],
	["fs.promises.realpath", "await fs.promises.realpath(p);", ["raw-realpath"]],
	[
		"named import",
		'import { realpath } from "node:fs/promises";',
		["raw-realpath"],
	],
	// plants: alias, indirect call, value through another binding
	[
		"plant: aliased import, then a call through the alias",
		'import { realpathSync as rp } from "node:fs";\nrp(x);',
		["raw-realpath"],
	],
	[
		"plant: indirect call through a bound reference",
		"const f = fs.realpathSync;\nf(x);",
		["raw-realpath"],
	],
	[
		"plant: computed member with a string key",
		'fs["realpathSync"](x);',
		["raw-realpath"],
	],
	[
		"plant: computed member with an escaped string key",
		'fs["realpath\\u0053ync"](x);',
		["raw-realpath"],
	],
	[
		"plant: Reflect.get with the member name",
		'Reflect.get(fs, "realpath")(x);',
		["raw-realpath"],
	],
	[
		"plant: value reached through a destructured binding",
		"const { realpath } = fs.promises;\nawait realpath(x);",
		["raw-realpath", "raw-realpath"],
	],
	[
		"plant: the realpath binary spawned",
		'spawnSync("realpath", [x]);',
		["raw-realpath"],
	],
	// path-resolve-keyed, admitted forms
	[
		"Map.set keyed by path.resolve",
		"m.set(path.resolve(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"Set.has keyed by path.resolve",
		"s.has(path.resolve(f));",
		["path-resolve-keyed"],
	],
	[
		"a cast does not change the key",
		"m.get(path.resolve(f) as string);",
		["path-resolve-keyed"],
	],
	[
		"subscript keyed by path.resolve",
		"byPath[path.resolve(f)] = 1;",
		["path-resolve-keyed"],
	],
	[
		"new Set over a resolve mapper",
		"new Set(xs.map((p) => path.resolve(p)));",
		["path-resolve-keyed"],
	],
	[
		"new Map over resolve pairs",
		"new Map([[path.resolve(a), 1]]);",
		["path-resolve-keyed"],
	],
	[
		"nodePath and path.posix namespaces",
		"m.set(nodePath.resolve(f), 1);\nm.set(path.posix.resolve(f), 1);",
		["path-resolve-keyed", "path-resolve-keyed"],
	],
	// plants: alias, indirect call, value through another binding
	[
		"plant: aliased resolve import",
		'import { resolve as r } from "node:path";\nm.set(r(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: destructured resolve alias",
		"const { resolve: r } = path;\nm.set(r(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"plant: bound resolve reference",
		"const r = path.resolve;\nm.set(r(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"plant: Map.prototype.set.call",
		"Map.prototype.set.call(m, path.resolve(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"plant: a mapper passed by reference",
		"new Set(xs.map(path.resolve));",
		["path-resolve-keyed"],
	],
	[
		"plant: value reached through a const binding",
		"const k = path.resolve(f);\nm.set(k, 1);",
		["path-resolve-keyed"],
	],
	// plants: a member read through a bracket with a literal key (review r5
	// LOW, Greptile PRRT_kwDORt8rec6u2wF3; live population 0 on 2026-10-21)
	[
		"plant: resolve called through a bracket key",
		'm.set(path["resolve"](f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: a key method called through a bracket key",
		'm["set"](path.resolve(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: both through escaped and template bracket keys",
		"m[`has`](path['res\\u006flve'](f));",
		["path-resolve-keyed"],
	],
	[
		"plant: a bound resolve read through a bracket key",
		'const r = path["resolve"];\nm.set(r(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: a bracket-key .call of a key method",
		'Map.prototype["set"]["call"](m, path.resolve(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: a bracket-key mapper inside new Set",
		'new Set(xs["map"](path["resolve"]));',
		["path-resolve-keyed"],
	],
	[
		"plant: binding in an enclosing function scope",
		"function g(f) {\n\tconst k = path.resolve(f);\n\treturn () => m.has(k);\n}",
		["path-resolve-keyed"],
	],
];

const CLEAN_ROWS: ReadonlyArray<[string, string]> = [
	["the seam's own export", "realpathOrResolve(p);"],
	[
		"a comment naming the needle",
		"// fs.realpathSync(p) and m.set(path.resolve(f))\nx();",
	],
	["prose in a string", 'log("realpath failed for " + p);'],
	["a key through the seam", "m.set(normalizeMapKey(path.resolve(f)), 1);"],
	["a resolve value outside a key position", "m.set(k, path.resolve(f));"],
	["path.relative is not resolve", "m.set(path.relative(root, f), 1);"],
	[
		"a binding shadowed by a parameter",
		"const k = path.resolve(f);\nfunction g(k) {\n\treturn m.has(k);\n}",
	],
	[
		"a binding shadowed by a loop variable",
		"const k = path.resolve(f);\nfor (const k of keys) m.has(k);",
	],
	["a raw template with a backslash", "x.replaceAll(String.raw`\\.`, '.');"],
	["a bracket key that is not resolve", 'm.set(path["relative"](root, f), 1);'],
	["a bracket key that is not a key method", 'm["push"](path.resolve(f));'],
];

describe("path identity detector state table (#4689)", () => {
	for (const [name, source, expected] of SITE_ROWS)
		it(`site: ${name}`, () => {
			expect(needles(source)).toEqual(expected);
		});

	for (const [name, source] of CLEAN_ROWS)
		it(`clean: ${name}`, () => {
			expect(needles(source)).toEqual([]);
		});
});
