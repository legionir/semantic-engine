"use strict";

/*
| The console keeps no state of its own beyond what the runtime reports:
| every box on screen is rebuilt from the event stream, so a reload
| reproduces the same picture from the snapshot.
|
| Three things are deliberately modal rather than inline, because they
| interrupt: settings, an approval request, and the full detail of one
| executed call. They share the Modal service in modal.js.
*/

const el = id => document.getElementById(id);

const escape = Modal.escape;

const state = {
    agents: new Map(),
    order: [],
    graphs: new Map(),
    calls: new Map(),
    approvals: new Map(),
    loops: [],
    hooks: new Map(),
    hookOrder: [],
    currentTask: null,
    plan: null,
    messages: [],
    events: [],
    waiting: null,
    waitingElapsed: null,
    waitingTimer: null,
    session: null,
    sessions: [],
    historyModal: null,
    executionModal: null,
    eventsModal: null,
    status: "idle",
    startedAt: null,
    timer: null,
    approvalModal: null,
    settingsModal: null,
    settings: [],
    logFilter: ""
};


/* ---------------------------------------------------------------- helpers */

function shorten(value, max = 90) {

    const text =
        typeof value === "string"
            ? value
            : JSON.stringify(value ?? "");

    return text.length > max
        ? `${text.slice(0, max)}…`
        : text;
}


function singleLine(value, max = 90) {

    const text =
        String(value || "")
            .replace(/\s+/g, " ")
            .trim();

    return text.length > max
        ? `${text.slice(0, max)}…`
        : text || "Untitled task";
}


function node(tag, className, text) {

    const element =
        document.createElement(tag);

    if (className) {
        element.className = className;
    }

    if (text !== undefined && text !== null) {
        element.textContent = text;
    }

    return element;
}


function agentNode(scope, depth, extra = {}) {

    if (!state.agents.has(scope)) {

        state.agents.set(scope, {
            scope,
            name: extra.name || scope,
            depth: depth || 0,
            parent: null,
            parentScope: null,
            persona: null,
            delegationId: null,
            task: null,
            status: "running",
            iterations: 0,
            graphs: [],
            skills: [],
            loops: []
        });

        state.order.push(scope);
    }

    const item =
        state.agents.get(scope);

    if (depth !== undefined && depth !== null) {
        item.depth = depth;
    }

    for (const [key, value] of Object.entries(extra)) {

        if (value !== undefined && value !== null) {
            item[key] = value;
        }
    }

    return item;
}


function graphNode(event) {

    const id =
        event.graph_id || `${event.agent}:loose`;

    if (!state.graphs.has(id)) {

        state.graphs.set(id, {
            id,
            agent: event.agent || "main_agent",
            kind: "tools",
            shape: event.shape || "single",
            waves: event.waves || [],
            maxParallel: event.max_parallel || null,
            iteration: event.iteration ?? null,
            order: [],
            calls: new Map()
        });

        const owner =
            agentNode(event.agent || "main_agent");

        owner.graphs.push(id);
    }

    const graph =
        state.graphs.get(id);

    if (event.shape) {
        graph.shape = event.shape;
    }

    if (event.waves) {
        graph.waves = event.waves;
    }

    if (event.iteration !== undefined && event.iteration !== null) {
        graph.iteration = event.iteration;
    }

    return graph;
}


/* ------------------------------------------------------------------ tree */

const SHAPE_LABEL = {
    single: "single call",
    parallel: "parallel",
    sequential: "sequential",
    graph: "dependency graph"
};


function statusIcon(status) {

    return status === "running"
        ? "◌"
        : status === "failed"
            ? "✕"
            : status === "skipped"
                ? "–"
                : status === "exit" || status === "warned"
                ? "!"
                : "✓";
}


function archiveCurrentExecution() {

    if (
        state.order.length === 0 &&
        state.hookOrder.length === 0
    ) {
        return false;
    }

    const tree = el("tree");
    const archive = el("executionArchive");
    const details = node("details", "execution-run");
    const summary = node("summary");

    summary.append(
        node("span", "archived-title", singleLine(state.currentTask, 100)),
        node("span", "archived-summary", el("execSummary").textContent)
    );

    const body = node("div", "archived-tree");

    while (tree.firstChild) {
        body.appendChild(tree.removeChild(tree.firstChild));
    }

    details.append(summary, body);
    archive.appendChild(details);

    while (archive.children.length > 50) {
        archive.removeChild(archive.firstChild);
    }

    return true;
}


function renderTree() {

    const container = el("tree");

    if (state.order.length === 0) {

        container.innerHTML =
            '<p class="empty">No run yet. Send a task to see the agent tree.</p>';

        el("execSummary").textContent = "";

        return;
    }

    container.innerHTML = "";

    let calls = 0;
    let failures = 0;

    if (state.hookOrder.length > 0) {

        const routine = node("div", "routine");
        routine.appendChild(node("div", "routine-title", "Runtime routine"));

        for (const id of state.hookOrder) {

            const hook = state.hooks.get(id);

            if (!hook) {
                continue;
            }

            routine.appendChild(
                node(
                    "div",
                    `hook ${hook.status}`,
                    `${statusIcon(hook.status)} ${hook.phase} · ${hook.id} · ${hook.hook_type}${
                        hook.summary ? ` — ${shorten(hook.summary, 100)}` : ""
                    }`
                )
            );
        }

        container.appendChild(routine);
    }

    for (const scope of state.order) {

        const agent =
            state.agents.get(scope);

        const box = node("div", `node depth-${agent.depth}`);

        box.style.marginLeft = `${agent.depth * 16}px`;

        const head = node("div", "node-head");

        head.append(
            node("span", "node-name", agent.name),
            node("span", `badge ${agent.status}`, agent.status)
        );

        if (agent.depth > 0) {
            head.appendChild(
                node("span", "badge depth", `depth ${agent.depth}`)
            );
        }

        if (agent.iterations) {
            head.appendChild(
                node("span", "badge", `iteration ${agent.iterations}`)
            );
        }

        if (agent.parentScope || agent.parent) {
            head.appendChild(
                node(
                    "span",
                    "badge parent",
                    `↳ from ${agent.parentScope || agent.parent}`
                )
            );
        }

        if (agent.persona) {
            head.appendChild(
                node("span", "badge muted", agent.persona)
            );
        }

        if (agent.task) {
            head.appendChild(
                node("span", "node-task", shorten(agent.task, 80))
            );
        }

        box.appendChild(head);

        for (const name of agent.skills || []) {

            box.appendChild(
                node("div", "skill", `Loaded skill ${name}`)
            );
        }

        for (const loop of agent.loops) {

            box.appendChild(
                node(
                    "div",
                    `loop ${loop.outcome}`,
                    `${
                        loop.outcome === "malformed" ||
                        loop.outcome === "malformed_stopped"
                            ? `⚠ unreadable answer ×${loop.repeats}`
                            : loop.outcome === "stalled"
                                ? "↻ no progress"
                                : `↻ repeated failure ×${loop.repeats}`
                    } — ${shorten(loop.signature || loop.reason || "", 90)}${
                        loop.outcome === "malformed_stopped"
                            ? " (retry budget exhausted; run stopped)"
                            : loop.outcome === "stopped"
                                ? " (run stopped)"
                                : ""
                    }`
                )
            );
        }

        for (const graphId of agent.graphs) {

            const graph =
                state.graphs.get(graphId);

            if (!graph) {
                continue;
            }

            const group = node("div", "graph");

            const groupHead = node("div", "graph-head");

            groupHead.append(
                node(
                    "span",
                    `badge shape ${graph.shape}`,
                    SHAPE_LABEL[graph.shape] || graph.shape
                ),
                node(
                    "span",
                    "muted",
                    `${graph.calls.size} call${
                        graph.calls.size === 1 ? "" : "s"
                    } · ${graph.waves.length || 1} wave${
                        (graph.waves.length || 1) === 1 ? "" : "s"
                    }${
                        graph.iteration
                            ? ` · iteration ${graph.iteration}`
                            : ""
                    }`
                )
            );

            group.appendChild(groupHead);

            let lastWave = null;

            for (const id of graph.order) {

                const call = graph.calls.get(id);

                calls++;

                if (call.status === "failed") {
                    failures++;
                }

                if (
                    graph.shape !== "single" &&
                    call.wave !== null &&
                    call.wave !== lastWave
                ) {

                    lastWave = call.wave;

                    const inWave =
                        graph.waves[call.wave] || [];

                    group.appendChild(
                        node(
                            "div",
                            "wave-label",
                            `wave ${call.wave + 1}${
                                inWave.length > 1
                                    ? ` · ${inWave.length} in parallel`
                                    : ""
                            }`
                        )
                    );
                }

                group.appendChild(callRow(call, graph));
            }

            box.appendChild(group);
        }

        container.appendChild(box);
    }

    el("execSummary").textContent =
        `${state.order.length} agent${
            state.order.length === 1 ? "" : "s"
        } · ${calls} call${calls === 1 ? "" : "s"}${
            failures ? ` · ${failures} failed` : ""
        }${
            state.hookOrder.length ? ` · ${state.hookOrder.length} hook` : ""
        }${
            state.loops.length ? ` · ${state.loops.length} loop` : ""
        }`;
}


function renderPlan() {

    const container = el("plan");
    const plan = state.plan;

    container.innerHTML = "";

    if (!plan || !plan.exists) {

        container.appendChild(
            node(
                "p",
                "empty",
                plan?.error
                    ? `Plan unavailable: ${plan.error}`
                    : "No plan yet."
            )
        );

        el("planSummary").textContent = "";
        return;
    }

    el("planSummary").textContent =
        `${plan.done || 0}/${plan.steps || 0} done${
            plan.blocked ? ` · ${plan.blocked} blocked` : ""
        }`;

    if (plan.objective) {
        container.appendChild(
            node("p", "plan-objective", plan.objective)
        );
    }

    for (const [index, phase] of (plan.phases || []).entries()) {

        const details = node("details", "plan-phase");

        details.open =
            phase.status === "in_progress" ||
            (
                index === 0 &&
                !(plan.phases || []).some(item => item.status === "in_progress")
            );

        const summary = node("summary");

        summary.append(
            node("span", null, `${phase.id || `phase ${index + 1}`} · ${phase.title || "Untitled phase"}`),
            node("span", `badge ${phase.status || "pending"}`, phase.status || "pending")
        );

        details.appendChild(summary);

        if (phase.goal) {
            details.appendChild(node("div", "plan-goal", phase.goal));
        }

        const steps = node("ol", "plan-steps");

        for (const step of phase.steps || []) {

            const item = node("li", `plan-step ${step.status || "pending"}`);
            const head = node("div", "plan-step-head");

            head.append(
                node("span", "plan-step-id", step.id),
                node("span", "plan-step-title", step.title),
                node("span", `badge ${step.status || "pending"}`, step.status || "pending")
            );

            if (step.agent) {
                head.appendChild(
                    node("span", "plan-step-agent", `@${step.agent}`)
                );
            }

            item.appendChild(head);

            if (step.evidence) {
                item.appendChild(
                    node("div", "plan-evidence", step.evidence)
                );
            }

            steps.appendChild(item);
        }

        if ((phase.steps || []).length === 0) {
            steps.appendChild(node("li", "empty", "No steps defined."));
        }

        details.appendChild(steps);
        container.appendChild(details);
    }

    if (plan.routine?.enabled) {

        container.appendChild(
            node(
                "div",
                "plan-routine",
                `Runtime routine · before: ${
                    (plan.routine.before_task || []).join(", ") || "none"
                } · after: ${
                    (plan.routine.after_task || []).join(", ") || "none"
                }`
            )
        );
    }
}


function callRow(call, graph) {

    const row =
        node("button", `tool ${call.status}`);

    row.type = "button";
    row.title = "click for the full call";

    row.append(
        node("span", "icon", statusIcon(call.status)),
        node("span", "name", call.name),
        node("span", "args", shorten(call.argumentsPreview, 70))
    );

    if ((call.depends_on || []).length > 0) {

        row.appendChild(
            node(
                "span",
                "badge dep",
                `after ${call.depends_on.join(", ")}`
            )
        );
    }

    if (call.exitCode) {
        row.appendChild(node("span", "badge dep", `exit ${call.exitCode}`));
    }

    if (call.warning) {
        row.appendChild(node("span", "badge dep", "warning"));
    }

    if (call.duration !== undefined && call.duration !== null) {
        row.appendChild(node("span", "ms", `${call.duration} ms`));
    }

    row.addEventListener(
        "click",
        () => openCallDetail(call, graph)
    );

    return row;
}


/* ----------------------------------------------------------- call detail */

function definition(list, label, value) {

    if (value === undefined || value === null || value === "") {
        return;
    }

    list.append(
        node("dt", null, label),
        node("dd", null, String(value))
    );
}


async function openCallDetail(call, graph) {

    const body = node("div", "detail");

    const list = node("dl", "detail-grid");

    definition(list, "tool", call.name);
    definition(list, "status", call.status);
    definition(list, "exit code", call.exitCode);
    definition(list, "warning", call.warning);
    definition(list, "executed by", call.agent);

    const owner =
        state.agents.get(call.agent);

    if (owner && (owner.parentScope || owner.parent)) {
        definition(
            list,
            "agent parent",
            `${owner.parentScope || owner.parent} (depth ${owner.depth})`
        );
    }

    definition(list, "iteration", call.iteration);
    definition(list, "call id", call.id);

    if (graph) {

        definition(
            list,
            "execution",
            `${SHAPE_LABEL[graph.shape] || graph.shape}, wave ${
                (call.wave ?? 0) + 1
            } of ${graph.waves.length || 1}`
        );

        definition(list, "graph", graph.id);

        if (graph.maxParallel) {
            definition(list, "max parallel", graph.maxParallel);
        }

        const siblings =
            (graph.waves[call.wave] || []).filter(
                id => id !== call.id
            );

        if (siblings.length > 0) {
            definition(list, "ran alongside", siblings.join(", "));
        }
    }

    if ((call.depends_on || []).length > 0) {
        definition(list, "depends on", call.depends_on.join(", "));
    }

    definition(
        list,
        "duration",
        call.duration === undefined || call.duration === null
            ? null
            : `${call.duration} ms`
    );

    body.appendChild(list);

    const argumentsBlock = node("div", "detail-block");

    argumentsBlock.append(
        node("h3", null, "Arguments"),
        node("pre", null, call.argumentsPreview || "{}")
    );

    body.appendChild(argumentsBlock);

    const resultBlock = node("div", "detail-block");

    resultBlock.append(
        node("h3", null, call.status === "failed" ? "Error" : "Result"),
        node(
            "pre",
            call.status === "failed" ? "bad" : null,
            call.error || call.resultPreview || "(pending)"
        )
    );

    body.appendChild(resultBlock);

    const handle =
        Modal.open({
            title: `${call.name}`,

            subtitle:
                `${call.agent} · ${call.status}${
                    call.duration !== undefined && call.duration !== null
                        ? ` · ${call.duration} ms`
                        : ""
                }`,

            size: "large",

            body,

            footer:
                Modal.row(
                    Modal.button(
                        "Copy as JSON",
                        "ghost",
                        () => copyCall(call)
                    ),
                    Modal.button(
                        "Close",
                        "",
                        () => handle.close("footer")
                    )
                )
        });

    /*
    | The stream carries a preview so a 40K result does not travel with
    | every event. The full record is fetched only when it is opened.
    */

    if (call.key) {

        try {

            const response =
                await fetch(`/api/calls/${encodeURIComponent(call.key)}`);

            if (response.ok) {

                const payload = await response.json();

                const full = payload.call;

                call.full = full;

                argumentsBlock.querySelector("pre").textContent =
                    JSON.stringify(full.arguments ?? {}, null, 2);

                resultBlock.querySelector("pre").textContent =
                    full.error ||
                    JSON.stringify(full.result ?? null, null, 2);
            }

        } catch {

            /* the preview stays on screen */
        }
    }
}


function copyCall(call) {

    const text =
        JSON.stringify(call.full || call, null, 2);

    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
}


/* ------------------------------------------------------------------ chat */

const WHO = {
    user: "you",
    assistant: "agent"
};


function updateWaitingElapsed() {

    if (!state.waitingElapsed || !state.waiting) {
        return;
    }

    state.waitingElapsed.textContent =
        `${((Date.now() - state.waiting.since) / 1000).toFixed(1)} s`;
}


function renderChat() {

    const container = el("chat");

    state.waitingElapsed = null;
    container.innerHTML = "";

    if (state.messages.length === 0) {

        container.innerHTML =
            '<p class="empty">No messages yet. Describe a task to start.</p>';

    } else {

        for (const message of state.messages) {

            container.appendChild(bubble(message));

            /* Under each user message, show the execution that ran for
               that turn as a collapsible stage-by-stage block. */
            if (message.role === "user" && message.turn_id) {

                const block = turnExecutionBlock(message.turn_id);

                if (block) {
                    container.appendChild(block);
                }
            }
        }
    }

    /*
    | While a request is in flight there is nothing to show yet, and a
    | two minute silence looks like a hang. The bubble is the wait
    | itself, and it disappears when the answer arrives.
    */

    if (state.waiting) {

        const pending =
            node("div", "bubble assistant pending");

        const elapsed = node("span", "text");
        state.waitingElapsed = elapsed;

        pending.append(
            node(
                "span",
                "who",
                `${state.waiting.agent} · thinking`
            ),
            elapsed
        );

        container.appendChild(pending);
        updateWaitingElapsed();
    }

    container.scrollTop = container.scrollHeight;
}


/*
| Builds the stage-by-stage execution block shown under a user message.
| It collects the events of the same turn (keyed by turn_id), summarises
| the tool calls and agent actions, and hides the detail behind a
| <details> element so the conversation stays readable.
*/

function turnEventsOf(turn_id) {

    return state.events.filter(
        event =>
            event.turn_id === turn_id &&
            ["agent:iteration", "agent:action", "tool:start", "tool:end", "run:malformed"].includes(event.type)
    );
}


function turnSummaryText(events) {

    const toolStarts =
        events.filter(e => e.type === "tool:start").length;

    const actions =
        events.filter(e => e.type === "agent:action");

    const actionsText =
        actions.length > 0
            ? actions.map(a => a.action).join(", ")
            : "";

    const malformed =
        events.filter(e => e.type === "run:malformed").length;

    return (
        `execution · ${toolStarts} tool call(s)${
            actionsText ? ` · ${actionsText}` : ""
        }${malformed ? ` · ${malformed} retried` : ""}`
    );
}


function turnExecutionLine(event) {

    const kind =
        event.type === "tool:end"
            ? (event.success === false ? "tool-fail" : "tool-ok")
            : event.type === "tool:start"
                ? "tool-ok"
                : event.type === "agent:action"
                    ? "action"
                    : event.type === "run:malformed"
                        ? "malformed"
                        : "";

    const line = node(
        "div",
        `turn-execution-line${kind ? ` ${kind}` : ""}`
    );

    if (event.type === "tool:start" || event.type === "tool:end") {

        line.appendChild(node("span", "tool-chip", event.name || ""));
    }

    line.appendChild(node("span", "turn-line-text", eventLabel(event)));

    return line;
}


function turnExecutionBody(events) {

    const body = node("div", "turn-execution-body");

    for (const event of events) {

        body.appendChild(turnExecutionLine(event));
    }

    return body;
}


function turnExecutionBlock(turn_id) {

    const events = turnEventsOf(turn_id);

    if (events.length === 0) {
        return null;
    }

    const details = node("details", "turn-execution");

    details.setAttribute("data-turn-id", turn_id);

    details.appendChild(
        node("summary", null, turnSummaryText(events))
    );

    details.appendChild(turnExecutionBody(events));

    return details;
}


/*
| Updates only the turn-execution block for one turn in place, instead of
| re-rendering the whole conversation. This keeps the UI stable while a run
| streams new tool events: an already-open block stays open and the chat
| does not jump. A new turn's block (added by a fresh user message) is
| rendered by renderChat, which resets it closed by default.
*/

function refreshTurnExecution(turn_id) {

    if (!turn_id) {
        return;
    }

    const chat = el("chat");

    /* A safe exact match on the data attribute: turn ids are runtime
       generated (alphanumeric + -), and CSS.escape is not present in the
       test shim, so filter the candidates explicitly. */
    let existing = null;

    for (const el of chat.querySelectorAll("details.turn-execution")) {

        if (el.getAttribute("data-turn-id") === turn_id) {
            existing = el;
            break;
        }
    }

    if (!existing) {
        renderChat();
        return;
    }

    const events = turnEventsOf(turn_id);

    existing.querySelector("summary").textContent =
        turnSummaryText(events);

    const body =
        existing.querySelector(".turn-execution-body");

    const wasOpen = existing.open;

    existing.replaceChild(
        turnExecutionBody(events),
        body
    );

    existing.open = wasOpen;
}


function eventLabel(event) {

    switch (event.type) {

        case "agent:iteration":
            return `iter ${event.iteration} · ${event.agent || event.scope}`;

        case "agent:action":
            return `action: ${event.action}`;

        case "tool:start":
            return event.id ? `start (${event.id})` : "start";

        case "tool:end":
            return event.success === false
                ? (event.error ? String(event.error).slice(0, 60) : "failed")
                : "done";

        case "run:malformed":
            return `retry: ${String(event.reason || "").slice(0, 60)}`;

        default:
            return event.type;
    }
}


/*
| Reasoning is folded away by default: it is useful when something went
| wrong and noise the rest of the time.
*/

function bubble(message) {

    const kind =
        message.kind || "message";

    const box =
        node(
            "div",
            `bubble ${message.role} ${kind === "message" ? "" : kind}`.trim()
        );

    if (kind === "thinking") {

        const details = node("details");

        /* Open reasoning by default so the agent's visible text is not
           hidden behind a collapsed summary — the user reported that no AI
           text was showing, only a "thinking" label. */
        details.open = true;

        details.appendChild(
            node(
                "summary",
                null,
                `thinking${
                    message.agent
                        ? ` · ${message.agent}`
                        : ""
                }${
                    message.iteration
                        ? ` · iteration ${message.iteration}`
                        : ""
                }`
            )
        );

        details.appendChild(node("pre", null, message.content || ""));

        box.appendChild(details);

        return box;
    }

    if (kind === "git-report") {

        box.appendChild(
            node(
                "span",
                "who",
                `git${message.branch ? ` · ${message.branch}` : ""}`
            )
        );

        box.appendChild(
            node("span", "text", message.content || "")
        );

        if (message.at) {

            box.appendChild(
                node(
                    "span",
                    "stamp",
                    new Date(message.at).toLocaleTimeString(
                        "en-GB",
                        { hour12: false }
                    )
                )
            );
        }

        return box;
    }

    box.append(
        node(
            "span",
            "who",
            `${WHO[message.role] || message.role}${
                kind === "error"
                    ? " · failed"
                    : ""
            }`
        ),
        node("span", "text", message.content || "")
    );

    if (message.at) {

        box.appendChild(
            node(
                "span",
                "stamp",
                new Date(message.at).toLocaleTimeString(
                    "en-GB",
                    { hour12: false }
                )
            )
        );
    }

    return box;
}


/* -------------------------------------------------------------- sessions */

function describeSession(session) {

    return `${session.turns || 0} turn${
        (session.turns || 0) === 1 ? "" : "s"
    } · ${session.events || 0} events · ${
        new Date(session.updated_at).toLocaleString("en-GB", {
            hour12: false
        })
    }`;
}


async function openHistory() {

    const response =
        await fetch("/api/sessions");

    const payload =
        await response.json();

    state.sessions = payload.sessions;

    const body = node("div", "sessions");

    if (payload.sessions.length === 0) {

        body.appendChild(
            node("p", "empty", "No conversations have been saved yet.")
        );
    }

    for (const session of payload.sessions) {

        const row =
            node(
                "button",
                `session${
                    session.id === payload.current
                        ? " current"
                        : ""
                }`
            );

        row.type = "button";

        row.append(
            node("span", "name", session.title || session.id),
            node("span", "facts", describeSession(session))
        );

        row.addEventListener(
            "click",
            () => loadSession(session.id)
        );

        body.appendChild(row);
    }

    const handle =
        Modal.open({
            title: "Conversations",

            subtitle:
                `${payload.sessions.length} saved in this workspace`,

            size: "medium",

            body,

            footer:
                Modal.row(
                    Modal.button(
                        "New conversation",
                        "ghost",
                        async () => {

                            await fetch("/api/sessions", { method: "POST" });

                            handle.close("new");
                        }
                    ),
                    Modal.button(
                        "Close",
                        "",
                        () => handle.close("footer")
                    )
                ),

            onClose: () => {

                state.historyModal = null;
            }
        });

    state.historyModal = handle;

    return handle;
}


/*
| Execution and Events live in a hidden row and are shown as header modals.
| Moving the actual node into the modal body (not a clone) keeps the live
| renderers working: el("tree")/el("log") still find the node wherever it
| is, and on close the node is returned to its hidden home.
*/

const hiddenSection = () => el("rowTwo");


function openExecutionModal() {

    if (state.executionModal) {
        return state.executionModal;
    }

    const tree = el("tree");
    const archive = el("executionArchive");

    const handle =
        Modal.open({
            title: "Execution",

            subtitle:
                () => el("execSummary").textContent || null,

            size: "large",

            body: archive.parentNode || tree,

            className: "execution-modal",

            onClose: () => {

                /*
                | Modal.close() detaches the backdrop before it calls this,
                | so the nodes it is holding are already out of the
                | document. Their connectedness says nothing about whether
                | they belong here; only the presence of the home does.
                */

                const section = hiddenSection();

                if (section) {

                    const scroller =
                        section.querySelector(".execution-scroll") ||
                        section;

                    scroller.appendChild(archive);
                    scroller.appendChild(tree);
                }

                state.executionModal = null;
            }
        });

    state.executionModal = handle;

    return handle;
}


function openEventsModal() {

    if (state.eventsModal) {
        return state.eventsModal;
    }

    const log = el("log");
    const filter = el("logFilter");
    const clear = el("clearLog");

    const controls = node("div", "log-controls");
    controls.appendChild(filter);
    controls.appendChild(clear);

    const body = node("div", "events-modal-body");
    body.appendChild(controls);
    body.appendChild(log);

    const handle =
        Modal.open({
            title: "Events",

            size: "large",

            body,

            className: "events-modal",

            onClose: () => {

                const section = hiddenSection();

                if (section) {

                    const scroller =
                        section.querySelector(".log-panel") ||
                        section;

                    scroller.appendChild(filter);
                    scroller.appendChild(clear);
                    scroller.appendChild(log);
                }

                state.eventsModal = null;
            }
        });

    state.eventsModal = handle;

    return handle;
}


/*
| Opening a conversation replays the events it stored, so the Execution
| and Events cards are rebuilt by the same code that draws them live.
| Nothing is summarised for storage, which is why this works at all.
*/

async function refreshSession(id) {

    const response =
        await fetch(`/api/sessions/${encodeURIComponent(id)}`);

    if (!response.ok) {
        return;
    }

    const payload =
        await response.json();

    applySession(payload.session);
}


async function loadSession(id) {

    const response =
        await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
            method: "POST"
        });

    if (!response.ok) {
        return;
    }

    const payload =
        await response.json();

    applySession(payload.session);

    if (state.historyModal) {
        state.historyModal.close("loaded");
    }
}


function applySession(session) {

    resetRun(true);

    state.messages = session.messages || [];

    state.session = {
        id: session.id,
        title: session.title,
        turns: session.turns
    };

    el("sessionTitle").textContent =
        session.title || "new conversation";

    el("log").innerHTML = "";

    for (const event of session.events || []) {
        apply(event);
    }

    for (const call of session.calls || []) {

        if (call.key && !state.calls.has(call.key)) {

            state.calls.set(call.key, {
                ...call,
                argumentsPreview:
                    JSON.stringify(call.arguments ?? {}, null, 2),
                duration: call.duration_ms
            });
        }
    }

    renderChat();
    renderTree();
}


/* ------------------------------------------------------------- approvals */

function renderApprovals() {

    const pending =
        [...state.approvals.values()];

    const button = el("approvalsButton");

    button.hidden = pending.length === 0;

    el("approvalsCount").textContent = String(pending.length);

    if (pending.length === 0) {

        if (state.approvalModal) {

            const handle = state.approvalModal;

            state.approvalModal = null;

            handle.close("resolved");
        }

        return;
    }

    if (!state.approvalModal) {
        openApprovalModal();

        return;
    }

    fillApprovalModal();
}


function openApprovalModal() {

    state.approvalModal =
        Modal.open({
            title: "Approval required",
            size: "medium",
            dismissible: true,

            onClose: () => {

                state.approvalModal = null;
            }
        });

    fillApprovalModal();
}


function fillApprovalModal() {

    const handle = state.approvalModal;

    if (!handle) {
        return;
    }

    const pending =
        [...state.approvals.values()];

    const current = pending[0];

    handle.setTitle(`Approval required — ${current.tool}`);

    handle.setSubtitle(
        `1/${pending.length} pending · requested by ${current.agent}`
    );

    const body = node("div", "detail");

    const list = node("dl", "detail-grid");

    definition(list, "tool", current.tool);
    definition(list, "agent", current.agent);
    definition(list, "reason", current.reason);

    definition(
        list,
        "groups",
        (current.groups || []).join(", ")
    );

    body.appendChild(list);

    const block = node("div", "detail-block");

    block.append(
        node("h3", null, "Arguments"),
        node(
            "pre",
            null,
            JSON.stringify(current.arguments ?? {}, null, 2)
        )
    );

    body.appendChild(block);

    if (pending.length > 1) {

        const queue = node("div", "detail-block");

        queue.appendChild(node("h3", null, "Also waiting"));

        const rest = node("ul", "queue");

        for (const item of pending.slice(1)) {

            rest.appendChild(
                node(
                    "li",
                    null,
                    `${item.tool} · ${item.agent} · ${shorten(
                        JSON.stringify(item.arguments ?? {}),
                        60
                    )}`
                )
            );
        }

        queue.appendChild(rest);

        body.appendChild(queue);
    }

    handle.setBody(body);

    handle.setFooter(
        Modal.row(
            Modal.button(
                "Deny",
                "refuse",
                () => answerApproval(current.id, false)
            ),
            Modal.button(
                "Approve",
                "allow",
                () => answerApproval(current.id, true)
            ),
            pending.length > 1
                ? Modal.button(
                    `Approve all (${pending.length})`,
                    "ghost",
                    () => approveAll()
                )
                : null
        )
    );
}


async function answerApproval(id, approved) {

    state.approvals.delete(id);

    renderApprovals();

    await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved })
    });
}


async function approveAll() {

    const ids =
        [...state.approvals.keys()];

    state.approvals.clear();

    renderApprovals();

    for (const id of ids) {

        await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approved: true })
        });
    }
}


/* -------------------------------------------------------------- log line */

function describeEvent(event) {

    switch (event.type) {

        case "hook:start":
            return `${event.phase} ${event.id} (${event.hook_type})`;

        case "hook:end":
            return `${event.phase} ${event.id} ${event.status}: ${shorten(event.summary || "", 70)}`;

        case "hook:phase:start":
            return `${event.phase}: ${event.hooks.join(", ")}`;

        case "hook:phase:end":
            return `${event.phase} ${event.stopped ? "stopped" : event.ok ? "ok" : "reported failures"}`;

        case "plan:autoroute:start":
            return `${event.step} → ${event.agent}`;

        case "plan:autoroute:end":
            return `${event.step} ${event.ok ? "done" : "failed"} by ${event.agent}`;

        case "tool:start":
            return `${event.agent} ${event.name} ${shorten(
                event.arguments_preview ?? event.arguments,
                60
            )}`;

        case "tool:end":
            return `${event.name} ${
                event.success
                    ? event.exit_code
                        ? `exit ${event.exit_code}`
                        : event.warning
                            ? "ok, with a warning"
                            : "ok"
                    : "failed"
            } ${event.duration_ms} ms`;

        case "tool:graph":
            return `${event.agent} ${event.shape}, ${
                event.calls.length
            } call(s), ${event.waves.length} wave(s)`;

        case "policy:decision":
            return `${event.tool} ${event.decision}`;

        case "agent:iteration":
            return `${event.agent} iteration ${event.iteration}`;

        case "agent:action":
            return `${event.agent} ${event.action}`;

        case "agent:start":
            return `${event.scope || event.agent}${
                event.parent_scope
                    ? ` from ${event.parent_scope}`
                    : ""
            }`;

        case "delegation:start":
            return `${event.parent} → ${
                event.delegations.map(item => item.agent).join(", ")
            }`;

        case "delegation:graph":
            return `${event.parent} ${event.shape}, ${
                event.delegations.length
            } sub-agent(s)`;

        case "delegation:end":
            return `${event.agent} ${
                event.success
                    ? `ok ${event.duration_ms} ms`
                    : `failed: ${shorten(event.error, 60)}`
            }`;

        case "tool:arguments_ignored":
            return `${event.name} ignored ${event.dropped.join(", ")}`;

        case "skill:loaded":
            return `loaded ${event.skills.join(", ")} (${event.chars} chars)`;

        case "skill:read":
            return `${event.skill}/${event.resource} (${event.chars} chars)`;

        case "run:delegation_hint":
            return `${event.agents_remaining} agents unused, ${
                event.open_steps
            } open steps`;

        case "report:mismatch":
            return `claimed work the runtime did not do: ${
                shorten(event.problems.join("; "), 70)
            }`;

        case "request:start":
            return `${event.agent} → ${event.model}`;

        case "request:end":
            return `${event.agent} ${event.outcome} in ${
                event.duration_ms
            } ms`;

        case "run:loop":
            return `${event.scope || event.agent} ${
                event.outcome
            } ${shorten(event.signature || event.reason || "", 60)}`;

        case "run:malformed":
            return `${event.scope || event.agent} ${event.code} ${
                event.attempt
            }/${event.max_attempts || event.limit} ${shorten(event.reason || "", 60)}`;

        case "response:repaired":
            if (event.repair === "action_envelope") {

                const changes = [
                    (event.moved_fields || []).length
                        ? `moved ${event.moved_fields.join(", ")}`
                        : null,
                    (event.defaulted_fields || []).length
                        ? `defaulted ${event.defaulted_fields.join(", ")}`
                        : null,
                    (event.removed_items || []).length
                        ? `removed ${event.removed_items.join(", ")}`
                        : null,
                    (event.argument_repairs || []).length
                        ? "cleaned linked path arguments"
                        : null
                ].filter(Boolean);

                return `action envelope repaired: ${changes.join("; ")}`;
            }

            if (event.repair === "markdown_path") {
                return `${event.tool} cleaned Markdown links in ${
                    (event.repaired_fields || []).join(", ")
                }`;
            }

            return `${event.tool} arguments repaired${
                (event.dropped || []).length
                    ? `, dropped ${event.dropped.join(", ")}`
                    : ""
            }`;

        case "context:compacted":
            return `${event.before} → ${event.after} chars`;

        case "context:memory":
            return `${event.folded_exchanges} exchanges folded with ${
                event.summary_calls ?? event.chunks ?? 0
            }/${event.chunks || 0} summary calls${
                event.skipped_chunks
                    ? `, ${event.skipped_chunks} archive-only`
                    : ""
            }, ${event.archived || 0} newly archived`;

        case "agent:thinking":
            return `${event.scope || event.agent} ${
                event.chars
            } chars of reasoning`;

        case "session:message":
            return `${event.message.role} ${event.message.kind}`;

        case "session:switched":
            return `${event.session.title || event.session.id}`;

        case "endpoint:degraded":
            return `${event.role} ${event.model} dropped ${event.dropped}`;

        case "run:wrapup":
            return `${
                Math.round(event.remaining_ms / 1000)
            }s left of ${
                Math.round(event.max_run_ms / 1000)
            }s, asking for a final answer`;

        case "run:deadline":
            return `budget spent: ${
                event.elapsed_ms
            } ms of ${event.max_run_ms} ms`;

        default:
            return shorten(
                event.task ||
                event.message ||
                event.status ||
                event.reason ||
                "",
                70
            );
    }
}


function log(event) {

    const list = el("log");

    /*
    | log() runs for every message on the stream. If the list is missing
    | the event is dropped rather than thrown away with an exception,
    | because throwing here would break the handler for every event that
    | follows, not just this one.
    */

    if (!list) {
        return;
    }

    const item = node("li");

    if (
        event.type.includes("error") ||
        event.success === false ||
        (event.type === "hook:end" && event.status === "failed") ||
        event.decision === "deny"
    ) {
        item.className = "bad";
    } else if (
        event.type === "report:mismatch" ||
        event.type === "run:delegation_hint" ||
        event.type === "run:loop" ||
        event.type === "run:wrapup" ||
        event.type === "run:deadline" ||
        event.type === "run:malformed" ||
        event.type === "response:repaired" ||
        event.type.startsWith("approval") ||
        event.decision === "require_approval"
    ) {
        item.className = "warn";
    }

    const time =
        new Date(event.at || Date.now())
            .toLocaleTimeString("en-GB", { hour12: false });

    item.append(
        node("span", "t", time),
        node("span", "k", event.type),
        node("span", "v", describeEvent(event))
    );

    if (event.call_key) {

        item.classList.add("clickable");

        item.addEventListener("click", () => {

            const call =
                state.calls.get(event.call_key);

            if (call) {
                openCallDetail(call, state.graphs.get(call.graph_id));
            }
        });
    }

    item.dataset.text =
        `${event.type} ${item.textContent}`.toLowerCase();

    if (
        state.logFilter &&
        !item.dataset.text.includes(state.logFilter)
    ) {
        item.hidden = true;
    }

    list.appendChild(item);

    while (list.children.length > 400) {
        list.removeChild(list.firstChild);
    }

    list.scrollTop = list.scrollHeight;
}


function applyLogFilter() {

    for (const item of el("log").children) {

        item.hidden =
            state.logFilter !== "" &&
            !(item.dataset.text || "").includes(state.logFilter);
    }
}


/* ---------------------------------------------------------------- status */

function setStatus(status) {

    state.status = status;

    el("statusDot").className = `dot ${status}`;
    el("statusText").textContent = status;

    el("runButton").disabled = status === "running";
    el("cancelButton").disabled = status !== "running";

    if (status === "running") {

        state.startedAt = state.startedAt || Date.now();

        if (!state.timer) {

            state.timer =
                setInterval(
                    () => {

                        el("runTimer").textContent =
                            `${(
                                (Date.now() - state.startedAt) / 1000
                            ).toFixed(1)} s`;
                    },
                    100
                );
        }

    } else {

        clearInterval(state.timer);

        state.timer = null;
        state.startedAt = null;
    }
}


/* ---------------------------------------------------------------- events */

function resetRun(clearArchive = false) {

    state.agents.clear();
    state.order = [];
    state.graphs.clear();
    state.calls.clear();
    state.approvals.clear();
    state.loops = [];
    state.hooks.clear();
    state.hookOrder = [];
    state.currentTask = null;

    if (clearArchive) {
        el("executionArchive").innerHTML = "";
    }
}


function pushMessage(message) {

    state.messages.push(message);

    renderChat();
}


function apply(event) {

    if (event.plan) {
        state.plan = event.plan;
        renderPlan();
    }

    /* Keep every event so a user message's execution can be re-rendered
       as a stage-by-stage block under that message (keyed by turn_id).
       Bounded so a long session does not grow without limit in the page. */
    state.events.push(event);

    if (state.events.length > 5000) {
        state.events = state.events.slice(-5000);
    }

    /* Execution steps that appear under a user message refresh that turn's
       block in place rather than re-rendering the whole conversation, so
       the UI stays stable and open blocks do not close on every event. */
    if (
        ["agent:iteration", "agent:action", "tool:start", "tool:end", "run:malformed"].includes(event.type)
    ) {
        refreshTurnExecution(event.turn_id);
    }

    switch (event.type) {

        case "run:start":
            archiveCurrentExecution();
            resetRun();

            state.currentTask = event.task;

            agentNode("main_agent", 0, { task: event.task });

            setStatus("running");

            renderTree();
            renderApprovals();
            break;

        case "agent:start":
            agentNode(
                event.scope || event.agent,
                event.depth,
                {
                    name: event.agent,
                    task: event.task,
                    parent: event.parent,
                    parentScope: event.parent_scope,
                    persona: event.persona,
                    delegationId: event.delegation_id
                }
            );

            renderTree();
            break;

        case "agent:iteration": {

            const agent =
                agentNode(event.scope || event.agent, event.depth);

            agent.iterations = event.iteration;

            renderTree();
            break;
        }

        case "agent:end": {

            const agent =
                agentNode(event.scope || event.agent, event.depth);

            agent.status =
                event.success
                    ? "done"
                    : "failed";

            renderTree();
            break;
        }

        case "delegation:start":
            for (const item of event.delegations) {

                agentNode(
                    `${item.agent}#${(event.depth || 0) + 1}`,
                    (event.depth || 0) + 1,
                    {
                        name: item.agent,
                        task: item.task,
                        parent: event.parent,
                        parentScope: event.parent_scope,
                        delegationId: item.id
                    }
                );
            }

            renderTree();
            break;

        case "delegation:graph": {

            const parent =
                agentNode(
                    event.parent_scope || event.parent,
                    Math.max(0, (event.depth || 1) - 1)
                );

            parent.delegationShape = event.shape;

            renderTree();
            break;
        }

        case "hook:start": {

            const key = `${event.phase}:${event.id}`;

            state.hooks.set(key, {
                ...event,
                status: "running",
                summary: null
            });

            if (!state.hookOrder.includes(key)) {
                state.hookOrder.push(key);
            }

            renderTree();
            break;
        }

        case "hook:end": {

            const key = `${event.phase}:${event.id}`;
            const before = state.hooks.get(key) || {};

            state.hooks.set(key, {
                ...before,
                ...event,
                hook_type: event.hook_type || before.hook_type,
                status: event.status || (event.ok ? "done" : "failed")
            });

            if (!state.hookOrder.includes(key)) {
                state.hookOrder.push(key);
            }

            renderTree();
            break;
        }

        case "tool:graph": {

            const graph = graphNode(event);

            graph.maxParallel = event.max_parallel;

            renderTree();
            break;
        }

        case "tool:start": {

            const graph = graphNode(event);

            const call = {
                key: event.call_key,
                id: event.id,
                agent: event.agent,
                name: event.name,
                graph_id: graph.id,
                wave: event.wave ?? null,
                iteration: event.iteration ?? null,
                depends_on: event.depends_on || [],
                argumentsPreview:
                    event.arguments_preview ??
                    JSON.stringify(event.arguments ?? {}, null, 2),
                status: "running"
            };

            graph.calls.set(call.id, call);

            if (!graph.order.includes(call.id)) {
                graph.order.push(call.id);
            }

            if (call.key) {
                state.calls.set(call.key, call);
            }

            renderTree();
            break;
        }

        case "tool:end": {

            const graph = graphNode(event);

            const call =
                graph.calls.get(event.id) || {
                    id: event.id,
                    agent: event.agent,
                    name: event.name,
                    graph_id: graph.id,
                    depends_on: [],
                    argumentsPreview: "{}"
                };

            call.key = event.call_key || call.key;

            /*
            | A non-zero exit code, or a tool that warned about what it
            | did, is not a clean success and must not be drawn as one.
            */

            call.status =
                !event.success
                    ? "failed"
                    : event.exit_code
                        ? "exit"
                        : event.warning
                            ? "warned"
                            : "done";

            call.exitCode = event.exit_code ?? null;
            call.warning = event.warning || null;
            call.duration = event.duration_ms;
            call.wave = event.wave ?? call.wave ?? null;
            call.iteration = event.iteration ?? call.iteration ?? null;
            call.resultPreview = event.result_preview ?? null;
            call.resultChars = event.result_chars ?? null;
            call.error = event.error || null;

            graph.calls.set(call.id, call);

            if (!graph.order.includes(call.id)) {
                graph.order.push(call.id);
            }

            if (call.key) {
                state.calls.set(call.key, call);
            }

            renderTree();
            break;
        }

        case "delegation:end": {

            /*
            | A delegation that failed before its agent existed has no
            | node of its own, so the parent carries the failure.
            */

            if (!event.success) {

                const parent =
                    agentNode(
                        event.parent_scope || event.parent || "main_agent"
                    );

                parent.loops.push({
                    outcome: "stopped",
                    repeats: 1,
                    signature:
                        `delegation ${event.id} to ${event.agent}: ${event.error}`
                });

                renderTree();
            }

            break;
        }

        case "run:loop": {

            state.loops.push(event);

            const agent =
                agentNode(event.scope || event.agent || "main_agent");

            agent.loops.push(event);

            renderTree();
            break;
        }

        case "skill:read": {

            const agent =
                agentNode(event.agent || "main_agent");

            agent.skills = agent.skills || [];

            const label =
                `${event.skill} · ${event.resource}`;

            if (!agent.skills.includes(label)) {
                agent.skills.push(label);
            }

            renderTree();
            break;
        }

        case "skill:loaded": {

            const agent =
                agentNode(
                    event.scope || event.agent || "main_agent"
                );

            agent.skills = agent.skills || [];

            for (const name of event.skills) {

                if (!agent.skills.includes(name)) {
                    agent.skills.push(name);
                }
            }

            renderTree();
            break;
        }

        case "report:mismatch": {

            const agent =
                agentNode(event.agent || "main_agent");

            agent.loops.push({
                outcome: "stopped",
                repeats: event.problems.length,
                signature:
                    `answer claimed work that never ran: ${
                        event.problems.join("; ")
                    }`
            });

            renderTree();
            break;
        }

        case "run:malformed": {

            /*
            | An answer the runtime could not read is a debugging fact,
            | so it sits on the agent that produced it rather than only
            | scrolling past in the log.
            */

            const agent =
                agentNode(event.scope || event.agent || "main_agent");

            agent.loops.push({
                outcome:
                    event.outcome === "stopped"
                        ? "malformed_stopped"
                        : "malformed",

                repeats: event.attempt,

                signature: event.reason,

                reason: event.reason
            });

            renderTree();
            break;
        }

        case "approval:request":
            state.approvals.set(event.id, event);
            renderApprovals();
            break;

        case "approval:resolved":
            state.approvals.delete(event.id);
            renderApprovals();
            break;

        case "run:end":
            for (const agent of state.agents.values()) {

                if (agent.status === "running") {
                    agent.status = "done";
                }
            }

            renderTree();
            break;

        case "run:auto_continue":
            el("turns").textContent = `cycle ${event.cycle}`;
            break;

        case "run:status":
            setStatus(event.status);

            state.waiting = null;

            clearInterval(state.waitingTimer);

            state.waitingTimer = null;

            renderChat();
            break;

        case "request:start":
            state.waiting = {
                agent: event.agent,
                role: event.role,
                since: Date.now()
            };

            if (!state.waitingTimer) {

                /* Only the elapsed text changes while the endpoint works.
                   Rebuilding the conversation here used to destroy text
                   selection, scroll position and open reasoning details five
                   times a second. */
                state.waitingTimer =
                    setInterval(updateWaitingElapsed, 200);
            }

            renderChat();
            break;

        case "request:end":
            state.waiting = null;

            clearInterval(state.waitingTimer);

            state.waitingTimer = null;

            renderChat();
            break;

        case "session:message":
            /*
            | The server owns the conversation, so the browser draws what
            | it is told rather than guessing from the run.
            */
            pushMessage(event.message);
            break;

        case "session:switched": {

            const same =
                state.session &&
                state.session.id === event.session.id;

            state.session = event.session;

            el("sessionTitle").textContent =
                event.session.title || "new conversation";

            /*
            | Another console, or the history dialog, moved to a
            | different conversation. Load it rather than showing the
            | previous one under a new name.
            */

            if (!same) {
                refreshSession(event.session.id);
            }

            break;
        }

        case "settings:changed":
            loadSettings();
            break;

        case "session:cleared":
            resetRun(true);

            state.messages = [];

            el("log").innerHTML = "";

            setStatus("idle");

            renderChat();
            renderTree();
            renderApprovals();
            break;

        default:
            break;
    }

    log(event);
}


function applySnapshot(snapshot) {

    resetRun(true);
    el("log").innerHTML = "";
    renderTree();

    state.plan = snapshot.plan || null;
    renderPlan();

    el("workspace").textContent = snapshot.workspace;
    el("model").textContent = snapshot.model;
    el("approvalMode").value = snapshot.approval_mode;

    if (snapshot.settings) {
        state.settings = snapshot.settings;
    }

    el("turns").textContent =
        `${snapshot.turns} turns${
            snapshot.cycles
                ? `, cycle ${snapshot.cycles}`
                : ""
        }`;

    el("autoContinue").checked = Boolean(snapshot.auto_continue);

    state.messages =
        Array.isArray(snapshot.messages)
            ? snapshot.messages
            : [];

    state.session = snapshot.session || null;

    state.sessions = snapshot.sessions || [];

    el("sessionTitle").textContent =
        snapshot.session
            ? snapshot.session.title || "new conversation"
            : "";

    renderChat();

    for (const event of snapshot.events) {
        apply(event);
    }

    for (const approval of snapshot.pending_approvals) {

        state.approvals.set(approval.id, approval);
    }

    renderApprovals();

    setStatus(snapshot.status);
}


/* -------------------------------------------------------------- settings */

const GROUP_ORDER = [
    "endpoint",
    "endpoint.main", "endpoint.l1", "endpoint.l2", "endpoint.l3", "endpoint.summary",
    "memory", "archive", "journal", "context", "budget", "delegation", "planning", "hooks",
    "persistence", "policy", "tools", "output", "workspace"
];


function settingsBody(list) {

    const container = node("div", "settings");

    const search = node("input", "filter");

    search.type = "search";
    search.placeholder = "filter settings";

    container.appendChild(search);

    const groups = new Map();

    for (const setting of list) {

        if (!groups.has(setting.group)) {
            groups.set(setting.group, []);
        }

        groups.get(setting.group).push(setting);
    }

    const ordered =
        [...groups.keys()].sort(
            (a, b) =>
                GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)
        );

    for (const name of ordered) {

        const section = node("div", "group");

        section.appendChild(node("h3", null, name));

        for (const setting of groups.get(name)) {

            section.appendChild(settingRow(setting));
        }

        container.appendChild(section);
    }

    search.addEventListener("input", () => {

        const term =
            search.value.trim().toLowerCase();

        for (const section of container.querySelectorAll(".group")) {

            let visible = 0;

            for (const row of section.querySelectorAll(".setting")) {

                const match =
                    term === "" ||
                    row.dataset.key.toLowerCase().includes(term) ||
                    (row.dataset.hint || "").includes(term);

                row.hidden = !match;

                visible += match ? 1 : 0;
            }

            section.hidden = visible === 0;
        }
    });

    return container;
}


function settingRow(setting) {

    const row = node("div", "setting");

    row.dataset.key = setting.key;
    row.dataset.hint = (setting.description || "").toLowerCase();

    const label = node("div");

    label.append(
        node("div", "label", setting.key),
        node(
            "div",
            "hint",
            `${setting.description}${
                setting.fixed
                    ? " (fixed at startup)"
                    : ""
            }`
        )
    );

    let input;

    if (setting.type === "boolean" || setting.type === "enum") {

        input = node("select");

        const values =
            setting.type === "boolean"
                ? ["true", "false"]
                : setting.values;

        for (const option of values) {

            const element = node("option", null, option);

            element.value = option;

            input.appendChild(element);
        }

        input.value = String(setting.value);

    } else {

        input = node("input");

        input.type =
            setting.type === "number"
                ? "number"
                : "text";

        if (setting.min !== undefined) {
            input.min = setting.min;
        }

        if (setting.max !== undefined) {
            input.max = setting.max;
        }

        input.value =
            setting.value === null
                ? ""
                : setting.value;
    }

    input.disabled = setting.fixed;

    input.addEventListener("change", async () => {

        const response =
            await fetch("/api/settings", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    key: setting.key,
                    value: input.value
                })
            });

        const payload =
            await response.json();

        if (!response.ok) {

            input.value = setting.value;

            row.classList.add("rejected");

            row.querySelector(".hint").textContent = payload.error;

            return;
        }

        row.classList.add("saved");

        setTimeout(
            () => row.classList.remove("saved"),
            800
        );

        loadSettings();
    });

    const source = node("span", `src ${setting.source}`, setting.source);

    source.title =
        setting.source === "override"
            ? "changed here, click to restore"
            : setting.source;

    if (setting.source === "override" && !setting.fixed) {

        source.style.cursor = "pointer";

        source.onclick = async () => {

            await fetch("/api/settings", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    key: setting.key,
                    reset: true
                })
            });

            loadSettings();
        };
    }

    row.append(label, input, source);

    return row;
}


async function loadSettings() {

    const response =
        await fetch("/api/settings");

    const payload =
        await response.json();

    state.settings = payload.settings;

    if (state.settingsModal && state.settingsModal.isOpen()) {

        state.settingsModal.setBody(settingsBody(state.settings));
    }
}


function openSettings() {

    if (state.settingsModal && state.settingsModal.isOpen()) {
        return;
    }

    state.settingsModal =
        Modal.open({
            title: "Settings",
            subtitle: "applied on next use, no restart",
            size: "large",
            body: settingsBody(state.settings),

            footer:
                Modal.row(
                    Modal.button(
                        "Reload",
                        "ghost",
                        () => loadSettings()
                    ),
                    Modal.button(
                        "Close",
                        "",
                        () => state.settingsModal.close("footer")
                    )
                ),

            onClose: () => {

                state.settingsModal = null;
            }
        });

    loadSettings();
}


/* ------------------------------------------------------------------ wire */

function connect() {

    const source =
        new EventSource("/api/events");

    source.onmessage = message => {

        const payload =
            JSON.parse(message.data);

        if (payload.type === "snapshot") {

            applySnapshot(payload.snapshot);

            return;
        }

        apply(payload);
    };

    source.onerror = () => {

        el("statusText").textContent = "reconnecting";
    };
}


el("taskForm").addEventListener("submit", async submitEvent => {

    submitEvent.preventDefault();

    const task =
        el("task").value.trim();

    if (task === "") {
        return;
    }

    setStatus("running");

    const response =
        await fetch("/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task })
        });

    if (response.ok) {

        el("task").value = "";

        const snapshot =
            await (await fetch("/api/state")).json();

        el("turns").textContent = `${snapshot.turns} turns`;

    } else {

        setStatus("idle");
    }
});


el("cancelButton").addEventListener("click", () => {

    fetch("/api/cancel", { method: "POST" });
});


el("clearButton").addEventListener("click", async () => {

    await fetch("/api/clear", { method: "POST" });

    el("turns").textContent = "0 turns";
});


el("autoContinue").addEventListener("change", event => {

    fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            key: "AUTO_CONTINUE",
            value: event.target.checked
        })
    });
});


el("clearLog").addEventListener("click", () => {

    el("log").innerHTML = "";
});


el("logFilter").addEventListener("input", event => {

    state.logFilter =
        event.target.value.trim().toLowerCase();

    applyLogFilter();
});


el("approvalMode").addEventListener("change", event => {

    fetch("/api/approval-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: event.target.value })
    });
});


el("settingsButton").addEventListener("click", openSettings);


el("historyButton").addEventListener("click", openHistory);

el("executionButton").addEventListener("click", openExecutionModal);

el("eventsButton").addEventListener("click", openEventsModal);


el("approvalsButton").addEventListener("click", () => {

    if (!state.approvalModal) {
        openApprovalModal();
    }
});


el("task").addEventListener("keydown", event => {

    if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter"
    ) {

        el("taskForm").requestSubmit();
    }
});


connect();

loadSettings();
