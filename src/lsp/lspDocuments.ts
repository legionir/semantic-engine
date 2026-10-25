/**
 * Open-document bookkeeping of an LSP client (split from LspClient.ts, behavior unchanged):
 * reference-counted `didOpen` / `didChange` / `didClose`.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { LspError } from './LspClientTypes';

interface OpenDocument {
  readonly uri: string;
  readonly languageId: string;
  version: number;
  refCount: number;
  text: string;
}

export interface LspDocumentStoreDeps {
  readonly serverId: string;
  /** Throws `LspNotRunningError` when the server is not running. */
  assertRunning(what: string): void;
  notify(method: string, params: unknown): void;
  isRunning(): boolean;
}

const uriOf = (filePath: string): string => pathToFileURL(filePath).toString();

export class LspDocumentStore {
  private readonly documents = new Map<string, OpenDocument>();

  constructor(private readonly deps: LspDocumentStoreDeps) {}

  get size(): number {
    return this.documents.size;
  }

  has(filePath: string): boolean {
    return this.documents.has(uriOf(filePath));
  }

  open(filePath: string, languageId: string, text?: string): void {
    this.deps.assertRunning(`open ${filePath}`);
    const uri = uriOf(filePath);
    const existing = this.documents.get(uri);

    if (existing) {
      existing.refCount += 1;
      if (text !== undefined && text !== existing.text) this.change(filePath, text);
      return;
    }

    const content = text ?? fs.readFileSync(filePath, 'utf8');
    this.documents.set(uri, { uri, languageId, version: 1, refCount: 1, text: content });
    this.deps.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  change(filePath: string, text: string): void {
    this.deps.assertRunning(`change ${filePath}`);
    const uri = uriOf(filePath);
    const doc = this.documents.get(uri);
    if (!doc) {
      throw new LspError(
        `cannot change ${filePath}: the document is not open on server ${this.deps.serverId}`,
        this.deps.serverId
      );
    }
    doc.version += 1;
    doc.text = text;
    this.deps.notify('textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  close(filePath: string): void {
    const uri = uriOf(filePath);
    const doc = this.documents.get(uri);
    if (!doc) return;

    doc.refCount -= 1;
    if (doc.refCount > 0) return;

    this.documents.delete(uri);
    if (this.deps.isRunning()) {
      this.deps.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  /** Graceful shutdown: tell the server about every document, then forget them. */
  closeAll(): void {
    for (const [key, doc] of this.documents) {
      this.deps.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
      this.documents.delete(key);
    }
  }

  /** The server is gone; nothing to notify. */
  clear(): void {
    this.documents.clear();
  }
}
