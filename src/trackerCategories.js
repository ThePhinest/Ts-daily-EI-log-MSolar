// ═══════════════════════════════════════════
// TRACKER CATEGORIES — B2 Session B
// ═══════════════════════════════════════════
//
// Per-project category management for the Map Tracker system.
// Categories are user-created, project-scoped, stored in Firestore.
// No hardcoded categories — empty state is correct for new projects.
//
// Storage path:
//   Firestore: users/{uid}/projects/{projectId}/trackerCategories/{catId}
//
// Category shape:
//   { id, name, color, order, measurementType, defaultUnit, createdAt, updatedAt }
//   measurementType: 'area' | 'linear'  (default 'area')
//   defaultUnit: 'ac'|'sqft'|'sqyd'|'sqm'|'ha' for area
//               'ft'|'yd'|'m'|'mi' for linear
//
// In-memory cache per project so map render calls don't await Firestore.
// Cache is populated on project load and kept in sync on save/delete.

const TC_AREA_UNITS   = ['ac','sqft','sqyd','sqm','ha'];
const TC_LINEAR_UNITS = ['ft','yd','m','mi'];
const TC_UNIT_LABELS  = {
  ac:'Acres', sqft:'Sq Ft', sqyd:'Sq Yards', sqm:'Sq Meters', ha:'Hectares',
  ft:'Feet',  yd:'Yards',   m:'Meters',       mi:'Miles'
};
// Normalize-to-base factors: area → acres, linear → feet
const _TC_AREA_FACTORS   = { ac:1, sqft:1/43560, sqyd:1/4840, sqm:1/4046.856, ha:2.47105 };
const _TC_LINEAR_FACTORS = { ft:1, yd:3, m:3.28084, mi:5280 };

function tcConvertMeasurement(value, fromUnit, toUnit){
  if(!value || fromUnit === toUnit) return value;
  const af = _TC_AREA_FACTORS, lf = _TC_LINEAR_FACTORS;
  if(af[fromUnit] !== undefined && af[toUnit] !== undefined)
    return value * af[fromUnit] / af[toUnit];
  if(lf[fromUnit] !== undefined && lf[toUnit] !== undefined)
    return value * lf[fromUnit] / lf[toUnit];
  return value;
}

function tcGetMeasurementType(catId, projectId){
  const cat = tcGetCategory(catId, projectId);
  return cat?.measurementType || 'area';
}

function tcGetDefaultUnit(catId, projectId){
  const cat = tcGetCategory(catId, projectId);
  if(cat?.defaultUnit) return cat.defaultUnit;
  return cat?.measurementType === 'linear' ? 'ft' : 'ac';
}

function tcFormatMeasurement(value, unit, decimals){
  if(value == null || value === '') return '—';
  const d = decimals !== undefined ? decimals : (['ft','yd','m'].includes(unit) ? 0 : 2);
  return parseFloat(value).toFixed(d) + ' ' + unit;
}

let _tcCache = {};   // { [projectId]: Category[] }
let _tcLoaded = {};  // { [projectId]: boolean }

const TC_DEFAULT_COLORS = [
  '#E67E22','#27AE60','#4A90E2','#9B59B6','#F4E200',
  '#D35400','#7CCD7C','#A8D8A8','#8E9BA3','#E74C3C'
];

function tcGenId(){
  return 'cat-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
}

function _tcStoragePath(projectId){
  return _udb().collection('projects').doc(projectId).collection('trackerCategories');
}

// Load all categories for a project from Firestore into memory cache.
// Call on auth-ready and on project switch.
async function tcLoadForProject(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(!pid || pid === 'default') return;
  if(typeof _udb !== 'function' || typeof _fbReady === 'undefined' || !_fbReady) return;
  if(!_udb() || !_currentUser) return;
  try {
    const snap = await _tcStoragePath(pid).orderBy('order').get();
    const cats = [];
    snap.forEach(doc => cats.push(doc.data()));
    _tcCache[pid] = cats;
    _tcLoaded[pid] = true;
  } catch(e){ console.warn('tcLoadForProject:', e.message); }
}

// Synchronous read from in-memory cache. Returns [] if not yet loaded.
function tcGetCategories(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  return (_tcCache[pid] || []).slice();
}

// Get a single category by id from cache.
function tcGetCategory(catId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  return (_tcCache[pid] || []).find(c => c.id === catId) || null;
}

// Get color for a category id, with fallback.
function tcGetColor(catId, projectId){
  const cat = tcGetCategory(catId, projectId);
  return cat ? cat.color : '#888888';
}

// Get name for a category id, with fallback.
function tcGetName(catId, projectId){
  const cat = tcGetCategory(catId, projectId);
  return cat ? cat.name : catId || 'Unknown';
}

// Pick the next default color (cycles through TC_DEFAULT_COLORS).
function tcNextColor(projectId){
  const existing = tcGetCategories(projectId);
  return TC_DEFAULT_COLORS[existing.length % TC_DEFAULT_COLORS.length];
}

// Save (create or update) a category. Updates cache and Firestore.
async function tcSaveCategory(cat, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(!pid || pid === 'default') return null;
  const now = Date.now();
  if(!cat.id) cat.id = tcGenId();
  if(!cat.createdAt) cat.createdAt = now;
  cat.updatedAt = now;
  if(cat.order === undefined){
    cat.order = (_tcCache[pid] || []).length;
  }

  // Update cache
  if(!_tcCache[pid]) _tcCache[pid] = [];
  const idx = _tcCache[pid].findIndex(c => c.id === cat.id);
  if(idx >= 0) _tcCache[pid][idx] = cat;
  else _tcCache[pid].push(cat);

  // Firestore — fire-and-forget
  if(typeof _udb === 'function' && _fbReady && _currentUser){
    try {
      _tcStoragePath(pid).doc(cat.id).set(cat)
        .catch(e => console.warn('tcSaveCategory Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return cat;
}

// Delete a category by id. Removes from cache and Firestore.
// Does NOT delete existing entries — their categoryName snapshot is preserved.
async function tcDeleteCategory(catId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(!pid || pid === 'default') return;
  if(!_tcCache[pid]) return;
  _tcCache[pid] = _tcCache[pid].filter(c => c.id !== catId);
  // Re-number order to keep it contiguous
  _tcCache[pid].forEach((c, i) => { c.order = i; });

  if(typeof _udb === 'function' && _fbReady && _currentUser){
    try {
      _tcStoragePath(pid).doc(catId).delete()
        .catch(e => console.warn('tcDeleteCategory Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
}

// Invalidate cache for a project (e.g. on project switch before reload).
function tcClearCache(projectId){
  if(projectId){
    delete _tcCache[projectId];
    delete _tcLoaded[projectId];
  } else {
    _tcCache = {};
    _tcLoaded = {};
  }
}

if(typeof window !== 'undefined'){
  window.tcLoadForProject       = tcLoadForProject;
  window.tcGetCategories        = tcGetCategories;
  window.tcGetCategory          = tcGetCategory;
  window.tcGetColor             = tcGetColor;
  window.tcGetName              = tcGetName;
  window.tcNextColor            = tcNextColor;
  window.tcSaveCategory         = tcSaveCategory;
  window.tcDeleteCategory       = tcDeleteCategory;
  window.tcClearCache           = tcClearCache;
  window.tcConvertMeasurement   = tcConvertMeasurement;
  window.tcGetMeasurementType   = tcGetMeasurementType;
  window.tcGetDefaultUnit       = tcGetDefaultUnit;
  window.tcFormatMeasurement    = tcFormatMeasurement;
  window.TC_AREA_UNITS          = TC_AREA_UNITS;
  window.TC_LINEAR_UNITS        = TC_LINEAR_UNITS;
  window.TC_UNIT_LABELS         = TC_UNIT_LABELS;
}
