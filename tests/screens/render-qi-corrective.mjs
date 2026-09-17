// 9/17: renders the QI report §8 (Corrective Actions) from fixture rows → PDF + DOCX, no sign-in.
// Run `npx vite preview --port 4173` first;  SP=<out dir> CHUNK=swpppPdf-<hash>.js node tests/screens/render-qi-corrective.mjs
import { chromium } from '@playwright/test';
import fs from 'fs';
const SP = process.env.SP;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.swCaCells === 'function' && typeof window._glSwpppBuildDocx === 'function', null, { timeout: 60000 });
await page.evaluate(c => import('/assets/' + c), process.env.CHUNK);   // the PDF module is lazy — pull it in directly
await page.waitForFunction(() => typeof window._glSwpppBuildPdf === 'function', null, { timeout: 60000 });
const res = await page.evaluate(async () => {
  const cfg = {
    formType: 'swppp-qi-inspection', version: 1, projectTitle: 'Ridgeline Solar Energy Center', projectName: 'Ridgeline Solar Energy Center',
    header: { inspectorName: 'Alex Rivera', roleCredential: 'Qualified Inspector (CPESC)', organization: 'Ridgeline Environmental LLC', spdesPermit: 'GP-0-20-001', swtNumber: 'NYR11X999', swptsId: 'Ridgeline-Demo' },
    drainageAreas: [{ id: 'DA-1', desc: 'Laydown yard, drains south' }], drainageAreasNote: '',
    dischargePoints: [{ id: 'DP-1', location: 'South roadside ditch outlet', receiving: 'Unnamed tributary (Class C)' }], dischargePointsNote: '',
    waterbodies: [], bmps: [{ name: 'Silt fence', location: 'South perimeter' }], pollutionSources: ['Dust'], pollutionNote: '', smps: [],
    correctiveNote: 'Open items carry forward from the Compliance log until resolved.', certification: { qiName: 'Alex Rivera' },
  };
  const insp = {
    id: 'qi_fx', date: '2026-09-15', createdAt: 1, updatedAt: 1, status: 'draft', ownerUid: 'u1', inspType: 'routine', inspTypeOther: '', stormDateTime: '',
    weather: { sky: 'Clear', temp: '56°F / 72°F', precip: '0', wind: '5 mph W', soil: 'Dry', access: 'Full', general: '' },
    daSummary: { active: 4.1, inactive: 0, tempStab: 1.2, finalStab: 0, totalOpen: 4.1, over5: 'no', enhanced: 'yes', source: 'manual' },
    drainageAreas: { 'DA-1': { condition: 'acceptable', action: '' } }, daBulkNote: '', dischargePoints: { 'DP-1': { condition: 'acceptable', notes: '' } },
    waterbodyNotes: '', escVerified: 'verified', bmps: { 'Silt fence': { installed: 'y', condition: 'acceptable', maintenance: 'n', corrective: 'compliant' } },
    pollution: { Dust: { controls: 'y', obs: '', action: '' } }, smps: {}, notes: '', sketches: [], sketchMeta: {}, photos: [], photoMeta: {}, cert: { signedName: '', signedDate: '' },
    corrective: [
      { dateId: '2026-09-08', tag: 'CMP-10 · Level 3', location: 'ST13, Sikes Rd driveway 7', desc: 'Turbid discharge reaching the stream below the super silt fence.', action: 'Repair the super silt fence and remove the sediment by hand.',
        actions: '9/9/26: SSF repaired', since: '9/14/26: Sediment removed by hand, siderails installed  ·  status Open to In Progress (9/14/26)', sinceDate: '2026-09-11', status: 'In Progress', note: 'Reviewed on site with the grading foreman.', fromComplianceId: 'a' },
      { dateId: '2026-09-13', tag: 'CMP-11 · Level 2', location: 'TX 11.A.5', desc: 'Perimeter control down along the east edge.', action: 'Reinstall and backfill.', actions: '', since: 'newly logged 9/13/26', sinceDate: '2026-09-11', status: 'Open', note: '', fromComplianceId: 'b' },
      { dateId: '2026-09-05', tag: 'CMP-12 · Level 2', location: 'W20', desc: 'Sediment at the wetland edge.', action: 'Clean by hand.', actions: '9/6/26: Cleaned', since: 'resolved 9/13/26', sinceDate: '2026-09-11', status: 'Resolved 9/13/26', note: '', fromComplianceId: 'c' },
      { dateId: '2026-09-02', tag: 'CMP-16 · Level 1', location: '', desc: 'Silt fence sagging near inverter 4', action: 'Monitor.', actions: '', since: 'no change', sinceDate: '2026-09-11', status: 'Open', note: '', fromComplianceId: 'g' },
      { dateId: '2026-08-01', location: 'Legacy row location', desc: 'CMP-03 · Level 2', action: 'Legacy action', actions: '8/2/26: did it', fromComplianceId: 'z' },
      { dateId: '2026-09-15', location: 'A-1 culvert crossing', desc: 'Hand-added row: fence toe exposed ~20 ft', action: 'Re-trench and backfill toe' },
    ],
  };
  const b64 = async blob => new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  const pdf = await window._glSwpppBuildPdf(insp, cfg, null);
  const docx = await window._glSwpppBuildDocx(insp, cfg);
  return { p: await b64(pdf), d: await b64(docx) };
});
fs.writeFileSync(SP + '/qi-test.pdf', Buffer.from(res.p, 'base64'));
fs.writeFileSync(SP + '/qi-test.docx', Buffer.from(res.d, 'base64'));
console.log('errors (' + errors.length + '):'); errors.forEach(e => console.log('  ' + e));
await browser.close();
