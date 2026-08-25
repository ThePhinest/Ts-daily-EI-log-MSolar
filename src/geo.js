// ═══════════════════════════════════════════
// GEO — net-area engine for mutually-exclusive state categories (SWPPP disturbance)
// ═══════════════════════════════════════════
// Precedence is CHRONOLOGICAL — the LAST-DRAWN entry WINS any overlap (report date,
// then createdAt). The most recent observation of a piece of ground is its current
// state, in ANY direction: stabilize active ground (temp over active), stabilize in
// any order (temp over inactive), or RE-DISTURB stabilized ground (active drawn back
// over final) — no fixed state ladder. (Was state-list order pre-2026-07-06, which
// silently ignored re-disturbance; Tim: "there's no set order.")
//
// Non-destructive: drawings are NEVER mutated — net areas are computed from the drawn
// geometry on demand (turf). The full set of drawings stays "on the record."
//
// Scoped by the caller to running-balance / running-total categories only. Per-state-vs-plan
// categories (seeding: lime→fert→seed intentionally stack on the SAME ground) must NOT use
// this — they keep their gross per-state sums.
//
// Turf is the industry-standard JS geospatial library (Mapbox's own, GeoJSON-native).
import length from '@turf/length';
import { glAreaConvertM2, _safeArea, computeStateNet, computeEntryNet, computeEntryGeoms } from './geoCore.js';

// ── Perf (2026-07-23) — suffix unions + version-keyed memo ──
// Each net fn needed "union of everything drawn AFTER entry i" — computed as a
// fresh union of a growing slice per entry (O(n²) union calls), recomputed from
// scratch on EVERY render and EVERY drawing tap. Fix 1: one reverse pass
// accumulates the later-union — n union calls total. Fix 2: results memoize keyed
// on the entry-id SET (sorted — callers pass different orders) + a version that
// any tracker-entry mutation bumps (trackerEntries.js).
// ── Perf (2026-08-25) — Web Worker warm-up ──
// The pass itself still costs ~5 s for 252 drawings on a phone, and it ran on
// the main thread on the first map / Compliance visit (the first-touch freeze).
// glGeoWarm() posts every running-mode category's entry set to geoWorker.js
// right after the tracker loads (and, debounced, after any tracker mutation);
// results land in this memo under the same keys the sync functions build, so
// the first visit is a cache hit. The sync functions are unchanged (inline
// compute on a miss) — exports and popups never see a partial value.
let _glGeoVer = 0;
const _glGeoCache = new Map();
let _glWarmTimer = null;
function glGeoInvalidate(){
  _glGeoVer++; _glGeoCache.clear();
  // Re-warm after the burst of edits settles so the next tap is a hit.
  if(typeof window !== 'undefined'){ clearTimeout(_glWarmTimer); _glWarmTimer = setTimeout(() => { try{ glGeoWarm(); }catch(_){} }, 800); }
}
function _glKey(fn, entries, extra){
  const ids = []; for(const e of entries) ids.push(e.id);
  ids.sort();
  return fn + ':' + _glGeoVer + ':' + (extra || '') + ':' + ids.join('|');
}
function _glMemo(fn, entries, extra, compute){
  const key = _glKey(fn, entries, extra);
  if(_glGeoCache.has(key)) return _glGeoCache.get(key);
  const t0 = performance.now();
  const v = compute();
  if(typeof glBootMark === 'function') glBootMark('geo:' + fn, { entries: entries.length, ms: Math.round(performance.now() - t0) });   // boot-timeline attribution; no-op after the log finalizes
  if(_glGeoCache.size > 60) _glGeoCache.clear();   // small bound; recompute is cheap post-fix-1
  _glGeoCache.set(key, v);
  return v;
}

// ── Worker plumbing ──
let _glWorker = null, _glWorkerDead = false, _glJobSeq = 0;
const _glJobs = new Map();   // id → {ver, keys:{S,E,G}}
function _glGetWorker(){
  if(_glWorker || _glWorkerDead) return _glWorker;
  try{
    _glWorker = new Worker(new URL('./geoWorker.js', import.meta.url), { type: 'module' });
    _glWorker.onmessage = (ev) => {
      const { id, v, err, ms, n } = ev.data || {};
      const job = _glJobs.get(id); _glJobs.delete(id);
      if(!job) return;
      if(typeof glBootMark === 'function') glBootMark('geo:warm', { entries: n, ms, err: err || undefined });
      if(err || !v || job.ver !== _glGeoVer) return;   // stale (a mutation bumped the version) → ignore
      if(job.keys.S && v.S !== undefined) _glGeoCache.set(job.keys.S, v.S);
      _glGeoCache.set(job.keys.E, v.E);
      _glGeoCache.set(job.keys.G, v.G);
      if(_glJobs.size === 0 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gl-geo-ready'));
    };
    _glWorker.onerror = (e) => { console.warn('geo worker error:', e && e.message); _glWorkerDead = true; try{ _glWorker.terminate(); }catch(_){} _glWorker = null; _glJobs.clear(); };
  }catch(e){ console.warn('geo worker unavailable:', e && e.message); _glWorkerDead = true; _glWorker = null; }
  return _glWorker;
}
// Slim copies: the worker needs only what the engine reads.
function _glSlim(entries){
  return entries.map(e => ({ id: e.id, date: e.date, createdAt: e.createdAt, state: e.state, geometry: e.geometry }));
}
// Warm every running-mode category of the active project. Entry sets mirror the
// map render's clip list (open temporary flags out, planned out) — the same set
// the Compliance card uses once planned/temporary are removed — so keys match.
function glGeoWarm(projectId){
  if(typeof window === 'undefined') return;
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(typeof tcGetCategories !== 'function' || typeof trGetEntriesForProject !== 'function' || typeof tcProgressMode !== 'function') return;
  const w = _glGetWorker(); if(!w) return;
  const all = trGetEntriesForProject(pid);
  tcGetCategories(pid).forEach(cat => {
    const mode = tcProgressMode(cat, pid);
    if(mode !== 'running-balance' && mode !== 'running-total') return;
    const states = (typeof tcGetStates === 'function') ? tcGetStates(cat, pid).filter(s => !s.isPlanned) : [];
    const list = all.filter(e => {
      if((e.categoryId || e.category) !== cat.id || !e.geometry) return false;
      if(e.temporary && e.tempStatus !== 'resolved') return false;
      const st = (typeof tcEntryState === 'function') ? tcEntryState(e, cat, pid) : null;
      return !(st ? !!st.isPlanned : (e.entryType === 'planned'));
    });
    if(!list.length) return;
    const keys = {
      S: states.length ? _glKey('S', list, states.map(s => s.id).join(',')) : null,
      E: _glKey('E', list, ''),
      G: _glKey('G', list, ''),
    };
    if(_glGeoCache.has(keys.G) && _glGeoCache.has(keys.E) && (!keys.S || _glGeoCache.has(keys.S))) return;
    for(const j of _glJobs.values()){ if(j.keys.G === keys.G) return; }   // already in flight
    const id = ++_glJobSeq;
    _glJobs.set(id, { ver: _glGeoVer, keys });
    try{ w.postMessage({ id, entries: _glSlim(list), states: states.map(s => ({ id: s.id })) }); }
    catch(e){ _glJobs.delete(id); console.warn('geo warm post failed:', e && e.message); }
  });
}

// entries        : installed entries for ONE category (caller pre-filters planned/temporary/deleted)
// orderedStates  : non-planned child states (defines the known state ids + output order)
// Precedence     : chronological — each drawing minus everything drawn AFTER it.
// Returns { netM2:{stateId:m²}, totalM2 } or null if no usable polygon geometry exists.
function glStateNetAreasM2(entries, orderedStates){
  if(!Array.isArray(entries) || !Array.isArray(orderedStates) || !orderedStates.length) return null;
  return _glMemo('S', entries, orderedStates.map(s => s.id).join(','), () => computeStateNet(entries, orderedStates));
}

// Per-ENTRY net area (m²): each drawing's geometry minus the union of everything
// drawn AFTER it (chronological — later drawing wins, matching glStateNetAreasM2).
// Returns { entryId: m² } or null.
function glEntryNetAreasM2(entries, orderedStates){
  if(!Array.isArray(entries) || !Array.isArray(orderedStates) || !orderedStates.length) return null;
  return _glMemo('E', entries, '', () => computeEntryNet(entries));
}

// Per-ENTRY net GEOMETRY: each drawing minus the union of everything drawn AFTER
// it (same chronological clip, returns the clipped shape; slivers < 4 m² dropped
// for DISPLAY only — see geoCore._dropSlivers). null = fully covered.
// Area in m² of one polygon ring-set (for picking the largest piece of a split remainder).
function glPolyAreaM2(coords){
  return _safeArea({ type:'Feature', properties:{}, geometry:{ type:'Polygon', coordinates: coords } });
}

// #36 — remaining gaps along a PLANNED line: stretches of the plan not yet within
// `tolM` meters of any installed child line. Sampled every `stepM` along the plan
// (hand-traced installs never share vertices with the plan, so a tolerance walk
// beats exact overlap math). Returns [{startFt,endFt,lengthFt}] — empty = fully
// covered; null = not measurable.
function glLineGapsFt(planGeom, installedGeoms, tolM, stepM){
  tolM = tolM || 3; stepM = stepM || 2;
  if(!planGeom || planGeom.type !== 'LineString' || !Array.isArray(installedGeoms)) return null;
  const segs = [];
  installedGeoms.forEach(g => {
    if(!g) return;
    const lines = g.type === 'LineString' ? [g.coordinates] : (g.type === 'MultiLineString' ? g.coordinates : []);
    lines.forEach(cs => { for(let i = 1; i < cs.length; i++) segs.push([cs[i-1], cs[i]]); });
  });
  if(!segs.length) return null;
  const lat0 = planGeom.coordinates[0][1] * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  const toXY = p => [p[0] * kx, p[1] * ky];
  const segXY = segs.map(s => [toXY(s[0]), toXY(s[1])]);
  const dSeg = (p, a, b) => {
    const vx = b[0]-a[0], vy = b[1]-a[1], wx = p[0]-a[0], wy = p[1]-a[1];
    const L2 = vx*vx + vy*vy;
    const t = L2 ? Math.max(0, Math.min(1, (wx*vx + wy*vy) / L2)) : 0;
    const dx = p[0] - (a[0] + t*vx), dy = p[1] - (a[1] + t*vy);
    return Math.sqrt(dx*dx + dy*dy);
  };
  const covered = p => { for(const s of segXY){ if(dSeg(p, s[0], s[1]) <= tolM) return true; } return false; };
  // Walk the plan line at stepM, tagging each sample covered / open.
  const pc = planGeom.coordinates.map(toXY);
  const samples = [];   // [distM, covered]
  let acc = 0;
  for(let i = 1; i < pc.length; i++){
    const a = pc[i-1], b = pc[i];
    const segLen = Math.hypot(b[0]-a[0], b[1]-a[1]);
    const n = Math.max(1, Math.ceil(segLen / stepM));
    for(let k = 0; k < n; k++){
      const t = k / n;
      samples.push([acc + t*segLen, covered([a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])])]);
    }
    acc += segLen;
  }
  samples.push([acc, covered(pc[pc.length-1])]);
  const gaps = [];
  let open = null;
  samples.forEach(([d, cov], i) => {
    if(!cov && open == null) open = d;
    if((cov || i === samples.length-1) && open != null){ const end = cov ? d : d; if(end - open >= tolM) gaps.push([open, end]); open = null; }
  });
  const FT = 3.28084;
  return gaps.map(([s, e]) => ({ startFt: s*FT, endFt: e*FT, lengthFt: (e - s)*FT }));
}

function glEntryNetGeoms(entries){
  return _glMemo('G', entries || [], '', () => computeEntryGeoms(entries || []));
}

// Line length in FEET for a LineString/MultiLineString geometry (object or JSON
// string). Used by the KML→planned-category promotion to measure imported lines.
function glLineLengthFt(geometry){
  try{
    let g = geometry;
    if(typeof g === 'string') g = JSON.parse(g);
    if(!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return 0;
    const km = length({ type:'Feature', properties:{}, geometry:g }, { units:'kilometers' });
    return km * 3280.8398950131; // km → ft
  }catch{ return 0; }
}

if(typeof window !== 'undefined'){
  window.glStateNetAreasM2 = glStateNetAreasM2;
  window.glEntryNetAreasM2 = glEntryNetAreasM2;
  window.glEntryNetGeoms   = glEntryNetGeoms;
  window.glAreaConvertM2   = glAreaConvertM2;
  window.glLineLengthFt    = glLineLengthFt;
  window.glLineGapsFt      = glLineGapsFt;
  window.glPolyAreaM2      = glPolyAreaM2;
  window.glGeoInvalidate   = glGeoInvalidate;
  window.glGeoWarm         = glGeoWarm;
}

export { glGeoWarm, glStateNetAreasM2, glEntryNetAreasM2, glEntryNetGeoms, glAreaConvertM2, glLineLengthFt, glLineGapsFt, glPolyAreaM2, glGeoInvalidate };
