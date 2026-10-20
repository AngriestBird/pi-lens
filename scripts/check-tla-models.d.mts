export type TlcVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string }
	| { status: "error"; detail: string };
export type ExpectedVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string };
export declare const TLA_TOOLS: Readonly<{
	release: string;
	url: string;
	sha256: string;
}>;
export declare function parseModelHeader(
	text: string,
): { module: string; expect: ExpectedVerdict } | { error: string };
export declare function classifyTlcOutput(output: string): TlcVerdict;
export declare function verdictMatches(
	expected: ExpectedVerdict,
	actual: TlcVerdict,
): boolean;
export declare function describeVerdict(verdict: TlcVerdict): string;
export declare function listModelConfigs(root: string): string[];
export declare function resolveJarPath(
	jarArg: string | undefined,
	root: string,
): string;
export declare function computeConcurrency(
	numConfigs: number,
	availableParallelism: number,
): number;
export declare function parseConcurrencyArg(raw: string | undefined): number;
export declare function resolveConcurrency(
	concurrencyRaw: string | undefined,
	numConfigs: number,
	availableParallelism: number,
): number;
export declare function formatSummary(
	configCount: number,
	shard: string | undefined,
	wallSeconds: number,
	concurrency: number,
): string;
export declare function parseShardArg(raw: string | undefined): {
	index: number;
	total: number;
};
/** The measured per-config cost table's file, repo-relative (#4672). */
export declare const MODEL_COSTS_FILE: string;
export type ModelCosts = {
	root: string;
	files: Record<string, number>;
	max: number;
};
export declare function loadModelCosts(root: string): {
	files: Record<string, number>;
	max: number;
};
/**
 * The cost table's key for `config`: its path under `root`, always posix.
 * `pathImpl` defaults to the host `path`; pass `path.win32` to dose one
 * (AGENTS.md shape 35).
 */
export declare function modelCostId(
	root: string,
	config: string,
	pathImpl?: { relative: (from: string, to: string) => string; sep: string },
): string;
/** `costs` null keeps the round-robin split; a table packs by measured cost. */
export declare function selectShard<Item>(
	configs: readonly Item[],
	shard: { index: number; total: number },
	costs?: ModelCosts | null,
): Item[];
/**
 * How far this run's own seconds may sit from the table before the balance
 * line calls the table stale.
 */
export declare const MODEL_COST_DRIFT_TOLERANCE: number;
/**
 * The balance line. `observed` maps `modelCostId` keys to the seconds this run
 * measured, so the drift half compares the projection with the run.
 */
export declare function formatShardBalance(args: {
	configs: readonly string[];
	total: number;
	costs: ModelCosts;
	observed?: Map<string, number> | Record<string, number> | null;
	driftTolerance?: number;
}): string;
export declare function resolveShardCosts(
	argv: readonly string[],
	root: string,
): ModelCosts | null;
export declare function parseCliArgs(argv: readonly string[]): {
	jar?: string;
	concurrency?: string;
	shard?: string;
};
export declare function selectConfigs(
	argv: readonly string[],
	root: string,
): string[];
export declare function buildJavaArgs(
	jar: string,
	metadir: string,
	configBasename: string,
	module: string,
): string[];
export declare function runPool<Item, Result>(
	items: readonly Item[],
	concurrency: number,
	task: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]>;
