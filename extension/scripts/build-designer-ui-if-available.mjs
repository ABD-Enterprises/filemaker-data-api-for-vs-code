import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Explicit development escape hatch; package validation still requires the real bundle.
const allowFallback = process.env.ALLOW_DESIGNER_UI_FALLBACK === '1';
function unavailable(reason) {
  console.error(`[extension build] ${reason} Set ALLOW_DESIGNER_UI_FALLBACK=1 only to allow a development fallback.`);
  if (allowFallback) rmSync(path.join(designerDir, 'dist'), { recursive: true, force: true });
  process.exit(allowFallback ? 0 : 1);
}

const extensionDir = path.resolve(import.meta.dirname, '..');
const designerDir = path.resolve(extensionDir, '..', 'designer-ui');
const requireFromDesigner = createRequire(path.join(designerDir, 'package.json'));

const requiredModules = ['react', 'react-dom/client', '@fmweb/shared/package.json'];
const missingModules = requiredModules.filter((specifier) => {
  try {
    requireFromDesigner.resolve(specifier);
    return false;
  } catch {
    return true;
  }
});

if (!existsSync(designerDir)) {
  unavailable('The designer-ui workspace is missing.');
}

// Start clean so an old development build (with source maps) can never be copied into the extension.
rmSync(path.join(designerDir, 'dist'), { recursive: true, force: true });

if (missingModules.length > 0) {
  unavailable(
    `Cannot resolve ${missingModules.join(', ')} for the designer-ui bundle. ` +
      'To build it, run "npm ci" at the repository root.'
  );
}

// designer-ui imports the workspace package @fmweb/shared by its built entry (shared/dist). When
// the dependencies are installed but shared has not been built, say that, not "run npm ci".
const sharedDir = path.resolve(designerDir, '..', 'shared');
if (!existsSync(path.join(sharedDir, 'dist', 'index.js'))) {
  unavailable(
    'The shared package has not been built (shared/dist is missing), so the designer-ui bundle cannot resolve @fmweb/shared. ' +
      'Run "npm run build -w shared" (or "npm run build" at the repository root, which builds shared first), then build the extension again.'
  );
}

try {
  // npm.cmd on Windows; shell:false would not find it there.
  execFileSync('npm', ['run', 'build'], { cwd: designerDir, stdio: 'inherit', shell: process.platform === 'win32' });
} catch {
  unavailable(
    'The designer-ui bundle failed to build. Run "npm run build -w designer-ui" at the repository root to see the error.'
  );
}
