// The one place that says how the shipped bundles are built. `bundle.mjs` runs these builds, and
// `generate-third-party-notices.mjs` runs the same ones (without writing) to learn which
// packages end up inside the extension, so the notices file cannot drift from the bundle.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export const extensionDir = path.resolve(import.meta.dirname, '..');

// Build identity embedded in the bundles for FileMaker: About / Show Version.
//  - commit: `git rev-parse --short=9 HEAD`, with `-dirty` when tracked files differ from HEAD.
//  - date: the commit's UTC date, from its Unix time (`%ct`), so it neither depends on the
//    committer's timezone nor on a git new enough for `%cs`; never the wall clock, so the same
//    commit builds to the same bytes.
// Both are 'unknown' when this is not the root checkout of its own repository (a tarball
// extracted inside some other git repository must not report that repository's commit).
/**
 * True when both paths name the same folder. `realpathSync.native` resolves Windows 8.3 short
 * names (RUNNER~1) and drive-letter case, which git (it prints the long form with forward
 * slashes) and `path.resolve` disagree on; the plain JS realpath does not.
 */
function samePath(a, b) {
  const left = realpathSync.native(a);
  const right = realpathSync.native(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function readBuildIdentity(dir, repoRoot = path.resolve(dir, '..')) {
  const unknown = { commit: 'unknown', date: 'unknown' };
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  try {
    const top = git(['rev-parse', '--show-toplevel']);
    if (!top || !samePath(top, repoRoot)) {
      return unknown;
    }
    const commit = git(['rev-parse', '--short=9', 'HEAD']);
    const seconds = Number(git(['log', '-1', '--format=%ct', 'HEAD']));
    if (!/^[0-9a-f]{9,}$/.test(commit) || !Number.isFinite(seconds) || seconds <= 0) {
      return unknown;
    }
    const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
    return {
      commit: dirty ? `${commit}-dirty` : commit,
      date: new Date(seconds * 1000).toISOString().slice(0, 10)
    };
  } catch {
    return unknown;
  }
}

const identity = readBuildIdentity(extensionDir);
export const buildCommit = identity.commit;
export const buildDate = identity.date;

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  // Production bundle: minified, with an external source map that .vscodeignore keeps out of the
  // VSIX (an inline map made dist/extension.js 6.5 MB). keepNames preserves class and function
  // names that show up in logs and error reports.
  minify: true,
  keepNames: true,
  sourcemap: 'external',
  define: {
    'process.env.NODE_ENV': '"production"',
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
    __BUILD_DATE__: JSON.stringify(buildDate)
  },
  logLevel: 'warning'
};

export const extensionBundles = {
  extension: {
    ...common,
    entryPoints: [path.join(extensionDir, 'src/extension.ts')],
    outfile: path.join(extensionDir, 'dist/extension.js')
  },
  worker: {
    ...common,
    entryPoints: [path.join(extensionDir, 'src/services/schemaDiffWorker.ts')],
    outfile: path.join(extensionDir, 'dist/schemaDiffWorker.js')
  },
  // Stand-alone stdio shim launched by MCP clients (#381); keeps its own target, no vscode.
  aiMcpShim: {
    ...common,
    keepNames: false,
    target: 'node18',
    entryPoints: [path.join(extensionDir, 'src/ai/mcp/shim.ts')],
    outfile: path.join(extensionDir, 'dist/aiMcpShim.js')
  }
};
