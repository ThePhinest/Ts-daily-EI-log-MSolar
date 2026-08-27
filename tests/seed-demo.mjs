// Demo-project seed for the App Store reviewer account (app-store-launch-plan A8).
//
//   node tests/seed-demo.mjs login   → opens a HEADED browser on app.groundlog.io using a
//                                       dedicated profile (tests/screens/.profile-demo).
//                                       Sign in as review@groundlog.io ONCE, then Ctrl+C.
//   node tests/seed-demo.mjs seed    → headless; refuses to run unless the signed-in user
//                                       IS the demo account; seeds "Ridgeline Solar Energy
//                                       Center" through the app's own save paths, then
//                                       makes one aiComplete call (live proxy test).
//   node tests/seed-demo.mjs check   → headless; prints who is signed in + project counts.
//
// Everything is generic/synthetic — no Moraine data, names, or coordinates.
import { chromium } from '@playwright/test';

const DEMO_EMAIL = 'review@groundlog.io';
const PROFILE = 'tests/screens/.profile-demo';
const mode = process.argv[2] || 'check';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: mode !== 'login',
  viewport: { width: 440, height: 956 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  colorScheme: 'dark',
});
const page = await ctx.newPage();
page.on('console', m => { if (/seed:|GroundLog seed/.test(m.text())) console.log('  ', m.text()); });
await page.goto('https://app.groundlog.io/', { waitUntil: 'domcontentloaded' });

if (mode === 'login') {
  console.log(`\nSign in as ${DEMO_EMAIL} in the browser window (email/password). Waiting…`);
  await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 0 });
  const who = await page.evaluate(() => window._currentUser.email);
  console.log(`Signed in as ${who}. Complete onboarding if it shows, then press Ctrl+C here.`);
  await new Promise(() => {});
}

await page.waitForFunction(() => !!(window._currentUser && window._fbReady), null, { timeout: 45000 })
  .catch(() => { console.log('NOT SIGNED IN — run `node tests/seed-demo.mjs login` first.'); process.exit(1); });
await page.waitForTimeout(3000);
const who = await page.evaluate(() => ({ email: window._currentUser.email, uid: window._currentUser.uid }));
console.log('signed in as', who.email);

if (who.email !== DEMO_EMAIL) {
  console.log(`REFUSING: profile is signed in as ${who.email}, not ${DEMO_EMAIL}.`);
  await ctx.close(); process.exit(1);
}

if (mode === 'check') {
  const info = await page.evaluate(async () => {
    const pid = window._activeProjectId ? window._activeProjectId() : null;
    const cfg = window.loadProjectConfig ? window.loadProjectConfig() : {};
    const cats = window.tcGetCategories ? window.tcGetCategories(pid) : [];
    const photos = (window._phPhotos || []).filter(p => p.projectId === pid);
    let logs = 0; try { logs = (await window._udb().collection('dailyLogs').get()).size; } catch {}
    return { pid, project: cfg.projectName, categories: cats.map(c => c.name), photos: photos.length, dailyLogs: logs };
  });
  console.log(JSON.stringify(info, null, 2));
  await ctx.close(); process.exit(0);
}

// ───────────────────────────── seed ─────────────────────────────
const result = await page.evaluate(async () => {
  const log = (...a) => console.log('seed:', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = window._currentUser.uid;
  const udb = window._udb();
  const out = { steps: [] };
  const step = (s) => { out.steps.push(s); log(s); };

  // ── 0. Refuse to double-seed ──
  const existing = (typeof knownProjectsGet === 'function' ? knownProjectsGet() : [])
    .find(p => /Ridgeline/.test(p.projectName || ''));
  if (existing) { return { error: 'Ridgeline project already exists (' + existing.projectId + ') — aborting, nothing written.' }; }

  // ── helpers ──
  const dayISO = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
  const weekdaysBack = (n) => { const out = []; let o = -1; while (out.length < n) { const d = new Date(); d.setDate(d.getDate() + o); const wd = d.getDay(); if (wd !== 0 && wd !== 6) out.push(d.toLocaleDateString('en-CA')); o--; } return out.reverse(); };
  const R = 6371008.8;
  const centroidOf = (coords) => { let x = 0, y = 0; coords.forEach(c => { x += c[0]; y += c[1]; }); return { lng: x / coords.length, lat: y / coords.length }; };
  const acresOf = (ring) => { // shoelace on an equirectangular projection — fine at demo scale
    const lat0 = ring[0][1] * Math.PI / 180;
    const pts = ring.map(([lng, lat]) => [lng * Math.PI / 180 * R * Math.cos(lat0), lat * Math.PI / 180 * R]);
    let a = 0; for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    return Math.abs(a / 2) / 4046.856;
  };
  const feetOf = (line) => { let ft = 0; for (let i = 1; i < line.length; i++) { const [a, b] = [line[i - 1], line[i]]; const dx = (b[0] - a[0]) * Math.PI / 180 * R * Math.cos(a[1] * Math.PI / 180); const dy = (b[1] - a[1]) * Math.PI / 180 * R; ft += Math.hypot(dx, dy) * 3.28084; } return ft; };
  // Generic site: rural central NY, nowhere near any real project of ours.
  const C = { lng: -75.6120, lat: 42.5610 };
  const box = (dx, dy, w, h) => { const ring = [[C.lng + dx, C.lat + dy], [C.lng + dx + w, C.lat + dy], [C.lng + dx + w, C.lat + dy + h], [C.lng + dx, C.lat + dy + h]]; ring.push(ring[0]); return ring; };

  // ── 1. Project ──
  const pid = await createProject('Ridgeline Solar Energy Center', 'Chenango County, NY', 'Summit Civil Contractors', { landOn: 'log', preparedBy: 'Alex Rivera' });
  if (!pid) return { error: 'createProject returned nothing' };
  step('project ' + pid);
  await sleep(1500);
  // Header fields for the log
  await udb.collection('settings').doc(pid).set({ preparedBy: 'Alex Rivera', org: 'Ridgeline Environmental LLC', reviewedBy: 'J. Morgan, PE', activePhase: 'Phase 1 — Civil', _ts: Date.now() }, { merge: true });

  // ── 2. Tracker categories ──
  const mk = async (name, template, color) => {
    const sch = tcTemplateSchema(template);
    const cat = Object.assign({ name, color, template }, sch);
    await tcSaveCategory(cat, pid);
    return cat;
  };
  const catDist = await mk('Ground Disturbance', 'disturbance', '#E67E22');
  const catSF = await mk('Silt Fence', 'linear-bmp', '#4A90E2');
  const catSeed = await mk('Seeding', 'seeding', '#27AE60');
  step('categories 3');
  const st = (cat, label) => (cat.states.find(s => s.label === label) || {}).id;

  // ── 3. Tracker entries (drawings) ──
  const days = weekdaysBack(5);
  const poly = (cat, ring, date, state, extra) => {
    const cen = centroidOf(ring); const ac = acresOf(ring);
    return trSaveEntry(Object.assign({
      date, categoryId: cat.id, categoryName: cat.name,
      geometry: { type: 'Polygon', coordinates: [ring] },
      centroidLng: cen.lng, centroidLat: cen.lat,
      acres: +ac.toFixed(2), measurementValue: +ac.toFixed(2), measurementUnit: 'ac',
      location: cen.lat.toFixed(5) + ', ' + cen.lng.toFixed(5), fields: {}, notes: '', state, showDateLabel: false,
    }, extra || {}), pid);
  };
  const line = (cat, pts, date, state, extra) => {
    const cen = centroidOf(pts); const ft = feetOf(pts);
    return trSaveEntry(Object.assign({
      date, categoryId: cat.id, categoryName: cat.name,
      geometry: { type: 'LineString', coordinates: pts },
      centroidLng: cen.lng, centroidLat: cen.lat,
      acres: null, measurementValue: Math.round(ft), measurementUnit: 'ft',
      location: cen.lat.toFixed(5) + ', ' + cen.lng.toFixed(5), fields: {}, notes: '', state, showDateLabel: false,
    }, extra || {}), pid);
  };
  // Disturbance (no plan baseline): two active, one temp-stabilized
  poly(catDist, box(-0.0040, -0.0020, 0.0030, 0.0022), days[0], st(catDist, 'Active disturbed'), { notes: 'Laydown yard strip + grade' });
  poly(catDist, box(0.0005, -0.0025, 0.0028, 0.0018), days[2], st(catDist, 'Active disturbed'), { notes: 'Array block A-1 access road' });
  poly(catDist, box(-0.0038, 0.0012, 0.0022, 0.0016), days[4], st(catDist, 'Temporary stabilization'), { notes: 'Topsoil stockpile — seeded + mulched' });
  // Silt fence: planned perimeter + installed south run
  const perim = [[C.lng - 0.0048, C.lat - 0.0030], [C.lng + 0.0040, C.lat - 0.0030], [C.lng + 0.0040, C.lat + 0.0032]];
  line(catSF, perim, days[0], st(catSF, 'Planned'), { entryType: 'planned', notes: 'Per ESC plan sheet C-301' });
  line(catSF, perim.slice(0, 2), days[1], st(catSF, 'Installed'), { notes: 'South perimeter — 2×2 hardwood stakes, 6 ft o.c.' });
  // Seeding: planned area + seeded portion
  const seedPlan = box(-0.0038, 0.0012, 0.0022, 0.0016);
  poly(catSeed, seedPlan, days[0], st(catSeed, 'Planned'), { entryType: 'planned', notes: 'Temporary seed mix — annual rye 40 lb/ac' });
  poly(catSeed, box(-0.0038, 0.0012, 0.0011, 0.0016), days[4], st(catSeed, 'Seeded'), { fields: { phase: 'Initial', method: 'Broadcast Seeding' }, notes: 'West half hand-broadcast + straw mulch' });
  step('tracker entries 7');
  await sleep(1500);

  // ── 4. Photos (synthetic JPEGs drawn on canvas) ──
  const drawPhoto = (title, sub, kind) => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 900; const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 480); sky.addColorStop(0, '#6FA8DC'); sky.addColorStop(1, '#CFE3F5'); g.fillStyle = sky; g.fillRect(0, 0, 1200, 480);
    const gnd = g.createLinearGradient(0, 480, 0, 900); gnd.addColorStop(0, kind === 'soil' ? '#8B5A2B' : '#5C8A3A'); gnd.addColorStop(1, kind === 'soil' ? '#5E3A1A' : '#2F5A1E'); g.fillStyle = gnd; g.fillRect(0, 480, 1200, 420);
    g.fillStyle = 'rgba(60,80,40,.9)'; g.beginPath(); g.moveTo(0, 480); for (let x = 0; x <= 1200; x += 60) g.lineTo(x, 470 - 25 * Math.sin(x / 140) - 10 * Math.cos(x / 53)); g.lineTo(1200, 480); g.fill();
    if (kind === 'fence') { g.strokeStyle = '#111'; g.lineWidth = 6; for (let x = 80; x < 1200; x += 140) { g.beginPath(); g.moveTo(x, 560); g.lineTo(x, 700); g.stroke(); } g.fillStyle = 'rgba(30,30,30,.55)'; g.fillRect(60, 600, 1100, 70); }
    if (kind === 'seed') { g.fillStyle = 'rgba(230,200,120,.35)'; for (let i = 0; i < 400; i++) g.fillRect(Math.random() * 1200, 520 + Math.random() * 380, 6, 3); }
    if (kind === 'water') { g.fillStyle = 'rgba(120,150,190,.85)'; g.beginPath(); g.ellipse(700, 760, 320, 60, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 800, 1200, 100);
    g.fillStyle = '#fff'; g.font = 'bold 40px system-ui, sans-serif'; g.fillText(title, 40, 845); g.font = '26px system-ui, sans-serif'; g.fillStyle = '#ddd'; g.fillText(sub, 40, 882);
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  };
  const shots = [
    ['Silt fence, south perimeter', 'Installed and trenched, 6 ft stake spacing', 'fence', days[1], 12, ['swppp'], 0.0000, -0.0030],
    ['Laydown yard strip', 'Topsoil stripped, stockpiled north side', 'soil', days[0], 300, [], -0.0025, -0.0010],
    ['Construction entrance', 'Stone pad in place, no tracking observed', 'soil', days[1], 95, ['swppp'], 0.0040, -0.0028],
    ['Stockpile seeding', 'Temporary seed + straw mulch applied', 'seed', days[4], 210, ['seed'], -0.0030, 0.0020],
    ['Access road A-1', 'Subgrade cut, culvert set', 'soil', days[2], 60, [], 0.0018, -0.0016],
    ['Sediment trap ST-1', 'Riser clear, 30% capacity', 'water', days[3], 180, ['swppp'], 0.0032, 0.0025],
    ['Perimeter check', 'Fence intact after 0.4 in. rain', 'fence', days[3], 25, ['swppp'], -0.0048, 0.0000],
    ['Stabilized stockpile', 'Germination visible, 60% cover', 'seed', dayISO(0), 240, ['seed'], -0.0028, 0.0022],
  ];
  const photoIds = [];
  for (const [title, sub, kind, date, heading, tags, dx, dy] of shots) {
    const blob = await drawPhoto(title, sub, kind);
    const e = await phSaveCameraPhoto(blob, { caption: title + ' — ' + sub, lat: C.lat + dy, lng: C.lng + dx, heading, accuracy: 4, tags });
    if (e) { const live = (window._phPhotos || []).find(x => x.id === e.id) || e; live.date = date; live.takenAt = new Date(date + 'T14:30:00').getTime(); photoIds.push(e.id); }
    await sleep(700);
  }
  phSaveLocal();
  const flushPhotos = async () => { for (const id of photoIds) { const p = (window._phPhotos || []).find(x => x.id === id); if (p) await phSaveCloudOne(p); } };
  await flushPhotos(); await sleep(3000); await flushPhotos();   // second pass picks up storageUrls from the background uploads
  step('photos ' + photoIds.length);

  // ── 5. Daily logs (5 archived weekdays + today's live session) ──
  const skyOpts = [['Clear'], ['Partly Cloudy'], ['Overcast'], ['Rain'], ['Clear']];
  const summaries = [
    'Supervised topsoil stripping at the laydown yard. Perimeter silt fence installation started along the south boundary. Construction entrance stone placed.',
    'Silt fence south run completed and trenched. Construction entrance inspected, no tracking onto the county road. Stockpile located north of laydown.',
    'Access road A-1 subgrade cut; 24 in. culvert set at the swale crossing with rip-rap outlet. Reminded crew to keep the fence toe buried.',
    '0.4 in. overnight rain. Walked full perimeter, all controls intact. Sediment trap ST-1 at ~30% capacity, no discharge observed at the outlet.',
    'Temporary seed and straw mulch applied to the north stockpile (west half). Dust control watering on A-1. No agency visits.',
  ];
  const crews = [
    [['Summit Civil — earthwork', '07:00–17:00', 'Laydown yard', 'Topsoil strip, stockpile', 'Fence toe trenched ahead of strip', '', '']],
    [['Summit Civil — earthwork', '07:00–16:30', 'South perimeter', 'Silt fence install', 'Stakes on downhill side', '', ''], ['Summit Civil — trucking', '08:00–15:00', 'Entrance', 'Stone pad', 'Geotextile under stone', '', '']],
    [['Summit Civil — earthwork', '07:00–17:00', 'Access road A-1', 'Subgrade, culvert', 'Rip-rap outlet placed', 'Fence toe exposed 20 ft — fixed same day', '']],
    [['Summit Civil — earthwork', '09:00–16:00', 'Site-wide', 'Post-rain repairs', 'All controls intact', '', 'Late start for rain']],
    [['Summit Civil — restoration', '07:00–15:00', 'North stockpile', 'Seed + mulch', 'Annual rye 40 lb/ac', '', '']],
  ];
  const mkState = (i, date) => {
    const crew = crews[i].map((c, k) => ({ id: k + 1, name: c[0], time: c[1], loc: c[2], acts: c[3], envcomp: c[4], issues: c[5], notes: c[6] }));
    return {
      fields: { projectName: 'Ridgeline Solar Energy Center', reportDate: date, preparedBy: 'Alex Rivera', org: 'Ridgeline Environmental LLC', activePhase: 'Phase 1 — Civil', contractor: 'Summit Civil Contractors', reviewedBy: 'J. Morgan, PE',
        tempAM: String(54 + i * 2), tempPM: String(71 + i), wind: ['5 mph W', '8 mph SW', '3 mph', '12 mph NW', '6 mph W'][i], precip: ['0', '0', '0', '0.40', '0'][i], soilCond: ['Dry', 'Dry', 'Dry', 'Saturated', 'Moist'][i],
        inspSummary: summaries[i], agencyInsp: '', landowner: '', rte: 'None observed', nonCompliance: '',
        genComms: i === 2 ? 'Discussed fence toe with the foreman; corrected same day.' : '', lookahead: ['Finish south fence', 'Start A-1 road', 'Rain forecast — check controls', 'Seed stockpile', 'Begin array block A-1 grading'][i],
        'p-timeIn': '06:45', 'p-timeOut': i === 3 ? '15:30' : '17:15', 'p-break': '30', 'p-odoStart': String(41200 + i * 38), 'p-odoEnd': String(41200 + i * 38 + 36), 'p-notes': '' },
      sky: skyOpts[i], checkboxes: {}, flagNotes: {}, checklist: {}, crew, crewSeq: crew.length, crewIds: crew.map(c => c.id),
    };
  };
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    const rec = Object.assign({}, mkState(i, date), { _archivedAt: new Date(date + 'T22:10:00').getTime(), _archivedDate: date, _edited: false, _editLog: [], projectId: pid });
    dlSaveLocal(date, rec);
    await udb.collection('dailyLogs').doc(date).set(rec);
  }
  step('daily logs ' + days.length);
  // Today's live session
  const today = dayISO(0);
  const todayState = mkState(4, today); todayState.fields.inspSummary = 'Morning walk: stockpile seeding germinating (~60% cover on the west half). Array block A-1 grading to begin after fence extension.'; todayState.fields.lookahead = 'Extend perimeter fence east side before A-1 grading'; todayState._ts = Date.now();
  await udb.collection('sessions').doc(pid).set(todayState);
  try { localStorage.setItem('msf_autosave', JSON.stringify(todayState)); } catch {}
  step('today session');

  // ── 6. One submitted day (yesterday-ish) ──
  const subDate = days[4];
  const subPayload = Object.assign({}, mkState(4, subDate));
  await db.collection('projects').doc(pid).collection('submissions').doc(subDate + '_v1').set({
    date: subDate, version: 1, status: 'active', audience: 'project', submittedBy: uid, submittedByName: 'Alex Rivera', submittedAt: new Date(subDate + 'T22:15:00').getTime(),
    projectName: 'Ridgeline Solar Energy Center', payload: subPayload,
  });
  step('submission ' + subDate);

  // ── 7. SWPPP QI form config + one completed inspection + one draft ──
  const swCfg = {
    formType: 'swppp-qi-inspection', version: 1, projectTitle: 'Ridgeline Solar Energy Center', projectName: 'Ridgeline Solar Energy Center',
    header: { inspectorName: 'Alex Rivera', roleCredential: 'Qualified Inspector (CPESC)', organization: 'Ridgeline Environmental LLC', spdesPermit: 'GP-0-20-001', swtNumber: 'NYR11X999', swptsId: 'Ridgeline-Demo' },
    drainageAreas: [{ id: 'DA-1', desc: 'Laydown yard and construction entrance, drains south to roadside ditch' }, { id: 'DA-2', desc: 'Array block A-1 and access road, drains east to sediment trap ST-1' }],
    drainageAreasNote: 'Drainage areas per ESC plan sheets C-301 to C-303.',
    dischargePoints: [{ id: 'DP-1', location: 'South roadside ditch outlet', receiving: 'Unnamed tributary (Class C)' }, { id: 'DP-2', location: 'ST-1 riser outlet', receiving: 'Unnamed tributary (Class C)' }],
    dischargePointsNote: '',
    waterbodies: [{ name: 'Unnamed tributary', type: 'Perennial stream', location: '400 ft east of A-1', impaired: 'No' }],
    bmps: [{ name: 'Silt fence', location: 'South + east perimeter' }, { name: 'Stabilized construction entrance', location: 'County Rd 12' }, { name: 'Sediment trap ST-1', location: 'East of A-1' }, { name: 'Temporary seeding / mulch', location: 'North stockpile' }],
    escCondition4: 'All ESC measures inspected per SWPPP.',
    pollutionSources: ['Fueling / equipment maintenance', 'Concrete washout', 'Waste and debris', 'Dust'],
    pollutionNote: '',
    smps: [{ name: 'Infiltration basin IB-1', location: 'Southwest corner' }],
    certification: { qiName: 'Alex Rivera' },
  };
  await db.collection('projects').doc(pid).collection('config').doc('swpppQiForm').set(swCfg);
  try { window.idbSet && window.idbSet('sw_cfg::' + pid, swCfg); } catch {}
  const mkInsp = (date, status, deficient) => {
    const ts = new Date(date + 'T15:00:00').getTime();
    return {
      id: 'qi_' + date + '_' + ts.toString(36), date, createdAt: ts, updatedAt: ts, status, ownerUid: uid, published: false,
      inspType: deficient ? 'post-storm' : 'routine', inspTypeOther: '', stormDateTime: deficient ? date + ' 02:00' : '',
      weather: { sky: deficient ? 'Overcast' : 'Clear', temp: deficient ? '58°F / 66°F' : '56°F / 72°F', precip: deficient ? '0.40' : '0', wind: '5 mph W', soil: deficient ? 'Saturated' : 'Dry', access: 'Full', general: '' },
      daSummary: { active: 4.1, inactive: 0, tempStab: 1.2, finalStab: 0, totalOpen: 4.1, over5: 'no', enhanced: 'yes', source: 'manual' },
      drainageAreas: { 'DA-1': { condition: 'acceptable', action: '' }, 'DA-2': { condition: deficient ? 'deficient' : 'acceptable', action: deficient ? 'Re-bury fence toe at A-1 culvert crossing' : '' } },
      daBulkNote: '', dischargePoints: { 'DP-1': { condition: 'acceptable', notes: '' }, 'DP-2': { condition: 'acceptable', notes: '' } },
      waterbodyNotes: 'No turbidity observed at either discharge point.', escVerified: 'verified',
      bmps: { 'Silt fence': { installed: 'y', condition: deficient ? 'attention' : 'acceptable', maintenance: deficient ? 'y' : 'n', corrective: deficient ? 'action' : 'compliant' }, 'Stabilized construction entrance': { installed: 'y', condition: 'acceptable', maintenance: 'n', corrective: 'compliant' }, 'Sediment trap ST-1': { installed: 'y', condition: 'acceptable', maintenance: 'n', corrective: 'compliant' }, 'Temporary seeding / mulch': { installed: deficient ? 'n' : 'y', condition: 'acceptable', maintenance: 'n', corrective: 'compliant' } },
      pollution: { 'Fueling / equipment maintenance': { controls: 'y', obs: 'Spill kit on site', action: '' }, 'Concrete washout': { controls: 'na', obs: '', action: '' }, 'Waste and debris': { controls: 'y', obs: '', action: '' }, 'Dust': { controls: 'y', obs: 'Water truck on A-1', action: '' } },
      smps: { 'Infiltration basin IB-1': { status: 'not-started', compliance: 'na' } },
      corrective: deficient ? [{ dateId: date, location: 'A-1 culvert crossing', desc: 'Silt fence toe exposed ~20 ft', action: 'Re-trench and backfill toe', fromComplianceId: null }] : [],
      notes: deficient ? 'Post-storm inspection after 0.4 in. Controls functional; one fence toe repair completed same day.' : 'Routine weekly inspection. No deficiencies.',
      sketches: [], sketchMeta: {}, photos: [], photoMeta: {},
      cert: { signedName: status === 'completed' ? 'Alex Rivera' : '', signedDate: status === 'completed' ? date : '' },
    };
  };
  const inspA = mkInsp(days[3], 'completed', true);
  const swPhotos = (window._phPhotos || []).filter(p => p.swppp && p.projectId === pid);
  inspA.photos = swPhotos.map(p => p.id); swPhotos.forEach(p => { inspA.photoMeta[p.id] = { subject: p.caption, loc: '' }; });
  const inspB = mkInsp(dayISO(0), 'draft', false);
  await db.collection('projects').doc(pid).collection('swpppInspections').doc(inspA.id).set(inspA);
  await db.collection('projects').doc(pid).collection('swpppInspections').doc(inspB.id).set(inspB);
  try { window.idbSet && window.idbSet('sw_insp::' + pid, [inspA, inspB]); } catch {}
  step('swppp config + 2 inspections');

  // ── 8. Open items ──
  const mkOi = (title, text, due, kind) => ({
    id: 'oi' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ownerUid: uid, kind: kind || 'task', title, text,
    order: 0, source: 'manual', sourceRef: null, createdDate: days[2], createdTs: new Date(days[2] + 'T16:00:00').getTime(),
    dueDate: due || '', remindAt: '', remindRepeat: '', remindDays: [], status: 'open', resolvedDate: '', resolvedTs: 0, resolutionNote: '',
    includeInReport: false, visibility: 'private', deleted: false, _mts: Date.now(),
  });
  const ois = [
    mkOi('Extend silt fence along east boundary before A-1 grading', 'Foreman says Thursday. Verify toe is trenched.', dayISO(2)),
    mkOi('Confirm seed mix delivery ticket for stockpile', 'Need the tag for the seeding record.', dayISO(1)),
    mkOi('Weekly inspection due', 'Routine QI inspection — walk full perimeter.', dayISO(3)),
  ];
  const batch = db.batch(); ois.forEach((it, i) => { it.order = i; batch.set(db.collection('projects').doc(pid).collection('openItems').doc(it.id), it); }); await batch.commit();
  try { window.idbSet && window.idbSet('oi_entries::' + pid, JSON.stringify(ois)); } catch {}
  step('open items 3');

  // ── 9. Live aiComplete proxy test (demo account has no own key) ──
  try {
    const fn = firebase.app().functions().httpsCallable('aiComplete');
    const res = await fn({ system: 'You are a terse assistant.', user: 'Reply with exactly: PROXY OK', maxTokens: 20 });
    out.aiComplete = (res.data && res.data.text) || JSON.stringify(res.data);
  } catch (e) { out.aiComplete = 'FAILED: ' + e.message; }
  step('aiComplete → ' + out.aiComplete);

  out.pid = pid; out.photoIds = photoIds;
  return out;
});

console.log(JSON.stringify(result, null, 2));
await page.waitForTimeout(4000);   // let trailing fire-and-forget writes land
await ctx.close();
