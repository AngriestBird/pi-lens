import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager } from "./cache-manager.js";
import type { TurnEndFindingsCache } from "./git-guard.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	provenanceStamp,
	validateAdvisoryProvenance,
	type AdvisoryProvenance,
} from "./advisory-provenance.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";

// Exported so the Stop-hook bin strips exactly what these bridges prepend.
export const AUTOMATION_FRAMING =
	"[pi-lens automated check — not a user request] ";

type ContextResult = { messages: Array<{ role: "user"; content: string }> };

function historicalPrefix(provenance: AdvisoryProvenance | undefined): string {
	return `Historical finding; workspace changed since capture; re-run to confirm. (${provenanceStamp(provenance)})`;
}

function turnEndMessage(
	content: string,
	current: boolean,
	provenance?: AdvisoryProvenance,
): { role: "user"; content: string } {
	return {
		role: "user",
		content: current
			? `${AUTOMATION_FRAMING}Address 🔴 blockers before continuing; ℹ️ advisories are informational only.\n\n${content}`
			: `${AUTOMATION_FRAMING}${historicalPrefix(provenance)}\n\n${content}`,
	};
}

function allCapturedFilesDeleted(
	provenance: AdvisoryProvenance | undefined,
	cwd: string,
): boolean {
	return !!provenance?.files.length && provenance.files.every((file) => {
		try {
			fs.statSync(path.resolve(cwd, file.path));
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
	});
}

/** Read a turn-end finding without changing its durable delivery state. */
export function peekTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	if (allCapturedFilesDeleted(findings.data.provenance, cwd)) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	return {
		messages: [turnEndMessage(
			findings.data.content,
			validation.status === "current",
			findings.data.provenance,
		)],
	};
}

export function consumeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	const deleted = allCapturedFilesDeleted(findings.data.provenance, cwd);
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);

	// A blocker record is also the opt-in commit gate's durable state. Mark the
	// context message consumed without deleting the record; clean/advisory-only
	// records retain the historical consume-and-clear behavior.
	if (
		findings.data.hasBlockers === true &&
		typeof findings.data.sessionId === "string"
	) {
		cacheManager.writeCache(
			"turn-end-findings",
			{ ...findings.data, consumed: true },
			cwd,
		);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}
	if (deleted) return;
	return {
		messages: [turnEndMessage(
			findings.data.content,
			validation.status === "current",
			findings.data.provenance,
		)],
	};
}

/** Read test findings without consuming them; used by acknowledged IPC delivery. */
export function peekTestFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	);
	if (!findings?.data?.content) return;
	if (allCapturedFilesDeleted(findings.data.provenance, cwd)) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	const current = validation.status === "current";
	return {
		messages: [
			{
				role: "user",
				content: current
					? `${AUTOMATION_FRAMING}Test failures detected last turn — fix before continuing:\n\n${findings.data.content}`
					: `${AUTOMATION_FRAMING}${historicalPrefix(findings.data.provenance)}\n\n${findings.data.content}`,
			},
		],
	};
}

export function consumeTestFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = peekTestFindings(cacheManager, cwd, runtime);
	cacheManager.writeCache(
		"test-runner-findings",
		null as unknown as TestRunnerFindingsCache,
		cwd,
	);
	return findings;
}

export function consumeSessionStartGuidance(
	cacheManager: CacheManager,
	cwd: string,
): ContextResult | undefined {
	const guidance = cacheManager.readCache<{ content: string }>(
		"session-start-guidance",
		cwd,
	);
	if (!guidance?.data?.content) return;

	cacheManager.writeCache(
		"session-start-guidance",
		null as unknown as { content: string },
		cwd,
	);

	return {
		messages: [
			{
				role: "user",
				content: `[pi-lens automated context — not a user request]\n\n${guidance.data.content}`,
			},
		],
	};
}
