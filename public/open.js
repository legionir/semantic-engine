"use strict";

/*
|--------------------------------------------------------------------------
| Semantic Engine — Open / Configure Project wizard
|--------------------------------------------------------------------------
| باز کردن پروژه، انتخاب مسیر، نحوهٔ اسکن، مدل embedding، اتصال provider،
| دریافت خودکار مدل‌ها، انتخاب مدل، مدل پیش‌فرض و شروع ایندکس‌سازی با
| نمایش زندهٔ پیشرفت (SSE).
*/

const $ = id => document.getElementById(id);

const state = {
  token: "",
  path: "",
  projectId: null,
  projectStatus: null,
  providers: [],
  localModels: [],
  localModel: "hashing-256",
  modelsTimer: null,
  settings: null,
  jobId: null,
  sse: null,
};

// ── token handling ──────────────────────────────────────────────────────
function loadToken() {
  const q = new URLSearchParams(location.search);
  const fromQuery = q.get("token");
  const stored = localStorage.getItem("se.token") || "";
  state.token = fromQuery || stored || "";
  $("tokenInput").value = state.token;
  if (fromQuery) localStorage.setItem("se.token", fromQuery);
}

function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (state.token) h["Authorization"] = "Bearer " + state.token;
  return h;
}

async function api(method, path, body) {
  const opts = { method, headers: authHeaders(body ? { "Content-Type": "application/json" } : {}) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || (res.status + " " + res.statusText);
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// ── status / health ─────────────────────────────────────────────────────
async function checkHealth() {
  try {
    await api("GET", "/health");
    setStatus("done", "connected");
  } catch (e) {
    setStatus("failed", "connection failed");
  }
}
function setStatus(cls, text) {
  const dot = $("statusDot");
  dot.className = "dot " + cls;
  $("statusText").textContent = text;
}

// ── file browser ────────────────────────────────────────────────────────
async function browse(path) {
  const url = "/api/v1/fs/browse" + (path ? "?path=" + encodeURIComponent(path) : "");
  const data = await api("GET", url);
  $("browser").hidden = false;
  $("browserPath").textContent = data.path;
  $("browser").dataset.current = data.path;
  $("browser").dataset.parent = data.parent || "";
  const list = $("browserList");
  list.innerHTML = "";
  for (const entry of data.entries) {
    const li = document.createElement("li");
    if (!entry.isDirectory) li.className = "file";
    const icon = document.createElement("span");
    icon.className = "entry-icon";
    icon.textContent = entry.isDirectory ? "📁" : "📄";
    const name = document.createElement("span");
    name.textContent = entry.name;
    li.appendChild(icon);
    li.appendChild(name);
    if (entry.hint) {
      const hint = document.createElement("span");
      hint.className = "entry-hint " + entry.hint;
      hint.textContent = entry.hint === "indexed" ? "indexed" : "project";
      li.appendChild(hint);
    }
    if (entry.isDirectory) {
      li.addEventListener("click", () => browse(entry.path));
    }
    list.appendChild(li);
  }
}

// ── provider / models ───────────────────────────────────────────────────
async function loadProviders() {
  try {
    const data = await api("GET", "/api/v1/providers");
    state.providers = data.providers || [];
    state.localModels = data.localModels || [];
    const sel = $("providerSelect");
    sel.innerHTML = "";
    for (const p of state.providers) {
      const opt = document.createElement("option");
      opt.value = p.kind;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    applyProvider();
  } catch (e) {
    log("bad", "Could not load providers: " + e.message);
  }
}

function currentProvider() {
  const kind = $("providerSelect").value;
  return state.providers.find(p => p.kind === kind) || null;
}

function applyProvider() {
  const p = currentProvider();
  if (!p) return;
  const isLocal = p.kind === "local";
  $("baseUrlField").hidden = !p.needsBaseUrl;
  $("apiKeyField").hidden = !p.acceptsApiKey;
  $("localModelsGroup").hidden = !isLocal;
  $("remoteModelsGroup").hidden = isLocal;
  if (p.defaultBaseUrl && !$("baseUrlInput").value) $("baseUrlInput").value = p.defaultBaseUrl;
  $("providerHint").textContent = p.description + " · default model: " + p.defaultModel;

  if (isLocal) {
    loadLocalModels();
  } else {
    $("modelSelect").innerHTML = '<option value="">— connect to load models —</option>';
    $("fetchStatus").textContent = "";
  }
}

function fillModels(models, defaultModel) {
  const sel = $("modelSelect");
  sel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name + (m.dimensions ? " (" + m.dimensions + "d)" : "") + (m.description ? " — " + m.description : "");
    if (m.id === defaultModel || m.isDefault) opt.dataset.default = "1";
    sel.appendChild(opt);
  }
  // انتخاب مدل پیش‌فرض
  const def = models.find(m => m.id === defaultModel) || models.find(m => m.isDefault) || models[0];
  if (def) sel.value = def.id;
  syncDefaultModelToggle();
}

// ── local embedding models: list, download, choose ─────────────────────
function formatBytes(n) {
  if (!n) return "0 MB";
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
}

async function loadLocalModels() {
  try {
    const data = await api("GET", "/api/v1/models/local");
    state.localModels = data.models || [];
    $("modelsDirNote").textContent = data.modelsDir ? "stored in " + data.modelsDir : "";
    const notice = $("runtimeNotice");
    const needsRuntime = state.localModels.some(m => !m.builtIn && m.status === "ready");
    notice.hidden = data.runtimeInstalled || !needsRuntime;
    if (!notice.hidden) {
      notice.innerHTML = "Downloaded models need the optional runtime. Run <code>npm install @xenova/transformers</code> in the semantic-engine folder and restart.";
    }
    // یک مدل انتخاب‌شدهٔ ناآماده نباید بماند.
    const chosen = state.localModels.find(m => m.id === state.localModel);
    // A saved choice that is still downloading must survive (Save-as-defaults would overwrite it).
    if (state.localModels.length && (!chosen || (chosen.status !== "ready" && chosen.status !== "downloading"))) {
      state.localModel = "hashing-256";
    }
    renderLocalModels();
    const busy = state.localModels.some(m => m.status === "downloading");
    clearTimeout(state.modelsTimer);
    if (busy) state.modelsTimer = setTimeout(loadLocalModels, 1000);
  } catch (e) {
    $("localModelList").innerHTML = "";
    log("bad", "Could not load local models: " + e.message);
    // A transient error must not stop download progress for good.
    clearTimeout(state.modelsTimer);
    if (state.localModels.some(m => m.status === "downloading")) state.modelsTimer = setTimeout(loadLocalModels, 3000);
  }
}

function renderLocalModels() {
  const list = $("localModelList");
  list.innerHTML = "";
  for (const m of state.localModels) {
    const li = document.createElement("li");
    li.className = "model-item" + (m.id === state.localModel ? " selected" : "");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "localModel";
    radio.checked = m.id === state.localModel;
    radio.disabled = m.status !== "ready";
    radio.setAttribute("aria-label", "Use " + m.name);
    radio.addEventListener("change", () => { state.localModel = m.id; renderLocalModels(); });
    li.appendChild(radio);

    const name = document.createElement("div");
    name.className = "model-name";
    name.textContent = m.name;
    const badge = document.createElement("span");
    badge.className = "badge " + (m.status === "ready" ? "ready" : m.status === "failed" ? "failed" : "missing");
    badge.textContent = m.builtIn ? "built in" : m.status === "ready" ? "downloaded" : m.status;
    name.appendChild(badge);
    li.appendChild(name);

    const action = document.createElement("div");
    action.className = "model-action";
    if (!m.builtIn && m.status === "downloading") {
      const t = document.createElement("span");
      t.className = "muted";
      t.textContent = formatBytes(m.receivedBytes) + " / " + formatBytes(m.totalBytes);
      action.appendChild(t);
    } else if (!m.builtIn && m.status !== "ready") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn small";
      b.textContent = m.status === "failed" ? "Retry download" : "Download";
      b.addEventListener("click", () => downloadModel(m.id));
      action.appendChild(b);
    } else if (!m.builtIn) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn ghost small";
      b.textContent = "Remove";
      b.addEventListener("click", () => removeModel(m.id));
      action.appendChild(b);
    }
    li.appendChild(action);

    const meta = document.createElement("div");
    meta.className = "model-meta";
    meta.textContent = m.dimensions + "d · " + m.languages + (m.sizeMb ? " · ~" + m.sizeMb + " MB" : "") + " — " + m.description;
    li.appendChild(meta);

    if (m.status === "downloading") {
      const bar = document.createElement("div");
      bar.className = "model-progress";
      const fill = document.createElement("div");
      const pct = m.totalBytes ? Math.min(100, (m.receivedBytes / m.totalBytes) * 100) : 0;
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      li.appendChild(bar);
    }
    if (m.status === "failed" && m.error) {
      const err = document.createElement("div");
      err.className = "model-error";
      err.textContent = m.error;
      li.appendChild(err);
    }
    list.appendChild(li);
  }
}

async function downloadModel(id) {
  try {
    await api("POST", "/api/v1/models/local/download", { id });
    log("info", "Downloading " + id);
    loadLocalModels();
  } catch (e) {
    log("bad", "Could not start download: " + e.message);
  }
}

async function removeModel(id) {
  try {
    await api("POST", "/api/v1/models/local/remove", { id });
    if (state.localModel === id) state.localModel = "hashing-256";
    loadLocalModels();
  } catch (e) {
    log("bad", "Could not remove model: " + e.message);
  }
}

async function fetchModels() {
  const p = currentProvider();
  if (!p) return;
  const btn = $("fetchModelsBtn");
  btn.disabled = true;
  $("fetchStatus").textContent = "Connecting…";
  try {
    const body = { provider: p.kind };
    if (p.needsBaseUrl) body.baseUrl = $("baseUrlInput").value.trim();
    if (p.acceptsApiKey && $("apiKeyInput").value) body.apiKey = $("apiKeyInput").value;
    const result = await api("POST", "/api/v1/providers/models", body);
    if (!result.connected) throw new Error(result.error || "connection failed");
    fillModels(result.models, result.defaultModel);
    $("fetchStatus").textContent = result.models.length + " models loaded (default: " + result.defaultModel + ")";
  } catch (e) {
    $("fetchStatus").textContent = "✗ " + e.message;
  } finally {
    btn.disabled = false;
  }
}

function syncDefaultModelToggle() {
  const useDefault = $("useDefaultModel").checked;
  $("modelSelect").disabled = useDefault;
}

// ── project selection ───────────────────────────────────────────────────
/*
| SE-UI-001 — a project switch must leave NO trace of the previous project.
| Previously a failed POST /projects kept state.projectId, the badge and the
| visualizer link pointing at the OLD project — so "Start indexing" would
| index the project the user believed they had left, and the dashboard link
| opened the wrong project. A successfully-opened but not-yet-indexed project
| also kept the old visualizer href. Now the selection is reset to a coherent
| "no project" state on failure, and the visualizer link is hidden whenever
| the current project is not ready.
*/
function clearProjectSelection() {
  state.projectId = null;
  state.projectStatus = null;
  state.jobId = null;
  const badge = $("projStatusBadge");
  badge.textContent = "no project";
  badge.className = "badge missing";
  $("selectedProject").hidden = true;
  $("startIndexBtn").disabled = true;
  $("gotoVisualizerBtn").hidden = true;
  $("gotoVisualizerBtn").removeAttribute("href");
}

async function selectProject(path) {
  state.path = path;
  $("pathInput").value = path;
  // the previous selection is invalid the moment a new switch starts
  clearProjectSelection();
  try {
    const project = await api("POST", "/api/v1/projects", { path });
    state.projectId = project.id;
    state.projectStatus = project.status;
    $("selectedProject").hidden = false;
    $("selectedPathCode").textContent = project.rootPath;
    const badge = $("projStatusBadge");
    badge.textContent = project.status === "ready" ? "indexed" : "not indexed";
    badge.className = "badge " + (project.status === "ready" ? "ready" : "missing");
    $("startIndexBtn").disabled = false;
    if (project.status === "ready") {
      $("gotoVisualizerBtn").hidden = false;
      $("gotoVisualizerBtn").href = "/visualizer.html?project=" + encodeURIComponent(project.id);
    }
    log("ok", "Project opened: " + project.rootPath + " (" + project.status + ")");
    showProjectPaths(project.id);
  } catch (e) {
    clearProjectSelection();
    log("bad", "Could not open project: " + e.message + " — no project is selected");
  }
}

async function showProjectPaths(id) {
  try {
    const detail = await api("GET", "/api/v1/projects/" + encodeURIComponent(id));
    $("indexPathCode").textContent = detail.indexPath || "";
    $("pathsInfo").hidden = false;
  } catch { /* the path list is informational */ }
}

// ── settings file (<data dir>/config.json) ──────────────────────────────
function applySettings(view) {
  state.settings = view;
  const c = view.config;
  $("configPathCode").textContent = view.configPath;
  $("modelsDirCode").textContent = view.modelsDir;
  $("pathsInfo").hidden = false;

  $("scanEngine").value = c.scan.treeSitter ? "tree-sitter" : "heuristic";
  $("useGitignore").checked = c.scan.useGitignore;
  $("skipHidden").checked = c.scan.skipHiddenDirectories;
  $("maxDepth").value = c.scan.maxDepth;
  $("maxFileSize").value = c.scan.maxFileSizeMb;
  $("extraIgnore").value = (c.scan.additionalIgnorePatterns || []).join(", ");
  $("wantBlueprint").checked = c.scan.blueprint;
  $("wantLspDiagnostics").checked = c.scan.lspDiagnostics;

  $("embeddingEnabled").checked = c.embedding.enabled;
  $("embeddingConfig").hidden = !c.embedding.enabled;
  $("normalizeVectors").checked = c.embedding.normalize;
  $("useDefaultModel").checked = c.embedding.useDefaultModel;
  if (c.embedding.provider === "local" && c.embedding.model) state.localModel = c.embedding.model;
  if (c.embedding.baseUrl) $("baseUrlInput").value = c.embedding.baseUrl;
  if ([...$("providerSelect").options].some(o => o.value === c.embedding.provider)) {
    $("providerSelect").value = c.embedding.provider;
    applyProvider();
  }

  if (c.chat.baseUrl) $("llmBaseUrl").value = c.chat.baseUrl;
  if (c.chat.model) $("llmModelSelect").value = c.chat.model;
  $("llmTemp").value = c.chat.temperature;
}

async function loadSettings() {
  try {
    const view = await api("GET", "/api/v1/settings");
    applySettings(view);
    // پوشهٔ سروری که با آن اجرا شده، همان‌جا انتخاب می‌شود.
    if (view.workspaceRoot && !$("pathInput").value) selectProject(view.workspaceRoot);
  } catch (e) {
    // بدون data dir (حالت تست) فایل تنظیمات وجود ندارد؛ پنل با پیش‌فرض‌های داخلی کار می‌کند.
    try {
      const cfg = await api("GET", "/api/v1/config");
      if (cfg.projectsRoot && !$("pathInput").value) selectProject(cfg.projectsRoot);
    } catch { /* not connected yet */ }
  }
}

function collectSettingsPatch() {
  const p = currentProvider();
  const provider = p ? p.kind : "local";
  const hashing = state.localModel === "hashing-256";
  const useDefault = provider === "local" ? hashing : $("useDefaultModel").checked;
  const model = provider === "local" ? state.localModel : ($("modelSelect").value || "");
  return {
    scan: {
      treeSitter: $("scanEngine").value === "tree-sitter",
      useGitignore: $("useGitignore").checked,
      skipHiddenDirectories: $("skipHidden").checked,
      maxDepth: parseInt($("maxDepth").value, 10) || 0,
      maxFileSizeMb: parseFloat($("maxFileSize").value) || 5,
      additionalIgnorePatterns: $("extraIgnore").value.split(",").map(x => x.trim()).filter(Boolean),
      blueprint: $("wantBlueprint").checked,
      lspDiagnostics: $("wantLspDiagnostics").checked,
    },
    embedding: {
      enabled: $("embeddingEnabled").checked,
      provider,
      model,
      useDefaultModel: useDefault,
      baseUrl: p && p.needsBaseUrl ? $("baseUrlInput").value.trim() : "",
      normalize: $("normalizeVectors").checked,
    },
  };
}

async function saveDefaults() {
  $("defaultsStatus").textContent = "Saving…";
  try {
    const view = await api("PUT", "/api/v1/settings", collectSettingsPatch());
    state.settings = view;
    $("defaultsStatus").textContent = "Saved to " + view.configPath;
  } catch (e) {
    $("defaultsStatus").textContent = "✗ " + e.message;
  }
}

// ── indexing ────────────────────────────────────────────────────────────
function collectIndexOptions() {
  const extra = $("extraIgnore").value.split(",").map(s => s.trim()).filter(Boolean);
  const embeddingEnabled = $("embeddingEnabled").checked;
  const p = currentProvider();
  const body = {
    scan: {
      treeSitter: $("scanEngine").value === "tree-sitter",
      useGitignore: $("useGitignore").checked,
      skipHiddenDirectories: $("skipHidden").checked,
      maxDepth: parseInt($("maxDepth").value, 10) || 0,
      maxFileSizeMb: parseFloat($("maxFileSize").value) || 5,
      additionalIgnorePatterns: extra,
    },
    output: {
      blueprint: $("wantBlueprint").checked,
    },
    lsp: { diagnostics: $("wantLspDiagnostics")?.checked === true },
    embedding: { enabled: false },
  };
  if (embeddingEnabled && p) {
    const isLocal = p.kind === "local";
    const hashing = state.localModel === "hashing-256";
    const useDefault = isLocal ? hashing : $("useDefaultModel").checked;
    body.embedding = {
      enabled: true,
      provider: p.kind,
      useDefaultModel: useDefault,
      model: useDefault ? "" : (isLocal ? state.localModel : $("modelSelect").value),
      normalize: $("normalizeVectors").checked,
    };
    if (p.needsBaseUrl) body.embedding.baseUrl = $("baseUrlInput").value.trim();
    if (p.acceptsApiKey && $("apiKeyInput").value) body.embedding.apiKey = $("apiKeyInput").value;
  }
  return body;
}

async function startIndex() {
  if (!state.projectId) return;
  const body = collectIndexOptions();
  $("startIndexBtn").disabled = true;
  $("progressWrap").hidden = false;
  setProgress("Queued…", 0);
  openEvents(state.projectId);
  try {
    const res = await api("POST", "/api/v1/projects/" + state.projectId + "/index", body);
    state.jobId = res.jobId;
    $("cancelIndexBtn").hidden = false;
    log("info", "Indexing started (job " + res.jobId + ")");
    if (res.options && res.options.embedding) {
      log("info", "embedding: " + res.options.embedding.provider + " · model " + (res.options.embedding.model || "default"));
    }
    pollJob();
  } catch (e) {
    log("bad", "Could not start indexing: " + e.message);
    $("startIndexBtn").disabled = false;
  }
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const job = await api("GET", "/api/v1/projects/" + state.projectId + "/jobs/" + state.jobId);
    setProgress(phaseLabel(job.phase), job.progress);
    if (job.status === "completed") {
      onJobDone(job);
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      log("bad", "job " + job.status + (job.error ? ": " + job.error : ""));
      $("startIndexBtn").disabled = false;
      $("cancelIndexBtn").hidden = true;
      setStatus("failed", "indexing failed");
      return;
    }
    setTimeout(pollJob, 900);
  } catch (e) {
    log("bad", "Could not read job status: " + e.message);
    setTimeout(pollJob, 1500);
  }
}

function onJobDone(job) {
  setProgress("Done", 100);
  $("cancelIndexBtn").hidden = true;
  const r = job.result || {};
  log("ok", "Indexing complete — files: " + (r.files ?? "?") + " · symbols: " + (r.symbols ?? "?") +
    (r.vectorChunks ? " · chunks: " + r.vectorChunks : "") +
    (r.embeddingModel ? " · model: " + r.embeddingModel : ""));
  $("gotoVisualizerBtn").hidden = false;
  $("gotoVisualizerBtn").href = "/visualizer.html?project=" + encodeURIComponent(state.projectId);
  $("startIndexBtn").disabled = false;
  const badge = $("projStatusBadge");
  badge.textContent = "indexed"; badge.className = "badge ready";
}

async function cancelIndex() {
  if (!state.jobId) return;
  try {
    await api("POST", "/api/v1/projects/" + state.projectId + "/jobs/" + state.jobId + "/cancel");
    log("info", "Cancellation requested");
  } catch (e) {
    log("bad", "Could not cancel: " + e.message);
  }
}

// SSE stream (real-time progress; poll is the fallback)
function openEvents(projectId) {
  if (state.sse) { state.sse.close(); state.sse = null; }
  try {
    const url = "/api/v1/projects/" + projectId + "/events" + (state.token ? "?token=" + encodeURIComponent(state.token) : "");
    const es = new EventSource(url);
    es.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type && msg.type.startsWith("job.") && msg.data) {
          setProgress(phaseLabel(msg.data.phase), msg.data.progress || 0);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* poll covers us */ };
    state.sse = es;
  } catch { /* EventSource unsupported → poll only */ }
}

// ── ui helpers ──────────────────────────────────────────────────────────
function phaseLabel(phase) {
  const map = {
    init: "starting", scanning: "scanning files", parsing: "parsing",
    symbols: "extracting symbols", graphs: "building graphs",
    finalizing: "finalizing", done: "done",
  };
  return map[phase] || phase || "…";
}
function setProgress(phase, pct) {
  $("progressPhase").textContent = phase;
  $("progressPct").textContent = Math.round(pct) + "%";
  $("progressFill").style.width = Math.round(pct) + "%";
  setStatus(pct >= 100 ? "done" : "running", phase);
}
function log(cls, text) {
  const el = $("jobLog");
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = new Date().toLocaleTimeString() + "  " + text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ── events wiring ───────────────────────────────────────────────────────
function bind() {
  $("saveTokenBtn").addEventListener("click", () => {
    state.token = $("tokenInput").value.trim();
    localStorage.setItem("se.token", state.token);
    checkHealth();
    loadProviders().then(loadSettings);
    log("info", "Token saved");
  });
  $("tokenInput").addEventListener("input", () => { state.token = $("tokenInput").value.trim(); });

  $("browseBtn").addEventListener("click", () => browse($("pathInput").value.trim() || ""));
  $("closeBrowserBtn").addEventListener("click", () => { $("browser").hidden = true; });
  $("upBtn").addEventListener("click", () => {
    const parent = $("browser").dataset.parent;
    if (parent) browse(parent);
  });
  $("selectDirBtn").addEventListener("click", () => {
    const current = $("browser").dataset.current;
    if (current) { selectProject(current); $("browser").hidden = true; }
  });
  $("useCwdBtn").addEventListener("click", async () => {
    try {
      const data = await api("GET", "/api/v1/fs/browse");
      selectProject(data.cwd || data.path);
    } catch (e) { log("bad", e.message); }
  });
  $("pathInput").addEventListener("keydown", e => {
    if (e.key === "Enter") selectProject($("pathInput").value.trim());
  });

  $("providerSelect").addEventListener("change", applyProvider);
  $("fetchModelsBtn").addEventListener("click", fetchModels);
  $("useDefaultModel").addEventListener("change", syncDefaultModelToggle);
  $("embeddingEnabled").addEventListener("change", () => {
    $("embeddingConfig").hidden = !$("embeddingEnabled").checked;
  });

  $("saveDefaultsBtn").addEventListener("click", saveDefaults);
  $("startIndexBtn").addEventListener("click", startIndex);
  $("cancelIndexBtn").addEventListener("click", cancelIndex);

  // LLM (chat) config
  $("llmFetchBtn").addEventListener("click", fetchLlmModels);
  $("llmSaveBtn").addEventListener("click", saveLlm);
}

// ── LLM (chat) settings ─────────────────────────────────────────────────
async function loadLlmConfig() {
  try {
    const cfg = await api("GET", "/api/v1/chat/llm");
    if (cfg.configured) {
      $("llmBaseUrl").value = cfg.baseUrl || "";
      if (cfg.model) $("llmModelSelect").value = cfg.model;
      if (typeof cfg.temperature === "number") $("llmTemp").value = cfg.temperature;
      $("llmSaveStatus").textContent = "Current model: " + cfg.model;
    }
  } catch { /* ignore */ }
}

async function fetchLlmModels() {
  const btn = $("llmFetchBtn");
  btn.disabled = true;
  $("llmFetchStatus").textContent = "Connecting…";
  try {
    const body = { baseUrl: $("llmBaseUrl").value.trim() };
    if ($("llmApiKey").value) body.apiKey = $("llmApiKey").value;
    const result = await api("POST", "/api/v1/chat/llm/test", body);
    if (!result.connected) throw new Error(result.error || "connection failed");
    const list = $("llmModelList");
    list.innerHTML = "";
    for (const m of result.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      list.appendChild(opt);
    }
    // فقط اگر کاربر خودش چیزی تایپ نکرده، مدل پیش‌فرض را بگذار
    if (!$("llmModelSelect").value && result.defaultModel) {
      $("llmModelSelect").value = result.defaultModel;
    }
    $("llmFetchStatus").textContent = result.models.length + " models loaded";
  } catch (e) {
    // دریافت خودکار اختیاری است — راهنمایی کن که مدل را دستی وارد کند
    $("llmFetchStatus").textContent = "Could not load models (" + e.message + ") — type the model name manually and save.";
  } finally {
    btn.disabled = false;
  }
}

async function saveLlm() {
  const baseUrl = $("llmBaseUrl").value.trim();
  const model = $("llmModelSelect").value.trim();
  if (!baseUrl || !model) {
    $("llmSaveStatus").textContent = "Base URL and model name are required";
    return;
  }
  try {
    const body = { baseUrl, model, temperature: parseFloat($("llmTemp").value) || 0.2 };
    if ($("llmApiKey").value) body.apiKey = $("llmApiKey").value;
    const cfg = await api("PUT", "/api/v1/chat/llm", body);
    $("llmSaveStatus").textContent = "Saved — model: " + cfg.model;
    try {
      await api("PUT", "/api/v1/settings", { chat: { baseUrl, model, temperature: body.temperature } });
    } catch { /* the endpoint works for this session even if the file cannot be written */ }
  } catch (e) {
    $("llmSaveStatus").textContent = "✗ " + e.message;
  }
}

function init() {
  loadToken();
  bind();
  checkHealth();
  loadProviders().then(loadSettings);
  loadLlmConfig();
  // اگر با #llm آمده‌ایم، به بخش LLM اسکرول کن
  if (location.hash === "#llm") {
    setTimeout(() => $("cardLlm")?.scrollIntoView({ behavior: "smooth" }), 300);
  }
}

init();
