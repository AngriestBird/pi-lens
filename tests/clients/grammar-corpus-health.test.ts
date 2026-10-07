import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	grammarBlockReason,
	LANGUAGE_TO_GRAMMAR,
} from "../../clients/grammar-source.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";

const CORPUS = join(import.meta.dirname, "../fixtures/grammar-health");
const files = new Map(
	readdirSync(CORPUS)
		.filter((name) => name.includes("."))
		.map((name) => [name.slice(0, name.indexOf(".")), join(CORPUS, name)]),
);

describe("grammar health corpus (#4012)", () => {
	// Recurrence: #3996 only exercised synthetic text, so a grammar could fail
	// on a real file while the nightly still reported a healthy load.
	for (const language of Object.keys(LANGUAGE_TO_GRAMMAR).sort()) {
		const blocked = Boolean(grammarBlockReason(LANGUAGE_TO_GRAMMAR[language]));
		it.skipIf(blocked)(
			`parses the committed corpus for ${language}`,
			async () => {
				const client = new TreeSitterClient();
				expect(await client.init()).toBe(true);
				const tree = await client.parseFile(files.get(language)!, language);
				expect(tree, `${language} grammar must load`).toBeTruthy();
				expect(
					(tree?.rootNode as unknown as { hasError?: boolean })?.hasError,
					`${language} corpus must parse`,
				).toBe(false);
			},
		);
	}
});
