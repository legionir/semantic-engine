/**
 * راز نباید از سورس به ایندکس منتقل شود.
 *
 * ConfigUsageEntry.context خط خام سورس است و مستقیم در
 * project-index.json نوشته می‌شود — فایلی که داخل خود
 * workspace ساخته می‌شوند و ممکن است commit شوند.
 */

import { ConfigUsageMapper } from './ConfigUsageMapper';
import { SecretRedactor } from './llm/SecretRedactor';

describe('secret redaction', () => {

  describe('ConfigUsageMapper', () => {

    const mapper = new ConfigUsageMapper();

    function contextFor(source: string): string {
      const usages = mapper.extract('src/env.ts', source);
      expect(usages.length).toBeGreaterThan(0);
      return usages[0]!.context ?? '';
    }

    it('redacts a key sitting in the fallback of an env read', () => {
      const context = contextFor(
        `const k = process.env.API_KEY || 'sk-live-4eC39HqLyjWDarjtT1zdp7dc';`
      );

      expect(context).not.toMatch(/4eC39HqLyjWDarjtT1zdp7dc/);
      expect(context).toMatch(/REDACTED/);
    });

    it('redacts a github token', () => {
      const context = contextFor(
        `const t = process.env.GH || 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';`
      );

      expect(context).not.toMatch(/16C7e42F292c6912E7710c838347Ae178B4a/);
    });

    it('redacts the password inside a connection string', () => {
      const context = contextFor(
        `const dsn = process.env.DATABASE_URL || 'postgres://admin:hunter2@db:5432/app';`
      );

      expect(context).not.toMatch(/hunter2/);
      expect(context).toMatch(/postgres:\/\/admin:\[REDACTED\]@db/);
    });

    it('leaves a line with no secret alone', () => {
      const line = `const port = process.env.PORT;`;

      expect(contextFor(line)).toBe(line);
    });

    it('still reports the key name it found', () => {
      const usages = mapper.extract(
        'src/env.ts',
        `const k = process.env.API_KEY || 'sk-live-4eC39HqLyjWDarjtT1zdp7dc';`
      );

      expect(usages[0]!.key).toBe('API_KEY');
    });
  });

  describe('SecretRedactor patterns', () => {

    const redactor = new SecretRedactor();

    const secrets: ReadonlyArray<readonly [string, string]> = [
      ['openai style', 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'],
      ['stripe style', 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
      ['github classic', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
      ['github fine grained', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz'],
      ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
      ['slack', 'xoxb-' + '123456789012-abcdefghijklmnop'],
      ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
    ];

    for (const [name, secret] of secrets) {
      it(`redacts a ${name} token`, () => {
        const output = redactor.redact(`const value = "${secret}";`);

        expect(output).not.toContain(secret);
        expect(output).toMatch(/REDACTED/);
      });
    }

    it('redacts a private key block', () => {
      const output = redactor.redact(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ\n-----END RSA PRIVATE KEY-----'
      );

      expect(output).not.toMatch(/MIIEpAIBAAKCAQ/);
    });

    it('leaves ordinary code alone', () => {
      const source = [
        'import { readFile } from "fs";',
        'export const TIMEOUT_MS = 30000;',
        'const url = "https://example.com/docs";',
        'function skipEmpty(values: string[]) { return values.filter(Boolean); }',
      ].join('\n');

      expect(redactor.redact(source)).toBe(source);
    });
  });
});
