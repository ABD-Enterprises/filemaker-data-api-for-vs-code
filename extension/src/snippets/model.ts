import type { FindRecordsRequest } from '../types/fm';

/** The text formats a request can be copied as. */
export type SnippetFormat = 'curl' | 'fetch' | 'http' | 'postman' | 'typescript';

export const SNIPPET_FORMATS: ReadonlyArray<{
  id: SnippetFormat;
  label: string;
  /** VS Code language id of the editor that "Open in editor" uses. */
  language: string;
  /** What the clipboard text is, for the confirmation message. */
  noun: string;
}> = [
  { id: 'curl', label: 'curl', language: 'shellscript', noun: 'curl command' },
  { id: 'fetch', label: 'fetch()', language: 'javascript', noun: 'fetch() snippet' },
  { id: 'http', label: '.http file (REST Client)', language: 'http', noun: '.http request' },
  { id: 'postman', label: 'Postman collection', language: 'json', noun: 'Postman collection' },
  { id: 'typescript', label: 'TypeScript', language: 'typescript', noun: 'TypeScript snippet' }
];

export function isSnippetFormat(value: unknown): value is SnippetFormat {
  return typeof value === 'string' && SNIPPET_FORMATS.some((format) => format.id === value);
}

/** A value the reader fills in, such as the `modId` of an edit. Never data from the database. */
export class Placeholder {
  public constructor(public readonly name: 'modId') {}
}

/** Every Data API request the extension can issue. */
export type SnippetOperation =
  | { kind: 'login' }
  | { kind: 'find'; layout: string; request: FindRecordsRequest }
  | { kind: 'getRecord'; layout: string; recordId: string }
  | { kind: 'createRecord'; layout: string; fieldData: Record<string, unknown> }
  | { kind: 'editRecord'; layout: string; recordId: string; fieldData: Record<string, unknown> }
  | { kind: 'deleteRecord'; layout: string; recordId: string }
  | { kind: 'runScript'; layout: string; scriptName: string; scriptParam?: string; recordId?: string }
  | { kind: 'listLayouts' }
  | { kind: 'listScripts' }
  | { kind: 'layoutMetadata'; layout: string }
  | {
      kind: 'uploadContainer';
      layout: string;
      recordId: string;
      fieldName: string;
      fieldRepetition?: number;
      /** Add the `modId` query parameter (a placeholder) so the upload is refused if the record changed. */
      withModId?: boolean;
    };

export type SnippetOperationKind = SnippetOperation['kind'];

export const SNIPPET_OPERATION_LABELS: Record<SnippetOperationKind, string> = {
  login: 'Log in (create a session)',
  find: 'Find records',
  getRecord: 'Get one record',
  createRecord: 'Create a record',
  editRecord: 'Edit a record (with modId)',
  deleteRecord: 'Delete a record',
  runScript: 'Run a script',
  listLayouts: 'List layouts',
  listScripts: 'List scripts',
  layoutMetadata: 'Get layout metadata',
  uploadContainer: 'Upload to a container field'
};

/** What the response looks like, so the TypeScript format can type it. */
export type ResponseKind =
  | 'session'
  | 'records'
  | 'created'
  | 'modified'
  | 'empty'
  | 'script'
  | 'layouts'
  | 'scripts'
  | 'metadata'
  | 'proxy';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** The format-neutral description of one request. Every string in it is already redacted and encoded. */
export interface RequestSpec {
  /** One line, safe in a comment or a name. */
  title: string;
  method: HttpMethod;
  /** Server address without a trailing slash, no user name or password. */
  host: string;
  /** Starts with `/`, percent-encoded exactly like the client does it. */
  path: string;
  /** Already-raw pairs: formats percent-encode them (`encodeURIComponent`). */
  query: ReadonlyArray<readonly [string, string | Placeholder]>;
  /**
   * `session`: `Authorization: Bearer <session token>`; `basic`: login with a user name and password;
   * `proxy`: `Authorization: Bearer <proxy api key>`.
   */
  auth: 'session' | 'basic' | 'proxy';
  /** `json` (may contain `Placeholder` values), a multipart `upload` of one file, or none. */
  body?: { kind: 'json'; value: unknown } | { kind: 'upload' };
  response: ResponseKind;
  /** One-line remarks shown as comments (what to fill in, what was replaced). */
  notes: string[];
}

export interface SnippetOptions {
  /**
   * Show the Authorization header with a variable to fill in (`$FM_TOKEN`, `{{token}}`).
   * Off (the default), the header carries `<REDACTED>`. A live token is never written either way.
   */
  includeAuthHeader?: boolean;
}

export class SnippetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SnippetError';
  }
}
