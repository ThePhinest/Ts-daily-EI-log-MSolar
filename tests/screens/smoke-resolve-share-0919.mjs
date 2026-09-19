// 9/19 resolve-time share (no sign-in): the two "fixed / resolved" sheets still open and close
// cleanly. Without sign-in there is no shared project, so the share checkbox must NOT render;
// the checkbox itself is verified live by Tim on a shared project.
// Run `npx vite preview --port 4173` first.   node tests/screens/smoke-resolve-share-0919.mjs
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.clSubmitForm === 'function' && typeof window.trSaveEntry === 'function' && typeof window.mapResolveTemporary === 'function', null, { timeout: 30000 });
await page.evaluate(() => { document.querySelectorAll('body > *').forEach(el => { const z = +getComputedStyle(el).zIndex; if (z >= 9990) el.style.display = 'none'; }); });
const out = {};

// compliance: new entry saved as Resolved -> correction-photo sheet, no share box, Skip closes it
out.cmp = await page.evaluate(async () => {
  window.clShowForm();
  await new Promise(r => setTimeout(r, 400));
  document.getElementById('cl-f-location').value = 'ST13';
  const st = document.getElementById('cl-f-status'); if (st) st.value = 'Resolved';
  window.clSubmitForm();
  await new Promise(r => setTimeout(r, 600));
  const sheet = [...document.querySelectorAll('.modal-overlay')].find(o => /Document the fix/.test(o.textContent));
  const r = { statusField: !!st, sheet: !!sheet, shareBox: !!document.getElementById('cl-cp-share') };
  if (sheet) { sheet.querySelector('#cl-cp-skip').click(); await new Promise(x => setTimeout(x, 100)); r.closed = !document.body.contains(sheet); }
  return r;
});

// flag: a temporary entry -> Mark fixed sheet, no share box, Fixed resolves it
out.flag = await page.evaluate(async () => {
  const e = window.trSaveEntry({ id: 'smoke_flag_0919', temporary: true, tempStatus: 'open', label: 'smoke', geometry: { type: 'Point', coordinates: [-77.7, 42.4] }, projectId: 'default' }, 'default');
  if (!e) return { saved: false };
  window.mapResolveTemporary('smoke_flag_0919');
  await new Promise(r => setTimeout(r, 200));
  const ov = document.getElementById('_rfr-ov');
  const r = { saved: true, sheet: !!ov, shareBox: !!document.getElementById('_rfr-share') };
  if (ov) { ov.querySelector('#_rfr-ok').click(); await new Promise(x => setTimeout(x, 400)); }
  const after = (window.trGetEntriesForProject('default') || []).find(x => x.id === 'smoke_flag_0919');
  r.tempStatus = after && after.tempStatus;
  r.fixPhotoSheet = [...document.querySelectorAll('.modal-overlay')].some(o => /Document the fix/.test(o.textContent));
  return r;
});
console.log(JSON.stringify({ out, errors }, null, 1));
await browser.close();
