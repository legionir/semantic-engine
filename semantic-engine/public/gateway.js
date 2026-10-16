"use strict";

/*
|--------------------------------------------------------------------------|
| Gateway console — فاز ۱۲
|--------------------------------------------------------------------------|
|
| One screen for every project the Gateway serves: aggregate cards, the worker
| table, the lifecycle actions, and the form that edits a worker's
| configuration.
|
| Two rules shaped this file:
|
|   1. Every form field maps to exactly one key of the WorkerConfig schema.
|      The mapping is data (WORKER_FORM_FIELDS), not scattered assignments, so
|      a test can prove no field is orphaned and no schema key is unreachable.
|   2. The pure half (mapping, validation, rendering, URLs) never touches the
|      DOM at load time, so Node can require this file and test it. The
|      browser bootstrap runs only when `document` exists.
|
| The command preview is built from the same argv rules the Gateway uses; it is
| display-only and is never executed.
|--------------------------------------------------------------------------|
*/

const GatewayUi = (function () {

    /*
    | section → the accordion group in the form. `configPath` is dotted and
    | resolves against ProjectWorkerConfig.
    */
    const WORKER_FORM_FIELDS = [
        { name: "projectId", section: "project", type: "text", configPath: "projectId", label: "Project id" },
        { name: "name", section: "project", type: "text", configPath: "name", label: "Display name" },
        { name: "rootPath", section: "project", type: "text", configPath: "rootPath", label: "Workspace root" },
        { name: "dataDir", section: "project", type: "text", configPath: "dataDir", label: "Data directory (optional)" },
        { name: "autoStart", section: "project", type: "checkbox", configPath: "autoStart", label: "Start with the Gateway" },
        { name: "watch", section: "watch", type: "checkbox", configPath: "watch", label: "Keep the index up to date" },

        { name: "vectors", section: "indexing", type: "checkbox", configPath: "indexing.vectors", label: "Build vectors" },
        { name: "sqlite", section: "indexing", type: "checkbox", configPath: "indexing.sqlite", label: "Write SQLite index" },
        { name: "blueprint", section: "indexing", type: "checkbox", configPath: "indexing.blueprint", label: "Build blueprint" },
        { name: "git", section: "indexing", type: "checkbox", configPath: "indexing.git", label: "Collect Git metadata" },
        { name: "treeSitter", section: "indexing", type: "checkbox", configPath: "indexing.treeSitter", label: "Use Tree-sitter" },
        { name: "pretty", section: "indexing", type: "checkbox", configPath: "indexing.pretty", label: "Pretty JSON" },

        { name: "debounceMs", section: "watch", type: "number", configPath: "watchOptions.debounceMs", label: "Debounce (ms)" },
        { name: "blueprintMode", section: "watch", type: "select", configPath: "watchOptions.blueprintMode", label: "Blueprint mode", options: ["always", "threshold"] },
        { name: "skipInitialIndex", section: "watch", type: "checkbox", configPath: "watchOptions.skipInitialIndex", label: "Skip the initial index" },

        { name: "transport", section: "service", type: "select", configPath: "service.transport", label: "Transport", options: ["loopback", "socket"] },
        { name: "host", section: "service", type: "text", configPath: "service.host", label: "Bind host" },
        { name: "port", section: "service", type: "number", configPath: "service.port", label: "Port (optional)" },
        { name: "uiPort", section: "service", type: "number", configPath: "service.uiPort", label: "UI port (optional)" },
        { name: "mcpPort", section: "service", type: "number", configPath: "service.mcpPort", label: "MCP port (optional)" },
        { name: "socketPath", section: "service", type: "text", configPath: "service.socketPath", label: "Socket path (optional)" },
        { name: "http", section: "service", type: "checkbox", configPath: "service.http", label: "HTTP MCP" },
        { name: "stdio", section: "service", type: "checkbox", configPath: "service.stdio", label: "stdio MCP" },
        { name: "web", section: "service", type: "checkbox", configPath: "service.web", label: "Project dashboard" },

        { name: "gatewayManaged", section: "security", type: "checkbox", configPath: "security.gatewayManaged", label: "Reachable only through the Gateway" },
        { name: "allowRemote", section: "security", type: "checkbox", configPath: "security.allowRemote", label: "Allow remote connections" },
        { name: "tokenEnvVar", section: "security", type: "text", configPath: "security.tokenEnvVar", label: "Token environment variable" },

        { name: "embeddingEnabled", section: "embedding", type: "checkbox", configPath: "embedding.enabled", label: "Enable embeddings" },
        { name: "embeddingProvider", section: "embedding", type: "select", configPath: "embedding.provider", label: "Provider", options: ["local", "ollama", "openai-compatible"] },
        { name: "embeddingModel", section: "embedding", type: "text", configPath: "embedding.model", label: "Model" },
        { name: "embeddingBaseUrl", section: "embedding", type: "text", configPath: "embedding.baseUrl", label: "Base URL" },
        { name: "embeddingApiKeyEnv", section: "embedding", type: "text", configPath: "embedding.apiKeyEnvVar", label: "API key environment variable" },
        { name: "embeddingNormalize", section: "embedding", type: "checkbox", configPath: "embedding.normalize", label: "Normalize vectors" },
        { name: "embeddingUseDefaultModel", section: "embedding", type: "checkbox", configPath: "embedding.useDefaultModel", label: "Use the provider's default model" },

        { name: "outOverride", section: "advanced", type: "text", configPath: "outOverride", label: "--out override (compat)" }
    ];

    const WORKER_TABLE_COLUMNS = [
        { key: "name", label: "Project" },
        { key: "projectId", label: "Project id" },
        { key: "rootPath", label: "Root path" },
        { key: "pid", label: "PID" },
        { key: "state", label: "State" },
        { key: "indexState", label: "Index" },
        { key: "restartCount", label: "Restarts" },
        { key: "degraded", label: "Degraded" }
    ];

    /*
    | SE-F-057 — the initial values of a NEW worker form. The save payload now
    | carries the whole config, so an empty form would silently send
    | `blueprint:false, git:false, …` and flip the documented backend defaults.
    | These mirror WORKER_CONFIG_JSON_SCHEMA's `default` entries; a test
    | (gatewayUi.test.ts) compares this table against the schema key by key,
    | so the two can never drift — one source of truth, mechanically checked.
    */
    const DEFAULT_FORM_VALUES = {
        watch: true,
        blueprint: true,
        git: true,
        treeSitter: true,
        pretty: true,
        vectors: false,
        sqlite: false,
        debounceMs: 500,
        blueprintMode: "always",
        skipInitialIndex: false,
        transport: "loopback",
        host: "127.0.0.1",
        http: false,
        stdio: false,
        web: false,
        gatewayManaged: false,
        allowRemote: false,
        embeddingEnabled: false,
        embeddingProvider: "local",
        embeddingNormalize: true
    };

    // No logs/events route is part of the Gateway route inventory. Keep these
    // controls visibly disabled instead of issuing guaranteed 404 requests.
    const UNSUPPORTED_ACTIONS = new Set(["logs", "events"]);

    const WORKER_ACTIONS = [
        { id: "open", label: "Open dashboard" },
        { id: "start", label: "Start" },
        { id: "stop", label: "Stop" },
        { id: "restart", label: "Restart" },
        { id: "reindex", label: "Reindex" },
        { id: "edit", label: "Edit configuration" },
        { id: "health", label: "Health detail" },
        { id: "logs", label: "View logs" },
        { id: "events", label: "View events" },
        { id: "mcp", label: "Open MCP endpoint" },
        { id: "remove", label: "Remove project" }
    ];

    function escape(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function getPath(source, dotted) {
        return dotted.split(".").reduce(function (acc, key) {
            return acc === undefined || acc === null ? undefined : acc[key];
        }, source);
    }

    function setPath(target, dotted, value) {
        const keys = dotted.split(".");
        let node = target;
        for (let i = 0; i < keys.length - 1; i += 1) {
            const key = keys[i];
            if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
            node = node[key];
        }
        node[keys[keys.length - 1]] = value;
        return target;
    }

    /* مقادیر خام فرم → ProjectWorkerConfig. */
    function formToConfig(values) {
        const config = {};
        WORKER_FORM_FIELDS.forEach(function (field) {
            const raw = values[field.name];
            if (raw === undefined || raw === "") {
                if (field.type !== "checkbox") return;
            }
            let value = raw;
            if (field.type === "checkbox") value = Boolean(raw);
            else if (field.type === "number") {
                if (raw === "" || raw === undefined) return;
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) return;
                value = parsed;
            }
            setPath(config, field.configPath, value);
        });
        return config;
    }

    /* ProjectWorkerConfig → مقادیر اولیهٔ فرم. */
    function configToForm(config) {
        const values = {};
        WORKER_FORM_FIELDS.forEach(function (field) {
            const value = getPath(config || {}, field.configPath);
            if (value === undefined) return;
            values[field.name] = field.type === "checkbox" ? Boolean(value) : value;
        });
        return values;
    }

    const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

    /* همان قواعد WorkerConfigSchema، تا خطا پیش از start دیده شود. */
    function validateForm(values) {
        const errors = [];
        const projectId = String(values.projectId || "");
        const rootPath = String(values.rootPath || "");

        if (!PROJECT_ID_PATTERN.test(projectId)) {
            errors.push({ field: "projectId", message: "lowercase letters, digits, dot, dash or underscore" });
        }
        if (String(values.name || "").trim() === "") {
            errors.push({ field: "name", message: "must not be empty" });
        }
        if (rootPath.trim() === "") {
            errors.push({ field: "rootPath", message: "must not be empty" });
        }

        const debounce = Number(values.debounceMs);
        if (values.debounceMs !== "" && values.debounceMs !== undefined) {
            if (!Number.isInteger(debounce) || debounce < 25 || debounce > 60000) {
                errors.push({ field: "debounceMs", message: "must be an integer between 25 and 60000" });
            }
        }

        for (const key of ["port", "uiPort", "mcpPort"]) {
            const raw = values[key];
            if (raw === "" || raw === undefined) continue;
            const port = Number(raw);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                errors.push({ field: key, message: "must be an integer between 0 and 65535" });
            }
        }

        if (values.transport === "socket" && String(values.socketPath || "").trim() === "") {
            errors.push({ field: "socketPath", message: "required when the transport is socket" });
        }
        if (values.gatewayManaged && values.allowRemote) {
            errors.push({ field: "allowRemote", message: "a gateway-managed worker must not allow remote connections" });
        }
        if (values.gatewayManaged && String(values.tokenEnvVar || "").trim() === "") {
            errors.push({ field: "tokenEnvVar", message: "a gateway-managed worker needs a token environment variable" });
        }

        const provider = values.embeddingProvider;
        if (values.embeddingEnabled && provider && provider !== "local") {
            if (!/^https?:\/\//i.test(String(values.embeddingBaseUrl || ""))) {
                errors.push({ field: "embeddingBaseUrl", message: "must be an http(s) URL" });
            }
            if (String(values.embeddingModel || "").trim() === "" && !values.embeddingUseDefaultModel) {
                errors.push({ field: "embeddingModel", message: "a model is required (or use the provider default)" });
            }
        }

        /* هیچ‌وقت خودِ کلید، فقط نام متغیر محیطی. */
        for (const key of ["token", "apiKey"]) {
            if (values[key] !== undefined && values[key] !== "") {
                errors.push({ field: key, message: "secrets are never part of the configuration" });
            }
        }

        return errors;
    }

    /*
    | پیش‌نمایش argv — فقط برای نمایش. همان قواعد workerArgv: پرچم‌های
    | boolean به‌شکل `--x`/`--no-x`، و هیچ shell string.
    */
    function commandPreview(config) {
        const argv = ["semantic-engine", "worker"];
        const push = function (flag, value) {
            if (value === undefined || value === null || value === "") return;
            argv.push("--" + flag, String(value));
        };
        const bool = function (flag, value) {
            argv.push(value ? "--" + flag : "--no-" + flag);
        };

        push("project-id", config.projectId);
        push("root", config.rootPath);
        push("data-dir", config.dataDir);
        push("out", config.outOverride);

        const indexing = config.indexing || {};
        bool("vectors", Boolean(indexing.vectors));
        bool("sqlite", Boolean(indexing.sqlite));
        bool("blueprint", indexing.blueprint !== false);
        bool("git", indexing.git !== false);
        bool("tree-sitter", indexing.treeSitter !== false);
        bool("pretty", indexing.pretty !== false);

        const watchOptions = config.watchOptions || {};
        if (config.watch === false) argv.push("--no-watch");
        push("debounce", watchOptions.debounceMs);
        push("blueprint-mode", watchOptions.blueprintMode);
        if (watchOptions.skipInitialIndex) argv.push("--skip-initial-index");

        const service = config.service || {};
        push("host", service.host);
        push("port", service.port);
        push("ui-port", service.uiPort);
        push("mcp-port", service.mcpPort);
        if (service.transport === "socket") push("socket", service.socketPath);
        if (service.http) argv.push("--http");
        if (service.stdio) argv.push("--stdio");
        if (service.web) argv.push("--web");

        const security = config.security || {};
        if (security.gatewayManaged) argv.push("--gateway-managed");
        if (security.allowRemote) argv.push("--allow-remote");

        const embedding = config.embedding || {};
        if (embedding.enabled) {
            push("embedding-provider", embedding.provider);
            push("embedding-model", embedding.model);
            push("embedding-base-url", embedding.baseUrl);
            push("embedding-api-key-env", embedding.apiKeyEnvVar);
            bool("embedding-normalize", embedding.normalize !== false);
        }

        return argv.join(" ");
    }

    function summarize(workers) {
        const list = workers || [];
        return {
            projects: list.length,
            ready: list.filter(function (w) { return w.state === "ready"; }).length,
            indexing: list.filter(function (w) { return w.state === "starting"; }).length,
            degraded: list.filter(function (w) { return w.degraded; }).length,
            crashed: list.filter(function (w) { return w.state === "crashed"; }).length,
            stopped: list.filter(function (w) { return w.state === "stopped"; }).length,
            restarts: list.reduce(function (sum, w) { return sum + (w.restartCount || 0); }, 0)
        };
    }

    function stateClass(worker) {
        if (worker.degraded) return "state-degraded";
        if (worker.state === "ready") return "state-ready";
        if (worker.state === "crashed") return "state-crashed";
        if (worker.state === "starting") return "state-indexing";
        return "state-stopped";
    }

    function renderWorkerRow(worker) {
        const cells = WORKER_TABLE_COLUMNS.map(function (column) {
            const value = worker[column.key];
            return '<td data-key="' + escape(column.key) + '">' +
                escape(value === true ? "yes" : value === false ? "no" : value) +
                "</td>";
        }).join("");

        const actions = WORKER_ACTIONS.map(function (action) {
            const unavailable = UNSUPPORTED_ACTIONS.has(action.id);
            return '<button class="action" data-action="' + escape(action.id) +
                '" data-project="' + escape(worker.projectId) + '"' +
                (unavailable ? ' disabled title="Unavailable: no Gateway route"' : '') + '>' +
                escape(action.label) + "</button>";
        }).join("");

        return '<tr class="' + stateClass(worker) + '" data-project="' + escape(worker.projectId) + '">' +
            cells +
            '<td class="actions">' + actions + "</td>" +
            "</tr>";
    }

    function renderSummaryCards(stats) {
        const cards = [
            { key: "projects", label: "Projects" },
            { key: "ready", label: "Ready" },
            { key: "indexing", label: "Indexing" },
            { key: "degraded", label: "Degraded" },
            { key: "crashed", label: "Crashed" },
            { key: "restarts", label: "Restarts" }
        ];
        return cards.map(function (card) {
            return '<div class="card" data-key="' + card.key + '">' +
                '<span class="card-value">' + escape(stats[card.key]) + "</span>" +
                '<span class="card-label">' + escape(card.label) + "</span>" +
                "</div>";
        }).join("");
    }

    function renderFormFields(values) {
        const bySection = {};
        WORKER_FORM_FIELDS.forEach(function (field) {
            if (!bySection[field.section]) bySection[field.section] = [];
            bySection[field.section].push(field);
        });

        return Object.keys(bySection).map(function (section) {
            const fields = bySection[section].map(function (field) {
                const value = values[field.name];
                const id = "field-" + field.name;
                let control;
                if (field.type === "checkbox") {
                    control = '<input id="' + id + '" name="' + escape(field.name) +
                        '" type="checkbox"' + (value ? " checked" : "") + ' data-config="' +
                        escape(field.configPath) + '">';
                } else if (field.type === "select") {
                    const options = (field.options || []).map(function (option) {
                        return '<option value="' + escape(option) + '"' +
                            (value === option ? " selected" : "") + ">" + escape(option) + "</option>";
                    }).join("");
                    control = '<select id="' + id + '" name="' + escape(field.name) +
                        '" data-config="' + escape(field.configPath) + '">' + options + "</select>";
                } else {
                    control = '<input id="' + id + '" name="' + escape(field.name) +
                        '" type="' + (field.type === "number" ? "number" : "text") + '" value="' +
                        escape(value === undefined ? "" : value) + '" data-config="' +
                        escape(field.configPath) + '">';
                }
                return '<label class="field" data-section="' + escape(section) + '">' +
                    "<span>" + escape(field.label) + "</span>" + control +
                    '<span class="error" data-error-for="' + escape(field.name) + '"></span>' +
                    "</label>";
            }).join("");

            return '<fieldset class="section" data-section="' + escape(section) + '">' +
                "<legend>" + escape(section) + "</legend>" + fields + "</fieldset>";
        }).join("");
    }

    /*
    | health detail یک worker (فاز ۱۳). هر بخش مستقل سبز/قرمز می‌شود تا خرابی
    | یک worker فقط همان ردیف را قرمز کند، و تاریخچهٔ restart همراه آخرین
    | خطا نشان داده شود.
    */
    const HEALTH_SECTIONS = [
        { key: "process", label: "Process", from: function (h) { return h && h.pid ? "ok" : "unknown"; } },
        { key: "index", label: "Index", from: function (h) { return h && h.indexState === "fresh" ? "ok" : h && h.indexState ? "warn" : "unknown"; } },
        { key: "watcher", label: "Watcher", from: function (h) { return h && h.watcher === "running" ? "ok" : "warn"; } },
        { key: "sqlite", label: "SQLite", from: function (h) { return h && h.sqlite === true ? "ok" : "off"; } },
        { key: "blueprint", label: "Blueprint", from: function (h) { return h && h.blueprint === true ? "ok" : "off"; } },
        { key: "vectors", label: "Vectors", from: function (h) { return h && h.vectorChunks > 0 ? "ok" : "off"; } },
        { key: "lsp", label: "LSP", from: function (h) { return h && h.lsp === false ? "warn" : "unknown"; } }
    ];

    function renderHealthPanel(detail) {
        const health = (detail && detail.health) || null;
        const sections = HEALTH_SECTIONS.map(function (section) {
            const state = section.from(health);
            return '<div class="health-item health-' + state + '" data-key="' + section.key + '">' +
                "<span>" + escape(section.label) + "</span>" +
                "<strong>" + escape(state) + "</strong>" +
                "</div>";
        }).join("");

        const history = (detail && detail.restartHistory) || [];
        const historyHtml = history.length === 0
            ? '<p class="muted">no restarts recorded</p>'
            : "<ul>" + history.map(function (entry) {
                return "<li>" + escape(entry.at) + " — " + escape(entry.reason) + "</li>";
            }).join("") + "</ul>";

        return '<section class="panel" data-project="' + escape(detail && detail.projectId) + '">' +
            "<h2>Health — " + escape(detail && (detail.name || detail.projectId)) + "</h2>" +
            '<div class="health-grid">' + sections + "</div>" +
            "<h3>Counters</h3><ul>" +
            "<li>files: " + escape(health && health.files) + "</li>" +
            "<li>symbols: " + escape(health && health.symbols) + "</li>" +
            "<li>dependencies: " + escape(health && health.dependencies) + "</li>" +
            "<li>vector chunks: " + escape(health && health.vectorChunks) + "</li>" +
            "<li>memory: " + escape(health && health.memoryMb) + " MB</li>" +
            "<li>queue: " + escape(health && health.queueSize) + "</li>" +
            "<li>last indexed: " + escape(health && health.lastIndexedAt) + "</li>" +
            "<li>restarts: " + escape(detail && detail.restartCount) + "</li>" +
            "</ul>" +
            "<h3>Last error</h3><p>" + escape((detail && detail.lastError) || "none") + "</p>" +
            "<h3>Restart history</h3>" + historyHtml +
            "</section>";
    }

    /* deep link پروژه؛ refresh هم همین context را نگه می‌دارد. */
    function projectDashboardUrl(projectId) {
        return "/visualizer?project=" + encodeURIComponent(projectId);
    }

    function mcpEndpointUrl(projectId) {
        return "/mcp/" + encodeURIComponent(projectId);
    }

    /*
    | SE-F-057 — the save request shape, as a PURE function so it can be
    | tested outside the browser: create is POST on the collection with the
    | registration keys plus the whole config; update is PATCH on the
    | project's own resource with the full config, where an optional field
    | the form left empty is sent as an explicit null (clears it back to the
    | default) instead of vanishing and silently keeping the old value.
    */
    const OPTIONAL_SCALARS = [
        "dataDir", "outOverride",
        ["service", "port"], ["service", "uiPort"], ["service", "mcpPort"],
        ["service", "socketPath"],
        ["security", "tokenEnvVar"],
        ["embedding", "model"], ["embedding", "baseUrl"], ["embedding", "apiKeyEnvVar"],
        ["embedding", "useDefaultModel"]
    ];

    function buildSaveRequest(config, editingId, start) {
        const full = {};
        for (const field of WORKER_FORM_FIELDS) {
            if (field.configPath === "projectId" || field.configPath === "name" ||
                field.configPath === "rootPath" || field.configPath === "autoStart") {
                continue;
            }
            setPath(full, field.configPath, getPath(config, field.configPath));
        }

        if (!editingId) {
            return {
                url: "/api/v1/gateway/projects",
                method: "POST",
                body: Object.assign({
                    path: config.rootPath,
                    name: config.name,
                    id: config.projectId,
                    autoStart: Boolean(start)
                }, full)
            };
        }

        for (const spec of OPTIONAL_SCALARS) {
            const dotted = Array.isArray(spec) ? spec.join(".") : spec;
            if (getPath(full, dotted) === undefined) setPath(full, dotted, null);
        }

        return {
            url: "/api/v1/gateway/projects/" + encodeURIComponent(editingId),
            method: "PATCH",
            body: Object.assign({}, full, {
                name: config.name,
                autoStart: Boolean(start)
            })
        };
    }

    return {
        WORKER_FORM_FIELDS,
        WORKER_TABLE_COLUMNS,
        WORKER_ACTIONS,
        UNSUPPORTED_ACTIONS,
        escape,
        getPath,
        setPath,
        formToConfig,
        configToForm,
        validateForm,
        commandPreview,
        summarize,
        stateClass,
        renderWorkerRow,
        renderSummaryCards,
        renderFormFields,
        buildSaveRequest,
        DEFAULT_FORM_VALUES,
        HEALTH_SECTIONS,
        renderHealthPanel,
        projectDashboardUrl,
        mcpEndpointUrl
    };
})();


if (typeof module !== "undefined" && module.exports) {
    module.exports = GatewayUi;
}


/* ── bootstrap مرورگر ─────────────────────────────────────────────────── */
if (typeof document !== "undefined") {
    (function () {
        const params = new URLSearchParams(location.search);
        const token = params.get("token") || localStorage.getItem("se.gateway.token") || "";
        if (token) localStorage.setItem("se.gateway.token", token);

        const headers = function () {
            return token ? { Authorization: "Bearer " + token } : {};
        };

        const els = {
            cards: document.getElementById("cards"),
            rows: document.getElementById("worker-rows"),
            status: document.getElementById("status"),
            form: document.getElementById("worker-form"),
            formFields: document.getElementById("form-fields"),
            preview: document.getElementById("command-preview"),
            formErrors: document.getElementById("form-errors"),
            formTitle: document.getElementById("form-title")
        };

        let workers = [];
        let editing = null;
        let formBlocked = false;

        async function api(path, options) {
            const res = await fetch(path, Object.assign({ headers: headers() }, options || {}));
            const text = await res.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
            if (!res.ok) throw new Error((body && (body.error || body.raw)) || res.status);
            return body;
        }

        function render() {
            const stats = GatewayUi.summarize(workers);
            els.cards.innerHTML = GatewayUi.renderSummaryCards(stats);
            els.rows.innerHTML = workers.map(GatewayUi.renderWorkerRow).join("");
        }

        function openForm(projectId) {
            const worker = workers.find(function (w) { return w.projectId === projectId; });
            editing = projectId;
            formBlocked = false;

            /*
            | SE-F-057 — hydrate EVERY field from the project's real, effective
            | worker config, not the three the old save path could send. The
            | list row is enough for the title, but the full config comes from
            | the detail route; if that fetch fails we fall back to the row's
            | identity fields rather than silently showing a blank config that
            | a save would then reset.
            */
            const identity = worker
                ? { projectId: worker.projectId, name: worker.name, rootPath: worker.rootPath }
                : {};

            function paintValues(values) {
                els.formTitle.textContent = worker ? "Edit " + worker.name : "New worker";
                els.formFields.innerHTML = GatewayUi.renderFormFields(values);
                els.form.hidden = false;
                updatePreview();
            }

            function paint(config) {
                paintValues(GatewayUi.configToForm(config || identity));
            }

            if (!worker) {
                /* a NEW worker starts from the schema defaults — an empty form
                | would now submit explicit falses and flip them. */
                paintValues(Object.assign({}, GatewayUi.DEFAULT_FORM_VALUES));
                return;
            }

            api("/api/v1/gateway/projects/" + encodeURIComponent(projectId))
                .then(function (detail) { paint(detail && detail.config ? detail.config : identity); })
                .catch(function (error) {
                    /* an edit whose effective config cannot be read must not
                    | be saved blind — a submit would now write the visible
                    | fields over the real config. Only identity is trusted. */
                    formBlocked = true;
                    els.formErrors.textContent =
                        "config load failed: " + error.message +
                        " — fix the connection before saving this worker";
                    paint(identity);
                });
        }

        function formValues() {
            const values = {};
            Array.prototype.forEach.call(els.formFields.querySelectorAll("[name]"), function (input) {
                values[input.name] = input.type === "checkbox" ? input.checked : input.value;
            });
            return values;
        }

        function updatePreview() {
            const values = formValues();
            /* a blocked edit keeps its reason visible — clearing it on every
            | keystroke would make the failure look like it healed */
            if (!formBlocked) els.formErrors.textContent = "";
            const errors = GatewayUi.validateForm(values);
            if (errors.length > 0) {
                els.formErrors.textContent = errors
                    .map(function (e) { return e.field + ": " + e.message; })
                    .join(" — ");
            }
            els.preview.textContent = GatewayUi.commandPreview(GatewayUi.formToConfig(values));
        }

        async function refresh() {
            try {
                const list = await api("/api/v1/gateway/projects");
                workers = list.projects || [];
                els.status.textContent = "connected";
                render();
            } catch (error) {
                els.status.textContent = "error: " + error.message;
            }
        }

        async function act(action, projectId) {
            try {
                if (action === "open") { location.href = GatewayUi.projectDashboardUrl(projectId); return; }
                if (action === "mcp") { location.href = GatewayUi.mcpEndpointUrl(projectId); return; }
                if (action === "edit") { openForm(projectId); return; }
                if (action === "health") {
                    const detail = await api("/api/v1/gateway/projects/" + encodeURIComponent(projectId) + "/health");
                    const panel = document.getElementById("health-panel");
                    panel.innerHTML = GatewayUi.renderHealthPanel(detail);
                    panel.hidden = false;
                    return;
                }
                if (action === "remove") {
                    await api("/api/v1/gateway/projects/" + encodeURIComponent(projectId), { method: "DELETE" });
                } else {
                    await api("/api/v1/gateway/projects/" + encodeURIComponent(projectId) + "/" + action, { method: "POST" });
                }
                await refresh();
            } catch (error) {
                els.status.textContent = "error: " + error.message;
            }
        }

        els.rows.addEventListener("click", function (event) {
            const button = event.target.closest("button[data-action]");
            if (!button) return;
            act(button.dataset.action, button.dataset.project);
        });

        els.formFields.addEventListener("input", updatePreview);

        document.getElementById("new-worker").addEventListener("click", function () {
            editing = null;
            formBlocked = false;
            els.formErrors.textContent = "";
            els.formTitle.textContent = "New worker";
            els.formFields.innerHTML = GatewayUi.renderFormFields(GatewayUi.DEFAULT_FORM_VALUES);
            els.form.hidden = false;
            updatePreview();
        });

        async function save(start) {
            if (formBlocked) {
                els.formErrors.textContent =
                    "saving is blocked: this worker's config could not be loaded, and saving now would overwrite it";
                return;
            }
            const values = formValues();
            const errors = GatewayUi.validateForm(values);
            if (errors.length > 0) {
                els.formErrors.textContent = errors.map(function (e) { return e.field + ": " + e.message; }).join(" — ");
                return;
            }

            /*
            | SE-F-057 — the complete config the form models is sent, and an
            | EDIT uses PATCH on the project's own resource instead of always
            | POSTing to the collection (the old code could never update an
            | existing worker). The request shape is the pure, tested
            | buildSaveRequest contract.
            */
            const config = GatewayUi.formToConfig(values);
            const request = GatewayUi.buildSaveRequest(config, editing, start);
            try {
                await api(request.url, {
                    method: request.method,
                    headers: Object.assign({ "Content-Type": "application/json" }, headers()),
                    body: JSON.stringify(request.body)
                });
                els.form.hidden = true;
                els.formErrors.textContent = "";
                editing = null;
                await refresh();
            } catch (error) {
                els.formErrors.textContent = error.message;
            }
        }

        document.getElementById("save-start").addEventListener("click", function () { save(true); });
        document.getElementById("save-only").addEventListener("click", function () { save(false); });

        /*
        | زنده‌سازی با SSE؛ polling فقط fallback است، چون یک Gateway شلوغ
        | نباید هر چند ثانیه کل لیست را دوباره بخواند.
        */
        function connectEvents() {
            const url = "/api/v1/gateway/events" + (token ? "?token=" + encodeURIComponent(token) : "");
            const source = new EventSource(url);
            source.addEventListener("gateway", function () { refresh(); });
            source.onerror = function () {
                source.close();
                setTimeout(connectEvents, 5000);
            };
        }

        refresh();
        connectEvents();
        setInterval(refresh, 30000);
    })();
}
