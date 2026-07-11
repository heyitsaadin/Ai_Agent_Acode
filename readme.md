# AI Agent for Acode

A sidebar chat panel that connects Acode to a custom AI API (any OpenAI-compatible
`/chat/completions` endpoint, or Anthropic's `/v1/messages`). The AI can read, write,
create, and delete files in your currently open project folder.

## Features

- Chat panel in Acode's sidebar
- Works with OpenAI-compatible APIs or Anthropic's API
- AI responds with a small JSON "actions" list (read/write/create/delete file)
- Multi-step agent loop: the AI can request `read_file` first, get the contents back automatically, and continue planning in the same turn — no need to paste file contents yourself
- Nested folder support: `create_file`/`write_file` on a path like `src/components/Button.js` creates any missing folders automatically
- Diff preview: writes to an existing file show a "View diff" toggle (added/removed lines) before you tap Apply; brand-new files show a "View new file" preview
- Provider picker: tapping "Quick preset" opens a searchable, card-based list of 16 built-in providers (icon, tag, short description) instead of a plain dropdown — OpenAI, Anthropic, Groq, DeepSeek, Google Gemini, MiniMax, Mistral, xAI (Grok), OpenRouter, Together AI, Fireworks AI, Perplexity, Cerebras, NVIDIA NIM, and local Ollama/LM Studio
- Safety guards:
  - All paths are resolved relative to your project root; `..` traversal is blocked
  - Deletes always require you to tap "Confirm delete"
  - Writes/creates can be reviewed (with a diff) before applying, or auto-applied if you enable it in settings

## Setup

1. Install the plugin, then tap the ⚙️ icon in the panel header.
2. Tap "Quick preset" to pick a provider from the searchable list — it fills in the endpoint, model, and API type automatically — or leave it on "Custom / other" and fill those in yourself.
3. Paste your API key. It's stored locally on-device in Acode's plugin data folder, never sent anywhere except directly to the endpoint you configured.
4. Tap the folder icon in the panel header and pick the project folder you want the AI scoped to — it can't read/write files until a folder is selected.
5. Start chatting. Review any proposed file actions before tapping "Apply" (or turn on "Auto-apply" in settings if you want writes/creates applied automatically — deletes always require a manual confirm either way). Use "View diff" to see exactly what will change first.

## Settings

Tap the ⚙️ icon in the panel header to set:
- Provider (OpenAI-compatible or Anthropic)
- Endpoint URL
- API key
- Model name
- Auto-apply toggle

## Known limitations (good next steps if you extend it)

- The agent loop caps automatic read→respond rounds at 6 per message, to keep a confused model from looping forever.
- The diff preview is a plain line-based LCS diff (added/removed lines), not a token-level or syntax-aware diff.

## AI Usage Policy

- **Your API key, your account.** This plugin doesn't ship a bundled AI service — you connect it to your own account with whichever provider you choose (OpenAI, Anthropic, Groq, DeepSeek, Google Gemini, MiniMax, Mistral, xAI, OpenRouter, Together AI, Fireworks AI, Perplexity, Cerebras, NVIDIA NIM, or a local Ollama/LM Studio server). Usage, billing, and rate limits are governed by that provider's own terms — not by this plugin.
- **Where your data goes.** Chat messages, file contents the AI requests via `read_file`, and the project file listing are sent only to the endpoint URL configured in Settings — directly from your device to that provider. Nothing passes through any server operated by this plugin's author.
- **Where your data is stored.** Your API key, endpoint, model, and settings are stored locally on-device in Acode's plugin data folder. They are never transmitted anywhere except the endpoint you configured, and are never collected, logged, or seen by the plugin author.
- **File changes are reviewable, not automatic.** By default, every write/create is shown as a diff for you to review before applying, and deletes always require a manual "Confirm delete" tap — regardless of provider. "Auto-apply" (writes/creates applied without review) is opt-in and off by default; even with it on, deletes still require confirmation.
- **The AI can be wrong.** Like any LLM-backed tool, responses can contain mistakes, incomplete edits, or misunderstand your intent. Review diffs before applying, especially for files you haven't backed up elsewhere (e.g. via git).
- **Your responsibility.** You are responsible for complying with your chosen AI provider's acceptable-use policies (e.g. not submitting secrets, proprietary code you're not permitted to share, or content that violates their terms) — this plugin is a conduit to that provider's API, not a moderation layer on top of it.
