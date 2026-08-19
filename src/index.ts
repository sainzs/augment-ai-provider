/**
 * Augment Code provider for pi.
 *
 * Registers an "augment" provider that talks to Augment's chat-stream API
 * through @augmentcode/auggie-sdk's AugmentLanguageModel (AI SDK
 * LanguageModelV2, direct HTTP - no local auggie subprocess). The wrapper
 * library lives at the repo root (index.js), shared with the
 * opencode/opencode2 provider integrations.
 *
 * Auth resolution:
 *   1. pi-resolved apiKey (provider config below uses `!jq ... session.json`)
 *   2. AUGMENT_SESSION_AUTH env (session JSON from `auggie token print`)
 *   3. AUGMENT_API_TOKEN / AUGMENT_API_URL env
 *   4. ~/.augment/session.json (from `auggie login`)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	AugmentLanguageModel,
	listModelsDetailed,
	resolveAugmentCredentialsSync,
	// The wrapper is plain ESM JS; import by absolute path so its own
	// node_modules (with @augmentcode/auggie-sdk) resolve normally.
} from "../index.js";
import { readFileSync } from "node:fs";

const AUGMENT_API: Api = "augment-chat" as Api;
const FALLBACK_API_URL = "https://xlb.api.augmentcode.com/";
const MODELS_CACHE = "../models-cache.json";

interface CatalogModel {
	id: string;
	displayName: string;
	isDefault?: boolean;
	isLegacyModel?: boolean;
	deprecationDate?: string;
	contextWindow?: number;
	maxTokens?: number;
}

function toPiModel(m: CatalogModel) {
	let name = m.displayName;
	if (m.isDefault) name += " (default)";
	if (m.deprecationDate) name += ` (deprecated ${m.deprecationDate})`;
	else if (m.isLegacyModel) name += " (legacy)";
	return {
		id: m.id,
		name: `${name} (Augment)`,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 200_000,
		maxTokens: m.maxTokens ?? 32_768,
	};
}

// Static fallback when neither the synced cache nor the live API is reachable.
const FALLBACK_MODELS: CatalogModel[] = [
	{ id: "claude-haiku-4-5", displayName: "Haiku 4.5" },
	{ id: "claude-sonnet-4-5", displayName: "Sonnet 4.5" },
	{ id: "claude-sonnet-5-0", displayName: "Sonnet 5.0" },
	{ id: "claude-opus-4-8", displayName: "Opus 4.8" },
	{ id: "gpt-5-6-sol", displayName: "GPT-5.6 Sol" },
];

/**
 * Model catalog resolution: synced cache file (fast, offline-safe; refresh
 * with `node ~/.local/share/augment-ai-provider/bin/sync-models.mjs`) ->
 * live /get-models fetch -> static fallback.
 */
function loadCachedModels(): CatalogModel[] | undefined {
	try {
		const cache = JSON.parse(readFileSync(MODELS_CACHE, "utf-8"));
		if (Array.isArray(cache.models) && cache.models.length > 0) return cache.models;
	} catch {
		// no cache - fall through
	}
	return undefined;
}

async function loadModels(): Promise<CatalogModel[]> {
	const cached = loadCachedModels();
	if (cached) return cached;
	try {
		const { models } = await listModelsDetailed();
		return models as CatalogModel[];
	} catch {
		return FALLBACK_MODELS;
	}
}

// --- pi Context -> LanguageModelV2 prompt -----------------------------------

function textOf(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p) => p.type === "text")
		.map((p) => (p as { text: string }).text)
		.join("");
}

function contextToPrompt(context: Context): unknown[] {
	const prompt: unknown[] = [];
	if (context.systemPrompt) {
		prompt.push({ role: "system", content: context.systemPrompt });
	}
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const text = textOf(msg.content);
			// Augment's chat API is text-only; images are dropped.
			prompt.push({ role: "user", content: [{ type: "text", text }] });
		} else if (msg.role === "assistant") {
			const parts: unknown[] = [];
			for (const part of msg.content) {
				if (part.type === "text" && part.text) {
					parts.push({ type: "text", text: part.text });
				} else if (part.type === "thinking" && part.thinking) {
					parts.push({ type: "reasoning", text: part.thinking });
				} else if (part.type === "toolCall") {
					parts.push({
						type: "tool-call",
						toolCallId: part.id,
						toolName: part.name,
						input: part.arguments ?? {},
					});
				}
			}
			// Skip empty (e.g. errored/aborted) assistant turns: each assistant
			// message closes a request/response exchange in Augment's history.
			if (parts.length > 0) prompt.push({ role: "assistant", content: parts });
		} else if (msg.role === "toolResult") {
			const text = textOf(msg.content);
			prompt.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						output: msg.isError
							? { type: "error-text", value: text }
							: { type: "text", value: text },
					},
				],
			});
		}
	}
	return prompt;
}

function contextToTools(context: Context): unknown[] | undefined {
	if (!context.tools || context.tools.length === 0) return undefined;
	return context.tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		inputSchema: t.parameters,
	}));
}

function mapStopReason(finishReason: string): AssistantMessage["stopReason"] {
	switch (finishReason) {
		case "length":
			return "length";
		case "tool-calls":
			return "toolUse";
		case "content-filter":
		case "error":
			return "error";
		default:
			// "stop", "unknown", "other": treat as normal end of turn.
			return "stop";
	}
}

// --- streaming adapter -------------------------------------------------------

const modelCache = new Map<string, InstanceType<typeof AugmentLanguageModel>>();

function getModel(modelId: string, apiKey: string, apiUrl: string) {
	const key = `${modelId}\u0000${apiUrl}\u0000${apiKey.slice(0, 12)}`;
	let m = modelCache.get(key);
	if (!m) {
		m = new AugmentLanguageModel(modelId, {
			apiKey,
			apiUrl,
			clientUserAgent: "pi-augment-provider/1.0",
		});
		modelCache.set(key, m);
	}
	return m;
}

function streamAugment(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });

			// Credentials: pi-resolved apiKey first, then env/session discovery.
			let apiKey = options?.apiKey;
			let apiUrl = model.baseUrl;
			if (!apiKey || !apiUrl) {
				const creds = resolveAugmentCredentialsSync({ apiKey, apiUrl });
				apiKey = creds.apiKey;
				apiUrl = creds.apiUrl;
			}

			const lm = getModel(model.id, apiKey, apiUrl);
			const { stream: v2Stream } = await lm.doStream({
				prompt: contextToPrompt(context),
				tools: contextToTools(context),
				abortSignal: options?.signal,
				maxOutputTokens: options?.maxTokens ?? model.maxTokens,
			} as never);

			// Map V2 stream part ids -> content indices.
			const blockIndex = new Map<string, number>();
			const toolJson = new Map<string, string>();
			let finishReason: string | undefined;

			const reader = (v2Stream as ReadableStream<Record<string, never>>).getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const part = value as {
					type: string;
					id?: string;
					delta?: string;
					toolName?: string;
					toolCallId?: string;
					input?: string;
					finishReason?: string;
					usage?: {
						inputTokens?: number;
						outputTokens?: number;
						totalTokens?: number;
						cachedInputTokens?: number;
					};
					error?: unknown;
				};

				switch (part.type) {
					case "text-start": {
						output.content.push({ type: "text", text: "" });
						blockIndex.set(part.id ?? "", output.content.length - 1);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						break;
					}
					case "text-delta": {
						const idx = blockIndex.get(part.id ?? "");
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type === "text") block.text += part.delta ?? "";
						stream.push({ type: "text_delta", contentIndex: idx, delta: part.delta ?? "", partial: output });
						break;
					}
					case "text-end": {
						const idx = blockIndex.get(part.id ?? "");
						if (idx === undefined) break;
						const block = output.content[idx];
						stream.push({
							type: "text_end",
							contentIndex: idx,
							content: block.type === "text" ? block.text : "",
							partial: output,
						});
						break;
					}
					case "reasoning-start": {
						output.content.push({ type: "thinking", thinking: "" });
						blockIndex.set(part.id ?? "", output.content.length - 1);
						stream.push({
							type: "thinking_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
						break;
					}
					case "reasoning-delta": {
						const idx = blockIndex.get(part.id ?? "");
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type === "thinking") block.thinking += part.delta ?? "";
						stream.push({ type: "thinking_delta", contentIndex: idx, delta: part.delta ?? "", partial: output });
						break;
					}
					case "reasoning-end": {
						const idx = blockIndex.get(part.id ?? "");
						if (idx === undefined) break;
						const block = output.content[idx];
						stream.push({
							type: "thinking_end",
							contentIndex: idx,
							content: block.type === "thinking" ? block.thinking : "",
							partial: output,
						});
						break;
					}
					case "tool-input-start": {
						output.content.push({
							type: "toolCall",
							id: part.id ?? "",
							name: part.toolName ?? "",
							arguments: {},
						});
						blockIndex.set(part.id ?? "", output.content.length - 1);
						toolJson.set(part.id ?? "", "");
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						break;
					}
					case "tool-input-delta": {
						const idx = blockIndex.get(part.id ?? "");
						if (idx === undefined) break;
						const acc = (toolJson.get(part.id ?? "") ?? "") + (part.delta ?? "");
						toolJson.set(part.id ?? "", acc);
						const block = output.content[idx];
						if (block.type === "toolCall") {
							try {
								block.arguments = JSON.parse(acc);
							} catch {
								// partial JSON - keep last good parse
							}
						}
						stream.push({ type: "toolcall_delta", contentIndex: idx, delta: part.delta ?? "", partial: output });
						break;
					}
					case "tool-input-end":
						break;
					case "tool-call": {
						const id = part.toolCallId ?? "";
						let idx = blockIndex.get(id);
						if (idx === undefined) {
							output.content.push({ type: "toolCall", id, name: part.toolName ?? "", arguments: {} });
							idx = output.content.length - 1;
							blockIndex.set(id, idx);
							stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						}
						const block = output.content[idx];
						if (block.type === "toolCall") {
							try {
								block.arguments = JSON.parse(part.input || "{}");
							} catch {
								block.arguments = {};
							}
							stream.push({
								type: "toolcall_end",
								contentIndex: idx,
								toolCall: { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
								partial: output,
							});
						}
						break;
					}
					case "finish": {
						finishReason = part.finishReason;
						const u = part.usage ?? {};
						output.usage.input = u.inputTokens ?? 0;
						output.usage.output = u.outputTokens ?? 0;
						output.usage.cacheRead = u.cachedInputTokens ?? 0;
						output.usage.cacheWrite = 0;
						output.usage.totalTokens = u.totalTokens ?? output.usage.input + output.usage.output;
						calculateCost(model, output.usage);
						break;
					}
					case "error": {
						const err = part.error;
						throw err instanceof Error ? err : new Error(String(err ?? "Augment stream error"));
					}
					default:
						// stream-start, response-metadata, raw, ...: ignore
						break;
				}
			}

			if (!finishReason) {
				throw new Error("Augment stream ended without a finish reason");
			}
			output.rawStopReason = finishReason;
			output.stopReason = mapStopReason(finishReason);
			if (output.stopReason === "error") {
				throw new Error(`Augment request failed (finish reason: ${finishReason})`);
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// --- registration ------------------------------------------------------------

export default async function augmentProvider(pi: ExtensionAPI) {
	let baseUrl = FALLBACK_API_URL;
	try {
		baseUrl = resolveAugmentCredentialsSync().apiUrl;
	} catch {
		// no credentials yet - keep fallback; auth resolves per request
	}

	const catalog = await loadModels();

	pi.registerProvider("augment", {
		name: "Augment Code",
		baseUrl,
		// Session token from `auggie login`; env vars win if set.
		apiKey: process.env.AUGMENT_API_TOKEN
			? "$AUGMENT_API_TOKEN"
			: "!jq -r .accessToken ~/.augment/session.json",
		api: AUGMENT_API,
		streamSimple: streamAugment,
		models: catalog.map(toPiModel),
		// Live refresh (e.g. on /login or model list refresh).
		async refreshModels() {
			const { models } = await listModelsDetailed();
			return (models as CatalogModel[]).map(toPiModel);
		},
	});
}
