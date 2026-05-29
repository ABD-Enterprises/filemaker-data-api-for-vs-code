import { mkdir, readFile, writeFile } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';

import type { FMClient } from './fmClient';
import type { Logger } from './logger';
import type { SchemaService } from './schemaService';
import type {
  ConnectionProfile,
  FileMakerFieldMetadata,
  GeneratedLayoutArtifacts,
  GeneratedSnippetsArtifacts,
  GeneratedTypeScriptClientArtifacts
} from '../types/fm';
import { hashObject } from '../utils/hash';
import { createNameMap, toPascalCaseIdentifier } from '../utils/nameSanitize';

interface TypeGenServiceOptions {
  getOutputDir?: () => string;
  getWorkspaceRoot?: () => string | undefined;
  isWorkspaceTrusted?: () => boolean;
}

export class TypeGenService {
  private readonly getOutputDir: () => string;
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly isWorkspaceTrusted: () => boolean;

  public constructor(
    private readonly schemaService: SchemaService,
    private readonly fmClient: FMClient,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    options?: TypeGenServiceOptions
  ) {
    this.getOutputDir = options?.getOutputDir ?? (() => 'filemaker-types');
    this.getWorkspaceRoot = options?.getWorkspaceRoot ?? (() => undefined);
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => true);
  }

  public async generateTypesForLayout(
    profile: ConnectionProfile,
    layout: string
  ): Promise<GeneratedLayoutArtifacts> {
    const schema = await this.schemaService.getLayoutSchema(profile, layout);
    if (!schema.supported) {
      throw new Error(schema.message ?? 'Schema metadata is not available for this layout.');
    }

    const metadataHash = hashObject(schema.metadata ?? schema.fields);
    const content = this.renderTypeFile(profile, layout, schema.fields, metadataHash);
    const filePath = await this.writeTypeFile(layout, content);

    return {
      layout,
      filePath,
      content,
      metadataHash
    };
  }

  public async generateTypesForAllLayouts(profile: ConnectionProfile): Promise<GeneratedLayoutArtifacts[]> {
    const layouts = await this.fmClient.listLayouts(profile);
    const artifacts: GeneratedLayoutArtifacts[] = [];

    for (const layout of layouts) {
      try {
        artifacts.push(await this.generateTypesForLayout(profile, layout));
      } catch (error) {
        this.logger.warn('Skipping type generation for layout due to metadata error.', {
          profileId: profile.id,
          layout,
          error
        });
      }
    }

    return artifacts;
  }

  public async generateSnippetsForLayout(
    profile: ConnectionProfile,
    layout: string
  ): Promise<GeneratedSnippetsArtifacts> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. Snippet generation to files is disabled.');
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      throw new Error('Open a workspace folder to generate snippets.');
    }

    const snippetsDir = resolveSafeWorkspacePath(root, 'snippets');
    const filePath = resolveSafeWorkspacePath(root, 'snippets', 'filemaker-data-api.code-snippets');
    await mkdir(snippetsDir, { recursive: true });

    const snippets = await this.readExistingSnippets(filePath);
    const keyPrefix = sanitizeSnippetKey(layout);

    snippets[`${keyPrefix} Find Records`] = {
      prefix: `fm find ${layout}`,
      description: `Find ${layout} records via extension client`,
      body: [
        "const result = await vscode.commands.executeCommand('filemakerDataApiTools.runFindJson', {",
        `  profileId: '\${1:${profile.id}}',`,
        `  layout: '\${2:${layout}}'`,
        '});',
        'console.log(result);'
      ]
    };

    snippets[`${keyPrefix} Get Record`] = {
      prefix: `fm get ${layout}`,
      description: `Get ${layout} record by ID via extension client`,
      body: [
        "await vscode.commands.executeCommand('filemakerDataApiTools.getRecordById', {",
        `  profileId: '\${1:${profile.id}}',`,
        `  layout: '\${2:${layout}}'`,
        '});'
      ]
    };

    const content = `${JSON.stringify(snippets, null, 2)}\n`;
    await writeFile(filePath, content, 'utf8');

    return {
      filePath,
      content
    };
  }

  public async generateTypeScriptClient(
    profile: ConnectionProfile,
    layouts: string[],
    outputDirectory: string
  ): Promise<GeneratedTypeScriptClientArtifacts> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. TypeScript client generation to files is disabled.');
    }

    const selectedLayouts = normalizeLayouts(layouts);
    if (selectedLayouts.length === 0) {
      throw new Error('Choose at least one layout to generate a TypeScript client.');
    }

    const outputDir = resolve(outputDirectory);
    await mkdir(outputDir, { recursive: true });

    const schemas: GeneratedClientSchema[] = [];
    for (const layout of selectedLayouts) {
      const schema = await this.schemaService.getLayoutSchema(profile, layout);
      if (!schema.supported) {
        throw new Error(
          schema.message ?? `Schema metadata is not available for layout "${layout}".`
        );
      }
      schemas.push({ layout, fields: schema.fields });
    }

    const generatedAt = new Date().toISOString();
    const layoutNames = createNameMap(selectedLayouts);
    const typesContent = renderClientTypes(profile, schemas, layoutNames, generatedAt);
    const clientContent = renderClientSource(profile, schemas, layoutNames, generatedAt);
    const readmeContent = renderClientReadme(profile, selectedLayouts, generatedAt);

    const typesPath = resolve(outputDir, 'types.ts');
    const clientPath = resolve(outputDir, 'client.ts');
    const readmePath = resolve(outputDir, 'README.md');

    await Promise.all([
      writeFile(typesPath, typesContent, 'utf8'),
      writeFile(clientPath, clientContent, 'utf8'),
      writeFile(readmePath, readmeContent, 'utf8')
    ]);

    return {
      directory: outputDir,
      typesPath,
      clientPath,
      readmePath,
      layouts: selectedLayouts
    };
  }

  private async writeTypeFile(layout: string, content: string): Promise<string> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. Type generation to files is disabled.');
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      throw new Error('Open a workspace folder to generate files.');
    }

    const outputDir = sanitizeRelativeOutputDir(this.getOutputDir());
    const fileName = `${sanitizeLayoutFileName(layout)}.ts`;
    const outputLayoutsDir = resolveSafeWorkspacePath(root, outputDir, 'layouts');
    const filePath = resolveSafeWorkspacePath(root, outputDir, 'layouts', fileName);

    await mkdir(outputLayoutsDir, { recursive: true });
    await writeFile(filePath, content, 'utf8');

    return filePath;
  }

  private renderTypeFile(
    profile: ConnectionProfile,
    layout: string,
    fields: FileMakerFieldMetadata[],
    metadataHash: string
  ): string {
    const timestamp = new Date().toISOString();
    const nameMap = createNameMap(fields.map((field) => field.name));
    const baseName = toPascalCaseIdentifier(layout);
    const fieldDataTypeName = `${baseName}FieldData`;
    const rawFieldTypeName = `${baseName}RawFieldData`;
    const recordTypeName = `${baseName}Record`;
    const findRequestTypeName = `${baseName}FindRequest`;
    const findResponseTypeName = `${baseName}FindResponse`;

    const rawTypeRows = fields
      .map((field) => `  ${JSON.stringify(field.name)}?: ${toTsType(field)};`)
      .join('\n');

    const friendlyRows = nameMap.mappings
      .map(
        (mapping) =>
          `  ${mapping.friendlyName}?: ${toTsType(findField(fields, mapping.rawName))}; // ${mapping.rawName}`
      )
      .join('\n');

    const mapRows = nameMap.mappings
      .map((mapping) => `  ${JSON.stringify(mapping.friendlyName)}: ${JSON.stringify(mapping.rawName)},`)
      .join('\n');

    return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: ${timestamp}
 * Profile: ${profile.name} (${profile.id})
 * Layout: ${layout}
 * Metadata hash (sha256): ${metadataHash}
 */

export interface ${rawFieldTypeName} {
${rawTypeRows}
}

export interface ${fieldDataTypeName} {
${friendlyRows}
}

export const ${baseName}FieldNameMap = {
${mapRows}
} as const;

export interface ${recordTypeName} {
  recordId: string;
  modId?: string;
  fieldData: ${rawFieldTypeName};
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ${findRequestTypeName} {
  query: Array<Partial<${rawFieldTypeName}>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ${findResponseTypeName} {
  data: ${recordTypeName}[];
  dataInfo?: Record<string, unknown>;
}
`;
  }

  private async readExistingSnippets(path: string): Promise<Record<string, unknown>> {
    try {
      const content = await readFile(path, 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

interface GeneratedClientSchema {
  layout: string;
  fields: FileMakerFieldMetadata[];
}

function toTsType(field: FileMakerFieldMetadata | undefined): string {
  if (!field) {
    return 'unknown';
  }

  const type = `${field.type ?? field.result ?? ''}`.toLowerCase();

  if (type.includes('number') || type.includes('integer') || type.includes('float') || type.includes('decimal')) {
    return 'number';
  }

  if (type.includes('boolean')) {
    return 'boolean';
  }

  if (type.includes('timestamp') || type.includes('date') || type.includes('time')) {
    return 'string';
  }

  if (type.includes('container')) {
    return 'string | { src?: string }';
  }

  if (type.length > 0) {
    return 'string';
  }

  return 'unknown';
}

function normalizeLayouts(layouts: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const layout of layouts) {
    const value = layout.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function renderClientTypes(
  profile: ConnectionProfile,
  schemas: GeneratedClientSchema[],
  layoutNames: ReturnType<typeof createNameMap>,
  generatedAt: string
): string {
  const layoutBlocks = schemas.map((schema) => {
    const suffix = typeSuffixForLayout(layoutNames, schema.layout);
    const rows = schema.fields
      .map((field) => `  ${JSON.stringify(field.name)}?: ${toTsType(field)};`)
      .join('\n');

    return `export interface ${suffix}FieldData {
${rows}
}

export type ${suffix}Record = FileMakerRecord<${suffix}FieldData>;

export interface ${suffix}FindRequest {
  query: Array<Partial<${suffix}FieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}`;
  });

  const recordMapRows = schemas
    .map((schema) => `  ${JSON.stringify(schema.layout)}: ${typeSuffixForLayout(layoutNames, schema.layout)}Record;`)
    .join('\n');
  const fieldDataMapRows = schemas
    .map((schema) => `  ${JSON.stringify(schema.layout)}: ${typeSuffixForLayout(layoutNames, schema.layout)}FieldData;`)
    .join('\n');
  const findRequestMapRows = schemas
    .map((schema) => `  ${JSON.stringify(schema.layout)}: ${typeSuffixForLayout(layoutNames, schema.layout)}FindRequest;`)
    .join('\n');

  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: ${generatedAt}
 * Profile: ${profile.name} (${profile.id})
 * Layouts: ${schemas.map((schema) => schema.layout).join(', ')}
 */

export interface FileMakerMessage {
  code: string;
  message: string;
}

export interface FileMakerRecord<TFieldData> {
  recordId: string;
  modId?: string;
  fieldData: TFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

${layoutBlocks.join('\n\n')}

export interface LayoutRecordMap {
${recordMapRows}
}

export interface LayoutFieldDataMap {
${fieldDataMapRows}
}

export interface LayoutFindRequestMap {
${findRequestMapRows}
}

export type LayoutName = keyof LayoutRecordMap;
`;
}

function renderClientSource(
  profile: ConnectionProfile,
  schemas: GeneratedClientSchema[],
  layoutNames: ReturnType<typeof createNameMap>,
  generatedAt: string
): string {
  const imports = schemas
    .flatMap((schema) => {
      const suffix = typeSuffixForLayout(layoutNames, schema.layout);
      return [`${suffix}FieldData`, `${suffix}FindRequest`, `${suffix}Record`];
    })
    .sort();

  const methods = schemas
    .map((schema) => renderLayoutClientMethods(schema.layout, typeSuffixForLayout(layoutNames, schema.layout)))
    .join('\n\n');

  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: ${generatedAt}
 * Profile: ${profile.name} (${profile.id})
 */

import type {
  FileMakerMessage,
  ${imports.join(',\n  ')}
} from './types';

export interface FileMakerClientConfig {
  serverUrl: string;
  database: string;
  token: string;
  apiBasePath?: string;
  apiVersionPath?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

interface DataApiEnvelope<TResponse> {
  response: TResponse;
  messages: FileMakerMessage[];
}

interface FindResponse<TRecord> {
  data: TRecord[];
  dataInfo?: Record<string, unknown>;
}

interface MutateResponse {
  recordId?: string;
  modId?: string;
}

export class FileMakerDataApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  public constructor(private readonly config: FileMakerClientConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('No fetch implementation is available.');
    }

    const serverUrl = trimSlashes(config.serverUrl);
    const apiBasePath = trimSlashes(config.apiBasePath ?? 'fmi/data');
    const apiVersionPath = trimSlashes(config.apiVersionPath ?? 'vLatest');
    this.baseUrl = \`\${serverUrl}/\${apiBasePath}/\${apiVersionPath}/databases/\${encodeURIComponent(config.database)}\`;
  }

${indent(methods, 2)}

  private async request<TResponse>(
    path: string,
    init: RequestInit
  ): Promise<DataApiEnvelope<TResponse>> {
    const response = await this.fetchImpl(\`\${this.baseUrl}\${path}\`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: \`Bearer \${this.config.token}\`,
        ...this.config.headers,
        ...init.headers
      }
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) as DataApiEnvelope<TResponse> : undefined;

    if (!response.ok) {
      const message = body?.messages?.map((item) => item.message).join('; ') || response.statusText;
      throw new Error(\`FileMaker Data API request failed (\${response.status}): \${message}\`);
    }

    if (!body) {
      throw new Error('FileMaker Data API returned an empty response.');
    }

    return body;
  }
}

function trimSlashes(value: string): string {
  return value.replace(/^\\/+|\\/+$/g, '');
}
`;
}

function renderLayoutClientMethods(layout: string, suffix: string): string {
  const encodedLayout = `\${encodeURIComponent(${JSON.stringify(layout)})}`;

  return `public async find${suffix}(request: ${suffix}FindRequest): Promise<${suffix}Record[]> {
  const envelope = await this.request<FindResponse<${suffix}Record>>(
    \`/layouts/${encodedLayout}/_find\`,
    {
      method: 'POST',
      body: JSON.stringify(request)
    }
  );
  return envelope.response.data;
}

public async get${suffix}(recordId: string): Promise<${suffix}Record> {
  const envelope = await this.request<FindResponse<${suffix}Record>>(
    \`/layouts/${encodedLayout}/records/\${encodeURIComponent(recordId)}\`,
    { method: 'GET' }
  );
  const record = envelope.response.data[0];
  if (!record) {
    throw new Error(\`Record not found: \${recordId}\`);
  }
  return record;
}

public async create${suffix}(fieldData: Partial<${suffix}FieldData>): Promise<MutateResponse> {
  const envelope = await this.request<MutateResponse>(
    \`/layouts/${encodedLayout}/records\`,
    {
      method: 'POST',
      body: JSON.stringify({ fieldData })
    }
  );
  return envelope.response;
}

public async edit${suffix}(
  recordId: string,
  fieldData: Partial<${suffix}FieldData>
): Promise<MutateResponse> {
  const envelope = await this.request<MutateResponse>(
    \`/layouts/${encodedLayout}/records/\${encodeURIComponent(recordId)}\`,
    {
      method: 'PATCH',
      body: JSON.stringify({ fieldData })
    }
  );
  return envelope.response;
}

public async delete${suffix}(recordId: string): Promise<void> {
  await this.request<Record<string, never>>(
    \`/layouts/${encodedLayout}/records/\${encodeURIComponent(recordId)}\`,
    { method: 'DELETE' }
  );
}`;
}

function renderClientReadme(
  profile: ConnectionProfile,
  layouts: string[],
  generatedAt: string
): string {
  const firstLayout = layouts[0] ?? 'Layout';
  const firstMethod = typeSuffixForLayout(createNameMap(layouts), firstLayout);

  return `# FileMaker TypeScript Client

Generated at ${generatedAt} for profile \`${profile.name}\`.

## Files

- \`types.ts\` contains interfaces for the selected layout fields and records.
- \`client.ts\` contains typed fetch wrappers for find, get, create, edit, and delete operations.

## Usage

\`\`\`ts
import { FileMakerDataApiClient } from './client';

const client = new FileMakerDataApiClient({
  serverUrl: 'https://example.filemaker-cloud.com',
  database: '${escapeReadmeString(profile.database)}',
  token: process.env.FM_DATA_API_TOKEN ?? ''
});

const records = await client.find${firstMethod}({
  query: [{}],
  limit: 10
});
\`\`\`

Selected layouts:

${layouts.map((layout) => `- ${layout}`).join('\n')}

Regenerating this client overwrites these files with a new timestamp.
`;
}

function typeSuffixForLayout(layoutNames: ReturnType<typeof createNameMap>, layout: string): string {
  const friendly = layoutNames.rawToFriendly[layout] ?? sanitizeLayoutFileName(layout);
  return toPascalCaseIdentifier(friendly);
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

function escapeReadmeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function findField(
  fields: FileMakerFieldMetadata[],
  fieldName: string
): FileMakerFieldMetadata | undefined {
  return fields.find((field) => field.name === fieldName);
}

function sanitizeLayoutFileName(layout: string): string {
  const normalized = layout
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized.length > 0 ? normalized : 'layout';
}

function sanitizeSnippetKey(layout: string): string {
  return layout.replace(/[^\w\s-]+/g, '').trim() || 'Layout';
}

function sanitizeRelativeOutputDir(value: string): string {
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..') || isAbsolute(normalized)) {
    return 'filemaker-types';
  }

  return normalized;
}

function resolveSafeWorkspacePath(root: string, ...segments: string[]): string {
  const resolved = resolve(root, ...segments);
  const relativePath = relative(root, resolved);
  const parts = relativePath.split(/[\\/]/).filter((part) => part.length > 0);
  if (relativePath.startsWith('..') || parts.includes('..')) {
    throw new Error('Refusing to write outside workspace root.');
  }

  return resolved;
}
