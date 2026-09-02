// ═══════════════════════════════════════════
// PHOTOS
// ═══════════════════════════════════════════
window._phPhotos = window._phPhotos || [];
window._phTrash = window._phTrash || [];
window._phShared = window._phShared || [];   // other members' PUBLISHED photos (project mirror)
var _phLbId = null;
var _phLbList = [];      // ordered photo ids the lightbox navigates through
var _phLbIndex = -1;     // current position within _phLbList
var _phPageSize = 7;
var _phDaysShown = 7;

function phGenId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function phFmtDate(d){
  if(!d) return '';
  const p = d.split('-');
  if(p.length!==3) return d;
  return `${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`;
}

function phDayLabel(d){
  if(!d) return '';
  const p = d.split('-');
  if(p.length!==3) return d;
  const dt = new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2]));
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${dt.getDate()}, ${p[0]}`;
}

// ── Parse Solocator filename for date/time ──
function phParseFilename(name){
  // Filename format: Description_text_YYYY-MM-DD_HH-MM-SS.jpeg
  const m = name.match(/^(.+?)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  if(m){
    const date = `${m[2]}-${m[3]}-${m[4]}`;
    // Convert description: underscores to spaces, capitalize first letter
    const raw = m[1].replace(/_/g,' ').trim();
    const caption = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    return { date, caption };
  }
  // No date pattern found — leave caption blank
  return { date: new Date().toLocaleDateString('en-CA'), caption: '' };
}

// ── Parse EXIF data from original file ──
async function phParseExif(file){
  const result = { lat:null, lng:null, direction:null, takenAt:null, software:null, exifCaption:null };
  try{
    if(typeof exifr === 'undefined') return result;
    const exif = await exifr.parse(file, {
      gps: true,
      tiff: true,
      exif: true,
      iptc: true,
      userComment: true
    });
    if(!exif) return result;

    // GPS
    if(exif.latitude)  result.lat = exif.latitude;
    if(exif.longitude) result.lng = exif.longitude;

    // Camera direction (compass bearing)
    if(exif.GPSImgDirection) result.direction = Math.round(exif.GPSImgDirection);

    // Timestamp
    if(exif.DateTimeOriginal) result.takenAt = exif.DateTimeOriginal.getTime
      ? exif.DateTimeOriginal.getTime()
      : Date.parse(exif.DateTimeOriginal);

    // Software tag (Solocator, etc.)
    if(exif.Software) result.software = exif.Software.trim();

    // Caption from Solocator UserComment — format: "PROJECT NAME: x DESCRIPTION: y WATERMARK: z"
    const uc = exif.UserComment || exif.ImageDescription || '';
    if(typeof uc === 'string' && uc.trim()){
      const descMatch = uc.match(/DESCRIPTION:\s*([^\n]+?)(?:\s*WATERMARK:|$)/i);
      const projMatch = uc.match(/PROJECT NAME:\s*([^\n]+?)(?:\s*DESCRIPTION:|$)/i);
      const desc = descMatch?.[1]?.trim();
      const proj = projMatch?.[1]?.trim();
      // Only use if not technical metadata (tilt/roll data)
      if(desc && !/tilt_angle|roll_angle/i.test(desc)) result.exifCaption = desc;
      else if(proj && !/tilt_angle|roll_angle/i.test(proj)) result.exifCaption = proj;
    }
    // Also check IPTC Caption-Abstract — but skip tilt/roll technical data
    if(!result.exifCaption && exif.Caption){
      const cap = exif.Caption.trim();
      if(!/tilt_angle|roll_angle/i.test(cap)) result.exifCaption = cap;
    }
  }catch(e){ console.warn('phParseExif failed:', e.message); }
  return result;
}

// ── Compass bearing to label ──
function phBearingLabel(deg){
  if(deg===null||deg===undefined) return '';
  const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg/22.5)%16];
}

// ── Compress image to base64 ──
function phCompress(file, maxW, maxH, quality){
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > maxW || h > maxH){
          const ratio = Math.min(maxW/w, maxH/h);
          w = Math.round(w*ratio); h = Math.round(h*ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Handle file upload ──
async function phHandleFiles(files){
  if(!files || files.length===0) return;
  const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
  if(arr.length===0) return;

  const prog = document.getElementById('ph-progress');
  const progBar = document.getElementById('ph-progress-bar');
  const progTxt = document.getElementById('ph-progress-txt');
  prog.style.display = 'block';

  for(let i=0; i<arr.length; i++){
    const file = arr[i];
    progTxt.textContent = `Uploading photo ${i+1} of ${arr.length}…`;
    progBar.style.width = `${Math.round(((i)/arr.length)*100)}%`;

    const { date, caption: filenameCaption } = phParseFilename(file.name);
    const id = phGenId();

    // Read EXIF BEFORE compression (compression strips metadata)
    const exif = await phParseExif(file);

    // Caption priority: EXIF description → EXIF project name → filename parse
    const caption = exif.exifCaption || filenameCaption || '';

    // Use EXIF date if available and more precise
    let photoDate = date;
    if(exif.takenAt){
      const d = new Date(exif.takenAt);
      if(!isNaN(d)) photoDate = d.toLocaleDateString('en-CA');   // 9/2 (#103): LOCAL day — toISOString put evening shots on tomorrow's date (UTC)
    }

    // Thumbnail only for in-app display
    const thumb = await phCompress(file, 140, 105, 0.7);

    // Upload original to Firebase Storage at full quality
    let storageUrl = '';
    try{
      const storageRef = storage.ref(`photos/${_currentUser.uid}/${id}/${file.name}`);
      const snapshot = await storageRef.put(file);
      storageUrl = await snapshot.ref.getDownloadURL();
    }catch(e){ console.warn('Storage upload failed:', e.message); }

    const entry = {
      id,
      date: photoDate,
      caption,
      filename: file.name,
      thumb,
      storageUrl,
      uploadedAt: Date.now(),
      projectId: _activeProjectId(),
      ...(exif.lat !== null && { lat: exif.lat, lng: exif.lng }),
      ...(exif.direction !== null && { direction: exif.direction }),
      ...(exif.takenAt && { takenAt: exif.takenAt }),
      ...(exif.software && { software: exif.software })
    };

    window._phPhotos.push(entry);
    phMarkDirty(entry.id);
  }

  progBar.style.width = '100%';
  progTxt.textContent = `${arr.length} photo${arr.length>1?'s':''} uploaded successfully`;
  setTimeout(()=>{ prog.style.display='none'; progBar.style.width='0%'; }, 2500);

  document.getElementById('ph-file-input').value = '';

  phSave();
  phRender();
  mapRenderPhotoPins();
}

// ── Persistence ──
// Soft delete: _phPhotos holds only live photos, so every consumer (gallery, map
// pins, compliance links, exports) stays deleted-free without per-site filters.
// Deleted photos live in _phTrash for the 30-day undo window.
const PH_TRASH_RETENTION_MS = 30*24*60*60*1000;
function _phPartition(list){
  const live=[], trash=[];
  (list||[]).forEach(p => { (p && p.deletedAt ? trash : live).push(p); });
  window._phPhotos = live;
  window._phTrash = trash;
}

// Tier-1 device cache — photos live in IndexedDB (record-per-key `ph:<id>`),
// not localStorage. Live + trash are one keyspace; partition is by deletedAt.
// (Storage architecture locked 2026-06-17 — see KB storage-architecture.md.)
const PH_IDB_PREFIX = 'ph:';
// Write only what changed (8/24, boot timeline): phSaveLocal used to structured-
// clone EVERY record into IndexedDB on every call — 1,681 photos × ~30 KB thumb
// ≈ 51 MB per caption edit, per boot, per listener delta. Each record now has a
// signature (every field except the thumb, which never changes after creation,
// plus the thumb's length); only records whose signature moved are written.
// Stale keys (hard delete / trash sweep) are still removed.
const _phSigMap = new Map();
// Signature = change detection between a local record and its cloud doc.
// null / undefined / false are all "not set" — _phDocFor writes explicit
// falsy values (swppp:false, tagCount:null, …) that a fresh local record
// simply lacks; treating them as different made EVERY new photo's first
// write ack look like a change (the 8/25 caption bug's first domino).
function _phSig(p){
  let s = '';
  for(const k of Object.keys(p).sort()){
    if(k === 'thumb') continue;
    const v = p[k];
    if(v === null || v === undefined || v === false) continue;
    s += k + '=' + ((v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v)) + ';';
  }
  return s + 'thumb#' + (p.thumb ? p.thumb.length : 0);
}
function phSaveLocal(){
  const all = (window._phPhotos||[]).concat(window._phTrash||[]).filter(p => p && p.id);
  const want = new Set(all.map(p => PH_IDB_PREFIX + p.id));
  const stale = (window.idbKeysWithPrefix ? window.idbKeysWithPrefix(PH_IDB_PREFIX) : []).filter(k => !want.has(k));
  const changed = [];
  for(const p of all){
    const sig = _phSig(p);
    if(_phSigMap.get(p.id) !== sig){ _phSigMap.set(p.id, sig); changed.push([PH_IDB_PREFIX + p.id, p]); }
  }
  if(changed.length && window.idbSetMany) window.idbSetMany(changed);
  if(stale.length && window.idbDelMany){
    window.idbDelMany(stale);
    stale.forEach(k => _phSigMap.delete(k.slice(PH_IDB_PREFIX.length)));
  }
}

function phLoadLocal(){
  const recs = window.idbGetPrefix ? window.idbGetPrefix(PH_IDB_PREFIX) : [];
  _phSigMap.clear();
  recs.forEach(p => { if(p && p.id) _phSigMap.set(p.id, _phSig(p)); });
  _phPartition(recs);
}

// One-time migration: move the legacy localStorage blobs (ph_photos/ph_trash)
// into record-per-key IDB, then drop them from localStorage (frees ~4.6 MB —
// the root cause of the 6/17 calendar regression). Idempotent: the absence of
// the localStorage keys is the done-signal. Must run AFTER `await idbReady`.
async function phMigrateLocalToIdb(){
  let raw, rawT;
  try{ raw = localStorage.getItem('ph_photos'); rawT = localStorage.getItem('ph_trash'); }catch{ return; }
  if(raw == null && rawT == null) return; // already migrated / nothing to move
  let list = [];
  if(raw){ try{ list = JSON.parse(raw) || []; }catch{} }
  if(rawT){ try{ list = list.concat(JSON.parse(rawT) || []); }catch{} }
  const pairs = list.filter(p => p && p.id).map(p => [PH_IDB_PREFIX + p.id, p]);
  if(pairs.length && window.idbSetMany) window.idbSetMany(pairs);
  try{ localStorage.removeItem('ph_photos'); localStorage.removeItem('ph_trash'); }catch{}
  if(pairs.length) console.log('phMigrate: moved', pairs.length, 'photos localStorage → IndexedDB');
}

// ── Dirty-ID cloud sync ──
// phSaveCloud used to re-batch the ENTIRE library on every change — at 400+
// photos (thumbs included) that exhausts Firestore's write stream
// (resource-exhausted) and each retry re-sends megabytes. Worse: if the batch
// died on a weak field connection, the next phLoadCloud replaced the local
// list from cloud and the unflushed photo VANISHED (the 7/8 "photos not
// saving" field report). Now every mutation marks its photo dirty; only dirty
// docs are written (chunked ≤400/batch, under Firestore's 500-op limit); the
// pending set persists across reloads (gl_ph_dirty, uid-fenced with the rest
// of localStorage) and phLoadCloud keeps pending local records instead of
// dropping them.
const _phDirtyIds = new Set();
try{ (JSON.parse(localStorage.getItem('gl_ph_dirty')||'[]')||[]).forEach(id=>_phDirtyIds.add(id)); }catch{}
function _phPersistDirty(){
  try{ localStorage.setItem('gl_ph_dirty', JSON.stringify([..._phDirtyIds])); }catch{}
}
function phMarkDirty(idOrIds){
  (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).forEach(id => { if(id) _phDirtyIds.add(id); });
  _phPersistDirty();
}

// Per-photo cloud doc shape (shared by the dirty flush + phSaveCloudOne).
function _phDocFor(p){
  const doc = {
    id: p.id, date: p.date, caption: p.caption,
    filename: p.filename, thumb: p.thumb, uploadedAt: p.uploadedAt
  };
  if(p.storageUrl) doc.storageUrl = p.storageUrl;
  if(p.lat !== undefined){ doc.lat = p.lat; doc.lng = p.lng; }
  if(p.direction !== undefined) doc.direction = p.direction;
  if(p.takenAt) doc.takenAt = p.takenAt;
  if(p.software) doc.software = p.software;
  if(p.projectId) doc.projectId = p.projectId;
  if(p.type) doc.type = p.type;
  // swppp/seedTag/locLabel write explicit falsy values: the flush is merge:true,
  // so a truthy-only write means an untag/clear NEVER reaches the cloud and other
  // devices resurrect it on next load.
  doc.swppp = !!p.swppp;
  doc.seedTag = !!p.seedTag;
  if(p.seedCap) doc.seedCap = p.seedCap;
  if(p.distCap) doc.distCap = p.distCap;
  if(p.plCap) doc.plCap = true;
  // 🌱 bag ledger (applications.js): tags-in-photo + material overrides. Explicit
  // null when cleared — merge:true would otherwise resurrect an old override.
  doc.tagCount = (p.tagCount>0) ? p.tagCount : null;
  doc.tagProduct = p.tagProduct || null;
  // 🌱 leftover-tag transfer (8/20): tagClosed = this tag's leftover was retired
  // (or carried on); carryLbs = SNAPSHOT of the pounds carried INTO this tag photo
  // from carryFrom (never recomputed — Tim: live recompute "could create chaos").
  doc.tagClosed = !!p.tagClosed;
  doc.carryLbs = (p.carryLbs>0) ? p.carryLbs : null;
  doc.carryFrom = p.carryFrom || null;
  // 📸 in-app camera fields (src/camera.js): the metadata record half of the
  // two-layer model — the stamp overlay renders from these on demand.
  if(p.locLabel != null) doc.locLabel = p.locLabel;
  if(p.repairTag) doc.repairTag = true;
  if(p.gpsAcc !== undefined) doc.gpsAcc = p.gpsAcc;
  if(p.published !== undefined){ doc.published = p.published; doc.publishedAt = p.publishedAt || null; }
  // 📄 report exclusion (9/1): explicit falsy so re-including syncs across devices.
  doc.reportExclude = !!p.reportExclude;
  return doc;
}

async function phSaveCloud(){
  if(!db || !_fbReady || !_phDirtyIds.size) return;
  const byId = {};
  (window._phPhotos||[]).forEach(p => { byId[p.id] = p; });
  const ids = [..._phDirtyIds];
  for(let i = 0; i < ids.length; i += 400){
    const slice = ids.slice(i, i + 400);
    const chunk = slice.filter(id => byId[id]);
    // ids no longer in the live list (deleted/trashed since): the delete path
    // writes its own doc update, so there's nothing left to flush here.
    slice.forEach(id => { if(!byId[id]) _phDirtyIds.delete(id); });
    if(!chunk.length){ _phPersistDirty(); continue; }
    try{
      const batch = db.batch();
      // merge:true so a device that hasn't seen a delete yet can't strip
      // deletedAt off the cloud doc and resurrect a deleted photo
      chunk.forEach(id => batch.set(_udb().collection('photos').doc(id), _phDocFor(byId[id]), { merge:true }));
      await batch.commit();
      chunk.forEach(id => _phDirtyIds.delete(id));
      _phPersistDirty();
    }catch(e){
      // Kept dirty — retried on the next phSave / app boot.
      console.warn('phSaveCloud chunk failed (kept pending for retry):', e.message);
    }
  }
}

// ── Cloud photos: persistent listener (8/24, boot timeline on Tim's phone) ──
// Was: one-shot .get() of the whole `photos` collection every launch — 1,681
// docs / 51.7 MB of thumbs (13 s cold in the field, the 48K-reads/day root
// cause) — then a full repartition + full IDB rewrite. Now: Firestore's own
// delta mechanism. With persistence + an unlimited cache (db.js) the SDK keeps
// a resume point per query; on each launch the listener first replays from its
// local cache (instant) and the server then sends ONLY docs that changed since
// this device last listened — tracked server-side, so it holds across app
// versions and devices, with nothing to stamp, migrate, or reconcile. Changes
// are applied from docChanges(): a change whose record signature equals the
// local copy is ignored (the cache replay and our own write acks are no-ops),
// so the boot cost is a signature pass, not 1,681 parses + 51 MB of IDB.
// Rules kept from the old path: a pending local write wins over the cloud copy
// until it flushes (a dead-zone upload must never vanish); a cache-only
// snapshot never proves a server-side removal (#52 offline rule), so removals
// apply only from server snapshots. Live deltas after boot re-render the grid
// and map pins — the other device's photos appear within seconds.
let _phUnsub = null, _phCloudSettled = false;
function _phApplySnapshot(snap){
  const fromCache = !!(snap.metadata && snap.metadata.fromCache);
  const byId = new Map();
  (window._phPhotos||[]).concat(window._phTrash||[]).forEach(p => { if(p && p.id) byId.set(p.id, p); });
  let applied = 0, removed = 0, kb = 0;
  snap.docChanges().forEach(ch => {
    const id = ch.doc.id;
    if(ch.type === 'removed'){
      if(fromCache) return;
      if(byId.delete(id)) removed++;
      return;
    }
    const cloud = ch.doc.data();
    if(!cloud || !cloud.id) return;
    const local = byId.get(id);
    if(!local){ byId.set(id, cloud); applied++; kb += (cloud.thumb ? cloud.thumb.length : 0); return; }
    // A pending local write wins wholesale until it flushes (its doc is on
    // its way; the cloud copy here is older by definition).
    if(_phDirtyIds.has(id)) return;
    // MERGE IN PLACE — never swap the object. Live code holds references to
    // these records (the camera's post-shot strip + upload IIFE, the lightbox,
    // popups); replacing the object detached them, so a caption edited after
    // the first write ack landed on an orphan and the library kept the
    // capture-time carry-forward caption (8/25: "tons of photos miscaptioned",
    // camera roll right, app wrong). Local-only extras (alt, …) survive.
    const before = _phSig(local);
    const merged = Object.assign({}, local, cloud);
    if(_phSig(merged) === before) return;   // identical → nothing to do
    Object.assign(local, cloud); applied++; kb += (cloud.thumb ? cloud.thumb.length : 0);
  });
  if(applied || removed){
    _phPartition([...byId.values()]);
    phSaveLocal();
  }
  return { applied, removed, fromCache, kb: Math.round(kb/1024), total: snap.size };
}
function phWatchCloud(){
  if(!db) return Promise.resolve(false);
  if(_phUnsub){ try{ _phUnsub(); }catch(_){} _phUnsub = null; }
  return new Promise(resolve => {
    let settled = false;
    const done = (ok) => { if(!settled){ settled = true; _phCloudSettled = true; clearTimeout(timer); resolve(ok); } };
    // Offline / slow link: boot proceeds on the local copy after 8 s; the listener stays up and applies the server delta whenever it lands.
    const timer = setTimeout(() => done(false), 8000);
    try{
      _phUnsub = _udb().collection('photos').onSnapshot({ includeMetadataChanges: true }, snap => {
        const r = _phApplySnapshot(snap);
        if(typeof glBootMark === 'function') glBootMark('ph-snap', { changes: snap.docChanges().length, applied: r.applied, removed: r.removed, fromCache: r.fromCache, kb: r.kb, total: r.total });
        if((r.applied || r.removed) && settled){
          phRender();
          if(typeof mapRenderPhotoPins === 'function'){ try{ mapRenderPhotoPins(); }catch(_){} }
        }
        if(!r.fromCache){
          if(_phDirtyIds.size) phSaveCloud();
          done(true);
        }
      }, err => { console.warn('photos listener:', err && err.message); done(false); });
    }catch(e){ console.warn('photos listener failed:', e && e.message); done(false); }
  });
}
async function phLoadCloud(){ return phWatchCloud(); }   // legacy name — boot path

function phSave(){
  phSaveLocal();
  phSaveCloud();
}

// ── One-time recovery: re-fetch storageUrl for photos missing it ──
const _phRecover404 = new Set();   // 9/1: one 404 per photo per session, not a flood on every pass
async function phRecoverStorageUrls(){
  if(!storage || !_udb()) return;
  const missing = window._phPhotos.filter(p => !p.storageUrl && p.filename && !_phRecover404.has(p.id));
  if(!missing.length) return;
  let fixed = 0;
  for(const p of missing){
    try{
      const url = await storage.ref(`photos/${_currentUser.uid}/${p.id}/${p.filename}`).getDownloadURL();
      p.storageUrl = url;
      phMarkDirty(p.id);
      fixed++;
    }catch(e){ _phRecover404.add(p.id); }
  }
  if(fixed > 0){
    phSave();
    console.log('phRecoverStorageUrls: recovered ' + fixed + ' photos');
  }
}

// ── 📸 Offline upload retry (camera v2) ──
// A camera shot whose Storage upload failed in the field keeps its ORIGINAL
// bytes in IDB (cam_pending::<id>, written by phSaveCameraPhoto) and retries
// here on reconnect / foreground / boot until the upload lands. The record was
// never at risk (local-first save); this heals the full-res cloud copy too.
let _phRetryBusy=false;
async function phRetryPendingUploads(){
  if(_phRetryBusy||!_currentUser||!storage||!_fbReady) return;
  if(!window.idbKeysWithPrefix) return;
  const keys=window.idbKeysWithPrefix('cam_pending::');
  if(!keys.length) return;
  _phRetryBusy=true;
  try{
    for(const key of keys){
      const id=key.slice('cam_pending::'.length);
      const p=(window._phPhotos||[]).find(x=>x.id===id);
      if(!p){ window.idbDel(key); continue; }            // photo deleted — drop the bytes
      if(p.storageUrl){ window.idbDel(key); continue; }  // healed elsewhere
      const blob=window.idbGet(key);
      if(!(blob instanceof Blob)){ window.idbDel(key); continue; }
      try{
        const ref=storage.ref(`photos/${_currentUser.uid}/${id}/${p.filename||('camera-'+id+'.jpg')}`);
        const snap=await ref.put(blob,{contentType:'image/jpeg'});
        p.storageUrl=await snap.ref.getDownloadURL();
        phSaveLocal(); phSaveCloudOne(p);
        window.idbDel(key);
        console.log('phRetryPendingUploads: healed '+id);
      }catch(e){
        // still offline / weak signal — next trigger tries again; keep the reason
        // so Diagnostics can show WHY a shot is still parked (9/1).
        _phUploadLastErr={id,at:Date.now(),msg:(e&&(e.code||e.message))||'upload failed'};
        console.warn('phRetryPendingUploads: '+id+' still pending —',e&&(e.code||e.message));
      }
    }
  }finally{ _phRetryBusy=false; }
}
window.phRetryPendingUploads=phRetryPendingUploads;
window.addEventListener('online',()=>{ setTimeout(phRetryPendingUploads,1500); });
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) setTimeout(phRetryPendingUploads,1500); });
// 9/1: a weak-signal morning can leave shots parked for hours while the app
// stays open in the foreground (no online/visibility event ever fires) —
// sweep every 2 minutes whenever anything is parked.
let _phUploadLastErr=null;
setInterval(()=>{ try{ if(window.idbKeysWithPrefix&&window.idbKeysWithPrefix('cam_pending::').length) phRetryPendingUploads(); }catch(_){} },120000);
// Diagnostics probe: what's parked, what never got a full-res copy, last error.
function phUploadHealth(){
  let pending=[]; try{ pending=(window.idbKeysWithPrefix?window.idbKeysWithPrefix('cam_pending::'):[]).map(k=>k.slice('cam_pending::'.length)); }catch(_){}
  const noUrl=(window._phPhotos||[]).filter(p=>p.type==='camera'&&!p.storageUrl&&p.filename);
  return { pending, pendingCount:pending.length, missingFullRes:noUrl.length,
    missingIds:noUrl.map(p=>p.id), missingDates:[...new Set(noUrl.map(p=>p.date))].sort(),
    lastErr:_phUploadLastErr };
}
window.phUploadHealth=phUploadHealth;

// Find a photo by id — own library first, then the project's shared mirror
// (other members' published photos, opened from map pins).
function _phById(id){
  return window._phPhotos.find(x=>x.id===id)
    || (window._phShared||[]).find(x=>x.id===id)
    || null;
}

// ── Load full image for lightbox ──
async function phGetFull(id){
  const p = _phById(id);
  if(p && p.storageUrl) return p.storageUrl;
  if(p && p.full) return p.full; // backwards compat for old entries
  return p ? p.thumb : '';
}

// ── Publish / unpublish photos (submit-day batch + lightbox Share button) ──
// "Explicit publish, keep your original": the library doc gets the published
// stamp; a capability-carrying copy (storageUrl = the token, same trust model
// as KML downloadUrl) is mirrored into projects/{pid}/photos for members.
// Unshare deletes the mirror — revocation is real.
async function phSetPublished(ids, publish, projectId){
  const pid = projectId || ((typeof _activeProjectId==='function') ? _activeProjectId() : 'default');
  const list = Array.isArray(ids) ? ids : [ids];
  const now = Date.now();
  const touched = [];
  list.forEach(id => {
    const p = window._phPhotos.find(x=>x.id===id);
    if(!p) return;
    p.published = !!publish;
    p.publishedAt = publish ? now : null;
    touched.push(p);
  });
  if(!touched.length) return 0;
  phSaveLocal();
  if(db && _fbReady && _currentUser && pid && pid !== 'default'){
    try{
      const batch = db.batch();
      touched.forEach(p => {
        batch.set(_udb().collection('photos').doc(p.id),
          { published: p.published, publishedAt: p.publishedAt }, { merge:true });
        const mref = db.collection('projects').doc(pid).collection('photos').doc(p.id);
        if(publish){
          batch.set(mref, _phMirrorDoc(p, pid, now));
        } else {
          batch.delete(mref);
        }
      });
      await batch.commit();
    }catch(e){ console.warn('phSetPublished:', e.message); }
  }
  return touched.length;
}

// ── 📄 Report photo selection (9/1) ──
// One flag drives both the daily report's photo picker and the submit-day
// sheet: reportExclude=true means "not in the report" AND shows unchecked at
// submit; checking it in either place clears the flag. Stored on the user's
// own photo doc (cloud + IDB) so re-exports and the reviewer snapshot honor it.
async function phSetReportExclude(ids, exclude){
  const list = Array.isArray(ids) ? ids : [ids];
  const touched = [];
  list.forEach(id => {
    const p = (window._phPhotos||[]).find(x=>x.id===id);
    if(!p) return;
    if(!!p.reportExclude === !!exclude) return;
    p.reportExclude = !!exclude;
    touched.push(p.id);
  });
  if(!touched.length) return 0;
  phSaveLocal();
  phMarkDirty(touched);
  if(db && _fbReady && _currentUser){ try{ await phSaveCloud(); }catch(e){ console.warn('phSetReportExclude:', e.message); } }
  return touched.length;
}

// Export bytes for a SNAPSHOT photo ref (report.js / swpppPdf.js): the healed
// Storage copy first; on the author's own device fall back to the live library
// record (offline-pending camera original → Storage → thumb) so a shot whose
// upload hadn't landed at generate time still prints. A reviewer's device has
// no library copy — it gets the Storage URL or nothing, by design.
async function phExportBlobForRef(ref){
  if(!ref) return null;
  if(ref.storageUrl){ try{ const r=await fetch(ref.storageUrl); if(r.ok) return await r.blob(); }catch(e){} }
  const live = ref.id ? _phById(ref.id) : null;
  if(live){ try{ const b=await _phFullBlob(live); if(b) return b; }catch(e){} }
  const raw = ref.thumb||'';
  if(raw.startsWith('data:')){
    const b64=raw.split(',')[1]; const bin=atob(b64);
    const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    return new Blob([arr],{type:'image/jpeg'});
  }
  return null;
}

// The project-mirror copy of a published photo. 9/1: carries the WHOLE camera
// metadata record (type, locLabel, gpsAcc, alt, tags…) — the stamp overlay a
// teammate sees renders from these on demand (two-layer model), so a mirror
// without `type:'camera'` showed reviewers a clean, unstamped photo (Tim 9/1).
function _phMirrorDoc(p, pid, now){
  now = now || Date.now();
  const m = { id:p.id, date:p.date||'', caption:p.caption||'', thumb:p.thumb||'',
    projectId: pid, ownerUid: _currentUser.uid,
    ownerName: (typeof window._glMyName==='function') ? window._glMyName() : (_currentUser.displayName||_currentUser.email||''),
    published: true, publishedAt: p.publishedAt||now, uploadedAt: p.uploadedAt||now };
  if(p.storageUrl) m.storageUrl = p.storageUrl;
  if(p.filename) m.filename = p.filename;
  if(p.type) m.type = p.type;
  if(p.lat !== undefined){ m.lat = p.lat; m.lng = p.lng; }
  if(p.direction !== undefined) m.direction = p.direction;
  if(p.takenAt) m.takenAt = p.takenAt;
  if(p.locLabel != null) m.locLabel = p.locLabel;
  if(p.gpsAcc !== undefined) m.gpsAcc = p.gpsAcc;
  if(p.alt !== undefined) m.alt = p.alt;
  if(p.software) m.software = p.software;
  m.swppp = !!p.swppp; m.seedTag = !!p.seedTag; m.repairTag = !!p.repairTag;
  if(p.plCap) m.plCap = true;
  return m;
}
// One-time backfill (9/1): rewrite every already-published photo's mirror with
// the full record so teammates' lightboxes stamp them too. Per project, once.
async function _phRemirrorPublished(pid, force){
  pid = pid || ((typeof _activeProjectId==='function') ? _activeProjectId() : null);
  if(!db || !_fbReady || !_currentUser || !pid || pid==='default') return;
  const flag='gl_ph_mirror_v2_'+pid;
  try{ if(!force && localStorage.getItem(flag)==='1') return; }catch(_){}
  const pubs=(window._phPhotos||[]).filter(p=>p.published && (!p.projectId || p.projectId===pid));
  try{
    // merge:true + no thumb: the mirror already holds the thumbnail, and 400
    // thumbs per batch would blow Firestore's ~10 MiB request cap.
    for(let i=0;i<pubs.length;i+=150){
      const batch=db.batch();
      pubs.slice(i,i+150).forEach(p=>{ const m=_phMirrorDoc(p,pid); delete m.thumb; batch.set(db.collection('projects').doc(pid).collection('photos').doc(p.id), m, {merge:true}); });
      await batch.commit();
    }
    try{ localStorage.setItem(flag,'1'); }catch(_){}
    if(pubs.length) console.log('photos: re-mirrored '+pubs.length+' published photos with full records');
  }catch(e){ console.warn('photo re-mirror deferred:', e.message); }
}

// ── Other members' published photos for the active project (map pins +
// the "Shared by project members" section on the Photos page) ──
async function phLoadShared(projectId){
  window._phShared = [];
  if(!db || !_fbReady || !_currentUser) return;
  const pid = projectId || ((typeof _activeProjectId==='function') ? _activeProjectId() : 'default');
  if(!pid || pid === 'default') return;
  try{
    const snap = await db.collection('projects').doc(pid).collection('photos')
      .where('published','==',true).get();
    const mine = _currentUser.uid;
    snap.forEach(d => {
      const p = d.data();
      if(p.ownerUid !== mine) window._phShared.push(p);
    });
  }catch(e){ /* not a member of a shared project — nothing to show */ }
  _phRenderShared();
}

// "Shared by project members" — published photos from teammates. Mirrors the
// Recently Deleted pattern (Tim, 6/11): ALWAYS-present collapsible section
// (so everyone knows it exists, even before anything is shared) + an
// always-visible 👥 count button at the top that jumps to it — never buried
// under a long own-photo library. Read-only (lightbox opens, no caption edit).
let _phSharedOpen = false;
function _phToggleShared(){ _phSharedOpen = !_phSharedOpen; _phRenderShared(); }
function phJumpToShared(){
  if(!_phSharedOpen){ _phSharedOpen = true; _phRenderShared(); }
  document.getElementById('ph-shared')?.scrollIntoView({ behavior:'smooth', block:'start' });
}
// 9/1: filter the shared section by teammate (Tim: reviewers with several EIs).
const _hEsc=t=>String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
let _phSharedPerson = 'all';
function _phSharedSetPerson(uid){ _phSharedPerson = uid || 'all'; _phRenderShared(); }
window._phSharedSetPerson = _phSharedSetPerson;
function _phOwnerName(p){
  return p.ownerName || (typeof window.glMemberNameFor==='function' ? window.glMemberNameFor(p.ownerUid) : '') || 'Member';
}
function _phRenderShared(){
  const box = document.getElementById('ph-shared');
  if(!box) return;
  const all = (window._phShared||[]).slice();
  const owners = {};
  all.forEach(p=>{ if(p.ownerUid && !owners[p.ownerUid]) owners[p.ownerUid] = _phOwnerName(p); });
  const ownerIds = Object.keys(owners).sort((a,b)=>owners[a].localeCompare(owners[b]));
  if(_phSharedPerson!=='all' && !owners[_phSharedPerson]) _phSharedPerson='all';
  const personRow = ownerIds.length>1
    ? '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px">'
      + `<button class="cl-fpill cl-fall${_phSharedPerson==='all'?' on':''}" onclick="_phSharedSetPerson('all')">All</button>`
      + ownerIds.map(uid=>`<button class="cl-fpill${_phSharedPerson===uid?' on':''}" style="display:inline-flex;align-items:center;gap:6px" onclick="_phSharedSetPerson('${_hEsc(uid)}')">${typeof window.glMemberChip==='function'?window.glMemberChip(uid,owners[uid],14):''}${_hEsc(owners[uid])}</button>`).join('')
      + '</div>'
    : '';
  const shared = all.filter(p=>_phSharedPerson==='all' || p.ownerUid===_phSharedPerson)
    .sort((a,b)=> b.date > a.date ? 1 : b.date < a.date ? -1 : (b.uploadedAt||0)-(a.uploadedAt||0));
  const cnt = document.getElementById('ph-shared-count');
  if(cnt) cnt.textContent = shared.length;
  const grouped = {};
  shared.forEach(p=>{ if(!grouped[p.date]) grouped[p.date]=[]; grouped[p.date].push(p); });
  const idsLiteral = '['+shared.map(p=>`'${_hEsc(p.id)}'`).join(',')+']';
  const body = !shared.length
    ? '<div class="ph-empty" style="padding:16px 20px">No teammate photos yet — photos shared by project members appear here the moment they publish them.</div>'
    : Object.keys(grouped).sort((a,b)=>b>a?1:-1).map(date => `
      <div class="ph-day-group">
        <div class="ph-day-label">${phDayLabel(date)} <span class="ph-day-count">${grouped[date].length} photo${grouped[date].length>1?'s':''}</span></div>
        <div class="ph-grid">
          ${grouped[date].map(p=>`
            <div class="ph-thumb" onclick="phOpenLightbox('${_hEsc(p.id)}',${idsLiteral})">
              <img src="${_hEsc(p.thumb)}" alt="${_hEsc(p.caption)}" loading="lazy">
              <div class="ph-thumb-caption">${_phSharedPerson==='all'&&ownerIds.length>1?`<span style="opacity:.75">${_hEsc(_phOwnerName(p).split(' ')[0])} · </span>`:''}${p.locLabel?`<span style="color:var(--amber)">${_hEsc(p.locLabel)}</span> · `:''}${_hEsc(p.caption)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  box.innerHTML =
    '<div class="ph-day-label" style="margin-top:18px;display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none" onclick="_phToggleShared()">'+
      '<span style="color:var(--s3)">'+(_phSharedOpen?'▾':'▸')+' 👥 Shared by project members ('+shared.length+')</span>'+
      '<span class="ph-day-count">published by teammates</span>'+
      '<button class="btn btn-outline" style="font-size:10px;padding:4px 10px;margin-left:auto" onclick="event.stopPropagation();glShowProjectSpace()">📁 Project Space</button>'+
    '</div>'+
    (_phSharedOpen ? personRow + body : '');
}

// ── Current filtered + sorted photo set (shared by library render + lightbox nav) ──
function _phFilteredSorted(){
  const fromDate = document.getElementById('ph-filter-from')?.value||'';
  const toDate   = document.getElementById('ph-filter-to')?.value||'';
  let photos = [...window._phPhotos].sort((a,b)=> b.date > a.date ? 1 : b.date < a.date ? -1 : b.uploadedAt - a.uploadedAt);
  if(_projectFilterActive) photos = photos.filter(p => !p.projectId || p.projectId === _activeProjectId());
  if(fromDate) photos = photos.filter(p=>p.date >= fromDate);
  if(toDate)   photos = photos.filter(p=>p.date <= toDate);
  return photos;
}

// ── Render library ──
function phRender(){
  let photos = _phFilteredSorted();

  // Stats (all photos, not filtered)
  const allDates = [...new Set(window._phPhotos.map(p=>p.date))];
  const el = document.getElementById('ph-stat-total');
  const ed = document.getElementById('ph-stat-days');
  if(el) el.textContent = window._phPhotos.length;
  if(ed) ed.textContent = allDates.length;

  const lib = document.getElementById('ph-library');
  if(!lib) return;

  if(photos.length===0){
    lib.innerHTML = window._phPhotos.length===0
      ? glEmptyState({
          icon:'📸', title:'No photos yet',
          body:'Field photos live here — GPS-tagged, captioned, and pinned to the map. Upload from your camera roll or capture straight from a map drawing.',
          actions:[{ label:'+ Upload Photos', onclick:"document.getElementById('ph-file-input').click()", primary:true }],
          academy:'map-photos', academyLabel:'Photos &amp; the map'
        })
      : '<div class="ph-empty">No photos match the current filters.</div>';
    document.getElementById('ph-load-more').style.display = 'none';
    _phRenderShared();
    _phRenderTrash();
    return;
  }

  // Group by date, limit to _phDaysShown unique dates
  const grouped = {};
  photos.forEach(p=>{ if(!grouped[p.date]) grouped[p.date]=[]; grouped[p.date].push(p); });
  const sortedDates = Object.keys(grouped).sort((a,b)=>b>a?1:-1);

  const visibleDates = sortedDates.slice(0, _phDaysShown);
  const hasMore = sortedDates.length > _phDaysShown;

  // 🌱 bag-ledger badge on seed-tag thumbs (one derived pass for the grid; Tim 8/20).
  const _ledBadge=(p)=>{
    if(!p.seedTag||typeof sbPhotoBadge!=='function') return '';
    const bd=sbPhotoBadge(p.id);
    if(!bd) return '';
    const top=p.swppp?44:24;
    const bg=bd.amber?'rgba(201,168,76,.92)':(bd.closed?'rgba(90,100,110,.92)':'rgba(39,140,60,.92)');
    return `<span class="ph-thumb-seed" style="top:${top}px;background:${bg};color:${bd.amber?'#111':'#fff'}">${bd.txt}</span>`;
  };

  lib.innerHTML = visibleDates.map(date => `
    <div class="ph-day-group">
      <div class="ph-day-label">${phDayLabel(date)} <span class="ph-day-count">${grouped[date].length} photo${grouped[date].length>1?'s':''}</span>${_phSelMode?` <a onclick="phSelectDay('${date}')" style="margin-left:auto;color:var(--amber);cursor:pointer;font-size:10px;text-decoration:underline">select day</a>`:''}</div>
      <div class="ph-grid">
        ${grouped[date].map(p=>`
          <div class="ph-thumb" onclick="${_phSelMode?`phSelTap('${p.id}')`:`phOpenLightbox('${p.id}')`}"${_phSel.has(p.id)?' style="outline:3px solid var(--amber);outline-offset:-3px;border-radius:6px"':''}>
            <img src="${p.thumb}" alt="${p.caption||''}" loading="lazy">
            ${_phSelMode?`<span style="position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;background:${_phSel.has(p.id)?'var(--amber)':'rgba(10,18,26,0.6)'};color:${_phSel.has(p.id)?'#111':'#fff'};border:1.5px solid ${_phSel.has(p.id)?'var(--amber)':'rgba(255,255,255,0.6)'}">${_phSel.has(p.id)?'✓':''}</span>`:''}
            ${p.swppp?'<span class="ph-thumb-swppp">🌊 SWPPP</span>':''}
            ${p.seedTag?`<span class="ph-thumb-seed"${p.swppp?' style="top:24px"':''}>🌱 SEED</span>`:''}
            ${_ledBadge(p)}
            <div class="ph-thumb-caption">${p.caption||'Tap to add caption'}</div>
            ${_phSelMode?'':`<button class="ph-thumb-del" onclick="event.stopPropagation();phConfirmDelete('${p.id}')">✕</button>`}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
  _phSelBar();

  document.getElementById('ph-load-more').style.display = hasMore ? 'block' : 'none';
  _phRenderShared();
  _phRenderTrash();
}

// ── ☑ Multi-select → save to camera roll / share (Tim 7/30) ──
// Select photos on the grid, then ONE share sheet with every file attached —
// on iOS "Save N Images" drops them all into the camera roll in one tap.
// Camera photos export their STAMPED rendering (two-layer rule: every export
// path shows the stamp; the stored original stays clean). Web falls back to
// sequential downloads.
let _phSelMode=false; const _phSel=new Set();
function phToggleSelectMode(){
  _phSelMode=!_phSelMode;
  if(!_phSelMode) _phSel.clear();
  const btn=document.getElementById('ph-select-btn');
  if(btn){ btn.textContent=_phSelMode?'✕ Done':'☑ Select'; btn.classList.toggle('btn-amber',_phSelMode); }
  phRender();
}
function phSelTap(id){
  if(_phSel.has(id)) _phSel.delete(id); else _phSel.add(id);
  phRender();
}
function phSelectDay(date){
  _phFilteredSorted().filter(p=>p.date===date).forEach(p=>_phSel.add(p.id));
  phRender();
}
function _phSelBar(){
  let bar=document.getElementById('ph-sel-bar');
  if(!_phSelMode){ if(bar) bar.remove(); return; }
  if(!bar){
    bar=document.createElement('div');
    bar.id='ph-sel-bar';
    bar.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(95px + env(safe-area-inset-bottom));z-index:4800;background:rgba(15,31,46,0.97);border:1px solid var(--amber);border-radius:12px;padding:10px 12px;display:flex;gap:8px;align-items:center;box-shadow:0 4px 18px rgba(0,0,0,.55);max-width:92vw';
    document.body.appendChild(bar);
  }
  const n=_phSel.size;
  bar.innerHTML=`
    <span style="font-family:var(--mono);font-size:12px;color:#dce8f4;white-space:nowrap">${n} selected</span>
    <button onclick="phShareSelected()" ${n?'':'disabled'} style="background:${n?'var(--amber)':'var(--s2,#1a2a38)'};border:none;color:${n?'#111':'var(--muted)'};padding:9px 14px;border-radius:8px;font-family:var(--mono);font-size:12px;font-weight:700;cursor:${n?'pointer':'default'};white-space:nowrap">📤 Save / Share</button>
    <button onclick="phToggleSelectMode()" style="background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#888);padding:9px 12px;border-radius:8px;font-family:var(--mono);font-size:12px;cursor:pointer">✕</button>`;
}
// Full-res bytes for export: offline-pending camera original (IDB) first, then
// the Storage copy, then the thumb as last resort.
async function _phFullBlob(p){
  try{
    if(p.type==='camera'&&window.idbGet){
      const pend=window.idbGet('cam_pending::'+p.id);
      if(pend instanceof Blob) return pend;
    }
  }catch(e){}
  if(p.storageUrl){ try{ const r=await fetch(p.storageUrl); if(r.ok) return await r.blob(); }catch(e){} }
  const raw=p.full||p.thumb||'';
  if(raw.startsWith('data:')){
    const b64=raw.split(',')[1]; const bin=atob(b64);
    const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    return new Blob([arr],{type:'image/jpeg'});
  }
  return null;
}
async function phShareSelected(){
  const ids=[..._phSel];
  if(!ids.length) return;
  const bar=document.getElementById('ph-sel-bar');
  const setMsg=m=>{ if(bar) bar.firstElementChild.textContent=m; };
  const isNative=!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
  try{
    if(isNative){
      const [{Filesystem,Directory},{Share}]=await Promise.all([import('@capacitor/filesystem'),import('@capacitor/share')]);
      const uris=[], paths=[];
      for(let i=0;i<ids.length;i++){
        setMsg(`Preparing ${i+1}/${ids.length}…`);
        const p=_phById(ids[i]); if(!p) continue;
        let blob=await _phFullBlob(p); if(!blob) continue;
        try{ if(typeof window.stampIfCamera==='function') blob=await window.stampIfCamera(p,blob); }catch(e){}
        const b64=await new Promise((res,rej)=>{ const r=new FileReader(); r.onloadend=()=>res(String(r.result).split(',')[1]); r.onerror=()=>rej(r.error); r.readAsDataURL(blob); });
        const path=`glshare/${p.id}.jpg`;
        await Filesystem.writeFile({path,data:b64,directory:Directory.Cache,recursive:true});
        uris.push((await Filesystem.getUri({path,directory:Directory.Cache})).uri);
        paths.push(path);
      }
      if(!uris.length) throw new Error('no photos could be prepared');
      setMsg(`${uris.length} ready`);
      await Share.share({files:uris});
      for(const path of paths){ try{ await Filesystem.deleteFile({path,directory:Directory.Cache}); }catch(e){} }
    } else {
      for(let i=0;i<ids.length;i++){
        setMsg(`Saving ${i+1}/${ids.length}…`);
        const p=_phById(ids[i]); if(!p) continue;
        let blob=await _phFullBlob(p); if(!blob) continue;
        try{ if(typeof window.stampIfCamera==='function') blob=await window.stampIfCamera(p,blob); }catch(e){}
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);
        const safeCap=(p.caption||'photo').replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-').slice(0,40)||'photo';
        a.download=`${p.date||'photo'}_${safeCap}.jpg`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(a.href),4000);
        await new Promise(r=>setTimeout(r,350));   // sequential downloads need breathing room
      }
    }
    if(typeof showCloudBanner==='function') showCloudBanner(`✓ ${ids.length} photo${ids.length>1?'s':''} ${isNative?'handed to the share sheet — tap "Save Images" for the camera roll':'downloaded'}.`);
    phToggleSelectMode();
  }catch(e){
    // User-cancelled share sheets land here too — quiet reset, no scary banner.
    console.warn('phShareSelected:',e&&e.message);
    _phSelBar();
  }
}
if(typeof window!=='undefined'){
  window.phToggleSelectMode=phToggleSelectMode;
  window.phSelTap=phSelTap;
  window.phSelectDay=phSelectDay;
  window.phShareSelected=phShareSelected;
}

// ── Recently Deleted section (collapsed by default; restore within 30 days) ──
let _phTrashOpen = false;
function _phToggleTrash(){ _phTrashOpen = !_phTrashOpen; _phRenderTrash(); }
function phJumpToTrash(){
  if(!(window._phTrash||[]).length) return;
  if(!_phTrashOpen){ _phTrashOpen = true; _phRenderTrash(); }
  document.getElementById('ph-trash')?.scrollIntoView({ behavior:'smooth', block:'start' });
}
function _phRenderTrash(){
  const box = document.getElementById('ph-trash');
  if(!box) return;
  const trash = [...(window._phTrash||[])].sort((a,b)=>(b.deletedAt||0)-(a.deletedAt||0));
  const btn = document.getElementById('ph-trash-btn');
  if(btn){
    btn.style.display = trash.length ? '' : 'none';
    const c = document.getElementById('ph-trash-count');
    if(c) c.textContent = trash.length;
  }
  if(!trash.length){ box.innerHTML=''; return; }
  const rows = trash.map(p=>{
    const daysLeft = Math.max(0, Math.ceil((p.deletedAt + PH_TRASH_RETENTION_MS - Date.now())/86400000));
    return '<div class="ph-thumb" style="cursor:default">'+
      '<img src="'+p.thumb+'" alt="" loading="lazy" style="filter:grayscale(.7) brightness(.7)">'+
      '<div class="ph-thumb-caption">'+phDayLabel(p.date)+' · '+daysLeft+'d left</div>'+
      '<button onclick="phUndoDelete(\''+p.id+'\')" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,.75);border:1px solid #E8B84B;color:#E8B84B;font-size:11px;font-weight:700;border-radius:8px;padding:4px 8px;cursor:pointer">RESTORE</button>'+
    '</div>';
  }).join('');
  box.innerHTML =
    '<div class="ph-day-label ph-trash" style="margin-top:18px;cursor:pointer;user-select:none" onclick="_phToggleTrash()">'+
      (_phTrashOpen?'▾':'▸')+' 🗑 Recently Deleted ('+trash.length+')'+
      ' <span class="ph-day-count">restorable for 30 days</span>'+
    '</div>'+
    (_phTrashOpen ? '<div class="ph-grid">'+rows+'</div>' : '');
}

function phLoadMore(){
  _phDaysShown += _phPageSize;
  phRender();
}

function phClearFilters(){
  document.getElementById('ph-filter-from').value='';
  document.getElementById('ph-filter-to').value='';
  phRender();
}

// ── Lightbox ──
// Opens the full-res viewer. `listIds` (optional) sets the navigation order;
// when omitted, navigates the current filtered+sorted photo-page set.
async function phOpenLightbox(id, listIds){
  _phLbList = (Array.isArray(listIds) && listIds.length) ? listIds.slice() : _phFilteredSorted().map(p=>p.id);
  _phLbIndex = _phLbList.indexOf(id);
  if(_phLbIndex < 0){ _phLbList = [id]; _phLbIndex = 0; } // opened on a photo outside the current filter
  const lb = document.getElementById('ph-lightbox');
  lb.classList.remove('hidden','sheet-open','chrome-hide');   // always open CLEAN (Tim 8/15)
  _phBindCaptionLive();
  _phLbBindGestures();
  await _phLbShow(_phLbIndex);
}

// Renders the photo at the given index: thumb instantly, full-res async (race-guarded).
async function _phLbShow(index){
  if(index < 0 || index >= _phLbList.length) return;
  _phLbIndex = index;
  const id = _phLbList[index];
  _phLbId = id;
  const p = _phById(id);
  if(!p) return;
  const img = document.getElementById('ph-lb-img');
  const cap = document.getElementById('ph-lb-caption');
  const dat = document.getElementById('ph-lb-date');
  img.src = p.thumb;            // instant
  if(cap) cap.value = p.caption||'';
  if(dat) dat.textContent = phDayLabel(p.date);
  // Share button + caption editability track ownership: another member's
  // published photo is read-only here.
  const own = window._phPhotos.some(x=>x.id===id);
  const share = document.getElementById('ph-lb-share');
  if(share){
    const pid = (typeof _activeProjectId==='function') ? _activeProjectId() : 'default';
    const inProject = own && p.projectId === pid && pid !== 'default';
    share.style.display = inProject ? '' : 'none';
    share.textContent = p.published ? '🌐 Shared ✓' : '📤 Share';
    share.title = p.published ? 'Shared with project members — tap to unshare' : 'Share to project members';
  }
  // SWPPP / Seed-Tag toggles — own photos only. SWPPP-tagged photos sort
  // first in the QI report's photo picker (swppp.js §11).
  const swBtn = document.getElementById('ph-lb-swppp');
  if(swBtn){
    swBtn.style.display = own ? '' : 'none';
    swBtn.textContent = p.swppp ? '🌊 SWPPP ✓' : '🌊 SWPPP';
    swBtn.title = p.swppp ? 'SWPPP-tagged — tap to untag' : 'Tag as SWPPP documentation';
    swBtn.classList.toggle('ph-swppp-on', !!p.swppp);
  }
  const sdBtn = document.getElementById('ph-lb-seed');
  if(sdBtn){
    sdBtn.style.display = own ? '' : 'none';
    sdBtn.textContent = p.seedTag ? '🌱 Seed ✓' : '🌱 Seed';
    sdBtn.title = p.seedTag ? 'Seed-tagged — tap to untag' : 'Tag as a seed tag photo';
    sdBtn.classList.toggle('ph-seed-on', !!p.seedTag);
  }
  const delBtn = document.getElementById('ph-lb-del');
  if(delBtn) delBtn.style.display = own ? '' : 'none';
  // ⚑ Report (Guideline 1.2 UGC): a teammate's published photo only.
  const repBtn = document.getElementById('ph-lb-report');
  if(repBtn) repBtn.style.display = (!own && p.ownerUid) ? '' : 'none';
  // 🏷 Stamp section — in-app camera photos only (they carry the metadata record
  // the stamp renders from; imported photos keep their own baked-in overlays).
  // Pills adjust what renders (lightbox view + every export); button saves a copy.
  const isCam = own && p.type==='camera';
  const stWrap = document.getElementById('ph-lb-stamp-wrap');
  if(stWrap){ stWrap.style.display = isCam ? 'flex' : 'none'; if(isCam) _phStampPillRow(); }
  if(cap) cap.readOnly = !own;
  // Location label — camera photos only (a record field: feeds the stamp's
  // caption line, map pins, and the SWPPP photo-log Location column).
  const locRow = document.getElementById('ph-lb-loc-row');
  const locInp = document.getElementById('ph-lb-loc');
  // 9/1: a teammate's camera photo shows its location too (read-only, no history picker).
  const showLoc = isCam || (!own && p.type==='camera' && p.locLabel);
  if(locRow) locRow.style.display = showLoc ? 'flex' : 'none';
  const locHist = document.getElementById('ph-lb-loc-hist');
  if(locHist) locHist.style.display = own ? '' : 'none';
  if(locInp){ locInp.value = p.locLabel||''; locInp.readOnly = !own; locInp.placeholder = own ? 'Location label (e.g. W21)' : 'Location'; }
  document.querySelectorAll('.ph-lb-hist').forEach(el=>el.remove()); // stale ＋ list from the prior photo
  _phLbResetZoom();
  _phLbRenderMeta(p);
  _phLbUpdateNav();
  const full = await phGetFull(id);
  if(_phLbId === id) img.src = full;   // only swap in full-res if still on this photo
  // Camera photos DISPLAY stamped (Tim 7/29: stamped everywhere, every time) —
  // the lightbox view is the stamped rendering per the current element pills;
  // the stored original stays clean underneath.
  if(p.type==='camera') _phLbApplyStamp(p);
  _phLbPreloadNeighbors();
}

// ── Stamped-render cache (8/15, field-swipe perf) ──
// Every landing used to re-fetch full-res + re-run the canvas stamp — even for
// a photo viewed seconds ago — which made swiping feel slow, worst on bad
// service. Small LRU of object URLs keyed by the stamp INPUTS (so caption/tag/
// pill edits naturally miss and re-render). Bounded at 6 entries and cleared
// on lightbox close: stamped full-res JPEGs are several MB each and lingering
// blobs feed exactly the memory-pressure reloads the iPad already shows.
let _phStampCache=new Map();
function _phStampKey(p){
  return [p.id,p.caption||'',p.locLabel||'',p.swppp?1:0,p.seedTag?1:0,p.repairTag?1:0,
    p.storageUrl?1:0,JSON.stringify(_stampDefaults())].join('|');
}
function _phStampCacheClear(){
  _phStampCache.forEach(u=>{ try{ URL.revokeObjectURL(u); }catch(e){} });
  _phStampCache.clear();
}
// Render (or fetch from cache) the stamped object URL for a camera photo.
// Touches recency on hit; evicts oldest past 6.
async function _phStampRender(p){
  const key=_phStampKey(p);
  if(_phStampCache.has(key)){
    const u=_phStampCache.get(key);
    _phStampCache.delete(key); _phStampCache.set(key,u);
    return u;
  }
  // Best-available bytes (#59): offline-pending ORIGINAL first, then Storage,
  // thumb last — the pending original exists precisely in the bad-service case.
  let blob=await _phFullBlob(p);
  if(!blob) return null;
  if(!_camMod) _camMod=await import('./camera.js');
  blob=(await _camMod.camStampBlob(p,blob,_stampDefaults()))||blob;
  const url=URL.createObjectURL(blob);
  _phStampCache.set(key,url);
  while(_phStampCache.size>6){
    const k=_phStampCache.keys().next().value;
    try{ URL.revokeObjectURL(_phStampCache.get(k)); }catch(e){}
    _phStampCache.delete(k);
  }
  return url;
}
async function _phLbApplyStamp(p){
  if(!p||p.type!=='camera') return;
  const id=p.id;
  try{
    const url=await _phStampRender(p);
    if(!url||_phLbId!==id) return;       // navigated away mid-render
    const img=document.getElementById('ph-lb-img');
    if(img) img.src=url;
  }catch(e){ console.warn('lightbox stamp preview failed:',e); }
}

// Stops at the ends (no wrap).
function phLbNext(){ if(_phLbIndex < _phLbList.length-1) _phLbShow(_phLbIndex+1); }
function phLbPrev(){ if(_phLbIndex > 0) _phLbShow(_phLbIndex-1); }

function _phLbUpdateNav(){
  const prev = document.getElementById('ph-lb-prev');
  const next = document.getElementById('ph-lb-next');
  const cnt  = document.getElementById('ph-lb-count');
  if(prev) prev.style.visibility = _phLbIndex > 0 ? 'visible' : 'hidden';
  if(next) next.style.visibility = _phLbIndex < _phLbList.length-1 ? 'visible' : 'hidden';
  if(cnt)  cnt.textContent = _phLbList.length > 1 ? `${_phLbIndex+1} / ${_phLbList.length}` : '';
}

// Warm the neighbours so swipes feel instant: HTTP cache for the full-res
// bytes, and (8/15) the stamped rendering itself for camera photos — the
// stamp pass was the real swipe latency, and pre-rendering it means landing
// on a neighbour is a cache hit. Deferred a beat so the CURRENT photo's
// render always wins the CPU first.
function _phLbPreloadNeighbors(){
  const centerId=_phLbId;
  setTimeout(()=>{
    if(_phLbId!==centerId) return;   // already moved on — that show preloads its own
    [_phLbIndex-1, _phLbIndex+1].forEach(async i=>{
      if(i < 0 || i >= _phLbList.length) return;
      try{
        const p=_phById(_phLbList[i]);
        const url = await phGetFull(_phLbList[i]);
        if(url){ const im = new Image(); im.src = url; }
        if(p&&p.type==='camera') await _phStampRender(p);
      }catch(e){}
    });
  },350);
}

// ── Lightbox v2 (8/15): full-screen gestures + details sheet + drawing links ──
// The stage owns every photo gesture via Pointer Events (touch-action:none):
// pinch/double-tap zoom with focal anchoring, one-finger pan when zoomed,
// swipe left/right to navigate at 1×, swipe down to close, swipe up for the
// details sheet. Chrome toggles on single tap (count chip always stays).
// img transform = translate(tx,ty) scale(s) about center → tx/ty are screen px.
let _phLbG=null, _phLbGBound=false;

function _phLbSetSheet(open){
  const lb=document.getElementById('ph-lightbox'); if(!lb) return;
  lb.classList.toggle('sheet-open',!!open);
  if(open) lb.classList.remove('chrome-hide');   // chrome is part of the editing context
}
function phLbToggleSheet(){
  const lb=document.getElementById('ph-lightbox'); if(!lb) return;
  _phLbSetSheet(!lb.classList.contains('sheet-open'));
}

function _phLbApplyT(instant){
  const img=document.getElementById('ph-lb-img'); if(!img||!_phLbG) return;
  img.style.transition=instant?'none':'transform .18s ease';
  img.style.transform=`translate(${_phLbG.tx}px,${_phLbG.ty}px) scale(${_phLbG.s})`;
}
function _phLbResetZoom(){
  if(!_phLbG){ _phLbG={s:1,tx:0,ty:0}; }
  _phLbG.s=1; _phLbG.tx=0; _phLbG.ty=0;
  _phLbApplyT(true);
  const st=document.getElementById('ph-lb-stage'); if(st) st.style.opacity='';
}
// Keep the zoomed image covering the stage — no gaps past the fitted edges.
function _phLbClampPan(){
  const g=_phLbG, st=document.getElementById('ph-lb-stage'), img=document.getElementById('ph-lb-img');
  if(!g||!st||!img) return;
  const r=st.getBoundingClientRect();
  const mx=Math.max(0,(img.clientWidth*g.s-r.width)/2);
  const my=Math.max(0,(img.clientHeight*g.s-r.height)/2);
  g.tx=Math.min(mx,Math.max(-mx,g.tx));
  g.ty=Math.min(my,Math.max(-my,g.ty));
}
// Zoom to `ns` keeping the stage-relative point (mx,my) anchored (focal zoom).
function _phLbZoomAt(ns,mx,my,instant){
  const g=_phLbG; if(!g) return;
  ns=Math.min(6,Math.max(1,ns));
  const cx=(mx-g.tx)/g.s, cy=(my-g.ty)/g.s;
  g.s=ns; g.tx=mx-ns*cx; g.ty=my-ns*cy;
  if(ns<=1.01){ g.s=1; g.tx=0; g.ty=0; }
  else _phLbClampPan();
  _phLbApplyT(instant);
}

function _phLbBindGestures(){
  if(_phLbGBound) return; _phLbGBound=true;
  const st=document.getElementById('ph-lb-stage'); if(!st) return;
  if(!_phLbG) _phLbG={s:1,tx:0,ty:0};
  const g=_phLbG;
  const pts=new Map();
  let start=null, mode=null, tapTimer=null, lastTap=0, lastTapXY=null;
  const mid=(x,y)=>{ const r=st.getBoundingClientRect(); return {x:x-r.left-r.width/2, y:y-r.top-r.height/2}; };

  st.addEventListener('pointerdown',e=>{
    if(document.getElementById('ph-lightbox').classList.contains('hidden')) return;
    try{ st.setPointerCapture(e.pointerId); }catch(_){}
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pts.size===1){
      start={s:g.s,tx:g.tx,ty:g.ty,x:e.clientX,y:e.clientY,t:Date.now()};
      mode=null;
    } else if(pts.size===2){
      const [a,b]=[...pts.values()];
      start={s:g.s,tx:g.tx,ty:g.ty,dist:Math.hypot(a.x-b.x,a.y-b.y)||1,mid:mid((a.x+b.x)/2,(a.y+b.y)/2)};
      mode='pinch';
      clearTimeout(tapTimer); tapTimer=null;
    }
  });

  st.addEventListener('pointermove',e=>{
    if(!pts.has(e.pointerId)||!start) return;
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(mode==='pinch'&&pts.size>=2){
      const [a,b]=[...pts.values()];
      const d=Math.hypot(a.x-b.x,a.y-b.y)||1;
      const m=mid((a.x+b.x)/2,(a.y+b.y)/2);
      const ns=Math.min(6,Math.max(1,start.s*d/start.dist));
      const cx=(start.mid.x-start.tx)/start.s, cy=(start.mid.y-start.ty)/start.s;
      g.s=ns; g.tx=m.x-ns*cx; g.ty=m.y-ns*cy;
      if(ns<=1.01){ g.s=1; g.tx=0; g.ty=0; } else _phLbClampPan();
      _phLbApplyT(true);
      return;
    }
    if(pts.size!==1) return;
    const dx=e.clientX-start.x, dy=e.clientY-start.y;
    if(!mode){
      if(Math.hypot(dx,dy)<8) return;
      clearTimeout(tapTimer); tapTimer=null;
      mode = g.s>1.01 ? 'pan' : (Math.abs(dx)>Math.abs(dy) ? 'swipe' : 'vert');
    }
    if(mode==='pan'){
      g.tx=start.tx+dx; g.ty=start.ty+dy; _phLbClampPan(); _phLbApplyT(true);
    } else if(mode==='swipe'){
      g.tx=dx; _phLbApplyT(true);
    } else if(mode==='vert'&&dy>0){
      g.ty=dy; _phLbApplyT(true);
      st.style.opacity=String(Math.max(.35,1-dy/450));
    }
  });

  const finish=e=>{
    if(!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if(mode==='pinch'){
      if(pts.size<2){ mode=null; start=null; if(g.s<=1.01) _phLbResetZoom(); }
      return;
    }
    if(!start) return;
    const dx=e.clientX-start.x, dy=e.clientY-start.y;
    const held=Date.now()-start.t;
    const m=mode; mode=null; start=null;
    if(m==='pan') return;
    if(m==='swipe'){
      const fling=held<250&&Math.abs(dx)>40;
      if((dx<-70||(dx<0&&fling))&&_phLbIndex<_phLbList.length-1){ g.tx=0; _phLbShow(_phLbIndex+1); }
      else if((dx>70||(dx>0&&fling))&&_phLbIndex>0){ g.tx=0; _phLbShow(_phLbIndex-1); }
      else { g.tx=0; _phLbApplyT(false); }
      return;
    }
    if(m==='vert'){
      if(dy>90||(held<250&&dy>50)){ phCloseLightbox(); return; }
      if(dy<-60){ g.ty=0; _phLbApplyT(false); st.style.opacity=''; _phLbSetSheet(true); return; }
      g.ty=0; _phLbApplyT(false); st.style.opacity='';
      return;
    }
    // No movement: tap. Double-tap = focal zoom toggle; single (after the
    // double-tap window) = close sheet if open, else toggle chrome.
    const now=Date.now(), xy={x:e.clientX,y:e.clientY};
    if(now-lastTap<300&&lastTapXY&&Math.hypot(xy.x-lastTapXY.x,xy.y-lastTapXY.y)<28){
      lastTap=0; lastTapXY=null;
      clearTimeout(tapTimer); tapTimer=null;
      const p=mid(xy.x,xy.y);
      _phLbZoomAt(g.s>1.01?1:2.5,p.x,p.y,false);
      return;
    }
    lastTap=now; lastTapXY=xy;
    clearTimeout(tapTimer);
    tapTimer=setTimeout(()=>{
      tapTimer=null;
      const lb=document.getElementById('ph-lightbox');
      if(lb.classList.contains('sheet-open')) _phLbSetSheet(false);
      else lb.classList.toggle('chrome-hide');
    },300);
  };
  st.addEventListener('pointerup',finish);
  st.addEventListener('pointercancel',e=>{ pts.delete(e.pointerId); mode=null; start=null; if(g.s<=1.01) _phLbResetZoom(); });

  // Desktop wheel zoom around the cursor.
  st.addEventListener('wheel',e=>{
    e.preventDefault();
    const p=mid(e.clientX,e.clientY);
    _phLbZoomAt(g.s*(e.deltaY<0?1.15:1/1.15),p.x,p.y,true);
  },{passive:false});

  // Sheet grip: drag down to dismiss.
  const grip=document.getElementById('ph-lb-grip');
  if(grip){
    let gy=null;
    grip.addEventListener('pointerdown',e=>{ gy=e.clientY; try{ grip.setPointerCapture(e.pointerId); }catch(_){} });
    grip.addEventListener('pointerup',e=>{ if(gy!=null&&e.clientY-gy>40) _phLbSetSheet(false); gy=null; });
    grip.addEventListener('pointercancel',()=>{ gy=null; });
    grip.addEventListener('click',()=>_phLbSetSheet(false));
  }

  // Web keyboard: arrows navigate, Escape closes sheet-then-lightbox.
  document.addEventListener('keydown',e=>{
    const lb=document.getElementById('ph-lightbox');
    if(!lb||lb.classList.contains('hidden')) return;
    if(e.target&&/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;   // typing in the sheet
    if(e.key==='ArrowRight') phLbNext();
    else if(e.key==='ArrowLeft') phLbPrev();
    else if(e.key==='Escape'){ if(lb.classList.contains('sheet-open')) _phLbSetSheet(false); else phCloseLightbox(); }
  });
}

// Badges (top chrome) + linked-drawings block (#30) for the current photo.
function _phLbLinkedEntries(photoId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  if(typeof trGetEntriesForProject!=='function') return [];
  try{
    return trGetEntriesForProject(pid).filter(e=>!e.deletedAt&&Array.isArray(e.photoIds)&&e.photoIds.includes(photoId));
  }catch(_){ return []; }
}
function _phLbRenderMeta(p){
  const links=_phLbLinkedEntries(p.id);
  const b=document.getElementById('ph-lb-badges');
  if(b) b.textContent=[p.swppp?'🌊':'',p.seedTag?'🌱':'',p.repairTag?'🚩':'',links.length?'📐':''].filter(Boolean).join(' ');
  // 🌱 bag-ledger line for seed-tag photos (Tim 8/20) — lives right under the badges.
  let led=document.getElementById('ph-lb-ledger');
  if(!led&&b){ led=document.createElement('div'); led.id='ph-lb-ledger'; led.style.cssText='font-family:var(--mono);font-size:10px;color:var(--muted);text-align:center;line-height:1.4;padding:0 12px'; b.insertAdjacentElement('afterend',led); }
  if(led){
    const line=(p.seedTag&&typeof sbPhotoLedgerLine==='function')?sbPhotoLedgerLine(p.id):'';
    led.innerHTML=line; led.style.display=line?'':'none';
  }
  const box=document.getElementById('ph-lb-links');
  if(!box) return;
  if(!links.length){ box.style.display='none'; box.innerHTML=''; return; }
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const esc=s=>String(s||'').replace(/</g,'&lt;');
  box.style.cssText='display:flex;flex-direction:column;gap:6px';
  box.innerHTML='<div style="font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.06em;text-align:center">📐 LINKED DRAWINGS · TAP TO VIEW ON MAP</div>'+
    links.map(e=>{
      const cid=e.categoryId||e.category;
      const cat=(typeof tcGetName==='function')?tcGetName(cid,e.projectId||pid):'';
      let stateLbl='';
      try{ const s=(typeof tcEntryState==='function')?tcEntryState(e,cid,e.projectId||pid):null; if(s&&s.label) stateLbl=s.label; }catch(_){}
      const name=e.tempLabel
        ? ((e.plNum&&typeof trPlFmt==='function')?trPlFmt(e.plNum)+' · ':'')+e.tempLabel
        : (stateLbl||'Drawing');
      return `<div class="ph-lb-link-row" onclick="phLbGotoEntry('${e.id}')">📐<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)} · ${esc(cat)}${e.date?` · ${esc(e.date)}`:''}</span><span style="color:var(--muted)">›</span></div>`;
    }).join('');
}
// Jump: close the viewer, land on the map, glow the drawing (punchlist pattern).
function phLbGotoEntry(entryId){
  phCloseLightbox();
  if(typeof showPage==='function') showPage('map');
  setTimeout(()=>{ if(typeof mapHighlightEntry==='function') mapHighlightEntry(entryId); },400);
}

function phCloseLightbox(){
  const lb=document.getElementById('ph-lightbox');
  lb.classList.add('hidden');
  lb.classList.remove('sheet-open','chrome-hide');
  document.querySelectorAll('.ph-lb-hist').forEach(el=>el.remove());
  _phLbId = null;
  _phLbList = [];
  _phLbIndex = -1;
  _phLbResetZoom();
  const st=document.getElementById('ph-lb-stage'); if(st) st.style.opacity='';
  _phStampCacheClear();   // stamped full-res blobs are MBs each — never outlive the viewer
}

function phSaveCaption(){
  if(!_phLbId) return;
  const cap = document.getElementById('ph-lb-caption').value.trim();
  const p = window._phPhotos.find(x=>x.id===_phLbId);
  if(p){
    p.caption = cap;
    // Camera photos: the location label saves with the caption (Tim 7/31 —
    // edit path only exposed the caption). '' is a real value: it clears the
    // label (and _phDocFor writes it explicitly so the clear syncs).
    const locInp = document.getElementById('ph-lb-loc');
    if(p.type==='camera' && locInp) p.locLabel = locInp.value.trim();
    phMarkDirty(p.id);
    phSave();
    phRender();
    // Published photo: keep the project mirror's caption current — in the
    // photo's OWN project (the library can show other projects' photos too).
    if(p.published && typeof phSetPublished === 'function') phSetPublished([p.id], true, p.projectId);
    // Map pin popups bake the caption into their HTML — re-render or they hold
    // the old caption until something else redraws the pins.
    if(typeof mapRenderPhotoPins === 'function') mapRenderPhotoPins();
  }
  phCloseLightbox();
}

// ── Live caption editing (Tim 7/30) ──
// Typing in the lightbox caption box applies without waiting for Save Caption:
// debounced auto-persist + live refresh of everything that displays the caption
// (grid, pins, and the stamped rendering — its caption line is drawn from the
// record). Save Caption stays as the explicit commit-and-close.
let _phCapDebs={},_phCapBound=false;
function _phBindCaptionLive(){
  if(_phCapBound) return;
  const cap=document.getElementById('ph-lb-caption');
  if(!cap) return;
  _phCapBound=true;
  // Debounced persist for both editors — per-field timers, so a quick
  // caption-edit → location-edit can't cancel the caption's pending write.
  const persist=(field,el)=>{
    if(!_phLbId||el.readOnly) return;
    const id=_phLbId, val=el.value;   // captured NOW — auto-save is the only
    // commit path (v2 dropped Save Caption), so the pending write must land
    // even if the user closes or swipes to another photo inside the debounce.
    clearTimeout(_phCapDebs[field]);
    _phCapDebs[field]=setTimeout(()=>{
      const p=window._phPhotos.find(x=>x.id===id);
      if(!p) return;
      if(field==='locLabel' && p.type!=='camera') return;
      p[field]=val.trim();   // captured value — el may already show another photo
      phMarkDirty(p.id);
      phSave();
      phRender();
      if(p.published && typeof phSetPublished === 'function') phSetPublished([p.id], true, p.projectId);
      if(typeof mapRenderPhotoPins === 'function') mapRenderPhotoPins();
      if(p.type==='camera' && _phLbId===id) _phLbApplyStamp(p);   // stamp refresh only if still viewing
    },600);
  };
  cap.addEventListener('input',()=>persist('caption',cap));
  const loc=document.getElementById('ph-lb-loc');
  if(loc) loc.addEventListener('input',()=>persist('locLabel',loc));
  // ＋ = previous locations quick-pick (the camera module derives MRU values
  // live from this project's camera records — same list as the post-shot strip).
  const hist=document.getElementById('ph-lb-loc-hist');
  if(hist) hist.onclick=async()=>{
    const wrap=hist.closest('.ph-lb-caption-wrap');
    const old=wrap&&wrap.querySelector('.ph-lb-hist');
    if(old){ old.remove(); return; }
    if(!_camMod) _camMod=await import('./camera.js');
    const vals=(typeof _camMod.camHistVals==='function')?_camMod.camHistVals('locLabel'):[];
    if(!vals.length||!loc||loc.readOnly){ if(loc&&!loc.readOnly) loc.focus(); return; }
    const list=document.createElement('div');
    list.className='ph-lb-hist';
    list.style.cssText='border:1px solid var(--amber);border-radius:8px;background:var(--s1);overflow:hidden;max-height:38vh;overflow-y:auto;-webkit-overflow-scrolling:touch';
    list.innerHTML=vals.map(v=>`<button style="display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--border);color:var(--text);font-family:var(--body);font-size:14px;padding:9px 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.replace(/</g,'&lt;')}</button>`).join('');
    list.querySelectorAll('button').forEach((b,i)=>{ b.onclick=()=>{ loc.value=vals[i]; list.remove(); persist('locLabel',loc); }; });
    document.getElementById('ph-lb-loc-row').insertAdjacentElement('afterend',list);
  };
}

// ── Seed-tag sync from tracker entries (Tim 7/31) ──
// The drawing-edit photo strip tags photos on the ENTRY (photoTypes[id] ===
// 'material_tag' — the old make-a-photo-a-seed-tag path, and what the seeding
// exports count). The Photos page amber 🌱 runs off the photo RECORD's seedTag.
// Mirror entry tags into the record at entry save so both paths agree.
// Untagging here clears the amber only when no OTHER live entry still tags the
// photo — one drawing's untag can't strip a tag another drawing owns. A 🌱 set
// directly on the Photos page has no entry context and is left alone.
function phSyncSeedTagsFromEntry(prevTypes, entry, pid){
  if(!entry) return;
  const types=entry.photoTypes||{};
  const ids=new Set([...Object.keys(prevTypes||{}),...Object.keys(types)]);
  const changed=[];
  ids.forEach(id=>{
    const was=(prevTypes||{})[id]==='material_tag';
    const now=types[id]==='material_tag';
    if(was===now) return;
    const p=(window._phPhotos||[]).find(x=>x.id===id);
    if(!p) return;
    if(now){
      if(!p.seedTag){ p.seedTag=true; changed.push(id); }
    } else {
      const others=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid):[];
      const still=others.some(e=>e&&e.id!==entry.id&&e.photoTypes&&e.photoTypes[id]==='material_tag');
      if(!still&&p.seedTag){ p.seedTag=false; changed.push(id); }
    }
  });
  if(changed.length){ phMarkDirty(changed); phSave(); phRender(); }
}
window.phSyncSeedTagsFromEntry=phSyncSeedTagsFromEntry;

// ── Lightbox Share / Unshare toggle (own photos in the active project) ──
async function phShareCurrent(){
  if(!_phLbId) return;
  const p = window._phPhotos.find(x=>x.id===_phLbId);
  if(!p) return;
  const btn = document.getElementById('ph-lb-share');
  if(btn) btn.disabled = true;
  const target = !p.published;
  await phSetPublished([p.id], target, p.projectId);
  if(btn){
    btn.disabled = false;
    btn.textContent = target ? '🌐 Shared ✓ — tap to unshare' : '📤 Share to project';
  }
  if(typeof showCloudBanner === 'function'){
    showCloudBanner(target ? '✓ Photo shared — project members can see it now.'
      : 'Photo unshared — members lose access on their next refresh.');
  }
}

// ── Lightbox SWPPP tag toggle (own photos) ──
// Marks a photo as SWPPP documentation: it sorts first in the QI inspection
// report's §11 photo picker (swppp.js) and gets a 🌊 badge in the library.
async function phToggleSwpppCurrent(){
  if(!_phLbId) return;
  const p = window._phPhotos.find(x=>x.id===_phLbId);
  if(!p) return;
  p.swppp = !p.swppp;
  phMarkDirty(p.id);
  phSave();
  phRender();
  const btn = document.getElementById('ph-lb-swppp');
  if(btn){
    btn.textContent = p.swppp ? '🌊 SWPPP ✓' : '🌊 Tag as SWPPP';
    btn.classList.toggle('ph-swppp-on', !!p.swppp);
  }
  try{ await phSaveCloudOne(p); }catch(e){}
}

// Seed-tag designation on the photo itself (mirrors the SWPPP tag) — pairs
// with the per-entry material_tag flow on tracker drawings.
async function phToggleSeedCurrent(){
  if(!_phLbId) return;
  const p = window._phPhotos.find(x=>x.id===_phLbId);
  if(!p) return;
  p.seedTag = !p.seedTag;
  phMarkDirty(p.id);
  phSave();
  phRender();
  const btn = document.getElementById('ph-lb-seed');
  if(btn){
    btn.textContent = p.seedTag ? '🌱 Seed Tag ✓' : '🌱 Tag as Seed Tag';
    btn.classList.toggle('ph-seed-on', !!p.seedTag);
  }
  try{ await phSaveCloudOne(p); }catch(e){}
}

// ── Delete with confirm (soft delete — 30-day undo window) ──
function phConfirmDelete(id){
  const p = window._phPhotos.find(x=>x.id===id);
  if(!p) return;
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box">' +
    '<div class="modal-title">⚠ Delete Photo?</div>' +
    '<div class="modal-msg">Delete the photo from <strong>' + phDayLabel(p.date) + '</strong>?<br><br>You can undo for 30 days.</div>' +
    '<div class="modal-btns">' +
      '<button class="modal-cancel" id="_phmc">Cancel</button>' +
      '<button class="modal-confirm" id="_phmok">Delete</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_phmc').onclick = function(){ ov.remove(); };
  document.getElementById('_phmok').onclick = async function(){
    ov.remove();
    const p = window._phPhotos.find(x=>x.id===id);
    if(!p) return;
    p.deletedAt = Date.now();
    window._phPhotos = window._phPhotos.filter(x=>x.id!==id);
    window._phTrash.push(p);
    phSaveLocal();
    phRender();
    mapRenderPhotoPins();
    _phShowUndoToast(id);
    // Storage file intentionally NOT deleted here — needed for undo; _phSweepTrash removes it after 30 days.
    if(db){
      try{
        await _udb().collection('photos').doc(id).update({ deletedAt: p.deletedAt });
      }catch(e){
        try{ await _udb().collection('photos').doc(id).set({ id: id, deletedAt: p.deletedAt }, { merge:true }); }
        catch(e2){ console.warn('phDelete soft-delete failed:', e2.message); }
      }
      // Published photo: pull the project mirror too (members must not keep a
      // deleted photo). The published flag stays on the record so undo re-shares.
      if(p.published && p.projectId && p.projectId !== 'default'){
        db.collection('projects').doc(p.projectId).collection('photos').doc(id)
          .delete().catch(()=>{});
      }
    }
  };
}

function phUndoDelete(id){
  const i = (window._phTrash||[]).findIndex(x=>x.id===id);
  if(i<0) return;
  const p = window._phTrash.splice(i,1)[0];
  delete p.deletedAt;
  window._phPhotos.push(p);
  phSaveLocal();
  phRender();
  mapRenderPhotoPins();
  if(db){
    _udb().collection('photos').doc(id).update({ deletedAt: null })
      .catch(e => console.warn('phUndoDelete failed:', e.message));
    // Was published when deleted — restore the project mirror with it.
    if(p.published && typeof phSetPublished === 'function') phSetPublished([id], true, p.projectId);
  }
}

function _phShowUndoToast(id){
  document.getElementById('ph-undo-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'ph-undo-toast';
  t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(78px + env(safe-area-inset-bottom,0px));z-index:400;background:rgba(0,0,0,.88);color:#eee;padding:10px 16px;border-radius:10px;display:flex;gap:16px;align-items:center;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.5)';
  t.innerHTML = 'Photo deleted <button style="background:none;border:none;color:#E8B84B;font-weight:700;font-size:14px;padding:4px 6px;cursor:pointer">UNDO</button>';
  t.querySelector('button').onclick = function(){ t.remove(); phUndoDelete(id); };
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 8000);
}

// Hard-delete trash older than 30 days: Storage file first (retry-safe), then the doc.
async function _phSweepTrash(){
  if(!db || !_fbReady) return;
  const cutoff = Date.now() - PH_TRASH_RETENTION_MS;
  const expired = (window._phTrash||[]).filter(p => p.deletedAt && p.deletedAt < cutoff);
  if(!expired.length) return;
  for(const p of expired){
    if(p.storageUrl && storage){
      try{ await storage.refFromURL(p.storageUrl).delete(); }
      catch(e){
        if(e.code !== 'storage/object-not-found'){ console.warn('phSweep storage failed:', e.message); continue; }
      }
    }
    try{ await _udb().collection('photos').doc(p.id).delete(); }
    catch(e){ console.warn('phSweep doc failed:', e.message); continue; }
    window._phTrash = window._phTrash.filter(x => x.id !== p.id);
  }
  phSaveLocal();
}

// ── (v1 lightbox interaction handlers REMOVED 8/15) ──
// Backdrop-tap close, the img touchend swipe, and the standalone keyboard
// handler all moved into the v2 gesture controller (_phLbBindGestures).
// The old touchend swipe was the "skips every other photo" bug: touch events
// fire ALONGSIDE pointer events, so v1 and v2 each navigated once per swipe.
// Any future lightbox interaction belongs IN the controller, never beside it.

// ── Phase D migration: tag existing photos with active projectId ──
async function _glMigratePhaseD() {
  if (localStorage.getItem('gl_phaseD_photos_migrated')) return;
  if (!_fbReady) return;
  const pid = _activeProjectId();
  if (!pid || pid === 'default') return;
  let changed = false;
  window._phPhotos.forEach(p => { if (!p.projectId) { p.projectId = pid; phMarkDirty(p.id); changed = true; } });
  if (changed) {
    phSaveLocal();
    await phSaveCloud();
  }
  localStorage.setItem('gl_phaseD_photos_migrated', '1');
}

// ── Init ──
async function phInit(){
  // Wait for the IDB cache to hydrate, then migrate any legacy localStorage
  // photo blobs into it — before the first synchronous read.
  if(window.idbReady){ try{ await window.idbReady; }catch(e){} }
  await phMigrateLocalToIdb();
  phLoadLocal();
  phRender();
  if(typeof glBootMark==='function') glBootMark('ph-local',{count:(window._phPhotos||[]).length});
  const fromCloud = await phWatchCloud();   // resolves on the first server-confirmed snapshot (or 8 s)
  phRender();
  if(typeof glBootMark==='function') glBootMark('ph-done',{cloud:fromCloud,count:(window._phPhotos||[]).length});
  phRecoverStorageUrls();
  phRetryPendingUploads();   // finish any camera uploads a dead zone deferred
  try{ _phRemirrorPublished((typeof _activeProjectId==='function')?_activeProjectId():null); }catch(_){}
  _glMigratePhaseD();
  // Other members' published photos (shared projects) — feed the map pins.
  phLoadShared().then(()=>{
    if((window._phShared||[]).length && typeof mapRenderPhotoPins === 'function') mapRenderPhotoPins();
  }).catch(()=>{});
}

// ── Reset day window and re-render (called from showPage) ──
function phResetAndRender(){ _phDaysShown = 7; phRender(); }

// ── 📸 In-app camera save (src/camera.js) ──
// Stores the CLEAN original JPEG + the shutter-time metadata record (GPS, heading,
// caption, location label, tags). The branded stamp is a rendering composited at
// share/export time — never baked here — so every element stays toggleable and a
// clean copy always exists (two-layer model, locked 7/29).
async function phSaveCameraPhoto(blob, meta){
  if(!_currentUser) return null;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const today=new Date().toLocaleDateString('en-CA');
  const id='cam'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  const fname=`camera-${id}.jpg`;
  // Thumbnail via canvas (same path as map captures).
  const bmp=await createImageBitmap(blob);
  const tc=document.createElement('canvas');
  tc.width=280; tc.height=Math.round(280*bmp.height/bmp.width)||157;
  tc.getContext('2d').drawImage(bmp,0,0,tc.width,tc.height);
  bmp.close();
  const thumb=tc.toDataURL('image/jpeg',0.72);
  const m=meta||{};
  // LOCAL-FIRST (Tim device test 7/29): the record saves and the post-shot strip
  // pops immediately; the Storage upload runs in the background and patches in.
  // A failed upload (dead zone in the field) keeps the shot local instead of
  // losing it — the cloud doc syncs with the thumb, storageUrl heals when the
  // background upload (or a later phRecoverStorageUrls pass) lands.
  const entry={
    id, date:today, caption:m.caption||'', filename:fname, thumb, storageUrl:'',
    uploadedAt:Date.now(), takenAt:Date.now(), projectId:pid, type:'camera',
    ...(m.lat!=null&&m.lng!=null?{lat:m.lat,lng:m.lng}:{}),
    ...(m.heading!=null?{direction:Math.round(m.heading)}:{}),
    ...(m.accuracy!=null?{gpsAcc:Math.round(m.accuracy)}:{}),
    ...(m.altitude!=null?{alt:Math.round(m.altitude*10)/10}:{}),   // meters MSL

    ...(m.locLabel?{locLabel:m.locLabel}:{}),
  };
  const tags=Array.isArray(m.tags)?m.tags:[];
  if(tags.includes('swppp'))  entry.swppp=true;
  if(tags.includes('seed'))   entry.seedTag=true;
  if(tags.includes('repair')) entry.repairTag=true;
  window._phPhotos=(window._phPhotos||[]);
  window._phPhotos.push(entry);
  phSaveLocal();
  // 9/1 DURABLE-FIRST (Tim: two Sep-1 shots never uploaded, phone kept only the
  // thumb). The old order was upload → park-on-failure, which loses the original
  // whenever the upload dies WITHOUT rejecting: iOS suspending the WebView in a
  // pocket, a memory-pressure reload, a force-close mid-put. Park the bytes in
  // IDB before the first byte goes out; delete them only after the URL lands.
  let parked=false;
  try{ if(window.idbSet){ window.idbSet('cam_pending::'+id, blob); parked=true; } }catch(_){}
  (async()=>{
    try{
      if(!storage||!_fbReady) throw new Error('firebase not ready');
      const ref=storage.ref(`photos/${_currentUser.uid}/${id}/${fname}`);
      const snap=await ref.put(blob,{contentType:'image/jpeg'});
      const url=await snap.ref.getDownloadURL();
      // Resolve the LIVE record by id — never trust a captured reference to
      // still be the array's object (see _phApplySnapshot).
      const live=(window._phPhotos||[]).find(x=>x.id===id)||entry;
      live.storageUrl=url; entry.storageUrl=url;
      phSaveLocal();
      if(parked){ try{ window.idbDel('cam_pending::'+id); }catch(_){} }
    }catch(e){
      console.warn('phSaveCameraPhoto upload deferred:',e.message);
      _phUploadLastErr={id,at:Date.now(),msg:(e&&(e.code||e.message))||'upload failed'};
      // Retry pass finishes it later (reconnect / foreground / boot / 2-min sweep).
      if(!parked){ try{ if(window.idbSet) window.idbSet('cam_pending::'+id, blob); }catch(_){} }
    }
    phSaveCloudOne((window._phPhotos||[]).find(x=>x.id===id)||entry);
  })();
  // Contextual launch (📸 from a punchlist flag / drawing popup): auto-attach the
  // photo to that tracker entry — the shot lands where it documents.
  if(m.attach&&m.attach.type==='entry'&&m.attach.id&&typeof trAddPhotoLink==='function'){
    try{ trAddPhotoLink(m.attach.id, id, pid, 'general'); }
    catch(e){ console.warn('camera auto-attach failed:',e); }
  }
  try{
    phRender();
    if(typeof mapRenderPhotoPins==='function') mapRenderPhotoPins();
  }catch(e){}
  return entry;
}

// ── 🏷 Stamped copy (lightbox) ──
// ONE TAP (Tim 7/29): renders immediately with the configured elements and hands
// the copy to save/share — no per-save interrogation. Element adjustments live on
// the photo itself: the inline pill row under the lightbox (below) flips elements
// and is remembered. The stored photo never changes (two-layer model).
const _STAMP_PILLS=[
  {key:'gps',     pill:'🧭 GPS'},
  {key:'time',    pill:'🕐 Time'},
  {key:'project', pill:'🏗 Project'},
  {key:'caption', pill:'✏ Caption'},
  {key:'tags',    pill:'🏷 Tags'},
  {key:'brand',   pill:'🖋 Watermark'},
];
function _stampDefaults(){
  const base={gps:true,time:true,project:true,caption:true,tags:true,brand:true};
  try{ return Object.assign(base,JSON.parse(localStorage.getItem('gl_cam_stamp')||'{}')); }catch{ return base; }
}
function _phStampPillRow(){
  const row=document.getElementById('ph-lb-stamp-row');
  if(!row) return;
  if(window.camStampHydrate) window.camStampHydrate();   // cross-device prefs (one-shot)
  const t=_stampDefaults();
  row.innerHTML=_STAMP_PILLS.map(e=>
    `<button class="_lb-st-pill" data-k="${e.key}" style="padding:4px 9px;border-radius:12px;border:1px solid ${t[e.key]?'var(--amber)':'var(--border)'};background:${t[e.key]?'rgba(201,168,76,0.18)':'transparent'};color:${t[e.key]?'var(--amber)':'var(--muted)'};font-family:var(--mono);font-size:10px;cursor:pointer">${e.pill}</button>`
  ).join('');
  row.querySelectorAll('._lb-st-pill').forEach(btn=>{
    btn.onclick=()=>{
      const cur=_stampDefaults();
      cur[btn.dataset.k]=!cur[btn.dataset.k];
      // camStampSetDefaults also writes the cross-device settings doc; the
      // camera module is loaded here whenever the stamp preview rendered.
      if(window.camStampSetDefaults) window.camStampSetDefaults(cur);
      else try{ localStorage.setItem('gl_cam_stamp',JSON.stringify(cur)); }catch{}
      _phStampPillRow();
      // Live preview: re-render the stamped view with the new element set.
      const p=(window._phPhotos||[]).find(x=>x.id===_phLbId);
      if(p) _phLbApplyStamp(p);
    };
  });
}
async function phStampCurrent(){
  const p=(window._phPhotos||[]).find(x=>x.id===_phLbId);
  if(!p||p.type!=='camera') return;
  const btn=document.getElementById('ph-lb-stamp');
  if(btn){ btn.disabled=true; btn.textContent='🏷 Rendering…'; }
  try{
    if(!_camMod) _camMod=await import('./camera.js');
    const url=await phGetFull(p.id);
    const resp=await fetch(url);
    if(!resp.ok) throw new Error('full-res fetch failed');
    const blob=await resp.blob();
    const stamped=await _camMod.camStampBlob(p,blob,_stampDefaults());
    if(!stamped) throw new Error('stamp render failed');
    const name=`GroundLog-${p.date||''}${p.locLabel?'-'+p.locLabel.replace(/[^\w-]+/g,'_'):''}.jpg`;
    await window.saveFileNative(stamped,name,'image/jpeg');
  }catch(e){
    console.error('stamped copy failed:',e);
    alert('Stamped copy failed — see console.');
  }finally{
    if(btn){ btn.disabled=false; btn.textContent='🏷 Save stamped copy'; }
  }
}

// 🗑 Delete from the lightbox — closes it, then runs the standard soft-delete
// confirm (30-day undo window via the trash section).
function phDeleteCurrent(){
  const id=_phLbId;
  if(!id) return;
  phCloseLightbox();
  phConfirmDelete(id);
}

// Lazy camera launcher — the viewfinder module (and the capgo plugin with it)
// loads on first use only; nothing lands in the main bundle (7 MiB SW cap).
let _camMod=null;
async function phOpenCamera(ctx){
  try{
    if(!_camMod) _camMod=await import('./camera.js');
    _camMod.camOpen(ctx);
  }catch(e){
    console.error('camera module failed to load:',e);
    alert('Camera failed to open — try refreshing the app.');
  }
}

// ── Save a captured map view blob as a photo record ──
async function phSaveCapturedImage(blob, photoDate, captionOverride, opts){
  if(!storage||!_currentUser||!_fbReady) return null;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const today=photoDate||new Date().toLocaleDateString('en-CA');
  const [y,m,d]=today.split('-');
  const labelDate=`${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
  const id='mv'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  const caption=(captionOverride&&captionOverride.trim())?captionOverride.trim():`Map View · ${labelDate}`;
  // Generate thumbnail via canvas
  const bmp=await createImageBitmap(blob);
  const tc=document.createElement('canvas');
  tc.width=280; tc.height=Math.round(280*bmp.height/bmp.width)||157;
  tc.getContext('2d').drawImage(bmp,0,0,tc.width,tc.height);
  bmp.close();
  const thumb=tc.toDataURL('image/jpeg',0.72);
  // Upload to Storage — captures are JPEG at the source now (7/23); the PNG branch
  // only fires if the composite failed open and handed back the raw canvas PNG.
  const isJpeg=blob&&blob.type==='image/jpeg';
  const fname=isJpeg?'map-view.jpg':'map-view.png';
  let storageUrl='';
  try{
    const ref=storage.ref(`photos/${_currentUser.uid}/${id}/${fname}`);
    const snap=await ref.put(blob,{contentType:isJpeg?'image/jpeg':'image/png'});
    storageUrl=await snap.ref.getDownloadURL();
  }catch(e){ console.warn('phSaveCapturedImage upload failed:',e.message); return null; }
  const entry={id,date:today,caption,filename:fname,thumb,storageUrl,uploadedAt:Date.now(),projectId:pid,type:'map_capture'};
  // Pre-tagged captures (ESC status) flow straight into the QI report's §11 auto-attach.
  if(opts&&opts.swppp) entry.swppp=true;
  // Seeding-status captures carry their source keys so the seeding XLSX can route the
  // latest capture onto the right tab (single source → its tab; multi → summary tab).
  if(opts&&opts.seedCap) entry.seedCap=opts.seedCap;
  // Disturbance-status captures (FAB 🚧 flow) carry their category id so the
  // disturbance XLSX embeds the newest capture day under its summary band.
  if(opts&&opts.distCap) entry.distCap=opts.distCap;
  // Punchlist captures (FAB 🚩 flow) front the punchlist PDF's newest capture day.
  if(opts&&opts.plCap) entry.plCap=true;
  window._phPhotos=(window._phPhotos||[]);
  window._phPhotos.push(entry);
  phSaveLocal();
  // Write ONLY the new photo's doc — phSaveCloud() rewrites the entire library in one
  // batch, which overflows Firestore's write-stream queue once the library is large
  // (resource-exhausted). Single-doc set is all a fresh capture needs.
  phSaveCloudOne(entry);
  return entry;
}

// Persist a single photo doc (used by add/capture paths) so we never re-batch the whole
// library on a one-photo change. Mirrors the per-photo doc shape in phSaveCloud.
async function phSaveCloudOne(p){
  if(!p) return;
  // Route through the dirty flush so a failed write persists as pending
  // (survives reloads) instead of silently disappearing.
  phMarkDirty(p.id);
  if(!db || !_fbReady) return;
  await phSaveCloud();
}

// ── Expose to window for HTML onclick handlers and cross-module calls ──
window.phInit = phInit;
window.phMarkDirty = phMarkDirty;
window.phResetAndRender = phResetAndRender;
window.phHandleFiles = phHandleFiles;
window.phRender = phRender;
window.phSaveLocal = phSaveLocal;
window.phLoadMore = phLoadMore;
window.phClearFilters = phClearFilters;
window.phSaveCapturedImage = phSaveCapturedImage;
window.phSaveCameraPhoto = phSaveCameraPhoto;
window.phSaveCloudOne = phSaveCloudOne;
window.phOpenCamera = phOpenCamera;
window.phStampCurrent = phStampCurrent;
window.phDeleteCurrent = phDeleteCurrent;
window.phOpenLightbox = phOpenLightbox;
window.phLbToggleSheet = phLbToggleSheet;
window.phLbGotoEntry = phLbGotoEntry;
window.phCloseLightbox = phCloseLightbox;
window.phLbNext = phLbNext;
window.phLbPrev = phLbPrev;
window.phSaveCaption = phSaveCaption;
window.phShareCurrent = phShareCurrent;
// ⚑ Report a teammate's shared photo → members.js glReportContent (contentReports/).
function phReportCurrent(){
  const p=_phById(_phLbId); if(!p) return;
  if(typeof window.glReportContent!=='function') return;
  window.glReportContent({ type:'photo', id:p.id, ownerUid:p.ownerUid||'', label:(p.caption||p.filename||'Photo')+(p.date?' · '+p.date:'') });
}
window.phReportCurrent = phReportCurrent;
window.phToggleSwpppCurrent = phToggleSwpppCurrent;
window.phToggleSeedCurrent = phToggleSeedCurrent;
window.phSetPublished = phSetPublished;
window.phSetReportExclude = phSetReportExclude;
window.phRemirrorPublished = (force)=>_phRemirrorPublished(null, force);   // console/manual: phRemirrorPublished(true)
window.phExportBlobForRef = phExportBlobForRef;
window.phRecoverStorageUrls = phRecoverStorageUrls;
window.phLoadShared = phLoadShared;
window._phById = _phById;
window.phConfirmDelete = phConfirmDelete;
window.phUndoDelete = phUndoDelete;
window._phToggleTrash = _phToggleTrash;
window.phJumpToTrash = phJumpToTrash;
window._phToggleShared = _phToggleShared;
window.phJumpToShared = phJumpToShared;
window.phBearingLabel = phBearingLabel;
