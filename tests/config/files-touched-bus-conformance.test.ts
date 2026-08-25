import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";

const EVENT = "pilens:files:touched";

type BusSurfaceEntry = {
	file: string;
	why: string;
};

// This is the reviewable contract. If a new module publishes or subscribes,
// the source scan below fails until this list and AGENTS.md are updated with
// the reason that the bus applies there.
const PUBLISHERS: BusSurfaceEntry[] = [
	{
		file: "clients/pipeline.ts",
		why: "immediate format and synchronous autofix completion",
	},
	{
		file: "clients/runtime-agent-end.ts",
		why: "deferred format/autofix and actionable-warning LSP autofix completion",
	},
	{
		file: "clients/lsp-mutation.ts",
		why: "format/autofix mutation summary completion",
	},
];

const SUBSCRIBERS: BusSurfaceEntry[] = [
	{
		file: "clients/agent-nudge.ts",
		why: "read-guard-filtered context nudge for touched paths",
	},
];

function sourceFiles(): string[] {
	const roots = ["clients", "tools", "mcp", "scripts"];
	const files: string[] = [];
	for (const root of roots) {
		const output = execFileSync("rg", ["--files", root], {
			cwd: repoRoot,
			encoding: "utf8",
		}) as string;
		files.push(...output.trim().split(/\r?\n/).filter(Boolean));
	}
	files.push("index.ts");
	return [...new Set(files)]
		.map((file) => file.replaceAll("\\", "/"))
		.filter((file) => /\.(?:ts|js|mjs)$/.test(file));
}

function read(file: string): string {
	return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

describe("pilens:files:touched bus surface (#1966)", () => {
	it("keeps the event constant and declared publisher list in conformance", () => {
		const files = sourceFiles();
		const eventFiles = files.filter((file) => read(file).includes(EVENT));
		expect(eventFiles).toContain("clients/bus-publish.ts");
		expect(eventFiles).toContain("clients/agent-nudge.ts");

		const actual = files
			.filter((file) => file !== "clients/bus-publish.ts")
			.filter((file) => /publishFilesTouched\s*\(/.test(read(file)))
			.sort();
		expect(actual, "new publisher: update PUBLISHERS and AGENTS.md").toEqual(
			PUBLISHERS.map((entry) => entry.file).sort(),
		);
	});

	it("keeps the event subscriber list in conformance", () => {
		const actual = sourceFiles()
			.filter((file) => /events\.on\(BUS_FILES_TOUCHED_EVENT/.test(read(file)))
			.sort();
		expect(actual, "new subscriber: update SUBSCRIBERS and AGENTS.md").toEqual(
			SUBSCRIBERS.map((entry) => entry.file).sort(),
		);
	});

	it("requires every declaration to explain why the bus applies", () => {
		const docs = read("AGENTS.md");
		for (const entry of [...PUBLISHERS, ...SUBSCRIBERS]) {
			expect(entry.why.length, `${entry.file} needs a reason`).toBeGreaterThan(
				20,
			);
			expect(docs, `${entry.file} is missing from AGENTS.md`).toContain(
				entry.file,
			);
		}
	});
});
