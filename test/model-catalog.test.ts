/**
 * The claim this check is allowed to make, which is narrower than it looks.
 *
 * `pi --list-models` does not enumerate everything pi can run — it reports the
 * catalogs this machine happens to have plus whatever the allowlist registered.
 * On a fresh checkout `anthropic` is absent entirely, while README documents
 * `--model anthropic/claude-sonnet-5`. So "not in the catalog" cannot mean
 * "wrong", or the check is red for the configuration the docs teach, which is
 * the state the extension-path check was in before 3fd75d4.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelCatalog, judgeModel } from "../src/daemon/model-catalog.ts";

/** Shaped like the real thing, banner included — measured on the deployed host. */
const LISTING = [
	"[sub2api] registered 10 model(s) — openai-completions: gpt-5.6, gpt-5.6-sol, gpt-5.5",
	"provider      model                            context  max-out  thinking  images",
	"openai-codex  gpt-5.4                          272K     128K     yes       yes   ",
	"sub2api       gpt-5.6                          400K     128K     yes       yes   ",
	"sub2api       gpt-5.5                          400K     128K     yes       yes   ",
	"openrouter    ~anthropic/claude-sonnet-latest  1M       128K     yes       yes   ",
	"",
].join("\n");

test("the table is found by its header, not by counting lines", () => {
	// An extension announcing itself on stdout is the normal case, not the odd
	// one: the allowlist exists to load provider extensions, and each prints.
	// A positional parse reads that banner as a model called "registered".
	const catalog = parseModelCatalog(LISTING);

	assert.deepEqual([...catalog.keys()].sort(), ["openai-codex", "openrouter", "sub2api"]);
	assert.equal(catalog.has("[sub2api]"), false, "the banner is not a provider");
	assert.deepEqual([...catalog.get("sub2api")!].sort(), ["gpt-5.5", "gpt-5.6"]);
});

test("output with no table at all yields nothing rather than guesses", () => {
	for (const text of ["", "pi: unknown option --list-models\n", "[ext] registered 3 model(s)\n"]) {
		assert.equal(parseModelCatalog(text).size, 0, JSON.stringify(text));
	}
});

test("a floating alias is counted once, under the id without its marker", () => {
	// openrouter renders these with a leading `~`. Recording both spellings made
	// the catalog 286 entries where --list-models prints 276 rows — and that count
	// goes into a fix line that names that very command as where to see the rest.
	const catalog = parseModelCatalog(LISTING);
	assert.deepEqual([...catalog.get("openrouter")!], ["anthropic/claude-sonnet-latest"]);
	assert.equal(judgeModel(catalog, "openrouter", "~anthropic/claude-sonnet-latest").ok, true,
		"while a config naming either spelling still matches");
});

test("an unreadable catalog is silence, not a verdict", () => {
	// pi missing, non-zero exit, a timeout — none of them are evidence about the
	// model, and a check that goes red because its own oracle failed is noise.
	for (const catalog of [undefined, new Map()]) {
		const verdict = judgeModel(catalog, "sub2api", "gpt-5.6");
		assert.equal(verdict.ok, true);
		assert.match(verdict.note!, /not checked/);
	}
});

test("a provider the catalog never mentions is not judged", () => {
	// The README example, on a machine whose catalog has no anthropic entry.
	const verdict = judgeModel(parseModelCatalog(LISTING), "anthropic", "claude-sonnet-5");
	assert.equal(verdict.ok, true, "absence of a provider is absence of evidence");
	assert.match(verdict.note!, /publishes no catalog/);
	assert.equal(verdict.fix, undefined);
});

test("a provider that did publish its list is taken at its word", () => {
	const catalog = parseModelCatalog(LISTING);

	assert.equal(judgeModel(catalog, "sub2api", "gpt-5.6").ok, true);

	// The motivating case: a fat-fingered id against a provider an extension
	// registered. Accepted today, and reported by the run it breaks — after which
	// consecutive failures trip the schedule's breaker, which a reload does not clear.
	const typo = judgeModel(catalog, "sub2api", "gpt-5.7");
	assert.equal(typo.ok, false);
	assert.match(typo.fix!, /gpt-5\.5, gpt-5\.6/, "naming what is there beats saying no");
});

test("a catalog too big to list gets near misses, a count, and the command for the rest", () => {
	// Measured: openrouter carries 276 models. Rendering all of them produced a
	// fix line that filled the terminal, which is the same as having no fix.
	const many = new Map([["openrouter", new Set([
		...Array.from({ length: 40 }, (_, i) => `vendor/model-${i}`),
		"openai/gpt-5.6-sol",
		"openai/gpt-5.6-terra",
	])]]);

	const verdict = judgeModel(many, "openrouter", "gpt-5.6-luna", ["npm:pi-sub2api"]);

	assert.equal(verdict.ok, false);
	assert.match(verdict.fix!, /gpt-5\.6-sol/, "the near misses come first, not the alphabet");
	assert.doesNotMatch(verdict.fix!, /vendor\/model-3\b/, "and the 40 unrelated ones stay out");
	assert.match(verdict.fix!, /42 in all/);
	assert.match(
		verdict.fix!,
		/pi -ne -e npm:pi-sub2api --list-models/,
		"reproducing it needs the same allowlist, so the command carries it",
	);

	// An id resembling nothing still shows what this provider's ids look like,
	// rather than the empty "it has , … (42 in all)" the scoring alone would give.
	assert.match(judgeModel(many, "openrouter", "zzzzzz").fix!, /vendor\/model-0/);
});
