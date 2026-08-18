/**
 * Coverage guard for the #1634 finding-delivery gate: every agent-facing
 * finding surface enumerated in `DELIVERY_SURFACES` is either `gated` (names
 * a real gate) or `labeled` (names a reason + age source) — never a bare,
 * unaccounted-for third state.
 *
 * The enumeration itself is fixed here as `EXPECTED_SURFACE_IDS`, derived by
 * grepping the render seams (see the module doc in
 * clients/finding-delivery-gate.ts for the exact seams). A surface added to
 * the registry without a matching real gate/label call in its named file, or
 * a render seam added without a registry entry, is the "third state" this
 * test exists to catch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNoDeliveryBypass,
	DELIVERY_SURFACES,
	formatCacheAgeLabel,
	type DeliverySurfaceEntry,
} from "../../clients/finding-delivery-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

function readSource(relativeFile: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
}

const EXPECTED_SURFACE_IDS = [
	"runtime-turn:secrets-gitleaks",
	"runtime-turn:secrets-trivy",
	"runtime-turn:govulncheck-advisory",
	"runtime-turn:trivy-critical-blocker",
	"runtime-turn:trivy-cve-advisory",
	"runtime-turn:trivy-license-advisory",
	"runtime-turn:dead-code-advisory",
	"runtime-turn:actionable-warnings-advisory",
	"lens-diagnostics:mode-full",
	"lens-diagnostics:mode-all",
	"widget-state:footer",
	"agent-nudge:context-message",
	"project-diagnostics:persisted-snapshot",
].sort();

describe("finding-delivery-gate enumeration (#1634)", () => {
	it("registers exactly the surfaces enumerated from the render seams", () => {
		expect(Object.keys(DELIVERY_SURFACES).sort()).toEqual(EXPECTED_SURFACE_IDS);
	});

	it("every registered surface passes the no-bypass validator", () => {
		expect(() => assertNoDeliveryBypass()).not.toThrow();
	});

	it("RED PROOF: a surface with a third mode is rejected, not silently accepted", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			// @ts-expect-error deliberately malformed for the red-proof
			"synthetic:bypass": { mode: "bypass", file: "nowhere.ts", description: "x" },
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/synthetic:bypass/);
	});

	it("RED PROOF: a gated surface that names zero gates is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:empty-gate": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/synthetic:empty-gate/);
	});

	it("RED PROOF: a labeled surface missing reason/ageSource is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:bare-label": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "",
				ageSource: "",
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(/synthetic:bare-label/);
	});

	// Ground-truth: every `gated` surface's named gate(s) actually appear in its
	// declared source file, and every `labeled` surface's age helper actually
	// appears in its declared source file. This is what makes the registry more
	// than a self-declared list — a gate call removed from source without
	// updating the registry fails here.
	const sourceCache = new Map<string, string>();
	function source(file: string): string {
		let cached = sourceCache.get(file);
		if (cached === undefined) {
			cached = readSource(file);
			sourceCache.set(file, cached);
		}
		return cached;
	}

	for (const [id, entry] of Object.entries(DELIVERY_SURFACES)) {
		if (entry.mode === "gated") {
			it(`"${id}" actually calls its declared gate(s) in ${entry.file}`, () => {
				const src = source(entry.file);
				for (const gate of entry.gates) {
					expect(src, `expected ${entry.file} to reference ${gate} for surface ${id}`)
						.toContain(gate);
				}
			});
		} else if (entry.ageSource !== "live") {
			// A "live" ageSource means the surface is computed fresh every call
			// (no cache to be old) — see the module doc's "Explicit lag labels"
			// section. Anything else claims a real cache age, so the surface must
			// actually call the shared formatter rather than hand-roll one.
			it(`"${id}" actually uses the shared age-label helper in ${entry.file}`, () => {
				const src = source(entry.file);
				expect(
					src,
					`expected ${entry.file} to call formatCacheAgeLabel for surface ${id}`,
				).toContain("formatCacheAgeLabel");
			});
		}
		// "live" surfaces (ageSource === "live") are computed fresh on every
		// call by construction (a per-turn accumulator, not a keyed cache read)
		// — there is no age string to grep for. Their honesty rests on the
		// module doc's per-surface `reason`, not a mechanical source check;
		// `assertNoDeliveryBypass` already requires that `reason` be non-empty.
	}
});

describe("formatCacheAgeLabel (#1634)", () => {
	it("renders a whole-minute age for a recent scan", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 12, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 12m ago");
	});

	it("renders an hour-scale age past 60 minutes", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 4, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 0, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 3h ago");
	});

	it("degrades to an honest unknown label on an empty/unparseable timestamp", () => {
		expect(formatCacheAgeLabel("")).toBe("scan age unknown");
		expect(formatCacheAgeLabel(undefined)).toBe("scan age unknown");
		expect(formatCacheAgeLabel("not-a-date")).toBe("scan age unknown");
	});

	it("never reports a negative age on clock skew", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 6, 59, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned <1m ago");
	});
});
