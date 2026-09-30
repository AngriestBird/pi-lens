/**
 * #3601: `lsp_navigation`'s rename reads the content every file its workspace
 * edit touches before the edit is applied, and passes it to
 * `applyWorkspaceEdit` as `expectedContent`. A file that changed in between is
 * refused, and the refusal names it in the tool result and in the degradation
 * ledger. The LSP service is a fake at that one boundary; the apply, pi's
 * mutation queue, and the degradation ledger are the real ones.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const lsp = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: () => lsp.service,
}));

import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

function sameFile(a: string, b: string): boolean {
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

let env: ReturnType<typeof setupTestEnvironment>;
let fileA: string;
let fileB: string;

beforeEach(() => {
	resetDegradationLedger();
	env = setupTestEnvironment("pi-lens-lsp-nav-stale-");
	fileA = path.join(env.tmpDir, "a.ts");
	fileB = path.join(env.tmpDir, "b.ts");
	fs.writeFileSync(fileA, "const = 1;\n");
	fs.writeFileSync(fileB, "const = 2;\n");
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
});

afterEach(() => {
	lsp.service = undefined;
	setHostFileMutationQueueLoader(undefined);
	env.cleanup();
});

/** Replaces `const` on line 1 of `target` with `let`. */
const valueEdit = (target = fileA) => ({
	changes: {
		[pathToFileURL(target).href]: [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				newText: "let",
			},
		],
	},
});

const staleRows = () =>
	getDegradationSummary().filter(
		(group) => group.kind === "lsp-edit-stale-content",
	);

async function runRename(): Promise<{
	isError?: boolean;
	content: Array<{ text?: string }>;
}> {
	const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
	return (await tool.execute(
		"rename-3601",
		{
			operation: "rename",
			path: fileA,
			line: 1,
			character: 1,
			newName: "let",
			apply: true,
		},
		new AbortController().signal,
		null,
		{ cwd: env.tmpDir },
	)) as never;
}

const resultText = (result: { content: Array<{ text?: string }> }): string =>
	String(result.content[0]?.text ?? "");

describe("#3601: lsp_navigation's rename refuses an edit on a file that changed", () => {
	it("an agent write made while the rename is computed is not overwritten, and the refusal names the file", async () => {
		const parked = gate();
		const resume = gate();
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => {
				parked.open();
				await resume.p;
				return valueEdit();
			},
		});

		const pending = runRename();
		await parked.p;
		// The rename has read its target and is parked inside the server call.
		await withFileMutationQueue(fileA, async () => {
			fs.writeFileSync(fileA, "AGENT = 9;\n");
		});
		resume.open();
		const result = await pending;

		// The rename's offsets land on the agent's bytes unless the edit is refused.
		expect(fs.readFileSync(fileA, "utf8")).toBe("AGENT = 9;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileA));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("an agent write made while a second touched file is read is not overwritten", async () => {
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => ({
				changes: {
					...valueEdit(fileA).changes,
					...valueEdit(fileB).changes,
				},
			}),
			// The edit's second file is read first, then the agent's write lands
			// before the edit reaches its queue. Only the pre-apply read is a
			// concurrent write; the post-apply resync sees the edit's own bytes.
			touchFile: vi.fn(async (touched: string) => {
				if (
					sameFile(touched, fileB) &&
					fs.readFileSync(fileB, "utf8") === "const = 2;\n"
				)
					fs.writeFileSync(fileB, "AGENT = 8;\n");
				return { diags: [] };
			}),
		});

		const result = await runRename();

		// Neither touched file takes the other's stale offsets.
		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 8;\n");
		// The whole edit is refused before any write, so the other file is untouched.
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("no-drop: with no write in between, the rename applies and records no stale content", async () => {
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => valueEdit(),
		});

		const result = await runRename();

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(staleRows()).toEqual([]);
	});
});
