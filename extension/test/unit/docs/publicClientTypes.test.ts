import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript6';
import { expect, it } from 'vitest';

it('keeps every local type used in a public FMClient signature visible in API docs', () => {
  const root = resolve(__dirname, '../../..');
  const parse = (path: string) => ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const client = parse('src/services/fmClient.ts');
  const types = parse('src/services/fmClient/types.ts');
  const config = JSON.parse(readFileSync(resolve(root, 'typedoc.json'), 'utf8'));
  const publicTypes = new Set<string>();
  const collect = (node: ts.Node) => { if (ts.isTypeReferenceNode(node)) publicTypes.add(node.typeName.getText(client)); ts.forEachChild(node, collect); };
  for (const declaration of client.statements) if (ts.isClassDeclaration(declaration) && declaration.name?.text === 'FMClient') {
    for (const member of declaration.members) {
      if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        for (const param of member.parameters) if (param.type) collect(param.type);
        if (ts.isMethodDeclaration(member) && member.type) collect(member.type);
      }
    }
  }
  expect(publicTypes.has('ClientRequestControl')).toBe(true);
  for (const declaration of types.statements) if (ts.isInterfaceDeclaration(declaration) && publicTypes.has(declaration.name.text)) {
    const name = declaration.name.text;
    expect(ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'internal'), name).toBe(false);
    expect(config.intentionallyNotExported, name).not.toContain(name);
  }
});
