// ═══════════════════════════════════════════
// GEO — net-area engine for mutually-exclusive state categories (SWPPP disturbance)
// ═══════════════════════════════════════════
// States are ordered; a LATER state WINS any overlap. Stabilizing an active area (drawing
// a stabilization state on top) moves that ground OUT of "active" and INTO the stabilized
// state — so per-state areas are the *current* (net) area in each state, never double-counted.
//
// Non-destructive: drawings are NEVER mutated — net areas are computed from the drawn
// geometry on demand (turf). The full set of drawings stays "on the record."
//
// Scoped by the caller to running-balance / running-total categories only. Per-state-vs-plan
// categories (seeding: lime→fert→seed intentionally stack on the SAME ground) must NOT use
// this — they keep their gross per-state sums.
//
// Turf is the industry-standard JS geospatial library (Mapbox's own, GeoJSON-native).
import area from '@turf/area';
import union from '@turf/union';
import difference from '@turf/difference';
import length from '@turf/length';
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

// entries        : installed entries for ONE category (caller pre-filters planned/temporary/deleted)
// orderedStates  : non-planned child states in order — precedence = index, LATER wins
// Returns { netM2:{stateId:m²}, totalM2 } or null if no usable polygon geometry exists.
function glStateNetAreasM2(entries, orderedStates){
  if(!Array.isArray(entries) || !Array.isArray(orderedStates) || !orderedStates.length) return null;
  const byState = {}; let any = false;
  orderedStates.forEach(s => { byState[s.id] = []; });
  entries.forEach(e => {
    const f = _parseGeom(e); if(!f) return;
    const sid = e.state;
    if(byState[sid]) { byState[sid].push(f); any = true; }
    else { byState[orderedStates[0].id].push(f); any = true; } // unstated → first state
  });
  if(!any) return null;

  const unions = orderedStates.map(s => _unionAll(byState[s.id]));
  const netM2 = {};
  orderedStates.forEach((s, i) => {
    let g = unions[i];
    if(g){
      const later = _unionAll(unions.slice(i + 1)); // everything that wins over this state
      if(later) g = _safeDiff(g, later);
    }
    netM2[s.id] = _safeArea(g);
  });
  const totalM2 = _safeArea(_unionAll(unions));
  return { netM2, totalM2 };
}

// Per-ENTRY net area (m²): each drawing's geometry minus the union of all LATER-state
// drawings (later state wins). So a list of drawings shows each one's CURRENT contribution
// after stabilization is drawn on top — not the misleading gross drawn size. Returns
// { entryId: m² } or null. (For one-drawing-per-state this equals the per-state net.)
function glEntryNetAreasM2(entries, orderedStates){
  if(!Array.isArray(entries) || !Array.isArray(orderedStates) || !orderedStates.length) return null;
  const prec = {}; orderedStates.forEach((s, i) => { prec[s.id] = i; });
  const parsed = entries
    .map(e => ({ e, f: _parseGeom(e), p: (prec[e.state] != null ? prec[e.state] : 0) }))
    .filter(x => x.f);
  if(!parsed.length) return null;
  const out = {};
  parsed.forEach(x => {
    const later = _unionAll(parsed.filter(y => y.p > x.p).map(y => y.f));
    let g = x.f;
    if(later) g = _safeDiff(g, later);
    out[x.e.id] = _safeArea(g);
  });
  return out;
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
  window.glAreaConvertM2   = glAreaConvertM2;
  window.glLineLengthFt    = glLineLengthFt;
}

export { glStateNetAreasM2, glEntryNetAreasM2, glAreaConvertM2, glLineLengthFt };
