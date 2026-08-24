// ── Boot timeline (8/24, delta #54/#55 — "10 s to open", "1,600 photos") ──
// Measure before optimizing. This module is the FIRST import in main.js, so
// its clock starts at the first executed module statement; app code drops
// named marks via window.glBootMark(name, extra) at each boot milestone
// (Firebase init → auth → IDB hydrate → session doc → _fbReady → photos local /
// cloud → tracker → timesheet → calendar → compliance). Alongside the marks:
//   • navigation + main-chunk resource timings (transfer KB, download ms)
//   • first user interaction (pointer / key) — the "usable" moment
//   • main-thread stalls: rAF gaps > 200 ms during the first 25 s (the black
//     unpainted scroll region in Tim's 8/22 screenshot is this)
// At 25 s (or when the page hides first) the run is written to
// localStorage.gl_boot_log — a ring of the last 6 boots (a few KB, Tier-2
// pref-sized). Account Settings → Diagnostics renders it; glBootReport() in
// the console prints it. Nothing here touches the network or Firestore.

const _marks=[];
const _t=()=>Math.round(performance.now());
let _finalized=false, _stalls=0, _worst=0, _firstTouch=null;

function glBootMark(name, extra){
  if(_finalized) return;
  const m=Object.assign({n:name,t:_t()},extra||{});
  _marks.push(m);
  return m;
}
window.glBootMark=glBootMark;
glBootMark('module');

document.addEventListener('DOMContentLoaded',()=>glBootMark('dcl'));
window.addEventListener('load',()=>glBootMark('load'));

// First interaction = the moment the user could actually do something.
const _ix=(e)=>{
  if(_firstTouch!=null) return;
  _firstTouch=_t();
  glBootMark('first-touch',{on:(e.target&&e.target.id)||(e.target&&e.target.tagName)||''});
};
['pointerdown','touchstart','keydown'].forEach(ev=>window.addEventListener(ev,_ix,{capture:true,passive:true}));

// Main-thread stall detector (rAF gap). Hidden tabs pause rAF — those gaps
// are not stalls, so the clock resets on every visibility change.
let _last=performance.now();
const _END=performance.now()+25000;
document.addEventListener('visibilitychange',()=>{ _last=performance.now(); if(document.visibilityState==='hidden') _finalize('hidden'); });
(function tick(){
  const now=performance.now(), gap=now-_last; _last=now;
  if(gap>200&&document.visibilityState==='visible'){
    _stalls++; if(gap>_worst) _worst=Math.round(gap);
    if(!_finalized) _marks.push({n:'stall',t:Math.round(now),ms:Math.round(gap),pg:((document.querySelector('.page.active')||{}).id||'').replace('page-','')});
  }
  if(now<_END&&!_finalized) requestAnimationFrame(tick); else _finalize('timer');
})();
window.addEventListener('pagehide',()=>_finalize('pagehide'));

function _resources(){
  const out={};
  try{
    const nav=performance.getEntriesByType('navigation')[0];
    if(nav) out.nav={type:nav.type,respEnd:Math.round(nav.responseEnd),dcl:Math.round(nav.domContentLoadedEventEnd),load:Math.round(nav.loadEventEnd),kb:Math.round((nav.transferSize||0)/1024)};
    const js=performance.getEntriesByType('resource').filter(r=>/\/assets\/index-[^/]*\.js$/.test(r.name)).sort((a,b)=>(b.encodedBodySize||0)-(a.encodedBodySize||0))[0];
    if(js) out.mainJs={kb:Math.round((js.transferSize||js.encodedBodySize||0)/1024),rawKb:Math.round((js.decodedBodySize||0)/1024),ms:Math.round(js.duration),cache:!js.transferSize};
    const fs=performance.getEntriesByType('resource').filter(r=>/firestore\.googleapis\.com/.test(r.name));
    if(fs.length) out.firestore={reqs:fs.length,kb:Math.round(fs.reduce((a,r)=>a+(r.transferSize||0),0)/1024)};
  }catch{}
  return out;
}

function _finalize(why){
  if(_finalized) return;
  _finalized=true;
  const run={
    at:new Date().toISOString().slice(0,19),
    end:why, dur:_t(),
    native:!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform()),
    ua:(navigator.userAgent||'').replace(/Mozilla\/5\.0 \(/,'(').slice(0,80),
    firstTouch:_firstTouch, stalls:_stalls, worstStallMs:_worst,
    marks:_marks.filter(m=>m.n!=='stall'),
    stallMarks:_marks.filter(m=>m.n==='stall').slice(0,12),
    res:_resources(),
    photos:(window._phPhotos||[]).length||undefined,
  };
  try{
    if(performance.memory) run.memMb=Math.round(performance.memory.usedJSHeapSize/1048576);
    const ring=JSON.parse(localStorage.getItem('gl_boot_log')||'[]');
    ring.push(run); while(ring.length>6) ring.shift();
    localStorage.setItem('gl_boot_log',JSON.stringify(ring));
  }catch{}
  window._glBootRun=run;
}

// ── Read-out ──
function _fmtRun(r){
  if(!r) return '(no boot recorded yet)';
  const L=[];
  L.push(`${r.at} · ${r.native?'iOS app':'web'} · ${r.end} @ ${(r.dur/1000).toFixed(1)}s`);
  if(r.res&&r.res.mainJs) L.push(`main js: ${r.res.mainJs.kb} KB over wire (${r.res.mainJs.rawKb} KB raw) in ${r.res.mainJs.ms} ms${r.res.mainJs.cache?' · from cache':''}`);
  if(r.res&&r.res.nav) L.push(`html: ${r.res.nav.kb} KB · response ${r.res.nav.respEnd} ms · DCL ${r.res.nav.dcl} ms · load ${r.res.nav.load} ms`);
  if(r.res&&r.res.firestore) L.push(`firestore: ${r.res.firestore.reqs} requests · ${r.res.firestore.kb} KB`);
  L.push(`first touch: ${r.firstTouch!=null?(r.firstTouch/1000).toFixed(1)+'s':'none'} · stalls >200ms: ${r.stalls} (worst ${r.worstStallMs} ms)${r.photos?' · photos '+r.photos:''}${r.memMb?' · heap '+r.memMb+' MB':''}`);
  L.push('');
  (r.marks||[]).forEach(m=>{
    const extra=Object.keys(m).filter(k=>k!=='n'&&k!=='t').map(k=>`${k}=${m[k]}`).join(' ');
    L.push(`${String((m.t/1000).toFixed(2)).padStart(6)}s  ${m.n}${extra?'  '+extra:''}`);
  });
  if(r.stallMarks&&r.stallMarks.length) L.push('', 'stalls: '+r.stallMarks.map(s=>`${(s.t/1000).toFixed(1)}s/${s.ms}ms${s.pg?'@'+s.pg:''}`).join('  '));
  return L.join('\n');
}
function glBootReport(all){
  let ring=[]; try{ ring=JSON.parse(localStorage.getItem('gl_boot_log')||'[]'); }catch{}
  const runs=all?ring:ring.slice(-1);
  const txt=runs.map(_fmtRun).join('\n\n────────\n\n')||'(no boot recorded yet — reopen the app, wait 25 s)';
  try{ console.log(txt); }catch{}
  return txt;
}
window.glBootReport=glBootReport;

// Account Settings → Diagnostics card: last boot + camera log, copyable.
function glDiagRender(){
  const out=document.getElementById('gl-diag-out'); if(!out) return;
  let cam=[]; try{ cam=JSON.parse(localStorage.getItem('gl_cam_log')||'[]'); }catch{}
  let sw=[]; try{ sw=JSON.parse(localStorage.getItem('gl_sw_log')||'[]'); }catch{}
  const camTxt=cam.length?cam.slice(-12).map(c=>`${c.t}  ${c.ev}  ${Object.keys(c).filter(k=>k!=='t'&&k!=='ev').map(k=>k+'='+c[k]).join(' ')}`).join('\n'):'(none)';
  out.textContent=glBootReport(false)+'\n\n── camera log (last 12) ──\n'+camTxt+'\n\n── sw log entries: '+sw.length;
}
window.glDiagRender=glDiagRender;
window.glDiagCopy=async function(){
  let cam='[]', sw='[]', boot='[]';
  try{ cam=localStorage.getItem('gl_cam_log')||'[]'; sw=localStorage.getItem('gl_sw_log')||'[]'; boot=localStorage.getItem('gl_boot_log')||'[]'; }catch{}
  const txt=`GroundLog diagnostics ${new Date().toISOString().slice(0,19)}\n\n== boot (all) ==\n${glBootReport(true)}\n\n== gl_boot_log ==\n${boot}\n\n== gl_cam_log ==\n${cam}\n\n== gl_sw_log ==\n${sw}`;
  try{ await navigator.clipboard.writeText(txt); const b=document.getElementById('gl-diag-copy'); if(b){ b.textContent='✓ Copied'; setTimeout(()=>{ b.textContent='📋 Copy all'; },1800); } }
  catch{ try{ window.prompt('Copy diagnostics:', txt.slice(0,2000)); }catch{} }
};
