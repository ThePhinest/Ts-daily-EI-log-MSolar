// Run the LOCAL dist/ build under the live origin, signed in as the demo (App Review) account.
// Every request to app.groundlog.io is answered from dist/, service workers are blocked, so the
// page is this checkout's code with the demo profile's real session + Firestore data.
// Read-only by intent: look, screenshot, never save.  Needs `npm run build` first and the
// profile from `node tests/seed-demo.mjs login`.
//   SP=<out dir> node tests/screens/local-build-as-demo.mjs
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
const SP = process.env.SP || 'tests/screens/out';
const DIST = path.resolve('dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.map': 'application/json' };
const ctx = await chromium.launchPersistentContext('tests/screens/.profile-demo', { headless: true, viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
// the profile already holds the live app's service worker: bypass it so page.route sees every request
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.setBypassServiceWorker', { bypass: true });
let served = 0, missed = [];
await page.route('https://app.groundlog.io/**', route => {
  const u = new URL(route.request().url());
  let rel = decodeURIComponent(u.pathname); if (rel === '/' || rel === '') rel = '/index.html';
  const f = path.join(DIST, rel);
  if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) { served++; return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) }); }
  missed.push(rel); return route.fulfill({ status: 404, body: '' });
});
await page.goto('https://app.groundlog.io/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window._currentUser && typeof window.glShowProjectSpace === 'function', null, { timeout: 60000 });
const out = { user: await page.evaluate(() => window._currentUser.email) };
if (out.user !== 'review@groundlog.io') { console.log(JSON.stringify({ refuse: out.user })); await ctx.close(); process.exit(2); }
await page.waitForTimeout(4000);
await page.evaluate(() => { document.querySelectorAll('body > *').forEach(el => { const z = +getComputedStyle(el).zIndex; if (z >= 9990 && !el.classList.contains('modal-overlay')) el.style.display = 'none'; }); /* boot prompts (New day…) are hidden, never tapped */ document.querySelectorAll('.modal-overlay, [id*=newday], [id*=new-day]').forEach(el => { el.style.display = 'none'; }); [...document.querySelectorAll('body *')].filter(el => /NEW DAY DETECTED/i.test(el.textContent) && getComputedStyle(el).position === 'fixed').forEach(el => { el.style.display = 'none'; }); });

// Project Space
await page.evaluate(() => window.glShowProjectSpace());
await page.waitForTimeout(3500);
out.pspace = await page.evaluate(() => ({
  role: document.querySelector('#pspace-head .ps-role')?.textContent || '',
  stats: [...document.querySelectorAll('#pspace-head .ps-stat')].map(x => x.textContent),
  tiles: [...document.querySelectorAll('#pspace-links .more-tile')].map(x => x.textContent.trim()),
  months: [...document.querySelectorAll('#pspace-list .ps-month-head')].map(x => x.textContent),
  weeks: document.querySelectorAll('#pspace-list .ps-week').length,
  rows: document.querySelectorAll('#pspace-list .proj-row').length,
  listText: document.getElementById('pspace-list').textContent.slice(0, 160),
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
fs.mkdirSync(SP, { recursive: true });
await page.screenshot({ path: SP + '/0919-pspace.png', fullPage: true });
// month toggle remembers
out.toggle = await page.evaluate(() => { const h = document.querySelector('#pspace-list .ps-month-head'); if (!h) return null; const b = h.nextElementSibling; const before = b.style.display; h.click(); return { before, after: b.style.display }; });
await page.evaluate(() => { const h = document.querySelector('#pspace-list .ps-month-head'); if (h && h.nextElementSibling.style.display === 'none') h.click(); });
// a tile navigates
out.hasGo = await page.evaluate(() => [typeof window._glPSpaceGo, typeof window.glPSpaceToggleMonth, [...document.scripts].map(x => x.src.split('/').pop()).filter(Boolean).slice(0, 4)]);
out.tileNav = await page.evaluate(async () => { if (typeof window._glPSpaceGo !== 'function') return null; window._glPSpaceGo('config', 'cfg-members'); await new Promise(r => setTimeout(r, 900)); return { page: document.querySelector('.page.active')?.id, membersOpen: !document.getElementById('cfg-members')?.classList.contains('collapsed') }; });

// Resolve-time share box on an UNSHARED open flag (open the sheet, read it, cancel: no write)
out.share = await page.evaluate(async () => {
  const pid = window._activeProjectId ? window._activeProjectId() : null;
  const open = (window.trGetOpenTemporary ? window.trGetOpenTemporary(pid) : []);
  const un = open.find(e => !e.published), pub = open.find(e => e.published);
  const look = async (e) => { if (!e) return null; window.mapResolveTemporary(e.id); await new Promise(r => setTimeout(r, 300)); const ov = document.getElementById('_rfr-ov'); const r = { sheet: !!ov, shareBox: !!document.getElementById('_rfr-share'), checked: document.getElementById('_rfr-share')?.checked }; ov?.querySelector('#_rfr-cancel')?.click(); return r; };
  return { pid, openFlags: open.length, unshared: await look(un), shared: await look(pub) };
});
if (out.share.unshared) { await page.evaluate(() => { const e = window.trGetOpenTemporary(window._activeProjectId()).find(x => !x.published); window.mapResolveTemporary(e.id); }); await page.waitForTimeout(300); await page.screenshot({ path: SP + '/0919-markfixed-share.png' }); await page.evaluate(() => document.querySelector('#_rfr-cancel')?.click()); }
console.log(JSON.stringify({ out, served, missed: missed.slice(0, 8), errors }, null, 1));
await ctx.close();
