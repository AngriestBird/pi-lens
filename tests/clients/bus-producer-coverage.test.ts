import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LENS_EVENT_NAMES } from "../../clients/lens-events.js";

const PRODUCERS = [
	"bus-publish.ts",
	"diagnostics-publish.ts",
	"disposition-publish.ts",
	"format-events-publish.ts",
	"lens-events.ts",
] as const;

describe("bus producer guarded-seam coverage", () => {
	it("routes every event producer through the shared live emitter resolver", () => {
		const clientsDir = path.resolve(process.cwd(), "clients");
		for (const file of PRODUCERS) {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			expect(source, file).toContain("resolveLiveBusEmitter(");
			expect(source, file).not.toMatch(/liveEmitter\.resolve\s*\(/);
			expect(source, file).not.toMatch(/(?:lensEventBusGetter|busEmitterGetter)\?\.\(/);
		}

		const productionSources = fs
			.readdirSync(clientsDir)
			.filter((file) => file.endsWith(".ts"))
			.map((file) => [file, fs.readFileSync(path.join(clientsDir, file), "utf8")] as const);
		const directResolvers = productionSources.filter(
			([file, source]) =>
				file !== "live-bus-emitter.ts" && /liveEmitter\.resolve\s*\(/.test(source),
		);
		expect(directResolvers).toEqual([]);
	});

	it("keeps the complete lens producer family in the guarded producer set", () => {
		expect(Object.values(LENS_EVENT_NAMES)).toEqual([
			"pi-lens/analysis-complete",
			"pi-lens/findings",
			"pi-lens/turn-findings",
		]);
	});
});
