import { isProxyProfile, type ConnectionProfile } from '../types/fm';
import { buildProxyProfilePayload } from '../services/proxyClient';
import { redactString, redactValue } from '../utils/redact';
import { dotSegmentMessage, isDotSegment } from '../utils/urlSegment';
import { cleanServerAddress } from './address';
import { encodeComponent, encodeQuery, singleLine } from './escape';
import {
  Placeholder,
  SnippetError,
  type RequestSpec,
  type ResponseKind,
  type SnippetOperation
} from './model';

/** The Claris guide advises keeping a Data API URL under about 2000 characters. */
export const MAX_SCRIPT_URL_LENGTH = 2000;

const MAX_TITLE_LENGTH = 120;

/** Tracks whether redaction changed anything, so the snippet can say so. */
class Redactor {
  public changed = false;

  public text(value: string): string {
    const next = redactString(value);
    if (next !== value) {
      this.changed = true;
    }
    return next;
  }

  public value<T>(value: T): T {
    const before = JSON.stringify(value);
    const next = redactValue(value) as T;
    if (JSON.stringify(next) !== before) {
      this.changed = true;
    }
    return next;
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) {
    return `/${trimmed.replace(/\/+$/, '')}`;
  }
  return trimmed.replace(/\/+$/, '');
}

/** One visible line for a title: control characters escaped, and no `{{` for a tool to expand (the first brace of a pair is written `\x7b`). */
function clip(value: string): string {
  const line = singleLine(value).replace(/\{(?=\{)/g, '\\x7b');
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line;
}

/** The value exactly as given (a leading or trailing space is part of a name), or an error when it is blank. */
function required(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === '') {
    throw new SnippetError(`${what} is required.`);
  }
  return value;
}

/** A layout, script or field called `.` or `..` would be resolved away by a web address: refuse, as the client does. */
function segment(value: string | undefined, what: string, kind: string): string {
  const name = required(value, what);
  if (isDotSegment(name)) {
    throw new SnippetError(dotSegmentMessage(kind, name));
  }
  return name;
}

/** Builds the request the extension would send for `operation`, with every secret replaced by a placeholder. */
export function buildRequestSpec(profile: ConnectionProfile, operation: SnippetOperation): RequestSpec {
  const redactor = new Redactor();
  const spec = isProxyProfile(profile)
    ? buildProxySpec(profile, operation, redactor)
    : buildDirectSpec(profile, operation, redactor);
  if (redactor.changed) {
    spec.notes.push(
      'Some text looked like a credential and was replaced with *** (names, find criteria and values are checked).'
    );
  }
  return spec;
}

function titleFor(operation: SnippetOperation, redactor: Redactor): string {
  const layout = 'layout' in operation ? clip(redactor.text(operation.layout)) : '';
  switch (operation.kind) {
    case 'login':
      return 'Log in (create a session)';
    case 'find':
      return `Find records in layout "${layout}"`;
    case 'getRecord':
      return `Get record ${clip(redactor.text(operation.recordId))} from layout "${layout}"`;
    case 'createRecord':
      return `Create a record in layout "${layout}"`;
    case 'editRecord':
      return `Edit record ${clip(redactor.text(operation.recordId))} in layout "${layout}"`;
    case 'deleteRecord':
      return `Delete record ${clip(redactor.text(operation.recordId))} from layout "${layout}"`;
    case 'runScript':
      return `Run script "${clip(redactor.text(operation.scriptName))}" (layout "${layout}")`;
    case 'listLayouts':
      return 'List layouts';
    case 'listScripts':
      return 'List scripts';
    case 'layoutMetadata':
      return `Get metadata of layout "${layout}"`;
    case 'uploadContainer':
      return `Upload to container field "${clip(redactor.text(operation.fieldName))}" of record ${clip(redactor.text(operation.recordId))} (layout "${layout}")`;
  }
}

function buildDirectSpec(profile: ConnectionProfile, operation: SnippetOperation, redactor: Redactor): RequestSpec {
  const host = cleanServerAddress(profile.serverUrl, 'server address');
  const version = (profile.apiVersionPath ?? 'vLatest').replace(/^\/+|\/+$/g, '');
  const base = `${normalizePath(profile.apiBasePath ?? '/fmi/data')}/${version}/databases/${encodeComponent(redactor.text(profile.database))}`;
  const title = titleFor(operation, redactor);
  const notes: string[] = [];
  const layoutPath = (layout: string): string => `${base}/layouts/${encodeComponent(redactor.text(segment(layout, 'Layout', 'layout')))}`;
  const recordPath = (layout: string, recordId: string): string =>
    `${layoutPath(layout)}/records/${encodeComponent(redactor.text(required(recordId, 'Record ID')))}`;

  const make = (
    method: RequestSpec['method'],
    path: string,
    response: ResponseKind,
    extra: Partial<Pick<RequestSpec, 'query' | 'body' | 'auth'>> = {}
  ): RequestSpec => ({
    title,
    method,
    host,
    path,
    query: extra.query ?? [],
    auth: extra.auth ?? 'session',
    body: extra.body,
    response,
    notes
  });

  switch (operation.kind) {
    case 'login':
      notes.push('Fill in the account name and password yourself (never copied). The response holds the session token.');
      return make('POST', `${base}/sessions`, 'session', { auth: 'basic', body: { kind: 'json', value: {} } });
    case 'find': {
      const payload: Record<string, unknown> = { query: operation.request.query };
      if (operation.request.sort && operation.request.sort.length > 0) {
        payload.sort = operation.request.sort;
      }
      if (typeof operation.request.limit === 'number') {
        payload.limit = operation.request.limit;
      }
      if (typeof operation.request.offset === 'number') {
        payload.offset = operation.request.offset;
      }
      return make('POST', `${layoutPath(operation.layout)}/_find`, 'records', {
        body: { kind: 'json', value: redactor.value(payload) }
      });
    }
    case 'getRecord':
      return make('GET', recordPath(operation.layout, operation.recordId), 'records');
    case 'createRecord':
      return make('POST', `${layoutPath(operation.layout)}/records`, 'created', {
        body: { kind: 'json', value: { fieldData: redactor.value(operation.fieldData) } }
      });
    case 'editRecord':
      notes.push('Replace the modId with the one from the record you read: FileMaker refuses the edit (error 306) if the record changed since.');
      return make('PATCH', recordPath(operation.layout, operation.recordId), 'modified', {
        body: {
          kind: 'json',
          value: { fieldData: redactor.value(operation.fieldData), modId: new Placeholder('modId') }
        }
      });
    case 'deleteRecord':
      notes.push('This deletes the record when sent.');
      return make('DELETE', recordPath(operation.layout, operation.recordId), 'modified');
    case 'runScript': {
      const scriptName = redactor.text(segment(operation.scriptName, 'Script name', 'script'));
      const scriptParam =
        operation.scriptParam !== undefined && operation.scriptParam.length > 0
          ? redactor.text(operation.scriptParam)
          : undefined;
      const layout = layoutPath(operation.layout);

      if (operation.recordId) {
        // A record in context cannot be given to the script endpoint: the script rides on a GET of that record.
        const query: Array<[string, string]> = [['script', scriptName]];
        if (scriptParam !== undefined) {
          query.push(['script.param', scriptParam]);
        }
        const path = recordPath(operation.layout, operation.recordId);
        if (`${host}${path}?${encodeQuery(query)}`.length > MAX_SCRIPT_URL_LENGTH) {
          throw tooLong();
        }
        return make('GET', path, 'script', { query });
      }

      const scriptPath = `${layout}/script/${encodeComponent(scriptName)}`;
      const query: Array<[string, string]> = scriptParam === undefined ? [] : [['script.param', scriptParam]];
      const url = `${host}${scriptPath}${query.length > 0 ? `?${encodeQuery(query)}` : ''}`;
      if (url.length > MAX_SCRIPT_URL_LENGTH) {
        // Too long for a web address: the documented body form, a find limited to one record.
        notes.push('The parameter is too long for a web address, so the script is attached to a find limited to one record (this reads that record).');
        return make('POST', `${layout}/_find`, 'records', {
          body: {
            kind: 'json',
            value: {
              query: [{}],
              limit: 1,
              script: scriptName,
              ...(scriptParam !== undefined ? { 'script.param': scriptParam } : {})
            }
          }
        });
      }
      return make('GET', scriptPath, 'script', { query });
    }
    case 'listLayouts':
      return make('GET', `${base}/layouts`, 'layouts');
    case 'listScripts':
      return make('GET', `${base}/scripts`, 'scripts');
    case 'layoutMetadata':
      return make('GET', layoutPath(operation.layout), 'metadata');
    case 'uploadContainer': {
      const repetition = repetitionOf(operation.fieldRepetition);
      notes.push('Replace ./file-to-upload with the path of the file to send.');
      if (operation.withModId) {
        notes.push('Replace the modId with the one from the record you read.');
      }
      const path = `${recordPath(operation.layout, operation.recordId)}/containers/${encodeComponent(redactor.text(segment(operation.fieldName, 'Container field name', 'field')))}/${repetition}`;
      return make('POST', path, 'modified', {
        body: { kind: 'upload' },
        query: operation.withModId ? [['modId', new Placeholder('modId')]] : []
      });
    }
  }
}

function tooLong(): SnippetError {
  return new SnippetError(
    `The script parameter is too long to send in a web address (the limit is about ${MAX_SCRIPT_URL_LENGTH} characters including the server and script name) when a record is in context. Shorten it, for example by passing an id.`
  );
}

function repetitionOf(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1 || value > 32767) {
    throw new SnippetError('Container field repetition must be a positive whole number.');
  }
  return value;
}

function buildProxySpec(profile: ConnectionProfile, operation: SnippetOperation, redactor: Redactor): RequestSpec {
  const endpoint = new URL(cleanServerAddress(required(profile.proxyEndpoint, 'The proxy endpoint'), 'proxy endpoint'));
  const proxyProfile = buildProxyProfilePayload(profile);
  const notes: string[] = [
    'Proxy profile: one POST to the proxy, which adds the FileMaker credentials itself.'
  ];
  const layout = (): string => redactor.text(segment('layout' in operation ? operation.layout : undefined, 'Layout', 'layout'));
  const recordId = (): string =>
    redactor.text(required('recordId' in operation ? operation.recordId : undefined, 'Record ID'));

  let action: string;
  let payload: Record<string, unknown>;
  let response: ResponseKind = 'proxy';

  switch (operation.kind) {
    case 'login':
      action = 'createSession';
      payload = {};
      break;
    case 'find':
      action = 'findRecords';
      payload = { layout: layout(), body: redactor.value(operation.request) };
      break;
    case 'getRecord':
      action = 'getRecord';
      payload = { layout: layout(), recordId: recordId() };
      break;
    case 'createRecord':
      action = 'createRecord';
      payload = { layout: layout(), fieldData: redactor.value(operation.fieldData) };
      break;
    case 'editRecord':
      action = 'editRecord';
      payload = {
        layout: layout(),
        recordId: recordId(),
        fieldData: redactor.value(operation.fieldData),
        modId: new Placeholder('modId')
      };
      notes.push('Replace the modId with the one from the record you read.');
      break;
    case 'deleteRecord':
      action = 'deleteRecord';
      payload = { layout: layout(), recordId: recordId() };
      notes.push('This deletes the record when sent.');
      break;
    case 'runScript':
      action = 'runScript';
      payload = {
        layout: layout(),
        scriptName: redactor.text(segment(operation.scriptName, 'Script name', 'script')),
        ...(operation.scriptParam ? { scriptParam: redactor.text(operation.scriptParam) } : {}),
        ...(operation.recordId ? { recordId: recordId() } : {})
      };
      break;
    case 'listLayouts':
      action = 'listLayouts';
      payload = {};
      break;
    case 'listScripts':
      action = 'listScripts';
      payload = {};
      break;
    case 'layoutMetadata':
      action = 'getLayoutMetadata';
      payload = { layout: layout() };
      break;
    case 'uploadContainer':
      action = 'uploadContainer';
      payload = {
        layout: layout(),
        recordId: recordId(),
        fieldName: redactor.text(segment(operation.fieldName, 'Container field name', 'field')),
        fieldRepetition: repetitionOf(operation.fieldRepetition),
        ...(operation.withModId ? { modId: new Placeholder('modId') } : {}),
        fileName: '<file name>',
        contentType: 'application/octet-stream',
        contentBase64: '<base64 of the file>'
      };
      notes.push('Fill in the file name and the base64 text of the file.');
      break;
  }

  return {
    title: titleFor(operation, redactor),
    method: 'POST',
    host: `${endpoint.protocol}//${endpoint.host}`,
    path: endpoint.pathname === '' ? '/' : endpoint.pathname,
    query: [],
    auth: 'proxy',
    body: {
      kind: 'json',
      value: {
        action,
        profile: {
          ...proxyProfile,
          id: redactor.text(proxyProfile.id),
          database: redactor.text(proxyProfile.database),
          serverUrl: cleanServerAddress(proxyProfile.serverUrl, 'server address')
        },
        payload
      }
    },
    response,
    notes
  };
}
