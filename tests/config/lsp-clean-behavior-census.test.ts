/**
 * #3347 — the expiry check on the clean-signal marker class.
 *
 * The repaired probe updates the generated matrix, while the wait-policy
 * registry is hand-maintained. Without this census a measured transition can
 * silently move in either direction: a newly silent server burns its whole
 * wait, or a server that publishes is incorrectly treated as silent.
 *
 * This is deliberately a two-source governance test. It parses the checked-in
 * matrix with the same parser used by the nightly generator and reads the real
 * registry imported by the LSP client; it does not recreate either source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { strategyKeyForLang } from "../../scripts/lib/clean-signal.mjs";
import { parseTable } from "../../scripts/lib/md-matrix.mjs";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const MATRIX_PATH = path.join(repoRoot, "docs", "lsp-capability-matrix.md");

const MEASURED_CLEAN_BEHAVIORS = new Set([
	"publishes-versioned",
	"publishes-unversioned",
	"silent",
]);

// Named admissions: unknown is not evidence for or against a marker. Keep this
// list shrink-only as the nightly probe makes those rows measurable.
const UNKNOWN_CLEAN_BEHAVIOR_ADMISSIONS = new Map<string, string>([]);

// marksman is measured silent in the current generated matrix, but its
// strategy key is intentionally pending the master-nightly server-id refresh.
const MARKSMAN_ADMISSION = new Map([
	["markdown", "marksman server-id mapping remains pending master nightly"],
]);

interface MatrixRow {
	lang: string;
	server: string;
	mode: string;
	cleanBehavior: string;
}

function matrixRows(): MatrixRow[] {
	const table = parseTable(
		fs.readFileSync(MATRIX_PATH, "utf8"),
		"| lang | server |",
	);
	expect(table, "capability matrix table is parseable").not.toBeNull();
	const header = table!.header;
	const index = (name: string) => {
		const result = header.indexOf(name);
		expect(result, `the matrix carries a ${name} column`).toBeGreaterThan(-1);
		return result;
	};
	const lang = index("lang");
	const server = index("server");
	const mode = index("mode");
	const cleanBehavior = index("clean-behavior");
	return table!.rows.map((cells) => ({
		lang: cells[lang] ?? "",
		server: cells[server] ?? "",
		mode: cells[mode] ?? "",
		cleanBehavior: cells[cleanBehavior] ?? "",
	}));
}

describe("#3347 clean-behavior marker census", () => {
	it("keeps the measured push population and admissions explicit", () => {
		const rows = matrixRows();
		const unknownRows = rows.filter(
			(row) => row.mode === "push-only" && row.cleanBehavior === "unknown",
		);
		const admittedUnknown = new Set(UNKNOWN_CLEAN_BEHAVIOR_ADMISSIONS.keys());
		expect(unknownRows.length).toBeGreaterThanOrEqual(0);
		for (const row of unknownRows) {
			expect(
				admittedUnknown.has(row.lang),
				`${row.lang} (${row.server}) is unknown and needs a named admission reason`,
			).toBe(true);
		}
		for (const lang of admittedUnknown) {
			expect(
				unknownRows.some((row) => row.lang === lang),
				`${lang} has a stale unknown clean-behavior admission`,
			).toBe(true);
		}
		const comparable = rows.filter(
			(row) =>
				row.mode === "push-only" &&
				MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior),
		);
		expect(comparable.length).toBeGreaterThanOrEqual(3);
	});

	it("matches every measured push server in both directions", () => {
		const mismatches: string[] = [];
		for (const row of matrixRows()) {
			if (
				row.mode !== "push-only" ||
				!MEASURED_CLEAN_BEHAVIORS.has(row.cleanBehavior) ||
				MARKSMAN_ADMISSION.has(row.lang)
			)
				continue;
			const key = strategyKeyForLang(row.lang);
			const marked = SERVER_DIAGNOSTIC_STRATEGIES[key]?.silentOnClean === true;
			const shouldBeSilent = row.cleanBehavior === "silent";
			if (marked !== shouldBeSilent) {
				mismatches.push(
					`${row.lang} (${row.server}) → ${key}: matrix clean-behavior=${row.cleanBehavior}, registry silentOnClean=${marked}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("keeps the marksman admission attached to a measured row", () => {
		const row = matrixRows().find((candidate) => candidate.lang === "markdown");
		expect(row?.server).toBe("marksman");
		expect(row?.cleanBehavior).toBe("silent");
		expect(MARKSMAN_ADMISSION.get("markdown")).toContain("master nightly");
	});
});
