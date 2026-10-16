/**
 * WebSocketManager — Manages live bidirectional event channels between AI Agent and Visualizer.
 */

import * as http from 'http';
import { EventEmitter } from 'events';

export interface AgentGraphCommand {
  readonly action: 'focus' | 'highlight_path' | 'annotate' | 'pulse';
  readonly targetNodes: readonly string[];
  readonly path?: readonly string[];
  readonly annotation?: {
    readonly title: string;
    readonly message: string;
    readonly level: 'info' | 'warning' | 'error';
  };
}

export class WebSocketManager extends EventEmitter {
  private readonly clients = new Set<http.ServerResponse>();

  registerClient(res: http.ServerResponse): void {
    this.clients.add(res);
  }

  unregisterClient(res: http.ServerResponse): void {
    this.clients.delete(res);
  }

  broadcastCommand(projectId: string, command: AgentGraphCommand): void {
    const payload = JSON.stringify({
      type: 'agent.graph.command',
      projectId,
      command,
      timestamp: Date.now(),
    });

    this.emit('command', { projectId, command });

    for (const client of this.clients) {
      if (!client.writableEnded) {
        client.write(`event: agent.graph.command\ndata: ${payload}\n\n`);
      }
    }
  }

  getActiveClientsCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* client already disconnected */
      }
    }
    this.clients.clear();
    this.removeAllListeners();
  }
}
