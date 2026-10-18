/** Common FileMaker and Data API error codes. Not complete; an unknown code says so. */
const KNOWN: Record<number, string> = {
  0: 'No error.',
  100: 'File is missing.',
  101: 'Record is missing.',
  102: 'Field is missing.',
  103: 'Relationship is missing.',
  104: 'Script is missing.',
  105: 'Layout is missing.',
  106: 'Table is missing.',
  200: 'Record access is denied.',
  201: 'Field cannot be modified.',
  202: 'Field access is denied.',
  204: 'No access to field(s) in the sort order.',
  205: 'The user does not have access privileges to create new records.',
  206: 'The user does not have password change privileges, or the file is not modifiable.',
  207: 'The user does not have sufficient privileges to change the database schema, or the file is not modifiable.',
  210: 'The user account is inactive.',
  211: 'The password has expired.',
  212: 'Invalid user account and/or password.',
  214: 'Too many login attempts.',
  301: 'The record is in use by another user.',
  302: 'The table is in use by another user.',
  303: 'The database schema is in use by another user.',
  304: 'The layout is in use by another user.',
  306: 'The record modification ID does not match: the record was changed by someone else since it was read.',
  401: 'No records match the request.',
  500: 'The date value does not meet the validation entry options.',
  501: 'The time value does not meet the validation entry options.',
  502: 'The number value does not meet the validation entry options.',
  503: 'The value is not within the range specified in the validation entry options.',
  504: 'The value is not unique as required in the validation entry options.',
  505: 'The value is not an existing value in the database file as required in the validation entry options.',
  506: 'The value is not listed on the value list specified in the validation entry options.',
  507: 'The value failed the calculation test of the validation entry options.',
  508: 'Invalid value entered in Find mode.',
  509: 'The field requires a valid value.',
  510: 'The related value is empty or unavailable.',
  511: 'The value exceeds the maximum number of allowed characters.',
  802: 'Unable to open the file.',
  952: 'Invalid Data API token (the session expired or was closed).',
  954: 'Unsupported XML grammar.',
  955: 'No database name.',
  956: 'The maximum number of Data API sessions was exceeded.',
  957: 'Conflicting commands.',
  958: 'A parameter is missing.'
};

export function explainFileMakerError(code: number): { code: number; known: boolean; meaning: string } {
  const meaning = KNOWN[code];
  return meaning
    ? { code, known: true, meaning }
    : {
        code,
        known: false,
        meaning: 'This code is not in the extension\'s short table. Look it up in the FileMaker error code reference.'
      };
}
