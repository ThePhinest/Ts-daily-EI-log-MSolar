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

let _poSheets = [];          // [{id,name,file,corners,rmsFt,quality,visible,storagePath,downloadUrl}]
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
  _poNudge = null;
  const box = document.getElementById('map-po-nudge');
  if(box) box.remove();
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

function poSaveSheets(){
  const pid = _poPid();
  const data = _poSheets.map(s => ({
    id: s.id, name: s.name, file: s.file || '',
    corners: _poPackCorners(s.corners), rmsFt: s.rmsFt ?? null, quality: s.quality || 'good',
    visible: !!s.visible, storagePath: s.storagePath || '', downloadUrl: s.downloadUrl || ''
  }));
  try{ if(window.idbSet) window.idbSet(_poStorageKey(), JSON.stringify({ data, opacity: _poOpacity })); }catch{}
  if(window.db && window._fbReady){
    // Personal copy — per-sheet visibility + opacity are view state, never shared.
    const u = (typeof window._projDataUser === 'function') ? window._projDataUser(pid) : null;
    if(u){
      u.collection('planOverlays').doc('sheets')
        .set({ data, opacity: _poOpacity, _ts: Date.now() })
        .catch(e => console.warn('poSaveSheets:', e.message));
    }
    // Shared mirror — sheet list + corners are live reference data for members.
    // Rules let only owner/lead land this write; silent on purpose.
    if(window._currentUser){
      window.db.collection('projects').doc(pid).collection('planOverlays').doc('sheets')
        .set({ data, ownerUid: window._currentUser.uid, _ts: Date.now() })
        .catch(() => {});
    }
  }
}

async function poLoadSheets(){
  const pid = _poPid();
  let data = null, opacity = null;
  if(window.db && window._fbReady){
    try{
      const u = (typeof window._projDataUser === 'function') ? window._projDataUser(pid) : null;
      const doc = u ? await u.collection('planOverlays').doc('sheets').get() : null;
      if(doc && doc.exists){ data = doc.data().data; opacity = doc.data().opacity; }
    }catch(e){ console.warn('poLoadSheets cloud:', e.message); }
    // Shared set is canonical for the sheet LIST + corners; the user's own copy
    // only overlays per-sheet visibility (personal view state).
    try{
      const sdoc = await window.db.collection('projects').doc(pid).collection('planOverlays').doc('sheets').get();
      if(sdoc.exists && Array.isArray(sdoc.data().data) && sdoc.data().data.length){
        const shared = sdoc.data().data;
        const ownById = new Map((data || []).map(s => [s.id, s]));
        data = shared.map(s => ownById.has(s.id) ? { ...s, visible: ownById.get(s.id).visible } : s);
      }
    }catch(e){ /* not a member of a shared project — own copy stands */ }
  }
  if(!data){
    try{
      const raw = window.idbGet && window.idbGet(_poStorageKey());
      if(raw){ const parsed = JSON.parse(raw); data = parsed.data; opacity = parsed.opacity; }
    }catch{}
  }
  if(typeof opacity === 'number' && opacity >= 0.1 && opacity <= 1) _poOpacity = opacity;
  _poSheets = (data || []).map(s => ({ ...s, corners: _poUnpackCorners(s.corners) }));
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
      const src = map && map.getSource('po-' + existing.id);
      if(src && src.setCoordinates) src.setCoordinates(existing.corners);
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
        storagePath, downloadUrl
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
    // Best-effort Storage cleanup — only the owner's rule allows it.
    if(window.storage && sheet.storagePath){ window.storage.ref(sheet.storagePath).delete().catch(() => {}); }
    poSaveSheets();
    poRenderPanel();
  };
}

// ── Nudge (registration correction) ─────────────────────────────────────────
// Shifts all 4 corners N/S/E/W by a foot step — live via ImageSource
// setCoordinates, persisted (shared — a corner fix is a data correction, not
// view state) on Save. Also the rescue path for REVIEW-flagged sheets.

function _poShiftCorners(corners, dxFt, dyFt){
  const latRef = corners[0][1];
  const dLat = (dyFt * 0.3048) / 111320;
  const dLng = (dxFt * 0.3048) / (111320 * Math.cos(latRef * Math.PI / 180));
  return corners.map(([lng, lat]) => [lng + dLng, lat + dLat]);
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
  box.style.cssText = 'position:absolute;bottom:150px;left:50%;transform:translateX(-50%);z-index:40;background:rgba(0,0,0,0.82);border:1px solid var(--border);border-radius:10px;padding:10px 12px;box-shadow:0 4px 20px rgba(0,0,0,.5);';
  const btn = 'background:var(--s1);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:14px;width:34px;height:34px;cursor:pointer;';
  box.innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;color:var(--amber2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;text-align:center">🎯 Nudge — ${String(sheet.name).replace(/</g,'&lt;')}</div>
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="display:grid;grid-template-columns:34px 34px 34px;gap:4px;justify-items:center;">
        <span></span><button style="${btn}" onclick="poNudgeBy(0,1)">↑</button><span></span>
        <button style="${btn}" onclick="poNudgeBy(-1,0)">←</button>
        <select id="map-po-nudge-step" style="background:var(--s1);border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:var(--mono);font-size:10px;width:34px;height:34px;text-align:center;padding:0">
          <option value="1">1ft</option><option value="5" selected>5ft</option><option value="25">25ft</option>
        </select>
        <button style="${btn}" onclick="poNudgeBy(1,0)">→</button>
        <span></span><button style="${btn}" onclick="poNudgeBy(0,-1)">↓</button><span></span>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        <button style="background:var(--amber);border:none;color:#1a1a1a;border-radius:6px;font-family:var(--mono);font-size:11px;font-weight:700;padding:7px 12px;cursor:pointer;" onclick="poNudgeSave()">✓ Save</button>
        <button style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;font-family:var(--mono);font-size:11px;padding:6px 12px;cursor:pointer;" onclick="poNudgeCancel()">Cancel</button>
      </div>
    </div>`;
  const host = document.getElementById('map-container') || document.getElementById('page-map') || document.body;
  host.appendChild(box);
}

function poNudgeBy(ex, ny){
  if(!_poNudge) return;
  const sheet = _poSheets.find(s => s.id === _poNudge.id);
  if(!sheet) return;
  const step = parseFloat(document.getElementById('map-po-nudge-step')?.value || '5');
  sheet.corners = _poShiftCorners(sheet.corners, ex * step, ny * step);
  const map = _poMap();
  const src = map && map.getSource('po-' + sheet.id);
  if(src && src.setCoordinates) src.setCoordinates(sheet.corners);
}

function poNudgeSave(){
  if(!_poNudge) return;
  _poNudge = null;
  document.getElementById('map-po-nudge')?.remove();
  poSaveSheets();
}

function poNudgeCancel(){
  if(!_poNudge) return;
  const sheet = _poSheets.find(s => s.id === _poNudge.id);
  if(sheet){
    sheet.corners = _poNudge.startCorners;
    const map = _poMap();
    const src = map && map.getSource('po-' + sheet.id);
    if(src && src.setCoordinates) src.setCoordinates(sheet.corners);
  }
  _poNudge = null;
  document.getElementById('map-po-nudge')?.remove();
}

// ── Layer panel section ──────────────────────────────────────────────────────

function poRenderPanel(){
  const section = document.getElementById('map-po-section');
  const list = document.getElementById('map-po-list');
  if(!section || !list) return;
  if(!_poSheets.length){ section.style.display = 'none'; return; }
  section.style.display = '';
  try{ _poCollapsed = localStorage.getItem('gl_po_collapsed') === '1'; }catch{}
  const allVisible = _poSheets.every(s => s.visible);
  const rows = _poSheets.map(s => {
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
      <button onclick="poNudgeOpen('${s.id}')" title="Nudge this sheet's position (registration correction)" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;">🎯</button>
      <button onclick="poDeleteSheet('${s.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;">✕</button>
    </div>`;
  }).join('');
  list.innerHTML = `
    <div style="margin-bottom:6px;border:1px solid var(--border2);border-radius:6px;overflow:hidden;">
      <div id="map-po-folder-head" style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--s2);cursor:pointer;">
        <span id="map-po-chev" style="font-size:10px;color:var(--muted2);">${_poCollapsed ? '▸' : '▾'}</span>
        <input type="checkbox" id="map-po-all-cb" ${allVisible ? 'checked' : ''} style="accent-color:var(--amber);width:14px;height:14px;flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--amber2);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📐 Plan Sheets</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--muted);flex-shrink:0">${_poSheets.filter(s => s.visible).length}/${_poSheets.length}</span>
      </div>
      <div id="map-po-children" style="padding:4px 6px 4px 16px;${_poCollapsed ? 'display:none;' : ''}">
        <div style="display:flex;align-items:center;gap:8px;padding:4px 8px 8px;font-family:var(--mono);font-size:10px;color:var(--muted);">
          🔅 <input type="range" min="10" max="100" value="${Math.round(_poOpacity * 100)}" style="flex:1;accent-color:var(--amber);" oninput="poSetOpacity(this.value)">
          <span id="map-po-opacity-val" style="width:32px;text-align:right">${Math.round(_poOpacity * 100)}%</span>
        </div>
        ${rows}
      </div>
    </div>`;
  const head = document.getElementById('map-po-folder-head');
  head.addEventListener('click', function(e){
    if(e.target.type === 'checkbox') return;
    const children = document.getElementById('map-po-children');
    const collapsed = children.style.display === 'none';
    children.style.display = collapsed ? '' : 'none';
    document.getElementById('map-po-chev').textContent = collapsed ? '▾' : '▸';
    try{ localStorage.setItem('gl_po_collapsed', collapsed ? '0' : '1'); }catch{}
  });
  document.getElementById('map-po-all-cb').addEventListener('click', function(e){
    e.stopPropagation();
    poToggleAll(this.checked);
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
window.poNudgeSave = poNudgeSave;
window.poNudgeCancel = poNudgeCancel;
window.poRenderPanel = poRenderPanel;
