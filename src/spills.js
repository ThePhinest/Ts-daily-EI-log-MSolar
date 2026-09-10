// ═══════════════════════════════════════════
// SPILLS — first-class incident records (#29, 9/8)
// ═══════════════════════════════════════════
//
// Tim's ask (9/8, "high priority"): the spill report built into the app. Same
// record-first pattern as agencyVisits.js — the RECORD is the source of truth,
// created at the spill, holding everything the owner's Environmental Incident
// Report form asks for (6 sections, mirrored 1:1 in the PDF), plus the pieces a
// paper form never carries: the NY four-part reportability test, a timed
// notification log, GPS/map location, and the project's photos.
//
// Surfaces: 🛢 card on the Compliance page (between Agency Visits and the
// Compliance Log), a Reports-page section (records + PDF per record + running
// spill log), 🛢 pins on the map (maps.js, view-palette SPILLS Show/Hide), and a
// "Log as CMP" button that files the spill as a CMP-NN compliance entry so it
// rides the daily report + punchlist.
//
// Storage: per-record docs under the user tree (users/{uid}/spills/{id},
// projectId-stamped — the agencyVisits shape; rules cover users/{uid}/** ) +
// a per-project IDB array for instant offline paint. Soft delete (deletedAt).
// Offline-first by construction: the form works with no network; cloud writes
// are fire-and-forget behind the local save.
//
// 9/9 (Tim): PROJECT MIRROR with EXPLICIT PUBLISH — a record stays author-private
// until the author publishes it (button on the record, or the PDF export offers
// once); the published copy lives at projects/{pid}/spills/{id}; members load it
// with a get on project open (no listener) and hold it read-only. See "Project
// mirror" below.

let _spRecs = {};     // pid -> records (live + deleted)
let _spLoaded = {};   // pid -> cloud load completed
let _spDraft = null;  // form values parked while picking a location on the map
let _spFormId = null; // record id of the open form (camera auto-attach target)
let _spFormSel = null;// Set of photo ids selected in the open form
let _spNotifs = [];   // notification rows in the open form
let _spShared = {};   // pid -> other members' PUBLISHED records (project mirror; loaded with a get, no listener — Tim 9/9)

const _SP_ROLES = ['Environmental Monitor', 'Compliance Manager', 'EPC / Contractor', 'Owner', 'State spill hotline', 'Siting / utility agency', 'Other'];
const _SP_LBL = 'font-family:var(--mono);font-size:10px;color:var(--muted);display:block;margin-bottom:3px;letter-spacing:.04em;text-transform:uppercase';
const _SP_INP = 'width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:16px;padding:8px;min-height:40px;font-family:var(--body)';
const _SP_SEC = 'font-family:var(--cond);font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--amber);margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--border)';

function _spPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _spKey(pid){ return 'gl_spills::'+pid; }
function _spUid(){ return window._currentUser ? _currentUser.uid : null; }
function _spReady(){ return typeof db!=='undefined' && db && window._fbReady && window._currentUser && typeof _udb==='function'; }
function _spEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _spGenId(){ return 'sp_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function _spToday(){ return new Date().toLocaleDateString('en-CA'); }
function _spNow(){ const d=new Date(); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function _spPretty(d){ const p=String(d||'').split('-'); return p.length===3?`${parseInt(p[1])}/${parseInt(p[2])}/${p[0]}`:String(d||''); }
function _spCfg(){ try{ return (typeof loadProjectConfig==='function')?loadProjectConfig():JSON.parse(localStorage.getItem('msf_projectconfig')||'{}'); }catch{ return {}; } }

function _spLoadLocal(pid){
  try{ const raw=window.idbGet && window.idbGet(_spKey(pid)); return raw?(JSON.parse(raw)||[]):[]; }catch{ return []; }
}
function _spSaveLocal(pid){
  try{ if(window.idbSet) window.idbSet(_spKey(pid), JSON.stringify(_spRecs[pid]||[])); }catch{}
}

async function spLoad(pid){
  pid = pid || _spPid();
  if(!_spRecs[pid]) _spRecs[pid] = _spLoadLocal(pid);
  if(_spLoaded[pid] || !_spReady()) return;
  try{
    const snap = await _udb().collection('spills').where('projectId','==',pid).get();
    const cloud = snap.docs.map(d=>d.data());
    const byId = {};
    (_spRecs[pid]||[]).forEach(r=>{ byId[r.id]=r; });
    cloud.forEach(r=>{ const l=byId[r.id]; if(!l || (r.updatedAt||0)>=(l.updatedAt||0)) byId[r.id]=r; });
    _spRecs[pid] = Object.values(byId);
    _spSaveLocal(pid);
    _spLoaded[pid] = true;
    spLoadShared(pid);
    _spRepaint();
  }catch(e){ console.warn('spills load:', e && e.message); }
}
function _spRepaint(){
  spRenderReportsSec(); spRenderComplianceCard();
  if(typeof window.mapRenderSpillMarkers==='function'){ try{ window.mapRenderSpillMarkers(); }catch(e){} }
}

// Live records, newest first (discovery date, then creation): own records plus the
// project's PUBLISHED records from other members (read-only; the own copy wins).
function spAll(pid){
  pid = pid || _spPid();
  if(!_spRecs[pid]) _spRecs[pid] = _spLoadLocal(pid);
  if(!_spShared[pid]) _spShared[pid] = _spLoadSharedLocal(pid);
  const me=_spUid();
  const own=(_spRecs[pid]||[]).filter(r=>!r.deletedAt);
  const ownIds=new Set(own.map(r=>r.id));
  const shared=(_spShared[pid]||[]).filter(r=>r&&!r.deletedAt&&!ownIds.has(r.id)&&(!me||r.ownerUid!==me));
  return own.concat(shared)
    .sort((a,b)=>String(b.discoveryDate||b.releaseDate||'').localeCompare(String(a.discoveryDate||a.releaseDate||'')) || (b.createdAt||0)-(a.createdAt||0));
}
function spGet(id, pid){
  pid=pid||_spPid();
  return ((_spRecs[pid])||[]).find(r=>r.id===id) || ((_spShared[pid])||[]).find(r=>r.id===id) || null;
}
function spLabel(r){ return 'SPL-'+String(r&&r.seq?r.seq:0).padStart(2,'0'); }
function _spNextSeq(pid){
  const all=_spRecs[pid]||[];
  return all.reduce((m,r)=>Math.max(m, parseInt(r.seq,10)||0), 0)+1;
}
function _spPersist(rec, o){
  o=o||{};
  const pid = rec.projectId;
  if(!_spRecs[pid]) _spRecs[pid] = _spLoadLocal(pid);
  const idx = _spRecs[pid].findIndex(r=>r.id===rec.id);
  if(idx>=0) _spRecs[pid][idx]=rec; else _spRecs[pid].push(rec);
  _spSaveLocal(pid);
  if(_spReady()){
    try{ _udb().collection('spills').doc(rec.id).set(rec).catch(e=>console.warn('spill save:', e.message)); }catch(e){}
  }
  // A published record keeps its project copy in step: edit → re-mirror, delete → unmirror.
  if(rec.published && !o.noMirror){ if(rec.deletedAt) _spUnmirror(rec); else _spMirror(rec); }
}

// ═══ Project mirror (9/9 — Tim: "publish to the project", no live listener) ═══
// A record is author-private until the author PUBLISHES it. The published copy
// lives at projects/{pid}/spills/{id} (the fieldMarkers / complianceLog rules
// block: member read, work-role create, owner-or-lead edit). Members load the
// mirror with one get on project open (cached in IDB for offline pins) and hold
// it read-only — no edit, no delete, no Log-as-CMP. Unpublish deletes the mirror;
// delete-from-everywhere covers both copies. Photos referenced by a published
// record are published with it so a member's PDF gets the bytes, not caption-only.
function _spSharedKey(pid){ return 'gl_spills_shared::'+pid; }
function _spLoadSharedLocal(pid){
  try{ const raw=window.idbGet && window.idbGet(_spSharedKey(pid)); return raw?(JSON.parse(raw)||[]):[]; }catch{ return []; }
}
function _spIsMine(r){ const me=_spUid(); return !!r && (!r.ownerUid || r.ownerUid===me); }   // a stamped record is never 'mine' by default
function _spOwnerName(r){ return (r&&r.ownerName)||'a project member'; }
function _spFirstName(r){ return String(_spOwnerName(r)).split(' ')[0]; }
function _spPhoto(id){ return (typeof window._phById==='function')?window._phById(id):((window._phPhotos||[]).find(p=>p.id===id)||null); }
// View roles (Glasses / Reviewer ✍) read; they don't start spill records.
function _spCanCreate(){
  try{ const pid=_spPid(); if(!pid||pid==='default') return true;
    const role=(typeof window.glMyRoleFor==='function')?window.glMyRoleFor(pid):null;
    return !(role && typeof window.glIsViewRole==='function' && window.glIsViewRole(role)); }catch{ return true; }
}
function _spWhoChip(r){
  if(_spIsMine(r)) return r.published?'<span title="Shared with the project" style="font-size:11px;flex-shrink:0">📤</span>':'';
  return '<span title="Shared by '+_spEsc(_spOwnerName(r))+'" style="font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0">👥 '+_spEsc(_spFirstName(r))+'</span>';
}
function _spMirrorDoc(rec){
  const d=Object.assign({}, rec);
  delete d.deletedAt; delete d.polishSkipHash; delete d.publishAsked;
  d.published=true; d.publishedAt=rec.publishedAt||Date.now();
  d.ownerUid=rec.ownerUid||_spUid();
  d.ownerName=(typeof window._glMyName==='function')?window._glMyName():((window._currentUser&&(_currentUser.displayName||_currentUser.email))||'');
  d._ts=Date.now();
  return d;
}
const _spMirrorSig=new Map();
function _spMirror(rec){
  if(!_spReady()||!rec||!rec.published||rec.deletedAt||!rec.projectId||rec.projectId==='default') return Promise.resolve(false);
  const d=_spMirrorDoc(rec);
  const sig=JSON.stringify(Object.assign({},d,{_ts:0,ownerName:'',updatedAt:0}));
  if(_spMirrorSig.get(rec.id)===sig) return Promise.resolve(true);
  return db.collection('projects').doc(rec.projectId).collection('spills').doc(rec.id).set(d)
    .then(()=>{ _spMirrorSig.set(rec.id,sig); return true; })
    .catch(e=>{ console.warn('spill mirror:', e.message); return false; });
}
function _spUnmirror(rec){
  _spMirrorSig.delete(rec&&rec.id);
  if(!_spReady()||!rec||!rec.projectId||rec.projectId==='default') return Promise.resolve(false);
  return db.collection('projects').doc(rec.projectId).collection('spills').doc(rec.id).delete().then(()=>true).catch(()=>false);
}
async function spLoadShared(pid){
  pid=pid||_spPid();
  if(!_spShared[pid]) _spShared[pid]=_spLoadSharedLocal(pid);
  if(!_spReady()||!pid||pid==='default') return;
  try{
    const snap=await db.collection('projects').doc(pid).collection('spills').where('published','==',true).get();
    const me=_spUid();
    _spShared[pid]=snap.docs.map(d=>d.data()).filter(r=>r&&r.ownerUid!==me&&!r.deletedAt);
    try{ if(window.idbSet) window.idbSet(_spSharedKey(pid), JSON.stringify(_spShared[pid])); }catch{}
    _spRepaint();
  }catch(e){ /* not a member of a shared project — own records only */ }
}
// Publish: stamp, persist (no auto-mirror), then write the mirror and wait for the
// server's answer — a permission failure reverts the stamp instead of lying.
// Offline the write queues; after 8 s we say so and leave it queued.
// Photos referenced by a published record ride along (publish, later edits, camera attach).
async function _spPublishPhotos(r){
  const ids=(r.photoIds||[]).filter(id=>{ const p=(window._phPhotos||[]).find(x=>x.id===id); return p&&!p.published; });
  if(ids.length&&typeof window.phSetPublished==='function'){ try{ await window.phSetPublished(ids,true,r.projectId); }catch(e){} }
  return ids.length;
}
async function _spPublish(r){
  if(!_spReady()){ if(typeof showCloudBanner==='function') showCloudBanner('✗ Sharing needs a signed-in, online session — try again in a moment.'); return false; }
  r.published=true; r.publishedAt=r.publishedAt||Date.now(); r.updatedAt=Date.now();
  _spPersist(r,{noMirror:true});
  const ok=await Promise.race([_spMirror(r), new Promise(res=>setTimeout(()=>res('queued'),8000))]);
  if(ok===false){
    r.published=false; r.publishedAt=null; r.updatedAt=Date.now(); _spPersist(r,{noMirror:true});
    if(typeof showCloudBanner==='function') showCloudBanner('✗ Could not share '+spLabel(r)+' — sharing needs a field or lead role on a shared project.');
    return false;
  }
  const n=await _spPublishPhotos(r);
  if(typeof showCloudBanner==='function') showCloudBanner((ok==='queued'?'📤 '+spLabel(r)+' queued — shares when back online':'📤 '+spLabel(r)+' shared with the project')+(n?' · '+n+' photo'+(n===1?'':'s')+' published':'')+'.');
  return true;
}
async function spTogglePublish(id){
  const r=spGet(id); if(!r||!_spIsMine(r)) return;
  if(!r.projectId||r.projectId==='default'){ if(typeof showCloudBanner==='function') showCloudBanner('Sharing needs a shared project — this record is on the default project.'); return; }
  if(r.published){
    const c=await _spChoice('Unpublish '+spLabel(r)+'? Project members lose the map pin, the record and the PDF. Your copy stays.','🔒 Unpublish','Keep it shared',{title:'Unpublish from project?'});
    if(c!=='a') return;
    r.published=false; r.publishedAt=null; r.updatedAt=Date.now();
    _spPersist(r,{noMirror:true}); _spUnmirror(r);
    if(typeof showCloudBanner==='function') showCloudBanner('🔒 '+spLabel(r)+' is private again.');
  } else {
    r.publishAsked=true;
    if(!(await _spPublish(r))) return;
  }
  _spRepaint();
  const open=document.querySelector('.modal-overlay'); if(open&&open.id!=='sp-form-ov'){ open.remove(); spShowDetail(r.id); }
}
// Export-time offer (Tim 9/9: "export and/or publish"): asked once per record.
async function _spMaybeOfferPublish(r){
  if(r.published||r.publishAsked||!r.projectId||r.projectId==='default') return true;
  const c=await _spChoice('Share '+spLabel(r)+' with the project team as well? Members get the map pin, the record and this PDF. You can unpublish any time.','📤 Publish & export','Export only',{title:'Publish to project?'});
  if(c===null) return false;
  r.publishAsked=true; r.updatedAt=Date.now();
  if(c==='a'){ await _spPublish(r); } else { _spPersist(r,{noMirror:true}); }
  return true;
}

// ── Weather line for a date ──
// Sources, in order: the live daily-log form when it sits on that date (today's log
// is rarely archived yet — Tim 9/8: "just staying blank"), the autosave draft, then
// the archived log. Sky chips + temps + precip + wind + soil. Shared with agency visits.
function spWeatherLine(date){
  const line=(f,sky)=>{
    f=f||{};
    const parts=[];
    const s=Array.isArray(sky)?sky.join(', '):(sky||'');
    if(s) parts.push(s);
    if(f.tempAM||f.tempPM) parts.push([f.tempAM,f.tempPM].filter(Boolean).join('–')+'°F');
    if(f.precip) parts.push(f.precip);
    if(f.wind) parts.push('wind '+f.wind);
    if(f.soilCond) parts.push('soil: '+f.soilCond);
    return parts.join(', ');
  };
  try{
    const rd=document.getElementById('reportDate');
    if(rd&&rd.value===date){
      const g=(id)=>{ const el=document.getElementById(id); return el?String(el.value||'').trim():''; };
      const sky=[...document.querySelectorAll('input[name="sky"]:checked')].map(el=>el.value);
      const l=line({tempAM:g('tempAM'),tempPM:g('tempPM'),precip:g('precip'),wind:g('wind'),soilCond:g('soilCond')},sky);
      if(l) return l;
    }
  }catch(e){}
  try{
    const d=JSON.parse(localStorage.getItem('msf_autosave')||'null');
    if(d&&d.fields&&d.fields.reportDate===date){ const l=line(d.fields,d.sky); if(l) return l; }
  }catch(e){}
  try{
    const r=(typeof dlGet==='function')?dlGet(date):null;
    if(r){ const l=line(r.fields||{}, r.sky); if(l) return l; }
  }catch(e){}
  return '';
}
const _spWeatherLine=spWeatherLine;
window.spWeatherLine=spWeatherLine;

// ── Reportability (NY): a petroleum spill is exempt ONLY if all four hold ──
const _SP_EXEMPT = [
  ['exUnder5',   'Known to be less than 5 gallons'],
  ['exContained','Contained and under the control of the spiller'],
  ['exNoContact','Has not and will not reach the State\'s waters or any land (bare soil counts as land)'],
  ['exWithin2h', 'Cleaned up within 2 hours of discovery']
];
function _spExemptLine(rec){
  const misses=_SP_EXEMPT.filter(([k])=>!rec[k]).length;
  if(misses===0) return {ok:true, text:'✓ Meets all four exemption criteria — not reportable to the state hotline. The owner still gets this form within 24 hours.'};
  return {ok:false, text:`⚠ ${misses} of 4 criteria not met — REPORTABLE. State spill hotline within 2 hours of discovery (NYSDEC 1-800-457-7362); the EM/CM makes the call, the EI documents and verifies it happened.`};
}

// ═══ Blank record ═══
function _spBlank(pid){
  const cfg=_spCfg();
  return {
    id:_spGenId(), projectId:pid, seq:_spNextSeq(pid), status:'open',
    createdAt:Date.now(), ownerUid:_spUid(),
    releaseDate:_spToday(), discoveryDate:_spToday(), discoveryTime:_spNow(),
    respName:'', respPhone:'',
    substance:'', quantity:'', locationDesc:'', lat:null, lng:null, cause:'', weather:_spWeatherLine(_spToday()),
    waterReached:'n', waterBody:'', dischargePoint:'', leftProperty:'', damage:'',
    hazFire:false, hazExplosion:false, hazOther:'', injuries:'',
    caContain:'', caCleanup:'', caRemove:'', caDisposal:'', caPrevent:'', caComplete:'',
    exUnder5:false, exContained:false, exNoContact:false, exWithin2h:false,
    reportable:'', agencies:'', agencyPhone:'', agencyPersonnel:'', reportDateTime:'', spillNo:'', followUp:'', pmFollowUp:'',
    notifications:[], notes:'', photoIds:[], cmpId:null,
    preparedBy:cfg.preparedBy||'', org:cfg.org||''
  };
}

// ═══ Form (bottom sheet — new / edit / resume-from-draft) ═══
function spShowForm(id, draft){
  const pid=_spPid();
  const existing = id ? spGet(id,pid) : null;
  if(existing && !_spIsMine(existing)){ spShowDetail(id); return; }   // members read, never edit
  const v = draft || existing || _spBlank(pid);
  _spFormId = v.id;
  _spFormSel = new Set(v.photoIds||[]);
  _spNotifs = (v.notifications||[]).map(n=>Object.assign({},n));
  document.getElementById('sp-form-ov')?.remove();
  const ov=document.createElement('div');
  ov.className='modal-overlay'; ov.id='sp-form-ov'; ov.style.cssText='z-index:5000;align-items:flex-end;padding:0';
  const F=(label,key,o)=>{
    o=o||{};
    const val=v[key]==null?'':v[key];
    let inp;
    if(o.type==='date') inp=`<input type="date" id="sp-f-${key}" value="${_spEsc(val)}" style="${_SP_INP}">`;
    else if(o.type==='time') inp=`<input type="time" id="sp-f-${key}" value="${_spEsc(val)}" style="${_SP_INP}">`;
    else if(o.type==='select') inp=`<select id="sp-f-${key}" style="${_SP_INP}">${o.opts.map(([ov2,l])=>`<option value="${_spEsc(ov2)}"${String(val)===String(ov2)?' selected':''}>${_spEsc(l)}</option>`).join('')}</select>`;
    else inp=`<textarea id="sp-f-${key}" rows="${o.rows||1}" class="auto-expand${o.rows>1?'':' auto-line'}" placeholder="${_spEsc(o.ph||'')}" style="${_SP_INP}">${_spEsc(val)}</textarea>`;
    return `<div style="margin-bottom:8px;${o.style||''}"><label style="${_SP_LBL}">${label}${o.extra||''}</label>${inp}</div>`;
  };
  const CK=(label,key)=>`<label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.35;padding:5px 0;cursor:pointer"><input type="checkbox" id="sp-f-${key}" ${v[key]?'checked':''} style="width:18px;height:18px;margin-top:1px;flex-shrink:0">${label}</label>`;
  const cfg=_spCfg();
  const hasLoc=typeof v.lat==='number'&&typeof v.lng==='number';
  ov.innerHTML=`
    <div style="width:100%;max-height:calc(100dvh - var(--app-bar-h,58px) - 8px);background:var(--bg);border-top:1px solid var(--border);border-radius:16px 16px 0 0;display:flex;flex-direction:column;overflow:hidden;padding-bottom:env(safe-area-inset-bottom)">
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--border);flex-shrink:0">
        <span style="font-family:var(--cond);font-weight:700;font-size:15px;letter-spacing:.06em;text-transform:uppercase;flex:1">🛢 ${existing||draft?'Edit':'New'} Spill · ${spLabel(v)}</span>
        <select id="sp-f-status" style="${_SP_INP};width:auto;min-height:34px;padding:4px 8px;font-size:12px;font-family:var(--mono)">
          <option value="open"${v.status!=='closed'?' selected':''}>● Open</option><option value="closed"${v.status==='closed'?' selected':''}>✓ Closed</option>
        </select>
        <button id="sp-f-close" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;width:36px;height:36px">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:4px 16px 12px" id="sp-f-body">

        <div style="${_SP_SEC}">1 · Incident</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5">${_spEsc(cfg.projectName||'Project')}${cfg.siteAddress?' · '+_spEsc(cfg.siteAddress):' · <span style="color:var(--amber)">no site address yet — Settings → Project</span>'}</div>
        <div style="display:flex;gap:8px">
          <div style="flex:1">${F('Date of release','releaseDate',{type:'date'})}</div>
          <div style="flex:1">${F('Date of discovery','discoveryDate',{type:'date'})}</div>
          <div style="flex:.8">${F('Time','discoveryTime',{type:'time'})}</div>
        </div>

        <div style="${_SP_SEC}">2 · Responsible person</div>
        ${F('Name, title &amp; company of the person responsible for the response','respName',{ph:'e.g. Foreman, contractor name', extra:(typeof ctrPickBtn==='function')?' '+ctrPickBtn('sp-f-respName'):''})}
        ${F('Phone','respPhone',{ph:'###-###-####'})}

        <div style="${_SP_SEC}">3 · Incident information</div>
        ${F('Type of substance(s) released','substance',{ph:'e.g. Hydraulic oil'})}
        ${F('Quantity released','quantity',{ph:'e.g. Approximately 0.25 gallons (1 quart)'})}
        ${F('Describe the release location','locationDesc',{rows:2,ph:'Where on site — laydown, road, field, feature nearby'})}
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:-2px 0 10px">
          <span id="sp-f-locchip" style="font-family:var(--mono);font-size:11px;color:${hasLoc?'var(--amber)':'var(--muted)'};flex:1;min-width:120px">${hasLoc?'📍 '+(+v.lat).toFixed(5)+', '+(+v.lng).toFixed(5):'📍 no map location yet'}</span>
          <button type="button" class="btn btn-outline" style="font-size:11px;padding:6px 10px" onclick="spLocHere()">📍 My position</button>
          <button type="button" class="btn btn-outline" style="font-size:11px;padding:6px 10px" onclick="spLocPickOnMap()">🗺 Pick on map</button>
          <button type="button" class="btn btn-outline" style="font-size:11px;padding:6px 10px" onclick="spLocFromPhoto()">📷 From photo</button>
          <button type="button" class="btn btn-outline" style="font-size:11px;padding:6px 10px;color:var(--muted)" onclick="spLocClear()">✕</button>
        </div>
        ${F('What caused the release','cause',{rows:2,ph:'Failed hose, overfill, equipment leak…'})}
        ${F('Weather conditions','weather',{ph:'Temp, sky, wind, precipitation', extra:` <button type="button" onclick="spWeatherFill()" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--amber);font-family:var(--mono);font-size:10px;padding:2px 8px;cursor:pointer;margin-left:6px">⟲ from daily log</button>`})}
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin:10px 0 6px;letter-spacing:.04em">IF THE RELEASE DISCHARGED INTO WATER, WETLAND, OR A SENSITIVE AREA</div>
        ${F('Did the release reach water, a wetland, or a sensitive area?','waterReached',{type:'select',opts:[['n','No — contained on land'],['potential','Potential pathway (ditch / culvert / drainage)'],['y','Yes — reached water / wetland / sensitive area']]})}
        <div id="sp-f-waterwrap" style="display:${v.waterReached&&v.waterReached!=='n'?'block':'none'}">
          ${F('Name of water body (if ditch or culvert, the water body it discharges to)','waterBody',{ph:'Stream / wetland ID and name'})}
          ${F('Identify the discharge point','dischargePoint',{ph:'DP / outfall / culvert'})}
          ${F('Did the release leave the property?','leftProperty',{type:'select',opts:[['','—'],['n','No'],['y','Yes']]})}
          ${F('Describe environmental damage (e.g. fish kill), if applicable','damage',{rows:2})}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 2px">
          ${CK('Fire hazard','hazFire')}
          ${CK('Explosion hazard','hazExplosion')}
        </div>
        ${F('Other existing or potential hazards','hazOther',{ph:'None'})}
        ${F('Injuries related to the release','injuries',{ph:'None'})}

        <div style="${_SP_SEC}">4 · Corrective actions taken</div>
        ${F('To contain the release / impact','caContain',{rows:2})}
        ${F('To clean up / recover','caCleanup',{rows:2})}
        ${F('To remove cleanup material','caRemove',{rows:2})}
        ${F('To document disposal','caDisposal',{rows:2})}
        ${F('To prevent reoccurrence','caPrevent',{rows:2})}
        ${F('When will the corrective action be completed','caComplete')}

        <div style="${_SP_SEC}">5 · Reporting</div>
        <div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px">
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.04em;margin-bottom:2px">NY PETROLEUM-SPILL EXEMPTION TEST (6 NYCRR 613) — exempt from state reporting ONLY if all four are true</div>
          ${_SP_EXEMPT.map(([k,l])=>CK(l,k)).join('')}
          <div id="sp-f-exline" style="font-size:12px;line-height:1.45;margin-top:4px;padding-top:6px;border-top:1px solid var(--border)"></div>
        </div>
        ${F('Does the incident meet or exceed reportable quantities?','reportable',{type:'select',opts:[['','— pick —'],['y','Yes'],['n','No']]})}
        <div id="sp-f-repwrap" style="display:${v.reportable==='y'?'block':'none'}">
          ${F('Agency(ies) contacted','agencies',{ph:'e.g. state spill hotline, owner'})}
          ${F('Agency phone number','agencyPhone')}
          ${F('Names of agency personnel spoken to','agencyPersonnel')}
          ${F('Date / time of report','reportDateTime',{ph:'e.g. 8/29/2026 10:15 AM'})}
          ${F('Spill number assigned','spillNo',{ph:'State spill # (if any)'})}
          ${F('Is a follow-up report required by the agency? If so, when','followUp')}
          ${F('Follow-up or corrective action required by the PM','pmFollowUp')}
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.04em;margin:8px 0 4px">NOTIFICATION LOG — who was told, by whom, when</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px">
          ${_SP_ROLES.map(r=>`<button type="button" onclick="spNotifAdd('${_spEsc(r)}')" style="background:var(--s1);border:1px solid var(--border);border-radius:12px;color:var(--text);font-family:var(--mono);font-size:10px;padding:4px 9px;cursor:pointer">＋ ${_spEsc(r)}</button>`).join('')}
        </div>
        <div id="sp-f-notifs"></div>

        <div style="${_SP_SEC}">6 · Notes &amp; photos</div>
        ${F('Additional notes / information','notes',{rows:4,ph:'Timeline in plain words: who found it, who responded, what was done, who was notified'})}
        <label style="${_SP_LBL}">Photos — <span id="sp-f-phcount">${_spFormSel.size}</span> attached</label>
        <div id="sp-f-photos" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button type="button" class="btn btn-amber" style="flex:1;font-size:12px" onclick="spFormCamera()">📸 Take photo</button>
          <button type="button" class="btn btn-outline" style="flex:1;font-size:12px" onclick="spFormPickPhotos()">🖼 Attach existing</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border);flex-shrink:0">
        <button id="sp-f-formalize" class="btn btn-outline" style="min-height:44px;flex:0 0 auto" onclick="spFormalize()" title="Rewrite the narrative fields into formal report language — you review before it applies">✦ Formalize</button>
        <button id="sp-f-save" class="btn btn-amber" style="flex:1;min-height:44px">💾 Save spill record</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.dataset.lat=hasLoc?String(v.lat):''; ov.dataset.lng=hasLoc?String(v.lng):'';
  ov.dataset.seq=String(v.seq||''); ov.dataset.created=String(v.createdAt||Date.now()); ov.dataset.owner=v.ownerUid||''; ov.dataset.cmp=v.cmpId||'';
  ov.dataset.existing=(existing||(draft&&spGet(v.id,pid)))?'1':'';
  requestAnimationFrame(()=>{ ov.querySelectorAll('textarea.auto-expand').forEach(t=>{ if(typeof autoResize==='function') autoResize(t); }); });
  _spRenderPhotos(); _spRenderNotifs(); _spPaintExempt();
  // live show/hide + exemption line
  ov.querySelector('#sp-f-waterReached').onchange=function(){ document.getElementById('sp-f-waterwrap').style.display=this.value!=='n'?'block':'none'; };
  ov.querySelector('#sp-f-reportable').onchange=function(){ document.getElementById('sp-f-repwrap').style.display=this.value==='y'?'block':'none'; };
  _SP_EXEMPT.forEach(([k])=>{ const cb=ov.querySelector('#sp-f-'+k); if(cb) cb.onchange=_spPaintExempt; });
  ov.querySelector('#sp-f-close').onclick=()=>{ ov.remove(); _spFormId=null; _spFormSel=null; _spDraft=null; };
  ov.querySelector('#sp-f-save').onclick=()=>{
    const rec=_spCollect();
    if(!rec) return;
    rec.updatedAt=Date.now(); rec.deletedAt=null;
    _spPersist(rec);
    if(rec.published) _spPublishPhotos(rec);   // new photos on a shared record share too
    if(window.glHaptic&&window.glHaptic.success) window.glHaptic.success();
    ov.remove(); _spFormId=null; _spFormSel=null; _spDraft=null;
    _spRepaint();
    if(typeof showCloudBanner==='function') showCloudBanner('🛢 '+spLabel(rec)+' saved'+(rec.reportable==='y'?' — reportable, notification log kept.':'.'));
  };
}
function _spVal(key){ const el=document.getElementById('sp-f-'+key); if(!el) return ''; return el.type==='checkbox'?!!el.checked:String(el.value||'').trim(); }
// Read the open form back into a record object (used by save + park-for-map-pick).
function _spCollect(){
  const ov=document.getElementById('sp-form-ov'); if(!ov) return null;
  const pid=_spPid();
  const base=spGet(_spFormId,pid)||_spDraft||null;
  const rec=Object.assign({}, base||{}, {
    id:_spFormId, projectId:pid,
    seq:parseInt(ov.dataset.seq,10)||_spNextSeq(pid),
    createdAt:parseInt(ov.dataset.created,10)||Date.now(),
    ownerUid:ov.dataset.owner||_spUid(),
    cmpId:ov.dataset.cmp||(base&&base.cmpId)||null,
    status:_spVal('status')||'open',
    lat:ov.dataset.lat!==''?parseFloat(ov.dataset.lat):null,
    lng:ov.dataset.lng!==''?parseFloat(ov.dataset.lng):null,
    notifications:_spNotifCollect(),
    photoIds:[...(_spFormSel||[])],
    preparedBy:(base&&base.preparedBy)||_spCfg().preparedBy||'',
    org:(base&&base.org)||_spCfg().org||''
  });
  ['releaseDate','discoveryDate','discoveryTime','respName','respPhone','substance','quantity','locationDesc','cause','weather',
   'waterReached','waterBody','dischargePoint','leftProperty','damage','hazOther','injuries',
   'caContain','caCleanup','caRemove','caDisposal','caPrevent','caComplete',
   'reportable','agencies','agencyPhone','agencyPersonnel','reportDateTime','spillNo','followUp','pmFollowUp','notes'].forEach(k=>{ rec[k]=_spVal(k); });
  ['hazFire','hazExplosion','exUnder5','exContained','exNoContact','exWithin2h'].forEach(k=>{ rec[k]=!!_spVal(k); });
  // ✦ Formalize bookkeeping: the hash of the narrative fields at the moment a polish was
  // applied in this form — export compares it to know whether to offer formalizing.
  if(ov.dataset.formalized) rec.formalizedHash=_spPolishHash(rec);
  return rec;
}

// ═══ ✦ Formalize (9/8, Tim: "like we do with daily log") ═══
// Same door as the daily-log polish (report.js → window.glClaude): narrative fields
// go out as JSON, come back rewritten, and the AUTHOR reviews field by field before
// anything is applied. Export offers it once per edit state (hash of the fields).
const _SP_POLISH_KEYS=['locationDesc','cause','weather','waterBody','dischargePoint','damage','hazOther','injuries','caContain','caCleanup','caRemove','caDisposal','caPrevent','caComplete','agencies','agencyPersonnel','followUp','pmFollowUp','notes'];
const _SP_POLISH_SYS='You are a professional environmental inspector writing assistant. Rewrite the provided spill / incident report field notes into clean, formal language suitable for an owner-filed environmental incident report. Rules: third person, past tense, definitive language; use "conducting" not "performing"; preserve every fact, name, time, quantity, material, location and spill number exactly as entered; do not add information not present in the original; do not remove relevant observations; keep each field a short paragraph with no headings and no bullet lists; do not use em dashes. Return a JSON object with the same keys as provided, containing the rewritten text for each field. Return ONLY the JSON object, no preamble, no markdown, no code fences.';
function _spPolishHash(rec){
  const s=_SP_POLISH_KEYS.map(k=>String(rec[k]||'').trim()).join('');
  let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0;
  return 'h'+(h>>>0).toString(36)+s.length.toString(36);
}
function _spFieldLabel(k){ return ({locationDesc:'Release location',cause:'Cause',weather:'Weather',waterBody:'Water body',dischargePoint:'Discharge point',damage:'Environmental damage',hazOther:'Other hazards',injuries:'Injuries',caContain:'Contain',caCleanup:'Clean up',caRemove:'Remove cleanup material',caDisposal:'Document disposal',caPrevent:'Prevent reoccurrence',caComplete:'Completion',agencies:'Agencies contacted',agencyPersonnel:'Agency personnel',followUp:'Follow-up',pmFollowUp:'PM follow-up',notes:'Notes'})[k]||k; }
async function _spPolish(rec){
  if(typeof window.glClaude!=='function') throw new Error('AI polish not available — reload the app online once.');
  const payload={}; _SP_POLISH_KEYS.forEach(k=>{ const v=String(rec[k]||'').trim(); if(v) payload[k]=v; });
  if(!Object.keys(payload).length) throw new Error('Nothing to formalize yet — fill in the narrative fields first.');
  const text=await window.glClaude(_SP_POLISH_SYS,'Rewrite these incident report fields:\n'+JSON.stringify(payload),6000);
  const j0=text.indexOf('{'),j1=text.lastIndexOf('}');
  if(j0===-1||j1===-1){ console.error('spill formalize: no JSON in response:',text); throw new Error('Polish response malformed — see console'); }
  const out=JSON.parse(text.slice(j0,j1+1));
  const patch={}; Object.keys(payload).forEach(k=>{ if(typeof out[k]==='string'&&out[k].trim()) patch[k]=out[k].trim(); });
  return patch;
}
// Form button: preview before/after per field; untick anything to keep as typed.
async function spFormalize(){
  const btn=document.getElementById('sp-f-formalize');
  const rec=_spCollect(); if(!rec) return;
  if(btn){ btn.disabled=true; btn.textContent='✦ Formalizing…'; }
  try{
    const patch=await _spPolish(rec);
    const keys=Object.keys(patch).filter(k=>patch[k]!==String(rec[k]||'').trim());
    if(!keys.length) throw new Error('Nothing changed — the wording already reads formal.');
    const ov=document.createElement('div'); ov.className='modal-overlay'; ov.style.cssText='z-index:9700';
    ov.innerHTML=`<div class="modal-box" style="max-width:460px;width:94%;max-height:84dvh;display:flex;flex-direction:column">
      <div class="modal-title" style="margin-bottom:2px">✦ Formalized — review before applying</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:8px">Untick any field to keep your wording. Facts are preserved by rule; read it anyway.</div>
      <div style="flex:1;overflow-y:auto;min-height:0">${keys.map(k=>`<label style="display:block;border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer">
          <div style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="${k}" checked style="width:18px;height:18px"><span style="font-family:var(--mono);font-size:10px;color:var(--amber);letter-spacing:.04em">${_spEsc(_spFieldLabel(k))}</span></div>
          <div style="font-size:11px;color:var(--muted);margin:4px 0 2px;text-decoration:line-through;line-height:1.4">${_spEsc(rec[k])}</div>
          <div style="font-size:13px;line-height:1.45">${_spEsc(patch[k])}</div>
        </label>`).join('')}</div>
      <div class="modal-btns" style="margin-top:10px"><button class="modal-cancel" id="sp-pol-cancel">Keep mine</button><button class="modal-confirm" id="sp-pol-ok">Apply</button></div>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#sp-pol-cancel').onclick=()=>ov.remove();
    ov.querySelector('#sp-pol-ok').onclick=()=>{
      let n=0;
      ov.querySelectorAll('input[data-k]').forEach(cb=>{ if(!cb.checked) return; const el=document.getElementById('sp-f-'+cb.dataset.k); if(el){ el.value=patch[cb.dataset.k]; if(typeof autoResize==='function') autoResize(el); n++; } });
      const fo=document.getElementById('sp-form-ov'); if(fo) fo.dataset.formalized='1';
      ov.remove();
      if(typeof showCloudBanner==='function') showCloudBanner('✦ '+n+' field'+(n===1?'':'s')+' formalized — save the record.');
    };
  }catch(e){ console.error('spill formalize:',e); if(typeof showCloudBanner==='function') showCloudBanner('✗ '+String(e.message||e).slice(0,110)); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='✦ Formalize'; } }
}
// Export-time offer ("make it formalize itself"): asked once per edit state — a record
// already formalized (or exported as typed) at this wording is not asked again.
function _spChoice(msg, labelA, labelB, o){
  o=o||{};
  return new Promise(res=>{
    const ov=document.createElement('div'); ov.className='modal-overlay'; ov.style.cssText='z-index:9700';
    ov.innerHTML=`<div class="modal-box" style="max-width:340px;width:92%">
      <div class="modal-title" style="margin-bottom:8px">${_spEsc(o.title||'✦ Formalize first?')}</div>
      <div style="font-size:13px;line-height:1.5;margin-bottom:14px">${msg}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn${o.danger?'':' btn-amber'}" id="sp-ch-a" style="min-height:44px${o.danger?';background:#3d1414;border:1px solid #6b2020;color:#ff8080':''}">${labelA}</button>
        <button class="btn btn-outline" id="sp-ch-b" style="min-height:44px">${labelB}</button>
        <button class="btn btn-outline" id="sp-ch-x" style="min-height:36px;color:var(--muted);border-color:transparent">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#sp-ch-a').onclick=()=>{ ov.remove(); res('a'); };
    ov.querySelector('#sp-ch-b').onclick=()=>{ ov.remove(); res('b'); };
    ov.querySelector('#sp-ch-x').onclick=()=>{ ov.remove(); res(null); };
  });
}
async function _spMaybeFormalizeForExport(r){
  const hash=_spPolishHash(r);
  if(hash===r.formalizedHash||hash===r.polishSkipHash) return true;
  const choice=await _spChoice('Rewrite the narrative fields into formal report language before exporting? You can still edit afterwards.','✦ Formalize & export','Export as typed');
  if(choice===null) return false;
  if(choice==='a'){
    try{
      if(typeof showCloudBanner==='function') showCloudBanner('✦ Formalizing…');
      const patch=await _spPolish(r);
      Object.assign(r,patch);
      r.formalizedHash=_spPolishHash(r); r.updatedAt=Date.now();
      _spPersist(r); _spRepaint();
      if(typeof showCloudBanner==='function') showCloudBanner('✦ Formalized '+Object.keys(patch).length+' field'+(Object.keys(patch).length===1?'':'s')+' — exporting.');
    }catch(e){ console.error('spill formalize (export):',e); if(typeof showCloudBanner==='function') showCloudBanner('✗ Formalize failed: '+String(e.message||e).slice(0,80)+' — exporting as typed.'); }
  } else {
    r.polishSkipHash=hash; r.updatedAt=Date.now(); _spPersist(r);
  }
  return true;
}
window.spFormalize=spFormalize;
function _spPaintExempt(){
  const el=document.getElementById('sp-f-exline'); if(!el) return;
  const tmp={}; _SP_EXEMPT.forEach(([k])=>{ tmp[k]=!!_spVal(k); });
  const r=_spExemptLine(tmp);
  el.textContent=r.text;
  el.style.color=r.ok?'var(--text)':'var(--amber)';
}

// ── Location helpers ──
function _spSetLoc(lat,lng){
  const ov=document.getElementById('sp-form-ov'); if(!ov) return;
  const chip=document.getElementById('sp-f-locchip');
  if(typeof lat==='number'&&typeof lng==='number'&&isFinite(lat)&&isFinite(lng)){
    ov.dataset.lat=String(lat); ov.dataset.lng=String(lng);
    if(chip){ chip.textContent='📍 '+lat.toFixed(5)+', '+lng.toFixed(5); chip.style.color='var(--amber)'; }
  } else {
    ov.dataset.lat=''; ov.dataset.lng='';
    if(chip){ chip.textContent='📍 no map location yet'; chip.style.color='var(--muted)'; }
  }
}
function spLocClear(){ _spSetLoc(null,null); }
function spLocHere(){
  if(!navigator.geolocation){ if(typeof showCloudBanner==='function') showCloudBanner('Location not available on this device.'); return; }
  const chip=document.getElementById('sp-f-locchip'); if(chip) chip.textContent='📍 locating…';
  navigator.geolocation.getCurrentPosition(p=>{ _spSetLoc(p.coords.latitude,p.coords.longitude); },
    e=>{ _spSetLoc(null,null); if(typeof showCloudBanner==='function') showCloudBanner('✗ Could not get a position — '+(e&&e.message||'try again outside')); },
    {enableHighAccuracy:true,timeout:12000,maximumAge:30000});
}
function spLocFromPhoto(){
  const ids=[...(_spFormSel||[])];
  const p=(window._phPhotos||[]).find(x=>ids.includes(x.id)&&typeof x.lat==='number'&&typeof x.lng==='number')
       || (window._phPhotos||[]).find(x=>ids.includes(x.id)&&x.lat!=null&&x.lng!=null);
  if(!p){ if(typeof showCloudBanner==='function') showCloudBanner('No attached photo carries GPS — take one with the in-app camera first.'); return; }
  _spSetLoc(+p.lat,+p.lng);
}
// Park the form, hop to the map, one tap places the pin, hop back and resume.
function spLocPickOnMap(){
  const draft=_spCollect(); if(!draft) return;
  _spDraft=draft;
  document.getElementById('sp-form-ov')?.remove();
  if(typeof showPage==='function') showPage('map');
  if(typeof window.mapPickSpillLocation!=='function'){ spShowForm(null,_spDraft); return; }
  setTimeout(()=>{
    window.mapPickSpillLocation(ll=>{
      const d=_spDraft||draft;
      if(ll){ d.lat=ll.lat; d.lng=ll.lng; }
      if(typeof showPage==='function') showPage('compliance');
      setTimeout(()=>spShowForm(null,d),50);
    });
  },350);
}
function spWeatherFill(){
  const date=_spVal('discoveryDate')||_spToday();
  const line=_spWeatherLine(date);
  const el=document.getElementById('sp-f-weather'); if(!el) return;
  if(!line){ if(typeof showCloudBanner==='function') showCloudBanner('No daily-log weather for '+_spPretty(date)+' yet.'); return; }
  el.value=line; if(typeof autoResize==='function') autoResize(el);
}

// ── Notification log rows ──
function _spRenderNotifs(){
  const box=document.getElementById('sp-f-notifs'); if(!box) return;
  if(!_spNotifs.length){ box.innerHTML='<div style="font-family:var(--mono);font-size:10px;color:var(--muted);padding:2px 0 8px">No notifications logged yet — tap a role above to add a row.</div>'; return; }
  const inp='box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:14px;padding:6px;min-height:36px;font-family:var(--body)';
  box.innerHTML=_spNotifs.map((n,i)=>`
    <div style="border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:8px;padding:8px;margin-bottom:6px">
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input type="text" data-nk="who" data-i="${i}" value="${_spEsc(n.who)}" placeholder="Who was notified (role / name)" style="${inp};flex:2;min-width:0">
        <input type="time" data-nk="time" data-i="${i}" value="${_spEsc(n.time)}" style="${inp};flex:1;min-width:0">
      </div>
      <div style="display:flex;gap:6px">
        <input type="text" data-nk="by" data-i="${i}" value="${_spEsc(n.by)}" placeholder="By whom" style="${inp};flex:1;min-width:0">
        <select data-nk="method" data-i="${i}" style="${inp};flex:1;min-width:0">${['call','text','email','in person','other'].map(m=>`<option value="${m}"${n.method===m?' selected':''}>${m}</option>`).join('')}</select>
        <input type="text" data-nk="note" data-i="${i}" value="${_spEsc(n.note)}" placeholder="Note / spill # given" style="${inp};flex:2;min-width:0">
        <button type="button" onclick="spNotifRemove(${i})" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);width:34px;flex-shrink:0;cursor:pointer">✕</button>
      </div>
    </div>`).join('');
}
function _spNotifCollect(){
  const box=document.getElementById('sp-f-notifs'); if(!box) return _spNotifs;
  const out=_spNotifs.map(n=>Object.assign({},n));
  box.querySelectorAll('[data-nk]').forEach(el=>{ const i=+el.dataset.i; if(out[i]) out[i][el.dataset.nk]=String(el.value||'').trim(); });
  return out.filter(n=>n.who||n.by||n.note);
}
function spNotifAdd(who){
  _spNotifs=_spNotifCollect();
  _spNotifs.push({who:who==='Other'?'':who, by:_spCfg().preparedBy||'', time:_spNow(), method:'call', note:''});
  _spRenderNotifs();
}
function spNotifRemove(i){ _spNotifs=_spNotifCollect(); _spNotifs.splice(i,1); _spRenderNotifs(); }

// ── Photos in the form ──
function _spRenderPhotos(){
  const box=document.getElementById('sp-f-photos'); if(!box||!_spFormSel) return;
  const cnt=document.getElementById('sp-f-phcount'); if(cnt) cnt.textContent=String(_spFormSel.size);
  const ps=[..._spFormSel].map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
  box.innerHTML=ps.length?ps.map(p=>`<div style="position:relative;width:64px;height:64px;border-radius:6px;overflow:hidden;border:2px solid var(--amber)">
      <img src="${_spEsc(p.thumb)}" style="width:100%;height:100%;object-fit:cover">
      <button type="button" onclick="spFormRemovePhoto('${_spEsc(p.id)}')" style="position:absolute;top:0;right:0;background:rgba(0,0,0,.6);color:#fff;border:none;width:20px;height:20px;font-size:11px;cursor:pointer;border-radius:0 0 0 6px">✕</button>
    </div>`).join('')
    :'<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">No photos attached yet.</span>';
}
function spFormRemovePhoto(id){ if(_spFormSel){ _spFormSel.delete(id); _spRenderPhotos(); } }
function spFormCamera(){
  if(!_spFormId) return;
  if(typeof phOpenCamera==='function') phOpenCamera({attach:{type:'sp',id:_spFormId}});
}
// photos.js hands every camera shot launched from a spill record here (attach type 'sp').
function spAttachPhoto(recId, photoId){
  if(!recId||!photoId) return;
  if(_spFormId===recId&&_spFormSel){ _spFormSel.add(photoId); _spRenderPhotos(); return; }
  const rec=spGet(recId); if(!rec) return;
  rec.photoIds=Array.isArray(rec.photoIds)?rec.photoIds:[];
  if(!rec.photoIds.includes(photoId)){ rec.photoIds.push(photoId); rec.updatedAt=Date.now(); _spPersist(rec); if(rec.published) _spPublishPhotos(rec); _spRepaint(); }
}
function spFormPickPhotos(){
  if(!_spFormSel) return;
  const pid=_spPid();
  const date=_spVal('discoveryDate');
  const all=(window._phPhotos||[]).filter(p=>!p.deletedAt&&p.thumb&&(!p.projectId||p.projectId===pid))
    .sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||(b.uploadedAt||0)-(a.uploadedAt||0));
  let dayOnly=all.some(p=>p.date===date);
  const ov=document.createElement('div'); ov.className='modal-overlay'; ov.style.cssText='z-index:7000';
  const render=()=>{
    const list=dayOnly?all.filter(p=>p.date===date):all.slice(0,300);
    ov.innerHTML=`<div class="modal-box" style="max-width:380px;width:92%;max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-title" style="margin-bottom:6px">Attach photos</div>
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <button type="button" id="sp-pk-day" class="btn ${dayOnly?'btn-amber':'btn-outline'}" style="flex:1;font-size:11px">${_spEsc(_spPretty(date))}</button>
        <button type="button" id="sp-pk-all" class="btn ${dayOnly?'btn-outline':'btn-amber'}" style="flex:1;font-size:11px">All project photos</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;flex:1;margin-bottom:12px">
        ${list.length?list.map(p=>{ const on=_spFormSel.has(p.id); return `<div data-pid="${_spEsc(p.id)}" style="position:relative;cursor:pointer;border-radius:6px;border:2px solid ${on?'var(--amber)':'transparent'};overflow:hidden">
            <img src="${_spEsc(p.thumb)}" style="width:80px;height:60px;object-fit:cover;display:block">
            <div style="position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;background:${on?'var(--amber)':'rgba(0,0,0,.45)'};display:flex;align-items:center;justify-content:center;font-size:9px;color:#111">${on?'✓':''}</div>
            <div style="position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-family:var(--mono);font-size:8px;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_spEsc((p.date||'').slice(5))}${p.caption?' · '+_spEsc(p.caption):''}</div>
          </div>`; }).join(''):'<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">No photos here yet.</span>'}
      </div>
      <div class="modal-btns"><button class="modal-confirm" id="sp-pk-done">Done</button></div>
    </div>`;
    ov.querySelector('#sp-pk-day').onclick=()=>{ dayOnly=true; render(); };
    ov.querySelector('#sp-pk-all').onclick=()=>{ dayOnly=false; render(); };
    ov.querySelector('#sp-pk-done').onclick=()=>{ ov.remove(); _spRenderPhotos(); };
    ov.querySelectorAll('[data-pid]').forEach(el=>{ el.onclick=()=>{ const id=el.dataset.pid; if(_spFormSel.has(id)) _spFormSel.delete(id); else _spFormSel.add(id); render(); }; });
  };
  render();
  document.body.appendChild(ov);
}

// ═══ Delete (soft) — from everywhere (Tim 9/8 rider): the house modal replaces the
// native confirm (dead on iOS); a published record's project copy goes with it.
async function spDelete(id){
  const rec=spGet(id); if(!rec||!_spIsMine(rec)) return;
  const where=rec.published
    ?'It disappears for every project member too: the Compliance card, the Reports section, the map pin and the shared record.'
    :'It disappears from your Compliance card, the Reports section and the map.';
  const cmpNote=rec.cmpId?' Its compliance-log entry (CMP) goes with it and is not recoverable.':'';
  const c=await _spChoice('Delete '+spLabel(rec)+' ('+_spPretty(rec.discoveryDate||rec.releaseDate||'')+') from everywhere? '+where+cmpNote+' The spill record itself is recoverable by support.',
    '🗑 Delete from everywhere','Keep it',{title:'Delete spill record?',danger:true});
  if(c!=='a') return;
  // Tim 9/9: "everywhere" includes the CMP entry Log-as-CMP filed (daily report + punchlist).
  if(rec.cmpId&&typeof window.clDeleteEntryById==='function'){ try{ window.clDeleteEntryById(rec.cmpId); }catch(e){ console.warn('spill delete: cmp cascade', e&&e.message); } }
  rec.deletedAt=Date.now(); rec.updatedAt=Date.now();
  _spPersist(rec);   // published → _spUnmirror
  _spRepaint();
  if(typeof showCloudBanner==='function') showCloudBanner('🗑 '+spLabel(rec)+' deleted'+(rec.published?' everywhere':'')+'.');
}

// ═══ Read-only detail ═══
function spShowDetail(id){
  const pid=_spPid();
  const r=spGet(id,pid); if(!r) return;
  const ex=_spExemptLine(r);
  const hasLoc=typeof r.lat==='number'&&typeof r.lng==='number';
  const mine=_spIsMine(r);
  const row=(l,val)=>val?`<div style="margin-bottom:6px"><div style="font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.04em">${l}</div><div style="font-size:13px;line-height:1.45;white-space:pre-wrap">${_spEsc(val)}</div></div>`:'';
  const cmpTxt=r.cmpId?(()=>{ try{ const e=(typeof clGetEntries==='function'?clGetEntries():[]).find(x=>x.id===r.cmpId); return e&&e.cmpNum?('CMP-'+String(e.cmpNum).padStart(2,'0')+' ✓'):'CMP linked ✓'; }catch{ return 'CMP linked ✓'; } })():'';
  const ov=document.createElement('div');
  ov.className='modal-overlay'; ov.style.cssText='z-index:5000';
  ov.innerHTML=`<div class="modal-box" style="max-width:440px;width:92%;max-height:84dvh;overflow-y:auto">
    <div class="modal-title" style="margin-bottom:2px">🛢 ${spLabel(r)} — ${_spEsc(r.substance||'Spill')}${r.quantity?' · '+_spEsc(r.quantity):''}</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px">${_spEsc(_spPretty(r.discoveryDate||r.releaseDate))}${r.discoveryTime?' '+_spEsc(r.discoveryTime):''} · ${r.status==='closed'?'✓ closed':'<span style="color:var(--amber)">● open</span>'} · ${r.reportable==='y'?'<span style="color:var(--amber)">reportable</span>':(r.reportable==='n'?'not reportable':'reportability not set')}${r.spillNo?' · #'+_spEsc(r.spillNo):''}${cmpTxt?' · '+cmpTxt:''}${r.published?(mine?' · <span style="color:var(--amber)">📤 shared with the project</span>':' · 👥 shared by '+_spEsc(_spOwnerName(r))):''}</div>
    ${row('Location',r.locationDesc+(hasLoc?'\n📍 '+(+r.lat).toFixed(5)+', '+(+r.lng).toFixed(5):''))}
    ${row('Cause',r.cause)}
    ${row('Responsible person',[r.respName,r.respPhone].filter(Boolean).join(' · '))}
    ${row('Water / wetland / sensitive area',r.waterReached==='y'?'YES — '+[r.waterBody,r.dischargePoint].filter(Boolean).join(' · '):(r.waterReached==='potential'?'Potential pathway — '+[r.waterBody,r.dischargePoint].filter(Boolean).join(' · '):'No — contained on land'))}
    ${row('Contain / clean up',[r.caContain,r.caCleanup].filter(Boolean).join('\n'))}
    ${row('Disposal',[r.caRemove,r.caDisposal].filter(Boolean).join('\n'))}
    <div style="font-size:12px;line-height:1.45;margin:4px 0 8px;padding:6px 8px;border-radius:6px;background:var(--s1);color:${ex.ok?'var(--text)':'var(--amber)'}">${_spEsc(ex.text)}</div>
    ${(r.notifications||[]).length?`<div style="font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.04em;margin-bottom:3px">NOTIFICATIONS</div>${(r.notifications||[]).map(n=>`<div style="font-size:12px;line-height:1.4;margin-bottom:2px">${_spEsc(n.time||'')} · <b>${_spEsc(n.who||'')}</b>${n.by?' by '+_spEsc(n.by):''}${n.method?' ('+_spEsc(n.method)+')':''}${n.note?' — '+_spEsc(n.note):''}</div>`).join('')}<div style="height:8px"></div>`:''}
    ${row('Notes',r.notes)}
    ${(r.photoIds||[]).length?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px">${(r.photoIds||[]).map(pid2=>{ const p=_spPhoto(pid2); return p&&p.thumb?`<img src="${_spEsc(p.thumb)}" onclick="phOpenLightbox&&phOpenLightbox('${_spEsc(p.id)}')" style="width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:pointer">`:''; }).join('')}</div>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${mine?`<button class="btn btn-outline" style="flex:1;min-width:120px" onclick="this.closest('.modal-overlay').remove();spShowForm('${_spEsc(r.id)}')">✏️ Edit</button>`:''}
      <button class="btn btn-outline" style="flex:1;min-width:120px" onclick="spExportPdf('${_spEsc(r.id)}')">${window.glPdfIcon?window.glPdfIcon(12):'PDF'} Report</button>
      ${!mine?'':(r.cmpId?`<button class="btn btn-outline" style="flex:1;min-width:120px" onclick="this.closest('.modal-overlay').remove();showPage('compliance')">📋 ${_spEsc(cmpTxt||'CMP')}</button>`
               :`<button class="btn btn-outline" style="flex:1;min-width:120px" onclick="spLogAsCmp('${_spEsc(r.id)}',this)">📋 Log as CMP</button>`)}
      ${hasLoc?`<button class="btn btn-outline" style="flex:1;min-width:120px" onclick="this.closest('.modal-overlay').remove();spShowOnMap('${_spEsc(r.id)}')">🗺 Show on map</button>`:''}
      ${mine?`<button class="btn btn-outline" style="flex:1;min-width:120px" title="${r.published?'Remove from the project — your copy stays':'Share with the project team'}" onclick="spTogglePublish('${_spEsc(r.id)}')">${r.published?'🔒 Unpublish':'📤 Publish'}</button>`:''}
      <button class="btn btn-amber" style="flex:1;min-width:120px" onclick="this.closest('.modal-overlay').remove()">Close</button>
    </div>
  </div>`;
  ov.addEventListener('click',e=>{ if(e.target===ov) ov.remove(); });
  document.body.appendChild(ov);
}
function spShowOnMap(id){
  const r=spGet(id); if(!r||typeof r.lat!=='number') return;
  if(typeof showPage==='function') showPage('map');
  setTimeout(()=>{
    try{
      const pid=_spPid();
      try{ localStorage.setItem('gl_spills_vis::'+pid,'1'); }catch{}
      if(typeof window.mapRenderSpillMarkers==='function') window.mapRenderSpillMarkers();
      const m=(typeof window.getMapInstance==='function')?window.getMapInstance():null;
      if(m) m.flyTo({center:[r.lng,r.lat],zoom:Math.max(m.getZoom(),17),essential:true});
    }catch(e){}
  },400);
}

// ═══ Log as CMP — file the spill as a compliance-log entry (rides daily report + punchlist) ═══
function spLogAsCmp(id, btn){
  const r=spGet(id); if(!r) return;
  if(r.cmpId){ if(typeof showPage==='function') showPage('compliance'); return; }
  if(typeof window.clAddEntry!=='function'){ if(typeof showCloudBanner==='function') showCloudBanner('Compliance log not loaded yet — try again in a moment.'); return; }
  const what=[r.substance||'Release', r.quantity?'('+r.quantity+')':''].filter(Boolean).join(' ');
  const corrective=[r.caContain, r.caCleanup].filter(Boolean).join(' ')||'Contain, clean up and document per the SPCC plan.';
  const cmpId=window.clAddEntry({
    date:r.discoveryDate||r.releaseDate||_spToday(),
    level:2,
    location:spLabel(r)+' spill'+(r.locationDesc?' — '+r.locationDesc:''),
    corrective:what+': '+corrective+(r.reportable==='y'?' Reported to the agency'+(r.spillNo?' (spill #'+r.spillNo+')':'')+'.':''),
    photoIds:r.photoIds||[]
  }, 'spill');
  if(!cmpId) return;
  r.cmpId=cmpId; r.updatedAt=Date.now();
  _spPersist(r);
  if(btn){ btn.textContent='📋 CMP ✓'; btn.disabled=true; }
  if(typeof showCloudBanner==='function') showCloudBanner('📋 '+spLabel(r)+' filed in the compliance log — it now rides the daily report and punchlist.');
  document.querySelector('.modal-overlay')?.remove();
  spShowDetail(r.id);
}

// ═══ Compliance page card — always shown (speed at the spill: ＋ is one tap) ═══
function spRenderComplianceCard(){
  const host=document.getElementById('cl-spill-card');
  if(!host) return;
  const pid=_spPid();
  spLoad(pid);
  const all=spAll(pid);
  const open=all.filter(r=>r.status!=='closed').length;
  const rows=all.slice(0,5).map(r=>`
    <div onclick="spShowDetail('${_spEsc(r.id)}')" style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid var(--border);cursor:pointer">
      <span style="font-family:var(--mono);font-size:11px;color:var(--amber);flex-shrink:0;font-weight:700">${spLabel(r)}</span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted);flex-shrink:0">${_spEsc((r.discoveryDate||r.releaseDate||'').slice(5))}</span>
      <span style="font-family:var(--mono);font-size:12px;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_spEsc(r.substance||'Spill')}${r.quantity?' · '+_spEsc(r.quantity):''}${r.locationDesc?' · '+_spEsc(r.locationDesc):''}</span>
      ${r.reportable==='y'?'<span title="Reportable" style="font-size:11px;flex-shrink:0">☎</span>':''}
      ${r.cmpId?'<span title="In the compliance log" style="font-size:11px;flex-shrink:0">📋</span>':''}
      ${_spWhoChip(r)}
      <span style="font-family:var(--mono);font-size:10px;flex-shrink:0;color:${r.status==='closed'?'var(--muted)':'var(--amber)'}">${r.status==='closed'?'closed':'open'}</span>
    </div>`).join('');
  const collapsed=(typeof window._clCardCollapsed==='function')&&window._clCardCollapsed('spill');
  host.innerHTML=`<div class="card${collapsed?' collapsed':''}">
    <div class="card-head" onclick="clToggleCard('spill')">
      <span class="card-num">🛢</span>
      <span class="card-title">Spills</span>
      <span class="head-fade"></span>
      ${_spCanCreate()?`<button class="btn btn-amber" style="font-size:11px;padding:5px 10px;margin-right:6px" onclick="event.stopPropagation();spShowForm()">＋ New</button>`:''}
      <span class="card-badge"${open?' style="color:var(--amber)"':''}>${open?open+' open':(all.length||'0')}</span>
      <span class="card-chevron">▾</span>
    </div>
    <div class="card-body" style="padding-top:4px">${rows||'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:8px 6px 4px;line-height:1.5">No spills recorded. Tap ＋ New the moment one happens — the form works offline and holds the notification clock.</div>'}
      <div onclick="showPage('reports')" style="font-family:var(--mono);font-size:10px;color:var(--amber);padding:9px 6px 2px;cursor:pointer">Manage &amp; export on the Reports page ›${all.length>5?` (+ ${all.length-5} more)`:''}</div>
    </div>
  </div>`;
}

// ═══ Reports page section ═══
function spRenderReportsSec(){
  const host=document.getElementById('sp-reports-sec');
  if(!host) return;
  const pid=_spPid();
  spLoad(pid);
  const all=spAll(pid);
  const rows=all.map(r=>`
    <div class="sw-list-row">
      <div class="sw-list-main" onclick="spShowDetail('${_spEsc(r.id)}')">
        <span class="sw-list-date">${_spEsc(r.discoveryDate||r.releaseDate||'')}</span>
        <span class="sw-list-type">${spLabel(r)} · ${_spEsc(r.substance||'Spill')}${r.quantity?' · '+_spEsc(r.quantity):''}</span>
        <span class="sw-chip ${r.status==='closed'?'sw-chip-done':'sw-chip-draft'}">${r.status==='closed'?'✓ Closed':'● Open'}</span>${_spIsMine(r)?'':`<span class="sw-chip" title="Shared by ${_spEsc(_spOwnerName(r))}">👥 ${_spEsc(_spFirstName(r))}</span>`}
      </div>
      ${_spIsMine(r)?`<button class="sw-list-btn" title="Edit" onclick="spShowForm('${_spEsc(r.id)}')">✏️</button>
      <button class="sw-list-btn" title="${r.published?'Shared with the project — tap to unpublish':'Publish to project'}" onclick="spTogglePublish('${_spEsc(r.id)}')">${r.published?'👥':'📤'}</button>`:''}
      <button class="sw-list-btn" title="Export incident report PDF" onclick="spExportPdf('${_spEsc(r.id)}')">${window.glPdfIcon?window.glPdfIcon(12):'PDF'}</button>
      ${_spIsMine(r)?`<button class="sw-list-btn" title="Delete" onclick="spDelete('${_spEsc(r.id)}')">🗑</button>`:''}
    </div>`).join('');
  const head=(typeof window._swSecHead==='function')
    ? window._swSecHead('sp','Spills / Incidents','Owner incident-report form per spill (PDF) + the running spill log — records stay on the map and in the compliance log',(_spCanCreate()?'<button class="btn" onclick="spShowForm()">＋ New Spill</button>':''))
    : `<div class="sw-sec-label sw-sec-next">Spills / Incidents<span class="sw-sec-line"></span>${_spCanCreate()?'<button class="btn" onclick="spShowForm()">＋ New Spill</button>':''}</div>`;
  const collapsed=(typeof window.swSecCollapsed==='function')&&window.swSecCollapsed('sp');
  host.innerHTML=`
    ${head}
    <div id="sw-sec-body-sp" style="display:${collapsed?'none':''}">
      ${rows || '<p style="color:var(--muted);font-size:12px;padding:10px 2px">No spills recorded — hopefully it stays that way. ＋ New Spill the moment one happens.</p>'}
      ${all.length?`<div style="margin-top:10px;text-align:right"><button class="btn btn-outline" onclick="spExportLogPdf()">⬇ Spill Log (PDF)</button></div>`:''}
    </div>`;
}

// ═══ PDF exports ═══
async function _spBrandLogo(pid){
  try{ if(typeof window.glBrandLogo==='function') return await window.glBrandLogo(pid,'spill'); }catch(e){}
  return null;
}
async function spExportPdf(id){
  const pid=_spPid();
  const r=spGet(id,pid); if(!r) return;
  if(_spIsMine(r)){
    if(!(await _spMaybeFormalizeForExport(r))) return;
    if(!(await _spMaybeOfferPublish(r))) return;
  }
  const btns=document.querySelectorAll(`[onclick="spExportPdf('${id}')"]`);
  btns.forEach(b=>{ b.dataset.oldTxt=b.innerHTML; b.textContent='…'; b.disabled=true; });
  try{
    const cfg=_spCfg();
    const logo=await _spBrandLogo(pid);
    const {spBuildPdf}=await import('./swpppPdf.js');
    const blob=await spBuildPdf(r,{projectName:cfg.projectName||'Project',siteAddress:cfg.siteAddress||'',preparedBy:r.preparedBy||cfg.preparedBy||'',org:r.org||cfg.org||''},{logo});
    const slug=(cfg.projectName||'Project').replace(/[^\w]+/g,'_');
    const [y,m,d]=String(r.discoveryDate||r.releaseDate||_spToday()).split('-');
    const fname=`${slug}-Spill_Report_${spLabel(r)}_${parseInt(m)}-${parseInt(d)}-${String(y).slice(2)}.pdf`;
    const {saveFileNative}=await import('./saveFile.js');
    await saveFileNative(blob,fname,'application/pdf');
  }catch(e){ console.error('spill export failed:',e); alert('Export failed: '+e.message); }
  finally{ btns.forEach(b=>{ b.innerHTML=b.dataset.oldTxt||'PDF'; b.disabled=false; }); }
}
async function spExportLogPdf(){
  const pid=_spPid();
  const all=spAll(pid); if(!all.length) return;
  try{
    const cfg=_spCfg();
    const logo=await _spBrandLogo(pid);
    const {spBuildLogPdf}=await import('./swpppPdf.js');
    const blob=await spBuildLogPdf(all.slice().reverse(),{projectName:cfg.projectName||'Project',preparedBy:cfg.preparedBy||''},{logo});
    const slug=(cfg.projectName||'Project').replace(/[^\w]+/g,'_');
    const t=new Date();
    const fname=`${slug}-Spill_Log_${t.getMonth()+1}-${t.getDate()}-${String(t.getFullYear()).slice(2)}.pdf`;
    const {saveFileNative}=await import('./saveFile.js');
    await saveFileNative(blob,fname,'application/pdf');
  }catch(e){ console.error('spill log export failed:',e); alert('Export failed: '+e.message); }
}

// ── window exports (cross-module + inline handlers) ──
window.spLoad=spLoad;
window.spAll=spAll;
window.spGet=spGet;
window.spLabel=spLabel;
window.spShowForm=spShowForm;
window.spShowDetail=spShowDetail;
window.spDelete=spDelete;
window.spExportPdf=spExportPdf;
window.spExportLogPdf=spExportLogPdf;
window.spRenderComplianceCard=spRenderComplianceCard;
window.spRenderReportsSec=spRenderReportsSec;
window.spAttachPhoto=spAttachPhoto;
window.spFormCamera=spFormCamera;
window.spFormPickPhotos=spFormPickPhotos;
window.spFormRemovePhoto=spFormRemovePhoto;
window.spLocHere=spLocHere;
window.spLocPickOnMap=spLocPickOnMap;
window.spLocFromPhoto=spLocFromPhoto;
window.spLocClear=spLocClear;
window.spWeatherFill=spWeatherFill;
window.spNotifAdd=spNotifAdd;
window.spNotifRemove=spNotifRemove;
window.spLogAsCmp=spLogAsCmp;
window.spShowOnMap=spShowOnMap;
window.spTogglePublish=spTogglePublish;
window.spLoadShared=spLoadShared;
window.spIsMine=_spIsMine;
