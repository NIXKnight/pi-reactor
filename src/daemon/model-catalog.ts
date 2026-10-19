import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { resolveRpcEntry } from "./agent-runner.ts";

/** Provider name to the model ids returned by pi's public RPC contract. */
export type ModelCatalog = Map<string, Set<string>>;

export interface ModelVerdict {
	ok: boolean;
	/** Shown even when ok, to say why a check did not really run. */
	note?: string;
	/** Only meaningful when ok is false. */
	fix?: string;
}

interface RpcModel {
	provider?: unknown;
	id?: unknown;
}

/** Converts the public get_available_models payload into the narrow catalog doctor needs. */
export function catalogFromModels(models: unknown): ModelCatalog {
	const catalog: ModelCatalog = new Map();
	if (!Array.isArray(models)) return catalog;
	for (const raw of models) {
		if (!raw || typeof raw !== "object") continue;
		const model = raw as RpcModel;
		if (typeof model.provider !== "string" || typeof model.id !== "string") continue;
		const ids = catalog.get(model.provider) ?? new Set<string>();
		ids.add(canonicalId(model.id));
		catalog.set(model.provider, ids);
	}
	return catalog;
}

/**
 * Whether the catalog contradicts this model — deliberately not "whether it
 * confirms it".
 *
 * get_available_models only returns models available under the process's
 * credentials and selected extensions. An absent provider therefore means "no
 * evidence". A provider that is present has published its available list, and a
 * missing model id is a typo worth naming.
 */
export function judgeModel(
	catalog: ModelCatalog | undefined,
	provider: string,
	modelId: string,
	extensions: string[] = [],
): ModelVerdict {
	if (!catalog || catalog.size === 0) {
		return { ok: true, note: "pi's model catalog could not be read; not checked" };
	}
	const ids = catalog.get(provider);
	if (!ids) {
		return { ok: true, note: `provider "${provider}" publishes no catalog under this allowlist; not checked` };
	}
	if (ids.has(canonicalId(modelId))) return { ok: true };

	const listing = ids.size <= FULL_LIST_MAX
		? [...ids].sort().join(", ")
		: `${nearestIds(ids, modelId).join(", ")}, … (${ids.size} in all: \`${listCommand(extensions)}\`)`;
	return { ok: false, fix: `provider "${provider}" does not offer "${modelId}"; it has ${listing}` };
}

/** Above this many, the full list stops being readable and starts being scrolled past. */
const FULL_LIST_MAX = 12;

/** Drops the marker openrouter uses on a floating alias. */
function canonicalId(modelId: string): string {
	return modelId.startsWith("~") ? modelId.slice(1) : modelId;
}

function listCommand(extensions: string[]): string {
	return ["pi", "-ne", ...extensions.flatMap((e) => ["-e", e]), "--list-models"].join(" ");
}

/** The ids most likely to be what was meant, by shared word. */
function nearestIds(ids: Set<string>, modelId: string, limit = 6): string[] {
	const needle = modelId.toLowerCase();
	const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
	const scored: Array<{ id: string; score: number }> = [];
	for (const id of ids) {
		const hay = id.toLowerCase();
		let score = hay.includes(needle) ? 100 : 0;
		for (const word of words) if (hay.includes(word)) score += word.length;
		if (score > 0) scored.push({ id, score });
	}
	scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	if (scored.length === 0) return [...ids].sort().slice(0, limit);
	return scored.slice(0, limit).map((s) => s.id);
}

export interface CatalogOptions {
	/** Where to run pi, because it resolves project-local settings per directory. */
	cwd: string;
	/** The profile's selected-only allowlist, passed exactly as the runner passes it. */
	extensions: string[];
	/** The complete allowlisted job environment. Defaults to the current process for direct callers. */
	env?: Record<string, string>;
	timeoutMs?: number;
	/** Injection point for tests; production resolves only pi's public rpc-entry export. */
	rpcEntry?: string;
}

/**
 * Lists available models through the public RPC protocol.
 *
 * The child receives only `-ne` plus the profile's selected extensions. It is
 * sent exactly one get_available_models command, never a prompt, and therefore
 * makes no provider/model call. stdout is continuously drained as LF-delimited
 * JSONL, stdin is closed after the response, and the child is bounded.
 */
export async function readModelCatalog(options: CatalogOptions): Promise<ModelCatalog | undefined> {
	let rpcEntry: string;
	try {
		rpcEntry = options.rpcEntry ?? resolveRpcEntry();
	} catch {
		return undefined;
	}

	const sessionDir = mkdtempSync(join(tmpdir(), "pi-reactor-models-"));
	const args = [rpcEntry, "--session-dir", sessionDir, "-ne"];
	for (const ext of options.extensions) args.push("-e", ext);

	return await new Promise<ModelCatalog | undefined>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, args, {
				cwd: options.cwd,
				env: options.env ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			rmSync(sessionDir, { recursive: true, force: true });
			resolve(undefined);
			return;
		}

		let result: ModelCatalog | undefined;
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rmSync(sessionDir, { recursive: true, force: true });
			resolve(result);
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish();
		}, options.timeoutMs ?? 20_000);
		timer.unref();

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let index: number;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (line === "") continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				if (!frame || typeof frame !== "object") continue;
				const value = frame as Record<string, unknown>;
				if (value.type === "extension_ui_request" && typeof value.id === "string") {
					const request = frame as RpcExtensionUIRequest;
					if (!["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)) {
						const response = { type: "extension_ui_response", id: request.id, cancelled: true } satisfies RpcExtensionUIResponse;
						child.stdin?.write(`${JSON.stringify(response)}\n`);
					}
					continue;
				}
				if (value.type !== "response" || value.id !== "models") continue;
				const response = frame as RpcResponse;
				if (response.success && response.command === "get_available_models") {
					result = catalogFromModels(response.data.models);
				}
				child.stdin?.end();
			}
		});
		// Always drain stderr; retaining it could leak provider or extension output.
		child.stderr?.resume();
		child.once("error", () => {
			result = undefined;
			finish();
		});
		child.once("close", (code) => {
			if (code !== 0) result = undefined;
			finish();
		});

		const command = { id: "models", type: "get_available_models" } satisfies RpcCommand;
		child.stdin?.write(`${JSON.stringify(command)}\n`);
	});
}
