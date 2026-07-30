// ── 📸 In-app camera (lazy chunk) ──────────────────────────────────────────────
// Live-viewfinder camera on @capgo/camera-preview (vetted 7/29 — maintained fork,
// MPL-2.0 free, Capacitor 8). The native preview renders BEHIND the WebView
// (toBack), so index.html's `html.camera-live` rules hide the app DOM and force
// the background chain transparent while the camera is open; on web the plugin's
// getUserMedia implementation renders a <video> inside #gl-cam-feed instead.
//
// TWO-LAYER MODEL (the architecture decision, Tim 7/29): the shot is stored as a
// CLEAN original JPEG plus a metadata record captured at shutter time (GPS,
// compass heading, timestamp, project, caption, location label, tags). The
// branded stamp overlay is a RENDERING of that record, composited on demand at
// share/export time — never baked into the stored pixels — so every element can
// be toggled per photo forever and a clean copy always exists. The viewfinder
// shows the overlay live (WYSIWYG for the stamped rendering).
//
// Per-shot editables (Tim's Solocator workflow): caption + location label carry
// forward from the previous shot (localStorage gl_cam_last::{pid}) and edit via
// the non-blocking post-shot strip. Tag chips (🌊/🌱/🚩) stay armed across shots.

import { CameraPreview } from '@capgo/camera-preview';

let _open=false, _suspended=false, _busy=false;
let _geoWatch=null, _coords=null, _heading=null;
let _tags=new Set(), _ctx=null;
let _clockTimer=null, _stripTimer=null;
let _orientBound=null, _visBound=null, _reframeT=null;

function _pid(){ return (typeof window._activeProjectId==='function')?window._activeProjectId():'default'; }
function _cfg(){ try{ return JSON.parse(localStorage.getItem('msf_projectconfig')||'{}'); }catch{ return {}; } }
function _lastKey(){ return 'gl_cam_last::'+_pid(); }
function _last(){ try{ return JSON.parse(localStorage.getItem(_lastKey())||'{}')||{}; }catch{ return {}; } }
function _saveLast(v){ try{ localStorage.setItem(_lastKey(),JSON.stringify(v)); }catch{} }
function _tagsKey(){ return 'gl_cam_tags::'+_pid(); }
// Per-project default caption (Tim 7/29: "captioned automatically… whatever the
// user chooses in settings") — seeds the carry-forward when nothing's been typed.
function _defCapKey(){ return 'gl_cam_defcap::'+_pid(); }
function _defCap(){ try{ return localStorage.getItem(_defCapKey())||''; }catch{ return ''; } }

const TAGS=[
  {key:'swppp', chip:'🌊 SWPPP'},
  {key:'seed',  chip:'🌱 Seed'},
  {key:'repair',chip:'🚩 Repair'},
];

// ── Stamp element toggles ──
// One set of per-user defaults drives BOTH the live viewfinder preview and the
// rendered stamp (WYSIWYG). Every element stays editable per photo at share time
// because the stamp is render-on-demand — the stored photo is always clean.
const STAMP_KEY='gl_cam_stamp';
const STAMP_ELEMENTS=[
  {key:'gps',     label:'Compass rose (GPS + bearing)'},
  {key:'time',    label:'Date / time'},
  {key:'project', label:'Project + prepared-by line'},
  {key:'caption', label:'Caption + location label'},
  {key:'tags',    label:'Tag badges (🌊 🌱 🚩)'},
  {key:'brand',   label:'Wordmark + record ID (edge strip)'},
];
export function camStampDefaults(){
  const base={gps:true,time:true,project:true,caption:true,tags:true,brand:true};
  try{ return Object.assign(base,JSON.parse(localStorage.getItem(STAMP_KEY)||'{}')); }catch{ return base; }
}
export function camStampSetDefaults(t){
  try{ localStorage.setItem(STAMP_KEY,JSON.stringify(t)); }catch{}
  _camCloudWrite('cameraPrefs',{stampDefaults:JSON.stringify(t)});
}
window.camStampDefaults=camStampDefaults;
window.camStampSetDefaults=camStampSetDefaults;

// ── Cross-device stamp prefs (settings-doc seam — the 7/28 tcfMap pattern) ──
// localStorage stays the fast synchronous cache; the user-subtree settings docs
// carry the cross-device copy. Stamp element toggles are user-global (doc
// 'cameraPrefs'); the default caption is per-project (field on the pid doc,
// alongside tcfMap/kflOrder). One-shot hydrate per session, remote wins;
// local-only values backfill the cloud (organization done before sync shipped).
const _camHydrated=new Set();
function _camCloudWrite(docId,fields){
  try{
    if(typeof window._udb==='function'&&window._fbReady)
      window._udb().collection('settings').doc(docId).set({...fields,_ts:Date.now()},{merge:true}).catch(()=>{});
  }catch{}
}
export function camStampHydrate(){
  if(typeof window._udb!=='function'||!window._fbReady) return;   // retry next open
  const pid=_pid();
  if(!_camHydrated.has('prefs')){
    _camHydrated.add('prefs');
    try{
      window._udb().collection('settings').doc('cameraPrefs').get().then(doc=>{
        const d=doc.exists?doc.data():{};
        if(typeof d.stampDefaults==='string'){
          if(d.stampDefaults!==localStorage.getItem(STAMP_KEY)){
            try{ localStorage.setItem(STAMP_KEY,d.stampDefaults); }catch{}
            if(_open) _renderOverlay();
          }
        } else if(localStorage.getItem(STAMP_KEY)){
          _camCloudWrite('cameraPrefs',{stampDefaults:localStorage.getItem(STAMP_KEY)});
        }
      }).catch(()=>{ _camHydrated.delete('prefs'); });
    }catch{ _camHydrated.delete('prefs'); }
  }
  if(pid!=='default'&&!_camHydrated.has('cap::'+pid)){
    _camHydrated.add('cap::'+pid);
    try{
      window._udb().collection('settings').doc(pid).get().then(doc=>{
        const d=doc.exists?doc.data():{};
        if(typeof d.camDefCap==='string'){
          if(d.camDefCap!==_defCap()){ try{ localStorage.setItem(_defCapKey(),d.camDefCap); }catch{} }
        } else if(_defCap()){
          _camCloudWrite(pid,{camDefCap:_defCap()});
        }
      }).catch(()=>{ _camHydrated.delete('cap::'+pid); });
    }catch{ _camHydrated.delete('cap::'+pid); }
  }
}
window.camStampHydrate=camStampHydrate;

// ── Compass rose — the #27 vision: coordinates in the middle of a compass ──
// Shared by the live viewfinder canvas and the stamp renderer (WYSIWYG).
// HEADING-UP dial (Tim 7/29 v2 refinement): the ring SPINS so the facing
// direction sits under a fixed amber pointer at the top — real-compass
// behavior, the amber N travels the ring as you turn. Letters stay upright.
// GPS coords sit INSIDE the dial; bearing text below it.
function _drawRose(ctx,cx,cy,R,heading,coordLines,bearing){
  const off=heading!=null?-heading:0;             // spin the dial, not the glyphs
  ctx.save();
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2);
  ctx.fillStyle='rgba(8,14,20,0.42)'; ctx.fill();
  ctx.lineWidth=Math.max(1,R*0.035); ctx.strokeStyle='rgba(255,255,255,0.9)'; ctx.stroke();
  for(let a=0;a<360;a+=30){                       // ticks — long at the cardinals
    const rad=(a+off-90)*Math.PI/180, main=a%90===0;
    const r1=R*(main?0.84:0.91), r2=R*0.975;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(rad)*r1, cy+Math.sin(rad)*r1);
    ctx.lineTo(cx+Math.cos(rad)*r2, cy+Math.sin(rad)*r2);
    ctx.lineWidth=Math.max(1,R*(main?0.03:0.018));
    ctx.strokeStyle=main?'rgba(255,255,255,0.95)':'rgba(255,255,255,0.5)';
    ctx.stroke();
  }
  ctx.font=`bold ${Math.round(R*0.22)}px Arial`;  // cardinal letters, N in amber
  for(const [ch,a] of [['N',0],['E',90],['S',180],['W',270]]){
    const rad=(a+off-90)*Math.PI/180, rr=R*0.68;
    ctx.fillStyle=ch==='N'?'#C9A84C':'rgba(255,255,255,0.95)';
    ctx.fillText(ch,cx+Math.cos(rad)*rr,cy+Math.sin(rad)*rr);
  }
  if(heading!=null){                              // fixed amber pointer, straight up
    ctx.beginPath();
    ctx.moveTo(cx, cy-R*1.08);
    ctx.lineTo(cx+Math.sin(0.17)*R*0.86*-1, cy-Math.cos(0.17)*R*0.86);
    ctx.lineTo(cx+Math.sin(0.17)*R*0.86, cy-Math.cos(0.17)*R*0.86);
    ctx.closePath();
    ctx.fillStyle='#C9A84C'; ctx.fill();
  }
  if(coordLines&&coordLines.length){              // the coordinates, mid-dial
    const fs=Math.round(R*0.21), clh=Math.round(fs*1.3);
    let yy=cy-((coordLines.length-1)*clh)/2;
    coordLines.forEach((ln,i)=>{
      ctx.font=`${i<2?fs:Math.round(fs*0.82)}px Arial`;
      ctx.fillStyle=i<2?'#fff':'rgba(255,255,255,0.75)';
      ctx.fillText(ln,cx,yy); yy+=clh;
    });
  }
  if(bearing){                                    // bearing text under the dial
    ctx.font=`bold ${Math.round(R*0.26)}px Arial`;
    ctx.fillStyle='#fff';
    ctx.fillText(bearing,cx,cy+R+Math.round(R*0.32));
  }
  ctx.restore();
}
function _bearingTxt(h){
  if(h==null) return null;
  const dirs=['N','NE','E','SE','S','SW','W','NW'];
  return `${dirs[Math.round(h/45)%8]} ${Math.round(h)}°`;
}

// ── Stamp renderer — the second layer of the two-layer model ──
// Composites the branded overlay from a photo's METADATA RECORD onto its clean
// original at share/export time (photos.js lazy-imports this). Layout (v2,
// Tim 7/29): caption → gold-bar time → project bottom-left; compass rose with
// the coords inside + tag badges bottom-right; the wordmark + record ID run
// vertically up the right edge (Timemark-style signature — and the future slot
// for a per-tenant output logo).
export async function camStampBlob(p, blob, toggles){
  const t=Object.assign(camStampDefaults(),toggles||{});
  const bmp=await createImageBitmap(blob);
  const W=bmp.width, H=bmp.height;
  const c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d');
  ctx.drawImage(bmp,0,0); bmp.close();
  const S=Math.max(18,Math.round(W*0.022));   // base type size ≈ half Timemark's weight
  const pad=Math.round(S*0.9), lh=Math.round(S*1.45);
  ctx.textBaseline='alphabetic';
  ctx.shadowColor='rgba(0,0,0,0.85)'; ctx.shadowBlur=Math.round(S*0.25); ctx.shadowOffsetY=Math.round(S*0.06);
  const cfg=_cfg();
  // Bottom-left block, drawn bottom-up. Visual order top→bottom:
  // caption → time → project (coords moved into the rose, wordmark to the edge).
  const lines=[];
  if(t.project){
    const who=[cfg.preparedBy,cfg.projectName].filter(Boolean).join(' · ');
    if(who) lines.push({txt:who,font:`${S}px Arial`});
  }
  if(t.time){
    const d=new Date(p.takenAt||p.uploadedAt||Date.now());
    lines.push({txt:_fmtClock(d),font:`bold ${Math.round(S*1.12)}px Arial`,bar:true});
  }
  if(t.caption){
    const bits=[p.locLabel,p.caption].filter(Boolean).join(' · ');
    if(bits) lines.push({txt:bits,font:`${S}px Arial`});
  }
  let y=H-pad;
  for(const ln of lines){
    ctx.font=ln.font; ctx.fillStyle='#ffffff';
    let x=pad;
    if(ln.bar){
      ctx.save(); ctx.shadowBlur=0;
      ctx.fillStyle='#C9A84C';
      ctx.fillRect(pad, y-Math.round(S*1.02), Math.round(S*0.18), Math.round(S*1.24));
      ctx.restore();
      x=pad+Math.round(S*0.55);
      ctx.fillStyle='#ffffff';
    }
    ctx.fillText(ln.txt,x,y,Math.round(W*0.72));
    y-=lh;
  }
  // Bottom-right: compass rose (coords inside, bearing below) + tag badges above.
  // Everything right-of-rose leaves a lane for the vertical edge strip.
  const laneR=Math.round(S*1.6);                  // edge-strip lane width
  let tagY=H-pad;
  if(t.gps&&(p.lat!=null&&p.lng!=null||p.direction!=null)){
    const R=Math.round(S*3.1);
    const cx=W-laneR-R, cy=H-pad-R-Math.round(R*0.55);
    const coordLines=[];
    if(p.lat!=null&&p.lng!=null){
      coordLines.push((+p.lat).toFixed(5), (+p.lng).toFixed(5));
      if(p.gpsAcc!=null) coordLines.push(`±${Math.round(p.gpsAcc*3.28084)} ft`);
      if(p.alt!=null) coordLines.push(`EL ${Math.round(p.alt*3.28084).toLocaleString()} ft`);
    }
    _drawRose(ctx,cx,cy,R,p.direction!=null?+p.direction:null,coordLines,_bearingTxt(p.direction!=null?+p.direction:null));
    tagY=cy-R-Math.round(S*1.1);
  }
  if(t.tags){
    const em=[p.swppp?'🌊':null,p.seedTag?'🌱':null,p.repairTag?'🚩':null].filter(Boolean).join(' ');
    if(em){
      ctx.textAlign='right';
      ctx.font=`${Math.round(S*1.3)}px Arial`; ctx.fillStyle='#ffffff';
      ctx.fillText(em,W-laneR,tagY);
      ctx.textAlign='left';
    }
  }
  // Right edge: vertical wordmark + record ID (the brand/verification signature).
  if(t.brand){
    ctx.save();
    ctx.translate(W-Math.round(S*0.45), H-pad);
    ctx.rotate(-Math.PI/2);
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
    const fs=Math.round(S*0.92), gap=Math.round(fs*0.18);
    let x=0;
    const seg=(txt,color,font)=>{ ctx.font=font||`bold ${fs}px Arial`; ctx.fillStyle=color; ctx.fillText(txt,x,0); x+=ctx.measureText(txt).width+gap; };
    seg('GROUND','#ffffff');
    seg('|','#C9A84C');
    seg('LOG','#38b6c4');
    if(p.id) seg(`  ·  ${String(p.id).toUpperCase()}`,'rgba(255,255,255,0.72)',`${Math.round(fs*0.85)}px Arial`);
    ctx.restore();
  }
  return await new Promise(res=>c.toBlob(res,'image/jpeg',0.92));
}
window.camStampBlob=camStampBlob;

function _fmtClock(d){
  const t=d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  const dt=d.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'});
  return `${t} │ ${dt}`;
}
// Live rose (viewfinder) — same _drawRose as the stamp, repainted on GPS /
// heading updates. Sized in CSS px, backed at devicePixelRatio for crispness.
function _paintRose(){
  const cv=document.getElementById('glc-rose'); if(!cv) return;
  const dpr=window.devicePixelRatio||1;
  const CW=118, CH=150, R=46;
  if(cv.width!==Math.round(CW*dpr)){
    cv.width=Math.round(CW*dpr); cv.height=Math.round(CH*dpr);
    cv.style.width=CW+'px'; cv.style.height=CH+'px';
  }
  const ctx=cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,CW,CH);
  ctx.shadowColor='rgba(0,0,0,0.7)'; ctx.shadowBlur=4;
  const coordLines=[];
  if(_coords){
    coordLines.push(_coords.latitude.toFixed(5), _coords.longitude.toFixed(5));
    if(_coords.accuracy!=null) coordLines.push(`±${Math.round(_coords.accuracy*3.28084)} ft`);
    if(_coords.altitude!=null) coordLines.push(`EL ${Math.round(_coords.altitude*3.28084).toLocaleString()} ft`);
  } else coordLines.push('GPS','acquiring…');
  _drawRose(ctx,CW/2,R+6,R,_heading,coordLines,_bearingTxt(_heading)||'—');
}

function _toast(msg){
  let t=document.getElementById('glc-toast');
  if(!t){
    t=document.createElement('div'); t.id='glc-toast';
    t.style.cssText='position:fixed;left:50%;transform:translateX(-50%);top:calc(70px + env(safe-area-inset-top));z-index:11500;background:rgba(10,18,26,.92);border:1px solid var(--amber,#C9A84C);border-radius:10px;padding:9px 14px;font-family:var(--mono);font-size:12px;color:#dce8f4';
    // Mount INSIDE #gl-camera — html.camera-live hides every other body child,
    // so a body-mounted toast would be invisible while the camera is open.
    (document.getElementById('gl-camera')||document.body).appendChild(t);
  }
  t.textContent=msg;
  clearTimeout(t._h); t._h=setTimeout(()=>t.remove(),2400);
}

// ── open / close ──
export async function camOpen(ctx){
  if(_open) return;
  _ctx=ctx||null;
  _open=true; _suspended=false; _coords=null; _heading=null;
  // Armed tags: launch context wins (e.g. 📷 from a punchlist item arms 🚩),
  // else the per-project remembered set.
  try{ _tags=new Set(ctx&&Array.isArray(ctx.tags)?ctx.tags:JSON.parse(localStorage.getItem(_tagsKey())||'[]')); }catch{ _tags=new Set(); }
  // Seed the caption carry-forward from the per-project default on first use.
  { const l=_last(); if(!l.caption&&_defCap()){ _saveLast({...l,caption:_defCap()}); } }
  _buildDom();
  document.documentElement.classList.add('camera-live');
  try{
    await _startSensors();          // permission prompts ride the opening tap gesture
    await _startPreview();
  }catch(e){
    console.warn('camera start failed:',e);
    _toast('✗ Camera unavailable — check permissions');
    camClose();
    return;
  }
  _visBound=_onVis.bind(null);
  document.addEventListener('visibilitychange',_visBound);
  window.addEventListener('resize',_onReframe);
  window.addEventListener('orientationchange',_onReframe);
  camStampHydrate();               // cross-device stamp prefs (eventual — repaints on land)
  _renderOverlay();
  _clockTimer=setInterval(_renderOverlay,30000);
}
window.camOpen=camOpen;

export async function camClose(){
  if(!_open&&!document.getElementById('gl-camera')){ return; }
  _open=false; _suspended=false;
  clearInterval(_clockTimer); _clockTimer=null;
  clearTimeout(_stripTimer); _stripTimer=null;
  clearTimeout(_reframeT); _reframeT=null;
  window.removeEventListener('resize',_onReframe);
  window.removeEventListener('orientationchange',_onReframe);
  if(_visBound){ document.removeEventListener('visibilitychange',_visBound); _visBound=null; }
  if(_orientBound){ window.removeEventListener('deviceorientationabsolute',_orientBound); window.removeEventListener('deviceorientation',_orientBound); _orientBound=null; }
  if(_geoWatch!=null){ try{ navigator.geolocation.clearWatch(_geoWatch); }catch{} _geoWatch=null; }
  try{ await CameraPreview.stop(); }catch{}
  // finally-shaped teardown: a failed stop must NEVER strand the app transparent.
  document.documentElement.classList.remove('camera-live');
  const el=document.getElementById('gl-camera'); if(el) el.remove();
}
window.camClose=camClose;

async function _startPreview(){
  await CameraPreview.start({
    parent:'gl-cam-feed',       // web: <video> mounts here; native ignores + renders toBack
    toBack:true,
    disableAudio:true,          // stills only — never touches the mic
    position:'rear',
    // Full-screen frame (Tim device test 7/29): without an explicit frame the iOS
    // preview sizes to the sensor's 4:3 at the top and leaves the rest black.
    // Given the frame, the native layer aspect-FILLS the whole screen and the
    // overlay text sits on the live image exactly like the rendered stamp.
    // aspectMode 'cover' is that fill behavior made explicit (device-verified in
    // portrait) instead of leaning on whatever the plugin defaults to.
    x:0, y:0,
    width:Math.round(window.innerWidth),
    height:Math.round(window.innerHeight),
    aspectMode:'cover',
    disableExifHeaderStripping:false,
  });
}

// Rotation fix (★ v2 device-test bug): the explicit start frame never re-sizes
// on its own, so landscape→portrait left the preview stuck at the old frame.
// Re-frame the native layer to the new window on every rotation/resize —
// setPreviewSize resizes the running session in place (no stop/restart flicker).
function _onReframe(){
  clearTimeout(_reframeT);
  _reframeT=setTimeout(async()=>{
    if(!_open||_suspended) return;
    if(window.Capacitor?.isNativePlatform?.()){
      try{
        await CameraPreview.setPreviewSize({x:0,y:0,width:Math.round(window.innerWidth),height:Math.round(window.innerHeight)});
      }catch(e){ console.warn('camera reframe failed:',e&&e.message); }
    }
    _renderOverlay();   // web <video> follows CSS; overlay repaints either way
  },250);
}

async function _onVis(){
  // Backgrounding is where camera-preview plugins historically break — stop the
  // native session on hide, restart on return (lock screen / app switcher safe).
  if(!_open) return;
  if(document.hidden){
    _suspended=true;
    try{ await CameraPreview.stop(); }catch{}
  } else if(_suspended){
    _suspended=false;
    try{ await _startPreview(); }
    catch(e){ console.warn('camera resume failed:',e); _toast('✗ Camera lost — reopening'); camClose(); }
  }
}

// ── sensors ──
async function _startSensors(){
  // GPS via our own pipeline — never trust plugin/EXIF GPS (undocumented on iOS).
  if(navigator.geolocation){
    _geoWatch=navigator.geolocation.watchPosition(
      p=>{ _coords=p.coords; _renderLive(); },
      err=>{ console.warn('camera geo:',err&&err.message); },
      {enableHighAccuracy:true, maximumAge:3000, timeout:15000}
    );
  }
  // Compass: iOS 13+ needs an explicit permission request from a user gesture.
  try{
    if(typeof DeviceOrientationEvent!=='undefined' && typeof DeviceOrientationEvent.requestPermission==='function'){
      const r=await DeviceOrientationEvent.requestPermission();
      if(r!=='granted') return;
    }
  }catch{ return; }
  let lastPaint=0;
  _orientBound=(e)=>{
    let h=null;
    if(typeof e.webkitCompassHeading==='number') h=e.webkitCompassHeading;            // iOS: degrees from north
    else if(e.absolute===true && typeof e.alpha==='number') h=(360-e.alpha)%360;      // spec absolute
    if(h==null) return;
    _heading=h;
    const now=Date.now();
    if(now-lastPaint>120){ lastPaint=now; _renderLive(); }
  };
  window.addEventListener('deviceorientationabsolute',_orientBound);
  window.addEventListener('deviceorientation',_orientBound);
}

// ── DOM ──
function _buildDom(){
  const old=document.getElementById('gl-camera'); if(old) old.remove();
  const cfg=_cfg();
  const last=_last();
  const el=document.createElement('div');
  el.id='gl-camera';
  el.innerHTML=`
    <div id="gl-cam-feed"></div>
    <div class="glc-top">
      <div style="display:flex;gap:8px">
        <button class="glc-close" title="Close camera">✕</button>
        <button class="glc-close glc-gear" title="Stamp elements">⚙</button>
      </div>
      <div class="glc-tags">
        ${TAGS.map(t=>`<button class="glc-chip${_tags.has(t.key)?' on':''}" data-tag="${t.key}">${t.chip}</button>`).join('')}
      </div>
    </div>
    <div class="glc-compass"><canvas id="glc-rose"></canvas></div>
    <div class="glc-edge">GROUND<span class="pipe">|</span><span class="log">LOG</span></div>
    <div class="glc-overlay">
      <div class="glc-line glc-cap"></div>
      <div class="glc-line glc-time"></div>
      <div class="glc-line glc-proj">${(cfg.projectName||'').replace(/</g,'&lt;')}</div>
    </div>
    <button id="glc-shutter" title="Take photo"></button>
    <div id="glc-strip" style="display:none"></div>`;
  document.body.appendChild(el);
  el.querySelector('.glc-close').onclick=()=>camClose();
  el.querySelector('.glc-gear').onclick=_stampSheet;
  el.querySelectorAll('.glc-chip').forEach(btn=>{
    btn.onclick=()=>{
      const k=btn.dataset.tag;
      if(_tags.has(k)) _tags.delete(k); else _tags.add(k);
      btn.classList.toggle('on',_tags.has(k));
      try{ localStorage.setItem(_tagsKey(),JSON.stringify([..._tags])); }catch{}
    };
  });
  document.getElementById('glc-shutter').onclick=_shoot;
  _paintCapLine(last.caption||'', last.loc||'');
}

function _renderOverlay(){
  const el=document.getElementById('gl-camera'); if(!el) return;
  // WYSIWYG: the live preview shows exactly the elements the stamp will render.
  const t=camStampDefaults();
  el.querySelector('.glc-time').style.display=t.time?'':'none';
  el.querySelector('.glc-proj').style.display=t.project?'':'none';
  el.querySelector('.glc-cap').style.display=t.caption?'':'none';
  el.querySelector('.glc-compass').style.display=t.gps?'':'none';
  el.querySelector('.glc-edge').style.display=t.brand?'':'none';
  el.querySelector('.glc-time').textContent=_fmtClock(new Date());
  _renderLive();
}
function _renderLive(){
  if(!document.getElementById('gl-camera')) return;
  _paintRose();
}

// ⚙ Stamp-elements sheet: per-user defaults for what the rendered stamp (and the
// live preview) includes. The photo itself always stores clean + full metadata —
// these are display choices, changeable per photo at share time too.
function _stampSheet(){
  const t=camStampDefaults();
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:11600';
  ov.innerHTML=`
    <div class="modal-box" style="max-width:330px;width:92%">
      <div class="modal-title" style="margin-bottom:6px">⚙ Stamp elements</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:12px;line-height:1.5">What the stamped rendering shows. The saved photo is always clean — you can change these per photo when sharing.</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
        ${STAMP_ELEMENTS.map(e=>`
          <button class="glc-st-row" data-k="${e.key}" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid ${t[e.key]?'var(--amber)':'var(--border)'};background:var(--s1);color:var(--text);font-family:var(--mono);font-size:12px">
            <span style="color:${t[e.key]?'var(--amber)':'var(--muted)'}">${t[e.key]?'☑':'☐'}</span>${e.label}
          </button>`).join('')}
      </div>
      <label style="font-family:var(--mono);font-size:10px;color:var(--muted)">DEFAULT CAPTION (this project — used until you type your own)</label>
      <input type="text" id="glc-st-defcap" value="${_defCap().replace(/"/g,'&quot;')}" placeholder="e.g. Daily SWPPP inspection" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin:4px 0 16px">
      <div class="modal-btns"><button class="modal-confirm" id="glc-st-done">Done</button></div>
    </div>`;
  (document.getElementById('gl-camera')||document.body).appendChild(ov);
  const cur={...t};
  ov.querySelectorAll('.glc-st-row').forEach(btn=>{
    btn.onclick=()=>{
      const k=btn.dataset.k;
      cur[k]=!cur[k];
      btn.style.borderColor=cur[k]?'var(--amber)':'var(--border)';
      const chk=btn.querySelector('span');
      chk.textContent=cur[k]?'☑':'☐';
      chk.style.color=cur[k]?'var(--amber)':'var(--muted)';
      camStampSetDefaults(cur);
      _renderOverlay();
    };
  });
  ov.querySelector('#glc-st-done').onclick=()=>{
    const dc=ov.querySelector('#glc-st-defcap').value.trim();
    const oldDefault=_defCap();
    try{ localStorage.setItem(_defCapKey(),dc); }catch{}
    if(_pid()!=='default') _camCloudWrite(_pid(),{camDefCap:dc});
    // Adopt immediately if the carry-forward is empty or still the old default.
    const l=_last();
    if(dc&&(!l.caption||!l.caption.trim()||l.caption===oldDefault)) _saveLast({...l,caption:dc});
    _paintCapLine(_last().caption||'',_last().loc||'');
    ov.remove();
  };
}
function _paintCapLine(caption,loc){
  const el=document.getElementById('gl-camera'); if(!el) return;
  const bits=[loc,caption].filter(Boolean).join(' · ');
  el.querySelector('.glc-cap').textContent=bits;
}

// ── capture ──
function _b64ToBlob(b64,type){
  const bin=atob(b64.replace(/^data:[^,]+,/,''));
  const arr=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr],{type:type||'image/jpeg'});
}

async function _shoot(){
  if(_busy) return; _busy=true;
  const sh=document.getElementById('glc-shutter'); if(sh) sh.disabled=true;
  try{
    const res=await CameraPreview.capture({quality:92});
    const b64=res&&(res.value||res.base64PictureTaken);
    if(!b64) throw new Error('empty capture result');
    const blob=_b64ToBlob(b64,'image/jpeg');
    const last=_last();
    const meta={
      lat:_coords?_coords.latitude:null,
      lng:_coords?_coords.longitude:null,
      accuracy:_coords&&_coords.accuracy!=null?_coords.accuracy:null,
      altitude:_coords&&_coords.altitude!=null?_coords.altitude:null,   // meters MSL
      heading:_heading,
      caption:last.caption||'',
      locLabel:last.loc||'',
      tags:[..._tags],
      attach:_ctx&&_ctx.attach?_ctx.attach:null,   // B7: PL-item / drawing auto-attach
    };
    if(typeof window.phSaveCameraPhoto!=='function') throw new Error('photo pipeline unavailable');
    const entry=await window.phSaveCameraPhoto(blob,meta);
    if(!entry){ _toast('✗ Save failed — photo not stored'); return; }
    _showStrip(entry,blob);
  }catch(e){
    console.warn('camera capture failed:',e);
    _toast('✗ Capture failed');
  }finally{
    _busy=false;
    const sh2=document.getElementById('glc-shutter'); if(sh2) sh2.disabled=false;
  }
}

// ── post-shot strip (non-blocking) ──
// Thumbnail + the two per-shot editables. Ignore it and keep shooting; tap to
// edit THIS photo's caption/location — saved values become the next shot's
// carry-forward (Tim's W21-style workflow).
function _showStrip(entry,blob){
  const el=document.getElementById('glc-strip'); if(!el) return;
  clearTimeout(_stripTimer);
  const url=URL.createObjectURL(blob);
  const loc=entry.locLabel||'';
  const cap=entry.caption||'';
  el.innerHTML=`
    <img src="${url}" alt="">
    <div class="glc-strip-txt">
      <div>${(loc||cap)?[loc,cap].filter(Boolean).map(s=>s.replace(/</g,'&lt;')).join(' · '):'No caption'}</div>
      <div class="sub">✓ Saved — tap to edit caption / location</div>
    </div>`;
  el.style.display='flex';
  el.onclick=()=>{ clearTimeout(_stripTimer); _stripEdit(entry,el,url); };
  _stripTimer=setTimeout(()=>{ el.style.display='none'; URL.revokeObjectURL(url); },6000);
}

function _stripEdit(entry,strip,objUrl){
  strip.style.display='none';
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:11600';
  const esc=s=>(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  ov.innerHTML=`
    <div class="modal-box" style="max-width:320px;width:90%">
      <div class="modal-title" style="margin-bottom:10px">📸 Photo details</div>
      <label style="font-family:var(--mono);font-size:10px;color:var(--muted)">LOCATION LABEL (e.g. W21)</label>
      <input type="text" id="glc-ed-loc" value="${esc(entry.locLabel)}" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin:4px 0 12px">
      <label style="font-family:var(--mono);font-size:10px;color:var(--muted)">CAPTION</label>
      <input type="text" id="glc-ed-cap" value="${esc(entry.caption)}" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin:4px 0 16px">
      <div class="modal-btns">
        <button class="modal-confirm" id="glc-ed-ok">Save</button>
        <button class="modal-cancel" id="glc-ed-x">Cancel</button>
      </div>
    </div>`;
  // Inside #gl-camera — a body-mounted modal is hidden by the camera-live rules.
  (document.getElementById('gl-camera')||document.body).appendChild(ov);
  const done=()=>{ ov.remove(); if(objUrl) URL.revokeObjectURL(objUrl); };
  ov.querySelector('#glc-ed-x').onclick=done;
  ov.querySelector('#glc-ed-ok').onclick=()=>{
    const loc=ov.querySelector('#glc-ed-loc').value.trim();
    const cap=ov.querySelector('#glc-ed-cap').value.trim();
    entry.locLabel=loc; entry.caption=cap;
    if(typeof window.phSaveLocal==='function') window.phSaveLocal();
    if(typeof window.phSaveCloudOne==='function') window.phSaveCloudOne(entry);
    _saveLast({caption:cap,loc});
    _paintCapLine(cap,loc);
    done();
    _toast('✓ Updated');
  };
  const inp=ov.querySelector('#glc-ed-loc'); inp.focus(); inp.select();
}
