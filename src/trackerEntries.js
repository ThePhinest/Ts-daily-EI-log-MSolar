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
// Entry shape (forward-compatible with Phase 4 §2 unified engine):
//   {
//     id, projectId, date,
//     categoryId,      <- reference to trackerCategories/{catId}
//     categoryName,    <- snapshot at creation time (compliance record — immutable)
//     geometry: { type, coordinates },
//     centroidLng, centroidLat, acres, location,
//     fields: { /* category-specific key/value pairs */ },
//     notes,
//     createdAt, updatedAt, createdBy, deletedAt, deletedFromMap
//   }

// Firestore does not support nested arrays (GeoJSON coordinates are arrays-of-arrays).
// Serialize geometry to a JSON string before any Firestore write; deserialize on read.
function _trToFs(entry){
  if(!entry || !entry.geometry) return entry;
  return {...entry, geometry: JSON.stringify(entry.geometry)};
}

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

function trGetChildEntries(parentId, projectId){
  return trGetEntriesForProject(projectId).filter(e => e.parentId === parentId);
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
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entry.id).set(_trToFs(entry))
        .catch(e => {
          console.warn('trSaveEntry Firestore:', e.message);
          if(typeof showCloudBanner === 'function') showCloudBanner('⚠ Entry saved locally — cloud sync failed: ' + e.message);
        });
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
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trMarkDeletedFromMap Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Archive from map: hides from map AND layer panel, keeps compliance record.
// Different from deletedFromMap (which keeps an unchecked row in the panel).
// Restore via compliance detail → Edit on Map.
function trArchiveFromMap(entryId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  const ts = Date.now();
  data.entries[idx].archivedFromMap = true;
  data.entries[idx].updatedAt = ts;
  _trSaveRaw(pid, data);
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entryId)
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trArchiveFromMap Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Set map visibility without touching deletedAt (entry stays in compliance).
function trSetMapVisibility(entryId, visible, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  const ts = Date.now();
  data.entries[idx].deletedFromMap = !visible;
  data.entries[idx].updatedAt = ts;
  _trSaveRaw(pid, data);
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entryId)
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trSetMapVisibility Firestore:', e.message));
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
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trDeleteEntry Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Cumulative totals per category across all non-deleted entries.
// Normalizes each entry's measurement to the category's defaultUnit.
// Returns [{categoryId, categoryName, measurementType, totalValue, displayUnit, entryCount}]
// sorted descending by totalValue (in display unit).
function trGetCumulativeTotals(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const entries = trGetEntriesForProject(pid);
  const map = {};
  entries.forEach(e => {
    const key = e.categoryId || '__none';
    if(!map[key]){
      const measType = (typeof tcGetMeasurementType === 'function') ? tcGetMeasurementType(e.categoryId, pid) : 'area';
      const displayUnit = (typeof tcGetDefaultUnit === 'function') ? tcGetDefaultUnit(e.categoryId, pid) : (measType === 'linear' ? 'ft' : 'ac');
      map[key] = { categoryId: e.categoryId, categoryName: e.categoryName || 'Unknown', measurementType: measType, totalValue: 0, displayUnit, entryCount: 0 };
    }
    // Resolve entry value + unit — new entries have measurementValue/measurementUnit; old have acres
    const entryValue = e.measurementValue !== undefined ? parseFloat(e.measurementValue) : parseFloat(e.acres);
    const entryUnit  = e.measurementUnit  || 'ac';
    if(entryValue && !isNaN(entryValue)){
      const normalized = (typeof tcConvertMeasurement === 'function')
        ? tcConvertMeasurement(entryValue, entryUnit, map[key].displayUnit)
        : entryValue;
      map[key].totalValue += normalized || 0;
    }
    map[key].entryCount++;
  });
  return Object.values(map).sort((a, b) => b.totalValue - a.totalValue);
}

// Photo linking — adds/removes a photoId from the entry's photoIds array.
function trAddPhotoLink(entryId, photoId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  if(!Array.isArray(data.entries[idx].photoIds)) data.entries[idx].photoIds = [];
  if(data.entries[idx].photoIds.includes(photoId)) return true;
  data.entries[idx].photoIds.push(photoId);
  data.entries[idx].updatedAt = Date.now();
  _trSaveRaw(pid, data);
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entryId)
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trAddPhotoLink Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

function trRemovePhotoLink(entryId, photoId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  if(!Array.isArray(data.entries[idx].photoIds)) return true;
  data.entries[idx].photoIds = data.entries[idx].photoIds.filter(id => id !== photoId);
  data.entries[idx].updatedAt = Date.now();
  _trSaveRaw(pid, data);
  if(typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady && typeof _currentUser !== 'undefined' && _currentUser){
    try {
      _udb().collection('projects').doc(pid).collection('trackerEntries').doc(entryId)
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trRemovePhotoLink Firestore:', e.message));
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
    snap.forEach(doc => {
      const d = doc.data();
      if(typeof d.geometry === 'string'){ try{ d.geometry = JSON.parse(d.geometry); }catch{} }
      remote.push(d);
    });
    if(remote.length === 0 && _trLoadRaw(pid).entries.length === 0) return;
    // Merge: prefer the higher updatedAt on conflict.
    const local = _trLoadRaw(pid).entries;
    const byId = new Map();
    [...local, ...remote].forEach(e => {
      if(!e || !e.id) return;
      const prev = byId.get(e.id);
      if(!prev || (e.updatedAt||0) >= (prev.updatedAt||0)) byId.set(e.id, e);
    });
    const merged = Array.from(byId.values());
    _trSaveRaw(pid, { entries: merged });
    // Push any local-only entries to Firestore (recovery for silent write failures).
    const ref = _udb().collection('projects').doc(pid).collection('trackerEntries');
    for(const e of merged){
      const rem = remote.find(r => r.id === e.id);
      if(!rem || (e.updatedAt||0) > (rem.updatedAt||0)){
        ref.doc(e.id).set(_trToFs(e)).catch(err => console.warn('trSync push:', err.message));
      }
    }
  } catch(e){
    console.warn('trLoadFromFirestore:', e.message);
    if(typeof showCloudBanner === 'function') showCloudBanner('⚠ Tracker cloud load failed: ' + e.message);
  }
}

// Window exposure — mirrors the pattern in db.js / timesheet.js.
if(typeof window !== 'undefined'){
  window.trGenId = trGenId;
  window.trGetEntriesForProject = trGetEntriesForProject;
  window.trMarkDeletedFromMap = trMarkDeletedFromMap;
  window.trArchiveFromMap = trArchiveFromMap;
  window.trSetMapVisibility = trSetMapVisibility;
  window.trGetEntriesForDate = trGetEntriesForDate;
  window.trGetEntriesForCategory = trGetEntriesForCategory;
  window.trGetChildEntries = trGetChildEntries;
  window.trGetCumulativeTotals = trGetCumulativeTotals;
  window.trGetEntry = trGetEntry;
  window.trAddPhotoLink = trAddPhotoLink;
  window.trRemovePhotoLink = trRemovePhotoLink;
  window.trSaveEntry = trSaveEntry;
  window.trDeleteEntry = trDeleteEntry;
  window.trLoadFromFirestore = trLoadFromFirestore;
}
