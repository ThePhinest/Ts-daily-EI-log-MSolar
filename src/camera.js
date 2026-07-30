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
import { ScreenOrientation } from '@capacitor/screen-orientation';

let _open=false, _suspended=false, _busy=false;
let _geoWatch=null, _coords=null, _heading=null;
let _tags=new Set(), _ctx=null;
let _clockTimer=null, _stripTimer=null;
let _orientBound=null, _visBound=null, _reframeT=null;
// Solocator-style orientation architecture (v3, Tim 7/29 device feedback): the
// INTERFACE is locked to portrait while the camera is open — the native preview
// never reframes (kills the plugin's 4:3 re-shrink on rotation for good) — and
// we track the PHYSICAL hold from the orientation sensor instead. _uiRot is the
// device's rotation from portrait: +90 = rotated clockwise (shutter lands under
// the left hand), -90 = counterclockwise. Overlay elements counter-rotate in
// place (CSS classes), the compass heading gets the ±90 correction, and
// landscape captures are pixel-rotated upright at save.
let _uiRot=0;
const _isNative=()=>!!(window.Capacitor?.isNativePlatform?.());

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
  {key:'brand',   label:'Wordmark watermark (edge strip)'},
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
  const R=Math.round(S*3.1);
  const roseCy=H-pad-R-Math.round(R*0.55);        // rose centre (strip aligns to it)
  let tagY=H-pad;
  if(t.gps&&(p.lat!=null&&p.lng!=null||p.direction!=null)){
    const cx=W-laneR-R;
    const coordLines=[];
    if(p.lat!=null&&p.lng!=null){
      coordLines.push((+p.lat).toFixed(5), (+p.lng).toFixed(5));
      if(p.gpsAcc!=null) coordLines.push(`±${Math.round(p.gpsAcc*3.28084)} ft`);
      if(p.alt!=null) coordLines.push(`EL ${Math.round(p.alt*3.28084).toLocaleString()} ft`);
    }
    _drawRose(ctx,cx,roseCy,R,p.direction!=null?+p.direction:null,coordLines,_bearingTxt(p.direction!=null?+p.direction:null));
    tagY=roseCy-R-Math.round(S*1.1);
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
  // Right edge: vertical wordmark, centred on the rose (Tim 7/29: ID dropped —
  // it lives in the record — leaving a clean brand watermark; future slot for
  // per-tenant output logos).
  if(t.brand){
    ctx.save();
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
    const fs=Math.round(S*0.92), gap=Math.round(fs*0.18);
    ctx.font=`bold ${fs}px Arial`;
    const L=ctx.measureText('GROUND').width+ctx.measureText('|').width+ctx.measureText('LOG').width+gap*2;
    ctx.translate(W-Math.round(S*0.45), Math.min(H-pad, roseCy+L/2));
    ctx.rotate(-Math.PI/2);
    let x=0;
    const seg=(txt,color)=>{ ctx.fillStyle=color; ctx.fillText(txt,x,0); x+=ctx.measureText(txt).width+gap; };
    seg('GROUND','#ffffff');
    seg('|','#C9A84C');
    seg('LOG','#38b6c4');
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
  // Square canvas so the landscape counter-rotation pivots in place.
  const CW=150, CH=150, R=46;
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
  const h=_viewHeading();
  _drawRose(ctx,CW/2,R+8,R,h,coordLines,_bearingTxt(h)||'—');
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
  // Lock the interface to portrait for the whole camera session (native only —
  // browsers reject outside fullscreen). Small settle so innerWidth/Height are
  // portrait before the preview frame is computed.
  if(_isNative()){
    try{ await ScreenOrientation.lock({orientation:'portrait'}); await new Promise(r=>setTimeout(r,60)); }catch{}
  }
  _uiRot=0; _applyUiRot();
  try{
    await _startSensors();          // permission prompts ride the opening tap gesture
    await _startPreview();
  }catch(e){
    console.warn('camera start failed:',e);
    _toast('✗ Camera unavailable — check permissions');
    camClose();
    return;
  }
  _zoomInit();                      // pinch-to-zoom range (async, non-blocking)
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
  if(_isNative()){ try{ ScreenOrientation.unlock(); }catch{} }   // app rotation restored
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
    // Interface is locked to portrait while open — the plugin's own rotation
    // handling (stale-frame updateCameraFrame + 4:3 re-shrink, the v2 square-
    // view bug) must stay OUT of the picture entirely.
    rotateWhenOrientationChanged:false,
    disableExifHeaderStripping:false,
  });
}

// Reframe fallback: with the interface locked, native resizes shouldn't happen;
// if one does (e.g. the lock landing mid-open), restart the preview — the START
// path is the only device-verified full-screen sizing; the plugin's
// setPreviewSize re-shrinks explicit frames toward its internal 4:3 default.
function _onReframe(){
  clearTimeout(_reframeT);
  _reframeT=setTimeout(async()=>{
    if(!_open||_suspended) return;
    if(_isNative()){
      try{ await CameraPreview.stop(); await _startPreview(); _zoomInit(); }
      catch(e){ console.warn('camera reframe restart failed:',e&&e.message); }
    }
    _renderOverlay();   // web <video> follows CSS; overlay repaints either way
  },250);
}

// ── Physical-hold tracking (interface is locked; sensors tell us the truth) ──
// From the same deviceorientation events that carry the compass. The roll about
// the view axis is atan2(gamma, beta): 0 upright, +90 rotated clockwise, -90
// counterclockwise — and the RATIO survives pitching the phone down at a
// subject (the failure mode of raw thresholds: both axes shrink together, the
// desk-shot bug from Tim's device test). Near-flat is genuinely ambiguous
// (same as the native camera) — keep the current state. Snap bands with dead
// zones between them stop the UI flapping mid-rotation.
function _calcUiRot(beta,gamma){
  if(typeof beta!=='number'||typeof gamma!=='number') return _uiRot;
  if(Math.hypot(beta,gamma)<20) return _uiRot;      // phone ~flat: keep current
  const a=Math.atan2(gamma,beta)*180/Math.PI;
  if(a>65&&a<115) return 90;
  if(a<-65&&a>-115) return -90;
  if(Math.abs(a)<25) return 0;
  return _uiRot;                                    // between bands / upside down
}
function _applyUiRot(){
  const el=document.getElementById('gl-camera'); if(!el) return;
  el.classList.toggle('glc-cw',_uiRot===90);
  el.classList.toggle('glc-ccw',_uiRot===-90);
  _renderLive();
}
// Compass heading arrives in the DEVICE frame (direction of the device's top
// edge). Held sideways, the top edge points ±90° off the shot direction — the
// same correction Solocator applies. Only meaningful under the native lock.
function _viewHeading(){
  if(_heading==null) return null;
  const rot=_isNative()?_uiRot:0;
  return ((_heading-rot)%360+360)%360;
}

// ── Pinch-to-zoom (Tim 7/29) ──
// Two-finger pinch drives the plugin's native zoom (incl. 0.5× ultra-wide when
// the device has one). Range from getZoom(), capped at 10× — beyond that is
// digital mush. Native only; the web <video> has no zoom API worth faking.
let _pinch=null, _zoomRange=null, _zoomAt=0, _zoomLblT=null;
async function _zoomInit(){
  _zoomRange=null;
  if(!_isNative()) return;
  try{
    const z=await CameraPreview.getZoom();
    _zoomRange={min:z.min,max:Math.min(z.max,10),cur:z.current||1};
  }catch(e){ console.warn('camera zoom unavailable:',e&&e.message); }
}
function _touchDist(e){
  const a=e.touches[0], b=e.touches[1];
  return Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
}
function _zoomLabel(lvl){
  const el=document.getElementById('gl-camera'); if(!el) return;
  let z=document.getElementById('glc-zoom');
  if(!z){
    z=document.createElement('div'); z.id='glc-zoom';
    z.style.cssText='position:absolute;left:50%;transform:translateX(-50%);bottom:calc(118px + env(safe-area-inset-bottom));z-index:3;pointer-events:none;background:rgba(10,18,26,.72);border:1px solid rgba(255,255,255,.3);border-radius:14px;padding:4px 12px;font-family:var(--mono);font-size:13px;font-weight:700;color:#fff';
    el.appendChild(z);
  }
  z.textContent=(Math.round(lvl*10)/10)+'×';
  z.style.display='';
  clearTimeout(_zoomLblT); _zoomLblT=setTimeout(()=>{ z.style.display='none'; },900);
}
function _bindPinch(el){
  el.addEventListener('touchstart',e=>{
    if(e.touches.length===2&&_zoomRange){
      e.preventDefault();
      _pinch={d:_touchDist(e), base:_zoomRange.cur};
    }
  },{passive:false});
  el.addEventListener('touchmove',e=>{
    if(!_pinch||e.touches.length!==2||!_zoomRange) return;
    e.preventDefault();
    let lvl=_pinch.base*(_touchDist(e)/_pinch.d);
    lvl=Math.max(_zoomRange.min,Math.min(_zoomRange.max,lvl));
    _zoomRange.cur=lvl;
    _zoomLabel(lvl);
    const now=Date.now();
    if(now-_zoomAt>66){ _zoomAt=now; CameraPreview.setZoom({level:lvl,autoFocus:false}).catch(()=>{}); }
  },{passive:false});
  el.addEventListener('touchend',e=>{ if(e.touches.length<2) _pinch=null; });
  el.addEventListener('touchcancel',()=>{ _pinch=null; });
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
    try{ await _startPreview(); _zoomInit(); }
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
    // Physical hold first — beta/gamma flow even before the compass warms up.
    if(_isNative()){
      const rot=_calcUiRot(e.beta,e.gamma);
      if(rot!==_uiRot){ _uiRot=rot; _applyUiRot(); }
    }
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
    <div class="glc-uframe">
      <div class="glc-compass"><canvas id="glc-rose"></canvas></div>
      <div class="glc-edge">GROUND<span class="pipe">|</span><span class="log">LOG</span></div>
      <div class="glc-overlay">
        <div class="glc-line glc-cap"></div>
        <div class="glc-line glc-time"></div>
        <div class="glc-line glc-proj">${(cfg.projectName||'').replace(/</g,'&lt;')}</div>
      </div>
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
  _bindPinch(el);
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
    let blob=_b64ToBlob(b64,'image/jpeg');
    // The plugin captures with the PHYSICAL device orientation (accelerometer
    // ratio check in CameraController.getPhysicalOrientation) — a landscape
    // shot already comes back framed exactly as shot, even under our interface
    // lock. v3's blanket rotation was therefore a DOUBLE rotation (Tim: "it
    // worked originally" — correct). Safety net only: if the hold says
    // landscape but the image came back portrait-framed, the plugin hit its
    // accelerometer-data-missing fallback (interface orientation) — fix it.
    // createImageBitmap applies EXIF, so its dimensions are display truth.
    if(_isNative()&&(_uiRot===90||_uiRot===-90)){
      try{
        const bmp=await createImageBitmap(blob);
        if(bmp.height>bmp.width){
          const c=document.createElement('canvas');
          c.width=bmp.height; c.height=bmp.width;
          const cctx=c.getContext('2d');
          cctx.translate(c.width/2,c.height/2);
          cctx.rotate(_uiRot*Math.PI/180);
          cctx.drawImage(bmp,-bmp.width/2,-bmp.height/2);
          const rb=await new Promise(r=>c.toBlob(r,'image/jpeg',0.92));
          if(rb) blob=rb;
        }
        bmp.close();
      }catch(e){ console.warn('camera orientation check failed (storing as captured):',e); }
    }
    const last=_last();
    const meta={
      lat:_coords?_coords.latitude:null,
      lng:_coords?_coords.longitude:null,
      accuracy:_coords&&_coords.accuracy!=null?_coords.accuracy:null,
      altitude:_coords&&_coords.altitude!=null?_coords.altitude:null,   // meters MSL
      heading:_viewHeading(),          // shot direction, ±90-corrected for the hold
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
