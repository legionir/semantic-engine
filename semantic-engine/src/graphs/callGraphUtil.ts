/**
 * Pure helpers of the call-graph builder (split from CallGraphBuilder.ts, behavior unchanged).
 */

import * as ts from 'typescript';
import { CallEdge, SymbolEntry } from '../core/types/project-index.types';
import { isAwaited, isConditional } from './callGraphAst';
import { EdgeBasis } from './EdgeProvenance';

export function callableKindPriority(kind: SymbolEntry['kind']): number {
  if (kind === 'function' || kind === 'method') return 2;
  if (kind === 'class' || kind === 'interface') return 1;
  return 0;
}

/** ضعیف‌ترین مبنا برنده است — یک زنجیره از حدس هم حدس است. */
export function weaker(left: EdgeBasis, right: EdgeBasis): EdgeBasis {
  return left === 'name-match' || right === 'name-match' ? 'name-match' : left;
}

/**
 * نوعِ فیلدی که با `new X()` مقدار گرفته — SE-GRAPH-14.
 *
 * فقط initializerِ مستقیمِ `new Identifier()` داخل همان کلاس خوانده می‌شود
 * (نه factory، نه وراثت، نه تزریقِ constructor) و اگر شکلِ دیگری باشد
 * `undefined` برمی‌گردد تا فراخوان مثل прежде رفتار کند.
 */
export function findFieldNewInstanceClass(
  sourceFile: ts.SourceFile,
  className: string,
  fieldName: string
): string | undefined {
  let found: string | undefined;

  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (
          !ts.isPropertyDeclaration(member) ||
          !ts.isIdentifier(member.name) ||
          member.name.text !== fieldName
        ) {
          continue;
        }
        const initializer = member.initializer;
        if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
          found = initializer.expression.text;
        }
        return;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

export function inferEdgeKind(
  node: ts.CallExpression,
  calleeSymbolId: string | undefined,
  isRecursive: boolean
): CallEdge['kind'] {
  if (isRecursive) return 'recursive';
  if (calleeSymbolId === undefined) return 'external';
  if (isAwaited(node)) return 'async';
  if (isConditional(node)) return 'conditional';
  return 'direct';
}

export function isTsJs(language: string | null): boolean {
  return language === 'typescript' || language === 'javascript' ||
    language === 'typescriptreact' || language === 'javascriptreact';
}

export function getScriptKind(language: string | null, filePath: string): ts.ScriptKind {
  if (language === 'typescript' || filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  if (language === 'typescriptreact' || filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (language === 'javascriptreact' || filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

export function fileExists(filePath: string): boolean {
  try {
    const stat = require('fs').statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function readFile(filePath: string): string {
  return require('fs').readFileSync(filePath, 'utf8');
}
