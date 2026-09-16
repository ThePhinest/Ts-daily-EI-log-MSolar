import { chromium } from '@playwright/test';
import fs from 'fs';
const SP = process.env.SP;
const imgs = JSON.parse(fs.readFileSync(SP + '/fixture_imgs.json', 'utf8'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window._rptMergeCompliance === 'function', null, { timeout: 60000 });
await page.evaluate(c => import('/assets/' + c), process.env.CHUNK);   // the PDF module is lazy — pull it in directly
await page.waitForFunction(() => typeof window._glDailyBuildPdf === 'function' && typeof window._rptMergeCompliance === 'function', null, { timeout: 60000 });
const res = await page.evaluate(async (imgs) => {
  const D = '2026-09-16';
  const ph = (id, cap, url) => ({ id, date: D, caption: cap, thumb: url, type: 'library', uploadedAt: 1 });
  const photoRefs = [ph('p_obs', 'Sediment at the W45 edge', imgs.obs), ph('p_s1a', 'Sediment retrieved from wetland', imgs.s1a), ph('p_s1b', 'SSF repaired at W45', imgs.s1b), ph('p_s2a', 'Tree line SSF backfilled', imgs.s2a), ph('p_day', 'Access road stoned (day photo, not a CMP photo)', imgs.day)];
  const compEntries = [
    { id: 'e1', cmpNum: 21, level: '3', location: 'LD13, W45 / W45 was receiving turbid discharge.', corrective: 'Install water bars above W45. Backfill SF above/adjacent to wetland, ensure backfill gets tamped in to prevent future erosion. All sediment located in resources should be cleaned up and brought back within the LOD. Corrective activity must begin within 24 hours to maintain compliance.', status: 'Resolved', dateResolved: '9/15/26', photoIds: ['p_obs'],
      steps: [{ id: 's1', date: '2026-09-12', text: 'Contractor retrieved sediment from within wetland with shovels and buckets. They also repaired the SSF at this location. SSF in upslope treeline needs to be backfilled and repaired.', photoIds: ['p_s1a', 'p_s1b'] },
              { id: 's2', date: '2026-09-14', text: 'No sediment observed in wetland. SSF upslope in treeline needs to be backfilled and repaired, and siderails installed to close this item.', photoIds: [] },
              { id: 's3', date: '2026-09-15', text: 'Repaired upslope SSF, cleaned sediment, installed siderails and wattles. COMPLETED', photoIds: ['p_s2a'] }] },
    { id: 'e2', cmpNum: 24, level: '1', location: 'TX 11.A.4 / silt fence undermined at the low corner', corrective: 'Re-trench and backfill the silt fence at the low corner; add a compost sock j hook.', status: 'Open', photoIds: [], steps: [] }
  ];
  const polished = { contractorActivities: 'Supreme regraded TX 11.A.4 and cut temporary water bars.', fieldObservationsOpening: 'Field observations opening.', fieldObservationsBullets: ['Bullet one', 'Bullet two'], fieldObservationsClosing: 'Closing.', agencyInspection: 'None.',
    complianceIssues: [{ level: 'Level 3', description: 'CMP-21 — LD13, W45 — W45 was receiving turbid discharge.', corrective: 'Install water bars above W45; backfill SF above and adjacent to the wetland, ensuring backfill is tamped in to prevent future erosion. All sediment located in resources should be cleaned up and brought back within the LOD. Corrective activity must begin within 24 hours to maintain compliance.', status: 'Resolved' },
                       { level: 'Level 1', description: 'TX 11.A.4 — silt fence undermined at the low corner', corrective: 'Re-trench and backfill the silt fence at the low corner; add a compost sock j hook.', status: 'Open' }],
    generalComms: 'None.', lookaheadBullets: ['Seeding'] };
  const logData = { reportDate: D, preparedBy: 'Tim Shortz', org: 'Stantec', project: 'Moraine Solar Energy Center', activePhase: 'Mass grading', contractor: 'Supreme / ProSeed', weather: { sky: ['Overcast'], tempAM: '58', tempPM: '66', precip: 'None', wind: 'Light', soilConditions: 'Moist' } };
  const merged = window._rptMergeCompliance(polished, { compEntries });
  const blob = await window._glDailyBuildPdf(logData, merged, photoRefs, { compPhotoRefs: photoRefs });
  const b64 = await new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  window._phPhotos = photoRefs; window._phShared = [];
  const dblob = await window.rptBuildDocx(logData, merged, photoRefs);
  const d64 = await new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result.split(',')[1]); fr.readAsDataURL(dblob); });
  return { d64, b64, rows: merged.complianceIssues.map(r => ({ cmpId: r.cmpId, steps: (r.steps || []).length, obs: (r.obsIds || []).length, photoIds: (r.photoIds || []).length })) };
}, imgs);
fs.writeFileSync(SP + '/daily-test.pdf', Buffer.from(res.b64, 'base64'));
fs.writeFileSync(SP + '/daily-test.docx', Buffer.from(res.d64, 'base64'));
console.log('rows:', JSON.stringify(res.rows));
console.log('errors (' + errors.length + '):'); errors.forEach(e => console.log('  ' + e));
await browser.close();
