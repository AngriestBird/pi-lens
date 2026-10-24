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

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** Production directories and files that could register a subscriber. */
const PRODUCTION_ROOTS = ["clients", "tools", "mcp", "scripts"] as const;

function productionSources(): string[] {
	const out: string[] = [path.join(repoRoot, "index.ts")];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
				out.push(full);
		}
	};
	for (const root of PRODUCTION_ROOTS) walk(path.join(repoRoot, root));
	return out;
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
		// A production registration site per row: a subscriber added elsewhere
		// has no row, and the count differs.
		const sites = productionSources().flatMap((file) => {
			if (file.endsWith(path.join("clients", "disk-changes.ts"))) return [];
			const text = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
			return [...text.matchAll(/\bsubscribeDiskChange\s*\(/g)].map(() =>
				path.relative(repoRoot, file),
			);
		});
		expect(sites).toHaveLength(rowIds.size);
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
