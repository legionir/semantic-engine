import { ILogger } from '../host/Logger';
import { CancellationToken } from '../host/Cancellation';
import { FileEntry } from '../core/types/project-index.types';
import type { IndexPipelineOptions } from './IndexPipeline';

/** آنچه این مراحل از pipeline لازم دارند. */
export interface StageContext {
  readonly options: IndexPipelineOptions;
  readonly logger: ILogger;
  readonly token: CancellationToken | undefined;
  report(message: string, increment?: number): void;
  contentOf(file: FileEntry, cache: Map<string, string>, countRead: () => void): Promise<string | null>;
}

/**
 * diagnostics واقعی — LSP-14.
 *
 * جدا از حلقهٔ اصلی اجرا می‌شود و نه داخلش، به یک دلیل: این مرحله
 * بودجه دارد و باید بتواند وسط کار بایستد بدون اینکه symbolها یا
 * وابستگی‌ها نیمه‌کاره بمانند. اگر داخل همان حلقه بود، تمام شدن
 * بودجه یعنی فایل‌های بعدی *هیچ‌چیز* نمی‌گرفتند.
 */
