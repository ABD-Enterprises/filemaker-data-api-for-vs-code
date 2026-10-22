import type { FindRecordsRequest, SchemaMetadataResult } from '../../types/fm';
import { EMPTY_FIND_ADVICE, hasFindCriteria } from '../../utils/findCriteria';
import { AiToolError } from './errors';
import { knownField, usableFieldName } from './fields';
import { finish, listNames, shapeRecords } from './results';
import type { AiToolDeps, Env, LayoutFields, Obj } from './types';

/** Session-owned operations stay in the service; reads cannot bypass consent or quotas. */
export interface ReadToolRuntime {
  deps: Pick<AiToolDeps, 'client'>;
  useLayout(env: Env, layout: string): Promise<void>;
  layoutSchema(env: Env, layout: string): Promise<SchemaMetadataResult>;
  layoutFields(env: Env, layout: string): Promise<LayoutFields>;
  withRecords<T>(wanted: number, request: (limit: number) => Promise<{ value: T; returned: number }>): Promise<T>;
  quota(): { used: number; limit: number };
}

export async function listLayouts(runtime: ReadToolRuntime, env: Env): Promise<unknown> {
  const layouts = await runtime.deps.client.listLayouts(env.profile, env.control);
  return listNames('layouts', layouts);
}

export async function listScripts(runtime: ReadToolRuntime, env: Env): Promise<unknown> {
  const scripts = await runtime.deps.client.listScripts(env.profile, env.control);
  return listNames('scripts', scripts);
}

export async function describeLayout(runtime: ReadToolRuntime, env: Env, layout: string): Promise<unknown> {
  await runtime.useLayout(env, layout);
  const schema = await runtime.layoutSchema(env, layout);
  let unusable = 0;
  const fields: Obj[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const field of schema.fields) {
    if (env.hidden.isHidden(field.name)) {
      continue;
    }
    const name = usableFieldName(field.name);
    if (name === undefined) {
      unusable += 1;
      continue;
    }
    if (seen.has(name)) { duplicates++; continue; }
    seen.add(name);
    const type = field.result ?? field.type;
    fields.push({
      name,
      type: typeof type === 'string' ? type.slice(0, 30) : undefined,
      repetitions: typeof field.repetitions === 'number' && field.repetitions > 1 ? field.repetitions : undefined
    });
  }
  return { layout, fields, ...(duplicates ? { note: 'Repeated fields are shown once. Each exact field name has one value in a record.', duplicateFields: duplicates } : {}), unusableFields: unusable > 0 ? unusable : undefined };
}

export async function findRecords(runtime: ReadToolRuntime, env: Env, input: Obj): Promise<unknown> {
  const layout = input.layout as string;
  await runtime.useLayout(env, layout);
  const fields = await runtime.layoutFields(env, layout);

  const requests = input.requests as Array<{ fields: Record<string, string>; omit?: boolean }>;
  const query = requests.map((request) => {
    const entries = Object.entries(request.fields);
    if (entries.length === 0) {
      throw new AiToolError(EMPTY_FIND_ADVICE);
    }
    // No prototype, so a field called "__proto__" or "constructor" is only a key.
    const criteria = Object.create(null) as Obj;
    for (const [fieldName, value] of entries) {
      criteria[knownField(fields, fieldName)] = value;
    }
    if (request.omit === true) {
      criteria.omit = 'true';
    }
    return criteria;
  });
  if (!hasFindCriteria(query)) throw new AiToolError(EMPTY_FIND_ADVICE);
  if (query.every((criteria) => criteria.omit === 'true')) {
    throw new AiToolError('At least one find request must not be an omit request.');
  }

  const sort = ((input.sort as Array<{ field: string; order?: 'asc' | 'desc' }> | undefined) ?? []).map((item) => ({
    fieldName: knownField(fields, item.field),
    sortOrder: item.order === 'desc' ? 'descend' : 'ascend'
  }));

  const outcome = await runtime.withRecords((input.limit as number | undefined) ?? 20, async (limit) => {
    const body: FindRecordsRequest = {
      query,
      ...(sort.length > 0 ? { sort } : {}),
      limit,
      ...(input.offset !== undefined ? { offset: input.offset as number } : {})
    };
    const result = await runtime.deps.client.findRecords(env.profile, layout, body, env.control);
    const shaped = shapeRecords(result.data.slice(0, limit), fields, env);
    return { value: { result, shaped, limit }, returned: shaped.records.length };
  });

  env.trace.recordIds = outcome.shaped.records.map((record) => String(record.recordId));
  const foundCount = outcome.result.dataInfo?.foundCount;
  return finish({
    layout,
    foundCount: typeof foundCount === 'number' ? foundCount : undefined,
    records: outcome.shaped.records,
    truncated: outcome.shaped.truncated || outcome.result.data.length > outcome.limit,
    quota: runtime.quota()
  });
}

export async function getRecord(runtime: ReadToolRuntime, env: Env, layout: string, recordId: string): Promise<unknown> {
  await runtime.useLayout(env, layout);
  const fields = await runtime.layoutFields(env, layout);
  const shaped = await runtime.withRecords(1, async () => {
    const record = await runtime.deps.client.getRecord(env.profile, layout, recordId, env.control);
    return { value: shapeRecords([record], fields, env), returned: 1 };
  });
  env.trace.recordIds = [recordId];
  return finish({ layout, records: shaped.records, truncated: shaped.truncated, quota: runtime.quota() });
}
