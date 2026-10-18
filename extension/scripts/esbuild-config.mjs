// The one place that says how the shipped bundles are built. `bundle.mjs` runs these builds, and
// `generate-third-party-notices.mjs` runs the same ones (without writing) to learn which
// packages end up inside the extension, so the notices file cannot drift from the bundle.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const extensionDir = path.resolve(import.meta.dirname, '..');

// Build identity embedded in the bundles for FileMaker: About / Show Version. The commit's own date
// (not the wall clock) keeps the same commit building to the same bytes. Outside git, or in a
// source archive, both fall back to 'unknown'.
function gitValue(args) {
  try {
    return execFileSync('git', args, { cwd: extensionDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
export const buildCommit = gitValue(['rev-parse', '--short=9', 'HEAD']);
export const buildDate = gitValue(['log', '-1', '--format=%cs', 'HEAD']);

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
