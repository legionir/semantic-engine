"use strict";

/*
|--------------------------------------------------------------------------
| Project Intelligence Visualizer Client
|--------------------------------------------------------------------------
|
| Handles Level of Detail (LoD) graph rendering, progressive drill-down,
| focus mode, search-to-graph highlights, and the 360° Symbol Inspector.
|--------------------------------------------------------------------------
*/

const params = new URLSearchParams(location.search);
const AUTH_TOKEN = params.get("token") || localStorage.getItem("se.token") || "";
function seHeaders() {
  return AUTH_TOKEN ? { Authorization: "Bearer " + AUTH_TOKEN } : {};
}
function withToken(url) {
  if (!AUTH_TOKEN) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(AUTH_TOKEN);
}

const state = {
  currentView: "architecture",
  projectId: params.get("project") || "current",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  focusDepth: 2,
  depthLimited: false, // آیا depth روی گراف اعمال شود (بعد از انتخاب نود)
  resolvedOnly: false,
  zoom: { scale: 1, panX: 0, panY: 0 },
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  chatHistory: [],
  viewState: "empty",
  viewReason: "",
  previewEnabled: params.get("preview") === "1",
};

// وقتی true باشد، auto-arrange مختصات ذخیره‌شدهٔ نودها را نادیده می‌گیرد و از نو می‌چیند.
let opts_reset = false;

// DOM Elements
const svg = document.getElementById("graphSvg");
const container = document.getElementById("canvasContainer");
const nodeCountEl = document.getElementById("nodeCount");
const edgeCountEl = document.getElementById("edgeCount");
const projectTitleEl = document.getElementById("projectTitle");

// Inspector Elements
const inspectorSidebar = document.getElementById("inspectorSidebar");
const inspectorDetails = document.getElementById("inspectorDetails");
const emptyHint = document.querySelector(".empty-hint");
const inspType = document.getElementById("inspType");
const inspTitle = document.getElementById("inspTitle");
/*
| بخش‌های Identity/Location/Metrics حالا داینامیک ساخته می‌شوند، پس
| ارجاع ثابت به تک‌تک فیلدها لازم نیست؛ نگه داشتنشان یعنی پنج
| `getElementById` که همیشه null برمی‌گردانند.
*/
const inspSignature = document.getElementById("inspSignature");
const inspConnections = document.getElementById("inspConnections");
const inspTests = document.getElementById("inspTests");

// Search Elements
const searchInput = document.getElementById("graphSearch");
const searchDropdown = document.getElementById("searchResults");

// Initialize
function init() {
  bindEvents();
  loadView("architecture");
}

function bindEvents() {
  // View Switcher
  document.querySelectorAll(".view-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.currentView = tab.dataset.view;
      loadView(state.currentView);
    });
  });

  // Focus depth — حالا واقعاً گراف را به N هاپ از نود انتخاب‌شده محدود می‌کند
  document.getElementById("focusDepth").addEventListener("change", e => {
    state.focusDepth = parseInt(e.target.value, 10) || 2;
    state.depthLimited = Boolean(state.selectedNodeId);
    layoutAndRender({ centerId: state.selectedNodeId });
  });

  // Resolved only checkbox — یال‌های کم‌اعتماد را از گراف حذف می‌کند و دوباره می‌چیند
  document.getElementById("filterResolvedOnly").addEventListener("change", e => {
    state.resolvedOnly = e.target.checked;
    layoutAndRender({ centerId: state.selectedNodeId });
  });

  // Fit & Reset & Auto-Arrange
  document.getElementById("fitGraphBtn").addEventListener("click", fitGraph);
  document.getElementById("resetFocusBtn").addEventListener("click", resetFocus);
  document.getElementById("autoArrangeBtn").addEventListener("click", () => {
    // pin ها را پاک کن و از نو بچین
    state.nodes.forEach(n => { n._pinned = false; });
    opts_reset = true;
    layoutAndRender({ centerId: state.selectedNodeId });
    opts_reset = false;
  });

  // Inspector close
  document.getElementById("closeInspectorBtn").addEventListener("click", () => {
    resetFocus();
  });

  // Pan & Zoom
  container.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  container.addEventListener("wheel", onWheel, { passive: false });

  // Search
  searchInput.addEventListener("input", onSearchInput);
  document.addEventListener("click", e => {
    if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
      searchDropdown.hidden = true;
    }
  });

  // Inspector Action buttons
  document.getElementById("btnExploreNeighborhood").addEventListener("click", () => {
    if (!state.selectedNodeId) return;
    // محدود کردن گراف به همسایگی نود انتخاب‌شده و چیدن دور آن
    state.depthLimited = true;
    layoutAndRender({ centerId: state.selectedNodeId });
  });

  document.getElementById("btnAnalyzeImpact").addEventListener("click", () => {
    if (state.selectedNodeId) analyzeImpact(state.selectedNodeId);
  });

  document.getElementById("btnAiExplain").addEventListener("click", () => {
    if (state.selectedNodeId) aiExplainNode(state.selectedNodeId);
  });

  // AI Chat panel
  document.getElementById("aiChatToggle").addEventListener("click", toggleChat);
  document.getElementById("aiChatClose").addEventListener("click", () => setChatOpen(false));

  /*
  | Escape هم پنل را می‌بندد. تا وقتی تمرکز داخل textarea است،
  | کاربر انتظار دارد کلید فرار کار کند و دستش از کیبورد جدا نشود.
  */
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;

    const panel = document.getElementById("aiChatPanel");
    if (panel && !panel.hidden) {
      setChatOpen(false);
      event.preventDefault();
    }
  });
  document.getElementById("aiChatSend").addEventListener("click", sendChat);
  document.getElementById("aiChatInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

// ── Data Fetching ────────────────────────────────────────────────────────

// نگاشت تب‌های نما به اندپوینت‌های واقعی platform (SE-UI-08).
// قبلاً به `/api/graph/*` می‌زد که اصلاً وجود ندارد و همیشه به دادهٔ
// ساختگیِ کلاینت سقوط می‌کرد؛ حالا از ایندکس واقعی می‌خواند.
// هر تب به یک نمای واقعاً متفاوت از بک‌اند وصل می‌شود (SE-VIZ-02).
const VIEW_ENDPOINTS = {
  architecture: id => `/api/v1/projects/${id}/visualization/architecture`,   // ماژول‌محور
  module: id => `/api/v1/projects/${id}/visualization/architecture`,          // ماژول‌ها + drill
  dependencies: id => `/api/v1/projects/${id}/visualization/dependencies`,    // فایل‌محور کامل
  workflow: id => `/api/v1/projects/${id}/visualization/business-mapping`,    // جریان‌ها/بیزنس
  "business-mapping": id => `/api/v1/projects/${id}/visualization/business-mapping`,
  "test-intelligence": id => `/api/v1/projects/${id}/visualization/test-map`,
  impact: id => `/api/v1/projects/${id}/visualization/dependencies`,          // پایه برای impact روی نود
  hotspots: id => `/api/v1/projects/${id}/visualization/dependencies`,
};

async function loadView(viewType) {
  projectTitleEl.textContent = `Loading ${viewType} view…`;
  updateBreadcrumb(viewType);

  // Preview data is deliberately opt-in and visibly labelled; it is never a
  // fallback for an empty or failed project request.
  if (state.previewEnabled) {
    generateFallbackData(viewType);
    state.viewState = "preview";
    state.viewReason = "Preview only — this is not project data.";
    projectTitleEl.textContent = `${state.projectId} · ${viewType} · PREVIEW ONLY`;
    return;
  }

  const build = VIEW_ENDPOINTS[viewType] || VIEW_ENDPOINTS.architecture;
  try {
    const res = await fetch(withToken(build(state.projectId)), { headers: seHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.state === "failed") throw new Error(data.reason || `HTTP ${res.status}`);
    setGraphData(data.nodes || [], data.edges || []);
    const total = (data.nodes || []).length;
    state.viewState = data.state || (total > 0 ? "ready" : "empty");
    state.viewReason = data.reason || (total > 0 ? "" : "No indexed graph data is available.");
    projectTitleEl.textContent = total > 0
      ? `${state.projectId} · ${viewType}`
      : `${state.projectId} — no data (is the project indexed?)`;
    showViewState(state.viewState, state.viewReason);
  } catch (err) {
    setGraphData([], []);
    state.viewState = "failed";
    state.viewReason = err instanceof Error ? err.message : String(err);
    projectTitleEl.textContent = `${state.projectId} — visualization unavailable`;
    showViewState("failed", state.viewReason);
  }
}

async function loadNeighborhood(nodeId) {
  try {
    const res = await fetch(withToken(`/api/v1/projects/${state.projectId}/visualization/neighborhood`), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, seHeaders()),
      body: JSON.stringify({ seedId: nodeId, depth: state.focusDepth }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.state === "failed") throw new Error(data.reason || `HTTP ${res.status}`);
    setGraphData(data.nodes || [], data.edges || []);
    showViewState(data.state || (data.nodes?.length ? "ready" : "empty"), data.reason);
    selectNode(nodeId);
  } catch (error) {
    setGraphData([], []);
    showViewState("failed", error instanceof Error ? error.message : String(error));
  }
}

async function loadImpact(nodeId) {
  try {
    const res = await fetch(withToken(`/api/v1/projects/${state.projectId}/analysis/impact`), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, seHeaders()),
      body: JSON.stringify({ symbolId: nodeId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.state === "failed") throw new Error(data.reason || `HTTP ${res.status}`);
    setGraphData(data.nodes || [], data.edges || []);
    showViewState(data.state || (data.nodes?.length ? "ready" : "empty"), data.reason);
    selectNode(nodeId);
  } catch (error) {
    setGraphData([], []);
    showViewState("failed", error instanceof Error ? error.message : String(error));
  }
}

function showViewState(viewState, reason) {
  state.viewState = viewState;
  state.viewReason = reason || "";
  const message = reason ? `${viewState}: ${reason}` : viewState;
  // The existing title is the least surprising status surface and works with
  // the current HTML without inventing a graph sample.
  if (viewState !== "ready" && viewState !== "preview") {
    projectTitleEl.textContent = message;
  }
}

function setGraphData(nodes, edges) {
  state.nodes = nodes;
  state.edges = edges;
  state.selectedNodeId = null;
  state.depthLimited = false;
  nodeCountEl.textContent = nodes.length;
  edgeCountEl.textContent = edges.length;
  // نمای جدید = چیدمان تازه
  opts_reset = true;
  layoutAndRender({ fit: true });
  opts_reset = false;
}

function updateBreadcrumb(viewType) {
  document.querySelectorAll(".lod-step").forEach(s => s.classList.remove("active"));
  if (viewType === "architecture") document.getElementById("lodStep1").classList.add("active");
  else if (viewType === "module") document.getElementById("lodStep2").classList.add("active");
  else if (viewType === "dependencies") document.getElementById("lodStep3").classList.add("active");
  else document.getElementById("lodStep4").classList.add("active");
}

// ── Graph Layout & Rendering ──────────────────────────────────────────────

// کدام نودها با توجه به depth و resolvedOnly واقعاً نمایش داده می‌شوند.
function visibleGraph() {
  let edges = state.edges;
  if (state.resolvedOnly) {
    edges = edges.filter(e => (e.metadata?.confidence ?? 100) >= 70);
  }

  let nodes = state.nodes;
  // depth فقط وقتی معنا دارد که نودی انتخاب شده باشد: نودهای تا N هاپ
  // از نود انتخاب‌شده را نگه می‌داریم (فیلتر واقعی روی گراف).
  if (state.selectedNodeId && state.depthLimited) {
    const keep = new Set([state.selectedNodeId]);
    let frontier = [state.selectedNodeId];
    for (let d = 0; d < state.focusDepth; d++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of edges) {
          if (e.source === cur && !keep.has(e.target)) { keep.add(e.target); next.push(e.target); }
          if (e.target === cur && !keep.has(e.source)) { keep.add(e.source); next.push(e.source); }
        }
      }
      frontier = next;
    }
    nodes = nodes.filter(n => keep.has(n.id));
    edges = edges.filter(e => keep.has(e.source) && keep.has(e.target));
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  edges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { nodes, edges };
}

function layoutAndRender(opts = {}) {
  autoArrange(opts.centerId || state.selectedNodeId || null);
  renderGraph();
  if (opts.fit !== false) fitGraph();
}

/**
 * چیدمان حرفه‌ای force-directed: دافعهٔ بین همهٔ نودها + فنر روی یال‌ها
 * + کششِ ملایم به مرکز. اگر یک نودِ hub داده شود، آن را در مرکز میخ
 * می‌کنیم و بقیه دورش می‌چینند (SE-VIZ-03).
 */
function autoArrange(hubId) {
  const { nodes, edges } = visibleGraph();
  if (nodes.length === 0) return;

  // The canvas grows with the node count: a fixed 1200x800 cannot hold 160x60 module boxes without overlap.
  const side = Math.ceil(Math.sqrt(nodes.length));
  const W = Math.max(1200, side * 260), H = Math.max(800, side * 170), cx = W / 2, cy = H / 2;

  // چیدمان اولیهٔ دایره‌ای (قطعی) تا هر بار یکسان شروع شود.
  nodes.forEach((n, i) => {
    if (typeof n.x !== "number" || typeof n.y !== "number" || opts_reset) {
      const a = (i / nodes.length) * Math.PI * 2;
      const r = 40 + (nodes.length > 1 ? 260 : 0);
      n.x = cx + Math.cos(a) * r;
      n.y = cy + Math.sin(a) * r;
      n._pinned = false;
    }
  });

  const byId = new Map(nodes.map(n => [n.id, n]));
  const degree = new Map(nodes.map(n => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // hub: نود انتخاب‌شده یا پرارتباط‌ترین نود
  let hub = hubId && byId.has(hubId) ? hubId : null;
  if (!hub) {
    let best = -1;
    for (const n of nodes) {
      const d = degree.get(n.id) || 0;
      if (d > best) { best = d; hub = n.id; }
    }
  }

  const iterations = nodes.length > 120 ? 120 : 220;
  const k = Math.max(220, Math.sqrt((W * H) / nodes.length) * 0.9); // فاصلهٔ ایده‌آل (≥ عرض یک نود)
  let temp = W / 8;

  for (let it = 0; it < iterations; it++) {
    // دافعه (O(n^2) — برای گراف‌های تا چند صد نود کافی است)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      a._dx = 0; a._dy = 0;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / dist;
        a._dx += (dx / dist) * rep;
        a._dy += (dy / dist) * rep;
      }
    }
    // جاذبهٔ فنری روی یال‌ها
    for (const e of edges) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      let dist = Math.hypot(dx, dy) || 0.01;
      const attr = (dist * dist) / k;
      const fx = (dx / dist) * attr, fy = (dy / dist) * attr;
      a._dx -= fx; a._dy -= fy;
      b._dx += fx; b._dy += fy;
    }
    // اعمال جابه‌جایی با محدودیت دما + کشش به مرکز
    for (const n of nodes) {
      if (n.id === hub) continue; // hub ثابت می‌ماند
      if (n._pinned) continue;     // نودی که کاربر جابه‌جا کرده
      const disp = Math.hypot(n._dx, n._dy) || 0.01;
      n.x += (n._dx / disp) * Math.min(disp, temp);
      n.y += (n._dy / disp) * Math.min(disp, temp);
      // کشش ملایم به مرکز تا گراف پخش نشود
      n.x += (cx - n.x) * 0.01;
      n.y += (cy - n.y) * 0.01;
    }
    temp *= 0.96;
  }

  // Separate boxes that still overlap after the force pass (nodes are up to 170x70 with a margin).
  const BOX_W = 180, BOX_H = 80;
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = BOX_W - Math.abs(dx), oy = BOX_H - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        // Push along the axis with the smaller overlap; fixed nodes (hub, pinned) do not move.
        const aFixed = a.id === hub || a._pinned, bFixed = b.id === hub || b._pinned;
        if (aFixed && bFixed) continue;
        const shareA = aFixed ? 0 : (bFixed ? 1 : 0.5), shareB = bFixed ? 0 : (aFixed ? 1 : 0.5);
        if (ox < oy) {
          const dir = dx >= 0 ? 1 : -1;
          a.x -= dir * ox * shareA; b.x += dir * ox * shareB;
        } else {
          const dir = dy >= 0 ? 1 : -1;
          a.y -= dir * oy * shareA; b.y += dir * oy * shareB;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  // hub دقیقاً وسط
  if (hub && byId.has(hub)) {
    const h = byId.get(hub);
    const ox = cx - h.x, oy = cy - h.y;
    for (const n of nodes) { n.x += ox; n.y += oy; }
  }
}

function renderGraph() {
  svg.innerHTML = "";

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("id", "viewport");
  g.setAttribute("transform", `translate(${state.zoom.panX}, ${state.zoom.panY}) scale(${state.zoom.scale})`);

  const view = visibleGraph();
  nodeCountEl.textContent = view.nodes.length;
  edgeCountEl.textContent = view.edges.length;
  const nodeById = new Map(view.nodes.map(n => [n.id, n]));

  // Render Edges
  view.edges.forEach(edge => {
    const src = nodeById.get(edge.source);
    const tgt = nodeById.get(edge.target);
    if (!src || !tgt) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const isSolid = (edge.metadata?.confidence || 100) >= 70;
    path.setAttribute("class", `graph-edge ${isSolid ? "solid" : "dashed"}`);
    path.setAttribute("data-source", edge.source);
    path.setAttribute("data-target", edge.target);

    const d = `M ${src.x} ${src.y} Q ${(src.x + tgt.x) / 2} ${(src.y + tgt.y) / 2 - 20} ${tgt.x} ${tgt.y}`;
    path.setAttribute("d", d);
    g.appendChild(path);
  });

  // Render Nodes
  view.nodes.forEach(node => {
    const nodeG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodeG.setAttribute("class", `graph-node type-${node.type}`);
    nodeG.setAttribute("id", `node-${node.id}`);
    nodeG.setAttribute("transform", `translate(${node.x}, ${node.y})`);

    let shape;
    if (node.type === "module") {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      shape.setAttribute("x", "-80");
      shape.setAttribute("y", "-30");
      shape.setAttribute("width", "160");
      shape.setAttribute("height", "60");
      shape.setAttribute("rx", "8");
      shape.setAttribute("fill", "#1c2128");
      shape.setAttribute("stroke", "#8957e5");
    } else if (node.type === "api") {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      shape.setAttribute("points", "-60,-24 60,-24 75,0 60,24 -60,24 -75,0");
      shape.setAttribute("fill", "#1c2128");
      shape.setAttribute("stroke", "#d29922");
    } else if (node.type === "workflow") {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      shape.setAttribute("points", "0,-30 70,0 0,30 -70,0");
      shape.setAttribute("fill", "#1c2128");
      shape.setAttribute("stroke", "#db6d28");
    } else {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      shape.setAttribute("x", "-70");
      shape.setAttribute("y", "-22");
      shape.setAttribute("width", "140");
      shape.setAttribute("height", "44");
      shape.setAttribute("rx", node.type === "class" ? "12" : "4");
      shape.setAttribute("fill", "#161b22");
      shape.setAttribute("stroke", node.type === "class" ? "#2ea043" : "#388bfd");
    }

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = truncate(node.label, 18);

    nodeG.appendChild(shape);
    nodeG.appendChild(text);

    nodeG.addEventListener("dblclick", e => {
      e.stopPropagation();
      drillDown(node);
    });

    // درگ نود (SE-VIZ-04): با گرفتن و کشیدن، نود جابه‌جا و pin می‌شود.
    nodeG.addEventListener("mousedown", e => {
      e.stopPropagation();
      startNodeDrag(node, e, nodeG);
    });

    g.appendChild(nodeG);
  });

  svg.appendChild(g);
}

// ── Node dragging ─────────────────────────────────────────────────────────
function startNodeDrag(node, e, nodeG) {
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  let moved = false;
  nodeG.classList.add("dragging");

  const onMove = ev => {
    const dx = (ev.clientX - startX) / state.zoom.scale;
    const dy = (ev.clientY - startY) / state.zoom.scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    node.x = origX + dx;
    node.y = origY + dy;
    node._pinned = true; // دیگر توسط auto-arrange جابه‌جا نشود
    nodeG.setAttribute("transform", `translate(${node.x}, ${node.y})`);
    updateEdgesFor(node.id);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    nodeG.classList.remove("dragging");
    if (!moved) selectNode(node.id); // کلیک ساده = انتخاب
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// بازکشیدن یال‌های متصل به یک نود هنگام درگ (بدون رندر کامل).
function updateEdgesFor(nodeId) {
  const view = visibleGraph();
  const byId = new Map(view.nodes.map(n => [n.id, n]));
  document.querySelectorAll(".graph-edge").forEach(el => {
    const s = el.getAttribute("data-source"), t = el.getAttribute("data-target");
    if (s !== nodeId && t !== nodeId) return;
    const src = byId.get(s), tgt = byId.get(t);
    if (!src || !tgt) return;
    el.setAttribute("d", `M ${src.x} ${src.y} Q ${(src.x + tgt.x) / 2} ${(src.y + tgt.y) / 2 - 20} ${tgt.x} ${tgt.y}`);
  });
}

// ── Interaction, Focus Mode & Inspector ──────────────────────────────────

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;

  applyFocusMode(nodeId);
  openInspector(node);
  // نودِ انتخاب‌شده را با یک انیمیشن نرم به مرکز بیاور
  centerNode(node);
}

function applyFocusMode(nodeId) {
  // Find nodes within focusDepth
  const neighborIds = new Set([nodeId]);
  let frontier = [nodeId];

  for (let d = 0; d < state.focusDepth; d++) {
    const nextFrontier = [];
    frontier.forEach(curr => {
      state.edges.forEach(edge => {
        if (edge.source === curr && !neighborIds.has(edge.target)) {
          neighborIds.add(edge.target);
          nextFrontier.push(edge.target);
        }
        if (edge.target === curr && !neighborIds.has(edge.source)) {
          neighborIds.add(edge.source);
          nextFrontier.push(edge.source);
        }
      });
    });
    frontier = nextFrontier;
  }

  // Update SVG classes
  document.querySelectorAll(".graph-node").forEach(el => {
    const id = el.id.replace(/^node-/, "");
    if (id === nodeId) {
      el.classList.add("focused");
      el.classList.remove("dimmed");
    } else if (neighborIds.has(id)) {
      el.classList.remove("focused", "dimmed");
    } else {
      el.classList.remove("focused");
      el.classList.add("dimmed");
    }
  });

  document.querySelectorAll(".graph-edge").forEach(el => {
    const src = el.getAttribute("data-source");
    const tgt = el.getAttribute("data-target");
    if (neighborIds.has(src) && neighborIds.has(tgt)) {
      el.classList.remove("dimmed");
      if (src === nodeId || tgt === nodeId) el.classList.add("active");
      else el.classList.remove("active");
    } else {
      el.classList.add("dimmed");
      el.classList.remove("active");
    }
  });
}

function resetFocus() {
  const wasLimited = state.depthLimited;
  state.selectedNodeId = null;
  state.depthLimited = false;
  emptyHint.hidden = false;
  inspectorDetails.hidden = true;
  inspTitle.textContent = "Select a node";
  const box = document.getElementById("aiExplainBox");
  if (box) box.hidden = true;
  // اگر گراف محدود شده بود، کل نمای فعلی را دوباره بساز
  if (wasLimited) {
    layoutAndRender({ fit: true });
  } else {
    document.querySelectorAll(".graph-node").forEach(el => el.classList.remove("focused", "dimmed"));
    document.querySelectorAll(".graph-edge").forEach(el => el.classList.remove("active", "dimmed"));
  }
}

/*
| نمایش هر چیزی که دربارهٔ یک نود می‌دانیم.
|
| نسخهٔ قبلی شش فیلد ثابت را نشان می‌داد و بقیهٔ metadata ای که
| بک‌اند فرستاده بود دور ریخته می‌شد — و بدتر، بخش «Covering Tests»
| یک نام فایل *می‌ساخت* (`${label}.test.ts`) که هیچ‌جا وجود نداشت.
| حالا هر چه هست نمایش داده می‌شود و چیزی از خودمان درنمی‌آوریم.
*/

const FRIENDLY_LABELS = {
  path: "File",
  language: "Language",
  role: "Role",
  line: "Line",
  endLine: "End line",
  complexity: "Cyclomatic complexity",
  referencesCount: "References",
  importance: "Importance",
  isEntryPoint: "Entry point",
  exported: "Exported",
  kind: "Kind",
  size: "Size",
  lines: "Lines",
  hash: "Content hash",
  modified: "Last modified",
  testFile: "Is a test file",
  generated: "Generated",
  confidence: "Confidence",
  symbolCount: "Symbols",
  loc: "Lines of code",
};

/* کلیدهایی که جای اختصاصی خودشان را دارند و در «All Metadata» تکرار نمی‌شوند. */
const PROMOTED_KEYS = new Set([
  "path", "line", "endLine", "complexity", "referencesCount", "importance",
]);

function humanLabel(key) {
  if (FRIENDLY_LABELS[key]) return FRIENDLY_LABELS[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, c => c.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function addFact(list, key, value, { code = false } = {}) {
  const dt = document.createElement("dt");
  dt.textContent = humanLabel(key);

  const dd = document.createElement("dd");
  const text = formatValue(value);

  if (code) {
    const el = document.createElement("code");
    el.textContent = text;
    dd.appendChild(el);
  } else {
    dd.textContent = text;
  }

  if (text === "—") dd.classList.add("muted");

  list.append(dt, dd);
}

function openInspector(node) {
  emptyHint.hidden = true;
  inspectorDetails.hidden = false;

  const meta = node.metadata || {};

  inspType.textContent = node.type;
  inspType.className = `node-type-badge ${node.type}`;
  inspTitle.textContent = node.label;
  inspTitle.title = node.label;

  /* ── Identity ───────────────────────────────────────────────── */
  const identity = document.getElementById("inspIdentity");
  identity.innerHTML = "";
  addFact(identity, "Name", node.label);
  addFact(identity, "Type", node.type);
  addFact(identity, "id", node.id, { code: true });
  if (node.parentId) addFact(identity, "Parent", node.parentId, { code: true });
  if (meta.kind) addFact(identity, "kind", meta.kind);
  if (meta.language) addFact(identity, "language", meta.language);
  if (meta.role) addFact(identity, "role", meta.role);

  /* ── Location ───────────────────────────────────────────────── */
  const location = document.getElementById("inspLocation");
  location.innerHTML = "";
  addFact(location, "path", meta.path || "—", { code: Boolean(meta.path) });
  if (meta.line) {
    const end = meta.endLine && meta.endLine !== meta.line ? `–${meta.endLine}` : "";
    addFact(location, "Range", `Line ${meta.line}${end}`);
  } else {
    addFact(location, "Range", "—");
  }

  /* ── Metrics — only the ones that actually exist ─────────────── */
  const metrics = document.getElementById("inspMetrics");
  metrics.innerHTML = "";

  const metricDefs = [
    ["complexity", meta.complexity],
    ["referencesCount", meta.referencesCount],
    ["importance", meta.importance],
    ["confidence", meta.confidence],
    ["lines", meta.lines],
    ["symbolCount", meta.symbolCount],
  ].filter(([, v]) => v !== undefined && v !== null);

  document.getElementById("inspMetricsSection").hidden = metricDefs.length === 0;

  for (const [key, value] of metricDefs) {
    const card = document.createElement("div");
    card.className = "metric-card";

    const val = document.createElement("span");
    val.className = "metric-val";
    val.textContent = key === "confidence" ? `${value}%` : String(value);

    const lbl = document.createElement("span");
    lbl.className = "metric-lbl";
    lbl.textContent = humanLabel(key);

    card.append(val, lbl);
    metrics.appendChild(card);
  }

  /* ── Signature ──────────────────────────────────────────────── */
  inspSignature.textContent = meta.signature
    ? meta.signature
    : meta.path
      ? `${node.type} ${node.label}\n// ${meta.path}${meta.line ? `:${meta.line}` : ""}`
      : `${node.type} ${node.label}`;

  /* ── Relationships — grouped, and every one of them ─────────── */
  inspConnections.innerHTML = "";
  const connections = state.edges.filter(e => e.source === node.id || e.target === node.id);
  document.getElementById("inspConnCount").textContent =
    connections.length ? String(connections.length) : "";

  if (connections.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No connections in the current view";
    inspConnections.appendChild(li);
  } else {
    for (const edge of connections) {
      const isOut = edge.source === node.id;
      const otherId = isOut ? edge.target : edge.source;
      const other = state.nodes.find(n => n.id === otherId);

      const li = document.createElement("li");
      li.className = "insp-conn";

      const dir = document.createElement("span");
      dir.className = `conn-dir ${isOut ? "out" : "in"}`;
      dir.textContent = isOut ? "→" : "←";

      const rel = document.createElement("span");
      rel.className = "conn-rel";
      rel.textContent = (edge.relation || "related").replace(/_/g, " ");

      const name = document.createElement("span");
      name.className = "conn-name";
      name.textContent = other ? other.label : otherId;
      name.title = other && other.metadata?.path ? other.metadata.path : otherId;

      li.append(dir, rel, name);

      const confidence = edge.metadata?.confidence;
      if (typeof confidence === "number" && confidence < 100) {
        const badge = document.createElement("span");
        badge.className = "conn-confidence";
        badge.textContent = `${confidence}%`;
        li.appendChild(badge);
      }

      /* کلیک روی یک همسایه، همان نود را انتخاب می‌کند. */
      if (other) {
        li.classList.add("clickable");
        li.addEventListener("click", () => {
          selectNode(other.id);
          centerNode(other);
        });
      }

      inspConnections.appendChild(li);
    }
  }

  /* ── Covering tests — only what the index really reports ────── */
  inspTests.innerHTML = "";
  const tests = Array.isArray(meta.tests) ? meta.tests : [];

  if (tests.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = meta.testFile
      ? "This file is itself a test"
      : "No covering tests reported by the index";
    inspTests.appendChild(li);
  } else {
    for (const test of tests) {
      const li = document.createElement("li");
      li.textContent = typeof test === "string" ? test : test.path || test.name || String(test);
      inspTests.appendChild(li);
    }
  }

  /* ── Everything else, so nothing is silently dropped ────────── */
  const raw = document.getElementById("inspRaw");
  raw.innerHTML = "";

  const remaining = Object.entries(meta).filter(
    ([key, value]) =>
      !PROMOTED_KEYS.has(key) &&
      key !== "tests" &&
      key !== "signature" &&
      value !== undefined &&
      value !== null &&
      value !== ""
  );

  document.getElementById("inspRawSection").hidden = remaining.length === 0;
  document.getElementById("inspRawCount").textContent =
    remaining.length ? String(remaining.length) : "";

  for (const [key, value] of remaining) {
    addFact(raw, key, value, { code: key.toLowerCase().includes("hash") });
  }
}

function drillDown(node) {
  if (node.type === "module") {
    loadView("module");
  } else if (node.type === "file") {
    loadView("dependencies");
  } else {
    loadNeighborhood(node.id);
  }
}

// ── Search-to-Graph ──────────────────────────────────────────────────────

async function onSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  if (q.length < 2) {
    searchDropdown.hidden = true;
    return;
  }

  const matches = state.nodes.filter(n => n.label.toLowerCase().includes(q) || (n.metadata?.path && n.metadata.path.toLowerCase().includes(q)));

  searchDropdown.innerHTML = "";
  if (matches.length === 0) {
    searchDropdown.innerHTML = "<div class='search-item muted'>No symbols or files found</div>";
  } else {
    matches.slice(0, 8).forEach(node => {
      const item = document.createElement("div");
      item.className = "search-item";
      /*
      | label و type از محتوای مخزن می‌آیند. یک نام سمبل مثل
      | `<img src=x onerror=...>` این‌جا اجرا می‌شد و توکن را از
      | localStorage برمی‌داشت.
      */
      item.innerHTML = `<span>${escapeHtml(node.label)}</span><span class="search-item-kind">${escapeHtml(node.type)}</span>`;
      item.addEventListener("click", () => {
        searchDropdown.hidden = true;
        searchInput.value = node.label;
        selectNode(node.id);
        centerNode(node);
      });
      searchDropdown.appendChild(item);
    });
  }
  searchDropdown.hidden = false;
}

// ── Pan, Zoom & Viewport Math ────────────────────────────────────────────

function centerNode(node) {
  const rect = container.getBoundingClientRect();
  state.zoom.panX = rect.width / 2 - node.x * state.zoom.scale;
  state.zoom.panY = rect.height / 2 - node.y * state.zoom.scale;
  updateViewportTransform();
}

function fitGraph() {
  if (state.nodes.length === 0) return;
  const rect = container.getBoundingClientRect();
  const minX = Math.min(...state.nodes.map(n => n.x)) - 100;
  const maxX = Math.max(...state.nodes.map(n => n.x)) + 100;
  const minY = Math.min(...state.nodes.map(n => n.y)) - 100;
  const maxY = Math.max(...state.nodes.map(n => n.y)) + 100;

  const w = maxX - minX;
  const h = maxY - minY;
  const scale = Math.min(1.2, Math.max(0.4, Math.min(rect.width / w, rect.height / h)));

  state.zoom.scale = scale;
  state.zoom.panX = (rect.width - w * scale) / 2 - minX * scale;
  state.zoom.panY = (rect.height - h * scale) / 2 - minY * scale;
  updateViewportTransform();
}

function updateViewportTransform() {
  const vp = document.getElementById("viewport");
  if (vp) {
    vp.setAttribute("transform", `translate(${state.zoom.panX}, ${state.zoom.panY}) scale(${state.zoom.scale})`);
  }
}

function onMouseDown(e) {
  if (e.target.closest(".graph-node")) return;
  state.isDragging = true;
  state.dragStart = { x: e.clientX - state.zoom.panX, y: e.clientY - state.zoom.panY };
}

function onMouseMove(e) {
  if (!state.isDragging) return;
  state.zoom.panX = e.clientX - state.dragStart.x;
  state.zoom.panY = e.clientY - state.dragStart.y;
  updateViewportTransform();
}

function onMouseUp() {
  state.isDragging = false;
}

function onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.min(2.5, Math.max(0.2, state.zoom.scale * delta));

  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  state.zoom.panX = mouseX - (mouseX - state.zoom.panX) * (newScale / state.zoom.scale);
  state.zoom.panY = mouseY - (mouseY - state.zoom.panY) * (newScale / state.zoom.scale);
  state.zoom.scale = newScale;

  updateViewportTransform();
}

function truncate(str, len = 20) {
  if (!str) return "";
  return str.length <= len ? str : str.slice(0, len - 1) + "…";
}

// ── Impact analysis (SE-VIZ-05) ──────────────────────────────────────────
async function analyzeImpact(nodeId) {
  const box = document.getElementById("aiExplainBox");
  box.hidden = false;
  box.classList.add("loading");
  box.textContent = "Analyzing impact radius…";
  try {
    const res = await fetch(withToken(`/api/v1/projects/${state.projectId}/impact`), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, seHeaders()),
      body: JSON.stringify({ symbol: nodeId, maxDepth: state.focusDepth }),
    });
    const data = await res.json();
    box.classList.remove("loading");
    const affected = data.affected || data.items || data.impactedSymbols || [];
    if (Array.isArray(affected) && affected.length) {
      // SE-VIZ-05 honesty: a capped page is not the whole impact radius.
      const capNote = data.truncated
        ? ` ≥${data.candidateCount ?? "?"} total`
        : "";
      box.innerHTML = `<strong>Impact radius (${affected.length}${capNote}):</strong>\n` +
        affected
          .slice(0, 25)
          .map(a => "• " + escapeHtml(a.name || a.label || a.id || JSON.stringify(a)))
          .join("\n") +
        (data.truncated ? "\n… more dependents exist beyond this page." : "");
    } else {
      box.textContent = data.targetType === "module"
        ? "No indexed dependents were found for this module."
        : data.targetType === "package"
          ? "No indexed dependents were found for this package."
          : "No indexed dependents were found for this node.";
    }
  } catch (e) {
    box.classList.remove("loading");
    box.textContent = "Impact analysis failed: " + e.message;
  }
}

// ── AI explain a node (SE-CHAT-01) ────────────────────────────────────────
async function aiExplainNode(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  const box = document.getElementById("aiExplainBox");
  box.hidden = false;
  box.classList.add("loading");
  box.textContent = "Analyzing this node…";
  const label = node ? node.label : nodeId;
  const hint = node && node.metadata?.path ? ` (file: ${node.metadata.path})` : "";
  try {
    const data = await chatRequest(
      `Explain this node: "${label}"${hint}. Describe its role, responsibility, dependencies and anything notable, based on the index tools.`
    );
    box.classList.remove("loading");
    box.textContent = data.reply || "No response received.";
  } catch (e) {
    box.classList.remove("loading");
    box.innerHTML = "AI explanation failed: " + escapeHtml(e.message) +
      `\n<a href="/open.html#llm" target="_blank" rel="noopener" style="color:var(--accent)">Configure an LLM model</a>`;
  }
}

// ── AI Chat ───────────────────────────────────────────────────────────────
function setChatOpen(open) {
  const panel = document.getElementById("aiChatPanel");
  const toggle = document.getElementById("aiChatToggle");

  panel.hidden = !open;

  /*
  | دکمهٔ هدر باید بگوید پنل باز است یا نه؛ بدون این، تنها راه
  | فهمیدنش نگاه کردن به خود پنل است.
  */
  if (toggle) toggle.classList.toggle("active", open);

  return open;
}

async function toggleChat() {
  const panel = document.getElementById("aiChatPanel");
  const open = setChatOpen(panel.hidden);

  if (open) {
    await refreshChatModel();
    document.getElementById("aiChatInput").focus();
  }
}

async function refreshChatModel() {
  try {
    const res = await fetch("/api/v1/chat/llm", { headers: seHeaders() });
    const cfg = await res.json();
    document.getElementById("aiChatModel").textContent = cfg.configured
      ? `Model: ${cfg.model}`
      : "No model configured — Settings → LLM";
  } catch { /* ignore */ }
}

async function chatRequest(message) {
  const res = await fetch(withToken(`/api/v1/projects/${state.projectId}/chat`), {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, seHeaders()),
    body: JSON.stringify({ message, history: state.chatHistory.slice(-8) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function sendChat() {
  const input = document.getElementById("aiChatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addChatMsg("user", text);
  state.chatHistory.push({ role: "user", content: text });

  const thinking = addChatMsg("assistant thinking", "Thinking, and calling index tools…");
  try {
    const data = await chatRequest(text);
    thinking.remove();
    const msg = addChatMsg("assistant", data.reply || "No response received.");
    if (data.toolTrace && data.toolTrace.length) {
      const tr = document.createElement("div");
      tr.className = "tool-trace";
      tr.textContent = "Tools: " + data.toolTrace.map(t => t.tool + (t.ok ? " ✓" : " ✗")).join(", ");
      msg.appendChild(tr);
    }
    state.chatHistory.push({ role: "assistant", content: data.reply || "" });
  } catch (e) {
    thinking.remove();
    addChatMsg("error", e.message + "\nConfigure a model in Settings → LLM.");
  }
}

function addChatMsg(cls, text) {
  const body = document.getElementById("aiChatBody");
  const el = document.createElement("div");
  el.className = "ai-msg " + cls;
  el.textContent = text;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function escapeHtml(s) {
  /*
  | نقل‌قول‌ها هم فرار داده می‌شوند: هر جا این خروجی داخل یک صفت
  | نقل‌قول‌دار بنشیند، بدون آن‌ها می‌شود از صفت بیرون پرید.
  */
  return String(s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ── Fallback Dataset Generator ───────────────────────────────────────────

function generateFallbackData(viewType) {
  let sampleNodes = [
    { id: "mod-auth", type: "module", label: "Auth Module", metadata: { path: "src/auth" } },
    { id: "mod-users", type: "module", label: "Users Module", metadata: { path: "src/users" } },
    { id: "api-login", type: "api", label: "POST /auth/login", metadata: { path: "src/auth/login.ts" } },
    { id: "class-auth-service", type: "class", label: "AuthService", metadata: { path: "src/auth/auth.service.ts", line: 10, endLine: 45, complexity: 4, referencesCount: 12 } },
    { id: "fn-login", type: "function", label: "login()", metadata: { path: "src/auth/auth.service.ts", line: 15, endLine: 35, complexity: 3, referencesCount: 8 } },
    { id: "class-user-repo", type: "class", label: "UserRepository", metadata: { path: "src/users/user.repo.ts", line: 5, endLine: 50, complexity: 2, referencesCount: 18 } },
    { id: "wf-login-flow", type: "workflow", label: "User Login Workflow", metadata: {} },
  ];

  let sampleEdges = [
    { id: "e1", source: "api-login", target: "fn-login", relation: "calls", metadata: { confidence: 95 } },
    { id: "e2", source: "class-auth-service", target: "fn-login", relation: "contains", metadata: { confidence: 100 } },
    { id: "e3", source: "fn-login", target: "class-user-repo", relation: "calls", metadata: { confidence: 90 } },
    { id: "e4", source: "mod-auth", target: "mod-users", relation: "depends_on", metadata: { confidence: 85 } },
    { id: "e5", source: "wf-login-flow", target: "api-login", relation: "executes", metadata: { confidence: 100 } },
  ];

  if (viewType === "business-mapping") {
    sampleNodes = [
      { id: "biz-auth", type: "workflow", label: "Customer Identity", metadata: { role: "business-entity" } },
      { id: "biz-orders", type: "workflow", label: "Order Checkout", metadata: { role: "business-entity" } },
      { id: "api-login", type: "api", label: "POST /auth/login", metadata: { path: "src/auth/login.ts" } },
      { id: "api-checkout", type: "api", label: "POST /orders/checkout", metadata: { path: "src/orders/checkout.ts" } },
      { id: "class-auth-service", type: "class", label: "AuthService", metadata: { path: "src/auth/auth.service.ts" } },
    ];
    sampleEdges = [
      { id: "be1", source: "biz-auth", target: "api-login", relation: "implements", metadata: { confidence: 95 } },
      { id: "be2", source: "biz-orders", target: "api-checkout", relation: "implements", metadata: { confidence: 95 } },
      { id: "be3", source: "api-login", target: "class-auth-service", relation: "calls", metadata: { confidence: 90 } },
    ];
  } else if (viewType === "test-intelligence") {
    sampleNodes = [
      { id: "test-auth", type: "file", label: "auth.service.test.ts", metadata: { role: "test-suite" } },
      { id: "class-auth-service", type: "class", label: "AuthService", metadata: { path: "src/auth/auth.service.ts" } },
      { id: "test-users", type: "file", label: "user.repo.test.ts", metadata: { role: "test-suite" } },
      { id: "class-user-repo", type: "class", label: "UserRepository", metadata: { path: "src/users/user.repo.ts" } },
      { id: "fn-untested", type: "function", label: "legacyMigrate() [Untested]", metadata: { complexity: 8, referencesCount: 2 } },
    ];
    sampleEdges = [
      { id: "te1", source: "test-auth", target: "class-auth-service", relation: "references", metadata: { confidence: 100 } },
      { id: "te2", source: "test-users", target: "class-user-repo", relation: "references", metadata: { confidence: 100 } },
    ];
  } else if (viewType === "hotspots") {
    sampleNodes = [
      { id: "hot-1", type: "file", label: "auth.service.ts (Hotspot: 92/100)", metadata: { complexity: 6, churn: 45 } },
      { id: "hot-2", type: "file", label: "payment.gateway.ts (Hotspot: 88/100)", metadata: { complexity: 8, churn: 32 } },
      { id: "hot-3", type: "file", label: "user.controller.ts (Hotspot: 64/100)", metadata: { complexity: 4, churn: 28 } },
    ];
    sampleEdges = [
      { id: "he1", source: "hot-1", target: "hot-2", relation: "depends_on", metadata: { confidence: 85 } },
    ];
  }

  setGraphData(sampleNodes, sampleEdges);
  projectTitleEl.textContent = `Workspace Intelligence (${viewType})`;
}

window.addEventListener("DOMContentLoaded", init);
