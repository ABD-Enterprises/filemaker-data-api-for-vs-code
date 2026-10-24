// Inspect the archive that vsce actually produced, including paths filtered by .vscodeignore.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Use vsce's ZIP reader rather than adding a second archive dependency.
const { openPromise } = createRequire(require.resolve('@vscode/vsce/package.json'))('yauzl');

export async function validateVsix(file) {
  const zip = await openPromise(file);
  const entries = new Map();
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('.map')) {
        throw new Error(`VSIX contains a source map: ${entry.fileName}`);
      }
      entries.set(entry.fileName, entry.uncompressedSize);
    }
  } finally {
    zip.close();
  }
  for (const bundle of ['extension.js', 'aiMcpShim.js', 'schemaDiffWorker.js']) {
    if (!entries.has(`extension/dist/${bundle}`)) {
      throw new Error(`VSIX is missing dist/${bundle}`);
    }
  }
  const layoutBytes = entries.get('extension/dist/webviews/layoutMode/ui/index.js') ?? 0;
  if (layoutBytes <= 200 * 1024) {
    throw new Error(`VSIX must contain the real Layout Mode bundle (over 200 KiB); found ${layoutBytes} bytes.`);
  }
}
