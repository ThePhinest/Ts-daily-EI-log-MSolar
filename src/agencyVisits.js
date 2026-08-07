// ═══════════════════════════════════════════
// AGENCY VISITS — first-class visit records (#54)
// ═══════════════════════════════════════════
//
// Tim's inversion (8/7): the visit RECORD is the source of truth — created on
// the day an agency (DPS/DEC/ORES…) walks the site, holding the full notes,
// inspector, follow-ups, and curated photos. The daily log's Agency Inspection
// field gets a ⟲ button that writes a one-line summary FROM the record
// (deterministic, no AI). Exports: per-visit PDF (record photos included) and
// the running Visit Log PDF (all visits, notes-only lean file for forwarding).
//
// Legacy history: past daily logs whose Agency Inspection field has text show
// up in every list/export as read-only "logged visits" (merged under real
// records, real record wins its date) — the running log is complete from day 1.
//
// Storage: per-record docs under the user tree (users/{uid}/agencyVisits/{id},
// projectId-stamped — the dailyLogs/docs shape) + a per-project IDB array for
// instant offline paint. Soft delete (deletedAt), never destroyed.

const _AV_AGENCIES = ['NYSDPS', 'NYSDEC', 'ORES', 'EPA', 'USACE', 'Other'];

let _avVisits = {};   // pid -> records array (live + deleted)
let _avLoaded = {};   // pid -> cloud load completed

function _avPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _avKey(pid){ return 'gl_agency_visits::'+pid; }
function _avUid(){ return window._currentUser ? _currentUser.uid : null; }
function _avReady(){ return typeof db!=='undefined' && db && window._fbReady && window._currentUser && typeof _udb==='function'; }
function _avEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _avGenId(){ return 'av_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

function _avLoadLocal(pid){
  try{ const raw=window.idbGet && window.idbGet(_avKey(pid)); return raw?(JSON.parse(raw)||[]):[]; }catch{ return []; }
}
function _avSaveLocal(pid){
  try{ if(window.idbSet) window.idbSet(_avKey(pid), JSON.stringify(_avVisits[pid]||[])); }catch{}
}

async function avLoad(pid){
  pid = pid || _avPid();
  if(!_avVisits[pid]) _avVisits[pid] = _avLoadLocal(pid);
  if(_avLoaded[pid] || !_avReady()) return;
  try{
    const snap = await _udb().collection('agencyVisits').where('projectId','==',pid).get();
    const cloud = snap.docs.map(d=>d.data());
    // Merge newest-wins by updatedAt so an offline edit on this device survives.
    const byId = {};
    (_avVisits[pid]||[]).forEach(r=>{ byId[r.id]=r; });
    cloud.forEach(r=>{ const l=byId[r.id]; if(!l || (r.updatedAt||0)>=(l.updatedAt||0)) byId[r.id]=r; });
    _avVisits[pid] = Object.values(byId);
    _avSaveLocal(pid);
    _avLoaded[pid] = true;
    // Repaint whichever surfaces are open — the loaded flag stops recursion.
    avRenderReportsSec(); avRenderComplianceCard();
  }catch(e){ console.warn('agencyVisits load:', e && e.message); }
}

// Live records, newest first.
function avAll(pid){
  pid = pid || _avPid();
  if(!_avVisits[pid]) _avVisits[pid] = _avLoadLocal(pid);
  return (_avVisits[pid]||[]).filter(r=>!r.deletedAt)
    .slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
}
function avGet(id, pid){ return ((_avVisits[pid||_avPid()])||[]).find(r=>r.id===id)||null; }

// Legacy "logged visits" — past daily logs with Agency Inspection text and no
// real record on that date. Read-only history rows.
function _avLegacy(pid){
  pid = pid || _avPid();
  const have = new Set(avAll(pid).map(r=>r.date));
  const out = [];
  try{
    const all = (typeof dlGetAll==='function') ? dlGetAll() : {};
    Object.keys(all).forEach(date=>{
      const r = all[date];
      if(r && (r.projectId||pid)===pid && !have.has(date)){
        const txt = ((r.fields||{}).agencyInsp||'').trim();
        if(txt) out.push({ legacy:true, id:'legacy_'+date, date, agency:'', inspector:'',
                           notes:txt, followUps:'', photoIds:[], preparedBy:(r.fields||{}).preparedBy||'' });
      }
    });
  }catch(e){}
  return out.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
}
// Records + legacy, newest first (what lists and the full log export show).
function avAllWithLegacy(pid){
  return [...avAll(pid), ..._avLegacy(pid)]
    .sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
}

function _avPersist(rec){
  const pid = rec.projectId;
  if(!_avVisits[pid]) _avVisits[pid] = _avLoadLocal(pid);
  const idx = _avVisits[pid].findIndex(r=>r.id===rec.id);
  if(idx>=0) _avVisits[pid][idx]=rec; else _avVisits[pid].push(rec);
  _avSaveLocal(pid);
  if(_avReady()){
    try{ _udb().collection('agencyVisits').doc(rec.id).set(rec).catch(e=>console.warn('agencyVisit save:', e.message)); }catch(e){}
  }
}

// ── Weather line for a visit date (from the archived daily log — site
// conditions the inspector saw; records don't duplicate weather data). ──
function _avWeatherLine(date){
  try{
    const r = (typeof dlGet==='function') ? dlGet(date) : null;
    const f = (r&&r.fields)||{};
    const parts=[];
    if(f.tempAM||f.tempPM) parts.push([f.tempAM,f.tempPM].filter(Boolean).join('–')+'°F');
    if(f.precip) parts.push(f.precip);
    if(f.wind) parts.push('wind '+f.wind);
    if(f.soilCond) parts.push(f.soilCond);
    return parts.join(' · ');
  }catch(e){ return ''; }
}

// ═══ Form modal (new / edit) ═══
function avShowForm(id){
  const pid = _avPid();
  const existing = id ? avGet(id,pid) : null;
  const today = new Date().toLocaleDateString('en-CA');
  const v = existing || { id:_avGenId(), projectId:pid, date:today, agency:'NYSDPS', agencyOther:'',
    inspector:'', notes:'', followUps:'', photoIds:[], createdAt:Date.now(), ownerUid:_avUid() };
  const sel = new Set(v.photoIds||[]);
  const ov = document.createElement('div');
  ov.className='modal-overlay'; ov.id='av-form-ov'; ov.style.cssText='z-index:5000;align-items:flex-end;padding:0';
  const agencyOpts = _AV_AGENCIES.map(a=>`<option value="${a}"${(v.agency===a||(a==='Other'&&v.agency&&!_AV_AGENCIES.includes(v.agency)))?' selected':''}>${a}</option>`).join('');
  ov.innerHTML=`
    <div style="width:100%;max-height:calc(100dvh - var(--app-bar-h,58px) - 8px);background:var(--bg);border-top:1px solid var(--border);border-radius:16px 16px 0 0;display:flex;flex-direction:column;overflow:hidden;padding-bottom:env(safe-area-inset-bottom)">
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--border);flex-shrink:0">
        <span style="font-family:var(--cond);font-weight:700;font-size:15px;letter-spacing:.06em;text-transform:uppercase;flex:1">🏛 ${existing?'Edit':'New'} Agency Visit</span>
        <button id="av-f-close" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;width:36px;height:36px">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:12px 16px">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <div style="flex:1"><label style="font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:3px">DATE</label>
            <input type="date" id="av-f-date" value="${_avEsc(v.date)}" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:16px;padding:8px;min-height:40px"></div>
          <div style="flex:1"><label style="font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:3px">AGENCY</label>
            <select id="av-f-agency" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:16px;padding:8px;min-height:40px">${agencyOpts}</select></div>
        </div>
        <div id="av-f-agother-wrap" style="display:${(_AV_AGENCIES.includes(v.agency)&&v.agency!=='Other')?'none':'block'};margin-bottom:10px">
          <input type="text" id="av-f-agother" value="${_avEsc(_AV_AGENCIES.includes(v.agency)?(v.agencyOther||''):v.agency)}" placeholder="Agency name" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:16px;padding:8px">
        </div>
        <label style="font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:3px">INSPECTOR(S)</label>
        <input type="text" id="av-f-insp" value="${_avEsc(v.inspector)}" placeholder="e.g. Chris Walker" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:16px;padding:8px;margin-bottom:10px">
        <label style="font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:3px">VISIT NOTES</label>
        <textarea id="av-f-notes" rows="6" placeholder="Everything from the visit — what was walked, what was said, observations, concerns…" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:16px;padding:8px;margin-bottom:10px;resize:vertical">${_avEsc(v.notes)}</textarea>
        <label style="font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:3px">FOLLOW-UP ITEMS</label>
        <textarea id="av-f-fu" rows="3" placeholder="What the inspector asked for / action items (optional)" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:16px;padding:8px;margin-bottom:10px;resize:vertical">${_avEsc(v.followUps)}</textarea>
        <label style="font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:5px">PHOTOS FROM <span id="av-f-photodate">${_avEsc(v.date)}</span> — tap to include in the visit report</label>
        <div id="av-f-photos" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>
      </div>
      <div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border);flex-shrink:0">
        <button id="av-f-save" class="btn btn-amber" style="flex:1;min-height:44px">💾 Save visit</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const renderPhotos=()=>{
    const date=document.getElementById('av-f-date').value;
    document.getElementById('av-f-photodate').textContent=date;
    const box=document.getElementById('av-f-photos');
    const dayPhotos=(window._phPhotos||[]).filter(p=>p.date===date&&p.thumb);
    box.innerHTML = dayPhotos.length
      ? dayPhotos.map(p=>`<div data-pid="${p.id}" style="width:64px;height:64px;border-radius:6px;overflow:hidden;border:2px solid ${sel.has(p.id)?'var(--amber)':'var(--border)'};opacity:${sel.has(p.id)?'1':'.55'};cursor:pointer;position:relative">
          <img src="${p.thumb}" style="width:100%;height:100%;object-fit:cover">
          ${sel.has(p.id)?'<span style="position:absolute;top:1px;right:3px;font-size:11px">✓</span>':''}
        </div>`).join('')
      : '<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">No photos on this date yet.</span>';
    box.querySelectorAll('[data-pid]').forEach(el=>{
      el.onclick=()=>{ const id=el.dataset.pid; if(sel.has(id)) sel.delete(id); else sel.add(id); renderPhotos(); };
    });
  };
  renderPhotos();
  document.getElementById('av-f-date').onchange=renderPhotos;
  document.getElementById('av-f-agency').onchange=function(){
    document.getElementById('av-f-agother-wrap').style.display=this.value==='Other'?'block':'none';
  };
  document.getElementById('av-f-close').onclick=()=>ov.remove();
  document.getElementById('av-f-save').onclick=()=>{
    const agSel=document.getElementById('av-f-agency').value;
    const rec=Object.assign({},v,{
      date:document.getElementById('av-f-date').value||today,
      agency:agSel==='Other'?(document.getElementById('av-f-agother').value.trim()||'Other'):agSel,
      inspector:document.getElementById('av-f-insp').value.trim(),
      notes:document.getElementById('av-f-notes').value.trim(),
      followUps:document.getElementById('av-f-fu').value.trim(),
      photoIds:[...sel],
      updatedAt:Date.now(), deletedAt:null
    });
    _avPersist(rec);
    if(window.glHaptic&&window.glHaptic.success) window.glHaptic.success();
    ov.remove();
    avRenderReportsSec(); avRenderComplianceCard();
    if(typeof showCloudBanner==='function') showCloudBanner('🏛 Agency visit saved.');
  };
}

function avDelete(id){
  const rec=avGet(id); if(!rec) return;
  if(rec.ownerUid && _avUid() && rec.ownerUid!==_avUid()) return;
  if(!confirm('Delete the '+(rec.date||'')+' agency visit record? (Recoverable by support — nothing is destroyed.)')) return;
  rec.deletedAt=Date.now(); rec.updatedAt=Date.now();
  _avPersist(rec);
  avRenderReportsSec(); avRenderComplianceCard();
}

// ═══ Read-only detail (compliance list tap) ═══
function avShowDetail(id){
  const pid=_avPid();
  const v = avGet(id,pid) || _avLegacy(pid).find(r=>r.id===id);
  if(!v) return;
  const wx=_avWeatherLine(v.date);
  const ov=document.createElement('div');
  ov.className='modal-overlay'; ov.style.cssText='z-index:5000';
  ov.innerHTML=`<div class="modal-box" style="max-width:420px;width:92%;max-height:80dvh;overflow-y:auto">
    <div class="modal-title" style="margin-bottom:2px">🏛 ${_avEsc(v.agency||'Agency visit')}${v.inspector?' — '+_avEsc(v.inspector):''}</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px">${_avEsc(v.date)}${wx?' · '+_avEsc(wx):''}${v.legacy?' · <i>from daily log</i>':''}</div>
    <div style="font-size:13px;line-height:1.55;white-space:pre-wrap;margin-bottom:${v.followUps?'10px':'14px'}">${_avEsc(v.notes)}</div>
    ${v.followUps?`<div style="font-family:var(--mono);font-size:10px;color:var(--amber);margin-bottom:3px">FOLLOW-UP ITEMS</div>
    <div style="font-size:13px;line-height:1.55;white-space:pre-wrap;margin-bottom:14px">${_avEsc(v.followUps)}</div>`:''}
    <div style="display:flex;gap:8px">
      ${v.legacy?'':`<button class="btn btn-outline" style="flex:1" onclick="this.closest('.modal-overlay').remove();avShowForm('${v.id}')">✏️ Edit</button>`}
      <button class="btn btn-amber" style="flex:1" onclick="this.closest('.modal-overlay').remove()">Close</button>
    </div>
  </div>`;
  ov.addEventListener('click',e=>{ if(e.target===ov) ov.remove(); });
  document.body.appendChild(ov);
}

// ═══ Compliance page card — the simple glanceable record ═══
function avRenderComplianceCard(){
  const host=document.getElementById('cl-agency-card');
  if(!host) return;
  const pid=_avPid();
  avLoad(pid);
  const all=avAllWithLegacy(pid);
  if(!all.length){ host.style.display='none'; return; }
  host.style.display='';
  const rows=all.slice(0,5).map(v=>`
    <div onclick="avShowDetail('${v.id}')" style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid var(--border);cursor:pointer">
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted);flex-shrink:0">${_avEsc(v.date)}</span>
      <span style="font-family:var(--mono);font-size:12px;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_avEsc(v.agency||'Agency')}${v.inspector?' — '+_avEsc(v.inspector):''}${v.legacy?' <span style="font-size:9px;color:var(--muted)">(log)</span>':''}</span>
      ${v.followUps?'<span title="Has follow-up items" style="font-size:11px;flex-shrink:0">📌</span>':''}
    </div>`).join('');
  const collapsed=(typeof window._clCardCollapsed==='function')&&window._clCardCollapsed('agency');
  host.innerHTML=`<div class="card${collapsed?' collapsed':''}">
    <div class="card-head" onclick="clToggleCard('agency')">
      <span class="card-num">🏛</span>
      <span class="card-title">Agency Visits</span>
      <span class="head-fade"></span>
      <span class="card-badge">${all.length}</span>
      <span class="card-chevron">▾</span>
    </div>
    <div class="card-body" style="padding-top:4px">${rows}
      <div onclick="showPage('reports')" style="font-family:var(--mono);font-size:10px;color:var(--amber);padding:9px 6px 2px;cursor:pointer">Manage &amp; export on the Reports page ›${all.length>5?` (+ ${all.length-5} more)`:''}</div>
    </div>
  </div>`;
}

// ═══ Reports page section — record management + report generation ═══
function avRenderReportsSec(){
  const host=document.getElementById('av-reports-sec');
  if(!host) return;
  const pid=_avPid();
  avLoad(pid);
  const all=avAllWithLegacy(pid);
  const rows=all.map(v=>`
    <div class="sw-list-row">
      <div class="sw-list-main" onclick="avShowDetail('${v.id}')">
        <span class="sw-list-date">${_avEsc(v.date)}</span>
        <span class="sw-list-type">${_avEsc(v.agency||'Agency')}${v.inspector?' — '+_avEsc(v.inspector):''}${v.legacy?' (log)':''}</span>
        ${v.followUps?'<span title="Follow-up items">📌</span>':''}
      </div>
      ${v.legacy?'':`<button class="sw-list-btn" title="Edit" onclick="avShowForm('${v.id}')">✏️</button>`}
      <button class="sw-list-btn" title="Export visit PDF" onclick="avExportPdf('${v.id}')">${window.glPdfIcon?window.glPdfIcon(12):'PDF'}</button>
      ${v.legacy?'':`<button class="sw-list-btn" title="Delete" onclick="avDelete('${v.id}')">🗑</button>`}
    </div>`).join('');
  const head=(typeof window._swSecHead==='function')
    ? window._swSecHead('av','Agency Visits','Document each agency walk — export one visit or the full log to forward to the contractor','<button class="btn" onclick="avShowForm()">＋ New Visit</button>')
    : `<div class="sw-sec-label sw-sec-next">Agency Visits<span class="sw-sec-line"></span><button class="btn" onclick="avShowForm()">＋ New Visit</button></div>
       <div class="sw-sec-sub">Document each agency walk — export one visit or the full log to forward to the contractor</div>`;
  const avCollapsed=(typeof window.swSecCollapsed==='function')&&window.swSecCollapsed('av');
  host.innerHTML=`
    ${head}
    <div id="sw-sec-body-av" style="display:${avCollapsed?'none':''}">
      ${rows || '<p style="color:var(--muted);font-size:12px;padding:10px 2px">No agency visits recorded yet — add one when an inspector walks the site.</p>'}
      ${all.length?`<div style="margin-top:10px;text-align:right"><button class="btn btn-outline" onclick="avExportPdf()">⬇ Full Visit Log (PDF)</button></div>`:''}
    </div>`;
}

// ═══ PDF export — one visit (photos included) or the full log (notes-only) ═══
async function avExportPdf(id){
  const pid=_avPid();
  const single = id ? (avGet(id,pid) || _avLegacy(pid).find(r=>r.id===id)) : null;
  const visits = single ? [single] : avAllWithLegacy(pid);
  if(!visits.length) return;
  const btns=document.querySelectorAll(id?`[onclick="avExportPdf('${id}')"]`:'[onclick="avExportPdf()"]');
  btns.forEach(b=>{ b.dataset.oldTxt=b.innerHTML; b.textContent='…'; b.disabled=true; });
  try{
    const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
    const payload=visits.map(v=>({
      date:v.date, agency:v.agency, inspector:v.inspector, notes:v.notes,
      followUps:v.followUps, legacy:!!v.legacy,
      preparedBy:v.preparedBy||cfg.preparedBy||'',
      weatherLine:_avWeatherLine(v.date),
      photoIds:single?(v.photoIds||[]):[]      // full log stays lean — no photos
    }));
    const {avBuildPdf}=await import('./swpppPdf.js');
    const blob=await avBuildPdf(payload,{projectName:cfg.projectName||'Project',preparedBy:cfg.preparedBy||''},{single:!!single});
    const slug=(cfg.projectName||'Project').replace(/[^\w]+/g,'_');
    const t=single?single.date:new Date().toLocaleDateString('en-CA');
    const [y,m,d]=String(t).split('-');
    const fname=single
      ? `${slug}-Agency_Visit_Report_${parseInt(m)}-${parseInt(d)}-${String(y).slice(2)}.pdf`
      : `${slug}-Agency_Visit_Log_${parseInt(m)}-${parseInt(d)}-${String(y).slice(2)}.pdf`;
    const {saveFileNative}=await import('./saveFile.js');
    await saveFileNative(blob,fname,'application/pdf');
  }catch(e){ console.error('agency visit export failed:',e); alert('Export failed: '+e.message); }
  finally{ btns.forEach(b=>{ b.innerHTML=b.dataset.oldTxt||'⬇'; b.disabled=false; }); }
}

// ═══ Daily log ⟲ — summarize the visit record into the Agency Inspection field ═══
// Deterministic (no AI call): the log carries the one-liner, the record carries
// the detail. Button is injected next to the field at boot.
function avSummarizeIntoLog(){
  const field=document.getElementById('agencyInsp');
  if(!field) return;
  const date=(document.getElementById('reportDate')?.value)||new Date().toLocaleDateString('en-CA');
  const rec=avAll().find(r=>r.date===date);
  if(!rec){
    if(typeof showCloudBanner==='function') showCloudBanner('🏛 No agency visit record for '+date+' — add one on the Reports page.');
    return;
  }
  const line=`${rec.agency||'Agency'}${rec.inspector?` (${rec.inspector})`:''} on site — see Agency Visit Report ${rec.date} for full notes.${rec.followUps?' Follow-up items noted.':''}`;
  if(field.value.trim() && field.value.trim()!==line && !confirm('Replace the current Agency Inspection text with the visit-report summary?')) return;
  field.value=line;
  field.dispatchEvent(new Event('input',{bubbles:true}));   // autosave path
  if(typeof showCloudBanner==='function') showCloudBanner('⟲ Summary written from the visit record.');
}
function _avInjectLogButton(){
  const field=document.getElementById('agencyInsp');
  if(!field || document.getElementById('av-log-btn')) return;
  const btn=document.createElement('button');
  btn.id='av-log-btn'; btn.type='button';
  btn.textContent='⟲ From visit report';
  btn.title='Fill this field with a summary line from today\'s Agency Visit record';
  btn.style.cssText='background:none;border:1px solid var(--border);border-radius:6px;color:var(--amber);font-family:var(--mono);font-size:10px;padding:4px 10px;cursor:pointer;margin:4px 0 2px;display:block';
  btn.onclick=avSummarizeIntoLog;
  field.parentNode.insertBefore(btn, field.nextSibling);
}
document.addEventListener('DOMContentLoaded',()=>{ setTimeout(_avInjectLogButton,0); });

// ── window exports (cross-module + inline handlers) ──
window.avLoad=avLoad;
window.avShowForm=avShowForm;
window.avShowDetail=avShowDetail;
window.avDelete=avDelete;
window.avExportPdf=avExportPdf;
window.avRenderComplianceCard=avRenderComplianceCard;
window.avRenderReportsSec=avRenderReportsSec;
window.avSummarizeIntoLog=avSummarizeIntoLog;
