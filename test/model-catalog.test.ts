/** The narrow claim doctor makes from pi's public get_available_models reply. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogFromModels, judgeModel } from "../src/daemon/model-catalog.ts";

const MODELS = [
	{ provider: "openai-codex", id: "gpt-5.4", name: "GPT" },
	{ provider: "sub2api", id: "gpt-5.6", name: "GPT" },
	{ provider: "sub2api", id: "gpt-5.5", name: "GPT" },
	{ provider: "openrouter", id: "~anthropic/claude-sonnet-latest", name: "Claude" },
];

test("the public RPC model payload is grouped by provider", () => {
	const catalog = catalogFromModels(MODELS);
	assert.deepEqual([...catalog.keys()].sort(), ["openai-codex", "openrouter", "sub2api"]);
	assert.deepEqual([...catalog.get("sub2api")!].sort(), ["gpt-5.5", "gpt-5.6"]);
});

test("malformed model entries are ignored rather than guessed", () => {
	assert.equal(catalogFromModels(undefined).size, 0);
	assert.equal(catalogFromModels([null, {}, { provider: "p" }, { id: "m" }]).size, 0);
});

test("a floating alias is counted once, under the id without its marker", () => {
	const catalog = catalogFromModels(MODELS);
	assert.deepEqual([...catalog.get("openrouter")!], ["anthropic/claude-sonnet-latest"]);
	assert.equal(judgeModel(catalog, "openrouter", "~anthropic/claude-sonnet-latest").ok, true,
		"while a config naming either spelling still matches");
});

test("an unreadable catalog is silence, not a verdict", () => {
	for (const catalog of [undefined, new Map()]) {
		const verdict = judgeModel(catalog, "sub2api", "gpt-5.6");
		assert.equal(verdict.ok, true);
		assert.match(verdict.note!, /not checked/);
	}
});

test("a provider the available catalog never mentions is not judged", () => {
	const verdict = judgeModel(catalogFromModels(MODELS), "anthropic", "claude-sonnet-5");
	assert.equal(verdict.ok, true, "absence of a provider is absence of evidence");
	assert.match(verdict.note!, /publishes no catalog/);
	assert.equal(verdict.fix, undefined);
});

test("a provider that did publish its list is taken at its word", () => {
	const catalog = catalogFromModels(MODELS);
	assert.equal(judgeModel(catalog, "sub2api", "gpt-5.6").ok, true);

	const typo = judgeModel(catalog, "sub2api", "gpt-5.7");
	assert.equal(typo.ok, false);
	assert.match(typo.fix!, /gpt-5\.5, gpt-5\.6/, "naming what is there beats saying no");
});

test("a catalog too big to list gets near misses, a count, and the command for the rest", () => {
	const many = new Map([["openrouter", new Set([
		...Array.from({ length: 40 }, (_, i) => `vendor/model-${i}`),
		"openai/gpt-5.6-sol",
		"openai/gpt-5.6-terra",
	])]]);

	const verdict = judgeModel(many, "openrouter", "gpt-5.6-luna", ["npm:pi-sub2api"]);
	assert.equal(verdict.ok, false);
	assert.match(verdict.fix!, /gpt-5\.6-sol/, "the near misses come first, not the alphabet");
	assert.doesNotMatch(verdict.fix!, /vendor\/model-3\b/, "and the unrelated ones stay out");
	assert.match(verdict.fix!, /42 in all/);
	assert.match(verdict.fix!, /pi -ne -e npm:pi-sub2api --list-models/);
	assert.match(judgeModel(many, "openrouter", "zzzzzz").fix!, /vendor\/model-0/);
});
