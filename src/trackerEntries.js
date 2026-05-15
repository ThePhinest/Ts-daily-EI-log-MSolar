// ═══════════════════════════════════════════
// TRACKER ENTRIES — B2 In-App Tracker Map (Session 1 / Stage 1.2)
// ═══════════════════════════════════════════
//
// Project-scoped storage for tracker-map entries — seeding, active
// disturbance, equipment cleaning stations, spills, rock-pick/stockpile,
// stabilized areas, etc. First concrete instance of the C13 Interactive
// Tracking Logs framework that Phase 4 §2 will generalize across all
// dynamic forms.
//
// Storage paths:
//   localStorage : msf_proj_<projectId>_tracker_entries  -> { entries: [...], _ts }
//   Firestore    : users/{uid}/projects/{projectId}/trackerEntries/{entryId}
//
// Soft-delete pattern per polish-phase #7 data integrity layer — entries
// gain `deletedAt: timestamp` instead of being removed from the array.
// Reads filter out deletedAt != null.
//
// Entry shape (forward-compatible with Phase 4 §2 unified engine):
//   {
//     id, projectId, date, category,
//     geometry: { type, coordinates },
//     centroidLng, centroidLat, acres, location,
//     fields: { /* category-specific key/value pairs */ },
//     notes,
//     createdAt, updatedAt, createdBy, deletedAt
//   }
//
// Categories — locked 2026-05-14 (see seeding-tracking-moraine wiki):
const TR_CATEGORIES = [
  'pre-seeding','temp-seeding','cover-crop','perm-seeding','ag-seeding','wetland-adj-seeding',
  'active-disturbance','stabilized',
  'cleaning-station','rock-stockpile','spill'
];

function _trStorageKey(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  return 'msf_proj_' + pid + '_tracker_entries';
}

function _trLoadRaw(projectId){
  try {
    const raw = localStorage.getItem(_trStorageKey(projectId));
    if(!raw) return { entries: [] };
    const parsed = JSON.parse(raw);
    return (parsed && Array.isArray(parsed.entries)) ? parsed : { entries: [] };
  } catch { return { entries: [] }; }
}

function _trSaveRaw(projectId, data){
  try {
    localStorage.setItem(_trStorageKey(projectId), JSON.stringify({ entries: data.entries, _ts: Date.now() }));
  } catch(e){ console.warn('trSave localStorage:', e.message); }
}

function trGenId(){
  return 'tr-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
}

// Live entries only (filters out soft-deleted).
function trGetEntriesForProject(projectId){
  return _trLoadRaw(projectId).entries.filter(e => !e.deletedAt);
}

function trGetEntriesForDate(date, projectId){
  return trGetEntriesForProject(projectId).filter(e => e.date === date);
}

function trGetEntriesForCategory(category, projectId){
  return trGetEntriesForProject(projectId).filter(e => e.category === category);
}

function trGetEntry(entryId, projectId){
  return _trLoadRaw(projectId).entries.find(e => e.id === entryId) || null;
}

// Persist entry. Creates new id if entry.id is missing. Returns the saved entry.
function trSaveEntry(entry, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const now = Date.now();
  const data = _trLoadRaw(pid);
  if(!entry.id) entry.id = trGenId();
  entry.projectId = pid;
  entry.updatedAt = now;
  if(!entry.createdAt) entry.createdAt = now;
  if(!entry.createdBy && typeof _currentUser !== 'undefined' && _currentUser){
    entry.createdBy = _currentUser.uid;
  }
  const idx = data.entries.findIndex(e => e.id === entry.id);
  if(idx >= 0) data.entries[idx] = entry;
  else data.entries.push(entry);
  _trSaveRaw(pid, data);
  // Firestore mirror — fire-and-forget per polished-narrative cache pattern.
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entry.id).set(entry)
        .catch(e => console.warn('trSaveEntry Firestore:', e.message));
    } catch(e){ /* silent — localStorage write already succeeded */ }
  }
  return entry;
}

// Map-only removal: stamps deletedFromMap:true but NOT deletedAt.
// Entry stays visible in compliance; mapRenderTrackerLayers filters it out.
// Use trDeleteEntry (below) only when deleting from compliance itself.
function trMarkDeletedFromMap(entryId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  const ts = Date.now();
  data.entries[idx].deletedFromMap = true;
  data.entries[idx].updatedAt = ts;
  _trSaveRaw(pid, data);
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entryId)
        .update({ deletedFromMap: true, updatedAt: ts })
        .catch(e => console.warn('trMarkDeletedFromMap Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Soft-delete: stamps deletedAt + updatedAt. Returns true if found.
function trDeleteEntry(entryId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  const ts = Date.now();
  data.entries[idx].deletedAt = ts;
  data.entries[idx].updatedAt = ts;
  _trSaveRaw(pid, data);
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entryId)
        .update({ deletedAt: ts, updatedAt: ts })
        .catch(e => console.warn('trDeleteEntry Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Pull all tracker entries for a project from Firestore into localStorage.
// Called on auth-ready and on project switch. Last-write-wins by updatedAt.
async function trLoadFromFirestore(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(typeof _udb !== 'function' || typeof _fbReady === 'undefined' || !_fbReady) return;
  if(!_udb()) return;
  try {
    const snap = await _udb().collection('projects').doc(pid).collection('trackerEntries').get();
    const remote = [];
    snap.forEach(doc => { remote.push(doc.data()); });
    if(remote.length === 0) return;
    // Merge: prefer the higher updatedAt on conflict.
    const local = _trLoadRaw(pid).entries;
    const byId = new Map();
    [...local, ...remote].forEach(e => {
      if(!e || !e.id) return;
      const prev = byId.get(e.id);
      if(!prev || (e.updatedAt||0) >= (prev.updatedAt||0)) byId.set(e.id, e);
    });
    _trSaveRaw(pid, { entries: Array.from(byId.values()) });
  } catch(e){ console.warn('trLoadFromFirestore:', e.message); }
}

// Window exposure — mirrors the pattern in db.js / timesheet.js.
if(typeof window !== 'undefined'){
  window.TR_CATEGORIES = TR_CATEGORIES;
  window.trGenId = trGenId;
  window.trGetEntriesForProject = trGetEntriesForProject;
  window.trMarkDeletedFromMap = trMarkDeletedFromMap;
  window.trGetEntriesForDate = trGetEntriesForDate;
  window.trGetEntriesForCategory = trGetEntriesForCategory;
  window.trGetEntry = trGetEntry;
  window.trSaveEntry = trSaveEntry;
  window.trDeleteEntry = trDeleteEntry;
  window.trLoadFromFirestore = trLoadFromFirestore;
}
