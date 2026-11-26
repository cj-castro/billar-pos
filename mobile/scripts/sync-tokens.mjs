// Copies the design tokens (source of truth) into the app: Metro cannot import outside the project root.
// Run after editing docs/mobile/design/tokens.json:  node scripts/sync-tokens.mjs
import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../docs/mobile/design/tokens.json');
const dst = resolve(here, '../src/theme/tokens.json');
copyFileSync(src, dst);
console.log(`tokens synced: ${src} -> ${dst}`);
