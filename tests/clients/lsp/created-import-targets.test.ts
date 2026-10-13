/**
 * #4346: the bounds of the created-module producer and of the workspace edit's
 * resource-operation announce, through the real modules (no language server
 * needed: neither spawns one).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	CREATED_IMPORT_SCAN_MAX_FILES,
	importTargetsToAnnounce,
} from "../../../clients/lsp/created-import-targets.js";
import { applyWorkspaceEdit } from "../../../clients/lsp/edits.js";
import { peekOwnedLspService } from "../../../clients/lsp/service-singleton.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { toPosix } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];
afterEach(() => {
	resetDegradationLedger();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function workspace(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		'{"name":"w","version":"0.0.0"}\n',
	);
	return root;
}

describe("importTargetsToAnnounce (#4346)", () => {
	// Recurrence: a sweep of hundreds of finding-bearing files would extract
	// every one of them on the diagnostics path; the cap bounds that, and the
	// record says what it left out.
	it("resolves at most the cap of importers per call and records the rest once", async () => {
		const root = workspace("pi-lens-4346-cap-");
		const importers: string[] = [];
		for (let i = 0; i <= CREATED_IMPORT_SCAN_MAX_FILES; i++) {
			const importer = path.join(root, `user${i}.ts`);
			fs.writeFileSync(importer, `import "./mod${i}";\nexport {};\n`);
			fs.writeFileSync(path.join(root, `mod${i}.ts`), "export {};\n");
			importers.push(importer);
		}

		const targets = (await importTargetsToAnnounce(root, importers)).map(
			(file) => toPosix(path.relative(root, file)),
		);
		await importTargetsToAnnounce(root, importers);

		expect(targets).toHaveLength(CREATED_IMPORT_SCAN_MAX_FILES);
		expect(targets).toContain("mod0.ts");
		expect(targets).not.toContain(`mod${CREATED_IMPORT_SCAN_MAX_FILES}.ts`);
		const record = getDegradationSummary().find(
			(group) => group.kind === "lsp-created-import-scan-incomplete",
		);
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]?.subject).toBe("capped");
	});

	it("records nothing within the cap", async () => {
		const root = workspace("pi-lens-4346-cap-under-");
		const importer = path.join(root, "user.ts");
		fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
		fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

		const targets = await importTargetsToAnnounce(root, [importer]);

		expect(targets.map((file) => toPosix(path.relative(root, file)))).toEqual([
			"mod.ts",
		]);
		expect(
			getDegradationSummary().some(
				(group) => group.kind === "lsp-created-import-scan-incomplete",
			),
		).toBe(false);
	});
});

describe("a workspace edit's resource operations with no LSP service (#4346)", () => {
	// Recurrence: an edit applied before any LSP use (a `rename_file` with no
	// client yet) must not start the LSP stack only to report its operations.
	it("applies the operation and creates no service", async () => {
		const root = workspace("pi-lens-4346-noservice-");
		const created = path.join(root, "made.ts");
		expect(peekOwnedLspService()).toBeUndefined();

		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			root,
		);

		expect(fs.existsSync(created)).toBe(true);
		expect(peekOwnedLspService()).toBeUndefined();
	});
});
