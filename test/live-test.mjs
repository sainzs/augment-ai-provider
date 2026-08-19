// Live smoke test: credentials, listModels, generateText, streamText, tool call.
// Run: node test/live-test.mjs
import { generateText, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createAugment, resolveAugmentCredentialsSync } from "../index.js";

const creds = resolveAugmentCredentialsSync();
console.log("[1] credentials resolved:", creds.apiUrl);

const augment = createAugment();
const { models, defaultModelId } = await augment.listModels();
console.log("[2] listModels:", models.map((m) => m.id).join(", "));
console.log("    default:", defaultModelId);

const modelId = models.find((m) => m.id.includes("haiku"))?.id ?? models[0].id;
console.log("    using model:", modelId);
const model = augment.languageModel(modelId);

// generateText
const { text } = await generateText({
  model,
  prompt: "Reply with exactly: PROVIDER_OK",
});
console.log("[3] generateText:", JSON.stringify(text.trim().slice(0, 80)));
if (!text.includes("PROVIDER_OK")) throw new Error("generateText mismatch");

// streamText
const { textStream } = streamText({
  model,
  prompt: "Count from 1 to 5, digits separated by spaces, nothing else.",
});
let streamed = "";
for await (const chunk of textStream) streamed += chunk;
console.log("[4] streamText:", JSON.stringify(streamed.trim().slice(0, 80)));
if (streamed.length === 0) throw new Error("empty stream");

// tool calling
let toolRan = false;
const result = await generateText({
  model,
  tools: {
    add_numbers: tool({
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => {
        toolRan = true;
        return { sum: a + b };
      },
    }),
  },
  stopWhen: stepCountIs(3),
  prompt: "Use the add_numbers tool to compute 17 + 25, then state the sum.",
});
console.log("[5] tool call ran:", toolRan, "| final:", JSON.stringify(result.text.trim().slice(0, 100)));
if (!toolRan) throw new Error("tool was not called");
if (!result.text.includes("42")) throw new Error("tool result not used");

console.log("ALL LIVE TESTS PASSED");
