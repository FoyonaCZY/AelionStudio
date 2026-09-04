// Boots Studio in a real Chromium and reports anything the console or the page
// complains about while it starts.
//
//   node apps/editor-demo/bench/smoke.mjs
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname.slice(1),
  root,
  logLevel: 'error',
  server: { port: 4198, strictPort: true },
});
await server.listen();

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('response', response => {
    if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`);
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location();
    problems.push(
      `console: ${message.text()}${location.url.length === 0 ? '' : ` (${location.url})`}`,
    );
  });
  await page.goto(`http://127.0.0.1:${server.config.server.port}/`, { waitUntil: 'load' });
  // Studio opens on its home screen, where the timeline exists but is hidden.
  await page.waitForSelector('#timeline', { state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(3_000);
  const shell = await page.evaluate(() => ({
    timeline: document.querySelector('#timeline') !== null,
    status: document.querySelector('#status')?.textContent ?? '',
    tracks: document.querySelectorAll('.track-row').length,
  }));
  console.log('shell:', JSON.stringify(shell));
} finally {
  await browser.close();
  await server.close();
}

if (problems.length === 0) {
  console.log('no console or page errors during boot');
} else {
  console.log(`${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 12)) console.log(`  ${problem}`);
  process.exitCode = 1;
}
