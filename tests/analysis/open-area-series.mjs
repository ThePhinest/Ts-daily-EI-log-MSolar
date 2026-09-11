// Replays the SWPPP Disturbance tracker week by week with the app's OWN net-area engine
// (geoCore.js: chronological precedence, later drawing wins), splits by the Regions
// category polygons, and validates against the signed QI report dates.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _prep, computeStateNet, _unionAll, _safeArea, glAreaConvertM2 } from '../../src/geoCore.js';
import intersectMod from '@turf/intersect';
import { featureCollection } from '@turf/helpers';
const intersect = intersectMod.default || intersectMod;

const dl = path.join(os.homedir(), 'Downloads');
const file = fs.readdirSync(dl).filter(f => /^groundlog-tracker-dump-.*\.json$/.test(f))
  .map(f => ({ f, t: fs.statSync(path.join(dl, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
const dump = JSON.parse(fs.readFileSync(path.join(dl, file), 'utf8'));
const DIST = 'cat-1782251313262-fxbn99';
const distCat = dump.categories.find(c => c && c.id === DIST);
const states = distCat.states;
const ACTIVE = states.find(s => s.label === 'Active disturbed').id;
const INACTIVE = states.find(s => s.label === 'Inactive disturbed').id;
const TEMP = states.find(s => s.label === 'Temporary stabilization').id;
const FINAL = states.find(s => s.label === 'Final stabilization').id;
const CLOSE = states.find(s => /Closeout/.test(s.label)).id;

const parseG = e => (typeof e.geometry === 'string' ? JSON.parse(e.geometry) : e.geometry);
const all = dump.entries.filter(e => e.categoryId === DIST && !e.deletedAt && e.geometry);
const regCat = dump.categories.find(c => c && /region/i.test(c.name || ''));
const regions = dump.entries.filter(e => regCat && e.categoryId === regCat.id && !e.deletedAt && e.geometry)
  .map(e => ({ id: e.id, name: (e.labelText || e.location || e.notes || e.fields?.name || '').toString().trim() || ('Region ' + e.id.slice(-4)), f: { type: 'Feature', properties: {}, geometry: parseG(e) }, acres: e.acres }))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

const ac = m2 => +glAreaConvertM2(m2 || 0, 'ac').toFixed(2);
function tryIntersect(a, b) {
  try { const r = intersect(featureCollection([a, b])); if (r) return r; } catch { }
  try { return intersect(a, b); } catch { return null; }
}
// Net state geometry + areas for everything dated <= cutoff.
function snapshot(cutoffISO) {
  const ents = all.filter(e => (e.date || '') <= cutoffISO);
  if (!ents.length) return null;
  const p = _prep(ents);
  const S = computeStateNet(ents, states, p);
  const byState = {};
  states.forEach(s => { byState[s.id] = []; });
  p.parsed.forEach((x, i) => { const sid = x.e.state || states[0].id; const g = p.clipped[i]; if (g && byState[sid]) byState[sid].push(g); });
  const unions = {}; states.forEach(s => { unions[s.id] = _unionAll(byState[s.id]); });
  const out = {
    cutoff: cutoffISO, n: ents.length,
    active: ac(S.netM2[ACTIVE]), inactive: ac(S.netM2[INACTIVE]), temp: ac(S.netM2[TEMP]), final: ac(S.netM2[FINAL]), closeout: ac(S.netM2[CLOSE]),
    everTouched: ac(S.totalM2), regions: {}
  };
  out.open = +(out.active + out.inactive).toFixed(2);
  for (const r of regions) {
    const row = {};
    for (const [k, sid] of [['active', ACTIVE], ['inactive', INACTIVE], ['temp', TEMP], ['final', FINAL]]) {
      const u = unions[sid]; if (!u) { row[k] = 0; continue; }
      const x = tryIntersect(u, r.f); row[k] = x ? ac(_safeArea(x)) : 0;
    }
    row.open = +(row.active + row.inactive).toFixed(2);
    out.regions[r.name] = row;
  }
  const sumOpen = Object.values(out.regions).reduce((a, r) => a + r.open, 0);
  out.openOutsideRegions = +(out.open - sumOpen).toFixed(2);
  return out;
}

const today = new Date().toLocaleDateString('en-CA');
// Weekly (Herzog "week of" = Monday): cutoff = that week's Sunday, capped at today.
const weekly = [];
for (let d = new Date('2026-07-06T12:00:00'); d.toLocaleDateString('en-CA') <= today; d.setDate(d.getDate() + 7)) {
  const mon = d.toLocaleDateString('en-CA');
  const sun = new Date(d); sun.setDate(sun.getDate() + 6);
  const cutoff = [sun.toLocaleDateString('en-CA'), today].sort()[0];
  const s = snapshot(cutoff); if (s) weekly.push({ weekOf: mon, ...s });
}
// Validation at the signed report dates.
const reportDates = ['2026-07-09','2026-07-13','2026-07-16','2026-07-21','2026-07-28','2026-07-31','2026-08-04','2026-08-07','2026-08-10','2026-08-11','2026-08-14','2026-08-18','2026-08-21','2026-08-25','2026-08-28','2026-08-31','2026-09-08'];
const reported = { '2026-07-09': 19.74, '2026-07-13': 18.92, '2026-07-16': 23.12, '2026-07-21': 59.81, '2026-07-28': 79.13, '2026-07-31': 85.32, '2026-08-04': 91.2, '2026-08-07': 78.96, '2026-08-10': 80.75, '2026-08-11': 82.16, '2026-08-14': 91.24, '2026-08-18': 100.42, '2026-08-21': 93.34, '2026-08-25': 92.24, '2026-08-28': 95.75, '2026-08-31': 99.45, '2026-09-08': 97.58 };
const validation = reportDates.map(dt => { const s = snapshot(dt); return { date: dt, reportedOpen: reported[dt], replayedOpen: s ? s.open : null, temp: s ? s.temp : null, final: s ? s.final : null, delta: s ? +(s.open - reported[dt]).toFixed(2) : null }; });

const result = { file, today, regions: regions.map(r => ({ name: r.name, acres: r.acres })), weekly, validation, now: snapshot(today) };
const outPath = process.argv[2] || path.join(process.cwd(), 'tests', 'analysis', 'open-area-series.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log('regions:', result.regions);
console.log('validation (date reported replayed delta):');
validation.forEach(v => console.log(' ', v.date, v.reportedOpen, v.replayedOpen, v.delta));
console.log('weekly open (weekOf: open | by region):');
weekly.forEach(w => console.log(' ', w.weekOf, w.open, '|', Object.entries(w.regions).map(([k, v]) => `${k}=${v.open}`).join(' '), '| outside', w.openOutsideRegions));
console.log('now:', JSON.stringify(result.now.regions), 'open', result.now.open, 'everTouched', result.now.everTouched);
console.log('wrote', outPath);
