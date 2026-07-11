/**
 * AI Agent plugin for Acode
 * -------------------------
 * Adds a sidebar chat panel that talks to a custom AI endpoint (any
 * OpenAI-compatible /chat/completions API, or Anthropic's /v1/messages).
 * The AI can respond with a JSON "actions" block describing file
 * operations (read / write / create / delete), which this plugin then
 * executes against the currently open project folder using Acode's fs API.
 *
 * Safety notes:
 * - All paths are resolved relative to the root of the first open folder.
 * - ".." path traversal is rejected.
 * - Deletes always require an explicit tap to confirm.
 * - "Auto-apply" (write/create without asking) is OFF by default.
 */

const PLUGIN_ID = "com.heyitsaadin.ai_agent";
const CONFIG_DIR_NAME = "ai-agent-plugin";
const CONFIG_FILE_NAME = "config.json";

let $style;
let containerEl;
let chatLogEl;
let inputEl;
let statusEl;
let statusTextEl;

let config = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o-mini",
  provider: "openai", // "openai" | "anthropic"
  autoApply: false,
  // Model names the person has actually typed/used per preset (keyed by
  // preset key, or "_custom" when no preset matches), remembered so the
  // model picker keeps growing with real usage instead of being frozen to
  // whatever list shipped with the plugin.
  customModels: {},
  // Last folder the user explicitly scoped the AI to, remembered so it
  // survives Acode/webview restarts instead of silently unscoping and
  // forcing the user to re-pick it every time the app is reopened. Only
  // ever used to *try* to re-match against Acode's live addedFolder list on
  // next launch — never trusted blindly (see restoreLastFolder()).
  lastFolder: null, // { url, title } | null
  // Local tally of API usage, built purely from token counts the APIs
  // themselves report back — never estimated, never fetched from a billing
  // endpoint (most providers don't expose one the same way, so this plugin
  // doesn't attempt to show account balance/quota, only what's actually
  // been sent through it this device).
  usage: {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byModel: {}, // key: "provider::model" -> { provider, model, requests, inputTokens, outputTokens, lastUsed }
  },
};

let history = []; // { role: "user"|"assistant", content: string }
let selectedFolderUrl = null; // url of the addedFolder entry the AI is scoped to

// How many automatic "read files, then respond again" rounds are allowed per
// user message before we give up and show whatever the AI last said. Keeps
// a confused model from looping forever on read_file requests.
const MAX_AGENT_STEPS = 6;

const ICON_SETTINGS = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const ICON_FOLDER_ADD = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
// Plain folder glyph (no "+"), used for existing-folder rows in the folder picker.
const ICON_FOLDER_PLAIN = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`;
const ICON_STATS = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
const ICON_SWAP = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 21l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
const ICON_ARROW_RIGHT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`;
const ICON_PLUG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M12 17v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/></svg>`;

// ---------- Minimal single-color line icons per provider ----------
// Simplified original glyphs (not reproductions of any company's logo
// artwork) — one small recognizable shape per provider so the picker and
// stats screen show something more distinctive than a two-letter monogram,
// while staying in the same flat, monochrome icon language as the rest of
// the UI (see ICON_STATS, ICON_SETTINGS, etc. above).
const PROVIDER_ICONS = {
  custom: ICON_PLUG,
  openai: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2.5l3.2 1.85v3.7L12 10 8.8 8.05v-3.7z"/><path d="M12 14l3.2 1.85v3.7L12 21.5l-3.2-1.95v-3.7z"/><path d="M4.5 8.25l3.2 1.85v3.8L4.5 15.75 1.3 13.9v-3.8z" transform="translate(2.2 -2.4)"/><path d="M15.8 8.25l3.2 1.85v3.8l-3.2 1.85-3.2-1.85v-3.8z" transform="translate(2.2 -2.4)"/></svg>`,
  anthropic: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5h2.4L16.5 19h-2.5l-1.15-3.15h-5.7L6 19H3.5z"/><path d="M8.05 13.4h4.9L10.5 7.3z" fill="currentColor" stroke="none"/></svg>`,
  groq: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>`,
  deepseek: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 3v18M4 7.5l8 4.5 8-4.5"/></svg>`,
  gemini: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none"><path d="M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10z"/></svg>`,
  minimax: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/></svg>`,
  mistral: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="16" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="13" y2="17"/></svg>`,
  xai: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M5 5l14 14"/><path d="M19 5L5 19"/></svg>`,
  openrouter: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M5 8v2a4 4 0 0 0 4 4h1M19 8v2a4 4 0 0 0-4 4h-1"/></svg>`,
  together: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/></svg>`,
  fireworks: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v6M12 16v6M4.2 4.2l4.2 4.2M15.6 15.6l4.2 4.2M2 12h6M16 12h6M4.2 19.8l4.2-4.2M15.6 8.4l4.2-4.2"/></svg>`,
  perplexity: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>`,
  cerebras: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>`,
  ollama: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0z"/><line x1="9" y1="11" x2="9" y2="12"/><line x1="15" y1="11" x2="15" y2="12"/><path d="M9 18v2M15 18v2"/></svg>`,
  lmstudio: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10l3 2-3 2M12 14h5"/></svg>`,
  nvidia: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c3-5 15-5 18 0-3 5-15 5-18 0z"/><circle cx="12" cy="12" r="2.2"/></svg>`,
};
function getProviderIcon(key) {
  return PROVIDER_ICONS[key] || ICON_PLUG;
}

// Quick-fill presets for popular AI providers. Most speak the exact same
// OpenAI-compatible /chat/completions wire format, so they all go through
// the existing "openai" provider path — no new request/response parsing
// needed, just a different base URL + model name. A couple (Anthropic) use
// their own native API shape, so those presets also set `provider`.
//
// `mono` + `colors` drive the little logo-style tile shown in the provider
// picker — a two-letter monogram on a gradient, not a reproduction of any
// company's actual logo artwork.
const OPENAI_COMPATIBLE_PRESETS = {
  custom: {
    label: "Custom / other",
    endpoint: "",
    model: "",
    provider: "openai",
    tag: "Manual",
    tagline: "Paste your own OpenAI-compatible endpoint and model name.",
    mono: "?",
    colors: ["#5b5f66", "#3a3d42"],
    models: [],
  },
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    provider: "openai",
    tag: "Popular",
    tagline: "GPT-4o, GPT-4o mini, and the o-series reasoning models.",
    mono: "AI",
    colors: ["#10a37f", "#0b7a5f"],
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o3-mini", "o4-mini"],
  },
  anthropic: {
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    tag: "Popular",
    tagline: "Claude models via Anthropic's native Messages API.",
    mono: "C",
    colors: ["#d97757", "#b35a3d"],
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  },
  groq: {
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    provider: "openai",
    tag: "Fast",
    tagline: "Ultra-low-latency inference for open models like Llama.",
    mono: "Gq",
    colors: ["#f55036", "#c93a24"],
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    provider: "openai",
    tag: "Reasoning",
    tagline: "Strong reasoning and coding models at low cost.",
    mono: "DS",
    colors: ["#4d6bfe", "#3550c9"],
    models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  },
  gemini: {
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    provider: "openai",
    tag: "Multimodal",
    tagline: "Google's Gemini models via the OpenAI-compatible endpoint.",
    mono: "Ge",
    colors: ["#4285f4", "#a142f4"],
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
  },
  minimax: {
    label: "MiniMax",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    model: "MiniMax-M3",
    provider: "openai",
    tag: "New",
    tagline: "MiniMax's general-purpose chat models.",
    mono: "Mx",
    colors: ["#ff3355", "#cc1f42"],
    models: ["MiniMax-M3", "MiniMax-Text-01"],
  },
  mistral: {
    label: "Mistral",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-large-latest",
    provider: "openai",
    tag: "Open weights",
    tagline: "Mistral's hosted API for its own open-weight model family.",
    mono: "Ms",
    colors: ["#fa5b30", "#e14f24"],
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest", "pixtral-large-latest"],
  },
  xai: {
    label: "xAI (Grok)",
    endpoint: "https://api.x.ai/v1/chat/completions",
    model: "grok-4",
    provider: "openai",
    tag: "Reasoning",
    tagline: "Grok models from xAI.",
    mono: "Gr",
    colors: ["#2b2b2b", "#000000"],
    models: ["grok-4", "grok-4-fast", "grok-3", "grok-3-mini"],
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openrouter/auto",
    provider: "openai",
    tag: "Multi-model",
    tagline: "One endpoint that routes to dozens of hosted models.",
    mono: "Or",
    colors: ["#6467f2", "#4548c9"],
    models: ["openrouter/auto", "anthropic/claude-sonnet-4.5", "openai/gpt-4o-mini", "meta-llama/llama-3.3-70b-instruct", "google/gemini-2.5-flash"],
  },
  together: {
    label: "Together AI",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    provider: "openai",
    tag: "Open weights",
    tagline: "Hosted inference for open-source models.",
    mono: "Tg",
    colors: ["#0f6fff", "#0c53c2"],
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
  },
  fireworks: {
    label: "Fireworks AI",
    endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
    model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    provider: "openai",
    tag: "Fast",
    tagline: "Fast, cheap hosted inference for open models.",
    mono: "Fw",
    colors: ["#ff5e3a", "#d9431f"],
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/qwen2p5-72b-instruct",
      "accounts/fireworks/models/deepseek-v3",
    ],
  },
  perplexity: {
    label: "Perplexity",
    endpoint: "https://api.perplexity.ai/chat/completions",
    model: "sonar-pro",
    provider: "openai",
    tag: "Web search",
    tagline: "Sonar models with built-in web search grounding.",
    mono: "Px",
    colors: ["#20808d", "#155d68"],
    models: ["sonar-pro", "sonar", "sonar-reasoning-pro", "sonar-reasoning"],
  },
  cerebras: {
    label: "Cerebras",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    model: "llama-3.3-70b",
    provider: "openai",
    tag: "Fast",
    tagline: "Wafer-scale hardware built for very fast inference.",
    mono: "Cb",
    colors: ["#f6a21e", "#c97e0f"],
    models: ["llama-3.3-70b", "llama3.1-8b", "qwen-3-32b"],
  },
  ollama: {
    label: "Ollama (local)",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.2",
    provider: "openai",
    tag: "Local",
    tagline: "Models running locally on your own device or network.",
    mono: "Ol",
    colors: ["#2b2b2b", "#111111"],
    models: [],
  },
  lmstudio: {
    label: "LM Studio (local)",
    endpoint: "http://localhost:1234/v1/chat/completions",
    model: "local-model",
    provider: "openai",
    tag: "Local",
    tagline: "Models served locally from LM Studio's built-in server.",
    mono: "Lm",
    colors: ["#6f42c1", "#5732a0"],
    models: [],
  },
  nvidia: {
    label: "NVIDIA NIM",
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "meta/llama-3.1-70b-instruct",
    provider: "openai",
    tag: "Free tier",
    tagline: "Free NIM microservices from build.nvidia.com — Llama, Nemotron, Mistral, and more.",
    mono: "Nv",
    colors: ["#76b900", "#588f00"],
    models: [
      "meta/llama-3.1-405b-instruct",
      "meta/llama-3.1-70b-instruct",
      "meta/llama-3.1-8b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "mistralai/mixtral-8x22b-instruct-v0.1",
      "mistralai/mistral-large-2-instruct",
      "microsoft/phi-3-medium-4k-instruct",
      "google/gemma-2-27b-it",
      "deepseek-ai/deepseek-r1",
    ],
  },
};

// ---------- Descriptive metadata for the provider + model pickers ----------
// Purely cosmetic — never sent to the AI or used for any functional
// decision. Known specs (context window, general positioning) for the most
// commonly-used models per preset, so the picker cards can show more than a
// bare model id. Anything not listed here falls back to a clearly-labeled
// best-guess derived from the model name (see heuristicModelInfo below), so
// new/unlisted model names still get a reasonable card instead of a blank one.
const MODEL_META = {
  openai: {
    "gpt-4o-mini": { tag: "Fast & light", context: "128K context", desc: "Small, cheap, and quick — a solid default for everyday chat and coding help." },
    "gpt-4o": { tag: "Flagship", context: "128K context", desc: "Multimodal flagship — strong all-round reasoning, vision, and writing." },
    "gpt-4.1": { tag: "Flagship", context: "1M context", desc: "Large-context GPT-4 generation model, tuned for long documents and codebases." },
    "gpt-4.1-mini": { tag: "Fast & light", context: "1M context", desc: "Smaller GPT-4.1 variant — most of the long-context ability at lower cost." },
    "gpt-4.1-nano": { tag: "Fastest", context: "1M context", desc: "The smallest, cheapest, lowest-latency model in this family." },
    o3: { tag: "Reasoning", desc: "Extended step-by-step reasoning model for hard math, logic, and planning." },
    "o3-mini": { tag: "Reasoning", desc: "Smaller, faster reasoning model — cheaper than o3 for everyday use." },
    "o4-mini": { tag: "Reasoning", desc: "Small reasoning model balancing speed with multi-step reasoning quality." },
  },
  anthropic: {
    "claude-sonnet-4-5": { tag: "Flagship", context: "200K context", desc: "Balanced flagship — strong coding and agentic tool-use performance." },
    "claude-opus-4-1": { tag: "Most capable", context: "200K context", desc: "Highest-capability model for the hardest, most open-ended tasks." },
    "claude-haiku-4-5": { tag: "Fast & light", context: "200K context", desc: "Fastest current model — low latency for quick, high-volume tasks." },
    "claude-3-7-sonnet-latest": { tag: "Previous gen", context: "200K context", desc: "Prior-generation Sonnet model, still fully supported." },
    "claude-3-5-haiku-latest": { tag: "Previous gen · Fast", context: "200K context", desc: "Prior-generation fast model, cheaper than current Haiku." },
  },
  gemini: {
    "gemini-2.5-flash": { tag: "Fast & light", context: "1M context", desc: "Fast, low-cost model with a very large context window." },
    "gemini-2.5-pro": { tag: "Flagship", context: "1M context", desc: "Most capable Gemini model — strong reasoning and long-document handling." },
    "gemini-2.5-flash-lite": { tag: "Fastest", desc: "Smallest, cheapest 2.5 model, for simple high-volume tasks." },
    "gemini-2.0-flash": { tag: "Previous gen", desc: "Prior-generation fast Gemini model." },
  },
  xai: {
    "grok-4": { tag: "Flagship", desc: "xAI's most capable current model." },
    "grok-4-fast": { tag: "Fast & light", desc: "Faster, cheaper Grok 4 variant." },
    "grok-3": { tag: "Previous gen", desc: "Prior-generation xAI flagship." },
    "grok-3-mini": { tag: "Fast & light", desc: "Smaller, cheaper Grok 3 variant." },
  },
  deepseek: {
    "deepseek-v4-flash": { tag: "Fast & light", desc: "Fast general-purpose chat model." },
    "deepseek-chat": { tag: "General purpose", desc: "General-purpose conversational model." },
    "deepseek-reasoner": { tag: "Reasoning", desc: "Extended reasoning model, tuned for math and logic." },
  },
  mistral: {
    "mistral-large-latest": { tag: "Flagship", desc: "Mistral's most capable hosted model." },
    "mistral-small-latest": { tag: "Fast & light", desc: "Smaller, cheaper model for everyday tasks." },
    "codestral-latest": { tag: "Coding", desc: "Tuned specifically for code generation." },
    "pixtral-large-latest": { tag: "Multimodal", desc: "Vision-capable large model." },
  },
  groq: {
    "llama-3.3-70b-versatile": { tag: "General purpose", desc: "Llama 3.3 70B served at very low latency on Groq hardware." },
    "llama-3.1-8b-instant": { tag: "Fastest", desc: "Small Llama model optimized for near-instant responses." },
    "mixtral-8x7b-32768": { tag: "General purpose", context: "32K context", desc: "Mixture-of-experts model with a 32K context window." },
    "gemma2-9b-it": { tag: "Fast & light", desc: "Small open Gemma 2 model." },
  },
};

// Best-effort guess for any model name not covered by MODEL_META above —
// e.g. brand-new releases, or presets with no fixed list (local runtimes,
// custom endpoints). Deliberately hedged ("Likely…") since it's guessed from
// the name alone, not a verified spec.
function heuristicModelInfo(id) {
  const s = String(id || "").toLowerCase();
  if (/reason|think|(^|[^0-9])o[34]([^0-9]|$)|-r1(\b|$)/.test(s)) {
    return { tag: "Reasoning", desc: "Name suggests this is tuned for extended, multi-step reasoning." };
  }
  if (/mini|nano|lite|instant|flash(?!-lite)|small|haiku|8b|9b/.test(s)) {
    return { tag: "Fast & light", desc: "Name suggests a smaller, faster, lower-cost model." };
  }
  if (/vision|pixtral|multimodal/.test(s)) {
    return { tag: "Multimodal", desc: "Name suggests support for image input alongside text." };
  }
  if (/large|opus|70b|405b|-pro(\b|$)/.test(s)) {
    return { tag: "Flagship", desc: "Name suggests this provider's larger, more capable model." };
  }
  return { tag: "General purpose", desc: "General-purpose chat model." };
}

function getModelInfo(presetKey, id) {
  const known = MODEL_META[presetKey] && MODEL_META[presetKey][id];
  if (known) return { ...known, known: true };
  return { ...heuristicModelInfo(id), known: false };
}

// Short, human label for how a preset actually talks to its API — shown in
// the provider picker's meta row so the choice isn't just a bare name.
function presetProtocolLabel(preset) {
  if (!preset) return "Custom setup";
  if (preset.provider === "anthropic") return "Anthropic Messages API";
  if (!preset.endpoint) return "Manual setup";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(preset.endpoint)) return "Local, OpenAI-compatible";
  return "OpenAI-compatible API";
}

function presetLocalityBadge(preset) {
  if (!preset || !preset.endpoint) return "Manual";
  return /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(preset.endpoint) ? "Local" : "Cloud";
}

// Shared card builder for the provider picker, model picker, and folder
// picker — one consistent "course catalog" layout: icon, title, badge row,
// description, and a meta/footer row for extra at-a-glance info.
function buildInfoCard({ iconText, iconSvg, iconColors, title, badges = [], desc, metaItems = [], footerBadge, selected, onClick }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "ai-agent-provider-card" + (selected ? " selected" : "");

  const icon = document.createElement("span");
  icon.className = "ai-agent-provider-icon";
  // Flat, muted tile: a neutral background (set in CSS) plus a single
  // desaturated accent color for the glyph itself — no bright per-provider
  // gradients. iconColors[0] still selects the accent hue so providers stay
  // distinguishable at a glance, but ai-agent-provider-icon's CSS filter
  // (see stylesheet) knocks the saturation/brightness down uniformly.
  if (iconColors && iconColors[0]) icon.style.color = iconColors[0];
  if (iconSvg) icon.innerHTML = iconSvg;
  else icon.textContent = iconText || "";
  card.appendChild(icon);

  const body = document.createElement("span");
  body.className = "ai-agent-provider-card-body";

  const top = document.createElement("span");
  top.className = "ai-agent-provider-card-top";
  const titleEl = document.createElement("span");
  titleEl.className = "ai-agent-provider-card-title";
  titleEl.textContent = title;
  top.appendChild(titleEl);
  body.appendChild(top);

  if (badges.length) {
    const badgeRow = document.createElement("span");
    badgeRow.className = "ai-agent-card-badge-row";
    badges.forEach((b) => {
      const el = document.createElement("span");
      el.className = "ai-agent-provider-tag" + (b.selected ? " ai-agent-provider-tag-selected" : "");
      el.textContent = b.text;
      badgeRow.appendChild(el);
    });
    body.appendChild(badgeRow);
  }

  if (desc) {
    const descEl = document.createElement("span");
    descEl.className = "ai-agent-provider-card-desc";
    descEl.textContent = desc;
    body.appendChild(descEl);
  }

  if (metaItems.length || footerBadge) {
    const footer = document.createElement("span");
    footer.className = "ai-agent-card-footer";
    if (metaItems.length) {
      const metaSpan = document.createElement("span");
      metaSpan.className = "ai-agent-card-meta";
      metaSpan.textContent = metaItems.join("  ·  ");
      footer.appendChild(metaSpan);
    }
    if (footerBadge) {
      const fb = document.createElement("span");
      fb.className = "ai-agent-card-footer-badge";
      fb.textContent = footerBadge;
      footer.appendChild(fb);
    }
    body.appendChild(footer);
  }

  card.appendChild(body);
  card.onclick = onClick;
  return card;
}

// Compact KPI-style tile — label on top, one big number, short description
// below. Used for the "All-time usage" totals on the stats screen, styled
// after simple analytics-dashboard stat cards rather than the card-catalog
// look of buildInfoCard.
function buildStatTile({ label, value, desc }) {
  const tile = document.createElement("div");
  tile.className = "ai-agent-stat-tile";
  const labelEl = document.createElement("span");
  labelEl.className = "ai-agent-stat-tile-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "ai-agent-stat-tile-value";
  valueEl.textContent = value;
  tile.appendChild(labelEl);
  tile.appendChild(valueEl);
  if (desc) {
    const descEl = document.createElement("span");
    descEl.className = "ai-agent-stat-tile-desc";
    descEl.textContent = desc;
    tile.appendChild(descEl);
  }
  return tile;
}

// ---------- Storage ----------

async function configFsDir() {
  const fs = acode.require("fs");
  const dirUrl = `${DATA_STORAGE}${CONFIG_DIR_NAME}`;
  const dir = await fs(dirUrl);
  if (!(await dir.exists())) {
    const parent = await fs(DATA_STORAGE);
    await parent.createDirectory(CONFIG_DIR_NAME);
  }
  return dirUrl;
}

async function loadConfig() {
  try {
    const fs = acode.require("fs");
    const dirUrl = await configFsDir();
    const fileUrl = `${dirUrl}/${CONFIG_FILE_NAME}`;
    const file = await fs(fileUrl);
    if (await file.exists()) {
      const text = await file.readFile("utf8");
      config = { ...config, ...JSON.parse(text) };
    }
  } catch (e) {
    console.warn("AI Agent: could not load config", e);
  }
}

async function saveConfig() {
  try {
    const fs = acode.require("fs");
    const dirUrl = await configFsDir();
    const fileUrl = `${dirUrl}/${CONFIG_FILE_NAME}`;
    const file = await fs(fileUrl);
    if (await file.exists()) {
      await file.writeFile(JSON.stringify(config, null, 2));
    } else {
      const dir = await fs(dirUrl);
      await dir.createFile(CONFIG_FILE_NAME, JSON.stringify(config, null, 2));
    }
  } catch (e) {
    window.toast ? window.toast("Failed to save AI Agent settings") : console.error(e);
  }
}

// Tallies real token usage reported back by whichever API just responded.
// Never invents numbers — only called with counts the provider itself sent.
function recordUsage(inputTokens, outputTokens) {
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  if (!inTok && !outTok) return;

  if (!config.usage) {
    config.usage = { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, byModel: {} };
  }
  config.usage.totalRequests = (config.usage.totalRequests || 0) + 1;
  config.usage.totalInputTokens = (config.usage.totalInputTokens || 0) + inTok;
  config.usage.totalOutputTokens = (config.usage.totalOutputTokens || 0) + outTok;

  const provider = config.provider || "openai";
  const model = config.model || "unknown";
  const key = `${provider}::${model}`;
  if (!config.usage.byModel) config.usage.byModel = {};
  if (!config.usage.byModel[key]) {
    config.usage.byModel[key] = { provider, model, requests: 0, inputTokens: 0, outputTokens: 0 };
  }
  const entry = config.usage.byModel[key];
  entry.requests += 1;
  entry.inputTokens += inTok;
  entry.outputTokens += outTok;
  entry.lastUsed = Date.now();

  saveConfig();
}

// Best-effort match of the current endpoint+provider back to a known quick
// preset, so the stats screen (and settings dialog) can show a friendly
// name/icon instead of a bare endpoint URL. Matches on endpoint+provider
// only (not model) so switching just the model doesn't lose the match.
function inferPresetKey() {
  return (
    Object.entries(OPENAI_COMPATIBLE_PRESETS).find(
      ([key, p]) => key !== "custom" && p.endpoint && p.endpoint === config.endpoint && p.provider === (config.provider || "openai")
    )?.[0] || null
  );
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

// ---------- Project root / path safety ----------

function getRootFolder() {
  // IMPORTANT: do not fall back to addedFolder[0]. addedFolder is Acode's
  // app-wide list of every folder open in the editor, not something owned by
  // this plugin. Silently using "whichever one happened to be first" is how
  // file writes end up in the wrong project. Only ever use a folder the user
  // explicitly picked via the folder picker in this session.
  //
  // We key off URL rather than id: folders opened outside this plugin (e.g.
  // Acode's own file browser) may not carry an id at all, so id-based lookup
  // can silently return null even when the folder is genuinely available.
  if (!selectedFolderUrl) return null;
  if (!window.addedFolder || addedFolder.length === 0) return null;
  return findFolderEntry(selectedFolderUrl);
}

function normalizeUrl(u) {
  return decodeURIComponent(String(u || "")).replace(/\/+$/, "");
}

// Finds a folder in addedFolder by URL. Deliberately URL-based, not
// id-based: some Acode builds don't preserve a caller-supplied id, and
// folders opened outside this plugin may have no id at all.
function findFolderEntry(url) {
  if (!window.addedFolder || !url) return null;
  const target = normalizeUrl(url);
  return addedFolder.find((f) => normalizeUrl(f.url) === target) || null;
}

// Remembers the current scope choice to disk so it survives an app/webview
// restart. Called every time selectedFolderUrl is set from a real user
// action (folder picker, "+ Add Project").
function rememberScopedFolder(url, title) {
  config.lastFolder = url ? { url, title: title || url } : null;
  saveConfig();
}

// On a fresh plugin init, selectedFolderUrl always starts out null — it's
// an in-memory variable, not something Acode preserves across app restarts.
// This tries to silently re-scope to whatever the user last picked, purely
// by matching config.lastFolder.url against Acode's live addedFolder list.
// addedFolder can take a beat to populate after Acode itself restarts a
// session, so this polls briefly rather than giving up after one check.
// Never invents a folder — if the remembered one genuinely isn't open
// anymore, it just leaves selectedFolderUrl null like before.
async function restoreLastFolder() {
  const last = config.lastFolder;
  if (!last || !last.url) return false;

  for (let i = 0; i < 8; i++) {
    const match = findFolderEntry(last.url);
    if (match) {
      selectedFolderUrl = match.url;
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Recursively lists files/folders under the currently scoped root, relative
// to that root. Capped so a huge project doesn't blow up the prompt.
async function listProjectFiles(maxEntries = 300) {
  const root = getRootFolder();
  if (!root) return null;
  const fs = acode.require("fs");
  const rootUrl = root.url.endsWith("/") ? root.url.slice(0, -1) : root.url;
  const results = [];
  const SKIP = new Set(["node_modules", ".git", ".vscode"]);

  async function walk(url, relPrefix, depth) {
    if (results.length >= maxEntries || depth > 6) return;
    const dir = await fs(url);
    const entries = await dir.lsDir();
    for (const entry of entries) {
      if (results.length >= maxEntries) return;
      if (SKIP.has(entry.name)) continue;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        results.push(`${relPath}/`);
        await walk(entry.url, relPath, depth + 1);
      } else {
        results.push(relPath);
      }
    }
  }

  await walk(rootUrl, "", 0);
  return results;
}

// Called right after the user scopes a folder. Pushes the file listing into
// the conversation history as context so the AI knows what exists without
// the user having to type file names, and without a separate tool round-trip.
async function announceProjectFiles() {
  try {
    const files = await listProjectFiles();
    if (!files || files.length === 0) return;
    const listing = files.join("\n");
    history.push({
      role: "user",
      content: `[Project file listing — for context only, not a request]\n${listing}`,
    });
    history.push({
      role: "assistant",
      content: JSON.stringify({
        message: "Got it, I can see these files in the project.",
        actions: [],
      }),
    });
    appendMessage("system", `Shared ${files.length} file path(s) with the AI.`);
  } catch (e) {
    console.warn("AI Agent: failed to list project files", e);
    appendMessage("system", "Connected, but couldn't list files automatically — you can still name files directly.");
  }
}

async function addNewProject() {
  try {
    const fileBrowser = acode.require("fileBrowser");
    const result = await fileBrowser("folder", "Select project folder");
    if (!result || result.type !== "folder") return;

    const openFolder = acode.require("openFolder");
    const id = `ai-agent-${Date.now()}`;
    await Promise.resolve(openFolder(result.url, { name: result.name, id, saveState: true }));

    // Don't just assume it worked — openFolder can silently fail (e.g. a
    // permission hiccup on the folder's SAF URI), or take a moment to
    // register in addedFolder. Poll and match by URL (not id — id may not
    // be honored, or may be missing on entries opened outside this plugin).
    let match = findFolderEntry(result.url);
    for (let i = 0; !match && i < 6; i++) {
      await new Promise((r) => setTimeout(r, 300));
      match = findFolderEntry(result.url);
    }

    if (!match) {
      selectedFolderUrl = null;
      appendMessage(
        "system",
        `Couldn't confirm "${result.name}" was added to Acode's folder list. This usually happens when the folder you picked is nested inside another folder that's already open (e.g. "test codes" inside "codes") — Acode may not add it as a separate root in that case. Try either: (1) tapping the folder icon and picking "test codes" from the existing-folders list instead of "+ Add Project", or (2) scoping to the parent folder ("codes") and telling me the path like "test codes/index.html".`
      );
      return;
    }

    selectedFolderUrl = match.url;
    rememberScopedFolder(match.url, match.title || result.name);
    appendProjectStatus("Added and scoped to:", match.title || result.name);
    await announceProjectFiles();
  } catch (e) {
    // user cancelled the picker, or it's genuinely unavailable
    appendMessage("system", `Folder selection was cancelled or unavailable: ${e.message}`);
  }
}

// Turns a folder's raw content:// / file:// URL into a short, readable
// subtitle for the folder picker card (full URL is still available on tap).
function shortFolderPath(url) {
  try {
    let clean = decodeURIComponent(String(url || ""));
    clean = clean.replace(/^content:\/\//i, "").replace(/^file:\/\//i, "");
    // SAF tree URIs repeat the volume id before "/document/..." — the part
    // after the last colon or "primary:" is the actual human-readable path.
    const afterColon = clean.split(/%3A|:/).pop();
    const path = (afterColon || clean).replace(/\/+/g, "/");
    return path.length > 56 ? "…" + path.slice(-53) : path;
  } catch (e) {
    return String(url || "");
  }
}

function openFolderPicker() {
  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay ai-agent-provider-overlay";
  overlay.innerHTML = `
    <div class="ai-agent-provider-sheet">
      <div class="ai-agent-provider-header">
        <button type="button" id="ai-agent-folder-back" class="ai-agent-settings-close" title="Close">←</button>
        <h3>Project Folder</h3>
        <span class="ai-agent-provider-header-spacer"></span>
      </div>
      <div class="ai-agent-provider-search-row">
        <input id="ai-agent-folder-search" type="text" placeholder="Search open folders…" />
      </div>
      <div class="ai-agent-provider-list scroll" id="ai-agent-folder-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector("#ai-agent-folder-list");
  const searchInput = overlay.querySelector("#ai-agent-folder-search");

  function renderList(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    listEl.innerHTML = "";

    // "Add a project" always shows, even while searching, so it's never
    // scrolled away or hidden by a filter that matches nothing.
    const addCard = buildInfoCard({
      iconSvg: ICON_FOLDER_ADD,
      iconColors: ["#5aa0ff", "#3a7fd9"],
      title: "Add a project folder",
      desc: "Browse your device and open a new folder for the AI to work in.",
      onClick: async () => {
        overlay.remove();
        await addNewProject();
      },
    });
    addCard.classList.add("ai-agent-add-project-row");
    listEl.appendChild(addCard);

    const allFolders = window.addedFolder || [];
    const folders = allFolders.filter((f) => {
      if (!q) return true;
      return `${f.title || ""} ${f.url || ""}`.toLowerCase().includes(q);
    });

    if (!allFolders.length) {
      const empty = document.createElement("div");
      empty.className = "ai-agent-provider-empty";
      empty.textContent = "No folders are open in Acode yet — add one above to get started.";
      listEl.appendChild(empty);
      return;
    }

    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "ai-agent-provider-empty";
      empty.textContent = "No open folders match your search.";
      listEl.appendChild(empty);
      return;
    }

    folders.forEach((f) => {
      const isSelected = normalizeUrl(selectedFolderUrl) === normalizeUrl(f.url);
      const card = buildInfoCard({
        iconSvg: ICON_FOLDER_PLAIN,
        iconColors: isSelected ? ["#5aa0ff", "#3a7fd9"] : ["#f6b83a", "#d9931c"],
        title: f.title || "Untitled folder",
        badges: isSelected ? [{ text: "✓ Currently scoped", selected: true }] : [],
        desc: shortFolderPath(f.url),
        selected: isSelected,
        onClick: async () => {
          const root = findFolderEntry(f.url);
          if (!root) {
            appendMessage("system", "That folder is no longer available. Try picking it again.");
            overlay.remove();
            return;
          }
          selectedFolderUrl = root.url;
          rememberScopedFolder(root.url, root.title || root.url);
          appendProjectStatus("AI now scoped to:", root.title || root.url);
          overlay.remove();
          await announceProjectFiles();
        },
      });
      listEl.appendChild(card);
    });
  }

  renderList("");
  searchInput.addEventListener("input", (e) => renderList(e.target.value));

  const close = () => overlay.remove();
  overlay.querySelector("#ai-agent-folder-back").onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
}

function resolveSafePath(relativePath) {
  const root = getRootFolder();
  if (!root) {
    throw new Error(
      "No project folder is scoped. Tap the folder icon and choose a folder before asking me to read/write/create files."
    );
  }
  const clean = String(relativePath || "").replace(/^\/+/, "");
  if (clean.split("/").some((seg) => seg === "..")) {
    throw new Error(`Rejected path outside project: ${relativePath}`);
  }
  const rootUrl = root.url.endsWith("/") ? root.url.slice(0, -1) : root.url;
  return { fullUrl: clean ? `${rootUrl}/${clean}` : rootUrl, rootUrl };
}

// ---------- AI call ----------

function systemPrompt() {
  return [
    "You are a coding assistant embedded in the Acode editor on Android.",
    "You can propose file operations on the user's currently open project.",
    "Respond with a single JSON object and nothing else, in this exact shape:",
    `{"message": "short explanation for the user", "actions": [`,
    `  {"type": "read_file", "path": "relative/path.js"},`,
    `  {"type": "write_file", "path": "relative/path.js", "content": "full new file content"},`,
    `  {"type": "create_file", "path": "relative/newfile.js", "content": "file content"},`,
    `  {"type": "delete_file", "path": "relative/path.js"}`,
    `]}`,
    "Rules:",
    "- Paths are always relative to the project root, never absolute, never containing '..'.",
    "- write_file/create_file must include the COMPLETE file content, not a diff.",
    "- create_file/write_file may use nested paths like 'src/components/Button.js' — any missing folders are created automatically, so never ask the user to create folders manually.",
    "- Only include actions you actually want performed. Use an empty array if none.",
    "- Keep 'message' short; it is shown directly to the user.",
    "",
    "Multi-step workflow: this runs as an agentic loop, not a single turn.",
    "- If you need to see a file's current contents before deciding what to write, include read_file actions ONLY (no write/create/delete in that same response). Those reads are executed automatically and their contents are sent back to you as a follow-up message, in the same conversation turn, without any user action needed.",
    "- Once you have everything you need, respond with the write_file/create_file/delete_file actions for the user to review and apply. Do not mix unresolved read_file requests with write/create/delete actions in the same response — reads are resolved first, then the next response should contain the actual changes.",
    `- You get up to ${MAX_AGENT_STEPS} of these automatic read/respond rounds per user message before the loop stops and shows your latest response as-is, so be efficient: read only what you actually need.`,
  ].join("\n");
}

async function callOpenAICompatible(userText) {
  const messages = [
    { role: "system", content: systemPrompt() },
    ...history,
    { role: "user", content: userText },
  ];
  let res;
  try {
    res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
      }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${config.endpoint} (${e.message}). Check your internet connection and that the endpoint URL in settings is correct.`
    );
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.usage) recordUsage(data.usage.prompt_tokens, data.usage.completion_tokens);
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(userText) {
  const msgs = [...history, { role: "user", content: userText }];
  let res;
  try {
    res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2000,
        system: systemPrompt(),
        messages: msgs,
      }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${config.endpoint} (${e.message}). Check your internet connection and that the endpoint URL in settings is correct.`
    );
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.usage) recordUsage(data.usage.input_tokens, data.usage.output_tokens);
  return (data.content || []).map((b) => b.text || "").join("");
}

async function callAI(userText) {
  return config.provider === "anthropic"
    ? callAnthropic(userText)
    : callOpenAICompatible(userText);
}

// ---------- Streaming AI call ----------
// Same requests as above but with stream:true, so the status line can show
// real, live info pulled straight from the API — the partial message text
// as it's generated and how many file actions are being drafted — instead
// of a static "Thinking..." placeholder.

function extractLiveInfo(partialRaw) {
  let preview = "";
  const msgMatch = partialRaw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
  if (msgMatch) {
    preview = msgMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
  }
  let actionCount = 0;
  const actionsIdx = partialRaw.indexOf('"actions"');
  if (actionsIdx !== -1) {
    actionCount = (
      partialRaw
        .slice(actionsIdx)
        .match(/"type"\s*:\s*"(read_file|write_file|create_file|delete_file)"/g) || []
    ).length;
  }
  return { preview, actionCount };
}

async function streamOpenAICompatible(userText, onChunk) {
  const messages = [
    { role: "system", content: systemPrompt() },
    ...history,
    { role: "user", content: userText },
  ];
  let res;
  try {
    res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${config.endpoint} (${e.message}). Check your internet connection and that the endpoint URL in settings is correct.`
    );
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  if (!res.body || !res.body.getReader) throw new Error("Streaming not supported by this runtime.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onChunk(full);
      }
      if (json.usage) usage = json.usage;
    }
  }
  if (usage) recordUsage(usage.prompt_tokens, usage.completion_tokens);
  return full;
}

async function streamAnthropic(userText, onChunk) {
  const msgs = [...history, { role: "user", content: userText }];
  let res;
  try {
    res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2000,
        system: systemPrompt(),
        messages: msgs,
        stream: true,
      }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${config.endpoint} (${e.message}). Check your internet connection and that the endpoint URL in settings is correct.`
    );
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  if (!res.body || !res.body.getReader) throw new Error("Streaming not supported by this runtime.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let inputTokens = 0;
  let outputTokens = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        full += json.delta.text;
        onChunk(full);
      }
      if (json.type === "message_start" && json.message?.usage) {
        inputTokens = json.message.usage.input_tokens || 0;
        outputTokens = json.message.usage.output_tokens || 0;
      }
      if (json.type === "message_delta" && json.usage) {
        outputTokens = json.usage.output_tokens || outputTokens;
      }
    }
  }
  recordUsage(inputTokens, outputTokens);
  return full;
}

async function streamAI(userText, onChunk) {
  return config.provider === "anthropic"
    ? streamAnthropic(userText, onChunk)
    : streamOpenAICompatible(userText, onChunk);
}

// Best-effort recovery of just the "message" field out of a JSON string that
// failed to fully parse (usually because the response got cut off mid
// "content" value when it hit the token limit, or the model added stray
// text around otherwise-valid JSON). Used only as a fallback so the chat
// shows a short sentence instead of a raw JSON dump.
function salvageMessageField(text) {
  const m = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

function parseAIResponse(raw) {
  // Be forgiving: strip code fences if the model added them anyway.
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Full parse failed. Try to at least pull out the "message" text so the
    // person sees a short sentence instead of the whole raw JSON/actions
    // block spilling into the chat — this is what used to show up as a wall
    // of `{"message": ..., "actions": [...]}` text.
    const salvaged = salvageMessageField(cleaned);
    if (salvaged) {
      return {
        message: salvaged,
        actions: [],
        _truncated: true,
      };
    }
    return {
      message:
        "The AI's response wasn't valid JSON, so I couldn't apply any file changes from it. Try asking again — if it keeps happening, the reply may be getting cut off by the model's output limit.",
      actions: [],
      _truncated: true,
    };
  }
}

// ---------- File action execution ----------

// Recursively creates every missing directory segment between rootUrl and
// dirUrl. Acode's fs API only offers single-level createDirectory, so nested
// paths like "src/components/Button.js" need each segment created in turn.
// Existing segments are left untouched (checked via exists() before create).
async function ensureDir(dirUrl, rootUrl) {
  const fs = acode.require("fs");
  const root = rootUrl.endsWith("/") ? rootUrl.slice(0, -1) : rootUrl;
  const dir = dirUrl.endsWith("/") ? dirUrl.slice(0, -1) : dirUrl;
  if (dir === root || dir.length <= root.length) return dir;

  const rel = dir.slice(root.length).replace(/^\/+/, "");
  if (!rel) return dir;

  const segments = rel.split("/").filter(Boolean);
  let currentUrl = root;
  for (const segment of segments) {
    const nextUrl = `${currentUrl}/${segment}`;
    const nextEntry = await fs(nextUrl);
    if (!(await nextEntry.exists())) {
      const currentEntry = await fs(currentUrl);
      await currentEntry.createDirectory(segment);
    }
    currentUrl = nextUrl;
  }
  return currentUrl;
}

async function executeAction(action) {
  const fs = acode.require("fs");
  const { type, path, content } = action;
  const { fullUrl, rootUrl } = resolveSafePath(path);

  switch (type) {
    case "read_file": {
      const f = await fs(fullUrl);
      const text = await f.readFile("utf8");
      return { ok: true, detail: `Read ${path} (${text.length} chars)`, content: text };
    }
    case "write_file": {
      const f = await fs(fullUrl);
      if (await f.exists()) {
        await f.writeFile(content ?? "");
      } else {
        const parentUrl = fullUrl.substring(0, fullUrl.lastIndexOf("/"));
        const name = fullUrl.substring(fullUrl.lastIndexOf("/") + 1);
        const realParentUrl = await ensureDir(parentUrl, rootUrl);
        const parent = await fs(realParentUrl);
        await parent.createFile(name, content ?? "");
      }
      refreshOpenEditorIfMatches(fullUrl, content ?? "");
      return { ok: true, detail: `Wrote ${path}` };
    }
    case "create_file": {
      const parentUrl = fullUrl.substring(0, fullUrl.lastIndexOf("/"));
      const name = fullUrl.substring(fullUrl.lastIndexOf("/") + 1);
      const realParentUrl = await ensureDir(parentUrl, rootUrl);
      const parent = await fs(realParentUrl);
      await parent.createFile(name, content ?? "");
      return { ok: true, detail: `Created ${path}` };
    }
    case "delete_file": {
      const f = await fs(fullUrl);
      await f.delete();
      return { ok: true, detail: `Deleted ${path}` };
    }
    default:
      return { ok: false, detail: `Unknown action type: ${type}` };
  }
}

// Best-effort read used only to build diff previews — never throws, just
// returns null if the file doesn't exist yet (i.e. this is a new file).
async function tryReadExisting(path) {
  try {
    const fs = acode.require("fs");
    const { fullUrl } = resolveSafePath(path);
    const f = await fs(fullUrl);
    if (!(await f.exists())) return null;
    return await f.readFile("utf8");
  } catch {
    return null;
  }
}

// ---------- Simple line diff (for the review-before-apply preview) ----------
// Plain LCS-based line diff. Good enough for typical source files reviewed
// on a phone screen; not meant to compete with a real diff algorithm on huge
// files, so it's capped by the caller before being rendered.
function diffLines(oldText, newText) {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", line: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "del", line: a[i] }); i++; }
  while (j < m) { ops.push({ type: "add", line: b[j] }); j++; }
  return ops;
}

function refreshOpenEditorIfMatches(fullUrl, newText) {
  try {
    const files = editorManager?.files || [];
    const match = files.find((f) => f.uri === fullUrl);
    if (match && match.session) {
      match.session.setValue(newText);
    }
  } catch (e) {
    // Non-fatal: file on disk is still updated even if the open tab isn't refreshed.
  }
}

// ---------- UI ----------

function setStatus(text) {
  if (!statusEl || !statusTextEl) return;
  if (!text) {
    statusEl.style.display = "none";
    statusEl.classList.remove("ai-agent-status-visible");
    statusTextEl.textContent = "";
    return;
  }
  statusEl.style.display = "flex";
  // Restart the entrance animation even if the status bar was already
  // showing (e.g. text changed mid-task), so each new status line still
  // reads as a fresh update rather than an abrupt text swap.
  statusEl.classList.remove("ai-agent-status-visible");
  void statusEl.offsetWidth;
  statusEl.classList.add("ai-agent-status-visible");
  statusTextEl.textContent = text;
  const dots = document.createElement("span");
  dots.className = "ai-agent-dots";
  dots.innerHTML = "<span>.</span><span>.</span><span>.</span>";
  statusTextEl.appendChild(dots);
}

function appendMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `ai-agent-msg ai-agent-${role}`;
  bubble.textContent = text;
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// Turns a raw thrown error (often a big HTTP status + JSON body dump) into a
// short, plain-English line. The original text isn't lost — appendError
// keeps it behind a "Show details" toggle for anyone who wants it — but the
// chat itself should never show a wall of JSON just because a request failed.
function friendlyErrorMessage(raw) {
  const msg = String(raw || "").trim();

  const apiMatch = msg.match(/^API error (\d+)/i);
  if (apiMatch) {
    const code = parseInt(apiMatch[1], 10);
    switch (code) {
      case 400:
        return "The AI service rejected the request — this usually means the model name isn't valid for the selected endpoint.";
      case 401:
      case 403:
        return "Authentication failed — check that your API key is correct and has access to this model.";
      case 404:
        return "Endpoint not found — double-check the endpoint URL in settings.";
      case 408:
        return "The request timed out — try again.";
      case 429:
        return "Rate limit or quota reached — wait a moment and try again, or check your plan/billing.";
      case 500:
      case 502:
      case 503:
      case 504:
        return "The AI service is having problems on its end right now — try again in a moment.";
      default:
        return `The AI service returned an error (status ${code}).`;
    }
  }

  if (/^Could not reach/i.test(msg)) {
    return "Couldn't connect to the AI service — check your internet connection and the endpoint URL in settings.";
  }
  if (/^No project folder is scoped/i.test(msg)) {
    return msg; // already short and actionable as-is
  }
  if (/^Rejected path outside project/i.test(msg)) {
    return "That file path isn't allowed — it points outside the project folder.";
  }
  if (/^Streaming not supported/i.test(msg)) {
    return "This endpoint doesn't support streaming responses — retrying without it.";
  }
  if (!msg) {
    return "Something went wrong talking to the AI service.";
  }
  // Fallback: if it's short already (not a JSON/stack dump), just show it as-is.
  if (msg.length <= 100 && !/[{}[\]]/.test(msg)) {
    return msg;
  }
  return "Something went wrong talking to the AI service.";
}

// Renders a friendly one-line error with an optional "Show details" toggle
// that reveals the original raw error text (status codes, JSON bodies,
// stack-ish messages) for anyone who wants to dig further — hidden by
// default so a single failed request doesn't fill the chat with noise.
function appendError(rawMessage) {
  const friendly = friendlyErrorMessage(rawMessage);
  const raw = String(rawMessage || "").trim();

  const bubble = document.createElement("div");
  bubble.className = "ai-agent-msg ai-agent-system ai-agent-error-msg";

  const textEl = document.createElement("div");
  textEl.className = "ai-agent-error-text";
  textEl.textContent = friendly;
  bubble.appendChild(textEl);

  if (raw && raw !== friendly) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ai-agent-error-toggle";
    toggle.textContent = "Show details";

    const details = document.createElement("pre");
    details.className = "ai-agent-error-details";
    details.textContent = raw;
    details.style.display = "none";

    toggle.onclick = () => {
      const showing = details.style.display !== "none";
      details.style.display = showing ? "none" : "block";
      toggle.textContent = showing ? "Show details" : "Hide details";
    };

    bubble.appendChild(toggle);
    bubble.appendChild(details);
  }

  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// Renders things like "Connected to project: <name>" with the folder name
// as its own rounded badge, instead of one plain sentence.
function appendProjectStatus(prefixText, folderName) {
  const bubble = document.createElement("div");
  bubble.className = "ai-agent-msg ai-agent-system ai-agent-project-status";

  const prefix = document.createElement("span");
  prefix.className = "ai-agent-project-status-text";
  prefix.textContent = prefixText;

  const badge = document.createElement("span");
  badge.className = "ai-agent-project-badge";
  badge.textContent = folderName;

  bubble.appendChild(prefix);
  bubble.appendChild(badge);
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function renderDiffPane(ops) {
  const pane = document.createElement("div");
  pane.className = "ai-agent-diff-pane";

  // Cap what we render — a phone screen can't usefully show thousands of
  // lines anyway, and this is a review preview, not a full diff tool.
  const MAX_DIFF_LINES = 400;
  const shown = ops.slice(0, MAX_DIFF_LINES);

  shown.forEach((op) => {
    const line = document.createElement("div");
    line.className = `ai-agent-diff-line ai-agent-diff-${op.type}`;
    const marker = op.type === "add" ? "+ " : op.type === "del" ? "− " : "  ";
    line.textContent = marker + op.line;
    pane.appendChild(line);
  });

  if (ops.length > MAX_DIFF_LINES) {
    const more = document.createElement("div");
    more.className = "ai-agent-diff-line ai-agent-diff-more";
    more.textContent = `… ${ops.length - MAX_DIFF_LINES} more line(s) not shown`;
    pane.appendChild(more);
  }

  return pane;
}

async function appendActionsBlock(actions) {
  const wrap = document.createElement("div");
  wrap.className = "ai-agent-actions";

  for (const action of actions) {
    const row = document.createElement("div");
    row.className = "ai-agent-action-row";

    const main = document.createElement("div");
    main.className = "ai-agent-action-main";

    const label = document.createElement("span");
    label.textContent = `${action.type}: ${action.path}`;
    main.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "ai-agent-action-controls";

    // Diff preview for anything that changes file content on disk.
    let diffPane = null;
    if (action.type === "write_file" || action.type === "create_file") {
      const existing = await tryReadExisting(action.path);
      const ops = diffLines(existing ?? "", action.content ?? "");
      const changed = ops.some((o) => o.type !== "same");
      if (changed) {
        const diffBtn = document.createElement("button");
        diffBtn.className = "ai-agent-diff-toggle";
        diffBtn.textContent = existing === null ? "View new file" : "View diff";
        diffPane = renderDiffPane(ops);
        diffPane.style.display = "none";
        diffBtn.onclick = () => {
          const showing = diffPane.style.display !== "none";
          diffPane.style.display = showing ? "none" : "block";
          diffBtn.textContent = showing
            ? (existing === null ? "View new file" : "View diff")
            : "Hide";
        };
        controls.appendChild(diffBtn);
      }
    }

    const btn = document.createElement("button");
    btn.textContent = action.type === "delete_file" ? "Confirm delete" : "Apply";
    btn.onclick = async () => {
      try {
        if (action.type === "delete_file") {
          const sure = window.confirm(`Delete ${action.path}? This cannot be undone.`);
          if (!sure) return;
        }
        const result = await executeAction(action);
        row.style.opacity = "0.5";
        btn.disabled = true;
        btn.textContent = result.ok ? "Done" : "Failed";
        appendMessage("system", result.detail);
      } catch (e) {
        appendError(e.message);
      }
    };
    controls.appendChild(btn);
    main.appendChild(controls);
    row.appendChild(main);
    if (diffPane) row.appendChild(diffPane);
    wrap.appendChild(row);
  }

  chatLogEl.appendChild(wrap);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

async function handleSend() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!config.apiKey) {
    appendError("Set your API key first — tap the gear icon to add one.");
    return;
  }
  inputEl.value = "";
  autoGrowInput();
  appendMessage("user", text);

  const startedAt = Date.now();
  let raw = "";
  let stepLabel = "Contacting API";

  const tick = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const { preview, actionCount } = extractLiveInfo(raw);
    let line = raw ? "Writing response" : stepLabel;
    if (actionCount > 0) {
      line += ` · drafting ${actionCount} file action${actionCount > 1 ? "s" : ""}`;
    } else if (preview) {
      line += ` · "${preview.slice(-48)}"`;
    }
    line += ` · ${secs}s`;
    setStatus(line);
  };

  setStatus(stepLabel);
  const timer = setInterval(tick, 200);

  try {
    // turnInput starts as the user's typed message. If the AI asks to read
    // files first, we resolve those reads ourselves and loop back with the
    // file contents as the next "turnInput" — the AI never has to ask the
    // user to paste anything, and the user never sees these intermediate
    // rounds as extra chat bubbles (just a short status line).
    let turnInput = text;

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      raw = "";
      stepLabel = step === 0 ? "Contacting API" : `Reading files · round ${step + 1}`;
      try {
        raw = await streamAI(turnInput, (fullSoFar) => {
          raw = fullSoFar;
          tick();
        });
      } catch (streamErr) {
        // Endpoint may not support server-sent streaming — fall back quietly.
        raw = await callAI(turnInput);
      }

      const parsed = parseAIResponse(raw);
      history.push({ role: "user", content: turnInput });
      history.push({ role: "assistant", content: raw });

      const allActions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const reads = allActions.filter((a) => a.type === "read_file");
      const others = allActions.filter((a) => a.type !== "read_file");

      // Pure read request (no writes/creates/deletes yet) and we still have
      // rounds left: resolve the reads automatically and let the AI continue
      // in the same turn. This is the actual "agentic loop" — previously
      // read_file was just another action the user had to review and tap.
      if (reads.length > 0 && others.length === 0 && step < MAX_AGENT_STEPS - 1) {
        appendMessage(
          "system",
          `Reading ${reads.length} file${reads.length > 1 ? "s" : ""} to plan the next step…`
        );
        let followUp = "[Automatic result of your read_file request(s) — continue the task]\n";
        let hardStop = false;
        for (const r of reads) {
          try {
            const result = await executeAction(r);
            followUp += `\n--- ${r.path} ---\n${result.content}\n`;
          } catch (e) {
            // Surface the real reason directly instead of only stuffing it
            // into the AI's next prompt — otherwise the user just sees
            // whatever the AI decides to paraphrase it as (or nothing).
            appendError(e.message);
            // No project folder scoped isn't something another round with
            // the AI can fix, so stop the loop here rather than spending a
            // turn asking the AI to "continue" against a project that
            // doesn't exist yet.
            if (/^No project folder is scoped/i.test(e.message)) hardStop = true;
            followUp += `\n--- ${r.path} ---\n[Error reading file: ${e.message}]\n`;
          }
        }
        if (hardStop) break;
        turnInput = followUp;
        continue;
      }

      // Final response for this message. Any read_file actions bundled
      // alongside real changes are non-destructive, so just run them
      // quietly; only write/create/delete go through the review UI below.
      if (reads.length > 0) {
        for (const r of reads) {
          try {
            const result = await executeAction(r);
            appendMessage("system", result.detail);
          } catch (e) {
            appendError(e.message);
          }
        }
      }

      appendMessage("assistant", parsed.message || "(no message)");

      if (others.length > 0) {
        if (config.autoApply) {
          for (const action of others) {
            if (action.type === "delete_file") {
              await appendActionsBlock([action]); // deletes always require a manual tap
            } else {
              try {
                const result = await executeAction(action);
                appendMessage("system", result.detail);
              } catch (e) {
                appendError(e.message);
              }
            }
          }
        } else {
          await appendActionsBlock(others);
        }
      }
      break;
    }
  } catch (e) {
    appendError(e.message);
  } finally {
    clearInterval(timer);
    setStatus("");
  }
}

// Full-screen provider picker — a searchable list of cards (icon tile, name,
// tag, short description) instead of the OS's native <select> dropdown.
// currentKey (nullable) is highlighted as selected; onSelect(key, preset)
// fires once when a card is tapped, then the picker closes itself.
function openProviderPicker(currentKey, onSelect) {
  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay ai-agent-provider-overlay";
  overlay.innerHTML = `
    <div class="ai-agent-provider-sheet">
      <div class="ai-agent-provider-header">
        <button type="button" id="ai-agent-provider-back" class="ai-agent-settings-close" title="Back">←</button>
        <h3>Choose Provider</h3>
        <span class="ai-agent-provider-header-spacer"></span>
      </div>
      <div class="ai-agent-provider-search-row">
        <input id="ai-agent-provider-search" type="text" placeholder="Search providers…" />
      </div>
      <div class="ai-agent-provider-list scroll" id="ai-agent-provider-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector("#ai-agent-provider-list");

  function renderList(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    listEl.innerHTML = "";
    Object.entries(OPENAI_COMPATIBLE_PRESETS).forEach(([key, preset]) => {
      const haystack = `${preset.label} ${preset.tagline || ""} ${preset.tag || ""}`.toLowerCase();
      if (q && !haystack.includes(q)) return;

      const isSelected = key === currentKey;
      const modelCount = (preset.models || []).length;
      const modelCountLabel = modelCount ? `${modelCount} model${modelCount === 1 ? "" : "s"} listed` : "Bring your own model";

      const badges = [];
      if (preset.tag) badges.push({ text: preset.tag });
      if (isSelected) badges.push({ text: "✓ Selected", selected: true });

      const card = buildInfoCard({
        iconSvg: getProviderIcon(key),
        iconColors: preset.colors,
        title: preset.label,
        badges,
        desc: preset.tagline,
        metaItems: [modelCountLabel, presetProtocolLabel(preset)],
        footerBadge: presetLocalityBadge(preset),
        selected: isSelected,
        onClick: () => {
          onSelect(key, preset);
          overlay.remove();
        },
      });
      listEl.appendChild(card);
    });

    if (!listEl.children.length) {
      const empty = document.createElement("div");
      empty.className = "ai-agent-provider-empty";
      empty.textContent = "No providers match your search.";
      listEl.appendChild(empty);
    }
  }

  renderList("");
  overlay.querySelector("#ai-agent-provider-search").addEventListener("input", (e) => renderList(e.target.value));
  const close = () => overlay.remove();
  overlay.querySelector("#ai-agent-provider-back").onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
}

// Full-screen model picker — same card-list look as the provider picker,
// but for models. Lists the known model names for whichever preset is
// currently selected (presetKey), plus any custom model names remembered
// from previous use of that preset, plus a live "Use '<typed text>'" card so
// the person can always type an arbitrary/custom model name — necessary for
// local runtimes (Ollama, LM Studio) and presets with no fixed model list,
// and useful even for known presets when a brand-new model isn't in the
// list yet. Picking a name that wasn't already known is remembered for next
// time, so the "current and functional" model list keeps growing with
// actual use instead of staying frozen to what shipped in the plugin.
// onSelect(modelName) fires once, then the picker closes itself.
function openModelPicker(presetKey, currentModel, onSelect) {
  const preset = presetKey ? OPENAI_COMPATIBLE_PRESETS[presetKey] : null;
  const storeKey = presetKey || "_custom";
  const remembered = Array.isArray(config.customModels?.[storeKey]) ? config.customModels[storeKey] : [];

  // Combine the preset's built-in list with anything remembered from past
  // use, plus the currently-configured model itself (even if it came from
  // somewhere else entirely) — so nothing the user is actually using ever
  // just vanishes from the list.
  const allModels = [];
  const seen = new Set();
  const addModel = (m) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    allModels.push(m);
  };
  ((preset && preset.models) || []).forEach(addModel);
  remembered.forEach(addModel);
  if (currentModel) addModel(currentModel);

  function rememberCustomModel(name) {
    if (!name || seen.has(name)) return;
    const list = Array.isArray(config.customModels?.[storeKey]) ? config.customModels[storeKey].slice() : [];
    if (!list.includes(name)) {
      list.push(name);
      if (!config.customModels) config.customModels = {};
      config.customModels[storeKey] = list;
      saveConfig();
    }
  }

  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay ai-agent-provider-overlay";
  overlay.innerHTML = `
    <div class="ai-agent-provider-sheet">
      <div class="ai-agent-provider-header">
        <button type="button" id="ai-agent-model-back" class="ai-agent-settings-close" title="Back">←</button>
        <h3>Choose Model</h3>
        <span class="ai-agent-provider-header-spacer"></span>
      </div>
      <div class="ai-agent-provider-search-row">
        <input id="ai-agent-model-search" type="text" placeholder="Search or type a model name…" />
      </div>
      <div class="ai-agent-provider-list scroll" id="ai-agent-model-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector("#ai-agent-model-list");
  const searchInput = overlay.querySelector("#ai-agent-model-search");

  function choose(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    rememberCustomModel(trimmed);
    onSelect(trimmed);
    overlay.remove();
  }

  // filterText only narrows the visible list — it never limits which
  // models exist. An empty filter always shows every known model with the
  // currently-selected one highlighted, never just the selected one alone.
  function renderList(filterText) {
    const q = (filterText || "").trim();
    const qLower = q.toLowerCase();
    listEl.innerHTML = "";

    const matches = allModels.filter((m) => !qLower || m.toLowerCase().includes(qLower));
    const exactMatch = allModels.some((m) => m.toLowerCase() === qLower);

    if (q && !exactMatch) {
      listEl.appendChild(
        buildInfoCard({
          iconText: "+",
          iconColors: ["#5aa0ff", "#3a7fd9"],
          title: `Use "${q}"`,
          desc: "Use this exact name as a custom model — it'll be remembered here next time.",
          onClick: () => choose(q),
        })
      );
    }

    matches.forEach((m) => {
      const info = getModelInfo(presetKey || "_custom", m);
      const isSelected = m === currentModel;
      const isDefault = preset && m === preset.model;

      const badges = [{ text: info.tag }];
      if (isDefault) badges.push({ text: "Default" });
      if (isSelected) badges.push({ text: "✓ Selected", selected: true });

      const metaItems = [];
      if (info.context) metaItems.push(info.context);
      if (!info.known) metaItems.push("Best guess from name");

      listEl.appendChild(
        buildInfoCard({
          iconSvg: getProviderIcon(presetKey),
          iconColors: (preset && preset.colors) || ["#5b5f66", "#3a3d42"],
          title: m,
          badges,
          desc: info.desc,
          metaItems,
          selected: isSelected,
          onClick: () => choose(m),
        })
      );
    });

    if (!listEl.children.length) {
      const empty = document.createElement("div");
      empty.className = "ai-agent-provider-empty";
      empty.textContent = allModels.length
        ? "No models match your search."
        : "No preset model list for this provider — type a model name above, then tap \"Use …\" to apply it.";
      listEl.appendChild(empty);
    }
  }

  renderList("");
  searchInput.addEventListener("input", (e) => renderList(e.target.value));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      choose(searchInput.value);
    }
  });

  const close = () => overlay.remove();
  overlay.querySelector("#ai-agent-model-back").onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
}

// Vertical "usage & stats" screen: current provider/model at a glance (with
// a one-tap shortcut to change just the model, same picker as settings),
// plus locally-tallied request/token counts built only from numbers the
// APIs themselves reported — never a guessed or fetched account balance.
function openStatsDialog() {
  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay ai-agent-provider-overlay";
  overlay.innerHTML = `
    <div class="ai-agent-provider-sheet">
      <div class="ai-agent-provider-header">
        <button type="button" id="ai-agent-stats-back" class="ai-agent-settings-close" title="Close">←</button>
        <h3>Usage &amp; Stats</h3>
        <span class="ai-agent-provider-header-spacer"></span>
      </div>
      <div class="ai-agent-provider-list scroll" id="ai-agent-stats-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const listEl = overlay.querySelector("#ai-agent-stats-list");

  function sectionLabel(text) {
    const el = document.createElement("div");
    el.className = "ai-agent-stats-section-label";
    el.textContent = text;
    return el;
  }

  function render() {
    listEl.innerHTML = "";
    const usage = config.usage || { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, byModel: {} };
    const presetKey = inferPresetKey();
    const preset = presetKey ? OPENAI_COMPATIBLE_PRESETS[presetKey] : null;

    // ---- Current provider (informational only — change it from Settings) ----
    listEl.appendChild(sectionLabel("Currently connected"));
    const providerCard = buildInfoCard({
      iconSvg: getProviderIcon(presetKey || "custom"),
      iconColors: preset ? preset.colors : ["#5b5f66", "#3a3d42"],
      title: preset ? preset.label : "Custom / manual endpoint",
      badges: [{ text: config.provider === "anthropic" ? "Anthropic Messages API" : "OpenAI-compatible API" }],
      desc: config.endpoint || "No endpoint configured yet — open Settings to add one.",
    });
    providerCard.classList.add("ai-agent-card-static");
    listEl.appendChild(providerCard);

    // ---- Current model, plus a dedicated button to switch it ----
    const info = getModelInfo(presetKey || "_custom", config.model || "");
    const isDefault = preset && config.model === preset.model;
    const modelKey = `${config.provider || "openai"}::${config.model || "unknown"}`;
    const modelEntry = usage.byModel && usage.byModel[modelKey];

    const modelBadges = [{ text: info.tag }];
    if (isDefault) modelBadges.push({ text: "Default" });

    const modelMeta = [];
    if (info.context) modelMeta.push(info.context);
    if (modelEntry) modelMeta.push(`${formatNumber(modelEntry.requests)} request${modelEntry.requests === 1 ? "" : "s"} with this model`);

    const modelCard = buildInfoCard({
      iconSvg: getProviderIcon(presetKey || "custom"),
      iconColors: preset ? preset.colors : ["#5b5f66", "#3a3d42"],
      title: config.model || "No model selected",
      badges: modelBadges,
      desc: info.desc,
      metaItems: modelMeta,
    });
    modelCard.classList.add("ai-agent-card-static");
    listEl.appendChild(modelCard);

    const changeModelBtn = document.createElement("button");
    changeModelBtn.type = "button";
    changeModelBtn.className = "ai-agent-change-model-btn";
    changeModelBtn.innerHTML = `
      <span class="ai-agent-change-model-icon">${ICON_SWAP}</span>
      <span class="ai-agent-change-model-label">Change model</span>
      <span class="ai-agent-change-model-arrow">${ICON_ARROW_RIGHT}</span>
    `;
    changeModelBtn.onclick = () => {
      openModelPicker(presetKey, config.model, async (name) => {
        config.model = name.trim();
        await saveConfig();
        appendMessage("system", `Model switched to ${config.model}.`);
        render();
      });
    };
    listEl.appendChild(changeModelBtn);

    // ---- Totals ----
    listEl.appendChild(sectionLabel("All-time usage on this device"));
    const totalTokens = (usage.totalInputTokens || 0) + (usage.totalOutputTokens || 0);
    const statsGrid = document.createElement("div");
    statsGrid.className = "ai-agent-stats-grid";
    statsGrid.appendChild(
      buildStatTile({
        label: "Requests sent",
        value: formatNumber(usage.totalRequests),
        desc: usage.totalRequests ? "Counted locally, from every reply received" : "Fills in once you send a message",
      })
    );
    statsGrid.appendChild(
      buildStatTile({
        label: "Tokens total",
        value: formatNumber(totalTokens),
        desc: `${formatNumber(usage.totalInputTokens)} in · ${formatNumber(usage.totalOutputTokens)} out`,
      })
    );
    listEl.appendChild(statsGrid);
    const totalsNote = document.createElement("div");
    totalsNote.className = "ai-agent-stats-note";
    totalsNote.textContent = "Token counts, not a dollar cost — pricing varies by provider and changes over time. Nothing here is fetched from a provider's billing dashboard.";
    listEl.appendChild(totalsNote);

    // ---- Per-model breakdown, most recently used first ----
    const rows = Object.values(usage.byModel || {}).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    if (rows.length) {
      listEl.appendChild(sectionLabel("By model"));
      rows.forEach((row) => {
        const rowPresetKey =
          Object.keys(OPENAI_COMPATIBLE_PRESETS).find(
            (k) => OPENAI_COMPATIBLE_PRESETS[k].provider === row.provider && OPENAI_COMPATIBLE_PRESETS[k].model === row.model
          ) || null;
        const rowPreset = rowPresetKey ? OPENAI_COMPATIBLE_PRESETS[rowPresetKey] : null;
        const card = buildInfoCard({
          iconSvg: getProviderIcon(rowPresetKey || (row.provider === "anthropic" ? "anthropic" : "custom")),
          iconColors: rowPreset ? rowPreset.colors : row.provider === "anthropic" ? ["#d97757", "#b35a3d"] : ["#5b5f66", "#3a3d42"],
          title: row.model,
          badges: [{ text: row.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible" }],
          metaItems: [
            `${formatNumber(row.requests)} request${row.requests === 1 ? "" : "s"}`,
            `${formatNumber((row.inputTokens || 0) + (row.outputTokens || 0))} tokens`,
          ],
        });
        card.classList.add("ai-agent-card-static");
        listEl.appendChild(card);
      });

      const resetRow = document.createElement("button");
      resetRow.type = "button";
      resetRow.className = "ai-agent-stats-reset";
      resetRow.textContent = "Reset usage stats";
      resetRow.onclick = async () => {
        config.usage = { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, byModel: {} };
        await saveConfig();
        render();
      };
      listEl.appendChild(resetRow);
    }
  }

  render();
  const close = () => overlay.remove();
  overlay.querySelector("#ai-agent-stats-back").onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
}

function openSettingsDialog() {
  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay";
  overlay.innerHTML = `
    <div class="ai-agent-settings-sheet">
      <div class="ai-agent-settings-header">
        <h3>AI Agent Settings</h3>
        <button id="ai-agent-settings-close" class="ai-agent-settings-close" title="Close">✕</button>
      </div>

      <div class="ai-agent-settings-body scroll">
        <section class="ai-agent-settings-section">
          <div class="ai-agent-settings-section-title">Provider</div>

          <div class="ai-agent-field">
            <label>Quick preset</label>
            <button type="button" id="ai-agent-preset-btn" class="ai-agent-preset-btn">
              <span class="ai-agent-preset-btn-icon" id="ai-agent-preset-btn-icon">?</span>
              <span class="ai-agent-preset-btn-label" id="ai-agent-preset-btn-label">Choose a provider preset…</span>
              <span class="ai-agent-preset-btn-chevron">›</span>
            </button>
          </div>

          <div class="ai-agent-field">
            <label>API type</label>
            <div class="ai-agent-segmented" id="ai-agent-provider-segmented">
              <button type="button" data-value="openai" class="${config.provider === "openai" ? "active" : ""}">OpenAI-compatible</button>
              <button type="button" data-value="anthropic" class="${config.provider === "anthropic" ? "active" : ""}">Anthropic (Claude)</button>
            </div>
          </div>
        </section>

        <section class="ai-agent-settings-section">
          <div class="ai-agent-settings-section-title">Connection</div>

          <div class="ai-agent-field">
            <label>Endpoint URL</label>
            <p class="ai-agent-hint">The web address this app sends your messages to. Pick a preset above to fill this in automatically, or paste your own OpenAI-compatible URL.</p>
            <input id="ai-agent-endpoint" type="text" value="${config.endpoint}" />
          </div>

          <div class="ai-agent-field">
            <label>API Key</label>
            <div class="ai-agent-key-row">
              <input id="ai-agent-key" type="password" value="${config.apiKey}" />
              <button type="button" id="ai-agent-key-toggle" class="ai-agent-key-toggle">Show</button>
            </div>
            <p class="ai-agent-hint">Stored locally on-device. Only ever sent to the endpoint above.</p>
          </div>
        </section>

        <section class="ai-agent-settings-section">
          <div class="ai-agent-settings-section-title">Model</div>
          <div class="ai-agent-field">
            <label>Model</label>
            <button type="button" id="ai-agent-model-btn" class="ai-agent-preset-btn">
              <span class="ai-agent-preset-btn-icon" id="ai-agent-model-btn-icon">M</span>
              <span class="ai-agent-preset-btn-label" id="ai-agent-model-btn-label">${config.model || "Choose a model…"}</span>
              <span class="ai-agent-preset-btn-chevron">›</span>
            </button>
            <p class="ai-agent-hint">Pick from the list for your selected preset, or search to type any custom model name.</p>
          </div>
        </section>

        <section class="ai-agent-settings-section">
          <div class="ai-agent-settings-section-title">Behavior</div>
          <label class="ai-agent-switch-row">
            <div>
              <div class="ai-agent-switch-label">Auto-apply writes/creates</div>
              <div class="ai-agent-switch-sub">Deletes always ask for confirmation</div>
            </div>
            <span class="ai-agent-switch">
              <input id="ai-agent-autoapply" type="checkbox" ${config.autoApply ? "checked" : ""} />
              <span class="ai-agent-switch-track"><span class="ai-agent-switch-thumb"></span></span>
            </span>
          </label>
        </section>
      </div>

      <div class="ai-agent-settings-footer">
        <button id="ai-agent-cancel" class="ai-agent-btn-secondary">Cancel</button>
        <button id="ai-agent-save" class="ai-agent-btn-primary">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const providerSegmented = overlay.querySelector("#ai-agent-provider-segmented");
  const setProvider = (value) => {
    providerSegmented.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.value === value);
    });
  };
  providerSegmented.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => setProvider(btn.dataset.value);
  });

  const presetBtn = overlay.querySelector("#ai-agent-preset-btn");
  const presetBtnIcon = overlay.querySelector("#ai-agent-preset-btn-icon");
  const presetBtnLabel = overlay.querySelector("#ai-agent-preset-btn-label");
  const endpointInput = overlay.querySelector("#ai-agent-endpoint");
  const modelBtn = overlay.querySelector("#ai-agent-model-btn");
  const modelBtnIcon = overlay.querySelector("#ai-agent-model-btn-icon");
  const modelBtnLabel = overlay.querySelector("#ai-agent-model-btn-label");

  // Best-effort: highlight whichever preset already matches the saved
  // endpoint+model, so reopening settings doesn't look like nothing is set.
  let currentPresetKey =
    Object.entries(OPENAI_COMPATIBLE_PRESETS).find(
      ([key, p]) => key !== "custom" && p.endpoint === config.endpoint && p.model === config.model
    )?.[0] || null;
  let currentModelValue = config.model || "";

  function applyPresetToButton(key) {
    const preset = OPENAI_COMPATIBLE_PRESETS[key];
    if (!preset) return;
    presetBtnIcon.textContent = preset.mono;
    presetBtnIcon.style.background = `linear-gradient(135deg, ${preset.colors[0]}, ${preset.colors[1]})`;
    presetBtnLabel.textContent = preset.label;
  }
  if (currentPresetKey) applyPresetToButton(currentPresetKey);

  function applyModelToButton(name) {
    modelBtnLabel.textContent = name || "Choose a model…";
    const preset = currentPresetKey ? OPENAI_COMPATIBLE_PRESETS[currentPresetKey] : null;
    if (preset) {
      modelBtnIcon.textContent = preset.mono;
      modelBtnIcon.style.background = `linear-gradient(135deg, ${preset.colors[0]}, ${preset.colors[1]})`;
    } else {
      modelBtnIcon.textContent = "M";
      modelBtnIcon.style.background = "linear-gradient(135deg, #5b5f66, #3a3d42)";
    }
  }
  applyModelToButton(currentModelValue);

  presetBtn.onclick = () => {
    openProviderPicker(currentPresetKey, (key, preset) => {
      currentPresetKey = key;
      applyPresetToButton(key);
      if (key === "custom") {
        applyModelToButton(currentModelValue); // just refresh the icon; leave the user's typed values alone
        return;
      }
      setProvider(preset.provider || "openai");
      endpointInput.value = preset.endpoint;
      currentModelValue = preset.model;
      applyModelToButton(currentModelValue);
    });
  };

  modelBtn.onclick = () => {
    openModelPicker(currentPresetKey, currentModelValue, (name) => {
      currentModelValue = name;
      applyModelToButton(currentModelValue);
    });
  };

  const keyInput = overlay.querySelector("#ai-agent-key");
  overlay.querySelector("#ai-agent-key-toggle").onclick = (e) => {
    const showing = keyInput.type === "text";
    keyInput.type = showing ? "password" : "text";
    e.currentTarget.textContent = showing ? "Show" : "Hide";
  };

  const close = () => overlay.remove();
  overlay.querySelector("#ai-agent-settings-close").onclick = close;
  overlay.querySelector("#ai-agent-cancel").onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  overlay.querySelector("#ai-agent-save").onclick = async () => {
    const activeProviderBtn = providerSegmented.querySelector("button.active");
    config.provider = activeProviderBtn ? activeProviderBtn.dataset.value : "openai";
    config.endpoint = overlay.querySelector("#ai-agent-endpoint").value.trim();
    config.apiKey = overlay.querySelector("#ai-agent-key").value.trim();
    config.model = currentModelValue.trim();
    config.autoApply = overlay.querySelector("#ai-agent-autoapply").checked;
    await saveConfig();
    close();
    appendMessage("system", "Settings saved.");
  };
}

function autoGrowInput() {
  inputEl.style.height = "auto";
  const maxHeight = window.innerHeight * 0.4;
  inputEl.style.height = Math.min(inputEl.scrollHeight, maxHeight) + "px";
}

async function buildUI(container) {
  containerEl = container;
  container.classList.add("ai-agent-container");
  container.innerHTML = `
    <div class="ai-agent-header">
      <span>AI Agent</span>
      <div class="ai-agent-header-actions">
        <button id="ai-agent-folder-btn" class="ai-agent-icon-btn" title="Project folder">${ICON_FOLDER_ADD}</button>
        <button id="ai-agent-stats-btn" class="ai-agent-icon-btn" title="Usage stats">${ICON_STATS}</button>
        <button id="ai-agent-settings-btn" class="ai-agent-icon-btn" title="Settings">${ICON_SETTINGS}</button>
      </div>
    </div>
    <div class="ai-agent-log scroll"></div>
    <div class="ai-agent-status">
      <span class="ai-agent-status-spinner"></span>
      <span class="ai-agent-status-text"></span>
    </div>
    <div class="ai-agent-input-dock">
      <textarea id="ai-agent-input" placeholder="Ask the AI to read, write, or create files..."></textarea>
      <button id="ai-agent-send-btn" class="ai-agent-send-btn" title="Send">${ICON_SEND}</button>
    </div>
  `;

  chatLogEl = container.querySelector(".ai-agent-log");
  chatLogEl.style.maxHeight = "60vh";
  chatLogEl.style.overflowY = "auto";
  statusEl = container.querySelector(".ai-agent-status");
  statusTextEl = container.querySelector(".ai-agent-status-text");
  inputEl = container.querySelector("#ai-agent-input");

  container.querySelector("#ai-agent-settings-btn").onclick = openSettingsDialog;
  container.querySelector("#ai-agent-folder-btn").onclick = openFolderPicker;
  container.querySelector("#ai-agent-stats-btn").onclick = openStatsDialog;
  container.querySelector("#ai-agent-send-btn").onclick = handleSend;
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  inputEl.addEventListener("input", autoGrowInput);

  let root = getRootFolder();
  if (!root && config.lastFolder) {
    // Don't flash "no folder scoped" the moment the app reopens — try
    // silently re-matching the last folder the user picked first.
    setStatus("Reconnecting to project folder…");
    const restored = await restoreLastFolder();
    setStatus(null);
    root = getRootFolder();
    if (!restored || !root) {
      appendMessage(
        "system",
        `Couldn't find "${config.lastFolder.title}" anymore — it may have been closed or removed. Tap the folder icon to pick your project again.`
      );
    }
  }

  if (root) {
    appendProjectStatus("Connected to project:", root.title || root.url);
  } else if (!config.lastFolder) {
    appendMessage(
      "system",
      "No folder scoped yet. Tap the folder icon and pick one — the AI can't read/write files until you do."
    );
  }

  // Some WebViews paint freshly-injected markup with the stylesheet only
  // partially applied (wrong font, missing rounding) until the next DOM
  // mutation forces a repaint — which is why things used to "snap" into
  // place only after the first message was sent. Nudge a repaint now so it
  // looks right immediately on load.
  void container.offsetHeight;
  requestAnimationFrame(() => {
    container.style.transform = "translateZ(0)";
    requestAnimationFrame(() => {
      container.style.transform = "";
    });
  });
}

// ---------- Plugin lifecycle ----------

if (window.acode) {
  acode.setPluginInit(PLUGIN_ID, async (baseUrl) => {
    await loadConfig();

    $style = document.createElement("style");
    $style.textContent = `
      .ai-agent-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 6px;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .ai-agent-header { display: flex !important; justify-content: space-between; align-items: center; font-weight: bold; padding: 4px 2px; gap: 8px; }
      .ai-agent-header-actions { display: flex !important; gap: 6px; flex-shrink: 0; }
      .ai-agent-icon-btn {
        background: rgba(255,255,255,0.08) !important;
        border: none;
        padding: 6px;
        margin: 0;
        min-width: 32px;
        min-height: 32px;
        line-height: 1;
        border-radius: 6px;
        color: #eeeeee !important;
        flex-shrink: 0;
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .ai-agent-icon-btn svg { display: block !important; width: 20px !important; height: 20px !important; flex-shrink: 0; pointer-events: none; }
      .ai-agent-icon-btn:active { background: rgba(255,255,255,0.2) !important; }
      .ai-agent-send-btn {
        background: rgba(90,160,255,0.95) !important;
        border: none;
        border-radius: 50% !important;
        padding: 0 !important;
        width: 34px !important;
        height: 34px !important;
        min-width: 34px !important;
        flex-shrink: 0 !important;
        display: flex !important;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        margin: 0 4px 4px 0;
      }
      .ai-agent-send-btn svg { display: block !important; width: 17px !important; height: 17px !important; pointer-events: none; }
      .ai-agent-send-btn:active { background: rgba(90,160,255,1) !important; }
      .ai-agent-log {
        flex: 1;
        border: 1px solid var(--border-color, #444);
        border-radius: 6px;
        padding: 8px;
        margin: 6px 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .ai-agent-msg {
        margin-bottom: 0;
        padding: 7px 11px;
        border-radius: 14px;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.35;
        width: fit-content;
        max-width: 85%;
        animation: ai-agent-msg-in 0.26s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .ai-agent-user {
        background: rgba(130,130,138,0.32);
        align-self: flex-end;
        border-bottom-right-radius: 4px;
      }
      .ai-agent-assistant {
        background: none;
        padding: 2px 2px;
        align-self: flex-start;
        width: 100%;
        max-width: 100%;
      }
      .ai-agent-system {
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.07);
        color: rgba(255,255,255,0.72);
        font-size: 0.85em;
        font-style: normal;
        align-self: center;
        max-width: 95%;
      }
      .ai-agent-project-status {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        font-style: normal;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .ai-agent-project-status-text {
        font-size: 0.85em;
        opacity: 0.75;
        letter-spacing: 0.01em;
      }
      .ai-agent-project-badge {
        display: inline-block;
        background: rgba(90,160,255,0.22);
        color: #cfe1ff;
        padding: 3px 12px;
        border-radius: 999px;
        font-size: 0.85em;
        font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .ai-agent-error-msg {
        background: rgba(255,90,90,0.12);
        border: 1px solid rgba(255,90,90,0.28);
        font-style: normal;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
      }
      .ai-agent-error-text { color: #ffb3ab; }
      .ai-agent-error-toggle {
        background: none; border: none; color: #ffb3ab; opacity: 0.75;
        font-size: 0.82em; text-decoration: underline; padding: 0;
      }
      .ai-agent-error-toggle:active { opacity: 1; }
      .ai-agent-error-details {
        margin: 0; max-width: 100%; max-height: 220px; overflow: auto;
        background: rgba(0,0,0,0.28); border-radius: 8px; padding: 8px 10px;
        font-size: 0.78em; white-space: pre-wrap; word-break: break-word;
        font-family: "SFMono-Regular", Consolas, Menlo, monospace;
      }
      .ai-agent-actions { border-top: 1px dashed var(--border-color, #555); margin-top: 4px; padding-top: 4px; width: 100%; align-self: stretch; }
      .ai-agent-action-row { padding: 3px 0; font-size: 0.85em; }
      .ai-agent-action-main { display: flex; justify-content: space-between; align-items: center; }
      .ai-agent-action-controls { display: flex; align-items: center; }
      .ai-agent-action-row button { margin-left: 6px; }
      .ai-agent-diff-toggle {
        background: transparent;
        border: 1px solid var(--border-color, #555);
        color: inherit;
        border-radius: 6px;
        font-size: 0.9em;
        padding: 2px 8px;
      }
      .ai-agent-diff-pane {
        margin: 6px 0 4px;
        max-height: 260px;
        overflow-y: auto;
        border: 1px solid var(--border-color, #444);
        border-radius: 6px;
        background: rgba(0,0,0,0.25);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        font-size: 0.78em;
        line-height: 1.4;
      }
      .ai-agent-diff-line { white-space: pre-wrap; word-break: break-all; padding: 0 8px; }
      .ai-agent-diff-add { background: rgba(80,200,120,0.18); color: #a8e6b8; }
      .ai-agent-diff-del { background: rgba(220,90,90,0.18); color: #f2b3b3; text-decoration: line-through; text-decoration-color: rgba(242,179,179,0.5); }
      .ai-agent-diff-same { opacity: 0.55; }
      .ai-agent-diff-more { opacity: 0.6; font-style: italic; padding: 2px 8px; }
      .ai-agent-input-dock {
        display: flex !important;
        align-items: flex-end;
        gap: 0;
        background: rgba(255,255,255,0.06);
        border: 1px solid var(--border-color, #444);
        border-radius: 20px;
        padding: 4px;
        box-sizing: border-box;
      }
      .ai-agent-input-dock textarea,
      .ai-agent-input-dock textarea:focus,
      .ai-agent-input-dock textarea:active {
        flex: 1;
        min-width: 0;
        min-height: 34px !important;
        max-height: 40vh;
        resize: none;
        box-sizing: border-box;
        background: transparent !important;
        background-image: none !important;
        border: none !important;
        border-radius: 0 !important;
        outline: none !important;
        box-shadow: none !important;
        appearance: none !important;
        -webkit-appearance: none !important;
        padding: 7px 8px 7px 12px !important;
        margin: 0 !important;
        font: inherit;
        color: inherit;
        overflow-y: auto;
      }
      .ai-agent-status {
        display: none;
        align-items: center;
        gap: 7px;
        font-size: 0.82em;
        opacity: 0.85;
        min-height: 1.4em;
        padding: 3px 10px;
        text-align: left;
        color: #cfe1ff;
      }
      .ai-agent-status-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }
      .ai-agent-status-spinner {
        width: 11px;
        height: 11px;
        flex-shrink: 0;
        border-radius: 50%;
        border: 2px solid rgba(90,160,255,0.25);
        border-top-color: #5aa0ff;
        animation: ai-agent-spin 0.7s linear infinite;
      }
      .ai-agent-dots span {
        display: inline-block;
        animation: ai-agent-blink 1.2s infinite;
        opacity: 0;
      }
      .ai-agent-dots span:nth-child(1) { animation-delay: 0s; }
      .ai-agent-dots span:nth-child(2) { animation-delay: 0.2s; }
      .ai-agent-dots span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes ai-agent-spin { to { transform: rotate(360deg); } }
      @keyframes ai-agent-blink { 0%, 80%, 100% { opacity: 0; } 40% { opacity: 1; } }
      @keyframes ai-agent-msg-in {
        from { opacity: 0; transform: translateY(6px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes ai-agent-fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ai-agent-overlay-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ai-agent-sheet-in {
        from { opacity: 0; transform: translateY(24px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes ai-agent-expand {
        from { opacity: 0; transform: scaleY(0.92); }
        to { opacity: 1; transform: scaleY(1); }
      }
      * { scroll-behavior: smooth; }
      .ai-agent-icon-btn, .ai-agent-send-btn, .ai-agent-error-toggle,
      .ai-agent-diff-toggle, .ai-agent-settings-close, button {
        transition: background 0.15s ease, transform 0.12s ease, opacity 0.15s ease, color 0.15s ease;
      }
      .ai-agent-icon-btn:active, .ai-agent-send-btn:active { transform: scale(0.92); }
      .ai-agent-log { scroll-behavior: smooth; }
      .ai-agent-log > * { transform-origin: top center; }
      .ai-agent-actions { animation: ai-agent-fade-in 0.25s ease both; }
      .ai-agent-diff-pane { animation: ai-agent-expand 0.2s ease both; transform-origin: top; }
      .ai-agent-status {
        transition: opacity 0.2s ease, transform 0.2s ease;
        opacity: 0;
        transform: translateY(-4px);
      }
      .ai-agent-status-visible {
        opacity: 1;
        transform: translateY(0);
      }
      .ai-agent-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999; animation: ai-agent-overlay-in 0.18s ease both; }
      .ai-agent-settings-card { background: var(--bg-color, #222); color: var(--text-color, #eee); padding: 16px; border-radius: 8px; width: 85vw; max-width: 400px; display: flex; flex-direction: column; gap: 6px; }
      .ai-agent-settings-card input, .ai-agent-settings-card select { padding: 6px; }

      /* ---- Settings sheet (AI Agent Settings dialog) ---- */
      .ai-agent-settings-sheet {
        background: #1c1c1e;
        color: #eee;
        width: 90vw;
        max-width: 420px;
        max-height: 88vh;
        border-radius: 16px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        animation: ai-agent-sheet-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .ai-agent-settings-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
      }
      .ai-agent-settings-header h3 { margin: 0; font-size: 1.05em; font-weight: 700; }
      .ai-agent-settings-close {
        background: rgba(255,255,255,0.06); border: none; color: inherit;
        width: 28px; height: 28px; border-radius: 8px; font-size: 0.9em; line-height: 1;
      }
      .ai-agent-settings-close:active { background: rgba(255,255,255,0.15); }
      .ai-agent-settings-body {
        padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
      }
      .ai-agent-settings-section {
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 14px;
        display: flex; flex-direction: column; gap: 12px;
      }
      .ai-agent-settings-section-title {
        font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em;
        font-weight: 700; opacity: 0.55;
      }
      .ai-agent-field { display: flex; flex-direction: column; gap: 6px; }
      .ai-agent-field label { font-size: 0.85em; font-weight: 600; opacity: 0.92; }
      .ai-agent-field input[type="text"],
      .ai-agent-field input[type="password"],
      .ai-agent-field select {
        background: rgba(0,0,0,0.28);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px;
        color: inherit;
        padding: 9px 10px;
        font-size: 0.92em;
        width: 100%;
        box-sizing: border-box;
      }
      .ai-agent-field input:focus, .ai-agent-field select:focus { border-color: #5aa0ff; outline: none; }
      .ai-agent-hint { font-size: 0.76em; opacity: 0.55; margin: 0; line-height: 1.35; }
      .ai-agent-segmented {
        display: flex; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; overflow: hidden;
      }
      .ai-agent-segmented button {
        flex: 1; padding: 9px 6px; background: transparent; border: none; color: inherit;
        font-size: 0.8em; opacity: 0.6; border-right: 1px solid rgba(255,255,255,0.1);
      }
      .ai-agent-segmented button:last-child { border-right: none; }
      .ai-agent-segmented button.active {
        background: rgba(90,160,255,0.22); color: #cfe1ff; opacity: 1; font-weight: 600;
      }
      .ai-agent-key-row { display: flex; gap: 6px; }
      .ai-agent-key-row input { flex: 1; min-width: 0; }
      .ai-agent-key-toggle {
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: inherit;
        border-radius: 8px; padding: 0 12px; font-size: 0.8em; flex-shrink: 0;
      }
      .ai-agent-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .ai-agent-switch-label { font-size: 0.9em; font-weight: 600; }
      .ai-agent-switch-sub { font-size: 0.76em; opacity: 0.55; margin-top: 2px; }
      .ai-agent-switch { position: relative; width: 42px; height: 24px; flex-shrink: 0; display: inline-block; }
      .ai-agent-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
      .ai-agent-switch-track {
        position: absolute; inset: 0; background: rgba(255,255,255,0.15); border-radius: 999px; transition: background 0.15s;
      }
      .ai-agent-switch-thumb {
        position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
        background: #fff; transition: transform 0.15s;
      }
      .ai-agent-switch input:checked ~ .ai-agent-switch-track { background: #4caf6a; }
      .ai-agent-switch input:checked ~ .ai-agent-switch-track .ai-agent-switch-thumb { transform: translateX(18px); }
      .ai-agent-settings-footer {
        display: flex; justify-content: flex-end; gap: 10px; padding: 14px 16px;
        border-top: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
      }
      .ai-agent-btn-secondary {
        background: transparent; border: 1px solid rgba(255,255,255,0.15); color: inherit;
        padding: 9px 16px; border-radius: 8px; font-size: 0.9em;
      }
      .ai-agent-btn-primary {
        background: #5aa0ff; border: none; color: #08152b; font-weight: 700;
        padding: 9px 18px; border-radius: 8px; font-size: 0.9em;
      }
      .ai-agent-btn-secondary:active, .ai-agent-btn-primary:active { opacity: 0.8; }

      .ai-agent-settings-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

      /* ---- Quick-preset button (opens the provider picker) ---- */
      .ai-agent-preset-btn {
        display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;
        background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
        padding: 8px 10px; color: inherit; font-size: 0.92em; text-align: left;
      }
      .ai-agent-preset-btn:active { background: rgba(255,255,255,0.08); }
      .ai-agent-preset-btn-icon {
        flex-shrink: 0; width: 26px; height: 26px; border-radius: 7px; display: flex;
        align-items: center; justify-content: center; font-size: 0.62em; font-weight: 800; color: #fff;
      }
      .ai-agent-preset-btn-label { flex: 1; min-width: 0; opacity: 0.92; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ai-agent-preset-btn-chevron { opacity: 0.45; font-size: 1.1em; }

      /* ---- Provider picker (full-screen, course-catalog style list) ---- */
      .ai-agent-provider-overlay { align-items: stretch; justify-content: stretch; padding: 0; background: rgba(0,0,0,0.7); }
      .ai-agent-provider-sheet {
        background: #18181a; color: #eee; width: 100%; height: 100%;
        display: flex; flex-direction: column; overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        animation: ai-agent-sheet-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .ai-agent-provider-header {
        display: flex; align-items: center; gap: 10px; padding: 16px;
        border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
      }
      .ai-agent-provider-header h3 { flex: 1; margin: 0; font-size: 1.08em; font-weight: 700; text-align: center; }
      .ai-agent-provider-header-spacer { width: 28px; flex-shrink: 0; }
      .ai-agent-provider-search-row { padding: 10px 16px; flex-shrink: 0; }
      .ai-agent-provider-search-row input {
        width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; color: inherit;
        padding: 10px 12px; font-size: 0.92em;
      }
      .ai-agent-provider-search-row input:focus { border-color: #5aa0ff; outline: none; }
      .ai-agent-provider-list { flex: 1; overflow-y: auto; padding: 4px 16px 28px; display: flex; flex-direction: column; gap: 10px; }
      .ai-agent-provider-card {
        display: flex; align-items: flex-start; gap: 12px; text-align: left;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px; padding: 14px; color: inherit;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
        animation: ai-agent-msg-in 0.22s ease both;
      }
      .ai-agent-provider-card.selected { border-color: #5aa0ff; background: rgba(90,160,255,0.1); }
      .ai-agent-provider-card:active { background: rgba(255,255,255,0.09); transform: scale(0.985); }
      .ai-agent-provider-icon {
        flex-shrink: 0; width: 44px; height: 44px; border-radius: 14px; display: flex;
        align-items: center; justify-content: center; font-weight: 800; font-size: 0.85em;
        letter-spacing: 0.02em;
        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
        color: #b9bcc2; filter: saturate(65%) brightness(0.95);
      }
      .ai-agent-provider-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .ai-agent-provider-card-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
      .ai-agent-provider-card-title { font-size: 1em; font-weight: 700; }
      .ai-agent-card-badge-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .ai-agent-provider-tag {
        font-size: 0.68em; font-weight: 700; padding: 2px 8px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18); opacity: 0.75;
      }
      .ai-agent-provider-tag-selected { color: #8fd19e; border-color: rgba(90,200,120,0.5); opacity: 1; }
      .ai-agent-provider-card-desc { font-size: 0.82em; opacity: 0.6; line-height: 1.35; }
      .ai-agent-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
      .ai-agent-card-meta { font-size: 0.74em; opacity: 0.5; }
      .ai-agent-card-footer-badge {
        font-size: 0.66em; font-weight: 700; padding: 2px 8px; border-radius: 999px;
        background: rgba(255,255,255,0.08); opacity: 0.85; flex-shrink: 0; white-space: nowrap;
      }
      .ai-agent-provider-empty { text-align: center; opacity: 0.5; padding: 40px 0; font-size: 0.9em; }
      .ai-agent-folder-row { display: block; width: 100%; text-align: left; padding: 8px; margin-bottom: 4px; border-radius: 6px; background: rgba(255,255,255,0.06); border: none; color: inherit; }
      .ai-agent-folder-row:active { background: rgba(255,255,255,0.15); }
      .ai-agent-add-project-row { border-color: rgba(90,160,255,0.4); background: rgba(90,160,255,0.08); }
      .ai-agent-add-project-row .ai-agent-provider-card-title { color: #cfe1ff; }

      /* ---- Usage & Stats screen ---- */
      .ai-agent-stats-section-label {
        font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em;
        font-weight: 700; opacity: 0.5; margin: 10px 2px 0;
      }
      .ai-agent-stats-section-label:first-child { margin-top: 2px; }
      .ai-agent-card-static { cursor: default; }
      .ai-agent-card-static:active { background: rgba(255,255,255,0.04); }

      /* Bigger, squircle "Change model" button with a trailing arrow —
         separated from the informational model card above it so it reads
         as a clear, deliberate action rather than a small footer link. */
      .ai-agent-change-model-btn {
        display: flex; align-items: center; gap: 12px; width: 100%; box-sizing: border-box;
        background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 18px; padding: 14px 16px; color: inherit; text-align: left;
        font-size: 0.95em; font-weight: 600; margin-top: -2px;
      }
      .ai-agent-change-model-btn:active { background: rgba(255,255,255,0.09); }
      .ai-agent-change-model-icon {
        flex-shrink: 0; width: 34px; height: 34px; border-radius: 12px; display: flex;
        align-items: center; justify-content: center; background: rgba(90,160,255,0.14);
        color: #7fb0ff;
      }
      .ai-agent-change-model-label { flex: 1; min-width: 0; }
      .ai-agent-change-model-arrow {
        flex-shrink: 0; width: 30px; height: 30px; border-radius: 10px; display: flex;
        align-items: center; justify-content: center; background: rgba(255,255,255,0.06);
        opacity: 0.7;
      }

      /* KPI-style totals grid — muted, flat tiles instead of bright cards. */
      .ai-agent-stats-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 10px; margin-top: 2px;
      }
      .ai-agent-stat-tile {
        display: flex; flex-direction: column; gap: 4px;
        background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px; padding: 14px;
      }
      .ai-agent-stat-tile-label {
        font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.05em;
        font-weight: 700; opacity: 0.5;
      }
      .ai-agent-stat-tile-value { font-size: 1.6em; font-weight: 800; letter-spacing: -0.01em; }
      .ai-agent-stat-tile-desc { font-size: 0.74em; opacity: 0.55; line-height: 1.35; }
      .ai-agent-stats-note { font-size: 0.74em; opacity: 0.45; line-height: 1.4; padding: 2px 2px 0; }

      .ai-agent-stats-reset {
        margin-top: 6px; align-self: center; background: transparent; border: none;
        color: #ff8a80; font-size: 0.82em; padding: 10px; opacity: 0.85;
      }
      .ai-agent-stats-reset:active { opacity: 1; }
    `;
    document.head.appendChild($style);

    const sideBarApps = acode.require("sidebarApps");
    const SIDEBAR_ICON_CLASS = "ai-agent-sidebar-icon";

    // Acode adds this string directly as a CSS class (via classList), not as an
    // image URL — that's why passing a raw URL previously threw and silently
    // fell back to the generic "file" icon. Instead we define a class here
    // that paints the bundled icon.png as a background-image, and register
    // that class name.
    $style.textContent += `
      .icon.${SIDEBAR_ICON_CLASS} {
        background-image: url('${baseUrl}icon.png');
        background-size: 20px 20px;
        background-repeat: no-repeat;
        background-position: center;
      }
    `;

    try {
      sideBarApps.add(
        SIDEBAR_ICON_CLASS,
        PLUGIN_ID,
        "AI Agent",
        (container) => buildUI(container),
        false,
        () => {}
      );
    } catch (e) {
      console.warn("AI Agent: custom sidebar icon failed, falling back to built-in icon", e);
      sideBarApps.add(
        "file", // known-safe built-in Acode icon class
        PLUGIN_ID,
        "AI Agent",
        (container) => buildUI(container),
        false,
        () => {}
      );
    }
  });

  acode.setPluginUnmount(PLUGIN_ID, () => {
    const sideBarApps = acode.require("sidebarApps");
    sideBarApps.remove(PLUGIN_ID);
    $style?.remove();
  });
}
