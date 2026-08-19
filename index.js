/**
 * augment-ai-provider - AI SDK provider factory for Augment Code.
 *
 * Wraps @augmentcode/auggie-sdk's AugmentLanguageModel (LanguageModelV2,
 * direct HTTP chat API - no local auggie subprocess) in a standard provider
 * shape so harnesses that load AI SDK providers dynamically (opencode,
 * opencode2) can use it via a `create*` factory export.
 *
 * Credential resolution (first hit wins):
 *   1. Explicit options passed in code / harness config:
 *      { apiKey, apiUrl } (also accepts baseURL as alias for apiUrl)
 *   2. AUGMENT_SESSION_AUTH env var - session JSON from `auggie token print`
 *      ({ accessToken, tenantURL, ... })
 *   3. AUGMENT_API_TOKEN + AUGMENT_API_URL env vars
 *   4. ~/.augment/session.json (created by `auggie login`)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AugmentLanguageModel,
  listModels,
  resolveAugmentCredentials,
} from "@augmentcode/auggie-sdk";

export { AugmentLanguageModel, listModels, resolveAugmentCredentials };

function parseSessionJson(raw, source) {
  try {
    const data = JSON.parse(raw);
    if (data && data.accessToken && data.tenantURL) {
      return { apiKey: data.accessToken, apiUrl: data.tenantURL };
    }
  } catch {
    throw new Error(`Augment: failed to parse session JSON from ${source}`);
  }
  return undefined;
}

/**
 * Synchronous credential resolution (harnesses construct providers
 * synchronously). Same sources as the SDK's async resolveAugmentCredentials,
 * plus AUGMENT_SESSION_AUTH support.
 */
export function resolveAugmentCredentialsSync(options = {}) {
  let apiKey = options.apiKey;
  let apiUrl = options.apiUrl || options.baseURL || options.baseUrl;
  if (apiKey && apiUrl) return { apiKey, apiUrl };

  // AUGMENT_SESSION_AUTH: session JSON (auggie token print)
  const sessionAuth = process.env.AUGMENT_SESSION_AUTH;
  if (sessionAuth) {
    const creds = parseSessionJson(sessionAuth, "AUGMENT_SESSION_AUTH");
    if (creds) {
      apiKey = apiKey || creds.apiKey;
      apiUrl = apiUrl || creds.apiUrl;
    }
  }

  // Plain env vars
  apiKey = apiKey || process.env.AUGMENT_API_TOKEN;
  apiUrl = apiUrl || process.env.AUGMENT_API_URL;

  // ~/.augment/session.json from `auggie login`
  if (!apiKey || !apiUrl) {
    try {
      const raw = readFileSync(join(homedir(), ".augment", "session.json"), "utf-8");
      const creds = parseSessionJson(raw, "~/.augment/session.json");
      if (creds) {
        apiKey = apiKey || creds.apiKey;
        apiUrl = apiUrl || creds.apiUrl;
      }
    } catch {
      // no session file - fall through to error below
    }
  }

  if (!apiKey || !apiUrl) {
    throw new Error(
      "Augment credentials not found. Provide apiKey/apiUrl in options, " +
        "set AUGMENT_SESSION_AUTH (from `auggie token print`), set " +
        "AUGMENT_API_TOKEN + AUGMENT_API_URL, or run `auggie login`.",
    );
  }
  return { apiKey, apiUrl };
}

// ---------------------------------------------------------------------------
// LanguageModelV2 -> LanguageModelV3 adapter.
//
// The auggie-sdk model implements spec "v2" (ai SDK 5). opencode/opencode2
// consume providers through the v3 spec (@ai-sdk/provider 3.x): call options
// and stream parts are shape-identical except `finish`, where v3 wraps
// finishReason as { unified, raw } and nests usage into inputTokens/
// outputTokens objects. ai v6's own compat shim does the same conversion, but
// opencode2 reads the model stream directly, so we expose native v3.
// ---------------------------------------------------------------------------

function v3FinishReason(finishReason) {
  return {
    unified: finishReason === "unknown" ? "other" : finishReason,
    raw: undefined,
  };
}

function v3Usage(usage = {}) {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: undefined,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: undefined,
      reasoning: usage.reasoningTokens,
    },
  };
}

class AugmentLanguageModelV3 {
  constructor(inner) {
    this.inner = inner;
    this.specificationVersion = "v3";
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls ?? {};
  }

  async doGenerate(options) {
    const result = await this.inner.doGenerate(options);
    return {
      ...result,
      warnings: result.warnings ?? [],
      finishReason: v3FinishReason(result.finishReason),
      usage: v3Usage(result.usage),
    };
  }

  async doStream(options) {
    const result = await this.inner.doStream(options);
    const stream = result.stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            controller.enqueue({
              ...chunk,
              finishReason: v3FinishReason(chunk.finishReason),
              usage: v3Usage(chunk.usage),
            });
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return { ...result, stream };
  }
}

export { AugmentLanguageModelV3 };

/**
 * Create an Augment provider.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey]   Augment API token (overrides discovery)
 * @param {string} [options.apiUrl]   Augment tenant API URL (baseURL also accepted)
 * @param {boolean} [options.debug]   Enable SDK debug logging (logs payloads!)
 * @param {string} [options.clientUserAgent] Custom User-Agent
 * @returns provider function/object with `.languageModel(modelId)`
 */
export function createAugment(options = {}) {
  // Resolve eagerly so misconfiguration surfaces at load time, but do not
  // block: languageModel() re-resolves if construction-time discovery failed.
  let cached;
  const resolve = () => {
    if (!cached) cached = resolveAugmentCredentialsSync(options);
    return cached;
  };
  try {
    resolve();
  } catch {
    // defer error until a model is actually requested
  }

  const languageModel = (modelId) => {
    const { apiKey, apiUrl } = resolve();
    const inner = new AugmentLanguageModel(modelId, {
      apiKey,
      apiUrl,
      debug: options.debug ?? false,
      clientUserAgent: options.clientUserAgent,
    });
    return new AugmentLanguageModelV3(inner);
  };

  const provider = (modelId) => languageModel(modelId);
  provider.languageModel = languageModel;
  provider.chat = languageModel;
  provider.textEmbeddingModel = (modelId) => {
    throw new Error(`Augment provider has no embedding model "${modelId}"`);
  };
  provider.imageModel = (modelId) => {
    throw new Error(`Augment provider has no image model "${modelId}"`);
  };
  provider.listModels = () => listModels(resolve());
  provider.listModelsDetailed = () => listModelsDetailed(resolve());
  return provider;
}

/**
 * Fetch the full model registry with metadata (superset of the SDK's
 * listModels): id, displayName, description, vendor, costTier, effortLevels,
 * legacy/deprecation info, priority, isDefault. Only enabled models are
 * returned, sorted by registry priority (best/newest first).
 */
export async function listModelsDetailed(credentials = {}) {
  const { apiKey, apiUrl } = resolveAugmentCredentialsSync(credentials);
  const resp = await fetch(`${apiUrl.replace(/\/$/, "")}/get-models`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: "{}",
  });
  if (!resp.ok) {
    throw new Error(`listModelsDetailed: /get-models returned ${resp.status} ${resp.statusText}`);
  }
  const body = await resp.json();
  const registry = JSON.parse(body.feature_flags.model_info_registry);
  const defaultModelId = body.feature_flags.agent_chat_model;
  const models = Object.entries(registry)
    .filter(([, e]) => !e.disabled)
    .map(([id, e]) => ({
      id,
      displayName: e.displayName ?? id,
      description: e.description,
      vendor: e.provider,
      shortName: e.shortName,
      costTier: e.costTier,
      effortLevels: e.effortLevels,
      defaultEffortLevel: e.defaultEffortLevel,
      isLegacyModel: e.isLegacyModel ?? false,
      deprecationDate: e.deprecationDate,
      priority: e.priority ?? 0,
      isDefault: id === defaultModelId,
      // Registry has no context info; "-500k" ids are the long-context tiers.
      contextWindow: id.endsWith("-500k") ? 500_000 : 200_000,
      maxTokens: 32_768,
    }))
    .sort((a, b) => b.priority - a.priority);
  return { models, defaultModelId };
}
