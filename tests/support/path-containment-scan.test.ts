/**
 * The path-containment detector's own state table (#2556): one named case per
 * admitted reading, per refusal, and per plant its author did not design for
 * (an alias, an indirect call, a value reached through another binding;
 * AGENTS.md shape 69). The census over the runtime trees and `tests/support/`
 * is `tests/config/path-containment-sweep.test.ts`.
 *
 * Recurrence guarded: a hand-rolled containment test over a `path.relative`
 * result passes every lane while being wrong across Windows drives (#4878 F1:
 * `!rel.startsWith("..")` read an absolute cross-drive `rel` as inside, and
 * `Unit tests Windows` failed 26 cells on a head every other lane called
 * green). Each `site` row is a spelling that reached, or could reach, that
 * test; each `clean` row is a spelling the detector must NOT report, so a
 * widened needle that buries the population under spread syntax or prose is
 * caught here too.
 */
import { describe, expect, it } from "vitest";
import {
	type PathContainmentSite,
	scanPathContainmentSites,
} from "./path-containment-scan.js";

function rows(source: string): PathContainmentSite[] {
	return scanPathContainmentSites(source);
}

function anchors(source: string): string[] {
	return rows(source).map((site) => site.anchor);
}

/** The #4878 F1 spelling, as it shipped in `tests/support/vi-mock-export-gate.ts`. */
const THE_4878_F1_SPELLING =
	"function isInside(file: string): boolean {\n" +
	"  const rel = path.relative(process.cwd(), file);\n" +
	'  return !rel.startsWith("..");\n' +
	"}\n";

describe("path containment detector (#2556)", () => {
	it("reports the direct, chained and bound readings", () => {
		const cases: Array<[string, string]> = [
			["direct chain", 'const inside = path.relative(a, b).startsWith("..");'],
			[
				"named sep operand",
				'const inside = !path.relative(a, b).startsWith(".." + path.sep);',
			],
			[
				"win32 separator literal",
				'const rel = path.relative(a, b);\nconst inside = !rel.startsWith("..\\\\");',
			],
			[
				"posix separator literal",
				'const rel = path.relative(a, b);\nconst inside = rel.startsWith("../");',
			],
			[
				"template with the platform separator",
				"const rel = path.relative(a, b);\nconst inside = rel.startsWith(`..${path.sep}`);",
			],
			[
				"separators folded, then tested",
				'const rel = path.relative(cwd, file).replace(/\\\\/g, "/");\n' +
					'const inside = rel.startsWith("../");',
			],
			[
				"through a local helper's argument",
				"const rel = toPosix(path.relative(cwd, file));\n" +
					'const inside = !rel.startsWith("..");',
			],
			[
				"split/join on the separator",
				"const rel = relative(cwd, file).split(sep).join(posix.sep);\n" +
					'if (rel.startsWith("../")) return false;',
			],
			[
				"two-statement binding, as six production sites spell it",
				"const rel = path.relative(root, dir);\n" +
					'if (rel.startsWith("..") || path.isAbsolute(rel)) break;',
			],
		];
		for (const [name, source] of cases)
			expect(rows(source).length, name).toBe(1);
	});

	it("reports a value reached through another binding or a whole-value rewrite", () => {
		const cases: Array<[string, string]> = [
			[
				"alias of the binding",
				'const rel = path.relative(a, b);\nconst alias = rel;\nalias.startsWith("..");',
			],
			[
				"binding of an alias of the callee",
				'const up = path.relative;\nconst rel = up(a, b);\nrel.startsWith("..");',
			],
			[
				"named import of the callee",
				'import { relative } from "node:path";\n' +
					"function f(a: string, b: string) {\n" +
					"  const rel = relative(a, b);\n" +
					'  return rel.startsWith("..");\n' +
					"}",
			],
			[
				"aliased named import",
				'import { relative as rel } from "node:path";\n' +
					'rel(a, b).startsWith("..");',
			],
			[
				"destructured callee",
				'const { relative: rel } = path;\nrel(a, b).startsWith("..");',
			],
			[
				"template concatenation of the value",
				'const rel = path.relative(a, b);\n`${rel}`.startsWith("..");',
			],
		];
		for (const [name, source] of cases)
			expect(rows(source).length, name).toBeGreaterThan(0);
	});

	it("reports the #4878 F1 spelling under the symbol it shipped in", () => {
		const [site] = rows(THE_4878_F1_SPELLING);
		expect(site?.anchor).toBe("isInside");
		expect(THE_4878_F1_SPELLING).toContain('rel.startsWith("..")');
	});

	it("never reads a spread prefix, an unrelated value, or prose as a site", () => {
		const clean: Array<[string, string]> = [
			[
				"rest-element prefix (`...`), not a parent segment",
				'const rest = arg.slice(3);\nif (rest.startsWith("...")) rest = rest.slice(3);',
			],
			[
				"rest-element prefix on a relative value",
				'const rel = path.relative(a, b);\nif (rel.startsWith("...")) rel = "";',
			],
			[
				"the seam itself",
				'return !rel.startsWith("..") && !path.isAbsolute(rel);',
			],
			[
				"a `..`-literal compared with equality, not containment",
				'const rel = path.relative(a, b);\nif (rel === "..") return false;',
			],
			[
				"containment on a resolved path, not on a relative one",
				'const resolved = path.resolve(a, b);\nresolved.startsWith("..");',
			],
			[
				"a comment copy of the needle",
				'// const rel = path.relative(cwd, file);\n// return !rel.startsWith("..");',
			],
			[
				"a string copy of the needle",
				"const doc = 'const rel = path.relative(a, b); rel.startsWith(\"..\")';",
			],
			[
				"a `..`-leading DIRECTORY name, not a containment test",
				'const dirName = "..foo";\ndirName.startsWith("..");',
			],
			[
				"a parameter's caller-supplied spelling (the cross-function hand-off)",
				"function inside(relative: string): boolean {\n" +
					'  return !relative.startsWith("..");\n' +
					"}\n" +
					"inside(path.relative(a, b));",
			],
		];
		for (const [name, source] of clean)
			expect(rows(source).length, name).toBe(0);
	});

	it("never reports a parameter's spelling, even when a sibling binds the name", () => {
		const source =
			"function first(a: string, b: string) {\n" +
			"  const target = toPosix(path.relative(a, b));\n" +
			"  return target;\n" +
			"}\n" +
			"function second(target: string) {\n" +
			'  return target.startsWith("../");\n' +
			"}\n";
		expect(rows(source).length).toBe(0);
	});

	it("names the enclosing symbol, so a second test in one file is distinct", () => {
		const source =
			"function outer(a: string, b: string) {\n" +
			"  function inner(c: string, d: string) {\n" +
			'    return path.relative(c, d).startsWith("..");\n' +
			"  }\n" +
			"  return inner(a, b);\n" +
			"}\n" +
			'const rel = path.relative("/a", "/b");\n' +
			'rel.startsWith("..");\n';
		expect(anchors(source)).toEqual(["inner", "<module>"]);
	});
});
