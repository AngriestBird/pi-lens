import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applyTextEditsToString,
	applyWorkspaceEdit,
	mergeWorkspaceTextEditsByPriority,
} from "../../../clients/lsp/edits.js";
import { removeTempDirSync } from "../test-utils.js";

describe("LSP workspace edits", () => {
	it("preserves original array order for inserts at the same position", () => {
		expect(
			applyTextEditsToString("ab", [
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 1 },
					},
					newText: "first",
				},
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 1 },
					},
					newText: "second",
				},
			]),
		).toBe("afirstsecondb");
	});

	it("throws a descriptive error for overlapping text edits", () => {
		expect(() =>
			applyTextEditsToString("abcdef", [
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 4 },
					},
					newText: "X",
				},
				{
					range: {
						start: { line: 0, character: 3 },
						end: { line: 0, character: 5 },
					},
					newText: "Y",
				},
			]),
		).toThrow(/overlapping LSP edits: 1:2-1:5 conflicts with 1:4-1:6/);
	});

	it("merges workspace edits by priority and drops lower-priority overlaps", () => {
		const uri = "file:///tmp/app.ts";
		const result = mergeWorkspaceTextEditsByPriority([
			{
				serverId: "typescript",
				edit: {
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 1 },
									end: { line: 0, character: 4 },
								},
								newText: "primary",
							},
						],
					},
				},
			},
			{
				serverId: "eslint",
				edit: {
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 2 },
									end: { line: 0, character: 5 },
								},
								newText: "secondary",
							},
						],
					},
				},
			},
		]);

		expect(result.droppedConflicts).toBe(1);
		expect(result.edit.changes[uri]).toEqual([
			{
				range: {
					start: { line: 0, character: 1 },
					end: { line: 0, character: 4 },
				},
				newText: "primary",
			},
		]);
	});

	it("collapses byte-identical non-empty duplicate edits", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "duplicate.ts");
		fs.writeFileSync(filePath, "abc", "utf-8");
		const duplicate = {
			range: {
				start: { line: 0, character: 1 },
				end: { line: 0, character: 2 },
			},
			newText: "X",
		};

		try {
			const result = await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(filePath).href]: [duplicate, duplicate],
					},
				},
				tmpDir,
			);

			expect(fs.readFileSync(filePath, "utf-8")).toBe("aXc");
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to duplicate.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("validates every text batch before the first filesystem write", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const firstPath = path.join(tmpDir, "first.ts");
		const secondPath = path.join(tmpDir, "second.ts");
		fs.writeFileSync(firstPath, "first", "utf-8");
		fs.writeFileSync(secondPath, "second", "utf-8");

		try {
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[pathToFileURL(firstPath).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 5 },
									},
									newText: "changed",
								},
							],
							[pathToFileURL(secondPath).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 4 },
									},
									newText: "A",
								},
								{
									range: {
										start: { line: 0, character: 2 },
										end: { line: 0, character: 6 },
									},
									newText: "B",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/overlapping LSP edits/);
			expect(fs.readFileSync(firstPath, "utf-8")).toBe("first");
			expect(fs.readFileSync(secondPath, "utf-8")).toBe("second");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("applies text edits before resource renames", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const oldName = 1;\n", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(oldPath).href]: [
							{
								range: {
									start: { line: 0, character: 13 },
									end: { line: 0, character: 20 },
								},
								newText: "newName",
							},
						],
					},
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(oldPath).href,
							newUri: pathToFileURL(newPath).href,
						},
					],
				},
				tmpDir,
			);

			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const newName = 1;\n",
			);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to old.ts",
				"Renamed old.ts → new.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preserves declared create-then-text ordering", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "created.ts");
		const uri = pathToFileURL(filePath).href;

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri },
						{
							textDocument: { uri },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "created",
								},
							],
						},
					],
				},
				tmpDir,
			);

			expect(fs.readFileSync(filePath, "utf-8")).toBe("created");
			expect(result.descriptions).toEqual([
				"Created created.ts",
				"Applied 1 edit(s) to created.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("flushes child text edits before a parent directory rename", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const oldChild = path.join(oldDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.writeFileSync(oldChild, "old", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(oldChild).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 3 },
									},
									newText: "new",
								},
							],
						},
						{
							kind: "rename",
							oldUri: pathToFileURL(oldDir).href,
							newUri: pathToFileURL(newDir).href,
						},
					],
				},
				tmpDir,
			);

			expect(fs.readFileSync(path.join(newDir, "child.ts"), "utf-8")).toBe(
				"new",
			);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to old/child.ts",
				"Renamed old → new",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("flushes destination-subtree edits before a directory rename", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const destinationChild = path.join(newDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.mkdirSync(newDir);
		fs.writeFileSync(path.join(oldDir, "source.ts"), "source", "utf-8");
		fs.writeFileSync(destinationChild, "old", "utf-8");

		try {
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								textDocument: {
									uri: pathToFileURL(destinationChild).href,
								},
								edits: [
									{
										range: {
											start: { line: 0, character: 0 },
											end: { line: 0, character: 3 },
										},
										newText: "new",
									},
								],
							},
							{
								kind: "rename",
								oldUri: pathToFileURL(oldDir).href,
								newUri: pathToFileURL(newDir).href,
							},
						],
					},
					tmpDir,
				),
			).rejects.toThrow(/no rollback performed:[\s\S]*new\/child\.ts/);
			expect(fs.readFileSync(destinationChild, "utf-8")).toBe("new");
			expect(fs.existsSync(path.join(oldDir, "source.ts"))).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("flushes child edits before recursively deleting their directory", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const doomedDir = path.join(tmpDir, "doomed");
		const childPath = path.join(doomedDir, "nested", "child.ts");
		fs.mkdirSync(path.dirname(childPath), { recursive: true });
		fs.writeFileSync(childPath, "old", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(childPath).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 3 },
									},
									newText: "new",
								},
							],
						},
						{ kind: "delete", uri: pathToFileURL(doomedDir).href },
					],
				},
				tmpDir,
			);

			expect(fs.existsSync(doomedDir)).toBe(false);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to doomed/nested/child.ts",
				"Deleted doomed",
			]);
			expect(result.files).toEqual([childPath, doomedDir]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
