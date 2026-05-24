# Architecture

## Overview

The extension is organized around service boundaries with a thin command/webview layer. Services handle all business logic and Data API communication. Commands and webviews are thin entry points that delegate to services.

Generated API documentation for `src/services` and `src/types` is published at [abd-enterprises.github.io/filemaker-data-api-for-vs-code/api/](https://abd-enterprises.github.io/filemaker-data-api-for-vs-code/api/). Run `npm run docs:api` from the repository root to regenerate the local TypeDoc output in `docs/api`.

## Module Boundaries

### Composition Root

- `src/extension.ts`
  - constructs stores/services
  - wires command registrations and explorer provider
  - owns lifecycle/disposal

### Core Services

- `src/services/fmClient.ts`
  - HTTP transport
  - session token lifecycle
  - request wrapper (timeouts + abort signals)
  - retry-on-401 once
  - normalized error conversion
  - history/metrics hooks

- `src/services/profileStore.ts`
  - profile CRUD (no secrets)
  - input/schema validation on persistence

- `src/services/secretStore.ts`
  - `SecretStorage` wrapper
  - key naming conventions

- `src/services/settingsService.ts`
  - centralized setting reads
  - defaults + validation/clamping
  - trust-aware defaults

- `src/services/schemaService.ts`
  - metadata fetch abstraction
  - schema cache + fallback behavior

- `src/services/savedQueriesStore.ts`
  - saved query CRUD
  - scope control (workspace/global)
  - schema versioning + migration

- `src/services/historyStore.ts`
  - request history persistence (non-sensitive)

- `src/diagnostics/metricsStore.ts`
  - rolling request metrics aggregates

- `src/services/jobRunner.ts`
  - job lifecycle, progress, cancellation

- `src/services/batchService.ts`
  - batch orchestration built on `fmClient` + `jobRunner` context

### Enterprise/Platform Services

- `src/enterprise/*`
  - role/policy guard
  - environment set storage + compare service

- `src/offline/offlineModeService.ts`
  - offline state + metadata cache

- `src/plugins/*`
  - plugin contracts and registry
  - safe API exposure (no direct secret access)

### Webview Layer

- `src/webviews/**/index.ts`
  - panel creation and message routing only
  - delegates business logic to services

- `src/webviews/common/csp.ts`
  - shared CSP + nonce helpers

- `src/webviews/common/messageValidation.ts`
  - shared incoming message guards/parsers

### Shared Types/Utils

- `src/types/dataApi.ts`
  - minimal Data API envelopes used by client

- `src/types/errors.ts`
  - normalized error contract

- `src/types/webviewMessages.ts`
  - shared webview message primitives

- `src/utils/normalizeError.ts`
  - single normalization strategy for network/auth/server/timeout/cancel/unknown

- `src/utils/redact.ts`
  - single redaction utility for logs/errors/history/details docs

- `src/utils/errorUx.ts`
  - command-facing error UX helper with `Details…` document

- `src/utils/valueListParser.ts`
  - value list extraction from layout metadata

- `src/utils/containerFieldUtils.ts`
  - container field detection and URL resolution

- `src/utils/portalUtils.ts`
  - portal data extraction, metadata parsing, request parameter building

- `src/utils/globalFieldUtils.ts`
  - global field payload building/parsing and validation

- `src/utils/compoundFindUtils.ts`
  - compound find query building with omit support

- `src/utils/duplicateRecord.ts`
  - duplicate record field preparation with auto-enter field filtering

## Dependency Diagram

```text
commands/* ----\
                \-> services/* -> fmClient -> FileMaker Data API
webviews/* ----/         |            |
                         |            +-> proxyClient (optional)
                         +-> stores (profiles, savedQueries, history, metrics)

extension.ts -> constructs services/stores/guards -> injects into commands/webviews/views

webviews/common/* and utils/* are pure helpers (no business state)
types/* are shared contracts only
```

## Data Flow

### Command Path

`Command -> Service -> fmClient -> Data API -> normalizeError/redact -> UX`

### Webview Path

`Webview UI -> postMessage -> Controller -> Service/fmClient -> Controller -> postMessage -> UI`

Webview never receives secrets and never performs direct FileMaker auth/API requests.

## Error Normalization Strategy

- `normalizeError()` converts unknown errors to a consistent `NormalizedError`.
- `FMClientError` can carry normalized metadata.
- Commands use `showErrorWithDetails()` to present:
  - friendly message
  - optional `Details…` action opening safe JSON:
    - requestId
    - endpoint/status
    - safe headers
    - redacted details payload

## Caching Strategy

- Layout list cache in `fmClient` (short TTL)
- Metadata cache in `schemaService` (configurable TTL)
- Snapshot/offline caches persisted via dedicated stores/services
- Cache invalidation on disconnect/profile invalidation/manual refresh commands

## Webview Messaging Validation

- Controllers validate inbound messages using shared guards.
- Unknown/invalid message shapes are ignored safely.
- Outbound payloads are constructed from trusted service results only.

## Adding New API Endpoints Safely

1. Add typed response contract in `src/types/dataApi.ts` (or `src/types/fm.ts` if domain-level).
2. Add `fmClient` method using existing request wrapper + `AbortSignal`.
3. Normalize and map errors via `normalizeError`.
4. Keep secrets out of payload/logging (`redact`).
5. Add unit test (request wrapper behavior) and integration test (mocked HTTP).
6. Expose through command/webview only after role/trust guards are considered.
