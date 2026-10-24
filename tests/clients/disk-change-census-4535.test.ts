/**
 * #4535 slice 3: the consumer census (`clients/disk-change-consumers.ts`) is
 * held to the code it describes, in both directions.
 *
 * Recurrence this prevents: slice 2 shipped `diagnosticsCacheSubscriber` with an
 * `if (change.origin !== "out-of-band") return` inside its own handler. Three
 * detectors published and the cache learned about one of them, and nothing
 * listed which consumer heard which detector, so the gap waited for the next
 * audit. A consumer added with no row, a row whose code is gone, or a
 * `subscriber` cell the registry does not back fails here instead.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	DISK_CHANGE_CONSUMERS,
	type DiskChangeConsumer,
} from "../../clients/disk-change-consumers.js";
import { ensureDiskChangeSubscribers } from "../../clients/disk-change-subscribers.js";
import {
	DISK_CHANGE_ORIGINS,
	diskChangeSubscriberOrigins,
} from "../../clients/disk-changes.js";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import { assertNonEmptyScan, listSourceFiles } from "../support/sweep-kit.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** Production directories and files that could register a subscriber. */
const PRODUCTION_ROOTS = ["clients", "tools", "mcp", "scripts"] as const;

function productionSources(): string[] {
	const sources = [
		path.join(repoRoot, "index.ts"),
		...PRODUCTION_ROOTS.flatMap((root) =>
			listSourceFiles(path.join(repoRoot, root), { skipTests: true }),
		),
	];
	assertNonEmptyScan("production source population", sources.length, 400);
	return sources;
}

/**
 * How one source file reaches `subscribeDiskChange`. The scan admits two forms
 * and refuses the rest: a named import, and a direct call. Any other mention of
 * the identifier (an alias, a value passed on, a property, a re-export) is an
 * `unknown` use, because a registration the scan cannot read is a subscriber
 * the census cannot see.
 */
function registrationUses(source: string): {
	calls: number;
	unknown: number;
} {
	const code = stripCommentsAndStrings(source).replace(
		/\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*[^;]*;/g,
		(clause) => clause.replace(/\bsubscribeDiskChange\b/g, ""),
	);
	const calls = [...code.matchAll(/\bsubscribeDiskChange\s*\(/g)].length;
	const all = [...code.matchAll(/\bsubscribeDiskChange\b/g)].length;
	return { calls, unknown: all - calls };
}

function reasonOf(
	cell: DiskChangeConsumer["cells"][keyof DiskChangeConsumer["cells"]],
): string {
	switch (cell.wire) {
		case "subscriber":
			return "subscriber";
		case "fed":
			return cell.by;
		case "pull":
		case "n/a":
			return cell.why;
		case "pending":
			return cell.gap;
	}
}

describe("the consumer census", () => {
	it("answers every origin for every consumer, with a reason on every cell that is not a subscriber", () => {
		const ids = new Set<string>();
		for (const consumer of DISK_CHANGE_CONSUMERS) {
			expect(ids.has(consumer.id), `duplicate row ${consumer.id}`).toBe(false);
			ids.add(consumer.id);
			expect(Object.keys(consumer.cells).sort()).toEqual(
				[...DISK_CHANGE_ORIGINS].sort(),
			);
			for (const origin of DISK_CHANGE_ORIGINS) {
				const cell = consumer.cells[origin];
				if (cell.wire !== "subscriber")
					expect(
						reasonOf(cell).trim().length,
						`${consumer.id} x ${origin} gives no reason`,
					).toBeGreaterThan(20);
			}
		}
	});

	it("backs every subscriber cell with the registry, and every registered subscriber with a row", () => {
		ensureDiskChangeSubscribers();
		const registered = diskChangeSubscriberOrigins();
		for (const consumer of DISK_CHANGE_CONSUMERS) {
			const claimed = DISK_CHANGE_ORIGINS.filter(
				(origin) => consumer.cells[origin].wire === "subscriber",
			);
			if (consumer.subscriberId === undefined) {
				expect(claimed, `${consumer.id} claims a subscription`).toEqual([]);
				continue;
			}
			expect(
				[...(registered.get(consumer.subscriberId) ?? [])].sort(),
				`${consumer.id} is delivered other origins than its row claims`,
			).toEqual([...claimed].sort());
		}
		const rowIds = new Set(
			DISK_CHANGE_CONSUMERS.flatMap((consumer) =>
				consumer.subscriberId === undefined ? [] : [consumer.subscriberId],
			),
		);
		// One production registration site per row. The publisher's own file
		// defines the function; every other file may only import it and call it.
		let calls = 0;
		const unreadable: string[] = [];
		for (const file of productionSources()) {
			if (file.endsWith(path.join("clients", "disk-changes.ts"))) continue;
			const uses = registrationUses(fs.readFileSync(file, "utf8"));
			calls += uses.calls;
			if (uses.unknown > 0) unreadable.push(path.relative(repoRoot, file));
		}
		expect(unreadable, "a use the scan cannot read").toEqual([]);
		expect(calls).toBe(rowIds.size);
		// The registry cell itself is a second way in: nothing but the publisher
		// names its family.
		const family = productionSources().filter(
			(file) =>
				!file.endsWith(path.join("clients", "disk-changes.ts")) &&
				fs.readFileSync(file, "utf8").includes("disk-changes.subscribers"),
		);
		expect(family).toEqual([]);
	});

	it("reads three spellings the scan was not designed around as unknown, not as zero", () => {
		// Recurrence: an enumerated gate admits the forms its author thought of
		// and passes the next spelling. Each plant below would register a
		// subscriber the census never sees if the scan counted only
		// `subscribeDiskChange(`.
		const alias = [
			'import { subscribeDiskChange } from "./disk-changes.js";',
			"const on = subscribeDiskChange;",
			'on("x", () => undefined);',
		].join("\n");
		const indirect = [
			'import { subscribeDiskChange } from "./disk-changes.js";',
			'[subscribeDiskChange].forEach((register) => register("x", () => undefined));',
		].join("\n");
		const throughBinding = [
			'import { subscribeDiskChange } from "./disk-changes.js";',
			"const bus = { on: subscribeDiskChange };",
			'bus.on("x", () => undefined);',
		].join("\n");
		for (const planted of [alias, indirect, throughBinding])
			expect(registrationUses(planted).unknown).toBeGreaterThan(0);
		// And the two admitted forms stay readable: an import plus a call.
		expect(
			registrationUses(
				'import { subscribeDiskChange } from "./disk-changes.js";\nsubscribeDiskChange("x", () => undefined);',
			),
		).toEqual({ calls: 1, unknown: 0 });
		// A comment or a string naming the call is neither a call nor a use.
		expect(
			registrationUses(
				'// subscribeDiskChange("x", fn)\nconst s = "subscribeDiskChange(";',
			),
		).toEqual({ calls: 0, unknown: 0 });
	});

	it("keeps each row's anchor in the file it names", () => {
		for (const consumer of DISK_CHANGE_CONSUMERS) {
			const file = path.join(repoRoot, consumer.anchor.file);
			expect(
				fs.existsSync(file),
				`${consumer.id}: ${consumer.anchor.file}`,
			).toBe(true);
			const code = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
			expect(
				new RegExp(`\\b${consumer.anchor.symbol}\\b`).test(code),
				`${consumer.id}: ${consumer.anchor.symbol} is gone from ${consumer.anchor.file}`,
			).toBe(true);
		}
	});

	it("pins the pending cells, so a wire that lands removes one and a new gap is a deliberate edit", () => {
		const pendingByConsumer = Object.fromEntries(
			DISK_CHANGE_CONSUMERS.flatMap((consumer) => {
				const count = DISK_CHANGE_ORIGINS.filter(
					(origin) => consumer.cells[origin].wire === "pending",
				).length;
				return count === 0 ? [] : [[consumer.id, count]];
			}),
		);
		expect(pendingByConsumer).toEqual({
			"lsp-unheld-modules": 4,
			"dispatch-delta-baseline": 4,
			"inline-blocker-records": 4,
			"record-carry-position-stale": 3,
			"widget-rows": 1,
			"widget-dependency-demotion": 4,
			"advisory-and-project-diagnostics": 1,
			"actionable-warnings-merge": 2,
			"cascade-carry-over-supersede": 2,
			"review-graph-and-reverse-deps": 4,
			"review-graph-answers-trust-note": 3,
			"word-index": 4,
			"project-snapshot": 3,
			"call-graph-and-codebase-model": 5,
			"formatter-detection-cache": 4,
			"workspace-modules-cache": 1,
		});
	});
});
