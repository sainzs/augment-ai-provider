# augment-ai-provider

AI SDK provider for [Augment Code](https://augmentcode.com), wrapping
`@augmentcode/auggie-sdk`'s `AugmentLanguageModel` (direct HTTP chat API — no
local `auggie` subprocess). Works with pi, OpenCode, OpenCode 2, and any AI
SDK v3-compatible host.

## Prerequisites

- Node ≥ 18
- `npm i -g @augmentcode/auggie && auggie login`

## Install

```bash
npm install augment-ai-provider
```

## Usage

### AI SDK (direct)

```js
import { createAugment } from "augment-ai-provider";
import { generateText } from "ai";

const augment = createAugment();
const { text } = await generateText({
  model: augment.languageModel("claude-sonnet-4-5"),
  prompt: "Hello",
});
```

### pi

Copy `integrations/pi/augment-provider.ts` into `~/.pi/agent/extensions/`.
Edit the import path to point at your installed copy of this package, then
add the model IDs you want to `enabledModels` in `~/.pi/agent/settings.json`.

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "enabled_providers": ["augment"],
  "provider": {
    "augment": {
      "name": "Augment Code",
      "npm": "file:///path/to/augment-ai-provider/index.js",
      "env": ["AUGMENT_API_TOKEN"]
    }
  }
}
```

Set `AUGMENT_API_TOKEN` and `AUGMENT_API_URL` in your environment (derived
from `~/.augment/session.json` after `auggie login`).

### OpenCode 2

Same provider block as OpenCode, plus a catalog plugin that filters to
working models. See `integrations/opencode2/`.

## Auth resolution (first hit wins)

1. Explicit `{ apiKey, apiUrl }` in code or harness options
2. `AUGMENT_SESSION_AUTH` env — session JSON from `auggie token print`
3. `AUGMENT_API_TOKEN` + `AUGMENT_API_URL` env
4. `~/.augment/session.json` (from `auggie login`)

## Model catalog

Run `npx augment-ai-provider sync` (or `node bin/sync-models.mjs`) to fetch
the current tenant catalog and write `models-cache.json`. Re-run whenever
Augment adds or retires models.

## Testing

```bash
node test/live-test.mjs   # live: listModels, generateText, streamText, tool call
```

## Known limitations

- Gemini models through Augment fail coding-agent tool loops: the SDK drops
  Google's required `thought_signature` when replaying tool calls.
- Text-only input; images are dropped.
- No streaming tool-call repair (spec-v2).

## License

MIT
