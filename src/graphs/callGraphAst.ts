/**
 * Pure TypeScript-AST helpers for the call-graph builder: property chains,
 * expression text, and whether a call is awaited or conditional.
 */

import * as ts from 'typescript';

export interface PropertyChain {
  readonly root: string;
  readonly properties: readonly string[];
  readonly rootExpression: ts.Expression;
  readonly fullName: string;
}

export function extractPropertyChain(expr: ts.PropertyAccessExpression): PropertyChain | null {
  const properties: string[] = [];
  let current: ts.Expression = expr;

  while (ts.isPropertyAccessExpression(current)) {
    properties.unshift(current.name.text);
    current = current.expression;
  }

  let root = '';
  if (ts.isIdentifier(current)) {
    root = current.text;
  } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
    root = 'this';
  }

  return {
    root,
    properties,
    rootExpression: current,
    fullName: expressionToString(expr),
  };
}

export function expressionToString(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    return `${expressionToString(expr.expression)}.${expr.name.text}`;
  }
  if (ts.isCallExpression(expr)) {
    return `${expressionToString(expr.expression)}()`;
  }
  if (ts.isNewExpression(expr)) {
    return `new ${expressionToString(expr.expression)}()`;
  }
  return '';
}

export function isAwaited(node: ts.CallExpression): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    if (current.parent.kind === ts.SyntaxKind.AwaitExpression) return true;
    if (!ts.isParenthesizedExpression(current.parent)) break;
    current = current.parent;
  }
  return false;
}

/**
 * آیا این فراخوانی شرطی است؟
 *
 * SE-GRAPH-06 — نسخهٔ قبلی تا ریشهٔ فایل بالا می‌رفت و در مرز تابع
 * نمی‌ایستاد. یعنی هر فراخوانی داخل تابعی که *خودش* داخل یک `if`
 * تعریف شده بود، «شرطی» علامت می‌خورد — حتی اگر در بدنهٔ آن تابع
 * بی‌قید و شرط اجرا شود. شرطی بودن، خاصیتِ مسیر اجرا *درون همان
 * تابع* است، نه جای تعریف تابع.
 */
export function isConditional(node: ts.CallExpression): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;

    // مرز تابع: فراتر از این، جای *تعریف* است نه مسیر اجرا
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)
    ) {
      return false;
    }

    switch (parent.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.SwitchStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
        return true;
      case ts.SyntaxKind.BinaryExpression:
        if (ts.isBinaryExpression(parent)) {
          const op = parent.operatorToken.kind;
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            return true;
          }
        }
        break;
    }
    current = parent;
  }
  return false;
}
