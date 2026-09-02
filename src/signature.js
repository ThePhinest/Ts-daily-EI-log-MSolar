// ═══════════════════════════════════════════
// DRAWN SIGNATURE — shared user-level capture (extracted from swppp.js 8/31)
// ═══════════════════════════════════════════
//
// One signature per user, drawn once, stamped onto every rendered report
// (QI cert, daily-report cert, reviewer countersign — §C sign-off build).
// Storage is IDENTICAL to the original swppp.js implementation so existing
// saved signatures keep working: IDB key 'sw_sig' + Firestore
// users/{uid}/settings/signature, shape { b64:<dataURL png>, w:460, h:150 }.
// swppp.js delegates here; new callers use these directly.

var _glSig = undefined;   // undefined = not loaded; null = none saved; {b64,w,h}

async function glSigLoad(){
  if(_glSig !== undefined) return _glSig;
  try{ _glSig = (await idbGet('sw_sig')) || null; }catch(e){ _glSig = null; }
  if(!_glSig && typeof db !== 'undefined' && db && _fbReady){
    try{
      const d = await _udb().collection('settings').doc('signature').get();
      if(d.exists){ _glSig = d.data(); idbSet('sw_sig', _glSig); }
    }catch(e){}
  }
  return _glSig;
}

// Draw/replace modal. onSaved(sig) fires after a successful save — callers
// refresh their own UI (and the review flow chains straight into signing).
function glSigDraw(onSaved){
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.zIndex='9800';   // 9/1: above the submission detail sheet (9050) — the pad opened BEHIND it on first Approve & Sign
  ov.innerHTML=`<div class="modal-box" style="max-width:500px">
    <h3 style="margin:0 0 4px">Draw your signature</h3>
    <p style="font-size:11px;color:var(--muted);margin:0 0 10px">Saved once to your account and stamped on every report you sign. Finger or stylus.</p>
    <canvas id="gl-sig-canvas" width="460" height="150" style="width:100%;touch-action:none;background:#fff;border-radius:8px;border:1px solid var(--s1);display:block"></canvas>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn btn-outline" id="gl-sig-clear">Clear</button>
      <button class="btn" id="gl-sig-save">Save signature</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const cv=ov.querySelector('#gl-sig-canvas');
  const ctx=cv.getContext('2d');
  ctx.lineWidth=2.6; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#101060';
  let drawing=false, drew=false;
  const pos=(ev)=>{ const r=cv.getBoundingClientRect(); return {x:(ev.clientX-r.left)*(cv.width/r.width), y:(ev.clientY-r.top)*(cv.height/r.height)}; };
  cv.addEventListener('pointerdown',ev=>{ ev.preventDefault(); drawing=true; drew=true; const p=pos(ev); ctx.beginPath(); ctx.moveTo(p.x,p.y); try{cv.setPointerCapture(ev.pointerId);}catch(e){} });
  cv.addEventListener('pointermove',ev=>{ if(!drawing) return; ev.preventDefault(); const p=pos(ev); ctx.lineTo(p.x,p.y); ctx.stroke(); });
  cv.addEventListener('pointerup',()=>{ drawing=false; });
  cv.addEventListener('pointercancel',()=>{ drawing=false; });
  ov.querySelector('#gl-sig-clear').onclick=()=>{ ctx.clearRect(0,0,cv.width,cv.height); drew=false; };
  ov.querySelector('#gl-sig-save').onclick=async()=>{
    if(!drew){ ov.remove(); return; }
    _glSig={ b64: cv.toDataURL('image/png'), w:460, h:150 };
    idbSet('sw_sig', _glSig);
    try{ if(typeof db !== 'undefined' && db && _fbReady) await _udb().collection('settings').doc('signature').set(_glSig); }catch(e){ console.warn('signature cloud save failed (kept locally):', e.message); }
    ov.remove();
    if(typeof onSaved==='function') onSaved(_glSig);
  };
}

function glSigB64ToBuf(b64){
  const raw = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(raw); const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return arr.buffer;
}

window.glSigLoad = glSigLoad;
window.glSigDraw = glSigDraw;
window.glSigB64ToBuf = glSigB64ToBuf;
