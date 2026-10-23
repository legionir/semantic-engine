/**
 * Types, defaults and error of the confined file provider
 * (split from fileProvider.ts, unchanged).
 */

import * as fs from 'fs';
import { CodeIntelError, codeIntelError } from './codeintel';

/** Metadata the provider needs; a subset of `fs.Stats`. */
export interface ProviderStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Filesystem surface the provider is written against.
 *
 * It exists so that the deadline and cancellation paths can be tested with a
 * slow or hanging implementation instead of a real hang, and so that the
 * provider never depends on the write-oriented `FileSystemPort`.
 */
export interface ProviderFileSystem {
  readdir(directory: string): Promise<readonly string[]>;
  lstat(target: string): Promise<ProviderStats>;
  /** Follows symlinks, unlike `lstat`. */
  stat(target: string): Promise<ProviderStats>;
  readFile(target: string): Promise<Buffer>;
  readPrefix(target: string, maxBytes: number): Promise<Buffer>;
  realpath(target: string): Promise<string>;
  exists(target: string): Promise<boolean>;
}

export const nodeProviderFileSystem: ProviderFileSystem = {
  readdir: directory => fs.promises.readdir(directory),
  lstat: target => fs.promises.lstat(target),
  stat: target => fs.promises.stat(target),
  readFile: target => fs.promises.readFile(target),
  readPrefix: async (target, maxBytes) => {
    const handle = await fs.promises.open(target, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  realpath: target => fs.promises.realpath(target),
  exists: async target => {
    try {
      await fs.promises.access(target);
      return true;
    } catch {
      return false;
    }
  },
};

export interface ConfinedFileProviderOptions {
  readonly workspaceRoot: string;
  /** Ceiling on the number of entries one `list()` may return. */
  readonly maxFiles?: number;
  /** Ceiling on the number of bytes one `read()` may return. */
  readonly maxFileBytes?: number;
  /** Deadline for a single call. */
  readonly timeoutMs?: number;
  /** Basename globs; `*` matches any suffix. Defaults to the secret denylist. */
  readonly deniedPatterns?: readonly string[];
  /** Path segments that are never readable. */
  readonly deniedSegments?: readonly string[];
  readonly fileSystem?: ProviderFileSystem;
  /** Externally owned cancellation. */
  readonly signal?: AbortSignal;
}

export const DEFAULT_DENIED_PATTERNS: readonly string[] = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  'id_rsa*',
  'id_ed25519*',
  'credentials*',
  '.npmrc',
  '.netrc',
]);

export const DEFAULT_DENIED_SEGMENTS: readonly string[] = Object.freeze(['.git']);

export class FileProviderError extends Error {
  readonly code: CodeIntelError['code'];

  constructor(code: CodeIntelError['code'], message: string) {
    super(message);
    this.name = 'FileProviderError';
    this.code = code;
  }

  /** Envelope-ready form; the provider itself never builds envelopes. */
  toCodeIntelError(): CodeIntelError {
    return codeIntelError(this.code, this.message);
  }
}
