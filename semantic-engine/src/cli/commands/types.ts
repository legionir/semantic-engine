/**
 * قرارداد مشترک دستورها.
 *
 * هر دستور یک *مقدار* برمی‌گرداند و خودش چاپ نمی‌کند. تصمیم دربارهٔ
 * stdout/stderr و `--json` یک جا گرفته می‌شود، وگرنه هر دستور
 * قالب خودش را می‌سازد و `--json` نصفه‌کاره می‌ماند.
 */

import { ILogger } from '../../host/Logger';

export interface CommandContext {
  readonly cwd: string;
  readonly logger: ILogger;
}

export interface CommandResult {
  readonly code: number;
  /** خروجی انسانی. */
  readonly text?: string;
  /** خروجی ماشین‌خوان برای `--json`. */
  readonly json?: unknown;
  /** پیام خطا — همیشه روی stderr. */
  readonly error?: string;
}
