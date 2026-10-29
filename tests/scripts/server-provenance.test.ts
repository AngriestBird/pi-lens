/**
 * #4512 acceptance 1 -- each matrix row records the server version and its
 * install source.
 *
 * ## The recurrence this guards
 *
 * No row carried a server version, so a capability change could not be told
 * apart from a server upgrade or a different install route. The nightly now
 * writes `version` and `install` from the installer's resolution of the one
 * tool a fixture names. These cases pin the read: which tool a fixture means,
 * what a `--version` answer reduces to, and that a server the installer cannot
 * find records nothing (a miss, so the matrix keeps the last known value).
 *
 * The statuses below are recorded `getAllToolStatuses` rows (the shape the
 * installer returns); the writer into the matrix is covered in
 * tests/scripts/lsp-matrix-refresh-expiry.test.ts through
 * `mergeCharacterization`.
 */
import { describe, expect, it } from "vitest";
import * as installer from "../../clients/installer/index.js";
import { getAllToolStatuses } from "../../clients/installer/index.js";
import {
	collectServerProvenance,
	readVersionFromBinary,
	resolveFixtureProvenance,
	serverToolId,
	versionToken,
} from "../../scripts/lib/server-provenance.mjs";

const STATUSES = [
	{
		id: "typescript-language-server",
		installed: true,
		source: "pi-lens-auto",
		path: "/home/u/.pi-lens/tools/node_modules/.bin/typescript-language-server",
	},
	{ id: "pyright", installed: true, source: "global-path", path: "pyright" },
	{ id: "gopls", installed: false, source: "not-installed" },
	{ id: "yaml-language-server", installed: false, source: "npx-fallback" },
	{
		id: "rust-analyzer",
		installed: true,
		source: "github-release",
		path: "/home/u/.pi-lens/bin/rust-analyzer",
	},
	{
		id: "jdtls",
		installed: true,
		source: "archive-dist",
		path: "/home/u/.pi-lens/jdtls",
	},
];

const VERSIONS: Record<string, string> = {
	"typescript-language-server": "4.3.3\n",
	pyright: "pyright 1.1.390\n",
	"rust-analyzer": "rust-analyzer 1.84.0 (9fc6b43 2025-01-07)\n",
};

describe("#4512 which tool a fixture's server runs through", () => {
	it("is the fixture's only tools entry", () => {
		expect(serverToolId({ tools: ["pyright"] })).toBe("pyright");
	});

	it("is nothing when the fixture names none or several (no guess)", () => {
		expect(serverToolId({ tools: [] })).toBeUndefined();
		expect(serverToolId({})).toBeUndefined();
		expect(serverToolId({ tools: ["ruff", "pyright"] })).toBeUndefined();
	});
});

describe("#4512 the version token", () => {
	it.each([
		["4.3.3\n", "4.3.3"],
		["pyright 1.1.390\n", "1.1.390"],
		["rust-analyzer 1.84.0 (9fc6b43 2025-01-07)\n", "1.84.0"],
		["dart language-server 3.5.4-beta.1\n", "3.5.4-beta.1"],
		["v0.9\n", "0.9"],
	])("reads %j as %s", (output, expected) => {
		expect(versionToken(output)).toBe(expected);
	});

	it.each([[""], ["no digits here"], [undefined], [null]])(
		"reads %j as no version",
		(output) => {
			expect(versionToken(output)).toBeUndefined();
		},
	);
});

describe("#4512 collectServerProvenance over recorded installer statuses", () => {
	const fixtures = [
		{ lang: "typescript", tools: ["typescript-language-server"] },
		{ lang: "python", tools: ["pyright"] },
		{ lang: "go", tools: ["gopls"] },
		{ lang: "yaml", tools: ["yaml-language-server"] },
		{ lang: "rust", tools: ["rust-analyzer"] },
		{ lang: "java", tools: ["jdtls"] },
		{ lang: "typescript7", tools: [] },
		{ lang: "python-linted", tools: ["ruff", "pyright"] },
	];
	const readVersion = (s: { id: string }) => VERSIONS[s.id];

	it("records the install source and version of every installed server", () => {
		const out = collectServerProvenance(fixtures, {
			statuses: STATUSES,
			readVersion,
		});
		expect(out.get("typescript")).toEqual({
			install: "pi-lens-auto",
			version: "4.3.3",
		});
		expect(out.get("python")).toEqual({
			install: "global-path",
			version: "1.1.390",
		});
		expect(out.get("rust")).toEqual({
			install: "github-release",
			version: "1.84.0",
		});
	});

	it("records the install source alone when no version can be read", () => {
		const out = collectServerProvenance(fixtures, {
			statuses: STATUSES,
			readVersion,
		});
		expect(out.get("java")).toEqual({ install: "archive-dist" });
	});

	it("records nothing for a server that is not installed, falls back to npx, names no tool or is ambiguous", () => {
		const out = collectServerProvenance(fixtures, {
			statuses: STATUSES,
			readVersion,
		});
		for (const lang of ["go", "yaml", "typescript7", "python-linted"])
			expect(out.has(lang), lang).toBe(false);
	});
});

describe("#4512 reading the binary and the installer filter", () => {
	it("reads a real binary's --version answer and nothing from a missing or non-zero one", () => {
		// node answers `--version` with `v22.x.y`: the one real spawn this file
		// makes, bounded by the helper's own 5 s timeout.
		expect(versionToken(readVersionFromBinary(process.execPath))).toMatch(
			/^\d+\.\d+\.\d+$/,
		);
		expect(readVersionFromBinary("/no/such/binary-4512")).toBeUndefined();
		expect(readVersionFromBinary(undefined)).toBeUndefined();
	});

	it("getAllToolStatuses(ids) reports only the named tools, in registry order", async () => {
		const statuses = await getAllToolStatuses([
			"pyright",
			"typescript-language-server",
		]);
		expect(statuses.map((s) => s.id).sort()).toEqual([
			"pyright",
			"typescript-language-server",
		]);
		expect(await getAllToolStatuses(["no-such-tool-4512"])).toEqual([]);
	});
});

describe("#4512 resolveFixtureProvenance over the real installer registry", () => {
	// Recurrence: a tree-manifest launcher (kotlin-language-server) answers any
	// argument by starting a JVM, so a nightly that ran `--version` there hung or
	// recorded the JVM banner as the server version. The reader must not be
	// called for it, while an ordinary tool is read.
	const FIXTURES = [
		{ lang: "kotlin", tools: ["kotlin-language-server"] },
		{ lang: "yaml", tools: ["yamllint"] },
	];

	it("never runs --version for a tree-manifest tool and reads the others", async () => {
		const asked: Array<string | undefined> = [];
		const fakeInstaller = {
			TOOLS: installer.TOOLS,
			getAllToolStatuses: async (ids: string[]) =>
				ids.map((id) => ({
					id,
					installed: true,
					source: "pi-lens-auto",
					path: `/bin/${id}`,
				})),
		};
		const out = await resolveFixtureProvenance(
			FIXTURES,
			fakeInstaller,
			(binPath) => {
				asked.push(binPath);
				return "yamllint 1.38.0";
			},
		);
		expect(asked).toEqual(["/bin/yamllint"]);
		expect(out.get("kotlin")).toEqual({ install: "pi-lens-auto" });
		expect(out.get("yaml")).toEqual({
			install: "pi-lens-auto",
			version: "1.38.0",
		});
	});

	it("asks the installer only for the fixtures' own tools", async () => {
		const requested: string[][] = [];
		await resolveFixtureProvenance(
			[...FIXTURES, { lang: "none", tools: [] }],
			{
				TOOLS: installer.TOOLS,
				getAllToolStatuses: async (ids: string[]) => {
					requested.push(ids);
					return [];
				},
			},
			() => undefined,
		);
		expect(requested).toEqual([["kotlin-language-server", "yamllint"]]);
	});
});
