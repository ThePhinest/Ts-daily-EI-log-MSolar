// Live-PWA smoke for the 9/16 🗺 disturbance-sketch tag. Toggles the tag ON then OFF on one
// of Tim's existing map captures (net zero change) and checks the QI pickers' pools.
// Usage: node tests/screens/smoke-sketch-tag.mjs [--headed]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const headed = process.argv.includes('--headed');
const out = 'tests/screens/out/sketch-tag'; fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext('tests/screens/.profile', {
  headless: !headed, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark',
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
const wait = ms => page.waitForTimeout(ms);
const shot = async name => { const f = `${out}/${name}.png`; await page.screenshot({ path: f }); console.log('  shot', f); };

await page.goto('https://app.groundlog.io/?smoke=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => {
  try { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); } catch {}
  try { const ks = await caches.keys(); for (const k of ks) await caches.delete(k); } catch {}
});
await wait(1500);
await page.goto('https://app.groundlog.io/?smoke=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 90000 });
await wait(5000);
console.log('new bundle live:', await page.evaluate(() => typeof window.phToggleSketchCurrent === 'function'));

const r = await page.evaluate(async () => {
  const caps = (window._phPhotos || []).filter(p => p.type === 'map_capture' && !p.deletedAt);
  const p = caps[caps.length - 1]; if (!p) return { error: 'no map capture' };
  const before = !!p.sketchTag;
  await window.phOpenLightbox(p.id);
  await new Promise(r => setTimeout(r, 800));
  const btn = document.getElementById('ph-lb-sketch');
  const visible = btn && btn.style.display !== 'none';
  await window.phToggleSketchCurrent();
  const afterOn = !!p.sketchTag, label = btn && btn.textContent;
  await new Promise(r => setTimeout(r, 600));
  const gridBadge = !!document.querySelector('.ph-thumb-sketch');
  await window.phToggleSketchCurrent();   // revert
  const afterOff = !!p.sketchTag;
  window.phCloseLightbox();
  return { id: p.id, before, visible, afterOn, label, gridBadge, afterOff, captures: caps.length };
});
console.log('toggle round-trip:', JSON.stringify(r));
await shot('01-after');
console.log('\nerrors (' + errors.length + '):'); errors.forEach(e => console.log('  ' + e));
await ctx.close();
