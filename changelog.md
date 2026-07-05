# Changelog

## 0.1.0
- Initial release: sidebar AI chat, file read/write/create/delete actions.

## 0.2.0
- Status indicator now streams live info pulled from the API (partial reply text, number of file actions being drafted, elapsed time) instead of a static "Thinking..." label.
- Falls back to a normal non-streaming request if the endpoint doesn't support SSE streaming.
- Status row redesigned: left-aligned with chat bubbles, spinner icon, animated ellipsis.

## 0.2.1
- Fixed a first-load rendering glitch where message text looked "off" (wrong font/spacing) until the first message was sent. The container now gets an explicit font-family and a forced repaint on mount instead of relying on a later interaction to fix it.
