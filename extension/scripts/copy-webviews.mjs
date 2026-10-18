// Copies the webview pages into dist/. Plain Node (no `sh`, no shell globs) so the build runs the
// same in cmd.exe, PowerShell and a POSIX shell: Windows has no `sh` on the PATH by default.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const extensionDir = path.resolve(import.meta.dirname, '..');
const pages = ['queryBuilder', 'recordViewer', 'scriptRunner', 'schemaDiff', 'recordEditor', 'connectionWizard', 'layoutMode'];

for (const page of pages) {
  const target = path.join(extensionDir, 'dist', 'webviews', page, 'ui');
  mkdirSync(target, { recursive: true });
  cpSync(path.join(extensionDir, 'src', 'webviews', page, 'ui'), target, { recursive: true });
}

// The designer UI build (when present) is laid over the Layout Mode page.
const designerDist = path.resolve(extensionDir, '..', 'designer-ui', 'dist');
if (existsSync(designerDist)) {
  cpSync(designerDist, path.join(extensionDir, 'dist', 'webviews', 'layoutMode', 'ui'), { recursive: true });
}
