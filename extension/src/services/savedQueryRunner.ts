import { assertFindCriteria } from '../utils/findCriteria';
import type { FMClient } from './fmClient';
import type { ConnectionProfile, FindRecordsRequest, FindRecordsResult, SavedQuery } from '../types/fm';

export async function executeSavedQueryAgainstClient(
  query: SavedQuery,
  profile: ConnectionProfile,
  fmClient: FMClient
): Promise<{
  request: FindRecordsRequest;
  result: FindRecordsResult;
}> {
  const request: FindRecordsRequest = {
    query: query.findJson,
    sort: query.sortJson,
    limit: query.limit,
    offset: query.offset
  };

  assertFindCriteria(request.query);
  const result = await fmClient.findRecords(profile, query.layout, request);

  return {
    request,
    result
  };
}
