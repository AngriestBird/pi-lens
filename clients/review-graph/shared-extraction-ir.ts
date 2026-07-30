import type { FunctionSummary } from "../dispatch/facts/function-facts.js";
import type {
	ImportEntry,
	ReExportEntry,
} from "../dispatch/facts/import-facts.js";
import { normalizeMapKey } from "../path-utils.js";
import type { ExtractedSymbols } from "../tree-sitter-symbol-extractor.js";

export interface JsTsReviewGraphIr {
	kind: "jsts";
	imports: ImportEntry[];
	reexports: ReExportEntry[];
	functionSummaries: FunctionSummary[];
}

export interface TreeSitterReviewGraphIr {
	kind: "tree-sitter";
	languageId: string;
	extracted: ExtractedSymbols;
}

export type ReviewGraphStructuralIr =
	| JsTsReviewGraphIr
	| TreeSitterReviewGraphIr;

export interface ReviewGraphFileIr {
	filePath: string;
	contentHash: string;
	/** False means extraction degraded/failed; consumers must parse normally. */
	complete: boolean;
	structural?: ReviewGraphStructuralIr;
}

// Process-local handoff only. Values are compact extracted data: never source
// strings, web-tree-sitter trees, or FactStores. Keep a small root bound so an
// MCP process that visits many workspaces cannot retain every project's IR.
const MAX_ROOTS = 8;
const roots = new Map<string, Map<string, ReviewGraphFileIr>>();
let accepted = 0;
let rejected = 0;

function rootKey(cwd: string): string {
	return normalizeMapKey(cwd);
}

export function publishReviewGraphFileIr(
	cwd: string,
	entry: ReviewGraphFileIr,
): void {
	const key = rootKey(cwd);
	let files = roots.get(key);
	if (!files) {
		files = new Map();
		roots.set(key, files);
		while (roots.size > MAX_ROOTS) {
			const oldest = roots.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			roots.delete(oldest);
		}
	}
	files.set(normalizeMapKey(entry.filePath), {
		...entry,
		filePath: normalizeMapKey(entry.filePath),
	});
}

export function getFreshReviewGraphFileIr(
	cwd: string,
	filePath: string,
	contentHash: string,
): ReviewGraphFileIr | undefined {
	const files = roots.get(rootKey(cwd));
	const entry = files?.get(normalizeMapKey(filePath));
	if (!entry?.complete || entry.contentHash !== contentHash) {
		rejected++;
		return undefined;
	}
	accepted++;
	return entry;
}

/** Test/session-reset seam; normal graph builds never depend on this being called. */
export function clearReviewGraphFileIr(cwd?: string): void {
	if (cwd === undefined) roots.clear();
	else roots.delete(rootKey(cwd));
}

export function getReviewGraphIrStats(): {
	accepted: number;
	rejected: number;
} {
	return { accepted, rejected };
}

export function resetReviewGraphIrStats(): void {
	accepted = 0;
	rejected = 0;
}
