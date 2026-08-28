import { chromium } from '@playwright/test';
const prof = process.argv[2];
const ctx = await chromium.launchPersistentContext(prof, { headless: true, viewport:{width:440,height:956}, deviceScaleFactor:2, isMobile:true, hasTouch:true, colorScheme:'dark' });
const page = await ctx.newPage();
await page.goto('https://app.groundlog.io/', { waitUntil: 'load' });
await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 60000 });
await page.waitForTimeout(8000);
for (const pg of ['log','projectSpace']) {
  await page.evaluate(p => showPage(p), pg); await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const sr = document.getElementById('scroll-root');
    const kids = [...document.body.children].filter(e => e.offsetParent !== null || e.id==='scroll-root').map(e => { const b = e.getBoundingClientRect(); return `${e.tagName.toLowerCase()}#${e.id} y=${Math.round(b.top)} h=${Math.round(b.height)} pos=${getComputedStyle(e).position}`; });
    return { vh: innerHeight, bodyH: document.body.getBoundingClientRect().height, srClient: sr.clientHeight, srScrollH: sr.scrollHeight, srTop: Math.round(sr.getBoundingClientRect().top), canScroll: sr.scrollHeight > sr.clientHeight, kids };
  });
  console.log(prof, pg, JSON.stringify(r, null, 1));
}
await ctx.close();
