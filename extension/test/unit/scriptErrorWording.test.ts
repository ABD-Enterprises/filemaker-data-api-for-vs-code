import { describe, expect, it } from 'vitest';

import { describeScriptErrors, extractScriptErrors } from '../../src/services/responseGuard';
import { getFileMakerErrorInfo } from '../../src/utils/fileMakerCodes';

describe('script error wording (FileMaker script error codes 1, 3, 4, 5)', () => {
  it('error 3 says the command is unavailable and why it matters through the Data API', () => {
    const info = getFileMakerErrorInfo('3');
    expect(info?.meaning).toBe('Command is unavailable (for example, wrong operating system or mode).');
    expect(info?.advice).toMatch(/not allowed when the script runs through the Data API/);
  });

  it('errors 1, 4 and 5 have their own meanings', () => {
    expect(getFileMakerErrorInfo('1')?.meaning).toBe('User canceled the action.');
    expect(getFileMakerErrorInfo('4')?.meaning).toBe('Command is unknown.');
    expect(getFileMakerErrorInfo('5')?.meaning).toMatch(/^Command is invalid/);
  });

  it('the line shown to the user carries the code and the meaning, for each phase', () => {
    const errors = extractScriptErrors({ scriptError: '3', 'scriptError.prerequest': 4, 'scriptError.presort': '5' });
    expect(describeScriptErrors(errors)).toBe(
      'the script reported error 3 (Command is unavailable (for example, wrong operating system or mode)); ' +
        'the pre-request script reported error 4 (Command is unknown); ' +
        'the pre-sort script reported error 5 (Command is invalid (for example, a Set Field script step does not have a calculation specified))'
    );
  });
});
