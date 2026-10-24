import type { SnippetOperation } from '../../../src/snippets/model';
import type { ConnectionProfile } from '../../../src/types/fm';

/** Strings that must never appear in anything that is copied. */
export const SENTINELS = {
  password: 'SENTINEL_PASSWORD_91c2d0',
  token: 'SENTINEL_TOKEN_5f3a8e',
  apiKey: 'SENTINEL_APIKEY_77ab12',
  user: 'SENTINEL_USER_0e1d44',
  query: 'SENTINEL_QUERY_42c9f1',
  fragment: 'SENTINEL_FRAGMENT_a7e3'
};

export const leakyDirect: ConnectionProfile = {
  id: 'p-leaky',
  name: 'Leaky',
  authMode: 'direct',
  username: SENTINELS.user,
  // A server address typed with an account, a token in the query and a fragment: none of it belongs in a request.
  serverUrl: `https://${SENTINELS.user}:${SENTINELS.password}@fm.example.com:8443/prefix/?token=${SENTINELS.query}#${SENTINELS.fragment}`,
  database: 'Sales'
};

export const leakyProxy: ConnectionProfile = {
  id: 'p-proxy',
  name: 'Leaky proxy',
  authMode: 'proxy',
  serverUrl: `https://${SENTINELS.user}:${SENTINELS.password}@fm.example.com/`,
  proxyEndpoint: `https://${SENTINELS.user}:${SENTINELS.apiKey}@proxy.example.com/rpc?api_key=${SENTINELS.apiKey}#${SENTINELS.fragment}`,
  database: 'Sales'
};

/** Text the helpers recognise as a credential, in every place text from the database can go. */
export const leakyOperations: SnippetOperation[] = [
  { kind: 'login' },
  { kind: 'listLayouts' },
  { kind: 'listScripts' },
  {
    kind: 'find',
    layout: 'Contacts',
    request: {
      query: [{ Note: `Authorization: Bearer ${SENTINELS.token}`, Login: `password=${SENTINELS.password}`, sessionToken: SENTINELS.token }],
      sort: [{ fieldName: 'apiKey', sortOrder: 'ascend' }]
    }
  },
  { kind: 'getRecord', layout: 'Contacts', recordId: '1' },
  { kind: 'createRecord', layout: 'Contacts', fieldData: { password: SENTINELS.password, apiKey: SENTINELS.apiKey, Note: `Bearer ${SENTINELS.token}` } },
  { kind: 'editRecord', layout: 'Contacts', recordId: '1', fieldData: { token: SENTINELS.token, Note: `Basic ${SENTINELS.password}` } },
  { kind: 'deleteRecord', layout: 'Contacts', recordId: '1' },
  { kind: 'runScript', layout: 'Contacts', scriptName: 'Sync', scriptParam: `user=bob&password=${SENTINELS.password}&token=${SENTINELS.token}` },
  { kind: 'runScript', layout: 'Contacts', scriptName: 'Sync', scriptParam: `Bearer ${SENTINELS.token}`, recordId: '1' },
  { kind: 'layoutMetadata', layout: 'Contacts' },
  { kind: 'uploadContainer', layout: 'Contacts', recordId: '1', fieldName: 'Photo', withModId: true }
];
