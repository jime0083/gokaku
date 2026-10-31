/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

it('開発ルートの実ファイル一覧と動的検証対象が一致する', () => {
  const root = resolve(__dirname, '../..');
  const testPath = resolve(root, 'src/app/__tests__/release-routes.test.tsx');
  const source = ts.createSourceFile(
    testPath,
    readFileSync(testPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'DEV_ROUTES')
      .map((declaration) => ({ statement, declaration })));

  if (declarations.length !== 1) {
    throw new Error('DEV_ROUTES must have exactly one top-level declaration');
  }
  const { statement, declaration } = declarations[0];
  const initializer = declaration.initializer;
  if (!(statement.declarationList.flags & ts.NodeFlags.Const) ||
      !initializer || !ts.isAsExpression(initializer) ||
      !ts.isTypeReferenceNode(initializer.type) ||
      !ts.isIdentifier(initializer.type.typeName) ||
      initializer.type.typeName.text !== 'const' ||
      Boolean(initializer.type.typeArguments?.length) ||
      !ts.isArrayLiteralExpression(initializer.expression)) {
    throw new Error('DEV_ROUTES must be a const array literal with an as const assertion');
  }
  const expected = initializer.expression.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error('DEV_ROUTES must contain only string literals');
    }
    return element.text;
  });
  const actual = readdirSync(resolve(root, 'src/app'))
    .filter((name) => /^dev-.*\.[cm]?[jt]sx?$/.test(name))
    .map((name) => name.replace(/\.[cm]?[jt]sx?$/, ''))
    .sort();
  expect(actual).toEqual([...expected].sort());
});
