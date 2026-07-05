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

const PLUGIN_ID = "com.example.ai-agent";
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
};

let history = []; // { role: "user"|"assistant", content: string }
let selectedFolderUrl = null; // url of the addedFolder entry the AI is scoped to

const ICON_SETTINGS = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const ICON_FOLDER_ADD = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`;

// Quick-fill presets for popular OpenAI-compatible APIs. Groq, DeepSeek, and
// MiniMax speak the exact same /chat/completions wire format as OpenAI, and
// Google now ships an official OpenAI-compatible endpoint for Gemini too, so
// all of these can go through the existing "openai" provider path — no new
// request/response parsing needed, just a different base URL + model name.
const OPENAI_COMPATIBLE_PRESETS = {
  custom: { label: "Custom / other", endpoint: "", model: "" },
  openai: { label: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  groq: { label: "Groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  deepseek: { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash" },
  gemini: { label: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.5-flash" },
  minimax: { label: "MiniMax", endpoint: "https://api.minimax.io/v1/chat/completions", model: "MiniMax-M3" },
};

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
    appendProjectStatus("Added and scoped to:", match.title || result.name);
    await announceProjectFiles();
  } catch (e) {
    // user cancelled the picker, or it's genuinely unavailable
    appendMessage("system", `Folder selection was cancelled or unavailable: ${e.message}`);
  }
}

function openFolderPicker() {
  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay";

  const existingRows = (window.addedFolder || [])
    .map(
      (f) => `
      <button class="ai-agent-folder-row" data-url="${encodeURIComponent(f.url)}">
        ${f.title || f.url}${normalizeUrl(selectedFolderUrl) === normalizeUrl(f.url) ? " ✓" : ""}
      </button>`
    )
    .join("");

  overlay.innerHTML = `
    <div class="ai-agent-settings-card">
      <h3>Project folder</h3>
      <button id="ai-agent-add-project" class="ai-agent-folder-row ai-agent-add-project-row">+ Add Project (browse device)</button>
      ${existingRows}
      <div class="ai-agent-settings-buttons">
        <button id="ai-agent-folder-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#ai-agent-add-project").onclick = async () => {
    overlay.remove();
    await addNewProject();
  };
  overlay.querySelectorAll(".ai-agent-folder-row[data-url]").forEach((btn) => {
    btn.onclick = async () => {
      const url = decodeURIComponent(btn.dataset.url);
      const root = findFolderEntry(url);
      if (!root) {
        appendMessage("system", "That folder is no longer available. Try picking it again.");
        overlay.remove();
        return;
      }
      selectedFolderUrl = root.url;
      appendProjectStatus("AI now scoped to:", root.title || root.url);
      overlay.remove();
      await announceProjectFiles();
    };
  });
  overlay.querySelector("#ai-agent-folder-cancel").onclick = () => overlay.remove();
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
    "- Only include actions you actually want performed. Use an empty array if none.",
    "- Keep 'message' short; it is shown directly to the user.",
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
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2, stream: true }),
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
    }
  }
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
    }
  }
  return full;
}

async function streamAI(userText, onChunk) {
  return config.provider === "anthropic"
    ? streamAnthropic(userText, onChunk)
    : streamOpenAICompatible(userText, onChunk);
}

function parseAIResponse(raw) {
  // Be forgiving: strip code fences if the model added them anyway.
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { message: raw, actions: [] };
  }
}

// ---------- File action execution ----------

async function executeAction(action) {
  const fs = acode.require("fs");
  const { type, path, content } = action;
  const { fullUrl } = resolveSafePath(path);

  switch (type) {
    case "read_file": {
      const f = await fs(fullUrl);
      const text = await f.readFile("utf8");
      return { ok: true, detail: `Read ${path} (${text.length} chars)` };
    }
    case "write_file": {
      const f = await fs(fullUrl);
      if (await f.exists()) {
        await f.writeFile(content ?? "");
      } else {
        const parentUrl = fullUrl.substring(0, fullUrl.lastIndexOf("/"));
        const name = fullUrl.substring(fullUrl.lastIndexOf("/") + 1);
        const parent = await fs(parentUrl);
        await parent.createFile(name, content ?? "");
      }
      refreshOpenEditorIfMatches(fullUrl, content ?? "");
      return { ok: true, detail: `Wrote ${path}` };
    }
    case "create_file": {
      const parentUrl = fullUrl.substring(0, fullUrl.lastIndexOf("/"));
      const name = fullUrl.substring(fullUrl.lastIndexOf("/") + 1);
      const parent = await fs(parentUrl);
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
    statusTextEl.textContent = "";
    return;
  }
  statusEl.style.display = "flex";
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

function appendActionsBlock(actions) {
  const wrap = document.createElement("div");
  wrap.className = "ai-agent-actions";

  actions.forEach((action) => {
    const row = document.createElement("div");
    row.className = "ai-agent-action-row";

    const label = document.createElement("span");
    label.textContent = `${action.type}: ${action.path}`;
    row.appendChild(label);

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
        appendMessage("system", `Error: ${e.message}`);
      }
    };
    row.appendChild(btn);
    wrap.appendChild(row);
  });

  chatLogEl.appendChild(wrap);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

async function handleSend() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!config.apiKey) {
    appendMessage("system", "Set your API key first (tap the gear icon).");
    return;
  }
  inputEl.value = "";
  autoGrowInput();
  appendMessage("user", text);

  const startedAt = Date.now();
  let raw = "";

  const tick = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const { preview, actionCount } = extractLiveInfo(raw);
    let line = raw ? "Writing response" : "Contacting API";
    if (actionCount > 0) {
      line += ` · drafting ${actionCount} file action${actionCount > 1 ? "s" : ""}`;
    } else if (preview) {
      line += ` · "${preview.slice(-48)}"`;
    }
    line += ` · ${secs}s`;
    setStatus(line);
  };

  setStatus("Contacting API");
  const timer = setInterval(tick, 200);

  try {
    try {
      raw = await streamAI(text, (fullSoFar) => {
        raw = fullSoFar;
        tick();
      });
    } catch (streamErr) {
      // Endpoint may not support server-sent streaming — fall back quietly.
      raw = await callAI(text);
    }

    const parsed = parseAIResponse(raw);
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: raw });

    appendMessage("assistant", parsed.message || "(no message)");

    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    if (actions.length > 0) {
      if (config.autoApply) {
        for (const action of actions) {
          if (action.type === "delete_file") {
            appendActionsBlock([action]); // deletes always require a manual tap
          } else {
            try {
              const result = await executeAction(action);
              appendMessage("system", result.detail);
            } catch (e) {
              appendMessage("system", `Error: ${e.message}`);
            }
          }
        }
      } else {
        appendActionsBlock(actions);
      }
    }
  } catch (e) {
    appendMessage("system", `Error: ${e.message}`);
  } finally {
    clearInterval(timer);
    setStatus("");
  }
}

function openSettingsDialog() {
  const overlay = document.createElement("div");
  overlay.className = "ai-agent-overlay";
  overlay.innerHTML = `
    <div class="ai-agent-settings-card">
      <h3>AI Agent Settings</h3>
      <label>Quick preset (optional)</label>
      <select id="ai-agent-preset">
        <option value="custom">Choose a provider preset…</option>
        <option value="openai">OpenAI</option>
        <option value="groq">Groq</option>
        <option value="deepseek">DeepSeek</option>
        <option value="gemini">Google Gemini</option>
        <option value="minimax">MiniMax</option>
      </select>
      <label>Provider</label>
      <select id="ai-agent-provider">
        <option value="openai" ${config.provider === "openai" ? "selected" : ""}>OpenAI-compatible (covers OpenAI, Groq, DeepSeek, Gemini, MiniMax, etc.)</option>
        <option value="anthropic" ${config.provider === "anthropic" ? "selected" : ""}>Anthropic (Claude)</option>
      </select>
      <label>Endpoint URL</label>
      <p class="ai-agent-hint">The web address this app sends your messages to — basically "which AI service to talk to." Pick a preset above to fill this in automatically, or paste your own OpenAI-compatible URL.</p>
      <input id="ai-agent-endpoint" type="text" value="${config.endpoint}" />
      <label>API Key</label>
      <input id="ai-agent-key" type="password" value="${config.apiKey}" />
      <label>Model</label>
      <input id="ai-agent-model" type="text" value="${config.model}" />
      <label class="ai-agent-checkbox-row">
        <input id="ai-agent-autoapply" type="checkbox" ${config.autoApply ? "checked" : ""} />
        Auto-apply writes/creates (deletes always ask)
      </label>
      <div class="ai-agent-settings-buttons">
        <button id="ai-agent-cancel">Cancel</button>
        <button id="ai-agent-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#ai-agent-preset").onchange = (e) => {
    const preset = OPENAI_COMPATIBLE_PRESETS[e.target.value];
    if (!preset || e.target.value === "custom") return;
    overlay.querySelector("#ai-agent-provider").value = "openai";
    overlay.querySelector("#ai-agent-endpoint").value = preset.endpoint;
    overlay.querySelector("#ai-agent-model").value = preset.model;
  };

  overlay.querySelector("#ai-agent-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#ai-agent-save").onclick = async () => {
    config.provider = overlay.querySelector("#ai-agent-provider").value;
    config.endpoint = overlay.querySelector("#ai-agent-endpoint").value.trim();
    config.apiKey = overlay.querySelector("#ai-agent-key").value.trim();
    config.model = overlay.querySelector("#ai-agent-model").value.trim();
    config.autoApply = overlay.querySelector("#ai-agent-autoapply").checked;
    await saveConfig();
    overlay.remove();
    appendMessage("system", "Settings saved.");
  };
}

function autoGrowInput() {
  inputEl.style.height = "auto";
  const maxHeight = window.innerHeight * 0.4;
  inputEl.style.height = Math.min(inputEl.scrollHeight, maxHeight) + "px";
}

function buildUI(container) {
  containerEl = container;
  container.classList.add("ai-agent-container");
  container.innerHTML = `
    <div class="ai-agent-header">
      <span>AI Agent</span>
      <div class="ai-agent-header-actions">
        <button id="ai-agent-folder-btn" class="ai-agent-icon-btn" title="Project folder">${ICON_FOLDER_ADD}</button>
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
  container.querySelector("#ai-agent-send-btn").onclick = handleSend;
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  inputEl.addEventListener("input", autoGrowInput);

  const root = getRootFolder();
  if (root) {
    appendProjectStatus("Connected to project:", root.title || root.url);
  } else {
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
        background: rgba(255,180,80,0.12);
        font-size: 0.85em;
        font-style: italic;
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
      .ai-agent-actions { border-top: 1px dashed var(--border-color, #555); margin-top: 4px; padding-top: 4px; width: 100%; align-self: stretch; }
      .ai-agent-action-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 0.85em; }
      .ai-agent-action-row button { margin-left: 6px; }
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
      .ai-agent-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999; }
      .ai-agent-settings-card { background: var(--bg-color, #222); color: var(--text-color, #eee); padding: 16px; border-radius: 8px; width: 85vw; max-width: 400px; display: flex; flex-direction: column; gap: 6px; }
      .ai-agent-settings-card input, .ai-agent-settings-card select { padding: 6px; }
      .ai-agent-checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 0.9em; }
      .ai-agent-hint { font-size: 0.8em; opacity: 0.7; margin: 0 0 2px; line-height: 1.3; }
      .ai-agent-settings-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      .ai-agent-folder-row { display: block; width: 100%; text-align: left; padding: 8px; margin-bottom: 4px; border-radius: 6px; background: rgba(255,255,255,0.06); border: none; color: inherit; }
      .ai-agent-folder-row:active { background: rgba(255,255,255,0.15); }
      .ai-agent-add-project-row { background: rgba(90,160,255,0.25); font-weight: bold; margin-bottom: 10px; }
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
