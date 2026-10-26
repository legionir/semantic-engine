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

        { name: "useGitignore", section: "scan", type: "checkbox", configPath: "scan.useGitignore", label: "Respect .gitignore" },
        { name: "skipHiddenDirectories", section: "scan", type: "checkbox", configPath: "scan.skipHiddenDirectories", label: "Skip hidden directories" },
        { name: "maxDepth", section: "scan", type: "number", configPath: "scan.maxDepth", label: "Max depth (0 = unlimited)" },
        { name: "maxFileSizeMb", section: "scan", type: "number", configPath: "scan.maxFileSizeMb", label: "Max file size (MB)" },
        { name: "ignore", section: "scan", type: "text", configPath: "scan.ignore", label: "Extra ignore patterns (comma separated)" },

        { name: "lspDiagnostics", section: "diagnostics", type: "checkbox", configPath: "diagnostics.lsp", label: "Collect language-server diagnostics" },
        { name: "diagnosticsBudgetMs", section: "diagnostics", type: "number", configPath: "diagnostics.budgetMs", label: "Diagnostics budget (ms, optional)" },

        { name: "cacheMode", section: "cache", type: "select", configPath: "cache.mode", label: "Extraction cache", options: ["use", "full", "off"] },
        { name: "artifactLocation", section: "cache", type: "select", configPath: "artifactLocation", label: "Artifact location", options: ["", "external", "in-root"] },

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
        useGitignore: true,
        skipHiddenDirectories: true,
        maxDepth: 0,
        maxFileSizeMb: 5,
        lspDiagnostics: false,
        cacheMode: "use",
        blueprint: true,
        git: true,
        treeSitter: true,
        pretty: true,
        vectors: false,
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

        const depthRaw = values.maxDepth;
        if (depthRaw !== "" && depthRaw !== undefined && depthRaw !== null) {
            const depth = Number(depthRaw);
            if (!Number.isInteger(depth) || depth < 0 || depth > 1000) {
                errors.push({ field: "maxDepth", message: "must be an integer between 0 and 1000" });
            }
        }
        const sizeRaw = values.maxFileSizeMb;
        if (sizeRaw !== "" && sizeRaw !== undefined && sizeRaw !== null) {
            const size = Number(sizeRaw);
            if (!Number.isFinite(size) || size <= 0 || size > 10240) {
                errors.push({ field: "maxFileSizeMb", message: "must be greater than 0 and at most 10240" });
            }
        }
        const budgetRaw = values.diagnosticsBudgetMs;
        if (budgetRaw !== "" && budgetRaw !== undefined && budgetRaw !== null) {
            const budget = Number(budgetRaw);
            if (!Number.isInteger(budget) || budget < 0) {
                errors.push({ field: "diagnosticsBudgetMs", message: "must be a non-negative integer" });
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
        // Display-only quoting, identical to commandPreview() in workerArgv.ts.
        const quote = function (value) {
            return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
        };
        const push = function (flag, value) {
            if (value === undefined || value === null || value === "") return;
            argv.push("--" + flag, quote(String(value)));
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
        bool("blueprint", indexing.blueprint !== false);
        bool("git", indexing.git !== false);
        bool("tree-sitter", indexing.treeSitter !== false);
        bool("pretty", indexing.pretty !== false);

        push("artifact-location", config.artifactLocation);
        const scan = config.scan || {};
        if (scan.useGitignore === false) argv.push("--no-gitignore");
        if (scan.skipHiddenDirectories === false) argv.push("--no-skip-hidden");
        if (Number(scan.maxDepth) > 0) push("max-depth", scan.maxDepth);
        if (scan.maxFileSizeMb !== undefined && Number(scan.maxFileSizeMb) !== 5) push("max-file-size-mb", scan.maxFileSizeMb);
        push("ignore", scan.ignore);
        const diagnostics = config.diagnostics || {};
        if (diagnostics.lsp) argv.push("--lsp-diagnostics");
        push("diagnostics-budget", diagnostics.budgetMs);
        const cacheMode = (config.cache || {}).mode;
        if (cacheMode === "full") argv.push("--full");
        if (cacheMode === "off") argv.push("--no-cache");

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
            return '<button class="action" data-action="' + escape(action.id) +
                '" data-project="' + escape(worker.projectId) + '">' +
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
        { key: "blueprint", label: "Blueprint", from: function (h) { return h && h.blueprint === true ? "ok" : "off"; } },
        { key: "vectors", label: "Vectors", from: function (h) { return h && h.vectorChunks > 0 ? "ok" : "off"; } },
        { key: "lsp", label: "LSP", from: function (h) {
            const lsp = h && h.lsp;
            if (!lsp) return "unknown";
            if (!lsp.enabled) return "off";
            if (!lsp.run) return "warn";
            return lsp.run.filesSkippedByBudget > 0 ? "warn" : "ok";
        } }
    ];

    /* One line for the LSP row: switched off, never run, or what the last run found. */
    function lspSummary(lsp) {
        if (!lsp) return "not reported by this worker (restart it to update)";
        if (!lsp.enabled) return "off (enable it in Edit configuration, then reindex)";
        if (!lsp.run) return "on, but no run recorded yet: reindex";
        return lsp.run.filesWithFindings + " files with findings" +
            (lsp.run.filesSkippedByBudget > 0 ? ", " + lsp.run.filesSkippedByBudget + " skipped (budget " + lsp.run.budgetMs + " ms)" : "") +
            (lsp.run.completedAt ? ", last run " + lsp.run.completedAt : "");
    }

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
            "<li>LSP diagnostics: " + escape(lspSummary(health && health.lsp)) + "</li>" +
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

    /* ADDRESS -> ADDRESS?token=TOKEN (keeps an existing query string). */
    function withToken(url, token) {
        if (!token) return url;
        return url + (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(token);
    }

    /*
    | Ready-to-paste client configuration. Pure: the page passes its own origin
    | and token, so a test can pin every snippet. `projectId` (optional) swaps
    | the all-projects endpoint for that one project's.
    */
    function connectSnippets(options) {
        const origin = options.origin;
        const token = options.token || "<TOKEN>";
        const project = options.projectId;
        const url = origin + (project ? "/mcp/" + encodeURIComponent(project) : "/mcp");
        const urlWithToken = withToken(url, token);
        const name = project ? "semantic-" + project : "semantic-engine";
        const header = "Bearer " + token;
        const example = project
            ? '{ name: "find_symbol", arguments: { name: "Router" } }'
            : '{ name: "find_symbol", arguments: { project: "my-app", name: "Router" } }';

        const json = function (value) { return JSON.stringify(value, null, 2); };
        const envServers = {};
        envServers[name] = { type: "http", url: url, headers: { Authorization: "Bearer ${SEMANTIC_ENGINE_TOKEN}" } };
        const cursorServers = {};
        cursorServers[name] = { url: url, headers: { Authorization: header } };
        const desktopServers = {};
        desktopServers[name] = { command: "npx", args: ["-y", "mcp-remote", urlWithToken, "--allow-http"] };
        const vscodeServers = {};
        vscodeServers[name] = { type: "http", url: url, headers: { Authorization: header } };

        return [
            {
                id: "claude-code",
                label: "Claude Code",
                language: "bash",
                note: "--scope user registers it once for every folder you open, so no per-project setup is needed.",
                code: 'claude mcp add --transport http --scope user ' + name + ' ' + url +
                    ' --header "Authorization: Bearer ' + token + '"\n\n' +
                    "# check it\nclaude mcp list"
            },
            {
                id: "mcp-json",
                label: ".mcp.json",
                language: "json",
                note: "Project-level file for Claude Code. The token is read from the SEMANTIC_ENGINE_TOKEN environment variable, so the file is safe to commit.",
                code: json({ mcpServers: envServers })
            },
            {
                id: "claude-desktop",
                label: "Claude Desktop",
                language: "json",
                note: "claude_desktop_config.json. Desktop speaks stdio, so mcp-remote bridges to this HTTP endpoint.",
                code: json({ mcpServers: desktopServers })
            },
            {
                id: "cursor",
                label: "Cursor",
                language: "json",
                note: "~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).",
                code: json({ mcpServers: cursorServers })
            },
            {
                id: "vscode",
                label: "VS Code",
                language: "json",
                note: ".vscode/mcp.json, or the MCP: Add Server command.",
                code: json({ servers: vscodeServers })
            },
            {
                id: "codex",
                label: "Codex CLI",
                language: "toml",
                note: "~/.codex/config.toml. The token is read from an environment variable.",
                code: "[mcp_servers." + name + "]\nurl = \"" + url + "\"\nbearer_token_env_var = \"SEMANTIC_ENGINE_TOKEN\"\n\n" +
                    "# then, in your shell profile:\n# export SEMANTIC_ENGINE_TOKEN=\"" + token + "\""
            },
            {
                id: "typescript",
                label: "TypeScript SDK",
                language: "ts",
                note: "npm i @modelcontextprotocol/sdk",
                code: 'import { Client } from "@modelcontextprotocol/sdk/client/index.js";\n' +
                    'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";\n\n' +
                    'const transport = new StreamableHTTPClientTransport(new URL("' + url + '"), {\n' +
                    '  requestInit: { headers: { Authorization: "' + header + '" } },\n' +
                    '});\n' +
                    'const client = new Client({ name: "my-agent", version: "1.0.0" });\n' +
                    'await client.connect(transport);\n\n' +
                    (project ? "" : 'console.log(await client.callTool({ name: "list_projects", arguments: {} }));\n') +
                    'console.log(await client.callTool(' + example + '));'
            },
            {
                id: "python",
                label: "Python SDK",
                language: "python",
                note: "pip install mcp",
                code: "import asyncio\n" +
                    "from mcp import ClientSession\n" +
                    "from mcp.client.streamable_http import streamablehttp_client\n\n" +
                    'URL = "' + url + '"\n' +
                    'HEADERS = {"Authorization": "' + header + '"}\n\n' +
                    "async def main():\n" +
                    "    async with streamablehttp_client(URL, headers=HEADERS) as (read, write, _):\n" +
                    "        async with ClientSession(read, write) as session:\n" +
                    "            await session.initialize()\n" +
                    "            print([tool.name for tool in (await session.list_tools()).tools])\n" +
                    (project
                        ? '            print(await session.call_tool("find_symbol", {"name": "Router"}))\n'
                        : '            print(await session.call_tool("list_projects", {}))\n' +
                          '            print(await session.call_tool("find_symbol", {"project": "my-app", "name": "Router"}))\n') +
                    "\nasyncio.run(main())"
            },
            {
                id: "curl",
                label: "curl",
                language: "bash",
                note: "Raw JSON-RPC, handy to check the endpoint from a terminal.",
                code: "curl -s " + url + " \\\n" +
                    '  -H "Authorization: Bearer ' + token + '" \\\n' +
                    '  -H "Content-Type: application/json" \\\n' +
                    '  -H "Accept: application/json, text/event-stream" \\\n' +
                    "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'"
            }
        ];
    }

    function renderLogLines(lines) {
        if (!lines || lines.length === 0) return '<p class="muted">The log is empty: this worker has not written anything yet.</p>';
        return '<pre class="log">' + escape(lines.join("\n")) + "</pre>";
    }

    /* A worker/gateway event, newest last, one line each. */
    function renderEvents(events) {
        if (!events || events.length === 0) {
            return '<p class="muted">No events recorded for this project since the Gateway started.</p>';
        }
        return '<ul class="events">' + events.map(function (event) {
            const kind = event.kind || event.type || "event";
            const detail = event.detail || event.error || "";
            return '<li class="event event-' + escape(kind) + '"><time>' + escape(event.at) + "</time>" +
                "<strong>" + escape(kind) + "</strong>" +
                (detail ? "<span>" + escape(detail) + "</span>" : "") + "</li>";
        }).join("") + "</ul>";
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
        "dataDir", "outOverride", "artifactLocation",
        ["scan", "ignore"], ["diagnostics", "budgetMs"],
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
        mcpEndpointUrl,
        withToken,
        connectSnippets,
        renderLogLines,
        renderEvents
    };
})();


if (typeof module !== "undefined" && module.exports) {
    module.exports = GatewayUi;
}


/* ── browser bootstrap ───────────────────────────────────────────────── */
if (typeof document !== "undefined") {
    (function () {
        const params = new URLSearchParams(location.search);
        const token = params.get("token") || localStorage.getItem("se.gateway.token") || "";
        if (token) {
            localStorage.setItem("se.gateway.token", token);
            /* the project dashboard and the settings page read this key */
            localStorage.setItem("se.token", token);
        }

        const headers = function () {
            return token ? { Authorization: "Bearer " + token } : {};
        };

        const $ = function (id) { return document.getElementById(id); };
        const els = {
            cards: $("cards"),
            rows: $("worker-rows"),
            status: $("status"),
            form: $("worker-form"),
            formFields: $("form-fields"),
            preview: $("command-preview"),
            formErrors: $("form-errors"),
            formTitle: $("form-title"),
            health: $("health-panel"),
            healthBody: $("health-body"),
            info: $("info-modal"),
            infoTitle: $("info-title"),
            infoSub: $("info-sub"),
            infoBody: $("info-body"),
            infoFoot: $("info-foot")
        };

        let workers = [];
        let editing = null;
        let formBlocked = false;
        /* what the info modal shows, so a live event can refresh it */
        let infoState = null;
        let followTimer = null;

        async function api(path, options) {
            const res = await fetch(path, Object.assign({ headers: headers() }, options || {}));
            const text = await res.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
            if (!res.ok) throw new Error((body && (body.error || body.raw)) || res.status);
            return body;
        }

        /* ── modal plumbing ─────────────────────────────────────────── */

        function showModal(modal) {
            modal.hidden = false;
            document.body.classList.add("modal-open");
            const first = modal.querySelector("input:not([type=hidden]), select, textarea");
            const target = first || modal.querySelector(".modal");
            if (target && target.focus) target.focus({ preventScroll: true });
        }

        function hideModal(modal) {
            modal.hidden = true;
            if (modal === els.info) {
                infoState = null;
                if (followTimer) { clearInterval(followTimer); followTimer = null; }
            }
            if (modal === els.form) editing = null;
            if (!document.querySelector(".modal-backdrop:not([hidden])")) {
                document.body.classList.remove("modal-open");
            }
        }

        document.addEventListener("click", function (event) {
            const closer = event.target.closest("[data-close]");
            if (closer) { hideModal(closer.closest(".modal-backdrop")); return; }
            if (event.target.classList && event.target.classList.contains("modal-backdrop")) {
                hideModal(event.target);
            }
        });

        document.addEventListener("keydown", function (event) {
            if (event.key !== "Escape") return;
            const open = Array.prototype.filter.call(
                document.querySelectorAll(".modal-backdrop"), function (m) { return !m.hidden; });
            if (open.length > 0) hideModal(open[open.length - 1]);
        });

        function copyText(text, button) {
            const done = function () {
                if (!button) return;
                const label = button.textContent;
                button.textContent = "Copied";
                setTimeout(function () { button.textContent = label; }, 1200);
            };
            if (navigator.clipboard && window.isSecureContext !== false) {
                navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
            } else {
                legacyCopy(text);
                done();
            }
        }

        function legacyCopy(text) {
            const area = document.createElement("textarea");
            area.value = text;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            try { document.execCommand("copy"); } catch (e) { /* the text stays selectable in the page */ }
            area.remove();
        }

        document.addEventListener("click", function (event) {
            const button = event.target.closest("[data-copy]");
            if (!button) return;
            const source = document.getElementById(button.getAttribute("data-copy"));
            if (source) copyText(source.value !== undefined && source.tagName !== "PRE" ? source.value : source.textContent, button);
        });

        /*
        | One generic dialog for everything that only shows information: logs,
        | events, the MCP endpoint and the connection guide. `actions` become
        | footer buttons; `reload` (optional) re-fetches and re-renders.
        */
        function openInfo(config) {
            els.infoTitle.textContent = config.title;
            els.infoSub.textContent = config.sub || "";
            els.infoBody.innerHTML = config.body;
            els.infoFoot.innerHTML = (config.actions || []).map(function (action) {
                return '<button type="button"' + (action.primary ? ' class="primary"' : "") +
                    ' data-info-action="' + GatewayUi.escape(action.id) + '">' + GatewayUi.escape(action.label) + "</button>";
            }).join("") + '<button type="button" data-close>Close</button>';
            infoState = config;
            els.infoBody.onclick = null;
            els.infoBody.onchange = null;
            els.info.querySelector(".modal").classList.toggle("modal-lg", Boolean(config.wide));
            if (followTimer) { clearInterval(followTimer); followTimer = null; }
            showModal(els.info);
        }

        els.infoFoot.addEventListener("click", function (event) {
            const button = event.target.closest("[data-info-action]");
            if (!button || !infoState || !infoState.onAction) return;
            infoState.onAction(button.getAttribute("data-info-action"), button);
        });

        function paintInfoBody(html) {
            els.infoBody.innerHTML = html;
        }

        /* ── data ───────────────────────────────────────────────────── */

        function render() {
            const stats = GatewayUi.summarize(workers);
            els.cards.innerHTML = GatewayUi.renderSummaryCards(stats);
            els.rows.innerHTML = workers.map(GatewayUi.renderWorkerRow).join("");
            $("empty-hint").hidden = workers.length > 0;
        }

        async function refresh() {
            try {
                const list = await api("/api/v1/gateway/projects");
                workers = list.projects || [];
                els.status.textContent = "connected";
                $("status-dot").className = "dot dot-ok";
                render();
            } catch (error) {
                els.status.textContent = "error: " + error.message;
                $("status-dot").className = "dot dot-bad";
            }
        }

        /* ── worker form (new / edit) ───────────────────────────────── */

        function openForm(projectId) {
            const worker = workers.find(function (w) { return w.projectId === projectId; });
            editing = projectId;
            formBlocked = false;
            els.formErrors.textContent = "";

            /*
            | SE-F-057 — hydrate EVERY field from the project's real, effective
            | worker config. If that fetch fails the form must not be saved
            | blind: a submit would write the visible fields over the real
            | config. Only identity is trusted then.
            */
            const identity = worker
                ? { projectId: worker.projectId, name: worker.name, rootPath: worker.rootPath }
                : {};

            function paintValues(values) {
                els.formTitle.textContent = worker ? "Edit " + worker.name : "New worker";
                els.formFields.innerHTML = GatewayUi.renderFormFields(values);
                showModal(els.form);
                updatePreview();
            }

            function paint(config) {
                paintValues(GatewayUi.configToForm(config || identity));
            }

            if (!worker) {
                paintValues(Object.assign({}, GatewayUi.DEFAULT_FORM_VALUES));
                return;
            }

            api("/api/v1/gateway/projects/" + encodeURIComponent(projectId))
                .then(function (detail) { paint(detail && detail.config ? detail.config : identity); })
                .catch(function (error) {
                    formBlocked = true;
                    paint(identity);
                    els.formErrors.textContent =
                        "config load failed: " + error.message +
                        " — fix the connection before saving this worker";
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
            if (!formBlocked) els.formErrors.textContent = "";
            const errors = GatewayUi.validateForm(values);
            if (errors.length > 0) {
                els.formErrors.textContent = errors
                    .map(function (e) { return e.field + ": " + e.message; })
                    .join(" — ");
            }
            els.preview.textContent = GatewayUi.commandPreview(GatewayUi.formToConfig(values));
        }

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

            const config = GatewayUi.formToConfig(values);
            const request = GatewayUi.buildSaveRequest(config, editing, start);
            try {
                await api(request.url, {
                    method: request.method,
                    headers: Object.assign({ "Content-Type": "application/json" }, headers()),
                    body: JSON.stringify(request.body)
                });
                els.formErrors.textContent = "";
                hideModal(els.form);
                await refresh();
            } catch (error) {
                els.formErrors.textContent = error.message;
            }
        }

        els.formFields.addEventListener("input", updatePreview);
        $("new-worker").addEventListener("click", function () {
            editing = null;
            formBlocked = false;
            els.formErrors.textContent = "";
            els.formTitle.textContent = "New worker";
            els.formFields.innerHTML = GatewayUi.renderFormFields(GatewayUi.DEFAULT_FORM_VALUES);
            showModal(els.form);
            updatePreview();
        });
        $("save-start").addEventListener("click", function () { save(true); });
        $("save-only").addEventListener("click", function () { save(false); });

        /* ── logs & events ──────────────────────────────────────────── */

        async function showLogs(projectId) {
            const worker = workers.find(function (w) { return w.projectId === projectId; });
            const load = async function () {
                const data = await api("/api/v1/gateway/projects/" + encodeURIComponent(projectId) + "/logs?lines=400");
                return { data: data, html: GatewayUi.renderLogLines(data.lines) };
            };
            const first = await load();
            const note = first.data.note ? " — " + first.data.note : "";
            openInfo({
                title: "Logs — " + (worker ? worker.name : projectId),
                sub: first.data.file + " · " + first.data.sizeBytes + " bytes" + note,
                body: '<div class="log-wrap" id="log-wrap">' + first.html + "</div>",
                actions: [
                    { id: "refresh", label: "Refresh" },
                    { id: "follow", label: "Follow: off" },
                    { id: "copy", label: "Copy" }
                ],
                onAction: async function (id, button) {
                    if (id === "copy") {
                        const pre = els.infoBody.querySelector("pre");
                        copyText(pre ? pre.textContent : "", button);
                        return;
                    }
                    if (id === "follow") {
                        if (followTimer) {
                            clearInterval(followTimer); followTimer = null;
                            button.textContent = "Follow: off";
                        } else {
                            button.textContent = "Follow: on";
                            followTimer = setInterval(reload, 3000);
                        }
                        return;
                    }
                    reload();
                }
            });
            scrollLog();

            async function reload() {
                try {
                    const next = await load();
                    paintInfoBody('<div class="log-wrap" id="log-wrap">' + next.html + "</div>");
                    scrollLog();
                } catch (error) {
                    paintInfoBody('<p class="error">' + GatewayUi.escape(error.message) + "</p>");
                }
            }
            function scrollLog() {
                const wrap = $("log-wrap");
                if (wrap) wrap.scrollTop = wrap.scrollHeight;
            }
        }

        async function showEvents(projectId) {
            const worker = workers.find(function (w) { return w.projectId === projectId; });
            const load = async function () {
                const data = await api("/api/v1/gateway/projects/" + encodeURIComponent(projectId) + "/events");
                return GatewayUi.renderEvents(data.events);
            };
            const html = await load();
            openInfo({
                title: "Events — " + (worker ? worker.name : projectId),
                sub: "Starts, stops, crashes and restarts seen since the Gateway started. Updates live.",
                body: html,
                kind: "events",
                projectId: projectId,
                reload: async function () { paintInfoBody(await load()); },
                actions: [{ id: "refresh", label: "Refresh" }],
                onAction: function () { infoState.reload(); }
            });
        }

        /* ── health ─────────────────────────────────────────────────── */

        async function showHealth(projectId) {
            const detail = await api("/api/v1/gateway/projects/" + encodeURIComponent(projectId) + "/health");
            els.healthBody.innerHTML = GatewayUi.renderHealthPanel(detail);
            showModal(els.health);
        }

        /* ── MCP ────────────────────────────────────────────────────── */

        async function rpc(path, method, params) {
            const res = await fetch(path, {
                method: "POST",
                headers: Object.assign({
                    "Content-Type": "application/json",
                    Accept: "application/json, text/event-stream"
                }, headers()),
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params || {} })
            });
            const text = await res.text();
            if (!res.ok) {
                let message = text;
                try { message = JSON.parse(text).error || text; } catch (e) { /* keep the raw text */ }
                throw new Error(res.status + " " + message);
            }
            const trimmed = text.trim();
            if (trimmed.charAt(0) === "{") return JSON.parse(trimmed);
            const data = trimmed.split(/\r?\n/).filter(function (l) { return l.indexOf("data:") === 0; }).pop();
            if (!data) throw new Error("empty answer");
            return JSON.parse(data.slice(5));
        }

        async function testEndpoint(path) {
            const started = Date.now();
            const reply = await rpc(path, "tools/list");
            if (reply.error) throw new Error(reply.error.message);
            const tools = (reply.result && reply.result.tools) || [];
            return tools.length + " tools available (" + (Date.now() - started) + " ms)";
        }

        function endpointRow(label, url) {
            const id = "ep-" + Math.random().toString(36).slice(2, 8);
            return '<div class="endpoint"><span class="endpoint-label">' + GatewayUi.escape(label) + "</span>" +
                '<input id="' + id + '" type="text" readonly value="' + GatewayUi.escape(url) + '">' +
                '<button type="button" data-copy="' + id + '">Copy</button></div>';
        }

        function showMcp(projectId) {
            const worker = workers.find(function (w) { return w.projectId === projectId; });
            const own = location.origin + GatewayUi.mcpEndpointUrl(projectId);
            const all = location.origin + "/mcp";
            const body =
                '<p class="lead">This address is for AI clients, not for a browser tab: MCP talks JSON-RPC over POST, ' +
                "so opening it as a page can only answer \"method not allowed\".</p>" +
                endpointRow("This project", GatewayUi.withToken(own, token)) +
                endpointRow("All projects", GatewayUi.withToken(all, token)) +
                '<p class="muted">The all-projects address is the one to give your AI: it is configured once, and the AI ' +
                "picks the project per call by name or id (tool <code>list_projects</code>).</p>" +
                '<p id="mcp-test-result" class="test-result" role="status"></p>';
            openInfo({
                title: "MCP — " + (worker ? worker.name : projectId),
                sub: "Project id: " + projectId,
                body: body,
                actions: [
                    { id: "test", label: "Test this project", primary: true },
                    { id: "guide", label: "Connection guide" }
                ],
                onAction: async function (id, button) {
                    if (id === "guide") { showConnect(projectId); return; }
                    const out = $("mcp-test-result");
                    out.className = "test-result"; out.textContent = "testing…";
                    button.disabled = true;
                    try {
                        out.textContent = "OK — " + await testEndpoint(GatewayUi.mcpEndpointUrl(projectId));
                        out.className = "test-result ok";
                    } catch (error) {
                        out.textContent = "Failed — " + error.message;
                        out.className = "test-result bad";
                    } finally {
                        button.disabled = false;
                    }
                }
            });
        }

        /* ── "Connect AI" guide ─────────────────────────────────────── */

        function showConnect(preselected) {
            const state = { scope: preselected ? "project" : "all", projectId: preselected || (workers[0] && workers[0].projectId) || "", tab: "claude-code" };

            function snippetsHtml() {
                const snippets = GatewayUi.connectSnippets({
                    origin: location.origin,
                    token: token,
                    projectId: state.scope === "project" ? state.projectId : undefined
                });
                const current = snippets.find(function (s) { return s.id === state.tab; }) || snippets[0];
                const tabs = snippets.map(function (s) {
                    return '<button type="button" role="tab" class="tab' + (s.id === current.id ? " active" : "") +
                        '" data-tab="' + s.id + '" aria-selected="' + (s.id === current.id) + '">' + GatewayUi.escape(s.label) + "</button>";
                }).join("");
                return '<div class="tabs" role="tablist">' + tabs + "</div>" +
                    '<p class="muted">' + GatewayUi.escape(current.note) + "</p>" +
                    '<div class="code-block"><button type="button" class="copy-code" data-copy="snippet-code">Copy</button>' +
                    '<pre id="snippet-code" data-lang="' + current.language + '">' + GatewayUi.escape(current.code) + "</pre></div>";
            }

            function bodyHtml() {
                const options = workers.map(function (w) {
                    return '<option value="' + GatewayUi.escape(w.projectId) + '"' + (w.projectId === state.projectId ? " selected" : "") + ">" +
                        GatewayUi.escape(w.name + " (" + w.projectId + ")") + "</option>";
                }).join("");
                return '<div class="steps">' +
                    "<div><b>1</b><span>Pick a mode</span></div>" +
                    "<div><b>2</b><span>Paste the config into your client</span></div>" +
                    "<div><b>3</b><span>Press Test</span></div></div>" +
                    '<div class="scope">' +
                    '<label><input type="radio" name="scope" value="all"' + (state.scope === "all" ? " checked" : "") + "> " +
                    "<span><b>All projects</b> (recommended) — one entry; the AI chooses the project with the <code>project</code> argument.</span></label>" +
                    '<label><input type="radio" name="scope" value="project"' + (state.scope === "project" ? " checked" : "") + "> " +
                    "<span><b>One project</b> — a fixed address for a single project. " +
                    '<select id="scope-project"' + (state.scope === "project" ? "" : " disabled") + ">" + options + "</select></span></label></div>" +
                    '<div id="snippets">' + snippetsHtml() + "</div>" +
                    '<p class="muted">The token above is this Gateway\'s own and does not change between restarts unless you start it with ' +
                    "<code>--rotate-token</code> or pin another with <code>--token</code>. Treat these snippets like a password.</p>" +
                    '<details class="how"><summary>How the AI finds a project</summary>' +
                    "<ol><li>The AI calls <code>list_projects</code> and gets every project's <code>id</code>, <code>name</code> and state.</li>" +
                    "<li>It passes <code>project</code> (an id, a name or the folder name) to any other tool. With a single project the argument can be left out.</li>" +
                    "<li>The Gateway sends the call to that project's worker. Adding or removing projects never changes your client's configuration.</li></ol></details>" +
                    '<p id="connect-test-result" class="test-result" role="status"></p>';
            }

            openInfo({
                title: "Connect an AI",
                sub: "Gateway " + location.origin,
                body: bodyHtml(),
                wide: true,
                actions: [{ id: "test", label: "Test all-projects endpoint", primary: true }],
                onAction: async function (id, button) {
                    const out = $("connect-test-result");
                    out.className = "test-result"; out.textContent = "testing…";
                    button.disabled = true;
                    try {
                        out.textContent = "OK — " + await testEndpoint("/mcp");
                        out.className = "test-result ok";
                    } catch (error) {
                        out.textContent = "Failed — " + error.message;
                        out.className = "test-result bad";
                    } finally {
                        button.disabled = false;
                    }
                }
            });

            els.infoBody.onclick = function (event) {
                const tab = event.target.closest("[data-tab]");
                if (!tab) return;
                state.tab = tab.getAttribute("data-tab");
                $("snippets").innerHTML = snippetsHtml();
            };
            els.infoBody.onchange = function (event) {
                if (event.target.name === "scope") {
                    state.scope = event.target.value;
                    $("scope-project").disabled = state.scope !== "project";
                } else if (event.target.id === "scope-project") {
                    state.projectId = event.target.value;
                }
                $("snippets").innerHTML = snippetsHtml();
            };
        }

        /* ── row actions ────────────────────────────────────────────── */

        async function act(action, projectId) {
            try {
                if (action === "open") {
                    location.href = GatewayUi.withToken(GatewayUi.projectDashboardUrl(projectId), token);
                    return;
                }
                if (action === "mcp") { showMcp(projectId); return; }
                if (action === "edit") { openForm(projectId); return; }
                if (action === "health") { await showHealth(projectId); return; }
                if (action === "logs") { await showLogs(projectId); return; }
                if (action === "events") { await showEvents(projectId); return; }
                if (action === "remove") {
                    if (!window.confirm("Remove project " + projectId + " from the Gateway? Its source files are not touched.")) return;
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

        $("connect-ai").addEventListener("click", function () { showConnect(); });
        $("refresh").addEventListener("click", function () { refresh(); });
        $("settings-link").setAttribute("href", GatewayUi.withToken("/open.html", token));

        /* the version and the stable facts about this Gateway */
        api("/api/v1/gateway/info").then(function (info) {
            $("version").textContent = "v" + info.version;
            $("version").hidden = false;
        }).catch(function () { /* the dashboard works without it */ });

        /*
        | Live updates over SSE; polling is only the fallback, because a busy
        | Gateway should not re-read the whole list every few seconds.
        */
        function connectEvents() {
            const url = "/api/v1/gateway/events" + (token ? "?token=" + encodeURIComponent(token) : "");
            const source = new EventSource(url);
            source.addEventListener("gateway", function (message) {
                refresh();
                if (infoState && infoState.kind === "events") {
                    try {
                        const event = JSON.parse(message.data);
                        if (event.projectId === infoState.projectId) infoState.reload();
                    } catch (e) { /* a malformed event is ignored */ }
                }
            });
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
