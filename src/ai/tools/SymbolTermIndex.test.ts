/**
 * SE-VEC-04 — هر پرس‌وجو، پیمایشِ خطیِ کلِ ایندکس بود.
 *
 * `getKeywordCandidates` روی **همهٔ** نمادها `map` می‌زد و برای هرکدام
 * قطعه‌های نام، امضا، مستند، مسیر و خلاصه را از نو می‌ساخت — بدون هیچ
 * ایندکس معکوس یا کشی. اندازه‌گیری روی ایندکس واقعی
 * `semantic-engine/src` (۸٬۴۱۴ نماد):
 *
 * ```
 * ۲۰ پرس‌وجوی کلیدواژه‌ای:  ۲٬۲۰۱ms   →  ۱۱۰ms برای هر پرس‌وجو
 * ```
 *
 * روی ۵۰٬۰۰۰ نماد این می‌شود چند صد میلی‌ثانیه CPU به‌ازای هر
 * پرس‌وجو، و `discover_context` در هر فراخوانی چند بار جست‌وجو
 * می‌کند.
 */

import { SymbolTermIndex } from './SymbolTermIndex';
import { ProjectIndex, SymbolEntry, FileEntry } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';
import { ProjectIndexReader } from '../ProjectIndexReader';

function file(id: string, path: string): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    size: 10,
    lines: 5,
    hash: 'h',
    binary: false,
    testFile: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  } as unknown as FileEntry;
}

function sym(id: string, fileId: string, name: string, extra: Partial<SymbolEntry> = {}): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    fullyQualifiedName: name,
    signature: `${name}()`,
    visibility: 'public',
    line: 1,
    endLine: 2,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
    complexity: 1,
    referenceCount: null,
    ...extra,
  } as unknown as SymbolEntry;
}

function index(symbols: SymbolEntry[], files: FileEntry[]): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 10,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

function smallIndex(): ProjectIndex {
  const files = [file('f1', 'src/auth/login.ts'), file('f2', 'src/db/pool.ts')];
  const symbols = [
    sym('s1', 'f1', 'authenticateUser'),
    sym('s2', 'f1', 'validateToken', { documentation: 'checks the session token' }),
    sym('s3', 'f2', 'connectDatabase'),
    sym('s4', 'f2', 'closePool'),
  ];
  return index(symbols, files);
}

describe('SymbolTermIndex — همان جواب، بدون پیمایش کامل', () => {
  it('نمادهای منطبق با یک اصطلاح را می‌دهد', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    // «auth» یک قطعهٔ واقعیِ مسیر است و `matchesSegments` حالتِ
    // `term.startsWith(segment)` را هم می‌پذیرد، پس s2 هم درست است.
    const ids = termIndex.candidatesFor(['authenticate']);
    expect([...ids].sort()).toEqual(['s1', 's2']);
  });

  it('قطعه‌های نام را می‌شناسد', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    expect([...termIndex.candidatesFor(['user'])]).toContain('s1');
    expect([...termIndex.candidatesFor(['database'])]).toContain('s3');
  });

  it('مسیر فایل و مستندات را هم پوشش می‌دهد', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    expect([...termIndex.candidatesFor(['auth'])]).toContain('s2');
    expect([...termIndex.candidatesFor(['session'])]).toContain('s2');
  });

  it('اجتماع چند اصطلاح را می‌دهد، نه اشتراک', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    const ids = termIndex.candidatesFor(['authenticate', 'database']);
    expect([...ids].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('پیشوند هم می‌خورد', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    expect([...termIndex.candidatesFor(['authent'])]).toContain('s1');
  });

  it('اصطلاحِ ناموجود، مجموعهٔ خالی می‌دهد', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    expect([...termIndex.candidatesFor(['zzzz'])]).toEqual([]);
  });

  it('فهرست خالی اصطلاح، مجموعهٔ خالی می‌دهد', () => {
    const reader = new ProjectIndexReader(smallIndex());
    const termIndex = new SymbolTermIndex(reader);

    expect([...termIndex.candidatesFor([])]).toEqual([]);
  });

  it('غیرلاتین را هم ایندکس می‌کند — SE-VEC-05', () => {
    const files = [file('f1', 'src/a.ts')];
    const symbols = [sym('s1', 'f1', 'buildVector', { documentation: 'بردار می‌سازد' })];
    const reader = new ProjectIndexReader(index(symbols, files));
    const termIndex = new SymbolTermIndex(reader);

    expect([...termIndex.candidatesFor(['بردار'])]).toContain('s1');
  });
});

describe('SymbolTermIndex — همان نتیجهٔ پیمایش کامل', () => {
  /*
  | مهم‌ترین تضمین: ایندکس معکوس یک *بهینه‌سازی* است، نه یک
  | الگوریتم دوم. هر نامزدی که پیمایشِ کامل پیدا می‌کرد، باید اینجا
  | هم پیدا شود — وگرنه سرعت را با درستی عوض کرده‌ایم.
  */
  function bigIndex(): ProjectIndex {
    const files = Array.from({ length: 40 }, (_, i) => file(`f${i}`, `src/mod${i}/thing${i}.ts`));
    const symbols = Array.from({ length: 400 }, (_, i) =>
      sym(`s${i}`, `f${i % 40}`, `handle${i % 7 === 0 ? 'Payment' : 'Request'}${i}`, {
        documentation: i % 5 === 0 ? 'processes the invoice ledger' : null,
      })
    );
    return index(symbols, files);
  }

  function bruteForce(reader: ProjectIndexReader, terms: string[]): Set<string> {
    const { identifierSegments, matchesSegments } = require('./queryTerms');
    const out = new Set<string>();
    for (const s of reader.getAllSymbols()) {
      const f = reader.getFileById(s.fileId);
      const segments = [
        ...identifierSegments(s.name),
        ...(s.fullyQualifiedName ? identifierSegments(s.fullyQualifiedName) : []),
        ...(s.signature ? identifierSegments(s.signature) : []),
        ...(s.documentation ? identifierSegments(s.documentation) : []),
        ...(f?.path ? identifierSegments(f.path) : []),
        ...(f?.aiMetadata?.summary ? identifierSegments(f.aiMetadata.summary) : []),
      ];
      if (terms.some(t => matchesSegments(t, segments))) out.add(s.id);
    }
    return out;
  }

  it('برای هر پرس‌وجو، دقیقاً همان مجموعهٔ پیمایش کامل', () => {
    const reader = new ProjectIndexReader(bigIndex());
    const termIndex = new SymbolTermIndex(reader);

    for (const terms of [
      ['payment'],
      ['request'],
      ['handle'],
      ['invoice', 'ledger'],
      ['mod3'],
      ['thing7'],
      ['payment', 'zzzz'],
    ]) {
      const fast = [...termIndex.candidatesFor(terms)].sort();
      const slow = [...bruteForce(reader, terms)].sort();
      expect({ terms, fast }).toEqual({ terms, fast: slow });
    }
  });

  it('ایندکس یک‌بار ساخته می‌شود و بین پرس‌وجوها می‌ماند', () => {
    const reader = new ProjectIndexReader(bigIndex());
    const termIndex = new SymbolTermIndex(reader);

    expect(termIndex.built).toBe(false);
    termIndex.candidatesFor(['payment']);
    expect(termIndex.built).toBe(true);
    const size = termIndex.termCount;
    termIndex.candidatesFor(['request']);
    expect(termIndex.termCount).toBe(size);
  });
});
