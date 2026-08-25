/**
 * Tests for MODELS construction + resolveModel.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, applyLongContext, buildModels, claudeCodeModelId, resolveClaudeCodeRuntimeModel, resolveModel } from "../src/models.js";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });

const find = (models, id) => models.find((m) => m.id === id);

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("silently drops IDs missing from pi-ai (no fallback)", () => {
		// Only haiku present — opus/sonnet vanish from picker.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("leaves display names bare before plan-specific context is applied", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
		assert.ok(models.every((m) => !m.name.includes("1M")));
	});

	it("forwards pi-ai's thinkingLevelMap verbatim", () => {
		const withMap = (id) => ({ ...mockPiAiModel(id), thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		const models = buildModels([withMap("claude-sonnet-5")]);
		assert.deepEqual(find(models, "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
	});

	it("forwards undefined thinkingLevelMap unchanged (no fabricated defaults)", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.equal(find(models, "claude-haiku-4-5")?.thinkingLevelMap, undefined);
	});
});

describe("Claude Code runtime model policy", () => {
	// Policy: [1m] is never requested. Every known model serves the bare id at 200K,
	// regardless of plan or long-context settings.
	const ALL_SETTINGS = [["pro", PRO], ["max", MAX], ["extra", EXTRA]];
	const ALL_MODELS = ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

	for (const [settingsName, settings] of ALL_SETTINGS) {
		it(`never requests [1m] under ${settingsName} settings`, () => {
			for (const id of ALL_MODELS) {
				assert.deepEqual(
					resolveClaudeCodeRuntimeModel(id, settings),
					{ cliModelId: id, contextWindow: 200000 },
				);
			}
		});
	}

	it("unknown model falls back to bare id at 200K", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-future-9-9", PRO), { cliModelId: "claude-future-9-9", contextWindow: 200000 });
	});
});

describe("claudeCodeModelId", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("returns the bare model id (no [1m]) for every model and setting", () => {
		for (const settings of [PRO, MAX, EXTRA]) {
			for (const m of models) {
				assert.equal(claudeCodeModelId(m, settings), m.id);
			}
		}
	});

});

describe("applyLongContext", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("registers every model at 200K with no 1M label, any setting", () => {
		for (const settings of [PRO, MAX, EXTRA]) {
			const registered = applyLongContext(models, settings);
			for (const m of registered) {
				assert.equal(m.contextWindow, 200000, `${m.id} contextWindow`);
				assert.ok(!m.name.includes("1M"), `${m.id} name: ${m.name}`);
			}
		}
		// Does not mutate the source table used for id resolution.
		assert.equal(find(models, "claude-opus-4-6").contextWindow, 1000000);
	});
});

describe("resolveModel", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-5 (first opus in order)", () => {
		assert.equal(resolveModel(models, "opus")?.id, "claude-opus-5");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModel(models, "haiku")?.id, "claude-haiku-4-5");
	});

	it("full ID resolves to itself", () => {
		assert.equal(resolveModel(models, "claude-opus-4-6")?.id, "claude-opus-4-6");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});

	it("returns the matched model object for CLI-arg conversion", () => {
		const oneMModels = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		const model = resolveModel(oneMModels, "opus");
		assert.equal(model.id, "claude-opus-5");
		assert.equal(claudeCodeModelId(model, PRO), "claude-opus-5");
	});
});
