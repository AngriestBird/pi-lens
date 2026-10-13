/**
 * #4346: `extractForwardImportPaths` answers the files one file imports now.
 * The LSP created-module producer calls it on every diagnostics batch that
 * replays a finding, so the parse is kept per file version and the sources are
 * resolved on every call: a module created since must appear without the
 * importer changing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_getForwardImportParsesForTests,
	extractForwardImportPaths,
} from "../../clients/blocker-freshness.js";
import { toPosix } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function workspace(prefix: string, files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	write(root, files);
	return root;
}

function write(root: string, files: Record<string, string>): void {
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

const relative = (root: string, files: string[]): string[] =>
	files.map((file) => toPosix(path.relative(root, file))).sort();

describe("extractForwardImportPaths (#4346)", () => {
	it("answers a module created after the first call, as a full build resolves it", async () => {
		const root = workspace("pi-lens-4346-fwd-", {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"src/fixturepkg/__init__.py": "",
			"tools/probe.py":
				"from fixturepkg.new_module import describe\nimport os\n\nvalue = describe()\n",
		});
		const importer = path.join(root, "tools/probe.py");
		expect(await extractForwardImportPaths(root, importer)).toEqual([]);

		write(root, {
			"src/fixturepkg/new_module.py": "def describe():\n    return 1\n",
		});

		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/fixturepkg/new_module.py"]);
	});

	// Recurrence: #4344 r1's replay regression class. Re-parsing each file on
	// every batch took a warm 32-file replay from 7 ms to 118-215 ms (#4346
	// measurement, before this memo).
	it("parses an unchanged file once and still sees a module created since", async () => {
		const root = workspace("pi-lens-4346-fwd-memo-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\nexport const x = b;\n',
		});
		const importer = path.join(root, "src/a.ts");
		const before = _getForwardImportParsesForTests();
		expect(await extractForwardImportPaths(root, importer)).toEqual([]);

		write(root, { "src/b.ts": "export const b = 1;\n" });
		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/b.ts"]);
		expect(_getForwardImportParsesForTests() - before).toBe(1);

		// The importer's own change is a new parse.
		write(root, {
			"src/a.ts": 'import { c } from "./c";\nexport const x = c;\n',
			"src/c.ts": "export const c = 1;\n",
		});
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(importer, later, later);
		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/c.ts"]);
		expect(_getForwardImportParsesForTests() - before).toBe(2);
	});
});
