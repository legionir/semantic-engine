import { ConfigUsageMapper } from './ConfigUsageMapper';

describe('ConfigUsageMapper', () => {
  const mapper = new ConfigUsageMapper();

  it('should detect process.env variables', () => {
    const content = `
const apiKey = process.env.API_KEY;
const port = process.env['PORT'];
const fallback = process.env.NODE_ENV || 'development';
`;
    const usages = mapper.extract('src/config.ts', content);
    const keys = usages.map(u => u.key);

    expect(keys).toContain('API_KEY');
    expect(keys).toContain('PORT');
    expect(keys).toContain('NODE_ENV');
    expect(usages.every(u => u.kind === 'env')).toBe(true);
  });

  it('should detect import.meta.env variables', () => {
    const content = `const base = import.meta.env.VITE_API_BASE;`;
    const usages = mapper.extract('src/vite-env.d.ts', content);

    expect(usages.map(u => u.key)).toContain('VITE_API_BASE');
  });

  it('should detect config.get calls', () => {
    const content = `
const dbHost = config.get('database.host');
const timeout = nconf.get('server.timeout');
`;
    const usages = mapper.extract('src/app.ts', content);

    expect(usages.map(u => u.key)).toContain('database.host');
    expect(usages.map(u => u.key)).toContain('server.timeout');
    expect(usages.every(u => u.kind === 'config-get')).toBe(true);
  });

  it('should detect dotenv imports', () => {
    const content = `
require('dotenv').config();
import 'dotenv/config';
`;
    const usages = mapper.extract('src/main.ts', content);

    expect(usages.some(u => u.kind === 'dotenv')).toBe(true);
  });

  it('should detect .env file references', () => {
    const content = `const envPath = path.resolve(__dirname, '../.env.local');`;
    const usages = mapper.extract('src/main.ts', content);

    expect(usages.some(u => u.kind === 'env-file-reference' && u.key.includes('.env.local'))).toBe(true);
  });

  it('should include line numbers and context', () => {
    const content = `const x = process.env.X;\nconst y = process.env.Y;`;
    const usages = mapper.extract('src/a.ts', content);

    expect(usages).toHaveLength(2);
    expect(usages[0]!.line).toBe(1);
    expect(usages[1]!.line).toBe(2);
    expect(usages[0]!.context).toContain('process.env.X');
  });

  it('should dedupe identical usages on same line', () => {
    const content = `const a = process.env.X; const b = process.env.X;`;
    const usages = mapper.extract('src/a.ts', content);

    expect(usages.filter(u => u.key === 'X')).toHaveLength(1);
  });

  it('should ignore Object.prototype false positives', () => {
    const content = `const x = process.env.toString;`;
    const usages = mapper.extract('src/a.ts', content);

    expect(usages.map(u => u.key)).not.toContain('toString');
  });

  it('should respect maxResults', () => {
    const content = Array.from({ length: 20 }, (_, i) => `const x${i} = process.env.X${i};`).join('\n');
    const limited = new ConfigUsageMapper({ maxResults: 5 }).extract('src/a.ts', content);

    expect(limited).toHaveLength(5);
  });
});

/*
| SE-AI-11 — تشخیص config فقط JS/TS بود.
|
| کامنت سرآمد فهرست پشتیبانی را صریح نوشته بود: `process.env`،
| `import.meta.env`، `config.get`، dotenv. یعنی برای هر پروژهٔ
| پایتون، Go یا Rust، فیلد `configUsages` همیشه خالی بود — بدون
| اینکه جایی گفته شود این زبان‌ها پوشش داده نمی‌شوند.
*/
describe('ConfigUsageMapper — زبان‌های غیر JS (SE-AI-11)', () => {
  const mapper = new ConfigUsageMapper();

  it('Python — os.environ و os.getenv', () => {
    const usages = mapper.extract(
      'app/settings.py',
      [
        'import os',
        'DATABASE_URL = os.environ["DATABASE_URL"]',
        "SECRET = os.environ.get('SECRET_KEY')",
        "PORT = os.getenv('PORT', '8080')",
      ].join('\n')
    );

    const keys = usages.map(u => u.key).sort();
    expect(keys).toEqual(['DATABASE_URL', 'PORT', 'SECRET_KEY']);
    expect(usages.every(u => u.kind === 'env')).toBe(true);
  });

  it('Go — os.Getenv و os.LookupEnv', () => {
    const usages = mapper.extract(
      'cmd/main.go',
      ['port := os.Getenv("PORT")', 'host, ok := os.LookupEnv("HOST")'].join('\n')
    );

    expect(usages.map(u => u.key).sort()).toEqual(['HOST', 'PORT']);
  });

  it('Rust — std::env::var و ماکروی env!', () => {
    const usages = mapper.extract(
      'src/main.rs',
      [
        'let url = std::env::var("DATABASE_URL").unwrap();',
        'let key = env::var("API_KEY")?;',
        'let build = env!("CARGO_PKG_VERSION");',
      ].join('\n')
    );

    expect(usages.map(u => u.key).sort()).toEqual([
      'API_KEY',
      'CARGO_PKG_VERSION',
      'DATABASE_URL',
    ]);
  });

  it('شمارهٔ خط درست است', () => {
    const usages = mapper.extract(
      'app/settings.py',
      ['import os', '', "PORT = os.getenv('PORT')"].join('\n')
    );

    expect(usages[0]!.line).toBe(3);
  });

  it('راز داخل خط، همچنان پاک می‌شود', () => {
    const usages = mapper.extract(
      'app/settings.py',
      'KEY = os.getenv("API_KEY") or "sk-live-not-a-real-key-abcdefgh"'
    );

    expect(usages).toHaveLength(1);
    expect(usages[0]!.context).not.toContain('sk-live-not-a-real-key-abcdefgh');
  });

  it('متنی که فقط شبیه است، تطابق نمی‌دهد', () => {
    const usages = mapper.extract(
      'docs/readme.md',
      'The function os_getenv_wrapper is not os.Getenv itself.'
    );

    expect(usages).toEqual([]);
  });

  it('JS/TS همچنان کار می‌کند', () => {
    const usages = mapper.extract('src/a.ts', 'const p = process.env.PORT;');

    expect(usages.map(u => u.key)).toEqual(['PORT']);
  });
});
