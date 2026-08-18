/**
 * Fixture-parse smoke for the CUE grammar (#1522, #1520).
 *
 * tree-sitter-cue is young (v0.0.1, no tagged releases) and, unlike every other
 * grammar here, it is BUILT BY US and committed to `vendor/grammars/` rather
 * than fetched — so nothing upstream would tell us if a rebuild regressed it.
 * #1522 made a fixture-parse smoke the gate for landing it: a realistic CUE file
 * covering the constructs pi-lens actually meets must parse with zero ERROR and
 * zero MISSING nodes, and a broken file must degrade to an ERROR node rather
 * than crash the shared WASM Module.
 *
 * The fixture deliberately avoids the two known-rough upstream productions:
 * multi-hash raw strings and alias-heavy paths.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	downloadGrammarDetailed,
	isVendoredGrammar,
	LANGUAGE_TO_GRAMMAR,
	VENDORED_GRAMMARS,
	vendoredGrammarsDir,
} from "../../clients/grammar-source.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";

interface Node {
	type: string;
	isMissing?: boolean;
	children?: Node[];
}

function countBadNodes(root: Node): { errors: number; missing: number } {
	let errors = 0;
	let missing = 0;
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (node.type === "ERROR") errors++;
		if (node.isMissing) missing++;
		for (const child of node.children ?? []) stack.push(child);
	}
	return { errors, missing };
}

// Packages, imports, a #Definition, constraints, disjunctions with a default,
// an optional field, a pattern constraint, string interpolation, an @attribute,
// and two comprehensions — the constructs a real CUE module is made of.
const GOOD_CUE = `package infra

import "strings"

// A definition with constraints and an attribute.
#Service: {
	name:     string & !=""
	replicas: int & >=1 & <=10
	port:     int | *8080
	tier:     "web" | "worker"
	labels: [string]: string
	env?: [...string]
	url: "https://\\(name).example.com:\\(port)"
	owner: string @tag(owner,type=string)
}

services: [Name=string]: #Service & {
	name: Name
}

services: web: {
	replicas: 3
	tier:     "web"
}

names: [for k, v in services if v.replicas > 1 {strings.ToUpper(k)}]

allNames: [for k, _ in services {k}]
`;

// An unclosed struct — the class cuelsp itself reports as a parse diagnostic.
const BROKEN_CUE = `package infra

#Service: {
	name: string
`;

const CUE_GRAMMAR = "tree-sitter-cue.wasm";

describe("CUE grammar smoke (#1522)", () => {
	let client: TreeSitterClient;

	beforeAll(async () => {
		client = getSharedTreeSitterClient() as TreeSitterClient;
		await client.init();
	});

	it("registers cue against the committed wasm", () => {
		expect(LANGUAGE_TO_GRAMMAR.cue).toBe(CUE_GRAMMAR);
		expect(isVendoredGrammar(CUE_GRAMMAR)).toBe(true);
		expect(VENDORED_GRAMMARS[CUE_GRAMMAR]?.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it("ships the committed wasm where the resolver looks for it", () => {
		const wasm = path.join(vendoredGrammarsDir(), CUE_GRAMMAR);
		expect(fs.existsSync(wasm)).toBe(true);
		// A wasm preamble, not an HTML error page (#1548's poisoning shape).
		expect([...fs.readFileSync(wasm).subarray(0, 4)]).toEqual([
			0x00, 0x61, 0x73, 0x6d,
		]);
	});

	it("parses a realistic CUE module with no ERROR or MISSING nodes", async () => {
		const tree = await client.parseFile("infra/services.cue", "cue", GOOD_CUE);
		expect(tree).toBeTruthy();
		expect(tree?.rootNode.type).toBe("source_file");
		expect(countBadNodes(tree?.rootNode as unknown as Node)).toEqual({
			errors: 0,
			missing: 0,
		});
	});

	it("degrades an unclosed struct to an ERROR node without crashing", async () => {
		const tree = await client.parseFile("infra/broken.cue", "cue", BROKEN_CUE);
		expect(tree).toBeTruthy();
		const bad = countBadNodes(tree?.rootNode as unknown as Node);
		expect(bad.errors + bad.missing).toBeGreaterThan(0);
		// The shared WASM Module must survive it — the #255 failure shape is a
		// broken parse poisoning every LATER parse, so re-parse the good fixture.
		const after = await client.parseFile("infra/services.cue", "cue", GOOD_CUE);
		expect(countBadNodes(after?.rootNode as unknown as Node)).toEqual({
			errors: 0,
			missing: 0,
		});
	});
});

describe("vendored grammars are never downloaded", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-vendored-"));
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// The CDN has no CUE wasm, so a fetch would 404 forever. The download path
	// must refuse the grammar outright and say so DURABLY — a retryable verdict
	// would put a permanently impossible fetch on #1536's cooldown ladder.
	it("refuses a vendored grammar with a non-retryable verdict", async () => {
		const result = await downloadGrammarDetailed(tmpDir, CUE_GRAMMAR);
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.reason).toContain("vendor/grammars");
		// Nothing was written, and no network call was made.
		expect(fs.existsSync(path.join(tmpDir, CUE_GRAMMAR))).toBe(false);
	});

	it("still downloads a normal grammar through the CDN path", () => {
		expect(isVendoredGrammar("tree-sitter-python.wasm")).toBe(false);
	});
});
