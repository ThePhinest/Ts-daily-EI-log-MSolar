// ═══════════════════════════════════════════
// FIELD MAP — MAPBOX
// ═══════════════════════════════════════════
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

let _mapInstance=null, _mapGpsMarker=null, _mapGpsWatch=null;
let _mapCurrentStyle=localStorage.getItem('gl_map_style')||'satellite-streets-v11';

// B2 — Draw / Measure / FAB / GPS state
let _drawInstance=null, _drawMode=null, _drawCategory=null;
let _fabOpen=false, _viewFabOpen=false, _gpsFollowActive=false, _gpsFollowWatch=null;
let _pendingDrawFeature=null;
let _pendingPhotoIds=[];

// Category colors/labels are project-scoped and user-defined.
// All lookups go through tcGetColor() / tcGetName() in trackerCategories.js.
// No hardcoded category data lives here.

// Two-token architecture (locked 2026-05-06 — see [[cost-tracker]] Mapbox row,
// memory feedback_operate_as_if_multi_tenant.md):
//   - Web reads `mapboxToken` (URL-restricted) — defense-in-depth.
//   - iOS native reads `mapboxTokenNative` (unrestricted) — required because
//     Mapbox URL allowlist accepts only http/https schemes and the iOS WebView
//     origin is `capacitor://app.groundlog.io`.
// Single source of truth for token keys to prevent any code path from reading
// the wrong field/storage and clobbering the other platform's token state.
// Phase 4b will replace both reads with server-side per-firm token issuance.
function _mapTokenKeys(){
  const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  return {
    storageKey: isNative ? 'gl_map_token_native' : 'gl_map_token',
    firestoreField: isNative ? 'mapboxTokenNative' : 'mapboxToken'
  };
}

async function mapInit(){
  document.getElementById('map-no-token').style.display='none';
  document.getElementById('map-loading').style.display='flex';
  if(_mapInstance){
    document.getElementById('map-loading').style.display='none';
    setTimeout(()=>{ _mapInstance.resize(); _mapInstance.triggerRepaint(); },150);
    return;
  }
  const {storageKey, firestoreField} = _mapTokenKeys();
  let token=(localStorage.getItem(storageKey)||'').trim();
  if(!token&&db){
    try{
      let waited=0;
      while(!_fbReady&&waited<5000){await new Promise(r=>setTimeout(r,200));waited+=200;}
      const doc=await _udb().collection('settings').doc('projectConfig').get();
      if(doc.exists&&doc.data()[firestoreField]){
        token=doc.data()[firestoreField].trim();
        localStorage.setItem(storageKey,token);
        const style=doc.data().mapStyle||'satellite-streets-v11';
        localStorage.setItem('gl_map_style',style);
      }
    }catch(e){console.warn('mapInit Firestore fetch failed:',e.message);}
  }
  if(!token){
    document.getElementById('map-loading').style.display='none';
    document.getElementById('map-no-token').style.display='flex';
    return;
  }
  if(typeof mapboxgl!=='undefined'){ setTimeout(()=>mapSetup(token),100); return; }
  if(!document.getElementById('mapbox-css')){
    const css=document.createElement('link');
    css.id='mapbox-css'; css.rel='stylesheet';
    css.href='https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css';
    document.head.appendChild(css);
  }
  const script=document.createElement('script');
  script.id='mapbox-js';
  script.src='https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js';
  script.onload=()=>mapSetup(token);
  script.onerror=()=>{
    const el=document.getElementById('map-loading');
    el.innerHTML='<div style="font-family:var(--mono);font-size:12px;color:var(--red);text-align:center;padding:20px">Failed to load map SDK.<br>Check your connection.</div>';
    el.style.display='flex';
  };
  document.head.appendChild(script);
}

function mapSetup(token){
  if(!mapboxgl.supported()){
    const el=document.getElementById('map-loading');
    el.innerHTML='<div style="font-family:var(--mono);font-size:12px;color:var(--red);text-align:center;padding:20px">WebGL is not supported on this device/browser.<br><br>Try opening in Safari directly rather than as a PWA.</div>';
    el.style.display='flex';
    return;
  }
  mapboxgl.accessToken=token;
  _mapCurrentStyle=localStorage.getItem('gl_map_style')||'satellite-streets-v11';
  const center=[
    parseFloat(localStorage.getItem('gl_map_lng')||'-77.755'),
    parseFloat(localStorage.getItem('gl_map_lat')||'42.448')
  ];
  const zoom=parseFloat(localStorage.getItem('gl_map_zoom')||'13');
  _mapInstance=new mapboxgl.Map({
    container:'mapbox-map',
    style:`mapbox://styles/mapbox/${_mapCurrentStyle}`,
    center, zoom,
    attributionControl:false
  });

  // ── β.1 instrumentation — Mapbox + WebGL silent-failure capture ──
  // Mapbox emits its own 'error' event on tile/style/source failures —
  // these don't bubble to window.error, so β.1's global listener misses
  // them. Forward through window._reportError to land in users/{uid}/_debug.
  // Added to diagnose iOS WebView map-tile black-screen carryover from
  // Capacitor Session 3 (desktop renders fine, iOS native shows pins on
  // black). UID-gated downstream by errorReporter; safe on all builds.
  _mapInstance.on('error', function(e) {
    if (typeof window._reportError !== 'function') return;
    const err = e && e.error;
    window._reportError({
      type: 'mapbox-error',
      message: (err && err.message) || (e && e.message) || String(err || 'mapbox error'),
      stack: (err && err.stack) || null,
      mapboxSourceId: (e && e.sourceId) || null,
      mapboxTileState: (e && e.tile && e.tile.state) ? String(e.tile.state) : null,
      mapboxStatus: (err && err.status) || null,
      mapboxUrl: (err && err.url) || null,
      mapStyle: _mapCurrentStyle
    });
  });

  // WebGL context loss without a JS exception — the canvas can lose its
  // GL context (memory pressure, app backgrounding, GPU reset) and the
  // map renders black with no error thrown. Capture explicitly.
  try {
    const _glCanvas = _mapInstance.getCanvas();
    if (_glCanvas) {
      _glCanvas.addEventListener('webglcontextlost', function(ev) {
        if (typeof window._reportError !== 'function') return;
        window._reportError({
          type: 'webgl-context-lost',
          message: 'WebGL context lost on map canvas',
          stack: null,
          preventedDefault: !!ev.defaultPrevented
        });
      }, false);
      _glCanvas.addEventListener('webglcontextrestored', function() {
        if (typeof window._reportError !== 'function') return;
        window._reportError({
          type: 'webgl-context-restored',
          message: 'WebGL context restored on map canvas',
          stack: null
        });
      }, false);
    }
  } catch (_) { /* never let instrumentation break map setup */ }

  _mapInstance.addControl(new mapboxgl.AttributionControl({compact:true}),'bottom-left');
  _mapInstance.addControl(new mapboxgl.NavigationControl({showCompass:true}),'top-right');
  _mapInstance.on('load',()=>{
    document.getElementById('map-loading').style.display='none';
    setTimeout(()=>_mapInstance.resize(),100);
    mapAddGPSDot();
    mapUpdateStyleButtons();
    mapRenderPhotoPins();
    mapRenderFieldMarkers();
    kmlLoadLayers();
    mapRenderTrackerLayers();
// Long press — desktop
let _lpTimer = null, _lpStartPos = null;
_mapInstance.on('mousedown', e => {
  if(e.originalEvent.button !== 0) return;
  const lngLat = e.lngLat;
  _lpTimer = setTimeout(()=>{ mapShowMarkerModal(lngLat); }, 700);
});
_mapInstance.on('mousemove', ()=> clearTimeout(_lpTimer));
_mapInstance.on('mouseup', ()=> clearTimeout(_lpTimer));
_mapInstance.on('dragstart', ()=>{ clearTimeout(_lpTimer); _lpStartPos=null; mapResetGpsFollow(); });
// Long press — touch
_mapInstance.on('touchstart', e => {
  if(e.originalEvent.touches.length !== 1) return;
  const t = e.originalEvent.touches[0];
  _lpStartPos = {x:t.clientX, y:t.clientY};
  const lngLat = e.lngLat;
  _lpTimer = setTimeout(()=>{ mapShowMarkerModal(lngLat); }, 700);
});
_mapInstance.on('touchmove', e => {
  if(!_lpStartPos) return;
  const t = e.originalEvent.touches[0];
  if(Math.abs(t.clientX-_lpStartPos.x)>10 || Math.abs(t.clientY-_lpStartPos.y)>10) clearTimeout(_lpTimer);
});
_mapInstance.on('touchend', ()=>{ clearTimeout(_lpTimer); _lpStartPos=null; });
  });
  _mapInstance.on('moveend',()=>{
    const c=_mapInstance.getCenter();
    localStorage.setItem('gl_map_lat',c.lat);
    localStorage.setItem('gl_map_lng',c.lng);
    localStorage.setItem('gl_map_zoom',_mapInstance.getZoom());
  });
}

function mapAddGPSDot(){
  if(!navigator.geolocation||!_mapInstance) return;
  const el=document.createElement('div');
  el.textContent='🥾';
  el.style.cssText='font-size:28px;cursor:pointer;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));line-height:1';
  el.title='Your location';
  if(_mapGpsWatch) navigator.geolocation.clearWatch(_mapGpsWatch);
  _mapGpsWatch=navigator.geolocation.watchPosition(
    pos=>{
      const {latitude:lat,longitude:lng}=pos.coords;
      if(!_mapGpsMarker){
        _mapGpsMarker=new mapboxgl.Marker({element:el,anchor:'bottom'}).setLngLat([lng,lat]).addTo(_mapInstance);
      } else { _mapGpsMarker.setLngLat([lng,lat]); }
    },
    err=>console.warn('GPS:',err.message),
    {enableHighAccuracy:true,maximumAge:5000}
  );
}

function mapLocateMe(){
  if(!_mapInstance||!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos=>_mapInstance.flyTo({center:[pos.coords.longitude,pos.coords.latitude],zoom:16,duration:1200}),
    err=>console.warn('Locate:',err.message),
    {enableHighAccuracy:true}
  );
}

function mapSetStyle(style){
  if(!_mapInstance) return;
  _mapCurrentStyle=style;
  localStorage.setItem('gl_map_style',style);
  // Reset accessToken before style switch — Mapbox destroys/recreates the map
  // instance and may re-fetch tiles. Use platform-correct token (web vs native).
  mapboxgl.accessToken = localStorage.getItem(_mapTokenKeys().storageKey);
  _mapInstance.setStyle(`mapbox://styles/mapbox/${style}`);
  mapUpdateStyleButtons();
  _mapInstance.once('styledata',()=>{
    if(_mapGpsMarker){_mapGpsMarker.remove();_mapGpsMarker=null;}
    mapAddGPSDot();
    mapRenderFieldMarkers();
    _mapKmlLayers.filter(l=>l.visible).forEach(layer => mapToggleKmlLayerById(layer.id, true));
  });
}

function mapUpdateStyleButtons(){
  const map={'satellite-streets-v11':'map-btn-satellite','streets-v11':'map-btn-streets','outdoors-v11':'map-btn-outdoors'};
  Object.entries(map).forEach(([s,id])=>{
    const btn=document.getElementById(id);
    if(btn) btn.classList.toggle('active',s===_mapCurrentStyle);
  });
}

async function mapSaveSettings(){
  const token=(document.getElementById('cfg-map-token')?.value||'').trim();
  const style=document.getElementById('cfg-map-style')?.value||'satellite-streets-v11';
  // Settings UI saves to platform-correct token slot — editing the token from
  // an iOS device updates `mapboxTokenNative`, from web updates `mapboxToken`.
  // Prevents either platform's settings UI from clobbering the other's token.
  const {storageKey, firestoreField} = _mapTokenKeys();
  if(token) localStorage.setItem(storageKey,token);
  localStorage.setItem('gl_map_style',style);
  if(db&&_fbReady){
    try{
      await _udb().collection('settings').doc('projectConfig').set(
        {[firestoreField]:token, mapStyle:style, _ts:Date.now()},
        {merge:true}
      );
    }catch(e){console.warn('mapSaveSettings cloud failed:',e.message);}
  }
  if(_mapInstance){
    _mapInstance.remove();
    _mapInstance=null;
    _mapGpsMarker=null;
    if(_mapGpsWatch){navigator.geolocation.clearWatch(_mapGpsWatch);_mapGpsWatch=null;}
  }
  // Reset map container HTML so it's clean for next init
  const container=document.getElementById('mapbox-map');
  if(container) container.innerHTML='';
  document.getElementById('map-loading').style.display='flex';
  document.getElementById('map-no-token').style.display='none';
  const s=document.getElementById('cfg-map-status');
  if(s){s.textContent='Saved!';s.style.opacity='1';setTimeout(()=>s.style.opacity='0',2000);}
  setTimeout(()=>mapInit(),200);
}

// ── Photo pins ──
let _mapPhotoMarkers = [];
let _mapFieldMarkers = [];
let _mapFieldMarkersData = [];
let _fieldMarkersVisible = true;
let _hiddenMarkerIds = new Set();
let _mapKmlLayers = [];
let _layerPanelOpen = false;
let _mapPendingMarkerLngLat = null;
let _mapSelectedEmoji = null;
let _mapMarkerScope = 'project';
const _mapEmojiList = [
  {emoji:'🌿', label:'Wetland'},
  {emoji:'💧', label:'Stream / Water Feature'},
  {emoji:'🛣️', label:'Road Crossing'},
  {emoji:'🛑', label:'Compliance Issue'},
  {emoji:'📍', label:'General Observation'},
  {emoji:'⚠️', label:'BMP Concern'},
  {emoji:'🌳', label:'Tree / Vegetation'},
  {emoji:'🔵', label:'Drainage / Outlet'},
  {emoji:'🏗️', label:'Active Work Area'},
  {emoji:'🧱', label:'Erosion Control'}
];
let _mapPinFilter = 'today';

function mapSetPinFilter(filter){
  _mapPinFilter = filter;
  document.getElementById('map-pin-range-inputs').style.display = 'none';
  ['all','today','range','none'].forEach(f => {
    const btn = document.getElementById('map-pin-'+f);
    if(btn) btn.classList.toggle('active', f === filter);
  });
  mapRenderPhotoPins();
}

function mapTogglePinDateRange(){
  _mapPinFilter = 'range';
  ['all','today','range','none'].forEach(f => {
    const btn = document.getElementById('map-pin-'+f);
    if(btn) btn.classList.toggle('active', f === 'range');
  });
  const ri = document.getElementById('map-pin-range-inputs');
  ri.style.display = ri.style.display === 'none' ? 'flex' : 'none';
  mapRenderPhotoPins();
}

function mapRenderPhotoPins(){
  if(!_mapInstance) return;

  // Clear existing markers
  _mapPhotoMarkers.forEach(m => m.remove());
  _mapPhotoMarkers = [];

  if(_mapPinFilter === 'none') return;

  const today = new Date().toLocaleDateString('en-CA');
  const fromDate = document.getElementById('map-pin-from')?.value || '';
  const toDate   = document.getElementById('map-pin-to')?.value || '';

  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
  const photos = (window._phPhotos || []).filter(p => {
    if(!p.lat || !p.lng) return false;
    if(pid && p.projectId !== pid) return false;
    if(_mapPinFilter === 'today') return p.date === today;
    if(_mapPinFilter === 'range'){
      if(fromDate && p.date < fromDate) return false;
      if(toDate && p.date > toDate) return false;
    }
    return true;
  });

  photos.forEach(p => {
    const el = document.createElement('div');
    el.textContent = '📸';
    el.style.cssText = 'font-size:26px;cursor:pointer;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));line-height:1;display:block;width:30px;height:30px;text-align:center;transform-origin:bottom center';
    el.title = p.caption || p.date;

    const dirLabel = p.direction !== undefined ? `${p.direction}° ${phBearingLabel(p.direction)}` : '';
    const cleanCaption = (p.caption||'').replace(/tilt_angle[^/]*\/?\s*roll_angle[^\n]*/i,'').trim();
    const popup = new mapboxgl.Popup({ offset:20, maxWidth:'220px', closeButton:true })
      .setHTML(`
        <div style="font-family:monospace;font-size:11px;color:#111">
          <img src="${p.thumb}" style="width:100%;border-radius:4px;margin-bottom:8px;display:block;cursor:pointer" onclick="phOpenLightbox('${p.id}')">
          ${cleanCaption ? `<div style="font-weight:600;margin-bottom:4px;font-size:12px">${cleanCaption}</div>` : ''}
          <div style="color:#555;margin-bottom:2px">${p.date}</div>
          ${dirLabel ? `<div style="color:#555">📷 Facing ${dirLabel}</div>` : ''}
          ${p.software ? `<div style="color:#999;margin-top:2px;font-size:10px">${p.software}</div>` : ''}
          <div style="margin-top:8px;padding-top:6px;border-top:1px solid #ddd">
            <button onclick="mapShowPhotoLinkPicker('${p.id}')" style="background:none;border:none;color:#006B75;font-family:monospace;font-size:10px;cursor:pointer;padding:0;text-decoration:underline">🔗 Link to tracker entry</button>
          </div>
        </div>
      `);

    el.classList.add('_photo-marker');

    const marker = new mapboxgl.Marker({ element:el, anchor:'bottom' })
      .setLngLat([p.lng, p.lat])
      .setPopup(popup)
      .addTo(_mapInstance);

    _mapPhotoMarkers.push(marker);
  });
}
  
function mapToggleLayerPanel(){
  _layerPanelOpen = !_layerPanelOpen;
  document.getElementById('map-layer-panel').style.transform = _layerPanelOpen ? 'translateX(0%)' : 'translateX(100%)';
  if(_layerPanelOpen) mapUpdateKmlLayerList();
}

function mapShowMarkerModal(lngLat){
  _mapPendingMarkerLngLat = lngLat;
  _mapSelectedEmoji = null;
  _mapMarkerScope = 'project';
  document.getElementById('map-marker-label').value = '';
  document.getElementById('map-marker-modal-err').style.display = 'none';
  document.getElementById('map-marker-scope-project').classList.add('active');
  document.getElementById('map-marker-scope-global').classList.remove('active');
  const list = document.getElementById('map-marker-emoji-list');
  list.innerHTML = '';
  _mapEmojiList.forEach(item => {
    const btn = document.createElement('button');
    btn.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--s1);cursor:pointer;width:100%;text-align:left;font-family:var(--mono);font-size:12px;color:var(--text);box-sizing:border-box;';
    btn.innerHTML = `<span style="font-size:20px">${item.emoji}</span><span>${item.label}</span>`;
    btn.onclick = () => {
      list.querySelectorAll('button').forEach(b => b.style.borderColor = 'var(--border)');
      btn.style.borderColor = '#006B75';
      _mapSelectedEmoji = item.emoji;
      document.getElementById('map-marker-modal-err').style.display = 'none';
    };
    list.appendChild(btn);
  });
  document.getElementById('map-marker-modal').style.display = 'block';
}

function mapMarkerSetScope(scope){
  _mapMarkerScope = scope;
  document.getElementById('map-marker-scope-project').classList.toggle('active', scope === 'project');
  document.getElementById('map-marker-scope-global').classList.toggle('active', scope === 'global');
}

function mapCancelMarker(){
  document.getElementById('map-marker-modal').style.display = 'none';
  _mapPendingMarkerLngLat = null;
  _mapSelectedEmoji = null;
}

async function mapConfirmMarker(){
  if(!_mapSelectedEmoji){
    document.getElementById('map-marker-modal-err').style.display = 'block';
    return;
  }
  const label = document.getElementById('map-marker-label').value.trim();
  const projectName = (JSON.parse(localStorage.getItem('msf_projectconfig'))||{}).projectName || '';
  const markerData = {
    emoji: _mapSelectedEmoji, label, lat: _mapPendingMarkerLngLat.lat,
    lng: _mapPendingMarkerLngLat.lng, scope: _mapMarkerScope,
    projectName, createdAt: Date.now()
  };
  document.getElementById('map-marker-modal').style.display = 'none';
  if(db && _fbReady){
    try { await _udb().collection('fieldMarkers').add(markerData); }
    catch(e){ console.error('Marker save failed:', e); }
  }
  mapRenderFieldMarkers();
}

async function mapRenderFieldMarkers(){
  if(!_mapInstance) return;
  _mapFieldMarkers.forEach(m => m.remove());
  _mapFieldMarkers = [];
  _mapFieldMarkersData = [];
  if(!db || !_fbReady) return;
  const projectName = (JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName) || '';
  try {
    const snap = await _udb().collection('fieldMarkers').get();
    snap.forEach(doc => {
      const m = doc.data();
      if(m.scope !== 'global' && m.projectName !== projectName) return;
      _mapFieldMarkersData.push({...m, id: doc.id});
      const el = document.createElement('div');
      el.textContent = m.emoji;
      el.style.cssText = 'font-size:26px;cursor:pointer;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));line-height:1;width:30px;height:30px;text-align:center;transform-origin:bottom center;';
      el.dataset.markerId = doc.id;
      const popup = new mapboxgl.Popup({ offset:20, maxWidth:'200px', closeButton:true })
        .setHTML(`<div style="font-family:monospace;font-size:11px;color:#111">
          <div style="font-size:22px;margin-bottom:4px">${m.emoji}</div>
          ${m.label ? `<div style="font-weight:600;margin-bottom:4px">${m.label}</div>` : ''}
          <div style="color:#555;margin-bottom:6px">${m.scope==='global'?'🌐 Global':'📌 This Project'}</div>
          <div style="display:flex;gap:6px">
            <button onclick="mapDeleteFieldMarker('${doc.id}')" style="background:#c00;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Delete</button>
            <button onclick="mapHideFieldMarker('${doc.id}')" style="background:#333;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Hide</button>
          </div>
        </div>`);
      const marker = new mapboxgl.Marker({ element:el, anchor:'bottom' })
        .setLngLat([m.lng, m.lat]).setPopup(popup).addTo(_mapInstance);
      if(!_fieldMarkersVisible || _hiddenMarkerIds.has(doc.id)) marker.getElement().style.display='none';
      _mapFieldMarkers.push(marker);
    });
  } catch(e){ console.error('Render field markers failed:', e); }
  mapUpdateFieldMarkerList();
}

function mapHideFieldMarker(id){
  _hiddenMarkerIds.add(id);
  _mapFieldMarkers.forEach(m=>{
    if(m.getElement().dataset.markerId===id) m.getElement().style.display='none';
  });
}

function mapToggleFmList(){
  const wrap=document.getElementById('map-vf-fm-list-wrap');
  const arrow=document.getElementById('map-vf-fm-arrow');
  if(!wrap) return;
  const collapsed=wrap.style.display==='none';
  wrap.style.display=collapsed?'':'none';
  if(arrow) arrow.textContent=collapsed?'▾':'▸';
}

function mapToggleFieldMarkers(){
  _fieldMarkersVisible=!_fieldMarkersVisible;
  if(_fieldMarkersVisible){
    // Show All — clear individual hides too
    _hiddenMarkerIds.clear();
    _mapFieldMarkers.forEach(m=>{ m.getElement().style.display=''; });
  } else {
    _mapFieldMarkers.forEach(m=>{ m.getElement().style.display='none'; });
  }
  const btn=document.getElementById('map-vf-fm-toggle');
  if(btn) btn.textContent=_fieldMarkersVisible?'Hide':'Show';
}

async function mapDeleteFieldMarker(id){
  if(!db || !_fbReady) return;
  try { await _udb().collection('fieldMarkers').doc(id).delete(); }
  catch(e){ console.error('Delete marker failed:', e); }
  mapRenderFieldMarkers();
}

function mapUpdateFieldMarkerList(){
  const list = document.getElementById('map-field-marker-list');
  if(!list) return;
  if(!_mapFieldMarkersData.length){ list.innerHTML = '<span>No markers placed.</span>'; return; }
  list.innerHTML = '';
  _mapFieldMarkersData.forEach(m => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s1);border-radius:6px;margin-bottom:4px;font-family:var(--mono);font-size:11px;color:var(--text);';
    row.innerHTML = `<span style="font-size:16px">${m.emoji}</span><span style="flex:1">${m.label||m.emoji}</span><span style="color:var(--muted)">${m.scope==='global'?'🌐':'📌'}</span>`;
    list.appendChild(row);
  });
}

// B2 Stage 1.4 — refactored to use src/kmlImport.js parser + project-scoped
// Storage paths + default-OFF imported folders + feature-color preservation.
// Existing user-scoped KML files at kml/{uid}/... are orphaned by design —
// Tim re-uploads after B2 ships per locked plan 2026-05-14.
async function mapImportKml(input){
  const file = input.files[0];
  if(!file) return;
  let parsed;
  try {
    parsed = await window.parseKmlOrKmzFile(file);
  } catch(err){
    console.warn('mapImportKml parse failed:', err.message);
    // _reportError already fired inside parseKmlOrKmzFile.
    input.value = '';
    return;
  }
  if(!parsed.features || parsed.features.length === 0){
    input.value = '';
    return;
  }

  // Upload original file to Storage. Scope under the user namespace so the
  // existing Firebase Storage rules (allow read/write on users/{uid}/**) keep
  // working pre-Phase-4.5 multi-tenant. Path still includes projectId so the
  // future migration to firms/{fid}/projects/{pid}/... is a simple find/replace.
  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
  const fileId = 'kml-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
  const storagePath = _currentUser
    ? `kml/${_currentUser.uid}/${fileId}.kml`
    : `projects/${pid}/kml/${fileId}.kml`;
  // For KMZ files, upload the extracted KML text (not the binary archive) so
  // kmlLoadLayers can download and parse it as valid XML on cold-boot. KML files
  // are uploaded as-is.
  const uploadBlob = (parsed.kmlText && /\.kmz$/i.test(file.name))
    ? new Blob([parsed.kmlText], { type: 'text/xml' })
    : file;
  if(storage && _currentUser){
    try {
      await storage.ref(storagePath).put(uploadBlob);
    } catch(err){
      console.warn('KML Storage upload failed:', err.message);
      if(typeof window._reportError === 'function'){
        window._reportError({
          type: 'kml-import-error',
          stage: 'storage-upload',
          filename: file.name,
          projectId: pid,
          error: err.message
        });
      }
    }
  }

  // Group features by FULL folder path (each unique leaf folder = one layer
  // entry). Top-level-only grouping collapsed multi-folder KMLs into a single
  // entry — fixed 2026-05-14. Features with no _folderPath (root-level
  // placemarks) land under the file's base name.
  const baseFileName = parsed.sourceFilename.replace(/\.(kml|kmz)$/i, '');
  const byFolder = new Map();
  parsed.features.forEach(f => {
    const props = f.properties || {};
    const folderPath = props._folderPath || '';
    const groupKey = folderPath || baseFileName;
    if(!byFolder.has(groupKey)) byFolder.set(groupKey, []);
    byFolder.get(groupKey).push(f);
  });

  // Register each leaf folder as one layer. Use the leaf folder name (last
  // segment of the path) as the displayed name; carry the parent path as
  // folderName so the layer panel can group nested KMLs under their parent.
  const newLayers = [];
  byFolder.forEach((features, fullPath) => {
    const segments = fullPath.split(' / ');
    const leafName = segments[segments.length - 1] || baseFileName;
    const parentPath = segments.slice(0, -1).join(' / ');
    const id = 'kml-' + Date.now() + '-' + Math.random().toString(36).slice(2,6) + '-' + newLayers.length;
    const entry = {
      id,
      name: leafName,
      folderName: parentPath,   // empty for single-level KMLs; populated for nested
      visible: false,           // default-OFF per spec
      storagePath,
      features,                 // keep in memory so toggle ON is instant
      featureCount: features.length
    };
    _mapKmlLayers.push(entry);
    newLayers.push(entry);
  });

  kmlSaveLayers();
  mapUpdateKmlLayerList();
  // Stage 1.5 modal — pass the new layers explicitly so the modal doesn't
  // have to reach into _mapKmlLayers via window (module-local in Vite bundle).
  if(typeof window.mapShowKmlImportInspectionModal === 'function'){
    window.mapShowKmlImportInspectionModal(parsed, storagePath, baseFileName, newLayers);
  }
  input.value = '';
}

// B2 Stage 1.4 — feature-color preservation. togeojson emits 'fill' /
// 'stroke' / 'fill-opacity' / 'stroke-width' as simplestyle-spec props on
// each feature where the KML defined a <Style>. We read them via Mapbox
// data-driven expressions ['get','fill'] with the palette fallback when
// the prop is missing. _paletteIdx is also stamped on each feature by
// kmlImport.js so unstyled features still pick from the 11-color rotation
// (vs the previous all-gold).
function mapReaddKmlLayer(layer, features){
  if(!_mapInstance || !features || !features.length) return;
  if(_mapInstance.getSource(layer.id)) return;
  // Stamp resolved fill/stroke onto each feature BEFORE addSource — Mapbox
  // expressions can't index a JS array (palette) at render time, so we
  // pre-resolve the color via data-expressions ['coalesce',['get','_fillResolved']].
  const palette = (typeof window !== 'undefined' && window.KML_PALETTE) ? window.KML_PALETTE : ['#C9A84C'];
  features.forEach(f => {
    f.properties = f.properties || {};
    if(typeof f.properties.fill !== 'string'){
      const idx = (typeof f.properties._paletteIdx === 'number') ? f.properties._paletteIdx : 0;
      f.properties._fillResolved = palette[idx % palette.length];
    } else {
      f.properties._fillResolved = f.properties.fill;
    }
    if(typeof f.properties.stroke !== 'string'){
      f.properties._strokeResolved = f.properties._fillResolved;
    } else {
      f.properties._strokeResolved = f.properties.stroke;
    }
  });
  _mapInstance.addSource(layer.id, { type: 'geojson', data: { type: 'FeatureCollection', features } });
  _mapInstance.addLayer({
    id: layer.id + '-fill',
    type: 'fill',
    source: layer.id,
    paint: {
      'fill-color': ['coalesce', ['get','_fillResolved'], '#C9A84C'],
      'fill-opacity': ['coalesce', ['get','fill-opacity'], 0.18]
    },
    filter: ['==', ['geometry-type'], 'Polygon']
  });
  _mapInstance.addLayer({
    id: layer.id + '-line',
    type: 'line',
    source: layer.id,
    paint: {
      'line-color': ['coalesce', ['get','_strokeResolved'], '#C9A84C'],
      'line-width': ['coalesce', ['get','stroke-width'], 2]
    },
    filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']]
  });
  _mapInstance.addLayer({
    id: layer.id + '-pt',
    type: 'circle',
    source: layer.id,
    paint: {
      'circle-color': ['coalesce', ['get','_fillResolved'], '#C9A84C'],
      'circle-radius': 6,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': ['coalesce', ['get','_strokeResolved'], '#FFFFFF']
    },
    filter: ['==', ['geometry-type'], 'Point']
  });
}

// B2 Stage 1.4 — project-scoped layer metadata storage. Features stay in
// memory; only id/name/visibility/storagePath is persisted (re-fetch + re-parse
// from Storage on cold boot via kmlLoadLayers).
function _kmlStorageKey(){
  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
  return 'msf_proj_' + pid + '_kml_layers';
}
function kmlSaveLayers(){
  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
  const data = _mapKmlLayers.map(l => ({
    id: l.id, name: l.name, folderName: l.folderName || '',
    visible: l.visible, storagePath: l.storagePath || ''
  }));
  try { localStorage.setItem(_kmlStorageKey(), JSON.stringify(data)); } catch {}
  if(db && _fbReady){
    _udb().collection('projects').doc(pid).collection('kml').doc('layers')
      .set({ data, _ts: Date.now() })
      .catch(e => console.warn('kmlSaveLayers:', e.message));
  }
}
  
function kmlParseLayerById(kmlText, layerName){
  const kml = new DOMParser().parseFromString(kmlText, 'text/xml');
  function getName(node){
    return node.querySelector('name')?.textContent?.trim() ||
           node.querySelector('n')?.textContent?.trim() || '';
  }
  // Find the matching Document or Folder by name
  const all = [...kml.querySelectorAll('Document'), ...kml.querySelectorAll('Folder')];
  const node = all.find(n=>getName(n)===layerName) || kml;
  const features = [];
  node.querySelectorAll('Placemark').forEach(pm=>{
    const name = getName(pm);
    const poly = pm.querySelector('Polygon outerBoundaryIs coordinates') || pm.querySelector('Polygon coordinates');
    const line = pm.querySelector('LineString coordinates');
    const pt   = pm.querySelector('Point coordinates');
    if(poly){
      const c = poly.textContent.trim().split(/\s+/).map(s=>s.split(',').map(Number).slice(0,2));
      features.push({type:'Feature',properties:{name},geometry:{type:'Polygon',coordinates:[c]}});
    } else if(line){
      const c = line.textContent.trim().split(/\s+/).map(s=>s.split(',').map(Number).slice(0,2));
      features.push({type:'Feature',properties:{name},geometry:{type:'LineString',coordinates:c}});
    } else if(pt){
      const [lng,lat] = pt.textContent.trim().split(',').map(Number);
      features.push({type:'Feature',properties:{name},geometry:{type:'Point',coordinates:[lng,lat]}});
    }
  });
  return features;
}

// ═══════════════════════════════════════════
// KML EDIT MODE — bulk select + delete
// ═══════════════════════════════════════════
// Edit mode repurposes the visibility checkboxes as selection checkboxes
// while preserving each layer's actual visibility state in memory. Toggling
// edit mode flips the panel into a selection UI; the existing per-row delete
// buttons hide, replaced by a bulk-delete button driven by `_mapKmlSelected`.
// Selection state is transient — cleared on enter/exit/successful delete.
// Two-tap arm-and-confirm on the delete action — first tap arms the button
// for 5s; second tap within that window executes; otherwise auto-disarms.
// Changing selection mid-confirm disarms (prevents accidental wrong-set
// deletes). Single-row delete (`mapRemoveKmlLayerById`) and visibility toggle
// (`mapToggleKmlLayerById`) paths are untouched; bulk delete is purely
// additive logic running alongside them.
let _mapKmlEditMode = false;
let _mapKmlSelected = new Set();
let _mapKmlDeleteArmed = false;
let _mapKmlDeleteArmedTimer = null;

function _mapKmlClearArm(){
  _mapKmlDeleteArmed = false;
  if(_mapKmlDeleteArmedTimer){ clearTimeout(_mapKmlDeleteArmedTimer); _mapKmlDeleteArmedTimer = null; }
}

function mapToggleKmlEditMode(){
  _mapKmlEditMode = !_mapKmlEditMode;
  _mapKmlSelected.clear();
  _mapKmlClearArm();
  mapUpdateKmlLayerList();
}

function mapKmlToggleSelection(id){
  if(_mapKmlSelected.has(id)) _mapKmlSelected.delete(id);
  else _mapKmlSelected.add(id);
  _mapKmlClearArm();
  mapUpdateKmlEditUI();
}

function mapKmlFolderToggleSelection(folderName){
  const layers = _mapKmlLayers.filter(l => l.folderName === folderName);
  const allSelected = layers.length > 0 && layers.every(l => _mapKmlSelected.has(l.id));
  if(allSelected) layers.forEach(l => _mapKmlSelected.delete(l.id));
  else layers.forEach(l => _mapKmlSelected.add(l.id));
  _mapKmlClearArm();
  mapUpdateKmlLayerList();
}

function mapKmlToggleSelectAll(){
  const allSelected = _mapKmlLayers.length > 0 && _mapKmlLayers.every(l => _mapKmlSelected.has(l.id));
  _mapKmlSelected.clear();
  if(!allSelected) _mapKmlLayers.forEach(l => _mapKmlSelected.add(l.id));
  _mapKmlClearArm();
  mapUpdateKmlLayerList();
}

function mapUpdateKmlEditUI(){
  const editBtn = document.getElementById('map-kml-edit-btn');
  const delBtn = document.getElementById('map-kml-bulk-delete-btn');
  const helper = document.getElementById('map-kml-edit-helper');
  if(!editBtn || !delBtn || !helper) return;
  if(_mapKmlEditMode){
    editBtn.innerHTML = '✕ Cancel';
    editBtn.style.display = '';
    helper.style.display = _mapKmlLayers.length > 0 ? '' : 'none';
    if(_mapKmlSelected.size > 0){
      delBtn.style.display = '';
      if(_mapKmlDeleteArmed){
        delBtn.style.background = '#5a0000';
        delBtn.style.borderColor = '#ff4444';
        delBtn.style.color = '#ffffff';
        delBtn.innerHTML = `🗑 CONFIRM (${_mapKmlSelected.size})`;
      } else {
        delBtn.style.background = '#3d1414';
        delBtn.style.borderColor = '#6b2020';
        delBtn.style.color = '#ff8080';
        delBtn.innerHTML = `🗑 Delete (<span id="map-kml-bulk-delete-count">${_mapKmlSelected.size}</span>)`;
      }
    } else {
      delBtn.style.display = 'none';
    }
  } else {
    editBtn.innerHTML = '✏️ Edit';
    editBtn.style.display = _mapKmlLayers.length > 0 ? '' : 'none';
    delBtn.style.display = 'none';
    helper.style.display = 'none';
  }
}

async function mapBulkDeleteSelected(){
  if(_mapKmlSelected.size === 0) return;
  // Two-tap arm/confirm — first tap arms (5s window), second executes
  if(!_mapKmlDeleteArmed){
    _mapKmlDeleteArmed = true;
    if(_mapKmlDeleteArmedTimer) clearTimeout(_mapKmlDeleteArmedTimer);
    _mapKmlDeleteArmedTimer = setTimeout(()=>{
      _mapKmlDeleteArmed = false;
      _mapKmlDeleteArmedTimer = null;
      mapUpdateKmlEditUI();
    }, 5000);
    mapUpdateKmlEditUI();
    return;
  }
  // Confirmed — execute
  _mapKmlClearArm();
  const ids = new Set(_mapKmlSelected);
  // Tear down map state for all selected
  for(const layer of _mapKmlLayers.filter(l => ids.has(l.id))){
    ['fill','line','pt'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
    if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  }
  // Remove from registry (back-to-front to preserve indices during splice)
  for(let i=_mapKmlLayers.length-1;i>=0;i--){
    if(ids.has(_mapKmlLayers[i].id)) _mapKmlLayers.splice(i,1);
  }
  kmlSaveLayers();
  // Exit edit mode + re-render
  _mapKmlEditMode = false;
  _mapKmlSelected.clear();
  mapUpdateKmlLayerList();
}

async function kmlLoadLayers(){
  let data = null;
  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
  if(db && _fbReady){
    try {
      const doc = await _udb().collection('projects').doc(pid).collection('kml').doc('layers').get();
      if(doc.exists) data = doc.data().data;
    } catch(e){ console.warn('kmlLoadLayers cloud:', e.message); }
  }
  if(!data){ try { const raw = localStorage.getItem(_kmlStorageKey()); if(raw) data = JSON.parse(raw); } catch {} }
  if(!data || !data.length) return;

  // Group by storagePath — fetch each KML file once, render visible layers only
  const byPath = {};
  data.forEach(layer=>{ if(!byPath[layer.storagePath]) byPath[layer.storagePath]=[]; byPath[layer.storagePath].push(layer); });

  for(const [storagePath, layers] of Object.entries(byPath)){
    const visibleLayers = layers.filter(l=>l.visible);
    if(!visibleLayers.length){
      // Register all as not visible — no fetch needed
      layers.forEach(layer=>{ if(!_mapKmlLayers.find(l=>l.id===layer.id)) _mapKmlLayers.push({...layer}); });
      continue;
    }

    // Fetch KML once for this file
    let kmlText = null;
    if(storage){
      try{
        const url = await storage.ref(storagePath).getDownloadURL();
        const res = await fetch(url);
        if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText||''));
        kmlText = await res.text();
      }catch(err){
        console.warn('kmlLoadLayers fetch failed:', err.message);
        // Forward to β.1 — initial KML load on map open. If this silently
        // fails on iOS native, layers will appear in the panel but won't
        // render on the map. Same iOS-WebView CORS hypothesis as toggle path.
        if(typeof window._reportError === 'function'){
          window._reportError({
            type: 'kml-load-failed',
            message: 'kmlLoadLayers fetch failed: ' + (err && err.message ? err.message : String(err)),
            stack: err && err.stack ? err.stack : null,
            kmlStoragePath: storagePath
          });
        }
      }
    }

    // Re-parse KML through full togeojson pipeline to restore style info
    // (fill/stroke/palette colors). kmlParseLayerById is a fallback that
    // strips styles — we only use it if the togeojson path fails.
    let folderFeatures = null;
    if(kmlText && typeof window.parseKmlOrKmzFile === 'function'){
      try{
        const kmlFile = new File([kmlText], 'restore.kml', { type: 'text/xml' });
        const reparsed = await window.parseKmlOrKmzFile(kmlFile);
        folderFeatures = new Map();
        reparsed.features.forEach(f => {
          const props = f.properties || {};
          const folderPath = props._folderPath || '';
          const segments = folderPath.split(' / ');
          const leafName = segments[segments.length - 1] || folderPath;
          if(!folderFeatures.has(leafName)) folderFeatures.set(leafName, []);
          folderFeatures.get(leafName).push(f);
        });
      }catch(e){
        console.warn('kmlLoadLayers reparse failed, falling back:', e.message);
      }
    }

    // Register all layers, cache features for ALL (not just visible) so future
    // toggles skip Storage fetch + re-parse. Flat KMLs store root-level features
    // under '' in folderFeatures but layer.name is the base filename — fall back
    // to '' before using all features as last resort.
    layers.forEach(layer=>{
      if(_mapKmlLayers.find(l=>l.id===layer.id)) return;
      const layerObj = { ...layer };
      _mapKmlLayers.push(layerObj);
      if(kmlText){
        let features;
        if(folderFeatures){
          features = folderFeatures.get(layer.name) || [];
          if(!features.length) features = folderFeatures.get('') || [];
        } else {
          features = kmlParseLayerById(kmlText, layer.name);
        }
        if(features.length){
          layerObj.features = features;
          if(layer.visible) mapReaddKmlLayer(layerObj, features);
        }
      }
    });
  }
  mapUpdateKmlLayerList();
}

function mapUpdateKmlLayerList(){
  const list = document.getElementById('map-kml-layer-list');
  if(!list) return;
  // Empty state — also reset edit mode in case the last layer was just deleted
  if(!_mapKmlLayers.length){
    _mapKmlEditMode = false;
    _mapKmlSelected.clear();
    _mapKmlClearArm();
    list.innerHTML = '<span>No layers imported.</span>';
    mapUpdateKmlEditUI();
    return;
  }
  list.innerHTML = '';
  // makeLayerRow branches by mode: normal = visibility checkbox + per-row ✕ delete;
  // edit = selection checkbox + red accent + selection-tinted background; no ✕.
  function makeLayerRow(layer){
    const selected = _mapKmlSelected.has(layer.id);
    const row = document.createElement('div');
    if(_mapKmlEditMode && selected){
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2a1414;border:1px solid #6b2020;border-radius:6px;margin-bottom:4px;';
    } else {
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s1);border-radius:6px;margin-bottom:4px;';
    }
    if(_mapKmlEditMode){
      row.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text);flex:1;min-width:0;">
        <input type="checkbox" ${selected?'checked':''} style="accent-color:#ff4444;" onchange="mapKmlToggleSelection('${layer.id}')">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${layer.name}</span>
      </label>`;
    } else {
      row.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text);flex:1;min-width:0;">
        <input type="checkbox" ${layer.visible?'checked':''} onchange="mapToggleKmlLayerById('${layer.id}',this.checked)">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${layer.name}</span>
      </label>
      <button onclick="mapRemoveKmlLayerById('${layer.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;">✕</button>`;
    }
    return row;
  }
  const folders = {};
  const noFolder = [];
  _mapKmlLayers.forEach(layer=>{
    if(layer.folderName){ if(!folders[layer.folderName]) folders[layer.folderName]=[]; folders[layer.folderName].push(layer); }
    else noFolder.push(layer);
  });
  Object.entries(folders).forEach(([folderName, layers])=>{
    const folderId = 'kml-folder-'+folderName.replace(/[^a-z0-9]/gi,'_');
    const folderWrap = document.createElement('div');
    folderWrap.style.cssText = 'margin-bottom:6px;border:1px solid var(--border2);border-radius:6px;overflow:hidden;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--s2);cursor:pointer;';
    // Folder-level checkbox: visibility tristate in normal mode,
    // selection tristate in edit mode (red accent).
    let cbChecked, cbAccent;
    if(_mapKmlEditMode){
      const allSelected = layers.every(l => _mapKmlSelected.has(l.id));
      cbChecked = allSelected ? 'checked' : '';
      cbAccent = '#ff4444';
    } else {
      const allVisible = layers.every(l=>l.visible);
      cbChecked = allVisible ? 'checked' : '';
      cbAccent = 'var(--amber)';
    }
    header.innerHTML = `
      <span id="${folderId}-chev" style="font-size:10px;color:var(--muted2);">▾</span>
      <input type="checkbox" ${cbChecked}
        style="accent-color:${cbAccent};width:14px;height:14px;flex-shrink:0;"
        id="${folderId}-cb">
      <span style="font-family:var(--mono);font-size:11px;color:var(--amber2);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📁 ${folderName}</span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);">${layers.length}</span>`;
    const children = document.createElement('div');
    children.id = folderId+'-children';
    children.style.cssText = 'padding:4px 6px 4px 16px;';
    layers.forEach(layer => children.appendChild(makeLayerRow(layer)));
    // Collapse toggle
    header.addEventListener('click', function(e){
      if(e.target.type==='checkbox') return;
      const collapsed = children.style.display==='none';
      children.style.display = collapsed ? '' : 'none';
      document.getElementById(folderId+'-chev').textContent = collapsed ? '▾' : '▸';
    });
    // Folder-level checkbox — branches by mode
    header.querySelector(`#${folderId}-cb`).addEventListener('click', function(e){
      e.stopPropagation();
      if(_mapKmlEditMode){
        mapKmlFolderToggleSelection(folderName);
      } else {
        kmlToggleFolderVisibility(folderName, this.checked);
      }
    });
    folderWrap.appendChild(header);
    folderWrap.appendChild(children);
    list.appendChild(folderWrap);
  });
  noFolder.forEach(layer => list.appendChild(makeLayerRow(layer)));
  mapUpdateKmlEditUI();

  // ── Tracker Drawings ─────────────────────────────────────────────────────
  // Append tracker categories as folders using the same visual pattern as KML.
  // Each category = folder header; each non-deleted entry = layer row with
  // visibility checkbox, edit button, and delete button.
  const _trPid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const _trCats=(typeof tcGetCategories==='function')?tcGetCategories(_trPid):[];
  const _trAllEntries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(_trPid).filter(e=>!e.archivedFromMap):[];
  if(_trCats.length>0 && _trAllEntries.length>0){
    const sep=document.createElement('div');
    sep.style.cssText='margin:10px 0 6px;border-top:1px solid var(--border);padding-top:8px;font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;';
    sep.textContent='Tracker Drawings';
    list.appendChild(sep);
    _trCats.forEach(cat=>{
      const catEntries=_trAllEntries.filter(e=>e.categoryId===cat.id);
      if(!catEntries.length) return;
      const fid='tr-folder-'+cat.id.replace(/[^a-z0-9]/gi,'_');
      const allVisible=catEntries.every(e=>!e.deletedFromMap);
      const folderWrap=document.createElement('div');
      folderWrap.style.cssText='margin-bottom:6px;border:1px solid var(--border2);border-radius:6px;overflow:hidden;';
      const hdr=document.createElement('div');
      hdr.style.cssText='display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--s2);cursor:pointer;';
      hdr.innerHTML=`
        <span id="${fid}-chev" style="font-size:10px;color:var(--muted2);">▾</span>
        <input type="checkbox" ${allVisible?'checked':''} style="accent-color:${cat.color||'#888'};width:14px;height:14px;flex-shrink:0;" id="${fid}-cb">
        <div style="width:10px;height:10px;border-radius:50%;background:${cat.color||'#888'};flex-shrink:0;"></div>
        <span style="font-family:var(--mono);font-size:11px;color:var(--text);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cat.name}</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--muted);">${catEntries.length}</span>`;
      const kids=document.createElement('div');
      kids.id=fid+'-children';
      kids.style.cssText='padding:4px 6px 4px 16px;';
      catEntries.forEach(e=>{
        const visible=!e.deletedFromMap;
        const row=document.createElement('div');
        row.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s1);border-radius:6px;margin-bottom:4px;';
        const parts=[];
        if(e.date){const p=e.date.split('-');parts.push(`${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`);}
        if(e.acres) parts.push(`${e.acres} ac`);
        else if(e.location) parts.push(e.location);
        const label=parts.join(' · ')||e.id.slice(0,8);
        row.innerHTML=`
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:11px;color:${visible?'var(--text)':'var(--muted)'};flex:1;min-width:0;">
            <input type="checkbox" ${visible?'checked':''} onchange="mapToggleTrackerEntryVisibility('${e.id}',this.checked)">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>
          </label>
          <button onclick="mapEditTrackerEntry('${e.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:0 4px;" title="Edit">✏</button>
          <button onclick="mapDeleteTrackerEntryFromPanel('${e.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;" title="Delete">✕</button>`;
        kids.appendChild(row);
      });
      hdr.addEventListener('click',function(ev){
        if(ev.target.type==='checkbox') return;
        const collapsed=kids.style.display==='none';
        kids.style.display=collapsed?'':'none';
        const chev=document.getElementById(fid+'-chev');
        if(chev) chev.textContent=collapsed?'▾':'▸';
      });
      hdr.querySelector(`#${fid}-cb`).addEventListener('click',function(ev){
        ev.stopPropagation();
        mapToggleTrackerCategoryVisibility(cat.id,this.checked);
      });
      folderWrap.appendChild(hdr);
      folderWrap.appendChild(kids);
      list.appendChild(folderWrap);
    });
  }
}
// Reparse a KML text through parseKmlOrKmzFile (preserves fill/stroke + _paletteIdx).
// Falls back to kmlParseLayerById only when the full parser is unavailable.
// Handles flat KMLs where root features land under '' but layer.name is the base filename.
async function _kmlReparseFeaturesForLayer(kmlText, layer){
  if(typeof window.parseKmlOrKmzFile !== 'function')
    return kmlParseLayerById(kmlText, layer.name);
  try{
    const kmlFile = new File([kmlText], 'restore.kml', {type:'text/xml'});
    const reparsed = await window.parseKmlOrKmzFile(kmlFile);
    const folderMap = new Map();
    reparsed.features.forEach(f => {
      const fp = (f.properties||{})._folderPath||'';
      const segs = fp.split(' / ');
      const leafName = segs[segs.length-1]||'';
      if(!folderMap.has(leafName)) folderMap.set(leafName,[]);
      folderMap.get(leafName).push(f);
    });
    let features = folderMap.get(layer.name)||[];
    if(!features.length) features = folderMap.get('')||[];
    if(!features.length) features = reparsed.features;
    return features;
  }catch(e){
    console.warn('_kmlReparseFeaturesForLayer fell back:', e.message);
    return kmlParseLayerById(kmlText, layer.name);
  }
}

async function kmlToggleFolderVisibility(folderName, visible){
  const layers = _mapKmlLayers.filter(l=>l.folderName===folderName);
  for(const layer of layers){
    layer.visible = visible;
    if(!visible){
      ['fill','line','pt'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
      if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
    } else {
      if(!_mapInstance.getSource(layer.id)){
        if(layer.features && layer.features.length){
          mapReaddKmlLayer(layer, layer.features);
        } else if(layer.storagePath && storage){
          try{
            const url = await storage.ref(layer.storagePath).getDownloadURL();
            const res = await fetch(url);
            const kmlText = await res.text();
            const features = await _kmlReparseFeaturesForLayer(kmlText, layer);
            layer.features = features;
            mapReaddKmlLayer(layer, features);
          }catch(err){ console.warn('kmlToggleFolderVisibility:', err.message); }
        }
      }
    }
  }
  kmlSaveLayers();
  mapUpdateKmlLayerList();
}

async function mapToggleKmlLayer(i, visible){
  const layer = _mapKmlLayers[i];
  layer.visible = visible;

  if(!visible){
    // Remove from map entirely — free memory
    ['fill','line'].forEach(t=>{
      if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t);
    });
    if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  } else {
    // Fetch and render on demand if not already on map
    if(!_mapInstance.getSource(layer.id)){
      if(layer.features && layer.features.length){
        mapReaddKmlLayer(layer, layer.features);
      } else if(layer.storagePath && storage){
        try{
          const url = await storage.ref(layer.storagePath).getDownloadURL();
          const res = await fetch(url);
          const kmlText = await res.text();
          const features = await _kmlReparseFeaturesForLayer(kmlText, layer);
          layer.features = features;
          mapReaddKmlLayer(layer, features);
        }catch(err){ console.warn('mapToggleKmlLayer fetch failed:', err.message); }
      }
    } else {
      ['fill','line'].forEach(t=>{
        if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.setLayoutProperty(layer.id+'-'+t,'visibility','visible');
      });
    }
  }
  kmlSaveLayers();
}

function mapRemoveKmlLayer(i){
  const layer = _mapKmlLayers[i];
  ['fill','line','pt'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
  if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  _mapKmlLayers.splice(i,1);
  kmlSaveLayers();
  mapUpdateKmlLayerList();
}
function mapRemoveKmlLayerById(id){
  const idx = _mapKmlLayers.findIndex(l=>l.id===id);
  if(idx===-1) return;
  const layer = _mapKmlLayers[idx];
  ['fill','line','pt'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
  if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  _mapKmlLayers.splice(idx,1);
  kmlSaveLayers();
  mapUpdateKmlLayerList();
}
async function mapToggleKmlLayerById(id, visible){
  const layer = _mapKmlLayers.find(l=>l.id===id);
  if(!layer) return;
  layer.visible = visible;
  if(!visible){
    ['fill','line','pt'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
    if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  } else {
    if(!_mapInstance.getSource(layer.id)){
      if(layer.features && layer.features.length){
        mapReaddKmlLayer(layer, layer.features);
      } else if(layer.storagePath && storage){
        try{
          const url = await storage.ref(layer.storagePath).getDownloadURL();
          const res = await fetch(url);
          if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText||''));
          const kmlText = await res.text();
          const features = await _kmlReparseFeaturesForLayer(kmlText, layer);
          layer.features = features;
          mapReaddKmlLayer(layer, features);
        }catch(err){
          console.warn('mapToggleKmlLayerById:', err.message);
          if(typeof window._reportError === 'function'){
            window._reportError({
              type: 'kml-toggle-failed',
              message: 'KML toggle ON failed: ' + (err && err.message ? err.message : String(err)),
              stack: err && err.stack ? err.stack : null,
              kmlLayerId: layer.id,
              kmlLayerName: layer.name,
              kmlStoragePath: layer.storagePath
            });
          }
        }
      }
    }
  }
  kmlSaveLayers();
}

// B2 Stage 1.4 — called from projects.js loadProject() on project switch.
// Tears down all KML sources/layers + clears in-memory state, then triggers
// kmlLoadLayers() to rehydrate from the new project's per-project cache.
function mapClearKmlLayers(){
  if(_mapInstance){
    _mapKmlLayers.forEach(layer => {
      ['fill','line','pt'].forEach(t => {
        if(_mapInstance.getLayer(layer.id + '-' + t)) _mapInstance.removeLayer(layer.id + '-' + t);
      });
      if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
    });
  }
  _mapKmlLayers.length = 0;
  if(typeof _mapKmlEditMode !== 'undefined') _mapKmlEditMode = false;
  if(typeof _mapKmlSelected !== 'undefined' && _mapKmlSelected.clear) _mapKmlSelected.clear();
  mapUpdateKmlLayerList();
}

function mapShowExportModal(){
  document.getElementById('map-export-modal').style.display='block';
}

function mapExportKml(){
  const incPhotos = document.getElementById('exp-photo-pins').checked;
  const incMarkers = document.getElementById('exp-field-markers').checked;
  const incKml = document.getElementById('exp-kml-layers').checked;
  const projectName = (JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName) || 'Project';
  const date = new Date().toLocaleDateString('en-CA');
  let placemarks = '';
  if(incPhotos){
    (window._phPhotos||[]).filter(p=>p.lat&&p.lng).forEach(p=>{
      placemarks += `  <Placemark><name>${(p.caption||p.date||'Photo').replace(/&/g,'&amp;')}</name><Point><coordinates>${p.lng},${p.lat},0</coordinates></Point></Placemark>\n`;
    });
  }
  if(incMarkers){
    _mapFieldMarkersData.forEach(m=>{
      const name = (m.label||m.emoji).replace(/&/g,'&amp;');
      placemarks += `  <Placemark><name>${m.emoji} ${name}</name><Point><coordinates>${m.lng},${m.lat},0</coordinates></Point></Placemark>\n`;
    });
  }
  if(incKml){
    _mapKmlLayers.forEach(layer=>{
      layer.features.forEach(f=>{
        const name = (f.properties.name||'').replace(/&/g,'&amp;');
        if(f.geometry.type==='Point'){
          const [lng,lat]=f.geometry.coordinates;
          placemarks += `  <Placemark><name>${name}</name><Point><coordinates>${lng},${lat},0</coordinates></Point></Placemark>\n`;
        } else if(f.geometry.type==='LineString'){
          const coords=f.geometry.coordinates.map(c=>c.join(',')+',0').join(' ');
          placemarks += `  <Placemark><name>${name}</name><LineString><coordinates>${coords}</coordinates></LineString></Placemark>\n`;
        } else if(f.geometry.type==='Polygon'){
          const coords=f.geometry.coordinates[0].map(c=>c.join(',')+',0').join(' ');
          placemarks += `  <Placemark><name>${name}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>\n`;
        }
      });
    });
  }
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>${projectName} GL ${date}</name>\n${placemarks}</Document>\n</kml>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([kml],{type:'application/vnd.google-earth.kml+xml'}));
  a.download = `${projectName}_GL_${date}.kml`;
  a.click();
  document.getElementById('map-export-modal').style.display='none';
}

async function mapLoadSettingsFields(){
  // Settings UI displays the platform-correct token (web sees mapboxToken,
  // native sees mapboxTokenNative) so the field never shows the wrong one.
  const {storageKey, firestoreField} = _mapTokenKeys();
  if(db&&_fbReady){
    try{
      const doc=await _udb().collection('settings').doc('projectConfig').get();
      if(doc.exists){
        const d=doc.data();
        if(d[firestoreField]){ localStorage.setItem(storageKey,d[firestoreField]); }
        if(d.mapStyle){ localStorage.setItem('gl_map_style',d.mapStyle); }
      }
    }catch(e){console.warn('mapLoadSettingsFields cloud failed:',e.message);}
  }
  const token=localStorage.getItem(storageKey)||'';
  const style=localStorage.getItem('gl_map_style')||'satellite-streets-v11';
  const tf=document.getElementById('cfg-map-token');
  const sf=document.getElementById('cfg-map-style');
  if(tf) tf.value=token;
  if(sf) sf.value=style;
}

function mapResize(){ if(_mapInstance) _mapInstance.resize(); }

// ═══════════════════════════════════════════
// B2 — FAB + TRACKER DRAW + MEASURE + GPS
// ═══════════════════════════════════════════

// ── FAB ──────────────────────────────────
function mapToggleFab(){
  mapCloseViewFab();
  _fabOpen=!_fabOpen;
  document.getElementById('map-fab').classList.toggle('open',_fabOpen);
  document.getElementById('map-fab-palette').classList.toggle('open',_fabOpen);
}
function mapCloseFab(){
  _fabOpen=false;
  document.getElementById('map-fab').classList.remove('open');
  document.getElementById('map-fab-palette').classList.remove('open');
}
function mapToggleViewFab(){
  mapCloseFab();
  _viewFabOpen=!_viewFabOpen;
  document.getElementById('map-view-fab').classList.toggle('open',_viewFabOpen);
  document.getElementById('map-view-palette').classList.toggle('open',_viewFabOpen);
}
function mapCloseViewFab(){
  _viewFabOpen=false;
  const vf=document.getElementById('map-view-fab');
  const vp=document.getElementById('map-view-palette');
  if(vf) vf.classList.remove('open');
  if(vp) vp.classList.remove('open');
}
function mapFabImportKml(){
  mapCloseFab();
  document.getElementById('map-kml-input').click();
}
function mapFabLayers(){
  mapCloseFab();
  mapToggleLayerPanel();
}
function mapFabDraw(){
  mapCloseFab();
  mapShowCategorySheet();
}
function mapFabMeasure(){
  if(_drawMode==='measure'){ mapDeactivateDrawMode(); return; }
  mapCloseFab();
  mapActivateMeasure();
}
function mapFabGps(){
  mapCloseFab();
  mapToggleGpsFollow();
}

// ── Category picker (draw flow) ───────────
function mapShowCategorySheet(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];
  const list=document.getElementById('map-category-list');
  const noCatPill=`<div class="map-cat-pill" onclick="mapActivateDrawMode(null)" style="border-color:var(--border2);margin-bottom:8px">
    <div class="map-cat-dot" style="background:#555"></div>
    <span style="color:var(--muted)">No Category</span>
  </div>`;
  if(!cats.length){
    list.innerHTML=noCatPill+'<div style="font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center;padding:16px 0">No categories yet.<br>Use Tracker to add your first.</div>';
  } else {
    list.innerHTML=noCatPill+cats.map(c=>`
      <div class="map-cat-pill" onclick="mapActivateDrawMode('${c.id}')">
        <div class="map-cat-dot" style="background:${c.color||'#888'}"></div>
        <span>${c.name}</span>
      </div>`).join('');
  }
  document.getElementById('map-category-sheet').classList.add('open');
}
function mapCloseCategorySheet(){
  document.getElementById('map-category-sheet').classList.remove('open');
}

// ── Tracker sheet (category management) ──
const TC_COLORS=[
  '#E74C3C','#D35400','#E67E22','#F39C12','#F4E200','#27AE60',
  '#1ABC9C','#3498DB','#4A90E2','#2980B9','#9B59B6','#E91E8C',
  '#7CCD7C','#A8D8A8','#82C4E8','#D7BDE2','#FFAB40','#FF7043',
  '#8E9BA3','#BDC3C7','#7F8C8D','#2C3E50','#922B21','#1B5E20',
];
let _tcLayerVisible={};       // { [catId]: boolean } — default true
let _tcEditingCatId=null;     // id of category being inline-edited
let _tcEditingColor=null;     // color staged for edit row (hex string)
let _tcAddingColor=null;      // color staged for add row (hex string)
let _tcConfirmDeleteId=null;  // id of category awaiting inline delete confirm
let _tcColorTarget=null;      // 'add'|'edit' — which swatch the picker is serving
let _tcAddingType='area';     // 'area'|'linear' — staged for add row

function mapShowTrackerSheet(){
  mapCloseFab();
  _tcEditingCatId=null;
  _tcAddingColor=null;
  _renderTrackerSheet();
  document.getElementById('map-tracker-sheet').classList.add('open');
}
function mapCloseTrackerSheet(){
  _tcEditingCatId=null;
  _tcAddingColor=null;
  document.getElementById('map-tracker-sheet').classList.remove('open');
  document.getElementById('map-tracker-sheet-add').classList.remove('open');
}

function _renderTrackerSheet(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];
  const list=document.getElementById('map-tracker-cat-list');
  if(!cats.length){
    list.innerHTML='<div style="font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center;padding:20px 0">No categories yet.<br>Tap + to create your first.</div>';
    return;
  }
  list.innerHTML=cats.map(c=>{
    const visible=_tcLayerVisible[c.id]!==false;
    if(_tcEditingCatId===c.id){
      const editType=c.measurementType||'area';
      const editUnitOpts=(editType==='linear'
        ?[['ft','Feet'],['yd','Yards'],['m','Meters'],['mi','Miles']]
        :[['ac','Acres'],['sqft','Sq Ft'],['sqyd','Sq Yards'],['sqm','Sq Meters'],['ha','Hectares']]
      ).map(([v,l])=>`<option value="${v}"${v===(c.defaultUnit||'ac')?' selected':''}>${l}</option>`).join('');
      const lsLabels={solid:'— Solid',dashed:'– Dashed',dotted:'·· Dotted','dash-dot':'–· D-Dot'};
      const lsOpts=['solid','dashed','dotted','dash-dot'].map(s=>`<option value="${s}"${s===(c.lineStyle||'solid')?' selected':''}>${lsLabels[s]||s}</option>`).join('');
      const lwOpts=[1,2,3,4].map(w=>`<option value="${w}"${w===(c.lineWidth||2)?' selected':''}>${w}px</option>`).join('');
      const fsLabels={solid:'■ Solid','hatch':'▥ Hatch','crosshatch':'▨ Cross','outline':'□ Outline'};
      const fsOpts=['solid','hatch','crosshatch','outline'].map(s=>`<option value="${s}"${s===(c.fillStyle||'solid')?' selected':''}>${fsLabels[s]||s}</option>`).join('');
      const foOpts=[['0.15','Light'],['0.35','Med'],['0.6','Dark']].map(([v,l])=>`<option value="${v}"${String(v)===String(c.fillOpacity??0.35)?' selected':''}>${l}</option>`).join('');
      const fillCtls=editType!=='linear'?`<select id="map-tc-edit-fillstyle" class="map-tc-unit-sel">${fsOpts}</select><select id="map-tc-edit-fillopacity" class="map-tc-unit-sel">${foOpts}</select>`:'';
      return `<div class="map-tc-row editing" style="flex-wrap:wrap;gap:6px">
        <div style="display:flex;align-items:center;gap:8px;width:100%">
          <div class="map-tc-edit-color" id="map-tc-edit-preview" style="background:${_tcEditingColor||c.color||'#888'}" onclick="mapShowColorPicker('edit',this)"></div>
          <input id="map-tc-edit-name" class="map-tc-name-input" value="${c.name}" placeholder="Name" autocomplete="off" maxlength="32">
          <button onclick="mapTrackerSaveEdit('${c.id}')" class="map-tc-save-btn">Save</button>
          <button onclick="mapTrackerCancelEdit()" class="map-tc-cancel-btn">✕</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding-left:28px">
          <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">${editType==='linear'?'Linear':'Area'} ·</span>
          <select id="map-tc-edit-unit" class="map-tc-unit-sel">${editUnitOpts}</select>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding-left:28px;flex-wrap:wrap">
          <select id="map-tc-edit-linestyle" class="map-tc-unit-sel">${lsOpts}</select>
          <select id="map-tc-edit-linewidth" class="map-tc-unit-sel">${lwOpts}</select>
          ${fillCtls}
        </div>
      </div>`;
    }
    if(_tcConfirmDeleteId===c.id){
      return `<div class="map-tc-row" style="background:rgba(220,50,50,.08)">
        <div class="map-tc-dot" style="background:${c.color||'#888'}"></div>
        <span class="map-tc-name" style="color:var(--muted)">Delete "${c.name}"?</span>
        <button onclick="mapTrackerConfirmDelete('${c.id}')" class="map-tc-save-btn" style="background:#c0392b;color:#fff">Yes</button>
        <button onclick="mapTrackerCancelDelete()" class="map-tc-cancel-btn">No</button>
      </div>`;
    }
    const hasDetails=c.measurementType==='linear'
      ?(c.specification||c.supplier)
      :(c.productName||c.targetRate||(c.amendmentType&&c.amendmentType!=='None'));
    const typeBadge=`<span style="font-family:var(--mono);font-size:9px;color:var(--muted);padding:2px 5px;border:1px solid var(--border);border-radius:3px;white-space:nowrap">${c.measurementType==='linear'?'LN':'AC'}</span>`;
    return `<div class="map-tc-row">
      <div class="map-tc-dot" style="background:${c.color||'#888'}"></div>
      <span class="map-tc-name">${c.name}</span>
      ${typeBadge}
      <button class="map-tc-btn ${visible?'':'dim'}" onclick="mapTrackerToggleLayer('${c.id}')" title="${visible?'Hide':'Show'} layer">${visible?'●':'○'}</button>
      <button class="map-tc-btn" onclick="mapTrackerStartEdit('${c.id}')">Edit</button>
      <button class="map-tc-btn" onclick="mapShowCategoryDetails('${c.id}')" title="Category details" style="${hasDetails?'color:var(--amber)':''}">⚙</button>
      <button class="map-tc-btn danger" onclick="mapTrackerAskDelete('${c.id}')">✕</button>
    </div>`;
  }).join('');
}

function mapTrackerToggleLayer(catId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  _tcLayerVisible[catId]=(_tcLayerVisible[catId]===false)?true:false;
  _renderTrackerSheet();
  mapRenderTrackerLayers();
}

function mapTrackerStartEdit(catId){
  _tcEditingCatId=catId;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null;
  _tcEditingColor=cat?cat.color:'#E67E22';
  _renderTrackerSheet();
  const input=document.getElementById('map-tc-edit-name');
  if(input){ input.focus(); input.select(); }
}
function mapTrackerCancelEdit(){
  _tcEditingCatId=null;
  _renderTrackerSheet();
}
async function mapTrackerSaveEdit(catId){
  const nameEl=document.getElementById('map-tc-edit-name');
  const name=(nameEl?nameEl.value.trim():'');
  if(!name) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const existing=(typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null;
  if(!existing) return;
  const editedUnit=document.getElementById('map-tc-edit-unit')?.value||existing.defaultUnit||'ac';
  const editedLineStyle=document.getElementById('map-tc-edit-linestyle')?.value||existing.lineStyle||'solid';
  const editedLineWidth=parseInt(document.getElementById('map-tc-edit-linewidth')?.value)||existing.lineWidth||2;
  const editedFillStyle=document.getElementById('map-tc-edit-fillstyle')?.value||existing.fillStyle||'solid';
  const editedFillOpacity=parseFloat(document.getElementById('map-tc-edit-fillopacity')?.value)??existing.fillOpacity??0.35;
  await tcSaveCategory({...existing,name,color:_tcEditingColor||existing.color,defaultUnit:editedUnit,lineStyle:editedLineStyle,lineWidth:editedLineWidth,fillStyle:editedFillStyle,fillOpacity:editedFillOpacity},pid);
  _tcEditingCatId=null;
  _tcEditingColor=null;
  _renderTrackerSheet();
  mapRenderTrackerLayers();
}
function mapTrackerAskDelete(catId){
  _tcConfirmDeleteId=catId;
  _renderTrackerSheet();
}
function mapTrackerCancelDelete(){
  _tcConfirmDeleteId=null;
  _renderTrackerSheet();
}
async function mapTrackerConfirmDelete(catId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  if(typeof tcDeleteCategory==='function') await tcDeleteCategory(catId,pid);
  _tcConfirmDeleteId=null;
  delete _tcLayerVisible[catId];
  const src='tracker-'+catId;
  if(_mapInstance){
    [src+'-fill',src+'-line',src+'-circle'].forEach(lid=>{
      try{ if(_mapInstance.getLayer(lid)) _mapInstance.removeLayer(lid); }catch{}
    });
    try{ if(_mapInstance.getSource(src)) _mapInstance.removeSource(src); }catch{}
  }
  _renderTrackerSheet();
}

// ── Category details modal ────────────────
const _INPUT_STYLE='width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-family:var(--mono);font-size:12px';
const _LABEL_STYLE='font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px';
function _cdField(label,inner){return `<div><label style="${_LABEL_STYLE}">${label}</label>${inner}</div>`;}

function mapShowCategoryDetails(catId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null;
  if(!cat) return;
  if(document.getElementById('_cat-details-ov')) return;
  const isLinear=cat.measurementType==='linear';
  let fields;
  if(isLinear){
    fields=`
      ${_cdField('Specification',`<input type="text" id="_cd-spec" value="${cat.specification||''}" placeholder="Standard, heavy duty, J-hook…" style="${_INPUT_STYLE}">`)}
      ${_cdField('Supplier / Product',`<input type="text" id="_cd-supplier" value="${cat.supplier||''}" placeholder="Manufacturer or vendor name" style="${_INPUT_STYLE}">`)}
      ${_cdField('Notes',`<input type="text" id="_cd-notes-det" value="${cat.detailNotes||''}" placeholder="Any additional details" style="${_INPUT_STYLE}">`)}`;
  } else {
    const typeOptions=['None','Seeding','Lime','Fertilizer','Mulch','Other'];
    const unitOptions=['lbs/ac','tons/ac','gal/ac','bags/ac'];
    fields=`
      ${_cdField('Amendment Type',`<select id="_cd-type" style="${_INPUT_STYLE}">${typeOptions.map(t=>`<option value="${t}"${(cat.amendmentType||'None')===t?' selected':''}>${t}</option>`).join('')}</select>`)}
      ${_cdField('Product Name',`<input type="text" id="_cd-product" value="${cat.productName||''}" placeholder="Seed mix, product, formula…" style="${_INPUT_STYLE}">`)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${_cdField('Target Rate',`<input type="number" id="_cd-rate" value="${cat.targetRate||''}" step="0.1" min="0" placeholder="e.g. 30" style="${_INPUT_STYLE}">`)}
        ${_cdField('Unit',`<select id="_cd-unit" style="${_INPUT_STYLE}">${unitOptions.map(u=>`<option value="${u}"${(cat.targetRateUnit||'lbs/ac')===u?' selected':''}>${u}</option>`).join('')}</select>`)}
      </div>`;
  }
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.id='_cat-details-ov';
  ov.style.cssText='z-index:5000';
  ov.innerHTML=`<div class="modal-box" style="max-width:320px;width:90%">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <div style="width:12px;height:12px;border-radius:50%;background:${cat.color||'#888'};flex-shrink:0"></div>
      <div class="modal-title" style="margin:0">${cat.name}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px">${fields}</div>
    <div class="modal-btns">
      <button class="modal-cancel" id="_cd-cancel">Cancel</button>
      <button class="modal-confirm" id="_cd-save">Save</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  document.getElementById('_cd-cancel').onclick=()=>ov.remove();
  document.getElementById('_cd-save').onclick=()=>mapSaveCategoryDetails(catId,ov,isLinear);
}

async function mapSaveCategoryDetails(catId, ov, isLinear){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const existing=(typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null;
  if(!existing) return;
  let patch;
  if(isLinear){
    patch={
      specification: document.getElementById('_cd-spec')?.value.trim()||null,
      supplier:      document.getElementById('_cd-supplier')?.value.trim()||null,
      detailNotes:   document.getElementById('_cd-notes-det')?.value.trim()||null
    };
  } else {
    patch={
      amendmentType: document.getElementById('_cd-type')?.value||'None',
      productName:   document.getElementById('_cd-product')?.value.trim()||null,
      targetRate:    parseFloat(document.getElementById('_cd-rate')?.value)||null,
      targetRateUnit:document.getElementById('_cd-unit')?.value||'lbs/ac'
    };
  }
  if(typeof tcSaveCategory==='function') await tcSaveCategory({...existing,...patch},pid);
  ov.remove();
  _renderTrackerSheet();
}

// ── Color picker popover ──────────────────
function mapShowColorPicker(target, swatchEl){
  _tcColorTarget=target;
  const picker=document.getElementById('map-tc-color-popover');
  if(!picker) return;
  picker.innerHTML=TC_COLORS.map(c=>`<div onclick="mapSelectColor('${c}')" style="width:26px;height:26px;border-radius:50%;background:${c};cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.45);flex-shrink:0;border:2px solid rgba(255,255,255,.12)"></div>`).join('')
    +`<div style="width:100%;border-top:1px solid rgba(255,255,255,.12);padding-top:8px;display:flex;align-items:center;gap:6px">
    <input id="_tc-hex-input" type="text" placeholder="#rrggbb" maxlength="7" style="flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:5px;color:#fff;font-family:var(--mono);font-size:11px;padding:5px 8px" oninput="mapHexColorInput(this.value)" onkeydown="if(event.key==='Enter')mapApplyHexColor()">
    <div id="_tc-hex-preview" style="width:24px;height:24px;border-radius:50%;background:#888;flex-shrink:0;border:2px solid rgba(255,255,255,.2)"></div>
    <button onclick="mapApplyHexColor()" style="background:var(--amber,#D97706);border:none;color:#111;border-radius:4px;font-family:var(--mono);font-size:10px;padding:4px 8px;cursor:pointer;font-weight:700">✓</button>
  </div>`;
  picker.style.display='flex';
  const rect=swatchEl.getBoundingClientRect();
  const pickerW=216; // 5 cols × (30+12) - 12 + 2×padding
  const left=Math.max(8, Math.min(rect.left, window.innerWidth-pickerW-8));
  picker.style.left=left+'px';
  picker.style.top=(rect.top-picker.offsetHeight-10)+'px';
  // Reposition after layout
  requestAnimationFrame(()=>{
    const h=picker.offsetHeight;
    picker.style.top=(rect.top-h-10)+'px';
  });
}
function mapSelectColor(hex){
  if(_tcColorTarget==='add'){
    _tcAddingColor=hex;
    const el=document.getElementById('map-tc-add-preview');
    if(el) el.style.background=hex;
  } else if(_tcColorTarget==='edit'){
    _tcEditingColor=hex;
    const el=document.getElementById('map-tc-edit-preview');
    if(el) el.style.background=hex;
  }
  document.getElementById('map-tc-color-popover').style.display='none';
  _tcColorTarget=null;
}
function mapHideColorPicker(){
  const picker=document.getElementById('map-tc-color-popover');
  if(picker) picker.style.display='none';
  _tcColorTarget=null;
}
function mapHexColorInput(val){
  const isValid=/^#[0-9A-Fa-f]{6}$/.test(val);
  const preview=document.getElementById('_tc-hex-preview');
  if(preview) preview.style.background=isValid?val:'#888';
}
function mapApplyHexColor(){
  const input=document.getElementById('_tc-hex-input');
  if(!input) return;
  const val=input.value.trim();
  if(/^#[0-9A-Fa-f]{6}$/.test(val)) mapSelectColor(val);
}

function mapTcSetAddType(type){
  _tcAddingType=type;
  document.getElementById('map-tc-add-type-area').classList.toggle('active',type==='area');
  document.getElementById('map-tc-add-type-linear').classList.toggle('active',type==='linear');
  const sel=document.getElementById('map-tc-add-unit');
  if(sel){
    sel.innerHTML=type==='linear'
      ?'<option value="ft">Feet</option><option value="yd">Yards</option><option value="m">Meters</option><option value="mi">Miles</option>'
      :'<option value="ac">Acres</option><option value="sqft">Sq Ft</option><option value="sqyd">Sq Yards</option><option value="sqm">Sq Meters</option><option value="ha">Hectares</option>';
  }
  const fillCtls=document.getElementById('map-tc-add-fill-controls');
  if(fillCtls) fillCtls.style.display=type==='linear'?'none':'';
}
function mapTrackerShowAdd(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  _tcAddingColor=(typeof tcNextColor==='function')?tcNextColor(pid):'#E67E22';
  _tcAddingType='area';
  mapTcSetAddType('area');
  const add=document.getElementById('map-tracker-sheet-add');
  const preview=document.getElementById('map-tc-add-preview');
  const input=document.getElementById('map-tc-add-name');
  if(preview) preview.style.background=_tcAddingColor;
  if(input){ input.value=''; }
  add.classList.add('open');
  if(input) setTimeout(()=>input.focus(),50);
}
function mapTrackerHideAdd(){
  document.getElementById('map-tracker-sheet-add').classList.remove('open');
  _tcAddingColor=null;
}
async function mapTrackerSaveAdd(){
  const nameEl=document.getElementById('map-tc-add-name');
  const name=(nameEl?nameEl.value.trim():'');
  if(!name) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const measurementType=_tcAddingType||'area';
  const defaultUnit=document.getElementById('map-tc-add-unit')?.value||(measurementType==='linear'?'ft':'ac');
  const lineStyle=document.getElementById('map-tc-add-linestyle')?.value||'solid';
  const lineWidth=parseInt(document.getElementById('map-tc-add-linewidth')?.value)||2;
  const fillStyle=measurementType==='linear'?'solid':(document.getElementById('map-tc-add-fillstyle')?.value||'solid');
  const fillOpacity=parseFloat(document.getElementById('map-tc-add-fillopacity')?.value)||0.35;
  await tcSaveCategory({name,color:_tcAddingColor||'#E67E22',measurementType,defaultUnit,lineStyle,lineWidth,fillStyle,fillOpacity},pid);
  mapTrackerHideAdd();
  _renderTrackerSheet();
}

// ── Draw mode ────────────────────────────
function mapActivateDrawMode(categoryId){
  mapCloseCategorySheet();
  mapResetGpsFollow();
  if(!_mapInstance) return;
  _drawCategory=categoryId;
  _drawMode='draw';
  if(!_drawInstance){
    _drawInstance=new MapboxDraw({ displayControlsDefault:false, controls:{} });
    _mapInstance.addControl(_drawInstance,'top-left');
    _mapInstance.on('draw.create',_onDrawCreate);
    _mapInstance.on('draw.delete',_onDrawDelete);
    _mapInstance.on('draw.modechange',_onDrawModeChange);
  }
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=categoryId?((typeof tcGetCategory==='function')?tcGetCategory(categoryId,pid):null):null;
  const isLinear=cat?.measurementType==='linear';
  if(isLinear){
    _drawInstance.changeMode('draw_line_string');
    mapDrawSetShape('line');
  } else {
    _drawInstance.changeMode('draw_polygon');
    mapDrawSetShape('polygon');
  }
  // Restrict shape buttons for linear (line only); all shapes for area and no-category
  const polyBtn=document.getElementById('map-draw-poly-btn');
  const pointBtn=document.getElementById('map-draw-point-btn');
  if(polyBtn){ polyBtn.disabled=isLinear; polyBtn.style.opacity=isLinear?'0.3':''; }
  if(pointBtn){ pointBtn.disabled=isLinear; pointBtn.style.opacity=isLinear?'0.3':''; }
  const catName=categoryId?((typeof tcGetName==='function')?tcGetName(categoryId,pid):categoryId):'Uncategorized';
  const catColor=categoryId?((typeof tcGetColor==='function')?tcGetColor(categoryId,pid):'#888'):'#888';
  const bar=document.getElementById('map-draw-bar');
  document.getElementById('map-draw-bar-label').textContent=`Drawing: ${catName}`;
  document.getElementById('map-draw-shape-btns').style.display='flex';
  bar.classList.add('show');
  bar.style.borderColor=catColor;
  document.getElementById('map-fab-draw-btn').classList.add('active');
}

function mapDeactivateDrawMode(){
  const prevMode=_drawMode;
  _drawMode=null;
  _drawCategory=null;
  _pendingDrawFeature=null;
  if(prevMode==='draw'&&_drawInstance){
    _drawInstance.deleteAll();
    try{ _mapInstance.removeControl(_drawInstance); }catch{}
    _drawInstance=null;
  }
  if(prevMode==='measure') _deactivateMeasureMode();
  document.getElementById('map-draw-bar').classList.remove('show');
  document.getElementById('map-fab-draw-btn').classList.remove('active');
  document.getElementById('map-fab-measure-btn').classList.remove('active');
  document.getElementById('map-measure-chip').classList.remove('show');
  const measTypeBtns=document.getElementById('map-measure-type-btns');
  if(measTypeBtns) measTypeBtns.style.display='none';
  ['poly','line','point'].forEach(s=>{
    const btn=document.getElementById('map-draw-'+s+'-btn');
    if(btn){ btn.disabled=false; btn.style.opacity=''; }
  });
  mapCloseTrackerModal();
}
function mapDrawSetShape(shape){
  if(!_drawInstance) return;
  if(shape==='polygon') _drawInstance.changeMode('draw_polygon');
  else if(shape==='line') _drawInstance.changeMode('draw_line_string');
  else if(shape==='point') _drawInstance.changeMode('draw_point');
  ['polygon','line','point'].forEach(s=>{
    const btn=document.getElementById('map-draw-'+s+'-btn');
    if(!btn) return;
    btn.style.background = s===shape ? 'rgba(0,0,0,.35)' : 'none';
    btn.style.boxShadow = s===shape ? 'inset 0 1px 3px rgba(0,0,0,.4)' : 'none';
  });
}

function _onDrawCreate(e){
  if(!e.features||!e.features.length) return;
  const feat=e.features[0];
  if(_drawMode==='measure'){
    _showMeasureReadout(feat);
    return;
  }
  _pendingDrawFeature=feat;
  mapShowTrackerModal(feat,_drawCategory);
}
function _onDrawDelete(){ /* no action needed */ }
function _onDrawModeChange(){ /* no action needed */ }

// ── Geometry helpers ──────────────────────
function _geoAreaAcres(feat){
  if(!feat||feat.geometry.type!=='Polygon') return null;
  const coords=feat.geometry.coordinates[0];
  if(coords.length<3) return null;
  let area=0;
  const n=coords.length;
  const toRad=d=>d*Math.PI/180;
  for(let i=0;i<n-1;i++){
    area+=(toRad(coords[i+1][0])-toRad(coords[i][0]))*(
      2+Math.sin(toRad(coords[i][1]))+Math.sin(toRad(coords[i+1][1]))
    );
  }
  const m2=Math.abs(area*6371000*6371000/2);
  return (m2*0.000247105).toFixed(2);
}

function _geoLengthFt(feat){
  if(!feat||feat.geometry.type!=='LineString') return null;
  const coords=feat.geometry.coordinates;
  let total=0;
  for(let i=0;i<coords.length-1;i++){
    const [lng1,lat1]=coords[i],[lng2,lat2]=coords[i+1];
    const R=6371000,toRad=d=>d*Math.PI/180;
    const dLat=toRad(lat2-lat1),dLng=toRad(lng2-lng1);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    total+=R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  return (total*3.28084).toFixed(0);
}

function _geoCentroid(feat){
  const coords=feat.geometry.type==='Polygon'
    ? feat.geometry.coordinates[0]
    : feat.geometry.type==='LineString'
      ? feat.geometry.coordinates
      : [feat.geometry.coordinates];
  if(!coords||!coords.length) return null;
  const sum=coords.reduce((a,c)=>[a[0]+c[0],a[1]+c[1]],[0,0]);
  return {lng:sum[0]/coords.length,lat:sum[1]/coords.length};
}

// ── Tracker entry modal ───────────────────
function _buildUnitOpts(units,selected){
  return units.map(u=>`<option value="${u}"${u===selected?' selected':''}>${TC_UNIT_LABELS?.[u]||u}</option>`).join('');
}
function mapShowTrackerModal(feat,category){
  const activeLogDate=document.getElementById('reportDate')?.value;
  const today=activeLogDate||new Date().toLocaleDateString('en-CA');
  document.getElementById('map-tr-date').value=today;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const catDetails=(typeof tcGetCategory==='function')?tcGetCategory(category,pid):null;
  const measType=catDetails?.measurementType||'area';
  const defaultUnit=catDetails?.defaultUnit||(measType==='linear'?'ft':'ac');
  // Measurement field — populate label, unit dropdown, and computed value
  const measLabel=document.getElementById('map-tr-meas-label');
  const unitSel=document.getElementById('map-tr-unit');
  const measInput=document.getElementById('map-tr-acres');
  if(measLabel) measLabel.textContent=measType==='linear'?'Length':'Area';
  if(unitSel){
    const opts=measType==='linear'?TC_LINEAR_UNITS:TC_AREA_UNITS;
    unitSel.innerHTML=_buildUnitOpts(opts,defaultUnit);
  }
  if(measInput){
    if(measType==='linear'){
      const rawFt=parseFloat(_geoLengthFt(feat));
      const val=rawFt?(typeof tcConvertMeasurement==='function'?tcConvertMeasurement(rawFt,'ft',defaultUnit):rawFt):null;
      measInput.value=val!=null?parseFloat(val.toFixed(['ft','yd','m'].includes(defaultUnit)?0:2)):'';
    } else {
      const rawAc=parseFloat(_geoAreaAcres(feat));
      const val=rawAc?(typeof tcConvertMeasurement==='function'?tcConvertMeasurement(rawAc,'ac',defaultUnit):rawAc):null;
      measInput.value=val!=null?parseFloat(val.toFixed(2)):'';
    }
    measInput.dataset.unit=defaultUnit;
  }
  const centroid=_geoCentroid(feat);
  document.getElementById('map-tr-location').value=
    centroid ? `${centroid.lat.toFixed(5)}, ${centroid.lng.toFixed(5)}` : '';
  document.getElementById('map-tr-notes').value='';
  _pendingPhotoIds=[];
  mapRefreshEntryPhotoStrip();
  // Seed calculator — only relevant for area categories
  const calcSection=document.getElementById('map-tr-calc-section');
  if(calcSection) calcSection.style.display=measType==='linear'?'none':'';
  const rateEl=document.getElementById('map-tr-rate');
  const calcEl=document.getElementById('map-tr-calc-result');
  if(rateEl) rateEl.value=catDetails?.targetRate||'';
  if(calcEl) calcEl.textContent='—';
  if(catDetails?.targetRate&&measType!=='linear') mapTrackerCalc();
  const catColor=(typeof tcGetColor==='function')?tcGetColor(category,pid):'#888';
  const catName=(typeof tcGetName==='function')?tcGetName(category,pid):(category||'Unknown');
  document.getElementById('map-tracker-cat-dot').style.background=catColor;
  document.getElementById('map-tracker-cat-label').textContent=catName;
  _populateEntryDropdowns();
  const areaFields=document.getElementById('map-tr-area-fields');
  const linearFields=document.getElementById('map-tr-linear-fields');
  if(areaFields) areaFields.style.display=measType==='linear'?'none':'';
  if(linearFields) linearFields.style.display=measType==='linear'?'':'none';
  const phaseEl=document.getElementById('map-tr-phase');
  const methodEl=document.getElementById('map-tr-method');
  const conEl=document.getElementById('map-tr-contractor');
  const statusEl=document.getElementById('map-tr-status');
  if(phaseEl) phaseEl.value='N/A';
  if(methodEl) methodEl.value='N/A';
  if(conEl) conEl.value='';
  if(statusEl) statusEl.value='Installed';
  document.getElementById('map-tracker-modal').classList.add('open');
}

function _populateEntryDropdowns(){
  const phases=window._amendmentPhases||['N/A'];
  const methods=window._amendmentMethods||['N/A'];
  const phaseEl=document.getElementById('map-tr-phase');
  const methodEl=document.getElementById('map-tr-method');
  if(phaseEl){ phaseEl.innerHTML=phases.map(p=>`<option value="${p}">${p}</option>`).join(''); }
  if(methodEl){ methodEl.innerHTML=methods.map(m=>`<option value="${m}">${m}</option>`).join(''); }
}

function mapCloseTrackerModal(){
  document.getElementById('map-tracker-modal').classList.remove('open');
}

function mapCancelTrackerEntry(){
  if(_drawInstance) _drawInstance.deleteAll();
  _pendingDrawFeature=null;
  _pendingPhotoIds=[];
  mapRefreshEntryPhotoStrip();
  mapCloseTrackerModal();
  // Stay in draw mode so user can try again
}

function mapSaveTrackerEntry(){
  const feat=_pendingDrawFeature;
  if(!feat) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const today=document.getElementById('reportDate')?.value||new Date().toLocaleDateString('en-CA');
  const measInput=document.getElementById('map-tr-acres');
  const unitSel=document.getElementById('map-tr-unit');
  const measurementUnit=unitSel?.value||measInput?.dataset.unit||'ac';
  const measurementValue=parseFloat(measInput?.value)||null;
  // Backward compat: keep `acres` populated for area-in-acres entries
  const acres=(measurementUnit==='ac')?measurementValue:
    (TC_AREA_UNITS?.includes(measurementUnit)&&measurementValue&&typeof tcConvertMeasurement==='function'
      ?parseFloat(tcConvertMeasurement(measurementValue,measurementUnit,'ac').toFixed(2)):null);
  const catDetails=(typeof tcGetCategory==='function')?tcGetCategory(_drawCategory,pid):null;
  const measType=catDetails?.measurementType||'area';
  const isLinear=measType==='linear';
  const centroid=_geoCentroid(feat);
  const catName=(typeof tcGetName==='function')?tcGetName(_drawCategory,pid):(_drawCategory||'Unknown');
  const entry={
    date:document.getElementById('map-tr-date').value||today,
    categoryId:_drawCategory||null,
    categoryName:catName,
    measurementType:measType,
    geometry:feat.geometry,
    centroidLng:centroid?centroid.lng:null,
    centroidLat:centroid?centroid.lat:null,
    acres,
    measurementValue,
    measurementUnit,
    location:document.getElementById('map-tr-location').value.trim()||null,
    phase:isLinear?null:(document.getElementById('map-tr-phase')?.value||'N/A'),
    method:isLinear?null:(document.getElementById('map-tr-method')?.value||'N/A'),
    status:isLinear?(document.getElementById('map-tr-status')?.value||'Installed'):null,
    contractor:document.getElementById('map-tr-contractor')?.value.trim()||null,
    fields:{},
    notes:document.getElementById('map-tr-notes').value.trim()||null,
    photoIds:[..._pendingPhotoIds]
  };
  // Editing an existing entry — preserve id so trSaveEntry updates in place
  if(_editingEntryId){ entry.id=_editingEntryId; entry.deletedFromMap=false; entry.archivedFromMap=false; }
  _editingEntryId=null;
  _pendingPhotoIds=[];
  if(typeof trSaveEntry==='function') trSaveEntry(entry,pid);
  _pendingDrawFeature=null;
  mapCloseTrackerModal();
  if(_drawInstance) _drawInstance.deleteAll();
  mapRenderTrackerLayers();
  mapUpdateKmlLayerList();
  if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
}

// ── Measure mode ──────────────────────────
let _measureType='line';
let _measurePoints=[], _measureClickHandler=null;

function _initMeasureSource(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;
  if(_mapInstance.getSource('measure-source')) return;
  _mapInstance.addSource('measure-source',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  _mapInstance.addLayer({id:'measure-fill',type:'fill',source:'measure-source',
    filter:['==',['geometry-type'],'Polygon'],
    paint:{'fill-color':'#4A90E2','fill-opacity':0.15}});
  _mapInstance.addLayer({id:'measure-line',type:'line',source:'measure-source',
    filter:['any',['==',['geometry-type'],'LineString'],['==',['geometry-type'],'Polygon']],
    paint:{'line-color':'#4A90E2','line-width':2,'line-dasharray':[4,2]}});
  _mapInstance.addLayer({id:'measure-points',type:'circle',source:'measure-source',
    filter:['==',['geometry-type'],'Point'],
    paint:{'circle-radius':4,'circle-color':'#fff','circle-stroke-color':'#4A90E2','circle-stroke-width':2}});
}

function _deactivateMeasureMode(){
  if(_measureClickHandler){
    _mapInstance.off('click',_measureClickHandler);
    _measureClickHandler=null;
  }
  _measurePoints=[];
  if(_mapInstance){
    ['measure-points','measure-line','measure-fill'].forEach(id=>{
      try{ if(_mapInstance.getLayer(id)) _mapInstance.removeLayer(id); }catch{}
    });
    try{ if(_mapInstance.getSource('measure-source')) _mapInstance.removeSource('measure-source'); }catch{}
  }
}

function _measureGeoJson(){
  const pts=_measurePoints.map(p=>[p.lng,p.lat]);
  const features=[];
  if(pts.length>=2){
    if(_measureType==='polygon'&&pts.length>=3){
      features.push({type:'Feature',geometry:{type:'Polygon',coordinates:[[...pts,pts[0]]]}});
    } else {
      features.push({type:'Feature',geometry:{type:'LineString',coordinates:pts}});
    }
  }
  pts.forEach(p=>features.push({type:'Feature',geometry:{type:'Point',coordinates:p}}));
  return {type:'FeatureCollection',features};
}

function _updateMeasureDisplay(){
  const src=_mapInstance&&_mapInstance.getSource('measure-source');
  if(src) src.setData(_measureGeoJson());
  const label=document.getElementById('map-draw-bar-label');
  if(!label) return;
  const pts=_measurePoints;
  if(pts.length<2){label.textContent=pts.length===1?'1 point — keep tapping':'Tap map to place points';return;}
  if(_measureType==='polygon'&&pts.length>=3){
    const coords=pts.map(p=>[p.lng,p.lat]);
    const ac=_geoAreaAcres({geometry:{type:'Polygon',coordinates:[[...coords,coords[0]]]}});
    const ft=_geoLengthFt({geometry:{type:'LineString',coordinates:[...coords,coords[0]]}});
    const mi=ft?(parseInt(ft)/5280).toFixed(2):null;
    label.textContent=`${ac||'—'} ac  ·  ${ft?parseInt(ft).toLocaleString()+' ft perim':'—'}${mi?' ('+mi+' mi)':''}`;
  } else {
    const ft=_geoLengthFt({geometry:{type:'LineString',coordinates:pts.map(p=>[p.lng,p.lat])}});
    const mi=ft?(parseInt(ft)/5280).toFixed(2):null;
    label.textContent=ft?`${parseInt(ft).toLocaleString()} ft  ·  ${mi} mi`:'Tap map to place points';
  }
}

function mapNewMeasure(){
  _measurePoints=[];
  _updateMeasureDisplay();
}

function mapActivateMeasure(){
  if(!_mapInstance) return;
  mapResetGpsFollow();
  _drawMode='measure';
  _measureType='line';
  _measurePoints=[];
  _initMeasureSource();
  _measureClickHandler=e=>{
    if(_drawMode!=='measure') return;
    _measurePoints.push({lng:e.lngLat.lng,lat:e.lngLat.lat});
    _updateMeasureDisplay();
  };
  _mapInstance.on('click',_measureClickHandler);
  const bar=document.getElementById('map-draw-bar');
  document.getElementById('map-draw-bar-label').textContent='Tap map to place points';
  document.getElementById('map-draw-shape-btns').style.display='none';
  const measTypeBtns=document.getElementById('map-measure-type-btns');
  if(measTypeBtns) measTypeBtns.style.display='flex';
  _updateMeasureTypeBtns('line');
  bar.classList.add('show');
  bar.style.borderColor='#4A90E2';
  document.getElementById('map-fab-measure-btn').classList.add('active');
}

function mapSetMeasureType(type){
  if(_drawMode!=='measure') return;
  _measureType=type;
  _measurePoints=[];
  _updateMeasureDisplay();
  _updateMeasureTypeBtns(type);
}

function _updateMeasureTypeBtns(type){
  const lineBtn=document.getElementById('map-meas-line-btn');
  const polyBtn=document.getElementById('map-meas-poly-btn');
  if(lineBtn) lineBtn.style.background=type==='line'?'rgba(0,0,0,.35)':'none';
  if(polyBtn) polyBtn.style.background=type==='polygon'?'rgba(0,0,0,.35)':'none';
}

// ── GPS Follow ────────────────────────────
function mapToggleGpsFollow(){
  const btn=document.getElementById('map-fab-gps-btn');
  if(_gpsFollowActive){
    _gpsFollowActive=false;
    if(_gpsFollowWatch) navigator.geolocation.clearWatch(_gpsFollowWatch);
    _gpsFollowWatch=null;
    if(btn) btn.classList.remove('active');
  } else {
    if(!navigator.geolocation) return;
    _gpsFollowActive=true;
    if(btn) btn.classList.add('active');
    // Fly to current position immediately
    navigator.geolocation.getCurrentPosition(pos=>{
      if(!_mapInstance||!_gpsFollowActive) return;
      _mapInstance.flyTo({center:[pos.coords.longitude,pos.coords.latitude],zoom:17,duration:800});
    },null,{enableHighAccuracy:true});
    // Then keep centered on updates
    _gpsFollowWatch=navigator.geolocation.watchPosition(pos=>{
      if(!_mapInstance||!_gpsFollowActive) return;
      _mapInstance.easeTo({center:[pos.coords.longitude,pos.coords.latitude],duration:300});
    },null,{enableHighAccuracy:true,maximumAge:3000});
  }
}

function mapResetGpsFollow(){
  if(!_gpsFollowActive) return;
  _gpsFollowActive=false;
  if(_gpsFollowWatch) navigator.geolocation.clearWatch(_gpsFollowWatch);
  _gpsFollowWatch=null;
  const btn=document.getElementById('map-fab-gps-btn');
  if(btn) btn.classList.remove('active');
}

// ── Tracker entry map layers ──────────────
let _trackerPopup=null,_trackerClickHandlerRegistered=false,_editingEntryId=null;

function mapClearTrackerLayers(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;
  const style=_mapInstance.getStyle();
  if(!style) return;
  (style.layers||[]).forEach(l=>{
    if(/^tracker-.+-(fill|line|circle)$/.test(l.id)) try{ _mapInstance.removeLayer(l.id); }catch{}
  });
  Object.keys(style.sources||{}).forEach(s=>{
    if(/^tracker-/.test(s)) try{ _mapInstance.removeSource(s); }catch{}
  });
  if(_trackerPopup){ _trackerPopup.remove(); _trackerPopup=null; }
}

// ── Tracker layer style helpers ────────────────────────────────────────────
const _TC_DASH_ARRAYS={solid:null,dashed:[5,3],dotted:[1,2.5],'dash-dot':[5,2,1,2]};

function _generateHatchPattern(color,type,opacity){
  const size=32;
  const canvas=document.createElement('canvas');
  canvas.width=size; canvas.height=size;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,size,size);
  ctx.globalAlpha=opacity!=null?opacity:0.7;
  ctx.strokeStyle=color; ctx.lineWidth=2;
  const sp=16;
  for(let i=-size;i<=size*2;i+=sp){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i+size,size);ctx.stroke();}
  if(type==='crosshatch'){
    for(let i=-size;i<=size*2;i+=sp){ctx.beginPath();ctx.moveTo(i,size);ctx.lineTo(i+size,0);ctx.stroke();}
  }
  return ctx.getImageData(0,0,size,size);
}

function _ensureCategoryPatternImages(cats){
  if(!_mapInstance) return;
  cats.forEach(cat=>{
    const color=cat.color||'#888';
    const fs=cat.fillStyle||'solid';
    const opacity=cat.fillOpacity!=null?cat.fillOpacity:0.7;
    if(fs==='hatch'||fs==='crosshatch'){
      const name='tr-hatch-'+cat.id;
      const img=_generateHatchPattern(color,'hatch',opacity);
      try{ if(_mapInstance.hasImage(name)) _mapInstance.updateImage(name,img); else _mapInstance.addImage(name,img); }catch{}
    }
    if(fs==='crosshatch'){
      const name='tr-xhatch-'+cat.id;
      const img=_generateHatchPattern(color,'crosshatch',opacity);
      try{ if(_mapInstance.hasImage(name)) _mapInstance.updateImage(name,img); else _mapInstance.addImage(name,img); }catch{}
    }
  });
}

function _addCategoryFillLayer(srcId,cat){
  const color=cat.color||'#888';
  const fs=cat.fillStyle||'solid';
  const fo=cat.fillOpacity!=null?cat.fillOpacity:0.35;
  let paint;
  if(fs==='hatch')        paint={'fill-pattern':'tr-hatch-'+cat.id};
  else if(fs==='crosshatch') paint={'fill-pattern':'tr-xhatch-'+cat.id};
  else if(fs==='outline')    paint={'fill-color':color,'fill-opacity':0};
  else                       paint={'fill-color':color,'fill-opacity':fo};
  _mapInstance.addLayer({id:srcId+'-fill',type:'fill',source:srcId,filter:['==',['geometry-type'],'Polygon'],paint});
}

function _addCategoryLineLayer(srcId,cat){
  const color=cat.color||'#888';
  const lw=cat.lineWidth||2;
  const dashArr=_TC_DASH_ARRAYS[cat.lineStyle||'solid']||null;
  const paint={'line-color':color,'line-width':lw,'line-opacity':0.9};
  if(dashArr) paint['line-dasharray']=dashArr;
  _mapInstance.addLayer({id:srcId+'-line',type:'line',source:srcId,
    filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'LineString']],paint});
}

function _addCategoryCircleLayer(srcId,cat){
  const color=cat.color||'#888';
  const r=5+(cat.lineWidth||2);
  _mapInstance.addLayer({id:srcId+'-circle',type:'circle',source:srcId,
    filter:['==',['geometry-type'],'Point'],
    paint:{'circle-color':color,'circle-radius':r,'circle-opacity':0.9,'circle-stroke-color':'#fff','circle-stroke-width':1.5}});
}

function mapRenderTrackerLayers(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;

  if(!_trackerClickHandlerRegistered){
    _trackerClickHandlerRegistered=true;
    _mapInstance.on('click',e=>{
      if(_drawMode) return;
      // Don't open tracker popup when user clicked a photo pin
      const clickTarget=e.originalEvent&&e.originalEvent.target;
      if(clickTarget&&clickTarget.closest&&clickTarget.closest('._photo-marker')) return;
      const bbox=[[e.point.x-22,e.point.y-22],[e.point.x+22,e.point.y+22]];
      const style=_mapInstance.getStyle();
      if(!style||!style.layers) return;
      const lids=style.layers.map(l=>l.id).filter(id=>/^tracker-.+-(fill|line|circle)$/.test(id));
      if(!lids.length) return;
      const features=_mapInstance.queryRenderedFeatures(bbox,{layers:lids});
      if(!features.length) return;
      _showTrackerEntryPopup(e.lngLat,features[0].properties);
    });
  }

  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid).filter(e=>!e.deletedFromMap&&!e.archivedFromMap):[];
  const cats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];

  const byCategory={};
  cats.forEach(c=>{byCategory[c.id]=[];});
  entries.forEach(e=>{
    const cid=e.categoryId||e.category;
    if(e.geometry){
      if(byCategory[cid]!==undefined) byCategory[cid].push(e);
      else { if(!byCategory['__orphan']) byCategory['__orphan']=[]; byCategory['__orphan'].push(e); }
    }
  });

  cats.forEach(cat=>{
    const src='tracker-'+cat.id;
    const color=cat.color||'#888';
    const visible=_tcLayerVisible[cat.id]!==false;
    const geojson={type:'FeatureCollection',features:(visible?byCategory[cat.id]:[]).map(e=>({
      type:'Feature',
      id:e.id,
      properties:{id:e.id,categoryId:e.categoryId||e.category,categoryName:e.categoryName||e.category,date:e.date,acres:e.acres,measurementValue:e.measurementValue??null,measurementUnit:e.measurementUnit||null,notes:e.notes,location:e.location,phase:e.phase||null,method:e.method||null,status:e.status||null,contractor:e.contractor||null},
      geometry:e.geometry
    }))};

    _ensureCategoryPatternImages([cat]);
    if(_mapInstance.getSource(src)){
      _mapInstance.getSource(src).setData(geojson);
      ['fill','line','circle'].forEach(t=>{try{if(_mapInstance.getLayer(src+'-'+t))_mapInstance.removeLayer(src+'-'+t);}catch{}});
      _addCategoryFillLayer(src,cat);
      _addCategoryLineLayer(src,cat);
      _addCategoryCircleLayer(src,cat);
    } else {
      _mapInstance.addSource(src,{type:'geojson',data:geojson});
      _addCategoryFillLayer(src,cat);
      _addCategoryLineLayer(src,cat);
      _addCategoryCircleLayer(src,cat);
      [src+'-fill',src+'-line',src+'-circle'].forEach(lid=>{
        _mapInstance.on('mouseenter',lid,()=>{_mapInstance.getCanvas().style.cursor='pointer';});
        _mapInstance.on('mouseleave',lid,()=>{_mapInstance.getCanvas().style.cursor='';});
      });
    }
  });

  // Render entries whose category isn't in cache yet (startup before tcLoadForProject completes).
  // Uses snapshotted categoryName + gray fill; colors update when categories load and re-render fires.
  const orphans=byCategory['__orphan']||[];
  if(orphans.length>0){
    const orphanByCat={};
    orphans.forEach(e=>{
      const cid=e.categoryId||e.category||'__unk';
      if(!orphanByCat[cid]) orphanByCat[cid]={name:e.categoryName||cid,entries:[]};
      orphanByCat[cid].entries.push(e);
    });
    Object.entries(orphanByCat).forEach(([cid,group])=>{
      const src='tracker-'+cid;
      const color='#888';
      const visible=_tcLayerVisible[cid]!==false;
      const geojson={type:'FeatureCollection',features:(visible?group.entries:[]).map(e=>({
        type:'Feature',id:e.id,
        properties:{id:e.id,categoryId:e.categoryId||e.category,categoryName:e.categoryName||e.category,date:e.date,acres:e.acres,measurementValue:e.measurementValue??null,measurementUnit:e.measurementUnit||null,notes:e.notes,location:e.location,phase:e.phase||null,method:e.method||null,status:e.status||null,contractor:e.contractor||null},
        geometry:e.geometry
      }))};
      if(_mapInstance.getSource(src)){
        _mapInstance.getSource(src).setData(geojson);
      } else {
        _mapInstance.addSource(src,{type:'geojson',data:geojson});
        _mapInstance.addLayer({id:src+'-fill',type:'fill',source:src,
          filter:['==',['geometry-type'],'Polygon'],
          paint:{'fill-color':color,'fill-opacity':0.35}});
        _mapInstance.addLayer({id:src+'-line',type:'line',source:src,
          filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'LineString']],
          paint:{'line-color':color,'line-width':2,'line-opacity':0.9}});
        _mapInstance.addLayer({id:src+'-circle',type:'circle',source:src,
          filter:['==',['geometry-type'],'Point'],
          paint:{'circle-color':color,'circle-radius':7,'circle-opacity':0.9,
                 'circle-stroke-color':'#fff','circle-stroke-width':1.5}});
        [src+'-fill',src+'-line',src+'-circle'].forEach(lid=>{
          _mapInstance.on('mouseenter',lid,()=>{_mapInstance.getCanvas().style.cursor='pointer';});
          _mapInstance.on('mouseleave',lid,()=>{_mapInstance.getCanvas().style.cursor='';});
        });
      }
    });
  }
}

function _showTrackerEntryPopup(lngLat,props){
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(props.id,pid):null;
  const label=props.categoryName||(typeof tcGetName==='function'?tcGetName(props.categoryId,pid):(props.categoryId||'Unknown'));
  const color=(typeof tcGetColor==='function')?tcGetColor(props.categoryId,pid):'#888';
  const measText=(props.measurementValue!=null&&props.measurementUnit)
    ?((typeof tcFormatMeasurement==='function')?tcFormatMeasurement(props.measurementValue,props.measurementUnit):(props.measurementValue+' '+props.measurementUnit))
    :(props.acres?props.acres+' ac':'');
  const photoIds=entry?.photoIds||[];
  const photos=(window._phPhotos||[]).filter(p=>photoIds.includes(p.id));
  const photoStrip=photos.length?`<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12)">
    ${photos.map(p=>`<img src="${p.thumb}" onclick="phOpenLightbox('${p.id}')" style="width:56px;height:56px;object-fit:cover;border-radius:4px;cursor:pointer;border:2px solid rgba(255,255,255,.15)">`).join('')}
  </div>`:'';
  const html=`<div style="font-family:var(--mono);font-size:12px;min-width:180px;color:#e8e8e8">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
      <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <strong style="color:#fff">${label}</strong>
    </div>
    ${props.date?`<div style="color:#dce8f4">📅 ${props.date}</div>`:''}
    ${measText?`<div style="color:#dce8f4">📐 ${measText}</div>`:''}
    ${props.location?`<div style="color:#dce8f4">📍 ${props.location}</div>`:''}
    ${props.status?`<div style="color:#dce8f4">🔧 ${props.status}</div>`:''}
    ${(props.phase&&props.phase!=='N/A')?`<div style="color:#dce8f4">🌱 ${props.phase}</div>`:''}
    ${(props.method&&props.method!=='N/A')?`<div style="color:#dce8f4">⚙️ ${props.method}</div>`:''}
    ${props.contractor?`<div style="color:#dce8f4">👷 ${props.contractor}</div>`:''}
    ${props.notes?`<div style="margin-top:6px;color:#c8d8e8;border-top:1px solid rgba(255,255,255,.1);padding-top:6px">${props.notes}</div>`:''}
    ${photoStrip}
    <div style="display:flex;gap:6px;margin-top:8px">
      <button onclick="mapEditTrackerEntry('${props.id}')" style="flex:1;background:var(--amber,#D97706);border:none;color:#111;padding:6px;border-radius:6px;font-family:var(--mono);font-size:11px;cursor:pointer;font-weight:700">✏️ Edit</button>
      <button onclick="mapDeleteTrackerEntryFromPanel('${props.id}')" style="flex:1;background:var(--s2);border:1px solid var(--border);color:var(--muted);padding:6px;border-radius:6px;font-family:var(--mono);font-size:11px;cursor:pointer;">✕ Remove</button>
    </div>
  </div>`;
  _trackerPopup=new mapboxgl.Popup({closeButton:true,closeOnClick:false,className:'gl-tracker-popup'})
    .setLngLat(lngLat).setHTML(html).addTo(_mapInstance);
}

function mapEditTrackerEntry(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  _editingEntryId=entryId;
  _pendingDrawFeature={geometry:entry.geometry};
  _drawCategory=entry.categoryId||entry.category;
  document.getElementById('map-tr-date').value=entry.date||'';
  document.getElementById('map-tr-location').value=entry.location||'';
  document.getElementById('map-tr-notes').value=entry.notes||'';
  _populateEntryDropdowns();
  const phaseEl=document.getElementById('map-tr-phase');
  const methodEl=document.getElementById('map-tr-method');
  const conEl=document.getElementById('map-tr-contractor');
  const statusElEdit=document.getElementById('map-tr-status');
  if(phaseEl) phaseEl.value=entry.phase||'N/A';
  if(methodEl) methodEl.value=entry.method||'N/A';
  if(conEl) conEl.value=entry.contractor||'';
  if(statusElEdit) statusElEdit.value=entry.status||'Installed';
  // Populate measurement field from entry (new fields or legacy acres)
  const editPid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const editCat=(typeof tcGetCategory==='function')?tcGetCategory(_drawCategory,editPid):null;
  const editMeasType=editCat?.measurementType||entry.measurementType||'area';
  const editDefUnit=editCat?.defaultUnit||(editMeasType==='linear'?'ft':'ac');
  const editAreaFields=document.getElementById('map-tr-area-fields');
  const editLinearFields=document.getElementById('map-tr-linear-fields');
  if(editAreaFields) editAreaFields.style.display=editMeasType==='linear'?'none':'';
  if(editLinearFields) editLinearFields.style.display=editMeasType==='linear'?'':'none';
  const entryUnit=entry.measurementUnit||(entry.acres!=null?'ac':'ft');
  const entryValue=entry.measurementValue!==undefined?entry.measurementValue:entry.acres;
  const measInput=document.getElementById('map-tr-acres');
  const unitSel=document.getElementById('map-tr-unit');
  const measLabel=document.getElementById('map-tr-meas-label');
  if(measLabel) measLabel.textContent=editMeasType==='linear'?'Length':'Area';
  if(unitSel){
    const opts=editMeasType==='linear'?TC_LINEAR_UNITS:TC_AREA_UNITS;
    unitSel.innerHTML=_buildUnitOpts(opts,entryUnit);
  }
  if(measInput){ measInput.value=entryValue||''; measInput.dataset.unit=entryUnit; }
  const calcSection=document.getElementById('map-tr-calc-section');
  if(calcSection) calcSection.style.display=editMeasType==='linear'?'none':'';
  const rateEl=document.getElementById('map-tr-rate');
  if(rateEl) rateEl.value='';
  const calcEl=document.getElementById('map-tr-calc-result');
  if(calcEl) calcEl.textContent='—';
  const editColor=(typeof tcGetColor==='function')?tcGetColor(_drawCategory,editPid):'#888';
  const editName=(typeof tcGetName==='function')?tcGetName(_drawCategory,editPid):(entry.categoryName||_drawCategory||'Unknown');
  document.getElementById('map-tracker-cat-dot').style.background=editColor;
  document.getElementById('map-tracker-cat-label').textContent=editName;
  _pendingPhotoIds=[...(entry.photoIds||[])];
  mapRefreshEntryPhotoStrip();
  document.getElementById('map-tracker-modal').classList.add('open');
}

function _catUnit(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(_drawCategory,pid):null;
  return cat?.targetRateUnit||'lbs/ac';
}
function mapTrackerUnitChange(){
  const unitSel=document.getElementById('map-tr-unit');
  const measInput=document.getElementById('map-tr-acres');
  if(!unitSel||!measInput) return;
  const newUnit=unitSel.value;
  const prevUnit=measInput.dataset.unit||newUnit;
  if(prevUnit===newUnit) return;
  const currentVal=parseFloat(measInput.value);
  if(currentVal&&!isNaN(currentVal)&&(typeof tcConvertMeasurement==='function')){
    const converted=tcConvertMeasurement(currentVal,prevUnit,newUnit);
    const decimals=['ft','yd','m'].includes(newUnit)?0:2;
    measInput.value=parseFloat(converted.toFixed(decimals));
  }
  measInput.dataset.unit=newUnit;
  mapTrackerCalc();
}
function mapTrackerCalc(){
  const acres=parseFloat(document.getElementById('map-tr-acres')?.value)||0;
  const rate=parseFloat(document.getElementById('map-tr-rate')?.value)||0;
  const el=document.getElementById('map-tr-calc-result');
  if(!el) return;
  if(acres>0&&rate>0){
    const unit=_catUnit();
    el.textContent=Math.round(acres*rate).toLocaleString('en-US')+' '+unit.split('/')[0];
  } else {
    el.textContent='—';
  }
}
function mapTrackerCalcInsert(){
  const rate=parseFloat(document.getElementById('map-tr-rate')?.value)||0;
  const acres=parseFloat(document.getElementById('map-tr-acres')?.value)||0;
  if(!rate||!acres) return;
  const unit=_catUnit();
  const total=Math.round(acres*rate).toLocaleString('en-US');
  const notesEl=document.getElementById('map-tr-notes');
  if(!notesEl) return;
  const line=`${rate} ${unit} × ${acres} ac = ${total} ${unit.split('/')[0]}`;
  notesEl.value=notesEl.value?(notesEl.value+'\n'+line):line;
}
function mapDeleteTrackerEntry(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  if(typeof trMarkDeletedFromMap==='function') trMarkDeletedFromMap(entryId,pid);
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  mapRenderTrackerLayers();
  mapUpdateKmlLayerList();
  if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
}
function mapToggleTrackerEntryVisibility(entryId, visible){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  if(typeof trSetMapVisibility==='function') trSetMapVisibility(entryId,visible,pid);
  mapRenderTrackerLayers();
  mapUpdateKmlLayerList();
}
function mapToggleTrackerCategoryVisibility(catId, visible){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid):[];
  entries.filter(e=>e.categoryId===catId).forEach(e=>{
    if(typeof trSetMapVisibility==='function') trSetMapVisibility(e.id,visible,pid);
  });
  mapRenderTrackerLayers();
  mapUpdateKmlLayerList();
}
function mapDeleteTrackerEntryFromPanel(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9000';
  ov.innerHTML=`<div class="modal-box" style="max-width:300px;width:88%">
    <div class="modal-title" style="margin-bottom:10px">Remove Entry</div>
    <div style="font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.5">How would you like to remove this entry?</div>
    <div class="modal-btns" style="flex-direction:column;gap:8px">
      <button id="_trpHide" class="modal-confirm" style="width:100%">Hide from Map</button>
      <button id="_trpArchive" class="modal-confirm" style="width:100%;background:#5a6a7a;">Keep in Compliance Only</button>
      <button id="_trpDel" class="modal-confirm" style="width:100%;background:#c0392b;">Delete Entirely</button>
      <button id="_trpCancel" class="modal-cancel" style="width:100%">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  document.getElementById('_trpCancel').onclick=()=>ov.remove();
  const _closePopup=()=>{if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}};
  document.getElementById('_trpHide').onclick=()=>{
    ov.remove(); _closePopup();
    if(typeof trMarkDeletedFromMap==='function') trMarkDeletedFromMap(entryId,pid);
    mapRenderTrackerLayers();
    mapUpdateKmlLayerList();
  };
  document.getElementById('_trpArchive').onclick=()=>{
    ov.remove(); _closePopup();
    if(typeof trArchiveFromMap==='function') trArchiveFromMap(entryId,pid);
    mapRenderTrackerLayers();
    mapUpdateKmlLayerList();
  };
  document.getElementById('_trpDel').onclick=()=>{
    ov.remove(); _closePopup();
    if(typeof trDeleteEntry==='function') trDeleteEntry(entryId,pid);
    mapRenderTrackerLayers();
    mapUpdateKmlLayerList();
    if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
  };
}

// ── Photo attachment for new / edit tracker entry modal ──────────────────────
function mapShowEntryPhotoPicker(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const projectPhotos=(window._phPhotos||[]).filter(p=>!p.projectId||p.projectId===pid)
    .sort((a,b)=>b.date>a.date?1:b.date<a.date?-1:b.uploadedAt-a.uploadedAt);
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9500';
  if(!projectPhotos.length){
    ov.innerHTML=`<div class="modal-box" style="max-width:300px;width:88%">
      <div class="modal-title" style="margin-bottom:10px">No Photos</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.5">Upload photos on the Photos page first, then attach them here.</div>
      <div class="modal-btns"><button class="modal-cancel" onclick="this.closest('.modal-overlay').remove()">OK</button></div>
    </div>`;
    document.body.appendChild(ov);
    return;
  }
  const thumbs=projectPhotos.map(p=>{
    const linked=_pendingPhotoIds.includes(p.id);
    return `<div id="mtrph-${p.id}" onclick="mapToggleEntryPhoto('${p.id}',this)"
      style="position:relative;cursor:pointer;border-radius:6px;border:2px solid ${linked?'var(--amber)':'transparent'};overflow:hidden;flex-shrink:0;width:80px;height:60px">
      <img src="${p.thumb}" style="width:80px;height:60px;object-fit:cover;display:block">
      <div id="mtrph-chk-${p.id}" style="position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;background:${linked?'var(--amber)':'rgba(0,0,0,.45)'};display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff">${linked?'✓':''}</div>
    </div>`;
  }).join('');
  ov.innerHTML=`<div class="modal-box" style="max-width:360px;width:92%;max-height:80vh;display:flex;flex-direction:column">
    <div class="modal-title" style="margin-bottom:12px">Attach Photos</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;flex:1;margin-bottom:12px">${thumbs}</div>
    <div class="modal-btns"><button class="modal-confirm" onclick="this.closest('.modal-overlay').remove();mapRefreshEntryPhotoStrip()">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function mapToggleEntryPhoto(photoId, el){
  if(_pendingPhotoIds.includes(photoId)){
    _pendingPhotoIds=_pendingPhotoIds.filter(id=>id!==photoId);
    el.style.borderColor='transparent';
    const chk=document.getElementById('mtrph-chk-'+photoId);
    if(chk){chk.style.background='rgba(0,0,0,.45)';chk.textContent='';}
  } else {
    _pendingPhotoIds.push(photoId);
    el.style.borderColor='var(--amber)';
    const chk=document.getElementById('mtrph-chk-'+photoId);
    if(chk){chk.style.background='var(--amber)';chk.textContent='✓';}
  }
}
function mapRefreshEntryPhotoStrip(){
  const strip=document.getElementById('map-tr-photo-strip');
  if(!strip) return;
  const photos=_pendingPhotoIds.map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
  strip.innerHTML=photos.map(p=>`
    <div style="position:relative;display:inline-block;flex-shrink:0">
      <img src="${p.thumb}" style="width:64px;height:48px;object-fit:cover;border-radius:4px;display:block">
      <button onclick="mapRemoveEntryPhoto('${p.id}')" style="position:absolute;top:-5px;right:-5px;background:#c0392b;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;color:#fff;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
    </div>`).join('');
}
function mapRemoveEntryPhoto(photoId){
  _pendingPhotoIds=_pendingPhotoIds.filter(id=>id!==photoId);
  mapRefreshEntryPhotoStrip();
}

// ── Photo → Tracker entry linking ────────────────────────────────────────────
function mapShowPhotoLinkPicker(photoId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid).filter(e=>!e.archivedFromMap):[];
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9500';
  if(!entries.length){
    ov.innerHTML=`<div class="modal-box" style="max-width:300px;width:88%">
      <div class="modal-title" style="margin-bottom:10px">No Tracker Entries</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.5">Draw a tracked area on the map first, then link photos to it.</div>
      <div class="modal-btns"><button class="modal-cancel" onclick="this.closest('.modal-overlay').remove()">OK</button></div>
    </div>`;
    document.body.appendChild(ov);
    return;
  }
  const rows=entries.map(e=>{
    const catColor=(typeof tcGetColor==='function')?tcGetColor(e.categoryId,pid):'#888';
    const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown');
    const parts=[];
    if(e.date){const p=e.date.split('-');parts.push(`${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`);}
    if(e.acres) parts.push(`${e.acres} ac`);
    const label=parts.join(' · ')||e.id.slice(0,8);
    const linked=Array.isArray(e.photoIds)&&e.photoIds.includes(photoId);
    return `<button id="mplp-${e.id}" onclick="mapLinkPhotoToEntry('${photoId}','${e.id}',this)"
      style="display:flex;align-items:center;gap:8px;width:100%;background:${linked?'rgba(255,255,255,.08)':'var(--s1)'};border:1px solid ${linked?'var(--amber)':'var(--border)'};border-radius:6px;padding:8px 10px;margin-bottom:6px;cursor:pointer;text-align:left;box-sizing:border-box">
      <div style="width:10px;height:10px;border-radius:50%;background:${catColor};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--mono);font-size:11px;color:var(--text);font-weight:600">${catName}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted)">${label}</div>
      </div>
      <div class="mplp-lbl" style="font-family:var(--mono);font-size:10px;color:var(--amber)">${linked?'✓':''}</div>
    </button>`;
  }).join('');
  ov.innerHTML=`<div class="modal-box" style="max-width:320px;width:90%;max-height:70vh;display:flex;flex-direction:column">
    <div class="modal-title" style="margin-bottom:12px">Link to Tracker Entry</div>
    <div style="overflow-y:auto;flex:1;margin-bottom:12px">${rows}</div>
    <div class="modal-btns"><button class="modal-cancel" onclick="this.closest('.modal-overlay').remove()">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function mapLinkPhotoToEntry(photoId, entryId, btn){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  const linked=entry&&Array.isArray(entry.photoIds)&&entry.photoIds.includes(photoId);
  if(linked){
    if(typeof trRemovePhotoLink==='function') trRemovePhotoLink(entryId,photoId,pid);
    btn.style.background='var(--s1)';
    btn.style.borderColor='var(--border)';
    btn.querySelector('.mplp-lbl').textContent='';
  } else {
    if(typeof trAddPhotoLink==='function') trAddPhotoLink(entryId,photoId,pid);
    btn.style.background='rgba(255,255,255,.08)';
    btn.style.borderColor='var(--amber)';
    btn.querySelector('.mplp-lbl').textContent='✓';
  }
}

// ── Expose to window for HTML onclick handlers and cross-module calls ──
window.getMapInstance = () => _mapInstance;
window.mapInit = mapInit;
window.mapResize = mapResize;
window.mapLocateMe = mapLocateMe;
window.mapSetStyle = mapSetStyle;
window.mapUpdateStyleButtons = mapUpdateStyleButtons;
window.mapSaveSettings = mapSaveSettings;
window.mapAddGPSDot = mapAddGPSDot;
window.mapSetPinFilter = mapSetPinFilter;
window.mapTogglePinDateRange = mapTogglePinDateRange;
window.mapRenderPhotoPins = mapRenderPhotoPins;
window.mapToggleLayerPanel = mapToggleLayerPanel;
window.mapShowMarkerModal = mapShowMarkerModal;
window.mapMarkerSetScope = mapMarkerSetScope;
window.mapCancelMarker = mapCancelMarker;
window.mapConfirmMarker = mapConfirmMarker;
window.mapRenderFieldMarkers = mapRenderFieldMarkers;
window.mapDeleteFieldMarker = mapDeleteFieldMarker;
window.mapHideFieldMarker = mapHideFieldMarker;
window.mapToggleFmList = mapToggleFmList;
window.mapToggleFieldMarkers = mapToggleFieldMarkers;
window.mapUpdateFieldMarkerList = mapUpdateFieldMarkerList;
window.mapImportKml = mapImportKml;
window.mapReaddKmlLayer = mapReaddKmlLayer;
window.kmlSaveLayers = kmlSaveLayers;
window.kmlParseLayerById = kmlParseLayerById;
window.kmlLoadLayers = kmlLoadLayers;
window.mapClearKmlLayers = mapClearKmlLayers;
window.mapUpdateKmlLayerList = mapUpdateKmlLayerList;
window.kmlToggleFolderVisibility = kmlToggleFolderVisibility;
window.mapToggleKmlLayer = mapToggleKmlLayer;
window.mapRemoveKmlLayer = mapRemoveKmlLayer;
window.mapRemoveKmlLayerById = mapRemoveKmlLayerById;
window.mapToggleKmlLayerById = mapToggleKmlLayerById;
window.mapToggleKmlEditMode = mapToggleKmlEditMode;
window.mapKmlToggleSelection = mapKmlToggleSelection;
window.mapKmlFolderToggleSelection = mapKmlFolderToggleSelection;
window.mapKmlToggleSelectAll = mapKmlToggleSelectAll;
window.mapBulkDeleteSelected = mapBulkDeleteSelected;
window.mapShowExportModal = mapShowExportModal;
window.mapExportKml = mapExportKml;
window.mapLoadSettingsFields = mapLoadSettingsFields;
// B2
window.mapToggleFab = mapToggleFab;
window.mapCloseFab = mapCloseFab;
window.mapToggleViewFab = mapToggleViewFab;
window.mapCloseViewFab = mapCloseViewFab;
window.mapFabImportKml = mapFabImportKml;
window.mapFabLayers = mapFabLayers;
window.mapFabDraw = mapFabDraw;
window.mapFabMeasure = mapFabMeasure;
window.mapFabGps = mapFabGps;
window.mapShowCategorySheet = mapShowCategorySheet;
window.mapCloseCategorySheet = mapCloseCategorySheet;
window.mapActivateDrawMode = mapActivateDrawMode;
window.mapDeactivateDrawMode = mapDeactivateDrawMode;
window.mapDrawSetShape = mapDrawSetShape;
window.mapShowTrackerModal = mapShowTrackerModal;
window.mapCloseTrackerModal = mapCloseTrackerModal;
window.mapCancelTrackerEntry = mapCancelTrackerEntry;
window.mapSaveTrackerEntry = mapSaveTrackerEntry;
window.mapActivateMeasure = mapActivateMeasure;
window.mapToggleGpsFollow = mapToggleGpsFollow;
window.mapResetGpsFollow = mapResetGpsFollow;
window.mapShowTrackerSheet = mapShowTrackerSheet;
window._renderTrackerSheet = _renderTrackerSheet;
window.mapCloseTrackerSheet = mapCloseTrackerSheet;
window.mapTrackerToggleLayer = mapTrackerToggleLayer;
window.mapTrackerStartEdit = mapTrackerStartEdit;
window.mapTrackerCancelEdit = mapTrackerCancelEdit;
window.mapTrackerSaveEdit = mapTrackerSaveEdit;
window.mapTrackerAskDelete = mapTrackerAskDelete;
window.mapTrackerCancelDelete = mapTrackerCancelDelete;
window.mapTrackerConfirmDelete = mapTrackerConfirmDelete;
window.mapShowCategoryDetails = mapShowCategoryDetails;
window.mapSaveCategoryDetails = mapSaveCategoryDetails;
window.mapTrackerShowAdd = mapTrackerShowAdd;
window.mapTrackerHideAdd = mapTrackerHideAdd;
window.mapTrackerSaveAdd = mapTrackerSaveAdd;
window.mapTcSetAddType   = mapTcSetAddType;
window.mapTrackerUnitChange = mapTrackerUnitChange;
window.mapShowColorPicker = mapShowColorPicker;
window.mapSelectColor = mapSelectColor;
window.mapHideColorPicker = mapHideColorPicker;
window.mapHexColorInput = mapHexColorInput;
window.mapApplyHexColor = mapApplyHexColor;
window.mapSetMeasureType = mapSetMeasureType;
window.mapNewMeasure = mapNewMeasure;
window.mapShowPhotoLinkPicker = mapShowPhotoLinkPicker;
window.mapLinkPhotoToEntry = mapLinkPhotoToEntry;
window.mapShowEntryPhotoPicker = mapShowEntryPhotoPicker;
window.mapToggleEntryPhoto = mapToggleEntryPhoto;
window.mapRefreshEntryPhotoStrip = mapRefreshEntryPhotoStrip;
window.mapRemoveEntryPhoto = mapRemoveEntryPhoto;
window.mapClearTrackerLayers = mapClearTrackerLayers;
window.mapRenderTrackerLayers = mapRenderTrackerLayers;
window.mapDeleteTrackerEntry = mapDeleteTrackerEntry;
window.mapToggleTrackerEntryVisibility = mapToggleTrackerEntryVisibility;
window.mapToggleTrackerCategoryVisibility = mapToggleTrackerCategoryVisibility;
window.mapDeleteTrackerEntryFromPanel = mapDeleteTrackerEntryFromPanel;
window.mapEditTrackerEntry = mapEditTrackerEntry;
window.mapTrackerCalc = mapTrackerCalc;
window.mapTrackerCalcInsert = mapTrackerCalcInsert;
