import { nulTextError } from '@fmweb/shared/dist/record-edit';
import { FMClientError } from '../services/errors';

export { NUL_TEXT_WARNING, containsNulText, nulTextFields, removeNulText, nulTextError } from '@fmweb/shared/dist/record-edit';

/** Refuse unsafe writes for callers that cannot ask the user to remove NUL. */
export function assertNoNulText(fields: Record<string, unknown>): void {
  const reason = nulTextError(fields);
  if (reason) throw new FMClientError(reason, { status: 400 });
}
