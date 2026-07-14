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

// Chronological sort key: report date (the day the ground condition was observed),
// then createdAt for same-day ordering. Entries without a date sort first.
function _chronoSort(a, b){
  return String(a.e.date||'').localeCompare(String(b.e.date||''))
    || (a.e.createdAt||0) - (b.e.createdAt||0);
}

// entries        : installed entries for ONE category (caller pre-filters planned/temporary/deleted)
// orderedStates  : non-planned child states (defines the known state ids + output order)
// Precedence     : chronological — each drawing minus everything drawn AFTER it.
// Returns { netM2:{stateId:m²}, totalM2 } or null if no usable polygon geometry exists.
function glStateNetAreasM2(entries, orderedStates){
  if(!Array.isArray(entries) || !Array.isArray(orderedStates) || !orderedStates.length) return null;
  const known = {}; orderedStates.forEach(s => { known[s.id] = true; });
  const parsed = entries.map(e => ({ e, f: _parseGeom(e) })).filter(x => x.f);
  if(!parsed.length) return null;
  parsed.sort(_chronoSort);

  const stateFeats = {}; orderedStates.forEach(s => { stateFeats[s.id] = []; });
  parsed.forEach((x, i) => {
    // Legacy unstated entries belong to the first state; an entry with a set-but-
    // UNKNOWN state id is skipped (mis-attributing it to Active would corrupt the
    // open total silently).
    let sid = x.e.state;
    if(!sid) sid = orderedStates[0].id;
    else if(!known[sid]){ console.warn('glStateNetAreasM2: unknown state id on entry', x.e.id, sid); return; }
    const later = _unionAll(parsed.slice(i + 1).map(y => y.f));
    let g = x.f;
    if(later) g = _safeDiff(g, later);
    if(g) stateFeats[sid].push(g);
  });
  const netM2 = {};
  orderedStates.forEach(s => { netM2[s.id] = _safeArea(_unionAll(stateFeats[s.id])); });
  const totalM2 = _safeArea(_unionAll(parsed.map(x => x.f)));
  return { netM2, totalM2 };
}

// Per-ENTRY net area (m²): each drawing's geometry minus the union of everything
// drawn AFTER it (chronological — later drawing wins, matching glStateNetAreasM2).
// So a list of drawings shows each one's CURRENT contribution after later work is
// drawn on top — not the misleading gross drawn size. Returns { entryId: m² } or null.
function glEntryNetAreasM2(entries, orderedStates){
  if(!Array.isArray(entries) || !Array.isArray(orderedStates) || !orderedStates.length) return null;
  const parsed = entries.map(e => ({ e, f: _parseGeom(e) })).filter(x => x.f);
  if(!parsed.length) return null;
  parsed.sort(_chronoSort);
  const out = {};
  parsed.forEach((x, i) => {
    const later = _unionAll(parsed.slice(i + 1).map(y => y.f));
    let g = x.f;
    if(later) g = _safeDiff(g, later);
    out[x.e.id] = _safeArea(g);
  });
  return out;
}

// Per-ENTRY net GEOMETRY: each drawing minus the union of everything drawn AFTER
// it (same chronological clip as the area fns above, but returns the clipped shape).
// Map rendering uses this for running-mode categories so stacked translucent fills
// never alpha-blend (yellow-over-red read as orange and collided with a real orange
// state — Tim 7/13). Returns { entryId: geometry|null } — null = fully covered by
// later drawings (outline-only on the map).
// Sliver cleanup for RENDERED clips: two drawings traced along the same edge
// never match vertex-for-vertex, so difference() leaves needle fragments that
// read as stray triangles on the map. Fragments under ~4 m² are drawing noise,
// not ground state — drop them from the DISPLAY geometry only (the acreage
// fns above keep exact math; the ~m² delta is far below drawing precision).
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

function glEntryNetGeoms(entries){
  const parsed = (entries || []).map(e => ({ e, f: _parseGeom(e) })).filter(x => x.f);
  if(!parsed.length) return null;
  parsed.sort(_chronoSort);
  const out = {};
  parsed.forEach((x, i) => {
    const later = _unionAll(parsed.slice(i + 1).map(y => y.f));
    let g = x.f;
    if(later) g = _safeDiff(g, later);
    out[x.e.id] = (g && g.geometry) ? _dropSlivers(g.geometry) : null;
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
  window.glEntryNetGeoms   = glEntryNetGeoms;
  window.glAreaConvertM2   = glAreaConvertM2;
  window.glLineLengthFt    = glLineLengthFt;
}

export { glStateNetAreasM2, glEntryNetAreasM2, glEntryNetGeoms, glAreaConvertM2, glLineLengthFt };
