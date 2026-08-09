/**
 * What models an agent's profile can actually see, asked of pi itself.
 *
 * `agent add`/`edit` validate that a model parses as `provider/model-id` and
 * nothing more, so a typo is accepted, written, and reported only by the run it
 * breaks — at 09:00, and after enough of them the schedule's breaker trips and
 * stays dark until `schedule resume`.
 *
 * The oracle is `pi --list-models` run under the profile's OWN allowlist. It has
 * to be that and not the ambient pi: batch jobs get `-ne`, so a provider a
 * global extension registers is invisible to them, and a check run without the
 * same flags passes for a configuration that cannot start.
 *
 * The catalog is evidence of presence only. See judgeModel.
 */
import { spawn } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Provider name to the model ids it offers, as pi's own table reports them. */
export type ModelCatalog = Map<string, Set<string>>;

export interface ModelVerdict {
	ok: boolean;
	/** Shown even when ok, to say why a check did not really run. */
	note?: string;
	/** Only meaningful when ok is false. */
	fix?: string;
}

/** Resolves pi's CLI entry, which is a different file from the RPC entry the runner spawns. */
export function resolvePiCli(): string {
	const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))));
	const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin?: Record<string, string> };
	const bin = pkg.bin?.["pi"];
	if (!bin) throw new Error("the pi package declares no `pi` bin");
	return isAbsolute(bin) ? bin : join(packageRoot, bin);
}

/**
 * Parses the `--list-models` table.
 *
 * Anchored on the header row rather than on line numbers: extensions print their
 * own startup lines to stdout first (`[sub2api] registered 10 model(s) — …`),
 * and that noise is exactly the case where a positional parse reads a banner as
 * a model. Everything before the header is skipped, and rows are split on
 * whitespace because no field in the first two columns contains any.
 */
export function parseModelCatalog(stdout: string): ModelCatalog {
	const catalog: ModelCatalog = new Map();
	const lines = stdout.split("\n");
	const header = lines.findIndex((line) => {
		const [first, second] = line.trim().split(/\s+/);
		return first === "provider" && second === "model";
	});
	if (header === -1) return catalog;

	for (const line of lines.slice(header + 1)) {
		const [provider, model] = line.trim().split(/\s+/);
		if (!provider || !model) continue;
		const ids = catalog.get(provider) ?? new Set<string>();
		ids.add(canonicalId(model));
		catalog.set(provider, ids);
	}
	return catalog;
}

/**
 * Whether the catalog contradicts this model — deliberately not "whether it
 * confirms it".
 *
 * `--list-models` does not enumerate everything pi can run. On a machine with no
 * fetched catalogs it lists only what extensions registered; `anthropic` does not
 * appear at all on a checkout where README's own `anthropic/claude-sonnet-5`
 * example is the documented one. So an absent PROVIDER means "no evidence", and
 * saying otherwise would make this red for correct configurations — the failure
 * mode that made the extension-path check worthless before 3fd75d4.
 *
 * A provider that IS in the catalog has published its list, and a model id
 * missing from that list is a typo worth naming. That narrow claim is the whole
 * check, and it covers the case that motivated it: a model id fat-fingered
 * against a provider some extension registers.
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

	// Naming what IS there is the whole value of the check — "not found" leaves
	// the operator exactly where they started. But openrouter alone carries 286
	// models, and a fix line that long is one nobody reads, so a big catalog gets
	// the near misses and the command that prints the rest under this same allowlist.
	const listing = ids.size <= FULL_LIST_MAX
		? [...ids].sort().join(", ")
		: `${nearestIds(ids, modelId).join(", ")}, … (${ids.size} in all: \`${listCommand(extensions)}\`)`;
	return { ok: false, fix: `provider "${provider}" does not offer "${modelId}"; it has ${listing}` };
}

/** Above this many, the full list stops being readable and starts being scrolled past. */
const FULL_LIST_MAX = 12;

/**
 * Drops the `~` openrouter renders on a floating alias (`~openai/gpt-latest`).
 *
 * Normalised on both sides rather than stored as two spellings: the count in the
 * fix line is a promise about the command printed beside it, and recording both
 * made it 286 where `--list-models` shows 276 rows.
 */
function canonicalId(modelId: string): string {
	return modelId.startsWith("~") ? modelId.slice(1) : modelId;
}

function listCommand(extensions: string[]): string {
	return ["pi", "-ne", ...extensions.flatMap((e) => ["-e", e]), "--list-models"].join(" ");
}

/**
 * The ids most likely to be what was meant, by shared word.
 *
 * A typo keeps most of the name — `gpt-5.7` for `gpt-5.6`, `claude-opus-6` for
 * `claude-opus-5` — so scoring on the chunks between separators puts the real
 * candidates first. Alphabetical order would answer a misspelt GPT id with
 * `ai21/jamba`, which is a list rather than an answer.
 */
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
	// Nothing resembles it: fall back to the front of the list rather than nothing,
	// so the line still shows what this provider's ids look like.
	if (scored.length === 0) return [...ids].sort().slice(0, limit);
	return scored.slice(0, limit).map((s) => s.id);
}

export interface CatalogOptions {
	/** Where to run pi, because it resolves project-local settings per directory. */
	cwd: string;
	/** The profile's allowlist, passed exactly as the runner passes it. */
	extensions: string[];
	timeoutMs?: number;
	/** Injection point for tests; production resolves pi's own bin. */
	cliPath?: string;
}

/**
 * Runs `pi --list-models` under one profile's allowlist.
 *
 * Returns undefined rather than throwing when pi cannot be run, exits non-zero,
 * or outruns the budget: an unreadable catalog is an absence of evidence, and a
 * check that goes red because its own oracle was unavailable is one nobody
 * reads. The timeout is the whole defence against a hang, since this is the only
 * subprocess doctor spawns.
 */
export async function readModelCatalog(options: CatalogOptions): Promise<ModelCatalog | undefined> {
	let cliPath: string;
	try {
		cliPath = options.cliPath ?? resolvePiCli();
	} catch {
		return undefined;
	}

	// `-ne` and the allowlist, in the order buildArgs uses: this has to be the
	// same pi the job gets, or the answer is about a different configuration.
	const args = [cliPath, "-ne"];
	for (const ext of options.extensions) args.push("-e", ext);
	args.push("--list-models");

	return await new Promise<ModelCatalog | undefined>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve(undefined);
			return;
		}

		let stdout = "";
		let settled = false;
		const finish = (value: ModelCatalog | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, options.timeoutMs ?? 20_000);
		timer.unref();

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		// Drained but unread: pi writes progress here, and a full pipe would wedge it.
		child.stderr?.resume();
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? parseModelCatalog(stdout) : undefined));
	});
}
