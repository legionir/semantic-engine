/**
 * LlmAiMetadataGenerator — تولید AI Metadata با استفاده از LLM واقعی.
 *
 * ورودی: project-index (یا یک slice از آن برای یک فایل).
 * خروجی: AiMetadata برای هر فایل.
 *
 * این generator قبل از ارسال محتوا، secretها را redact می‌کند.
 */

import { FileEntry, SymbolEntry, DependencyEdge, AiMetadata, AiScore } from '../../core/types/project-index.types';
import { ILlmClient, LlmMessage } from './LlmClient';
import { SecretRedactor } from './SecretRedactor';
import { defaultLogger } from '../../host/Logger';
import {
  estimateTokens as sharedEstimateTokens,
} from '../ranking/TokenBudget';

export interface LlmAiMetadataInput {
  readonly workspaceRoot: string;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
  readonly dependencyGraph: readonly DependencyEdge[];
}

export interface LlmAiMetadataOptions {
  readonly llmClient: ILlmClient;
  readonly maxFilesPerBatch?: number;
  /** چند درخواست هم‌زمان. */
  readonly concurrency?: number;
  /** سقف تعداد کل درخواست‌ها — بودجهٔ هزینه. */
  readonly maxRequests?: number;
  /** لغو. */
  readonly signal?: AbortSignal;
}

export class LlmAiMetadataGenerator {
  private readonly redactor = new SecretRedactor();
  /**
   * hash محتوای فایل → متادیتای تولیدشده — SE-AI-04.
   *
   * روی نمونه زندگی می‌کند، پس بین دو `generate` پشت سر هم (که مسیر
   * watch دقیقاً همین را می‌کند) فایلِ دست‌نخورده دوباره پرسیده
   * نمی‌شود. `hash` در `FileEntry` از قبل هست و از فاز ۲۱ کل فایل را
   * پوشش می‌دهد، پس معیار درستی است.
   */
  private readonly byContentHash = new Map<string, AiMetadata>();
  private spentRequests = 0;

  constructor(private readonly options: LlmAiMetadataOptions) {}

  /**
   * ── SE-AI-04 ──────────────────────────────────────────────────────
   *
   * نسخهٔ قبلی روی همهٔ فایل‌ها حلقه می‌زد و برای هرکدام یک
   * `await complete(...)` می‌زد: روی ۳٬۰۰۰ فایل یعنی ۳٬۰۰۰ درخواست
   * پشت سر هم، بدون همزمانی، بدون کش، بدون سقف هزینه و بدون امکان
   * لغو. گزینهٔ `maxFilesPerBatch` تعریف شده بود و هرگز خوانده
   * نمی‌شد.
   *
   * چهار مهار، همه با تنزل تمیز: فایلی که بودجه یا لغو به آن نرسد،
   * متادیتای heuristic می‌گیرد — نه هیچ.
   */
  async generate(input: LlmAiMetadataInput): Promise<Map<string, AiMetadata>> {
    const result = new Map<string, AiMetadata>();
    const symbolsByFile = this.groupSymbolsByFile(input.symbols);
    const targets = input.files.filter(file => !file.binary);

    const concurrency = Math.max(1, this.options.concurrency ?? this.options.maxFilesPerBatch ?? 4);
    const maxRequests = this.options.maxRequests;
    const signal = this.options.signal;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= targets.length) return;

        const file = targets[index]!;
        const fileSymbols = symbolsByFile.get(file.id) ?? [];

        const cached = file.hash ? this.byContentHash.get(file.hash) : undefined;
        if (cached) {
          result.set(file.id, cached);
          continue;
        }

        const outOfBudget = maxRequests !== undefined && this.spentRequests >= maxRequests;
        if (outOfBudget || signal?.aborted) {
          result.set(file.id, this.fallbackMetadata(file, fileSymbols));
          continue;
        }

        this.spentRequests++;
        const metadata = await this.generateForFile(file, fileSymbols);
        if (file.hash) this.byContentHash.set(file.hash, metadata);
        result.set(file.id, metadata);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

    /*
    | فایل‌هایی که هیچ worker به آن‌ها نرسید (نمی‌شود، ولی ارزان است
    | که مطمئن باشیم قرارداد «به ازای هر فایل یک ورودی» برقرار است).
    */
    for (const file of targets) {
      if (!result.has(file.id)) {
        result.set(file.id, this.fallbackMetadata(file, symbolsByFile.get(file.id) ?? []));
      }
    }

    return result;
  }

  private groupSymbolsByFile(symbols: readonly SymbolEntry[]): Map<string, SymbolEntry[]> {
    const map = new Map<string, SymbolEntry[]>();
    for (const sym of symbols) {
      const list = map.get(sym.fileId) ?? [];
      list.push(sym);
      map.set(sym.fileId, list);
    }
    return map;
  }

  private async generateForFile(file: FileEntry, symbols: SymbolEntry[]): Promise<AiMetadata> {
    const safeContent = this.buildFileContext(file, symbols);
    const redactedContent = this.redactor.redact(safeContent);

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: this.getSystemPrompt(),
      },
      {
        role: 'user',
        content: redactedContent,
      },
    ];

    try {
      const completion = await this.options.llmClient.complete(messages, {
        temperature: 0.2,
        maxTokens: 512,
        // F-0030 — لغو باید درخواستِ در-flight را هم بکشد، نه فقط
        // درخواست‌های بعدی را. سیگنال به fetch منتقل می‌شود.
        signal: this.options.signal,
      });

      const parsed = this.parseJsonResponse(completion.content);
      const aiScore = this.computeAiScore(file, symbols);

      return {
        summary: parsed.summary ?? `File ${file.path}`,
        keywords: parsed.keywords ?? this.extractKeywords(file),
        businessDomains: parsed.businessDomains ?? [],
        designPatterns: parsed.designPatterns ?? [],
        frameworks: parsed.frameworks ?? [],
        relatedFileIds: this.findRelatedFileIds(file),
        estimatedTokenCost: this.estimateTokens(redactedContent),
        aiScore,
      };
    } catch (error) {
      defaultLogger.warn('llm metadata generation failed', { file: file.path, cause: error });
      return this.fallbackMetadata(file, symbols);
    }
  }

  private getSystemPrompt(): string {
    return `You are a code analysis assistant. Analyze the provided file and return a JSON object with exactly these fields:
{
  "summary": "a concise 1-2 sentence description of what this file does",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "businessDomains": ["Domain Name"],
  "designPatterns": ["PatternName"],
  "frameworks": ["FrameworkName"]
}
Rules:
- Return ONLY the JSON object, no markdown, no explanation.
- Use empty arrays [] if nothing applies.
- Infer frameworks from imports (e.g., react, express, nestjs).
- Infer business domains from path and symbol names (e.g., auth, payment, user).
- Infer design patterns from code structure (e.g., Repository, Controller, Middleware).`;
  }

  private buildFileContext(file: FileEntry, symbols: SymbolEntry[]): string {
    const parts: string[] = [
      `File: ${file.path}`,
      `Language: ${file.language ?? 'unknown'}`,
      `Lines: ${file.lines}`,
    ];

    const exportNames = (file.exports ?? []).map(e => e.name).filter(Boolean);
    if (exportNames.length > 0) {
      parts.push(`Exports: ${exportNames.join(', ')}`);
    }

    const importFroms = (file.imports ?? []).map(i => i.from).filter(Boolean);
    if (importFroms.length > 0) {
      parts.push(`Imports: ${importFroms.join(', ')}`);
    }

    if (symbols.length > 0) {
      parts.push('Symbols:');
      for (const sym of symbols.slice(0, 20)) {
        parts.push(`  - ${sym.kind} ${sym.name}${sym.signature ? ` (${sym.signature})` : ''}`);
      }
    }

    return parts.join('\n');
  }

  private parseJsonResponse(content: string): Partial<AiMetadata> {
    // Extract JSON from possible markdown code block
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) ?? content.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? jsonMatch[1] ?? jsonMatch[0] : content;

    try {
      return JSON.parse(jsonString) as Partial<AiMetadata>;
    } catch {
      return {};
    }
  }

  private computeAiScore(file: FileEntry, symbols: SymbolEntry[]): AiScore {
    // Use same formula as heuristic generator for consistency
    const importsCount = (file.imports ?? []).length;
    const exportsCount = (file.exports ?? []).length;
    const complexitySum = symbols.reduce((sum, s) => sum + (s.complexity ?? 0), 0);
    const symbolReferenceCount = symbols.reduce((sum, s) => sum + (s.referenceCount ?? 0), 0);

    const entryNames = ['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'server.ts', 'server.js'];
    const isEntryPoint = entryNames.some(name => file.path.toLowerCase().endsWith('/' + name) || file.path.toLowerCase() === name);

    const entryBonus = isEntryPoint ? 30 : 0;
    const exportWeight = Math.min(exportsCount * 5, 25);
    const importWeight = Math.min(importsCount * 2, 15);
    const refWeight = Math.min(symbolReferenceCount * 10, 40);
    const complexityWeight = Math.min(complexitySum * 2, 20);
    const testPenalty = file.testFile ? -20 : 0;

    const clamp = (v: number) => Math.max(0, Math.min(100, Math.floor(v)));

    return {
      importance: clamp(10 + entryBonus + exportWeight + importWeight + refWeight + complexityWeight + testPenalty),
      readPriority: clamp(entryBonus + refWeight + Math.round(exportWeight * 1.5) + complexityWeight + importWeight),
      hotness: clamp(refWeight + complexityWeight + importWeight),
      factors: {
        referenceCountWeight: refWeight,
        importCountWeight: importWeight,
        entryPointBonus: entryBonus,
      },
    };
  }

  private extractKeywords(file: FileEntry): string[] {
    const tokens = new Set<string>();
    const addTokens = (input: string) => {
      const split = input
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/);
      for (const token of split) {
        if (token.length > 1) tokens.add(token);
      }
    };

    for (const part of file.path.split(/[/\\]/)) {
      addTokens(part.replace(/\.(ts|js|tsx|jsx|py|go|java|json|md)$/i, ''));
    }
    for (const exp of file.exports ?? []) addTokens(exp.name);
    for (const imp of file.imports ?? []) addTokens(imp.from);

    return Array.from(tokens).sort();
  }

  private findRelatedFileIds(file: FileEntry): string[] {
    const related = new Set<string>();
    for (const imp of file.imports ?? []) {
      if (imp.resolvedFileId) related.add(imp.resolvedFileId);
    }
    return Array.from(related).sort();
  }

  /** SE-AI-09 — همان مرجعِ مشترک، نه یک کپیِ محلی. */
  private estimateTokens(content: string): number {
    return Math.max(1, sharedEstimateTokens(content));
  }

  private fallbackMetadata(file: FileEntry, symbols: SymbolEntry[]): AiMetadata {
    return {
      summary: `File ${file.path}`,
      keywords: this.extractKeywords(file),
      businessDomains: [],
      designPatterns: [],
      frameworks: [],
      relatedFileIds: this.findRelatedFileIds(file),
      // A fallback still describes the file; charge for that content, not
      // merely for the pathname (which made large files look nearly free).
      estimatedTokenCost: this.estimateTokens(this.redactor.redact(this.buildFileContext(file, symbols))),
      aiScore: this.computeAiScore(file, symbols),
    };
  }
}
