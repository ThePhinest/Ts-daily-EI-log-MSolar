// Live-PWA smoke for the 9/16 map memory bundle (plan-sheet LOD budget,
// sequenced map open, persisted KML parse cache).
// Usage: node tests/screens/smoke-map-memory.mjs [--headed]
// Uses the persistent profile at tests/screens/.profile (Tim's account, already
// signed in). Restores every plan sheet's visibility exactly as it found it.
// Output: tests/screens/out/map-memory/*.png + a JSON summary on stdout.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const headed = process.argv.includes('--headed');
const out = 'tests/screens/out/map-memory';
fs.mkdirSync(out, { recursive: true });

const ctx = await chromium.launchPersistentContext('tests/screens/.profile', {
  headless: !headed,
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark',
  geolocation: { latitude: 42.39, longitude: -77.70 }, permissions: ['geolocation'],
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));

const wait = ms => page.waitForTimeout(ms);
const stats = async () => page.evaluate(() => (typeof window.glMapStats === 'function') ? window.glMapStats() : null);
const shot = async name => { const f = `${out}/${name}.png`; await page.screenshot({ path: f }); console.log('  shot', f); };

// 1. Load with a fresh service worker (the persistent profile keeps the old bundle).
await page.goto('https://app.groundlog.io/?smoke=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => { try { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); } catch {} });
await wait(4000);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 90000 });
await wait(4000);
const hasNew = await page.evaluate(() => typeof window.glMapStats === 'function');
console.log('new bundle live:', hasNew);
if (!hasNew) {
  // one more SW cycle
  await page.evaluate(async () => { try { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); } catch {} });
  await wait(6000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 90000 });
  await wait(4000);
  console.log('new bundle live (retry):', await page.evaluate(() => typeof window.glMapStats === 'function'));
}

// 2. Open the map and let the sequenced loaders run.
await page.evaluate(() => { try { window.showPage('map'); } catch (e) { console.log(e); } });
await page.waitForFunction(() => !!(window.getMapInstance && window.getMapInstance()), null, { timeout: 120000 });
await wait(14000);
let s0 = await stats();
console.log('after open:', JSON.stringify(s0));
await shot('01-open');

// Snapshot the sheet visibility so we can restore it exactly.
const sheetsVis = await page.evaluate(() => window._poDebugSheets().map(s => ({ id: s.id, on: s.visible })));
console.log('sheet visibility before:', JSON.stringify(sheetsVis));

// 3. Turn every sheet on (the 9/15 field scenario) — previews build serially.
await page.evaluate(() => window.poToggleAll(true));
for (let i = 0; i < 24; i++) { await wait(5000); const s = await stats(); if (s && s.sheets && (s.sheets.mountedFull + s.sheets.mountedPreview) >= s.sheets.visible) break; }
let s1 = await stats();
console.log('all on:', JSON.stringify(s1.sheets));
await shot('02-all-on');

// 4. Zoom into the first visible sheet's centre well past its detail zoom → HD.
await page.evaluate(() => {
  const m = window.getMapInstance();
  const sh = window._poDebugSheets().filter(s => s.visible);
  const s = sh[Math.floor(sh.length / 2)] || sh[0];
  if (s) { const c = s.corners; m.jumpTo({ center: [c.reduce((a, p) => a + p[0], 0) / 4, c.reduce((a, p) => a + p[1], 0) / 4], zoom: 17.5 }); }
  else m.jumpTo({ zoom: 17.5 });
});
await wait(4000);
let s2 = await stats();
console.log('zoom 17.5:', JSON.stringify(s2.sheets));
await shot('03-zoom-17-5');

// 5. Zoom out to 13 → everything back to lite.
await page.evaluate(() => window.getMapInstance().jumpTo({ zoom: 13 }));
await wait(4000);
let s3 = await stats();
console.log('zoom 13:', JSON.stringify(s3.sheets));
await shot('04-zoom-13');

// 6. Wait for preview uploads to finish (owner stamps previewUrl on each sheet), then restore visibility.
for (let i = 0; i < 24; i++) {
  const a = await stats(); await wait(3000); const b = await stats();
  if (a && b && a.sheets.previewsBuilt === b.sheets.previewsBuilt && a.sheets.mountedFull + a.sheets.mountedPreview >= a.sheets.visible) break;
}
await wait(5000);
for (const sv of sheetsVis) { await page.evaluate(([id, on]) => window.poToggleSheet(id, on), [sv.id, sv.on]); await wait(150); }
await wait(3000);
const after = await page.evaluate(() => window._poDebugSheets().map(s => ({ id: s.id, on: s.visible })));
const restored = JSON.stringify(after) === JSON.stringify(sheetsVis);
console.log('visibility restored:', restored);
let s4 = await stats();
console.log('final:', JSON.stringify(s4));
await shot('05-restored');

// 7. Reload → the KML cache + previews should make the second open cheap.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 90000 });
await wait(3000);
await page.evaluate(() => { try { window.showPage('map'); } catch {} });
await page.waitForFunction(() => !!(window.getMapInstance && window.getMapInstance()), null, { timeout: 120000 });
await wait(12000);
let s5 = await stats();
console.log('second open:', JSON.stringify(s5));
await shot('06-second-open');

console.log('\nconsole errors/warnings (' + errors.length + '):');
errors.slice(0, 40).forEach(e => console.log('  ' + e));
await ctx.close();
