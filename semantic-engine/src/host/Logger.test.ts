/**
 * لاگر میزبان — MIG-10.
 *
 * دو الزام واقعی این تست‌ها را شکل داده‌اند:
 *
 * ۱. در حالت stdio (سرور MCP) stdout متعلق به جریان JSON-RPC است. یک خط
 *    لاگ روی stdout یعنی پیام بدشکل و قطع ارتباط. پس در آن حالت هر سطحی،
 *    حتی debug، باید به stderr برود.
 * ۲. لاگ باید هم برای آدم خواندنی باشد و هم برای ماشین. یعنی دو قالب.
 */

import { Logger, LOG_LEVELS, createLoggerFromEnv } from './Logger';

/** یک sink در حافظه تا بتوان دقیقاً دید چه چیزی کجا نوشته شد. */
function makeSink() {
  const chunks: string[] = [];
  return {
    write(chunk: string): void {
      chunks.push(chunk);
    },
    get lines(): string[] {
      return chunks.join('').split('\n').filter(line => line.length > 0);
    },
    get text(): string {
      return chunks.join('');
    },
  };
}

function makeLogger(options: Record<string, unknown> = {}) {
  const out = makeSink();
  const err = makeSink();
  const logger = new Logger({
    stdout: out,
    stderr: err,
    now: () => new Date('2026-08-18T09:30:00.000Z'),
    ...options,
  });
  return { logger, out, err };
}

describe('Logger', () => {

  describe('routing between stdout and stderr', () => {

    it('sends error and warn to stderr, info and debug to stdout', () => {
      const { logger, out, err } = makeLogger({ level: 'debug' });

      logger.error('boom');
      logger.warn('careful');
      logger.info('working');
      logger.debug('details');

      expect(err.text).toContain('boom');
      expect(err.text).toContain('careful');
      expect(err.text).not.toContain('working');
      expect(out.text).toContain('working');
      expect(out.text).toContain('details');
      expect(out.text).not.toContain('boom');
    });

    /*
    | این تنها تست بلوکی است که اگر بشکند، سرور MCP در عمل از کار
    | می‌افتد: هر بایت اضافه روی stdout قاب Content-Length را بهم می‌زند.
    */
    it('writes nothing at all to stdout in stdio mode', () => {
      const { logger, out, err } = makeLogger({ level: 'debug', stdio: true });

      for (const level of LOG_LEVELS) {
        logger[level](`message at ${level}`);
      }

      expect(out.text).toBe('');
      for (const level of LOG_LEVELS) {
        expect(err.text).toContain(`message at ${level}`);
      }
    });

    it('keeps stdout clean in stdio mode even for the ndjson format', () => {
      const { logger, out, err } = makeLogger({ stdio: true, format: 'ndjson' });

      logger.info('indexing started');

      expect(out.text).toBe('');
      expect(err.lines).toHaveLength(1);
    });
  });

  describe('levels', () => {

    it('drops everything below the configured level', () => {
      const { logger, out, err } = makeLogger({ level: 'warn' });

      logger.error('kept');
      logger.warn('kept too');
      logger.info('dropped');
      logger.debug('dropped too');

      expect(err.lines).toHaveLength(2);
      expect(out.lines).toHaveLength(0);
    });

    it('defaults to info, so debug is silent unless asked for', () => {
      const { logger, out } = makeLogger();

      logger.info('visible');
      logger.debug('invisible');

      expect(out.lines).toHaveLength(1);
      expect(out.text).toContain('visible');
    });

    it('can be silenced completely', () => {
      const { logger, out, err } = makeLogger({ level: 'silent' });

      logger.error('not even this');

      expect(out.text).toBe('');
      expect(err.text).toBe('');
    });

    it('changes level at runtime', () => {
      const { logger, out } = makeLogger({ level: 'info' });

      logger.debug('before');
      logger.setLevel('debug');
      logger.debug('after');

      expect(out.text).not.toContain('before');
      expect(out.text).toContain('after');
    });
  });

  describe('text format', () => {

    it('writes one line with timestamp, level and message', () => {
      const { logger, out } = makeLogger();

      logger.info('scan complete');

      expect(out.lines).toEqual(['2026-08-18T09:30:00.000Z info  scan complete']);
    });

    it('appends metadata as key=value pairs', () => {
      const { logger, out } = makeLogger();

      logger.info('scan complete', { files: 59, ms: 213 });

      expect(out.lines[0]).toBe('2026-08-18T09:30:00.000Z info  scan complete files=59 ms=213');
    });

    it('quotes metadata values that contain spaces', () => {
      const { logger, out } = makeLogger();

      logger.info('failed', { path: 'src/my file.ts' });

      expect(out.lines[0]).toContain('path="src/my file.ts"');
    });

    it('shows the scope of a child logger', () => {
      const { logger, out } = makeLogger();

      logger.child('scanner').info('walking');

      expect(out.lines[0]).toBe('2026-08-18T09:30:00.000Z info  [scanner] walking');
    });

    it('nests child scopes with a dot', () => {
      const { logger, out } = makeLogger();

      logger.child('pipeline').child('symbols').info('extracting');

      expect(out.lines[0]).toContain('[pipeline.symbols]');
    });
  });

  describe('ndjson format', () => {

    it('writes one parseable JSON object per line', () => {
      const { logger, out } = makeLogger({ format: 'ndjson', level: 'debug' });

      logger.info('scan complete', { files: 59 });
      logger.debug('detail');

      const records = out.lines.map(line => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        ts: '2026-08-18T09:30:00.000Z',
        level: 'info',
        message: 'scan complete',
        meta: { files: 59 },
      });
      expect(records[1]).toEqual({
        ts: '2026-08-18T09:30:00.000Z',
        level: 'debug',
        message: 'detail',
      });
    });

    it('includes the scope as its own field', () => {
      const { logger, err } = makeLogger({ format: 'ndjson' });

      logger.child('git').warn('slow');

      expect(JSON.parse(err.lines[0]).scope).toBe('git');
    });

    /*
    | یک رکورد باید دقیقاً یک خط باشد، وگرنه NDJSON نیست و هر خوانندهٔ
    | خط‌به‌خط روی پیام چندخطی می‌شکند.
    */
    it('never emits a raw newline inside a record', () => {
      const { logger, err } = makeLogger({ format: 'ndjson' });

      logger.error('two\nlines', { detail: 'also\ntwo' });

      expect(err.lines).toHaveLength(1);
      expect(JSON.parse(err.lines[0]).message).toBe('two\nlines');
    });
  });

  describe('errors as metadata', () => {

    it('renders an Error value with its message, not as [object Object]', () => {
      const { logger, err } = makeLogger();

      logger.error('scan failed', { cause: new Error('ENOENT: missing file') });

      expect(err.text).toContain('ENOENT: missing file');
      expect(err.text).not.toContain('[object Object]');
    });

    it('keeps the stack in the ndjson record', () => {
      const { logger, err } = makeLogger({ format: 'ndjson' });

      logger.error('scan failed', { cause: new Error('bad') });

      const record = JSON.parse(err.lines[0]);
      expect(record.meta.cause.message).toBe('bad');
      expect(typeof record.meta.cause.stack).toBe('string');
    });
  });

  describe('robustness', () => {

    /*
    | یک ساختار حلقوی در metadata نباید کل ایندکس را با
    | «Converting circular structure to JSON» متوقف کند. لاگر ابزار
    | تشخیص است؛ خودش نباید منبع خرابی شود.
    */
    it('survives a circular metadata object', () => {
      const { logger, err } = makeLogger({ format: 'ndjson' });
      const cyclic: Record<string, unknown> = { name: 'node' };
      cyclic.self = cyclic;

      expect(() => logger.error('cyclic', { node: cyclic })).not.toThrow();
      expect(err.lines).toHaveLength(1);
      expect(() => JSON.parse(err.lines[0])).not.toThrow();
    });

    it('never lets a broken sink take the process down', () => {
      const exploding = {
        write(): void {
          throw new Error('EPIPE');
        },
      };
      const logger = new Logger({ stdout: exploding, stderr: exploding });

      expect(() => logger.error('anything')).not.toThrow();
    });
  });

  describe('createLoggerFromEnv', () => {

    it('reads level and format from the environment', () => {
      const out = makeSink();
      const err = makeSink();
      const logger = createLoggerFromEnv(
        {
          SEMANTIC_ENGINE_LOG_LEVEL: 'debug',
          SEMANTIC_ENGINE_LOG_FORMAT: 'ndjson',
        },
        { stdout: out, stderr: err }
      );

      logger.debug('hello');

      expect(JSON.parse(out.lines[0]).message).toBe('hello');
    });

    it('ignores an unknown level rather than throwing', () => {
      const out = makeSink();
      const logger = createLoggerFromEnv(
        { SEMANTIC_ENGINE_LOG_LEVEL: 'chatty' },
        { stdout: out, stderr: makeSink() }
      );

      logger.info('still works');

      expect(out.lines).toHaveLength(1);
    });

    it('turns on stdio mode from the environment', () => {
      const out = makeSink();
      const err = makeSink();
      const logger = createLoggerFromEnv(
        { SEMANTIC_ENGINE_STDIO: '1' },
        { stdout: out, stderr: err }
      );

      logger.info('to stderr please');

      expect(out.text).toBe('');
      expect(err.text).toContain('to stderr please');
    });
  });
});
