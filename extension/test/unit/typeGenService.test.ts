import { runInNewContext } from 'vm';
import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
// TypeScript 7 supplies the CLI; this alias keeps the compiler API for checking generated code.
import * as ts from 'typescript6';
import { describe, expect, it, vi } from 'vitest';

import { duplicatePhotoMetadata } from '../fixtures/duplicatePhoto';
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
  it('generates compiling layout types for duplicate Photo container metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-duplicate-types-'));
    try {
      const service = new TypeGenService({ getLayoutSchema: vi.fn(async () => ({ supported: true, fields: duplicatePhotoMetadata.fieldMetaData, metadata: duplicatePhotoMetadata })) } as never,
        {} as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { getWorkspaceRoot: () => root });
      const artifact = await service.generateTypesForLayout(createProfile(), 'Contact Details');
      const program = ts.createProgram([artifact.filePath], { noEmit: true, strict: true, types: [], skipLibCheck: true });
      expect(ts.getPreEmitDiagnostics(program).map(formatDiagnostic)).toEqual([]);
      expect(artifact.content.match(/"Photo"\?:/g)).toHaveLength(1);
      expect(artifact.content).not.toContain('photo2');
      const client = await service.generateTypeScriptClient(createProfile(), ['Contact Details'], join(root, 'client'));
      const config = join(root, 'tsconfig.json');
      await writeFile(config, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true, lib: ['es2020', 'dom'] }, files: [artifact.filePath, client.typesPath] }));
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
          { name: 'Age', type: 'number' }
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
  });

  it('generates snippets file for a layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-snippets-'));

    const service = new TypeGenService({} as never, {} as never, {
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
  });

  it('generated finds refuse empty criteria before fetch and the example supplies a field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-generated-find-'));
    try {
      const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }], metadata: {} }) } as never,
        {} as never, { debug() {}, info() {}, warn() {}, error() {} }, { getWorkspaceRoot: () => root });
      const artifacts = await service.generateTypeScriptClient(createProfile(), ['Contacts'], root);
      const source = await readFile(artifacts.clientPath, 'utf8');
      const exports: { FileMakerDataApiClient?: new (config: unknown) => { findContacts(request: unknown): Promise<unknown> } } = {};
      runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
      const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify({ response: { data: [] }, messages: [] })));
      const client = new exports.FileMakerDataApiClient!({ serverUrl: 'https://fm.local', database: 'Sales', token: 't', fetch });
      for (const query of [[], [{}], [{ omit: 'true' }], [{ ' Name ': '' }]]) {
        await expect(client.findContacts({ query })).rejects.toThrow('Enter at least one field value to search');
      }
      expect(fetch).not.toHaveBeenCalled();
      await client.findContacts({ query: [{ ' Name ': '*' }] });
      expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ query: [{ ' Name ': '*' }] });
      expect(await readFile(artifacts.readmePath, 'utf8')).not.toContain('query: [{}]');
    } finally { await rm(root, { recursive: true, force: true }); }
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
          { name: 'Age', type: 'number' }
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

    const artifacts = await service.generateTypeScriptClient(createProfile(), ['Contacts'], root);
    const types = await readFile(artifacts.typesPath, 'utf8');
    const client = await readFile(artifacts.clientPath, 'utf8');
    const readme = await readFile(artifacts.readmePath, 'utf8');

    expect(types).toContain('export interface ContactsFieldData');
    expect(types).toContain('"First Name"?: string;');
    expect(types).toContain('"Age"?: number;');
    expect(client).toContain('public async findContacts');
    expect(client).toContain('public async createContacts');
    expect(readme).toContain('Regenerating this client overwrites these files');

    const usagePath = join(root, 'usage.ts');
    await writeFile(
      usagePath,
      `import { FileMakerDataApiClient } from './client';

const fetchImpl: typeof fetch = async () =>
  new Response(JSON.stringify({ response: { data: [] }, messages: [] }));

const client = new FileMakerDataApiClient({
  serverUrl: 'https://fm.local',
  database: 'TestDB',
  token: 'token',
  fetch: fetchImpl
});

async function run(): Promise<string | undefined> {
  const records = await client.findContacts({ query: [{ "First Name": "Ada" }] });
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
