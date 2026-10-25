/**
 * استخراج imports/exports از فایل‌های TypeScript/JavaScript با TypeScript compiler API.
 *
 * این extractor برای TS/JS از LSP دقیق‌تر است چون:
 * - import/export ها را مستقیماً از AST می‌خواند
 * - dynamic import ها را شناسایی می‌کند
 * - re-export ها را تشخیص می‌دهد
 *
 * محدودیت: فقط syntax analysis؛ resolve دقیق path نیاز به TSPathResolver دارد.
 */

import * as ts from 'typescript';
import {
  IDependencyExtractor,
  DependencyExtractionResult,
} from '../IDependencyExtractor';
import { ImportEntry, ExportEntry, ImportSpecifier } from '../../core/types/project-index.types';
import { ExtractionSource, Result, ok, err } from '../../core/types/common.types';

const BUILTIN_MODULES = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'zlib',
  // SE-DEP-06 — این‌ها جا افتاده بودند و package طبقه‌بندی می‌شدند
  'worker_threads', 'perf_hooks', 'async_hooks', 'diagnostics_channel',
  'inspector', 'http2', 'trace_events', 'wasi', 'test',
]);

/**
 * حذف entryهای یکسان.
 *
 * حالا که هر نام entry خودش را دارد، یک فایل که هم
 * `export function a() {}` دارد و هم `export { a }`، دو رکورد یکسان
 * تولید می‌کند. دو بار شمردن یک صادرات، هر متریک «سطح API» را باد
 * می‌کند.
 */
function dedupeExports(entries: readonly ExportEntry[]): ExportEntry[] {
  const seen = new Set<string>();
  const unique: ExportEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.name}\u0000${entry.kind}\u0000${entry.reExportFrom ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

export class TSDependencyExtractor implements IDependencyExtractor {
  /*
  | SE-DEP-08 — این استخراج‌گر با TypeScript compiler API کار می‌کند.
  | قبلاً خودش را `'tree-sitter'` معرفی می‌کرد «تا فاز ۲ آماده بشه»،
  | یعنی `source` در خروجی چیزی می‌گفت که درست نبود.
  */
  readonly name: ExtractionSource = 'typescript-api';
  readonly priority = 50;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId === 'typescript' || languageId === 'javascript' || languageId === 'typescriptreact' || languageId === 'javascriptreact';
  }

  async extractDependencies(
    _fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<DependencyExtractionResult>> {
    try {
      const scriptKind = this.getScriptKind(languageId, filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      );

      const imports: ImportEntry[] = [];
      const exports: ExportEntry[] = [];

      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const entry = this.parseImportDeclaration(node);
          if (entry) imports.push(entry);
        } else if (ts.isExportDeclaration(node)) {
          exports.push(...this.parseExportDeclaration(node));
        } else if (ts.isExportAssignment(node)) {
          exports.push(this.parseExportAssignment(node));
        } else if (this.hasExportModifier(node)) {
          exports.push(...this.parseExportedDeclaration(node));
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const entry = this.parseDynamicImport(node);
          if (entry) imports.push(entry);
        } else if (this.isRequireCall(node)) {
          /*
          | SE-DEP-01 — بدون این، هیچ پروژهٔ CommonJS گراف وابستگی
          | ندارد. بخش بزرگی از اکوسیستم Node — از جمله `agent/` و
          | `bin/` همین مخزن — CJS خالص است.
          */
          const entry = this.parseRequireCall(node as ts.CallExpression);
          if (entry) imports.push(entry);
        } else if (ts.isExpressionStatement(node)) {
          exports.push(...this.parseCommonJsExport(node));
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);

      return ok({
        imports,
        exports: dedupeExports(exports),
        partial: false,
      } as DependencyExtractionResult);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private getScriptKind(languageId: string, filePath: string): ts.ScriptKind {
    if (languageId === 'typescript' || filePath.endsWith('.ts')) return ts.ScriptKind.TS;
    if (languageId === 'typescriptreact' || filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (languageId === 'javascriptreact' || filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
  }

  private parseImportDeclaration(node: ts.ImportDeclaration): ImportEntry | null {
    const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral)?.text;
    if (!moduleSpecifier) return null;

    const specifiers: ImportSpecifier[] = [];
    if (node.importClause) {
      if (node.importClause.name) {
        // default import: import x from '...'
        specifiers.push({
          imported: 'default',
          local: node.importClause.name.text,
          isDefault: true,
        });
      }
      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const elem of node.importClause.namedBindings.elements) {
            // elem.name همیشه نام local binding است
            // elem.propertyName (در صورت وجود) نام اصلی import شده است
            specifiers.push({
              imported: elem.propertyName ? elem.propertyName.text : elem.name.text,
              local: elem.name.text,
            });
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          specifiers.push({
            imported: '*',
            local: node.importClause.namedBindings.name.text,
            isNamespace: true,
          });
        }
      }
    }

    /*
    | SE-DEP-07 — دو شکل type-only وجود دارد: روی خودِ import
    | (`import type { A }`) و روی تک‌تک specifierها
    | (`import { type A, type B }`). دومی فقط وقتی کل import را تایپی
    | می‌کند که *همه* اعضایش تایپی باشند.
    */
    const declarationIsTypeOnly = node.importClause?.isTypeOnly === true;
    const named = node.importClause?.namedBindings;
    const allSpecifiersAreTypes =
      named !== undefined &&
      ts.isNamedImports(named) &&
      named.elements.length > 0 &&
      named.elements.every(element => element.isTypeOnly === true);

    return {
      from: moduleSpecifier,
      type: this.classifyImportPath(moduleSpecifier),
      resolvedFileId: null,
      specifiers: specifiers.length > 0 ? specifiers : undefined,
      dynamic: false,
      typeOnly: declarationIsTypeOnly || allSpecifiersAreTypes,
    };
  }

  /** `require('x')` با آرگومان رشته‌ای ثابت. */
  private isRequireCall(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    );
  }

  private parseRequireCall(node: ts.CallExpression): ImportEntry | null {
    const argument = node.arguments[0];
    if (!argument || !ts.isStringLiteralLike(argument)) return null;

    /*
    | شکل تخریبی: `const { join, resolve } = require('path')`.
    | الگوی binding یک سطح بالاتر از فراخوانی است.
    */
    const specifiers: ImportSpecifier[] = [];
    const declaration = node.parent;
    if (declaration && ts.isVariableDeclaration(declaration)) {
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          specifiers.push({ imported, local: element.name.text });
        }
      } else if (ts.isIdentifier(declaration.name)) {
        specifiers.push({ imported: 'default', local: declaration.name.text, isDefault: true });
      }
    }

    return {
      from: argument.text,
      type: this.classifyImportPath(argument.text),
      resolvedFileId: null,
      specifiers: specifiers.length > 0 ? specifiers : undefined,
      dynamic: false,
    };
  }

  /** `module.exports = …` و `exports.name = …`. */
  private parseCommonJsExport(node: ts.ExpressionStatement): ExportEntry[] {
    const expression = node.expression;
    if (!ts.isBinaryExpression(expression)) return [];
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return [];

    const left = expression.left;
    if (!ts.isPropertyAccessExpression(left)) return [];

    const object = left.expression;
    const property = left.name.text;

    // module.exports = …
    if (ts.isIdentifier(object) && object.text === 'module' && property === 'exports') {
      /*
      | SE-DEP-12 — `module.exports = { HookRunner, dirtyPathsFromStatus }` قبلاً
      | یک entry به نام `module.exports` می‌داد، نه به‌ازای هر نام. نتیجه اینکه
      | هیچ‌چیز سمبلِ `HookRunner` را به import‌کننده‌هایش وصل نمی‌کرد و
      | `simulate_mutation` یک rename را «safe» گزارش می‌کرد درحالی‌که فایل
      | با requireِ نام‌دار مصرف می‌شد. حالا هر کلیدِ object-literal یک
      | exportِ نام‌دار می‌گیرد (هم‌راستا با ESM)؛ شکل غیر-آبجکت همان namespace می‌ماند.
      */
      const named = this.commonJsExportNames(expression.right);
      return named.length > 0 ? named : [{ name: 'module.exports', kind: 'namespace' }];
    }

    // exports.name = …
    if (ts.isIdentifier(object) && object.text === 'exports') {
      return [{ name: property, kind: 'named' }];
    }

    // module.exports.name = …
    if (ts.isPropertyAccessExpression(object) &&
        ts.isIdentifier(object.expression) &&
        object.expression.text === 'module' &&
        object.name.text === 'exports') {
      return [{ name: property, kind: 'named' }];
    }

    return [];
  }

  /**
   * SE-DEP-12 — نام‌های صادرشده از مقدارِ سمت راستِ `module.exports = …`.
   *
   * فقط object-literal به تک‌تک نام‌ها باز می‌شود؛ spread (نام‌های ناشناخته)
   * نادیده می‌رود تا export جعلی نسازیم. هر چیز دیگر [] برمی‌گرداند تا
   * فراخوان همان namespace واحد را نگه دارد.
   */
  private commonJsExportNames(value: ts.Expression): ExportEntry[] {
    if (ts.isObjectLiteralExpression(value)) {
      const out: ExportEntry[] = [];
      for (const prop of value.properties) {
        if (ts.isSpreadAssignment(prop)) continue;
        const nameNode = prop.name;
        if (!nameNode) continue;
        const name = ts.isStringLiteral(nameNode)
          ? nameNode.text
          : nameNode.getText().replace(/^['"]|['"]$/g, '');
        if (name) out.push({ name, kind: 'named' });
      }
      return out;
    }

    return [];
  }

  /**
   * SE-DATA-02 — یک `ExportEntry` به‌ازای هر نام.
   *
   * قبلاً نام‌ها با `', '` به هم چسبانده می‌شدند و در یک رشته ذخیره
   * می‌شدند. نتیجه اینکه هر مصرف‌کننده باید خودش split می‌کرد و چهار
   * جا واقعاً می‌کردند — هر کدام کمی متفاوت — و هیچ‌کدام نمی‌توانستند
   * `symbolId` مستقل بدهند، چون یک entry بیشتر وجود نداشت.
   */
  private parseExportDeclaration(node: ts.ExportDeclaration): ExportEntry[] {
    const typeOnly = node.isTypeOnly === true;

    if (!node.moduleSpecifier) {
      // named exports: export { a, b }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        return node.exportClause.elements.map(element => ({
          name: element.name.text,
          kind: 'named' as const,
          typeOnly: typeOnly || element.isTypeOnly === true,
        }));
      }
      return [{ name: '*', kind: 'named', typeOnly }];
    }

    // re-export: export { ... } from '...' or export * from '...'
    const from = (node.moduleSpecifier as ts.StringLiteral).text;
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.map(element => ({
        name: element.name.text,
        kind: 're-export' as const,
        reExportFrom: from,
        typeOnly: typeOnly || element.isTypeOnly === true,
      }));
    }

    return [{ name: '*', kind: 'namespace', reExportFrom: from, typeOnly }];
  }

  private parseExportAssignment(node: ts.ExportAssignment): ExportEntry {
    return {
      name: node.isExportEquals ? 'module.exports' : 'default',
      kind: node.isExportEquals ? 'namespace' : 'default',
    };
  }

  /**
   * One `ExportEntry` per exported name. `export const a = 1, b = 2;` used to
   * be collapsed into a single entry named `"a, b"` (not a valid identifier,
   * so nothing could ever match it); every declarator now gets its own entry,
   * including names bound by destructuring (`export const { x, y: z } = o`).
   */
  private parseExportedDeclaration(node: ts.Node): ExportEntry[] {
    const isDefault = this.hasDefaultModifier(node);
    const kind = isDefault ? 'default' : 'named';

    if (ts.isVariableStatement(node)) {
      const names: string[] = [];
      for (const declaration of node.declarationList.declarations) {
        this.collectBindingNames(declaration.name, names);
      }
      return names.map(name => ({ name, kind }));
    }

    const name = this.getDeclarationName(node);

    /*
    | SE-DEP-09 — `export default function () {}` نام ندارد و قبلاً
    | همین‌جا به `null` می‌رسید و صادرات کاملاً گم می‌شد. ماژولی که
    | تنها صادراتش همین است، در ایندکس هیچ API نداشت. نامش همان چیزی
    | است که واردکننده با آن صدایش می‌زند.
    */
    if (!name) {
      return isDefault ? [{ name: 'default', kind: 'default' }] : [];
    }

    return [{ name, kind }];
  }

  private collectBindingNames(binding: ts.BindingName, into: string[]): void {
    if (ts.isIdentifier(binding)) {
      into.push(binding.text);
      return;
    }
    for (const element of binding.elements) {
      if (ts.isBindingElement(element)) this.collectBindingNames(element.name, into);
    }
  }

  private parseDynamicImport(node: ts.CallExpression): ImportEntry | null {
    const arg = node.arguments[0];
    if (!arg || !ts.isStringLiteral(arg)) return null;

    return {
      from: arg.text,
      type: this.classifyImportPath(arg.text),
      resolvedFileId: null,
      dynamic: true,
    };
  }

  private hasExportModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (!modifiers) return false;
    return modifiers.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  private hasDefaultModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (!modifiers) return false;
    return modifiers.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.DefaultKeyword);
  }

  private getDeclarationName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (ts.isClassDeclaration(node) && node.name) return node.name.text;
    if (ts.isInterfaceDeclaration(node) && node.name) return node.name.text;
    if (ts.isEnumDeclaration(node) && node.name) return node.name.text;
    if (ts.isTypeAliasDeclaration(node) && node.name) return node.name.text;
    return null;
  }

  private classifyImportPath(modulePath: string): 'package' | 'local' | 'builtin' {
    if (modulePath.startsWith('.') || modulePath.startsWith('/')) {
      return 'local';
    }

    /*
    | SE-DEP-06 — `node:fs` همان `fs` است. بدون این، هر پروژه‌ای که
    | از شکل صریح استفاده می‌کند (که توصیهٔ خود Node است) وابستگی‌های
    | داخلی‌اش را «پکیج خارجی» می‌بیند.
    */
    const withoutPrefix = modulePath.startsWith('node:')
      ? modulePath.slice('node:'.length)
      : modulePath;

    if (BUILTIN_MODULES.has(withoutPrefix.split('/')[0]!)) {
      return 'builtin';
    }
    return 'package';
  }

  dispose(): void {
    // TypeScript compiler stateless است
  }
}
