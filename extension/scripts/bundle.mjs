// Usage: node scripts/bundle.mjs <extension|worker>
import { build } from 'esbuild';

import { extensionBundles } from './esbuild-config.mjs';

const name = process.argv[2];
const options = extensionBundles[name];
if (!options) {
  console.error(`[bundle] Unknown bundle "${name}". Use one of: ${Object.keys(extensionBundles).join(', ')}.`);
  process.exit(1);
}

await build(options);
