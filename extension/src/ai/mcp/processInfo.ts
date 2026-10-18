import { execFile } from 'child_process';
import { readFile } from 'fs/promises';

/** True if a process with this id exists (it may belong to another user). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim());
    });
  });
}

/**
 * A string that identifies one run of a process: it changes if the process id is reused.
 * Linux: the start time in `/proc/<pid>/stat`. macOS and other Unix: `ps -o lstart=`.
 * Windows: PowerShell `StartTime`. Returns undefined when the process is not there or the
 * time cannot be read; callers must then treat the process as unverified.
 */
export async function getProcessStartTime(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  if (platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // The name field may contain spaces and parentheses; the rest starts after the last ")".
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = rest[19]; // field 22 of the file: starttime in clock ticks since boot
      return start && /^\d+$/.test(start) ? `linux:${start}` : undefined;
    } catch {
      return undefined;
    }
  }

  if (platform === 'win32') {
    const output = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
    ]);
    return output && /^\d{4}-\d{2}-\d{2}T/.test(output) ? `win:${output}` : undefined;
  }

  const output = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  return output ? `ps:${output.replace(/\s+/g, ' ')}` : undefined;
}
