/** Verifies model listing through pi 1.3.0's exported RPC entry and commands. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCatalog } from "../src/daemon/model-catalog.ts";
import { buildJobEnv } from "../src/daemon/job-env.ts";
import { resolveProviderCredential } from "../src/core/credentials.ts";
import type { AgentProfile } from "../src/core/config.ts";

const PROVIDER = process.env.PROVIDER ?? "sub2api";
const PROVIDER_EXTENSION = process.env.PROVIDER_EXTENSION;

function tmpCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-reactor-catalog-"));
}

function catalogEnv(cwd: string, providerVars: Record<string, string> = {}): Record<string, string> {
	const agent: AgentProfile = {
		name: "catalog",
		cwd,
		provider: PROVIDER,
		modelId: process.env.MODEL ?? "unused",
		extensions: [],
		env: {},
		maxDurationS: 60,
	};
	return buildJobEnv({
		agent,
		jobId: 0,
		socketPath: join(cwd, "daemon.sock"),
		providerVars,
		hostEnv: { PATH: process.env.PATH, HOME: cwd },
	});
}

test("contract: get_available_models lists through public rpc-entry without a prompt", async () => {
	const cwd = tmpCwd();
	try {
		const catalog = await readModelCatalog({
			cwd,
			extensions: [],
			env: catalogEnv(cwd),
			timeoutMs: 60_000,
		});
		assert.ok(catalog, "the public RPC child answered and exited cleanly");
		assert.ok(catalog instanceof Map);
		// With no credential the current public contract returns an empty available
		// list. That is a valid answer, not a reason to consult package internals.
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("contract: selected provider extensions affect the RPC model list", async (t) => {
	if (!PROVIDER_EXTENSION) {
		t.skip("set PROVIDER_EXTENSION (and PROVIDER) to a provider extension on this machine");
		return;
	}
	const cwd = tmpCwd();
	try {
		const credential = await resolveProviderCredential(PROVIDER, {
			credentialsFile: join(cwd, "credentials.json"),
		});
		if (!credential) {
			t.skip(`no credential for provider=${PROVIDER}; available-model assertion is gated`);
			return;
		}
		const withExt = await readModelCatalog({
			cwd,
			extensions: [PROVIDER_EXTENSION],
			env: catalogEnv(cwd, credential.vars),
			timeoutMs: 60_000,
		});
		const without = await readModelCatalog({
			cwd,
			extensions: [],
			env: catalogEnv(cwd, credential.vars),
			timeoutMs: 60_000,
		});
		assert.ok(withExt?.has(PROVIDER), `${PROVIDER} registers when the selected extension is loaded`);
		assert.equal(without?.has(PROVIDER), false, "the provider is absent without that selected extension");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("contract: an unloadable selected extension fails closed", async () => {
	const cwd = tmpCwd();
	try {
		const catalog = await readModelCatalog({
			cwd,
			extensions: [join(cwd, "definitely-not-here.ts")],
			env: catalogEnv(cwd),
			timeoutMs: 60_000,
		});
		assert.equal(catalog, undefined, "doctor must not claim model evidence from a failed selected-only startup");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
