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
//   Firestore    : _projData(pid).collection('trackerEntries') — FLIPPED
//                  2026-06-11 to the shared root projects/{pid}/trackerEntries.
//                  Rules: members-only; non-owners see published == true only;
//                  creates self-attributed (ownerUid); edits owner-or-lead.
//                  Every entry carries ownerUid + published (+publishedAt) —
//                  the publish flag is what a reviewer's map can see.
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
//     showDateLabel,   <- bool; render label on map at centroid
//     labelText,       <- optional custom label text (falls back to formatted date)
//     labelColor,      <- optional hex color (#rrggbb); halo stays dark
//     createdAt, updatedAt, createdBy, deletedAt, deletedFromMap
//   }

// Firestore does not support nested arrays (GeoJSON coordinates are arrays-of-arrays).
// Serialize geometry to a JSON string before any Firestore write; deserialize on read.
function _trToFs(entry){
  if(!entry || !entry.geometry) return entry;
  return {...entry, geometry: JSON.stringify(entry.geometry)};
}

// Shared-root stamps: creates must be self-attributed (rules) and work product
// is private until published. Mutates + returns the entry.
function _trStamp(entry){
  if(!entry.ownerUid && typeof _currentUser !== 'undefined' && _currentUser){
    entry.ownerUid = entry.createdBy || _currentUser.uid;
  }
  if(entry.published === undefined) entry.published = false;
  return entry;
}

// Cloud sync only for a real project: the shared root has no 'default' —
// membership rules would deny it and spam permission errors. Local-first
// storage still works; entries sync once a real project exists.
function _trCloudOk(pid){
  return pid && pid !== 'default'
    && typeof _udb === 'function' && typeof _fbReady !== 'undefined' && _fbReady
    && typeof _currentUser !== 'undefined' && !!_currentUser;
}

// Is this entry someone else's record? (Their doc is theirs — our visibility
// toggles on it are personal view state and must never write to the cloud.)
function _trForeign(entry){
  return !!(entry && entry.ownerUid && typeof _currentUser !== 'undefined'
    && _currentUser && entry.ownerUid !== _currentUser.uid);
}

// Reviewer (Glasses) holds no write capability — block before localStorage so
// the local cache can't diverge from what the rules will deny anyway.
function _trReviewerBlocked(pid){
  if(typeof window.glMyRoleFor === 'function' && window.glMyRoleFor(pid) === 'reviewer'){
    if(typeof showCloudBanner === 'function') showCloudBanner('👓 You\'re viewing this project — drawings here are read-only for your role.');
    return true;
  }
  return false;
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
  if(_trReviewerBlocked(pid)) return null;
  const now = Date.now();
  const data = _trLoadRaw(pid);
  if(!entry.id) entry.id = trGenId();
  entry.projectId = pid;
  entry.updatedAt = now;
  if(!entry.createdAt) entry.createdAt = now;
  if(!entry.createdBy && typeof _currentUser !== 'undefined' && _currentUser){
    entry.createdBy = _currentUser.uid;
  }
  _trStamp(entry);
  const idx = data.entries.findIndex(e => e.id === entry.id);
  if(idx >= 0) data.entries[idx] = entry;
  else data.entries.push(entry);
  _trSaveRaw(pid, data);
  // Firestore mirror — fire-and-forget per polished-narrative cache pattern.
  if(_trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entry.id).set(_trToFs(entry))
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
  // Foreign entry: hiding it from MY map is personal view state — local only.
  if(!_trForeign(data.entries[idx]) && _trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entryId)
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
  if(!_trForeign(data.entries[idx]) && _trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entryId)
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
  if(!_trForeign(data.entries[idx]) && _trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entryId)
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trSetMapVisibility Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Soft-delete: stamps deletedAt + updatedAt. Returns true if found.
function trDeleteEntry(entryId, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(_trReviewerBlocked(pid)) return false;
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  const ts = Date.now();
  data.entries[idx].deletedAt = ts;
  data.entries[idx].updatedAt = ts;
  _trSaveRaw(pid, data);
  if(_trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entryId)
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

// ── Per-state overlay helpers (added 2026-06-03) ──
// A child overlay carries `state` (the category state-id it belongs to) and
// `parentId` (the planned parent). Legacy children have neither → they fold
// into the category's default child state via tcDefaultChildState.

// Geometric measurement of an entry, normalized to `toUnit`. Handles the
// new measurementValue/measurementUnit shape and the legacy `acres` field.
function trEntryMeasure(entry, toUnit, projectId){
  if(!entry) return 0;
  const v = entry.measurementValue !== undefined ? parseFloat(entry.measurementValue)
          : (entry.acres !== undefined ? parseFloat(entry.acres) : NaN);
  if(isNaN(v) || !v) return 0;
  const u = entry.measurementUnit || 'ac';
  if(!toUnit || toUnit === u) return v;
  return (typeof tcConvertMeasurement === 'function') ? (tcConvertMeasurement(v, u, toUnit) || 0) : v;
}

// Resolve the state-id a child overlay aggregates under (legacy → default child state).
function trEntryStateId(entry, projectId){
  if(entry && entry.entryType === 'planned') return null; // parent, not a state bucket
  if(entry && entry.state) return entry.state;
  if(typeof tcDefaultChildState === 'function'){
    const s = tcDefaultChildState(entry?.categoryId, projectId);
    return s ? s.id : null;
  }
  return null;
}

// Live child overlays of a parent plan (excludes the parent, soft-deleted, deletedFromMap).
function trGetOverlaysForParent(parentId, projectId){
  return trGetChildEntries(parentId, projectId).filter(e => !e.deletedAt && e.entryType !== 'planned');
}

// Photo linking — adds/removes a photoId from the entry's photoIds array.
function trAddPhotoLink(entryId, photoId, projectId, type){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const data = _trLoadRaw(pid);
  const idx = data.entries.findIndex(e => e.id === entryId);
  if(idx < 0) return false;
  if(!Array.isArray(data.entries[idx].photoIds)) data.entries[idx].photoIds = [];
  if(data.entries[idx].photoIds.includes(photoId)) return true;
  data.entries[idx].photoIds.push(photoId);
  if(!data.entries[idx].photoTypes) data.entries[idx].photoTypes = {};
  data.entries[idx].photoTypes[photoId] = type || 'general';
  data.entries[idx].updatedAt = Date.now();
  _trSaveRaw(pid, data);
  if(_trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entryId)
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
  if(data.entries[idx].photoTypes) delete data.entries[idx].photoTypes[photoId];
  if(data.entries[idx].photoCaptions) delete data.entries[idx].photoCaptions[photoId];
  data.entries[idx].updatedAt = Date.now();
  _trSaveRaw(pid, data);
  if(_trCloudOk(pid)){
    try {
      _projData(pid).collection('trackerEntries').doc(entryId)
        .set(_trToFs(data.entries[idx]))
        .catch(e => console.warn('trRemovePhotoLink Firestore:', e.message));
    } catch(e){ /* silent */ }
  }
  return true;
}

// Pull all tracker entries for a project from Firestore into localStorage.
// Called on auth-ready and on project switch. Last-write-wins by updatedAt.
// Shared root is publish-gated, so an unconstrained list is not rules-provable —
// two provable queries cover everything a member may see: own records
// (published or not) + everyone's published records.
async function trLoadFromFirestore(projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  if(!_trCloudOk(pid) || !_udb()) return;
  const uid = _currentUser.uid;
  try {
    const ref = _projData(pid).collection('trackerEntries');
    const [ownSnap, pubSnap] = await Promise.all([
      ref.where('ownerUid', '==', uid).get(),
      ref.where('published', '==', true).get()
    ]);
    const remote = [];
    const remoteIds = new Set();
    [ownSnap, pubSnap].forEach(snap => snap.forEach(doc => {
      if(remoteIds.has(doc.id)) return;
      remoteIds.add(doc.id);
      const d = doc.data();
      if(typeof d.geometry === 'string'){ try{ d.geometry = JSON.parse(d.geometry); }catch{} }
      remote.push(d);
    }));
    const local = _trLoadRaw(pid).entries;
    if(remote.length === 0 && local.length === 0) return;
    // Merge: prefer the higher updatedAt on conflict.
    const byId = new Map();
    [...local, ...remote].forEach(e => {
      if(!e || !e.id) return;
      const prev = byId.get(e.id);
      if(!prev || (e.updatedAt||0) >= (prev.updatedAt||0)) byId.set(e.id, e);
    });
    // A foreign entry that no longer comes back was unpublished or removed by
    // its owner — revocation is real, so it leaves the local cache too.
    const merged = Array.from(byId.values()).filter(e =>
      !e.ownerUid || e.ownerUid === uid || remoteIds.has(e.id));
    _trSaveRaw(pid, { entries: merged });
    // Push own local-only/newer entries to Firestore (recovery for silent write
    // failures). Never push someone else's record back.
    for(const e of merged){
      if(e.ownerUid && e.ownerUid !== uid) continue;
      const rem = remote.find(r => r.id === e.id);
      if(!rem || (e.updatedAt||0) > (rem.updatedAt||0)){
        ref.doc(e.id).set(_trToFs(_trStamp(e))).catch(err => console.warn('trSync push:', err.message));
      }
    }
  } catch(e){
    console.warn('trLoadFromFirestore:', e.message);
    if(typeof showCloudBanner === 'function') showCloudBanner('⚠ Tracker cloud load failed: ' + e.message);
  }
}

// ── Publish / unpublish a set of entries (submit-day batch + Share-now) ──
// Publishing flips the one field that drives all reviewer visibility; unshare
// is the same flip back — members lose it on their next load (revocation real).
async function trSetPublished(entryIds, publish, projectId){
  const pid = projectId || ((typeof _activeProjectId === 'function') ? _activeProjectId() : 'default');
  const ids = Array.isArray(entryIds) ? entryIds : [entryIds];
  const data = _trLoadRaw(pid);
  const now = Date.now();
  const touched = [];
  ids.forEach(id => {
    const e = data.entries.find(x => x.id === id);
    if(!e) return;
    e.published = !!publish;
    e.publishedAt = publish ? now : null;
    e.updatedAt = now;
    _trStamp(e);
    touched.push(e);
  });
  if(!touched.length) return 0;
  _trSaveRaw(pid, data);
  if(_trCloudOk(pid)){
    const ref = _projData(pid).collection('trackerEntries');
    for(let i = 0; i < touched.length; i += 400){
      const batch = db.batch();
      touched.slice(i, i + 400).forEach(e => batch.set(ref.doc(e.id), _trToFs(e)));
      await batch.commit().catch(e => console.warn('trSetPublished:', e.message));
    }
  }
  return touched.length;
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
  window.trEntryMeasure = trEntryMeasure;
  window.trEntryStateId = trEntryStateId;
  window.trGetOverlaysForParent = trGetOverlaysForParent;
  window.trGetCumulativeTotals = trGetCumulativeTotals;
  window.trGetEntry = trGetEntry;
  window.trAddPhotoLink = trAddPhotoLink;
  window.trRemovePhotoLink = trRemovePhotoLink;
  window.trSaveEntry = trSaveEntry;
  window.trDeleteEntry = trDeleteEntry;
  window.trLoadFromFirestore = trLoadFromFirestore;
  window.trSetPublished = trSetPublished;
}
