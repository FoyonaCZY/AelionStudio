// Drives the Studio timeline benchmark in a real Chromium.
//
//   node apps/editor-demo/bench/run.mjs [baseline.json]
//
// Starts the Studio dev server, opens the benchmark page, and reports the cost
// of one timeline rebuild at several project sizes. With a saved report as the
// argument, prints the change against it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const SIZES = [100, 500, 1_000, 1_360];
const root = fileURLToPath(new URL('..', import.meta.url));

const server = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname.slice(1),
  root,
  logLevel: 'error',
  server: { port: 4199, strictPort: true },
});
await server.listen();
const port = server.config.server.port;

// Uses the installed Chrome rather than a downloaded build, matching how the
// SDK's own browser suite launches; there is no bundled browser to fetch.
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', error => {
    console.error('page error:', error.message);
  });
  await page.goto(`http://127.0.0.1:${port}/bench/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__timelineBench !== undefined, null, { timeout: 30_000 });
  for (const clips of SIZES) {
    // One throwaway run per size so the first-paint cost is not attributed.
    await page.evaluate(size => window.__timelineBench(size), Math.min(clips, 100));
    results.push(await page.evaluate(size => window.__timelineBench(size), clips));
  }
} finally {
  await browser.close();
  await server.close();
}

const baselinePath = process.argv[2];
const baseline =
  baselinePath === undefined
    ? null
    : new Map(JSON.parse(readFileSync(baselinePath, 'utf8')).map(row => [row.clips, row]));

console.log(
  `clips   rebuild ms   markup KB   clip nodes${baseline === null ? '' : '        change'}`,
);
console.log('-'.repeat(baseline === null ? 46 : 62));
for (const row of results) {
  const line =
    `${String(row.clips).padStart(5)}   ${row.rebuildMs.toFixed(2).padStart(10)}   ` +
    `${(row.markupBytes / 1024).toFixed(0).padStart(9)}   ${String(row.clipNodes).padStart(10)}`;
  const before = baseline?.get(row.clips);
  if (before === undefined) {
    console.log(line);
    continue;
  }
  const factor = before.rebuildMs / row.rebuildMs;
  const label = factor >= 1 ? `${factor.toFixed(2)}x faster` : `${(1 / factor).toFixed(2)}x SLOWER`;
  console.log(`${line}   ${label.padStart(12)}`);
}

const out = process.env.BENCH_OUT;
if (out !== undefined) writeFileSync(out, JSON.stringify(results, null, 2));
