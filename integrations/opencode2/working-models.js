const WORKING_MODELS = new Map([
  ["azure", new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])],
  ["github-copilot", new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])],
  [
    "augment",
    new Set([
      "kimi-k2p6",
      "gpt-5-2",
      "gpt-5-1",
      "gpt-5",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "gpt-5-4-mini",
      "gpt-5-4",
      "kimi-k2p7",
      "grok-4-5",
      "claude-haiku-4-5",
      "claude-sonnet-4-6-500k",
      "claude-sonnet-4-6",
      "claude-sonnet-5-0-500k",
      "claude-opus-4-6-500k",
      "claude-opus-4-6",
      "claude-opus-4-7-500k",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "gpt-5-5",
      "glm-5-2",
      "kimi-k3",
      "grok-4-6",
      "claude-sonnet-5-0",
      "gpt-5-6-luna",
      "gpt-5-6-terra",
      "gpt-5-6-sol",
    ]),
  ],
])

export default {
  id: "working-models.filter",
  setup: async (ctx) => {
    await ctx.catalog.transform((draft) => {
      for (const { provider, models } of draft.provider.list()) {
        const allowed = WORKING_MODELS.get(provider.id)
        for (const [modelID] of models) {
          draft.model.update(provider.id, modelID, (model) => {
            model.enabled = allowed?.has(modelID) ?? false
          })
        }
      }
      draft.model.default.set("azure", "gpt-5.6-luna")
    })
  },
}
