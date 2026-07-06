// ═══════════════════════════════════════════
// SWPPP QI INSPECTION — Reports page (in-app form + DOCX export)
// ═══════════════════════════════════════════
//
// First resident of the Reports page and the pilot of the dynamic-forms
// architecture: a schema-lite renderer driven by per-project config, so the
// app code stays project-agnostic (no Moraine data baked in).
//
//   config:      projects/{pid}/config/swpppQiForm      (member-read / lead-write — existing rules)
//   inspections: projects/{pid}/swpppInspections/{id}   (work product: ownerUid-stamped, publish-gated)
//
// Local-first: every change writes to an IndexedDB mirror immediately
// (field-offline safe) with a debounced cloud sync — same posture as the
// tracker. Completed inspections lock read-only; reopening requires an
// explicit confirm (the record may already have been submitted).
//
// Auto-feeds: Disturbed Area Summary from the disturbance tracker
// (window._runningTotals), weather from the daily-log fields, §10 sketches
// from map captures, §11 photos from SWPPP-tagged project photos.

// ── State ──
var _swCfg = {};        // pid → config object (or null when checked-and-missing)
var _swInsp = {};       // pid → array of inspection docs
var _swOpenId = null;   // inspection id currently open in the form
var _swSaveTimer = null;
var _swCloudTimer = null;

function _swPid(){ return (typeof _activeProjectId==='function') ? _activeProjectId() : 'default'; }
function _swUid(){ return (typeof _currentUser!=='undefined' && _currentUser) ? _currentUser.uid : null; }
function _swProj(pid){ return db.collection('projects').doc(pid); }

// ── Persistence ──
async function _swLoadAll(pid){
  // IDB first (instant, offline), then cloud merge (newer updatedAt wins).
  if(!_swInsp[pid]){
    try{ _swInsp[pid] = (await idbGet('sw_insp::'+pid)) || []; }catch(e){ _swInsp[pid] = []; }
  }
  if(_swCfg[pid]===undefined){
    try{ _swCfg[pid] = (await idbGet('sw_cfg::'+pid)) || null; }catch(e){ _swCfg[pid] = null; }
  }
  if(!(db && _fbReady)) return;
  try{
    const cfgSnap = await _swProj(pid).collection('config').doc('swpppQiForm').get();
    if(cfgSnap.exists){ _swCfg[pid] = cfgSnap.data(); idbSet('sw_cfg::'+pid, _swCfg[pid]); }
    const uid = _swUid();
    // Rules gate list queries: own docs + published docs are two separate legal queries.
    const [own, pub] = await Promise.all([
      _swProj(pid).collection('swpppInspections').where('ownerUid','==',uid).get(),
      _swProj(pid).collection('swpppInspections').where('published','==',true).get().catch(()=>({docs:[]}))
    ]);
    const remote = {};
    own.docs.forEach(d=>{ remote[d.id]=d.data(); });
    (pub.docs||[]).forEach(d=>{ remote[d.id]=d.data(); });
    const local = _swInsp[pid];
    Object.values(remote).forEach(r=>{
      const i = local.findIndex(x=>x.id===r.id);
      if(i<0) local.push(r);
      else if((r.updatedAt||0) > (local[i].updatedAt||0)) local[i]=r;
    });
    idbSet('sw_insp::'+pid, local);
  }catch(e){ console.warn('swppp cloud load failed:', e.message); }
}

function _swGet(id){ const pid=_swPid(); return (_swInsp[pid]||[]).find(x=>x.id===id) || null; }

function _swQueueSave(insp){
  insp.updatedAt = Date.now();
  const pid = _swPid();
  clearTimeout(_swSaveTimer);
  _swSaveTimer = setTimeout(()=>{ idbSet('sw_insp::'+pid, _swInsp[pid]||[]); }, 400);
  clearTimeout(_swCloudTimer);
  _swCloudTimer = setTimeout(()=>{ _swSaveCloud(insp.id, pid); }, 2500);
}
async function _swSaveCloud(id, pid){
  if(!(db && _fbReady)) return;
  const insp = (_swInsp[pid]||[]).find(x=>x.id===id);
  if(!insp) return;
  try{ await _swProj(pid).collection('swpppInspections').doc(id).set(insp, {merge:true}); }
  catch(e){ console.warn('swppp cloud save failed (kept locally):', e.message); }
}

// ── Config setup (paste-JSON, one time per project) ──
function swpppShowSetup(){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-box" style="max-width:520px">
    <h3 style="margin:0 0 8px">Set up QI Inspection Report</h3>
    <p style="font-size:12px;color:var(--muted);margin:0 0 10px">Paste the project's QI form configuration JSON (drainage areas, discharge points, BMPs, header info). It saves to the shared project config — this is a one-time step.</p>
    <textarea id="sw-setup-json" style="width:100%;min-height:180px;box-sizing:border-box;font-family:var(--mono);font-size:10px" placeholder='{"formType":"swppp-qi-inspection", ...}'></textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn" onclick="swpppSaveSetup()">Save configuration</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
async function swpppSaveSetup(){
  const ta = document.getElementById('sw-setup-json');
  let cfg;
  try{ cfg = JSON.parse(ta.value); }
  catch(e){ ta.style.borderColor='#e74c3c'; return; }
  if(cfg.formType !== 'swppp-qi-inspection'){ ta.style.borderColor='#e74c3c'; return; }
  const pid = _swPid();
  _swCfg[pid] = cfg;
  idbSet('sw_cfg::'+pid, cfg);
  try{ if(db && _fbReady) await _swProj(pid).collection('config').doc('swpppQiForm').set(cfg); }
  catch(e){ console.warn('swppp config cloud save failed (kept locally):', e.message); }
  document.querySelector('.modal-overlay')?.remove();
  glRenderReportsPage();
}

// ── Auto-feeds ──
// Disturbed Area Summary from the disturbance tracker (running-balance/-total category).
function _swComputeDaSummary(pid){
  try{
    const cats = (typeof tcGetCategories==='function') ? tcGetCategories(pid) : [];
    const cat = cats.find(c=>{
      const m = (typeof tcProgressMode==='function') ? tcProgressMode(c, pid) : '';
      return m==='running-balance' || m==='running-total';
    });
    if(!cat || typeof window._runningTotals!=='function') return null;
    const mode = tcProgressMode(cat, pid);
    const childStates = ((typeof tcGetStates==='function') ? tcGetStates(cat, pid) : []).filter(s=>!s.isPlanned);
    if(!childStates.length) return null;
    const unit = (typeof tcGetDefaultUnit==='function') ? (tcGetDefaultUnit(cat.id, pid)||'ac') : 'ac';
    const inst = ((typeof trGetEntriesForProject==='function') ? trGetEntriesForProject(pid) : [])
      .filter(e=>e.categoryId===cat.id && e.entryType!=='planned' && !e.temporary && !e.deletedAt);
    const rt = window._runningTotals(cat.id, inst, childStates, unit, pid, mode);
    const buckets = { active:0, inactive:0, tempStab:0, finalStab:0 };
    childStates.forEach(s=>{
      const v = rt.perState[s.id]||0;
      const L = (s.label||'').toLowerCase();
      if(/inactive/.test(L)) buckets.inactive += v;
      else if(/active|disturb/.test(L) && !/stab|closeout/.test(L)) buckets.active += v;
      else if(/temp/.test(L)) buckets.tempStab += v;
      else buckets.finalStab += v;   // final / permanent / closeout
    });
    const r2 = (v)=>Math.round(v*100)/100;
    return {
      active:r2(buckets.active), inactive:r2(buckets.inactive),
      tempStab:r2(buckets.tempStab), finalStab:r2(buckets.finalStab),
      totalOpen:r2(rt.open),
      over5: rt.open>5 ? 'yes' : 'no',
      enhanced: 'yes',
      snapshotAt: Date.now(), source:'tracker', unit
    };
  }catch(e){ console.warn('swppp DA summary compute failed:', e.message); return null; }
}
// Weather prefill from the daily-log fields (best-effort; all editable after).
function _swPrefillWeather(){
  const g = (id)=>{ const el=document.getElementById(id); return el ? (el.value||'').trim() : ''; };
  const sky = Array.from(document.querySelectorAll('input[name="sky"]:checked')).map(c=>c.value).join(', ');
  const tAM=g('tempAM'), tPM=g('tempPM');
  return {
    sky: sky,
    temp: (tAM||tPM) ? `${tAM||'—'}°F / ${tPM||'—'}°F` : '',
    precip: g('precip'), wind: g('wind'), soil: g('soilCond'),
    access: '', general: ''
  };
}

// ── Inspection lifecycle ──
function swpppNewInspection(){
  const pid = _swPid();
  const cfg = _swCfg[pid];
  if(!cfg) return;
  const today = new Date().toLocaleDateString('en-CA');
  const prev = (_swInsp[pid]||[]).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''))[0] || null;
  const insp = {
    id: 'qi_'+today+'_'+Date.now().toString(36),
    date: today,
    createdAt: Date.now(), updatedAt: Date.now(),
    status: 'draft',
    ownerUid: _swUid(), published: false,
    inspType: 'routine', inspTypeOther: '', stormDateTime: '',
    weather: _swPrefillWeather(),
    daSummary: _swComputeDaSummary(pid) || { active:'', inactive:'', tempStab:'', finalStab:'', totalOpen:'', over5:'', enhanced:'yes', source:'manual' },
    // Carry-forward: conditions rarely change wholesale between inspections —
    // start from the previous record, change what changed.
    drainageAreas: prev ? JSON.parse(JSON.stringify(prev.drainageAreas||{})) : {},
    daBulkNote: prev ? (prev.daBulkNote||'') : '',
    dischargePoints: prev ? JSON.parse(JSON.stringify(prev.dischargePoints||{})) : {},
    waterbodyNotes: '',
    escVerified: '',
    bmps: prev ? JSON.parse(JSON.stringify(prev.bmps||{})) : {},
    pollution: prev ? JSON.parse(JSON.stringify(prev.pollution||{})) : {},
    smps: prev ? JSON.parse(JSON.stringify(prev.smps||{})) : {},
    corrective: [],
    notes: '',
    sketches: [], sketchMeta: {},
    photos: [], photoMeta: {},
    cert: { signedName: cfg.certification ? (cfg.certification.qiName||'') : '', signedDate: '' }
  };
  if(!_swInsp[pid]) _swInsp[pid]=[];
  _swInsp[pid].push(insp);
  _swQueueSave(insp);
  swpppOpenInspection(insp.id);
}

function swpppOpenInspection(id){
  _swOpenId = id;
  showPage('swpppForm');
  _swRenderForm();
}

function swpppRefreshDaSummary(){
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  const fresh = _swComputeDaSummary(_swPid());
  if(fresh){ insp.daSummary = fresh; _swQueueSave(insp); _swRenderSection('sw-sec-das'); }
}

function swpppComplete(){
  const insp = _swGet(_swOpenId); if(!insp) return;
  _confirmModal('Mark this inspection as Completed? It will lock as a record — reopening for edits will require confirmation.', ()=>{
    insp.status='completed'; insp.completedAt=Date.now();
    if(!insp.cert.signedDate){
      const d=new Date(); insp.cert.signedDate = `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
    }
    _swQueueSave(insp); _swSaveCloud(insp.id,_swPid());
    _swRenderForm();
  }, 'Complete Inspection', 'Complete');
}
function swpppReopen(){
  const insp = _swGet(_swOpenId); if(!insp) return;
  _confirmModal('This inspection is COMPLETED and may already have been submitted or distributed. Reopen it for editing anyway?', ()=>{
    insp.status='draft'; _swQueueSave(insp); _swRenderForm();
  }, 'Reopen Completed Inspection', 'Reopen');
}

// ── Model write helpers (called from rendered inputs) ──
function swSet(){
  const args = Array.from(arguments);
  const value = args.pop();
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  let o = insp;
  for(let i=0;i<args.length-1;i++){
    const k=args[i];
    if(typeof o[k]!=='object' || o[k]===null) o[k]={};
    o=o[k];
  }
  o[args[args.length-1]] = value;
  // Manual edits to Active/Inactive keep TOTAL OPEN truthful (it's what the
  // export prints against the authorization cap).
  if(args[0]==='daSummary' && (args[args.length-1]==='active' || args[args.length-1]==='inactive')){
    const s=insp.daSummary||{};
    const a=parseFloat(s.active), b=parseFloat(s.inactive);
    if(!isNaN(a)||!isNaN(b)) s.totalOpen=Math.round(((isNaN(a)?0:a)+(isNaN(b)?0:b))*100)/100;
    s.over5=(s.totalOpen>5)?'yes':(s.totalOpen===''?s.over5:'no');
  }
  _swQueueSave(insp);
}
function swInp(ev){
  const keys = Array.from(arguments).slice(1);
  swSet.apply(null, keys.concat([ev.target.value]));
}
// Segmented chip: set value (tap same value again to clear) and re-render the group.
function swSeg(groupId, value){
  const keys = Array.from(arguments).slice(2);
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  let o = insp;
  for(let i=0;i<keys.length-1;i++){ const k=keys[i]; if(typeof o[k]!=='object'||o[k]===null) o[k]={}; o=o[k]; }
  const leaf = keys[keys.length-1];
  o[leaf] = (o[leaf]===value) ? '' : value;
  _swQueueSave(insp);
  // DA condition toggles change row structure (deficient reveals the action
  // input + row tint) — re-render the whole section, not just the segment.
  if(keys[0]==='drainageAreas'){ _swRenderSection('sw-sec-da2'); return; }
  const el = document.getElementById(groupId);
  if(el) el.outerHTML = _swSegHtml(groupId, o[leaf], _swSegOpts[groupId]||[], keys);
}
// Registry of segment options per group id so re-renders know their choices.
var _swSegOpts = {};
function _swSegHtml(groupId, current, opts, keys){
  _swSegOpts[groupId] = opts;
  const ro = _swReadOnly() ? ' sw-ro' : '';
  const keyArgs = keys.map(k=>`'${String(k).replace(/'/g,"\\'")}'`).join(',');
  const btns = opts.map(o=>{
    const on = current===o.v;
    return `<button type="button" class="sw-seg-btn${on?' on':''}${o.cls?' '+o.cls:''}" onclick="swSeg('${groupId}','${o.v}',${keyArgs})">${o.l}</button>`;
  }).join('');
  return `<span class="sw-seg${ro}" id="${groupId}">${btns}</span>`;
}
function _swReadOnly(){ const i=_swGet(_swOpenId); return !!(i && i.status==='completed'); }

// ── Bulk DA actions ──
function swpppDaAll(cond){
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  const cfg = _swCfg[_swPid()]; if(!cfg) return;
  (cfg.drainageAreas||[]).forEach(da=>{
    if(!insp.drainageAreas[da.id]) insp.drainageAreas[da.id]={condition:'',action:''};
    insp.drainageAreas[da.id].condition = cond;
  });
  _swQueueSave(insp);
  _swRenderSection('sw-sec-da2');
}

// ── Corrective actions rows ──
function swpppAddCorrective(){
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  insp.corrective.push({dateId:insp.date, location:'', desc:'', action:''});
  _swQueueSave(insp); _swRenderSection('sw-sec-ca');
}
function swpppRemoveCorrective(i){
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  insp.corrective.splice(i,1);
  _swQueueSave(insp); _swRenderSection('sw-sec-ca');
}
function swCaInp(ev, i, field){
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  if(insp.corrective[i]){ insp.corrective[i][field]=ev.target.value; _swQueueSave(insp); }
}

// ── Photo / sketch pickers ──
function swpppPickPhotos(kind){   // kind: 'sketches' | 'photos'
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  const pid = _swPid();
  let pool = (window._phPhotos||[]).filter(p=>!p.deletedAt && (!p.projectId || p.projectId===pid));
  if(kind==='sketches') pool = pool.filter(p=>p.type==='map_capture');
  else pool = pool.filter(p=>p.type!=='map_capture');
  // SWPPP-tagged first, then newest first.
  pool.sort((a,b)=> (b.swppp?1:0)-(a.swppp?1:0) || (b.uploadedAt||0)-(a.uploadedAt||0));
  pool = pool.slice(0,120);
  const sel = new Set(insp[kind]||[]);
  const ov = document.createElement('div');
  ov.className='modal-overlay';
  const cells = pool.map(p=>{
    const on = sel.has(p.id);
    return `<div class="sw-pick${on?' on':''}" data-id="${p.id}" onclick="this.classList.toggle('on')">
      <img src="${p.thumb||''}" loading="lazy">
      ${p.swppp?'<span class="sw-pick-tag">SWPPP</span>':''}
      <span class="sw-pick-date">${p.date||''}</span>
    </div>`;
  }).join('');
  ov.innerHTML = `<div class="modal-box" style="max-width:560px">
    <h3 style="margin:0 0 4px">${kind==='sketches'?'Select disturbance-map captures':'Select inspection photos'}</h3>
    <p style="font-size:11px;color:var(--muted);margin:0 0 10px">${kind==='sketches'?'Map captures with the legend baked in — Tracker → category → Capture.':'SWPPP-tagged photos sort first. Tap to select.'}</p>
    <div class="sw-pick-grid" id="sw-pick-grid">${cells || '<p style="color:var(--muted);font-size:12px">Nothing available yet.</p>'}</div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn" onclick="swpppPickDone('${kind}')">Use selected</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
function swpppPickDone(kind){
  const insp = _swGet(_swOpenId); if(!insp) return;
  const ids = Array.from(document.querySelectorAll('#sw-pick-grid .sw-pick.on')).map(el=>el.dataset.id);
  insp[kind] = ids;
  const metaKey = kind==='sketches' ? 'sketchMeta' : 'photoMeta';
  ids.forEach(id=>{
    if(!insp[metaKey][id]){
      const p=(window._phPhotos||[]).find(x=>x.id===id)||{};
      insp[metaKey][id] = kind==='sketches'
        ? {area:'', desc:p.caption||'', date:p.date||insp.date}
        : {subject:p.caption||'', loc:''};
    }
  });
  Object.keys(insp[metaKey]).forEach(id=>{ if(!ids.includes(id)) delete insp[metaKey][id]; });
  _swQueueSave(insp);
  document.querySelector('.modal-overlay')?.remove();
  _swRenderSection(kind==='sketches'?'sw-sec-sk':'sw-sec-ph');
}
function swMetaInp(ev, metaKey, id, field){
  const insp = _swGet(_swOpenId); if(!insp || insp.status==='completed') return;
  if(!insp[metaKey][id]) insp[metaKey][id]={};
  insp[metaKey][id][field]=ev.target.value;
  _swQueueSave(insp);
}

// ═══════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════
function glRenderReportsPage(){
  const pid = _swPid();
  const host = document.getElementById('reports-page-body');
  if(!host) return;
  _swLoadAll(pid).then(()=>{ _swRenderReportsInner(host, pid); });
  _swRenderReportsInner(host, pid);   // instant paint from cache; reload repaints
}
function _swRenderReportsInner(host, pid){
  const cfg = _swCfg[pid];
  if(cfg===undefined) { host.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:8px 0">Loading…</p>'; return; }
  if(!cfg){
    host.innerHTML = `
      <div class="gl-empty-state">
        <div class="gl-es-icon">🌊</div>
        <div class="gl-es-title">SWPPP QI Inspection Report</div>
        <div class="gl-es-body">Complete your SPDES Qualified-Inspector stormwater inspections in the field and export the finished report — no separate Word doc. One-time setup: paste this project's form configuration.</div>
        <div class="gl-es-actions">
          <button class="gl-es-btn gl-es-btn-primary" onclick="swpppShowSetup()">⚙ Set up QI report</button>
        </div>
      </div>`;
    return;
  }
  const list = (_swInsp[pid]||[]).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
  const rows = list.map(i=>{
    const chip = i.status==='completed'
      ? '<span class="sw-chip sw-chip-done">✓ Completed</span>'
      : '<span class="sw-chip sw-chip-draft">Draft</span>';
    const typeLbl = i.inspType==='post-storm' ? 'Post-Storm' : (i.inspType==='other' ? (i.inspTypeOther||'Other') : 'Routine');
    return `<div class="sw-list-row">
      <div class="sw-list-main" onclick="swpppOpenInspection('${i.id}')">
        <span class="sw-list-date">${i.date||''}</span>
        <span class="sw-list-type">${typeLbl}</span>
        ${chip}
      </div>
      <button class="sw-list-btn" title="Export DOCX" onclick="swpppExport('${i.id}')">⬇</button>
    </div>`;
  }).join('');
  host.innerHTML = `
    <div class="sw-head-row">
      <div>
        <div style="font-weight:700">SWPPP QI Inspections</div>
        <div style="font-size:11px;color:var(--muted)">SPDES GP-0-25-001 — Qualified Inspector stormwater inspection reports</div>
      </div>
      <button class="btn" onclick="swpppNewInspection()">＋ New Inspection</button>
    </div>
    ${rows || '<p style="color:var(--muted);font-size:12px;padding:10px 2px">No inspections yet — start your first one.</p>'}
    <div style="margin-top:10px;text-align:right"><button class="btn btn-outline" style="font-size:10px;padding:4px 10px" onclick="swpppShowSetup()">⚙ Edit configuration</button></div>`;
}

// Section re-render (keeps text-input focus intact elsewhere).
function _swRenderSection(secId){
  const el = document.getElementById(secId);
  if(!el) return;
  const html = _swSectionHtml[secId] ? _swSectionHtml[secId]() : null;
  if(html!==null) el.outerHTML = html;
}
var _swSectionHtml = {};

function _swRenderForm(){
  const wrap = document.getElementById('swppp-form-wrap');
  const insp = _swGet(_swOpenId);
  const cfg = _swCfg[_swPid()];
  if(!wrap || !insp || !cfg){ if(wrap) wrap.innerHTML='<p style="padding:20px;color:var(--muted)">Inspection not found.</p>'; return; }
  const ro = insp.status==='completed';
  const esc = (s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const dis = ro ? 'disabled' : '';
  const field = (label, inputHtml)=>`<div class="field"><label>${label}</label>${inputHtml}</div>`;
  const txt = (val, keys, ph)=>`<input type="text" value="${esc(val)}" placeholder="${ph||''}" ${dis} oninput="swInp(event,${keys.map(k=>`'${String(k).replace(/'/g,"\\'")}'`).join(',')})">`;
  const ta = (val, keys, ph)=>`<textarea class="auto-expand" rows="2" placeholder="${ph||''}" ${dis} oninput="swInp(event,${keys.map(k=>`'${String(k).replace(/'/g,"\\'")}'`).join(',')})">${esc(val)}</textarea>`;
  let segSeq = 0;
  const seg = (opts, current, keys)=>{ const gid='sw-g'+(segSeq++); return _swSegHtml(gid, current, opts, keys); };
  const YN = [{v:'y',l:'Y'},{v:'n',l:'N'}];
  const YNNA = [{v:'y',l:'Y'},{v:'n',l:'N'},{v:'na',l:'N/A'}];

  // ── header/status bar ──
  const statusBar = ro
    ? `<div class="sw-lockbar">🔒 Completed ${insp.completedAt?new Date(insp.completedAt).toLocaleDateString():''} — locked as a record <button class="btn btn-outline" style="margin-left:auto;font-size:11px" onclick="swpppReopen()">↩ Reopen</button></div>`
    : `<div class="sw-lockbar sw-lockbar-draft">✎ Draft — autosaves as you go <button class="btn" style="margin-left:auto;font-size:11px" onclick="swpppComplete()">✓ Complete</button></div>`;

  // ── §0 header ──
  _swSectionHtml['sw-sec-hdr'] = ()=>{
    const i=_swGet(_swOpenId);
    return `<div class="card" id="sw-sec-hdr"><div class="card-head" onclick="toggleSection('sw-sec-hdr')"><span class="card-num">📋</span><span class="card-title">Inspection Info</span><span class="card-chevron">▾</span></div><div class="card-body">
      <div class="g g2">
        ${field('Inspection Date', `<input type="date" value="${esc(i.date)}" ${dis} oninput="swInp(event,'date')">`)}
        ${field('Inspection Type', seg([{v:'routine',l:'Routine 2×/wk'},{v:'post-storm',l:'Post-Storm ≥0.5&quot;'},{v:'other',l:'Other'}], i.inspType, ['inspType']))}
      </div>
      <div class="g g2">
        ${field('Storm Date / Time (if post-storm)', txt(i.stormDateTime, ['stormDateTime'], 'e.g. 7/6 2:30 PM — 0.8 in'))}
        ${field('Other type (if Other)', txt(i.inspTypeOther, ['inspTypeOther']))}
      </div>
      <p class="sw-static-note">Inspector: <b>${esc(cfg.header.inspectorName)}</b> · ${esc(cfg.header.roleCredential)} · SWT# ${esc(cfg.header.swtNumber)} · ${esc(cfg.header.organization)}<br>
      ${esc(cfg.header.spdesPermit)} · SWPTS ${esc(cfg.header.swptsId)}</p>
    </div></div>`;
  };

  // ── DA summary ──
  _swSectionHtml['sw-sec-das'] = ()=>{
    const i=_swGet(_swOpenId); const s=i.daSummary||{};
    const num=(v,k)=>`<input type="number" step="0.01" inputmode="decimal" value="${esc(v)}" ${dis} oninput="swInp(event,'daSummary','${k}')">`;
    return `<div class="card" id="sw-sec-das"><div class="card-head" onclick="toggleSection('sw-sec-das')"><span class="card-num">⛰</span><span class="card-title">Disturbed Area Summary</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc((cfg.disturbedAreaSummary||{}).note||'')}</p>
      <div class="g g2">
        ${field('Active disturbed (ac)', num(s.active,'active'))}
        ${field('Inactive disturbed (ac)', num(s.inactive,'inactive'))}
        ${field('Temporary stabilization (ac)', num(s.tempStab,'tempStab'))}
        ${field('Final / permanent stabilization (ac)', num(s.finalStab,'finalStab'))}
      </div>
      <div class="sw-total-row">TOTAL OPEN (Active + Inactive): <b>${esc(s.totalOpen!==''?s.totalOpen:'—')} ac</b> <span style="color:var(--muted)">/ ${(cfg.disturbedAreaSummary||{}).capAcres||125} ac cap</span></div>
      <div class="g g2">
        ${field('Currently over 5 acres open?', seg(YN.map(o=>({v:o.v==='y'?'yes':'no',l:o.v==='y'?'Yes':'No'})), s.over5, ['daSummary','over5']))}
        ${field('Enhanced frequency in effect?', seg([{v:'yes',l:'Yes (2×/wk + post-storm)'},{v:'no',l:'No'}], s.enhanced, ['daSummary','enhanced']))}
      </div>
      ${ro?'':`<button class="btn btn-outline" style="font-size:11px" onclick="swpppRefreshDaSummary()">↻ Refresh from disturbance tracker</button>`}
      ${s.source==='tracker'?`<span class="sw-static-note" style="margin-left:8px">from tracker ${s.snapshotAt?new Date(s.snapshotAt).toLocaleString():''}</span>`:''}
    </div></div>`;
  };

  // ── §1 weather ──
  _swSectionHtml['sw-sec-wx'] = ()=>{
    const i=_swGet(_swOpenId); const w=i.weather||{};
    return `<div class="card" id="sw-sec-wx"><div class="card-head" onclick="toggleSection('sw-sec-wx')"><span class="card-num">1</span><span class="card-title">Weather &amp; Site Conditions</span><span class="card-chevron">▾</span></div><div class="card-body">
      <div class="g g2">
        ${field('Sky Conditions', txt(w.sky,['weather','sky']))}
        ${field('Temperature (AM/PM)', txt(w.temp,['weather','temp'],'e.g. 58°F / 74°F'))}
        ${field('Precipitation', txt(w.precip,['weather','precip'],'e.g. 0.3 in last 24 hr'))}
        ${field('Wind', txt(w.wind,['weather','wind']))}
        ${field('Soil Conditions', txt(w.soil,['weather','soil']))}
        ${field('Site Access', txt(w.access,['weather','access']))}
      </div>
      ${field('General Site Conditions', ta(w.general,['weather','general']))}
    </div></div>`;
  };

  // ── §2 drainage areas ──
  _swSectionHtml['sw-sec-da2'] = ()=>{
    const i=_swGet(_swOpenId);
    let s2=0;
    const rows=(cfg.drainageAreas||[]).map(da=>{
      const st=i.drainageAreas[da.id]||{condition:'',action:''};
      const gid='sw-da'+(s2++);
      const showAction = st.condition==='deficient';
      return `<div class="sw-da-row${st.condition==='deficient'?' sw-da-def':''}">
        <div class="sw-da-id">${esc(da.id)}</div>
        <div class="sw-da-desc">${esc(da.desc)}</div>
        <div>${_swSegHtml(gid, st.condition, [{v:'acceptable',l:'✓ Acceptable'},{v:'deficient',l:'⚠ Deficient',cls:'sw-warn'}], ['drainageAreas', da.id, 'condition'])}</div>
        ${showAction?`<input type="text" class="sw-da-action" placeholder="Action required…" value="${esc(st.action||'')}" ${dis} oninput="swInp(event,'drainageAreas','${esc(da.id)}','action')">`:''}
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-da2"><div class="card-head" onclick="toggleSection('sw-sec-da2')"><span class="card-num">2</span><span class="card-title">Drainage Areas Inspected</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.drainageAreasNote||'')}</p>
      ${ro?'':`<div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="btn btn-outline" style="font-size:11px" onclick="swpppDaAll('acceptable')">✓ Mark all Acceptable</button>
        <button class="btn btn-outline" style="font-size:11px" onclick="swpppDaAll('')">Clear all</button>
      </div>`}
      ${field('Grouped note (inactive / undisturbed DAs)', ta(i.daBulkNote,['daBulkNote'],'e.g. All DAs without active grading — no ESC controls installed, no disturbance; inspected representative areas.'))}
      ${rows}
    </div></div>`;
  };

  // ── §3 discharge points ──
  _swSectionHtml['sw-sec-dp'] = ()=>{
    const i=_swGet(_swOpenId);
    const rows=(cfg.dischargePoints||[]).map(dp=>{
      const st=i.dischargePoints[dp.id]||{notes:''};
      return `<div class="sw-dp-row">
        <div class="sw-da-id">${esc(dp.id)}</div>
        <div class="sw-da-desc">${esc(dp.location)}<br><span style="color:var(--muted)">→ ${esc(dp.receiving)}</span></div>
        <input type="text" placeholder="Condition / notes…" value="${esc(st.notes||'')}" ${dis} oninput="swInp(event,'dischargePoints','${esc(dp.id)}','notes')">
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-dp"><div class="card-head" onclick="toggleSection('sw-sec-dp')"><span class="card-num">3</span><span class="card-title">Points of Discharge</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.dischargePointsNote||'')}</p>
      ${rows}
    </div></div>`;
  };

  // ── §4 waterbodies ──
  _swSectionHtml['sw-sec-wb'] = ()=>{
    const i=_swGet(_swOpenId);
    const rows=(cfg.waterbodies||[]).map(w=>`<div class="sw-dp-row"><div class="sw-da-id">${esc(w.name)}</div><div class="sw-da-desc">${esc(w.type)} — ${esc(w.location)} · 303(d): ${esc(w.impaired)}</div></div>`).join('');
    return `<div class="card collapsed" id="sw-sec-wb"><div class="card-head" onclick="toggleSection('sw-sec-wb')"><span class="card-num">4</span><span class="card-title">Receiving Waterbodies</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.waterbodiesNote||'')}</p>
      ${rows}
      ${field('Notes', ta(i.waterbodyNotes,['waterbodyNotes']))}
    </div></div>`;
  };

  // ── §5 BMPs ──
  _swSectionHtml['sw-sec-bmp'] = ()=>{
    const i=_swGet(_swOpenId);
    let s5=0;
    const rows=(cfg.bmps||[]).map(b=>{
      const st=i.bmps[b.name]||{};
      const g1='sw-b'+(s5++), g2='sw-b'+(s5++), g3='sw-b'+(s5++), g4='sw-b'+(s5++);
      return `<div class="sw-bmp-row">
        <div class="sw-bmp-name">${esc(b.name)}<div class="sw-bmp-loc">${esc(b.location)}</div></div>
        <div class="sw-bmp-grid">
          <span class="sw-bmp-lbl">Installed</span>${_swSegHtml(g1, st.installed||'', YN, ['bmps',b.name,'installed'])}
          <span class="sw-bmp-lbl">Condition</span>${_swSegHtml(g2, st.condition||'', [{v:'acceptable',l:'Acceptable'},{v:'attention',l:'Needs Attention',cls:'sw-warn'},{v:'deficient',l:'Deficient',cls:'sw-bad'}], ['bmps',b.name,'condition'])}
          <span class="sw-bmp-lbl">Maint. needed</span>${_swSegHtml(g3, st.maintenance||'', YN, ['bmps',b.name,'maintenance'])}
          <span class="sw-bmp-lbl">Corrective</span>${_swSegHtml(g4, st.corrective||'', [{v:'compliant',l:'Compliant'},{v:'action',l:'Action Req',cls:'sw-warn'}], ['bmps',b.name,'corrective'])}
        </div>
        <input type="text" placeholder="Status / notes…" value="${esc(st.status||'')}" ${dis} oninput="swInp(event,'bmps','${esc(b.name)}','status')">
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-bmp"><div class="card-head" onclick="toggleSection('sw-sec-bmp')"><span class="card-num">5</span><span class="card-title">ESC Practice Inspection</span><span class="card-chevron">▾</span></div><div class="card-body">
      ${field(esc(cfg.escCondition4||'Condition 4 — ESC verified installed prior to disturbance'), seg([{v:'verified',l:'✓ Verified'},{v:'na',l:'N/A this inspection'}], i.escVerified, ['escVerified']))}
      <p class="sw-static-note">${esc(cfg.escNote||'')}</p>
      ${rows}
    </div></div>`;
  };

  // ── §6 pollution prevention ──
  _swSectionHtml['sw-sec-pp'] = ()=>{
    const i=_swGet(_swOpenId);
    let s6=0;
    const rows=(cfg.pollutionSources||[]).map(name=>{
      const st=i.pollution[name]||{};
      const gid='sw-p'+(s6++);
      return `<div class="sw-pp-row">
        <div class="sw-da-desc" style="font-weight:600">${esc(name)}</div>
        ${_swSegHtml(gid, st.controls||'', YNNA.map(o=>({v:o.v,l:o.v==='y'?'Controls ✓':(o.v==='n'?'Controls ✗':'N/A'),cls:o.v==='n'?'sw-warn':''})), ['pollution',name,'controls'])}
        <input type="text" placeholder="Observations / action…" value="${esc(st.obs||'')}" ${dis} oninput="swInp(event,'pollution','${esc(name)}','obs')">
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-pp"><div class="card-head" onclick="toggleSection('sw-sec-pp')"><span class="card-num">6</span><span class="card-title">Pollution Prevention</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.pollutionNote||'')}</p>
      ${rows}
    </div></div>`;
  };

  // ── §7 SMPs ──
  _swSectionHtml['sw-sec-smp'] = ()=>{
    const i=_swGet(_swOpenId);
    let s7=0;
    const rows=(cfg.smps||[]).map(s=>{
      const st=i.smps[s.name]||{};
      const g1='sw-s'+(s7++), g2='sw-s'+(s7++);
      return `<div class="sw-pp-row">
        <div class="sw-da-desc" style="font-weight:600">${esc(s.name)}<br><span style="color:var(--muted);font-weight:400">${esc(s.location)}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          ${_swSegHtml(g1, st.status||'', [{v:'not-started',l:'Not Started'},{v:'in-progress',l:'In Progress'},{v:'complete',l:'Complete'}], ['smps',s.name,'status'])}
          ${_swSegHtml(g2, st.compliance||'', [{v:'compliant',l:'Compliant'},{v:'non',l:'Non-Compliant',cls:'sw-bad'},{v:'na',l:'N/A'}], ['smps',s.name,'compliance'])}
        </div>
        <input type="text" placeholder="Notes / action…" value="${esc(st.notes||'')}" ${dis} oninput="swInp(event,'smps','${esc(s.name)}','notes')">
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-smp"><div class="card-head" onclick="toggleSection('sw-sec-smp')"><span class="card-num">7</span><span class="card-title">Post-Construction SMPs</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.smpNote||'')}</p>
      ${rows}
    </div></div>`;
  };

  // ── §8 corrective actions ──
  _swSectionHtml['sw-sec-ca'] = ()=>{
    const i=_swGet(_swOpenId);
    const rows=(i.corrective||[]).map((c,idx)=>`<div class="sw-ca-row">
      <div class="g g2">
        <div class="field"><label>Date identified</label><input type="date" value="${esc(c.dateId)}" ${dis} oninput="swCaInp(event,${idx},'dateId')"></div>
        <div class="field"><label>Location / BMP</label><input type="text" value="${esc(c.location)}" ${dis} oninput="swCaInp(event,${idx},'location')"></div>
      </div>
      <div class="field"><label>Description of deficiency</label><textarea class="auto-expand" rows="2" ${dis} oninput="swCaInp(event,${idx},'desc')">${esc(c.desc)}</textarea></div>
      <div class="field"><label>Required action / deadline / status</label><textarea class="auto-expand" rows="2" ${dis} oninput="swCaInp(event,${idx},'action')">${esc(c.action)}</textarea></div>
      ${ro?'':`<button class="btn btn-outline sw-ca-del" onclick="swpppRemoveCorrective(${idx})">🗑 Remove</button>`}
    </div>`).join('');
    return `<div class="card collapsed" id="sw-sec-ca"><div class="card-head" onclick="toggleSection('sw-sec-ca')"><span class="card-num">8</span><span class="card-title">Corrective Actions</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.correctiveNote||'')}</p>
      ${rows || '<p style="color:var(--muted);font-size:12px">No corrective actions this inspection.</p>'}
      ${ro?'':`<button class="btn btn-outline" style="font-size:11px" onclick="swpppAddCorrective()">＋ Add corrective action</button>`}
    </div></div>`;
  };

  // ── §9 notes ──
  _swSectionHtml['sw-sec-notes'] = ()=>{
    const i=_swGet(_swOpenId);
    return `<div class="card collapsed" id="sw-sec-notes"><div class="card-head" onclick="toggleSection('sw-sec-notes')"><span class="card-num">9</span><span class="card-title">General Notes / Observations</span><span class="card-chevron">▾</span></div><div class="card-body">
      ${field('Additional observations, communications, site conditions', ta(i.notes,['notes']))}
    </div></div>`;
  };

  // ── §10 sketches ──
  _swSectionHtml['sw-sec-sk'] = ()=>{
    const i=_swGet(_swOpenId);
    const rows=(i.sketches||[]).map((id,idx)=>{
      const p=(window._phPhotos||[]).find(x=>x.id===id)||{};
      const m=i.sketchMeta[id]||{};
      return `<div class="sw-att-row">
        <img src="${p.thumb||''}" class="sw-att-thumb">
        <div class="sw-att-fields">
          <input type="text" placeholder="Area / DA" value="${esc(m.area||'')}" ${dis} oninput="swMetaInp(event,'sketchMeta','${id}','area')">
          <input type="text" placeholder="Status / description" value="${esc(m.desc||'')}" ${dis} oninput="swMetaInp(event,'sketchMeta','${id}','desc')">
        </div>
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-sk"><div class="card-head" onclick="toggleSection('sw-sec-sk')"><span class="card-num">10</span><span class="card-title">Disturbance Sketches</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.sketchesNote||'')}</p>
      ${rows}
      ${ro?'':`<button class="btn btn-outline" style="font-size:11px" onclick="swpppPickPhotos('sketches')">🗺 Select map captures (${(i.sketches||[]).length})</button>`}
    </div></div>`;
  };

  // ── §11 photos ──
  _swSectionHtml['sw-sec-ph'] = ()=>{
    const i=_swGet(_swOpenId);
    const rows=(i.photos||[]).map((id)=>{
      const p=(window._phPhotos||[]).find(x=>x.id===id)||{};
      const m=i.photoMeta[id]||{};
      return `<div class="sw-att-row">
        <img src="${p.thumb||''}" class="sw-att-thumb">
        <div class="sw-att-fields">
          <input type="text" placeholder="Location / DA" value="${esc(m.loc||'')}" ${dis} oninput="swMetaInp(event,'photoMeta','${id}','loc')">
          <input type="text" placeholder="Subject / description" value="${esc(m.subject||'')}" ${dis} oninput="swMetaInp(event,'photoMeta','${id}','subject')">
        </div>
      </div>`;
    }).join('');
    return `<div class="card collapsed" id="sw-sec-ph"><div class="card-head" onclick="toggleSection('sw-sec-ph')"><span class="card-num">11</span><span class="card-title">Photographic Documentation</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(cfg.photosNote||'')} Tip: tag field photos as SWPPP (Photos page or map) and they sort first here.</p>
      ${rows}
      ${ro?'':`<button class="btn btn-outline" style="font-size:11px" onclick="swpppPickPhotos('photos')">📷 Select photos (${(i.photos||[]).length})</button>`}
    </div></div>`;
  };

  // ── certification ──
  _swSectionHtml['sw-sec-cert'] = ()=>{
    const i=_swGet(_swOpenId); const c=cfg.certification||{};
    return `<div class="card collapsed" id="sw-sec-cert"><div class="card-head" onclick="toggleSection('sw-sec-cert')"><span class="card-num">✍</span><span class="card-title">Certification</span><span class="card-chevron">▾</span></div><div class="card-body">
      <p class="sw-static-note">${esc(c.text||'')}</p>
      <div class="g g2">
        ${field('Signed (typed name)', txt(i.cert.signedName,['cert','signedName']))}
        ${field('Date', txt(i.cert.signedDate,['cert','signedDate'],'M/D/YY'))}
      </div>
      <p class="sw-static-note">Supervising QI/QP: ${esc(c.supervisingQi||'')} — signature on distributed copy.</p>
    </div></div>`;
  };

  const order=['sw-sec-hdr','sw-sec-das','sw-sec-wx','sw-sec-da2','sw-sec-dp','sw-sec-wb','sw-sec-bmp','sw-sec-pp','sw-sec-smp','sw-sec-ca','sw-sec-notes','sw-sec-sk','sw-sec-ph','sw-sec-cert'];
  wrap.innerHTML = `
    <div class="sw-form-top">
      <button class="sw-back" onclick="showPageBack('reports')">‹</button>
      <div>
        <div style="font-weight:700">QI Stormwater Inspection</div>
        <div style="font-size:11px;color:var(--muted)">${esc(cfg.projectTitle||'')} — ${esc(insp.date)}</div>
      </div>
      <button class="btn" style="margin-left:auto;font-size:11px" onclick="swpppExport('${insp.id}')">⬇ Export DOCX</button>
    </div>
    ${statusBar}
    ${order.map(id=>_swSectionHtml[id]()).join('')}
    <div style="height:120px"></div>`;
  wrap.querySelectorAll('textarea.auto-expand').forEach(t=>{ if(typeof autoResize==='function') autoResize(t); });
}

// ═══════════════════════════════════════════
// DOCX EXPORT — mirrors the QI report template section-for-section
// ═══════════════════════════════════════════
async function swpppExport(id){
  const pid=_swPid();
  await _swLoadAll(pid);
  const insp=(_swInsp[pid]||[]).find(x=>x.id===id);
  const cfg=_swCfg[pid];
  if(!insp||!cfg){ alert('Inspection or configuration not found.'); return; }
  const btns=document.querySelectorAll(`[onclick="swpppExport('${id}')"]`);
  btns.forEach(b=>{ b.dataset.oldTxt=b.textContent; b.textContent='Building…'; b.disabled=true; });
  try{
    const blob=await swpppBuildDocx(insp,cfg);
    const [y,m,d]=(insp.date||new Date().toLocaleDateString('en-CA')).split('-');
    const fname=`${(cfg.projectTitle||'Project').replace(/[^\w]+/g,'_')}-QI_Stormwater_Inspection_Report_${parseInt(m)}-${parseInt(d)}-${y.slice(2)}.docx`;
    await saveFileNative(blob,fname,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }catch(e){ console.error('swppp export failed:',e); alert('Export failed: '+e.message); }
  finally{ btns.forEach(b=>{ b.textContent=b.dataset.oldTxt||'⬇ Export DOCX'; b.disabled=false; }); }
}

async function swpppBuildDocx(insp,cfg){
  if(!window.docx) throw new Error('Report library not loaded — refresh and try again.');
  const{Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,AlignmentType,BorderStyle,WidthType,ShadingType,ImageRun,Footer,Header,PageNumber}=window.docx;
  const BLUE='1F3864',LT_BLUE='D9E2F3',MID_BLUE='2E5496',WHITE='FFFFFF',AMBER='FFF2CC';
  const bdr={style:BorderStyle.SINGLE,size:1,color:'AAAAAA'};
  const borders={top:bdr,bottom:bdr,left:bdr,right:bdr};
  const noBdr={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
  const noBorders={top:noBdr,bottom:noBdr,left:noBdr,right:noBdr};
  const CB=(on)=>on?'☒ ':'☐ ';
  const spacer=(pts=80)=>new Paragraph({spacing:{before:0,after:pts}});
  const h1=(text)=>new Paragraph({children:[new TextRun({text,bold:true,color:WHITE,font:'Arial',size:24})],shading:{fill:BLUE,type:ShadingType.CLEAR},spacing:{before:200,after:100}});
  const body=(text,opts)=>new Paragraph({children:[new TextRun(Object.assign({text,font:'Arial',size:20},opts||{}))],spacing:{before:40,after:40}});
  const note=(text)=>new Paragraph({children:[new TextRun({text,font:'Arial',size:16,italics:true,color:'555555'})],spacing:{before:20,after:60}});
  const cell=(text,o)=>{
    o=o||{};
    return new TableCell({borders,shading:o.fill?{fill:o.fill,type:ShadingType.CLEAR}:undefined,width:o.w?{size:o.w,type:WidthType.PERCENTAGE}:undefined,margins:{top:50,bottom:50,left:80,right:80},
      children:[new Paragraph({children:[new TextRun({text:String(text==null?'':text),bold:!!o.bold,italics:!!o.i,font:'Arial',size:o.size||18,color:o.color||'000000'})]})]});
  };
  const hcell=(text,w)=>cell(text,{fill:BLUE,color:WHITE,bold:true,w,size:18});
  const infoRow=(label,value)=>new TableRow({children:[
    new TableCell({borders,width:{size:3200,type:WidthType.DXA},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},margins:{top:70,bottom:70,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:label,bold:true,font:'Arial',size:20})]})] }),
    new TableCell({borders,width:{size:6160,type:WidthType.DXA},margins:{top:70,bottom:70,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:String(value==null?'':value),font:'Arial',size:20})]})] })
  ]});
  const fullTable=(rows)=>new Table({width:{size:100,type:WidthType.PERCENTAGE},rows});

  // Date formatting
  const [y,m,d]=(insp.date||new Date().toLocaleDateString('en-CA')).split('-');
  const dt=new Date(parseInt(y),parseInt(m)-1,parseInt(d));
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const longDate=`${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${parseInt(d)}, ${y}`;
  const H=cfg.header||{};

  // Title
  const title=[
    new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:cfg.projectTitle||'',bold:true,font:'Arial',size:30,color:BLUE})],spacing:{before:120,after:40}}),
    new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:cfg.title||'SPDES Stormwater — Qualified Inspector Inspection Report',font:'Arial',size:22,color:MID_BLUE})],spacing:{before:0,after:160}})
  ];

  // Header info table
  const typeLine=
    CB(insp.inspType==='routine')+'Routine — 2×/week (≥2 business days apart)    '+
    CB(insp.inspType==='post-storm')+'Post-Storm — within 1 business day of ≥0.5" rain    '+
    CB(insp.inspType==='other')+'Other'+(insp.inspType==='other'&&insp.inspTypeOther?': '+insp.inspTypeOther:'');
  const headerTbl=fullTable([
    infoRow('Inspection Date:',longDate),
    infoRow('Inspection Type:',typeLine),
    infoRow('Storm Date / Time:',insp.stormDateTime||'—'),
    infoRow('SQI Name:',H.inspectorName||''),
    infoRow('Role / Credential:',H.roleCredential||''),
    infoRow('SWT #:',`${H.swtNumber||''}   |   Expires: ${H.swtExpires||''}`),
    infoRow('Organization:',H.organization||''),
    infoRow('Project:',H.project||cfg.projectTitle||''),
    infoRow('SPDES Permit No.:',H.spdesPermit||''),
    infoRow('SWPTS Application ID:',H.swptsId||''),
    infoRow('Contractor POC:',H.contractorPoc||''),
    infoRow('Supervising QI / QP:',H.supervisingQi||'')
  ]);

  // Disturbed Area Summary
  const S=insp.daSummary||{};
  const das=cfg.disturbedAreaSummary||{};
  const fmtAc=(v)=>(v===''||v==null)?'______':`${v}`;
  const dasTbl=fullTable([
    infoRow('Active disturbed',fmtAc(S.active)+' ac'),
    infoRow('Inactive disturbed',fmtAc(S.inactive)+' ac'),
    infoRow('Temporary stabilization',fmtAc(S.tempStab)+' ac'),
    infoRow('Final / permanent stabilization',fmtAc(S.finalStab)+' ac'),
    new TableRow({children:[
      new TableCell({borders,shading:{fill:AMBER,type:ShadingType.CLEAR},width:{size:3200,type:WidthType.DXA},margins:{top:70,bottom:70,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:das.totalLabel||'TOTAL OPEN disturbed (Active + Inactive)',bold:true,font:'Arial',size:20})]})]}),
      new TableCell({borders,shading:{fill:AMBER,type:ShadingType.CLEAR},margins:{top:70,bottom:70,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:fmtAc(S.totalOpen)+' ac',bold:true,font:'Arial',size:20})]})]})
    ]}),
    infoRow(das.capLabel||'Authorization cap — max open at one time',`${das.capAcres||125} ac`),
    infoRow('Currently over 5 acres open?',CB(S.over5==='yes')+'Yes    '+CB(S.over5==='no')+'No'),
    infoRow('Enhanced inspection frequency in effect?',CB(S.enhanced==='yes')+'Yes (2×/wk + post-storm)    '+CB(S.enhanced==='no')+'No')
  ]);
  const dasBlock=[
    new Paragraph({children:[new TextRun({text:'Disturbed Area Summary — >5-Acre Authorization (Condition 1)',bold:true,font:'Arial',size:22,color:BLUE})],spacing:{before:160,after:40}}),
    note(das.note||''), dasTbl
  ];

  // §1 Weather
  const W=insp.weather||{};
  const wxTbl=fullTable([
    infoRow('Sky Conditions:',W.sky||'—'),
    infoRow('Temperature (AM/PM):',W.temp||'—'),
    infoRow('Precipitation:',W.precip||'—'),
    infoRow('Wind:',W.wind||'—'),
    infoRow('Soil Conditions:',W.soil||'—'),
    infoRow('Site Access:',W.access||'—'),
    infoRow('General Site Conditions:',W.general||'—')
  ]);

  // §2 Drainage areas
  const daRows=[new TableRow({children:[hcell('Drainage Area ID',18),hcell('General Location / Description',42),hcell('Condition',22),hcell('Action Required',18)]})];
  (cfg.drainageAreas||[]).forEach(da=>{
    const st=(insp.drainageAreas||{})[da.id]||{};
    const cond=CB(st.condition==='acceptable')+'Acceptable   '+CB(st.condition==='deficient')+'Deficient';
    daRows.push(new TableRow({children:[cell(da.id,{bold:true,size:16}),cell(da.desc,{size:16}),cell(cond,{size:16}),cell(st.action||'',{size:16})]}));
  });

  // §3 Discharge points
  const dpRows=[new TableRow({children:[hcell('Discharge Point ID',14),hcell('Location Description',38),hcell('Receiving Water',28),hcell('Condition / Notes',20)]})];
  (cfg.dischargePoints||[]).forEach(dp=>{
    const st=(insp.dischargePoints||{})[dp.id]||{};
    dpRows.push(new TableRow({children:[cell(dp.id,{bold:true,size:16}),cell(dp.location,{size:16,i:true}),cell(dp.receiving,{size:16,i:true}),cell(st.notes||'',{size:16})]}));
  });

  // §4 Waterbodies
  const wbRows=[new TableRow({children:[hcell('Waterbody',28),hcell('Type',14),hcell('Location on Site',40),hcell('303(d) Impaired?',18)]})];
  (cfg.waterbodies||[]).forEach(w=>{ wbRows.push(new TableRow({children:[cell(w.name,{size:16,bold:true}),cell(w.type,{size:16}),cell(w.location,{size:16}),cell(w.impaired,{size:16})]})); });

  // §5 ESC BMPs
  const bmpRows=[new TableRow({children:[hcell('BMP / Practice',18),hcell('Location / Ref',22),hcell('Installed',10),hcell('Condition',20),hcell('Maint. Needed',10),hcell('Corrective / Status',20)]})];
  (cfg.bmps||[]).forEach(b=>{
    const st=(insp.bmps||{})[b.name]||{};
    const inst=CB(st.installed==='y')+'Y  '+CB(st.installed==='n')+'N';
    const cond=CB(st.condition==='acceptable')+'Acceptable\n'+CB(st.condition==='attention')+'Needs Attention\n'+CB(st.condition==='deficient')+'Deficient';
    const maint=CB(st.maintenance==='y')+'Y  '+CB(st.maintenance==='n')+'N';
    const corr=CB(st.corrective==='compliant')+'Compliant  '+CB(st.corrective==='action')+'Action Req'+(st.status?`\nStatus: ${st.status}`:'');
    const multiline=(txt,o)=>new TableCell({borders,margins:{top:50,bottom:50,left:80,right:80},children:String(txt).split('\n').map(l=>new Paragraph({children:[new TextRun({text:l,font:'Arial',size:16,bold:!!(o&&o.bold)})]}))});
    bmpRows.push(new TableRow({children:[cell(b.name,{bold:true,size:16}),cell(b.location,{size:16,i:true}),multiline(inst),multiline(cond),multiline(maint),multiline(corr)]}));
  });
  const cond4Line=body(CB(insp.escVerified==='verified')+'Verified    '+CB(insp.escVerified==='na')+'N/A this inspection — '+(cfg.escCondition4||''),{size:16,italics:true});

  // §6 Pollution prevention
  const ppRows=[new TableRow({children:[hcell('Pollution Source / Activity',34),hcell('Controls in Place',22),hcell('Condition / Observations',28),hcell('Action Required',16)]})];
  (cfg.pollutionSources||[]).forEach(name=>{
    const st=(insp.pollution||{})[name]||{};
    const c=CB(st.controls==='y')+'Y  '+CB(st.controls==='n')+'N  '+CB(st.controls==='na')+'N/A';
    ppRows.push(new TableRow({children:[cell(name,{size:16}),cell(c,{size:16}),cell(st.obs||'',{size:16}),cell(st.action||'',{size:16})]}));
  });

  // §7 SMPs
  const smpRows=[new TableRow({children:[hcell('SMP Practice',24),hcell('Location',26),hcell('Construction Status',20),hcell('SWPPP Compliance',18),hcell('Notes / Action',12)]})];
  (cfg.smps||[]).forEach(s=>{
    const st=(insp.smps||{})[s.name]||{};
    const cs=CB(st.status==='not-started')+'Not Started '+CB(st.status==='in-progress')+'In Progress '+CB(st.status==='complete')+'Complete';
    const sc=CB(st.compliance==='compliant')+'Compliant '+CB(st.compliance==='non')+'Non-Compliant '+CB(st.compliance==='na')+'N/A';
    smpRows.push(new TableRow({children:[cell(s.name,{bold:true,size:16}),cell(s.location,{size:16,i:true}),cell(cs,{size:16}),cell(sc,{size:16}),cell(st.notes||'',{size:16})]}));
  });

  // §8 Corrective actions
  const caRows=[new TableRow({children:[hcell('Date Identified',14),hcell('Location / BMP',22),hcell('Description of Deficiency',34),hcell('Required Action / Deadline / Status',30)]})];
  const caList=(insp.corrective&&insp.corrective.length)?insp.corrective:[];
  caList.forEach(c=>{ caRows.push(new TableRow({children:[cell(c.dateId||'',{size:16}),cell(c.location||'',{size:16}),cell(c.desc||'',{size:16}),cell(c.action||'',{size:16})]})); });
  if(!caList.length) caRows.push(new TableRow({children:[cell('—',{size:16}),cell('None identified this inspection',{size:16}),cell('',{size:16}),cell('',{size:16})]}));

  // §10 / §11 — images with preserved aspect (createImageBitmap), thumb fallback.
  async function imgFor(pId,maxW){
    const p=(window._phPhotos||[]).find(x=>x.id===pId);
    if(!p) return null;
    try{
      let blob=null;
      if(p.storageUrl){ try{ blob=await (await fetch(p.storageUrl)).blob(); }catch(e){} }
      if(!blob&&p.thumb){ const raw=p.thumb, b64=raw.includes(',')?raw.split(',')[1]:raw; const bin=atob(b64); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i); blob=new Blob([arr]); }
      if(!blob) return null;
      let w=maxW,h=Math.round(maxW*0.72);
      try{ const bmp=await createImageBitmap(blob); const sc=maxW/bmp.width; w=maxW; h=Math.round(bmp.height*sc); if(h>700){ h=700; w=Math.round(bmp.width*(700/bmp.height)); } bmp.close&&bmp.close(); }catch(e){}
      return {data:await blob.arrayBuffer(),w,h,p};
    }catch(e){ return null; }
  }
  const skParas=[];
  const skMetaRows=[new TableRow({children:[hcell('Sketch #',12),hcell('Area / DA',28),hcell('Date',16),hcell('Status / Description',44)]})];
  let skN=0;
  for(const pId of (insp.sketches||[])){
    skN++;
    const m=(insp.sketchMeta||{})[pId]||{};
    skMetaRows.push(new TableRow({children:[cell(String(skN),{size:16}),cell(m.area||'',{size:16}),cell(m.date||'',{size:16}),cell(m.desc||'',{size:16})]}));
  }
  skN=0;
  for(const pId of (insp.sketches||[])){
    skN++;
    const im=await imgFor(pId,620);
    if(im){
      skParas.push(new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({data:im.data,transformation:{width:im.w,height:im.h}})],spacing:{before:120,after:20}}));
      const m=(insp.sketchMeta||{})[pId]||{};
      skParas.push(new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:`Sketch ${skN} — ${[m.area,m.desc].filter(Boolean).join(' · ')}`,font:'Arial',size:16,italics:true})],spacing:{before:0,after:80}}));
    }
  }
  const phMetaRows=[new TableRow({children:[hcell('Photo #',12),hcell('Date / Time',20),hcell('Location / DA',26),hcell('Subject / Description',42)]})];
  let phN=0;
  const phCells=[];
  for(const pId of (insp.photos||[])){
    phN++;
    const p=(window._phPhotos||[]).find(x=>x.id===pId)||{};
    const m=(insp.photoMeta||{})[pId]||{};
    phMetaRows.push(new TableRow({children:[cell(String(phN),{size:16}),cell(p.date||'',{size:16}),cell(m.loc||'',{size:16}),cell(m.subject||'',{size:16})]}));
  }
  phN=0;
  const phRows=[];
  const phIds=(insp.photos||[]);
  for(let i=0;i<phIds.length;i+=2){
    const rowCells=[];
    for(let j=i;j<Math.min(i+2,phIds.length);j++){
      const im=await imgFor(phIds[j],300);
      const m=(insp.photoMeta||{})[phIds[j]]||{};
      if(im){
        rowCells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},margins:{top:40,bottom:40,left:40,right:40},children:[
          new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({data:im.data,transformation:{width:im.w,height:im.h}})]}),
          new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:`Photo ${j+1} — ${[m.loc,m.subject].filter(Boolean).join(' · ')}`,font:'Arial',size:16,italics:true})],spacing:{before:40,after:60}})
        ]}));
      }else{
        rowCells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},children:[new Paragraph({children:[new TextRun({text:`Photo ${j+1}`,font:'Arial',size:16})]})]}));
      }
    }
    if(rowCells.length===1) rowCells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},children:[new Paragraph({children:[]})]}));
    phRows.push(new TableRow({children:rowCells}));
  }

  // Certification
  const C=cfg.certification||{};
  const certBlock=[
    spacer(160),
    new Paragraph({children:[new TextRun({text:'Report Certification',bold:true,font:'Arial',size:22,color:MID_BLUE})],border:{bottom:{style:BorderStyle.SINGLE,size:6,color:MID_BLUE,space:1}},spacing:{before:0,after:60}}),
    body(C.text||''),
    spacer(80),
    fullTable([
      infoRow('QI Name:',C.qiName||''),
      infoRow('Role / Credential:',C.roleCredential||''),
      infoRow('SWT #:',`${C.swtNumber||''}   |   Expires: ${C.swtExpires||''}`),
      infoRow('Organization:',C.organization||''),
      infoRow('Signature:',(insp.cert&&insp.cert.signedName)?`/s/ ${insp.cert.signedName}`:''),
      infoRow('Date:',(insp.cert&&insp.cert.signedDate)||''),
      infoRow('Supervising QI / QP:',C.supervisingQi||''),
      infoRow('QP Signature:','')
    ])
  ];

  // Footer + repeating page header
  const footer=new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,border:{top:{style:BorderStyle.SINGLE,size:6,color:'AAAAAA',space:4}},spacing:{before:80},children:[
    new TextRun({text:`${cfg.projectTitle||''}  |  SPDES QI Stormwater Inspection Report  |  ${parseInt(m)}/${parseInt(d)}/${y.slice(2)}  |  Page `,font:'Arial',size:16,color:'888888'}),
    new TextRun({children:[PageNumber.CURRENT],font:'Arial',size:16,color:'888888'})
  ]})]});
  const wordHeader=new Header({children:[new Table({width:{size:100,type:WidthType.PERCENTAGE},borders:noBorders,rows:[new TableRow({children:[
    new TableCell({borders:{top:bdr,left:bdr,bottom:bdr,right:noBdr},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},width:{size:60,type:WidthType.PERCENTAGE},margins:{top:60,bottom:60,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:(cfg.projectTitle||'').toUpperCase(),bold:true,font:'Arial',size:20,color:BLUE})]})]}),
    new TableCell({borders:{top:bdr,left:noBdr,bottom:bdr,right:bdr},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},width:{size:40,type:WidthType.PERCENTAGE},margins:{top:60,bottom:60,left:120,right:120},children:[new Paragraph({alignment:AlignmentType.RIGHT,children:[new TextRun({text:'QI Inspection Report',font:'Arial',size:18,color:MID_BLUE})]})]})
  ]})]})]});

  const children=[
    ...title, headerTbl,
    ...dasBlock, spacer(80),
    h1('1.  Weather & Site Conditions'),spacer(40),wxTbl,spacer(80),
    h1('2.  Drainage Areas Inspected'),note(cfg.drainageAreasNote||''),
    ...(insp.daBulkNote?[body('Grouped note: '+insp.daBulkNote,{italics:true})]:[]),
    fullTable(daRows),spacer(80),
    h1('3.  Points of Discharge'),note(cfg.dischargePointsNote||''),fullTable(dpRows),spacer(80),
    h1('4.  Receiving Waterbodies'),note(cfg.waterbodiesNote||''),fullTable(wbRows),
    ...(insp.waterbodyNotes?[body('Notes: '+insp.waterbodyNotes)]:[]),spacer(80),
    h1('5.  ESC Practice Inspection'),cond4Line,note(cfg.escNote||''),fullTable(bmpRows),spacer(80),
    h1('6.  Pollution Prevention Measures'),note(cfg.pollutionNote||''),fullTable(ppRows),spacer(80),
    h1('7.  Post-Construction Stormwater Management Practices'),note(cfg.smpNote||''),fullTable(smpRows),spacer(80),
    h1('8.  Corrective Actions Summary'),note(cfg.correctiveNote||''),fullTable(caRows),spacer(80),
    h1('9.  General Notes / Additional Observations'),body(insp.notes||'None.'),spacer(80),
    h1('10.  Disturbance Sketches'),note(cfg.sketchesNote||''),
    ...(skMetaRows.length>1?[fullTable(skMetaRows)]:[body('No sketches attached.')]),
    ...skParas,spacer(80),
    h1('11.  Photographic Documentation'),note(cfg.photosNote||''),
    ...(phMetaRows.length>1?[fullTable(phMetaRows)]:[body('No photographs attached.')]),
    ...(phRows.length?[spacer(60),new Table({borders:noBorders,width:{size:100,type:WidthType.PERCENTAGE},rows:phRows})]:[]),
    ...certBlock
  ];
  const doc=new Document({sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1700,bottom:1080,left:1080,right:1080},header:{value:720}}},headers:{default:wordHeader},footers:{default:footer},children}]});
  return Packer.toBlob(doc);
}

// ── CSS (self-contained; uses the app's theme variables) ──
(function(){
  const css=`
  .sw-head-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
  .sw-list-row{display:flex;align-items:center;gap:8px;padding:10px 4px;border-bottom:1px solid var(--s1)}
  .sw-list-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}
  .sw-list-date{font-family:var(--mono);font-size:12px}
  .sw-list-type{font-size:11px;color:var(--muted)}
  .sw-list-btn{background:var(--s1);border:1px solid var(--s1);border-radius:8px;color:var(--text);font-size:14px;padding:6px 12px;cursor:pointer}
  .sw-chip{font-family:var(--mono);font-size:9px;padding:2px 8px;border-radius:10px;white-space:nowrap}
  .sw-chip-draft{background:rgba(230,160,30,.15);color:var(--amber);border:1px solid var(--amber)}
  .sw-chip-done{background:rgba(39,174,96,.15);color:#27AE60;border:1px solid #27AE60}
  .sw-form-top{display:flex;align-items:center;gap:10px;padding:10px 0 6px}
  .sw-back{background:none;border:none;color:var(--text);font-size:26px;line-height:1;cursor:pointer;padding:4px 10px 4px 0}
  .sw-lockbar{display:flex;align-items:center;gap:10px;font-size:12px;padding:8px 12px;border-radius:8px;margin-bottom:12px;background:rgba(39,174,96,.12);border:1px solid #27AE60}
  .sw-lockbar-draft{background:rgba(230,160,30,.10);border-color:var(--amber)}
  .sw-static-note{font-size:10.5px;color:var(--muted);font-style:italic;margin:4px 0 10px;line-height:1.45}
  .sw-total-row{font-size:13px;padding:8px 10px;margin:6px 0 10px;background:rgba(230,160,30,.10);border:1px solid var(--amber);border-radius:8px}
  .sw-seg{display:inline-flex;flex-wrap:wrap;gap:5px}
  .sw-seg-btn{background:var(--s1);border:1px solid var(--s1);border-radius:14px;color:var(--muted);font-size:11px;padding:5px 11px;cursor:pointer;min-height:30px}
  .sw-seg-btn.on{border-color:var(--amber);color:var(--text);background:rgba(230,160,30,.16);font-weight:600}
  .sw-seg-btn.sw-warn.on{border-color:#e67e22;background:rgba(230,126,34,.18)}
  .sw-seg-btn.sw-bad.on{border-color:#e74c3c;background:rgba(231,76,60,.18)}
  .sw-seg.sw-ro .sw-seg-btn{pointer-events:none;opacity:.75}
  .sw-da-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 2px;border-bottom:1px solid var(--s1)}
  .sw-da-row.sw-da-def{background:rgba(231,76,60,.06)}
  .sw-da-id{font-family:var(--mono);font-size:11px;font-weight:700;min-width:120px}
  .sw-da-desc{font-size:11px;color:var(--text);flex:1;min-width:160px;line-height:1.4}
  .sw-da-action{width:100%;box-sizing:border-box}
  .sw-dp-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 2px;border-bottom:1px solid var(--s1)}
  .sw-dp-row input{flex:1;min-width:180px;box-sizing:border-box}
  .sw-bmp-row{padding:10px 2px;border-bottom:1px solid var(--s1)}
  .sw-bmp-name{font-size:13px;font-weight:700;margin-bottom:6px}
  .sw-bmp-loc{font-size:10px;color:var(--muted);font-weight:400;margin-top:2px}
  .sw-bmp-grid{display:grid;grid-template-columns:max-content 1fr;gap:6px 10px;align-items:center;margin-bottom:8px}
  .sw-bmp-lbl{font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase}
  .sw-bmp-row>input{width:100%;box-sizing:border-box}
  .sw-pp-row{display:flex;flex-direction:column;gap:6px;padding:10px 2px;border-bottom:1px solid var(--s1)}
  .sw-pp-row input{width:100%;box-sizing:border-box}
  .sw-ca-row{border:1px solid var(--s1);border-radius:8px;padding:10px;margin-bottom:10px}
  .sw-ca-del{font-size:10px;padding:4px 10px}
  .sw-att-row{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--s1)}
  .sw-att-thumb{width:84px;height:64px;object-fit:cover;border-radius:6px;flex-shrink:0}
  .sw-att-fields{flex:1;display:flex;flex-direction:column;gap:6px}
  .sw-att-fields input{width:100%;box-sizing:border-box}
  .sw-pick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;max-height:46vh;overflow-y:auto}
  .sw-pick{position:relative;border:2px solid transparent;border-radius:8px;overflow:hidden;cursor:pointer;aspect-ratio:4/3}
  .sw-pick img{width:100%;height:100%;object-fit:cover;display:block}
  .sw-pick.on{border-color:var(--amber)}
  .sw-pick.on::after{content:'✓';position:absolute;top:4px;right:4px;background:var(--amber);color:#000;border-radius:50%;width:18px;height:18px;font-size:12px;display:flex;align-items:center;justify-content:center}
  .sw-pick-tag{position:absolute;top:4px;left:4px;background:rgba(30,120,200,.9);color:#fff;font-family:var(--mono);font-size:8px;padding:1px 5px;border-radius:6px}
  .sw-pick-date{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#fff;font-family:var(--mono);font-size:8px;padding:2px 4px}`;
  const st=document.createElement('style'); st.id='sw-css'; st.textContent=css; document.head.appendChild(st);
})();

// ── window exposure (onclick handlers + showPage hook) ──
window.glRenderReportsPage = glRenderReportsPage;
window.swpppShowSetup = swpppShowSetup;
window.swpppSaveSetup = swpppSaveSetup;
window.swpppNewInspection = swpppNewInspection;
window.swpppOpenInspection = swpppOpenInspection;
window.swpppRefreshDaSummary = swpppRefreshDaSummary;
window.swpppComplete = swpppComplete;
window.swpppReopen = swpppReopen;
window.swSet = swSet;
window.swInp = swInp;
window.swSeg = swSeg;
window.swCaInp = swCaInp;
window.swMetaInp = swMetaInp;
window.swpppDaAll = swpppDaAll;
window.swpppAddCorrective = swpppAddCorrective;
window.swpppRemoveCorrective = swpppRemoveCorrective;
window.swpppPickPhotos = swpppPickPhotos;
window.swpppPickDone = swpppPickDone;
window.swpppExport = swpppExport;
