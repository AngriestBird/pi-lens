import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { normalizeMapKey } from "./path-utils.js";

export type AdvisoryFileRole = "source" | "test" | "affected";

export interface AdvisoryFileProvenance {
	path: string;
	role: AdvisoryFileRole;
	mtimeMs: number;
	size: number;
	sha256: string;
}

export interface AdvisoryProvenance {
	revision: {
		sessionId: string;
		projectSeq: number;
		turnIndex: number;
		generation: number;
		capturedAt: number;
	};
	files: AdvisoryFileProvenance[];
	truncated?: boolean;
}

export interface AdvisoryValidation {
	status: "current" | "superseded" | "unknown";
	reasons: string[];
	allFilesDeleted: boolean;
	changedPathCount: number;
}

export const MAX_ADVISORY_AFFECTED_FILES = 256;

export function advisoryPathKey(filePath: string, cwd: string): string {
	return normalizeMapKey(path.resolve(cwd, filePath));
}

/** Shared with git guard: there is one SHA-256 implementation for advisories. */
export function advisoryFileHash(filePath: string): string {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		return code === "ENOENT" ? "missing" : `unreadable:${code}`;
	}
}

function snapshotOne(
	filePath: string,
	cwd: string,
	role: AdvisoryFileRole,
): AdvisoryFileProvenance {
	const resolved = path.resolve(cwd, filePath);
	try {
		const stat = fs.statSync(resolved);
		return {
			path: resolved,
			role,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			sha256: advisoryFileHash(resolved),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		return {
			path: resolved,
			role,
			mtimeMs: -1,
			size: -1,
			sha256: code === "ENOENT" ? "missing" : `unreadable:${code}`,
		};
	}
}

export function snapshotAdvisoryProvenance(args: {
	cwd: string;
	runtime: Pick<RuntimeCoordinator, "telemetrySessionId" | "projectSeq" | "turnIndex">;
	generation: number;
	files: Array<{ path: string; role: AdvisoryFileRole }>;
	capturedAt?: number;
	truncated?: boolean;
}): AdvisoryProvenance {
	const seen = new Set<string>();
	const files: AdvisoryFileProvenance[] = [];
	for (const file of args.files) {
		const key = advisoryPathKey(file.path, args.cwd);
		if (seen.has(key)) continue;
		seen.add(key);
		files.push(snapshotOne(file.path, args.cwd, file.role));
	}
	return {
		revision: {
			sessionId: args.runtime.telemetrySessionId,
			projectSeq: args.runtime.projectSeq,
			turnIndex: args.runtime.turnIndex,
			generation: args.generation,
			capturedAt: args.capturedAt ?? Date.now(),
		},
		files,
		...(args.truncated ? { truncated: true } : {}),
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isCapturedHash(value: unknown): value is string {
	return typeof value === "string" &&
		(/^[a-f0-9]{64}$/.test(value) || value === "missing" || value.startsWith("unreadable:"));
}

function isWellFormed(value: unknown): value is AdvisoryProvenance {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AdvisoryProvenance>;
	const revision = record.revision;
	return !!revision && typeof revision.sessionId === "string" &&
		isFiniteNumber(revision.projectSeq) && isFiniteNumber(revision.turnIndex) &&
		isFiniteNumber(revision.generation) && isFiniteNumber(revision.capturedAt) &&
		Array.isArray(record.files) && record.files.length > 0 && record.files.every((file) =>
			!!file && typeof file.path === "string" &&
			(file.role === "source" || file.role === "test" || file.role === "affected") &&
			isFiniteNumber(file.mtimeMs) && isFiniteNumber(file.size) &&
			isCapturedHash(file.sha256)
		);
}

export function validateAdvisoryProvenance(
	record: { provenance?: unknown },
	cwd: string,
	runtime?: Pick<RuntimeCoordinator, "telemetrySessionId" | "projectSeq" | "turnIndex">,
): AdvisoryValidation {
	if (!isWellFormed(record.provenance)) {
		return { status: "unknown", reasons: ["malformed-or-legacy-provenance"], allFilesDeleted: false, changedPathCount: 0 };
	}
	const provenance = record.provenance;
	const reasons: string[] = [];
	let unknown = provenance.truncated === true;
	if (unknown) reasons.push("truncated-provenance");
	if (runtime) {
		if (provenance.revision.sessionId !== runtime.telemetrySessionId) reasons.push("session-mismatch");
	}
	let deletedFiles = 0;
	const changedPaths = new Set<string>();
	for (const captured of provenance.files) {
		const resolved = path.resolve(cwd, captured.path);
		const reasonsBefore = reasons.length;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "unknown";
			if (code === "ENOENT") {
				if (captured.sha256 !== "missing") {
					deletedFiles += 1;
					reasons.push(`missing:${advisoryPathKey(resolved, cwd)}`);
					changedPaths.add(advisoryPathKey(resolved, cwd));
				}
			}
			else {
				unknown = true;
				reasons.push(`unreadable:${advisoryPathKey(resolved, cwd)}:${code}`);
				changedPaths.add(advisoryPathKey(resolved, cwd));
			}
			continue;
		}
		if (captured.sha256.startsWith("unreadable:")) {
			unknown = true;
			reasons.push(`capture-unreadable:${advisoryPathKey(resolved, cwd)}`);
			changedPaths.add(advisoryPathKey(resolved, cwd));
			continue;
		}
		if (captured.sha256 === "missing") {
			reasons.push(`created:${advisoryPathKey(resolved, cwd)}`);
			continue;
		}
		if (stat.mtimeMs !== captured.mtimeMs || stat.size !== captured.size) {
			reasons.push(`metadata-changed:${advisoryPathKey(resolved, cwd)}`);
		}
		const currentHash = advisoryFileHash(resolved);
		if (currentHash.startsWith("unreadable:")) {
			unknown = true;
			reasons.push(`${currentHash}:${advisoryPathKey(resolved, cwd)}`);
		} else if (currentHash !== captured.sha256) {
			reasons.push(`content-changed:${advisoryPathKey(resolved, cwd)}`);
		}
		if (reasons.length > reasonsBefore) changedPaths.add(advisoryPathKey(resolved, cwd));
	}
	const allFilesDeleted = deletedFiles === provenance.files.length;
	if (unknown) return { status: "unknown", reasons, allFilesDeleted, changedPathCount: changedPaths.size };
	return reasons.length > 0
		? { status: "superseded", reasons, allFilesDeleted, changedPathCount: changedPaths.size }
		: { status: "current", reasons: [], allFilesDeleted, changedPathCount: 0 };
}

export function provenanceStamp(provenance: unknown): string {
	if (!isWellFormed(provenance)) return "session unknown / turn unknown / generation unknown";
	return `session ${provenance.revision.sessionId} / turn ${provenance.revision.turnIndex} / generation ${provenance.revision.generation}`;
}
