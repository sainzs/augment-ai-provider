#!/usr/bin/env node
/**
 * Sync the Augment tenant model catalog into every harness:
 *
 *   1. ~/.local/share/augment-ai-provider/models-cache.json
 *      (read by the pi extension at startup)
 *   2. ~/.config/opencode/opencode.json   -> provider.augment.models
 *   3. ~/.config/opencode2/opencode.json  -> provider.augment.models
 *
 * Run after `auggie login`, or whenever Augment adds/retires models:
 *   node ~/.local/share/augment-ai-provider/bin/sync-models.mjs
 *
 * Note: opencode2's background service caches config; run
 * `opencode2 service restart` afterwards.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listModelsDetailed } from "../index.js";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const { models, defaultModelId } = await listModelsDetailed();

// 1. cache for the pi extension
const cachePath = join(here, "models-cache.json");
writeFileSync(cachePath, JSON.stringify({ syncedAt: new Date().toISOString(), defaultModelId, models }, null, 2));
console.log(`wrote ${cachePath} (${models.length} models)`);

// 2+3. opencode configs
function displayName(m) {
  let name = m.displayName;
  if (m.isDefault) name += " (default)";
  if (m.deprecationDate) name += ` (deprecated ${m.deprecationDate})`;
  else if (m.isLegacyModel) name += " (legacy)";
  return name;
}

const OPENCODE_EXCLUDED_MODELS = new Set([
  // Augment's SDK currently drops Google thought signatures when replaying
  // tool calls, so these fail on the post-tool request in coding agents.
  "gemini-3-1-pro-preview",
  "gemini-3-7-flash",
]);

function toOpencodeModels(models) {
  const out = {};
  for (const m of models) {
    if (OPENCODE_EXCLUDED_MODELS.has(m.id)) continue;
    out[m.id] = {
      name: displayName(m),
      family: m.vendor ? m.vendor.toLowerCase() : "unknown",
      status: "active",
      reasoning: false,
      tool_call: true,
      temperature: false,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: m.contextWindow, output: m.maxTokens },
      cost: { input: 0, output: 0 },
    };
  }
  return out;
}

for (const cfgPath of [
  join(homedir(), ".config", "opencode", "opencode.json"),
  join(homedir(), ".config", "opencode2", "opencode.json"),
]) {
  if (!existsSync(cfgPath)) {
    console.warn(`skip ${cfgPath}: not found`);
    continue;
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  if (!cfg.provider?.augment) {
    console.warn(`skip ${cfgPath}: no provider.augment entry`);
    continue;
  }
  const opencodeModels = toOpencodeModels(models);
  cfg.provider.augment.models = opencodeModels;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log(`updated ${cfgPath} (${Object.keys(opencodeModels).length} models)`);
}

console.log(`default model: ${defaultModelId ?? "(none)"}`);
