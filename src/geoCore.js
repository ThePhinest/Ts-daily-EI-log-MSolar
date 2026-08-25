// ═══════════════════════════════════════════
// GEO CORE — pure net-area engine (no window, no memo). Imported by geo.js
// (main thread) AND geoWorker.js (Web Worker) so both run the exact same math.
// Semantics live in geo.js's header comment: chronological precedence, non-
// destructive, running-mode categories only.
// ═══════════════════════════════════════════
import area from '@turf/area';
import union from '@turf/union';
import difference from '@turf/difference';
import { featureCollection } from '@turf/helpers';

// m² → area unit (matches the cap-unit selector: ac/sqft/sqyd/sqm/ha).
const _M2_PER = { sqm:1, m2:1, 'm²':1, sqft:0.09290304, sqyd:0.83612736, ac:4046.8564224, ha:10000 };
function glAreaConvertM2(m2, toUnit){
  const d = _M2_PER[toUnit] || _M2_PER[(toUnit||'').toLowerCase()] || _M2_PER.ac;
  return (m2 || 0) / d;
}

function _parseGeom(e){
  if(!e || !e.geometry) return null;
  let g = e.geometry;
  if(typeof g === 'string'){ try{ g = JSON.parse(g); }catch{ return null; } }
  if(!g || !g.type) return null;
  if(g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null; // area only
  return { type:'Feature', properties:{}, geometry:g };
}

// Union a list of polygon Features → one Feature (or null). Falls back to pairwise on error.
function _unionAll(feats){
  feats = (feats || []).filter(Boolean);
  if(!feats.length) return null;
  if(feats.length === 1) return feats[0];
  try{ return union(featureCollection(feats)); }
  catch{
    let acc = feats[0];
    for(let i = 1; i < feats.length; i++){
      try{ acc = union(featureCollection([acc, feats[i]])) || acc; }catch{}
    }
    return acc;
  }
}
function _safeArea(f){ try{ return f ? area(f) : 0; }catch{ return 0; } }
function _safeDiff(a, b){
  if(!a) return null;
  if(!b) return a;
  try{ return difference(featureCollection([a, b])); }catch{ return a; }
}

// Chronological sort key: report date (the day the ground condition was observed),
// then createdAt for same-day ordering. Entries without a date sort first.
function _chronoSort(a, b){
  return String(a.e.date||'').localeCompare(String(b.e.date||''))
    || (a.e.createdAt||0) - (b.e.createdAt||0);
}


// laters[i] = union of parsed[i+1..end] (null when nothing later).
function _suffixLaters(parsed){
  const laters = new Array(parsed.length).fill(null);
  let acc = null;
  for(let i = parsed.length - 1; i >= 0; i--){
    laters[i] = acc;
    acc = acc ? (_unionAll([acc, parsed[i].f]) || acc) : parsed[i].f;
  }
  return laters;
}


const _SLIVER_M2 = 4;
function _dropSlivers(geometry){
  if(!geometry) return null;
  const polyArea = (coords) => _safeArea({ type:'Feature', properties:{}, geometry:{ type:'Polygon', coordinates: coords } });
  if(geometry.type === 'Polygon'){
    return polyArea(geometry.coordinates) < _SLIVER_M2 ? null : geometry;
  }
  if(geometry.type === 'MultiPolygon'){
    const kept = geometry.coordinates.filter(coords => polyArea(coords) >= _SLIVER_M2);
    if(!kept.length) return null;
    return kept.length === 1 ? { type:'Polygon', coordinates: kept[0] } : { type:'MultiPolygon', coordinates: kept };
  }
  return geometry;
}


// One chronological pass shared by all three outputs (the suffix-union is the
// whole cost; computing S/E/G separately tripled it).
// Bounding boxes (8/25): the suffix-union accumulated ONE giant multipolygon
// and every drawing was differenced against all of it (7 s for 264 drawings on
// an iPhone, even in the worker). A polygon can only be clipped by later
// drawings whose bbox touches its own, so each drawing is differenced against
// the union of just those — identical result (disjoint-bbox polygons contribute
// nothing to the difference), a fraction of the work. _suffixLaters is kept
// exported for reference/tests.
function _bboxOf(f){
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if(typeof c[0] === 'number'){ if(c[0] < minX) minX = c[0]; if(c[0] > maxX) maxX = c[0]; if(c[1] < minY) minY = c[1]; if(c[1] > maxY) maxY = c[1]; }
    else for(const k of c) walk(k);
  };
  try{ walk(f.geometry.coordinates); }catch{}
  return [minX, minY, maxX, maxY];
}
function _bboxHit(a, b){ return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]; }
function _prep(entries){
  const parsed = (entries || []).map(e => ({ e, f: _parseGeom(e) })).filter(x => x.f);
  if(!parsed.length) return null;
  parsed.sort(_chronoSort);
  const bb = parsed.map(x => _bboxOf(x.f));
  const clipped = parsed.map((x, i) => {
    const laters = [];
    for(let j = i + 1; j < parsed.length; j++){ if(_bboxHit(bb[i], bb[j])) laters.push(parsed[j].f); }
    if(!laters.length) return x.f;
    return _safeDiff(x.f, _unionAll(laters));
  });
  return { parsed, clipped };
}

function computeStateNet(entries, orderedStates, prep){
  if(!Array.isArray(orderedStates) || !orderedStates.length) return null;
  const p = prep || _prep(entries);
  if(!p) return null;
  const known = {}; orderedStates.forEach(s => { known[s.id] = true; });
  const stateFeats = {}; orderedStates.forEach(s => { stateFeats[s.id] = []; });
  p.parsed.forEach((x, i) => {
    // Legacy unstated entries belong to the first state; an entry with a set-but-
    // UNKNOWN state id is skipped (mis-attributing it to Active would corrupt the
    // open total silently).
    let sid = x.e.state;
    if(!sid) sid = orderedStates[0].id;
    else if(!known[sid]){ console.warn('glStateNetAreasM2: unknown state id on entry', x.e.id, sid); return; }
    const g = p.clipped[i];
    if(g) stateFeats[sid].push(g);
  });
  const netM2 = {};
  orderedStates.forEach(s => { netM2[s.id] = _safeArea(_unionAll(stateFeats[s.id])); });
  const totalM2 = _safeArea(_unionAll(p.parsed.map(x => x.f)));
  return { netM2, totalM2 };
}

function computeEntryNet(entries, prep){
  const p = prep || _prep(entries);
  if(!p) return null;
  const out = {};
  p.parsed.forEach((x, i) => { out[x.e.id] = _safeArea(p.clipped[i]); });
  return out;
}

function computeEntryGeoms(entries, prep){
  const p = prep || _prep(entries);
  if(!p) return null;
  const out = {};
  p.parsed.forEach((x, i) => { const g = p.clipped[i]; out[x.e.id] = (g && g.geometry) ? _dropSlivers(g.geometry) : null; });
  return out;
}

// Worker job: everything for one entry set in ONE pass.
function computeAll(entries, orderedStates){
  const p = _prep(entries);
  if(!p) return { S: null, E: null, G: null };
  return {
    S: (orderedStates && orderedStates.length) ? computeStateNet(entries, orderedStates, p) : null,
    E: computeEntryNet(entries, p),
    G: computeEntryGeoms(entries, p),
  };
}

export { glAreaConvertM2, _parseGeom, _unionAll, _safeArea, _safeDiff, _chronoSort, _suffixLaters, _dropSlivers, _prep, computeStateNet, computeEntryNet, computeEntryGeoms, computeAll };
