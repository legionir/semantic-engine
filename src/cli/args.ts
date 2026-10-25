/**
 * تجزیهٔ آرگومان — MIG-50.
 *
 * عمداً دست‌ساز و بدون وابستگی. یک CLI که برای خواندن `--root` یک
 * پکیج خارجی بیاورد، همان چیزی است که SE-BUILD-10 درباره‌اش هشدار
 * می‌دهد؛ و آنچه لازم است در پنجاه خط جا می‌شود.
 */

/**
 * کدهای خروج.
 *
 * تفکیک «استفادهٔ غلط» از «شکست اجرا» برای اسکریپت‌نویس مهم است:
 * اولی یعنی دستور را عوض کن، دومی یعنی محیط را درست کن.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** `doctor` بررسیِ *لازم*ی را ناموفق دید. */
  unhealthy: 3,
} as const;

export type OptionValue = string | boolean;

export interface ParsedArgs {
  /** `null` یعنی هیچ دستوری داده نشده. */
  readonly command: string | null;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

/** `--foo-bar` → `fooBar`؛ `--root` → `root`. */
function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, OptionValue> = {};
  let command: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;

    if (!token.startsWith('-')) {
      if (command === null) command = token;
      else positional.push(token);
      continue;
    }

    // `--` تمام پرچم‌ها را می‌بندد
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    const bare = token.replace(/^--?/, '');

    // `--key=value`
    const equals = bare.indexOf('=');
    if (equals !== -1) {
      options[camelCase(bare.slice(0, equals))] = bare.slice(equals + 1);
      continue;
    }

    // `--no-key` → key: false
    if (bare.startsWith('no-')) {
      options[camelCase(bare.slice(3))] = false;
      continue;
    }

    /*
    | یک پرچم مقدار می‌گیرد فقط اگر توکن بعدی خودش پرچم نباشد. بدون
    | این قید، `--pretty --root /x` مقدار `--root` را به `pretty`
    | می‌داد و `root` بی‌مقدار می‌ماند.
    */
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      options[camelCase(bare)] = next;
      index++;
    } else {
      options[camelCase(bare)] = true;
    }
  }

  return { command, positional, options };
}

/** مقدار رشته‌ای یک گزینه، یا `undefined`. */
export function stringOption(
  options: Readonly<Record<string, OptionValue>>,
  name: string
): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

/** مقدار boolean یک گزینه، با پیش‌فرض. */
export function boolOption(
  options: Readonly<Record<string, OptionValue>>,
  name: string,
  fallback: boolean
): boolean {
  const value = options[name];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
