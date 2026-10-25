/**
 * The block every long-running command prints once it is ready.
 *
 * Every command used to hand-format its own bullets; the layout, the version
 * line and the way a link carries its token drifted apart. One renderer keeps
 * them identical: a title with the version, then labelled rows aligned in a
 * column, with every URL written as `ADDRESS?token=TOKEN`.
 */

import { PRODUCT_NAME, packageVersion } from '../host/version';

export interface BannerRow {
  readonly label: string;
  readonly value: string;
}

export interface BannerSection {
  readonly title?: string;
  readonly rows: readonly BannerRow[];
}

/** `http://host:4000/path` -> `http://host:4000/path?token=…` (keeps an existing query). */
export function withToken(url: string, token: string | undefined): string {
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function renderBanner(options: {
  readonly mode: string;
  readonly sections: readonly BannerSection[];
  readonly footer?: readonly string[];
}): string {
  const width = Math.max(
    8,
    ...options.sections.flatMap(section => section.rows.map(row => row.label.length))
  );
  const lines: string[] = [
    '',
    `${PRODUCT_NAME} v${packageVersion()} · ${options.mode}`,
  ];
  for (const section of options.sections) {
    lines.push('');
    if (section.title) lines.push(`  ${section.title}`);
    for (const row of section.rows) {
      lines.push(`    ${row.label.padEnd(width)}  ${row.value}`);
    }
  }
  if (options.footer && options.footer.length > 0) {
    lines.push('');
    for (const line of options.footer) lines.push(`  ${line}`);
  }
  lines.push('');
  return lines.join('\n');
}
