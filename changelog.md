# Changelog

## 0.6.2
- Fixed the scoped project folder being forgotten every time Acode/the app restarted, forcing you to re-pick it and re-share the file listing on every launch. The last folder you scoped is now remembered on disk and silently re-matched against Acode's open folders on startup (with a brief "Reconnecting…" status instead of an immediate "no folder scoped" message).
- Fixed raw JSON sometimes leaking straight into the chat as the assistant's message (usually when a response got cut off mid-way through the "content" field and failed to parse). The plugin now tries to salvage just the short "message" text from a broken response instead of dumping the whole JSON block.
- Replaced the amber/brown system-message bubbles (status lines like "Reading files…", "Wrote file…") with a minimal neutral tone that matches the rest of the panel.
- Added subtle motion throughout the panel: chat bubbles, status updates, action/diff blocks, and provider/folder/model picker cards and sheets now animate in instead of popping in instantly; buttons get a light press animation.

## 0.6.1
- Redesigned the Usage & Stats screen: provider/model icons are now minimal single-color glyphs (one per provider) on a flat, neutral squircle tile instead of a bright two-letter gradient monogram — applied consistently everywhere the app shows a provider icon (stats screen, provider picker, model picker).
- "Tap to change" is now its own full-size squircle button ("Change model") with an icon and a trailing arrow, separated from the model info card above it, instead of a small footer pill.
- Totals ("Requests sent" / "Tokens total") now render as compact KPI tiles — small label, one big number, short description — in a two-column grid instead of full sentences in a catalog-style card.

## 0.6.0
- Fixed the model picker showing only the currently-selected model instead of the full list — it now always shows every known model for the preset, with the selected one highlighted, and the search box starts empty instead of pre-filled with the current model (which was silently filtering the list down to one item).
- The model picker now remembers any custom model name you type and use, so it shows up as a normal entry in that preset's list next time — the list grows with real use instead of staying frozen to what shipped with the plugin. The currently-configured model is also always shown, even if it isn't in the preset's built-in list.
- "Set your API key first" now uses the same friendly error style as the "no project folder scoped" message, instead of a plain italic note.
- Fixed the "no project folder scoped" error not reliably reaching the user: previously it was only stuffed into the AI's next prompt for it to paraphrase (or ignore). It's now shown directly, right away, in the same style as other errors, and stops the current turn instead of wasting a round trip asking the AI to continue against a project that doesn't exist yet.
- Added NVIDIA NIM (build.nvidia.com's free-tier, OpenAI-compatible endpoint) as a built-in preset, with a starter list of catalog models (Llama, Nemotron, Mistral, Phi, Gemma, DeepSeek).

## 0.5.0
- Errors are now shown as a short, plain-English line (e.g. "Rate limit or quota reached — wait a moment and try again") instead of a raw dump of the HTTP status and JSON body. The original technical details are still available behind a "Show details" toggle for anyone who wants them.
- Added a full-screen model picker (matching the provider picker's card-list style) for the "Model" field in Settings: shows the known models for whichever preset is selected, and always lets you type a custom model name — needed for local runtimes (Ollama, LM Studio) and any model not yet in the list.
- Every built-in preset now carries a curated list of its common model names.

## 0.4.0
- Replaced the native "Quick preset" dropdown with a full-screen, searchable provider picker: cards with a colored icon tile, a tag (Popular/Fast/Local/etc.), and a short description, instead of a plain OS select list.
- Added 9 more built-in providers: Anthropic, Mistral, xAI (Grok), OpenRouter, Together AI, Fireworks AI, Perplexity, Cerebras, and local Ollama/LM Studio — 15 total, up from 6.
- Picking the Anthropic preset now also switches "API type" to Anthropic automatically, since it uses a different wire format than the others.

## 0.3.1
- Redesigned the Settings dialog: grouped into clear sections (Provider, Connection, Model, Behavior) with card-style layout, a segmented control for API type, a show/hide toggle for the API key, and a proper switch for auto-apply — instead of one long stacked list of labels and inputs.

## 0.3.0
- **Multi-step agent loop**: if the AI responds with only `read_file` actions, they're now resolved automatically and fed back to the AI so it can continue planning in the same turn — up to 6 rounds per message. Previously every `read_file` needed a manual tap, and the AI got no automatic follow-up round.
- **Nested folder creation**: `create_file`/`write_file` now create any missing parent folders along the path (e.g. `src/components/Button.js`), instead of failing past one directory level deep.
- **Diff preview before applying**: write/create actions now show a "View diff" (or "View new file" for brand-new files) toggle with a line-level added/removed preview, instead of only a bare "Apply" button.

## 0.1.0
- Initial release: sidebar AI chat, file read/write/create/delete actions.

## 0.2.0
- Status indicator now streams live info pulled from the API (partial reply text, number of file actions being drafted, elapsed time) instead of a static "Thinking..." label.
- Falls back to a normal non-streaming request if the endpoint doesn't support SSE streaming.
- Status row redesigned: left-aligned with chat bubbles, spinner icon, animated ellipsis.

## 0.2.1
- Fixed a first-load rendering glitch where message text looked "off" (wrong font/spacing) until the first message was sent. The container now gets an explicit font-family and a forced repaint on mount instead of relying on a later interaction to fix it.

## 0.2.2
- Replaced the placeholder plugin ID (com.example.ai-agent, copied from Acode's tutorial) with a unique one tied to the author, to avoid collisions in the store.
- Fixed a dead link in the readme to a SETUP.md file that was never included — setup steps are now inline.
