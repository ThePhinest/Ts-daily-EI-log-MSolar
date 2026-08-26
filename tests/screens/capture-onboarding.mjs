// App Store screenshot capture — onboarding carousel at exact device sizes.
// Usage: node tests/screens/capture-onboarding.mjs [iphone|ipad]
// Opens a HEADED browser at app.groundlog.io sized like the device; YOU sign in
// (demo account — no real project data on screen); the script then replays the
// onboarding tour slide by slide and writes PNGs to tests/screens/out/<device>/.
// iPhone 6.9" = 1320×2868 (440×956 @3x). iPad 13" = 2064×2752 (1032×1376 @2x).
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const device = process.argv[2] || 'iphone';
const spec = device === 'ipad'
  ? { width: 1032, height: 1376, dsf: 2, mobile: true }
  : { width: 440,  height: 956,  dsf: 3, mobile: true };
const out = `tests/screens/out/${device}`;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: spec.width, height: spec.height },
  deviceScaleFactor: spec.dsf,
  isMobile: spec.mobile,
  hasTouch: true,
  colorScheme: 'dark',
});
const page = await ctx.newPage();
await page.goto('https://app.groundlog.io/', { waitUntil: 'domcontentloaded' });

console.log(`\n[${device}] Sign in as the DEMO account in the browser window. Waiting…`);
await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 0 });
await page.waitForTimeout(4000);

// Replay the tour: obStartTour shows the carousel; obSlide(i) jumps.
const n = await page.evaluate(() => {
  document.getElementById('ob-overlay').classList.add('ob-active');
  window.obStartTour();
  return document.querySelectorAll('#ob-slides .ob-slide').length;
});
console.log(`carousel slides: ${n}`);
for (let i = 0; i < n; i++) {
  await page.evaluate((k) => document.querySelectorAll('.ob-dot')[k].click(), i);
  await page.waitForTimeout(700);
  const f = `${out}/onboarding-${String(i + 1).padStart(2, '0')}.png`;
  await page.screenshot({ path: f, fullPage: false });
  console.log('wrote', f);
}
console.log('Done. Leave the window open if you want to capture more; press Ctrl+C here to close.');
await new Promise(() => {});
