# AI Agent for Acode

A sidebar chat panel that connects Acode to a custom AI API (any OpenAI-compatible
`/chat/completions` endpoint, or Anthropic's `/v1/messages`). The AI can read, write,
create, and delete files in your currently open project folder.

## Features

- Chat panel in Acode's sidebar
- Works with OpenAI-compatible APIs or Anthropic's API
- AI responds with a small JSON "actions" list (read/write/create/delete file)
- Safety guards:
  - All paths are resolved relative to your project root; `..` traversal is blocked
  - Deletes always require you to tap "Confirm delete"
  - Writes/creates can be reviewed before applying, or auto-applied if you enable it in settings

## Setup

1. Install the plugin, then tap the ⚙️ icon in the panel header.
2. Pick a provider (OpenAI-compatible or Anthropic) — a preset dropdown fills in the endpoint and a default model for popular providers.
3. Paste your API key. It's stored locally on-device in Acode's plugin data folder, never sent anywhere except directly to the endpoint you configured.
4. Tap the folder icon in the panel header and pick the project folder you want the AI scoped to — it can't read/write files until a folder is selected.
5. Start chatting. Review any proposed file actions before tapping "Apply" (or turn on "Auto-apply" in settings if you want writes/creates applied automatically — deletes always require a manual confirm either way).

## Settings

Tap the ⚙️ icon in the panel header to set:
- Provider (OpenAI-compatible or Anthropic)
- Endpoint URL
- API key
- Model name
- Auto-apply toggle

## Known limitations (good next steps if you extend it)

- `create_file` only creates one directory level deep — no automatic nested folder creation yet.
- Single-turn tool use per message (not a full agentic loop with multi-step retries).
- No diff view yet — writes replace the whole file content the AI sends back.
