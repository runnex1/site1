import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// Clean build for deterministic output.
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copy = (from, to) => {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
};

copy(join(root, 'index.html'), join(dist, 'index.html'));
copy(join(root, 'lib'), join(dist, 'lib'));
copy(join(root, 'public'), join(dist, 'public'));
copy(join(root, 'ui-previews'), join(dist, 'ui-previews'));

console.log('Build complete: dist populated');
