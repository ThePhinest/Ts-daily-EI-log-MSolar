// 9/17 bug bundle smoke (no sign-in): chips row, multi-select picker, Camera settings card,
// KML table popup, tracker needs-info list. Run `npx vite preview --port 4173` first.
//   SP=<out dir> node tests/screens/smoke-bundle-0917.mjs
import { chromium } from '@playwright/test';
import fs from 'fs';
const SP = process.env.SP;
const maps = fs.readFileSync(new URL('../../src/maps.js', import.meta.url), 'utf8');
const a = maps.indexOf('function _kmlDescToHtml(raw){');
const b = maps.indexOf('function _kmlWirePointPopup', a);
const kmlFn = maps.slice(a, b);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.glPick === 'function' && typeof window.trShowNeedsInfo === 'function' && typeof window.camSettingsOpen === 'function', null, { timeout: 60000 });
// hide the sign-in gate and anything else sitting on top
await page.evaluate(() => { document.querySelectorAll('body > *').forEach(el => { const z = +getComputedStyle(el).zIndex; if (z >= 9990) el.style.display = 'none'; }); });
const out = {};

// BB4 — KML table popup
out.kml = await page.evaluate((src) => {
  const fn = new Function(src + '; return _kmlDescToHtml;')();
  const raw = '<table><tr><td colspan="2"><b>Volusia channery silt loam, 8 to 15 percent slopes</b><br></td></tr><tr><td colspan="2"><br><b>RUNOFF AND DRAINAGE</b></td></tr><tr><td>Hydrologic soil group: </td><td><b>D</b></td></tr><tr><td>Drainage class: </td><td><b>Somewhat poorly drained</b></td></tr><tr><td colspan="2"><br><b>TOPSOIL AND AGRICULTURE</b></td></tr><tr><td>Native topsoil depth: </td><td><b>about 9 in (Ap)</b></td></tr><tr><td>Restrictive layer: </td><td><b>Fragipan at about 17 in</b></td></tr><tr><td>Evil</td><td><img src=x onerror="window.__xss=1"><script>window.__xss=1</script>ok</td></tr></table>';
  const html = fn(raw);
  const d = document.createElement('div');
  d.id = '_t-kml'; d.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;z-index:99999;background:#1b1b1b;border-radius:10px;padding:12px;font-size:11.5px;line-height:1.5;color:#cfcfcf';
  d.innerHTML = '<div style="font-weight:700;font-size:13px;margin-bottom:4px;color:#fff">68C</div>' + html;
  document.body.appendChild(d);
  const plain = fn('Line one<br>Line two &amp; more');
  return { rows: (html.match(/display:flex/g) || []).length, heads: (html.match(/letter-spacing/g) || []).length, hasTag: /<img|<script/i.test(html), plain };
}, kmlFn);
await page.waitForTimeout(300);
out.kml.xss = await page.evaluate(() => !!window.__xss);
await page.locator('#_t-kml').screenshot({ path: SP + '/bb4-kml-popup.png' });
await page.evaluate(() => document.getElementById('_t-kml').remove());

// BB1 — chips row
await page.evaluate(() => {
  const d = document.createElement('div');
  d.id = '_t-row'; d.style.cssText = 'position:fixed;left:10px;top:20px;width:400px;z-index:99999;background:var(--bg,#121212);padding:8px';
  d.innerHTML = `<div class="proj-row"><div class="proj-row-info"><div class="proj-row-name gl-sub-name"><span>Wed, Sep 16, 2026</span> <span class="gl-role-chip">v2</span> <span class="gl-role-chip" style="color:var(--amber,#C9A84C)">⏳ review</span></div><div class="proj-row-meta">Tim Shortz · 9/16/2026, 2:32 PM</div></div><span>›</span></div>
    <div class="proj-row"><div class="proj-row-info"><div class="proj-row-name"><span>OLD MARKUP</span> <span class="gl-role-chip">v2</span> <span class="gl-role-chip">⏳ review</span></div><div class="proj-row-meta">before the fix</div></div><span>›</span></div>`;
  document.body.appendChild(d);
});
await page.locator('#_t-row').screenshot({ path: SP + '/bb1-chips.png' });
out.chips = await page.evaluate(() => { const n = document.querySelector('#_t-row .gl-sub-name'), c = n.querySelector('.gl-role-chip'); const r = n.getBoundingClientRect(), k = c.getBoundingClientRect(); return { chipInsideName: k.bottom <= r.bottom + 0.5 && k.top >= r.top - 0.5, overflow: getComputedStyle(n).overflow }; });
await page.evaluate(() => document.getElementById('_t-row').remove());

// BB2 — multi-select picker
await page.evaluate(() => {
  window.__picked = null;
  window.glPick({ title: 'Active contractors today', multi: true, selected: ['Supreme Industries'], onPickMany: v => { window.__picked = v; },
    rows: [{ value: 'Herzog', label: 'Herzog', sub: 'EPC, management', meta: 'on site', accent: true }, { value: 'Supreme Industries', label: 'Supreme Industries', sub: 'Grading and dirt work', meta: 'on site', accent: true }, { value: 'ProSeed', label: 'ProSeed', sub: 'Seeding and restoration', meta: '' }] });
});
await page.locator('.gl-pick-row[data-v="ProSeed"]').click();
await page.locator('.gl-pick-row[data-v="Herzog"]').click();
await page.locator('.gl-pick-row[data-v="Herzog"]').click();   // untick again
await page.locator('.modal-box').last().screenshot({ path: SP + '/bb2-picker.png' });
await page.locator('.gl-pick-done').click();
out.picked = await page.evaluate(() => window.__picked);

// BB3 — Camera settings card
await page.evaluate(() => {
  const sec = document.getElementById('cfg-camera');
  let n = sec; while (n && n !== document.body) { n.style.display = 'block'; n.classList.remove('collapsed'); n = n.parentElement; }
  document.querySelectorAll('.page').forEach(p => { if (p.contains(sec)) { p.classList.add('active'); p.style.display = 'block'; } });
});
await page.evaluate(() => window.camSettingsOpen());
await page.waitForFunction(() => document.querySelectorAll('#cfg-camera-body input[type=checkbox]').length > 0, null, { timeout: 30000 });
await page.evaluate(() => window.camSettingsSet('autosave', 'stamped'));
await page.evaluate(() => window.camSettingsSet('stamp', 'brand', false));
out.cam = await page.evaluate(() => ({ autosave: localStorage.getItem('gl_cam_autosave'), stamp: localStorage.getItem('gl_cam_stamp'), boxes: document.querySelectorAll('#cfg-camera-body input[type=checkbox]').length }));
await page.locator('#cfg-camera').screenshot({ path: SP + '/bb3-camera.png' }).catch(e => errors.push('cam shot: ' + e.message.slice(0, 120)));

// BB5 — needs-info list
await page.evaluate(() => {
  window._phPhotos = [{ id: 'ph_flagged', seedTag: true }];
  const E = (o) => Object.assign({ categoryId: 'c1', categoryName: 'Stabilization', date: '2026-09-14', measurementValue: 0.43, measurementUnit: 'ac', entryType: 'installed' }, o);
  window.trGetEntriesForProject = () => [
    E({ id: 'e1', location: 'Array 3 north slope', applications: [{ type: 'seed', product: 'Upland mix', rate: 35, actual: 15 }], photoIds: ['p1'], photoTypes: { p1: 'general' } }),
    E({ id: 'e2', location: 'Has its tag (typed)', applications: [{ type: 'seed', product: 'Upland mix', rate: 35 }], photoIds: ['p2'], photoTypes: { p2: 'material_tag' } }),
    E({ id: 'e3', location: 'Has its tag (photo flagged)', applications: [{ type: 'seed', product: 'Upland mix', rate: 35 }], photoIds: ['ph_flagged'] }),
    E({ id: 'e4', location: 'TX 11.A.4', date: '2026-09-12', applications: [{ type: 'lime', rate: 2, rateUnit: 'tons/ac' }], photoIds: ['p4'] }),
    E({ id: 'e5', location: 'Laydown 2', date: '2026-09-10', applications: [{ type: 'fertilizer', product: '10-20-20' }], photoIds: [] }),
    E({ id: 'e6', location: 'Planned seeding', entryType: 'planned', applications: [{ type: 'seed', product: 'x', rate: 1 }] }),
    E({ id: 'e7', location: 'Plain silt fence, no photos', categoryName: 'Silt Fence', applications: [] }),
  ];
  window.trShowNeedsInfo();
});
out.needs = await page.evaluate(() => Array.from(document.querySelectorAll('._trni-row')).map(r => r.getAttribute('data-id')));
await page.locator('#_tr-needs-info .modal-box').screenshot({ path: SP + '/bb5-needs-info.png' });
await page.locator('#_trni-ph').check();
out.needsWithPhotos = await page.evaluate(() => Array.from(document.querySelectorAll('._trni-row')).map(r => r.getAttribute('data-id')));

console.log(JSON.stringify(out, null, 1));
console.log('errors (' + errors.length + '):'); errors.forEach(e => console.log('  ' + e));
await browser.close();
