import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  process.exit(0);
}

// Start clean so an old development build (with source maps) can never be copied into the extension.
rmSync(path.join(designerDir, 'dist'), { recursive: true, force: true });

if (missingModules.length > 0) {
  // A checkout where only extension/ was installed has no designer-ui dependencies. The extension
  // still works (Layout Mode uses its built-in fallback UI), so this is a warning, not a failure.
  console.warn(
    `[extension build] Skipping the designer-ui bundle (cannot resolve ${missingModules.join(', ')}); ` +
      'Layout Mode will use the built-in fallback UI. To build it, run "npm ci" at the repository root.'
  );
  process.exit(0);
}

try {
  // npm.cmd on Windows; shell:false would not find it there.
  execFileSync('npm', ['run', 'build'], { cwd: designerDir, stdio: 'inherit', shell: process.platform === 'win32' });
} catch {
  // The dependencies are installed, so a failure here is a real build problem. Say what to try,
  // and fail: a release must not silently ship the fallback UI.
  console.error(
    '[extension build] The designer-ui bundle failed to build. Run "npm ci" at the repository root ' +
      '(it links the @fmweb/shared workspace package), then "npm run build -w designer-ui" to see the error.'
  );
  process.exit(1);
}
