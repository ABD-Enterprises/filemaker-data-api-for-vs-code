import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
// TypeScript 7 supplies the CLI; this alias keeps the compiler API for checking generated code.
import * as ts from 'typescript6';
import { describe, expect, it, vi } from 'vitest';

import { duplicatePhotoMetadata } from '../fixtures/duplicatePhoto';
import { buildLayoutInspectorModel } from '../../src/utils/layoutInspector';
import { TypeGenService } from '../../src/services/typeGenService';
import type { ConnectionProfile } from '../../src/types/fm';

function createProfile(): ConnectionProfile {
  return {
    id: 'profile-a',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.local',
    database: 'TestDB',
    username: 'admin'
  };
}

describe('TypeGenService', () => {
  it('generates unique compiling keys for duplicate Photo, repeating Phones and literal Phones(2) together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-duplicate-types-'));
    try {
      const fields = [
        ...duplicatePhotoMetadata.fieldMetaData,
        { name: 'Phones', type: 'normal', result: 'text', maxRepeat: 3 },
        { name: 'Phones(2)', type: 'normal', result: 'text' }
      ];
      const schema = { supported: true, fromCache: false, fields, metadata: duplicatePhotoMetadata };
      const service = new TypeGenService({ getLayoutSchema: vi.fn(async () => schema) } as never,
        {} as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { getWorkspaceRoot: () => root });
      const artifact = await service.generateTypesForLayout(createProfile(), 'Contact Details');
      const client = await service.generateTypeScriptClient(createProfile(), ['Contact Details'], join(root, 'client'));
      const expected = ['Photo', 'Phones(1)', 'Phones(2)', 'Phones(3)'];
      for (const source of [artifact.content, await readFile(client.typesPath, 'utf8')]) {
        const rawKeys = [...source.matchAll(/^ {2}"([^"\n]+)"\?:/gm)].map((match) => match[1]);
        expect(rawKeys).toEqual(expected);
        expect(source).not.toContain('photo2');
      }
      const snippets = await service.generateSnippetsForLayout(createProfile(), 'Contact Details');
      for (const entry of Object.values(JSON.parse(snippets.content.replace(/^\/\/[^\n]*\n/, ''))) as Array<{ description: string }>) {
        const keys = entry.description.split(' Fields: ')[1]!.split('; ').map((field) => field.split(':')[0]);
        expect(keys).toEqual(expected);
      }
      expect(buildLayoutInspectorModel(schema).fields.map((field) => field.name)).toEqual(expected);
      const config = join(root, 'tsconfig.json');
      await writeFile(config, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true, lib: ['es2020', 'dom'] }, files: [artifact.filePath, client.typesPath, client.clientPath] }));
      expect(() => execFileSync(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { encoding: 'utf8' })).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('generates layout type files with field maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-typegen-'));

    const schemaService = {
      getLayoutSchema: vi.fn().mockResolvedValue({
        supported: true,
        fromCache: false,
        metadata: { fieldMetaData: [{ name: 'First Name', type: 'text' }] },
        fields: [
          { name: 'First Name', type: 'text' },
          { name: 'Age', type: 'normal', result: 'number' },
          { name: ' Photo ', type: 'normal', result: 'container' },
          { name: 'Birthday', type: 'normal', result: 'date' },
          { name: 'Clock', type: 'normal', result: 'time' },
          { name: 'Stamp', type: 'normal', result: 'timeStamp' },
          { name: 'Repeats', type: 'normal', result: 'number', maxRepeat: 3 },
          ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((name) => ({ name, type: 'normal', result: 'text' }))
        ]
      })
    };

    const fmClient = {
      listLayouts: vi.fn().mockResolvedValue(['Contacts'])
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const service = new TypeGenService(schemaService as never, fmClient as never, logger as never, {
      getOutputDir: () => 'filemaker-types',
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const artifact = await service.generateTypesForLayout(createProfile(), 'Contacts');
    expect(artifact.filePath).toContain(join('filemaker-types', 'layouts', 'Contacts.ts'));
    expect(artifact.content).toContain('export interface ContactsFieldData');
    expect(artifact.content).toContain('ContactsFieldNameMap');

    const content = await readFile(artifact.filePath, 'utf8');
    expect(content).toContain('"firstName": "First Name"');
    expect(content).toContain('"Age"?: number;');
    expect(content).toContain('" Photo "?: string;');
    expect(content).toContain('"Repeats(3)"?: number;');
    expect(content).not.toContain('"Repeats"?:');
  });

  it('generates snippets file for a layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-snippets-'));

    const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Age ', type: 'normal', result: 'number' }, { name: 'Photo', type: 'normal', result: 'container' }] }) } as never, {} as never, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const snippets = await service.generateSnippetsForLayout(createProfile(), 'Contacts');
    expect(snippets.filePath).toContain(join('snippets', 'filemaker-data-api.code-snippets'));
    expect(snippets.content).toContain('Contacts Find Records');
    const entries = Object.values(JSON.parse(snippets.content.replace(/^\/\/[^\n]*\n/, ''))) as Array<{ description: string }>;
    for (const entry of entries) {
      expect(entry.description).toContain(' Age : number (kind: normal)');
      expect(entry.description).toContain('Photo: container (kind: normal)');
    }
  });

  it('generates a compiling TypeScript client with typed find results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-clientgen-'));

    const schemaService = {
      getLayoutSchema: vi.fn().mockResolvedValue({
        supported: true,
        fromCache: false,
        metadata: { fieldMetaData: [{ name: 'First Name', type: 'text' }] },
        fields: [
          { name: 'First Name', type: 'text' },
          { name: 'Age', type: 'normal', result: 'number' },
          { name: ' Photo ', type: 'normal', result: 'container' },
          { name: 'Birthday', type: 'normal', result: 'date' },
          { name: 'Clock', type: 'normal', result: 'time' },
          { name: 'Stamp', type: 'normal', result: 'timeStamp' },
          { name: 'Repeats', type: 'normal', result: 'number', maxRepeat: 3 },
          ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((name) => ({ name, type: 'normal', result: 'text' }))
        ]
      })
    };

    const service = new TypeGenService(schemaService as never, {} as never, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const artifacts = await service.generateTypeScriptClient(createProfile(), ['Contacts', ' Contacts', 'Contacts', '__proto__', 'constructor', 'toString', 'hasOwnProperty'], root);
    const types = await readFile(artifacts.typesPath, 'utf8');
    const client = await readFile(artifacts.clientPath, 'utf8');
    const readme = await readFile(artifacts.readmePath, 'utf8');

    expect(types).toContain('export interface ContactsFieldData');
    expect(types).toContain('"First Name"?: string;');
    expect(types).toContain('"Age"?: number;');
    for (const name of [' Photo ', 'Birthday', 'Clock', 'Stamp']) expect(types).toContain(`${JSON.stringify(name)}?: string;`);
    for (const n of [1, 2, 3]) expect(types).toContain(`"Repeats(${n})"?: number;`);
    expect(types).not.toContain('"Repeats"?:');
    expect(types).toContain('2^53');
    expect(types).toContain('locale');
    expect(types).toContain('URL');
    expect(client).toContain('public async findContacts');
    expect(client).toContain('public async createContacts');
    expect(readme).toContain('Regenerating this client overwrites these files');

    const usagePath = join(root, 'usage.ts');
    await writeFile(
      usagePath,
      `import { FileMakerDataApiClient } from './client';

const criteria: import('./types').ContactsFieldData = Object.create(null);
criteria["First Name"] = "Ada";

const fetchImpl: typeof fetch = async () =>
  new Response(JSON.stringify({ response: { data: [] }, messages: [] }));

const client = new FileMakerDataApiClient({
  serverUrl: 'https://fm.local',
  database: 'TestDB',
  token: 'token',
  fetch: fetchImpl
});

async function run(): Promise<string | undefined> {
  const records = await client.findContacts({ query: [criteria] });
  const amount: number | undefined = records[0]?.fieldData["Repeats(3)"];
  const photo: string | undefined = records[0]?.fieldData[" Photo "];
  const special: string | undefined = records[0]?.fieldData["__proto__"];
  void special;
  void amount; void photo;
  return records[0]?.fieldData["First Name"];
}

void run;
`,
      'utf8'
    );

    const program = ts.createProgram([artifacts.typesPath, artifacts.clientPath, usagePath], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      // TypeScript 6.0 deprecates the node10 resolver; this inline program
      // still targets it deliberately (it mirrors a consumer's classic
      // CommonJS tsconfig). Silence the deprecation so the diagnostics
      // assertion below stays focused on the generated code, not tooling.
      ignoreDeprecations: '6.0',
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
      types: [],
      skipLibCheck: true
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, 30_000);
});

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}

  it('uses the default output folder for invisible selectors and keeps visible emoji folders exact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-typegen-folder-'));
    try {
      for (const [configured, expected] of [['out/\uFE0F', 'filemaker-types'], ['out/☀️', 'out/☀️']]) {
        const schema = { getLayoutSchema: async () => ({ supported: true, fields: [], metadata: {} }) };
        const service = new TypeGenService(schema as never, {} as never,
          { debug() {}, info() {}, warn() {}, error() {} } as never,
          { getOutputDir: () => configured!, getWorkspaceRoot: () => root, isWorkspaceTrusted: () => true });
        const result = await service.generateTypesForLayout(createProfile(), 'Contacts');
        expect(result.filePath).toBe(join(root, expected!, 'layouts', 'Contacts.ts'));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
