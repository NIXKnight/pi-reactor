/**
 * Pins the two upstream facts the model check rests on, against the PUBLISHED
 * build the lockfile resolves — today `@earendil-works/pi-coding-agent@0.82.1`.
 *
 * The check parses a table meant for humans, so its shape is a contract nobody
 * wrote down. And its whole premise is that `--list-models` answers differently
 * under a different allowlist; if that ever stopped being true the check would
 * pass for configurations that cannot start, which is worse than not having it.
 *
 * Run before widening the supported range in doctor.ts, and after any `npm
 * update` that moves pi. The allowlist case needs a provider extension on the
 * machine; without one it SKIPs and says so rather than pretending to pass.
 *   PROVIDER_EXTENSION=npm:pi-sub2api PROVIDER=sub2api node --test test/model-catalog.contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCatalog } from "../src/daemon/model-catalog.ts";

const PROVIDER = process.env.PROVIDER ?? "sub2api";
const PROVIDER_EXTENSION = process.env.PROVIDER_EXTENSION;

function tmpCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-reactor-catalog-"));
}

test("contract: --list-models still prints a table this parser recognises", async () => {
	const cwd = tmpCwd();
	try {
		const catalog = await readModelCatalog({ cwd, extensions: [], timeoutMs: 60_000 });

		assert.ok(catalog, "pi ran and exited 0");
		assert.ok(catalog.size > 0, "a machine with no catalog at all would make this check permanently silent");

		for (const [provider, ids] of catalog) {
			assert.doesNotMatch(provider, /\s/, "provider names are one whitespace-free token");
			assert.notEqual(provider, "provider", "the header row was consumed, not parsed as data");
			assert.ok(ids.size > 0, `${provider} has at least one model`);
			for (const id of ids) assert.doesNotMatch(id, /\s/, `${provider}/${id}`);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("contract: the allowlist decides which providers register", async (t) => {
	// The premise of asking pi under the profile's own flags. A provider an
	// extension registers is invisible to `-ne` alone, which is exactly the state
	// a batch job runs in — so a check that consulted the ambient pi would bless a
	// configuration that dies at startup with `Unknown provider`.
	if (!PROVIDER_EXTENSION) {
		t.diagnostic("SKIP: set PROVIDER_EXTENSION (and PROVIDER) to a provider extension on this machine");
		return;
	}
	const cwd = tmpCwd();
	try {
		const withExt = await readModelCatalog({ cwd, extensions: [PROVIDER_EXTENSION], timeoutMs: 60_000 });
		const without = await readModelCatalog({ cwd, extensions: [], timeoutMs: 60_000 });

		assert.ok(withExt?.has(PROVIDER), `${PROVIDER} registers when ${PROVIDER_EXTENSION} is allowlisted`);
		assert.equal(without?.has(PROVIDER), false, `and is invisible without it — the reason the check passes the allowlist`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("contract: an unloadable allowlist entry does not fail the listing", async () => {
	// Measured, against the guess that preceded it: pi exits 0 with an empty
	// stderr and lists the rest. So a broken -e never reaches judgeModel as
	// "oracle failed" — the provider it would have registered is simply absent,
	// which judgeModel treats as no evidence and passes over in silence.
	//
	// That is the right division of labour rather than a gap: doctor already
	// reports a missing extension PATH on its own line, and reporting one fault
	// twice is how a report stops being read. If this ever starts exiting
	// non-zero, readModelCatalog returns undefined and the check goes quiet for
	// every provider on that agent — still no false failure, but worth knowing.
	const cwd = tmpCwd();
	try {
		const catalog = await readModelCatalog({
			cwd,
			extensions: [join(cwd, "definitely-not-here.ts")],
			timeoutMs: 60_000,
		});
		assert.ok(catalog, "a broken allowlist entry is ignored, not fatal");
		assert.ok(catalog.size > 0, "and the providers that did load are still listed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
