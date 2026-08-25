// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.

export const MODEL_IDS_IN_ORDER = ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Never request [1m]. That suffix opts into 1M-context serving, which costs
// extra on some plans and is never wanted here. The registered contextWindow
// must equal what the bridge actually serves or pi's status bar and
// auto-compaction threshold misreport, so it is pinned rather than forwarded.
// See diag/CONTEXT-SIZE.md for the measured SDK behavior.
export const CONTEXT_WINDOW = 200_000;

/** Project pi-ai's model entries down to the fields pi's registerProvider
 *  expects, in MODEL_IDS_IN_ORDER order. IDs missing from pi-ai are dropped. */
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// thinkingLevelMap carries pi-ai's per-model effort overrides (e.g. opus-4-8
		// mapping xhigh→xhigh), which the effort lookup prefers over our generic table.
		.map(({ id, name, reasoning, input, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, maxTokens,
			contextWindow: CONTEXT_WINDOW,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}
