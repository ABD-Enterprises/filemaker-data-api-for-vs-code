// Copies the webview pages into dist/. Plain Node (no `sh`, no shell globs) so the build runs the
// same in cmd.exe, PowerShell and a POSIX shell: Windows has no `sh` on the PATH by default.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, transform } from 'esbuild';

const extensionDir = path.resolve(import.meta.dirname, '..');
const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(extensionDir, 'dist');
const pages = ['queryBuilder', 'recordViewer', 'scriptRunner', 'schemaDiff', 'recordEditor', 'connectionWizard', 'layoutMode'];

// Bundle only the dependency-free presentation module, not React or the layout schema.
const standards = await build({ entryPoints: [path.resolve(extensionDir, '../shared/src/field-standards.ts')],
  bundle: true, platform: 'browser', format: 'esm', write: false });
const moduleText = standards.outputFiles[0].text;
const { standardFieldsCss } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`);
const browserStandards = await transform(moduleText, { format: 'iife', globalName: 'FieldStandards' });

for (const page of pages) {
  const target = path.join(outputDir, 'webviews', page, 'ui');
  mkdirSync(target, { recursive: true });
  cpSync(path.join(extensionDir, 'src', 'webviews', page, 'ui'), target, { recursive: true });
  if (['queryBuilder', 'recordEditor', 'recordViewer'].includes(page)) {
    writeFileSync(path.join(target, 'fieldStandards.js'), browserStandards.code);
    writeFileSync(path.join(target, 'fieldStandards.css'), standardFieldsCss());
  }
}

// The designer UI build (when present) is laid over the Layout Mode page.
const designerDist = path.resolve(extensionDir, '..', 'designer-ui', 'dist');
if (existsSync(designerDist)) {
  cpSync(designerDist, path.join(outputDir, 'webviews', 'layoutMode', 'ui'), { recursive: true });
}
