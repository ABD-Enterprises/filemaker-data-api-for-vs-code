/**
 * FileMaker and Data API error codes: what they mean and what to do. One table for the whole
 * extension (the UI error messages and the AI `explain error` tool).
 *
 * `meaning` is the short, stable description. `advice` says what the user can do or what to ask
 * the FileMaker administrator, and is added to the message the user sees. `category` drives
 * behaviour: which buttons an error shows and whether anything is retried.
 */
export type FileMakerErrorCategory =
  /** The account or password is wrong, inactive, expired or locked: fix the profile. */
  | 'credentials'
  /** The account is signed in but its privilege set does not allow this: not fixable in the profile. */
  | 'privilege'
  /** The thing asked for does not exist (record, layout, script, database). */
  | 'notFound'
  /** The request itself is wrong (bad parameter, field value, find criteria). */
  | 'request'
  /** Someone else holds or changed the record. */
  | 'conflict'
  /** The server or Data API is unavailable or limited; trying again later may work. */
  | 'transient'
  /** The server is set up so that this cannot work (disabled, unsupported). */
  | 'config';

export interface FileMakerErrorInfo {
  meaning: string;
  category: FileMakerErrorCategory;
  advice?: string;
  /** Retrying the identical request can succeed (a lock, a session limit, a restart). */
  retryable?: boolean;
}

const ADMIN_PRIVILEGE =
  'Your account cannot do this. Ask your FileMaker administrator to change the privilege set for your account; editing this connection will not help.';

const KNOWN: Record<number, FileMakerErrorInfo> = {
  0: { meaning: 'No error.', category: 'request' },
  9: {
    meaning: 'Insufficient privileges.',
    category: 'privilege',
    advice: ADMIN_PRIVILEGE
  },
  100: {
    meaning: 'File is missing.',
    category: 'config',
    advice:
      'Check the database name in the connection (the hosted file name, without .fmp12). The file may not be hosted or may be closed.'
  },
  101: { meaning: 'Record is missing.', category: 'notFound', advice: 'The record may have been deleted by someone else. Reload.' },
  102: { meaning: 'Field is missing.', category: 'notFound', advice: 'The field name is not on this layout. The layout may have changed; refresh and try again.' },
  103: { meaning: 'Relationship is missing.', category: 'notFound' },
  104: { meaning: 'Script is missing.', category: 'notFound', advice: 'Check the script name, and that your account may run scripts.' },
  105: { meaning: 'Layout is missing.', category: 'notFound', advice: 'The layout may have been renamed or hidden from your account.' },
  106: { meaning: 'Table is missing.', category: 'notFound' },
  200: { meaning: 'Record access is denied.', category: 'privilege', advice: ADMIN_PRIVILEGE },
  201: { meaning: 'Field cannot be modified.', category: 'request', advice: 'The field is a calculation, summary or otherwise protected field, or your account may only view it.' },
  202: { meaning: 'Field access is denied.', category: 'privilege', advice: ADMIN_PRIVILEGE },
  203: {
    meaning: 'No records in file to print, or the password does not allow print access.',
    category: 'privilege',
    advice: ADMIN_PRIVILEGE
  },
  204: { meaning: 'No access to field(s) in the sort order.', category: 'privilege', advice: ADMIN_PRIVILEGE },
  205: {
    meaning: 'The user does not have access privileges to create new records.',
    category: 'privilege',
    advice: ADMIN_PRIVILEGE
  },
  206: {
    meaning: 'The user does not have password change privileges, or the file is not modifiable.',
    category: 'privilege',
    advice: ADMIN_PRIVILEGE
  },
  207: {
    meaning: 'The user does not have sufficient privileges to change the database schema, or the file is not modifiable.',
    category: 'privilege',
    advice: ADMIN_PRIVILEGE
  },
  208: {
    meaning: 'The password does not contain enough characters.',
    category: 'credentials',
    advice: 'The account\'s password policy requires a longer password. Change it in FileMaker, then update this connection.'
  },
  209: {
    meaning: 'The new password must be different from the existing one.',
    category: 'credentials',
    advice: 'Choose a password that differs from the current one.'
  },
  210: {
    meaning: 'The user account is inactive.',
    category: 'credentials',
    advice: 'Ask your FileMaker administrator to make the account active.'
  },
  211: {
    meaning: 'The password has expired.',
    category: 'credentials',
    advice:
      'Change the password in FileMaker Pro (or ask your administrator), then edit this connection. The Data API cannot change passwords.'
  },
  212: {
    meaning: 'Invalid user account and/or password.',
    category: 'credentials',
    advice: 'Account names are not case sensitive; passwords are. Edit the connection to enter the password again.'
  },
  213: { meaning: 'The user account and/or password does not exist.', category: 'credentials' },
  214: {
    meaning: 'Too many login attempts.',
    category: 'credentials',
    advice: 'Wait, then try again. Sign-in attempts stay paused until you edit the connection or run Connect.'
  },
  301: {
    meaning: 'The record is in use by another user.',
    category: 'conflict',
    retryable: true,
    advice: 'Someone (or a script) is editing this record. Try again in a moment.'
  },
  302: { meaning: 'The table is in use by another user.', category: 'conflict', retryable: true },
  303: { meaning: 'The database schema is in use by another user.', category: 'conflict', retryable: true },
  304: { meaning: 'The layout is in use by another user.', category: 'conflict', retryable: true },
  306: {
    meaning: 'The record modification ID does not match: the record was changed by someone else since it was read.',
    category: 'conflict'
  },
  400: { meaning: 'Find criteria are empty.', category: 'request', advice: 'Enter at least one find criterion.' },
  401: { meaning: 'No records match the request.', category: 'notFound' },
  500: { meaning: 'The date value does not meet the validation entry options.', category: 'request' },
  501: { meaning: 'The time value does not meet the validation entry options.', category: 'request' },
  502: { meaning: 'The number value does not meet the validation entry options.', category: 'request' },
  503: { meaning: 'The value is not within the range specified in the validation entry options.', category: 'request' },
  504: { meaning: 'The value is not unique as required in the validation entry options.', category: 'request' },
  505: { meaning: 'The value is not an existing value in the database file as required in the validation entry options.', category: 'request' },
  506: { meaning: 'The value is not listed on the value list specified in the validation entry options.', category: 'request' },
  507: { meaning: 'The value failed the calculation test of the validation entry options.', category: 'request' },
  508: { meaning: 'Invalid value entered in Find mode.', category: 'request' },
  509: { meaning: 'The field requires a valid value.', category: 'request' },
  510: { meaning: 'The related value is empty or unavailable.', category: 'request' },
  511: { meaning: 'The value exceeds the maximum number of allowed characters.', category: 'request' },
  802: {
    meaning: 'Unable to open the file.',
    category: 'config',
    advice:
      'The database may be closed or not hosted, or your account\'s privilege set may lack the "Access via FileMaker Data API" (fmrest) extended privilege. Ask your FileMaker administrator to check both.'
  },
  952: { meaning: 'Invalid Data API token (the session expired or was closed).', category: 'credentials' },
  953: { meaning: 'The request exceeded the limit on data the FileMaker Data API can transmit.', category: 'request', advice: 'Ask for fewer records or fields at a time.' },
  954: { meaning: 'Unsupported XML grammar.', category: 'config' },
  955: { meaning: 'No database name.', category: 'config', advice: 'Enter the database name in the connection.' },
  956: {
    meaning: 'The maximum number of database or Admin API sessions was exceeded (FileMaker error 956).',
    category: 'transient',
    retryable: true,
    advice:
      'The server has no free Data API sessions. Try again shortly, or ask the administrator to disconnect idle clients (Admin Console > Databases, Clients list).'
  },
  957: { meaning: 'Conflicting commands.', category: 'request' },
  958: { meaning: 'A parameter is missing.', category: 'request' },
  959: {
    meaning: 'The FileMaker Data API (web publishing) is disabled.',
    category: 'config',
    advice: 'Ask your FileMaker administrator to enable the Data API (Admin Console > Connectors > FileMaker Data API).'
  },
  960: { meaning: 'A parameter is invalid.', category: 'request' },
  1630: { meaning: 'The server rejected the request (error 1630).', category: 'request', advice: 'Look up this code in the FileMaker Server error reference, or ask your administrator.' },
  1700: { meaning: 'The server could not process the request (error 1700).', category: 'transient' },
  1701: {
    meaning: 'The host is currently unable to receive requests.',
    category: 'transient',
    retryable: true,
    advice: 'The server may be starting, restarting or in maintenance. Try again shortly.'
  },
  1702: { meaning: 'The server could not process the request (error 1702).', category: 'transient' },
  1703: {
    meaning: 'The server requires a different sign-in method (error 1703).',
    category: 'credentials',
    advice:
      'FileMaker Cloud normally uses Claris ID sign-in, which this extension does not support; an account name and password may not be accepted by your Cloud tenant (ask Claris or your administrator). On other servers the account may use external authentication.'
  },
  1704: { meaning: 'The server could not process the request (error 1704).', category: 'transient' },
  1705: { meaning: 'The server could not process the request (error 1705).', category: 'transient' },
  1706: { meaning: 'The server could not process the request (error 1706).', category: 'transient' },
  1707: { meaning: 'The server could not process the request (error 1707).', category: 'transient' },
  1708: { meaning: 'The server could not process the request (error 1708).', category: 'transient' },
  1709: { meaning: 'The server could not process the request (error 1709).', category: 'transient' },
  1710: { meaning: 'The server could not process the request (error 1710).', category: 'transient' }
};

export function getFileMakerErrorInfo(code: number | string | undefined): FileMakerErrorInfo | undefined {
  const numeric = typeof code === 'string' ? Number(code) : code;
  return numeric === undefined || !Number.isInteger(numeric) ? undefined : KNOWN[numeric];
}

/** Codes where signing in again with the same stored credentials cannot work. */
export function isCredentialRejection(code: string | undefined): boolean {
  return (
    code === '210' || code === '211' || code === '212' || code === '213' || code === '214' ||
    // The server wants a different kind of sign-in (Claris ID, external authentication): the stored password cannot work.
    code === '1703'
  );
}

/** What the AI `explain error code` tool returns. Unknown codes say so. */
export function explainFileMakerError(code: number): { code: number; known: boolean; meaning: string } {
  const info = KNOWN[code];
  return info
    ? { code, known: true, meaning: info.meaning }
    : {
        code,
        known: false,
        meaning: 'This code is not in the extension\'s short table. Look it up in the FileMaker error code reference.'
      };
}
