/**
 * Verifies every RPC contract we depend on against the PUBLISHED build the
 * lockfile resolves — `@earendil-works/pi-coding-agent@1.3.0`.
 *
 * This is the upgrade gate: run it before widening the supported range in
 * doctor.ts, and after any `npm update` that moves pi. A failure means upstream
 * drifted — change the design first, then the code.
 *
 * Content-level cases need a working provider; without one they SKIP and say so
 * rather than pretending to pass.
 *   PROVIDER=sub2api MODEL=gpt-5.4-mini node --test test/agent-runner.contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRpcEntry, runAgent } from "../src/daemon/agent-runner.ts";
import { buildJobEnv } from "../src/daemon/job-env.ts";
import { createLogger } from "../src/daemon/logger.ts";
import { classify } from "../src/daemon/outcome.ts";
import { resolveProviderCredential } from "../src/core/credentials.ts";
import type { AgentProfile } from "../src/core/config.ts";

const RPC_ENTRY = resolveRpcEntry();
const PROVIDER = process.env.PROVIDER ?? "sub2api";
const MODEL = process.env.MODEL ?? "gpt-5.4-mini";
/**
 * Provider extension allowlist. `-ne` also disables the extension that registers
 * a provider: here sub2api comes from the npm package `pi-sub2api`, and without
 * adding it back pi prints `Unknown provider "sub2api"` and exits immediately.
 * Built-in providers such as anthropic need no allowlist.
 */
const PROVIDER_EXTENSIONS = process.env.PROVIDER_EXTENSION
	? [process.env.PROVIDER_EXTENSION]
	: PROVIDER === "sub2api"
		? [join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/pi-sub2api/src/index.ts")]
		: [];
const quietLogger = createLogger({ level: "error", write: () => {} });

/**
 * pi writes sessions into the OPERATOR's ~/.pi/agent/sessions/, which a test cleaning
 * up its own temp directory cannot reach — 187 stray directories accumulated there
 * before this. Pointing each run at its own temp directory makes them vanish with
 * the cwd.
 */
let currentDir: string | undefined;
const SESSION_DIR = (): string => join(currentDir ?? tmpdir(), "sessions");

function tmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-reactor-contract-"));
	mkdirSync(join(dir, "work"), { recursive: true });
	currentDir = dir;
	return dir;
}

function agentFor(cwd: string, extensions: string[] = PROVIDER_EXTENSIONS): AgentProfile {
	return { name: "t", cwd, provider: PROVIDER, modelId: MODEL, extensions, env: {}, maxDurationS: 60 };
}

// ------------------------------------------------------------ raw protocol probe
// Speaks the protocol directly, bypassing agent-runner, to pin upstream behaviour itself.

interface Probe {
	send(o: unknown): void;
	call(type: string, fields?: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>;
	waitFor(pred: (f: Record<string, unknown>) => boolean, ms: number, label: string): Promise<Record<string, unknown>>;
	/** Writes raw bytes: `send` JSON-serialises, so it cannot produce a genuinely bad frame. */
	raw(text: string): void;
	frames: Record<string, unknown>[];
	exited: Promise<{ code: number | null; signal: string | null }>;
	kill(sig?: NodeJS.Signals): void;
	endStdin(): void;
}

function probe(args: string[], cwd: string, env: Record<string, string>): Probe {
	// --session-dir for the same reason runAgent takes one: the probe also spawns a
	// real pi, and would also write into the operator's session directory.
	const child = spawn(process.execPath, [RPC_ENTRY, "--session-dir", SESSION_DIR(), ...args], {
		cwd, env, stdio: ["pipe", "pipe", "pipe"],
	});
	const frames: Record<string, unknown>[] = [];
	const listeners = new Set<(f: Record<string, unknown>) => void>();
	const decoder = new StringDecoder("utf8");
	let buf = "";
	child.stdout.on("data", (c: Buffer) => {
		buf += decoder.write(c);
		let i: number;
		while ((i = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (!line) continue;
			try {
				const f = JSON.parse(line) as Record<string, unknown>;
				frames.push(f);
				for (const fn of listeners) fn(f);
			} catch { /* ignore non-JSON lines */ }
		}
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
		child.once("exit", (code, signal) => r({ code, signal })));
	let id = 0;
	const send = (o: unknown) => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(o)}\n`); };
	const waitFor: Probe["waitFor"] = (pred, ms, label) => {
		const hit = frames.find(pred);
		if (hit) return Promise.resolve(hit);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { listeners.delete(fn); reject(new Error(`timeout: ${label}`)); }, ms);
			const fn = (f: Record<string, unknown>) => {
				if (pred(f)) { clearTimeout(timer); listeners.delete(fn); resolve(f); }
			};
			listeners.add(fn);
		});
	};
	return {
		send, frames, exited,
		raw: (text) => { if (child.stdin.writable) child.stdin.write(text); },
		call: (type, fields = {}, ms = 20_000) => {
			const rid = `p${++id}`;
			send({ id: rid, type, ...fields });
			return waitFor((f) => f.type === "response" && f.id === rid, ms, `response to ${type}`);
		},
		waitFor,
		kill: (sig = "SIGTERM") => child.kill(sig),
		endStdin: () => child.stdin.end(),
	};
}

const MINIMAL_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

// ------------------------------------------------------------ T1/T2/T7 lifecycle

test("contract T1: current public RPC commands work under the job environment allowlist", async () => {
	const dir = tmpCwd();
	let p: Probe | undefined;
	try {
		const agent = agentFor(join(dir, "work"), []);
		const env = buildJobEnv({
			agent,
			jobId: 1,
			socketPath: join(dir, "daemon.sock"),
			providerVars: {},
			hostEnv: { PATH: process.env.PATH, HOME: dir, UNLISTED_VALUE: "must-not-pass" },
		});
		assert.equal(env.UNLISTED_VALUE, undefined);

		p = probe(["-ne"], join(dir, "work"), env);
		const st = await p.call("get_state");
		assert.equal(st.success, true);
		const data = st.data as Record<string, unknown>;
		assert.equal(typeof data.sessionId, "string");
		assert.equal(data.isStreaming, false);

		const models = await p.call("get_available_models");
		assert.equal(models.success, true);
		assert.ok(Array.isArray((models.data as Record<string, unknown>).models));
		const last = await p.call("get_last_assistant_text");
		assert.equal(last.success, true);
		const lastText = (last.data as Record<string, unknown>).text;
		assert.ok(lastText === null || lastText === undefined,
			"an empty session has no last assistant text (the 1.3.0 runtime omits it)");

		p.endStdin();
		assert.equal((await p.exited).code, 0, "closing stdin is the graceful exit path");
	} finally {
		p?.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("contract T2: SIGTERM yields exit code 143, the anchor of the termination chain", async () => {
	const dir = tmpCwd();
	try {
		const p = probe(["-ne"], join(dir, "work"), MINIMAL_ENV);
		await p.call("get_state");
		p.kill("SIGTERM");
		const end = await p.exited;
		assert.ok(end.code === 143 || end.signal === "SIGTERM", `expected 143/SIGTERM, got code=${end.code} signal=${end.signal}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contract T7: a malformed line yields a parse error frame and the process survives", async () => {
	const dir = tmpCwd();
	try {
		const p = probe(["-ne"], join(dir, "work"), MINIMAL_ENV);
		await p.call("get_state");
		// Must write RAW bytes: send() would JSON.stringify and turn this into a valid JSON string.
		p.raw("this is not json at all\n");
		const err = await p.waitFor((f) => f.type === "response" && f.success === false, 10_000, "parse error");
		assert.equal(err.command, "parse");
		assert.equal((await p.call("get_state")).success, true, "the daemon can hold the connection: a bad frame is not fatal");
		p.endStdin();
		await p.exited;
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ T5 extension loading and UI

test("contract T5a: awaiting a dialog inside session_start deadlocks unconditionally", async () => {
	const dir = tmpCwd();
	try {
		const ext = join(dir, "nag.ts");
		writeFileSync(ext, `export default function (pi) {
			pi.on("session_start", async (_e, ctx) => {
				const v = await ctx.ui.confirm("nag", "proceed?");
				ctx.ui.notify("returned:" + v, "info");
			});
		}\n`);
		const p = probe(["-ne", "-e", ext], join(dir, "work"), MINIMAL_ENV);
		const req = await p.waitFor((f) => f.type === "extension_ui_request" && f.method === "confirm", 25_000, "confirm");
		p.send({ type: "extension_ui_response", id: req.id, cancelled: true });
		await new Promise((r) => setTimeout(r, 2500));
		assert.ok(!p.frames.some((f) => f.method === "notify"),
			"rpc-mode binds the stdin reader after rebindSession, so the response never lands and no auto-answer policy can help");
		p.kill("SIGKILL");
		await p.exited;
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contract T5b: a dialog after startup answers normally, and cancel has a safe default", async () => {
	const dir = tmpCwd();
	try {
		const ext = join(dir, "nag-late.ts");
		writeFileSync(ext, `export default function (pi) {
			pi.on("session_start", (_e, ctx) => {
				setTimeout(async () => {
					const v = await ctx.ui.confirm("nag", "proceed?");
					ctx.ui.notify("returned:" + v, "info");
				}, 300);
			});
		}\n`);
		const p = probe(["-ne", "-e", ext], join(dir, "work"), MINIMAL_ENV);
		const req = await p.waitFor((f) => f.type === "extension_ui_request" && f.method === "confirm", 25_000, "confirm");
		p.send({ type: "extension_ui_response", id: req.id, cancelled: true });
		const note = await p.waitFor((f) => f.method === "notify", 10_000, "notify");
		assert.equal(note.message, "returned:false", "cancel resolves confirm to false and the extension does not crash");
		p.endStdin();
		assert.equal((await p.exited).code, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contract T5c: selected extensions keep order; discovered extensions and Operator console stay out", async () => {
	const dir = tmpCwd();
	try {
		const agentDir = join(dir, "agent");
		const discoveredDir = join(agentDir, "extensions");
		mkdirSync(discoveredDir, { recursive: true });
		const selectedFirst = join(dir, "selected-first.ts");
		const selectedSecond = join(dir, "selected-second.ts");
		writeFileSync(selectedFirst,
			`export default pi => pi.registerCommand("selected-first", {description:"first", handler(){}});\n`);
		writeFileSync(selectedSecond,
			`export default pi => pi.registerCommand("selected-second", {description:"second", handler(){}});\n`);
		writeFileSync(join(discoveredDir, "discovered.ts"),
			`export default pi => pi.registerCommand("discovered", {description:"must stay out", handler(){}});\n`);
		// This discovered wrapper is the actual Operator extension. If -ne regresses,
		// /reactor appears in get_commands and the assertion below fails.
		const operatorExtension = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "extension", "index.ts");
		writeFileSync(join(discoveredDir, "reactor.ts"),
			`import reactor from ${JSON.stringify(pathToFileURL(operatorExtension).href)};\n` +
			`export default pi => { pi.registerCommand("operator-wrapper-loaded", {description:"marker", handler(){}}); reactor(pi); };\n`);

		const agent = agentFor(join(dir, "work"), [selectedSecond, selectedFirst]);
		const env = buildJobEnv({
			agent,
			jobId: 1,
			socketPath: join(dir, "daemon.sock"),
			providerVars: {},
			hostEnv: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agentDir },
		});
		const p = probe(["-ne", "-e", selectedSecond, "-e", selectedFirst], agent.cwd, env);
		await p.call("get_state");
		const response = await p.call("get_commands");
		const commands = ((response.data as Record<string, unknown>).commands as Array<{ name: string }>).map((c) => c.name);
		assert.deepEqual(commands.filter((name) => name.startsWith("selected-")), ["selected-second", "selected-first"]);
		assert.equal(commands.includes("discovered"), false);
		assert.equal(commands.includes("operator-wrapper-loaded"), false);
		assert.equal(commands.includes("reactor"), false, "the Operator console is never discovered into unattended jobs");
		p.endStdin();
		assert.equal((await p.exited).code, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ T3/T4 through agent-runner

test("contract T3: full agent-runner round trip (protocol always; content needs a provider)", async (t) => {
	const dir = tmpCwd();
	try {
		const agent = agentFor(join(dir, "work"));
		const cred = await resolveProviderCredential(agent.provider, {
			credentialsFile: join(dir, "credentials.json"),
		});
		if (!cred) {
			t.skip(`no credential for provider=${PROVIDER}; provider-dependent round trip is gated`);
			return;
		}
		const env = buildJobEnv({
			agent, jobId: 1, socketPath: join(dir, "daemon.sock"),
			providerVars: cred.vars,
		});
		const result = await runAgent({
			agent, task: "Reply with exactly: PONG", env,
			maxDurationMs: 90_000, logger: quietLogger, sessionDir: SESSION_DIR(), startupProbeMs: 30_000,
			abortGraceMs: 500, termGraceMs: 500,
		});

		// Protocol level: independent of provider health.
		assert.equal(result.settled, true, "must reach agent_settled");
		assert.equal(typeof result.durationMs, "number");
		assert.ok(result.pid && result.pid > 0);
		assert.equal(result.timedOut, false);

		// Content level (the whole case is credential-gated above).
		assert.match(result.lastText ?? "", /PONG/);
		assert.ok(result.usage.total > 0, `usage should be populated, got ${JSON.stringify(result.usage)}`);
		assert.equal(classify(result).outcome, "succeeded");
		assert.ok(result.sessionFile, "session_file must be captured: the reaper uses it to delete only our own sessions");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contract T3b: an unregistered provider exits at once and must fail fast, not burn the probe budget", async () => {
	const dir = tmpCwd();
	try {
		// Deliberately omit the provider extension to reproduce "-ne disabled the registrar".
		const agent: AgentProfile = { ...agentFor(join(dir, "work"), []), provider: "sub2api" };
		const began = Date.now();
		const result = await runAgent({
			agent, task: "hi",
			env: buildJobEnv({ agent, jobId: 9, socketPath: join(dir, "s"), providerVars: {} }),
			maxDurationMs: 60_000, logger: quietLogger, sessionDir: SESSION_DIR(),
			startupProbeMs: 30_000, abortGraceMs: 500, termGraceMs: 500,
		});
		const elapsed = Date.now() - began;

		assert.equal(result.settled, false);
		assert.ok(elapsed < 15_000, `the process died in a second; it must not burn the 30s probe budget (took ${elapsed}ms)`);
		assert.match(result.errorMessage ?? "", /exited during startup/i);
		const c = classify(result);
		assert.equal(c.outcome, "failed");
		assert.equal(c.reason, "crash");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contract T4: maxDuration drives the termination chain to failed + reason:timeout", async (t) => {
	const dir = tmpCwd();
	try {
		const agent = agentFor(join(dir, "work"));
		const cred = await resolveProviderCredential(agent.provider, { credentialsFile: join(dir, "credentials.json") });
		if (!cred) { t.skip("no provider credential; cannot produce an interruptible stream"); return; }

		const env = buildJobEnv({ agent, jobId: 2, socketPath: join(dir, "daemon.sock"), providerVars: cred.vars });
		const result = await runAgent({
			agent, task: "Write a 2000 word story about a lighthouse, in full detail.",
			env, maxDurationMs: 3_000, logger: quietLogger, sessionDir: SESSION_DIR(),
			startupProbeMs: 30_000, abortGraceMs: 2_000, termGraceMs: 2_000,
		});

		assert.equal(result.timedOut, true);
		const c = classify(result);
		assert.equal(c.outcome, "failed");
		assert.equal(c.reason, "timeout");
		assert.equal(c.retryable, false, "policy class does not retry: retrying without changing maxDuration just spends again");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
