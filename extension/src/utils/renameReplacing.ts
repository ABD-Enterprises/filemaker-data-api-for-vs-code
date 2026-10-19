import { chmod, lstat, rename } from 'fs/promises';

/**
 * `rename` that replaces the target, also when the target is a read-only file on Windows.
 *
 * On Unix the folder decides whether a file can be replaced, so a read-only file (mode 0444, which a
 * version-control tool or the user may set) is replaced like any other and the new file keeps whatever
 * mode it was given. On Windows the read-only attribute makes the replacing rename fail with EPERM.
 * Writers here create the new file with the old file's mode first, so the intended result is "new
 * content, still read-only"; this clears the attribute on the target just long enough to replace it,
 * and puts it back if the replacement still fails. A target that is not a read-only regular file (a
 * real permission problem, a folder, a link) keeps the original error.
 */
export async function renameReplacing(source: string, target: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) {
      throw error;
    }
    const existing = await lstat(target).catch(() => undefined);
    if (!existing?.isFile() || (existing.mode & 0o200) !== 0) {
      throw error;
    }
    await chmod(target, existing.mode | 0o200);
    try {
      await rename(source, target);
    } catch (second) {
      await chmod(target, existing.mode & 0o777).catch(() => undefined);
      throw second;
    }
  }
}
