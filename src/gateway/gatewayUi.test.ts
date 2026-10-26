/**
 * Gateway console logic — فاز ۱۲.
 *
 * `public/gateway.js` keeps its pure half (form mapping, validation, rendering,
 * URLs) free of the DOM so Node can require it. The point of these tests is the
 * contract the plan asks for: **every form field maps to a key of the
 * WorkerConfig schema, and every schema key is reachable from the form.**
 */

import * as path from 'path';
import { WORKER_CONFIG_JSON_SCHEMA } from './WorkerConfigSchema';
import { ProjectWorkerConfig } from './types';

const ui = require(path.join(__dirname, '..', '..', 'public', 'gateway.js')) as {
  WORKER_FORM_FIELDS: { name: string; section: string; type: string; configPath: string }[];
  WORKER_ACTIONS: { id: string }[];
  formToConfig(values: Record<string, unknown>): Record<string, unknown>;
  configToForm(config: unknown): Record<string, unknown>;
  validateForm(values: Record<string, unknown>): { field: string; message: string }[];
  commandPreview(config: Record<string, unknown>): string;
  summarize(workers: Record<string, unknown>[]): Record<string, number>;
  stateClass(worker: Record<string, unknown>): string;
  renderWorkerRow(worker: Record<string, unknown>): string;
  renderSummaryCards(stats: Record<string, number>): string;
  renderFormFields(values: Record<string, unknown>): string;
  buildSaveRequest(
    config: Record<string, unknown>,
    editingId: string | null,
    start: boolean
  ): { url: string; method: string; body: Record<string, unknown> };
  DEFAULT_FORM_VALUES: Record<string, unknown>;
  projectDashboardUrl(projectId: string): string;
  mcpEndpointUrl(projectId: string): string;
  withToken(url: string, token: string): string;
  connectSnippets(options: { origin: string; token: string; projectId?: string }): { id: string; code: string }[];
  renderLogLines(lines: string[]): string;
  renderEvents(events: Record<string, unknown>[]): string;
};

/** همهٔ کلیدهای schema، به‌شکل نقطه‌دار (`indexing.vectors`). */
function schemaKeys(): string[] {
  const properties = WORKER_CONFIG_JSON_SCHEMA.properties as Record<
    string,
    { type?: string; properties?: Record<string, unknown> }
  >;
  const keys: string[] = [];

  for (const [name, definition] of Object.entries(properties)) {
    if (definition.type === 'object' && definition.properties) {
      for (const child of Object.keys(definition.properties)) keys.push(`${name}.${child}`);
    } else {
      keys.push(name);
    }
  }

  return keys;
}

describe('gateway console — form ↔ WorkerConfig schema', () => {
  it('maps every form field to a real schema key', () => {
    const keys = new Set(schemaKeys());

    for (const field of ui.WORKER_FORM_FIELDS) {
      expect(`${field.name} → ${field.configPath}`).toBeTruthy();
      expect(keys.has(field.configPath)).toBe(true);
    }
  });

  it('leaves no schema key unreachable from the form', () => {
    const covered = new Set(ui.WORKER_FORM_FIELDS.map(field => field.configPath));

    for (const key of schemaKeys()) {
      expect(key).toBe(covered.has(key) ? key : `MISSING FORM FIELD: ${key}`);
    }
  });

  it('has no duplicate field names', () => {
    const names = ui.WORKER_FORM_FIELDS.map(field => field.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('round-trips a configuration through the form', () => {
    const config = {
      projectId: 'prj-app-12345678',
      name: 'App',
      rootPath: '/srv/app',
      autoStart: true,
      watch: true,
      indexing: { vectors: true, blueprint: true, git: true, treeSitter: true, pretty: false },
      watchOptions: { debounceMs: 250, blueprintMode: 'threshold', skipInitialIndex: true },
      service: { transport: 'socket', host: '127.0.0.1', socketPath: '/run/app.sock', web: true },
      security: { gatewayManaged: true, allowRemote: false, tokenEnvVar: 'SE_TOKEN' },
      embedding: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', normalize: true },
    } as unknown as ProjectWorkerConfig;

    const values = ui.configToForm(config);
    expect(values['projectId']).toBe('prj-app-12345678');
    expect(values['debounceMs']).toBe(250);
    expect(values['embeddingProvider']).toBe('ollama');
    expect(values['treeSitter']).toBe(true);
    expect(values['pretty']).toBe(false);

    const back = ui.formToConfig(values) as Record<string, unknown>;
    expect(back['projectId']).toBe('prj-app-12345678');
    expect((back['watchOptions'] as Record<string, unknown>)['debounceMs']).toBe(250);
    expect((back['indexing'] as Record<string, unknown>)['pretty']).toBe(false);
    expect((back['service'] as Record<string, unknown>)['socketPath']).toBe('/run/app.sock');
    expect((back['security'] as Record<string, unknown>)['tokenEnvVar']).toBe('SE_TOKEN');
  });
});

describe('gateway console — validation', () => {
  const valid = {
    projectId: 'prj-app-12345678',
    name: 'App',
    rootPath: '/srv/app',
    debounceMs: 500,
    transport: 'loopback',
    embeddingEnabled: false,
    embeddingProvider: 'local',
  };

  it('accepts a valid configuration', () => {
    expect(ui.validateForm(valid)).toEqual([]);
  });

  it.each([
    ['projectId', { projectId: 'Not Valid' }, /lowercase/],
    ['name', { name: '   ' }, /must not be empty/],
    ['rootPath', { rootPath: '' }, /must not be empty/],
    ['debounceMs', { debounceMs: 5 }, /between 25 and 60000/],
    ['port', { port: 70000 }, /between 0 and 65535/],
    ['socketPath', { transport: 'socket', socketPath: '' }, /required when the transport is socket/],
    ['allowRemote', { gatewayManaged: true, allowRemote: true, tokenEnvVar: 'T' }, /must not allow remote/],
    ['tokenEnvVar', { gatewayManaged: true, tokenEnvVar: '' }, /needs a token environment variable/],
    ['embeddingBaseUrl', { embeddingEnabled: true, embeddingProvider: 'ollama', embeddingBaseUrl: 'localhost' }, /http\(s\) URL/],
    ['embeddingModel', { embeddingEnabled: true, embeddingProvider: 'openai-compatible', embeddingBaseUrl: 'http://x', embeddingModel: '' }, /model is required/],
  ])('rejects %s', (_field, patch, pattern) => {
    const errors = ui.validateForm({ ...valid, ...patch });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map(error => error.message).join(' ')).toMatch(pattern);
  });

  it('refuses a secret in the form values', () => {
    const errors = ui.validateForm({ ...valid, apiKey: 'sk-live-123' });
    expect(errors.map(error => error.message).join(' ')).toMatch(/secrets are never/);
  });
});

describe('gateway console — preview and rendering', () => {
  const config = {
    projectId: 'prj-app-12345678',
    rootPath: '/srv/app',
    dataDir: '/srv/data',
    indexing: { vectors: true, blueprint: true, git: true, treeSitter: true, pretty: true },
    watchOptions: { debounceMs: 250, blueprintMode: 'threshold' },
    service: { transport: 'loopback', host: '127.0.0.1' },
    security: { gatewayManaged: true, tokenEnvVar: 'SE_TOKEN' },
    embedding: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', normalize: true },
  };

  it('previews the same flags the worker accepts', () => {
    const preview = ui.commandPreview(config);

    expect(preview.startsWith('semantic-engine worker ')).toBe(true);
    expect(preview).toContain('--project-id prj-app-12345678');
    expect(preview).toContain('--root /srv/app');
    expect(preview).toContain('--data-dir /srv/data');
    expect(preview).toContain('--vectors');
    expect(preview).not.toContain('sqlite');
    expect(preview).toContain('--debounce 250');
    expect(preview).toContain('--blueprint-mode threshold');
    expect(preview).toContain('--gateway-managed');
    expect(preview).toContain('--embedding-provider ollama');
    expect(preview).toContain('--embedding-normalize');
  });

  it('never previews a secret value, only the variable name', () => {
    const preview = ui.commandPreview(config);
    expect(preview).not.toContain('SE_TOKEN');
    expect(preview).not.toMatch(/sk-/);
  });

  it('has no shell metacharacters in the flags it emits', () => {
    for (const part of ui.commandPreview(config).split(' ')) {
      if (part.startsWith('--')) expect(part).toMatch(/^--[a-z0-9-]+$/);
    }
  });

  it('renders one row per worker, with its state and actions', () => {
    const workers = Array.from({ length: 10 }, (_unused, index) => ({
      projectId: `prj-app-${String(index).padStart(8, '0')}`,
      name: `App ${index}`,
      rootPath: `/srv/app-${index}`,
      pid: 1000 + index,
      state: index % 2 === 0 ? 'ready' : 'starting',
      indexState: index % 2 === 0 ? 'fresh' : 'missing',
      restartCount: index,
      degraded: index === 3,
    }));

    const rows = workers.map(worker => ui.renderWorkerRow(worker)).join('');

    for (let index = 0; index < 10; index += 1) {
      expect(rows).toContain(`prj-app-${String(index).padStart(8, '0')}`);
    }
    expect(rows).toContain('state-ready');
    expect(rows).toContain('state-indexing');
    expect(rows).toContain('state-degraded');

    for (const action of ui.WORKER_ACTIONS) {
      expect(rows).toContain(`data-action="${action.id}"`);
    }
  });

  it('escapes what it renders', () => {
    const row = ui.renderWorkerRow({ projectId: '<script>alert(1)</script>', name: 'x', state: 'ready' });
    expect(row).not.toContain('<script>');
    expect(row).toContain('&lt;script&gt;');
  });

  it('aggregates the cards', () => {
    const stats = ui.summarize([
      { state: 'ready', restartCount: 1 },
      { state: 'starting', restartCount: 0 },
      { state: 'crashed', restartCount: 2, degraded: true },
    ]);

    expect(stats['projects']).toBe(3);
    expect(stats['ready']).toBe(1);
    expect(stats['indexing']).toBe(1);
    expect(stats['crashed']).toBe(1);
    expect(stats['degraded']).toBe(1);
    expect(stats['restarts']).toBe(3);

    const cards = ui.renderSummaryCards(stats);
    expect(cards).toContain('data-key="projects"');
    expect(cards).toContain('>3<');
  });

  it('renders every form field with its section', () => {
    const html = ui.renderFormFields(ui.configToForm(config as unknown as ProjectWorkerConfig));

    for (const field of ui.WORKER_FORM_FIELDS) {
      expect(html).toContain(`name="${field.name}"`);
      expect(html).toContain(`data-config="${field.configPath}"`);
    }
    for (const section of ['project', 'indexing', 'watch', 'service', 'security', 'embedding', 'advanced']) {
      expect(html).toContain(`data-section="${section}"`);
    }
  });

  it('builds the deep links', () => {
    expect(ui.projectDashboardUrl('prj-app-12345678')).toBe('/visualizer?project=prj-app-12345678');
    expect(ui.projectDashboardUrl('a/b')).toBe('/visualizer?project=a%2Fb');
    expect(ui.mcpEndpointUrl('prj-app-12345678')).toBe('/mcp/prj-app-12345678');
  });
});

/*
| SE-F-057 — the dashboard used to drop almost every form field and could not
| update an existing worker at all (it always POSTed the collection with only
| path/name/id/autoStart). These lock the corrected request contract:
| create = POST /projects, update = PATCH /projects/<id>, and the FULL config
| in both payloads — a field the form left empty is an explicit null on
| update, never a silently-forgotten key.
*/
describe('gateway console — SE-F-057 save request contract', () => {
  const fullConfig = () => ({
    projectId: 'prj-app-12345678',
    name: 'App',
    rootPath: '/srv/app',
    watch: false,
    artifactLocation: 'in-root',
    scan: { useGitignore: false, skipHiddenDirectories: false, maxDepth: 6, maxFileSizeMb: 2, ignore: '**/*.snap,vendor/**' },
    diagnostics: { lsp: true, budgetMs: 30000 },
    cache: { mode: 'full' },
    indexing: { vectors: true, blueprint: true, git: false, treeSitter: true, pretty: false },
    watchOptions: { debounceMs: 250, blueprintMode: 'threshold', skipInitialIndex: true },
    service: { transport: 'socket', host: '127.0.0.1', socketPath: '/run/app.sock', http: true, stdio: false, web: true },
    security: { gatewayManaged: true, allowRemote: false, tokenEnvVar: 'SE_TOKEN' },
    embedding: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', normalize: true },
  });

  it('create is a POST on the collection carrying the ENTIRE config', () => {
    const req = ui.buildSaveRequest(ui.formToConfig(fullConfigValue(fullConfig())) as Record<string, unknown>, null, true);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/gateway/projects');
    expect(req.body['path']).toBe('/srv/app');
    expect(req.body['id']).toBe('prj-app-12345678');
    expect(req.body['autoStart']).toBe(true);
    /* the keys the old payload dropped */
    expect(req.body['watch']).toBe(false);
    expect(req.body['indexing']).toEqual(
      expect.objectContaining({ vectors: true, git: false, pretty: false })
    );
    expect(req.body['watchOptions']).toEqual(
      expect.objectContaining({ debounceMs: 250, blueprintMode: 'threshold', skipInitialIndex: true })
    );
    expect(req.body['service']).toEqual(expect.objectContaining({ transport: 'socket', socketPath: '/run/app.sock' }));
    expect(req.body['security']).toEqual(expect.objectContaining({ gatewayManaged: true, tokenEnvVar: 'SE_TOKEN' }));
    expect(req.body['embedding']).toEqual(expect.objectContaining({ enabled: true, provider: 'ollama' }));
    expect(req.body['scan']).toEqual(
      expect.objectContaining({ useGitignore: false, skipHiddenDirectories: false, maxDepth: 6, maxFileSizeMb: 2, ignore: '**/*.snap,vendor/**' })
    );
    expect(req.body['diagnostics']).toEqual({ lsp: true, budgetMs: 30000 });
    expect(req.body['cache']).toEqual({ mode: 'full' });
    expect(req.body['artifactLocation']).toBe('in-root');
  });

  it('update is a PATCH on the project resource, never the collection', () => {
    const req = ui.buildSaveRequest(
      ui.formToConfig(fullConfigValue(fullConfig())) as Record<string, unknown>,
      'prj-app-12345678',
      false
    );
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('/api/v1/gateway/projects/prj-app-12345678');
    expect(req.body['path']).toBeUndefined();
    expect(req.body['id']).toBeUndefined();
    expect(req.body['autoStart']).toBe(false);
    expect(req.body['name']).toBe('App');
    expect(req.body['indexing']).toEqual(expect.objectContaining({ vectors: true }));
    expect(req.body['embedding']).toEqual(expect.objectContaining({ provider: 'ollama' }));
  });

  it('update sends an explicit null for every optional field the form left empty', () => {
    const sparse = ui.formToConfig({
      projectId: 'prj-app-12345678',
      name: 'App',
      rootPath: '/srv/app',
      transport: 'loopback',
      vectors: true,
    }) as Record<string, unknown>;
    const req = ui.buildSaveRequest(sparse, 'prj-app-12345678', false);
    const service = req.body['service'] as Record<string, unknown>;
    const security = req.body['security'] as Record<string, unknown>;
    const embedding = req.body['embedding'] as Record<string, unknown>;
    expect(req.body['dataDir']).toBeNull();
    expect(req.body['outOverride']).toBeNull();
    expect(service['port']).toBeNull();
    expect(service['socketPath']).toBeNull();
    expect(security['tokenEnvVar']).toBeNull();
    expect(embedding['model']).toBeNull();
    expect(embedding['baseUrl']).toBeNull();
  });

  it('update carries a value for EVERY schema key — nothing is dropped', () => {
    const req = ui.buildSaveRequest(
      ui.formToConfig(fullConfigValue(fullConfig())) as Record<string, unknown>,
      'prj-x',
      false
    );
    const covered = new Set<string>();
    for (const field of ui.WORKER_FORM_FIELDS) {
      if (field.configPath === 'projectId' || field.configPath === 'rootPath') continue;
      covered.add(field.configPath);
    }
    for (const key of covered) {
      const value = key.split('.').reduce<unknown>(
        (acc, part) => (acc === null || typeof acc !== 'object' ? undefined : (acc as Record<string, unknown>)[part]),
        req.body
      );
      expect(`${key}=${JSON.stringify(value)}`).toMatch(/=/);
      expect(value).not.toBeUndefined();
    }
  });

  it('escapes the edited project id in the URL', () => {
    const req = ui.buildSaveRequest({ projectId: 'a/b', name: 'n', rootPath: '/r' }, 'a/b', false);
    expect(req.url).toBe('/api/v1/gateway/projects/a%2Fb');
  });
});

function fullConfigValue(config: Record<string, unknown>): Record<string, unknown> {
  /* configToForm-style values: the form is built from a full config, saved
     through formToConfig, so the test feeds the SAME shape the browser does. */
  const values: Record<string, unknown> = {};
  for (const field of ui.WORKER_FORM_FIELDS) {
    const raw = getPath(config, field.configPath);
    if (raw === undefined) continue;
    values[field.name] = raw;
  }
  return values;
}

function getPath(source: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, key) => (acc === undefined || acc === null ? undefined : (acc as Record<string, unknown>)[key]),
    source
  );
}

/*
| SE-F-057 (independent-review guard) — the "New worker" form now submits the
| whole config, so its initial values MUST equal the backend schema defaults;
| otherwise an untouched new worker silently flips defaults to false/absent.
| The UI table and the JSON Schema are two sources of the same truth — this
| test fails the moment they drift apart, so neither can lie about the other.
*/
describe('gateway console — DEFAULT_FORM_VALUES mirrors the WorkerConfig schema', () => {
  /** schema default at a dotted path, or `undefined` when it declares none. */
  function schemaDefault(dotted: string): unknown {
    const [top, child] = dotted.split('.');
    const props = WORKER_CONFIG_JSON_SCHEMA.properties as Record<
      string,
      { default?: unknown; properties?: Record<string, { default?: unknown }> }
    >;
    const def = props[top];
    if (!def) return undefined;
    if (child === undefined) return def.default;
    return def.properties?.[child]?.default;
  }

  const FIELD_BY_NAME = new Map(ui.WORKER_FORM_FIELDS.map(f => [f.name, f]));

  /*
  | autoStart is deliberately NOT in the defaults table: the payload's
  | autoStart comes from which Save button was pressed ("save & start" vs
  | "save only") — the request builder skips the checkbox field entirely, so
  | a default here would be a second, contradictory source.
  */
  const BUTTON_DRIVEN = new Set(['autoStart']);

  it('every declared default equals the schema default', () => {
    for (const [name, value] of Object.entries(ui.DEFAULT_FORM_VALUES)) {
      const field = FIELD_BY_NAME.get(name);
      expect(field).toBeDefined();
      const expected = schemaDefault(field!.configPath);
      expect(`${name}=${JSON.stringify(value)}`).toBe(`${name}=${JSON.stringify(expected)}`);
    }
  });

  it('every schema-declared default is present in the form table (no default silently flipped)', () => {
    for (const field of ui.WORKER_FORM_FIELDS) {
      if (BUTTON_DRIVEN.has(field.configPath)) continue;
      const expected = schemaDefault(field.configPath);
      if (expected === undefined) continue; // optional fields carry no schema default
      expect(`${field.configPath} covered? ${field.name in ui.DEFAULT_FORM_VALUES}`).toBe(
        `${field.configPath} covered? true`
      );
    }
  });
});

describe('gateway console — connection guide', () => {

  it('puts the token on every address as ?token=', () => {
    expect(ui.withToken('http://h:4000/mcp', 'abc')).toBe('http://h:4000/mcp?token=abc');
    expect(ui.withToken('http://h/x?a=1', 'a b')).toBe('http://h/x?a=1&token=a%20b');
    expect(ui.withToken('http://h/x', '')).toBe('http://h/x');
  });

  it('builds a snippet for every client, pointing at the all-projects endpoint', () => {
    const snippets = ui.connectSnippets({ origin: 'http://127.0.0.1:4000', token: 'TKN' });
    expect(snippets.map(s => s.id)).toEqual(
      expect.arrayContaining(['claude-code', 'mcp-json', 'claude-desktop', 'cursor', 'vscode', 'codex', 'typescript', 'python', 'curl'])
    );
    for (const snippet of snippets) expect(snippet.code).toContain('http://127.0.0.1:4000/mcp');
    expect(snippets.find(s => s.id === 'claude-code')!.code).toContain('--scope user');
    expect(snippets.find(s => s.id === 'python')!.code).toContain('list_projects');
  });

  it('points at one project when asked, and never calls list_projects there', () => {
    const snippets = ui.connectSnippets({ origin: 'http://h', token: 'T', projectId: 'prj-a' });
    for (const snippet of snippets) expect(snippet.code).toContain('/mcp/prj-a');
    expect(snippets.find(s => s.id === 'typescript')!.code).not.toContain('list_projects');
  });

  it('renders logs and events, escaped', () => {
    expect(ui.renderLogLines(['<b>x</b>'])).toContain('&lt;b&gt;');
    expect(ui.renderLogLines([])).toContain('empty');
    expect(ui.renderEvents([{ kind: 'crash', at: 't', detail: '<x>' }])).toContain('&lt;x&gt;');
    expect(ui.renderEvents([])).toContain('No events');
  });
});

describe('gateway console — LSP health row', () => {
  const lspState = (lsp: unknown): string =>
    (ui as unknown as { HEALTH_SECTIONS: { key: string; from(h: unknown): string }[] }).HEALTH_SECTIONS
      .find(section => section.key === 'lsp')!.from({ pid: 1, lsp });

  it('is ok after a clean run, warn when files were skipped or no run exists, off when disabled', () => {
    expect(lspState({ enabled: true, run: { filesWithFindings: 30, filesSkippedByBudget: 0, budgetMs: 60000 } })).toBe('ok');
    expect(lspState({ enabled: true, run: { filesWithFindings: 3, filesSkippedByBudget: 5, budgetMs: 1 } })).toBe('warn');
    expect(lspState({ enabled: true })).toBe('warn');
    expect(lspState({ enabled: false })).toBe('off');
  });

  it('stays unknown only for a worker that does not report LSP at all', () => {
    expect(lspState(undefined)).toBe('unknown');
  });
});
