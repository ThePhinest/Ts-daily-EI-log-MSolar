// App Store map screenshots at exact device size, label-free satellite style.
// Usage: node tests/screens/capture-map.mjs [iphone|ipad]
// Headed browser; YOU sign in (your own account is fine — no place names are
// rendered with satellite-v9). Then, in the browser window, open the Field Map,
// pan/zoom to the framing you want, open any popup you want visible, and come
// a frame is captured every 12 s until tests/screens/out/STOP exists. Files: tests/screens/out/<device>/map-N.png
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const device = process.argv[2] || 'iphone';
const spec = device === 'ipad'
  ? { width: 1376, height: 1032, dsf: 2 }     // 13" iPad landscape = 2752×2064
  : { width: 440,  height: 956,  dsf: 3 };    // 6.9" iPhone = 1320×2868
const out = `tests/screens/out/${device}`;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: spec.width, height: spec.height },
  deviceScaleFactor: spec.dsf, isMobile: true, hasTouch: true, colorScheme: 'dark',
  geolocation: { latitude: 42.45, longitude: -77.73 }, permissions: ['geolocation'],
});
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem('gl_map_style', 'satellite-v9'); } catch {} });
await page.goto('https://app.groundlog.io/', { waitUntil: 'domcontentloaded' });
console.log(`\n[${device}] Sign in, open the Field Map, frame the shot. A frame is captured every 12 s.`);

// Auto-capture every 12 s until tests/screens/out/STOP exists — frame the map in
// the window between shots; the best frames get picked afterwards.
let n = 0;
while (!fs.existsSync('tests/screens/out/STOP')) {
  await page.waitForTimeout(12000);
  n++;
  const f = `${out}/map-${String(n).padStart(2, '0')}.png`;
  await page.screenshot({ path: f });
  console.log('wrote', f);
}
await browser.close();
