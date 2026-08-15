import { logLatency } from "./latency-logger.js";

export type ToolSetMutationReason =
	| "fresh_session_lazy_deactivation"
	| "lazy_activation";

export interface ToolSetMutation {
	addedCount: number;
	removedCount: number;
	reason: ToolSetMutationReason;
	deferralApplies: boolean;
}

type DeferredToolModel = {
	api?: string;
	provider?: string;
	id?: string;
	compat?: {
		supportsToolReferences?: boolean;
		supportsToolSearch?: boolean;
	};
};

/** Match pi's provider capability decision without depending on an internal API. */
export function supportsDeferredTools(model: DeferredToolModel | undefined): boolean {
	if (!model) return false;
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return model.compat?.supportsToolSearch === true;
	}
	if (model.api !== "anthropic-messages") return false;
	if (model.compat?.supportsToolReferences !== undefined) {
		return model.compat.supportsToolReferences;
	}
	if (model.provider !== "anthropic" || model.id?.includes("haiku")) return false;
	const version = model.id?.match(
		/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/,
	);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

/** Only a new logical conversation may shrink the active tool set. */
export function isFreshSessionStart(reason: unknown): boolean {
	return reason === undefined || reason === "startup" || reason === "new";
}

export function recordToolSetMutation(mutation: ToolSetMutation): void {
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "tool_set_mutation",
		durationMs: 0,
		metadata: { ...mutation },
	});
}
