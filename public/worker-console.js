"use strict";

/*
|--------------------------------------------------------------------------|
| Worker console — shared by the Gateway dashboard and the settings page
|--------------------------------------------------------------------------|
|
| Two things live here because both pages need exactly the same behaviour:
|
|   - runOperation(): Start / Stop / Restart / Reindex as a tracked operation,
|     with a progress bar and the worker's log tail in an overlay;
|   - mountPanel():   the "Worker" card of /open.html — the project's lifecycle
|     buttons plus the full worker configuration form, pre-filled from what the
|     user saved in Settings.
|
| It carries its own scoped stylesheet (wc-*), so it looks the same whether the
| page around it uses gateway.css or app.css. It depends on GatewayUi
| (gateway.js) for form mapping and the rules about which buttons a phase shows;
| that global is only touched inside functions, so script order does not matter.
|--------------------------------------------------------------------------|
*/

const WorkerConsole = (function () {

    const STYLE = [
        ".wc-overlay{position:fixed;inset:0;z-index:200;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;background:rgba(5,8,14,.72);backdrop-filter:blur(4px);overflow-y:auto}",
        ".wc-dialog{width:min(820px,100%);max-height:88vh;display:flex;flex-direction:column;background:var(--panel,#141925);color:var(--text,#e8ecf4);border:1px solid var(--line,#262e3d);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.55);font:14px/1.5 var(--sans,system-ui,sans-serif)}",
        ".wc-head{display:flex;justify-content:space-between;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--line,#262e3d)}",
        ".wc-head h2{margin:0;font-size:16px}",
        ".wc-sub{margin:3px 0 0;color:var(--muted,#98a2b3);font-size:12px;word-break:break-all}",
        ".wc-x{background:none;border:0;color:var(--muted,#98a2b3);font-size:22px;line-height:1;cursor:pointer;padding:0 6px}",
        ".wc-body{padding:16px 20px;overflow:auto;flex:1 1 auto}",
        ".wc-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--line,#262e3d)}",
        ".wc-line{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:8px}",
        ".wc-line .wc-elapsed{color:var(--muted,#98a2b3);font-variant-numeric:tabular-nums}",
        ".wc-bar{height:8px;border-radius:99px;background:var(--panel-3,#222a3a);overflow:hidden}",
        ".wc-fill{height:100%;width:0;border-radius:99px;background:var(--accent-grad,linear-gradient(90deg,#5b8cff,#9b5cf6));transition:width .3s}",
        ".wc-fill.wc-busy{width:38%;animation:wc-slide 1.3s ease-in-out infinite}",
        ".wc-fill.wc-ok{width:100%;background:var(--ok,#37d39a)}",
        ".wc-fill.wc-bad{width:100%;background:var(--bad,#f8717a)}",
        "@keyframes wc-slide{0%{margin-left:-38%}100%{margin-left:100%}}",
        ".wc-status-ok{color:var(--ok,#37d39a)}.wc-status-bad{color:var(--bad,#f8717a)}",
        ".wc-hint{margin:8px 0 0;font-size:12px;color:var(--muted,#98a2b3);min-height:1.4em;word-break:break-word}",
        ".wc-log{margin:14px 0 0;max-height:46vh;overflow:auto;padding:12px;border:1px solid var(--line,#262e3d);border-radius:8px;background:var(--bg-2,#0d1119);color:var(--muted,#98a2b3);font:12px/1.55 var(--mono,ui-monospace,Consolas,monospace);white-space:pre-wrap;word-break:break-word}",
        ".wc-btn{background:var(--panel-2,#1b212e);color:var(--text,#e8ecf4);border:1px solid var(--line,#262e3d);border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer}",
        ".wc-btn:hover:not(:disabled){border-color:var(--accent,#5b8cff)}.wc-btn:disabled{opacity:.5;cursor:default}",
        ".wc-btn.wc-primary{background:var(--accent-grad,linear-gradient(135deg,#5b8cff,#9b5cf6));border-color:transparent;color:#fff;font-weight:600}",
        ".wc-btn.wc-danger{border-color:var(--bad,#f8717a);color:var(--bad,#f8717a)}",
        /* the settings-page card */
        ".wc-card .wc-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}",
        ".wc-card .wc-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
        ".wc-phase{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line,#262e3d);border-radius:99px;padding:2px 10px;font-size:12px;text-transform:capitalize}",
        ".wc-phase.p-ready{color:var(--ok,#37d39a);border-color:var(--ok,#37d39a)}.wc-phase.p-indexing,.wc-phase.p-starting,.wc-phase.p-restarting,.wc-phase.p-stopping{color:var(--warn,#f0b64a);border-color:var(--warn,#f0b64a)}.wc-phase.p-crashed,.wc-phase.p-degraded{color:var(--bad,#f8717a);border-color:var(--bad,#f8717a)}",
        ".wc-spin{width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:wc-rot .8s linear infinite}",
        "@keyframes wc-rot{to{transform:rotate(360deg)}}",
        ".wc-actions{display:flex;flex-wrap:wrap;gap:8px}",
        ".wc-inherit{margin:0 0 12px;padding:9px 12px;border:1px dashed var(--line,#262e3d);border-radius:8px;font-size:12px;color:var(--muted,#98a2b3)}",
        ".wc-form fieldset.section{border:1px solid var(--line,#262e3d);border-radius:8px;margin:0 0 12px;padding:10px 14px}",
        ".wc-form legend{color:var(--muted,#98a2b3);font-size:12px;font-weight:600;padding:0 6px;text-transform:capitalize}",
        ".wc-form label.field{display:grid;grid-template-columns:230px 1fr;gap:10px;align-items:center;margin:8px 0}",
        ".wc-form label.field>span:first-child{color:var(--muted,#98a2b3);font-size:13px}",
        ".wc-form input[type=text],.wc-form input[type=number],.wc-form select{background:var(--bg-2,#0d1119);color:var(--text,#e8ecf4);border:1px solid var(--line,#262e3d);border-radius:8px;padding:7px 10px;width:100%;font:inherit}",
        ".wc-form .error{grid-column:2;color:var(--bad,#f8717a);font-size:12px}",
        ".wc-preview{background:var(--bg-2,#0d1119);border:1px solid var(--line,#262e3d);border-radius:8px;padding:12px;overflow-x:auto;font:12px/1.5 var(--mono,ui-monospace,Consolas,monospace);color:var(--muted,#98a2b3);white-space:pre-wrap}",
        ".wc-errors{color:var(--bad,#f8717a);font-size:12px;min-height:1.2em;margin:8px 0 0}",
        ".wc-note{font-size:12px;color:var(--muted,#98a2b3)}",
        "@media (max-width:640px){.wc-form label.field{grid-template-columns:1fr}.wc-form .error{grid-column:1}}"
    ].join("\n");

    let styled = false;
    function ensureStyle() {
        if (styled || typeof document === "undefined") return;
        const style = document.createElement("style");
        style.setAttribute("data-worker-console", "");
        style.textContent = STYLE;
        document.head.appendChild(style);
        styled = true;
    }

    function esc(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function formatElapsed(ms) {
        const total = Math.max(0, Math.round((ms || 0) / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return minutes > 0 ? minutes + "m " + String(seconds).padStart(2, "0") + "s" : seconds + "s";
    }

    const VERBS = {
        start: { busy: "Starting the worker", done: "Started", title: "Start" },
        stop: { busy: "Stopping the worker", done: "Stopped", title: "Stop" },
        restart: { busy: "Restarting the worker", done: "Restarted", title: "Restart" },
        reindex: { busy: "Indexing the project", done: "Index rebuilt", title: "Reindex" }
    };

    function makeApi(token) {
        return async function api(path, options) {
            const headers = Object.assign({}, token ? { Authorization: "Bearer " + token } : {}, (options && options.headers) || {});
            const res = await fetch(path, Object.assign({}, options || {}, { headers: headers }));
            const text = await res.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
            if (!res.ok) throw new Error((body && (body.error || body.raw)) || String(res.status));
            return body;
        };
    }

    /* ── the overlay: progress bar + log tail ──────────────────────── */

    function openActivity(config) {
        ensureStyle();
        const overlay = document.createElement("div");
        overlay.className = "wc-overlay";
        overlay.innerHTML =
            '<div class="wc-dialog" role="dialog" aria-modal="true">' +
            '<div class="wc-head"><div><h2></h2><p class="wc-sub"></p></div><button type="button" class="wc-x" aria-label="Close">&times;</button></div>' +
            '<div class="wc-body">' +
            '<div class="wc-line"><span class="wc-status"></span><span class="wc-elapsed"></span></div>' +
            '<div class="wc-bar"><div class="wc-fill wc-busy"></div></div>' +
            '<p class="wc-hint"></p>' +
            '<pre class="wc-log" hidden></pre>' +
            "</div>" +
            '<div class="wc-foot"><button type="button" class="wc-btn wc-close">Run in background</button></div>' +
            "</div>";
        document.body.appendChild(overlay);
        overlay.querySelector("h2").textContent = config.title;
        overlay.querySelector(".wc-sub").textContent = config.sub || "";

        const q = function (selector) { return overlay.querySelector(selector); };
        const handle = {
            closed: false,
            onClose: null,
            close: function () {
                if (handle.closed) return;
                handle.closed = true;
                overlay.remove();
                if (handle.onClose) handle.onClose();
            },
            setStatus: function (text, kind) {
                const node = q(".wc-status");
                node.textContent = text;
                node.className = "wc-status" + (kind ? " wc-status-" + kind : "");
            },
            setElapsed: function (text) { q(".wc-elapsed").textContent = text; },
            setHint: function (text) { q(".wc-hint").textContent = text || ""; },
            setBar: function (kind) { q(".wc-fill").className = "wc-fill wc-" + kind; },
            setLogs: function (lines) {
                const pre = q(".wc-log");
                const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
                pre.hidden = !lines || lines.length === 0;
                pre.textContent = (lines || []).join("\n");
                if (stick) pre.scrollTop = pre.scrollHeight;
            },
            finish: function (label) { q(".wc-close").textContent = label || "Close"; }
        };
        overlay.addEventListener("click", function (event) { if (event.target === overlay) handle.close(); });
        const onKey = function (event) { if (event.key === "Escape") handle.close(); };
        document.addEventListener("keydown", onKey);
        const closeNow = handle.close;
        handle.close = function () { document.removeEventListener("keydown", onKey); closeNow(); };
        q(".wc-x").onclick = handle.close;
        q(".wc-close").onclick = handle.close;
        return handle;
    }

    /*
    | Start / Stop / Restart / Reindex. The gateway runs the action as a tracked
    | operation (POST …/<action>?async=1); this polls it, together with the log
    | tail, until it ends. Closing the overlay only stops watching: the work goes
    | on, and the page's own phase badge keeps showing it.
    */
    async function runOperation(ctx, project, action) {
        const verbs = VERBS[action];
        const id = encodeURIComponent(project.projectId);
        const view = openActivity({
            title: verbs.title + " — " + (project.name || project.projectId),
            sub: project.rootPath || project.projectId
        });
        view.setStatus(verbs.busy + "…");
        view.setBar("busy");

        let operation;
        try {
            const reply = await ctx.api("/api/v1/gateway/projects/" + id + "/" + action + "?async=1", { method: "POST" });
            operation = reply.operation;
        } catch (error) {
            view.setStatus(error.message, "bad");
            view.setBar("bad");
            view.finish("Close");
            return;
        }

        let stopped = false;
        view.onClose = function () { stopped = true; };

        for (;;) {
            let status = null;
            try {
                const answers = await Promise.all([
                    ctx.api("/api/v1/gateway/projects/" + id + "/operation"),
                    ctx.api("/api/v1/gateway/projects/" + id + "/logs?lines=300")
                ]);
                status = answers[0];
                if (!view.closed) view.setLogs(answers[1].lines);
            } catch (error) {
                if (!view.closed) view.setHint("could not read progress: " + error.message);
            }

            const current = status && status.operation && (!operation || status.operation.id === operation.id) ? status.operation : null;
            if (!view.closed && current) {
                view.setElapsed(formatElapsed(current.elapsedMs));
                const stats = status.stats && status.stats.available
                    ? status.stats.filesCount + " files · " + status.stats.symbolsCount + " symbols indexed so far"
                    : "";
                view.setHint(stats);
            }

            if (current && current.status !== "running") {
                if (!view.closed) {
                    if (current.status === "done") {
                        view.setStatus(verbs.done + " in " + formatElapsed(current.elapsedMs), "ok");
                        view.setBar("ok");
                    } else {
                        view.setStatus("Failed: " + (current.error || "see the log below"), "bad");
                        view.setBar("bad");
                    }
                    view.finish("Close");
                }
                if (ctx.onChange) ctx.onChange();
                return;
            }
            if (!current && status && status.phase && ["ready", "stopped", "crashed", "degraded"].indexOf(status.phase) !== -1) {
                /* the gateway forgot the operation (restart): report what the project looks like */
                if (!view.closed) {
                    view.setStatus("Finished — the project is " + status.phase, status.phase === "ready" || status.phase === "stopped" ? "ok" : "bad");
                    view.setBar(status.phase === "ready" || status.phase === "stopped" ? "ok" : "bad");
                    view.finish("Close");
                }
                if (ctx.onChange) ctx.onChange();
                return;
            }
            if (stopped) {
                if (ctx.onChange) ctx.onChange();
                return;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 1200); });
        }
    }

    /* ── the "Worker" card of /open.html ───────────────────────────── */

    /*
    | What Settings already decided, expressed in the worker form's own fields,
    | for every field this project has not stored a value for. The page used to
    | show the worker form blank of them, so a model picked in Settings looked
    | unset in Edit configuration — and a command line without any embedding flag.
    */
    function inheritedValues(settings) {
        const out = {};
        const c = settings && settings.config;
        if (!c) return out;
        const scan = c.scan || {};
        const embedding = c.embedding || {};
        const put = function (name, value) { if (value !== undefined) out[name] = value; };
        put("useGitignore", scan.useGitignore);
        put("skipHiddenDirectories", scan.skipHiddenDirectories);
        put("maxDepth", scan.maxDepth);
        put("maxFileSizeMb", scan.maxFileSizeMb);
        put("treeSitter", scan.treeSitter);
        put("blueprint", scan.blueprint);
        put("git", scan.git);
        put("lspDiagnostics", scan.lspDiagnostics);
        if (Array.isArray(scan.additionalIgnorePatterns) && scan.additionalIgnorePatterns.length > 0) {
            put("ignore", scan.additionalIgnorePatterns.join(","));
        }
        put("vectors", embedding.enabled);
        put("embeddingProvider", embedding.provider);
        if (embedding.model && !embedding.useDefaultModel) put("embeddingModel", embedding.model);
        put("embeddingNormalize", embedding.normalize);
        return out;
    }

    function describeEmbedding(settings) {
        const e = settings && settings.config && settings.config.embedding;
        if (!e) return "";
        if (!e.enabled) return "Settings: embeddings are off";
        const model = e.provider === "local" && (e.useDefaultModel || !e.model || e.model === "hashing-256")
            ? "built-in hashing model"
            : (e.model || "provider default");
        return "Settings: " + e.provider + " · " + model;
    }

    async function mountPanel(host, ctx) {
        ensureStyle();
        const ui = GatewayUi;
        let projects = [];
        try {
            projects = (await ctx.api("/api/v1/gateway/projects")).projects || [];
        } catch (error) {
            return false;
        }
        host.hidden = false;
        host.classList.add("wc-card");

        let settings = null;
        try { settings = await ctx.api("/api/v1/settings"); } catch (e) { /* the worker may be stopped: the form still works */ }

        const wanted = new URLSearchParams(location.search).get("project");
        let projectId = projects.some(function (p) { return p.projectId === wanted; })
            ? wanted
            : (projects[0] && projects[0].projectId) || "";
        let formBlocked = false;
        let timer = null;

        const current = function () { return projects.find(function (p) { return p.projectId === projectId; }); };

        function frame() {
            const options = projects.map(function (p) {
                return '<option value="' + esc(p.projectId) + '"' + (p.projectId === projectId ? " selected" : "") + ">" + esc(p.name + " (" + p.projectId + ")") + "</option>";
            }).join("");
            host.innerHTML =
                '<div class="card-head"><h2>Worker configuration</h2>' +
                '<p class="muted">The gateway runs one worker per project. Start, stop and reindex it here, and edit every option it is launched with. ' +
                'Defaults you saved below in Settings are used wherever this project has no value of its own.</p></div>' +
                '<div class="wc-top"><div class="wc-title"><select id="wc-project" class="select-box">' + options + "</select>" +
                '<span class="wc-phase" id="wc-phase"></span></div>' +
                '<div class="wc-actions" id="wc-actions"></div></div>' +
                '<div class="wc-inherit" id="wc-inherit"></div>' +
                '<div class="wc-form" id="wc-form"></div>' +
                '<h3 class="group-title" style="margin-top:14px">Command this worker will run</h3>' +
                '<pre class="wc-preview" id="wc-preview"></pre>' +
                '<p class="wc-errors" id="wc-errors" role="alert"></p>' +
                '<div class="wc-actions" style="margin-top:10px">' +
                '<button type="button" class="wc-btn wc-primary" id="wc-save">Save</button>' +
                '<button type="button" class="wc-btn" id="wc-save-restart">Save &amp; restart</button>' +
                '<a class="wc-btn" id="wc-dashboard" href="/gateway" style="text-decoration:none">&larr; All projects</a></div>';
            const back = host.querySelector("#wc-dashboard");
            back.setAttribute("href", ui.withToken("/gateway", ctx.token));
        }

        function paintStatus() {
            const project = current();
            const phaseNode = host.querySelector("#wc-phase");
            const actionsNode = host.querySelector("#wc-actions");
            if (!project) { phaseNode.textContent = ""; actionsNode.innerHTML = ""; return; }
            const phase = project.phase || project.state || "stopped";
            const busy = ["starting", "indexing", "restarting", "stopping"].indexOf(phase) !== -1;
            phaseNode.className = "wc-phase p-" + phase;
            phaseNode.innerHTML = (busy ? '<span class="wc-spin"></span>' : "") + esc(phase);
            actionsNode.innerHTML = ui.actionsFor(phase)
                .filter(function (a) { return ["start", "stop", "restart", "reindex"].indexOf(a.id) !== -1; })
                .map(function (a) { return '<button type="button" class="wc-btn' + (a.id === "start" ? " wc-primary" : a.id === "stop" ? " wc-danger" : "") + '" data-op="' + a.id + '">' + esc(a.label) + "</button>"; })
                .join("") +
                (busy ? '<button type="button" class="wc-btn" data-op="watch">Show progress</button>' : "");
            host.querySelector("#wc-inherit").textContent = describeEmbedding(settings);
            host.querySelector("#wc-inherit").hidden = !describeEmbedding(settings);
        }

        function formValues() {
            const values = {};
            Array.prototype.forEach.call(host.querySelectorAll("#wc-form [name]"), function (input) {
                values[input.name] = input.type === "checkbox" ? input.checked : input.value;
            });
            return values;
        }

        function updatePreview() {
            const values = formValues();
            const errors = ui.validateForm(values);
            const errorNode = host.querySelector("#wc-errors");
            if (!formBlocked) errorNode.textContent = errors.map(function (e) { return e.field + ": " + e.message; }).join(" — ");
            let text = ui.commandPreview(ui.formToConfig(values));
            if (values.vectors && !values.embeddingEnabled) {
                text += "\n# embeddings: " + (describeEmbedding(settings) || "the model chosen in Settings") + " (used because this project sets none of its own)";
            }
            host.querySelector("#wc-preview").textContent = text;
        }

        async function loadForm() {
            const project = current();
            const formNode = host.querySelector("#wc-form");
            formBlocked = false;
            host.querySelector("#wc-errors").textContent = "";
            if (!project) { formNode.innerHTML = '<p class="wc-note">No project is registered yet.</p>'; return; }

            let stored = null;
            try {
                stored = (await ctx.api("/api/v1/gateway/projects/" + encodeURIComponent(projectId))).config || null;
            } catch (error) {
                formBlocked = true;
                host.querySelector("#wc-errors").textContent =
                    "config load failed: " + error.message + " — saving is blocked so the stored configuration is not overwritten";
            }
            const own = ui.configToForm(stored || { projectId: project.projectId, name: project.name, rootPath: project.rootPath });
            const values = Object.assign({}, ui.DEFAULT_FORM_VALUES, inheritedValues(settings), own);
            formNode.innerHTML = ui.renderFormFields(values);
            updatePreview();
        }

        async function save(restart) {
            if (formBlocked) return;
            const values = formValues();
            const errors = ui.validateForm(values);
            const errorNode = host.querySelector("#wc-errors");
            if (errors.length > 0) { errorNode.textContent = errors.map(function (e) { return e.field + ": " + e.message; }).join(" — "); return; }
            const config = ui.formToConfig(values);
            const request = ui.buildSaveRequest(config, projectId, false);
            try {
                await ctx.api(request.url, {
                    method: request.method,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(request.body)
                });
                errorNode.textContent = "";
                errorNode.style.color = "var(--ok,#37d39a)";
                errorNode.textContent = "Saved" + (restart ? "" : ". A running worker restarts to pick it up.");
                setTimeout(function () { errorNode.style.color = ""; }, 4000);
                await refresh();
                if (restart && current() && current().phase !== "stopped") runOperation(ctx, current(), "restart");
            } catch (error) {
                errorNode.textContent = error.message;
            }
        }

        async function refresh() {
            try {
                projects = (await ctx.api("/api/v1/gateway/projects")).projects || projects;
            } catch (e) { /* keep the last list */ }
            paintStatus();
        }

        frame();
        paintStatus();
        await loadForm();

        host.addEventListener("change", function (event) {
            if (event.target.id === "wc-project") {
                projectId = event.target.value;
                history.replaceState(null, "", ui.withToken("?project=" + encodeURIComponent(projectId), ctx.token));
                paintStatus();
                loadForm();
            }
        });
        host.addEventListener("input", function (event) { if (host.querySelector("#wc-form").contains(event.target)) updatePreview(); });
        host.addEventListener("click", function (event) {
            const op = event.target.closest("[data-op]");
            if (op) {
                const project = current();
                if (!project) return;
                if (op.getAttribute("data-op") === "watch") {
                    const action = project.operation && project.operation.action ? project.operation.action : (project.phase === "indexing" ? "reindex" : "start");
                    runOperation(ctx, project, action);
                    return;
                }
                runOperation(ctx, project, op.getAttribute("data-op"));
                return;
            }
            if (event.target.id === "wc-save") save(false);
            if (event.target.id === "wc-save-restart") save(true);
        });

        timer = setInterval(refresh, 4000);
        window.addEventListener("beforeunload", function () { if (timer) clearInterval(timer); });
        ctx.onChange = refresh;
        return true;
    }

    /* On /open.html: show the card only when this server is a Gateway. */
    async function bootSettingsPage() {
        const host = document.getElementById("cardWorker");
        if (!host || typeof GatewayUi === "undefined") return;
        const params = new URLSearchParams(location.search);
        const token = params.get("token") || localStorage.getItem("se.token") || localStorage.getItem("se.gateway.token") || "";
        const api = makeApi(token);
        try {
            await api("/api/v1/gateway/info");
        } catch (error) {
            return; /* a single-project server: there is no worker to configure */
        }
        const ctx = { api: api, token: token, onChange: null };
        await mountPanel(host, ctx);
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootSettingsPage);
        else bootSettingsPage();
    }

    return {
        formatElapsed: formatElapsed,
        inheritedValues: inheritedValues,
        describeEmbedding: describeEmbedding,
        makeApi: makeApi,
        openActivity: openActivity,
        runOperation: runOperation,
        mountPanel: mountPanel
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = WorkerConsole;
}
