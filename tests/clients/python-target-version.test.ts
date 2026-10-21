/**
 * #4638: the declared Python syntax level, read from the project rather than
 * from whichever interpreter runs a checker. Every case drives the production
 * resolver (`detectPythonTargetVersion`) over a real fixture tree; nothing here
 * rebuilds the precedence table in the test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	detectPythonTargetVersion,
	isJediCompileVerdictOutranked,
	PYTHON_COMPILE_VERDICT_SERVER_ID,
	type PythonTargetVersion,
} from "../../clients/python-environment.js";
import { removeTempDirSync } from "./test-utils.js";

let cwd: string;

function project(...segments: string[]): string {
	return path.join(cwd, "project", ...segments);
}

function write(relativePath: string, content: string): string {
	const target = project(relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

/** Resolve for a file in the fixture project, with `cwd` as the home ceiling. */
function resolveFor(relativePath = "app.py") {
	return detectPythonTargetVersion(project(relativePath), cwd);
}

function declared(
	minor: number,
	source: PythonTargetVersion["source"] = "requires-python",
): PythonTargetVersion {
	return { major: 3, minor, source, file: project("pyproject.toml") };
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-syntax-"));
	fs.mkdirSync(project(), { recursive: true });
	resetDegradationLedger();
});

afterEach(() => {
	resetDegradationLedger();
	removeTempDirSync(cwd);
});

describe("detectPythonTargetVersion sources", () => {
	it("reads ruff target-version from pyproject [tool.ruff]", async () => {
		const file = write(
			"pyproject.toml",
			'[tool.ruff]\ntarget-version = "py312"\n',
		);
		await expect(resolveFor()).resolves.toEqual({
			major: 3,
			minor: 12,
			source: "ruff-target-version",
			file,
		});
	});

	it("reads ruff target-version from .ruff.toml", async () => {
		const file = write(".ruff.toml", 'target-version = "py311"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 11,
			source: "ruff-target-version",
			file,
		});
	});

	it("reads ruff target-version from ruff.toml", async () => {
		const file = write("ruff.toml", 'target-version = "py314"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "ruff-target-version",
			file,
		});
	});

	it("reads pyright pythonVersion from pyrightconfig.json", async () => {
		const file = write("pyrightconfig.json", '{"pythonVersion": "3.13"}\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 13,
			source: "pyright-python-version",
			file,
		});
	});

	it("reads pyright pythonVersion from pyproject [tool.pyright]", async () => {
		const file = write(
			"pyproject.toml",
			'[tool.pyright]\npythonVersion = "3.13"\n',
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 13,
			source: "pyright-python-version",
			file,
		});
	});

	it("reads requires-python from pyproject [project]", async () => {
		const file = write(
			"pyproject.toml",
			'[project]\nname = "demo"\nrequires-python = ">=3.12"\n',
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "requires-python",
			file,
		});
	});

	it("reads the first line of .python-version", async () => {
		const file = write(".python-version", "3.14.2\n3.12.0\n");
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "python-version-file",
			file,
		});
	});

	it("prefers a redirection-free declaration in the nearest directory", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write("pkg/.python-version", "3.14\n");
		await expect(resolveFor("pkg/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "python-version-file",
		});
	});

	it("walks past a directory that declares nothing", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
		fs.mkdirSync(project("pkg", "nested"), { recursive: true });
		await expect(resolveFor("pkg/nested/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 11,
			source: "requires-python",
		});
	});
});

describe("detectPythonTargetVersion precedence", () => {
	it("prefers ruff target-version over pyright and requires-python", async () => {
		write(
			"pyproject.toml",
			[
				'[project]\nrequires-python = ">=3.12"',
				'[tool.pyright]\npythonVersion = "3.13"',
				'[tool.ruff]\ntarget-version = "py310"',
				"",
			].join("\n"),
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 10,
			source: "ruff-target-version",
		});
	});

	it("prefers pyright pythonVersion over requires-python", async () => {
		write(
			"pyproject.toml",
			[
				'[project]\nrequires-python = ">=3.12"',
				'[tool.pyright]\npythonVersion = "3.13"',
				"",
			].join("\n"),
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 13,
			source: "pyright-python-version",
		});
	});

	it("prefers requires-python over .python-version", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write(".python-version", "3.14\n");
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "requires-python",
		});
	});

	it("prefers pyrightconfig.json over pyproject [tool.pyright]", async () => {
		write("pyproject.toml", '[tool.pyright]\npythonVersion = "3.13"\n');
		write("pyrightconfig.json", '{"pythonVersion": "3.14"}\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
		});
	});

	it("stops at the ruff config ruff itself would read", async () => {
		// `.ruff.toml` is the config ruff uses here; it declares no target, so
		// ruff runs at its default level and a sibling `ruff.toml` is dead text.
		write(".ruff.toml", "[lint]\nselect = ['E']\n");
		write("ruff.toml", 'target-version = "py312"\n');
		write("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 11,
			source: "requires-python",
		});
	});
});

describe("detectPythonTargetVersion reductions", () => {
	const forms: Array<[string, number]> = [
		[">=3.12", 12],
		[">=3.12,<4", 12],
		["==3.14.*", 14],
		["~=3.11", 11],
		["3.14", 14],
	];

	for (const [specifier, minor] of forms) {
		it(`reduces requires-python "${specifier}" to 3.${minor}`, async () => {
			write("pyproject.toml", `[project]\nrequires-python = "${specifier}"\n`);
			await expect(resolveFor()).resolves.toMatchObject({
				major: 3,
				minor,
				source: "requires-python",
			});
		});
	}

	const unusable = ["pypy-3.10", "main", "", "<4", ">3.12", "!=3.12", "3"];
	for (const line of unusable) {
		it(`treats .python-version line ${JSON.stringify(line)} as no declaration`, async () => {
			write(".python-version", `${line}\n`);
			await expect(resolveFor()).resolves.toBeUndefined();
		});
	}

	it("takes the strongest lower bound in either order (#4638 review)", async () => {
		for (const specifier of [">=3.12,>=3.14", ">=3.14,>=3.12"]) {
			write("pyproject.toml", `[project]\nrequires-python = "${specifier}"\n`);
			await expect(resolveFor()).resolves.toMatchObject({
				major: 3,
				minor: 14,
				source: "requires-python",
			});
		}
	});

	it("reads a commented pyrightconfig.json (#4638 review)", async () => {
		const file = write(
			"pyrightconfig.json",
			'{\n\t// comment\n\t"pythonVersion": "3.14",\n\t/* note */\n}\n',
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
			file,
		});
	});

	it("stops at a nested pyproject.toml that declares nothing (#4638 review)", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.14"\n');
		write("services/api/pyproject.toml", '[project]\nname = "api"\n');
		await expect(resolveFor("services/api/app.py")).resolves.toBeUndefined();
	});

	it("still reads a declaration inside the nested project", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write(
			"services/api/pyproject.toml",
			'[tool.pyright]\npythonVersion = "3.14"\n',
		);
		await expect(resolveFor("services/api/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
		});
	});

	it("prefers .ruff.toml, then ruff.toml, then pyproject (#4638 review)", async () => {
		write("pyproject.toml", '[tool.ruff]\ntarget-version = "py39"\n');
		write("ruff.toml", 'target-version = "py310"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 10,
			source: "ruff-target-version",
		});
		write(".ruff.toml", 'target-version = "py312"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "ruff-target-version",
		});
	});

	it("treats requires-python with no lower bound as no declaration", async () => {
		write("pyproject.toml", '[project]\nrequires-python = "<4"\n');
		await expect(resolveFor()).resolves.toBeUndefined();
	});

	it("keeps walking when the nearest declaration is unusable", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write("pkg/.python-version", "pypy-3.10\n");
		await expect(resolveFor("pkg/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "requires-python",
		});
	});

	it("returns undefined when the project declares nothing", async () => {
		write("README.md", "# demo\n");
		await expect(resolveFor()).resolves.toBeUndefined();
	});

	it("returns undefined for a file that is not Python", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.14"\n');
		await expect(resolveFor("app.ts")).resolves.toBeUndefined();
	});

	it("records one degradation and stays absent when a manifest cannot be read", async () => {
		// A directory where the manifest belongs makes the real `readFile` throw
		// EISDIR on every platform, so the failure path is not a mock.
		fs.mkdirSync(project("pyproject.toml"), { recursive: true });
		await expect(resolveFor()).resolves.toBeUndefined();
		const rows = getDegradationSummary().filter(
			(entry) => entry.kind === "python-target-version-unreadable",
		);
		expect(rows).toHaveLength(1);
	});
});

describe("isJediCompileVerdictOutranked", () => {
	const jediCompile = {
		serverId: PYTHON_COMPILE_VERDICT_SERVER_ID,
		source: "compile",
	};

	it("drops jedi's compile verdict at a declared 3.14", () => {
		expect(isJediCompileVerdictOutranked(jediCompile, declared(14))).toBe(true);
	});

	it("keeps jedi's compile verdict at a declared 3.13", () => {
		expect(isJediCompileVerdictOutranked(jediCompile, declared(13))).toBe(
			false,
		);
	});

	it("keeps every verdict when nothing is declared", () => {
		expect(isJediCompileVerdictOutranked(jediCompile, undefined)).toBe(false);
	});

	it("keeps another server's compile verdict at 3.14", () => {
		expect(
			isJediCompileVerdictOutranked(
				{ serverId: "pyright", source: "compile" },
				declared(14),
			),
		).toBe(false);
	});

	it("keeps jedi's non-compile verdict at 3.14", () => {
		expect(
			isJediCompileVerdictOutranked(
				{ serverId: PYTHON_COMPILE_VERDICT_SERVER_ID, source: "jedi" },
				declared(14),
			),
		).toBe(false);
		expect(
			isJediCompileVerdictOutranked(
				{ serverId: PYTHON_COMPILE_VERDICT_SERVER_ID },
				declared(14),
			),
		).toBe(false);
	});

	it("drops at any later major or minor", () => {
		expect(
			isJediCompileVerdictOutranked(jediCompile, {
				...declared(0),
				major: 4,
			}),
		).toBe(true);
	});
});
