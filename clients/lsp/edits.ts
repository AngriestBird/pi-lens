import fs from "node:fs/promises";
import path from "node:path";
import { isUnderDir, pathsEqual, uriToPath } from "./path-utils.js";

export interface LSPPosition {
	line: number;
	character: number;
}

export interface LSPRange {
	start: LSPPosition;
	end: LSPPosition;
}

export interface LSPTextEdit {
	range: LSPRange;
	newText: string;
}

interface TextDocumentEdit {
	textDocument: { uri: string };
	edits: unknown[];
}

interface CreateFileOp {
	kind: "create";
	uri: string;
}

interface RenameFileOp {
	kind: "rename";
	oldUri: string;
	newUri: string;
}

interface DeleteFileOp {
	kind: "delete";
	uri: string;
}

export interface AppliedWorkspaceEdit {
	descriptions: string[];
	files: string[];
}

function isPosition(value: unknown): value is LSPPosition {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { line?: unknown }).line === "number" &&
		typeof (value as { character?: unknown }).character === "number"
	);
}

function isRange(value: unknown): value is LSPRange {
	return (
		typeof value === "object" &&
		value !== null &&
		isPosition((value as { start?: unknown }).start) &&
		isPosition((value as { end?: unknown }).end)
	);
}

function isTextEdit(value: unknown): value is LSPTextEdit {
	return (
		typeof value === "object" &&
		value !== null &&
		isRange((value as { range?: unknown }).range) &&
		typeof (value as { newText?: unknown }).newText === "string"
	);
}

function isTextDocumentEdit(value: unknown): value is TextDocumentEdit {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { textDocument?: { uri?: unknown } }).textDocument?.uri ===
			"string" &&
		Array.isArray((value as { edits?: unknown }).edits)
	);
}

function comparePosition(a: LSPPosition, b: LSPPosition): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function formatRange(range: LSPRange): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

export function rangesOverlap(a: LSPRange, b: LSPRange): boolean {
	return (
		comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0
	);
}

function positionsEqual(a: LSPPosition, b: LSPPosition): boolean {
	return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: LSPRange, b: LSPRange): boolean {
	return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: LSPRange): boolean {
	return positionsEqual(range.start, range.end);
}

function sortAndValidateTextEdits(edits: LSPTextEdit[]): LSPTextEdit[] {
	const sorted = edits
		.map((edit, index) => ({ edit, index }))
		.sort((a, b) => {
			const positionDelta = comparePosition(b.edit.range.start, a.edit.range.start);
			return positionDelta !== 0 ? positionDelta : b.index - a.index;
		})
		.map(({ edit }) => edit);
	const unique: LSPTextEdit[] = [];
	for (const edit of sorted) {
		const previous = unique[unique.length - 1];
		if (
			previous &&
			!isEmptyRange(edit.range) &&
			rangesEqual(previous.range, edit.range) &&
			previous.newText === edit.newText
		) {
			continue;
		}
		unique.push(edit);
	}

	for (let index = 0; index < unique.length - 1; index++) {
		const later = unique[index]?.range;
		const earlier = unique[index + 1]?.range;
		if (later && earlier && comparePosition(earlier.end, later.start) > 0) {
			throw new Error(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}`,
			);
		}
	}
	return unique;
}

export function applyTextEditsToString(
	content: string,
	edits: LSPTextEdit[],
): string {
	const lines = content.split("\n");
	for (const edit of sortAndValidateTextEdits(edits)) {
		const { start, end } = edit.range;
		if (start.line === end.line) {
			const line = lines[start.line] ?? "";
			lines[start.line] =
				line.slice(0, start.character) +
				edit.newText +
				line.slice(end.character);
			continue;
		}

		const startLine = lines[start.line] ?? "";
		const endLine = lines[end.line] ?? "";
		const replacement =
			startLine.slice(0, start.character) +
			edit.newText +
			endLine.slice(end.character);
		lines.splice(
			start.line,
			end.line - start.line + 1,
			...replacement.split("\n"),
		);
	}

	return lines.join("\n");
}

export function flattenWorkspaceTextEdits(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): Map<string, LSPTextEdit[]> {
	const out = new Map<string, LSPTextEdit[]>();
	const push = (uri: string, edits: unknown[]) => {
		const textEdits = edits.filter(isTextEdit);
		if (textEdits.length === 0) return;
		const existing = out.get(uri);
		if (existing) existing.push(...textEdits);
		else out.set(uri, [...textEdits]);
	};

	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		push(uri, edits);
	}

	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) {
			push(change.textDocument.uri, change.edits);
		}
	}

	return out;
}

function textEditKey(uri: string, edit: LSPTextEdit): string {
	return [
		uri,
		edit.range.start.line,
		edit.range.start.character,
		edit.range.end.line,
		edit.range.end.character,
		edit.newText,
	].join(":");
}

export interface MergeWorkspaceEditsResult {
	edit: { changes: Record<string, LSPTextEdit[]> };
	droppedConflicts: number;
	inputEditCount: number;
	serverIds: string[];
}

export function mergeWorkspaceTextEditsByPriority(
	entries: Array<{
		serverId: string;
		edit:
			| { changes?: Record<string, unknown[]>; documentChanges?: unknown[] }
			| null
			| undefined;
	}>,
): MergeWorkspaceEditsResult {
	const merged = new Map<string, LSPTextEdit[]>();
	const seenExact = new Set<string>();
	let droppedConflicts = 0;
	let inputEditCount = 0;
	const serverIds: string[] = [];

	for (const entry of entries) {
		serverIds.push(entry.serverId);
		if (!entry.edit) continue;
		for (const [uri, edits] of flattenWorkspaceTextEdits(entry.edit)) {
			const kept = merged.get(uri) ?? [];
			for (const edit of edits) {
				inputEditCount += 1;
				const exactKey = textEditKey(uri, edit);
				if (seenExact.has(exactKey)) continue;
				if (
					kept.some((existing) => rangesOverlap(existing.range, edit.range))
				) {
					droppedConflicts += 1;
					continue;
				}
				seenExact.add(exactKey);
				kept.push(edit);
			}
			if (kept.length > 0) merged.set(uri, kept);
		}
	}

	const changes: Record<string, LSPTextEdit[]> = {};
	for (const [uri, edits] of merged) {
		changes[uri] = edits;
	}
	return { edit: { changes }, droppedConflicts, inputEditCount, serverIds };
}

type WorkspaceEditOp =
	| { kind: "text"; uri: string; edits: LSPTextEdit[] }
	| CreateFileOp
	| RenameFileOp
	| DeleteFileOp;

function planWorkspaceEdit(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): WorkspaceEditOp[] {
	const ops: WorkspaceEditOp[] = [];
	const pending = new Map<string, LSPTextEdit[]>();
	const queue = (uri: string, edits: unknown[]) => {
		const textEdits = edits.filter(isTextEdit);
		if (textEdits.length === 0) return;
		const existing = pending.get(uri);
		if (existing) existing.push(...textEdits);
		else pending.set(uri, [...textEdits]);
	};
	const flushUri = (uri: string) => {
		const edits = pending.get(uri);
		if (!edits) return;
		pending.delete(uri);
		ops.push({ kind: "text", uri, edits });
	};
	const flushSubtree = (uri: string) => {
		const targetPath = uriToPath(uri);
		for (const candidate of [...pending.keys()]) {
			const candidatePath = uriToPath(candidate);
			if (
				pathsEqual(candidatePath, targetPath) ||
				isUnderDir(candidatePath, targetPath)
			) {
				flushUri(candidate);
			}
		}
	};

	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		queue(uri, edits);
	}
	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) {
			queue(change.textDocument.uri, change.edits);
			continue;
		}
		if (typeof change !== "object" || change === null || !("kind" in change)) {
			continue;
		}
		const kind = (change as { kind?: unknown }).kind;
		if (kind === "create" && typeof (change as CreateFileOp).uri === "string") {
			const op = change as CreateFileOp;
			flushUri(op.uri);
			ops.push(op);
		} else if (
			kind === "rename" &&
			typeof (change as RenameFileOp).oldUri === "string" &&
			typeof (change as RenameFileOp).newUri === "string"
		) {
			const op = change as RenameFileOp;
			flushSubtree(op.oldUri);
			flushSubtree(op.newUri);
			ops.push(op);
		} else if (
			kind === "delete" &&
			typeof (change as DeleteFileOp).uri === "string"
		) {
			const op = change as DeleteFileOp;
			flushSubtree(op.uri);
			ops.push(op);
		}
	}
	for (const uri of [...pending.keys()]) flushUri(uri);
	return ops;
}

function relativeToCwd(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath) || path.basename(filePath);
	return rel.replace(/\\/g, "/");
}

export function summarizeWorkspaceEdit(
	edit: {
		changes?: Record<string, unknown[]>;
		documentChanges?: unknown[];
	},
	cwd: string,
): string[] {
	const lines: string[] = [];
	const textEditsByUri = flattenWorkspaceTextEdits(edit);
	for (const [uri, edits] of textEditsByUri) {
		lines.push(
			`Apply ${edits.length} edit(s) to ${relativeToCwd(uriToPath(uri), cwd)}`,
		);
	}
	for (const change of edit.documentChanges ?? []) {
		if (typeof change !== "object" || change === null || !("kind" in change))
			continue;
		const kind = (change as { kind?: unknown }).kind;
		if (kind === "create" && typeof (change as CreateFileOp).uri === "string") {
			lines.push(
				`Create ${relativeToCwd(uriToPath((change as CreateFileOp).uri), cwd)}`,
			);
		} else if (
			kind === "rename" &&
			typeof (change as RenameFileOp).oldUri === "string" &&
			typeof (change as RenameFileOp).newUri === "string"
		) {
			lines.push(
				`Rename ${relativeToCwd(uriToPath((change as RenameFileOp).oldUri), cwd)} → ${relativeToCwd(uriToPath((change as RenameFileOp).newUri), cwd)}`,
			);
		} else if (
			kind === "delete" &&
			typeof (change as DeleteFileOp).uri === "string"
		) {
			lines.push(
				`Delete ${relativeToCwd(uriToPath((change as DeleteFileOp).uri), cwd)}`,
			);
		}
	}
	return lines;
}

export async function applyWorkspaceEdit(
	edit: {
		changes?: Record<string, unknown[]>;
		documentChanges?: unknown[];
	},
	cwd: string,
): Promise<AppliedWorkspaceEdit> {
	const descriptions: string[] = [];
	const touchedFiles = new Set<string>();
	const planned = planWorkspaceEdit(edit).map((op): WorkspaceEditOp =>
		op.kind === "text"
			? { ...op, edits: sortAndValidateTextEdits(op.edits) }
			: op,
	);

	try {
		for (const op of planned) {
			if (op.kind === "text") {
				const filePath = uriToPath(op.uri);
				const content = await fs.readFile(filePath, "utf-8");
				const updated = applyTextEditsToString(content, op.edits);
				await fs.writeFile(filePath, updated, "utf-8");
				touchedFiles.add(filePath);
				descriptions.push(
					`Applied ${op.edits.length} edit(s) to ${relativeToCwd(filePath, cwd)}`,
				);
			} else if (op.kind === "create") {
				const filePath = uriToPath(op.uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs
					.writeFile(filePath, "", { flag: "wx" })
					.catch(async (err: unknown) => {
						if ((err as { code?: string }).code !== "EEXIST") throw err;
					});
				touchedFiles.add(filePath);
				descriptions.push(`Created ${relativeToCwd(filePath, cwd)}`);
			} else if (op.kind === "rename") {
				const oldPath = uriToPath(op.oldUri);
				const newPath = uriToPath(op.newUri);
				await fs.mkdir(path.dirname(newPath), { recursive: true });
				await fs.rename(oldPath, newPath);
				touchedFiles.add(oldPath);
				touchedFiles.add(newPath);
				descriptions.push(
					`Renamed ${relativeToCwd(oldPath, cwd)} → ${relativeToCwd(newPath, cwd)}`,
				);
			} else if (op.kind === "delete") {
				const filePath = uriToPath(op.uri);
				await fs.rm(filePath, { recursive: true, force: true });
				touchedFiles.add(filePath);
				descriptions.push(`Deleted ${relativeToCwd(filePath, cwd)}`);
			}
		}
	} catch (err) {
		const already = [...touchedFiles];
		if (already.length > 0) {
			const alreadyList = already
				.map((f) => `  • ${relativeToCwd(f, cwd)}`)
				.join("\n");
			throw new Error(
				`Workspace edit failed mid-application — ${already.length} file(s) already written, no rollback performed:\n${alreadyList}\nCause: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		throw err;
	}

	return { descriptions, files: [...touchedFiles] };
}
