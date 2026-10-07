// The source tree behind tests/fixtures/review-graph-persist/released-ca7e89066
// (#3913). Shared by generate-released-writer.mjs and the transfer test so both
// build the same graph. The astral characters sit in a path and a symbol name,
// far from any 256 KiB chunk boundary.
export const CORPUS_FILES = {
	"src/a.ts": "export const alpha = 1;\n",
	"src/b.ts": "import { alpha } from './a';\nexport const beta = alpha;\n",
	"src/c.ts":
		"import { beta } from './b';\nexport function gamma() { return beta; }\n",
	"src/d.ts": "export function delta() { return 4; }\n",
	"src/e.ts": "import { gamma } from './c';\nexport const eps = gamma();\n",
	"src/日本語/é-😀.ts":
		"import { delta } from '../d';\nexport function généré() { return delta(); }\n",
};

/** The file signatures carry mtimeMs, so every file gets this one. */
export const CORPUS_MTIME_SECONDS = 1_700_000_000;

/** The checkpoint arm fires after files 2 and 4 of six at this stride. */
export const CORPUS_CHECKPOINT_EVERY_FILES = "2";
