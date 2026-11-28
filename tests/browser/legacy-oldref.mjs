// Captures the same screens from the OLD published port (local server) for
// visual comparison with web/legacy/. Reference only; not part of CI.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
const OUT = process.env.OLD_OUT || '/tmp/oldref';
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.OLD_URL || 'http://127.0.0.1:4560/?qa';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US' });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 200)); });
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(2000);
await page.evaluate(() => document.getElementById('qa-modern-panel')?.remove());
await page.waitForFunction(() => window.Module && window.Module._dune_web_campaign_json && window.Module._dune_web_frame_serial?.() > 4, null, { timeout: 180000, polling: 500 });
console.log('engine ready');
await page.waitForFunction(() => document.getElementById('new-campaign') != null, null, { timeout: 90000, polling: 300 }).catch(() => {});
await page.waitForTimeout(2500);
console.log('page alive after ready');
// The ?qa gate keeps the old page out of the install gate; its QA panel covers
// the UI, so drop it (and any later instance) before taking reference shots.
await page.addStyleTag({ content: '#qa-modern-panel{display:none!important}' });
await page.evaluate(() => document.getElementById('qa-modern-panel')?.remove());
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '00-home.png') });
const readJson = (name) => page.evaluate((n) => { try { const p = window.Module[n](); return p ? JSON.parse(window.Module.UTF8ToString(p)) : null; } catch { return null; } }, name);
console.log('home campaign:', JSON.stringify(await readJson('_dune_web_campaign_json')).slice(0, 400));
console.log('home camera:', JSON.stringify(await readJson('_dune_web_camera_debug')));
console.log('buttons:', await page.evaluate(() => [...document.querySelectorAll('#scene-ui button')].filter((b) => b.offsetParent !== null).map((b) => b.id)));
await page.locator('#new-campaign').click({ force: true });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, '02-houses.png') });
await page.locator('#house-1').click({ force: true });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, '03-missions.png') });
await page.locator('#mission-1').click({ force: true });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, '04-confirm.png') });
await page.getByRole('button', { name: 'START', exact: false }).first().click({ force: true });
for (let i = 0; i < 80; i += 1) {
  const st = await page.evaluate(() => { try { const p = window.Module._dune_web_campaign_json(); const c = JSON.parse(window.Module.UTF8ToString(p)); const ids = [...document.querySelectorAll('#scene-ui button')].filter((b) => b.offsetParent !== null).map((b) => b.id).filter(Boolean); return { scene: c.scene, ready: c.sceneReady, armed: c.activeRunArmed, pending: c.pending, ids, phase: c.presentationPhase }; } catch { return {}; } });
  if (st.scene === 'map' && st.ready && st.armed) { console.log('reached map at step', i); break; }
  if (st.ids?.includes('native-yes')) await page.locator('#native-yes').click({ force: true });
  else { const box = await page.locator('#scene-ui').boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6); }
  await page.waitForTimeout(650);
  if (i % 6 === 0) console.log('walk', i, JSON.stringify(st).slice(0, 180));
}
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(OUT, '07-map.png') });
const cam = await readJson('_dune_web_camera_debug');
const ram = await page.evaluate(() => {
  const M = window.Module; const base = 0; // HEAPU8 indexes RAM directly? old core RAM is at fixed offset; use _dune_web_debug to find
  let info = {};
  try { const p = M._dune_web_debug(); info.debug = JSON.parse(M.UTF8ToString(p)); } catch {}
  return info;
});
console.log('map camera:', JSON.stringify(cam));
console.log('debug:', JSON.stringify(ram.debug).slice(0, 500));
// pointer over map + click, then screenshot again (expanded view moves)
const box = await page.locator('#canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.45);
await page.waitForTimeout(500);
await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.45);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, '08-map-click.png') });
console.log('map click camera:', JSON.stringify(await readJson('_dune_web_camera_debug')));
// landscape
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, '09-landscape.png') });
console.log('landscape camera:', JSON.stringify(await readJson('_dune_web_camera_debug')));
// pause menu
await page.evaluate(() => document.getElementById('native-menu')?.click());
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, '10-pause.png') });
console.log('pause campaign:', JSON.stringify(await readJson('_dune_web_campaign_json')).slice(0, 300));
await browser.close();
