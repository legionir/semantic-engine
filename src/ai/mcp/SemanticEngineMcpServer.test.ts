/**
 * تست SemanticEngineMcpServer با SDK رسمی.
 *
 * چون transport رسمی stdio است، یک InMemoryTransport ساده می‌سازیم
 * تا server و client را به هم متصل کنیم.
 */

import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { ProjectIndex, FileEntry, SymbolEntry } from '../../core/types/project-index.types';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

function createFile(id: string, path: string): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    encoding: 'utf8',
    size: 100,
    lines: 10,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile: false,
    generated: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  };
}

function createSymbol(id: string, fileId: string, name: string): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    line: 1,
    endLine: 1,
    source: 'lsp',
    confidence: 85,
  } as SymbolEntry;
}

function createProjectIndex(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: '/project',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files: [createFile('f1', 'src/utils.ts')],
    symbols: [createSymbol('s1', 'f1', 'activate')],
    graphs: {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 1,
      totalLoc: 10,
      totalSymbols: 1,
      avgCyclomaticComplexity: 0,
      languageBreakdown: { typescript: 1 },
    },
  };
}

class InMemoryTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(private readonly other: InMemoryTransport) {}

  async start(): Promise<void> {
    // no-op
  }

  async close(): Promise<void> {
    if (this.onclose) this.onclose();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.other.onmessage) {
      this.other.onmessage(message);
    }
  }
}

function createTransportPair(): [InMemoryTransport, InMemoryTransport] {
  const a = {} as InMemoryTransport;
  const b = {} as InMemoryTransport;
  Object.setPrototypeOf(a, InMemoryTransport.prototype);
  Object.setPrototypeOf(b, InMemoryTransport.prototype);
  (a as any).other = b;
  (b as any).other = a;
  return [a, b];
}

describe('SemanticEngineMcpServer', () => {
  it('should construct without errors', () => {
    const server = new SemanticEngineMcpServer({ projectIndex: createProjectIndex() });
    expect(server).toBeDefined();
  });

  it('should list tools via MCP protocol', async () => {
    const projectIndex = createProjectIndex();
    const [serverTransport, clientTransport] = createTransportPair();

    const server = new SemanticEngineMcpServer({ projectIndex });
    await (server as any).server.connect(serverTransport);

    const receivedMessages: JSONRPCMessage[] = [];
    clientTransport.onmessage = (msg) => receivedMessages.push(msg);
    await clientTransport.start();

    // Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    };
    await clientTransport.send(initRequest as JSONRPCMessage);

    // Wait for initialize response
    await new Promise(r => setTimeout(r, 50));

    // Send tools/list request
    const listRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };
    await clientTransport.send(listRequest as JSONRPCMessage);

    // Wait for response
    await new Promise(r => setTimeout(r, 100));

    const listResponse = receivedMessages.find(
      m => typeof m === 'object' && 'id' in m && m.id === 2
    ) as any;

    expect(listResponse).toBeDefined();
    expect(listResponse.result).toBeDefined();
    expect(Array.isArray(listResponse.result.tools)).toBe(true);
    expect(listResponse.result.tools.length).toBeGreaterThan(0);

    const toolNames = listResponse.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('find_symbol');
    expect(toolNames).toContain('get_config_usage');
    expect(toolNames).toEqual(expect.arrayContaining(['code_outline', 'code_fold', 'code_read', 'symbol_find', 'symbol_inspect', 'search_text', 'diagnostics_get', 'project_info', 'project_list_files', 'gains_report']));

    await server.close();
  });

  it('should call a tool via MCP protocol', async () => {
    const projectIndex = createProjectIndex();
    const [serverTransport, clientTransport] = createTransportPair();

    const server = new SemanticEngineMcpServer({ projectIndex });
    await (server as any).server.connect(serverTransport);

    const receivedMessages: JSONRPCMessage[] = [];
    clientTransport.onmessage = (msg) => receivedMessages.push(msg);
    await clientTransport.start();

    // initialize
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    } as JSONRPCMessage);
    await new Promise(r => setTimeout(r, 50));

    // call tool
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'find_symbol',
        arguments: { name: 'activate' },
      },
    } as JSONRPCMessage);
    await new Promise(r => setTimeout(r, 100));

    const callResponse = receivedMessages.find(
      m => typeof m === 'object' && 'id' in m && m.id === 2
    ) as any;

    expect(callResponse).toBeDefined();
    expect(callResponse.result).toBeDefined();
    expect(callResponse.result.isError).toBe(false);
    expect(callResponse.result.content).toHaveLength(1);

    const parsed = JSON.parse(callResponse.result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);

    await server.close();
  });

  it('exposes the Phase 1 structural tools through tools/call', async () => {
    const server = new SemanticEngineMcpServer({ projectIndex: createProjectIndex() });
    const result = await server.callTool('code_outline', { path: 'src/utils.ts' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(expect.objectContaining({ success: true, indexGeneration: 0 }));
    await server.close();
  });

  it('should connect to a custom transport via connectTransport', async () => {
    const projectIndex = createProjectIndex();
    const [serverTransport, clientTransport] = createTransportPair();

    const server = new SemanticEngineMcpServer({ projectIndex });
    await server.connectTransport(serverTransport);

    const receivedMessages: JSONRPCMessage[] = [];
    clientTransport.onmessage = (msg) => receivedMessages.push(msg);
    await clientTransport.start();

    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    } as JSONRPCMessage);
    await new Promise(r => setTimeout(r, 50));

    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    } as JSONRPCMessage);
    await new Promise(r => setTimeout(r, 100));

    const listResponse = receivedMessages.find(
      m => typeof m === 'object' && 'id' in m && m.id === 2
    ) as any;

    expect(listResponse).toBeDefined();
    expect(Array.isArray(listResponse.result.tools)).toBe(true);

    await server.close();
  });
});
