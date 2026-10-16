/**
 * ProjectChatService — پرامپت، فهرست ابزارها و حلقهٔ tool-calling (SE-CHAT-03).
 */

import { ProjectChatService } from './ProjectChatService';
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
    expect(search.function.description).toMatch(/items/); // output-shape hint present
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
});
