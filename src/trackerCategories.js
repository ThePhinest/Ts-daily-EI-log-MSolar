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
  return _projData(projectId).collection('trackerCategories');
}

// Shared-project mirror — category definitions/schemas are live-visible
// reference data for members (submission-sharing-model visibility matrix).
// Rules allow create self-attributed; update/delete owner-or-lead; a
// reviewer's write attempt dies silently at the rules.
function _tcMirrorShared(pid, cat){
  if(!db || !window._currentUser) return;
  try {
    db.collection('projects').doc(pid).collection('trackerCategories').doc(cat.id)
      .set(Object.assign({}, cat, { ownerUid: cat.ownerUid || _currentUser.uid }))
      .catch(() => {});
  } catch(e){ /* silent */ }
}
function _tcMirrorSharedDelete(pid, catId){
  if(!db || !window._currentUser) return;
  try {
    db.collection('projects').doc(pid).collection('trackerCategories').doc(catId)
      .delete().catch(() => {});
  } catch(e){ /* silent */ }
}

// Load all categories for a project from Firestore into memory cache.
// Call on auth-ready and on project switch. Own categories merge with the
// shared-project set (members see the lead's schemas; own edits win on id
// conflicts since the mirror lags the local write).
async function tcLoadForProject(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(!pid || pid === 'default') return;
  if(typeof _udb !== 'function' || typeof _fbReady === 'undefined' || !_fbReady) return;
  if(!_udb() || !_currentUser) return;
  try {
    const snap = await _tcStoragePath(pid).orderBy('order').get();
    const cats = [];
    snap.forEach(doc => cats.push(doc.data()));
    try {
      const ssnap = await db.collection('projects').doc(pid).collection('trackerCategories').get();
      const sharedIds = new Set();
      ssnap.forEach(doc => {
        sharedIds.add(doc.id);
        if(!cats.find(c => c.id === doc.id)) cats.push(doc.data());
      });
      // One-time sync: own categories that predate the mirror get published
      // so members see existing schemas, not just future edits.
      cats.filter(c => !sharedIds.has(c.id) && snap.docs.find(d => d.id === c.id))
        .forEach(c => _tcMirrorShared(pid, c));
      cats.sort((a, b) => (a.order || 0) - (b.order || 0));
    } catch(e){ /* not a member of a shared project — own set stands */ }
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
    _tcMirrorShared(pid, cat);
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
    _tcMirrorSharedDelete(pid, catId);
  }
}

// ═══════════════════════════════════════════
// CATEGORY SCHEMA — states / templates / progress (added 2026-06-03)
// ═══════════════════════════════════════════
//
// Generalizes the seeding-centric tracker into a customizable, template-seeded
// category system. All readers below synthesize legacy defaults when the new
// fields are absent, so existing categories/entries behave exactly as before
// until edited (additive — no migration; honors Tim's 6/2 no-migration rule).
//
// New category fields (all optional):
//   template       'seeding'|'disturbance'|'linear-bmp'|'progress'|'blank'
//   states[]       ordered { id, label, color, style, pattern, isPlanned }
//                    - style: fill style (area) | line dash (linear)
//                    - isPlanned:true on the plan-baseline state → renders faint
//   trackMaterial  bool — show the lbs/ac + required/actual + seed-tag block?
//   phases[]/methods[]  per-category descriptor lists (off the global config)
//   progressMode   'per-state-vs-plan'|'running-balance'|'simple-count'
//   overallMode    'terminal'|'average'|'weighted'   (default 'terminal')
//   statePatterns  bool — distinguish states by color+pattern (vs color only)
//   disturbanceCap/capUnit  editable limit for running-balance categories
//
// New entry field: state — the state-id a child overlay belongs to.

const TC_FILL_STYLES = ['solid','hatch','crosshatch','dots'];
const TC_LINE_STYLES = ['solid','dashed','dotted'];
const TC_TEMPLATES   = ['seeding','disturbance','disturbance-cumulative','linear-bmp','progress','blank'];
const TC_TEMPLATE_LABELS = {
  seeding:'Seeding', disturbance:'Ground Disturbance', 'disturbance-cumulative':'Cumulative Disturbance',
  'linear-bmp':'Linear BMP', progress:'Progress / Phases', blank:'Blank'
};

function _tcGenStateId(){ return 's-' + Math.random().toString(36).slice(2,8); }

// Template seed schema. `measurementType` is used for templates that defer to it.
// Returns a partial category object (caller merges into the new category).
function tcTemplateSchema(template, measurementType){
  const mt = measurementType || 'area';
  const defs = {
    seeding: {
      measurementType:'area', trackMaterial:true, statePatterns:false,
      progressMode:'per-state-vs-plan', overallMode:'terminal',
      phases:['N/A','Initial','1st Reseed','2nd Reseed','3rd Reseed','Final'],
      methods:['N/A','Hydro Seeding','Drill Seeding','Broadcast Seeding','Hand Seeding','Lime Application','Fertilizer Application','Mulch Application'],
      states:[
        {label:'Planned',    color:'#8E9BA3', isPlanned:true},
        {label:'Limed',      color:'#C9A84C'},
        {label:'Fertilized', color:'#4A90E2'},
        {label:'Seeded',     color:'#27AE60'},
        {label:'Stabilized', color:'#1E6B3A'}
      ]
    },
    disturbance: {
      measurementType:'area', trackMaterial:false, statePatterns:false,
      progressMode:'running-balance', overallMode:'terminal',
      disturbanceCap:null, capUnit:'ac', phases:[], methods:[],
      states:[
        {label:'Planned',    color:'#8E9BA3', isPlanned:true},
        {label:'Disturbed',  color:'#E67E22'},
        {label:'Stabilized', color:'#27AE60'}
      ]
    },
    // Like 'disturbance' but cumulative — overlays only ADD (Stabilized never
    // subtracts). Tracks total acreage ever disturbed (SWPPP Condition 1) vs an
    // optional cap, where 'disturbance' tracks net currently-open (the 125-ac cap).
    'disturbance-cumulative': {
      measurementType:'area', trackMaterial:false, statePatterns:false,
      progressMode:'running-total', overallMode:'terminal',
      disturbanceCap:null, capUnit:'ac', phases:[], methods:[],
      states:[
        {label:'Planned',    color:'#8E9BA3', isPlanned:true},
        {label:'Disturbed',  color:'#E67E22'},
        {label:'Stabilized', color:'#27AE60'}
      ]
    },
    'linear-bmp': {
      measurementType:'linear', trackMaterial:false, statePatterns:false,
      progressMode:'per-state-vs-plan', overallMode:'terminal', phases:[], methods:[],
      states:[
        {label:'Planned',    color:'#8E9BA3', isPlanned:true},
        {label:'Installed',  color:'#4A90E2'},
        {label:'Maintained', color:'#27AE60'},
        {label:'Removed',    color:'#8E9BA3'}
      ]
    },
    progress: {
      measurementType:mt, trackMaterial:false, statePatterns:false,
      progressMode:'per-state-vs-plan', overallMode:'terminal', phases:[], methods:[],
      states:[
        {label:'Planned',  color:'#8E9BA3', isPlanned:true},
        {label:'Graded',   color:'#C9A84C'},
        {label:'Active',   color:'#4A90E2'},
        {label:'Complete', color:'#27AE60'}
      ]
    },
    blank: {
      measurementType:mt, trackMaterial:false, statePatterns:false,
      progressMode:'simple-count', overallMode:'terminal', phases:[], methods:[],
      states:[
        {label:'Planned', color:'#8E9BA3', isPlanned:true},
        {label:'Done',    color:'#27AE60'}
      ]
    }
  };
  const sch = defs[template] || defs.seeding;
  sch.template = template;
  sch.states = sch.states.map(s => ({
    id:_tcGenStateId(), style:'solid', pattern:null, isPlanned:false, ...s
  }));
  return sch;
}

function _tcResolve(catOrId, projectId){
  return (typeof catOrId === 'string') ? tcGetCategory(catOrId, projectId) : catOrId;
}

// Ordered states for a category. Synthesizes legacy [Planned(faint)+Installed] (both
// the category color) when no states[] exists — preserving today's exact look.
function tcGetStates(catOrId, projectId){
  const cat = _tcResolve(catOrId, projectId);
  if(cat && Array.isArray(cat.states) && cat.states.length) return cat.states;
  const color = cat?.color || '#888888';
  return [
    {id:'planned',   label:'Planned',   color, isPlanned:true,  style:'solid', pattern:null},
    {id:'installed', label:'Installed', color, isPlanned:false, style:'solid', pattern:null}
  ];
}

function tcGetState(catOrId, stateId, projectId){
  return tcGetStates(catOrId, projectId).find(s => s.id === stateId) || null;
}

// The plan-baseline state (faint / progress denominator).
function tcPlannedState(catOrId, projectId){
  const st = tcGetStates(catOrId, projectId);
  return st.find(s => s.isPlanned) || st[0];
}

// Default state for a freshly-drawn child overlay (first non-planned).
function tcDefaultChildState(catOrId, projectId){
  const st = tcGetStates(catOrId, projectId);
  return st.find(s => !s.isPlanned) || st[st.length-1] || null;
}

// Resolve an entry's render/aggregation state (handles legacy entryType).
function tcEntryState(entry, catOrId, projectId){
  const cat = _tcResolve(catOrId, projectId);
  if(entry && entry.entryType === 'planned') return tcPlannedState(cat, projectId);
  if(entry && entry.state){
    const s = tcGetState(cat, entry.state, projectId);
    if(s) return s;
  }
  return tcDefaultChildState(cat, projectId);
}

function tcTrackMaterial(catOrId, projectId){
  const cat = _tcResolve(catOrId, projectId);
  if(cat && typeof cat.trackMaterial === 'boolean') return cat.trackMaterial;
  return true; // legacy = seeding = material block on
}

function tcProgressMode(catOrId, projectId){
  return _tcResolve(catOrId, projectId)?.progressMode || 'per-state-vs-plan';
}

function tcOverallMode(catOrId, projectId){
  return _tcResolve(catOrId, projectId)?.overallMode || 'terminal';
}

function tcStatePatterns(catOrId, projectId){
  return _tcResolve(catOrId, projectId)?.statePatterns === true;
}

// Per-category phase/method lists; fall back to the legacy global config.
function tcCategoryPhases(catOrId, projectId){
  const cat = _tcResolve(catOrId, projectId);
  if(cat && Array.isArray(cat.phases)) return cat.phases;
  return (typeof window !== 'undefined' && window._amendmentPhases) ? window._amendmentPhases : [];
}
function tcCategoryMethods(catOrId, projectId){
  const cat = _tcResolve(catOrId, projectId);
  if(cat && Array.isArray(cat.methods)) return cat.methods;
  return (typeof window !== 'undefined' && window._amendmentMethods) ? window._amendmentMethods : [];
}

// Category identity chip — a small horizontal ramp of the category's state colors,
// in order. Replaces the old single category-color dot everywhere a category is
// listed. Self-maintaining: edit a state color and every chip updates. Falls back
// to a single swatch for a 1-state category. `h` = height px (default 10).
function tcRampChip(catOrId, projectId, h){
  const states=tcGetStates(catOrId, projectId);
  const ht=h||10;
  const w=Math.min(30, Math.max(12, states.length*6));
  const segs=states.map(s=>{
    const c=(s.color&&/^#[0-9A-Fa-f]{6}$/.test(s.color))?s.color:'#888888';
    return `<span style="display:block;flex:1 1 0;min-width:0;background:${c}"></span>`;
  }).join('');
  // Accepts a category id OR a category object (callers pass either).
  const _cat=_tcResolve(catOrId, projectId);
  const nm=(_cat&&typeof _cat.name==='string')?_cat.name:'';
  return `<span title="${nm.replace(/"/g,'&quot;')}" style="display:inline-flex;width:${w}px;height:${ht}px;border-radius:3px;overflow:hidden;flex-shrink:0;border:1px solid rgba(0,0,0,0.18);box-shadow:0 0 0 0.5px rgba(255,255,255,0.06) inset">${segs}</span>`;
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
  window.tcRampChip             = tcRampChip;
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
  // Category schema (2026-06-03)
  window.tcTemplateSchema       = tcTemplateSchema;
  window.tcGetStates            = tcGetStates;
  window.tcGetState             = tcGetState;
  window.tcPlannedState         = tcPlannedState;
  window.tcDefaultChildState    = tcDefaultChildState;
  window.tcEntryState           = tcEntryState;
  window.tcTrackMaterial        = tcTrackMaterial;
  window.tcProgressMode         = tcProgressMode;
  window.tcOverallMode          = tcOverallMode;
  window.tcStatePatterns        = tcStatePatterns;
  window.tcCategoryPhases       = tcCategoryPhases;
  window.tcCategoryMethods      = tcCategoryMethods;
  window.TC_FILL_STYLES         = TC_FILL_STYLES;
  window.TC_LINE_STYLES         = TC_LINE_STYLES;
  window.TC_TEMPLATES           = TC_TEMPLATES;
  window.TC_TEMPLATE_LABELS     = TC_TEMPLATE_LABELS;
}
