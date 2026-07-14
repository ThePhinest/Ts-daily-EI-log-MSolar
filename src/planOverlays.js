// ── Plan-sheet overlays (★★ plan overlay, 2026-07-07) ───────────────────────
// Georeferenced plan sheets (ESC/grading/drainage crops from the offline
// georef pipeline) rendered on the live map as Mapbox ImageSources pinned to
// 4 lng/lat corners. The sheet is REFERENCE — it renders above the basemap and
// below every vector layer (KML, tracker drawings, labels, draw mode), so the
// user traces work over truth with the normal draw tools + snap.
//
// Memory: each decoded sheet is ~27 MB of GPU texture (2800×2378 RGBA), so
// sources are added ONLY while a sheet is toggled ON and removed on toggle OFF
// — same on-demand discipline as KML layers (iOS WKWebView ~150–200 MB cap).
//
// Persistence mirrors the KML layer trio:
//   IDB cache            msf_proj_{pid}_plan_overlays        (offline boot)
//   user subtree         users/{uid}/projects/{pid}/planOverlays/sheets
//   shared mirror        projects/{pid}/planOverlays/sheets  (member-readable;
//                        owner/lead writes — a member's toggle save is denied
//                        there and stays personal view state)
// Files live at planOverlays/{uid}/{sheetId}.png; members fetch via the
// persisted token downloadUrl (the token IS the capability — photos/KML model).

let _poSheets = [];          // [{id,name,file,corners,rmsFt,quality,visible,folderId,storagePath,downloadUrl}]
let _poFolders = [];         // [{id,name,order,_mts,deleted}] — shared organization (7/13); deleted = tombstone
let _poOpacity = 0.7;        // global raster opacity — personal view state
let _poCollapsed = false;    // panel section collapse — personal, localStorage
let _poNudge = null;         // active nudge session {id, startCorners}

function _poPid(){ return (typeof window._activeProjectId === 'function') ? window._activeProjectId() : 'default'; }
function _poMap(){ return (typeof window.getMapInstance === 'function') ? window.getMapInstance() : null; }
function _poStorageKey(){ return 'msf_proj_' + _poPid() + '_plan_overlays'; }

// ── Map render ───────────────────────────────────────────────────────────────

// Rasters must sit under every custom vector overlay. All of ours (KML,
// tracker, glow, measure, cone, labels, gl-draw) use geojson sources, while
// basemap style layers use mapbox vector/raster tiles — so "insert before the
// first geojson-sourced layer" keeps sheets above the basemap and below all
// working linework, regardless of what's currently mounted.
function _poBeforeId(map){
  try{
    const layers = map.getStyle().layers || [];
    for(const ly of layers){
      if(!ly.source || String(ly.id).startsWith('po-')) continue;
      const src = map.getSource(ly.source);
      if(src && src.type === 'geojson') return ly.id;
    }
  }catch{}
  return undefined;
}

// Resolve a fetchable URL: own file via Storage ref, another member's via the
// persisted token downloadUrl. Owner-side stamps the token URL on first
// resolve so members can load sheets the owner has toggled at least once.
async function _poEnsureUrl(sheet){
  if(sheet.downloadUrl) return sheet.downloadUrl;
  if(window.storage && sheet.storagePath){
    const url = await window.storage.ref(sheet.storagePath).getDownloadURL();
    sheet.downloadUrl = url;
    poSaveSheets();
    return url;
  }
  throw new Error('no fetch path for plan sheet ' + sheet.id);
}

async function _poAddToMap(sheet){
  const map = _poMap();
  if(!map || map.getSource('po-' + sheet.id)) return;
  const url = await _poEnsureUrl(sheet);
  // toggled OFF (or project switched) while the URL was resolving — don't mount
  if(!sheet.visible || !_poSheets.find(s => s.id === sheet.id)) return;
  if(map.getSource('po-' + sheet.id)) return;
  map.addSource('po-' + sheet.id, { type:'image', url, coordinates: sheet.corners });
  map.addLayer({
    id: 'po-' + sheet.id + '-raster',
    type: 'raster',
    source: 'po-' + sheet.id,
    paint: { 'raster-opacity': _poOpacity, 'raster-fade-duration': 0 }
  }, _poBeforeId(map));
}

function _poRemoveFromMap(sheet){
  const map = _poMap();
  if(!map) return;
  if(map.getLayer('po-' + sheet.id + '-raster')) map.removeLayer('po-' + sheet.id + '-raster');
  if(map.getSource('po-' + sheet.id)) map.removeSource('po-' + sheet.id);
}

async function poToggleSheet(id, visible){
  const sheet = _poSheets.find(s => s.id === id);
  if(!sheet) return;
  sheet.visible = visible;
  if(visible){
    try{ await _poAddToMap(sheet); }
    catch(err){
      console.warn('poToggleSheet:', err.message);
      sheet.visible = false;
      if(typeof window._reportError === 'function'){
        window._reportError({ type:'plan-overlay-toggle-failed',
          message:'plan sheet toggle ON failed: ' + err.message,
          stack: err.stack || null, sheetId: sheet.id, storagePath: sheet.storagePath });
      }
      if(typeof window.showCloudBanner === 'function') window.showCloudBanner('Couldn\'t load plan sheet ' + sheet.name + ' — check connection.');
    }
  } else {
    _poRemoveFromMap(sheet);
  }
  poSaveSheets();
  poRenderPanel();
}

function poToggleAll(visible){
  // Batched: one save + one panel render, not one per sheet. Turning many
  // sheets on at once is heavy (each ≈27 MB GPU) — warn but don't block; the
  // field workflow is 1–3 sheets at a time.
  if(visible && _poSheets.length > 8 && typeof window.showCloudBanner === 'function'){
    window.showCloudBanner('Heads up — all sheets at once is heavy on phone memory. In the field, toggle just the sheets you need.');
  }
  _poSheets.forEach(s => {
    s.visible = visible;
    if(visible){
      _poAddToMap(s).catch(e => console.warn('poToggleAll mount:', e.message));
    } else {
      _poRemoveFromMap(s);
    }
  });
  poSaveSheets();
  poRenderPanel();
}

function poSetOpacity(pct){
  _poOpacity = Math.min(1, Math.max(0.1, pct / 100));
  const map = _poMap();
  if(map){
    _poSheets.forEach(s => {
      if(map.getLayer('po-' + s.id + '-raster')) map.setPaintProperty('po-' + s.id + '-raster', 'raster-opacity', _poOpacity);
    });
  }
  const lbl = document.getElementById('map-po-opacity-val');
  if(lbl) lbl.textContent = Math.round(_poOpacity * 100) + '%';
  poSaveSheets();
}

// Style switch destroys all sources — re-mount the visible sheets. Called from
// mapSetStyle's styledata handler alongside the KML re-add.
function poReaddVisible(){
  _poSheets.filter(s => s.visible).forEach(s => { _poAddToMap(s).catch(e => console.warn('poReaddVisible:', e.message)); });
}

// Project switch teardown — remove mounted rasters and forget state; the new
// project's poLoadSheets() rehydrates.
function poClearAll(){
  _poSheets.forEach(_poRemoveFromMap);
  _poSheets = [];
  _poFolders = [];
  _poNudge = null;
  _poAdjustBindDrag(false);
  const box = document.getElementById('map-po-nudge');
  if(box) box.remove();
  poCropCancel();
  poRenderPanel();
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Firestore rejects nested arrays, so corners (4×[lng,lat]) are stored as an
// array of {lng,lat} maps and unpacked back to pairs on load (ImageSource
// wants pairs). The unpack accepts both shapes so IDB/Firestore stay in sync.

function _poPackCorners(corners){ return corners.map(c => ({ lng: c[0], lat: c[1] })); }
function _poUnpackCorners(corners){
  return (corners || []).map(c => Array.isArray(c) ? c : [c.lng, c.lat]);
}

// Stamp a sheet whose SHARED content (corners/crop/files/registration) just
// changed. The per-sheet _mts drives the newest-wins merge in poLoadSheets —
// it is what protects an edit from being reverted by a stale whole-list write
// from another device, or by a cloud copy that never received the edit
// because the WebView reloaded (iOS memory pressure) before the write flushed.
function _poTouch(sheet){ sheet._mts = Date.now(); }

function poSaveSheets(){
  const pid = _poPid();
  const data = _poSheets.map(s => ({
    id: s.id, name: s.name, file: s.file || '',
    corners: _poPackCorners(s.corners), rmsFt: s.rmsFt ?? null, quality: s.quality || 'good',
    visible: !!s.visible, folderId: s.folderId || null,
    storagePath: s.storagePath || '', downloadUrl: s.downloadUrl || '',
    // ✂ crop state (null when uncropped): rect in ORIGINAL-image fractions +
    // the pre-crop original file so crops are re-editable and resettable.
    crop: s.crop || null, origStoragePath: s.origStoragePath || '', origDownloadUrl: s.origDownloadUrl || '',
    _mts: s._mts ?? null
  }));
  const folders = _poFolders.map(f => ({ id: f.id, name: f.name, order: f.order ?? 0, deleted: !!f.deleted, _mts: f._mts ?? null }));
  try{ if(window.idbSet) window.idbSet(_poStorageKey(), JSON.stringify({ data, folders, opacity: _poOpacity })); }catch{}
  let userWrite = null;
  if(window.db && window._fbReady){
    // Personal copy — per-sheet visibility + opacity are view state, never shared.
    const u = (typeof window._projDataUser === 'function') ? window._projDataUser(pid) : null;
    if(u){
      userWrite = u.collection('planOverlays').doc('sheets')
        .set({ data, folders, opacity: _poOpacity, _ts: Date.now() });
      userWrite.catch(e => console.warn('poSaveSheets:', e.message));
    }
    // Shared mirror — sheet list + corners are live reference data for members.
    // Rules let only owner/lead land this write; silent on purpose.
    if(window._currentUser){
      window.db.collection('projects').doc(pid).collection('planOverlays').doc('sheets')
        .set({ data, folders, ownerUid: window._currentUser.uid, _ts: Date.now() })
        .catch(() => {});
    }
  }
  return userWrite;   // callers that just committed real work await/verify this
}

// Folders merge: union across shared/user/IDB, newest-wins per folder by _mts.
// Deletion is a TOMBSTONE (deleted:true) — a plain removal would resurrect from
// any stale cache under the union. Tombstones purge after 45 days.
function _poMergeFolders(shared, own, idb){
  const by = new Map();
  [shared, own, idb].forEach(list => (list || []).forEach(f => {
    if(!f || !f.id) return;
    const cur = by.get(f.id);
    if(!cur || (f._mts || 0) > (cur._mts || 0)) by.set(f.id, f);
  }));
  const cutoff = Date.now() - 45 * 86400000;
  return [...by.values()]
    .filter(f => !(f.deleted && (f._mts || 0) < cutoff))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

async function poLoadSheets(){
  const pid = _poPid();
  let own = null, shared = null, idb = null, opacity = null;
  let ownF = null, sharedF = null, idbF = null;
  if(window.db && window._fbReady){
    try{
      const u = (typeof window._projDataUser === 'function') ? window._projDataUser(pid) : null;
      const doc = u ? await u.collection('planOverlays').doc('sheets').get() : null;
      if(doc && doc.exists){ own = doc.data().data; ownF = doc.data().folders; opacity = doc.data().opacity; }
    }catch(e){ console.warn('poLoadSheets cloud:', e.message); }
    try{
      const sdoc = await window.db.collection('projects').doc(pid).collection('planOverlays').doc('sheets').get();
      if(sdoc.exists && Array.isArray(sdoc.data().data) && sdoc.data().data.length){ shared = sdoc.data().data; sharedF = sdoc.data().folders; }
    }catch(e){ /* not a member of a shared project — own copy stands */ }
  }
  try{
    const raw = window.idbGet && window.idbGet(_poStorageKey());
    if(raw){ const parsed = JSON.parse(raw); idb = parsed.data; idbF = parsed.folders; if(typeof opacity !== 'number') opacity = parsed.opacity; }
  }catch{}
  _poFolders = _poMergeFolders(sharedF, ownF, idbF);
  // Shared doc is canonical for LIST MEMBERSHIP (never resurrect deletes from
  // a local cache), but each sheet's CONTENT is newest-wins by per-sheet _mts
  // across shared / user / device-IDB copies. This is the guard against the
  // two whole-list-doc loss modes: a stale device writing its old list over a
  // fresh edit, and a cloud copy that never received the edit because the
  // WebView reloaded (iOS memory pressure) before the async write flushed —
  // the device that made the edit still holds it in IDB and heals the cloud.
  const base = (shared && shared.length) ? shared : ((own && own.length) ? own : (idb || []));
  const ownBy = new Map((own || []).map(s => [s.id, s]));
  const idbBy = new Map((idb || []).map(s => [s.id, s]));
  const sharedBy = new Map((shared || []).map(s => [s.id, s]));
  let healNeeded = false;
  const data = base.map(s => {
    let best = s;
    for(const cand of [ownBy.get(s.id), idbBy.get(s.id)]){
      if(cand && (cand._mts || 0) > (best._mts || 0)) best = cand;
    }
    if((best._mts || 0) > (((sharedBy.get(s.id)) || {})._mts || 0)) healNeeded = true;
    const mine = ownBy.get(s.id) || idbBy.get(s.id);
    return { ...best, visible: mine ? !!mine.visible : !!s.visible };
  });
  if(typeof opacity === 'number' && opacity >= 0.1 && opacity <= 1) _poOpacity = opacity;
  _poSheets = data.map(s => ({ ...s, corners: _poUnpackCorners(s.corners) }));
  if(healNeeded && _poSheets.length) poSaveSheets();   // push the newer local truth back up
  _poSheets.filter(s => s.visible).forEach(s => { _poAddToMap(s).catch(e => console.warn('poLoadSheets mount:', e.message)); });
  poRenderPanel();
}

// ── Import (manifest.json + sheet images, one multi-select) ─────────────────
// Manifest format = the georef pipeline output: { "PV.C04.23": { file, corners
// (4×[lng,lat] TL,TR,BR,BL), rms_ft, quality }, ... }. Generic — any future
// sheet set (grading, drainage, roads) with the same manifest shape imports
// the same way.

async function poImportFiles(input){
  const files = Array.from(input.files || []);
  input.value = '';
  if(!files.length) return;
  const banner = m => { if(typeof window.showCloudBanner === 'function') window.showCloudBanner(m); };
  if(!window._currentUser || !window.storage){ banner('Sign in first — plan sheets need cloud storage.'); return; }

  const manifestFile = files.find(f => /\.json$/i.test(f.name));
  if(!manifestFile){ banner('Select the manifest.json TOGETHER with the sheet images (one multi-select).'); return; }
  let manifest;
  try{ manifest = JSON.parse(await manifestFile.text()); }
  catch(e){ banner('Couldn\'t parse ' + manifestFile.name + ' — not valid JSON.'); return; }

  const images = new Map(files.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name)).map(f => [f.name, f]));
  const entries = Object.entries(manifest).filter(([, m]) => m && m.file && Array.isArray(m.corners) && m.corners.length === 4);
  if(!entries.length){ banner('No sheets with corners found in the manifest.'); return; }

  let done = 0, skipped = 0, updated = 0;
  for(const [name, meta] of entries){
    // Re-importing a manifest (with or without images) REFRESHES an existing
    // sheet's registration in place — corners/rms/quality update, the uploaded
    // image is reused. This is the delivery path for re-registered manifests:
    // select just the new manifest.json, no 40 MB re-upload.
    const existing = _poSheets.find(s => s.name === name);
    if(existing){
      const map = _poMap();
      existing.corners = meta.corners;
      existing.rmsFt = (typeof meta.rms_ft === 'number') ? meta.rms_ft : existing.rmsFt;
      existing.quality = meta.quality || existing.quality;
      // A registration refresh delivers FULL-extent corners — a crop's corners
      // and derivative image would no longer match. Restore the original.
      let remount = false;
      if(existing.crop){
        if(window.storage && existing.origStoragePath && existing.storagePath !== existing.origStoragePath){
          window.storage.ref(existing.storagePath).delete().catch(() => {});
        }
        existing.storagePath = existing.origStoragePath || existing.storagePath;
        existing.downloadUrl = existing.origDownloadUrl || existing.downloadUrl;
        existing.crop = null; existing.origStoragePath = ''; existing.origDownloadUrl = '';
        remount = existing.visible;
      }
      _poTouch(existing);
      const src = map && map.getSource('po-' + existing.id);
      if(remount){
        _poRemoveFromMap(existing);
        _poAddToMap(existing).catch(e => console.warn('poImportFiles remount:', e.message));
      } else if(src && src.setCoordinates){
        src.setCoordinates(existing.corners);
      }
      updated++;
      continue;
    }
    const img = images.get(meta.file);
    if(!img){ skipped++; continue; }
    banner(`Uploading plan sheet ${done + 1}/${entries.length} — ${name}…`);
    const id = 'po-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const storagePath = `planOverlays/${window._currentUser.uid}/${id}-${meta.file}`;
    try{
      const snap = await window.storage.ref(storagePath).put(img);
      const downloadUrl = await snap.ref.getDownloadURL();
      _poSheets.push({
        id, name, file: meta.file,
        corners: meta.corners,
        rmsFt: (typeof meta.rms_ft === 'number') ? meta.rms_ft : null,
        quality: meta.quality || 'good',
        visible: false,                      // default OFF — 27 MB GPU each
        storagePath, downloadUrl,
        _mts: Date.now()
      });
      done++;
    }catch(err){
      console.warn('poImportFiles upload:', err.message);
      if(typeof window._reportError === 'function'){
        window._reportError({ type:'plan-overlay-import-error', stage:'storage-upload',
          message: err.message, stack: err.stack || null, sheetName: name, storagePath });
      }
      skipped++;
    }
  }
  _poSheets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  poSaveSheets();
  poRenderPanel();
  const parts = [];
  if(done) parts.push(`${done} imported`);
  if(updated) parts.push(`${updated} updated (registration refreshed)`);
  if(skipped) parts.push(`${skipped} skipped`);
  banner(`Plan sheets: ${parts.join(', ') || 'nothing to do'}.`);
}

function poDeleteSheet(id){
  const sheet = _poSheets.find(s => s.id === id);
  if(!sheet) return;
  document.getElementById('_po-del-ov')?.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay'; ov.id = '_po-del-ov';
  ov.style.cssText = 'z-index:9000';
  ov.innerHTML = `<div class="modal-box" style="max-width:320px;width:90%">
    <div class="modal-title" style="margin-bottom:8px">Remove plan sheet?</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5"><b>${String(sheet.name).replace(/</g,'&lt;')}</b> is removed for every project member. Drawings traced over it are NOT affected.</div>
    <div class="modal-btns">
      <button class="modal-confirm" id="_po-del-go" style="background:#3d1414;border:1px solid #6b2020;color:#ff8080">✕ Remove sheet</button>
      <button class="modal-cancel" id="_po-del-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#_po-del-cancel').onclick = () => ov.remove();
  ov.addEventListener('click', ev => { if(ev.target === ov) ov.remove(); });
  ov.querySelector('#_po-del-go').onclick = () => {
    ov.remove();
    _poRemoveFromMap(sheet);
    _poSheets = _poSheets.filter(s => s.id !== id);
    // Best-effort Storage cleanup — only the owner's rule allows it. A cropped
    // sheet has two files (derivative + kept original); remove both.
    if(window.storage && sheet.storagePath){ window.storage.ref(sheet.storagePath).delete().catch(() => {}); }
    if(window.storage && sheet.origStoragePath && sheet.origStoragePath !== sheet.storagePath){
      window.storage.ref(sheet.origStoragePath).delete().catch(() => {});
    }
    poSaveSheets();
    poRenderPanel();
  };
}

// ── Adjust mode (registration correction / manual fit) ──────────────────────
// Full manual transform for a sheet: DRAG it on the map to move, rotate and
// scale in stepped increments, arrows for fine translation. Live via
// ImageSource setCoordinates; persisted (shared — a corner fix is a data
// correction, not view state) on Save. This is both the rescue path for
// REVIEW-flagged registrations AND the universal fallback for plan sets that
// have no surveyed reference to auto-fit against.

const _FT_PER_DEG_LAT = 364567.2;
function _poFtPerDegLng(lat){ return _FT_PER_DEG_LAT * Math.cos(lat * Math.PI / 180); }

function _poShiftCorners(corners, dxFt, dyFt){
  const latRef = corners[0][1];
  const dLat = dyFt / _FT_PER_DEG_LAT;
  const dLng = dxFt / _poFtPerDegLng(latRef);
  return corners.map(([lng, lat]) => [lng + dLng, lat + dLat]);
}

// Rotate (deg CCW) and/or scale the corner quad about its centroid, in local
// ENU-ft so the transform is metric-true regardless of latitude.
function _poTransformCorners(corners, rotDeg, scale){
  const clng = corners.reduce((a, c) => a + c[0], 0) / corners.length;
  const clat = corners.reduce((a, c) => a + c[1], 0) / corners.length;
  const fLng = _poFtPerDegLng(clat), fLat = _FT_PER_DEG_LAT;
  const a = rotDeg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  return corners.map(([lng, lat]) => {
    const x = (lng - clng) * fLng, y = (lat - clat) * fLat;
    const xr = (x * cos - y * sin) * scale, yr = (x * sin + y * cos) * scale;
    return [clng + xr / fLng, clat + yr / fLat];
  });
}

// Point-in-convex-quad (corners TL,TR,BR,BL) — raster layers aren't
// queryRenderedFeatures-able, so drag targeting hit-tests the geometry.
function _poPointInQuad(lngLat, corners){
  let sign = 0;
  for(let i = 0; i < 4; i++){
    const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
    const cross = (bx - ax) * (lngLat.lat - ay) - (by - ay) * (lngLat.lng - ax);
    if(cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if(sign === 0) sign = s;
    else if(s !== sign) return false;
  }
  return true;
}

// step sizes per action, indexed by the S/M/L selector
const _PO_STEPS = { move: [1, 5, 25], rot: [0.1, 0.5, 2], scale: [0.002, 0.01, 0.05] };
function _poStepIdx(){ return parseInt(document.getElementById('map-po-adj-step')?.value || '1', 10); }

function _poAdjustSheet(){ return _poNudge ? _poSheets.find(s => s.id === _poNudge.id) : null; }

function _poApplyLive(sheet){
  const map = _poMap();
  const src = map && map.getSource('po-' + sheet.id);
  if(src && src.setCoordinates) src.setCoordinates(sheet.corners);
}

// Drag-to-move: pointer down inside the sheet quad captures the gesture and
// suspends map panning; each move applies the lng/lat delta to all corners.
// Two-finger gestures stay with the map (pinch zoom keeps working mid-adjust).
let _poDragFrom = null;
function _poAdjustPointerDown(e){
  const sheet = _poAdjustSheet();
  if(!sheet) return;
  if(e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length > 1) return;
  if(!_poPointInQuad(e.lngLat, sheet.corners)) return;
  e.preventDefault();
  _poDragFrom = e.lngLat;
  const map = _poMap();
  const move = ev => {
    if(!_poDragFrom) return;
    const dLng = ev.lngLat.lng - _poDragFrom.lng;
    const dLat = ev.lngLat.lat - _poDragFrom.lat;
    _poDragFrom = ev.lngLat;
    sheet.corners = sheet.corners.map(([lng, lat]) => [lng + dLng, lat + dLat]);
    _poApplyLive(sheet);
  };
  const up = () => {
    _poDragFrom = null;
    map.off('mousemove', move); map.off('touchmove', move);
    map.off('mouseup', up); map.off('touchend', up);
  };
  map.on('mousemove', move); map.on('touchmove', move);
  map.on('mouseup', up); map.on('touchend', up);
}

function _poAdjustBindDrag(on){
  const map = _poMap();
  if(!map) return;
  if(on){
    map.on('mousedown', _poAdjustPointerDown);
    map.on('touchstart', _poAdjustPointerDown);
  } else {
    map.off('mousedown', _poAdjustPointerDown);
    map.off('touchstart', _poAdjustPointerDown);
    _poDragFrom = null;
  }
}

function poNudgeOpen(id){
  const sheet = _poSheets.find(s => s.id === id);
  if(!sheet) return;
  if(_poNudge) poNudgeCancel();   // discard any unsaved movement on another sheet
  if(!sheet.visible){ poToggleSheet(id, true); }
  document.getElementById('map-po-nudge')?.remove();
  _poNudge = { id, startCorners: sheet.corners.map(c => [...c]) };
  const box = document.createElement('div');
  box.id = 'map-po-nudge';
  box.style.cssText = 'position:absolute;bottom:150px;left:50%;transform:translateX(-50%);z-index:40;background:rgba(0,0,0,0.85);border:1px solid var(--border);border-radius:10px;padding:10px 12px;box-shadow:0 4px 20px rgba(0,0,0,.5);';
  const btn = 'background:var(--s1);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:14px;width:34px;height:34px;cursor:pointer;';
  box.innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;color:var(--amber2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;text-align:center">🎯 Adjust — ${String(sheet.name).replace(/</g,'&lt;')}</div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--muted);margin-bottom:8px;text-align:center">drag the sheet on the map to move it</div>
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="display:grid;grid-template-columns:34px 34px 34px;gap:4px;justify-items:center;">
        <button style="${btn}" title="rotate counter-clockwise" onclick="poAdjustRotate(1)">↺</button>
        <button style="${btn}" onclick="poNudgeBy(0,1)">↑</button>
        <button style="${btn}" title="rotate clockwise" onclick="poAdjustRotate(-1)">↻</button>
        <button style="${btn}" onclick="poNudgeBy(-1,0)">←</button>
        <select id="map-po-adj-step" title="step size" style="background:var(--s1);border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:var(--mono);font-size:10px;width:34px;height:34px;text-align:center;padding:0">
          <option value="0">S</option><option value="1" selected>M</option><option value="2">L</option>
        </select>
        <button style="${btn}" onclick="poNudgeBy(1,0)">→</button>
        <button style="${btn}" title="shrink" onclick="poAdjustScale(-1)">−</button>
        <button style="${btn}" onclick="poNudgeBy(0,-1)">↓</button>
        <button style="${btn}" title="enlarge" onclick="poAdjustScale(1)">＋</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        <button style="background:var(--amber);border:none;color:#1a1a1a;border-radius:6px;font-family:var(--mono);font-size:11px;font-weight:700;padding:7px 12px;cursor:pointer;" onclick="poNudgeSave()">✓ Save</button>
        <button style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:var(--mono);font-size:10px;padding:5px 12px;cursor:pointer;" onclick="poCropOpen('${sheet.id}')">✂ Crop</button>
        <button style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;font-family:var(--mono);font-size:10px;padding:5px 12px;cursor:pointer;" onclick="poAdjustReset()">Reset</button>
        <button style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;font-family:var(--mono);font-size:10px;padding:5px 12px;cursor:pointer;" onclick="poNudgeCancel()">Cancel</button>
      </div>
    </div>`;
  const host = document.getElementById('map-container') || document.getElementById('page-map') || document.body;
  host.appendChild(box);
  _poAdjustBindDrag(true);
}

function poNudgeBy(ex, ny){
  const sheet = _poAdjustSheet();
  if(!sheet) return;
  const step = _PO_STEPS.move[_poStepIdx()];
  sheet.corners = _poShiftCorners(sheet.corners, ex * step, ny * step);
  _poApplyLive(sheet);
}

function poAdjustRotate(dir){
  const sheet = _poAdjustSheet();
  if(!sheet) return;
  sheet.corners = _poTransformCorners(sheet.corners, dir * _PO_STEPS.rot[_poStepIdx()], 1);
  _poApplyLive(sheet);
}

function poAdjustScale(dir){
  const sheet = _poAdjustSheet();
  if(!sheet) return;
  sheet.corners = _poTransformCorners(sheet.corners, 0, 1 + dir * _PO_STEPS.scale[_poStepIdx()]);
  _poApplyLive(sheet);
}

function poAdjustReset(){
  const sheet = _poAdjustSheet();
  if(!sheet || !_poNudge) return;
  sheet.corners = _poNudge.startCorners.map(c => [...c]);
  _poApplyLive(sheet);
}

function poNudgeSave(){
  if(!_poNudge) return;
  const sheet = _poSheets.find(s => s.id === _poNudge.id);
  if(sheet) _poTouch(sheet);
  _poNudge = null;
  _poAdjustBindDrag(false);
  document.getElementById('map-po-nudge')?.remove();
  poSaveSheets();
}

function poNudgeCancel(){
  if(!_poNudge) return;
  const sheet = _poSheets.find(s => s.id === _poNudge.id);
  if(sheet){
    sheet.corners = _poNudge.startCorners;
    _poApplyLive(sheet);
  }
  _poNudge = null;
  _poAdjustBindDrag(false);
  document.getElementById('map-po-nudge')?.remove();
}

// ── ✂ Crop (clip a sheet to just the region you need) ───────────────────────
// The crop is a rectangle in ORIGINAL-image space (u/v fractions). Applying it
// renders the sub-rect to a canvas at native resolution, uploads the cropped
// PNG, and re-pins the corners by affine interpolation of the sheet quad — so
// a cropped sheet drops GPU memory AND stops covering its neighbours, and the
// 🎯 adjust tools keep working on the result. The pre-crop original file is
// kept so the crop can be re-edited outward or fully reset at any time.
//
// Corner math: every quad here is a parallelogram (georef + all adjust ops are
// affine), so the FULL-image quad is exactly recoverable from the current
// corners and the stored crop fractions — no original corners need persisting,
// and crop→adjust→re-crop composes without drift.

let _poCrop = null;   // {id, img, iw, ih, rect:{u0,v0,u1,v1}, drag}

function _poFullQuad(corners, crop){
  if(!crop) return corners.map(c => [...c]);
  const [TL, TR, , BL] = corners;
  const du = Math.max(crop.u1 - crop.u0, 1e-6), dv = Math.max(crop.v1 - crop.v0, 1e-6);
  const U = [(TR[0] - TL[0]) / du, (TR[1] - TL[1]) / du];   // full left→right vector
  const V = [(BL[0] - TL[0]) / dv, (BL[1] - TL[1]) / dv];   // full top→bottom vector
  const fTL = [TL[0] - crop.u0 * U[0] - crop.v0 * V[0], TL[1] - crop.u0 * U[1] - crop.v0 * V[1]];
  return [
    fTL,
    [fTL[0] + U[0], fTL[1] + U[1]],
    [fTL[0] + U[0] + V[0], fTL[1] + U[1] + V[1]],
    [fTL[0] + V[0], fTL[1] + V[1]]
  ];
}

function _poQuadForCrop(fullQuad, r){
  const [TL, TR, , BL] = fullQuad;
  const U = [TR[0] - TL[0], TR[1] - TL[1]];
  const V = [BL[0] - TL[0], BL[1] - TL[1]];
  const at = (u, v) => [TL[0] + u * U[0] + v * V[0], TL[1] + u * U[1] + v * V[1]];
  return [at(r.u0, r.v0), at(r.u1, r.v0), at(r.u1, r.v1), at(r.u0, r.v1)];
}

async function poCropOpen(id){
  const sheet = _poSheets.find(s => s.id === id);
  if(!sheet) return;
  const banner = m => { if(typeof window.showCloudBanner === 'function') window.showCloudBanner(m); };
  // The cropped file lives under the importing user's Storage subtree — only
  // that user can write there, so cropping is owner-only (members see a hint).
  const uid = window._currentUser && window._currentUser.uid;
  if(!uid || (sheet.storagePath && !sheet.storagePath.includes('/' + uid + '/'))){
    banner('Only the member who imported this sheet can crop it.');
    return;
  }
  banner('Loading sheet image…');
  let img;
  try{
    const url = sheet.origDownloadUrl || await _poEnsureUrl(sheet);
    const blob = await (await fetch(url)).blob();
    img = await createImageBitmap(blob);
  }catch(err){
    console.warn('poCropOpen:', err.message);
    banner('Couldn\'t load the sheet image — check connection.');
    return;
  }
  document.getElementById('_po-crop-ov')?.remove();
  _poCrop = {
    id, img, iw: img.width, ih: img.height,
    rect: sheet.crop ? { ...sheet.crop } : { u0: 0, v0: 0, u1: 1, v1: 1 },
    drag: null
  };
  const ov = document.createElement('div');
  ov.id = '_po-crop-ov';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;';
  const small = 'background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;font-family:var(--mono);font-size:11px;padding:8px 14px;cursor:pointer;';
  ov.innerHTML = `
    <div style="padding:calc(env(safe-area-inset-top, 0px) + 10px) 14px 8px;display:flex;align-items:center;gap:8px;">
      <span style="font-family:var(--mono);font-size:11px;color:var(--amber2);text-transform:uppercase;letter-spacing:.06em;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">✂ Crop — ${String(sheet.name).replace(/</g,'&lt;')}</span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);">drag edges/corners · drag inside to move</span>
    </div>
    <div id="_po-crop-host" style="flex:1;position:relative;overflow:hidden;touch-action:none;">
      <canvas id="_po-crop-cv" style="position:absolute;"></canvas>
    </div>
    <div style="padding:10px 14px calc(env(safe-area-inset-bottom, 0px) + 12px);display:flex;gap:8px;justify-content:center;">
      <button style="background:var(--amber);border:none;color:#1a1a1a;border-radius:6px;font-family:var(--mono);font-size:12px;font-weight:700;padding:8px 18px;cursor:pointer;" onclick="poCropApply()">✓ Apply crop</button>
      ${sheet.crop ? `<button style="${small}" onclick="poCropReset()">Reset to full sheet</button>` : ''}
      <button style="${small}" onclick="poCropCancel()">Cancel</button>
    </div>`;
  document.body.appendChild(ov);
  const cv = ov.querySelector('#_po-crop-cv');
  cv.addEventListener('pointerdown', _poCropDown);
  cv.addEventListener('pointermove', _poCropMove);
  cv.addEventListener('pointerup', _poCropUp);
  cv.addEventListener('pointercancel', _poCropUp);
  window.addEventListener('resize', _poCropDraw);
  requestAnimationFrame(_poCropDraw);
}

// canvas layout: image letterboxed into the host; _poCrop.fit carries the
// image→canvas mapping so pointer math stays in image fractions.
function _poCropDraw(){
  if(!_poCrop) return;
  const host = document.getElementById('_po-crop-host');
  const cv = document.getElementById('_po-crop-cv');
  if(!host || !cv) return;
  const W = host.clientWidth, H = host.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { img, iw, ih, rect } = _poCrop;
  const sc = Math.min((W - 20) / iw, (H - 20) / ih);
  const dw = iw * sc, dh = ih * sc;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  _poCrop.fit = { sc, ox, oy, dw, dh };
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(img, ox, oy, dw, dh);
  // dim everything outside the crop rect
  const x0 = ox + rect.u0 * dw, y0 = oy + rect.v0 * dh;
  const x1 = ox + rect.u1 * dw, y1 = oy + rect.v1 * dh;
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(ox, oy, dw, y0 - oy);
  ctx.fillRect(ox, y1, dw, oy + dh - y1);
  ctx.fillRect(ox, y0, x0 - ox, y1 - y0);
  ctx.fillRect(x1, y0, ox + dw - x1, y1 - y0);
  // rect + handles
  ctx.strokeStyle = '#e8b44d'; ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = '#e8b44d';
  for(const [hx, hy] of _poCropHandles(x0, y0, x1, y1)){
    ctx.fillRect(hx - 7, hy - 7, 14, 14);
  }
}

function _poCropHandles(x0, y0, x1, y1){
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  // order matters — indexes map to the drag modes in _poCropDown
  return [[x0, y0], [mx, y0], [x1, y0], [x1, my], [x1, y1], [mx, y1], [x0, y1], [x0, my]];
}

function _poCropDown(e){
  if(!_poCrop || !_poCrop.fit) return;
  e.preventDefault();
  e.target.setPointerCapture(e.pointerId);
  const { fit, rect } = _poCrop;
  const px = e.offsetX, py = e.offsetY;
  const x0 = fit.ox + rect.u0 * fit.dw, y0 = fit.oy + rect.v0 * fit.dh;
  const x1 = fit.ox + rect.u1 * fit.dw, y1 = fit.oy + rect.v1 * fit.dh;
  const hs = _poCropHandles(x0, y0, x1, y1);
  const R = 18; // finger-sized catch radius
  let mode = null;
  hs.forEach(([hx, hy], i) => {
    if(mode === null && Math.abs(px - hx) <= R && Math.abs(py - hy) <= R) mode = i;
  });
  if(mode === null && px > x0 && px < x1 && py > y0 && py < y1) mode = 'move';
  if(mode === null) return;
  _poCrop.drag = { mode, px, py, rect0: { ...rect } };
}

function _poCropMove(e){
  if(!_poCrop || !_poCrop.drag) return;
  e.preventDefault();
  const { fit, drag } = _poCrop;
  const du = (e.offsetX - drag.px) / fit.dw;
  const dv = (e.offsetY - drag.py) / fit.dh;
  const r0 = drag.rect0;
  let r = { ...r0 };
  const MIN = 0.05; // never collapse below 5% of the sheet
  if(drag.mode === 'move'){
    const su = Math.min(Math.max(du, -r0.u0), 1 - r0.u1);
    const sv = Math.min(Math.max(dv, -r0.v0), 1 - r0.v1);
    r = { u0: r0.u0 + su, v0: r0.v0 + sv, u1: r0.u1 + su, v1: r0.v1 + sv };
  } else {
    const m = drag.mode; // 0 TL,1 T,2 TR,3 R,4 BR,5 B,6 BL,7 L
    if(m === 0 || m === 6 || m === 7) r.u0 = Math.min(Math.max(0, r0.u0 + du), r0.u1 - MIN);
    if(m === 2 || m === 3 || m === 4) r.u1 = Math.max(Math.min(1, r0.u1 + du), r0.u0 + MIN);
    if(m === 0 || m === 1 || m === 2) r.v0 = Math.min(Math.max(0, r0.v0 + dv), r0.v1 - MIN);
    if(m === 4 || m === 5 || m === 6) r.v1 = Math.max(Math.min(1, r0.v1 + dv), r0.v0 + MIN);
  }
  _poCrop.rect = r;
  requestAnimationFrame(_poCropDraw);
}

function _poCropUp(){
  if(_poCrop) _poCrop.drag = null;
}

function poCropCancel(){
  document.getElementById('_po-crop-ov')?.remove();
  window.removeEventListener('resize', _poCropDraw);
  if(_poCrop && _poCrop.img && _poCrop.img.close) _poCrop.img.close();
  _poCrop = null;
}

// A crop commits its own corner change — if a 🎯 adjust session is open on the
// same sheet, rebase its revert point so adjust-Cancel doesn't undo the crop
// geometry against the already-swapped image.
function _poCropSyncNudge(sheet){
  if(_poNudge && _poNudge.id === sheet.id){
    _poNudge.startCorners = sheet.corners.map(c => [...c]);
  }
}

async function poCropApply(){
  if(!_poCrop) return;
  const sheet = _poSheets.find(s => s.id === _poCrop.id);
  const banner = m => { if(typeof window.showCloudBanner === 'function') window.showCloudBanner(m); };
  if(!sheet){ poCropCancel(); return; }
  const { img, iw, ih, rect } = _poCrop;
  const full = (rect.u0 <= 0.001 && rect.v0 <= 0.001 && rect.u1 >= 0.999 && rect.v1 >= 0.999);
  if(full){ poCropReset(); return; }
  banner('Cropping sheet…');
  const sx = Math.round(rect.u0 * iw), sy = Math.round(rect.v0 * ih);
  const sw = Math.max(1, Math.round((rect.u1 - rect.u0) * iw));
  const sh = Math.max(1, Math.round((rect.v1 - rect.v0) * ih));
  const cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if(!blob){ banner('Crop failed — couldn\'t render the image.'); return; }
  // exact fractions actually rendered (post-rounding), so corners match pixels
  const r = { u0: sx / iw, v0: sy / ih, u1: (sx + sw) / iw, v1: (sy + sh) / ih };
  const newPath = `planOverlays/${window._currentUser.uid}/${sheet.id}-crop-${Date.now().toString(36)}.png`;
  let newUrl;
  try{
    const snap = await window.storage.ref(newPath).put(blob);
    newUrl = await snap.ref.getDownloadURL();
  }catch(err){
    console.warn('poCropApply upload:', err.message);
    if(typeof window._reportError === 'function'){
      window._reportError({ type:'plan-overlay-crop-error', message: err.message,
        stack: err.stack || null, sheetId: sheet.id, storagePath: newPath });
    }
    banner('Crop upload failed — check connection and try again.');
    return;
  }
  // first crop keeps the original file; later crops replace only the derivative
  const prevDerivative = sheet.crop ? sheet.storagePath : '';
  if(!sheet.crop){
    sheet.origStoragePath = sheet.storagePath;
    sheet.origDownloadUrl = sheet.downloadUrl;
  }
  const fullQuad = _poFullQuad(sheet.corners, sheet.crop);
  sheet.corners = _poQuadForCrop(fullQuad, r);
  sheet.crop = r;
  sheet.storagePath = newPath;
  sheet.downloadUrl = newUrl;
  if(prevDerivative && window.storage){ window.storage.ref(prevDerivative).delete().catch(() => {}); }
  _poTouch(sheet);
  _poCropSyncNudge(sheet);
  const wasVisible = sheet.visible;
  _poRemoveFromMap(sheet);
  if(wasVisible){ await _poAddToMap(sheet).catch(e => console.warn('poCropApply remount:', e.message)); }
  const cloudWrite = poSaveSheets();
  poRenderPanel();
  poCropCancel();
  banner('Sheet cropped ✂ — 🎯 adjust still works on the result.');
  // Verify the cloud actually got it — a crop is committed work, not view
  // state. If the write hasn't confirmed in 4s, say so honestly (it stays on
  // this device and heals the cloud on the next load).
  if(cloudWrite){
    const ok = await Promise.race([cloudWrite.then(() => true).catch(() => false),
                                   new Promise(r => setTimeout(() => r(false), 4000))]);
    if(!ok) banner('Crop saved on this device — cloud sync pending (weak signal?). It syncs automatically when connection improves.');
  }
}

// Restore the pre-crop original (file + full-extent corners).
function poCropReset(){
  if(!_poCrop) return;
  const sheet = _poSheets.find(s => s.id === _poCrop.id);
  if(!sheet || !sheet.crop){ poCropCancel(); return; }
  const derivative = sheet.storagePath;
  sheet.corners = _poFullQuad(sheet.corners, sheet.crop);
  sheet.storagePath = sheet.origStoragePath || sheet.storagePath;
  sheet.downloadUrl = sheet.origDownloadUrl || sheet.downloadUrl;
  sheet.crop = null;
  sheet.origStoragePath = '';
  sheet.origDownloadUrl = '';
  if(derivative && derivative !== sheet.storagePath && window.storage){
    window.storage.ref(derivative).delete().catch(() => {});
  }
  _poTouch(sheet);
  _poCropSyncNudge(sheet);
  const wasVisible = sheet.visible;
  _poRemoveFromMap(sheet);
  if(wasVisible){ _poAddToMap(sheet).catch(e => console.warn('poCropReset remount:', e.message)); }
  poSaveSheets();
  poRenderPanel();
  poCropCancel();
  if(typeof window.showCloudBanner === 'function') window.showCloudBanner('Crop removed — full sheet restored.');
}

// ── Layer panel section ──────────────────────────────────────────────────────

// ── Folders (user-created, shared organization — 7/13) ──────────────────────
// Live (non-tombstoned) folders in display order.
function _poLiveFolders(){ return _poFolders.filter(f => !f.deleted); }
function _poFoldCollapseKey(){ return 'gl_po_fold_collapsed::' + _poPid(); }
function _poFoldCollapsed(){
  try{ return JSON.parse(localStorage.getItem(_poFoldCollapseKey()) || '{}') || {}; }catch{ return {}; }
}
function poFolderCollapse(fid){
  const m = _poFoldCollapsed();
  m[fid] = !m[fid];
  try{ localStorage.setItem(_poFoldCollapseKey(), JSON.stringify(m)); }catch{}
  poRenderPanel();
}

// Small self-contained name-input modal (create + rename share it).
function _poNameModal(title, initial, onOk){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-box" style="max-width:340px">
    <h3 style="margin:0 0 10px;font-size:15px">${title}</h3>
    <input id="po-fold-name" type="text" value="${String(initial || '').replace(/"/g,'&quot;')}" maxlength="40"
      style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--s1);background:var(--s1);color:var(--text);font-size:14px">
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn" id="po-fold-ok">Save</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('#po-fold-name');
  input.focus(); input.select();
  const ok = () => { const v = input.value.trim(); if(v){ ov.remove(); onOk(v); } };
  ov.querySelector('#po-fold-ok').onclick = ok;
  input.addEventListener('keydown', e => { if(e.key === 'Enter') ok(); });
}

function poFolderCreate(){
  _poNameModal('New plan-sheet folder', '', name => {
    const order = Math.max(0, ..._poLiveFolders().map(f => (f.order ?? 0) + 1));
    _poFolders.push({ id: 'pf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                      name, order, _mts: Date.now() });
    poSaveSheets();
    poRenderPanel();
  });
}
function poFolderRename(fid){
  const f = _poFolders.find(x => x.id === fid);
  if(!f) return;
  _poNameModal('Rename folder', f.name, name => {
    f.name = name; f._mts = Date.now();
    poSaveSheets();
    poRenderPanel();
  });
}
function poFolderDelete(fid){
  const f = _poFolders.find(x => x.id === fid);
  if(!f) return;
  const inside = _poSheets.filter(s => s.folderId === fid).length;
  const doDelete = () => {
    f.deleted = true; f._mts = Date.now();   // tombstone — a removal would resurrect from stale caches
    _poSheets.forEach(s => { if(s.folderId === fid){ s.folderId = null; _poTouch(s); } });
    poSaveSheets();
    poRenderPanel();
  };
  if(typeof window._confirmModal === 'function'){
    window._confirmModal(`Delete folder "${f.name}"?` + (inside ? ` Its ${inside} sheet${inside > 1 ? 's' : ''} move back to the main list — no sheets are deleted.` : ''),
      doDelete, 'Delete folder', 'Delete');
  } else doDelete();
}
function poFolderToggle(fid, visible){
  // Batched like poToggleAll: one save + one render for the whole folder.
  const sheets = _poSheets.filter(s => (s.folderId || null) === fid);
  if(visible && sheets.length > 8 && typeof window.showCloudBanner === 'function'){
    window.showCloudBanner('Heads up — many sheets at once is heavy on phone memory.');
  }
  sheets.forEach(s => {
    s.visible = visible;
    if(visible) _poAddToMap(s).catch(e => console.warn('poFolderToggle mount:', e.message));
    else _poRemoveFromMap(s);
  });
  poSaveSheets();
  poRenderPanel();
}
// 📁 on a sheet row → pick a destination folder.
function poSheetSetFolder(id){
  const sheet = _poSheets.find(s => s.id === id);
  if(!sheet) return;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  const rows = [
    `<button class="btn btn-outline" style="width:100%;text-align:left;margin-bottom:6px${!sheet.folderId ? ';border-color:var(--amber)' : ''}" data-fid="">— No folder (main list)</button>`,
    ..._poLiveFolders().map(f =>
      `<button class="btn btn-outline" style="width:100%;text-align:left;margin-bottom:6px${sheet.folderId === f.id ? ';border-color:var(--amber)' : ''}" data-fid="${f.id}">📁 ${String(f.name).replace(/</g,'&lt;')}</button>`)
  ].join('');
  ov.innerHTML = `<div class="modal-box" style="max-width:340px">
    <h3 style="margin:0 0 4px;font-size:15px">Move sheet</h3>
    <p style="font-size:11px;color:var(--muted);margin:0 0 10px;font-family:var(--mono)">${String(sheet.name).replace(/</g,'&lt;')}</p>
    ${rows}
    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:10px">
      <button class="btn btn-outline" id="po-mv-new">＋ New folder</button>
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-fid]').forEach(b => b.onclick = () => {
    sheet.folderId = b.dataset.fid || null;
    _poTouch(sheet);
    ov.remove();
    poSaveSheets();
    poRenderPanel();
  });
  ov.querySelector('#po-mv-new').onclick = () => {
    ov.remove();
    _poNameModal('New plan-sheet folder', '', name => {
      const order = Math.max(0, ..._poLiveFolders().map(f => (f.order ?? 0) + 1));
      const f = { id: 'pf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, order, _mts: Date.now() };
      _poFolders.push(f);
      sheet.folderId = f.id;
      _poTouch(sheet);
      poSaveSheets();
      poRenderPanel();
    });
  };
}

function _poSheetRow(s){
  const rms = (typeof s.rmsFt === 'number') ? `±${Math.round(s.rmsFt)}ft` : '';
  const review = s.quality === 'REVIEW'
    ? '<span style="font-family:var(--mono);font-size:8px;color:#ffb44d;border:1px solid #7a5a20;border-radius:3px;padding:1px 4px;letter-spacing:.04em;flex-shrink:0" title="Registration flagged for review — use 🎯 nudge to correct">REVIEW</span>' : '';
  return `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s1);border-radius:6px;margin-bottom:4px;">
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text);flex:1;min-width:0;">
      <input type="checkbox" ${s.visible ? 'checked' : ''} onchange="poToggleSheet('${s.id}',this.checked)">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${String(s.name).replace(/</g,'&lt;')}</span>
    </label>
    <span style="font-family:var(--mono);font-size:9px;color:var(--muted);flex-shrink:0">${rms}</span>
    ${review}
    <button onclick="poSheetSetFolder('${s.id}')" title="Move to folder" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;">📁</button>
    <button onclick="poNudgeOpen('${s.id}')" title="Nudge this sheet's position (registration correction)" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;">🎯</button>
    <button onclick="poDeleteSheet('${s.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;">✕</button>
  </div>`;
}

function poRenderPanel(){
  const section = document.getElementById('map-po-section');
  const list = document.getElementById('map-po-list');
  if(!section || !list) return;
  if(!_poSheets.length){ section.style.display = 'none'; return; }
  section.style.display = '';
  try{ _poCollapsed = localStorage.getItem('gl_po_collapsed') === '1'; }catch{}
  const allVisible = _poSheets.every(s => s.visible);
  const collapsed = _poFoldCollapsed();
  const folders = _poLiveFolders();
  const folderIds = new Set(folders.map(f => f.id));
  // Sheets pointing at a tombstoned/unknown folder render in the main list.
  const inFolder = (s, f) => s.folderId === f.id;
  const rootSheets = _poSheets.filter(s => !s.folderId || !folderIds.has(s.folderId));
  const folderBlocks = folders.map(f => {
    const sheets = _poSheets.filter(s => inFolder(s, f));
    const on = sheets.filter(s => s.visible).length;
    const isCollapsed = !!collapsed[f.id];
    return `<div style="margin-bottom:4px;border:1px solid var(--s1);border-radius:6px;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s2);">
        <span onclick="poFolderCollapse('${f.id}')" style="cursor:pointer;font-size:10px;color:var(--muted2);padding:2px 4px 2px 0;">${isCollapsed ? '▸' : '▾'}</span>
        <input type="checkbox" ${sheets.length && on === sheets.length ? 'checked' : ''} ${sheets.length ? '' : 'disabled'}
          onclick="event.stopPropagation();poFolderToggle('${f.id}',this.checked)" style="accent-color:var(--amber);flex-shrink:0;">
        <span onclick="poFolderCollapse('${f.id}')" style="cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📁 ${String(f.name).replace(/</g,'&lt;')}</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--muted);flex-shrink:0">${on}/${sheets.length}</span>
        <button onclick="poFolderRename('${f.id}')" title="Rename folder" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:0 2px;">✏️</button>
        <button onclick="poFolderDelete('${f.id}')" title="Delete folder (sheets kept)" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:0;">✕</button>
      </div>
      ${isCollapsed ? '' : `<div style="padding:4px 4px 2px 14px;">${sheets.map(_poSheetRow).join('') || '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);padding:2px 8px 6px;">Empty — use 📁 on a sheet to move it here</div>'}</div>`}
    </div>`;
  }).join('');
  list.innerHTML = `
    <div style="margin-bottom:6px;border:1px solid var(--border2);border-radius:6px;overflow:hidden;">
      <div id="map-po-folder-head" style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--s2);cursor:pointer;">
        <span id="map-po-chev" style="font-size:10px;color:var(--muted2);">${_poCollapsed ? '▸' : '▾'}</span>
        <input type="checkbox" id="map-po-all-cb" ${allVisible ? 'checked' : ''} style="accent-color:var(--amber);width:14px;height:14px;flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--amber2);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📐 Plan Sheets</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--muted);flex-shrink:0">${_poSheets.filter(s => s.visible).length}/${_poSheets.length}</span>
        <button id="map-po-newfold" title="New folder" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;flex-shrink:0;">📁+</button>
      </div>
      <div id="map-po-children" style="padding:4px 6px 4px 16px;${_poCollapsed ? 'display:none;' : ''}">
        <div style="display:flex;align-items:center;gap:8px;padding:4px 8px 8px;font-family:var(--mono);font-size:10px;color:var(--muted);">
          🔅 <input type="range" min="10" max="100" value="${Math.round(_poOpacity * 100)}" style="flex:1;accent-color:var(--amber);" oninput="poSetOpacity(this.value)">
          <span id="map-po-opacity-val" style="width:32px;text-align:right">${Math.round(_poOpacity * 100)}%</span>
        </div>
        ${folderBlocks}
        ${rootSheets.map(_poSheetRow).join('')}
      </div>
    </div>`;
  const head = document.getElementById('map-po-folder-head');
  head.addEventListener('click', function(e){
    if(e.target.type === 'checkbox' || e.target.id === 'map-po-newfold') return;
    const children = document.getElementById('map-po-children');
    const collapsed2 = children.style.display === 'none';
    children.style.display = collapsed2 ? '' : 'none';
    document.getElementById('map-po-chev').textContent = collapsed2 ? '▾' : '▸';
    try{ localStorage.setItem('gl_po_collapsed', collapsed2 ? '0' : '1'); }catch{}
  });
  document.getElementById('map-po-all-cb').addEventListener('click', function(e){
    e.stopPropagation();
    poToggleAll(this.checked);
  });
  document.getElementById('map-po-newfold').addEventListener('click', function(e){
    e.stopPropagation();
    poFolderCreate();
  });
}

window.poLoadSheets = poLoadSheets;
window.poSaveSheets = poSaveSheets;
window.poToggleSheet = poToggleSheet;
window.poToggleAll = poToggleAll;
window.poSetOpacity = poSetOpacity;
window.poReaddVisible = poReaddVisible;
window.poClearAll = poClearAll;
window.poImportFiles = poImportFiles;
window.poDeleteSheet = poDeleteSheet;
window.poNudgeOpen = poNudgeOpen;
window.poNudgeBy = poNudgeBy;
window.poAdjustRotate = poAdjustRotate;
window.poAdjustScale = poAdjustScale;
window.poAdjustReset = poAdjustReset;
window.poNudgeSave = poNudgeSave;
window.poNudgeCancel = poNudgeCancel;
window.poCropOpen = poCropOpen;
window.poCropApply = poCropApply;
window.poCropReset = poCropReset;
window.poCropCancel = poCropCancel;
window.poRenderPanel = poRenderPanel;
window.poFolderCreate = poFolderCreate;
window.poFolderRename = poFolderRename;
window.poFolderDelete = poFolderDelete;
window.poFolderToggle = poFolderToggle;
window.poFolderCollapse = poFolderCollapse;
window.poSheetSetFolder = poSheetSetFolder;
window.poAdjustActive = () => !!_poNudge;   // maps.js long-press suppression
