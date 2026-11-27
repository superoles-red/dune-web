// Browser smoke test for the BYOP shell: ROM -> recompile -> SHA match -> OPFS cache.
// Requires a built bundle (npm install && python3 tools/bundle_web.py) and a local ROM.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/smoke.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.SMOKE_PORT || (4200 + Math.floor(Math.random() * 300)));
const URL = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM ? path.resolve(process.env.DUNE_ROM) : null;
const RESULT_DIR = path.join(ROOT, 'test-results');
const TIMEOUT_MS = 20 * 60 * 1000;

function fail(message) {
  console.error(`smoke FAILED: ${message}`);
  process.exit(1);
}

for (const required of ['web/reference.json', 'web/py-package.zip', 'web/vendor/pyodide/pyodide.asm.wasm']) {
  if (!fs.existsSync(path.join(ROOT, required))) fail(`${required} is missing; run npm install && python3 tools/bundle_web.py`);
}
if (!ROM || !fs.existsSync(ROM)) {
  console.log('smoke SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen to run the browser check');
  process.exit(0);
}
if (!fs.existsSync(CHROME)) fail(`Chrome not found: ${CHROME}`);
fs.mkdirSync(RESULT_DIR, { recursive: true });

const server = spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));

async function waitForServer() {
  let lastError = 'unknown';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode != null) throw new Error(`local server exited with ${server.exitCode}`);
    try {
      const response = await fetch(URL, { cache: 'no-store' });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local server did not start on ${URL}: ${lastError}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const logs = [];
try {
  await waitForServer();
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  page.on('console', (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(() => document.querySelector('#build') && !document.querySelector('#build').disabled, null, { timeout: 60000 });
  await page.click('#build');
  const waitResults = (count) => page.waitForFunction(
    (n) => (window.__BUILD_RESULTS?.length || 0) >= n || (window.__BUILD_ERRORS?.length || 0) > 0,
    count, { timeout: TIMEOUT_MS, polling: 1000 },
  );
  await waitResults(1);
  const first = await page.evaluate(() => window.__BUILD_RESULTS?.[0] ?? null);
  if (!first) throw new Error(`no result from the first build: ${JSON.stringify(await page.evaluate(() => window.__BUILD_ERRORS))}`);

  await page.click('#build');
  await waitResults(2);
  const second = await page.evaluate(() => window.__BUILD_RESULTS?.[1] ?? null);

  await page.screenshot({ path: path.join(RESULT_DIR, 'smoke.png'), fullPage: true });
  const report = { first, second, logs };
  fs.writeFileSync(path.join(RESULT_DIR, 'smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ first, second }, null, 2));

  if (!first.ok) throw new Error(`first build did not match the shipped core: ${first.output_sha256}`);
  if (!second || !second.cached) throw new Error('second build was not served from the OPFS cache');
  console.log('smoke OK');
  process.exitCode = 0;
} catch (error) {
  fs.writeFileSync(path.join(RESULT_DIR, 'smoke.json'), JSON.stringify({ error: String(error), logs }, null, 2) + '\n');
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGKILL');
}
