# Changelog

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

## 0.2.3
- Fixed invalid plugin ID: Acode only allows letters, numbers, dots, and underscores — the hyphen in "ai-agent" was rejected at publish time. ID is now com.heyitsaadin.ai_agent.

## 0.2.4
- Reduced icon.png from 245 KB to ~8 KB (resized to a square 512x512 canvas, palette-quantized) to meet Acode's 50 KB icon size limit for publishing. No visible change to the icon itself.
