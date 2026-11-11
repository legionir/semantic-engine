/**
 * ProjectChatService — پرامپت، فهرست ابزارها و حلقهٔ tool-calling (SE-CHAT-03).
 */

import { ProjectChatService, toolNamesInPrompt } from './ProjectChatService';
import { AiToolRegistry as RealRegistry } from '../../ai/AiToolRegistry';
import type { AiToolRegistry } from '../../ai/AiToolRegistry';

/** یک رجیستری ساختگی که فقط list/execute لازم را دارد. */
function fakeRegistry(): AiToolRegistry {
  return {
    list: () => [
      { name: 'semantic_search', description: 'Search by natural language', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'explain_symbol', description: 'Explain one symbol', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      { name: 'get_config_usage', description: 'Env/config usages', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    ],
    execute: async (name: string) => ({
      success: true,
      items: [{ id: 's1', name: 'AuthService', kind: 'class', source: 'tree-sitter' }],
      context: `result of ${name}`,
    }),
  } as unknown as AiToolRegistry;
}

/** کنترل پاسخ‌های متوالیِ LLM از طریق mock fetch. */
function mockFetchSequence(responses: unknown[]): { calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    const payload = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, status: 200, statusText: 'OK', json: async () => payload, text: async () => '' };
  };
  return { calls };
}

const LLM = { baseUrl: 'http://mock/v1', model: 'test-model' };

describe('ProjectChatService', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { (globalThis as any).fetch = realFetch; });

  it('exposes every registered tool to the model — no name-based denylist (SE-CHAT-03)', async () => {
    const { calls } = mockFetchSequence([
      { choices: [{ message: { content: 'done', tool_calls: [] } }] },
    ]);

    await new ProjectChatService().chat(fakeRegistry(), LLM, [{ role: 'user', content: 'hi' }]);

    const toolsSent = calls[0].body.tools.map((t: any) => t.function.name);
    expect(toolsSent).toContain('semantic_search');
    expect(toolsSent).toContain('explain_symbol');
    expect(toolsSent).toContain('get_config_usage');
  });

  it('passes each tool input schema and an output-shape hint to the model', async () => {
    const { calls } = mockFetchSequence([
      { choices: [{ message: { content: 'ok', tool_calls: [] } }] },
    ]);
    await new ProjectChatService().chat(fakeRegistry(), LLM, [{ role: 'user', content: 'hi' }]);

    const search = calls[0].body.tools.find((t: any) => t.function.name === 'semantic_search');
    expect(search.function.parameters.required).toEqual(['query']);
    expect(search.function.description).toMatch(/notes and warnings/); // output-shape hint present
  });

  it('ships a strong, guard-railed system prompt', async () => {
    const { calls } = mockFetchSequence([
      { choices: [{ message: { content: 'ok', tool_calls: [] } }] },
    ]);
    await new ProjectChatService().chat(fakeRegistry(), LLM, [{ role: 'user', content: 'hi' }]);

    const system = calls[0].body.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/NEVER invent/i);
    expect(system.content).toMatch(/MUST call a tool/i);
    expect(system.content).not.toMatch(/Prefer calling a tool over guessing/); // نرم‌ترین جمله حذف شده
  });

  it('runs the tool-calling loop: executes a requested tool and feeds the result back', async () => {
    const { calls } = mockFetchSequence([
      // دور ۱: مدل ابزار می‌خواهد
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'semantic_search', arguments: '{"query":"auth"}' } }] } }] },
      // دور ۲: مدل پاسخ نهایی می‌دهد
      { choices: [{ message: { content: 'AuthService handles login.', tool_calls: [] } }] },
    ]);

    const result = await new ProjectChatService().chat(fakeRegistry(), LLM, [{ role: 'user', content: 'what is auth?' }]);

    expect(result.reply).toBe('AuthService handles login.');
    expect(result.toolTrace.map(t => t.tool)).toContain('semantic_search');
    // دور دوم باید پیام نقش tool را شامل شود
    const secondCallMessages = calls[1].body.messages;
    expect(secondCallMessages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true);
  });

  it('executes whichever tool the model requests and reports its success', async () => {
    let executed = '';
    const reg = {
      list: () => [{ name: 'get_config_usage', description: 'Env/config usages', inputSchema: { type: 'object' } }],
      execute: async (name: string) => { executed = name; return { success: true, items: [{ key: 'JWT_SECRET' }] }; },
    } as unknown as AiToolRegistry;

    mockFetchSequence([
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_config_usage', arguments: '{"key":"JWT_SECRET"}' } }] } }] },
      { choices: [{ message: { content: 'JWT_SECRET is read in app.config.ts.', tool_calls: [] } }] },
    ]);

    const result = await new ProjectChatService().chat(reg, LLM, [{ role: 'user', content: 'where is the secret read?' }]);
    expect(executed).toBe('get_config_usage');
    expect(result.toolTrace[0].ok).toBe(true);
  });

  it('only names tools that the registry really offers to it', () => {
    const registry = new RealRegistry({
      reader: { projectIndex: { files: [], symbols: [], graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] } }, getAllFiles: () => [] } as never,
      workspaceRoot: '/tmp',
      artifactRoot: '/tmp',
      projectHash: 'x',
    });
    const offered = new Set(registry.list().map(t => t.name));
    const named = toolNamesInPrompt().filter(name => name.includes('_') || offered.has(name) || ['search', 'impact'].includes(name));
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter(name => !offered.has(name))).toEqual([]);
  });

  describe('what the model is given back from a tool', () => {
    const registryReturning = (execute: (name: string, input: unknown) => unknown): AiToolRegistry =>
      ({
        list: () => [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }],
        execute: async (name: string, input: unknown) => execute(name, input),
      }) as unknown as AiToolRegistry;
    const ask = (registry: AiToolRegistry, calls: unknown[], extra: unknown[] = []) => {
      const { calls: sent } = mockFetchSequence([
        { choices: [{ message: { content: '', tool_calls: calls } }] },
        ...extra,
        { choices: [{ message: { content: 'ok', tool_calls: [] } }] },
      ]);
      return { sent, run: () => new ProjectChatService().chat(registry, LLM, [{ role: 'user', content: 'q' }]) };
    };
    const call = (args: string, name = 'search') => [{ id: 'c1', type: 'function', function: { name, arguments: args } }];
    const toolMessage = (sent: any[]) => sent[1].body.messages.find((m: any) => m.role === 'tool').content as string;

    it('hands over the same readable text MCP clients get, notes and warnings included', async () => {
      const registry = registryReturning(() => ({
        success: true,
        items: [{ id: 's1', name: 'alpha', kind: 'function', path: 'a.ts', line: 3 }],
        metadata: { truncated: true, matchCount: 40, note: 'keyword-only: no embeddings in this index' },
      }));
      const { sent, run } = ask(registry, call('{"query":"alpha"}'));
      await run();
      const text = toolMessage(sent);
      expect(text).toContain('alpha [function] a.ts:3');
      expect(text).toContain('more exist');
      expect(text).toContain('note: keyword-only');
    });

    it('does not run a tool on arguments that are not JSON', async () => {
      const execute = jest.fn();
      const { sent, run } = ask(registryReturning(execute), call('{"query": '));
      await run();
      expect(execute).not.toHaveBeenCalled();
      expect(toolMessage(sent)).toMatch(/not valid JSON/);
    });

    it('answers a call to a tool that is not offered with the names that are', async () => {
      const execute = jest.fn();
      const { sent, run } = ask(registryReturning(execute), call('{}', 'impact_analysis'));
      await run();
      expect(execute).not.toHaveBeenCalled();
      expect(toolMessage(sent)).toMatch(/no tool named "impact_analysis"\. Available tools: search/);
    });

    it('says when it cut a long result', async () => {
      const registry = registryReturning(() => ({ success: true, items: [], context: 'x'.repeat(20000) }));
      const { sent, run } = ask(registry, call('{}'));
      await run();
      expect(toolMessage(sent)).toMatch(/\[truncated: \d+ more characters/);
    });

    it('at the round limit asks for an answer and says what could not be verified', async () => {
      const registry = registryReturning(() => ({ success: true, items: [], context: 'r' }));
      const loop = { choices: [{ message: { content: '', tool_calls: call('{}') } }] };
      const { calls } = mockFetchSequence([loop, loop, { choices: [{ message: { content: 'final', tool_calls: [] } }] }]);
      const result = await new ProjectChatService().chat(registry, { ...LLM, maxToolRounds: 2 }, [{ role: 'user', content: 'q' }]);
      expect(result.reply).toBe('final');
      const last = calls[calls.length - 1].body;
      expect(last.tools).toBeUndefined();
      expect(last.messages[last.messages.length - 1].content).toMatch(/which part of the question you could not verify/);
    });
  });
});
