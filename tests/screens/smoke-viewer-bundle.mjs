// Live-PWA smoke for the 9/16 viewer bundles (stored report PDFs + view-role modal +
// full-res photo device cache). Usage: node tests/screens/smoke-viewer-bundle.mjs [--headed]
// Uses tests/screens/.profile (Tim's account). Writes nothing to project data: the Storage
// check uploads a tiny PDF under docs/{uid}/_reports/_smoke/ and deletes it again.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const headed = process.argv.includes('--headed');
const out = 'tests/screens/out/viewer-bundle';
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext('tests/screens/.profile', {
  headless: !headed, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark',
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push('[error] ' + m.text().slice(0, 300)); });
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
console.log('new bundle live:', await page.evaluate(() => typeof window.glInfoModal === 'function' && typeof window.phFullCacheStats === 'function'));

// 1. Info modal renders (the view-role / foreign-record message).
await page.evaluate(() => window.glInfoModal('👓 View-only role',
  'You\'re on this project as a <b>Reviewer</b>. Drawings, punch-list flags and their notes are read-only for your role, so this change was <b>not saved</b>.<br><br>Need to edit, or mark work as fixed? Ask the project lead for Inspector access.', 'Got it'));
await wait(600);
await shot('01-info-modal');
await page.evaluate(() => document.querySelector('.modal-overlay[data-confirm] .modal-confirm').click());

// 2. Storage path for stored report PDFs: put → token URL → fetch → delete.
const st = await page.evaluate(async () => {
  const uid = window._currentUser.uid;
  const path = `docs/${uid}/_reports/_smoke/smoke-${Date.now()}.pdf`;
  const blob = new Blob(['%PDF-1.4\n% GroundLog smoke\n'], { type: 'application/pdf' });
  const up = await window.storage.ref(path).put(blob, { contentType: 'application/pdf' });
  const url = await up.ref.getDownloadURL();
  const r = await fetch(url); const txt = await r.text();
  await window.storage.ref(path).delete();
  return { ok: r.ok, bytes: txt.length, type: r.headers.get('content-type') };
});
console.log('storage round-trip:', JSON.stringify(st));

// 3. Full-res photo cache: prefetch open-item originals, then time a lightbox open twice.
await page.evaluate(() => window.phPrefetchOpenItemPhotos(true));
for (let i = 0; i < 20; i++) { await wait(3000); const s = await page.evaluate(() => window.phFullCacheStats()); if (s.photos > 0) { console.log('cache after prefetch:', JSON.stringify(s)); break; } if (i === 19) console.log('cache after prefetch: (still empty)', JSON.stringify(s)); }
const timing = await page.evaluate(async () => {
  const pool = (window._phPhotos || []).filter(p => p.type === 'camera' && p.storageUrl && !p.deletedAt);
  const p = pool[pool.length - 1]; if (!p) return null;
  const t0 = performance.now(); await window.phOpenLightbox(p.id);
  // wait for the stamped full-res to replace the thumb
  const img = document.getElementById('ph-lb-img');
  for (let i = 0; i < 100 && !(img.src || '').startsWith('blob:'); i++) await new Promise(r => setTimeout(r, 100));
  const first = Math.round(performance.now() - t0);
  window.phCloseLightbox();
  await new Promise(r => setTimeout(r, 500));
  const t1 = performance.now(); await window.phOpenLightbox(p.id);
  for (let i = 0; i < 100 && !(img.src || '').startsWith('blob:'); i++) await new Promise(r => setTimeout(r, 100));
  const second = Math.round(performance.now() - t1);
  window.phCloseLightbox();
  return { id: p.id, firstOpenMs: first, secondOpenMs: second };
});
console.log('lightbox full-res timing:', JSON.stringify(timing));
await shot('02-after');
console.log('\nerrors (' + errors.length + '):'); errors.slice(0, 20).forEach(e => console.log('  ' + e));
await ctx.close();
