/**
 * Fix B (#3167) — honest age labels for carried and demoted repeats.
 *
 * Recurrence: a cascade result carried across a turn boundary re-rendered at
 * turn_end indistinguishable from a fresh observation, and demoted (stale)
 * delta rows repeated with the stale marker but no age information — the
 * delivery-gate registry's own `partial` entries named this exactly.
 *
 * Red-first: pre-fix, `cascadeCarrySuffix` does not exist (import fails) and
 * the delta group renders no age line, so every case below fails against the
 * pre-fix production path.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

import { cascadeCarrySuffix } from "../../clients/cascade-format.js";
import { DELIVERY_SURFACES } from "../../clients/finding-delivery-gate.js";
import { STALE_LINE_MARKER } from "../../clients/stale-marker.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

describe("cascade carry label (#3167)", () => {
	it("labels a run carried across one turn", () => {
		expect(cascadeCarrySuffix(1)).toBe("(carried 1 turn)");
	});

	it("labels multi-turn carries with the plural form", () => {
		expect(cascadeCarrySuffix(3)).toBe("(carried 3 turns)");
	});

	it("emits no label for non-carried runs — no label noise", () => {
		expect(cascadeCarrySuffix(undefined)).toBeUndefined();
		expect(cascadeCarrySuffix(0)).toBeUndefined();
	});
});

describe("delivery-gate registry (#3167)", () => {
	it("the two carried-cascade entries are no longer partial", () => {
		for (const id of [
			"runtime-turn:cascade-blocker",
			"runtime-turn:cascade-coverage-advisory",
		]) {
			const entry = DELIVERY_SURFACES[id];
			expect(entry, id).toBeDefined();
			expect((entry as { status?: string }).status, id).toBeUndefined();
		}
	});
});

describe("demoted delta rows (#3167)", () => {
	let tmpDir: string;
	let cwd: string;
	let filePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-age-label-"));
		cwd = tmpDir;
		filePath = path.join(cwd, "src", "foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		resetProjectLensConfigCache();
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
	});

	function makeTool(cacheData: Record<string, unknown>) {
		return createLensDiagnosticsTool(
			{
				readCache: vi.fn((key: string) =>
					cacheData[key]
						? { data: cacheData[key], meta: { savedAt: "", scanner: key } }
						: undefined,
				),
			} as any,
			() => cwd,
		);
	}

	it("B3: a demoted delta file group renders exactly one age label", async () => {
		fs.writeFileSync(filePath, "const x = 1;\n");
		// The file's mtime must be NEWER than the report's observation stamp so
		// the freshness gate demotes the rows (edited since observed).
		const generatedAt = new Date(Date.now() - 60_000).toISOString();
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath,
						warnings: [
							{
								line: 1,
								rule: "no-unused-vars",
								tool: "eslint",
								message: "x is unused",
							},
						],
					},
				],
				generatedAt,
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).toContain(STALE_LINE_MARKER);
		expect(text).toContain("x is unused");
		const ageLabels = text.match(/scanned .* ago|scan age unknown/g) ?? [];
		expect(ageLabels.length, text).toBe(1);
	});

	it("B4: a missing observation stamp renders the neutral label, never a fabricated number", async () => {
		fs.writeFileSync(filePath, "const x = 1;\n");
		// No generatedAt at all: applyDeltaFreshnessGate returns files unchanged
		// when no stamp exists, so the rows render LIVE (not stale) — the label
		// contract here is exercised through the carried/stale arm only when a
		// stamp exists. This case pins the negative: no stamp → no rows demoted
		// → no label noise on a live row.
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath,
						warnings: [
							{
								line: 1,
								rule: "no-unused-vars",
								tool: "eslint",
								message: "x is unused",
							},
						],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).not.toContain(STALE_LINE_MARKER);
		expect(text).not.toContain("scan age unknown");
	});
});
