// Live-PWA smoke for the #19 fix: after a COLD map open every KML layer that is toggled on
// must have a source on the map (glMapStats().kml.missingOnMap empty) and features > 0.
// Usage: node tests/screens/smoke-kml-first-open.mjs [--headed]
import { chromium } from '@playwright/test';
const headed = process.argv.includes('--headed');
const ctx = await chromium.launchPersistentContext('tests/screens/.profile', {
  headless: !headed, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark',
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
const wait = ms => page.waitForTimeout(ms);
await page.goto('https://app.groundlog.io/?smoke=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => {
  try { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); } catch {}
  try { const ks = await caches.keys(); for (const k of ks) await caches.delete(k); } catch {}
  // drop the persisted KML parse cache so this is a true cold load through the fetch+parse path
  try { await new Promise(r => { const q = indexedDB.deleteDatabase('gl_kml_geojson'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); } catch {}
});
await wait(1500);
for (const pass of ['cold (fetch + parse)', 'warm (IDB cache)']) {
  await page.goto('https://app.groundlog.io/?smoke=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 90000 });
  await wait(3000);
  await page.evaluate(() => { try { window.showPage('map'); } catch {} });
  await page.waitForFunction(() => !!(window.getMapInstance && window.getMapInstance()), null, { timeout: 120000 });
  await wait(14000);
  const s = await page.evaluate(() => { const m = window.glMapStats(); return { loaders: m.loaders, kml: m.kml }; });
  console.log(pass + ':', JSON.stringify(s));
  const layers = await page.evaluate(() => {
    const map = window.getMapInstance();
    return Array.from(document.querySelectorAll('#map-kml-list input[type=checkbox][onchange^="mapToggleKmlLayerById"]'))
      .filter(cb => cb.checked)
      .map(cb => { const id = cb.getAttribute('onchange').match(/'([^']+)'/)[1]; const src = map.getSource(id); const vis = map.getLayer(id + '-line') ? map.getLayoutProperty(id + '-line', 'visibility') : 'no-layer';
        return { id, hasSource: !!src, lineVisibility: vis || 'visible', label: cb.closest('label,div')?.textContent?.trim().slice(0, 40) }; });
  });
  console.log('  visible KML rows:', JSON.stringify(layers));
}
console.log('errors (' + errors.length + '):'); errors.forEach(e => console.log('  ' + e));
await ctx.close();
