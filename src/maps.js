// ═══════════════════════════════════════════
// FIELD MAP — MAPBOX
// ═══════════════════════════════════════════
let _mapInstance=null, _mapGpsMarker=null, _mapGpsWatch=null;
let _mapCurrentStyle=localStorage.getItem('gl_map_style')||'satellite-streets-v11';

async function mapInit(){
  document.getElementById('map-no-token').style.display='none';
  document.getElementById('map-loading').style.display='flex';
  if(_mapInstance){
    document.getElementById('map-loading').style.display='none';
    setTimeout(()=>{ _mapInstance.resize(); _mapInstance.triggerRepaint(); },150);
    return;
  }
  // Two-token architecture (locked 2026-05-06 — see [[cost-tracker]] Mapbox row,
  // memory feedback_operate_as_if_multi_tenant.md):
  //   - Web platforms read `mapboxToken` (URL-restricted to https://app.groundlog.io
  //     etc.) — defense-in-depth against drive-by token theft.
  //   - iOS native reads `mapboxTokenNative` (no URL restrictions) — required
  //     because Mapbox's allowlist only accepts http/https schemes, but the iOS
  //     WebView origin is `capacitor://app.groundlog.io`. Confirmed via β.1
  //     mapbox-error capture on build #15: 403 Forbidden, capacitor:// referer.
  // Phase 4b will replace both reads with server-side per-firm token issuance
  // via Cloud Function — at which point this branch becomes a single fetch call.
  const _isNativeMap = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  const _tokenField = _isNativeMap ? 'mapboxTokenNative' : 'mapboxToken';
  const _tokenStorageKey = _isNativeMap ? 'gl_map_token_native' : 'gl_map_token';

  let token=(localStorage.getItem(_tokenStorageKey)||'').trim();
  if(!token&&db){
    try{
      let waited=0;
      while(!_fbReady&&waited<5000){await new Promise(r=>setTimeout(r,200));waited+=200;}
      const doc=await _udb().collection('settings').doc('projectConfig').get();
      if(doc.exists&&doc.data()[_tokenField]){
        token=doc.data()[_tokenField].trim();
        localStorage.setItem(_tokenStorageKey,token);
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
  _mapInstance.addControl(new mapboxgl.NavigationControl({showCompass:true}),'bottom-right');
  _mapInstance.on('load',()=>{
    document.getElementById('map-loading').style.display='none';
    setTimeout(()=>_mapInstance.resize(),100);
    mapAddGPSDot();
    mapUpdateStyleButtons();
    mapRenderPhotoPins();
    mapRenderFieldMarkers();
    kmlLoadLayers();
// Long press — desktop
let _lpTimer = null, _lpStartPos = null;
_mapInstance.on('mousedown', e => {
  if(e.originalEvent.button !== 0) return;
  const lngLat = e.lngLat;
  _lpTimer = setTimeout(()=>{ mapShowMarkerModal(lngLat); }, 700);
});
_mapInstance.on('mousemove', ()=> clearTimeout(_lpTimer));
_mapInstance.on('mouseup', ()=> clearTimeout(_lpTimer));
_mapInstance.on('dragstart', ()=>{ clearTimeout(_lpTimer); _lpStartPos=null; });
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
  mapboxgl.accessToken = localStorage.getItem('gl_map_token');
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
  if(token) localStorage.setItem('gl_map_token',token);
  localStorage.setItem('gl_map_style',style);
  if(db&&_fbReady){
    try{
      await _udb().collection('settings').doc('projectConfig').set(
        {mapboxToken:token, mapStyle:style, _ts:Date.now()},
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
let _mapPinFilter = 'all';

function mapSetPinFilter(filter){
  _mapPinFilter = filter;
  document.getElementById('map-pin-range-inputs').style.display = 'none';
  ['all','today','range'].forEach(f => {
    const btn = document.getElementById('map-pin-'+f);
    if(btn) btn.classList.toggle('active', f === filter);
  });
  mapRenderPhotoPins();
}

function mapTogglePinDateRange(){
  _mapPinFilter = 'range';
  ['all','today','range'].forEach(f => {
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

  const today = new Date().toISOString().split('T')[0];
  const fromDate = document.getElementById('map-pin-from')?.value || '';
  const toDate   = document.getElementById('map-pin-to')?.value || '';

  const photos = _phPhotos.filter(p => {
    if(!p.lat || !p.lng) return false;
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
        </div>
      `);

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
      const popup = new mapboxgl.Popup({ offset:20, maxWidth:'200px', closeButton:true })
        .setHTML(`<div style="font-family:monospace;font-size:11px;color:#111">
          <div style="font-size:22px;margin-bottom:4px">${m.emoji}</div>
          ${m.label ? `<div style="font-weight:600;margin-bottom:4px">${m.label}</div>` : ''}
          <div style="color:#555;margin-bottom:6px">${m.scope==='global'?'🌐 Global':'📌 This Project'}</div>
          <button onclick="mapDeleteFieldMarker('${doc.id}')" style="background:#c00;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Delete</button>
        </div>`);
      const marker = new mapboxgl.Marker({ element:el, anchor:'bottom' })
        .setLngLat([m.lng, m.lat]).setPopup(popup).addTo(_mapInstance);
      _mapFieldMarkers.push(marker);
    });
  } catch(e){ console.error('Render field markers failed:', e); }
  mapUpdateFieldMarkerList();
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

function mapImportKml(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const kmlText = e.target.result;
    const kml = new DOMParser().parseFromString(kmlText, 'text/xml');

    function getName(node){
      return node.querySelector('name')?.textContent?.trim() ||
             node.querySelector('n')?.textContent?.trim() || '';
    }

    const fileName = file.name.replace(/\.kml$/i,'');

    function parsePlacemarks(node){
      const features = [];
      node.querySelectorAll('Placemark').forEach(pm=>{
        const name = getName(pm);
        const poly = pm.querySelector('Polygon outerBoundaryIs coordinates') || pm.querySelector('Polygon coordinates');
        const line = pm.querySelector('LineString coordinates');
        const pt = pm.querySelector('Point coordinates');
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

    // Recursively walk KML tree — build flat layerDefs with folderName captured
    const layerDefs = [];
    let autoCount = 0;
    function walkNode(node, parentFolderName){
      const tag = node.tagName;
      if(tag === 'Document'){
        // Documents are always leaf layers — never recurse into them
        const nodeName = getName(node) || fileName;
        const autoLoad = autoCount < 2;
        if(autoLoad) autoCount++;
        layerDefs.push({name:nodeName, folderName:parentFolderName||'', docEl:node, autoLoad});
      } else if(tag === 'Folder'){
        const nodeName = getName(node) || fileName;
        const subFolders = Array.from(node.children).filter(c=>c.tagName==='Folder');
        const subDocs = Array.from(node.children).filter(c=>c.tagName==='Document');
        const directPlacemarks = Array.from(node.children).filter(c=>c.tagName==='Placemark');
        if(subDocs.length > 0){
          // Folder contains Documents — each Document is a layer, this Folder is the group
          subDocs.forEach(doc => walkNode(doc, nodeName));
          subFolders.forEach(f => walkNode(f, nodeName));
        } else if(subFolders.length > 0 && directPlacemarks.length === 0){
          // Folder contains only sub-Folders — recurse, this Folder is a group
          subFolders.forEach(f => walkNode(f, nodeName));
        } else {
          // Folder has direct Placemarks — it's a leaf layer
          const autoLoad = autoCount < 2;
          if(autoLoad) autoCount++;
          layerDefs.push({name:nodeName, folderName:parentFolderName||'', docEl:node, autoLoad});
        }
      }
    }
    const root = kml.querySelector('Folder') || kml.querySelector('Document');
    if(!root){ input.value=''; return; }
    const rootChildren = Array.from(root.children).filter(c=>c.tagName==='Folder'||c.tagName==='Document');
    if(rootChildren.length > 0){
      rootChildren.forEach(child => walkNode(child, ''));
    } else {
      layerDefs.push({name:getName(root)||fileName, folderName:'', docEl:root, autoLoad:true});
    }
    if(layerDefs.length === 0){ input.value=''; return; }

    // Upload original file to Storage once
    const fileId = 'kml-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
    const storagePath = `kml/${_currentUser.uid}/${fileId}.kml`;
    if(storage){
      try{
        await storage.ref(storagePath).put(file);
      }catch(err){ console.warn('KML Storage upload failed:', err.message); }
    }

    // Register all layers — only auto-load first 2
    layerDefs.forEach(({name, folderName, docEl, autoLoad})=>{
      const id = 'kml-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
      const visible = autoLoad;

      if(autoLoad){
        const features = parsePlacemarks(docEl);
        if(features.length > 0){
          _mapInstance.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features}});
          _mapInstance.addLayer({id:id+'-fill',type:'fill',source:id,paint:{'fill-color':'#C9A84C','fill-opacity':0.15},filter:['==',['geometry-type'],'Polygon']});
          _mapInstance.addLayer({id:id+'-line',type:'line',source:id,paint:{'line-color':'#C9A84C','line-width':2},filter:['any',['==',['geometry-type'],'LineString'],['==',['geometry-type'],'Polygon']]});
        }
      }

      _mapKmlLayers.push({id, name, folderName, visible, storagePath});
    });

    kmlSaveLayers();
    mapUpdateKmlLayerList();
    input.value='';
  };
  reader.readAsText(file);
}

function mapReaddKmlLayer(layer, features){
  if(!_mapInstance || !features || !features.length) return;
  if(_mapInstance.getSource(layer.id)) return;
  _mapInstance.addSource(layer.id,{type:'geojson',data:{type:'FeatureCollection',features}});
  _mapInstance.addLayer({id:layer.id+'-fill',type:'fill',source:layer.id,paint:{'fill-color':'#C9A84C','fill-opacity':0.15},filter:['==',['geometry-type'],'Polygon']});
  _mapInstance.addLayer({id:layer.id+'-line',type:'line',source:layer.id,paint:{'line-color':'#C9A84C','line-width':2},filter:['any',['==',['geometry-type'],'LineString'],['==',['geometry-type'],'Polygon']]});
}

function kmlSaveLayers(){
  // Store metadata only — features stay in memory, KML text in Storage
  const data = _mapKmlLayers.map(l=>({id:l.id, name:l.name, folderName:l.folderName||'', visible:l.visible, storagePath:l.storagePath||''}));
  try{ localStorage.setItem('gl_kml_layers', JSON.stringify(data)); }catch{}
  if(db&&_fbReady){
    _udb().collection('kml').doc('layers').set({data, _ts:Date.now()}).catch(e=>console.warn('kmlSaveLayers:',e.message));
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
  
async function kmlLoadLayers(){
  let data = null;
  if(db&&_fbReady){
    try{
      const doc = await _udb().collection('kml').doc('layers').get();
      if(doc.exists) data = doc.data().data;
    }catch(e){ console.warn('kmlLoadLayers cloud:', e.message); }
  }
  if(!data){ try{ const raw=localStorage.getItem('gl_kml_layers'); if(raw) data=JSON.parse(raw); }catch{} }
  if(!data||!data.length) return;

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
        kmlText = await res.text();
      }catch(err){ console.warn('kmlLoadLayers fetch failed:', err.message); }
    }

    // Register all layers, render only visible ones
    layers.forEach(layer=>{
      if(_mapKmlLayers.find(l=>l.id===layer.id)) return;
      _mapKmlLayers.push({...layer});
      if(layer.visible && kmlText){
        const features = kmlParseLayerById(kmlText, layer.name);
        mapReaddKmlLayer(layer, features);
      }
    });
  }
  mapUpdateKmlLayerList();
}

function mapUpdateKmlLayerList(){
  const list = document.getElementById('map-kml-layer-list');
  if(!list) return;
  if(!_mapKmlLayers.length){ list.innerHTML = '<span>No layers imported.</span>'; return; }
  list.innerHTML = '';
  function makeLayerRow(layer){
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--s1);border-radius:6px;margin-bottom:4px;';
    row.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text);flex:1;min-width:0;">
      <input type="checkbox" ${layer.visible?'checked':''} onchange="mapToggleKmlLayerById('${layer.id}',this.checked)">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${layer.name}</span>
    </label>
    <button onclick="mapRemoveKmlLayerById('${layer.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;">✕</button>`;
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
    const allVisible = layers.every(l=>l.visible);
    const someVisible = layers.some(l=>l.visible);
    const folderWrap = document.createElement('div');
    folderWrap.style.cssText = 'margin-bottom:6px;border:1px solid var(--border2);border-radius:6px;overflow:hidden;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--s2);cursor:pointer;';
    header.innerHTML = `
      <span id="${folderId}-chev" style="font-size:10px;color:var(--muted2);">▾</span>
      <input type="checkbox" ${allVisible?'checked':someVisible?'':''}
        style="accent-color:var(--amber);width:14px;height:14px;flex-shrink:0;"
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
    // Folder-level checkbox
    header.querySelector(`#${folderId}-cb`).addEventListener('click', function(e){
      e.stopPropagation();
      kmlToggleFolderVisibility(folderName, this.checked);
    });
    folderWrap.appendChild(header);
    folderWrap.appendChild(children);
    list.appendChild(folderWrap);
  });
  noFolder.forEach(layer => list.appendChild(makeLayerRow(layer)));
}
async function kmlToggleFolderVisibility(folderName, visible){
  const layers = _mapKmlLayers.filter(l=>l.folderName===folderName);
  for(const layer of layers){
    layer.visible = visible;
    if(!visible){
      ['fill','line'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
      if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
    } else {
      if(!_mapInstance.getSource(layer.id) && layer.storagePath && storage){
        try{
          const url = await storage.ref(layer.storagePath).getDownloadURL();
          const res = await fetch(url);
          const kmlText = await res.text();
          const features = kmlParseLayerById(kmlText, layer.name);
          mapReaddKmlLayer(layer, features);
        }catch(err){ console.warn('kmlToggleFolderVisibility:', err.message); }
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
      if(layer.storagePath && storage){
        try{
          const url = await storage.ref(layer.storagePath).getDownloadURL();
          const res = await fetch(url);
          const kmlText = await res.text();
          const features = kmlParseLayerById(kmlText, layer.name);
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
  ['fill','line'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
  if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  _mapKmlLayers.splice(i,1);
  kmlSaveLayers();
  mapUpdateKmlLayerList();
}
function mapRemoveKmlLayerById(id){
  const idx = _mapKmlLayers.findIndex(l=>l.id===id);
  if(idx===-1) return;
  const layer = _mapKmlLayers[idx];
  ['fill','line'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
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
    ['fill','line'].forEach(t=>{ if(_mapInstance.getLayer(layer.id+'-'+t)) _mapInstance.removeLayer(layer.id+'-'+t); });
    if(_mapInstance.getSource(layer.id)) _mapInstance.removeSource(layer.id);
  } else {
    if(!_mapInstance.getSource(layer.id) && layer.storagePath && storage){
      try{
        const url = await storage.ref(layer.storagePath).getDownloadURL();
        const res = await fetch(url);
        const kmlText = await res.text();
        const features = kmlParseLayerById(kmlText, layer.name);
        mapReaddKmlLayer(layer, features);
      }catch(err){ console.warn('mapToggleKmlLayerById:', err.message); }
    }
  }
  kmlSaveLayers();
}

function mapShowExportModal(){
  document.getElementById('map-export-modal').style.display='block';
}

function mapExportKml(){
  const incPhotos = document.getElementById('exp-photo-pins').checked;
  const incMarkers = document.getElementById('exp-field-markers').checked;
  const incKml = document.getElementById('exp-kml-layers').checked;
  const projectName = (JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName) || 'Project';
  const date = new Date().toISOString().split('T')[0];
  let placemarks = '';
  if(incPhotos){
    _phPhotos.filter(p=>p.lat&&p.lng).forEach(p=>{
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
  if(db&&_fbReady){
    try{
      const doc=await _udb().collection('settings').doc('projectConfig').get();
      if(doc.exists){
        const d=doc.data();
        if(d.mapboxToken){ localStorage.setItem('gl_map_token',d.mapboxToken); }
        if(d.mapStyle){ localStorage.setItem('gl_map_style',d.mapStyle); }
      }
    }catch(e){console.warn('mapLoadSettingsFields cloud failed:',e.message);}
  }
  const token=localStorage.getItem('gl_map_token')||'';
  const style=localStorage.getItem('gl_map_style')||'satellite-streets-v11';
  const tf=document.getElementById('cfg-map-token');
  const sf=document.getElementById('cfg-map-style');
  if(tf) tf.value=token;
  if(sf) sf.value=style;
}

function mapResize(){ if(_mapInstance) _mapInstance.resize(); }

// ── Expose to window for HTML onclick handlers and cross-module calls ──
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
window.mapUpdateFieldMarkerList = mapUpdateFieldMarkerList;
window.mapImportKml = mapImportKml;
window.mapReaddKmlLayer = mapReaddKmlLayer;
window.kmlSaveLayers = kmlSaveLayers;
window.kmlParseLayerById = kmlParseLayerById;
window.kmlLoadLayers = kmlLoadLayers;
window.mapUpdateKmlLayerList = mapUpdateKmlLayerList;
window.kmlToggleFolderVisibility = kmlToggleFolderVisibility;
window.mapToggleKmlLayer = mapToggleKmlLayer;
window.mapRemoveKmlLayer = mapRemoveKmlLayer;
window.mapRemoveKmlLayerById = mapRemoveKmlLayerById;
window.mapToggleKmlLayerById = mapToggleKmlLayerById;
window.mapShowExportModal = mapShowExportModal;
window.mapExportKml = mapExportKml;
window.mapLoadSettingsFields = mapLoadSettingsFields;
