/**
 * محاسبهٔ Cyclomatic Complexity برای توابع/متدهای TypeScript/JavaScript.
 *
 * فرمول: تعداد نقاط تصمیم‌گیری (decision points) + 1.
 * نقاط تصمیم:
 * - if / else if
 * - for / for-in / for-of / while / do-while
 * - switch case / default
 * - catch
 * - ternary (?:)
 * - && / ||
 *
 * توابع nested داخل یک تابع در محاسبهٔ complexity تابع والد لحاظ نمی‌شوند.
 */

import * as ts from 'typescript';

export function calculateComplexity(sourceFile: ts.SourceFile, functionNode: ts.Node): number {
  let decisions = 0;

  const visit = (node: ts.Node) => {
    // از توابع nested عبور نمی‌کنیم چون complexity خودشان محاسبه می‌شود
    if (isFunctionLike(node) && node !== functionNode) {
      return;
    }

    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        decisions++;
        break;
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.DefaultClause:
        // هر case یک branch جداست
        decisions++;
        break;
      case ts.SyntaxKind.BinaryExpression:
        if (ts.isBinaryExpression(node)) {
          const op = node.operatorToken.kind;
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            decisions++;
          }
        }
        break;
    }

    ts.forEachChild(node, visit);
  };

  visit(functionNode);

  // حداقل complexity هر تابع 1 است
  return Math.max(1, decisions + 1);
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}
