// 9/18 bug bundle smoke (no sign-in): precipitation text + the Settings → Camera card body
// rendering on Settings open (no head tap). Run `npx vite preview --port 4173` first.
//   SP=<out dir> node tests/screens/smoke-bundle-0918.mjs
import { chromium } from '@playwright/test';
const SP = process.env.SP;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.glPrecipText === 'function' && typeof window.camSettingsOpen === 'function', null, { timeout: 30000 });
await page.evaluate(() => { document.querySelectorAll('body > *').forEach(el => { const z = +getComputedStyle(el).zIndex; if (z >= 9990) el.style.display = 'none'; }); });
const out = {};

out.precip = await page.evaluate(() => ['0.31', '0', '.5', '1', '', 'Trace', '0.3 in last 24 hr', '0.31 inches (last 24 hours)'].map(v => [v, window.glPrecipText(v)]));

// fresh device: nothing in the collapsed list, so the Camera card starts open
out.camera = await page.evaluate(async () => {
  localStorage.removeItem('pei_collapsed_config');
  const nav = window.showPage || window.switchTab || window.goTo;
  const fn = ['showPage', 'switchTab', 'showTab', 'navTo'].find(n => typeof window[n] === 'function');
  if (fn) { try { window[fn]('config'); } catch (e) { return { fn, err: String(e).slice(0, 200) }; } }
  await new Promise(r => setTimeout(r, 2500));
  const sec = document.getElementById('cfg-camera'), body = document.getElementById('cfg-camera-body');
  return { fn, collapsed: sec.classList.contains('collapsed'), bodyChars: body.innerHTML.length, controls: body.querySelectorAll('input,select,button').length };
});
if (SP) { await page.locator('#cfg-camera').scrollIntoViewIfNeeded().catch(() => {}); await page.locator('#cfg-camera').screenshot({ path: SP + '/0918-camera-card.png' }).catch(e => errors.push('shot: ' + e.message.slice(0, 120))); }

console.log(JSON.stringify({ out, errors }, null, 1));
await browser.close();
