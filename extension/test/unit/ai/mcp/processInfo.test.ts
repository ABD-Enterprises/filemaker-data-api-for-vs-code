import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getProcessStartTime, isProcessAlive } from '../../../../src/ai/mcp/processInfo';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('fs/promises', () => ({ readFile: vi.fn() }));

describe('process identity lookups', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  function commandResult(output: string, error: Error | null = null): void {
    vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(error, output);
    }) as typeof execFile);
  }

  it('checks liveness without treating permission denied as a dead process', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(isProcessAlive(42)).toBe(true);
    expect(kill).toHaveBeenCalledWith(42, 0);
    kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(isProcessAlive(42)).toBe(true);
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(isProcessAlive(42)).toBe(false);
  });

  it('rejects invalid ids without looking up or signalling a process', async () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pid of [0, -5, 1.5, NaN, Infinity]) {
      expect(isProcessAlive(pid)).toBe(false);
      expect(await getProcessStartTime(pid)).toBeUndefined();
    }
    expect(kill).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin', 'win32'] as const)('returns stable identities and distinguishes later starts on %s', async (platform) => {
    // Include spaces and parentheses in the Linux process name; starttime is field 22.
    const stat = (start: string) => `42 (a tricky (name)) ${['S', ...Array<string>(18).fill('0'), start].join(' ')}`;
    const first = platform === 'linux' ? '12345' : platform === 'win32' ? '2026-10-20T12:00:00.0000000Z' : 'Tue Oct 20 12:00:00 2026';
    const later = platform === 'linux' ? '12346' : platform === 'win32' ? '2026-10-20T12:00:01.0000000Z' : 'Tue Oct 20 12:00:01 2026';
    vi.mocked(readFile).mockResolvedValue(stat(first));
    commandResult(`  ${first}\n`);
    const identity = await getProcessStartTime(42, platform);
    const prefix = platform === 'linux' ? 'linux' : platform === 'win32' ? 'win' : 'ps';
    expect(identity).toBe(`${prefix}:${first}`);
    expect(await getProcessStartTime(42, platform)).toBe(identity);

    vi.mocked(readFile).mockResolvedValue(stat(later));
    commandResult(later);
    expect(await getProcessStartTime(43, platform)).toBe(`${prefix}:${later}`);
    if (platform === 'linux') {
      expect(readFile).toHaveBeenLastCalledWith('/proc/43/stat', 'utf8');
    } else {
      const [command, args, options] = vi.mocked(execFile).mock.calls.at(-1)!;
      expect(command).toBe(platform === 'win32' ? 'powershell.exe' : 'ps');
      expect(args).toEqual(platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "(Get-Process -Id 43 -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')"]
        : ['-o', 'lstart=', '-p', '43']);
      expect(options).toMatchObject({ windowsHide: true, timeout: platform === 'win32' ? 30_000 : 8000 });
    }
  });

  it.each(['darwin', 'win32'] as const)('fixes the lookup locale and time zone on %s regardless of the caller', async (platform) => {
    const output = platform === 'win32' ? '2026-10-20T12:00:00.0000000Z' : 'Tue  Oct 20 12:00:00 2026';
    commandResult(output);
    try {
      const seen = new Set<string | undefined>();
      for (const [tz, locale] of [['UTC', 'C'], ['Asia/Tokyo', 'ja_JP.UTF-8'], ['America/Los_Angeles', 'de_DE.UTF-8'], ['Pacific/Kiritimati', 'fr_FR.UTF-8']]) {
        vi.stubEnv('TZ', tz);
        vi.stubEnv('LC_ALL', locale);
        vi.stubEnv('LANG', locale);
        seen.add(await getProcessStartTime(42, platform));
        expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({ env: { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
      }
      expect([...seen]).toEqual([platform === 'win32' ? `win:${output}` : 'ps:Tue Oct 20 12:00:00 2026']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['linux', 'darwin', 'win32'] as const)('leaves missing or unreadable processes unverified on %s', async (platform) => {
    vi.mocked(readFile).mockRejectedValue(new Error('gone'));
    commandResult('ignored output', new Error('gone or timed out'));
    expect(await getProcessStartTime(42, platform)).toBeUndefined();
    vi.mocked(readFile).mockResolvedValue('');
    commandResult('');
    expect(await getProcessStartTime(42, platform)).toBeUndefined();
  });

  it('normalizes Unix whitespace and rejects a truncated Linux stat record', async () => {
    commandResult('  Tue\t Oct 20   12:00:00 2026\n');
    expect(await getProcessStartTime(42, 'darwin')).toBe('ps:Tue Oct 20 12:00:00 2026');
    vi.mocked(readFile).mockResolvedValue('42 (truncated name) S 0');
    expect(await getProcessStartTime(42, 'linux')).toBeUndefined();
  });

  it('rejects malformed Windows timestamps and Linux start ticks', async () => {
    commandResult('not a timestamp');
    expect(await getProcessStartTime(42, 'win32')).toBeUndefined();
    vi.mocked(readFile).mockResolvedValue(`42 (name) ${['S', ...Array<string>(18).fill('0'), 'invalid'].join(' ')}`);
    expect(await getProcessStartTime(42, 'linux')).toBeUndefined();
  });
});
