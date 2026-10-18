import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterAll, describe, expect, it } from 'vitest';

const config = pathToFileURL(path.resolve(__dirname, '../../scripts/esbuild-config.mjs')).href;
const roots: string[] = [];

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env }
  }).trim();
}

/** A repository with one commit made at the given committer date (any timezone offset). */
function makeRepo(committerDate: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-id-'));
  roots.push(dir);
  git(dir, ['init', '-q']);
  mkdirSync(path.join(dir, 'extension'));
  writeFileSync(path.join(dir, 'extension', 'file.txt'), 'a');
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one'], {
    GIT_COMMITTER_DATE: committerDate,
    GIT_AUTHOR_DATE: committerDate
  });
  return dir;
}

afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('build identity (scripts/esbuild-config.mjs)', () => {
  it('uses a 9-character commit and the commit date in UTC, whatever timezone it was made in', async () => {
    const { readBuildIdentity } = (await import(/* @vite-ignore */ config)) as {
      readBuildIdentity: (dir: string, root?: string) => { commit: string; date: string };
    };
    // 23:30 at UTC-5 is already the next day in UTC.
    const repo = makeRepo('2026-01-01T23:30:00-0500');
    const { commit, date } = readBuildIdentity(path.join(repo, 'extension'), repo);
    expect(commit).toBe(git(repo, ['rev-parse', '--short=9', 'HEAD']));
    expect(commit).toMatch(/^[0-9a-f]{9}$/);
    expect(date).toBe('2026-01-02');
    // The same commit read again gives the same answer (deterministic, no wall clock).
    expect(readBuildIdentity(path.join(repo, 'extension'), repo)).toEqual({ commit, date });
  });

  it('marks a tree with changes to tracked files as dirty and ignores untracked files', async () => {
    const { readBuildIdentity } = (await import(/* @vite-ignore */ config)) as {
      readBuildIdentity: (dir: string, root?: string) => { commit: string; date: string };
    };
    const repo = makeRepo('2026-03-04T12:00:00+0000');
    const dir = path.join(repo, 'extension');
    writeFileSync(path.join(dir, 'untracked.txt'), 'x');
    expect(readBuildIdentity(dir, repo).commit).toMatch(/^[0-9a-f]{9}$/);
    writeFileSync(path.join(dir, 'file.txt'), 'changed');
    expect(readBuildIdentity(dir, repo).commit).toMatch(/^[0-9a-f]{9}-dirty$/);
  });

  it("is 'unknown' for a copy that sits inside some other repository, or outside git", async () => {
    const { readBuildIdentity } = (await import(/* @vite-ignore */ config)) as {
      readBuildIdentity: (dir: string, root?: string) => { commit: string; date: string };
    };
    const outer = makeRepo('2026-03-04T12:00:00+0000');
    const tarball = path.join(outer, 'unpacked');
    mkdirSync(path.join(tarball, 'extension'), { recursive: true });
    expect(readBuildIdentity(path.join(tarball, 'extension'), tarball)).toEqual({ commit: 'unknown', date: 'unknown' });
    const plain = mkdtempSync(path.join(tmpdir(), 'no-git-'));
    roots.push(plain);
    mkdirSync(path.join(plain, 'extension'));
    expect(readBuildIdentity(path.join(plain, 'extension'), plain)).toEqual({ commit: 'unknown', date: 'unknown' });
  });

  it('injects both constants into every bundle', async () => {
    const { extensionBundles, buildCommit, buildDate } = (await import(/* @vite-ignore */ config)) as {
      extensionBundles: Record<string, { define: Record<string, string> }>;
      buildCommit: string;
      buildDate: string;
    };
    for (const options of Object.values(extensionBundles)) {
      expect(options.define.__BUILD_COMMIT__).toBe(JSON.stringify(buildCommit));
      expect(options.define.__BUILD_DATE__).toBe(JSON.stringify(buildDate));
    }
  });
});
