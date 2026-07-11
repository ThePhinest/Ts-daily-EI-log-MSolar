// ═══════════════════════════════════════════
// FIELD MAP — MAPBOX
// ═══════════════════════════════════════════
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
// Snapping ("soft magnet") to the active plan + its sibling overlays. Severable.
import { SnapPolygonMode, SnapLineMode, SnapPointMode, SnapModeDrawStyles } from 'mapbox-gl-draw-snap-mode';

// Snap source: the active planned parent PLUS every sibling overlay under it, so
// new overlays anchor to the plan AND to previous states (Lime→Fert→Seed) — no
// gaps/overlaps. Returns [] when nothing is activated. Fully guarded so it can
// never throw (the snap engine calls this on every move).
function _snapGetFeatures(){
  try{
    if(!_activePlannedEntryId) return [];
    const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
    const out=[];
    const pushGeom=(e)=>{
      if(!e||!e.geometry) return;
      let g=e.geometry; if(typeof g==='string'){ try{ g=JSON.parse(g); }catch{ return; } }
      if(g&&g.type) out.push({type:'Feature',id:'_snap-'+e.id,properties:{},geometry:g});
    };
    if(typeof trGetEntry==='function') pushGeom(trGetEntry(_activePlannedEntryId,pid));
    if(typeof trGetEntriesForProject==='function'){
      trGetEntriesForProject(pid)
        .filter(e=>e.parentId===_activePlannedEntryId && !e.deletedAt && e.id!==_activePlannedEntryId)
        .forEach(pushGeom);
    }
    return out;
  }catch{ return []; }
}

let _mapInstance=null, _mapGpsMarker=null, _mapGpsWatch=null;
let _mapCurrentStyle=localStorage.getItem('gl_map_style')||'satellite-streets-v11';

// B2 — Draw / Measure / FAB / GPS state
let _drawInstance=null, _drawMode=null, _drawCategory=null;
let _drawEntryType='installed'; // 'planned' | 'installed'
let _activePlannedEntryId=null;
// When set ({label,type}), the next drawn overlay is flagged a temporary/maintenance
// item (open lifecycle). Drawn on top of an existing drawing via the snap/anchor flow.
// Repair-flag placement mode: holds the parent entry id while the user picks the
// spot on the map (point-marker punchlist model, locked 2026-07-01).
let _placingFlagParentId=null;
let _fabOpen=false, _viewFabOpen=false, _gpsFollowActive=false, _gpsFollowWatch=null;
// GPS location/direction mode cycle: 0=off, 1=locate, 2=direction(cone,north-up), 3=heading(cone+map spins)
let _gpsMode=0, _compassActive=false, _compassHandler=null, _curHeading=0, _lastSpinTs=0, _origCompassHTML=null, _followPaused=false;
let _captureEntryId=null; // entry awaiting a framed map capture
let _pendingDrawFeature=null;
let _pendingPhotoIds=[];
let _pendingPhotoTypes={};
let _pendingPhotoCaptions={};

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
  // Tier 3: project-shared token (lead pressed "Share map token" — members.js).
  // Prefer this platform's field; fall back to the other (a web URL-restricted
  // token can 403 on the capacitor origin, but trying beats a blank map).
  if(!token&&db&&_fbReady){
    try{
      const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
      const sharedDoc=await db.collection('projects').doc(pid).collection('config').doc('mapKey').get();
      if(sharedDoc.exists){
        const sd=sharedDoc.data();
        token=((sd[firestoreField]||sd.mapboxToken||sd.mapboxTokenNative)||'').trim();
        if(token){
          localStorage.setItem(storageKey,token);
          console.log('GroundLog: using project-shared map token');
        }
      }
    }catch(e){/* not a member of a shared project / nothing shared — fall through */}
  }
  // Tier 4: platform-hosted default (appConfig/mapKey, admin-published) — a
  // brand-new user on their own project gets a working map with zero setup.
  if(!token&&db&&_fbReady){
    try{
      const hostedDoc=await db.collection('appConfig').doc('mapKey').get();
      if(hostedDoc.exists){
        const hd=hostedDoc.data();
        token=((hd[firestoreField]||hd.mapboxToken||hd.mapboxTokenNative)||'').trim();
        if(token){
          localStorage.setItem(storageKey,token);
          console.log('GroundLog: using platform default map token');
        }
      }
    }catch(e){/* hosted key unset — fall through to the no-token UI */}
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
    attributionControl:false,
    preserveDrawingBuffer:true,
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
  _mapInstance.addControl(new mapboxgl.NavigationControl({showCompass:false,showZoom:true}),'top-right');
  _mapInstance.on('rotate',()=>{
    const b=_mapInstance.getBearing();
    const needle=document.getElementById('map-compass-needle');
    if(needle) needle.style.transform=`rotate(${-b}deg)`;
    const rose=document.getElementById('map-heading-rose');
    if(rose) rose.style.transform=`rotate(${-b}deg)`; // keep N pointing true north
  });
  _mapInstance.on('load',()=>{
    document.getElementById('map-loading').style.display='none';
    setTimeout(()=>_mapInstance.resize(),100);
    mapAddGPSDot();
    mapUpdateStyleButtons();
    mapRenderPhotoPins();
    mapRenderFieldMarkers();
    kmlLoadLayers();
    if(typeof window.poLoadSheets === 'function') window.poLoadSheets();
    mapRenderTrackerLayers();
// Long press — desktop
let _lpTimer = null, _lpStartPos = null;
_mapInstance.on('mousedown', e => {
  if(e.originalEvent.button !== 0) return;
  if(typeof window.poAdjustActive === 'function' && window.poAdjustActive()) return;  // sheet-adjust drag owns the pointer
  const lngLat = e.lngLat;
  _lpTimer = setTimeout(()=>{ mapShowMarkerModal(lngLat); }, 700);
});
_mapInstance.on('mousemove', ()=> clearTimeout(_lpTimer));
_mapInstance.on('mouseup', ()=> clearTimeout(_lpTimer));
_mapInstance.on('dragstart', ()=>{ clearTimeout(_lpTimer); _lpStartPos=null; if(_gpsMode>0) _followPaused=true; });
// Long press — touch
_mapInstance.on('touchstart', e => {
  if(e.originalEvent.touches.length !== 1) return;
  if(typeof window.poAdjustActive === 'function' && window.poAdjustActive()) return;  // sheet-adjust drag owns the pointer
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
      _updateConeData(); // keep the direction cone glued to the dot's coordinate
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
  // styledata fires when the new style is applied but isStyleLoaded() may still be false.
  // GPS dot, field markers, and KML work here (Markers are HTML; KML awaits Storage so style
  // is loaded by the time addLayer runs). Tracker GL layers need isStyleLoaded()=true so
  // they wait for 'idle' which fires after full render.
  _mapInstance.once('styledata',()=>{
    if(_mapGpsMarker){_mapGpsMarker.remove();_mapGpsMarker=null;}
    mapAddGPSDot();
    mapRenderFieldMarkers();
    // Plan-sheet rasters first so they mount BELOW the KML vectors re-added next.
    if(typeof window.poReaddVisible === 'function') window.poReaddVisible();
    _mapKmlLayers.filter(l=>l.visible).forEach(layer => mapToggleKmlLayerById(layer.id, true));
  });
  _mapInstance.once('idle',()=>{
    mapRenderTrackerLayers();
    // Symbol layers (text) need glyph loading to complete before they render.
    // Wait for the map to go idle a second time (after fill/line layers trigger
    // a full render cycle and glyphs are available) then refresh date labels.
    _mapInstance.once('idle', mapRefreshDateLabels);
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
  {emoji:'📝', label:'Site Note'}
];
let _mapPinFilter = 'today';
let _mapPhotoSearch = '';

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
function mapTogglePinKeyword(){
  const input = document.getElementById('map-photo-search');
  const btn = document.getElementById('map-pin-keyword');
  if(!input) return;
  const showing = input.style.display !== 'none';
  if(showing){
    input.style.display = 'none';
    input.value = '';
    _mapPhotoSearch = '';
    mapRenderPhotoPins();
    if(btn) btn.classList.remove('active');
  } else {
    input.style.display = 'block';
    if(btn) btn.classList.add('active');
    setTimeout(()=>input.focus(), 50);
  }
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
  // Own library + other members' published photos (project mirror), deduped by id.
  const ownIds = new Set((window._phPhotos||[]).map(p => p.id));
  const pool = (window._phPhotos || []).concat(
    (window._phShared || []).filter(s => !ownIds.has(s.id)));
  const photos = pool.filter(p => {
    if(!p.lat || !p.lng) return false;
    if(pid && p.projectId !== pid) return false;
    if(_mapPinFilter === 'today') return p.date === today;
    if(_mapPinFilter === 'range'){
      if(fromDate && p.date < fromDate) return false;
      if(toDate && p.date > toDate) return false;
    }
    if(_mapPhotoSearch && !(p.caption||'').toLowerCase().includes(_mapPhotoSearch)) return false;
    return true;
  });

  photos.forEach(p => {
    const el = document.createElement('div');
    el.textContent = '📸';
    el.style.cssText = 'font-size:26px;cursor:pointer;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));line-height:1;display:block;width:30px;height:30px;text-align:center;transform-origin:bottom center';
    el.title = p.caption || p.date;

    const dirLabel = p.direction !== undefined ? `${p.direction}° ${phBearingLabel(p.direction)}` : '';
    const cleanCaption = (p.caption||'').replace(/tilt_angle[^/]*\/?\s*roll_angle[^\n]*/i,'').trim();
    const popup = new mapboxgl.Popup({ offset:20, maxWidth:'220px', closeButton:true, className:'gl-photo-popup' })
      .setHTML(`
        <div style="font-family:monospace;font-size:11px;color:#e8e8e8">
          <img src="${p.thumb}" style="width:100%;border-radius:4px;margin-bottom:8px;display:block;cursor:pointer" onclick="phOpenLightbox('${p.id}')">
          ${cleanCaption ? `<div style="font-weight:600;margin-bottom:4px;font-size:12px;color:#fff">${cleanCaption}</div>` : ''}
          <div style="color:#c8d8e8;margin-bottom:2px">${p.date}</div>
          ${dirLabel ? `<div style="color:#c8d8e8">📷 Facing ${dirLabel}</div>` : ''}
          ${p.software ? `<div style="color:#a0b8c8;margin-top:2px;font-size:10px">${p.software}</div>` : ''}
          <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.12)">
            <button onclick="mapShowPhotoLinkPicker('${p.id}')" style="background:none;border:none;color:#4FD1C5;font-family:monospace;font-size:10px;cursor:pointer;padding:0;text-decoration:underline">🔗 Link to tracker entry</button>
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
  const _fmAdd = (id, m, popupHtml) => {
    const el = document.createElement('div');
    el.textContent = m.emoji;
    el.style.cssText = 'font-size:26px;cursor:pointer;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));line-height:1;width:30px;height:30px;text-align:center;transform-origin:bottom center;';
    el.dataset.markerId = id;
    const popup = new mapboxgl.Popup({ offset:20, maxWidth:'200px', closeButton:true, className:'gl-field-popup' })
      .setHTML(popupHtml);
    const marker = new mapboxgl.Marker({ element:el, anchor:'bottom' })
      .setLngLat([m.lng, m.lat]).setPopup(popup).addTo(_mapInstance);
    if(!_fieldMarkersVisible || _hiddenMarkerIds.has(id)) marker.getElement().style.display='none';
    _mapFieldMarkers.push(marker);
  };
  const ownIds = new Set();
  try {
    const snap = await _udb().collection('fieldMarkers').get();
    snap.forEach(doc => {
      const m = doc.data();
      if(m.scope !== 'global' && m.projectName !== projectName) return;
      ownIds.add(doc.id);
      _mapFieldMarkersData.push({...m, id: doc.id});
      // Share-now: project-scoped markers publish a mirror copy to project space.
      const shareBtn = m.scope !== 'global'
        ? `<button onclick="mapShareFieldMarker('${doc.id}')" style="background:${m.published?'rgba(79,209,197,.18)':'#333'};color:${m.published?'#4FD1C5':'#fff'};border:${m.published?'1px solid #4FD1C5':'none'};padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">${m.published?'🌐 Shared ✓':'📤 Share'}</button>`
        : '';
      _fmAdd(doc.id, m, `<div style="font-family:monospace;font-size:11px;color:#e8e8e8">
          <div style="font-size:22px;margin-bottom:4px">${m.emoji}</div>
          ${m.label ? `<div style="font-weight:600;margin-bottom:4px">${m.label}</div>` : ''}
          <div style="color:#9fb0b2;margin-bottom:6px">${m.scope==='global'?'🌐 Global':'📌 This Project'}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button onclick="mapDeleteFieldMarker('${doc.id}')" style="background:#c00;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Delete</button>
            <button onclick="mapHideFieldMarker('${doc.id}')" style="background:#333;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Hide</button>
            ${shareBtn}
          </div>
        </div>`);
    });
  } catch(e){ console.error('Render field markers failed:', e); }
  // Other members' published markers (project mirror) — read-only, hideable locally.
  try {
    const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
    if(pid && pid !== 'default' && window._currentUser){
      const ssnap = await db.collection('projects').doc(pid).collection('fieldMarkers')
        .where('published','==',true).get();
      ssnap.forEach(doc => {
        if(ownIds.has(doc.id)) return;
        const m = doc.data();
        if(m.ownerUid === _currentUser.uid) return;
        _mapFieldMarkersData.push({...m, id: doc.id, shared: true});
        _fmAdd(doc.id, m, `<div style="font-family:monospace;font-size:11px;color:#e8e8e8">
            <div style="font-size:22px;margin-bottom:4px">${m.emoji}</div>
            ${m.label ? `<div style="font-weight:600;margin-bottom:4px">${m.label}</div>` : ''}
            <div style="color:#4FD1C5;margin-bottom:6px">🌐 Shared by ${(m.ownerName||'a project member').replace(/[<>&"]/g,'')}</div>
            <button onclick="mapHideFieldMarker('${doc.id}')" style="background:#333;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Hide</button>
          </div>`);
      });
    }
  } catch(e){ /* not a member of a shared project */ }
  mapUpdateFieldMarkerList();
}

// Share-now / Unshare a field marker (own, project-scoped). Uses the same
// publish-mirror helper the submit-day sheet uses.
async function mapShareFieldMarker(id){
  const m = _mapFieldMarkersData.find(x => x.id === id);
  if(!m || typeof glSetMarkersPublished !== 'function') return;
  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
  if(!pid || pid === 'default') return;
  const target = !m.published;
  await glSetMarkersPublished({ [id]: m }, [id], target, pid);
  if(typeof showCloudBanner === 'function'){
    showCloudBanner(target ? '✓ Marker shared — project members can see it now.'
      : 'Marker unshared — it\'s private again.');
  }
  mapRenderFieldMarkers();
}
window.mapShareFieldMarker = mapShareFieldMarker;

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
  const m = _mapFieldMarkersData.find(x => x.id === id);
  try { await _udb().collection('fieldMarkers').doc(id).delete(); }
  catch(e){ console.error('Delete marker failed:', e); }
  // Published marker: pull the project mirror too (members must not keep it).
  if(m && m.published){
    const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : 'default';
    if(pid && pid !== 'default'){
      db.collection('projects').doc(pid).collection('fieldMarkers').doc(id).delete().catch(()=>{});
    }
  }
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
    row.innerHTML = `<span style="font-size:16px">${m.emoji}</span><span style="flex:1">${m.label||m.emoji}</span><span style="color:var(--muted)" title="${m.shared?'Shared by a project member':(m.scope==='global'?'Global':'This project')}">${m.shared?'👥':(m.scope==='global'?'🌐':'📌')}</span>`;
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
// Every Mapbox sublayer a KML import renders as — any code that removes,
// hides, shows, or reorders a KML layer must walk this exact list.
const KML_SUBLAYER_TYPES = ['fill','line','pt','label'];

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
  // Point names as map labels. Mapbox's default collision handling declutters:
  // labels appear as you zoom in, so dense imports stay readable.
  _mapInstance.addLayer({
    id: layer.id + '-label',
    type: 'symbol',
    source: layer.id,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {'text-field':['get','name'],'text-size':11,'text-anchor':'top','text-offset':[0,0.9]},
    paint: {'text-color':'#ffffff','text-halo-color':'rgba(0,0,0,0.8)','text-halo-width':1.3}
  });
  _kmlWirePointPopup(layer.id);
}

// Tap popup for imported KML points — shows the placemark's name + description
// (house dark-popup style). Handlers are delegated by layer id, which survives
// layer remove/re-add, so wire each id exactly once.
const _kmlPopupWired = new Set();
function _kmlWirePointPopup(layerId){
  if(_kmlPopupWired.has(layerId) || !_mapInstance) return;
  _kmlPopupWired.add(layerId);
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const showPopup = (lngLat, f)=>{
    const nm = esc(f.properties.name) || 'Imported feature';
    const ds = esc(f.properties.desc);
    const popup = new mapboxgl.Popup({ offset:12, maxWidth:'280px', closeButton:true, className:'gl-field-popup' })
      .setLngLat(lngLat)
      .setHTML(`<div style="font-weight:700;font-size:13px;margin-bottom:4px;padding-right:20px">${nm}</div>`
        + (ds ? `<div style="font-size:12px;line-height:1.5;color:#cfcfcf">${ds}</div>` : ''))
      .addTo(_mapInstance);
    popup.on('close', _kmlGlowClear);
    return popup;
  };
  _mapInstance.on('click', layerId + '-pt', (e)=>{
    const f = e.features && e.features[0];
    if(!f) return;
    showPopup(f.geometry.coordinates, f);
    _kmlGlowNearestLine(f.geometry.coordinates);
  });
  _mapInstance.on('click', layerId + '-line', (e)=>{
    // if a point sits under the tap, its handler owns this click
    const pts = _mapInstance.queryRenderedFeatures(e.point, { layers: [layerId + '-pt'] });
    if(pts && pts.length) return;
    const f = e.features && e.features[0];
    if(!f || !f.geometry || f.geometry.type !== 'LineString') return;
    showPopup([e.lngLat.lng, e.lngLat.lat], f);
    _kmlGlowFeature(_kmlSourceFeatureFor(f) || { type:'Feature', geometry:f.geometry, properties:{} });
  });
  _mapInstance.on('mouseenter', layerId + '-pt', ()=>{ _mapInstance.getCanvas().style.cursor = 'pointer'; });
  _mapInstance.on('mouseleave', layerId + '-pt', ()=>{ _mapInstance.getCanvas().style.cursor = ''; });
}

// ── KML tap-glow ─────────────────────────────────────────────────────────────
// Tapping an imported point glows the boundary line it belongs to (nearest
// visible KML LineString — imported tags are snapped onto their line, so
// nearest = its own run). Tapping a line glows that line. Cleared on popup
// close. Static glow, separate source from the tracker ✨ highlight.
function _kmlEnsureGlowLayers(){
  if(!_mapInstance || _mapInstance.getSource('kml-glow')) return;
  _mapInstance.addSource('kml-glow', { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
  _mapInstance.addLayer({ id:'kml-glow-halo', type:'line', source:'kml-glow',
    paint:{ 'line-color':'#FFE680', 'line-width':13, 'line-opacity':0.45, 'line-blur':5 } });
  _mapInstance.addLayer({ id:'kml-glow-core', type:'line', source:'kml-glow',
    paint:{ 'line-color':'#FFD23F', 'line-width':3.5 } });
}
function _kmlGlowClear(){
  if(_mapInstance && _mapInstance.getSource('kml-glow')){
    try{ _mapInstance.getSource('kml-glow').setData({ type:'FeatureCollection', features:[] }); }catch(e){}
  }
}
function _kmlGlowFeature(f){
  _kmlEnsureGlowLayers();
  if(!_mapInstance.getSource('kml-glow')) return;
  _mapInstance.getSource('kml-glow').setData({ type:'FeatureCollection', features:[f] });
  ['kml-glow-halo','kml-glow-core'].forEach(id=>{ try{ _mapInstance.moveLayer(id); }catch(e){} });
}
// Rendered features come back tile-clipped; recover the full-length original
// from the in-memory layer cache by matching name + first coordinate proximity.
function _kmlSourceFeatureFor(rendered){
  const nm = rendered.properties && rendered.properties.name;
  for(const l of _mapKmlLayers){
    if(!l.features) continue;
    for(const f of l.features){
      if(f.geometry && f.geometry.type === 'LineString' && (f.properties||{}).name === nm){
        return f;
      }
    }
  }
  return null;
}
function _kmlGlowNearestLine(lngLat){
  const px = lngLat[0], py = lngLat[1];
  const cosLat = Math.cos(py * Math.PI / 180);
  let best = null;
  _mapKmlLayers.forEach(l=>{
    if(!l.visible || !l.features) return;
    l.features.forEach(f=>{
      if(!f.geometry || f.geometry.type !== 'LineString') return;
      const c = f.geometry.coordinates;
      for(let i=0; i<c.length-1; i++){
        const ax=(c[i][0]-px)*cosLat, ay=c[i][1]-py;
        const bx=(c[i+1][0]-px)*cosLat, by=c[i+1][1]-py;
        const dx=bx-ax, dy=by-ay;
        const L2=dx*dx+dy*dy;
        let t = L2 ? -(ax*dx+ay*dy)/L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx=ax+t*dx, qy=ay+t*dy;
        const d=qx*qx+qy*qy;
        if(best===null || d<best.d) best={ d, f };
      }
    });
  });
  if(best) _kmlGlowFeature(best.f);
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
    visible: l.visible, storagePath: l.storagePath || '',
    downloadUrl: l.downloadUrl || ''
  }));
  try { if(window.idbSet) window.idbSet(_kmlStorageKey(), JSON.stringify(data)); } catch {}  // Tier-1 IDB cache (Firestore fallback)
  if(db && _fbReady){
    // Personal copy (per-layer visibility = view state) — user subtree, never shared.
    _projDataUser(pid).collection('kml').doc('layers')
      .set({ data, _ts: Date.now() })
      .catch(e => console.warn('kmlSaveLayers:', e.message));
    // Shared-project mirror — KML layers are live-visible reference data for
    // members (submission-sharing-model visibility matrix). Rules let only the
    // owner/lead land this write; a member's local visibility toggles are
    // denied here and stay their own view state. Silent on purpose.
    if(window._currentUser){
      db.collection('projects').doc(pid).collection('kmlLayers').doc('layers')
        .set({ data, ownerUid: _currentUser.uid, _ts: Date.now() })
        .catch(() => {});
    }
  }
}

// Fetch a KML file's text. Own files: Storage ref by path. Another member's
// files: Storage rules deny foreign paths — fall back to the token downloadUrl
// persisted in layer metadata (same capability model photos already use).
async function _kmlFetchKmlText(storagePath, layers){
  let lastErr = null;
  if(storage && storagePath){
    try{
      const url = await storage.ref(storagePath).getDownloadURL();
      const res = await fetch(url);
      if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText||''));
      // Owner path succeeded — stamp the token URL so project members can
      // fetch this file without Storage access. Persisted by the caller.
      if(layers && layers.length && !layers.find(l => l.downloadUrl)){
        layers.forEach(l => { l.downloadUrl = url; });
        window._kmlUrlBackfillPending = true;
      }
      return await res.text();
    }catch(err){ lastErr = err; }
  }
  const dl = layers && layers.find(l => l.downloadUrl);
  if(dl){
    const res = await fetch(dl.downloadUrl);
    if(!res.ok) throw new Error('HTTP ' + res.status + ' (shared url)');
    return await res.text();
  }
  throw (lastErr || new Error('no KML fetch path available'));
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
    const desc = pm.querySelector('description')?.textContent?.trim() || '';
    const poly = pm.querySelector('Polygon outerBoundaryIs coordinates') || pm.querySelector('Polygon coordinates');
    const line = pm.querySelector('LineString coordinates');
    const pt   = pm.querySelector('Point coordinates');
    if(poly){
      const c = poly.textContent.trim().split(/\s+/).map(s=>s.split(',').map(Number).slice(0,2));
      features.push({type:'Feature',properties:{name,desc},geometry:{type:'Polygon',coordinates:[c]}});
    } else if(line){
      const c = line.textContent.trim().split(/\s+/).map(s=>s.split(',').map(Number).slice(0,2));
      features.push({type:'Feature',properties:{name,desc},geometry:{type:'LineString',coordinates:c}});
    } else if(pt){
      const [lng,lat] = pt.textContent.trim().split(',').map(Number);
      features.push({type:'Feature',properties:{name,desc},geometry:{type:'Point',coordinates:[lng,lat]}});
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
    KML_SUBLAYER_TYPES.forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
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
      const doc = await _projDataUser(pid).collection('kml').doc('layers').get();
      if(doc.exists) data = doc.data().data;
    } catch(e){ console.warn('kmlLoadLayers cloud:', e.message); }
    // Shared-project layer set (live reference data, member-readable). The
    // shared set is canonical for the layer LIST; the user's own copy only
    // overlays per-layer visibility (view state is personal, never shared).
    try {
      const sdoc = await db.collection('projects').doc(pid).collection('kmlLayers').doc('layers').get();
      if(sdoc.exists && Array.isArray(sdoc.data().data) && sdoc.data().data.length){
        const shared = sdoc.data().data;
        const ownById = new Map((data || []).map(l => [l.id, l]));
        const merged = shared.map(s => ownById.has(s.id) ? { ...s, visible: ownById.get(s.id).visible } : s);
        (data || []).forEach(o => { if(!shared.find(s => s.id === o.id)) merged.push(o); });
        data = merged;
      }
    } catch(e){ /* not a member of a shared project — own copy stands */ }
  }
  if(!data){ try { const raw = window.idbGet && window.idbGet(_kmlStorageKey()); if(raw) data = JSON.parse(raw); } catch {} }
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

    // Fetch KML once for this file (own Storage path, or shared downloadUrl)
    let kmlText = null;
    try{
      kmlText = await _kmlFetchKmlText(storagePath, layers);
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
  // Owner-side: persist freshly-stamped downloadUrls (also stamping hidden
  // groups, so members can fetch files the owner hasn't viewed this session).
  if(window._kmlUrlBackfillPending){
    window._kmlUrlBackfillPending = false;
    if(storage){
      for(const [path, ls] of Object.entries(byPath)){
        if(path && !ls.find(l => l.downloadUrl)){
          try{
            const u = await storage.ref(path).getDownloadURL();
            ls.forEach(l => {
              l.downloadUrl = u;
              const reg = _mapKmlLayers.find(r => r.id === l.id);
              if(reg) reg.downloadUrl = u;
            });
          }catch(e){ /* foreign/hidden path — skip */ }
        }
      }
    }
    kmlSaveLayers();
  }
  mapUpdateKmlLayerList();
}

// Remembered folder collapse state for the layers slide-out. The list rebuilds on
// every mapUpdateKmlLayerList() call, so without this the user's collapse choices
// reset on each re-render and on slide-out close/reopen. Project-scoped; persisted.
let _mapFolderCollapsed={key:null,set:null};
function _folderCollapseSet(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const k='gl_layerFolderCollapsed_'+pid;
  if(_mapFolderCollapsed.key!==k){
    let set;
    try{ set=new Set(JSON.parse(localStorage.getItem(k)||'[]')); }catch{ set=new Set(); }
    _mapFolderCollapsed={key:k,set};
  }
  return _mapFolderCollapsed.set;
}
function _isFolderCollapsed(fid){ return _folderCollapseSet().has(fid); }
function _setFolderCollapsed(fid, collapsed){
  const set=_folderCollapseSet();
  if(collapsed) set.add(fid); else set.delete(fid);
  try{ localStorage.setItem(_mapFolderCollapsed.key, JSON.stringify([...set])); }catch{}
}

// ── Tracker legend overlay (screenshot/export color key) ─────────────────────
// Per-category, one at a time: triggered from a drawing's popup, shows just THAT
// category's state color key on the map so the user can screenshot a self-keyed
// "map version of tracking". Showing a new one replaces the previous.
let _legendCatId=null;
function mapShowCategoryLegend(catId){
  if(!catId) return;
  _legendCatId=catId;
  const box=document.getElementById('map-legend');
  if(box) box.style.display='block';
  mapRenderLegend();
  if(typeof _trackerPopup!=='undefined' && _trackerPopup){ try{ _trackerPopup.remove(); }catch{} }
}
function mapHideLegend(){
  _legendCatId=null;
  const box=document.getElementById('map-legend');
  if(box) box.style.display='none';
}
function mapRenderLegend(){
  const box=document.getElementById('map-legend');
  const body=document.getElementById('map-legend-body');
  const titleEl=document.getElementById('map-legend-title');
  if(!box||!body||!_legendCatId||box.style.display==='none') return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(_legendCatId,pid):null;
  if(!cat){ mapHideLegend(); return; }
  if(titleEl) titleEl.textContent=cat.name;
  const states=(typeof tcGetStates==='function')?tcGetStates(cat,pid):[];
  body.innerHTML=states.map(s=>{
    const col=(s.color&&/^#[0-9A-Fa-f]{6}$/.test(s.color))?s.color:'#888888';
    return `<div style="display:flex;align-items:center;gap:6px;margin:3px 0">
      <span style="width:13px;height:13px;border-radius:3px;background:${col};flex-shrink:0;opacity:${s.isPlanned?'0.5':'1'};border:1px solid rgba(255,255,255,0.18)"></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--text);white-space:nowrap">${s.label}${s.isPlanned?' · planned':''}</span>
    </div>`;
  }).join('');
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
      <button onclick="mapPromoteKmlLayer('${layer.id}')" title="Adopt this layer's lines as a planned tracker category (silt fence from a plan, LOD spans…)" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:0 2px;">⇪</button>
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
  const _kflPid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const _kflOrder=_getKmlFolderOrder(_kflPid);
  const _kflSorted=Object.entries(folders).sort(([a],[b])=>{
    const ai=_kflOrder.indexOf(a), bi=_kflOrder.indexOf(b);
    if(ai<0&&bi<0) return 0;
    if(ai<0) return 1;
    if(bi<0) return -1;
    return ai-bi;
  });
  _kflSorted.forEach(([folderName, layers])=>{
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
      <span style="font-family:var(--mono);font-size:11px;color:var(--amber2);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${folderName}">📁 ${folderName}</span>
      <button onclick="event.stopPropagation();mapMoveKmlFolderOrder('${folderName.replace(/'/g,"\\'")}','up')" title="Bring forward" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:0 1px;line-height:1;flex-shrink:0">↑</button>
      <button onclick="event.stopPropagation();mapMoveKmlFolderOrder('${folderName.replace(/'/g,"\\'")}','down')" title="Send back" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:0 1px;line-height:1;flex-shrink:0">↓</button>`;
    const children = document.createElement('div');
    children.id = folderId+'-children';
    children.style.cssText = 'padding:4px 6px 4px 16px;';
    layers.forEach(layer => children.appendChild(makeLayerRow(layer)));
    // Apply remembered collapse state.
    if(_isFolderCollapsed(folderId)){
      children.style.display='none';
      const ch=header.querySelector(`#${folderId}-chev`); if(ch) ch.textContent='▸';
    }
    // Collapse toggle
    header.addEventListener('click', function(e){
      if(e.target.type==='checkbox') return;
      const collapsed = children.style.display==='none';
      children.style.display = collapsed ? '' : 'none';
      document.getElementById(folderId+'-chev').textContent = collapsed ? '▾' : '▸';
      _setFolderCollapsed(folderId, !collapsed);
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
        ${catEntries.some(e=>e.deletedFromMap)?`<span style="font-family:var(--mono);font-size:9px;color:var(--amber);white-space:nowrap;">${catEntries.filter(e=>e.deletedFromMap).length} hidden</span>`:''}
        <span style="font-family:var(--mono);font-size:9px;color:var(--muted);">${catEntries.length}</span>
        <button onclick="event.stopPropagation();mapHighlightCategory('${cat.id}')" title="Highlight this category on the map" style="background:none;border:none;color:var(--amber);cursor:pointer;font-size:12px;padding:0 2px;line-height:1">✨</button>
        <button onclick="event.stopPropagation();mapMoveCatLayerOrder('${cat.id}','up')" title="Bring forward" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:0 2px;line-height:1">↑</button>
        <button onclick="event.stopPropagation();mapMoveCatLayerOrder('${cat.id}','down')" title="Send back" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:0 2px;line-height:1">↓</button>`;
      const kids=document.createElement('div');
      kids.id=fid+'-children';
      kids.style.cssText='padding:4px 6px 4px 16px;';
      const _trEntryRow=(e)=>{
        const visible=!e.deletedFromMap;
        const row=document.createElement('div');
        row.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s1);border-radius:6px;margin-bottom:4px;';
        // Richer labels so hidden items are identifiable: planned entries carry a
        // PLAN tag, and location shows alongside acreage instead of only without it.
        const parts=[];
        if(e.entryType==='planned') parts.push('PLAN');
        if(e.date){const p=e.date.split('-');parts.push(`${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`);}
        if(e.acres) parts.push(`${e.acres} ac`);
        if(e.location) parts.push(e.location);
        const label=parts.join(' · ')||e.id.slice(0,8);
        row.innerHTML=`
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:11px;color:${visible?'var(--text)':'var(--muted)'};flex:1;min-width:0;">
            <input type="checkbox" ${visible?'checked':''} onchange="mapToggleTrackerEntryVisibility('${e.id}',this.checked)">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>
          </label>
          <button onclick="mapEditTrackerEntry('${e.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:0 4px;" title="Edit">✏</button>
          <button onclick="mapDeleteTrackerEntryFromPanel('${e.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;" title="Delete">✕</button>`;
        kids.appendChild(row);
      };
      // Visible drawings first, then hidden ones grouped under their own divider so
      // re-finding and re-adding hidden items is one glance + one tap (Tim 7/11).
      catEntries.filter(e=>!e.deletedFromMap).forEach(_trEntryRow);
      const hiddenEntries=catEntries.filter(e=>e.deletedFromMap);
      if(hiddenEntries.length){
        const div=document.createElement('div');
        div.style.cssText='display:flex;align-items:center;gap:6px;margin:6px 0 4px;font-family:var(--mono);font-size:9px;color:var(--amber);letter-spacing:.06em;text-transform:uppercase;';
        div.innerHTML=`<span style="flex-shrink:0;">Hidden (${hiddenEntries.length})</span><span style="flex:1;border-top:1px solid var(--border);"></span>`;
        kids.appendChild(div);
        hiddenEntries.forEach(_trEntryRow);
      }
      // Apply remembered collapse state.
      if(_isFolderCollapsed(fid)){
        kids.style.display='none';
        const ch=hdr.querySelector(`#${fid}-chev`); if(ch) ch.textContent='▸';
      }
      hdr.addEventListener('click',function(ev){
        if(ev.target.type==='checkbox') return;
        const collapsed=kids.style.display==='none';
        kids.style.display=collapsed?'':'none';
        const chev=document.getElementById(fid+'-chev');
        if(chev) chev.textContent=collapsed?'▾':'▸';
        _setFolderCollapsed(fid, !collapsed);
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
      KML_SUBLAYER_TYPES.forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
      if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
    } else {
      if(!_mapInstance.getSource(layer.id)){
        if(layer.features && layer.features.length){
          mapReaddKmlLayer(layer, layer.features);
        } else if(layer.storagePath || layer.downloadUrl){
          try{
            const kmlText = await _kmlFetchKmlText(layer.storagePath, [layer]);
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
    KML_SUBLAYER_TYPES.forEach(t=>{
      if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t);
    });
    if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  } else {
    // Fetch and render on demand if not already on map
    if(!_mapInstance.getSource(layer.id)){
      if(layer.features && layer.features.length){
        mapReaddKmlLayer(layer, layer.features);
      } else if(layer.storagePath || layer.downloadUrl){
        try{
          const kmlText = await _kmlFetchKmlText(layer.storagePath, [layer]);
          const features = await _kmlReparseFeaturesForLayer(kmlText, layer);
          layer.features = features;
          mapReaddKmlLayer(layer, features);
        }catch(err){ console.warn('mapToggleKmlLayer fetch failed:', err.message); }
      }
    } else {
      KML_SUBLAYER_TYPES.forEach(t=>{
        if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.setLayoutProperty(layer.id+'-'+t,'visibility','visible');
      });
    }
  }
  kmlSaveLayers();
}

function mapRemoveKmlLayer(i){
  const layer = _mapKmlLayers[i];
  KML_SUBLAYER_TYPES.forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
  if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  _mapKmlLayers.splice(i,1);
  kmlSaveLayers();
  mapUpdateKmlLayerList();
}
function mapRemoveKmlLayerById(id){
  const layer = _mapKmlLayers.find(l=>l.id===id);
  if(!layer) return;
  // Deleting a layer is destructive for every member — confirm first (delta 7/2).
  document.getElementById('_kml-del-ov')?.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay'; ov.id = '_kml-del-ov';
  ov.style.cssText = 'z-index:9000';
  ov.innerHTML = `<div class="modal-box" style="max-width:320px;width:90%">
    <div class="modal-title" style="margin-bottom:8px">Delete map layer?</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5"><b>${String(layer.name).replace(/</g,'&lt;')}</b> is removed from the map for every project member. Tracker drawings adopted or traced from it are NOT affected.</div>
    <div class="modal-btns">
      <button class="modal-confirm" id="_kml-del-go" style="background:#3d1414;border:1px solid #6b2020;color:#ff8080">✕ Delete layer</button>
      <button class="modal-cancel" id="_kml-del-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#_kml-del-cancel').onclick = () => ov.remove();
  ov.addEventListener('click', ev => { if(ev.target === ov) ov.remove(); });
  ov.querySelector('#_kml-del-go').onclick = () => { ov.remove(); _mapRemoveKmlLayerNow(id); };
}
function _mapRemoveKmlLayerNow(id){
  const idx = _mapKmlLayers.findIndex(l=>l.id===id);
  if(idx===-1) return;
  const layer = _mapKmlLayers[idx];
  KML_SUBLAYER_TYPES.forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
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
    KML_SUBLAYER_TYPES.forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
    if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  } else {
    if(!_mapInstance.getSource(layer.id)){
      if(layer.features && layer.features.length){
        mapReaddKmlLayer(layer, layer.features);
      } else if(layer.storagePath || layer.downloadUrl){
        try{
          const kmlText = await _kmlFetchKmlText(layer.storagePath, [layer]);
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

// ── KML → planned tracker category (adoption seam, 2026-07-01) ──
// Turns an imported KML layer's LINE features into PLANNED drawings in a linear
// category — the import half of the silt-fence auto-draw pipeline (extract lines
// from the E&S plan → KML → import → adopt as the plan, no hand-tracing). Each
// LineString becomes one planned entry measured in ft (turf).
async function mapPromoteKmlLayer(layerId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const layer=_mapKmlLayers.find(l=>l.id===layerId);
  if(!layer) return;
  // Features may not be loaded yet (metadata-only restore) — same load path as toggle ON.
  if(!(layer.features&&layer.features.length)&&(layer.storagePath||layer.downloadUrl)){
    try{
      const kmlText=await _kmlFetchKmlText(layer.storagePath,[layer]);
      layer.features=await _kmlReparseFeaturesForLayer(kmlText,layer);
    }catch(err){ console.warn('mapPromoteKmlLayer load:',err.message); }
  }
  const feats=(layer.features||[]).filter(f=>f&&f.geometry&&(f.geometry.type==='LineString'||f.geometry.type==='MultiLineString'));
  const skipped=(layer.features||[]).length-feats.length;
  if(!feats.length){
    if(typeof showCloudBanner==='function') showCloudBanner('No line features in this layer — adopting areas/points isn\'t supported yet.');
    return;
  }
  // Pick a target category: existing linear categories + create-new (template default).
  const cats=((typeof tcGetCategories==='function')?tcGetCategories(pid):[])
    .filter(c=>((typeof tcGetMeasurementType==='function')?tcGetMeasurementType(c.id,pid):'')==='linear');
  document.getElementById('_pk-ov')?.remove();
  const ov=document.createElement('div');
  ov.className='modal-overlay'; ov.id='_pk-ov';
  ov.style.cssText='z-index:9000';
  ov.innerHTML=`<div class="modal-box" style="max-width:340px;width:90%">
    <div class="modal-title" style="margin-bottom:8px">⇪ Adopt as planned category</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5"><b>${String(layer.name).replace(/</g,'&lt;')}</b> — ${feats.length} line${feats.length>1?'s':''}${skipped>0?` (${skipped} non-line feature${skipped>1?'s':''} skipped)`:''}. Each line becomes a <b>planned</b> drawing you can install / flag against.</div>
    <label style="${_LABEL_STYLE}">Into category</label>
    <select id="_pk-cat" style="${_INPUT_STYLE}width:100%;box-sizing:border-box;margin-bottom:10px">
      <option value="__new">＋ New category — "${String(layer.name).replace(/"/g,'&quot;').slice(0,30)}"</option>
      ${cats.map(c=>`<option value="${c.id}">${(typeof tcGetName==='function')?tcGetName(c.id,pid):c.id}</option>`).join('')}
    </select>
    <div class="modal-btns">
      <button class="modal-confirm" id="_pk-go">⇪ Adopt ${feats.length} line${feats.length>1?'s':''}</button>
      <button class="modal-cancel" id="_pk-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#_pk-cancel').onclick=()=>ov.remove();
  ov.addEventListener('click',ev=>{ if(ev.target===ov) ov.remove(); });
  ov.querySelector('#_pk-go').onclick=async()=>{
    const sel=ov.querySelector('#_pk-cat').value;
    ov.remove();
    let catId=sel, catName;
    if(sel==='__new'){
      if(typeof tcTemplateSchema!=='function'||typeof tcSaveCategory!=='function') return;
      const schema=tcTemplateSchema('linear-bmp','linear');
      const color='#4A90E2';
      if(schema.states&&schema.states[0]) schema.states[0].color='#8E9BA3';
      const cat=await tcSaveCategory({...schema,template:'linear-bmp',name:String(layer.name).slice(0,40),color,measurementType:'linear',defaultUnit:'ft'},pid);
      if(!cat){ if(typeof showCloudBanner==='function') showCloudBanner('Couldn\'t create the category (needs a real project).'); return; }
      catId=cat.id; catName=cat.name;
    } else {
      catName=(typeof tcGetName==='function')?tcGetName(catId,pid):'';
    }
    const today=document.getElementById('reportDate')?.value||new Date().toLocaleDateString('en-CA');
    let count=0, totalFt=0;
    for(const f of feats){
      const ft=(typeof glLineLengthFt==='function')?glLineLengthFt(f.geometry):0;
      const centroid=_geoCentroid({geometry:f.geometry});
      const nameProp=(f.properties&&(f.properties.name||f.properties.Name))||null;
      const entry={
        date:today, categoryId:catId, categoryName:catName, measurementType:'linear',
        geometry:f.geometry,
        centroidLng:centroid?centroid.lng:null, centroidLat:centroid?centroid.lat:null,
        acres:null, measurementValue:ft?Math.round(ft):null, measurementUnit:'ft',
        location:nameProp, phase:null, method:null, status:'Planned', contractor:null,
        fields:{}, seedMix:null, showDateLabel:false, labelText:null, labelColor:null,
        notes:'Adopted from KML layer "'+layer.name+'"',
        photoIds:[], photoTypes:{}, photoCaptions:{},
        entryType:'planned', parentId:null, state:null,
      };
      if((typeof trSaveEntry==='function')?trSaveEntry(entry,pid):null){ count++; totalFt+=ft; }
    }
    mapRenderTrackerLayers();
    mapUpdateKmlLayerList();
    if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
    if(typeof showCloudBanner==='function') showCloudBanner(`⇪ Adopted ${count} planned line${count>1?'s':''} (~${Math.round(totalFt).toLocaleString()} ft) into "${catName}".`);
  };
}
window.mapPromoteKmlLayer=mapPromoteKmlLayer;

// B2 Stage 1.4 — called from projects.js loadProject() on project switch.
// Tears down all KML sources/layers + clears in-memory state, then triggers
// kmlLoadLayers() to rehydrate from the new project's per-project cache.
function mapClearKmlLayers(){
  _kmlGlowClear();
  if(_mapInstance){
    _mapKmlLayers.forEach(layer => {
      KML_SUBLAYER_TYPES.forEach(t => {
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
function mapResetNorth(){
  if(_mapInstance) _mapInstance.resetNorth({duration:300});
}
function mapToggleFab(){
  mapCloseViewFab();
  _fabOpen=!_fabOpen;
  document.getElementById('map-fab').classList.toggle('open',_fabOpen);
  document.getElementById('map-fab-palette').classList.toggle('open',_fabOpen);
  document.getElementById('map-compass')?.classList.toggle('fab-open',_fabOpen);
  if(_fabOpen&&typeof _syncFlagFabBtn==='function') _syncFlagFabBtn();
}
function mapCloseFab(){
  _fabOpen=false;
  document.getElementById('map-fab').classList.remove('open');
  document.getElementById('map-fab-palette').classList.remove('open');
  document.getElementById('map-compass')?.classList.remove('fab-open');
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
  mapCycleGpsMode();
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
      <div class="map-cat-pill" onclick="mapSelectCategoryForDraw('${c.id}')">
        <div class="map-cat-dot" style="background:${c.color||'#888'}"></div>
        <span>${c.name}</span>
      </div>`).join('');
  }
  document.getElementById('map-category-sheet').classList.add('open');
}
function mapSelectCategoryForDraw(catId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=catId?((typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null):null;
  const name=cat?cat.name:'Uncategorized';
  const color=cat?(cat.color||'#888'):'#555';
  const list=document.getElementById('map-category-list');
  const noPlan=(typeof tcNoPlan==='function')?tcNoPlan(cat,pid):false;
  const header=`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <button onclick="mapShowCategorySheet()" style="background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:0;line-height:1">‹</button>
      <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <span style="font-family:var(--mono);font-size:13px;color:var(--text);font-weight:600">${name}</span>
    </div>`;
  // No-plan categories (e.g. SWPPP disturbance) skip the plan step — one Draw button that
  // goes straight to the default state (Active disturbed); the state picker handles the rest.
  if(noPlan){
    const ds=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cat,pid):null;
    list.innerHTML=header+`
    <button onclick="mapActivateDrawModeTyped('${catId}','installed')" style="width:100%;background:rgba(230,126,34,0.12);border:1px solid #E67E22;border-radius:8px;padding:12px;color:var(--text);font-family:var(--mono);font-size:12px;cursor:pointer;text-align:left;font-weight:700">
      ✏️ Draw${ds?` — ${ds.label}`:''}
      <div style="font-size:10px;color:var(--muted);font-weight:400;margin-top:3px">Draws straight to a state — pick the state in the entry form (default ${ds?ds.label:'first'}). No plan needed.</div>
    </button>`;
    return;
  }
  list.innerHTML=header+`
    <button onclick="mapActivateDrawModeTyped('${catId}','planned')" style="width:100%;background:rgba(201,168,76,0.1);border:1px solid var(--amber);border-radius:8px;padding:12px;color:var(--amber);font-family:var(--mono);font-size:12px;cursor:pointer;text-align:left;margin-bottom:8px;font-weight:700">
      📍 Draw Planned Area
      <div style="font-size:10px;color:var(--muted);font-weight:400;margin-top:3px">Define the full scope — rate × area sets required amount</div>
    </button>
    <button onclick="mapActivateDrawModeTyped('${catId}','installed')" style="width:100%;background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text);font-family:var(--mono);font-size:12px;cursor:pointer;text-align:left;font-weight:700">
      ✏️ Draw Installed
      <div style="font-size:10px;color:var(--muted);font-weight:400;margin-top:3px">Record actual work — link to a planned area to track progress</div>
    </button>`;
}
function mapActivateDrawModeTyped(catId, entryType){
  _drawEntryType=entryType||'installed';
  mapActivateDrawMode(catId);
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
let _trSessionDate=null; // user-chosen entry date for the current drawing session
let _renderedOrphanCids=new Set(); // tracks orphan source IDs currently on the map
let _tcLayerVisible={};       // { [catId]: boolean } — default true
function _getTcLayerOrder(pid){ try{ return JSON.parse(localStorage.getItem('gl_tc_order_'+pid)||'[]'); }catch{ return []; } }
function _setTcLayerOrder(order,pid){ try{ localStorage.setItem('gl_tc_order_'+pid,JSON.stringify(order)); }catch{} }
function _getKmlFolderOrder(pid){ try{ return JSON.parse(localStorage.getItem('gl_kfl_order_'+pid)||'[]'); }catch{ return []; } }
function _setKmlFolderOrder(order,pid){ try{ localStorage.setItem('gl_kfl_order_'+pid,JSON.stringify(order)); }catch{} }
function _applyKmlFolderMapOrder(){
  if(!_mapInstance) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const folderNames=[...new Set(_mapKmlLayers.map(l=>l.folderName).filter(Boolean))];
  const order=_getKmlFolderOrder(pid);
  const sorted=[...folderNames.filter(f=>order.includes(f)).sort((a,b)=>order.indexOf(a)-order.indexOf(b)),
                ...folderNames.filter(f=>!order.includes(f))];
  sorted.forEach(folderName=>{
    _mapKmlLayers.filter(l=>l.folderName===folderName&&l.visible).forEach(layer=>{
      KML_SUBLAYER_TYPES.forEach(t=>{
        if(_mapInstance.getLayer(layer.id+'-'+t)) try{_mapInstance.moveLayer(layer.id+'-'+t);}catch(e){}
      });
    });
  });
}
function mapMoveKmlFolderOrder(folderName, dir){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const folderNames=[...new Set(_mapKmlLayers.map(l=>l.folderName).filter(Boolean))];
  let order=_getKmlFolderOrder(pid);
  if(!order.length) order=[...folderNames];
  folderNames.forEach(f=>{ if(!order.includes(f)) order.push(f); });
  const idx=order.indexOf(folderName);
  if(idx<0) return;
  if(dir==='up'&&idx<order.length-1){ const t=order[idx+1];order[idx+1]=order[idx];order[idx]=t; }
  if(dir==='down'&&idx>0){ const t=order[idx-1];order[idx-1]=order[idx];order[idx]=t; }
  _setKmlFolderOrder(order,pid);
  mapUpdateKmlLayerList();
  _applyKmlFolderMapOrder();
}
function _sortCatsByOrder(cats,pid){
  const order=_getTcLayerOrder(pid);
  if(!order.length) return cats;
  const indexed=cats.filter(c=>order.includes(c.id)).sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
  const rest=cats.filter(c=>!order.includes(c.id));
  return [...indexed,...rest];
}
let _tcEditingCatId=null;     // id of category being inline-edited
let _tcEditingColor=null;     // color staged for edit row (hex string)
let _tcAddingColor=null;      // color staged for add row (hex string)
let _tcConfirmDeleteId=null;  // id of category awaiting inline delete confirm
let _tcColorTarget=null;      // 'add'|'edit' — which swatch the picker is serving
let _tcAddingType='area';     // 'area'|'linear' — staged for add row
let _tcAddingTemplate='seeding'; // template seed for the add row (2026-06-03)

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
  const cats=_sortCatsByOrder((typeof tcGetCategories==='function')?tcGetCategories(pid):[],pid);
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
          <input type="color" class="map-tc-edit-color" id="map-tc-edit-preview" value="${(_tcEditingColor&&/^#[0-9A-Fa-f]{6}$/.test(_tcEditingColor))?_tcEditingColor:((c.color&&/^#[0-9A-Fa-f]{6}$/.test(c.color))?c.color:'#888888')}" oninput="window.mapSetEditColor&&window.mapSetEditColor(this.value)" title="Category color" style="padding:0">
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
        ${(typeof tcRampChip==='function')?tcRampChip(c,pid,12):`<div class="map-tc-dot" style="background:${c.color||'#888'}"></div>`}
        <span class="map-tc-name" style="color:var(--muted)">Delete "${c.name}"?</span>
        <button onclick="mapTrackerConfirmDelete('${c.id}')" class="map-tc-save-btn" style="background:#c0392b;color:#fff">Yes</button>
        <button onclick="mapTrackerCancelDelete()" class="map-tc-cancel-btn">No</button>
      </div>`;
    }
    const hasDetails=c.measurementType==='linear'
      ?(c.specification||c.supplier)
      :(c.productName||c.targetRate||(c.amendmentType&&c.amendmentType!=='None'));
    const typeBadge=`<span style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:3px 6px;border:1px solid var(--border);border-radius:3px;white-space:nowrap">${c.measurementType==='linear'?'LN':'AC'}</span>`;
    return `<div class="map-tc-row">
      ${(typeof tcRampChip==='function')?tcRampChip(c,pid,12):`<div class="map-tc-dot" style="background:${c.color||'#888'}"></div>`}
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
function mapMoveCatLayerOrder(catId, dir){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];
  let order=_getTcLayerOrder(pid);
  // Seed order with all cat IDs if empty
  if(!order.length) order=cats.map(c=>c.id);
  // Ensure catId is in order
  if(!order.includes(catId)) order.push(catId);
  const idx=order.indexOf(catId);
  if(dir==='up'&&idx<order.length-1){ const t=order[idx+1];order[idx+1]=order[idx];order[idx]=t; }
  if(dir==='down'&&idx>0){ const t=order[idx-1];order[idx-1]=order[idx];order[idx]=t; }
  _setTcLayerOrder(order,pid);
  _renderTrackerSheet();
  mapRenderTrackerLayers();
  if(_layerPanelOpen) mapUpdateKmlLayerList();
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
  const _editColor=_tcEditingColor||existing.color;
  // Keep the plan (first) state's color = the category identity color (Part 1).
  const _editStates=(Array.isArray(existing.states)&&existing.states.length)
    ? existing.states.map(s=>s.isPlanned?{...s,color:_editColor}:s) : existing.states;
  await tcSaveCategory({...existing,name,color:_editColor,...(_editStates?{states:_editStates}:{}),defaultUnit:editedUnit,lineStyle:editedLineStyle,lineWidth:editedLineWidth,fillStyle:editedFillStyle,fillOpacity:editedFillOpacity},pid);
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
  // Cascade: soft-delete every entry in this category so it also clears from the
  // map AND the compliance/tracker-log surfaces (was leaving orphaned drawings).
  if(typeof trGetEntriesForProject==='function' && typeof trDeleteEntry==='function'){
    trGetEntriesForProject(pid)
      .filter(e=>(e.categoryId===catId)||(e.category===catId))
      .forEach(e=>{ try{ trDeleteEntry(e.id,pid); }catch{} });
  }
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
  if(typeof mapRenderTrackerLayers==='function') mapRenderTrackerLayers();
  if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
}

// ── Category details modal ────────────────
const _INPUT_STYLE='width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:9px 10px;color:var(--text);font-family:var(--mono);font-size:13px';
const _LABEL_STYLE='font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:5px';
// Plain-language hint under a control (used by the schema editor to demystify the
// progress/overall settings — #1).
const _HINT_STYLE='font-family:var(--mono);font-size:10px;color:var(--muted2);line-height:1.4;margin-top:4px';
function _cdField(label,inner){return `<div><label style="${_LABEL_STYLE}">${label}</label>${inner}</div>`;}

// Working copy of the category's states while the details modal is open.
let _cdStates=null;

function _cdGenStateId(){ return 's-'+Math.random().toString(36).slice(2,8); }

function _cdStyleOptions(isLinear, sel){
  const styles = isLinear ? ['solid','dashed','dotted'] : ['solid','hatch','crosshatch','dots'];
  const labels = isLinear
    ? {solid:'— Solid',dashed:'– Dashed',dotted:'·· Dotted'}
    : {solid:'■ Solid',hatch:'▥ Hatch',crosshatch:'▨ Cross',dots:'• Dots'};
  return styles.map(s=>`<option value="${s}"${s===(sel||'solid')?' selected':''}>${labels[s]}</option>`).join('');
}

function _cdMiniBtn(extra){
  // Font stack includes system-symbol fallbacks so ↑/↓/✓/✕ glyphs always render
  // (the mono webfont lacks some of these on iOS → they showed as blank ovals).
  return `background:var(--s2);border:1px solid var(--border);color:var(--muted);border-radius:5px;font-family:var(--mono),-apple-system,'Segoe UI Symbol',sans-serif;font-size:13px;padding:8px 10px;min-height:34px;cursor:pointer;flex-shrink:0;${extra||''}`;
}

const _CD_AMEND_TYPES=['None','Seeding','Lime','Fertilizer','Mulch','Other'];
const _CD_RATE_UNITS=['lbs/ac','tons/ac','gal/ac','bags/ac'];
function _cdAmendOpts(sel){ return _CD_AMEND_TYPES.map(t=>`<option value="${t}"${(sel||'None')===t?' selected':''}>${t}</option>`).join(''); }
function _cdRateUnitOpts(sel){ return _CD_RATE_UNITS.map(u=>`<option value="${u}"${(sel||'lbs/ac')===u?' selected':''}>${u}</option>`).join(''); }

function _cdRenderStates(isLinear){
  const wrap=document.getElementById('_cd-states-list');
  if(!wrap||!_cdStates) return;
  // Per-state material shows when the category tracks material (area only); the plan
  // baseline has no material. Each state can be its own amendment (Lime/Fert/Seed).
  const showMat=!isLinear && !!document.getElementById('_cd-trackmat')?.checked;
  // countMode picker shows only for running modes (it only affects those totals).
  const running=['running-balance','running-total'].includes(document.getElementById('_cd-progmode')?.value);
  // Two-line rows so the name field stays readable (single-line overflowed/squeezed it).
  wrap.innerHTML=_cdStates.map((s,i)=>{
    const col=/^#[0-9A-Fa-f]{6}$/.test(s.color)?s.color:'#888888';
    const cmLine=(running && !s.isPlanned)?`
      <div style="display:flex;align-items:center;gap:6px;margin-top:5px">
        <span style="font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0">counts as</span>
        <select onchange="_cdSetStateCount(${i},this.value)" title="How this state affects the disturbed total" style="flex:1;min-width:0;${_INPUT_STYLE}">
          ${[['add','＋ Adds (open disturbance)'],['subtract','－ Subtracts (stabilized)'],['none','· Track only (don’t count)']].map(([v,l])=>`<option value="${v}"${((s.countMode||'add')===v)?' selected':''}>${l}</option>`).join('')}
        </select>
      </div>`:'';
    const matLine=(showMat && !s.isPlanned)?`
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--border)">
        <select onchange="_cdSetStateMat(${i},'amendmentType',this.value)" title="Amendment" style="flex:1;min-width:0;${_INPUT_STYLE}">${_cdAmendOpts(s.amendmentType)}</select>
        <input type="text" value="${(s.productName||'').replace(/"/g,'&quot;')}" oninput="_cdSetStateMat(${i},'productName',this.value)" placeholder="Product / mix" maxlength="40" style="flex:1;min-width:0;${_INPUT_STYLE}">
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:5px">
        <input type="number" value="${s.targetRate??''}" oninput="_cdSetStateMat(${i},'targetRate',this.value)" placeholder="Target rate (e.g. 30)" step="0.1" min="0" style="${_INPUT_STYLE}flex:1 1 auto;min-width:0">
        <select onchange="_cdSetStateMat(${i},'targetRateUnit',this.value)" title="Rate unit" style="${_INPUT_STYLE}flex:0 0 104px;width:104px">${_cdRateUnitOpts(s.targetRateUnit)}</select>
      </div>`:'';
    return `<div style="border:1px solid var(--border);border-radius:7px;padding:6px;margin-bottom:6px;background:var(--s1)">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
        <input type="color" value="${col}" oninput="_cdSetStateColor(${i},this.value)" title="State color" style="width:36px;height:36px;border:none;background:none;padding:0;flex-shrink:0;cursor:pointer">
        <input type="text" value="${(s.label||'').replace(/"/g,'&quot;')}" oninput="_cdSetStateLabel(${i},this.value)" placeholder="State name (e.g. Disturbed)" maxlength="24" style="flex:1;min-width:0;${_INPUT_STYLE}">
        <button onclick="_cdDelState(${i})" ${_cdStates.length<=1?'disabled':''} title="Delete state" style="${_cdMiniBtn('color:#e74c3c'+(_cdStates.length<=1?';opacity:.3':''))}">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <select onchange="_cdSetStateStyle(${i},this.value)" title="Style" style="flex:1;min-width:0;${_INPUT_STYLE}">${_cdStyleOptions(isLinear,s.style)}</select>
        ${_cdNoPlan?'':`<button onclick="_cdSetPlanned(${i})" title="Plan baseline — renders faint" style="${_cdMiniBtn(s.isPlanned?'background:var(--amber);color:#111;border-color:var(--amber);font-weight:700':'')}">${s.isPlanned?'✓ plan':'plan'}</button>`}
        <button onclick="_cdMoveState(${i},-1)" ${i===0?'disabled':''} style="${_cdMiniBtn(i===0?'opacity:.3':'')}">↑</button>
        <button onclick="_cdMoveState(${i},1)" ${i===_cdStates.length-1?'disabled':''} style="${_cdMiniBtn(i===_cdStates.length-1?'opacity:.3':'')}">↓</button>
      </div>
      ${cmLine}
      ${matLine}
    </div>`;
  }).join('');
}
function _cdSetStateCount(i,v){ if(_cdStates[i]) _cdStates[i].countMode=v; }
function _cdSetStateColor(i,v){ if(_cdStates[i]) _cdStates[i].color=v; }
function _cdSetStateLabel(i,v){ if(_cdStates[i]) _cdStates[i].label=v; }
function _cdSetStateStyle(i,v){ if(_cdStates[i]) _cdStates[i].style=v; }
function _cdSetStateMat(i,field,v){
  if(!_cdStates[i]) return;
  if(field==='targetRate'){ const f=parseFloat(v); _cdStates[i].targetRate=isNaN(f)?null:f; }
  else _cdStates[i][field]=v;
}
function _cdSetPlanned(i){
  _cdStates.forEach((s,j)=>{ s.isPlanned=(j===i); });
  _cdRenderStates(_cdIsLinear);
}
function _cdMoveState(i,dir){
  const j=i+dir; if(j<0||j>=_cdStates.length) return;
  const t=_cdStates[i]; _cdStates[i]=_cdStates[j]; _cdStates[j]=t;
  _cdRenderStates(_cdIsLinear);
}
function _cdDelState(i){
  if(_cdStates.length<=1) return;
  const wasPlanned=_cdStates[i].isPlanned;
  _cdStates.splice(i,1);
  if(wasPlanned && !_cdStates.some(s=>s.isPlanned)) _cdStates[0].isPlanned=true;
  _cdRenderStates(_cdIsLinear);
}
function _cdAddState(){
  const palette=['#E67E22','#27AE60','#4A90E2','#9B59B6','#C9A84C','#E74C3C','#1E6B3A'];
  _cdStates.push({id:_cdGenStateId(),label:'',color:palette[_cdStates.length%palette.length],style:'solid',pattern:null,isPlanned:false,countMode:'add'});
  _cdRenderStates(_cdIsLinear);
}
function _cdToggleMaterial(on){
  const box=document.getElementById('_cd-material-fields');
  if(box) box.style.display=on?'flex':'none';
  // Per-state material lines depend on this toggle — re-render the states list.
  _cdRenderStates(_cdIsLinear);
}
function _cdToggleCap(){
  const mode=document.getElementById('_cd-progmode')?.value;
  const box=document.getElementById('_cd-cap-row');
  if(box) box.style.display=(mode==='running-balance'||mode==='running-total')?'block':'none';
  // Re-render states so the per-state countMode picker appears/disappears with the mode.
  _cdRenderStates(_cdIsLinear);
}

let _cdIsLinear=false;
let _cdNoPlan=false;
let _cdCatColor=null;
function _cdSetCatColor(v){ _cdCatColor=v; }

function mapShowCategoryDetails(catId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null;
  if(!cat) return;
  if(document.getElementById('_cat-details-ov')) return;
  const isLinear=cat.measurementType==='linear';
  _cdIsLinear=isLinear;
  _cdCatColor=(cat.color&&/^#[0-9A-Fa-f]{6}$/.test(cat.color))?cat.color:'#888888';
  _cdNoPlan=(typeof tcNoPlan==='function')?tcNoPlan(cat,pid):false;
  // Deep-clone states (synthesizes legacy defaults) so edits don't touch the cache.
  _cdStates=(typeof tcGetStates==='function'?tcGetStates(cat,pid):[]).map(s=>({...s}));
  // No-plan categories (e.g. SWPPP disturbance) have NO plan baseline — don't force one.
  if(!_cdNoPlan && !_cdStates.some(s=>s.isPlanned)&&_cdStates.length) _cdStates[0].isPlanned=true;
  // The plan (first) state's color IS the category's identity color (locked 2026-06-18) —
  // seed it from cat.color so the editor shows them unified and editing the plan color
  // edits the category identity. Kills the legacy gray plan default on existing categories.
  _cdStates.forEach(s=>{ if(s.isPlanned && /^#[0-9A-Fa-f]{6}$/.test(_cdCatColor)) s.color=_cdCatColor; });

  const trackMat=(typeof tcTrackMaterial==='function')?tcTrackMaterial(cat,pid):true;
  const progMode=(typeof tcProgressMode==='function')?tcProgressMode(cat,pid):'per-state-vs-plan';
  const overMode=(typeof tcOverallMode==='function')?tcOverallMode(cat,pid):'terminal';
  // Seed countMode on child states so the editor reflects (and persists) current behavior —
  // legacy categories with no explicit flag derive from the old positional rule.
  const _cdChild=_cdStates.filter(s=>!s.isPlanned);
  _cdChild.forEach((s,idx)=>{ if(!s.countMode) s.countMode=(typeof tcStateCountMode==='function')?tcStateCountMode(s,idx,_cdChild,progMode):'add'; });
  const statePat=(typeof tcStatePatterns==='function')?tcStatePatterns(cat,pid):false;
  const capVal=cat.disturbanceCap!=null?cat.disturbanceCap:'';
  const capUnit=cat.capUnit||cat.defaultUnit||(isLinear?'ft':'ac');

  // Material block. Area = per-state (set on each state above); linear keeps its
  // category-level spec/supplier descriptors (linear states have no rate calc).
  let materialFields;
  if(isLinear){
    materialFields=`
      ${_cdField('Specification',`<input type="text" id="_cd-spec" value="${(cat.specification||'').replace(/"/g,'&quot;')}" placeholder="Standard, heavy duty, J-hook…" style="${_INPUT_STYLE}">`)}
      ${_cdField('Supplier / Product',`<input type="text" id="_cd-supplier" value="${(cat.supplier||'').replace(/"/g,'&quot;')}" placeholder="Manufacturer or vendor name" style="${_INPUT_STYLE}">`)}
      ${_cdField('Notes',`<input type="text" id="_cd-notes-det" value="${(cat.detailNotes||'').replace(/"/g,'&quot;')}" placeholder="Any additional details" style="${_INPUT_STYLE}">`)}`;
  } else {
    materialFields=`<div style="font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.5">Set the amendment + rate on each state above — each state can be its own material (Lime, Fertilizer, Seed…).</div>`;
  }

  const progModeOpts=[['per-state-vs-plan','Each state vs. the plan area'],['running-balance','Running balance (adds − subtracts)'],['running-total','Running total (only adds up)'],['simple-count','Just count entries']]
    .map(([v,l])=>`<option value="${v}"${v===progMode?' selected':''}>${l}</option>`).join('');
  const overModeOpts=[['terminal','The final state’s progress'],['average','Average of all states'],['weighted','Weighted by area']]
    .map(([v,l])=>`<option value="${v}"${v===overMode?' selected':''}>${l}</option>`).join('');
  const capUnitOpts=(isLinear?['ft','yd','m','mi']:['ac','sqft','sqyd','sqm','ha'])
    .map(u=>`<option value="${u}"${u===capUnit?' selected':''}>${u}</option>`).join('');
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.id='_cat-details-ov';
  // Full-width bottom sheet (like the Tracker Log) — the schema editor has too much
  // to fit a small centered box; this gives the per-state rows room to breathe.
  ov.style.cssText='z-index:5000;align-items:flex-end;padding:0';
  ov.innerHTML=`<div style="width:100%;max-height:92dvh;background:var(--bg);border-top:1px solid var(--border);border-radius:16px 16px 0 0;display:flex;flex-direction:column;overflow:hidden;padding-bottom:env(safe-area-inset-bottom)">
    <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
      ${(typeof tcRampChip==='function')?tcRampChip(cat,pid,14):''}
      <div class="modal-title" style="margin:0;flex:1;font-size:15px">${cat.name}</div>
      <button id="_cd-x" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;width:34px;height:34px">✕</button>
    </div>
    <div style="flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:14px">
      <div>
        <label style="${_LABEL_STYLE}">States <span style="text-transform:none;color:var(--muted)">— ✏️ editable; the ‘plan’ state’s color is the category’s identity color</span></label>
        <div id="_cd-states-list"></div>
        <button onclick="_cdAddState()" style="${_cdMiniBtn('width:100%;justify-content:center;padding:8px;color:var(--text)')}">+ Add state</button>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:12px">
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">⚙ Progress &amp; display</div>
        <div>
          ${_cdField('How progress is counted',`<select id="_cd-progmode" onchange="_cdToggleCap()" style="${_INPUT_STYLE}">${progModeOpts}</select>`)}
          <div style="${_HINT_STYLE}">Most categories: <b>“Each state vs. the plan area.”</b> Use <b>Running balance</b> for SWPPP disturbance.</div>
        </div>
        <div>
          ${_cdField('Overall % is based on',`<select id="_cd-overmode" style="${_INPUT_STYLE}">${overModeOpts}</select>`)}
          <div style="${_HINT_STYLE}">Usually <b>“The final state’s progress.”</b></div>
        </div>
        <div id="_cd-cap-row" style="display:${(progMode==='running-balance'||progMode==='running-total')?'block':'none'}">
          <label style="${_LABEL_STYLE}">Disturbance limit (warn above)</label>
          <div style="display:grid;grid-template-columns:1fr 90px;gap:8px">
            <input type="number" id="_cd-cap" value="${capVal}" step="0.1" min="0" placeholder="e.g. 5" style="${_INPUT_STYLE}">
            <select id="_cd-capunit" style="${_INPUT_STYLE}">${capUnitOpts}</select>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text);cursor:pointer">
          <input type="checkbox" id="_cd-statepat" ${statePat?'checked':''}> Distinguish states by pattern (not just color)
        </label>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text);cursor:pointer">
        <input type="checkbox" id="_cd-trackmat" ${trackMat?'checked':''} onchange="_cdToggleMaterial(this.checked)"> Track material / rate (lbs per acre, etc.)
      </label>
      <div id="_cd-material-fields" style="display:${trackMat?'flex':'none'};flex-direction:column;gap:12px">${materialFields}</div>
    </div>
    <div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);flex-shrink:0">
      <button class="modal-cancel" id="_cd-cancel" style="flex:1">Cancel</button>
      <button class="modal-confirm" id="_cd-save" style="flex:1">Save</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  document.getElementById('_cd-x').onclick=()=>{ _cdStates=null; ov.remove(); };
  _cdRenderStates(isLinear);
  document.getElementById('_cd-cancel').onclick=()=>{ _cdStates=null; ov.remove(); };
  document.getElementById('_cd-save').onclick=()=>mapSaveCategoryDetails(catId,ov,isLinear);
}

async function mapSaveCategoryDetails(catId, ov, isLinear){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const existing=(typeof tcGetCategory==='function')?tcGetCategory(catId,pid):null;
  if(!existing) return;
  // States — drop blank-labeled rows; ensure ids + exactly one planned baseline.
  let states=(_cdStates||[]).map(s=>({
    id:s.id||_cdGenStateId(),
    label:(s.label||'').trim()||'State',
    color:/^#[0-9A-Fa-f]{6}$/.test(s.color)?s.color:'#888888',
    style:s.style||'solid',
    pattern:s.pattern||null,
    isPlanned:!!s.isPlanned,
    // How this state affects a running total (add/subtract/none) — editable per state.
    ...(['add','subtract','none'].includes(s.countMode)?{countMode:s.countMode}:{}),
    // Per-state material (Lime/Fert/Seed each its own amendment + product + rate)
    ...(s.amendmentType&&s.amendmentType!=='None'?{amendmentType:s.amendmentType}:{}),
    ...(s.productName&&s.productName.trim()?{productName:s.productName.trim()}:{}),
    ...(s.targetRate!=null?{targetRate:s.targetRate}:{}),
    ...(s.targetRateUnit?{targetRateUnit:s.targetRateUnit}:{})
  }));
  if(!states.length) states=[{id:_cdGenStateId(),label:_cdNoPlan?'Active disturbed':'Planned',color:existing.color||'#888',style:'solid',pattern:null,isPlanned:!_cdNoPlan}];
  // No-plan categories have NO plan baseline; everything else needs exactly one.
  if(!_cdNoPlan){
    if(!states.some(s=>s.isPlanned)) states[0].isPlanned=true;
    let seenPlan=false;
    states.forEach(s=>{ if(s.isPlanned){ if(seenPlan) s.isPlanned=false; else seenPlan=true; } });
  } else {
    states.forEach(s=>{ s.isPlanned=false; });
  }

  const trackMaterial=!!document.getElementById('_cd-trackmat')?.checked;
  const progressMode=document.getElementById('_cd-progmode')?.value||'per-state-vs-plan';
  const overallMode=document.getElementById('_cd-overmode')?.value||'terminal';
  const statePatterns=!!document.getElementById('_cd-statepat')?.checked;
  // Category identity color = the PLAN (first) state's color (locked 2026-06-18): the
  // plan is the denominator — always ≥ every other state — so it's the most prevalent
  // color across a job. Each state still owns its own fill+outline; this keeps cat.color
  // (used for exports, legend, ramp-chip fallback, no-category drawings) in sync.
  const _planSt=states.find(s=>s.isPlanned)||states[0];
  const patch={ states, trackMaterial, progressMode, overallMode, statePatterns, noPlan:_cdNoPlan,
    color:(_planSt&&/^#[0-9A-Fa-f]{6}$/.test(_planSt.color))?_planSt.color:existing.color };

  if(progressMode==='running-balance'||progressMode==='running-total'){
    const cv=parseFloat(document.getElementById('_cd-cap')?.value);
    patch.disturbanceCap=isNaN(cv)?null:cv;
    patch.capUnit=document.getElementById('_cd-capunit')?.value||existing.defaultUnit||(isLinear?'ft':'ac');
  }

  if(isLinear){
    patch.specification=document.getElementById('_cd-spec')?.value.trim()||null;
    patch.supplier=document.getElementById('_cd-supplier')?.value.trim()||null;
    patch.detailNotes=document.getElementById('_cd-notes-det')?.value.trim()||null;
  }
  // Area material now lives per-state (states[].amendmentType/targetRate/targetRateUnit),
  // so there's no category-level amendment block to read here anymore.

  if(typeof tcSaveCategory==='function') await tcSaveCategory({...existing,...patch},pid);
  _cdStates=null;
  ov.remove();
  _renderTrackerSheet();
  if(typeof mapRenderTrackerLayers==='function') mapRenderTrackerLayers();
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
// Template picker on the Add sheet — seeds measurement type, then the schema
// is merged in on save (mapTrackerSaveAdd). 2026-06-03.
function mapTcSetTemplate(template){
  _tcAddingTemplate=template||'seeding';
  // Templates that imply a measurement type pre-select it (user can still flip).
  const impliedType = template==='linear-bmp' ? 'linear' : 'area';
  mapTcSetAddType(impliedType);
}
// Native color inputs (the OS 3-tab Grid/Spectrum/Sliders picker) drive the
// add/edit category color — consistent with the per-state color inputs.
function mapSetAddColor(v){ if(/^#[0-9A-Fa-f]{6}$/.test(v)) _tcAddingColor=v; }
function mapSetEditColor(v){ if(/^#[0-9A-Fa-f]{6}$/.test(v)) _tcEditingColor=v; }
window.mapSetAddColor=mapSetAddColor;
window.mapSetEditColor=mapSetEditColor;

function mapTrackerShowAdd(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  _tcAddingColor=(typeof tcNextColor==='function')?tcNextColor(pid):'#E67E22';
  _tcAddingType='area';
  _tcAddingTemplate='seeding';
  const tplSel=document.getElementById('map-tc-add-template');
  if(tplSel) tplSel.value='seeding';
  mapTcSetAddType('area');
  const add=document.getElementById('map-tracker-sheet-add');
  const preview=document.getElementById('map-tc-add-preview');
  const input=document.getElementById('map-tc-add-name');
  if(preview) preview.value=(_tcAddingColor&&/^#[0-9A-Fa-f]{6}$/.test(_tcAddingColor))?_tcAddingColor:'#e67e22';
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
  // Seed the category schema from the chosen template; explicit user choices
  // (name/color/type/unit/styling) override the template defaults.
  const template=_tcAddingTemplate||'seeding';
  const schema=(typeof tcTemplateSchema==='function')?tcTemplateSchema(template,measurementType):{};
  // Plan (first) state's color = the category identity color (locked 2026-06-18) — no gray default.
  const _catColor=_tcAddingColor||'#E67E22';
  if(Array.isArray(schema.states)){ const _ps=schema.states.find(s=>s.isPlanned)||schema.states[0]; if(_ps) _ps.color=_catColor; }
  await tcSaveCategory({...schema,template,name,color:_catColor,measurementType,defaultUnit,lineStyle,lineWidth,fillStyle,fillOpacity},pid);
  mapTrackerHideAdd();
  _renderTrackerSheet();
}

// ── Draw mode ────────────────────────────
// Touch snapping fix (item C, 2026-06-04). Two library quirks combine to break snap
// on iOS taps:
//  1. The snap mode computes the snapped point only in onMouseMove, which never fires
//     on a tap (no hover before the tap).
//  2. DrawPolygon sets `onTap = onClick`, but the snap library reassigns ONLY onClick
//     to its snap-aware version — leaving onTap pointing at the BASE (non-snap) handler.
//     mapbox-gl-draw routes touch taps through onTap, so taps bypassed snapping entirely.
// Fix: define onTap to first recompute the snap from the tap's own lngLat, then route
// through the SNAP-aware onClick (base.onClick) — never the inherited base onTap.
// TEMP tripwire (Bug A: intermittent iOS line-tap offset) — REMOVE after diagnosis.
// Computes the gap between the real finger position and where mapbox placed the point
// (finger.clientX/Y vs rect.left/top + point.x/y). Normal taps land dead-on (gap ~0) and
// are IGNORED — so normal use can't wash out the data. Only ACTUAL offset events (gap
// > 8px = the bug) are recorded to Firestore _debug/drawoffsets, where they accumulate
// and wait for us to read whenever it next strikes (no need to pull immediately).
window._glDrawOffsets = window._glDrawOffsets || [];
function _glLogDrawTap(e, kind){
  try{
    const oe = e && e.originalEvent;
    const t = oe && ((oe.touches && oe.touches[0]) || (oe.changedTouches && oe.changedTouches[0]));
    if(!t || !e.point || !_mapInstance) return;
    const rect = _mapInstance.getContainer().getBoundingClientRect();
    const dx = Math.round(t.clientX - (rect.left + e.point.x));
    const dy = Math.round(t.clientY - (rect.top + e.point.y));
    if(Math.abs(dx) <= 8 && Math.abs(dy) <= 8) return;   // landed where the finger was — normal, ignore
    window._glDrawOffsets.push({
      kind, when:new Date().toISOString(), dx, dy,
      finger:{x:Math.round(t.clientX), y:Math.round(t.clientY)},
      point:{x:Math.round(e.point.x), y:Math.round(e.point.y)},
      rect:{top:Math.round(rect.top), left:Math.round(rect.left)},
    });
    if(window._udb) window._udb().collection('_debug').doc('drawoffsets').set({events: window._glDrawOffsets.slice(-25), updated: Date.now()}).catch(()=>{});
  }catch(_){}
}
function _snapTouchMode(base,kind){
  const mode={...base};
  const recompute=function(state,e){
    if(e&&e.lngLat&&typeof base.onMouseMove==='function') base.onMouseMove.call(this,state,e);
  };
  // A finger tap rarely lands dead-on the tiny vertex hit-target, so mapbox-gl-draw's
  // native "tap first vertex to close / last vertex to finish" never fires on touch — and
  // the snap onClick just drops another vertex (polygons never close, lines never finish).
  // Detect the finish tap ourselves with a finger-friendly radius: near the FIRST vertex
  // (polygon, >=3 placed) closes; near the LAST placed vertex (line, >=2 placed) finishes.
  // changeMode('simple_select') runs the draw mode's onStop, which auto-closes the ring,
  // validates, and fires draw.create — the identical save path as a native completion.
  const tryFinish=function(state,e){
    try{
      if(kind==='point'||!e||!e.point||!this.map) return false;
      const feat=kind==='polygon'?state.polygon:state.line;
      if(!feat) return false;
      let ring=feat.coordinates; if(kind==='polygon') ring=ring&&ring[0];
      if(!Array.isArray(ring)) return false;
      const placed=ring.slice(0,-1);                       // drop the trailing cursor-follow coord
      if(placed.length<(kind==='polygon'?3:2)) return false;
      const t=kind==='polygon'?placed[0]:placed[placed.length-1];
      if(!Array.isArray(t)) return false;
      const p=this.map.project({lng:t[0],lat:t[1]});
      if(Math.hypot(p.x-e.point.x,p.y-e.point.y)<=24){ this.changeMode('simple_select'); return true; }
    }catch(_){}
    return false;
  };
  mode.onClick=function(state,e){ recompute.call(this,state,e); if(tryFinish.call(this,state,e)) return; return base.onClick.call(this,state,e); };
  // Route taps through the snap-aware onClick (NOT base.onTap, which is the non-snap base).
  mode.onTap=function(state,e){ _glLogDrawTap(e,kind); recompute.call(this,state,e); if(tryFinish.call(this,state,e)) return; return base.onClick.call(this,state,e); };
  return mode;
}

function mapActivateDrawMode(categoryId){
  mapCloseCategorySheet();
  _pauseGpsForDraw();
  if(!_mapInstance) return;
  _drawCategory=categoryId;
  _drawMode='draw';
  if(!_drawInstance){
    _drawInstance=new MapboxDraw({
      displayControlsDefault:false,
      controls:{},
      modes:{ ...MapboxDraw.modes, draw_point:_snapTouchMode(SnapPointMode,'point'), draw_polygon:_snapTouchMode(SnapPolygonMode,'polygon'), draw_line_string:_snapTouchMode(SnapLineMode,'line') },
      styles:SnapModeDrawStyles,
      userProperties:true,
      snap:true,
      // snapToMidPoints off + low vertex priority → edge-snap dominates, so the
      // anchor slides ALONG the line instead of jumping between preset points.
      // snapPx 22 (was 15) — fingers are less precise than a cursor; a slightly wider
      // catch radius makes tap-to-snap lock on reliably on touch without feeling sticky.
      snapOptions:{ snapPx:22, snapToMidPoints:false, snapVertexPriorityDistance:0.0009, snapGetFeatures:_snapGetFeatures },
    });
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
  document.getElementById('map-draw-bar-label').textContent=_drawEntryType==='planned'?`Planning: ${catName}`:`Drawing: ${catName}`;
  _updateActivePlanIndicator();
  document.getElementById('map-draw-shape-btns').style.display='flex';
  bar.classList.add('show');
  bar.style.borderColor=catColor;
  document.getElementById('map-fab-draw-btn').classList.add('active');
}

function mapDeactivateDrawMode(){
  _trSessionDate=null;
  const prevMode=_drawMode;
  _drawMode=null;
  _drawCategory=null;
  _drawEntryType='installed';
  _activePlannedEntryId=null;
  _pendingDrawFeature=null;
  if(prevMode==='draw'&&_drawInstance){
    // Switch to a non-snap mode FIRST so the active snap mode's onStop runs and
    // removes its 'moveend' listener — otherwise it leaks and throws getAll-of-null
    // on every zoom/scroll after the control is torn down.
    try{ _drawInstance.changeMode('simple_select'); }catch{}
    _drawInstance.deleteAll();
    try{ _mapInstance.removeControl(_drawInstance); }catch{}
    _drawInstance=null;
  }
  if(prevMode==='measure') _deactivateMeasureMode();
  document.getElementById('map-draw-bar').classList.remove('show');
  document.getElementById('map-fab-draw-btn').classList.remove('active');
  document.getElementById('map-fab-measure-btn').classList.remove('active');
  document.getElementById('map-measure-chip').classList.remove('show');
  _updateActivePlanIndicator();
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
  const isPlanned=_drawEntryType==='planned';
  const titleEl=document.getElementById('map-tracker-modal-title');
  if(titleEl) titleEl.textContent=isPlanned?'New Planned Area':'New Tracker Entry';
  const typeRow=document.getElementById('map-tr-type-row');
  if(typeRow) typeRow.style.display=isPlanned?'block':'none';
  const activeLogDate=document.getElementById('reportDate')?.value;
  const today=_trSessionDate||activeLogDate||new Date().toLocaleDateString('en-CA');
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
  _pendingPhotoTypes={};
  _pendingPhotoCaptions={};
  mapRefreshEntryPhotoStrip();
  // Seed calculator — area categories that track material only (toggled below via
  // _setEntryFieldVisibility, which also handles planned/linear/phase visibility).
  const trackMat=(typeof tcTrackMaterial==='function')?tcTrackMaterial(catDetails,pid):true;
  const rateEl=document.getElementById('map-tr-rate');
  const calcEl=document.getElementById('map-tr-calc-result');
  if(rateEl) rateEl.value=catDetails?.targetRate||'';
  if(calcEl) calcEl.textContent='—';
  const actualAmtEl=document.getElementById('map-tr-actual-amt');
  const actualUnitEl=document.getElementById('map-tr-actual-unit');
  const seedTagsEl=document.getElementById('map-tr-seed-tags');
  if(actualAmtEl) actualAmtEl.value='';
  if(actualUnitEl) actualUnitEl.value='lbs';
  if(seedTagsEl) seedTagsEl.value='';
  const mixProductEl=document.getElementById('map-tr-mix-product');
  if(mixProductEl) mixProductEl.value='';
  const newLabelBtn=document.getElementById('map-tr-date-label-btn');
  if(newLabelBtn){newLabelBtn.dataset.on='0';newLabelBtn.style.background='none';newLabelBtn.style.borderColor='rgba(255,255,255,0.15)';newLabelBtn.style.color='rgba(255,255,255,0.35)';newLabelBtn.textContent='🔖 Label';}
  const newLabelText=document.getElementById('map-tr-label-text'); if(newLabelText) newLabelText.value='';
  const newLabelColor=document.getElementById('map-tr-label-color'); if(newLabelColor) newLabelColor.value='#ffffff';
  const newLabelCfg=document.getElementById('map-tr-label-config'); if(newLabelCfg) newLabelCfg.style.display='none';
  if(catDetails?.targetRate&&measType!=='linear') mapTrackerCalc();
  const catColor=(typeof tcGetColor==='function')?tcGetColor(category,pid):'#888';
  const catName=(typeof tcGetName==='function')?tcGetName(category,pid):(category||'Unknown');
  document.getElementById('map-tracker-cat-dot').style.background=catColor;
  document.getElementById('map-tracker-cat-label').textContent=catName;
  const dd=_populateEntryDropdowns(category);
  // State picker — child overlays pick a non-planned state; hidden for the plan baseline.
  const stateRow=document.getElementById('map-tr-state-row');
  if(stateRow){
    if(isPlanned){ stateRow.style.display='none'; }
    else {
      const defState=(typeof tcDefaultChildState==='function')?tcDefaultChildState(category,pid):null;
      _populateEntryStates(category, defState?defState.id:null);
      const hasStates=(document.getElementById('map-tr-state')?.options.length||0)>0;
      stateRow.style.display=hasStates?'block':'none';
      // Prefill rate from the default state's material (per-state material).
      if(hasStates) mapTrStateChanged();
    }
  }
  // Phase/method only show when this category actually defines them (drops seeding implication).
  const hasDesc=(dd.phases&&dd.phases.length)||(dd.methods&&dd.methods.length);
  _setEntryFieldVisibility(isPlanned, measType, hasDesc, trackMat, category, pid);
  const phaseEl=document.getElementById('map-tr-phase');
  const methodEl=document.getElementById('map-tr-method');
  const conEl=document.getElementById('map-tr-contractor');
  const statusEl=document.getElementById('map-tr-status');
  if(phaseEl) phaseEl.value='N/A';
  if(methodEl) methodEl.value='N/A';
  if(conEl) conEl.value='';
  if(statusEl) statusEl.value=isPlanned?'Planned':'Installed';
  _populateLinkToPlanDropdown(category);
  document.getElementById('map-tracker-modal').classList.add('open');
}

function _populateEntryDropdowns(category){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const phases=(typeof tcCategoryPhases==='function')?tcCategoryPhases(category,pid):(window._amendmentPhases||['N/A']);
  const methods=(typeof tcCategoryMethods==='function')?tcCategoryMethods(category,pid):(window._amendmentMethods||['N/A']);
  const phaseEl=document.getElementById('map-tr-phase');
  const methodEl=document.getElementById('map-tr-method');
  if(phaseEl){ phaseEl.innerHTML=(phases.length?phases:['N/A']).map(p=>`<option value="${p}">${p}</option>`).join(''); }
  if(methodEl){ methodEl.innerHTML=(methods.length?methods:['N/A']).map(m=>`<option value="${m}">${m}</option>`).join(''); }
  return {phases,methods};
}

// Populate the State picker with the category's non-planned states (child overlay buckets).
function _populateEntryStates(category, selectedStateId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const sel=document.getElementById('map-tr-state');
  if(!sel) return;
  const states=(typeof tcGetStates==='function')?tcGetStates(category,pid).filter(s=>!s.isPlanned):[];
  sel.innerHTML=states.map(s=>`<option value="${s.id}"${s.id===selectedStateId?' selected':''}>${s.label}</option>`).join('');
}

// The currently-selected state object in the entry modal (for per-state material).
function _trSelectedState(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const sid=document.getElementById('map-tr-state')?.value;
  if(!sid||typeof tcGetState!=='function') return null;
  return tcGetState(_drawCategory,sid,pid);
}

// State changed in the entry form → prefill the rate from that state's material
// (falls back to the category targetRate), then recompute the calc.
function mapTrStateChanged(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(_drawCategory,pid):null;
  const st=_trSelectedState();
  const rate=(st&&st.targetRate!=null)?st.targetRate:(cat?.targetRate??'');
  const rateEl=document.getElementById('map-tr-rate');
  if(rateEl) rateEl.value=rate||'';
  // Prefill Mix/Product from the state's product (only if the field is empty,
  // so we never clobber what the user already typed).
  const mixEl=document.getElementById('map-tr-mix-product');
  if(mixEl && !mixEl.value && st && st.productName) mixEl.value=st.productName;
  if(typeof mapTrackerCalc==='function') mapTrackerCalc();
}
window.mapTrStateChanged=mapTrStateChanged;

// A category "uses a multi-state model" once it has ≥2 non-planned states
// (Limed → Fertilized → Seeded…). For those the State picker already says what the
// layer is, so the legacy Application Phase dropdown is a duplicate (#5.2).
function _catMultiState(category, pid){
  const states=(typeof tcGetStates==='function')?tcGetStates(category,pid):[];
  return states.filter(s=>!s.isPlanned).length>=2;
}
// Shared show/hide for the entry modal's conditional field groups (add + edit).
// Planned areas carry no per-application data — phase/method + the seed/material
// calc belong to the LAYERS drawn on the plan, not the plan itself (#5.1).
function _setEntryFieldVisibility(isPlanned, measType, hasDesc, trackMat, category, pid){
  const isLinear=measType==='linear';
  const areaFields=document.getElementById('map-tr-area-fields');
  const linearFields=document.getElementById('map-tr-linear-fields');
  const calcSection=document.getElementById('map-tr-calc-section');
  const phaseWrap=document.getElementById('map-tr-phase-wrap');
  if(phaseWrap) phaseWrap.style.display=_catMultiState(category,pid)?'none':'';
  if(areaFields) areaFields.style.display=(isPlanned||isLinear||!hasDesc)?'none':'';
  if(linearFields) linearFields.style.display=isLinear?'':'none';
  if(calcSection) calcSection.style.display=(isPlanned||isLinear||!trackMat)?'none':'';
}

function mapCloseTrackerModal(){
  document.getElementById('map-tracker-modal').classList.remove('open');
}

function _updateActivePlanIndicator(){
  const el=document.getElementById('map-draw-active-plan');
  const lbl=document.getElementById('map-draw-active-plan-label');
  if(!el) return;
  if(_activePlannedEntryId&&_drawMode==='draw'&&_drawEntryType==='installed'){
    const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
    const entry=(typeof trGetEntry==='function')?trGetEntry(_activePlannedEntryId,pid):null;
    const name=entry?(entry.categoryName||'Plan'):'Plan';
    if(lbl) lbl.textContent=`📍 ${name}`;
    el.style.display='flex';
  } else {
    el.style.display='none';
  }
}
// Activate ANY drawing (plan or overlay) as the draw target. Activating a plan
// links new overlays to it; activating an overlay links new overlays to that
// overlay's parent plan (siblings) so you can stack Lime→Fert→Seed by activating
// the previous layer. (The trace/snap-to-it part lands with the snapping rework.)
function mapActivatePlannedEntry(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  _activePlannedEntryId=(entry.entryType==='planned')?entry.id:(entry.parentId||entry.id);
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  _drawEntryType='installed';
  if(!_drawMode) mapActivateDrawMode(entry.categoryId||entry.category);
  else _updateActivePlanIndicator();
}
function mapClearActivePlan(){
  _activePlannedEntryId=null;
  _updateActivePlanIndicator();
  const sel=document.getElementById('map-tr-link-plan');
  if(sel) sel.value='';
}
function _populateLinkToPlanDropdown(categoryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const sel=document.getElementById('map-tr-link-plan');
  const section=document.getElementById('map-tr-link-plan-section');
  if(!sel||!section) return;
  if(_drawEntryType==='planned'){ section.style.display='none'; return; }
  const plans=(typeof trGetEntriesForProject==='function')
    ?trGetEntriesForProject(pid).filter(e=>!e.deletedFromMap&&!e.archivedFromMap&&e.entryType==='planned'&&(e.categoryId===categoryId||e.category===categoryId))
    :[];
  if(!plans.length){ section.style.display='none'; return; }
  section.style.display='block';
  sel.innerHTML='<option value="">— None —</option>'+plans.map(e=>{
    const meas=e.measurementValue!=null?`${e.measurementValue} ${e.measurementUnit||'ac'}`:e.acres?`${e.acres} ac`:'';
    const label=[e.date,meas,e.notes?e.notes.slice(0,20):''].filter(Boolean).join(' · ');
    return `<option value="${e.id}"${e.id===_activePlannedEntryId?' selected':''}>${label}</option>`;
  }).join('');
}
function _showUndoToast(entry, pid){
  window.glHaptic && window.glHaptic.success();  // tactile confirm on tracker entry save
  const existing=document.getElementById('_gl-undo-toast');
  if(existing) existing.remove();
  const toast=document.createElement('div');
  toast.id='_gl-undo-toast';
  toast.style.cssText='position:fixed;bottom:calc(160px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:#1a2a3a;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px;z-index:4800;font-family:var(--mono);font-size:12px;color:#e8e8e8;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  const label=entry.entryType==='planned'?'Planned area saved':'Entry saved';
  const catName=entry.categoryName||(typeof tcGetName==='function'?tcGetName(entry.categoryId,pid):'');
  toast.innerHTML=`<span>${label}${catName?' · '+catName:''}</span><button onclick="(function(){if(typeof trDeleteEntry==='function')trDeleteEntry('${entry.id}','${pid}');if(typeof mapRenderTrackerLayers==='function')mapRenderTrackerLayers();if(typeof clRenderTrackerCard==='function')clRenderTrackerCard();document.getElementById('_gl-undo-toast')?.remove();})()" style="background:var(--amber);border:none;color:#111;padding:4px 10px;border-radius:4px;font-family:var(--mono);font-size:11px;cursor:pointer;font-weight:700">Undo</button>`;
  document.body.appendChild(toast);
  setTimeout(()=>{const t=document.getElementById('_gl-undo-toast');if(t===toast)toast.remove();},6000);
}
function mapCancelTrackerEntry(){
  if(_drawInstance) _drawInstance.deleteAll();
  _pendingDrawFeature=null;
  _editingEntryId=null;
  _pendingPhotoIds=[];
  _pendingPhotoTypes={};
  _pendingPhotoCaptions={};
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
    fields:(()=>{
      if(isLinear) return {};
      const rateVal=parseFloat(document.getElementById('map-tr-rate')?.value)||null;
      const requiredAmt=rateVal&&acres?Math.round(rateVal*acres):null;
      const requiredUnit=rateVal?_catUnit().split('/')[0]:null;
      const rawActual=document.getElementById('map-tr-actual-amt')?.value;
      const actualAmt=rawActual!==''&&rawActual!=null?parseFloat(rawActual):null;
      const actualUnitVal=document.getElementById('map-tr-actual-unit')?.value||'lbs';
      const rawTags=document.getElementById('map-tr-seed-tags')?.value;
      const seedTagVal=rawTags!==''&&rawTags!=null?parseInt(rawTags):null;
      return {
        ...(rateVal!=null?{appliedRate:rateVal}:{}),
        ...(requiredAmt!=null?{requiredAmount:requiredAmt,requiredUnit}:{}),
        ...(actualAmt!=null?{actualAmount:actualAmt,actualUnit:actualUnitVal}:{}),
        ...(seedTagVal!=null?{seedTagCount:seedTagVal}:{}),
      };
    })(),
    seedMix:document.getElementById('map-tr-mix-product')?.value.trim()||null,
    showDateLabel:document.getElementById('map-tr-date-label-btn')?.dataset.on==='1'||false,
    labelText:document.getElementById('map-tr-label-text')?.value.trim()||null,
    labelColor:(()=>{const v=document.getElementById('map-tr-label-color')?.value;return (v&&/^#[0-9A-Fa-f]{6}$/.test(v))?v:null;})(),
    notes:document.getElementById('map-tr-notes').value.trim()||null,
    photoIds:[..._pendingPhotoIds],
    photoTypes:{..._pendingPhotoTypes},
    photoCaptions:{..._pendingPhotoCaptions},
    entryType:_drawEntryType||'installed',
    parentId:(()=>{
      if(_drawEntryType==='planned') return null;
      const sel=document.getElementById('map-tr-link-plan');
      return (sel&&sel.value)?sel.value:(_activePlannedEntryId||null);
    })(),
    // Which state bucket this child overlay belongs to (null for the plan baseline).
    state:(()=>{
      if(_drawEntryType==='planned') return null;
      const sv=document.getElementById('map-tr-state')?.value;
      if(sv) return sv;
      const ds=(typeof tcDefaultChildState==='function')?tcDefaultChildState(_drawCategory,pid):null;
      return ds?ds.id:null;
    })(),
  };
  // Editing an existing entry — preserve id + the temporary lifecycle fields that
  // aren't on the form, so a re-save (which rebuilds the entry from form inputs)
  // doesn't strip them.
  if(_editingEntryId){
    entry.id=_editingEntryId; entry.deletedFromMap=false;
    const _prev=(typeof trGetEntry==='function')?trGetEntry(_editingEntryId,pid):null;
    if(_prev&&_prev.temporary){
      entry.temporary=true; entry.tempStatus=_prev.tempStatus||'open';
      entry.tempLabel=_prev.tempLabel; entry.tempType=_prev.tempType;
      entry.resolvedAt=_prev.resolvedAt||null; entry.resolvedBy=_prev.resolvedBy||null;
      entry.resolveNote=_prev.resolveNote||null;
      entry.archivedFromMap=_prev.tempStatus==='resolved'; // keep resolved ones filed
    } else {
      entry.archivedFromMap=false;
    }
  }
  _editingEntryId=null;
  _pendingPhotoIds=[];
  const saved=(typeof trSaveEntry==='function')?trSaveEntry(entry,pid):null;
  if(saved) _showUndoToast(saved,pid);
  _pendingDrawFeature=null;
  mapCloseTrackerModal();
  if(_drawInstance) _drawInstance.deleteAll();
  mapRenderTrackerLayers();
  mapUpdateKmlLayerList();
  if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
  // Auto-exit draw mode once an entry is finalized (Tim 6/3 — was stuck in draw mode).
  if(typeof mapDeactivateDrawMode==='function') mapDeactivateDrawMode();
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
  _pauseGpsForDraw();
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
  // Only acts if a GPS mode is engaged — preserves a user's manual map rotation.
  if(_gpsMode===0 && !_gpsFollowActive) return;
  _gpsMode=0;
  _stopGpsFollow();
  _stopCompass();
  _hideCone();
  _updateGpsBtn();
  if(_mapInstance){ try{ _mapInstance.easeTo({bearing:0,duration:300}); }catch(e){} } // unspin
}

// Drawing/measuring needs a still map. Stop auto-recenter and demote heading→direction
// so the map stops spinning, but KEEP the cone + selected mode so it persists after.
function _pauseGpsForDraw(){
  _stopGpsFollow();
  if(_gpsMode===3){
    _gpsMode=2;
    if(_mapInstance){ try{ _mapInstance.easeTo({bearing:0,duration:300}); }catch(e){} }
    _updateGpsBtn();
  }
}

// ── GPS / heading mode cycle ──────────────
// off → locate → direction (cone, north-up) → heading (cone + map spins) → off
function _startGpsFollow(){
  _followPaused=false; // a fresh engage always re-centers
  if(_gpsFollowActive||!navigator.geolocation) return;
  _gpsFollowActive=true;
  navigator.geolocation.getCurrentPosition(pos=>{
    if(!_mapInstance||!_gpsFollowActive) return;
    _mapInstance.flyTo({center:[pos.coords.longitude,pos.coords.latitude],zoom:17,duration:800});
  },null,{enableHighAccuracy:true});
  _gpsFollowWatch=navigator.geolocation.watchPosition(pos=>{
    // Pause re-centering once the user pans away — no more snap-back. The dot + cone
    // keep tracking; tap the compass again to re-engage centering.
    if(!_mapInstance||!_gpsFollowActive||_followPaused) return;
    _mapInstance.easeTo({center:[pos.coords.longitude,pos.coords.latitude],duration:300});
  },null,{enableHighAccuracy:true,maximumAge:3000});
}
function _stopGpsFollow(){
  _gpsFollowActive=false;
  if(_gpsFollowWatch) navigator.geolocation.clearWatch(_gpsFollowWatch);
  _gpsFollowWatch=null;
}

// The direction cone is a map GL symbol layer anchored to a GeoJSON point at the
// user's location — so it can't drift from the dot, and icon-rotation-alignment:'map'
// keeps it pointing at the true compass bearing as the map rotates.
function _ensureConeImage(){
  if(!_mapInstance || _mapInstance.hasImage('gps-cone-img')) return;
  const W=240,H=280,apexX=120,apexY=H,r=270,half=Math.PI/6; // 60° fan, apex at bottom-center
  const c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d');
  const grad=ctx.createRadialGradient(apexX,apexY,0,apexX,apexY,r);
  grad.addColorStop(0,'rgba(201,168,76,0.60)');
  grad.addColorStop(0.65,'rgba(201,168,76,0.22)');
  grad.addColorStop(1,'rgba(201,168,76,0)');
  ctx.fillStyle=grad;
  ctx.beginPath();
  ctx.moveTo(apexX,apexY);
  ctx.arc(apexX,apexY,r,-Math.PI/2-half,-Math.PI/2+half); // pie slice opening straight up
  ctx.closePath();
  ctx.fill();
  _mapInstance.addImage('gps-cone-img',{width:W,height:H,data:ctx.getImageData(0,0,W,H).data},{pixelRatio:2});
}
function _coneFeatureCollection(){
  const ll=_mapGpsMarker?_mapGpsMarker.getLngLat():_mapInstance.getCenter();
  return {type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[ll.lng,ll.lat]},properties:{heading:_curHeading}}]};
}
function _showCone(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;
  _ensureConeImage();
  if(!_mapInstance.getSource('gps-cone')){
    _mapInstance.addSource('gps-cone',{type:'geojson',data:_coneFeatureCollection()});
    _mapInstance.addLayer({id:'gps-cone-layer',type:'symbol',source:'gps-cone',
      layout:{'icon-image':'gps-cone-img','icon-anchor':'bottom','icon-rotate':['get','heading'],
              'icon-rotation-alignment':'map','icon-allow-overlap':true,'icon-ignore-placement':true,'icon-size':1}});
  } else {
    _mapInstance.getSource('gps-cone').setData(_coneFeatureCollection());
    if(_mapInstance.getLayer('gps-cone-layer')) _mapInstance.setLayoutProperty('gps-cone-layer','visibility','visible');
  }
}
function _hideCone(){
  if(_mapInstance && _mapInstance.getLayer('gps-cone-layer')) _mapInstance.setLayoutProperty('gps-cone-layer','visibility','none');
}
function _cardinal(deg){
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round((((deg%360)+360)%360)/45)%8];
}
// Push the latest position + heading into the cone source (no-op when the cone isn't shown).
function _updateConeData(){
  if(!_mapInstance || !_mapInstance.getSource('gps-cone')) return;
  if(_gpsMode<2) return;
  _mapInstance.getSource('gps-cone').setData(_coneFeatureCollection());
}

async function _startCompass(){
  if(_compassActive) return;
  // iOS 13+ requires explicit permission, granted from a user gesture (the FAB tap).
  try{
    if(typeof DeviceOrientationEvent!=='undefined' && typeof DeviceOrientationEvent.requestPermission==='function'){
      const res=await DeviceOrientationEvent.requestPermission();
      if(res!=='granted') return;
    }
  }catch(e){ /* not a user gesture / unsupported — fall through, listener still tries */ }
  _compassHandler=(e)=>{
    let h=null;
    if(typeof e.webkitCompassHeading==='number' && !isNaN(e.webkitCompassHeading)) h=e.webkitCompassHeading; // iOS true heading
    else if(e.absolute && typeof e.alpha==='number') h=(360-e.alpha)%360;                                    // android absolute
    if(h==null) return;
    // Low-pass smoothing over the circular range to kill raw-compass jitter.
    const delta=((h-_curHeading+540)%360)-180;
    _curHeading=(_curHeading+delta*0.3+360)%360;
    _updateConeData(); // updates the cone's heading (and keeps it on the dot)
    const lbl=document.getElementById('map-heading-label');
    if(lbl) lbl.textContent=_cardinal(_curHeading);
    if(_gpsMode===3 && _mapInstance){ // heading-up: spin map (throttled)
      const now=Date.now();
      if(now-_lastSpinTs>110){ _lastSpinTs=now; _mapInstance.rotateTo(_curHeading,{duration:110}); }
    }
  };
  window.addEventListener('deviceorientation',_compassHandler,true);
  window.addEventListener('deviceorientationabsolute',_compassHandler,true);
  _compassActive=true;
}
function _stopCompass(){
  if(_compassHandler){
    window.removeEventListener('deviceorientation',_compassHandler,true);
    window.removeEventListener('deviceorientationabsolute',_compassHandler,true);
  }
  _compassHandler=null; _compassActive=false;
}

function _updateGpsBtn(){
  // The bottom-right compass button IS the cycler: needle (off) → 🎯 (locate)
  // → 🎯 amber (direction) → 🧭 amber (heading).
  const btn=document.getElementById('map-compass');
  if(!btn) return;
  if(_origCompassHTML==null) _origCompassHTML=btn.innerHTML; // capture needle markup once
  btn.classList.remove('gps-active','gps-amber');
  if(_gpsMode===0){
    btn.innerHTML=_origCompassHTML; // restore the compass needle
    const needle=document.getElementById('map-compass-needle');
    if(needle&&_mapInstance) needle.style.transform=`rotate(${-_mapInstance.getBearing()}deg)`;
    btn.title='Locate / cycle location modes';
  } else {
    btn.innerHTML=`<span style="font-size:18px;line-height:1">${_gpsMode===3?'🧭':'🎯'}</span>`;
    btn.classList.add('gps-active');
    if(_gpsMode>=2) btn.classList.add('gps-amber');
    btn.title=['','Location: centered on you','Direction: view cone (north up)','Heading: map rotates to your facing'][_gpsMode];
  }
  btn.dataset.gpsMode=_gpsMode;
  // Heading compass rose: visible in direction + heading modes.
  const hc=document.getElementById('map-heading-compass');
  if(hc){
    hc.classList.toggle('on',_gpsMode>=2);
    if(_gpsMode>=2 && _mapInstance){
      const rose=document.getElementById('map-heading-rose');
      if(rose) rose.style.transform=`rotate(${-_mapInstance.getBearing()}deg)`;
      const lbl=document.getElementById('map-heading-label');
      if(lbl) lbl.textContent=_cardinal(_curHeading);
    }
  }
}

function mapCycleGpsMode(){
  if(!navigator.geolocation) return;
  _gpsMode=(_gpsMode+1)%4;
  switch(_gpsMode){
    case 0: // OFF
      _stopGpsFollow(); _stopCompass(); _hideCone();
      if(_mapInstance) _mapInstance.easeTo({bearing:0,duration:300});
      break;
    case 1: // LOCATE — centered, north up, no cone
      _stopCompass(); _hideCone();
      if(_mapInstance) _mapInstance.easeTo({bearing:0,duration:300});
      _startGpsFollow();
      break;
    case 2: // DIRECTION — cone, north up
      if(_mapInstance) _mapInstance.easeTo({bearing:0,duration:300});
      _startGpsFollow(); _showCone(); _startCompass();
      break;
    case 3: // HEADING — cone + map spins to heading
      _startGpsFollow(); _showCone(); _startCompass();
      break;
  }
  _updateGpsBtn();
}

// ── Tracker entry map layers ──────────────
let _trackerPopup=null,_trackerClickHandlerRegistered=false,_editingEntryId=null,_labelTopGuardRegistered=false;

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
  // Per-state color is data-driven via the `stateColor` feature property (solid fills);
  // hatch/crosshatch patterns remain category-colored (per-state pattern is a follow-up).
  const fillColor=['coalesce',['get','stateColor'],color];
  if(fs==='hatch')        paint={'fill-pattern':'tr-hatch-'+cat.id};
  else if(fs==='crosshatch') paint={'fill-pattern':'tr-xhatch-'+cat.id};
  else if(fs==='outline')    paint={'fill-color':fillColor,'fill-opacity':0};
  else                       paint={'fill-color':fillColor,'fill-opacity':['case',['get','faint'],0.07,fo]};
  _mapInstance.addLayer({id:srcId+'-fill',type:'fill',source:srcId,filter:['==',['geometry-type'],'Polygon'],paint});
}

function _addCategoryLineLayer(srcId,cat){
  const color=cat.color||'#888';
  // ESC-status capture framing: boost line widths so silt-fence runs etc. stay
  // legible in a zoomed-out phone/iPad capture. Layers re-add on every render, so
  // widths revert automatically when the filter clears.
  const lw=(cat.lineWidth||2)*(_escCapFilter?1.8:1);
  const lineColor=['coalesce',['get','stateColor'],color];
  const paint={'line-color':lineColor,'line-width':['case',['get','faint'],Math.max(1,lw-0.5),lw],'line-opacity':['case',['get','faint'],0.45,0.9]};
  // Per-STATE line style (ties the schema editor's state Style dropdown to the map;
  // GL JS v3 line-dasharray is data-driven). Each feature carries `stateStyle`
  // (state's style, falling back to the category-level lineStyle) — solid renders
  // as a huge dash (expressions can't emit "no dasharray").
  paint['line-dasharray']=['match',['get','stateStyle'],
    'dashed',['literal',_TC_DASH_ARRAYS.dashed],
    'dotted',['literal',_TC_DASH_ARRAYS.dotted],
    'dash-dot',['literal',_TC_DASH_ARRAYS['dash-dot']],
    ['literal',[1,0]]];
  _mapInstance.addLayer({id:srcId+'-line',type:'line',source:srcId,
    filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'LineString']],paint});
}

function _addCategoryCircleLayer(srcId,cat){
  const color=cat.color||'#888';
  const r=5+(cat.lineWidth||2);
  _mapInstance.addLayer({id:srcId+'-circle',type:'circle',source:srcId,
    filter:['==',['geometry-type'],'Point'],
    paint:{'circle-color':['coalesce',['get','stateColor'],color],'circle-radius':r,'circle-opacity':0.9,'circle-stroke-color':'#fff','circle-stroke-width':1.5}});
}

// ── Date label helpers ──
function _calcCentroid(geometry){
  if(!geometry) return null;
  try{
    const g=typeof geometry==='string'?JSON.parse(geometry):geometry;
    if(!g||!g.type) return null;
    if(g.type==='Polygon'){
      const ring=g.coordinates[0];
      if(!ring||!ring.length) return null;
      return [ring.reduce((s,p)=>s+p[0],0)/ring.length, ring.reduce((s,p)=>s+p[1],0)/ring.length];
    }
    if(g.type==='LineString'){
      const c=g.coordinates;
      return c&&c.length?c[Math.floor(c.length/2)]:null;
    }
    if(g.type==='Point') return g.coordinates;
  }catch{}
  return null;
}

function _fmtLabelDate(d){
  if(!d) return '';
  const [y,m,dy]=d.split('-');
  return `${parseInt(m)}/${parseInt(dy)}/${y.slice(2)}`;
}

function mapRefreshDateLabels(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid):[];
  const features=entries
    .filter(e=>{
      // Label shows when the drawing is on the map (geometry, not deleted/archived/
      // removed, category visible) AND either it has the date-label flag OR it's an
      // open temporary item (which always gets a ⚠ flag so an issue is obvious).
      if(!e.geometry||e.deletedAt||e.archivedFromMap||e.deletedFromMap) return false;
      const cid=e.categoryId||e.category;
      if(_tcLayerVisible[cid]===false) return false;
      const isOpenTemp=e.temporary&&e.tempStatus!=='resolved';
      if(isOpenTemp&&!_flagsVisible()) return false; // FAB flag toggle hides these
      // ESC-status capture framing: labels follow the same filter as the drawings —
      // selected categories only, no flags, no Removed-state entries.
      if(_escCapFilter){
        if(!_escCapFilter.cids.has(cid)||isOpenTemp) return false;
        const st=(typeof tcEntryState==='function')?tcEntryState(e,cid,pid):null;
        if(st&&(st.isPlanned||/remov/i.test(st.label||''))) return false;
        if(!st&&e.entryType==='planned') return false;
      }
      if(!e.showDateLabel&&!isOpenTemp) return false;
      return true;
    })
    .map(e=>{
      const c=_calcCentroid(e.geometry);
      if(!c) return null;
      const isOpenTemp=e.temporary&&e.tempStatus!=='resolved';
      // Open repair flags override the date label with an amber 🚩 so the
      // live punchlist reads at a glance; otherwise the normal date/custom label.
      const text=isOpenTemp
        ? '🚩 '+((e.tempLabel&&e.tempLabel.trim())||'Repair')
        : ((e.labelText&&e.labelText.trim())?e.labelText.trim():_fmtLabelDate(e.date));
      const color=isOpenTemp ? '#C9A84C'
        : ((e.labelColor&&/^#[0-9A-Fa-f]{6}$/.test(e.labelColor))?e.labelColor:'#ffffff');
      return {type:'Feature',geometry:{type:'Point',coordinates:c},properties:{label:text,color}};
    })
    .filter(Boolean);
  const geojson={type:'FeatureCollection',features};
  if(_mapInstance.getSource('tracker-date-labels')){
    _mapInstance.getSource('tracker-date-labels').setData(geojson);
  } else {
    _mapInstance.addSource('tracker-date-labels',{type:'geojson',data:geojson});
    _mapInstance.addLayer({
      id:'tracker-date-labels-layer',type:'symbol',source:'tracker-date-labels',
      layout:{'text-field':['get','label'],'text-size':11,'text-anchor':'center','text-allow-overlap':true,'text-ignore-placement':true},
      paint:{'text-color':['get','color'],'text-halo-color':'rgba(0,0,0,0.85)','text-halo-width':1.5},
    });
  }
  // Drawing fill/line layers get re-added above this symbol layer on re-render
  // (toggling a label, editing a drawing, hiding/showing a category), burying the
  // label. Always re-raise it to the top so labels render above their drawings
  // regardless of toggle order.
  if(_mapInstance.getLayer('tracker-date-labels-layer')){
    try{_mapInstance.moveLayer('tracker-date-labels-layer');}catch(e){}
  }
}
window.mapRefreshDateLabels=mapRefreshDateLabels;

function mapToggleDateLabel(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  // Fast-path rename: if label already on, open the inline edit modal
  if(entry.showDateLabel){
    _showLabelTextModal(entryId);
    return;
  }
  const updated={...entry,showDateLabel:true};
  if(typeof trSaveEntry==='function') trSaveEntry(updated,pid);
  mapRefreshDateLabels();
  if(_trackerPopup){
    const lngLat=_trackerPopup.getLngLat();
    _showTrackerEntryPopup(lngLat,{id:entryId,categoryId:entry.categoryId,categoryName:entry.categoryName,date:entry.date,measurementValue:entry.measurementValue,measurementUnit:entry.measurementUnit,acres:entry.acres,location:entry.location,status:entry.status,phase:entry.phase,method:entry.method,contractor:entry.contractor,notes:entry.notes});
  }
}
window.mapToggleDateLabel=mapToggleDateLabel;

// Inline rename modal for the popup tap-to-edit path. Edits labelText + labelColor;
// "Turn Off" toggles the label visibility off; persists directly to entry.
function _showLabelTextModal(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  const curText=entry.labelText||'';
  const curColor=(entry.labelColor&&/^#[0-9A-Fa-f]{6}$/.test(entry.labelColor))?entry.labelColor:'#ffffff';
  const dateFallback=_fmtLabelDate(entry.date);
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9700';
  ov.innerHTML=`
    <div class="modal-box" style="max-width:320px;width:90%">
      <div class="modal-title" style="margin-bottom:6px">Edit Label</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:12px;line-height:1.5">Leave blank to use the date (${dateFallback||'—'}).</div>
      <input type="text" id="_lblt-input" value="${curText.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}" placeholder="Custom label" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">Color</span>
        <input type="color" id="_lblt-color" value="${curColor}" style="width:32px;height:32px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent;cursor:pointer">
        <input type="text" id="_lblt-color-hex" value="${curColor}" maxlength="7" style="flex:1;min-width:0;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:12px;padding:6px 9px">
      </div>
      <div class="modal-btns">
        <button class="modal-confirm" id="_lblt-ok">Save</button>
        <button class="modal-cancel" id="_lblt-off" style="color:#c0392b">Turn Off</button>
        <button class="modal-cancel" id="_lblt-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const input=ov.querySelector('#_lblt-input');
  const cIn=ov.querySelector('#_lblt-color');
  const cHex=ov.querySelector('#_lblt-color-hex');
  input.focus(); input.select();
  cIn.addEventListener('input',()=>{ cHex.value=cIn.value; });
  cHex.addEventListener('input',()=>{ if(/^#[0-9A-Fa-f]{6}$/.test(cHex.value)) cIn.value=cHex.value; });
  const persist=(patch)=>{
    const refreshed=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):entry;
    if(!refreshed) return;
    const updated={...refreshed,...patch};
    if(typeof trSaveEntry==='function') trSaveEntry(updated,pid);
    mapRefreshDateLabels();
    if(_trackerPopup){
      const lngLat=_trackerPopup.getLngLat();
      _showTrackerEntryPopup(lngLat,{id:entryId,categoryId:updated.categoryId,categoryName:updated.categoryName,date:updated.date,measurementValue:updated.measurementValue,measurementUnit:updated.measurementUnit,acres:updated.acres,location:updated.location,status:updated.status,phase:updated.phase,method:updated.method,contractor:updated.contractor,notes:updated.notes});
    }
  };
  ov.querySelector('#_lblt-ok').onclick=()=>{
    const val=input.value.trim();
    const hex=cHex.value.trim();
    const color=/^#[0-9A-Fa-f]{6}$/.test(hex)?hex:'#ffffff';
    persist({labelText:val||null,labelColor:color});
    ov.remove();
  };
  ov.querySelector('#_lblt-off').onclick=()=>{ persist({showDateLabel:false}); ov.remove(); };
  ov.querySelector('#_lblt-cancel').onclick=()=>ov.remove();
  input.addEventListener('keydown',e=>{ if(e.key==='Enter') ov.querySelector('#_lblt-ok').click(); });
}

function mapToggleDateLabelEdit(){
  const btn=document.getElementById('map-tr-date-label-btn');
  if(!btn) return;
  const newOn=btn.dataset.on!=='1';
  btn.dataset.on=newOn?'1':'0';
  btn.style.background=newOn?'rgba(201,168,76,0.25)':'none';
  btn.style.borderColor=newOn?'var(--amber)':'rgba(255,255,255,0.15)';
  btn.style.color=newOn?'var(--amber)':'rgba(255,255,255,0.35)';
  btn.textContent=newOn?'🔖 On':'🔖 Label';
  const cfg=document.getElementById('map-tr-label-config');
  if(cfg) cfg.style.display=newOn?'block':'none';
  // Immediately persist — keeps popup and edit modal in sync
  if(_editingEntryId){
    const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
    const entry=(typeof trGetEntry==='function')?trGetEntry(_editingEntryId,pid):null;
    if(entry&&typeof trSaveEntry==='function'){
      trSaveEntry({...entry,showDateLabel:newOn},pid);
      mapRefreshDateLabels();
    }
  }
}
window.mapToggleDateLabelEdit=mapToggleDateLabelEdit;

// ── Brand wordmark composite ──
// Decodes the captured GL canvas blob, draws a translucent dark pill in the
// bottom-left, then composites "GROUND|LOG" wordmark (white + amber pipe) on top
// and re-encodes. Fails open — returns the raw blob if anything throws so capture
// still succeeds without branding.
async function _compositeBrandWordmark(blob, legendCat, pid, scopeEntryId, opts){
  try{
    const bmp=await createImageBitmap(blob);
    const c=document.createElement('canvas');
    c.width=bmp.width; c.height=bmp.height;
    const ctx=c.getContext('2d');
    ctx.drawImage(bmp,0,0);
    bmp.close();
    try{ if(document.fonts&&document.fonts.ready) await document.fonts.ready; }catch{}
    // Photo pins + field markers are DOM (mapboxgl.Marker) overlays — they aren't on
    // the GL canvas, so a raw canvas grab misses them. Composite each visible marker
    // onto the image at its projected position (anchor 'bottom' = tip at the point),
    // so an end-of-day map capture actually shows where photos were taken.
    try{
      // ESC-status captures skip the marker overlay — pins/markers are context the
      // deliverable deliberately excludes (clean installation-status image).
      if(_mapInstance&&!(opts&&opts.escCids)){
        const cont=_mapInstance.getContainer();
        const sx=cont&&cont.clientWidth?c.width/cont.clientWidth:1;
        const sy=cont&&cont.clientHeight?c.height/cont.clientHeight:1;
        const markers=[].concat(_mapPhotoMarkers||[],_mapFieldMarkers||[]);
        markers.forEach(m=>{
          if(!m||typeof m.getLngLat!=='function') return;
          const el=typeof m.getElement==='function'?m.getElement():null;
          if(el&&el.style.display==='none') return;
          const pt=_mapInstance.project(m.getLngLat());
          const x=pt.x*sx, y=pt.y*sy;
          const glyph=(el&&el.textContent&&el.textContent.trim())||'📍';
          const fsCSS=el?(parseFloat(getComputedStyle(el).fontSize)||26):26;
          ctx.save();
          ctx.font=`${Math.round(fsCSS*sy)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
          ctx.textAlign='center';
          ctx.textBaseline='bottom';
          ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=4*sy; ctx.shadowOffsetY=2*sy;
          ctx.fillText(glyph,x,y);
          ctx.restore();
        });
      }
    }catch(e){ console.warn('marker composite failed:',e.message); }
    // Optional state-color LEGEND (top-left) — bakes the color meaning into the image so
    // the captured map is self-explanatory in the export. Shown for the category captured.
    if(legendCat && typeof tcGetStates==='function'){
      try{
        const sts=tcGetStates(legendCat,pid).filter(s=>!s.isPlanned);
        if(sts.length){
          const catNm=(typeof tcGetName==='function')?tcGetName(legendCat,pid):'Legend';
          const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(legendCat,pid):'ac';
          const mode=(typeof tcProgressMode==='function')?tcProgressMode(legendCat,pid):'';
          const fmtA=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,defUnit):`${(v||0).toFixed(2)} ${defUnit}`;
          // Per-state areas baked into the legend so buried layers' totals stay visible.
          // DISTURBANCE (running-balance/total): net areas (turf, later state wins) + an
          //   "open" total (Σ add) — the SWPPP net-disturbed picture.
          // SEEDING (per-state-vs-plan): GROSS per-state sums (lime→fert→seed→mulch stack
          //   on the same ground; lime under fertilizer still counts its FULL area), and
          //   NO open total — "Total open" is a disturbance concept and must not bleed here.
          const isRunning=(mode==='running-balance'||mode==='running-total');
          const areaByState={}; let openTotal=0, haveAreas=false, flagCount=0;
          try{
            if(typeof trGetEntriesForProject==='function'){
              let inst=trGetEntriesForProject(pid).filter(e=>(e.categoryId===legendCat)&&e.entryType!=='planned'&&!e.temporary&&!e.deletedAt);
              // Open repair flags baked into the legend too — the punchlist at a glance.
              let flags=trGetEntriesForProject(pid).filter(e=>(e.categoryId===legendCat)&&e.temporary&&e.tempStatus!=='resolved'&&!e.deletedAt);
              // Scope to ONE drawing/area when requested: the planned area + its layers.
              if(scopeEntryId && typeof trGetEntry==='function'){
                const se=trGetEntry(scopeEntryId,pid);
                const areaId=se?(se.entryType==='planned'?se.id:(se.parentId||se.id)):scopeEntryId;
                inst=inst.filter(e=>e.id===areaId||e.parentId===areaId);
                flags=flags.filter(e=>e.id===areaId||e.parentId===areaId);
              }
              flagCount=flags.length;
              if(isRunning && typeof glStateNetAreasM2==='function'){
                const g=glStateNetAreasM2(inst,sts);
                if(g){
                  haveAreas=true;
                  sts.forEach((s,idx)=>{
                    const a=(typeof glAreaConvertM2==='function')?glAreaConvertM2(g.netM2[s.id]||0,defUnit):0;
                    areaByState[s.id]=a;
                    const cm=(typeof tcStateCountMode==='function')?tcStateCountMode(s,idx,sts,mode):'add';
                    if(cm==='add') openTotal+=a;
                  });
                }
              } else if(typeof trEntryMeasure==='function'){
                const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(legendCat,pid):null;
                sts.forEach(s=>{
                  const a=inst.filter(e=>(e.state||(dcs?dcs.id:null))===s.id)
                    .reduce((sum,e)=>sum+(trEntryMeasure(e,defUnit,pid)||0),0);
                  areaByState[s.id]=a;
                  if(a>0) haveAreas=true;
                });
              }
            }
          }catch{}
          // "Total open" row is disturbance-only; seeding legends carry per-state areas alone.
          const showOpenTotal=isRunning && haveAreas;
          const showFlags=flagCount>0;
          const LP=Math.max(14,Math.round(c.width*0.011));   // inner padding
          const LF=Math.max(13,Math.round(c.height*0.021));  // row font px
          const TF=Math.round(LF*1.08);                      // title font px
          const SW=Math.round(LF*1.15);                      // swatch size
          const ROW=Math.round(LF*1.6);                      // row pitch
          const GAP=Math.round(LF*1.2);                      // label↔area column gap
          ctx.save();
          ctx.textBaseline='middle';
          // measure columns
          ctx.font=`600 ${TF}px system-ui, sans-serif`;
          let maxLabelW=ctx.measureText(catNm).width;
          ctx.font=`500 ${LF}px system-ui, sans-serif`;
          sts.forEach(s=>{ const w=ctx.measureText(s.label).width; if(w>maxLabelW) maxLabelW=w; });
          if(showOpenTotal){ const w=ctx.measureText('Total open').width; if(w>maxLabelW) maxLabelW=w; }
          if(showFlags){ const w=ctx.measureText('🚩 Needs repair').width; if(w>maxLabelW) maxLabelW=w; }
          let maxAreaW=0;
          if(haveAreas){
            sts.forEach(s=>{ const w=ctx.measureText(fmtA(areaByState[s.id]||0)).width; if(w>maxAreaW) maxAreaW=w; });
            if(showOpenTotal){ const w=ctx.measureText(fmtA(openTotal)).width; if(w>maxAreaW) maxAreaW=w; }
          }
          if(showFlags){ const w=ctx.measureText(String(flagCount)).width; if(w>maxAreaW) maxAreaW=w; }
          const contentW=SW+Math.round(LF*0.7)+maxLabelW+((haveAreas||showFlags)?GAP+maxAreaW:0);
          const boxW=Math.round(contentW+LP*2);
          const totalRows=sts.length+(showOpenTotal?1:0)+(showFlags?1:0);
          const boxH=Math.round(LP*1.5+ROW+ROW*totalRows);
          const bx=LP, by=LP, br=Math.round(LF*0.4);
          const areaRightX=bx+boxW-LP;
          ctx.fillStyle='rgba(15,31,46,0.82)';
          ctx.beginPath();
          ctx.moveTo(bx+br,by);
          ctx.arcTo(bx+boxW,by,bx+boxW,by+boxH,br);
          ctx.arcTo(bx+boxW,by+boxH,bx,by+boxH,br);
          ctx.arcTo(bx,by+boxH,bx,by,br);
          ctx.arcTo(bx,by,bx+boxW,by,br);
          ctx.closePath(); ctx.fill();
          // title
          ctx.textAlign='left';
          ctx.font=`600 ${TF}px system-ui, sans-serif`;
          ctx.fillStyle='#C9A84C';
          ctx.fillText(catNm, bx+LP, by+LP*0.75+TF*0.5);
          // state rows (swatch + label + net area)
          ctx.font=`500 ${LF}px system-ui, sans-serif`;
          let ry=by+LP*0.75+ROW;
          sts.forEach(s=>{
            const col=(s.color&&/^#[0-9A-Fa-f]{6}$/.test(s.color))?s.color:'#888888';
            const cy=ry+ROW*0.5, swx=bx+LP, swy=cy-SW/2, sr=Math.round(SW*0.25);
            ctx.fillStyle=col;
            ctx.beginPath();
            ctx.moveTo(swx+sr,swy);
            ctx.arcTo(swx+SW,swy,swx+SW,swy+SW,sr);
            ctx.arcTo(swx+SW,swy+SW,swx,swy+SW,sr);
            ctx.arcTo(swx,swy+SW,swx,swy,sr);
            ctx.arcTo(swx,swy,swx+SW,swy,sr);
            ctx.closePath(); ctx.fill();
            ctx.textAlign='left'; ctx.fillStyle='#ffffff';
            ctx.fillText(s.label, swx+SW+Math.round(LF*0.7), cy);
            if(haveAreas){ ctx.textAlign='right'; ctx.fillStyle='#dfe8f0'; ctx.fillText(fmtA(areaByState[s.id]||0), areaRightX, cy); }
            ry+=ROW;
          });
          // total row (divider + Total open) — disturbance only
          if(showOpenTotal){
            const cy=ry+ROW*0.5;
            ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=Math.max(1,Math.round(LF*0.06));
            ctx.beginPath(); ctx.moveTo(bx+LP, ry+Math.round(ROW*0.08)); ctx.lineTo(bx+boxW-LP, ry+Math.round(ROW*0.08)); ctx.stroke();
            ctx.font=`700 ${LF}px system-ui, sans-serif`;
            ctx.textAlign='left'; ctx.fillStyle='#ffffff'; ctx.fillText('Total open', bx+LP, cy);
            ctx.textAlign='right'; ctx.fillStyle='#C9A84C'; ctx.fillText(fmtA(openTotal), areaRightX, cy);
            ry+=ROW;
          }
          // open repair flags — any category; the punchlist count in the shot
          if(showFlags){
            const cy=ry+ROW*0.5;
            ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=Math.max(1,Math.round(LF*0.06));
            ctx.beginPath(); ctx.moveTo(bx+LP, ry+Math.round(ROW*0.08)); ctx.lineTo(bx+boxW-LP, ry+Math.round(ROW*0.08)); ctx.stroke();
            ctx.font=`700 ${LF}px system-ui, sans-serif`;
            ctx.textAlign='left'; ctx.fillStyle='#ffffff'; ctx.fillText('🚩 Needs repair', bx+LP, cy);
            ctx.textAlign='right'; ctx.fillStyle='#E67E22'; ctx.fillText(String(flagCount), areaRightX, cy);
          }
          ctx.restore();
        }
      }catch(e){ console.warn('legend composite failed:',e.message); }
    }
    // ESC INSTALLATION STATUS legend — one compact row per selected category × state
    // WITH data (zero-quantity states never print; typical ESC categories = one line
    // each). Installed quantities ONLY — no plan totals or % (a partially-drawn plan
    // is a wrong denominator, Tim 7/11) and no plan linework in the image.
    else if(opts&&Array.isArray(opts.escCids)&&opts.escCids.length&&typeof tcGetStates==='function'){
      try{
        const rows=[];
        opts.escCids.forEach(cid=>{
          try{
            const catNm=(typeof tcGetName==='function')?tcGetName(cid,pid):'Category';
            const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ac';
            const sts=tcGetStates(cid,pid).filter(s=>!s.isPlanned&&!/remov/i.test(s.label||''));
            if(!sts.length||typeof trGetEntriesForProject!=='function'||typeof trEntryMeasure!=='function') return;
            const inst=trGetEntriesForProject(pid).filter(e=>((e.categoryId||e.category)===cid)&&!e.deletedAt&&!e.temporary&&!e.deletedFromMap&&!e.archivedFromMap&&e.entryType!=='planned');
            const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cid,pid):null;
            const fmt=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,defUnit):`${(v||0).toFixed(1)} ${defUnit}`;
            sts.forEach(s=>{
              const v=inst.filter(e=>(e.state||(dcs?dcs.id:null))===s.id).reduce((sum,e)=>sum+(trEntryMeasure(e,defUnit,pid)||0),0);
              if(v<=0) return;
              rows.push({color:(s.color&&/^#[0-9A-Fa-f]{6}$/.test(s.color))?s.color:'#888888',
                         label:`${catNm} — ${s.label}`,
                         val:fmt(v)});
            });
          }catch{}
        });
        if(rows.length){
          const title=`🛡️ ESC INSTALLATION STATUS · ${_fmtLabelDate(new Date().toLocaleDateString('en-CA'))}`;
          const LP=Math.max(14,Math.round(c.width*0.011));
          const LF=Math.max(13,Math.round(c.height*0.021));
          const TF=Math.round(LF*1.08);
          const SW=Math.round(LF*1.15);
          const ROW=Math.round(LF*1.6);
          const GAP=Math.round(LF*1.2);
          ctx.save();
          ctx.textBaseline='middle';
          ctx.font=`600 ${TF}px system-ui, sans-serif`;
          let maxW=ctx.measureText(title).width;
          ctx.font=`500 ${LF}px system-ui, sans-serif`;
          let maxLabelW=0,maxValW=0;
          rows.forEach(r=>{
            const lw=ctx.measureText(r.label).width; if(lw>maxLabelW) maxLabelW=lw;
            const vw=ctx.measureText(r.val).width;   if(vw>maxValW)   maxValW=vw;
          });
          const rowW=SW+Math.round(LF*0.7)+maxLabelW+GAP+maxValW;
          if(rowW>maxW) maxW=rowW;
          const boxW=Math.round(maxW+LP*2);
          const boxH=Math.round(LP*1.5+ROW+ROW*rows.length);
          const bx=LP,by=LP,br=Math.round(LF*0.4);
          const valRightX=bx+boxW-LP;
          ctx.fillStyle='rgba(15,31,46,0.82)';
          ctx.beginPath();
          ctx.moveTo(bx+br,by);
          ctx.arcTo(bx+boxW,by,bx+boxW,by+boxH,br);
          ctx.arcTo(bx+boxW,by+boxH,bx,by+boxH,br);
          ctx.arcTo(bx,by+boxH,bx,by,br);
          ctx.arcTo(bx,by,bx+boxW,by,br);
          ctx.closePath(); ctx.fill();
          ctx.textAlign='left';
          ctx.font=`600 ${TF}px system-ui, sans-serif`;
          ctx.fillStyle='#C9A84C';
          ctx.fillText(title,bx+LP,by+LP*0.75+TF*0.5);
          ctx.font=`500 ${LF}px system-ui, sans-serif`;
          let ry=by+LP*0.75+ROW;
          rows.forEach(r=>{
            const cy=ry+ROW*0.5,swx=bx+LP,swy=cy-SW/2,sr=Math.round(SW*0.25);
            ctx.fillStyle=r.color;
            ctx.beginPath();
            ctx.moveTo(swx+sr,swy);
            ctx.arcTo(swx+SW,swy,swx+SW,swy+SW,sr);
            ctx.arcTo(swx+SW,swy+SW,swx,swy+SW,sr);
            ctx.arcTo(swx,swy+SW,swx,swy,sr);
            ctx.arcTo(swx,swy,swx+SW,swy,sr);
            ctx.closePath(); ctx.fill();
            ctx.textAlign='left'; ctx.fillStyle='#ffffff';
            ctx.fillText(r.label,swx+SW+Math.round(LF*0.7),cy);
            ctx.textAlign='right'; ctx.fillStyle='#dfe8f0';
            ctx.fillText(r.val,valRightX,cy);
            ry+=ROW;
          });
          ctx.restore();
        }
      }catch(e){ console.warn('ESC legend composite failed:',e.message); }
    }
    const PAD=Math.max(16,Math.round(c.width*0.012));
    const PILL_H=Math.max(28,Math.round(c.height*0.035));
    const FONT_PX=Math.round(PILL_H*0.50);
    const TEXT_PAD=Math.round(PILL_H*0.55);
    const SPACE=Math.round(FONT_PX*0.28);
    ctx.font=`600 ${FONT_PX}px Oswald, "Arial Narrow", system-ui, sans-serif`;
    const wLeft=ctx.measureText('GROUND').width;
    const wPipe=ctx.measureText('|').width;
    const wRight=ctx.measureText('LOG').width;
    const pillW=Math.round(wLeft+SPACE+wPipe+SPACE+wRight+TEXT_PAD*2);
    const x=PAD, y=c.height-PAD-PILL_H, r=Math.round(PILL_H*0.25);
    ctx.fillStyle='rgba(15,31,46,0.55)';
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+pillW,y,x+pillW,y+PILL_H,r);
    ctx.arcTo(x+pillW,y+PILL_H,x,y+PILL_H,r);
    ctx.arcTo(x,y+PILL_H,x,y,r);
    ctx.arcTo(x,y,x+pillW,y,r);
    ctx.closePath();
    ctx.fill();
    ctx.textBaseline='middle';
    // Visual-center fix: textBaseline='middle' aligns to em-box midpoint, but for
    // all-caps text the visual mass sits above that (no descenders). Nudge down
    // ~10% of font-size to put caps in the optical center of the pill.
    const cy=y+PILL_H/2+Math.round(FONT_PX*0.10);
    let tx=x+TEXT_PAD;
    ctx.fillStyle='#ffffff'; ctx.fillText('GROUND',tx,cy); tx+=wLeft+SPACE;
    ctx.fillStyle='#C9A84C'; ctx.fillText('|',tx,cy); tx+=wPipe+SPACE;
    ctx.fillStyle='#006B75'; ctx.fillText('LOG',tx,cy);
    return await new Promise(res=>c.toBlob(res,'image/png'));
  }catch(e){
    console.warn('_compositeBrandWordmark failed:',e.message);
    return blob;
  }
}

// ── Capture-to-drawing: capture current map view, brand it, save as photo,
//    link it to the popup's tracker entry, then open caption modal with prefill.
// Entry point from the popup 📷 button: close the popup and let the user FRAME the
// shot first (the old flow captured instantly with no feedback, then sat on a silent
// Firebase upload). They pan/zoom, then tap Capture.
function mapCaptureForEntry(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  if(typeof trGetEntry==='function' && !trGetEntry(entryId,pid)){ console.warn('mapCaptureForEntry: entry not found',entryId); return; }
  _captureEntryId=entryId;
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  _showCaptureScopeChoice(entryId);
}
window.mapCaptureForEntry=mapCaptureForEntry;

// Ask what the baked-in legend should cover before framing: the WHOLE category's totals
// (overall-project SS) or just THIS drawing's area (that day's work). Then frame + capture.
function _showCaptureScopeChoice(entryId){
  _hideCaptureBar();
  const bar=document.createElement('div');
  bar.id='_gl-capture-bar';
  bar.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom));z-index:9600;background:rgba(15,31,46,0.96);border:1px solid var(--amber,#C9A84C);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 18px rgba(0,0,0,.55);max-width:92vw';
  bar.innerHTML=`
    <div style="font-family:var(--mono);font-size:11px;color:#dce8f4;text-align:center;line-height:1.4">🏷️ Legend totals for this capture?</div>
    <div style="display:flex;gap:8px">
      <button id="_gl-scope-cat" style="flex:1;background:var(--amber,#C9A84C);border:none;color:#111;padding:9px 10px;border-radius:8px;font-family:var(--mono);font-size:11px;font-weight:700;cursor:pointer">Whole category</button>
      <button id="_gl-scope-draw" style="flex:1;background:var(--s2,#1a2a38);border:1px solid var(--amber,#C9A84C);color:var(--amber,#C9A84C);padding:9px 10px;border-radius:8px;font-family:var(--mono);font-size:11px;font-weight:700;cursor:pointer">This drawing</button>
    </div>
    <button id="_gl-scope-cancel" style="background:none;border:1px solid var(--border,#334);color:var(--muted,#888);padding:7px;border-radius:8px;font-family:var(--mono);font-size:11px;cursor:pointer">Cancel</button>`;
  document.body.appendChild(bar);
  const go=(scope)=>{ _hideCaptureBar(); _showCaptureBar(()=>_doCaptureForEntry(entryId, scope)); };
  document.getElementById('_gl-scope-cat').onclick=()=>go('category');
  document.getElementById('_gl-scope-draw').onclick=()=>go('drawing');
  document.getElementById('_gl-scope-cancel').onclick=_hideCaptureBar;
}

// Standalone map-view capture (not tied to a drawing) — same frame-then-capture
// flow, saves straight to the Photos page (e.g. an end-of-day site map). Triggered
// from the bottom-right FAB palette.
function mapCaptureMapView(){
  if(!_mapInstance) return;
  if(typeof mapCloseFab==='function') mapCloseFab();
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  _showCaptureBar(()=>_doCaptureMapView());
}
window.mapCaptureMapView=mapCaptureMapView;

function _showCaptureBar(onGo){
  _hideCaptureBar();
  const bar=document.createElement('div');
  bar.id='_gl-capture-bar';
  bar.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom));z-index:9600;background:rgba(15,31,46,0.96);border:1px solid var(--amber,#C9A84C);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 18px rgba(0,0,0,.55);max-width:90vw';
  bar.innerHTML=`
    <div style="font-family:var(--mono);font-size:11px;color:#dce8f4;text-align:center;line-height:1.4">📸 Frame your shot — pan &amp; zoom the map, then Capture</div>
    <div style="display:flex;gap:8px">
      <button id="_gl-cap-cancel" style="flex:1;background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#aaa);padding:9px;border-radius:8px;font-family:var(--mono);font-size:12px;cursor:pointer">Cancel</button>
      <button id="_gl-cap-go" style="flex:2;background:var(--amber,#C9A84C);border:none;color:#111;padding:9px;border-radius:8px;font-family:var(--mono);font-size:12px;font-weight:700;cursor:pointer">📷 Capture</button>
    </div>`;
  document.body.appendChild(bar);
  document.getElementById('_gl-cap-cancel').onclick=_hideCaptureBar;
  document.getElementById('_gl-cap-go').onclick=()=>{ _hideCaptureBar(); (typeof onGo==='function'?onGo:()=>_doCaptureForEntry(_captureEntryId))(); };
}
function _hideCaptureBar(){ const b=document.getElementById('_gl-capture-bar'); if(b) b.remove(); }
function _showCaptureToast(msg){ _hideCaptureToast(); const t=document.createElement('div'); t.id='_gl-capture-toast'; t.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom));z-index:9600;background:rgba(15,31,46,0.96);border:1px solid var(--border2,#445);border-radius:10px;padding:10px 16px;font-family:var(--mono);font-size:12px;color:#dce8f4;box-shadow:0 4px 18px rgba(0,0,0,.55)'; t.textContent=msg; document.body.appendChild(t); }
function _hideCaptureToast(){ const t=document.getElementById('_gl-capture-toast'); if(t) t.remove(); }

async function _doCaptureForEntry(entryId, scope){
  if(!_mapInstance) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry){ console.warn('_doCaptureForEntry: entry not found',entryId); return; }
  _showCaptureToast('📷 Capturing…');
  // Let the toast paint and the popup/bar fully clear before grabbing the canvas.
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const canvas=_mapInstance.getCanvas();
  const today=new Date().toLocaleDateString('en-CA');
  const rawBlob=await new Promise(res=>canvas.toBlob(res,'image/png'));
  if(!rawBlob){ _hideCaptureToast(); console.warn('_doCaptureForEntry: canvas returned null'); return; }
  const branded=await _compositeBrandWordmark(rawBlob, entry.categoryId, pid, scope==='drawing'?entryId:null);
  if(typeof phSaveCapturedImage!=='function'){ _hideCaptureToast(); return; }
  _showCaptureToast('☁️ Saving…');
  const catName=(typeof tcGetName==='function')?tcGetName(entry.categoryId,pid):(entry.categoryName||'Drawing');
  const prefill=`${catName} · ${_fmtLabelDate(today)}`;
  const photoEntry=await phSaveCapturedImage(branded,today,prefill);
  if(!photoEntry){ _hideCaptureToast(); console.warn('_doCaptureForEntry: save failed'); return; }
  // Link to entry — also seed photoCaptions so ZIP export filename works
  if(typeof trAddPhotoLink==='function') trAddPhotoLink(entryId,photoEntry.id,pid,'general');
  const refreshed=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(refreshed&&typeof trSaveEntry==='function'){
    const caps={...(refreshed.photoCaptions||{}),[photoEntry.id]:prefill};
    trSaveEntry({...refreshed,photoCaptions:caps},pid);
  }
  _hideCaptureToast();
  // Popup was closed for framing — go straight to the caption modal.
  _showCaptureCaptionModal(entryId,photoEntry.id,prefill);
}

// Standalone capture: grab the current map view, brand it, save to Photos. No
// drawing link, no caption modal (kept simple per the FAB-capture ask).
async function _doCaptureMapView(){
  if(!_mapInstance) return;
  _showCaptureToast('📷 Capturing…');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const canvas=_mapInstance.getCanvas();
  const today=new Date().toLocaleDateString('en-CA');
  const rawBlob=await new Promise(res=>canvas.toBlob(res,'image/png'));
  if(!rawBlob){ _hideCaptureToast(); console.warn('_doCaptureMapView: canvas returned null'); return; }
  const branded=await _compositeBrandWordmark(rawBlob);
  if(typeof phSaveCapturedImage!=='function'){ _hideCaptureToast(); return; }
  _showCaptureToast('☁️ Saving…');
  const prefill=`Site map · ${_fmtLabelDate(today)}`;
  const photoEntry=await phSaveCapturedImage(branded,today,prefill);
  if(!photoEntry){ _hideCaptureToast(); console.warn('_doCaptureMapView: save failed'); return; }
  _showCaptureToast('✓ Saved to Photos');
  setTimeout(_hideCaptureToast,1800);
}

// ── ESC Installation Status capture ──
// FAB 🛡️ row: pick which tracker categories to show, temporarily filter the map to
// plan (faint) + active states of just those categories (open 🚩 flags and
// "Removed"-type states hidden), frame, capture with a compact multi-category
// legend, save to Photos pre-tagged 🌊 SWPPP (auto-attaches to the next QI
// report's §11), then restore the view. KML layers / plan-sheet overlays are
// untouched — the user controls that context via the layers panel.
let _escCapFilter=null;   // {cids:Set<string>} — armed only while framing/capturing

function _escCapEntries(list,cat,pid){
  if(!_escCapFilter) return list;
  if(!_escCapFilter.cids.has(cat.id)) return [];
  // Installed work only (Tim 7/11): plans hidden too — a partially-drawn plan is a
  // misleading baseline, and unexplained faint linework confused the deliverable.
  return list.filter(e=>{
    if(e.temporary&&e.tempStatus!=='resolved') return false;
    const st=(typeof tcEntryState==='function')?tcEntryState(e,cat,pid):null;
    const planned=st?!!st.isPlanned:(e.entryType==='planned');
    if(planned) return false;
    if(st&&/remov/i.test(st.label||'')) return false;
    return true;
  });
}

function _escCapClear(){
  if(!_escCapFilter) return;
  _escCapFilter=null;
  mapRenderTrackerLayers();
  if(typeof mapRefreshDateLabels==='function') mapRefreshDateLabels();
}

function mapCaptureEscStatus(){
  if(!_mapInstance) return;
  if(typeof mapCloseFab==='function') mapCloseFab();
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cats=_sortCatsByOrder((typeof tcGetCategories==='function')?tcGetCategories(pid):[],pid);
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid).filter(e=>!e.deletedFromMap&&!e.archivedFromMap&&e.geometry):[];
  const counts={};
  entries.forEach(e=>{const cid=e.categoryId||e.category; counts[cid]=(counts[cid]||0)+1;});
  const withData=cats.filter(c=>counts[c.id]);
  if(!withData.length){ _showCaptureToast('No tracker drawings to capture'); setTimeout(_hideCaptureToast,1800); return; }
  // Last selection remembered per project (tiny-pref tier); default = linear categories.
  let lastSel=[];
  try{ lastSel=JSON.parse(localStorage.getItem('gl_esc_cap_sel::'+pid)||'[]'); }catch{}
  lastSel=lastSel.filter(id=>withData.some(c=>c.id===id));
  const selected=new Set(lastSel.length?lastSel:withData.filter(c=>c.measurementType==='linear').map(c=>c.id));
  if(!selected.size) withData.forEach(c=>selected.add(c.id));

  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9500';
  const rowBase='display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:12px 14px;border-radius:8px;cursor:pointer;border:2px solid var(--border);background:var(--s1);transition:border-color .15s';
  const rowOn ='display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:12px 14px;border-radius:8px;cursor:pointer;border:2px solid var(--amber);background:var(--s1);transition:border-color .15s';
  const render=()=>{
    const nSel=selected.size;
    ov.innerHTML=`
      <div class="modal-box" style="max-width:360px;width:92%">
        <div class="modal-title" style="margin-bottom:4px">🛡️ ESC Status Capture</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:16px">Pick the controls to show — installed work only; plans, repair flags and removed sections are hidden</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;max-height:46dvh;overflow-y:auto">
          ${withData.map(c=>`
            <button class="_esc-cat" data-cid="${c.id}" style="${selected.has(c.id)?rowOn:rowBase}">
              <span style="font-size:15px;width:18px;flex-shrink:0;text-align:center;color:${selected.has(c.id)?'var(--amber)':'var(--muted)'}">${selected.has(c.id)?'☑':'☐'}</span>
              <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
                <span style="font-family:var(--cond);font-weight:700;font-size:14px;letter-spacing:.03em;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}</span>
                <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">${c.measurementType==='linear'?'linear':'area'} · ${counts[c.id]} entr${counts[c.id]===1?'y':'ies'}</span>
              </span>
            </button>`).join('')}
        </div>
        <button id="_esc-go" ${nSel?'':'disabled'} style="width:100%;padding:12px;background:${nSel?'var(--amber)':'var(--s2,#1a2a38)'};color:${nSel?'#000':'var(--muted)'};font-family:var(--cond);font-weight:700;font-size:14px;letter-spacing:.06em;border:none;border-radius:8px;cursor:${nSel?'pointer':'default'};margin-bottom:8px">📷 Frame &amp; capture${nSel?` (${nSel})`:''}</button>
        <button id="_esc-cancel" style="width:100%;padding:9px;background:none;color:var(--muted);font-family:var(--mono);font-size:11px;border:1px solid var(--border);border-radius:8px;cursor:pointer">Cancel</button>
      </div>`;
    ov.querySelectorAll('._esc-cat').forEach(btn=>{
      btn.onclick=()=>{ const id=btn.dataset.cid; if(selected.has(id)) selected.delete(id); else selected.add(id); render(); };
    });
    ov.querySelector('#_esc-cancel').onclick=()=>ov.remove();
    const goBtn=ov.querySelector('#_esc-go');
    if(goBtn) goBtn.onclick=()=>{
      if(!selected.size) return;
      const sel=[...selected];
      try{ localStorage.setItem('gl_esc_cap_sel::'+pid,JSON.stringify(sel)); }catch{}
      ov.remove();
      _escCapFilter={cids:new Set(sel)};
      mapRenderTrackerLayers();
      if(typeof mapRefreshDateLabels==='function') mapRefreshDateLabels();
      _showCaptureBar(()=>_doCaptureEsc(sel));
      // The shared capture bar's Cancel must also restore the filtered view.
      const cb=document.getElementById('_gl-cap-cancel');
      if(cb) cb.onclick=()=>{ _hideCaptureBar(); _escCapClear(); };
    };
  };
  render();
  document.body.appendChild(ov);
}
window.mapCaptureEscStatus=mapCaptureEscStatus;

async function _doCaptureEsc(cids){
  if(!_mapInstance){ _escCapClear(); return; }
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  _showCaptureToast('📷 Capturing…');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const canvas=_mapInstance.getCanvas();
  const today=new Date().toLocaleDateString('en-CA');
  const rawBlob=await new Promise(res=>canvas.toBlob(res,'image/png'));
  if(!rawBlob){ _hideCaptureToast(); _escCapClear(); console.warn('_doCaptureEsc: canvas returned null'); return; }
  const branded=await _compositeBrandWordmark(rawBlob,null,pid,null,{escCids:cids});
  if(typeof phSaveCapturedImage!=='function'){ _hideCaptureToast(); _escCapClear(); return; }
  _showCaptureToast('☁️ Saving…');
  const prefill=`ESC installation status · ${_fmtLabelDate(today)}`;
  const photoEntry=await phSaveCapturedImage(branded,today,prefill,{swppp:true});
  _escCapClear();
  _hideCaptureToast();
  if(!photoEntry){ console.warn('_doCaptureEsc: save failed'); return; }
  _showCaptureToast('✓ Saved to Photos · 🌊 SWPPP-tagged');
  setTimeout(_hideCaptureToast,2200);
}

// Standalone caption modal for capture flow — writes directly to entry.photoCaptions
// (since we're not inside the entry edit modal's pending state).
function _showCaptureCaptionModal(entryId,photoId,prefill){
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9700';
  const safe=(prefill||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  ov.innerHTML=`
    <div class="modal-box" style="max-width:320px;width:90%">
      <div class="modal-title" style="margin-bottom:6px">Capture Label</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:12px;line-height:1.5">Used as the filename in the photo ZIP export.</div>
      <input type="text" id="_capcap-input" value="${safe}" placeholder="Label for this capture" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin-bottom:14px">
      <div class="modal-btns">
        <button class="modal-confirm" id="_capcap-ok">Save</button>
        <button class="modal-cancel" id="_capcap-skip">Skip</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const input=ov.querySelector('#_capcap-input');
  input.focus(); input.select();
  const persist=(val)=>{
    const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
    const e=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
    if(e&&typeof trSaveEntry==='function'){
      const caps={...(e.photoCaptions||{})};
      if(val) caps[photoId]=val; else delete caps[photoId];
      trSaveEntry({...e,photoCaptions:caps},pid);
    }
    // Also update the photo record's caption so it surfaces in the lightbox
    const photo=(window._phPhotos||[]).find(p=>p.id===photoId);
    if(photo) photo.caption=val||photo.caption||'';
    if(typeof phSaveLocal==='function') phSaveLocal();
    if(typeof phSaveCloud==='function') phSaveCloud();
  };
  ov.querySelector('#_capcap-ok').onclick=()=>{ persist(input.value.trim()); ov.remove(); };
  ov.querySelector('#_capcap-skip').onclick=()=>ov.remove();
  input.addEventListener('keydown',e=>{ if(e.key==='Enter') ov.querySelector('#_capcap-ok').click(); });
}

// Rough bounding-box "size" of a geometry, used to rank overlapping drawings on tap
// (smallest wins). Points = 0, lines biased tiny so a thin line over a polygon wins.
// Handles Firestore JSON-string geometry. Returns Infinity on anything unusable.
function _geomPickArea(g){
  try{
    if(typeof g==='string') g=JSON.parse(g);
    if(!g||!g.type) return Infinity;
    const t=g.type;
    if(t==='Point') return 0;
    let coords=[];
    if(t==='LineString') coords=g.coordinates;
    else if(t==='Polygon') coords=g.coordinates&&g.coordinates[0];
    else if(t==='MultiLineString') coords=g.coordinates&&g.coordinates[0];
    else if(t==='MultiPolygon') coords=g.coordinates&&g.coordinates[0]&&g.coordinates[0][0];
    if(!coords||!coords.length) return Infinity;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const c of coords){ if(c[0]<minX)minX=c[0]; if(c[0]>maxX)maxX=c[0]; if(c[1]<minY)minY=c[1]; if(c[1]>maxY)maxY=c[1]; }
    const area=(maxX-minX)*(maxY-minY);
    return (t==='LineString'||t==='MultiLineString')?area*0.001:area;
  }catch(e){ return Infinity; }
}

// ── Highlight / spotlight (#9) ───────────────────────────────────────────────
// Make a selected drawing OR an entire category really STAND OUT (animated glow +
// bright pulsing outline) — for showing someone something on the map. Not a dim of
// the others; the selection itself pops. Toggle off by re-selecting the same set
// or tapping the floating chip.
let _highlightIds=[], _highlightRAF=null, _highlightT0=0;

function _highlightGeoms(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const feats=[];
  _highlightIds.forEach(id=>{
    const e=(typeof trGetEntry==='function')?trGetEntry(id,pid):null;
    if(!e||!e.geometry) return;
    let g=e.geometry; if(typeof g==='string'){ try{g=JSON.parse(g);}catch(err){ return; } }
    feats.push({type:'Feature',geometry:g,properties:{}});
  });
  return {type:'FeatureCollection',features:feats};
}
function _ensureHighlightLayers(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;
  if(_mapInstance.getSource('tracker-highlight')) return;
  _mapInstance.addSource('tracker-highlight',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  _mapInstance.addLayer({id:'tracker-highlight-glow',type:'line',source:'tracker-highlight',
    filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'LineString']],
    paint:{'line-color':'#FFE680','line-width':14,'line-opacity':0.35,'line-blur':6}});
  _mapInstance.addLayer({id:'tracker-highlight-line',type:'line',source:'tracker-highlight',
    filter:['any',['==',['geometry-type'],'Polygon'],['==',['geometry-type'],'LineString']],
    paint:{'line-color':'#FFD23F','line-width':3.5}});
  _mapInstance.addLayer({id:'tracker-highlight-pt',type:'circle',source:'tracker-highlight',
    filter:['==',['geometry-type'],'Point'],
    paint:{'circle-color':'rgba(255,210,63,0.25)','circle-radius':16,'circle-stroke-color':'#FFD23F','circle-stroke-width':3}});
}
function _raiseHighlightLayers(){
  ['tracker-highlight-glow','tracker-highlight-line','tracker-highlight-pt'].forEach(l=>{ try{ if(_mapInstance.getLayer(l)) _mapInstance.moveLayer(l); }catch(e){} });
}
function _highlightTick(ts){
  if(!_highlightIds.length){ _highlightRAF=null; return; }
  if(!_highlightT0) _highlightT0=ts;
  const t=(ts-_highlightT0)/1000;
  const pulse=0.5+0.5*Math.sin(t*3.4); // 0..1
  if(_mapInstance&&_mapInstance.getLayer('tracker-highlight-glow')){
    try{
      _mapInstance.setPaintProperty('tracker-highlight-glow','line-width',10+12*pulse);
      _mapInstance.setPaintProperty('tracker-highlight-glow','line-opacity',0.18+0.42*pulse);
      _mapInstance.setPaintProperty('tracker-highlight-line','line-width',2.5+2.5*pulse);
      _mapInstance.setPaintProperty('tracker-highlight-pt','circle-radius',12+8*pulse);
    }catch(e){}
  }
  _highlightRAF=requestAnimationFrame(_highlightTick);
}
function _startHighlight(){
  _ensureHighlightLayers();
  if(!_mapInstance.getSource('tracker-highlight')) return;
  _mapInstance.getSource('tracker-highlight').setData(_highlightGeoms());
  _raiseHighlightLayers();
  _showHighlightChip();
  if(!_highlightRAF){ _highlightT0=0; _highlightRAF=requestAnimationFrame(_highlightTick); }
}
function mapClearHighlight(){
  _highlightIds=[];
  if(_highlightRAF){ cancelAnimationFrame(_highlightRAF); _highlightRAF=null; }
  if(_mapInstance&&_mapInstance.getSource('tracker-highlight')){
    try{ _mapInstance.getSource('tracker-highlight').setData({type:'FeatureCollection',features:[]}); }catch(e){}
  }
  _hideHighlightChip();
}
window.mapClearHighlight=mapClearHighlight;
function mapHighlightEntry(id){
  if(!_mapInstance) return;
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  if(_highlightIds.length===1&&_highlightIds[0]===id){ mapClearHighlight(); return; } // toggle off
  _highlightIds=[id];
  _startHighlight();
}
window.mapHighlightEntry=mapHighlightEntry;
function mapHighlightCategory(catId){
  if(!_mapInstance) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const ids=(typeof trGetEntriesForProject==='function')
    ? trGetEntriesForProject(pid).filter(e=>(e.categoryId||e.category)===catId&&!e.deletedFromMap&&!e.archivedFromMap&&e.geometry).map(e=>e.id)
    : [];
  if(!ids.length) return;
  const same=ids.length===_highlightIds.length&&ids.every(i=>_highlightIds.includes(i));
  if(same){ mapClearHighlight(); return; } // toggle off
  _highlightIds=ids;
  _startHighlight();
}
window.mapHighlightCategory=mapHighlightCategory;
function _showHighlightChip(){
  _hideHighlightChip();
  const c=document.createElement('button');
  c.id='_gl-highlight-chip';
  c.style.cssText='position:fixed;left:50%;transform:translateX(-50%);top:calc(var(--app-bar-h, 64px) + 8px);z-index:9500;background:rgba(201,168,76,0.96);border:none;color:#111;font-family:var(--mono);font-size:11px;font-weight:700;padding:7px 14px;border-radius:20px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.5)';
  c.textContent='✨ Highlighting — tap to clear';
  c.onclick=mapClearHighlight;
  document.body.appendChild(c);
}
function _hideHighlightChip(){ const c=document.getElementById('_gl-highlight-chip'); if(c) c.remove(); }

function mapRenderTrackerLayers(){
  if(!_mapInstance||!_mapInstance.isStyleLoaded()) return;
  // Keep an open legend in sync if a state color/label changed.
  if(_legendCatId) mapRenderLegend();

  if(!_labelTopGuardRegistered){
    _labelTopGuardRegistered=true;
    // Async layer re-adds (pattern-image loads, style ops) can stack a drawing fill
    // above the label layer after our synchronous re-top runs. Once the map settles,
    // ensure the label is the topmost layer. Cheap: only moves it if it isn't already.
    _mapInstance.on('idle',()=>{
      const lyr='tracker-date-labels-layer';
      if(!_mapInstance.getLayer(lyr)) return;
      const layers=(_mapInstance.getStyle()||{}).layers||[];
      if(layers.length && layers[layers.length-1].id!==lyr){
        try{_mapInstance.moveLayer(lyr);}catch(e){}
      }
    });
  }

  if(!_trackerClickHandlerRegistered){
    _trackerClickHandlerRegistered=true;
    _mapInstance.on('click',e=>{
      if(_drawMode) return;
      // Placing a repair flag — that tap belongs to the flag placement handler.
      if(_placingFlagParentId) return;
      const clickTarget=e.originalEvent&&e.originalEvent.target;
      // Don't open tracker popup when user clicked a photo pin or field marker
      if(clickTarget&&clickTarget.closest&&(
        clickTarget.closest('._photo-marker') ||
        clickTarget.closest('[data-marker-id]') ||
        clickTarget.closest('.mapboxgl-marker')
      )) return;
      const style=_mapInstance.getStyle();
      if(!style||!style.layers) return;
      const lids=style.layers.map(l=>l.id).filter(id=>/^tracker-.+-(fill|line|circle)$/.test(id));
      if(!lids.length) return;
      // Stacked drawings: query the EXACT point first (what's truly under the finger);
      // only widen to a 22px finger radius if nothing's directly hit. Then, when more
      // than one drawing overlaps, pick the smallest-area (most specific) one so a small
      // drawing on top of a large plan wins instead of mapbox's render-order first hit.
      let cands=_mapInstance.queryRenderedFeatures(e.point,{layers:lids});
      if(!cands.length){
        const bbox=[[e.point.x-22,e.point.y-22],[e.point.x+22,e.point.y+22]];
        cands=_mapInstance.queryRenderedFeatures(bbox,{layers:lids});
      }
      if(!cands.length) return;
      let best=cands[0];
      if(cands.length>1){
        const _pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
        const areaOf=fp=>{
          const ent=(fp&&fp.properties&&typeof trGetEntry==='function')?trGetEntry(fp.properties.id,_pid):null;
          return _geomPickArea((ent&&ent.geometry)||fp.geometry);
        };
        let bestA=areaOf(best);
        for(let i=1;i<cands.length;i++){ const a=areaOf(cands[i]); if(a<bestA){ bestA=a; best=cands[i]; } }
      }
      _showTrackerEntryPopup(e.lngLat,best.properties);
    });
  }

  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  // Repair flags honor the FAB visibility toggle (open temporaries only — resolved
  // ones are archived and never reach the map anyway).
  const _flagsOn=_flagsVisible();
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid).filter(e=>!e.deletedFromMap&&!e.archivedFromMap&&(_flagsOn||!(e.temporary&&e.tempStatus!=='resolved'))):[];
  const cats=_sortCatsByOrder((typeof tcGetCategories==='function')?tcGetCategories(pid):[],pid);

  const byCategory={};
  cats.forEach(c=>{byCategory[c.id]=[];});
  entries.forEach(e=>{
    const cid=e.categoryId||e.category;
    if(e.geometry){
      if(byCategory[cid]!==undefined) byCategory[cid].push(e);
      else { if(!byCategory['__orphan']) byCategory['__orphan']=[]; byCategory['__orphan'].push(e); }
    }
  });

  const _rtPid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  cats.forEach(cat=>{
    const src='tracker-'+cat.id;
    const color=cat.color||'#888';
    const visible=_tcLayerVisible[cat.id]!==false;
    const geojson={type:'FeatureCollection',features:(visible?_escCapEntries(byCategory[cat.id],cat,_rtPid):[]).map(e=>{
      // Per-state render props: stateColor drives fill/line color; faint = plan baseline.
      // Open repair flags render attention-amber regardless of state colors.
      const _openTemp=!!(e.temporary&&e.tempStatus!=='resolved');
      const st=(typeof tcEntryState==='function')?tcEntryState(e,cat,_rtPid):null;
      const faint=_openTemp?false:(st?!!st.isPlanned:(e.entryType==='planned'));
      const stateColor=_openTemp?'#C9A84C':((st&&/^#[0-9A-Fa-f]{6}$/.test(st.color))?st.color:color);
      // Per-state line style for the data-driven dasharray (schema editor's Style
      // dropdown); falls back to the category-level lineStyle.
      const stateStyle=_openTemp?'solid':((st&&st.style)||cat.lineStyle||'solid');
      return {
        type:'Feature',
        id:e.id,
        properties:{id:e.id,categoryId:e.categoryId||e.category,categoryName:e.categoryName||e.category,date:e.date,acres:e.acres,measurementValue:e.measurementValue??null,measurementUnit:e.measurementUnit||null,notes:e.notes,location:e.location,phase:e.phase||null,method:e.method||null,status:e.status||null,contractor:e.contractor||null,entryType:e.entryType||'installed',state:e.state||null,stateColor,stateStyle,faint,temporary:!!(e.temporary&&e.tempStatus!=='resolved')},
        geometry:e.geometry
      };
    })};

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
  {
    const orphanByCat={};
    // Seed all previously rendered orphan cids so they get processed (and cleared if now empty).
    _renderedOrphanCids.forEach(cid=>{ orphanByCat[cid]={name:cid,entries:[]}; });
    orphans.forEach(e=>{
      const cid=e.categoryId||e.category||'__unk';
      if(!orphanByCat[cid]) orphanByCat[cid]={name:e.categoryName||cid,entries:[]};
      orphanByCat[cid].entries.push(e);
    });
    _renderedOrphanCids.clear();
    Object.entries(orphanByCat).forEach(([cid,group])=>{
      const src='tracker-'+cid;
      const color='#888';
      // Orphan (not-yet-cached) categories can't appear in the ESC checklist — hide
      // them while the ESC capture filter is armed.
      const visible=_tcLayerVisible[cid]!==false&&!_escCapFilter;
      const geojson={type:'FeatureCollection',features:(visible?group.entries:[]).map(e=>({
        type:'Feature',id:e.id,
        properties:{id:e.id,categoryId:e.categoryId||e.category,categoryName:e.categoryName||e.category,date:e.date,acres:e.acres,measurementValue:e.measurementValue??null,measurementUnit:e.measurementUnit||null,notes:e.notes,location:e.location,phase:e.phase||null,method:e.method||null,status:e.status||null,contractor:e.contractor||null,entryType:e.entryType||'installed'},
        geometry:e.geometry
      }))};
      if(group.entries.length===0){
        // No entries — remove source/layers if they exist.
        [src+'-fill',src+'-line',src+'-circle'].forEach(lid=>{ if(_mapInstance.getLayer(lid)) _mapInstance.removeLayer(lid); });
        if(_mapInstance.getSource(src)) _mapInstance.removeSource(src);
      } else {
        _renderedOrphanCids.add(cid);
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
      }
    });
  }
  mapRefreshDateLabels();
  // Safety net (#14 "label persists after hiding"): the layer swaps + pattern-image
  // loads above can transiently flip isStyleLoaded() to false, making the refresh
  // above self-abort and leave a hidden drawing's label on the map. If the style
  // isn't fully settled, re-run the filter once the map goes idle.
  if(_mapInstance&&!_mapInstance.isStyleLoaded()) _mapInstance.once('idle',mapRefreshDateLabels);
  // Keep an active highlight on top of the freshly re-added category layers.
  if(_highlightIds.length) _startHighlight();
}

// Shared popup-button base style — fixed-width grid cells so nothing sticks off the popup.
const _TRP_BTN='width:100%;box-sizing:border-box;padding:7px 4px;border-radius:6px;font-family:var(--mono);font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

// Open the category schema editor from a drawing's popup (closes the popup first,
// else the modal opens behind the higher-z-index popup).
function mapOpenCategoryFromPopup(catId){
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  if(typeof mapShowCategoryDetails==='function') mapShowCategoryDetails(catId);
}
window.mapOpenCategoryFromPopup=mapOpenCategoryFromPopup;
window.mapShowCategoryLegend=mapShowCategoryLegend;
window.mapHideLegend=mapHideLegend;
window.mapRenderLegend=mapRenderLegend;

function _showTrackerEntryPopup(lngLat,props){
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(props.id,pid):null;
  const label=props.categoryName||(typeof tcGetName==='function'?tcGetName(props.categoryId,pid):(props.categoryId||'Unknown'));
  const color=(typeof tcGetColor==='function')?tcGetColor(props.categoryId,pid):'#888';
  let measText=(props.measurementValue!=null&&props.measurementUnit)
    ?((typeof tcFormatMeasurement==='function')?tcFormatMeasurement(props.measurementValue,props.measurementUnit):(props.measurementValue+' '+props.measurementUnit))
    :(props.acres?props.acres+' ac':'');
  // For DISTURBANCE (running-balance/total) drawings, show the NET area — the drawn size
  // double-counts ground that's since been stabilized over. Matches the tracker log,
  // compliance summary, and the export's "Net area" so every surface agrees.
  try{
    const _mode=(typeof tcProgressMode==='function')?tcProgressMode(props.categoryId,pid):'';
    if((_mode==='running-balance'||_mode==='running-total') && entry && entry.entryType!=='planned'
       && typeof glEntryNetAreasM2==='function' && typeof trGetEntriesForProject==='function'){
      const _cat0=(typeof tcGetCategory==='function')?tcGetCategory(props.categoryId,pid):null;
      const _sts=(_cat0&&typeof tcGetStates==='function')?tcGetStates(_cat0,pid).filter(s=>!s.isPlanned):[];
      const _inst=trGetEntriesForProject(pid).filter(e=>e.categoryId===props.categoryId&&e.entryType!=='planned'&&!e.temporary&&!e.deletedAt);
      const _net=glEntryNetAreasM2(_inst,_sts);
      if(_net && _net[props.id]!=null){
        const _du=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(props.categoryId,pid):'ac';
        const _a=(typeof glAreaConvertM2==='function')?glAreaConvertM2(_net[props.id],_du):0;
        measText=((typeof tcFormatMeasurement==='function')?tcFormatMeasurement(_a,_du):`${(_a||0).toFixed(2)} ${_du}`)+' · net';
      }
    }
  }catch{}
  const photoIds=entry?.photoIds||[];
  const photos=(window._phPhotos||[]).filter(p=>photoIds.includes(p.id));
  const seedTagCount=entry?.fields?.seedTagCount||0;
  const reportCount=(entry?.reportIds||[]).length;
  // Photo count moved into the collapsible photo header below — keep seed/report here.
  const badgeRow=(seedTagCount||reportCount)?`<div style="display:flex;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.1)">
    ${seedTagCount?`<span style="color:#dce8f4;font-size:11px">🏷️ ${seedTagCount}</span>`:''}
    ${reportCount?`<span style="color:#dce8f4;font-size:11px">📋 ${reportCount}</span>`:''}
  </div>`:'';
  // Collapsible photo section — saves screen space on phone; tap header to expand.
  // Swipe in the lightbox stays scoped to this drawing's photos.
  const photoIdsLiteral='['+photos.map(p=>`'${p.id}'`).join(',')+']';
  const photoStrip=photos.length?`<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12)">
    <div onclick="mapTogglePopupPhotos(this)" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#dce8f4;user-select:none">
      <span>📷 ${photos.length} photo${photos.length>1?'s':''}</span>
      <span class="_trp-chev" style="margin-left:auto;display:inline-block;transition:transform .15s;transform:rotate(90deg)">▸</span>
    </div>
    <div class="_trp-photos" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">
      ${photos.map(p=>`<img src="${p.thumb}" onclick="phOpenLightbox('${p.id}',${photoIdsLiteral})" style="width:56px;height:56px;object-fit:cover;border-radius:4px;cursor:pointer;border:2px solid rgba(255,255,255,.15)">`).join('')}
    </div>
  </div>`:'';
  const labelOn=entry?.showDateLabel||false;
  // Share-now (submission-sharing-model): owners publish a single record
  // immediately; published records can be unshared (revocation is real).
  const _mineEntry=entry&&(!entry.ownerUid||(window._currentUser&&entry.ownerUid===_currentUser.uid));
  const _isPub=!!entry?.published;
  const shareBtn=_mineEntry?`<button onclick="mapShareTrackerEntry('${props.id}')" style="${_TRP_BTN}grid-column:1/-1;background:${_isPub?'rgba(79,209,197,0.15)':'var(--s2,#1a2a38)'};border:1px solid ${_isPub?'#4FD1C5':'var(--border,#334)'};color:${_isPub?'#4FD1C5':'var(--muted,#888)'}" title="${_isPub?'Visible to project members — tap to unshare':'Publish this drawing to project members now'}">${_isPub?'🌐 Shared with project ✓':'📤 Share with project'}</button>`:'';
  const sharedByNote=(!_mineEntry&&entry)?`<div style="font-size:10px;color:#4FD1C5;margin-top:4px;border-top:1px solid rgba(255,255,255,.08);padding-top:4px">🌐 Shared by a project member</div>`:'';
  // Repair flag (open-until-resolved point marker). Owner-only controls.
  const _isTemp=!!(entry&&entry.temporary&&entry.tempStatus!=='resolved');
  const tempStatusLine=_isTemp?`<div style="color:#C9A84C;display:flex;align-items:center;gap:6px;margin-top:2px">🚩 <b>${(entry.tempLabel||'Repair').replace(/</g,'&lt;')}</b><span style="opacity:.7">· needs attention</span></div>`:'';
  const tempBtn=_mineEntry?(_isTemp
    ?`<button onclick="mapResolveTemporary('${props.id}')" style="${_TRP_BTN}background:rgba(39,174,96,0.18);border:1px solid #27AE60;color:#27AE60" title="Mark fixed — leaves the live map but stays in the punchlist record">✓ Fixed</button>`
    :`<button onclick="mapFlagRepair('${props.id}')" style="${_TRP_BTN}background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#888)" title="Pin a repair / needs-attention flag on this drawing — photo + note, shows on the punchlist until fixed">🚩 Flag repair</button>`):'';
  // Category identity = the multicolor state-ramp chip (same as the tracker log),
  // not a single dot. Falls back to the entry's state color for no-category drawings.
  const _dotFallback=(props.stateColor&&/^#[0-9A-Fa-f]{6}$/.test(props.stateColor))?props.stateColor:color;
  // Which STATE this drawing is in — shown in the always-visible info list.
  const _cat=(typeof tcGetCategory==='function')?tcGetCategory(props.categoryId,pid):null;
  // A repair flag isn't a state layer — suppress the state line for it.
  const _state=(entry&&!_isTemp&&typeof tcEntryState==='function')?tcEntryState(entry,_cat||props.categoryId,pid):null;
  const _stateColor=(props.stateColor&&/^#[0-9A-Fa-f]{6}$/.test(props.stateColor))?props.stateColor
    :((_state&&/^#[0-9A-Fa-f]{6}$/.test(_state.color))?_state.color:_dotFallback);
  const stateLine=_state?`<div style="color:#dce8f4;display:flex;align-items:center;gap:6px"><span style="width:9px;height:9px;border-radius:50%;background:${_stateColor};flex-shrink:0"></span>${_state.label}${_state.isPlanned?' (plan)':''}</div>`:'';
  // Collapsible "Details" — drawing-specific fields beyond the always-visible list
  // (materials, rates, amounts, type). Only built when there's something to show.
  const _f=entry?.fields||{};
  const _isPlanned=entry?.entryType==='planned';
  const _hasV=v=>v!=null&&v!==''&&!(typeof v==='number'&&isNaN(v));
  const _detailRows=[];
  // Per-application fields (material, rate, amounts) belong to the LAYERS drawn on a
  // plan, not the plan itself — so a planned drawing's popup omits them (#5.1).
  if(!_isPlanned){
    if(_hasV(entry?.seedMix)) _detailRows.push(['Mix / Product',entry.seedMix]);
    if(_hasV(_f.appliedRate)) _detailRows.push(['Applied rate',_f.appliedRate]);
    if(_hasV(_f.requiredAmount)) _detailRows.push(['Required',_f.requiredAmount+(_f.requiredUnit?(' '+_f.requiredUnit):'')]);
    if(_hasV(_f.actualAmount)) _detailRows.push(['Actual',_f.actualAmount+(_f.actualUnit?(' '+_f.actualUnit):'')]);
  }
  if(entry&&!_isTemp) _detailRows.push(['Type',_isPlanned?'Planned':'Installed']);
  const detailsBlock=_detailRows.length?`<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12)">
    <div onclick="mapTogglePopupDetails(this)" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#dce8f4;user-select:none">
      <span>ℹ️ Details</span>
      <span class="_trp-chev" style="margin-left:auto;display:inline-block;transition:transform .15s">▸</span>
    </div>
    <div class="_trp-details" style="display:none;margin-top:8px">
      ${_detailRows.map(([k,v])=>`<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:2px 0"><span style="color:#9fb2c4">${k}</span><span style="color:#dce8f4;text-align:right">${v}</span></div>`).join('')}
    </div>
  </div>`:'';
  const html=`<div style="font-family:var(--mono);font-size:12px;min-width:180px;color:#e8e8e8;max-height:calc(100dvh - var(--app-bar-h) - 95px - env(safe-area-inset-bottom) - 16px);overflow-y:auto;overflow-x:hidden">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
      ${(props.categoryId&&typeof tcRampChip==='function')?tcRampChip(props.categoryId,pid,12):`<div style="width:10px;height:10px;border-radius:50%;background:${_dotFallback};flex-shrink:0"></div>`}
      <strong style="color:#fff">${label}</strong>
    </div>
    ${stateLine}
    ${tempStatusLine}
    ${props.date?`<div style="color:#dce8f4">📅 ${props.date}</div>`:''}
    ${measText?`<div style="color:#dce8f4">📐 ${measText}</div>`:''}
    ${props.location?`<div style="color:#dce8f4">📍 ${props.location}</div>`:''}
    ${props.status?`<div style="color:#dce8f4">🔧 ${props.status}</div>`:''}
    ${(props.phase&&props.phase!=='N/A'&&!_isPlanned)?`<div style="color:#dce8f4">🌱 ${props.phase}</div>`:''}
    ${(props.method&&props.method!=='N/A'&&!_isPlanned)?`<div style="color:#dce8f4">⚙️ ${props.method}</div>`:''}
    ${props.contractor?`<div style="color:#dce8f4">👷 ${props.contractor}</div>`:''}
    ${props.notes?`<div style="margin-top:6px;color:#c8d8e8;border-top:1px solid rgba(255,255,255,.1);padding-top:6px">${props.notes}</div>`:''}
    ${badgeRow}
    ${detailsBlock}
    ${photoStrip}
    ${entry?.parentId?`<div style="font-size:10px;color:#a0b8c8;margin-top:4px;border-top:1px solid rgba(255,255,255,.08);padding-top:4px">📍 Linked to planned area</div>`:''}
    ${sharedByNote}
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12)">
      <div onclick="mapTogglePopupActions(this)" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#dce8f4;user-select:none">
        <span>⚡ Actions</span>
        <span class="_trp-chev" style="margin-left:auto;display:inline-block;transition:transform .15s">▸</span>
      </div>
      <div class="_trp-actions" style="display:none;margin-top:8px">
        ${entry?`${_isTemp?'':`<button onclick="mapActivatePlannedEntry('${props.id}')" style="${_TRP_BTN}padding:11px 4px;font-size:12px;background:rgba(201,168,76,0.22);border:1px solid var(--amber,#C9A84C);color:var(--amber,#C9A84C);font-weight:700" title="${entry?.entryType==='planned'?'Draw overlays on this plan':'Stack the next state on this layer'}">📍 Activate</button>`}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
          <button onclick="mapToggleDateLabel('${props.id}')" style="${_TRP_BTN}background:${labelOn?'rgba(201,168,76,0.2)':'var(--s2,#1a2a38)'};border:1px solid ${labelOn?'var(--amber,#C9A84C)':'var(--border,#334)'};color:${labelOn?'var(--amber,#C9A84C)':'var(--muted,#888)'}">🔖${labelOn?' On':' Label'}</button>
          <button onclick="mapHighlightEntry('${props.id}')" style="${_TRP_BTN}background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#888)" title="Make this drawing stand out on the map">✨ Highlight</button>
          <button onclick="mapShowCategoryLegend('${props.categoryId}')" style="${_TRP_BTN}background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#888)" title="Show this category's color key on the map (for screenshots)">🏷️ Legend</button>
          <button onclick="mapOpenCategoryFromPopup('${props.categoryId}')" style="${_TRP_BTN}background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#888)" title="Category settings">⚙ Category</button>
          <button onclick="mapCaptureForEntry('${props.id}')" style="${_TRP_BTN}background:var(--s2,#1a2a38);border:1px solid var(--border,#334);color:var(--muted,#888)" title="Capture map view as photo">📷 Capture</button>
          ${tempBtn}
          ${shareBtn}
        </div>`:''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
          <button onclick="mapEditTrackerEntry('${props.id}')" style="${_TRP_BTN}background:var(--amber,#D97706);border:none;color:#111;font-weight:700">✏️ Edit</button>
          <button onclick="mapDeleteTrackerEntryFromPanel('${props.id}')" style="${_TRP_BTN}background:var(--s2);border:1px solid var(--border);color:var(--muted)">✕ Remove</button>
        </div>
      </div>
    </div>
  </div>`;
  _trackerPopup=new mapboxgl.Popup({offset:14,maxWidth:'250px',closeButton:true,closeOnClick:false,className:'gl-tracker-popup'})
    .setLngLat(lngLat).setHTML(html).addTo(_mapInstance);
}

// Share-now / Unshare a single tracker entry from its popup.
async function mapShareTrackerEntry(id){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const e=(typeof trGetEntry==='function')?trGetEntry(id,pid):null;
  if(!e||typeof trSetPublished!=='function') return;
  if(e.published){
    _confirmModal('Stop sharing this drawing? Project members lose access to it on their next refresh. Your record is untouched.',async function(){
      await trSetPublished([id],false,pid);
      if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
      if(typeof showCloudBanner==='function') showCloudBanner('Drawing unshared — it\'s private again.');
    },'Unshare drawing','Unshare');
  } else {
    await trSetPublished([id],true,pid);
    if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
    if(typeof showCloudBanner==='function') showCloudBanner('✓ Drawing shared — project members can see it now.');
  }
}
window.mapShareTrackerEntry=mapShareTrackerEntry;

// ── Repair flag flow (point-marker punchlist, locked 2026-07-01) ──
// A repair/needs-attention item is a lightweight POINT MARKER pinned on the
// damaged spot — not a state change and not a drawn overlay (drawn lines carry
// the still-open iOS line-draw bugs). It carries a note + field photo, shows on
// the live map (amber dot + 🚩 label) and the compliance-page punchlist until
// resolved, never counts toward totals, and is never deleted. Works on ANY
// tracker drawing (silt fence, disturbance, seeding…).

// FAB visibility toggle for flags — tiny per-project pref, localStorage tier.
function _flagsVisible(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  try{ return localStorage.getItem('gl_flags_vis::'+pid)!=='0'; }catch{ return true; }
}
function mapToggleRepairFlags(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const next=!_flagsVisible();
  try{ localStorage.setItem('gl_flags_vis::'+pid,next?'1':'0'); }catch{}
  _syncFlagFabBtn();
  mapRenderTrackerLayers();
  if(typeof showCloudBanner==='function') showCloudBanner(next?'🚩 Repair flags shown':'🚩 Repair flags hidden');
}
window.mapToggleRepairFlags=mapToggleRepairFlags;
function _syncFlagFabBtn(){
  const btn=document.getElementById('map-fab-flags-btn');
  if(btn) btn.classList.toggle('active',_flagsVisible());
}

// Step 1 — popup 🚩 → pick the spot. One follow-up tap places the flag.
function mapFlagRepair(parentId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const parent=(typeof trGetEntry==='function')?trGetEntry(parentId,pid):null;
  if(!parent||!_mapInstance) return;
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  _placingFlagParentId=parentId;
  // Cancel chip (mirrors the highlight chip pattern).
  document.getElementById('_rf-cancel-chip')?.remove();
  const chip=document.createElement('div');
  chip.id='_rf-cancel-chip';
  chip.style.cssText='position:fixed;top:calc(var(--app-bar-h,60px) + 10px);left:50%;transform:translateX(-50%);z-index:5100;background:var(--bg);border:1px solid var(--amber,#C9A84C);color:var(--amber,#C9A84C);font-family:var(--mono);font-size:11px;padding:7px 14px;border-radius:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.5)';
  chip.textContent='🚩 Tap the damaged spot — or tap here to cancel';
  chip.onclick=()=>_cancelFlagPlacement();
  document.body.appendChild(chip);
  _mapInstance.once('click',_onFlagPlaceClick);
}
window.mapFlagRepair=mapFlagRepair;
function _cancelFlagPlacement(){
  _placingFlagParentId=null;
  document.getElementById('_rf-cancel-chip')?.remove();
  try{ _mapInstance&&_mapInstance.off('click',_onFlagPlaceClick); }catch{}
}
// Page-switch guard (called from showPage): only tears down the PLACEMENT step —
// an open flag sheet is a modal overlay and manages itself.
function mapCancelFlagPlacement(){ if(!document.getElementById('_rf-ov')) _cancelFlagPlacement(); }
window.mapCancelFlagPlacement=mapCancelFlagPlacement;
function _onFlagPlaceClick(e){
  const parentId=_placingFlagParentId;
  if(!parentId){ return; }
  const lngLat=[e.lngLat.lng,e.lngLat.lat];
  document.getElementById('_rf-cancel-chip')?.remove();
  // Keep _placingFlagParentId set until the sheet closes so the tracker popup
  // click handler stays suppressed for this tap; the sheet clears it.
  _showRepairFlagSheet(parentId,lngLat,null);
}

// Step 2 — the flag sheet: what's wrong + field photo. Sits ABOVE the bottom
// nav (95px + safe-area) — the old temporary sheet covering the nav was a bug.
function _showRepairFlagSheet(parentId,lngLat,existing){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const parent=(typeof trGetEntry==='function')?trGetEntry(parentId,pid):null;
  document.getElementById('_rf-ov')?.remove();
  _pendingPhotoIds=existing?[...(existing.photoIds||[])]:[];
  const parentName=(parent&&(parent.categoryName||parent.location))||'drawing';
  const ov=document.createElement('div');
  ov.className='modal-overlay'; ov.id='_rf-ov';
  ov.style.cssText='z-index:5200;align-items:flex-end;padding:0';
  ov.innerHTML=`<div style="width:100%;background:var(--bg);border-top:1px solid var(--border);border-radius:16px 16px 0 0;padding:16px 16px calc(95px + env(safe-area-inset-bottom) + 12px);display:flex;flex-direction:column;gap:12px;max-height:calc(100dvh - var(--app-bar-h,60px) - 20px);overflow-y:auto">
    <div class="modal-title" style="margin:0;font-size:15px">🚩 ${existing?'Edit repair flag':'Flag a repair'}</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.5">Pinned on <b>${String(parentName).replace(/</g,'&lt;')}</b>. Shows on the map and the punchlist until it's marked fixed. Never counts toward totals.</div>
    <div>
      <label style="${_LABEL_STYLE}">What's wrong</label>
      <input type="text" id="_rf-label" maxlength="60" value="${existing?String(existing.tempLabel||'').replace(/"/g,'&quot;'):''}" placeholder="e.g. blown-out section, undercut, torn fabric" style="${_INPUT_STYLE}width:100%;box-sizing:border-box">
    </div>
    <div>
      <label style="${_LABEL_STYLE}">Details (optional)</label>
      <textarea id="_rf-notes" rows="2" placeholder="Anything the crew needs to know…" style="${_INPUT_STYLE}width:100%;box-sizing:border-box;resize:vertical">${existing?String(existing.notes||'').replace(/</g,'&lt;'):''}</textarea>
    </div>
    <div>
      <label style="${_LABEL_STYLE}">Field photo</label>
      <div id="_rf-photo-strip" style="display:flex;gap:6px;overflow-x:auto;padding:2px 0;min-height:8px"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button id="_rf-take" style="flex:1;padding:10px 4px;border-radius:8px;font-family:var(--mono);font-size:12px;background:rgba(201,168,76,0.15);border:1px solid var(--amber,#C9A84C);color:var(--amber,#C9A84C);cursor:pointer">📷 Take photo</button>
        <button id="_rf-attach" style="flex:1;padding:10px 4px;border-radius:8px;font-family:var(--mono);font-size:12px;background:var(--s1);border:1px solid var(--border);color:var(--muted);cursor:pointer">🖼 Attach existing</button>
      </div>
      <input type="file" id="_rf-file" accept="image/*" capture="environment" style="display:none">
    </div>
    <div style="display:flex;gap:8px">
      <button class="modal-cancel" id="_rf-cancel" style="flex:1">Cancel</button>
      <button class="modal-confirm" id="_rf-save" style="flex:1">${existing?'Save changes':'🚩 Pin flag'}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const done=()=>{ ov.remove(); _placingFlagParentId=null; _pendingPhotoIds=[]; };
  ov.querySelector('#_rf-cancel').onclick=done;
  ov.addEventListener('click',ev=>{ if(ev.target===ov) done(); });
  _rfRefreshStrip();
  // Take photo — straight into the camera on mobile, routed through the normal
  // photo pipeline (EXIF, thumb, Storage), then auto-linked to this flag.
  ov.querySelector('#_rf-take').onclick=()=>ov.querySelector('#_rf-file').click();
  ov.querySelector('#_rf-file').addEventListener('change',async ev=>{
    const files=ev.target.files;
    if(!files||!files.length) return;
    const before=new Set((window._phPhotos||[]).map(p=>p.id));
    const btn=ov.querySelector('#_rf-take');
    btn.textContent='⏳ Saving…'; btn.disabled=true;
    try{ await phHandleFiles(files); }catch(err){ console.warn('flag photo:',err); }
    (window._phPhotos||[]).forEach(p=>{ if(!before.has(p.id)&&!_pendingPhotoIds.includes(p.id)) _pendingPhotoIds.push(p.id); });
    btn.textContent='📷 Take photo'; btn.disabled=false;
    _rfRefreshStrip();
  });
  ov.querySelector('#_rf-attach').onclick=()=>mapShowEntryPhotoPicker();
  ov.querySelector('#_rf-save').onclick=()=>{
    const label=ov.querySelector('#_rf-label').value.trim();
    const notes=ov.querySelector('#_rf-notes').value.trim();
    if(!label){ ov.querySelector('#_rf-label').focus(); return; }
    _saveRepairFlag(parentId,lngLat,existing,label,notes,[..._pendingPhotoIds]);
    done();
  };
}
// The flag sheet's photo strip (thumbs + remove). The attach picker's Done
// button calls mapRefreshEntryPhotoStrip(), which also refreshes this strip.
function _rfRefreshStrip(){
  const strip=document.getElementById('_rf-photo-strip');
  if(!strip) return;
  const photos=_pendingPhotoIds.map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
  strip.innerHTML=photos.map(p=>`
    <div style="position:relative;flex-shrink:0">
      <img src="${p.thumb}" style="width:64px;height:48px;object-fit:cover;border-radius:4px;display:block;border:2px solid var(--amber,#C9A84C)">
      <button onclick="mapRemoveEntryPhoto('${p.id}');_rfRefreshStrip&&_rfRefreshStrip()" style="position:absolute;top:-5px;right:-5px;background:#c0392b;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;color:#fff;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
    </div>`).join('');
}
window._rfRefreshStrip=_rfRefreshStrip;

// Step 3 — save: the flag is a real tracker entry (Point geometry, temporary
// lifecycle) so photos, sharing, cloud sync, and resolve all come for free.
function _saveRepairFlag(parentId,lngLat,existing,label,notes,photoIds){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const parent=(typeof trGetEntry==='function')?trGetEntry(parentId,pid):null;
  const today=document.getElementById('reportDate')?.value||new Date().toLocaleDateString('en-CA');
  const entry=existing?{...existing}:{
    date:today,
    categoryId:(parent&&(parent.categoryId||parent.category))||null,
    categoryName:(parent&&parent.categoryName)||null,
    measurementType:null,
    geometry:{type:'Point',coordinates:lngLat},
    centroidLng:lngLat[0], centroidLat:lngLat[1],
    acres:null, measurementValue:null, measurementUnit:null,
    location:null, phase:null, method:null, status:null, contractor:null,
    fields:{}, seedMix:null, showDateLabel:false, labelText:null, labelColor:null,
    entryType:'installed', parentId:parentId, state:null,
    temporary:true, tempStatus:'open', tempType:'repair',
  };
  entry.tempLabel=label.slice(0,60);
  entry.notes=notes||null;
  entry.photoIds=photoIds;
  const saved=(typeof trSaveEntry==='function')?trSaveEntry(entry,pid):null;
  mapRenderTrackerLayers();
  if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
  if(typeof showCloudBanner==='function') showCloudBanner(existing?'🚩 Flag updated.':'🚩 Flag pinned — it\'s on the punchlist until fixed.');
  return saved;
}

// Resolve = "fixed" — timestamp + optional note into the punchlist history;
// the flag leaves the live map but stays in the record (never deleted).
function mapResolveTemporary(id){
  if(typeof trResolveTemporary!=='function') return;
  document.getElementById('_rfr-ov')?.remove();
  const ov=document.createElement('div');
  ov.className='modal-overlay'; ov.id='_rfr-ov';
  ov.style.cssText='z-index:9000';
  ov.innerHTML=`<div class="modal-box" style="max-width:320px;width:88%">
    <div class="modal-title" style="margin-bottom:8px">✓ Mark fixed</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5">It leaves the live map but stays in the punchlist history (never deleted).</div>
    <label style="${_LABEL_STYLE}">What was done (optional)</label>
    <textarea id="_rfr-note" rows="2" placeholder="e.g. section replaced, re-trenched and staked" style="${_INPUT_STYLE}width:100%;box-sizing:border-box;resize:vertical;margin-bottom:14px"></textarea>
    <div class="modal-btns">
      <button class="modal-confirm" id="_rfr-ok">✓ Fixed</button>
      <button class="modal-cancel" id="_rfr-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#_rfr-cancel').onclick=()=>ov.remove();
  ov.addEventListener('click',ev=>{ if(ev.target===ov) ov.remove(); });
  ov.querySelector('#_rfr-ok').onclick=()=>{
    const note=ov.querySelector('#_rfr-note').value.trim();
    ov.remove();
    trResolveTemporary(id,undefined,note);
    if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
    if(typeof mapRenderTrackerLayers==='function') mapRenderTrackerLayers();
    if(typeof clRender==='function') clRender();
    if(typeof showCloudBanner==='function') showCloudBanner('✓ Fixed — filed in the punchlist history.');
  };
}
window.mapResolveTemporary=mapResolveTemporary;

// Toggle the collapsible Actions block inside a tracker entry popup.
// Collapsed by default — the popup was getting tall enough to run offscreen.
function mapTogglePopupActions(hdr){
  const wrap=hdr.parentElement;
  const block=wrap&&wrap.querySelector('._trp-actions');
  const chev=hdr.querySelector('._trp-chev');
  if(!block) return;
  const open=block.style.display!=='none';
  block.style.display=open?'none':'block';
  if(chev) chev.style.transform=open?'':'rotate(90deg)';
}
window.mapTogglePopupActions=mapTogglePopupActions;

// Toggle the collapsible photo strip inside a tracker entry popup.
function mapTogglePopupPhotos(hdr){
  const wrap=hdr.parentElement;
  const strip=wrap&&wrap.querySelector('._trp-photos');
  const chev=hdr.querySelector('._trp-chev');
  if(!strip) return;
  const open=strip.style.display!=='none';
  strip.style.display=open?'none':'flex';
  if(chev) chev.style.transform=open?'':'rotate(90deg)';
}
window.mapTogglePopupPhotos=mapTogglePopupPhotos;

// Toggle the collapsible Details block inside a tracker entry popup.
function mapTogglePopupDetails(hdr){
  const wrap=hdr.parentElement;
  const block=wrap&&wrap.querySelector('._trp-details');
  const chev=hdr.querySelector('._trp-chev');
  if(!block) return;
  const open=block.style.display!=='none';
  block.style.display=open?'none':'block';
  if(chev) chev.style.transform=open?'':'rotate(90deg)';
}
window.mapTogglePopupDetails=mapTogglePopupDetails;

function mapEditTrackerEntry(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  if(_trackerPopup){_trackerPopup.remove();_trackerPopup=null;}
  // Repair flags are simple point markers — edit through their own slim sheet,
  // not the full drawing modal (which expects a drawn shape + measurements).
  if(entry.temporary&&entry.geometry&&(typeof entry.geometry==='string'?entry.geometry.includes('"Point"'):entry.geometry.type==='Point')){
    const g=typeof entry.geometry==='string'?JSON.parse(entry.geometry):entry.geometry;
    _showRepairFlagSheet(entry.parentId,g.coordinates,entry);
    return;
  }
  _editingEntryId=entryId;
  _pendingDrawFeature={geometry:entry.geometry};
  _drawCategory=entry.categoryId||entry.category;
  _drawEntryType=entry.entryType||'installed';
  _activePlannedEntryId=entry.parentId||null;
  const editTitleEl=document.getElementById('map-tracker-modal-title');
  if(editTitleEl) editTitleEl.textContent=_drawEntryType==='planned'?'Edit Planned Area':'Edit Tracker Entry';
  const editTypeRow=document.getElementById('map-tr-type-row');
  if(editTypeRow) editTypeRow.style.display=_drawEntryType==='planned'?'block':'none';
  document.getElementById('map-tr-date').value=entry.date||'';
  document.getElementById('map-tr-location').value=entry.location||'';
  document.getElementById('map-tr-notes').value=entry.notes||'';
  const dd=_populateEntryDropdowns(_drawCategory);
  // State picker — pre-select the entry's current state (child overlays only).
  const editStateRow=document.getElementById('map-tr-state-row');
  if(editStateRow){
    if(_drawEntryType==='planned'){ editStateRow.style.display='none'; }
    else {
      const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(_drawCategory,pid):null;
      _populateEntryStates(_drawCategory, entry.state||(dcs?dcs.id:null));
      const hasStates=(document.getElementById('map-tr-state')?.options.length||0)>0;
      editStateRow.style.display=hasStates?'block':'none';
    }
  }
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
  const editHasDesc=(dd.phases&&dd.phases.length)||(dd.methods&&dd.methods.length);
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
  const editTrackMat=(typeof tcTrackMaterial==='function')?tcTrackMaterial(editCat,editPid):true;
  _setEntryFieldVisibility(_drawEntryType==='planned', editMeasType, editHasDesc, editTrackMat, _drawCategory, editPid);
  const rateEl=document.getElementById('map-tr-rate');
  if(rateEl) rateEl.value=entry.fields?.appliedRate||'';
  const calcEl=document.getElementById('map-tr-calc-result');
  if(calcEl) calcEl.textContent='—';
  const editActualAmtEl=document.getElementById('map-tr-actual-amt');
  const editActualUnitEl=document.getElementById('map-tr-actual-unit');
  const editSeedTagsEl=document.getElementById('map-tr-seed-tags');
  if(editActualAmtEl) editActualAmtEl.value=entry.fields?.actualAmount!=null?entry.fields.actualAmount:'';
  if(editActualUnitEl) editActualUnitEl.value=entry.fields?.actualUnit||'lbs';
  if(editSeedTagsEl) editSeedTagsEl.value=entry.fields?.seedTagCount!=null?entry.fields.seedTagCount:'';
  const editMixEl=document.getElementById('map-tr-mix-product');
  if(editMixEl) editMixEl.value=entry.seedMix||'';
  const editLabelBtn=document.getElementById('map-tr-date-label-btn');
  const on=!!entry.showDateLabel;
  if(editLabelBtn){
    editLabelBtn.dataset.on=on?'1':'0';
    editLabelBtn.style.background=on?'rgba(201,168,76,0.25)':'none';
    editLabelBtn.style.borderColor=on?'var(--amber)':'rgba(255,255,255,0.15)';
    editLabelBtn.style.color=on?'var(--amber)':'rgba(255,255,255,0.35)';
    editLabelBtn.textContent=on?'🔖 On':'🔖 Label';
  }
  const editLabelText=document.getElementById('map-tr-label-text');
  if(editLabelText) editLabelText.value=entry.labelText||'';
  const editLabelColor=document.getElementById('map-tr-label-color');
  if(editLabelColor) editLabelColor.value=(entry.labelColor&&/^#[0-9A-Fa-f]{6}$/.test(entry.labelColor))?entry.labelColor:'#ffffff';
  const editLabelCfg=document.getElementById('map-tr-label-config');
  if(editLabelCfg) editLabelCfg.style.display=on?'block':'none';
  const editColor=(typeof tcGetColor==='function')?tcGetColor(_drawCategory,editPid):'#888';
  const editName=(typeof tcGetName==='function')?tcGetName(_drawCategory,editPid):(entry.categoryName||_drawCategory||'Unknown');
  document.getElementById('map-tracker-cat-dot').style.background=editColor;
  document.getElementById('map-tracker-cat-label').textContent=editName;
  _pendingPhotoIds=[...(entry.photoIds||[])];
  _pendingPhotoTypes={...(entry.photoTypes||{})};
  _pendingPhotoCaptions={...(entry.photoCaptions||{})};
  mapRefreshEntryPhotoStrip();
  _populateLinkToPlanDropdown(entry.categoryId||entry.category);
  const editLinkSel=document.getElementById('map-tr-link-plan');
  if(editLinkSel&&entry.parentId) editLinkSel.value=entry.parentId;
  if(editMeasType!=='linear') mapTrackerCalc();
  document.getElementById('map-tracker-modal').classList.add('open');
}

function _catUnit(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(_drawCategory,pid):null;
  // Prefer the selected state's rate unit (per-state material), else the category's.
  const st=(typeof _trSelectedState==='function')?_trSelectedState():null;
  return (st&&st.targetRateUnit)||cat?.targetRateUnit||'lbs/ac';
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
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  const children=entry?.entryType==='planned'
    ?((typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid).filter(e=>e.parentId===entryId):[])
    :[];
  const childNote=children.length>0?`<div style="font-family:var(--mono);font-size:11px;color:var(--amber);margin-bottom:10px;padding:8px;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);border-radius:6px">⚠ This planned area has ${children.length} linked installation${children.length===1?'':'s'} — they will be unlinked (not deleted).</div>`:'';
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9000';
  ov.innerHTML=`<div class="modal-box" style="max-width:300px;width:88%">
    <div class="modal-title" style="margin-bottom:10px">Remove Entry</div>
    ${childNote}
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
  // The repair-flag sheet shares _pendingPhotoIds + the attach picker — keep its
  // strip in sync too (no-ops when the sheet isn't open).
  if(typeof _rfRefreshStrip==='function') _rfRefreshStrip();
  const strip=document.getElementById('map-tr-photo-strip');
  if(!strip) return;
  const photos=_pendingPhotoIds.map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
  strip.innerHTML=photos.map(p=>{
    const isTag=(_pendingPhotoTypes[p.id]||'general')==='material_tag';
    const cap=_pendingPhotoCaptions[p.id]||'';
    const badgeLabel=isTag?(cap?cap.slice(0,12)+(cap.length>12?'…':''):'🏷 Mat. Tag'):'General';
    return `
      <div style="display:inline-flex;flex-direction:column;align-items:center;flex-shrink:0;gap:3px">
        <div style="position:relative">
          <img src="${p.thumb}" style="width:64px;height:48px;object-fit:cover;border-radius:4px;display:block;border:2px solid ${isTag?'var(--amber)':'transparent'}">
          <button onclick="mapRemoveEntryPhoto('${p.id}')" style="position:absolute;top:-5px;right:-5px;background:#c0392b;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;color:#fff;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
        </div>
        <button onclick="mapTogglePhotoType('${p.id}')" style="font-family:var(--mono);font-size:8px;padding:2px 4px;border-radius:3px;border:1px solid ${isTag?'var(--amber)':'var(--border)'};background:${isTag?'rgba(201,168,76,0.15)':'var(--s1)'};color:${isTag?'var(--amber)':'var(--muted)'};cursor:pointer;width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center" title="${cap||''}">
          ${badgeLabel}
        </button>
      </div>`;
  }).join('');
}
function mapTogglePhotoType(photoId){
  const cur=_pendingPhotoTypes[photoId]||'general';
  if(cur==='general') _pendingPhotoTypes[photoId]='material_tag';
  _showPhotoCaptionModal(photoId);
}
function _showPhotoCaptionModal(photoId){
  const isTag=(_pendingPhotoTypes[photoId]||'general')==='material_tag';
  const photo=(window._phPhotos||[]).find(p=>p.id===photoId);
  const existing=_pendingPhotoCaptions[photoId]||photo?.caption||'';
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9600';
  ov.innerHTML=`
    <div class="modal-box" style="max-width:300px;width:88%">
      <div class="modal-title" style="margin-bottom:6px">${isTag?'Edit export label':'Label for export'}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:14px;line-height:1.5">Used as the filename in the material tag photo ZIP. Leave blank to use the photo caption.</div>
      <input type="text" id="_phcap-input" value="${existing.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}" placeholder="e.g. Seed tag east section 3" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin-bottom:14px">
      <div class="modal-btns">
        <button class="modal-confirm" id="_phcap-ok">Save</button>
        ${isTag?`<button class="modal-cancel" id="_phcap-remove" style="color:#c0392b">Remove Tag</button>`:''}
        <button class="modal-cancel" id="_phcap-skip">${isTag?'Cancel':'Skip'}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const input=ov.querySelector('#_phcap-input');
  input.focus(); input.select();
  const save=()=>{
    const val=input.value.trim();
    if(val) _pendingPhotoCaptions[photoId]=val;
    else delete _pendingPhotoCaptions[photoId];
    ov.remove(); mapRefreshEntryPhotoStrip();
  };
  ov.querySelector('#_phcap-ok').onclick=save;
  if(isTag) ov.querySelector('#_phcap-remove').onclick=()=>{
    _pendingPhotoTypes[photoId]='general';
    delete _pendingPhotoCaptions[photoId];
    ov.remove(); mapRefreshEntryPhotoStrip();
  };
  ov.querySelector('#_phcap-skip').onclick=()=>{ ov.remove(); mapRefreshEntryPhotoStrip(); };
  input.addEventListener('keydown',e=>{ if(e.key==='Enter') save(); });
}
function mapRemoveEntryPhoto(photoId){
  _pendingPhotoIds=_pendingPhotoIds.filter(id=>id!==photoId);
  delete _pendingPhotoTypes[photoId];
  delete _pendingPhotoCaptions[photoId];
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
window.mapTogglePinKeyword = mapTogglePinKeyword;
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
window.mapMoveKmlFolderOrder = mapMoveKmlFolderOrder;
window.kmlToggleFolderVisibility = kmlToggleFolderVisibility;
window.mapSetPhotoSearch = (q)=>{ _mapPhotoSearch=(q||'').trim().toLowerCase(); mapRenderPhotoPins(); };
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
window.mapResetNorth = mapResetNorth;
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
window.mapSelectCategoryForDraw = mapSelectCategoryForDraw;
window.mapActivateDrawModeTyped = mapActivateDrawModeTyped;
window.mapActivatePlannedEntry = mapActivatePlannedEntry;
window.mapClearActivePlan = mapClearActivePlan;
window.mapDeactivateDrawMode = mapDeactivateDrawMode;
window.mapDrawSetShape = mapDrawSetShape;
window.mapShowTrackerModal = mapShowTrackerModal;
window.mapCloseTrackerModal = mapCloseTrackerModal;
window.mapCancelTrackerEntry = mapCancelTrackerEntry;
window.mapSaveTrackerEntry = mapSaveTrackerEntry;
window.mapActivateMeasure = mapActivateMeasure;
window.mapToggleGpsFollow = mapToggleGpsFollow;
window.mapResetGpsFollow = mapResetGpsFollow;
window.mapCycleGpsMode = mapCycleGpsMode;
window.mapShowTrackerSheet = mapShowTrackerSheet;
window._renderTrackerSheet = _renderTrackerSheet;
window.mapCloseTrackerSheet = mapCloseTrackerSheet;
window.mapTrackerToggleLayer = mapTrackerToggleLayer;
window.mapMoveCatLayerOrder = mapMoveCatLayerOrder;
window.mapSetSessionDate = (d)=>{ _trSessionDate=d; };
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
window.mapTcSetTemplate  = mapTcSetTemplate;
// Category schema editor (details modal) — 2026-06-03
window._cdAddState       = _cdAddState;
window._cdDelState       = _cdDelState;
window._cdMoveState      = _cdMoveState;
window._cdSetPlanned     = _cdSetPlanned;
window._cdSetStateColor  = _cdSetStateColor;
window._cdSetStateLabel  = _cdSetStateLabel;
window._cdSetStateStyle  = _cdSetStateStyle;
window._cdToggleMaterial = _cdToggleMaterial;
window._cdToggleCap      = _cdToggleCap;
window._cdSetCatColor    = _cdSetCatColor;
window._cdSetStateMat    = _cdSetStateMat;
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
window.mapTogglePhotoType = mapTogglePhotoType;
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
