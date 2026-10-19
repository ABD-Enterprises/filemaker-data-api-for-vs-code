import type { ConnectionProfile } from '../../../src/types/fm';
import type { SnippetFormat, SnippetOperation } from '../../../src/snippets/model';

export const FORMATS: SnippetFormat[] = ['curl', 'fetch', 'http', 'postman', 'typescript'];

export const EXTENSION: Record<SnippetFormat, string> = {
  curl: 'sh',
  fetch: 'js',
  http: 'http',
  postman: 'json',
  typescript: 'ts.txt'
};

export const directProfile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  serverUrl: 'https://fm.example.com',
  database: 'Sales DB',
  authMode: 'direct',
  username: 'api_user'
};

export const proxyProfile: ConnectionProfile = {
  id: 'profile-proxy',
  name: 'Via proxy',
  serverUrl: 'https://fm.example.com',
  database: 'Sales DB',
  authMode: 'proxy',
  proxyEndpoint: 'https://proxy.example.com/filemaker'
};

/** One entry per operation, and the variants that change the request. */
export const OPERATIONS: Record<string, SnippetOperation> = {
  login: { kind: 'login' },
  find: {
    kind: 'find',
    layout: 'Contacts',
    request: { query: [{ City: 'Portland', Status: '==Active' }, { City: 'Seattle', omit: 'true' }], sort: [{ fieldName: 'Name', sortOrder: 'ascend' }], limit: 25, offset: 26 }
  },
  getRecord: { kind: 'getRecord', layout: 'Contacts', recordId: '42' },
  createRecord: { kind: 'createRecord', layout: 'Contacts', fieldData: { Name: 'Ada Lovelace', Email: 'ada@example.com' } },
  editRecord: { kind: 'editRecord', layout: 'Contacts', recordId: '42', fieldData: { Status: 'Inactive' } },
  deleteRecord: { kind: 'deleteRecord', layout: 'Contacts', recordId: '42' },
  runScript: { kind: 'runScript', layout: 'Contacts', scriptName: 'Send Welcome', scriptParam: '{"id": 42, "note": "a b&c"}' },
  runScriptNoParam: { kind: 'runScript', layout: 'Contacts', scriptName: 'Refresh' },
  runScriptWithRecord: { kind: 'runScript', layout: 'Contacts', scriptName: 'Send Welcome', scriptParam: 'hi', recordId: '42' },
  runScriptLongParam: { kind: 'runScript', layout: 'Contacts', scriptName: 'Import', scriptParam: 'x'.repeat(2100) },
  listLayouts: { kind: 'listLayouts' },
  listScripts: { kind: 'listScripts' },
  layoutMetadata: { kind: 'layoutMetadata', layout: 'Contacts' },
  uploadContainer: { kind: 'uploadContainer', layout: 'Contacts', recordId: '42', fieldName: 'Photo' },
  uploadContainerModId: { kind: 'uploadContainer', layout: 'Contacts', recordId: '42', fieldName: 'Photo', fieldRepetition: 2, withModId: true }
};

/**
 * Names and values chosen to break whatever they are written into. `pwn` is a file that the shell
 * commands in the strings would create if one ever ran.
 */
export function hostileStrings(pwn: string): Record<string, string> {
  return {
    singleQuotes: `O'Brien's '; touch ${pwn}; echo '`,
    doubleQuotes: `"; touch ${pwn}; echo "`,
    substitution: `$(touch ${pwn}) \`touch ${pwn}\` \${HOME} $HOME !history ;touch ${pwn}`,
    newlines: 'line1\nline2\r\nline3\rline4',
    unicodeSeparators: 'a\u2028b\u2029c\u0085d\u000be\u000cf',
    scriptClose: '</script><script>alert(1)</script><!-- x -->',
    slashPercent: 'Reports/2026 100% done ../../etc?x=1#frag',
    crlfHeader: 'x\r\nX-Injected: yes\r\n\r\nGET /evil HTTP/1.1',
    separator: 'x\n###\nGET https://evil.example/',
    templates: '{{$processEnv HOME}} {{$dotenv X}} {{baseUrl}} {{host}} {{modId}} {{{x}}}',
    quotesBackslash: 'say "hi" \\ back\\slash \\" end \\\\',
    emoji: 'caf\u00e9 \u{1F600} \u4e2d\u6587',
    nul: 'a\u0000b',
    dollarEnd: 'price: $',
    heredoc: 'EOF\n<<EOF\nEOF'
  };
}

/** Every place a name or value from the database ends up in a request, with the hostile text in it. */
export function hostileOperations(value: string): Record<string, SnippetOperation> {
  return {
    find: { kind: 'find', layout: value, request: { query: [{ [value]: value, Other: `==${value}` }], sort: [{ fieldName: value }] } },
    getRecord: { kind: 'getRecord', layout: value, recordId: value },
    createRecord: { kind: 'createRecord', layout: value, fieldData: { [value]: value } },
    editRecord: { kind: 'editRecord', layout: value, recordId: value, fieldData: { [value]: value } },
    deleteRecord: { kind: 'deleteRecord', layout: value, recordId: value },
    runScript: { kind: 'runScript', layout: value, scriptName: value, scriptParam: value },
    runScriptWithRecord: { kind: 'runScript', layout: value, scriptName: value, scriptParam: value, recordId: value },
    layoutMetadata: { kind: 'layoutMetadata', layout: value },
    uploadContainer: { kind: 'uploadContainer', layout: value, recordId: value, fieldName: value, withModId: true }
  };
}
