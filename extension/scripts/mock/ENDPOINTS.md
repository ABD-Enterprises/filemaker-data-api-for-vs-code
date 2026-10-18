# Mock FileMaker Data API: endpoint inventory

The mock lives in `extension/test/mock-server/` (`npm run mock:server`, `npm run mock:check`).
This file lists the Claris FileMaker Data API surface as documented, and what the mock does with each part.

## Running it

```bash
cd extension
npm run mock:server        # http://127.0.0.1:18080 (PORT=0 picks a free port); prints a MOCK_READY JSON line
npm run mock:check         # starts it on a free port, runs the real FMClient and every endpoint and error code over HTTP
```

Demo accounts (test values, nothing else is accepted): `tester` / `testpass1` and `admin` / `adminpass1` (full access),
`viewer` / `viewpass1` (reads; writes refused with 200 / 205 / 9; field `Email` hidden), `limited` / `limitpass1` (sees only layout `Contacts`
in `Sales`), `reader` / `readpass1` (read-only: 403 / 9), `nobody` / `nopass1` (no layouts), `retired` / `retired1` (inactive, 212).
Databases: `Sales` (Contacts 157, Invoices 12), `Quality` (about 1,400 mixed-quality records), `Inventory`, `Locked` (802).
`GET /fmi/data/vLatest/productInfo` needs no auth; `GET /fmi/data/vLatest/databases` needs none unless `FILTER_DATABASES=1` (or
`POST /__admin/config {"filterDatabases": true}`), then it needs Basic auth. Admin control: same port under `/__admin/*`, or a separate
plain-HTTP port with `ADMIN_PORT` (see "Control surface" below).

## Sources and how complete this inventory is

Fetched on 2026-10-18 from the current Claris Data API Guide (version 22 / 2025 documentation set):

| Topic                                           | URL                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Guide index                                     | https://help.claris.com/en/data-api-guide/content/index.html                      |
| Call components (methods, headers, URL forms)   | https://help.claris.com/en/data-api-guide/content/write-data-api-calls.html       |
| URL and data format notes                       | https://help.claris.com/en/data-api-guide/content/url-data-format-notes.html      |
| Scripts and the Data API                        | https://help.claris.com/en/data-api-guide/content/filemaker-scripts-data-api.html |
| Reference (where the real OpenAPI viewer lives) | https://help.claris.com/en/data-api-guide/content/data-api-reference.html         |
| Log in                                          | https://help.claris.com/en/data-api-guide/content/log-in-database-session.html    |
| Log out                                         | https://help.claris.com/en/data-api-guide/content/log-out-database-session.html   |
| Metadata overview                               | https://help.claris.com/en/data-api-guide/content/get-metadata.html               |
| Product info                                    | https://help.claris.com/en/data-api-guide/content/get-product-information.html    |
| Database names                                  | https://help.claris.com/en/data-api-guide/content/get-database-names.html         |
| Layout names                                    | https://help.claris.com/en/data-api-guide/content/get-layout-names.html           |
| Script names                                    | https://help.claris.com/en/data-api-guide/content/get-script-names.html           |
| Layout metadata                                 | https://help.claris.com/en/data-api-guide/content/get-layout-metadata.html        |
| Get a range of records                          | https://help.claris.com/en/data-api-guide/content/get-range-of-records.html       |
| Create record                                   | https://help.claris.com/en/data-api-guide/content/create-record.html              |
| Edit record                                     | https://help.claris.com/en/data-api-guide/content/edit-record.html                |
| Duplicate record                                | https://help.claris.com/en/data-api-guide/content/duplicate-record.html           |
| Perform a find                                  | https://help.claris.com/en/data-api-guide/content/perform-find-request.html       |
| Upload container data                           | https://help.claris.com/en/data-api-guide/content/upload-container-data.html      |
| Set global fields                               | https://help.claris.com/en/data-api-guide/content/set-global-field-values.html    |
| Error responses (HTTP statuses)                 | https://help.claris.com/en/data-api-guide/content/error-responses.html            |

**Limits of this inventory (read this).** Claris does not publish the per-version OpenAPI document online. It ships with the server and is
served at `https://<host>/fmi/data/apidoc/` (Cloud) or `https://<host>:3000/fmi/data/apidoc/` (Server) once Data API access is enabled. I had no
FileMaker Server or Cloud host, so I could not read it. The guide pages above do not contain: the OAuth login page (the topic URL I tried
returned a 404 redirect), the validate-session page, the "run a script with another request" page, the dedicated script-endpoint page,
or the FileMaker error-code table (the guide defers to FileMaker Pro Help). Items marked **(reference knowledge)** below come from the
published URL shapes in the guide's call-component page, the public Jentic-hosted spec summary (https://jentic.com/apis/help.claris.com/filemaker-data-api.md,
a third party, not Claris) and my own knowledge of the reference viewer. Treat them as unverified against a live server.
There is no machine-readable official spec to validate against, so the contract tests (`test/unit/mockServer/`) encode the response shapes
printed in the guide pages above, not a downloaded OpenAPI file.

Versions: `v1`, `v2` and `vLatest` are all accepted by the mock. The guide documents only one behavioural difference: in `v1` the
portal structure of a record depends on the layout view (Form View returns all related records, Table View the first), while `v2`
and `vLatest` follow Form View. The mock always behaves like `v2`/`vLatest`.

## Endpoints

Status: **Y** implemented, **P** partial, **N** intentionally not implemented.

| Method and path (under `/fmi/data/{v}`)                                       | Status | Mock behaviour and gaps                                                                                                                                                                                                                                                                                                                                                                                          | Source                                        |
| ----------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /productInfo`                                                            | Y      | No auth. `response.productInfo` has name, dateFormat, timeFormat, timeStampFormat (plus buildDate and version, which are not in the guide's example).                                                                                                                                                                                                                                                            | get-product-information                       |
| `GET /databases`                                                              | Y      | Open by default. With `FILTER_DATABASES=1` (or admin config) requires Basic auth, like the Admin Console setting "Filter Databases in Client Applications".                                                                                                                                                                                                                                                      | get-database-names                            |
| `GET /validateSession`                                                        | Y      | **(reference knowledge)** Bearer token; 200 when valid, 401/952 otherwise.                                                                                                                                                                                                                                                                                                                                       | reference viewer                              |
| `GET /oauth/getoauthurl?provider=&trackingID=&address=&X-FMS-OAuth-AuthType=` | P      | **(reference knowledge)** Returns a fake provider URL and the `X-FMS-Request-ID` header. No real provider exists.                                                                                                                                                                                                                                                                                                | write-data-api-calls (headers only)           |
| `POST /databases/{db}/sessions`                                               | Y      | Basic auth (`tester`/`testpass1`, `reader`/`readpass1`, `nobody`/`nopass1`; `retired` is inactive). OAuth headers `X-FM-Data-OAuth-Request-Id: mock-oauth-request` + `X-FM-Data-OAuth-Identifier: mock-oauth-identifier`. Claris ID `Authorization: FMID mock-fmid-token` when `CLOUD=1`. Token in `response.token` and the `X-FM-Data-Access-Token` header. `fmDataSource` in the body is accepted and ignored. | log-in-database-session, write-data-api-calls |
| `DELETE /databases/{db}/sessions/{token}`                                     | Y      | Always 200, empty `response`.                                                                                                                                                                                                                                                                                                                                                                                    | log-out-database-session                      |
| `GET /databases/{db}/layouts`                                                 | Y      | Folders as `{name, isFolder:true, folderLayoutNames:[...]}`, nested folders supported. `nobody` sees none.                                                                                                                                                                                                                                                                                                       | get-layout-names                              |
| `GET /databases/{db}/scripts`                                                 | Y      | Folders nest to any depth (`folderScriptNames`), and the `-` separator entry from the guide's example is present in `Quality`.                                                                                                                                                                                                                                                                                   | get-script-names                              |
| `GET /databases/{db}/layouts/{layout}`                                        | Y      | `fieldMetaData`, `portalMetaData` (per portal), `valueLists`. Field keys follow the guide (`fourDigitYear`, `repetitionStart/End`).                                                                                                                                                                                                                                                                              | get-layout-metadata                           |
| `GET .../layouts/{layout}?recordId=`                                          | P      | Accepted; value lists are static (dynamic/related value lists are not modelled).                                                                                                                                                                                                                                                                                                                                 | get-layout-metadata                           |
| `GET .../layouts/{layout}/records`                                            | Y      | `_offset` (default 1), `_limit` (default 100), `_sort` (JSON array; `ascend`, `descend` or a value-list name), `portal`, `_offset.{portal}`, `_limit.{portal}` (default 50; also `offset.`/`limit.` without underscore), `layout.response`, `dateformats` (0 US, 1 "file locale" = DD/MM/YYYY in the mock, 2 ISO 8601), `script`, `script.param`, `script.prerequest(.param)`, `script.presort(.param)`.         | get-range-of-records                          |
| `GET .../records/{id}`                                                        | Y      | Same query parameters as above that apply to one record.                                                                                                                                                                                                                                                                                                                                                         | write-data-api-calls                          |
| `POST .../records`                                                            | Y      | `fieldData`, `portalData` (rows without `recordId` create related records), `options.entrymode/prohibitmode`, `dateformats`, script parameters. Validation (entrymode `user`): date 500, number 502, unique 504, value list 506, required 509, calculation/global field 201.                                                                                                                                     | create-record                                 |
| `PATCH .../records/{id}`                                                      | Y      | `fieldData`, `modId` (306 on mismatch), `portalData` with `recordId`/`modId`, `deleteRelated` (`"Portal.recordId"` string or array), `options`, `dateformats`, script parameters. modId increments by one. A failed validation leaves the record unchanged.                                                                                                                                                      | edit-record                                   |
| `DELETE .../records/{id}`                                                     | Y      | 101 when missing.                                                                                                                                                                                                                                                                                                                                                                                                | write-data-api-calls                          |
| `POST .../records/{id}` (duplicate)                                           | Y      | Unique fields get a new value.                                                                                                                                                                                                                                                                                                                                                                                   | duplicate-record                              |
| `POST .../records/{id}/containers/{field}[/{repetition}]`                     | Y      | Multipart with the file in a part named `upload` (other parts ignored). `modId` query parameter checked. The container then holds a `/Streaming_SSL/MainDB/...` URL served by the mock (needs the `X-FM-Data-Access-Token` cookie). Related-table containers are not supported, as documented.                                                                                                                   | upload-container-data                         |
| `POST .../_find`                                                              | Y      | `query` (several requests are OR-ed), `omit`, `sort`, `offset`, `limit`, `portal`, `offset.{portal}`, `limit.{portal}`, `layout.response`, `dateformats`, script parameters. Related-field criteria (`Orders::Status`) match if any related row matches. Global fields as criteria give 102. Operators are an approximation (see `lib/find.mjs`).                                                                | perform-find-request                          |
| `PATCH /databases/{db}/globals`                                               | Y      | `globalFields` keyed `Table::field`. Values are per session and appear in later responses.                                                                                                                                                                                                                                                                                                                       | set-global-field-values                       |
| `GET .../layouts/{layout}/script/{script}?script.param=`                      | Y      | **(reference knowledge)** The dedicated script endpoint. `response.scriptResult` / `scriptError`. A `POST` to it is answered 405, which is what the extension's first attempt gets (see the finding in the E2E report).                                                                                                                                                                                          | reference viewer                              |
| Script parameters on record calls                                             | Y      | Results added to `response` as `scriptResult`, `scriptError`, `scriptResult.prerequest`, `scriptError.prerequest`, `scriptResult.presort`, `scriptError.presort`. A failing pre-request script does not abort the call (the real behaviour is not documented in the guide).                                                                                                                                      | filemaker-scripts-data-api                    |
| Cloud: `Authorization: FMID {token}`                                          | P      | Single fixed token, only with `CLOUD=1`.                                                                                                                                                                                                                                                                                                                                                                         | write-data-api-calls                          |
| `X-FM-Data-Login-Credentials` header (Basic alternative)                      | N      | Not documented in the pages above.                                                                                                                                                                                                                                                                                                                                                                               | none                                          |
| CORS / `OPTIONS`                                                              | N      | The guide says they are not supported; the mock answers `OPTIONS` with 405.                                                                                                                                                                                                                                                                                                                                      | write-data-api-calls                          |
| Data API Admin / FileMaker Server Admin API                                   | N      | Out of scope.                                                                                                                                                                                                                                                                                                                                                                                                    | none                                          |
| OData (`/fmi/odata`)                                                          | N      | A different API.                                                                                                                                                                                                                                                                                                                                                                                                 | none                                          |

### Responses and errors

Success: HTTP 200 with `{"response": {...}, "messages": [{"code": "0", "message": "OK"}]}`.
Errors: `{"messages": [{"code": "<n>", "message": "..."}]}`.

**Basis column.** The guide's error-responses page only states that an invalid URL gives HTTP 404. Every other
code-to-HTTP-status mapping below is an assumption of this mock (it matches what servers have been observed to
do in field reports and the extension's own tests, but nobody re-checked it against a real server here). Rows
marked "unverified" must not be read as the product's specification.

| Situation                                                                        | HTTP | `messages[0].code`                                         | Basis                                                                                                         |
| -------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Invalid URL / not a Data API path                                                | 404  | 105                                                        | documented (error-responses page)                                                                             |
| Invalid or expired token, or database name with different case than at login     | 401  | 952                                                        | unverified                                                                                                    |
| Wrong account or password, inactive account, bad OAuth/FMID (210, 211, 212, 214) | 401  | 212 (and 210/211/214 where used)                           | unverified                                                                                                    |
| No records match (find, or `_offset` past the end)                               | 404  | 401 (body also has `response: {}`)                         | unverified; a switch: `NO_RECORDS_STATUS=500` or `POST /__admin/config {"noRecordsStatus":500}` (default 404) |
| Insufficient privileges (writes or scripts for `reader`)                         | 403  | 9                                                          | unverified                                                                                                    |
| Invalid parameter (bad `_offset`, `_limit=0`, malformed JSON, bad `dateformats`) | 400  | 960                                                        | unverified                                                                                                    |
| Empty find criteria (`query: []`)                                                | 500  | 400                                                        | unverified                                                                                                    |
| Unknown layout / field / script / record                                         | 500  | 105 / 102 / 104 / 101                                      | unverified                                                                                                    |
| modId mismatch                                                                   | 500  | 306                                                        | unverified                                                                                                    |
| Validation                                                                       | 500  | 500, 502, 504, 506, 509; 201 field cannot be modified; 205 | unverified                                                                                                    |
| Database cannot be opened (`Locked`, unknown database)                           | 500  | 802                                                        | unverified                                                                                                    |
| Script returned an error                                                         | 200  | `scriptError` holds the code (e.g. "3")                    | unverified                                                                                                    |
| Wrong HTTP method                                                                | 405  | -1                                                         | unverified                                                                                                    |
| Wrong Content-Type (`STRICT_CONTENT_TYPE=0` turns this off)                      | 415  | -1                                                         | unverified                                                                                                    |
| Too many sessions (`maxSessions`)                                                | 503  | 1633                                                       | invented                                                                                                      |
| Rate limit scenario                                                              | 429  | -1                                                         | invented (FileMaker documents no rate limit)                                                                  |

Other behaviours that are assumptions, not documented facts (all **unverified**):

- A login request with no body and no `Content-Type` is accepted (200); any request with a body but no `application/json` `Content-Type` is refused with 415 unless `STRICT_CONTENT_TYPE=0`.
- `DELETE /sessions/{token}` with a bogus token answers 200 (a logout is idempotent here).
- `_limit=0`, a negative `_limit`, `_offset=0` (offsets start at 1) and a negative `_offset` give 400 / 960; an `_offset` past the end gives the "no records" answer above.
- A newly created record has `modId` `"0"`.
- Field metadata reports `maxCharacters: 0` for fields with no limit.
- `GET /productInfo` returns invented `version` (`22.0.1`) and `buildDate` (`09/01/2026`) values; its `dateFormat` and `timeFormat` are the mock's, and the seeded dates follow that format.

FileMaker error code 3 ("command invalid") occurs as a script result (`Fail` script), not as a request error. HTTP 500 for FileMaker errors is as documented.

## Session behaviour

- Token idle lifetime 15 minutes, sliding (the guide: "expires 15 minutes after the last call that used it"). `TTL_MS` env or `POST /__admin/config {"ttlMs": 2000}` shortens it; `POST /__admin/age {"ms": 600000}` ages every session without waiting.
- `maxSessions` caps concurrent sessions (default 500).

## Control surface (not part of the Data API)

Same port, or a separate plain-HTTP `ADMIN_PORT` (then the main port answers 404 for `/__admin`). All JSON.

| Call                                                                               | Purpose                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /__admin/log?limit=`                                                          | Request log (`method`, `path` relative to the database, `query`, `db`, `status`, `code`, `ms`, truncated `body`) and `sessionPosts`.                                                                                                            |
| `GET /__admin/state`                                                               | Session count, config, active scenario, record totals.                                                                                                                                                                                          |
| `GET /__admin/manifest`                                                            | The dataset manifest (which record ids exercise which condition).                                                                                                                                                                               |
| `POST /__admin/reset`                                                              | Re-seed data, clear sessions, log, scenario, globals.                                                                                                                                                                                           |
| `POST /__admin/expire {token?}`                                                    | Forget one token or all (next call: 401/952).                                                                                                                                                                                                   |
| `POST /__admin/age {ms?}`                                                          | Age sessions toward the TTL.                                                                                                                                                                                                                    |
| `POST /__admin/config {ttlMs,maxSessions,filterDatabases,cloud,strictContentType}` | Change server behaviour.                                                                                                                                                                                                                        |
| `POST /__admin/scenario {...}`                                                     | Merge scenario switches: `delayMs`, `hang` (path regexp: never answer), `drop` (path regexp: close the socket), `rateLimit {limit, windowMs}`, `failNext [{match:{method,path}, status, code, message, count}]`; `{"clear":true}` removes them. |
| `POST /__admin/concurrent-edit {db,table,recordId,fieldData}`                      | Another user edits a record: modId increases, so the editor's next save conflicts (306).                                                                                                                                                        |
| `POST /__admin/concurrent-delete {db,table,recordId}`                              | Another user deletes a record.                                                                                                                                                                                                                  |

### Faults (failure-mode scenarios)

`POST /__admin/fault {name, count?, path?, ...params}` adds a named fault (`count` omitted = until cleared; `path` is a regular expression
tested against the URL path); `{ "clear": true }` removes all; `GET /__admin/faults` lists them. The set follows
`docs/FILEMAKER_FAILURE_MODES.md` (PR #384, section 7):

| Fault                                                                          | Effect                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `login-inactive`, `login-expired-password`, `login-locked`                     | login answers 401 with FileMaker code 210, 211, 214                                  |
| `login-no-fmrest`                                                              | login answers 500 / 802                                                              |
| `login-session-limit`                                                          | login answers 500 / 956                                                              |
| `db-not-hosted` (`variant: "401"` for 401/212)                                 | login answers 500 / 100                                                              |
| `html-200`, `empty-200`, `truncated-json`, `array-body`                        | HTTP 200 with something that is not the Data API envelope                            |
| `redirect-login`, `redirect-other-origin` (`target`)                           | 302 to `/login`, 307 to another origin                                               |
| `status-413`, `-429` (`retryAfter`), `-502`, `-503`, `-504`                    | that status with an HTML gateway page                                                |
| `slow` (`delayMs`)                                                             | hold the response                                                                    |
| `drop-mid-response`, `reset-connection`                                        | close the socket after the headers / immediately                                     |
| `data-api-disabled`                                                            | HTML 404 for every `/fmi/data` path                                                  |
| `messages-nonzero-200` (`code`)                                                | HTTP 200 whose `messages[0].code` is not 0                                           |
| `find-no-match-500`                                                            | a find with no match answers 500 / 401 instead of 404 / 401                          |
| `record-locked`, `record-gone`, `validation-fail`                              | create / edit / delete answers 301 / 101 / 509                                       |
| `field-readonly` (`field`)                                                     | writing that field answers 201                                                       |
| `script-error`, `script-error-after-edit`, `script-huge-result`, `script-slow` | script endpoint error code 3 / scriptError 3 after a save / 2 MB result / 20 s delay |

Other admin calls: `POST /__admin/account {name, password?}` changes an account (the stored password "goes bad"),
`POST /__admin/reset-accounts`, `POST /__admin/many {db, n}` creates layout `Big` with `n` records, `POST /__admin/schema` adds/removes a field or renames a layout.
Extra accounts: `viewer`/`viewpass1` (reads; writes refused with 200 / 205 / 9; field `Email` hidden), `limited`/`limitpass1` (sees only layout `Contacts`).

TLS modes (`TLS=<mode>`): `self-signed`, `ca`, `expired`, `notyet`, `wronghost`, `missing-intermediate` (the server sends the leaf only;
`intermediatePath` is in the `MOCK_READY` line), `tls10-only` (TLS 1.0/1.1 only). Certificates come from `openssl ca -startdate/-enddate`
(any OpenSSL or LibreSSL, no 3.4 requirement). Scheme mix-ups (`http-to-tls`, `tls-to-http`) need no server mode: use the wrong scheme on a port.

TLS: `TLS=self-signed` serves a self-signed certificate (the connection must "allow self-signed"); `TLS=ca` serves a certificate signed by a throwaway CA whose file path is in the `MOCK_READY` line (`caPath`) so the "CA bundle" option can be tested. Both need `openssl` on PATH. The certificate lives in a temp dir removed on shutdown.

Proxy mode: `POST /__proxy` with `Authorization: Bearer mock-proxy-key` and `{action, profile, payload}`, matching `src/services/proxyClient.ts` (actions `createSession`, `deleteSession`, `listLayouts`, `listScripts`, `getRecord`, `findRecords`, `getLayoutMetadata`, `runScript`, `editRecord`, `createRecord`, `deleteRecord`, `uploadContainer`). It is a reference proxy that logs in as `tester`.

## Data

`Sales` (baseline, small), `Quality` (about 1,400 records of mixed quality), `Inventory` (clean), `Locked` (802). See `extension/test/mock-server/DATASET.md` for which record ids exercise which condition. Repeating fields are returned as `Name(1)`, `Name(2)`, ... (**assumption**: the guide documents the `(n)` form only for related fields).
