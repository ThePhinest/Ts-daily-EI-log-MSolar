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
let _orientBound=null, _visBound=null;

function _pid(){ return (typeof window._activeProjectId==='function')?window._activeProjectId():'default'; }
function _cfg(){ try{ return JSON.parse(localStorage.getItem('msf_projectconfig')||'{}'); }catch{ return {}; } }
function _lastKey(){ return 'gl_cam_last::'+_pid(); }
function _last(){ try{ return JSON.parse(localStorage.getItem(_lastKey())||'{}')||{}; }catch{ return {}; } }
function _saveLast(v){ try{ localStorage.setItem(_lastKey(),JSON.stringify(v)); }catch{} }
function _tagsKey(){ return 'gl_cam_tags::'+_pid(); }

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
  {key:'gps',     label:'GPS coordinates + compass bearing'},
  {key:'time',    label:'Date / time'},
  {key:'project', label:'Project + prepared-by line'},
  {key:'caption', label:'Caption + location label'},
  {key:'tags',    label:'Tag badges (🌊 🌱 🚩)'},
];
export function camStampDefaults(){
  const base={gps:true,time:true,project:true,caption:true,tags:true};
  try{ return Object.assign(base,JSON.parse(localStorage.getItem(STAMP_KEY)||'{}')); }catch{ return base; }
}
export function camStampSetDefaults(t){ try{ localStorage.setItem(STAMP_KEY,JSON.stringify(t)); }catch{} }
window.camStampDefaults=camStampDefaults;

// ── Stamp renderer — the second layer of the two-layer model ──
// Composites the branded overlay from a photo's METADATA RECORD onto its clean
// original at share/export time (photos.js lazy-imports this). Layout = the
// agreed Timemark-inspired block: wordmark, gold-bar time/date line, project
// line, coords line, caption line bottom-left; compass + tag badges bottom-right.
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
  // Bottom-left block, drawn bottom-up: caption → coords → project → time → wordmark.
  const lines=[];
  if(t.caption){
    const bits=[p.locLabel,p.caption].filter(Boolean).join(' · ');
    if(bits) lines.push({txt:bits,font:`${S}px Arial`});
  }
  if(t.gps&&p.lat!=null&&p.lng!=null){
    const acc=p.gpsAcc!=null?` ±${Math.round(p.gpsAcc*3.28084)}ft`:'';
    lines.push({txt:`${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}${acc}`,font:`${S}px Arial`});
  }
  if(t.project){
    const who=[cfg.preparedBy,cfg.projectName].filter(Boolean).join(' · ');
    if(who) lines.push({txt:who,font:`${S}px Arial`});
  }
  if(t.time){
    const d=new Date(p.takenAt||p.uploadedAt||Date.now());
    lines.push({txt:_fmtClock(d),font:`bold ${Math.round(S*1.12)}px Arial`,bar:true});
  }
  lines.push({wordmark:true});
  let y=H-pad;
  for(const ln of lines){
    if(ln.wordmark){
      const fs=S;
      ctx.font=`bold ${fs}px Arial`;
      let x=pad;
      ctx.fillStyle='#ffffff'; ctx.fillText('GROUND',x,y); x+=ctx.measureText('GROUND').width+Math.round(fs*0.18);
      ctx.fillStyle='#C9A84C'; ctx.fillText('|',x,y); x+=ctx.measureText('|').width+Math.round(fs*0.18);
      ctx.fillStyle='#38b6c4'; ctx.fillText('LOG',x,y);
      y-=lh;
      continue;
    }
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
  // Bottom-right: compass bearing + tag badges (the #27 layout call).
  ctx.textAlign='right';
  const rx=W-pad;
  let ry=H-pad;
  if(t.gps&&p.direction!=null){
    const dirs=['N','NE','E','SE','S','SW','W','NW'];
    const card=dirs[Math.round(p.direction/45)%8];
    ctx.font=`bold ${S}px Arial`; ctx.fillStyle='#ffffff';
    ctx.fillText(`${card} ${Math.round(p.direction)}°`,rx,ry); ry-=Math.round(lh*1.1);
    ctx.font=`${Math.round(S*1.5)}px Arial`;
    ctx.fillText('◐',rx,ry); ry-=Math.round(lh*1.25);
  }
  if(t.tags){
    const em=[p.swppp?'🌊':null,p.seedTag?'🌱':null,p.repairTag?'🚩':null].filter(Boolean).join(' ');
    if(em){ ctx.font=`${Math.round(S*1.3)}px Arial`; ctx.fillText(em,rx,ry); }
  }
  ctx.textAlign='left';
  return await new Promise(res=>c.toBlob(res,'image/jpeg',0.92));
}
window.camStampBlob=camStampBlob;

function _fmtClock(d){
  const t=d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  const dt=d.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'});
  return `${t} │ ${dt}`;
}
function _fmtCoords(){
  if(!_coords) return 'GPS: acquiring…';
  const acc=_coords.accuracy!=null?` ±${Math.round(_coords.accuracy*3.28084)}ft`:'';
  return `${_coords.latitude.toFixed(5)}, ${_coords.longitude.toFixed(5)}${acc}`;
}
function _headingLabel(){
  if(_heading==null) return {dial:'◐', txt:'—'};
  const dirs=['N','NE','E','SE','S','SW','W','NW'];
  const d=dirs[Math.round(_heading/45)%8];
  return {dial:'◐', txt:`${d} ${Math.round(_heading)}°`};
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
  _renderOverlay();
  _clockTimer=setInterval(_renderOverlay,30000);
}
window.camOpen=camOpen;

export async function camClose(){
  if(!_open&&!document.getElementById('gl-camera')){ return; }
  _open=false; _suspended=false;
  clearInterval(_clockTimer); _clockTimer=null;
  clearTimeout(_stripTimer); _stripTimer=null;
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
    disableExifHeaderStripping:false,
  });
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
    <div class="glc-compass"><span class="dial">◐</span><span class="glc-hdg">—</span></div>
    <div class="glc-overlay">
      <div class="glc-brand">GROUND<span class="pipe">|</span><span class="log">LOG</span></div>
      <div class="glc-line glc-time"></div>
      <div class="glc-line glc-proj">${(cfg.projectName||'').replace(/</g,'&lt;')}</div>
      <div class="glc-line glc-coords"></div>
      <div class="glc-line glc-cap"></div>
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
  el.querySelector('.glc-coords').style.display=t.gps?'':'none';
  el.querySelector('.glc-cap').style.display=t.caption?'':'none';
  el.querySelector('.glc-compass').style.display=t.gps?'':'none';
  el.querySelector('.glc-time').textContent=_fmtClock(new Date());
  _renderLive();
}
function _renderLive(){
  const el=document.getElementById('gl-camera'); if(!el) return;
  el.querySelector('.glc-coords').textContent=_fmtCoords();
  const h=_headingLabel();
  el.querySelector('.glc-hdg').textContent=h.txt;
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
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
        ${STAMP_ELEMENTS.map(e=>`
          <button class="glc-st-row" data-k="${e.key}" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid ${t[e.key]?'var(--amber)':'var(--border)'};background:var(--s1);color:var(--text);font-family:var(--mono);font-size:12px">
            <span style="color:${t[e.key]?'var(--amber)':'var(--muted)'}">${t[e.key]?'☑':'☐'}</span>${e.label}
          </button>`).join('')}
      </div>
      <div class="modal-btns"><button class="modal-cancel" id="glc-st-done">Done</button></div>
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
  ov.querySelector('#glc-st-done').onclick=()=>ov.remove();
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
