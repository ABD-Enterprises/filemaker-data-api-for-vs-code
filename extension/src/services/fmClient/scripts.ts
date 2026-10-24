import type { ConnectionProfile, RunScriptRequest, RunScriptResult } from '../../types/fm';
import { isProxyProfile } from '../../types/fm';
import { FMClientError, toFMClientError } from '../errors';
import { normalizeError } from '../../utils/normalizeError';
import { buildProfileCacheKey } from '../../utils/profileCacheKey';
import { assertUsableUrlName } from '../../utils/urlSegment';
import { NOT_DATA_API_CODE } from '../responseGuard';
import type { ClientRequestControl } from './types';
import type { ClientContext } from './context';
import { MAX_SCRIPT_URL_LENGTH } from './types';
import { strictQuerySerializer, buildEndpoint } from './transport';
import { isNoRecordsFound } from './records';
import { getErrorStatus } from './response';

/**
 * Runs a FileMaker script the way the Claris Data API Guide documents it ("Run a script",
 * https://help.claris.com/en/data-api-guide/content/run-a-script.html):
 *
 *   GET /fmi/data/<version>/databases/<db>/layouts/<layout>/script/<script>?script.param=<text>
 *
 * The response carries `scriptError` (and `scriptResult` when the script exits with a result).
 * Nothing else is requested: no record is read or changed.
 *
 * When a record is needed, or the script endpoint is unsupported, attach the script to a GET
 * of the selected record or a GET records limited to one. Without a record ID, long parameters
 * use a wildcard find on a normal stored text field, limited to one record. An empty find is invalid,
 * and a find with no matches does not run the attached script (verified 2026-10-21).
 */
export async function runScript(
  client: ClientContext,
  profile: ConnectionProfile,
  request: RunScriptRequest,
  control?: ClientRequestControl
): Promise<RunScriptResult> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'runScript',
      layout: request.layout,
      endpoint: `GET /layouts/${request.layout}/script/${request.scriptName}`
    },
    async (trace) => {
      assertUsableUrlName(request.scriptName, 'script');
      assertUsableUrlName(request.layout, 'layout');
      if (isProxyProfile(profile)) {
        const result = await client.proxyClient.runScript(profile, request, control?.signal);
        return { ...result, response: scriptResponse(result.response) };
      }

      // Names are used exactly as given (see uploadContainer): only an empty or all-blank name is refused.
      const scriptName = request.scriptName;
      if (!scriptName.trim()) {
        throw new FMClientError('Script name is required.');
      }

      const layout = request.layout;
      if (!layout.trim()) {
        throw new FMClientError('Layout is required to run script.');
      }

      const scriptParam = request.scriptParam !== undefined && request.scriptParam.length > 0 ? request.scriptParam : undefined;
      const ifTooLong = (path: string, query: Record<string, string>): boolean =>
        buildEndpoint(profile, path).length + 1 + strictQuerySerializer(query).length > MAX_SCRIPT_URL_LENGTH;

      const attach = async (): Promise<RunScriptResult> => {
        if (request.recordId) {
          // GET: the script parameters are query parameters.
          const recordPath = `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(request.recordId)}`;
          const query = buildScriptParams(scriptName, scriptParam);
          if (ifTooLong(recordPath, query as Record<string, string>)) {
            throw tooLongScriptParameter();
          }
          const envelope = await client.requestWithAuth<Record<string, unknown>>(
            profile,
            { method: 'GET', path: recordPath, params: query, strictQuery: true, signal: control?.signal },
            true,
            trace
          );
          return { response: scriptResponse(envelope.response), messages: envelope.messages };
        }
        const path = `/layouts/${encodeURIComponent(layout)}/records`;
        const params = { _limit: 1, ...buildScriptParams(scriptName, scriptParam) };
        if (ifTooLong(path, Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])))) {
          throw tooLongScriptParameter();
        }
        try {
          const envelope = await client.requestWithAuth<Record<string, unknown>>(profile,
            { method: 'GET', path, params, strictQuery: true, signal: control?.signal }, true, trace);
          return { response: scriptResponse(envelope.response), messages: envelope.messages };
        } catch (error) {
          if (isNoRecordsFound(error)) throw scriptLayoutEmpty();
          throw error;
        }
      };

      const failure = (error: unknown, endpoint: string): FMClientError =>
        client.explainPinnedFailure(
          profile,
          toFMClientError(
            normalizeError(error, {
              fallbackMessage: 'Failed to run FileMaker script.',
              operation: trace.operation,
              requestId: trace.requestId,
              endpoint
            })
          )
        );

      // A record in context cannot be given to the script endpoint.
      if (request.recordId) {
        try {
          return await attach();
        } catch (error) {
          if (error instanceof FMClientError && error.code === 'SCRIPT_PARAMETER_TOO_LONG') {
            throw error;
          }
          if (isLikelyScriptUnsupportedError(error)) {
            throw scriptUnsupported(error);
          }
          throw failure(error, `GET /layouts/${request.layout}/records/${request.recordId}`);
        }
      }

      const scriptPath = `/layouts/${encodeURIComponent(layout)}/script/${encodeURIComponent(scriptName)}`;
      const query: Record<string, string> = scriptParam === undefined ? {} : { 'script.param': scriptParam };

      if (ifTooLong(scriptPath, query)) {
        const metadata = client.layoutMetadataCache.get(buildProfileCacheKey(profile, layout))
          ?? await client.getLayoutMetadata(profile, layout, { signal: control?.signal, recordHistory: false });
        const fields = Array.isArray(metadata.fieldMetaData) ? metadata.fieldMetaData : [];
        const textFields = fields.filter((field): field is { name: string; result: string; type?: string } =>
          field !== null && typeof field === 'object' && typeof field.name === 'string'
          && typeof field.result === 'string' && field.result.toLowerCase() === 'text'
          && (field.type === undefined || (typeof field.type === 'string' && field.type.toLowerCase() === 'normal'))
          && field.global !== true && String(field.global).toLowerCase() !== 'true');
        // Prefer confirmed stored fields, but tolerate metadata that omits the field type.
        const textField = textFields.find((field) => field.type?.toLowerCase() === 'normal') ?? textFields[0];
        if (!textField) {
          // Establish whether the layout is empty even when the parameter cannot fit a GET.
          const records = await client.listRecords(profile, layout, { limit: 1 }, control);
          if (!records.data.length) throw scriptLayoutEmpty();
          return attach();
        }
        try {
          const envelope = await client.requestWithAuth<Record<string, unknown>>(
            profile,
            {
              method: 'POST', path: `/layouts/${encodeURIComponent(layout)}/_find`,
              data: { query: [{ [textField.name]: '*' }], limit: 1, ...buildScriptParams(scriptName, scriptParam) },
              signal: control?.signal
            },
            true,
            trace
          );
          return { response: scriptResponse(envelope.response), messages: envelope.messages };
        } catch (error) {
          if (isNoRecordsFound(error)) {
            // '*' matches non-empty text, not every record. A read without a script distinguishes
            // an empty layout from one whose chosen field is empty in every visible record.
            const records = await client.listRecords(profile, layout, { limit: 1 }, control);
            if (!records.data.length) throw scriptLayoutEmpty();
            return attach();
          }
          throw failure(error, `POST /layouts/${request.layout}/_find`);
        }
      }

      try {
        const envelope = await client.requestWithAuth<Record<string, unknown>>(
          profile,
          { method: 'GET', path: scriptPath, params: query, strictQuery: true, signal: control?.signal },
          true,
          trace
        );
        return { response: scriptResponse(envelope.response), messages: envelope.messages };
      } catch (error) {
        if (!isLikelyScriptUnsupportedError(error)) {
          throw failure(error, `GET /layouts/${request.layout}/script/${request.scriptName}`);
        }
      }

      // The script endpoint was refused for a reason that is about the endpoint itself: use the documented
      // "another request" form instead.
      try {
        return await attach();
      } catch (error) {
        if (isNoRecordsFound(error)) throw scriptLayoutEmpty();
        if (isLikelyScriptUnsupportedError(error)) {
          throw scriptUnsupported(error);
        }
        throw failure(error, `GET /layouts/${request.layout}/records`);
      }
    }
  );
}

/**
 * A script run is not a data request. When the script is attached to a record or a find, that request's own
 * record(s) (`data`, `dataInfo`) come back too; they are not part of the script's answer and are dropped, so no
 * consumer (Layout Mode, the preview bridge, the AI tools, Script Runner) passes a record along by accident.
 */
function withoutRecordData(response: Record<string, unknown>): Record<string, unknown> {
  const { data: _data, dataInfo: _dataInfo, ...rest } = response;
  void _data;
  void _dataInfo;
  return rest;
}

/** An HTTP success without the main script's status does not confirm execution. */
function scriptResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (response.scriptError === undefined || response.scriptError === null || response.scriptError === '') {
    throw new FMClientError(
      'The server did not confirm that the script ran (no scriptError in the response). Check the script before trying again.',
      { code: 'SCRIPT_NOT_CONFIRMED', kind: 'server', isRetryable: false }
    );
  }
  return withoutRecordData(response);
}

function tooLongScriptParameter(): FMClientError {
  return new FMClientError(
    'This parameter is too long to send. Shorten it or run the script from a layout with a text field',
    { code: 'SCRIPT_PARAMETER_TOO_LONG', kind: 'validation', isRetryable: false }
  );
}

function scriptUnsupported(error: unknown): FMClientError {
  return new FMClientError('Script runner is not supported on this server/profile.', {
    code: 'SCRIPT_UNSUPPORTED',
    status: getErrorStatus(error),
    details: error
  });
}

function buildScriptParams(
  scriptName: string,
  scriptParam?: string
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    script: scriptName
  };

  if (scriptParam !== undefined && scriptParam.length > 0) {
    params['script.param'] = scriptParam;
  }

  return params;
}

function isLikelyScriptUnsupportedError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 405 || status === 501) {
    return true;
  }
  // A bare 404 is a wrong address or a disabled Data API, not "scripts unsupported": only a 404
  // that carries a FileMaker error code counts.
  return (
    status === 404 &&
    error instanceof FMClientError &&
    error.code !== undefined &&
    error.code !== NOT_DATA_API_CODE
  );
}

function scriptLayoutEmpty(): FMClientError {
  return new FMClientError('The script did not run because this layout has no records. Add a record or use a layout that has records.',
    { code: '401', kind: 'validation', isRetryable: false });
}
