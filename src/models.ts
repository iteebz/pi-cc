// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so pi-ai's per-model overrides (e.g. opus-4-8
		// mapping xhigh→xhigh and max→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// Runtime policy: never request [1m]. The [1m] suffix opts into 1M-context
// serving, which costs extra on some plans and is never wanted here — always
// serve the bare id at 200K. See diag/CONTEXT-SIZE.md for the measured SDK
// behavior that motivated this.
export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;

export function resolveClaudeCodeRuntimeModel(modelId: string): ClaudeCodeRuntimeModel {
	if (!MODEL_IDS_IN_ORDER.includes(modelId)) {
		console.error(`claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`);
	}
	return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

// The registered contextWindow must match the window the bridge actually serves,
// or pi's status bar and auto-compaction threshold misreport. Always 200K here.
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(models: T[]): T[] {
	return models.map((m) =>
		m.contextWindow === TWO_HUNDRED_K_CONTEXT ? m : { ...m, contextWindow: TWO_HUNDRED_K_CONTEXT },
	);
}
