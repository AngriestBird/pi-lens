import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";
import {
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

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
];

const SUBSCRIBERS: BusSurfaceEntry[] = [
	{
		file: "clients/agent-nudge.ts",
		why: "read-guard-filtered context nudge for touched paths",
	},
];

function sourceFiles(): string[] {
	const roots = ["clients", "tools", "mcp", "scripts"];
	const files = roots.flatMap((root) =>
		listSourceFiles(path.join(repoRoot, root), {
			// Scan authored TypeScript only: the build emits sibling .js files,
			// and those compiled artifacts must never become bus declarations.
			extensions: [".ts"],
			skipDeclarations: false,
		}),
	);
	files.push(path.join(repoRoot, "index.ts"));
	return [...new Set(files)]
		.map((file) => relativePosix(repoRoot, file))
		.filter((file) => /\.(?:ts|js|mjs)$/.test(file))
		.sort((a, b) => a.localeCompare(b));
}

function read(file: string): string {
	return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

function busPublisherFiles(
	files: string[],
	sources: Map<string, string>,
): string[] {
	return files
		.filter((file) => file !== "clients/bus-publish.ts")
		.filter((file) => {
			const source = stripSource(sources.get(file) ?? "");
			const importSource = stripSource(sources.get(file) ?? "", {
				strings: "keep",
			});
			// Bare calls catch the direct seam; the import catches aliases. A property
			// call such as context.publishFilesTouched() is intentionally not a bus
			// publication: lsp-mutation's optional callback is unwired and narrower.
			const directCall = /(?<![\w$.])publishFilesTouched\s*\(/.test(source);
			const seamImport =
				/import\s*\{[^}]*\bpublishFilesTouched\b[^}]*\}\s*from\s*["'][^"']*bus-publish(?:\.js)?["']/.test(
					importSource,
				);
			return directCall || seamImport;
		});
}

function busSubscriberFiles(
	files: string[],
	sources: Map<string, string>,
): string[] {
	return files.filter((file) => {
		// Keep strings while blanking comments: this permits both
		// bus.on("pilens:files:touched", ...) and bus.on(EVENT, ...) where
		// EVENT is a local constant initialized to that event string.
		const source = stripSource(sources.get(file) ?? "", { strings: "keep" });
		const bindings = new Set<string>();
		const definition =
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']pilens:files:touched["']/g;
		let match: RegExpExecArray | null;
		while ((match = definition.exec(source))) bindings.add(match[1]);
		const eventArgument = `(?:["']${EVENT}["']|${
			[...bindings]
				.map((binding) => binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("|") || "(?!)"
		})`;
		return new RegExp(`\\.on\\s*\\(\\s*${eventArgument}(?=\\s*[,)])`).test(
			source,
		);
	});
}

describe("pilens:files:touched bus surface (#1966)", () => {
	it("keeps the event constant and declared publisher list in conformance", () => {
		const files = sourceFiles();
		const sources = new Map(files.map((file) => [file, read(file)]));
		const eventFiles = files.filter((file) => read(file).includes(EVENT));
		expect(eventFiles).toContain("clients/bus-publish.ts");
		expect(eventFiles).toContain("clients/agent-nudge.ts");

		const actual = busPublisherFiles(files, sources).sort((a, b) =>
			a.localeCompare(b),
		);
		expect(actual, "new publisher: update PUBLISHERS and AGENTS.md").toEqual(
			PUBLISHERS.map((entry) => entry.file).sort((a, b) => a.localeCompare(b)),
		);
	});

	it("keeps the event subscriber list in conformance", () => {
		const files = sourceFiles();
		const sources = new Map(files.map((file) => [file, read(file)]));
		const actual = busSubscriberFiles(files, sources).sort((a, b) =>
			a.localeCompare(b),
		);
		expect(actual, "new subscriber: update SUBSCRIBERS and AGENTS.md").toEqual(
			SUBSCRIBERS.map((entry) => entry.file).sort((a, b) => a.localeCompare(b)),
		);
	});

	it("handles the review probes without text-scan false positives", () => {
		const files = ["comment.ts", "alias.ts", "literal-subscriber.ts"];
		const sources = new Map([
			[
				"comment.ts",
				'// publishFilesTouched(); events.on(\\"pilens:files:touched\\");',
			],
			[
				"alias.ts",
				'import { publishFilesTouched as emitTouched } from "./bus-publish.js"; emitTouched({});',
			],
			["literal-subscriber.ts", 'bus.on("pilens:files:touched", handler);'],
		]);
		expect(busPublisherFiles(files, sources)).toEqual(["alias.ts"]);
		expect(busSubscriberFiles(files, sources)).toEqual([
			"literal-subscriber.ts",
		]);
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
