import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { includeAuthByDefault } from '../../../src/snippets/settings';

describe('copied-request auth default', () => {
  const trusted = vscode.workspace.isTrusted;
  afterEach(() => {
    (vscode.workspace as { isTrusted: boolean }).isTrusted = trusted;
  });

  it.each([true, false])('reads the effective workspace value with trust=%s', (isTrusted) => {
    (vscode.workspace as { isTrusted: boolean }).isTrusted = isTrusted;
    const get = vi.fn(() => true);
    // A conflicting user baseline must not turn this ordinary setting into a stricter-bool setting.
    const inspect = vi.fn(() => ({ globalValue: false, workspaceValue: true }));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({ get, inspect } as never);
    expect(includeAuthByDefault()).toBe(true);
    expect(vscode.workspace.getConfiguration).toHaveBeenLastCalledWith('filemaker');
    expect(get).toHaveBeenCalledWith('snippets.includeAuthByDefault', false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([false, undefined, null, 'true', 1])('only boolean true opts in: %j', (value) => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({ get: () => value } as never);
    expect(includeAuthByDefault()).toBe(false);
  });
});
