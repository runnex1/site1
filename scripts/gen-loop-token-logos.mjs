import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'lib', 'loop-token-logos.js');
const files = {
  USDM: path.join(root, 'public', 'loop-logos', 'usdm.png'),
  JUICED: path.join(root, 'public', 'loop-logos', 'juiced.png'),
};

const entries = Object.entries(files).map(([sym, file]) => {
  const b64 = fs.readFileSync(file).toString('base64');
  return `  ${sym}: "data:image/png;base64,${b64}"`;
});

const body = `/**
 * Pinned loop token logos — embedded PNG data URLs (browser + server).
 */
const LOOP_TOKEN_LOGOS = {
${entries.join(',\n')}
};

function loopTokenLogoDataUrl(symbol) {
  return LOOP_TOKEN_LOGOS[String(symbol || '').toUpperCase()] || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOOP_TOKEN_LOGOS, loopTokenLogoDataUrl };
}
if (typeof window !== 'undefined') {
  window.LoopTokenLogos = { LOOP_TOKEN_LOGOS, loopTokenLogoDataUrl };
}
`;

fs.writeFileSync(out, body);
console.log('wrote', out, fs.statSync(out).size, 'bytes');
