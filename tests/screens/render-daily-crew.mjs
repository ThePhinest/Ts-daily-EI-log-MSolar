// 9/18 crew details render (no sign-in): daily report PDF + DOCX with three crew blocks — one
// polished, one falling back to as-typed, one empty (must not print) — plus the precipitation row.
// Run `npx vite preview --port 4173` first.
//   SP=<out dir> CHUNK=<swpppPdf-*.js in dist/assets> node tests/screens/render-daily-crew.mjs
import { chromium } from '@playwright/test';
import fs from 'fs';
const SP = process.env.SP;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.rptCrewDetails === 'function', null, { timeout: 60000 });
await page.evaluate(c => import('/assets/' + c), process.env.CHUNK);
await page.waitForFunction(() => typeof window._glDailyBuildPdf === 'function', null, { timeout: 60000 });
const res = await page.evaluate(async () => {
  const D = '2026-09-18';
  const crewBlocks = [
    { name: 'ABC Earthworks grading crew', time: '7:00 AM to 3:30 PM', location: 'Array 4 north', activities: 'Regraded the access road shoulder and cut two temporary water bars', envCompliance: 'Silt fence intact along the downslope edge', issues: '', notes: 'Stockpile to be seeded Monday' },
    { name: 'Seeding crew', time: '9:00 AM to 2:00 PM', location: 'Laydown 2', activities: 'Hydroseeded 0.4 ac of the laydown perimeter.', envCompliance: '', issues: 'Hose leak at the tank, contained on the pad', notes: '' },
    { name: 'Fence crew', time: '', location: '', activities: '', envCompliance: '', issues: '', notes: '' }
  ];
  const polished = { contractorActivities: 'Contractor personnel attended the morning safety meeting at 6:30 AM, then conducted grading and seeding.', fieldObservationsOpening: 'The EI arrived on site at 6:30 AM. The following activities were observed:', fieldObservationsBullets: ['Grading at Array 4', 'Seeding at Laydown 2'], fieldObservationsClosing: 'No concerns were noted.',
    complianceIssues: [], generalComms: 'None.', lookaheadBullets: ['Seeding'],
    crewDetails: [{ crew: 'ABC Earthworks grading crew', body: 'The crew regraded the access road shoulder and installed two temporary water bars. Silt fence along the downslope edge remained intact. The stockpile is scheduled to be seeded Monday.' }] };
  const logData = { reportDate: D, preparedBy: 'Test Inspector', org: 'Test Org', project: 'Demo Solar', location: 'Anytown', activePhase: 'Mass grading', contractor: 'ABC Earthworks', crewBlocks, weather: { sky: ['Overcast'], tempAM: '58', tempPM: '66', precip: '0.31', wind: 'Light', soilConditions: 'Moist' } };
  const details = window.rptCrewDetails(logData, polished);
  const to64 = blob => new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  window._phPhotos = []; window._phShared = [];
  const b64 = await to64(await window._glDailyBuildPdf(logData, polished, [], {}));
  const d64 = await to64(await window.rptBuildDocx(logData, polished, []));
  const none = window.rptCrewDetails({ crewBlocks: [] }, {}).length + window.rptCrewDetails({}, null).length;
  return { details, b64, d64, none };
});
fs.writeFileSync(SP + '/daily-crew.pdf', Buffer.from(res.b64, 'base64'));
fs.writeFileSync(SP + '/daily-crew.docx', Buffer.from(res.d64, 'base64'));
console.log(JSON.stringify({ details: res.details, none: res.none, errors }, null, 1));
await browser.close();
