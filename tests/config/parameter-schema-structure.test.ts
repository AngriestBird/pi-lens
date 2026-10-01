import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import extension from "../../index.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

// #3721: every vitest worker shares one PI_LENS_HOME; this file loads the
// extension entry, so pin a private home before any import and release it
// last (afterAll hooks run in reverse registration order).
const lensHome = await vi.hoisted(async () =>
	(await import("../support/private-lens-home.js")).pinPrivateLensHome(
		"parameter-schema-structure",
	),
);
afterAll(() => lensHome.release());

type Tool = {
	name: string;
	parameters?: unknown;
	inputSchema?: unknown;
};

const snapshotPath = path.join(
	process.cwd(),
	"tests/config/parameter-schema-structure.snapshot.json",
);
const trimmedPiNames = [
	"ast_grep_search",
	"lens_diagnostics",
	"lsp_navigation",
];
const trimmedMcpNames = [
	"pilens_ast_grep_search",
	"pilens_diagnostics",
	"pilens_lsp_navigation",
];

function withoutDescriptions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutDescriptions);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "description")
				.map(([key, child]) => [key, withoutDescriptions(child)]),
		);
	}
	return value;
}

function selectedSchemas(
	tools: Tool[],
	names: string[],
): Record<string, unknown> {
	return Object.fromEntries(
		names.map((name) => {
			const tool = tools.find((candidate) => candidate.name === name);
			expect(tool, `missing trimmed tool ${name}`).toBeDefined();
			return [name, withoutDescriptions(tool?.inputSchema ?? tool?.parameters)];
		}),
	);
}

describe("trimmed parameter schema structure (#2800 item 13)", () => {
	let piTools: Tool[];
	let mcp: McpHarness;
	let mcpTools: Tool[];

	beforeAll(async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		piTools = [...pi.tools.values()] as Tool[];
		mcp = new McpHarness();
		const listed = await mcp.request(1, "tools/list");
		mcpTools = ((listed.result as { tools: Tool[] }).tools ?? []) as Tool[];
	});

	afterAll(() => mcp?.dispose());

	it("preserves every accepted argument shape on pi and MCP surfaces", () => {
		const actual = {
			pi: selectedSchemas(piTools, trimmedPiNames),
			mcp: selectedSchemas(mcpTools, trimmedMcpNames),
		};
		if (process.env.UPDATE_PARAMETER_SCHEMA_SNAPSHOT === "1") {
			fs.writeFileSync(snapshotPath, `${JSON.stringify(actual, null, "\t")}\n`);
		}
		const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		// Recurrence: byte-only pins can bless a narrowed enum or nested schema after regeneration.
		expect(actual).toEqual(expected);
	});
});
