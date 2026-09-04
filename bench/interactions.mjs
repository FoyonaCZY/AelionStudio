// Times Studio's per-frame and per-pointer-move work in a real Chromium.
//   node apps/editor-demo/bench/interactions.mjs [baseline.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const SIZES = [100, 500, 1_000];
const root = fileURLToPath(new URL('..', import.meta.url));

const server = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname.slice(1),
  root,
  logLevel: 'error',
  server: { port: 4197, strictPort: true },
});
await server.listen();

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const rows = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', error => console.error('page error:', error.message));
  await page.goto(`http://127.0.0.1:${server.config.server.port}/bench/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__interactionBench !== undefined, null, { timeout: 30_000 });
  for (const clips of SIZES) {
    rows.push(...(await page.evaluate(size => window.__interactionBench(size), clips)));
  }
} finally {
  await browser.close();
  await server.close();
}

const names = [...new Set(rows.map(row => row.name))];
const sizes = [...new Set(rows.map(row => row.clips))].sort((a, b) => a - b);
const baselinePath = process.argv[2];
const baseline = baselinePath === undefined ? null : new Map(
  JSON.parse(readFileSync(baselinePath, 'utf8')).map(row => [`${row.name}@${row.clips}`, row.ms]),
);

const width = Math.max(...names.map(n => n.length));
const head = sizes.map(s => `${s} clips`.padStart(12)).join('');
console.log(`${'interaction'.padEnd(width)}${head}${baseline ? '      4k change' : ''}`);
console.log('-'.repeat(width + head.length + (baseline ? 16 : 0)));
for (const name of names) {
  const cells = sizes
    .map(size => {
      const row = rows.find(r => r.name === name && r.clips === size);
      return (row === undefined ? '-' : row.ms.toFixed(3)).padStart(12);
    })
    .join('');
  let change = '';
  if (baseline !== null) {
    const biggest = sizes.at(-1);
    const now = rows.find(r => r.name === name && r.clips === biggest)?.ms;
    const before = baseline.get(`${name}@${biggest}`);
    if (now !== undefined && before !== undefined) {
      const factor = before / now;
      change = (factor >= 1 ? `${factor.toFixed(2)}x faster` : `${(1 / factor).toFixed(2)}x SLOWER`).padStart(16);
    }
  }
  console.log(`${name.padEnd(width)}${cells}${change}`);
}

const out = process.env.BENCH_OUT;
if (out !== undefined) writeFileSync(out, JSON.stringify(rows, null, 2));
