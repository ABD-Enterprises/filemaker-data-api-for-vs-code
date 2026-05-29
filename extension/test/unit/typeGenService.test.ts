import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

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
    expect(artifact.filePath).toContain('filemaker-types/layouts/Contacts.ts');
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
    expect(snippets.filePath).toContain('snippets/filemaker-data-api.code-snippets');
    expect(snippets.content).toContain('Contacts Find Records');
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
      ignoreDeprecations: '6.0',
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
      skipLibCheck: true
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });
});

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}
