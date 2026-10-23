/**
 * Process I/O helpers for the language-server child.
 */

import * as cp from 'child_process';
import type { ILogger } from '../host/Logger';

/**
 * stderr سرور: خط به خط به لاگر، هرگز به stdout ما.
 *
 * وقتی خودمان سرور MCP روی stdio هستیم، stdout کانال پروتکل است و
 * یک خط لاگ سرور کافی است تا قاب `Content-Length` را خراب کند.
 */
export function pipeServerStderr(child: cp.ChildProcess, logger: ILogger): void {
  if (!child.stderr) return;
  let buffer = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) logger.debug(`server stderr: ${line}`);
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > 64 * 1024) {
      // سروری که بدون newline حرف می‌زند نباید حافظه را ببلعد.
      logger.debug(`server stderr: ${buffer}`);
      buffer = '';
    }
  });
  child.stderr.on('error', error => {
    logger.debug('server stderr stream error', { error: String(error) });
  });
}
