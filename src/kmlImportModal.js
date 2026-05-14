// ═══════════════════════════════════════════
// KML IMPORT INSPECTION MODAL — B2 Stage 1.5
// ═══════════════════════════════════════════
//
// Lives on top of the KML layer panel as a one-shot inspection step on
// import. Fires immediately on parse success (per memory
// feedback_modal_trigger_immediacy) and shows: filename + feature counts
// (polygons/lines/points) + folder tree with per-folder feature counts
// + bounds-in-view indicator + style coverage + error expander.
//
// Three actions:
//  - [Preview on map (8s timed)]  — mounts all folders temporarily, fits to
//    bounds, auto-unmounts after 8s unless the user hits "Keep visible".
//  - [Toggle folders]             — expands the tree to per-folder checkboxes
//    so the user can pick which to keep before dismiss. Default-OFF state
//    holds until the user toggles ON.
//  - [Done]                       — applies visibility decisions, persists
//    via kmlSaveLayers, dismisses.
//
// After dismiss, normal KML layer panel handles all subsequent toggle /
// delete / bulk-edit interactions.

let _kimRoot = null;
let _kimState = null; // { parsed, layers, storagePath, baseFileName, previewTimer, mountedForPreview, foldersExpanded }

function _kimEnsureRoot(){
  if(_kimRoot) return _kimRoot;
  _kimRoot = document.createElement('div');
  _kimRoot.id = 'kml-import-modal';
  _kimRoot.style.cssText = 'position:fixed;inset:0;z-index:8000;background:rgba(0,0,0,.55);display:none;align-items:flex-end;justify-content:center;padding:0;';
  _kimRoot.innerHTML = `
    <div class="kim-panel" style="background:var(--s1);border-top:1px solid var(--border2);border-radius:14px 14px 0 0;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;padding:0 0 env(safe-area-inset-bottom);box-shadow:0 -8px 24px rgba(0,0,0,.4);">
      <div class="kim-header" style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-family:var(--cond);font-weight:800;font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:var(--amber);">KML Import</div>
          <div id="kim-filename" style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
        </div>
        <button id="kim-close-btn" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:22px;padding:0 6px;line-height:1;">✕</button>
      </div>
      <div class="kim-body" style="padding:14px 18px;">
        <div id="kim-summary" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;"></div>
        <div id="kim-meta" style="font-family:var(--mono);font-size:11px;color:var(--muted2);margin-bottom:12px;line-height:1.55;"></div>
        <div id="kim-errors" style="display:none;background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.35);border-radius:var(--r);padding:10px 12px;margin-bottom:12px;">
          <div id="kim-errors-summary" style="font-family:var(--mono);font-size:12px;color:var(--red);"></div>
          <button id="kim-errors-toggle" style="background:none;border:none;color:var(--amber);cursor:pointer;font-family:var(--mono);font-size:11px;text-decoration:underline;padding:4px 0 0;">Details</button>
          <pre id="kim-errors-detail" style="display:none;font-family:var(--mono);font-size:10px;color:var(--muted2);background:var(--bg);border-radius:5px;padding:8px;margin-top:6px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow-y:auto;"></pre>
        </div>
        <div id="kim-folder-wrap">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="font-family:var(--cond);font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--amber2);">Folders</div>
            <button id="kim-toggle-folders-btn" style="background:none;border:1px solid var(--border2);color:var(--amber);border-radius:5px;cursor:pointer;font-family:var(--mono);font-size:10px;padding:3px 8px;">Show folders</button>
          </div>
          <div id="kim-folder-list" style="display:none;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:8px;max-height:200px;overflow-y:auto;"></div>
        </div>
      </div>
      <div class="kim-actions" style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--border);flex-wrap:wrap;">
        <button id="kim-preview-btn" style="flex:1;min-width:130px;background:var(--s2);border:1px solid var(--border2);color:var(--amber);border-radius:6px;cursor:pointer;font-family:var(--cond);font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:8px 12px;">Preview · 8s</button>
        <button id="kim-keep-btn" style="display:none;flex:1;min-width:130px;background:var(--s2);border:1px solid var(--amber);color:var(--amber);border-radius:6px;cursor:pointer;font-family:var(--cond);font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:8px 12px;">Keep visible</button>
        <button id="kim-done-btn" style="flex:1;min-width:120px;background:var(--amber);border:1px solid var(--amber);color:#000;border-radius:6px;cursor:pointer;font-family:var(--cond);font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:8px 12px;">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(_kimRoot);
  // Click outside the panel = dismiss (same as Done w/ no visibility changes).
  _kimRoot.addEventListener('click', (e) => {
    if(e.target === _kimRoot) _kimDismiss();
  });
  document.getElementById('kim-close-btn').addEventListener('click', _kimDismiss);
  document.getElementById('kim-errors-toggle').addEventListener('click', () => {
    const d = document.getElementById('kim-errors-detail');
    d.style.display = (d.style.display === 'none') ? 'block' : 'none';
  });
  document.getElementById('kim-toggle-folders-btn').addEventListener('click', _kimToggleFolderList);
  document.getElementById('kim-preview-btn').addEventListener('click', _kimDoPreview);
  document.getElementById('kim-keep-btn').addEventListener('click', _kimKeepVisible);
  document.getElementById('kim-done-btn').addEventListener('click', _kimDone);
  return _kimRoot;
}

function _kimStatTile(label, value, color){
  return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:8px 6px;text-align:center;">
    <div style="font-family:var(--cond);font-weight:800;font-size:20px;color:${color};line-height:1;">${value}</div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:3px;">${label}</div>
  </div>`;
}

function _kimRenderFolders(){
  const list = document.getElementById('kim-folder-list');
  if(!list || !_kimState) return;
  const { layers } = _kimState;
  if(!layers || !layers.length){
    list.innerHTML = '<span style="font-family:var(--mono);font-size:11px;color:var(--muted);">No folders found.</span>';
    return;
  }
  list.innerHTML = layers.map(layer => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text);border-radius:4px;">
      <input type="checkbox" data-layer-id="${layer.id}" ${layer.visible ? 'checked' : ''} style="accent-color:var(--amber);">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📁 ${layer.name}</span>
      <span style="color:var(--muted);">${layer.featureCount || (layer.features ? layer.features.length : 0)}</span>
    </label>
  `).join('');
  // Wire checkbox changes to layer.visible state (apply on Done).
  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-layer-id');
      const layer = _kimState.layers.find(l => l.id === id);
      if(layer) layer.visible = e.target.checked;
    });
  });
}

function _kimToggleFolderList(){
  const list = document.getElementById('kim-folder-list');
  const btn = document.getElementById('kim-toggle-folders-btn');
  if(!list || !btn) return;
  const hidden = (list.style.display === 'none');
  if(hidden){
    _kimRenderFolders();
    list.style.display = 'block';
    btn.textContent = 'Hide folders';
  } else {
    list.style.display = 'none';
    btn.textContent = 'Show folders';
  }
}

function _kimBoundsInView(bounds){
  if(!bounds) return 'no geometry';
  if(typeof _mapInstance === 'undefined' || !_mapInstance) return 'map not ready';
  const mb = _mapInstance.getBounds();
  // Loose overlap check on lng/lat ranges.
  const overlapLng = !(bounds.maxLng < mb.getWest() || bounds.minLng > mb.getEast());
  const overlapLat = !(bounds.maxLat < mb.getSouth() || bounds.minLat > mb.getNorth());
  return (overlapLng && overlapLat) ? 'in current view' : 'outside current view — Preview will fit';
}

function _kimDoPreview(){
  if(!_kimState || typeof _mapInstance === 'undefined' || !_mapInstance) return;
  // Mount ALL layers temporarily regardless of visibility checkbox state.
  _kimState.mountedForPreview = [];
  _kimState.layers.forEach(layer => {
    if(layer.features && layer.features.length && !_mapInstance.getSource(layer.id)){
      if(typeof mapReaddKmlLayer === 'function'){
        mapReaddKmlLayer(layer, layer.features);
        _kimState.mountedForPreview.push(layer.id);
      }
    }
  });
  // Fit bounds.
  if(_kimState.parsed && _kimState.parsed.bounds){
    const b = _kimState.parsed.bounds;
    try {
      _mapInstance.fitBounds(
        [[b.minLng, b.minLat], [b.maxLng, b.maxLat]],
        { padding: 60, duration: 800, maxZoom: 16 }
      );
    } catch(e){ /* ignore */ }
  }
  // Swap buttons: hide Preview, show Keep visible. Auto-unmount after 8s.
  document.getElementById('kim-preview-btn').style.display = 'none';
  document.getElementById('kim-keep-btn').style.display = '';
  if(_kimState.previewTimer) clearTimeout(_kimState.previewTimer);
  _kimState.previewTimer = setTimeout(_kimUnmountPreview, 8000);
}

function _kimUnmountPreview(){
  if(!_kimState || !_kimState.mountedForPreview) return;
  _kimState.mountedForPreview.forEach(id => {
    if(_mapInstance && _mapInstance.getSource(id)){
      ['fill','line','pt'].forEach(t => {
        if(_mapInstance.getLayer(id + '-' + t)) _mapInstance.removeLayer(id + '-' + t);
      });
      if(_mapInstance.getSource(id)) _mapInstance.removeSource(id);
    }
  });
  _kimState.mountedForPreview = [];
  if(_kimState.previewTimer){ clearTimeout(_kimState.previewTimer); _kimState.previewTimer = null; }
  const pb = document.getElementById('kim-preview-btn');
  const kb = document.getElementById('kim-keep-btn');
  if(pb) pb.style.display = '';
  if(kb) kb.style.display = 'none';
}

function _kimKeepVisible(){
  // Don't unmount — flip checkbox state to checked for all layers + persist.
  if(!_kimState) return;
  if(_kimState.previewTimer){ clearTimeout(_kimState.previewTimer); _kimState.previewTimer = null; }
  _kimState.layers.forEach(layer => { layer.visible = true; });
  _kimState.mountedForPreview = []; // these stay mounted now
  // Re-render folder list checkboxes if visible.
  const list = document.getElementById('kim-folder-list');
  if(list && list.style.display !== 'none') _kimRenderFolders();
  // Dismiss.
  _kimDone();
}

function _kimDone(){
  if(!_kimState) { _kimDismiss(); return; }
  // Unmount any preview-only layers that weren't "Keep visible'd".
  _kimUnmountPreview();
  // For each layer marked visible, ensure it's actually mounted on the map.
  _kimState.layers.forEach(layer => {
    if(layer.visible && layer.features && layer.features.length && _mapInstance && !_mapInstance.getSource(layer.id)){
      if(typeof mapReaddKmlLayer === 'function') mapReaddKmlLayer(layer, layer.features);
    }
  });
  if(typeof kmlSaveLayers === 'function') kmlSaveLayers();
  if(typeof mapUpdateKmlLayerList === 'function') mapUpdateKmlLayerList();
  _kimDismiss();
}

function _kimDismiss(){
  if(_kimState && _kimState.previewTimer){
    clearTimeout(_kimState.previewTimer);
    _kimState.previewTimer = null;
  }
  // If preview was up and user closed without Done, unmount any preview-only.
  if(_kimState && _kimState.mountedForPreview && _kimState.mountedForPreview.length){
    _kimUnmountPreview();
  }
  if(_kimRoot) _kimRoot.style.display = 'none';
  _kimState = null;
}

// Public entry — called from maps.js mapImportKml after parse + register.
function mapShowKmlImportInspectionModal(parsed, storagePath, baseFileName){
  _kimEnsureRoot();
  // Pick up the _mapKmlLayers entries that mapImportKml just registered for
  // this file. They share the same storagePath.
  const layers = (typeof _mapKmlLayers !== 'undefined' && Array.isArray(_mapKmlLayers))
    ? _mapKmlLayers.filter(l => l.storagePath === storagePath)
    : [];
  _kimState = { parsed, layers, storagePath, baseFileName, previewTimer: null, mountedForPreview: [], foldersExpanded: false };

  document.getElementById('kim-filename').textContent = parsed.sourceFilename || baseFileName;
  // Counts tiles.
  const gc = parsed.geomCounts || { polygons:0, lines:0, points:0, other:0 };
  document.getElementById('kim-summary').innerHTML =
    _kimStatTile('Polygons', gc.polygons, 'var(--amber)') +
    _kimStatTile('Lines', gc.lines, 'var(--text)') +
    _kimStatTile('Points', gc.points, 'var(--muted2)');
  // Meta block.
  const sc = parsed.styleCoverage || { styled:0, total:0 };
  const folderCt = (parsed.folders || []).length;
  const sizeKb = parsed.fileSize ? (parsed.fileSize / 1024).toFixed(1) + ' KB' : '—';
  const boundsLabel = _kimBoundsInView(parsed.bounds);
  document.getElementById('kim-meta').innerHTML =
    `${folderCt} folder${folderCt===1?'':'s'} · ${sc.styled} of ${sc.total} feature${sc.total===1?'':'s'} styled · ${sizeKb}<br>` +
    `<span style="color:var(--amber);">${boundsLabel}</span>`;
  // Errors.
  if(parsed.errors && parsed.errors.length){
    document.getElementById('kim-errors').style.display = 'block';
    document.getElementById('kim-errors-summary').textContent = `⚠️ ${parsed.errors.length} issue${parsed.errors.length===1?'':'s'} during parse — features may be partial`;
    document.getElementById('kim-errors-detail').textContent = parsed.errors.map(e => `[${e.stage||'?'}] ${e.message||JSON.stringify(e)}`).join('\n');
  } else {
    document.getElementById('kim-errors').style.display = 'none';
  }
  // Reset preview button state.
  document.getElementById('kim-preview-btn').style.display = '';
  document.getElementById('kim-keep-btn').style.display = 'none';
  document.getElementById('kim-folder-list').style.display = 'none';
  document.getElementById('kim-toggle-folders-btn').textContent = 'Show folders';

  _kimRoot.style.display = 'flex';
}

// Window exposure — non-module callers (maps.js) reach in via window.
if(typeof window !== 'undefined'){
  window.mapShowKmlImportInspectionModal = mapShowKmlImportInspectionModal;
}
