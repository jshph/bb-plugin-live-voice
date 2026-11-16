import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The browser bundle (src/app), the server bundle (src/server) and contracts used by both (src/shared)
// are separate deployment targets. These checks keep server-only code out of the browser bundle.
const root = dirname(fileURLToPath(import.meta.url));
const areas = ['app', 'shared', 'server'] as const;
type Area = typeof areas[number];
type Import = { specifier: string; typeOnly: boolean };

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
function imports(file: string): Import[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Import[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every(element => element.isTypeOnly)));
      found.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function area(file: string): Area | null {
  const top = relative(root, file).split(/[\\/]/)[0];
  return (areas as readonly string[]).includes(top!) ? top as Area : null;
}
function local(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  return [base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')].find(candidate => existsSync(candidate)) ?? base;
}

const files = sources(root).filter(file => file !== fileURLToPath(import.meta.url));

it('places every source file in app, shared or server', () => {
  expect(files.filter(file => !area(file)).map(file => relative(root, file))).toEqual([]);
});

it('keeps app, shared and server imports in their allowed directions, including type-only imports', () => {
  const forbidden: Record<Area, Area[]> = { app: ['server'], shared: ['app', 'server'], server: ['app'] };
  const violations = files.flatMap(file => imports(file).flatMap(({ specifier }) => {
    const target = local(file, specifier);
    const from = area(file)!;
    if (target && area(target) && forbidden[from].includes(area(target)!)) return [`${relative(root, file)} -> ${specifier}`];
    if (from !== 'server' && /^node:/.test(specifier) && !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) return [`${relative(root, file)} -> ${specifier}`];
    return [];
  }));
  expect(violations).toEqual([]);
});

it('keeps server-only packages out of the browser bundle, allowing type-only use of shared contracts', () => {
  // A value import of shared/contract would bundle the server SDK entry into the browser.
  const serverOnly = (specifier: string) => specifier === '@get-bb/plugin-sdk' || specifier === 'better-sqlite3' || /^node:/.test(specifier);
  const seen = new Set<string>(), violations: string[] = [];
  const walk = (file: string, path: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { specifier, typeOnly } of imports(file)) {
      if (typeOnly) continue;
      if (serverOnly(specifier)) violations.push([...path, relative(root, file), specifier].join(' -> '));
      const target = local(file, specifier);
      if (target && /\.tsx?$/.test(target)) walk(target, [...path, relative(root, file)]);
    }
  };
  walk(join(root, 'app', 'index.tsx'), []);
  expect(seen.size).toBeGreaterThan(5);
  expect(violations).toEqual([]);
});
