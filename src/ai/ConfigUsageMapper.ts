/**
 * ConfigUsageMapper — شناسایی استفاده از env variables و config keys در کد.
 *
 * پشتیبانی‌شده:
 * - process.env.VAR_NAME / process.env['VAR_NAME']
 * - import.meta.env.VAR_NAME
 * - config.get('key') / nconf.get('key')
 * - require('dotenv').config() / import 'dotenv/config'
 * - ارجاع به فایل‌های .env در import/path string
 * - **Python**: os.environ['X'] / os.environ.get('X') / os.getenv('X')
 * - **Go**: os.Getenv("X") / os.LookupEnv("X")
 * - **Rust**: std::env::var("X") / env::var("X") / env!("X")
 *
 * ── SE-AI-11 ──────────────────────────────────────────────────────
 *
 * تا فاز ۴۵ این فهرست فقط سه ردیف اول را داشت، یعنی برای هر پروژهٔ
 * پایتون، Go یا Rust فیلد `configUsages` **همیشه خالی** بود — و
 * هیچ‌جا هم اعلام نمی‌شد که این زبان‌ها پوشش داده نمی‌شوند. مصرف‌کننده
 * «هیچ متغیر محیطی‌ای استفاده نشده» را از «بلد نیستم نگاه کنم» تشخیص
 * نمی‌داد.
 *
 * الگوها عمداً به فراخوانیِ واقعی گره خورده‌اند (`os.getenv(` با
 * پرانتز) نه صرفِ وجودِ نام، تا متنی مثل «the os.Getenv function»
 * در یک فایل markdown تطابق ندهد.
 */

import { ConfigUsageEntry, ConfigUsageKind } from '../core/types/project-index.types';
import { SecretRedactor } from './llm/SecretRedactor';

export interface ConfigUsageMapperOptions {
  /** حداکثر تعداد نتایج برای هر فایل */
  readonly maxResults?: number;
}

export class ConfigUsageMapper {
  /*
  | context خط خام سورس است و مستقیم در project-index.json نوشته
  | می‌شود —
  | نوشته می‌شود — فایل‌هایی که داخل workspace ساخته می‌شوند و ممکن است
  | commit شوند. خطی مثل
  |     const key = process.env.API_KEY || "sk-live-abc123"
  | راز را عیناً منتقل می‌کرد.
  */
  private readonly redactor = new SecretRedactor();

  constructor(private readonly options: ConfigUsageMapperOptions = {}) {}

  extract(relativePath: string, content: string): ConfigUsageEntry[] {
    const results: ConfigUsageEntry[] = [];
    const lines = content.split('\n');
    const seen = new Set<string>();

    const add = (kind: ConfigUsageKind, key: string, line: number, context: string): void => {
      const dedupeKey = `${kind}:${key}:${line}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      results.push({
        kind,
        key: key.trim(),
        line,
        context: this.redactor.redact(context.trim()).slice(0, 200),
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNumber = i + 1;

      // process.env.VAR or process.env['VAR'] or process.env["VAR"]
      const processEnvMatches = this.matchProcessEnv(line);
      for (const key of processEnvMatches) {
        add('env', key, lineNumber, line);
      }

      // import.meta.env.VAR
      const importMetaEnvMatches = this.matchImportMetaEnv(line);
      for (const key of importMetaEnvMatches) {
        add('env', key, lineNumber, line);
      }

      // SE-AI-11 — Python / Go / Rust
      for (const key of this.matchOtherLanguageEnv(line)) {
        add('env', key, lineNumber, line);
      }

      // config.get('key') / nconf.get('key') / appConfig.get('key')
      const configGetMatches = this.matchConfigGet(line);
      for (const key of configGetMatches) {
        add('config-get', key, lineNumber, line);
      }

      // dotenv import
      const dotenvMatch = this.matchDotenvImport(line);
      if (dotenvMatch) {
        add('dotenv', dotenvMatch, lineNumber, line);
      }

      // .env file reference
      const envFileMatches = this.matchEnvFileReference(line);
      for (const key of envFileMatches) {
        add('env-file-reference', key, lineNumber, line);
      }
    }

    const maxResults = this.options.maxResults ?? 500;
    return results.slice(0, maxResults);
  }

  private matchProcessEnv(line: string): string[] {
    const results: string[] = [];
    const patterns = [
      /process\.env\.[A-Za-z_][A-Za-z0-9_]*/g,
      /process\.env\[(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\]/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const raw = match[0];
        const key = raw.replace(/^process\.env\.?/, '').replace(/[[\]'"`]/g, '');
        if (key && !this.isCommonFalsePositive(key)) {
          results.push(key);
        }
      }
    }
    return results;
  }

  /**
   * SE-AI-11 — الگوهای متغیر محیطی در Python، Go و Rust.
   *
   * هر الگو پرانتز یا براکتِ فراخوانی را هم می‌خواهد، پس صرفِ نوشتنِ
   * نامِ تابع در یک کامنت یا مستند، تطابق نمی‌دهد.
   */
  private matchOtherLanguageEnv(line: string): string[] {
    const results: string[] = [];
    const patterns: RegExp[] = [
      // Python: os.environ['X'] / os.environ["X"]
      /os\.environ\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
      // Python: os.environ.get('X') / os.getenv('X')
      /os\.(?:environ\.get|getenv)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
      // Go: os.Getenv("X") / os.LookupEnv("X")
      /os\.(?:Getenv|LookupEnv)\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
      // Rust: std::env::var("X") / env::var("X") / env::var_os("X")
      /(?:std::)?env::var(?:_os)?\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
      // Rust: env!("X") / option_env!("X")
      /(?:option_)?env!\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
    ];

    for (const pattern of patterns) {
      /*
      | یک نمونهٔ تازه برای هر خط. یک regex با پرچم `g` مقدار
      | `lastIndex` را بین فراخوانی‌ها نگه می‌دارد — همان تلهٔ
      | SE-SEC-02. اینجا چون آرایه در هر فراخوانی از نو ساخته
      | می‌شود مشکلی نیست، ولی ارزش نوشتن دارد.
      */
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (match[1]) results.push(match[1]);
      }
    }

    return results;
  }

  private matchImportMetaEnv(line: string): string[] {
    const results: string[] = [];
    const pattern = /import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const key = match[0].replace(/^import\.meta\.env\./, '');
      if (key && !this.isCommonFalsePositive(key)) {
        results.push(key);
      }
    }
    return results;
  }

  private matchConfigGet(line: string): string[] {
    const results: string[] = [];
    const pattern = /(?:config|nconf|appConfig|cfg)\.get\((['"`])([^'"`]+)\1\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const key = match[2];
      if (key && !this.isCommonFalsePositive(key)) {
        results.push(key);
      }
    }
    return results;
  }

  private matchDotenvImport(line: string): string | null {
    if (/require\(['"]dotenv['"]\)\.config\(\)/.test(line)) return 'dotenv';
    if (/import\s+['"]dotenv\/config['"]/.test(line)) return 'dotenv';
    if (/from\s+['"]dotenv['"]/.test(line) && /config\(\)/.test(line)) return 'dotenv';
    return null;
  }

  private matchEnvFileReference(line: string): string[] {
    const results: string[] = [];
    const pattern = /["']([^"']*\.env[^"']*)["']/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const path = match[1];
      if (path) {
        results.push(path);
      }
    }
    return results;
  }

  private isCommonFalsePositive(key: string): boolean {
    // اجتناب از ثبت دسترسی به property های Object.prototype
    const falsePositives = new Set([
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
    ]);
    return falsePositives.has(key);
  }
}
