import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveImportToFiles } from "../../../clients/review-graph/import-resolvers.js";
import {
	clearTsconfigPathsCache,
	parseTsconfigPaths,
} from "../../../clients/review-graph/tsconfig-paths.js";
import { setupTestEnvironment } from "../test-utils.js";

let root: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-tsconfig-paths-");
	root = env.tmpDir;
	cleanup = env.cleanup;
	clearTsconfigPathsCache();
});

afterEach(() => {
	clearTsconfigPathsCache();
	cleanup();
});

function write(rel: string, content = "export const value = 1;\n"): string {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

function resolve(source: string): string[] {
	return resolveImportToFiles(
		root,
		path.join(root, "src", "main.ts"),
		"jsts",
		source,
	).map((file) => path.relative(root, file).replace(/\\/g, "/"));
}

describe("tsconfig paths import resolution (#775 R2)", () => {
	it("resolves a baseUrl + paths alias to a workspace file", () => {
		write(
			"tsconfig.json",
			'{\n // JSONC is valid here\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"], }, },\n}',
		);
		write("src/utils/x.ts");
		expect(resolve("@app/utils/x")).toEqual(["src/utils/x.ts"]);
	});

	it("uses the longest matching prefix", () => {
		write(
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: {
					baseUrl: ".",
					paths: {
						"@app/*": ["generic/*"],
						"@app/utils/*": ["special/*"],
					},
				},
			}),
		);
		write("generic/utils/x.ts");
		write("special/x.ts");
		expect(resolve("@app/utils/x")).toEqual(["special/x.ts"]);
	});

	it("honors paths inherited through a relative extends chain", () => {
		write(
			"config/tsconfig.base.json",
			JSON.stringify({
				compilerOptions: { baseUrl: "..", paths: { "@shared/*": ["lib/*"] } },
			}),
		);
		write("tsconfig.json", JSON.stringify({ extends: "./config/tsconfig.base" }));
		write("lib/value.ts");
		expect(resolve("@shared/value")).toEqual(["lib/value.ts"]);
	});

	it("leaves an unmatched alias unresolved for the existing external fallback", () => {
		write(
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
			}),
		);
		expect(resolve("@other/missing")).toEqual([]);
	});

	it("ignores a malformed tsconfig gracefully", () => {
		write("tsconfig.json", "{ definitely not json");
		expect(() => resolve("@app/value")).not.toThrow();
		expect(resolve("@app/value")).toEqual([]);
	});

	it("refuses a tsconfig found at the configured home-directory ceiling", () => {
		const project = path.join(root, "project", "src");
		write(
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
			}),
		);
		expect(parseTsconfigPaths(project, root)).toEqual([]);
	});
});
