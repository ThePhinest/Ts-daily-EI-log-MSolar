// ═══════════════════════════════════════════
// COMPLIANCE LOG
// ═══════════════════════════════════════════
var _clEntries = [];
var _clEditId = null;

// ── Helpers ──
function clGenId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function clLevelLabel(l){
  const m = {'1':'Level 1 — Observation','2':'Level 2 — Corrective Action','3':'Level 3 — Non-Compliance','4':'Level 4 — Stop Work Order'};
  return m[String(l)] || 'Level '+l;
}

function clLevelClass(l){ return 'cl-level cl-level-'+l; }

function clStatusClass(s){
  if(s==='Open') return 'cl-status cl-status-open';
  if(s==='In Progress') return 'cl-status cl-status-prog';
  return 'cl-status cl-status-resolved';
}

function clFmtDate(d){
  if(!d) return '';
  const p = d.split('-');
  if(p.length!==3) return d;
  return `${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`;
}

// ── Persistence: Tier-1 IDB cache (key `cl_entries`, JSON string verbatim) ──
// Migrated out of localStorage on boot in initFirebaseLoad.
function clSaveLocal(){
  try{ if(window.idbSet) window.idbSet('cl_entries', JSON.stringify(_clEntries)); }catch{}
}

function clLoadLocal(){
  try{
    const raw = window.idbGet && window.idbGet('cl_entries');
    if(raw){ _clEntries = JSON.parse(raw); }
  }catch{ _clEntries = []; }
}

// ── Persistence: Firebase ──
async function clSaveCloud(){
  if(!db || !_fbReady) return;
  try{
    const batch = db.batch();
    // Save entire array as single doc for simplicity
    batch.set(_udb().collection('compliance').doc('entries'), { list: _clEntries, _ts: Date.now() });
    await batch.commit();
  }catch(e){ console.warn('clSaveCloud failed:', e.message); }
}

async function clLoadCloud(){
  if(!db || !_fbReady) return false;
  try{
    const doc = await _udb().collection('compliance').doc('entries').get();
    if(doc.exists){
      const data = doc.data();
      _clEntries = data.list || [];
      clSaveLocal();
      return true;
    }
  }catch(e){ console.warn('clLoadCloud failed:', e.message); }
  return false;
}

function clSave(){
  clSaveLocal();
  clSaveCloud();
  window.glHaptic && window.glHaptic.success();  // tactile confirm on compliance entry save
}

// ── Render ──
function clRender(){
  const search = (document.getElementById('cl-search')?.value||'').toLowerCase();
  const filterLevel = document.getElementById('cl-filter-level')?.value||'';
  const filterStatus = document.getElementById('cl-filter-status')?.value||'';

  let entries = [..._clEntries].sort((a,b)=> b.date > a.date ? 1 : -1);

  if(_projectFilterActive) entries = entries.filter(e => !e.projectId || e.projectId === _activeProjectId());
  if(filterLevel) entries = entries.filter(e=>String(e.level)===filterLevel);
  if(filterStatus) entries = entries.filter(e=>e.status===filterStatus);
  if(search) entries = entries.filter(e=>
    (e.location||'').toLowerCase().includes(search) ||
    (e.corrective||'').toLowerCase().includes(search)
  );

  // Update stats (based on ALL entries, not filtered)
  const openCount = _clEntries.filter(e=>e.status==='Open'||e.status==='In Progress').length;
  const el = document.getElementById('cl-stat-open');
  const et = document.getElementById('cl-stat-total');
  if(el) el.textContent = openCount;
  if(et) et.textContent = _clEntries.length;

  clRenderTrackerCard();
  const list = document.getElementById('cl-list');
  if(!list) return;

  if(entries.length===0){
    list.innerHTML = _clEntries.length===0
      ? glEmptyState({
          icon:'⚠️', title:'No compliance entries yet',
          body:'Observations, BMP issues, and regulatory flags get logged here — and auto-detected from your daily log narrative when you write one.',
          actions:[{ label:'+ Add Entry', onclick:'clShowForm()', primary:true }],
          academy:'tracker-log', academyLabel:'Tracking &amp; compliance'
        })
      : '<div class="cl-empty">No entries match the current filters.</div>';
    return;
  }

  list.innerHTML = entries.map(e => {
    const resolvedRow = e.status==='Resolved' && e.dateResolved
      ? `<div class="cl-field-val full"><span style="font-family:var(--mono);font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Resolved</span> <span style="font-size:13px;color:var(--green)">${clFmtDate(e.dateResolved)}</span></div>`
      : '';
    const sourceLabel = e.sourceReport ? `Report: ${clFmtDate(e.sourceReport)}` : (e.addedBy==='auto'?'Auto-captured':'Manual entry');
    return `
    <div class="cl-entry" id="cle-${e.id}">
      <div class="cl-entry-head">
        <span class="cl-entry-date">${clFmtDate(e.date)}</span>
        <span class="${clLevelClass(e.level)}">${clLevelLabel(e.level)}</span>
        <span class="${clStatusClass(e.status)}">${e.status}</span>
        <span class="cl-entry-source">${sourceLabel}</span>
      </div>
      <div class="cl-entry-body">
        <div>
          <div class="cl-field-lbl">Location / Description</div>
          <div class="cl-field-val">${e.location||'—'}</div>
        </div>
        <div>
          <div class="cl-field-lbl">Corrective Action</div>
          <div class="cl-field-val">${e.corrective||'—'}</div>
        </div>
        ${resolvedRow}
      </div>
      <div class="cl-entry-footer">
        <button class="btn btn-outline" style="font-size:11px;padding:5px 12px" onclick="clEditEntry('${e.id}')">Edit</button>
        <button class="btn btn-ghost" style="font-size:11px;padding:5px 12px" onclick="clConfirmDelete('${e.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// ── Form: show / hide ──
function clShowForm(prefill){
  _clEditId = null;
  // Set defaults
  document.getElementById('cl-f-date').value = new Date().toLocaleDateString('en-CA');
  document.getElementById('cl-f-level').value = '1';
  document.getElementById('cl-f-location').value = '';
  document.getElementById('cl-f-corrective').value = '';
  document.getElementById('cl-f-status').value = 'Open';
  document.getElementById('cl-f-resolved').value = '';
  document.getElementById('cl-f-source').value = document.getElementById('reportDate')?.value||'';
  document.getElementById('cl-f-resolved-wrap').style.display = 'none';
  document.getElementById('cl-form-title').textContent = 'New Compliance Entry';

  if(prefill){
    if(prefill.level) document.getElementById('cl-f-level').value = prefill.level;
    if(prefill.location) document.getElementById('cl-f-location').value = prefill.location;
    if(prefill.corrective) document.getElementById('cl-f-corrective').value = prefill.corrective;
    if(prefill.date) document.getElementById('cl-f-date').value = prefill.date;
    if(prefill.source) document.getElementById('cl-f-source').value = prefill.source;
  }

  document.getElementById('cl-form-overlay').classList.add('open');
  document.getElementById('cl-form-panel').classList.add('open');
}

function clEditEntry(id){
  const e = _clEntries.find(x=>x.id===id);
  if(!e) return;
  _clEditId = id;
  document.getElementById('cl-f-date').value = e.date||'';
  document.getElementById('cl-f-level').value = String(e.level||'1');
  document.getElementById('cl-f-location').value = e.location||'';
  document.getElementById('cl-f-corrective').value = e.corrective||'';
  document.getElementById('cl-f-status').value = e.status||'Open';
  document.getElementById('cl-f-resolved').value = e.dateResolved||'';
  document.getElementById('cl-f-source').value = e.sourceReport||'';
  document.getElementById('cl-f-resolved-wrap').style.display = e.status==='Resolved'?'block':'none';
  document.getElementById('cl-form-title').textContent = 'Edit Compliance Entry';
  document.getElementById('cl-form-overlay').classList.add('open');
  document.getElementById('cl-form-panel').classList.add('open');
}

function clHideForm(){
  document.getElementById('cl-form-overlay').classList.remove('open');
  document.getElementById('cl-form-panel').classList.remove('open');
  _clEditId = null;
}

function clToggleResolvedDate(){
  const s = document.getElementById('cl-f-status').value;
  document.getElementById('cl-f-resolved-wrap').style.display = s==='Resolved'?'block':'none';
  if(s==='Resolved' && !document.getElementById('cl-f-resolved').value){
    document.getElementById('cl-f-resolved').value = new Date().toLocaleDateString('en-CA');
  }
}

function clSubmitForm(){
  const location = document.getElementById('cl-f-location').value.trim();
  if(!location){ document.getElementById('cl-f-location').focus(); return; }

  const entry = {
    id: _clEditId || clGenId(),
    date: document.getElementById('cl-f-date').value,
    level: parseInt(document.getElementById('cl-f-level').value),
    location: location,
    corrective: document.getElementById('cl-f-corrective').value.trim(),
    status: document.getElementById('cl-f-status').value,
    dateResolved: document.getElementById('cl-f-status').value==='Resolved' ? document.getElementById('cl-f-resolved').value : '',
    sourceReport: document.getElementById('cl-f-source').value,
    addedBy: _clEditId ? (_clEntries.find(x=>x.id===_clEditId)?.addedBy||'manual') : 'manual',
    projectId: _clEditId ? (_clEntries.find(x=>x.id===_clEditId)?.projectId||_activeProjectId()) : _activeProjectId()
  };

  if(_clEditId){
    const idx = _clEntries.findIndex(x=>x.id===_clEditId);
    if(idx>=0) _clEntries[idx] = entry;
  } else {
    _clEntries.push(entry);
  }

  clSave();
  clHideForm();
  clRender();
}

// ── Delete with confirm modal ──
function clConfirmDelete(id){
  const e = _clEntries.find(x=>x.id===id);
  if(!e) return;
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box">' +
    '<div class="modal-title">⚠ Delete Entry?</div>' +
    '<div class="modal-msg">Delete the <strong>' + clLevelLabel(e.level) + '</strong> entry from <strong>' + clFmtDate(e.date) + '</strong>?<br><br>This cannot be undone.</div>' +
    '<div class="modal-btns">' +
      '<button class="modal-cancel" id="_clmc">Cancel</button>' +
      '<button class="modal-confirm" id="_clmok">Delete</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_clmc').onclick = function(){ ov.remove(); };
  document.getElementById('_clmok').onclick = function(){
    ov.remove();
    _clEntries = _clEntries.filter(x=>x.id!==id);
    clSave();
    clRender();
  };
}

// ── Auto-detect issues from daily log ──
function clAutoDetect(){
  const reportDate = document.getElementById('reportDate')?.value || '';
  const detected = [];
  const levelRx = /level\s*([1-4])/i;

  // Check nonCompliance field
  const nc = document.getElementById('nonCompliance')?.value.trim()||'';
  if(nc){
    const m = nc.match(levelRx);
    detected.push({ level: m?parseInt(m[1]):2, location: nc, corrective:'', date:reportDate, source:reportDate, addedBy:'auto' });
  }

  // Check all crew block issues fields
  document.querySelectorAll('[id$="-issues"]').forEach(el=>{
    const val = el.value.trim();
    if(!val) return;
    const m = val.match(levelRx);
    detected.push({ level: m?parseInt(m[1]):2, location: val, corrective:'', date:reportDate, source:reportDate, addedBy:'auto' });
  });

  if(detected.length===0) return;

  // Filter out already-logged (same date + first 40 chars of location)
  const newOnes = detected.filter(d=>{
    const key = d.date + d.location.slice(0,40).toLowerCase();
    return !_clEntries.some(e=> (e.date + (e.location||'').slice(0,40).toLowerCase()) === key);
  });

  if(newOnes.length===0) return;

  const banner = document.getElementById('cl-auto-banner');
  const msg = document.getElementById('cl-auto-msg');
  if(banner && msg){
    msg.textContent = `${newOnes.length} issue${newOnes.length>1?'s':''} detected in today's log — add to compliance log?`;
    banner.style.display = 'flex';
    banner._pending = newOnes;
  }
}

function clAutoImport(){
  const banner = document.getElementById('cl-auto-banner');
  const pending = banner?._pending||[];
  pending.forEach(d=>{
    _clEntries.push({ id:clGenId(), date:d.date, level:d.level, location:d.location, corrective:d.corrective, status:'Open', dateResolved:'', sourceReport:d.source, addedBy:'auto', projectId:_activeProjectId() });
  });
  clSave();
  banner.style.display = 'none';
  clRender();
}

// ── Phase D migration: tag existing compliance entries with active projectId ──
async function _glMigrateCompliancePhaseD() {
  if (localStorage.getItem('gl_phaseD_cl_migrated')) return;
  if (!_fbReady) return;
  const pid = _activeProjectId();
  if (!pid || pid === 'default') return;
  let changed = false;
  _clEntries.forEach(e => { if (!e.projectId) { e.projectId = pid; changed = true; } });
  if (changed) clSave();
  localStorage.setItem('gl_phaseD_cl_migrated', '1');
}

// ── Today's Tracker Activity card ──
// ── Punchlist card — open repair flags (point markers on drawings) ──
// Reads the temporary lifecycle (trGetOpenTemporary / trGetResolvedTemporary).
// Open rows: what's wrong, where, photo, [Fixed] [Map]. Resolved history stays
// collapsible — non-destructive record with timestamp + resolution note.
function clRenderPunchlist(){
  const el=document.getElementById('cl-punchlist-card');
  if(!el) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const open=(typeof trGetOpenTemporary==='function')?trGetOpenTemporary(pid):[];
  const resolved=(typeof trGetResolvedTemporary==='function')?trGetResolvedTemporary(pid):[];
  if(!open.length&&!resolved.length){ el.style.display='none'; return; }
  const fmtWhen=ts=>{ if(!ts) return ''; const d=new Date(ts); return `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
  const rowHtml=(e,isOpen)=>{
    const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'')||'—';
    const photos=(e.photoIds||[]).map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
    const thumb=photos.length?`<img src="${photos[0].thumb}" onclick="phOpenLightbox('${photos[0].id}',[${photos.map(p=>`'${p.id}'`).join(',')}])" style="width:44px;height:34px;object-fit:cover;border-radius:4px;cursor:pointer;flex-shrink:0;border:1px solid var(--border2)">`:'';
    const btns=isOpen
      ?`<div style="display:flex;gap:6px;flex-shrink:0">
          <button onclick="event.stopPropagation();clPunchlistGoto('${e.id}')" style="background:var(--s1);border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:10px;padding:5px 8px;border-radius:5px;cursor:pointer">📍 Map</button>
          <button onclick="event.stopPropagation();mapResolveTemporary('${e.id}')" style="background:rgba(39,174,96,0.15);border:1px solid var(--green,#27AE60);color:var(--green,#27AE60);font-family:var(--mono);font-size:10px;padding:5px 8px;border-radius:5px;cursor:pointer">✓ Fixed</button>
        </div>`
      :`<button onclick="event.stopPropagation();clPunchlistReopen('${e.id}')" style="background:var(--s1);border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:10px;padding:5px 8px;border-radius:5px;cursor:pointer;flex-shrink:0">↩ Reopen</button>`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--border)">
      ${thumb}
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--mono);font-size:12px;color:${isOpen?'var(--text)':'var(--muted)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isOpen?'🚩':'✓'} ${(e.tempLabel||'Repair').replace(/</g,'&lt;')}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${catName} · flagged ${e.date||''}${isOpen?'':(e.resolvedAt?` · fixed ${fmtWhen(e.resolvedAt)}`:'')}</div>
        ${(!isOpen&&e.resolveNote)?`<div style="font-family:var(--mono);font-size:10px;color:var(--green,#27AE60);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">→ ${String(e.resolveNote).replace(/</g,'&lt;')}</div>`:''}
      </div>
      ${btns}
    </div>`;
  };
  const openRows=open.map(e=>rowHtml(e,true)).join('');
  const resolvedBlock=resolved.length?`<div style="margin-top:6px">
    <div onclick="const b=this.nextElementSibling;const on=b.style.display==='none';b.style.display=on?'block':'none';this.querySelector('span:last-child').textContent=on?'▾':'▸'" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;padding:6px 4px;user-select:none">
      <span>Fixed history (${resolved.length})</span><span style="margin-left:auto">▸</span>
    </div>
    <div style="display:none">${resolved.map(e=>rowHtml(e,false)).join('')}</div>
  </div>`:'';
  el.innerHTML=`<div class="card">
    <div class="card-head"><span class="card-num">🚩</span><span class="card-title">Punchlist</span><span class="card-badge"${open.length?'':' style="opacity:.4"'}>${open.length} open</span></div>
    <div class="card-body" style="padding-top:4px">
      ${open.length?openRows:`<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:8px 4px">Nothing needs attention. Flag repairs from any drawing's popup on the map.</div>`}
      ${resolvedBlock}
    </div>
  </div>`;
  el.style.display='block';
}
// Jump from a punchlist row to its flag on the map (highlight pulls the eye).
function clPunchlistGoto(entryId){
  if(typeof showPage==='function') showPage('map');
  setTimeout(()=>{ if(typeof mapHighlightEntry==='function') mapHighlightEntry(entryId); },400);
}
function clPunchlistReopen(entryId){
  if(typeof trReopenTemporary==='function') trReopenTemporary(entryId);
  if(typeof mapRenderTrackerLayers==='function'){ try{ mapRenderTrackerLayers(); }catch{} }
  clRenderPunchlist();
}
if(typeof window!=='undefined'){
  window.clRenderPunchlist=clRenderPunchlist;
  window.clPunchlistGoto=clPunchlistGoto;
  window.clPunchlistReopen=clPunchlistReopen;
}

function clRenderTrackerCard(search){
  clRenderPunchlist();
  const el=document.getElementById('cl-tracker-card');
  if(!el) return;
  const today=new Date().toLocaleDateString('en-CA');
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  let entries=(typeof trGetEntriesForDate==='function')?trGetEntriesForDate(today,pid):[];
  if(search){
    entries=entries.filter(e=>
      (e.categoryName||'').toLowerCase().includes(search)||
      (e.location||'').toLowerCase().includes(search)||
      (e.notes||'').toLowerCase().includes(search)||
      (e.date||'').includes(search)||
      String(e.acres||'').includes(search)
    );
  }
  // Split totals: installed vs planned per category. Temporary/maintenance items
  // are provisional — excluded from all progress totals (they live on the punchlist).
  const _allProjEntries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid).filter(e=>!e.temporary):[];
  const _catMap={};
  _allProjEntries.forEach(e=>{
    const cid=e.categoryId||'__none';
    if(!_catMap[cid]){
      const mt=(typeof tcGetMeasurementType==='function')?tcGetMeasurementType(cid,pid):'area';
      const du=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):(mt==='linear'?'ft':'ac');
      _catMap[cid]={categoryId:e.categoryId,categoryName:e.categoryName||'Unknown',measType:mt,displayUnit:du,installedValue:0,plannedValue:0,entryCount:0};
    }
    const ev=e.measurementValue!==undefined?parseFloat(e.measurementValue):parseFloat(e.acres);
    const eu=e.measurementUnit||'ac';
    const norm=(ev&&!isNaN(ev)&&typeof tcConvertMeasurement==='function')?tcConvertMeasurement(ev,eu,_catMap[cid].displayUnit)||0:(isNaN(ev)?0:ev||0);
    if(e.entryType==='planned') _catMap[cid].plannedValue+=norm;
    else _catMap[cid].installedValue+=norm;
    _catMap[cid].entryCount++;
  });
  // Schema categories (stacked states) — the naive installed SUM double-counts
  // overlapping states (Lime + Fert on the same ground). Compute per-state totals
  // and a non-double-counted headline (overall % vs plan, or net for running-balance).
  Object.values(_catMap).forEach(t=>{
    const cat=(typeof tcGetCategory==='function')?tcGetCategory(t.categoryId,pid):null;
    if(!(cat&&Array.isArray(cat.states)&&cat.states.length)) return;
    t.isSchema=true;
    const mode=(typeof tcProgressMode==='function')?tcProgressMode(cat,pid):'per-state-vs-plan';
    const childStates=((typeof tcGetStates==='function')?tcGetStates(cat,pid):[]).filter(s=>!s.isPlanned);
    const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cat,pid):null;
    const stateTotal=(sid)=>_allProjEntries
      .filter(e=>(e.categoryId===t.categoryId)&&e.entryType!=='planned'&&((e.state||(dcs?dcs.id:null))===sid))
      .reduce((s,e)=>s+((typeof trEntryMeasure==='function')?trEntryMeasure(e,t.displayUnit,pid):0),0);
    t.stateTotals=childStates.map(s=>({label:s.label,color:s.color,value:stateTotal(s.id)}));
    if(mode==='running-balance'||mode==='running-total'){
      // Net per-state via turf (later state wins overlaps); open = Σ(add). Scalar fallback signs.
      const _inst=_allProjEntries.filter(e=>(e.categoryId===t.categoryId)&&e.entryType!=='planned'&&!e.temporary&&!e.deletedAt);
      const rt=_runningTotals(t.categoryId,_inst,childStates,t.displayUnit,pid,mode);
      t.stateTotals=childStates.map(s=>({label:s.label,color:s.color,value:rt.perState[s.id]||0}));
      t.headlineMode='area'; t.headlineVal=rt.open;
    } else if(t.plannedValue>0 && childStates.length){
      t.headlineMode='pct'; t.headlinePct=Math.min(100,(stateTotal(childStates[childStates.length-1].id)/t.plannedValue)*100);
    } else {
      t.headlineMode='area'; t.headlineVal=childStates.length?stateTotal(childStates[childStates.length-1].id):0;
    }
  });
  const splitTotals=Object.values(_catMap).filter(t=>t.entryCount>0).sort((a,b)=>b.installedValue-a.installedValue);
  if(!entries.length && !splitTotals.length){ el.style.display='none'; return; }

  const todayRows=entries.map(e=>{
    const catColor=(typeof tcGetColor==='function')?tcGetColor(e.categoryId,pid):'#888';
    const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown');
    const photoCount=Array.isArray(e.photoIds)?e.photoIds.length:0;
    const measDisplay=e.measurementValue!=null&&e.measurementUnit
      ?(typeof tcFormatMeasurement==='function'?tcFormatMeasurement(e.measurementValue,e.measurementUnit):`${e.measurementValue} ${e.measurementUnit}`)
      :(e.acres?`${e.acres} ac`:'');
    const isPlanned=e.entryType==='planned';
    return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:10px;padding:9px ${isPlanned?'3':'6'}px 9px 6px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:4px;${isPlanned?'border-left:3px solid var(--amber,#C9A84C);background:rgba(201,168,76,0.06)':''}">
      ${(typeof tcRampChip==='function')?tcRampChip(e.categoryId,pid,12):`<div style="width:12px;height:12px;border-radius:50%;background:${catColor};flex-shrink:0"></div>`}
      <span style="font-family:var(--mono);font-size:12px;color:var(--text);flex:1">${catName}${isPlanned?' <span style="font-family:var(--mono);font-size:9px;font-weight:700;color:var(--amber,#C9A84C);letter-spacing:.06em">PLAN</span>':''}</span>
      ${measDisplay?`<span style="font-family:var(--mono);font-size:12px;color:var(--muted)">${measDisplay}</span>`:''}
      ${photoCount?`<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">📷${photoCount}</span>`:''}
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">›</span>
    </div>`;
  }).join('');

  const todaySection=entries.length?`<div style="padding:0 4px 4px">${todayRows}</div>`:'';

  const _totHasPlan=splitTotals.some(t=>t.plannedValue>0);
  const _totCols=`1fr 34px 72px${_totHasPlan?' 68px':''}`;
  const _totHdrPlan=_totHasPlan?`<span style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;text-align:right">Planned</span>`:'';
  const totalsSection=splitTotals.length?`<div style="border-top:${entries.length?'2px solid var(--border2)':'none'};padding:10px 4px 4px">
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Project Totals</div>
    <div style="display:grid;grid-template-columns:${_totCols};gap:0 6px;padding:0 0 4px 18px;border-bottom:1px solid var(--border);margin-bottom:2px">
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Category</span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;text-align:right">Ent.</span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;text-align:right">${_totHasPlan?'Installed':'Total'}</span>
      ${_totHdrPlan}
    </div>
    ${splitTotals.map(t=>{
      const catColor=(typeof tcGetColor==='function')?tcGetColor(t.categoryId,pid):'#888';
      const fmt=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,t.displayUnit):`${v.toFixed(2)} ${t.displayUnit}`;
      const planCell=_totHasPlan?`<span style="font-family:var(--mono);font-size:11px;color:var(--muted);text-align:right;white-space:nowrap">${t.plannedValue>0?fmt(t.plannedValue):'—'}</span>`:'';
      // Headline: schema categories show overall % (or net) — not the double-counted sum.
      let instCell, instColor='var(--amber)';
      if(t.isSchema && t.headlineMode==='pct'){
        instColor=t.headlinePct>=100?'var(--green)':'var(--amber)';
        instCell=`${t.headlinePct.toFixed(0)}%`;
      } else if(t.isSchema){
        instCell=t.headlineVal>0?fmt(t.headlineVal):'—';
      } else {
        instCell=t.installedValue>0?fmt(t.installedValue):'—';
      }
      // Per-state glance chips (schema categories only).
      const chips=(t.isSchema&&Array.isArray(t.stateTotals)&&t.stateTotals.some(s=>s.value>0))
        ?`<div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 0 6px 18px;margin-top:-2px">
            ${t.stateTotals.map(s=>`<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:9px;color:var(--muted)"><span style="width:7px;height:7px;border-radius:2px;background:${(s.color&&/^#[0-9A-Fa-f]{6}$/.test(s.color))?s.color:'#888'}"></span>${s.label} ${fmt(s.value)}</span>`).join('')}
          </div>`:'';
      return `<div style="border-bottom:1px solid var(--border)">
        <div style="display:grid;grid-template-columns:${_totCols};gap:0 6px;padding:5px 0 ${chips?'2px':'5px'};align-items:center">
          <div style="display:flex;align-items:center;gap:6px;min-width:0">
            ${(typeof tcRampChip==='function')?tcRampChip(t.categoryId,pid,9):`<div style="width:8px;height:8px;border-radius:50%;background:${catColor};flex-shrink:0"></div>`}
            <span style="font-family:var(--mono);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.categoryName}</span>
          </div>
          <span style="font-family:var(--mono);font-size:11px;color:var(--muted);text-align:right">${t.entryCount}</span>
          <span style="font-family:var(--mono);font-size:11px;color:${instColor};font-weight:600;text-align:right;white-space:nowrap">${instCell}</span>
          ${planCell}
        </div>
        ${chips}
      </div>`;
    }).join('')}
  </div>`:'';

  el.innerHTML=`<div class="card">
    <div class="card-head"><span class="card-num">🗺️</span><span class="card-title">Today's Tracker Activity</span>${entries.length?`<span class="card-badge">${entries.length}</span>`:''}<button onclick="clShowTrackerLog()" style="margin-left:auto;background:none;border:none;color:var(--amber);font-family:var(--mono);font-size:11px;cursor:pointer;padding:2px 4px;letter-spacing:.04em">View All →</button></div>
    <div class="card-body" style="padding-top:4px">${todaySection}${totalsSection}</div>
  </div>`;
  el.style.display='block';
}

// ── Tracker entry detail modal (opened from compliance card rows) ──
function clShowTrackerDetail(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  const label=entry.categoryName||(typeof tcGetName==='function'?tcGetName(entry.categoryId,pid):'Unknown');
  const color=(typeof tcGetColor==='function')?tcGetColor(entry.categoryId,pid):'#888';
  const linkedPhotos=(entry.photoIds||[]).map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
  const photoStrip=linkedPhotos.map(p=>`
    <div style="position:relative;display:inline-block;flex-shrink:0">
      <img src="${p.thumb}" style="width:64px;height:48px;object-fit:cover;border-radius:4px;cursor:pointer;display:block" onclick="phOpenLightbox('${p.id}')">
      <button onclick="clUnlinkPhoto('${entryId}','${p.id}')" style="position:absolute;top:-5px;right:-5px;background:#c0392b;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;color:#fff;cursor:pointer;padding:0;line-height:16px;display:flex;align-items:center;justify-content:center">✕</button>
    </div>`).join('');
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:5000';
  ov.innerHTML=`<div class="modal-box" style="max-width:340px;width:90%">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <div style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div class="modal-title" style="margin:0">${label}</div>
    </div>
    <div style="font-family:var(--mono);font-size:12px;color:var(--text);display:flex;flex-direction:column;gap:7px;margin-bottom:14px">
      ${entry.date?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Date</span><div style="margin-top:2px">${entry.date}</div></div>`:''}
      ${(entry.measurementValue!=null&&entry.measurementUnit)?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">${entry.measurementType==='linear'?'Length':'Area'}</span><div style="margin-top:2px">${(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(entry.measurementValue,entry.measurementUnit):(entry.measurementValue+' '+entry.measurementUnit)}</div></div>`:entry.acres?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Area</span><div style="margin-top:2px">${entry.acres} acres</div></div>`:''}
      ${entry.location?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Location</span><div style="margin-top:2px">${entry.location}</div></div>`:''}
      ${entry.status?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">BMP Status</span><div style="margin-top:2px">${entry.status}</div></div>`:''}
      ${(entry.phase&&entry.phase!=='N/A')?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Application Phase</span><div style="margin-top:2px">${entry.phase}</div></div>`:''}
      ${(entry.method&&entry.method!=='N/A')?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Application Method</span><div style="margin-top:2px">${entry.method}</div></div>`:''}
      ${entry.contractor?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Contractor / Applicator</span><div style="margin-top:2px">${entry.contractor}</div></div>`:''}
      ${entry.notes?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Notes</span><div style="margin-top:2px;line-height:1.5">${entry.notes}</div></div>`:''}
      ${entry.fields?.seedTagCount!=null?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Seed Tags</span><div style="margin-top:2px">🏷️ ${entry.fields.seedTagCount}</div></div>`:''}
    </div>
    ${(()=>{
      const hasReq=entry.fields?.requiredAmount!=null;
      const hasAct=entry.fields?.actualAmount!=null;
      if(!hasReq&&!hasAct) return '';
      const req=entry.fields?.requiredAmount||0;
      const reqUnit=entry.fields?.requiredUnit||'lbs';
      const act=entry.fields?.actualAmount||0;
      const actUnit=entry.fields?.actualUnit||'lbs';
      const pct=(hasReq&&hasAct&&req>0)?Math.min(100,(act/req)*100):null;
      const bar=pct!=null?`<div style="margin-top:6px;height:6px;background:var(--border);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct.toFixed(1)}%;background:${pct>=100?'var(--green)':'var(--amber)'};border-radius:3px"></div></div><div style="font-family:var(--mono);font-size:10px;color:${pct>=100?'var(--green)':'var(--amber)'};text-align:right;margin-top:2px">${pct.toFixed(1)}%</div>`:'';
      return `<div style="background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px">
        ${hasReq?`<div style="font-family:var(--mono);font-size:10px;color:var(--muted)">Required <span style="color:var(--text)">${req.toLocaleString()} ${reqUnit}</span></div>`:''}
        ${hasAct?`<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px">Actual <span style="color:var(--text)">${act.toLocaleString()} ${actUnit}</span></div>`:''}
        ${bar}
      </div>`;
    })()}
    ${(()=>{
      if(entry.entryType!=='planned') return '';
      const children=(typeof trGetEntriesForProject==='function')
        ?trGetEntriesForProject(pid).filter(e=>e.parentId===entryId&&!e.deletedAt)
        :[];
      if(!children.length) return `<div style="font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px">No installations linked yet.</div>`;
      const totalAct=children.reduce((s,e)=>s+(e.fields?.actualAmount||0),0);
      const unit=children.find(e=>e.fields?.actualUnit)?.fields?.actualUnit||'lbs';
      const rows=children.map(e=>{
        const meas=e.measurementValue!=null?`${e.measurementValue} ${e.measurementUnit||'ac'}`:e.acres?`${e.acres} ac`:'';
        const act=e.fields?.actualAmount!=null?`${e.fields.actualAmount.toLocaleString()} ${e.fields.actualUnit||'lbs'}`:'';
        return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--border);cursor:pointer">
          <span style="font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0">${e.date||'—'}</span>
          <span style="font-family:var(--mono);font-size:10px;color:var(--text);flex:1">${meas}</span>
          ${act?`<span style="font-family:var(--mono);font-size:10px;color:var(--amber);flex-shrink:0">${act}</span>`:''}
          <span style="color:var(--muted);font-size:11px">›</span>
        </div>`;
      }).join('');
      return `<div style="margin-bottom:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
        <div style="display:flex;justify-content:space-between;padding:8px 10px;background:var(--s1)">
          <span style="font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Linked Installations</span>
          <span style="font-family:var(--mono);font-size:10px;color:var(--amber)">${totalAct>0?totalAct.toLocaleString()+' '+unit+' total':children.length+' linked'}</span>
        </div>
        ${rows}
      </div>`;
    })()}
    <div style="margin-bottom:14px">
      <span style="font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Photos</span>
      <div id="_cltr-photo-strip" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${photoStrip}</div>
      <button id="_cltrattach" style="margin-top:8px;background:none;border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-family:var(--mono);font-size:11px;color:var(--muted);cursor:pointer;width:100%;text-align:center">+ Attach Photo</button>
    </div>
    <div class="modal-btns" style="flex-wrap:wrap;gap:8px">
      <button class="modal-cancel" id="_cltrclose">Close</button>
      <button class="modal-cancel" id="_cltrdelete" style="color:#e74c3c">Delete</button>
      <button class="modal-confirm" id="_cltredit">Edit on Map</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  document.getElementById('_cltrclose').onclick=()=>ov.remove();
  document.getElementById('_cltrdelete').onclick=()=>{
    if(typeof trDeleteEntry==='function') trDeleteEntry(entryId,pid);
    ov.remove();
    const tlogOv=document.querySelector('._tlog-modal');
    if(tlogOv&&tlogOv._tlogRefresh) tlogOv._tlogRefresh();
    if(typeof mapRenderTrackerLayers==='function') mapRenderTrackerLayers();
    if(typeof mapUpdateKmlLayerList==='function') mapUpdateKmlLayerList();
    if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
  };
  document.getElementById('_cltrattach').onclick=()=>clShowPhotoAttachPicker(entryId);
  document.getElementById('_cltredit').onclick=()=>{
    ov.remove();
    // Also close the Tracker Log modal behind it, else the entry popup opens under it.
    document.querySelectorAll('.\_tlog-modal').forEach(el=>el.remove());
    if(typeof showPage==='function') showPage('map');
    setTimeout(()=>{
      if(typeof mapEditTrackerEntry==='function') mapEditTrackerEntry(entryId);
    },350);
  };
}

// ── Photo attach picker (opened from tracker detail modal) ──
function clShowPhotoAttachPicker(entryId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  const projectPhotos=(window._phPhotos||[]).filter(p=>!p.projectId||p.projectId===pid)
    .sort((a,b)=>b.date>a.date?1:b.date<a.date?-1:b.uploadedAt-a.uploadedAt);
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:6000';
  if(!projectPhotos.length){
    ov.innerHTML=`<div class="modal-box" style="max-width:300px;width:88%">
      <div class="modal-title" style="margin-bottom:10px">No Photos</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.5">Upload photos on the Photos page first, then attach them here.</div>
      <div class="modal-btns"><button class="modal-cancel" onclick="this.closest('.modal-overlay').remove()">OK</button></div>
    </div>`;
    document.body.appendChild(ov);
    return;
  }
  const linkedIds=new Set(entry.photoIds||[]);
  const thumbs=projectPhotos.map(p=>{
    const linked=linkedIds.has(p.id);
    return `<div id="clatph-${p.id}" onclick="clTogglePhotoLink('${entryId}','${p.id}',this)"
      style="position:relative;cursor:pointer;border-radius:6px;border:2px solid ${linked?'var(--amber)':'transparent'};overflow:hidden;flex-shrink:0;width:80px;height:60px">
      <img src="${p.thumb}" style="width:80px;height:60px;object-fit:cover;display:block">
      <div id="clatph-chk-${p.id}" style="position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;background:${linked?'var(--amber)':'rgba(0,0,0,.45)'};display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff">${linked?'✓':''}</div>
    </div>`;
  }).join('');
  ov.innerHTML=`<div class="modal-box" style="max-width:360px;width:92%;max-height:80vh;display:flex;flex-direction:column">
    <div class="modal-title" style="margin-bottom:12px">Attach Photos</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;flex:1;margin-bottom:12px">${thumbs}</div>
    <div class="modal-btns">
      <button class="modal-confirm" onclick="this.closest('.modal-overlay').remove()">Done</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}

function clTogglePhotoLink(entryId, photoId, el){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  const linked=entry&&Array.isArray(entry.photoIds)&&entry.photoIds.includes(photoId);
  if(linked){
    if(typeof trRemovePhotoLink==='function') trRemovePhotoLink(entryId,photoId,pid);
    el.style.borderColor='transparent';
    const chk=document.getElementById('clatph-chk-'+photoId);
    if(chk){chk.style.background='rgba(0,0,0,.45)';chk.textContent='';}
  } else {
    if(typeof trAddPhotoLink==='function') trAddPhotoLink(entryId,photoId,pid);
    el.style.borderColor='var(--amber)';
    const chk=document.getElementById('clatph-chk-'+photoId);
    if(chk){chk.style.background='var(--amber)';chk.textContent='✓';}
  }
  clRefreshDetailPhotoStrip(entryId);
}

function clUnlinkPhoto(entryId, photoId){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  if(typeof trRemovePhotoLink==='function') trRemovePhotoLink(entryId,photoId,pid);
  clRefreshDetailPhotoStrip(entryId);
  clRenderTrackerCard();
}

function clRefreshDetailPhotoStrip(entryId){
  const strip=document.getElementById('_cltr-photo-strip');
  if(!strip) return;
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const entry=(typeof trGetEntry==='function')?trGetEntry(entryId,pid):null;
  if(!entry) return;
  const linked=(entry.photoIds||[]).map(id=>(window._phPhotos||[]).find(p=>p.id===id)).filter(Boolean);
  strip.innerHTML=linked.map(p=>`
    <div style="position:relative;display:inline-block;flex-shrink:0">
      <img src="${p.thumb}" style="width:64px;height:48px;object-fit:cover;border-radius:4px;cursor:pointer;display:block" onclick="phOpenLightbox('${p.id}')">
      <button onclick="clUnlinkPhoto('${entryId}','${p.id}')" style="position:absolute;top:-5px;right:-5px;background:#c0392b;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;color:#fff;cursor:pointer;padding:0;line-height:16px;display:flex;align-items:center;justify-content:center">✕</button>
    </div>`).join('');
  clRenderTrackerCard();
}

// Net per-state areas + open total for running-balance/running-total categories.
// Uses the turf net-area engine (geo.js) when the category is area-type with polygon
// geometry — a LATER state wins overlaps, so per-state areas are the CURRENT (net) area
// in each state, never double-counted (stabilizing carves ground out of "active"). Falls
// back to gross scalar sums (signed by countMode) when geometry isn't usable (e.g. linear).
function _runningTotals(cid, instEntries, childStates, defUnit, pid, mode){
  const measType=(typeof tcGetMeasurementType==='function')?tcGetMeasurementType(cid,pid):'area';
  const perState={}; let geoOk=false;
  if(measType==='area' && typeof glStateNetAreasM2==='function'){
    const g=glStateNetAreasM2(instEntries, childStates);
    if(g){
      geoOk=true;
      childStates.forEach(s=>{ perState[s.id]=(typeof glAreaConvertM2==='function')?glAreaConvertM2(g.netM2[s.id]||0, defUnit):0; });
    }
  }
  if(!geoOk){
    const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cid,pid):null;
    const measure=(e)=>(typeof trEntryMeasure==='function')?trEntryMeasure(e,defUnit,pid):0;
    childStates.forEach(s=>{ perState[s.id]=instEntries.filter(e=>(e.state||(dcs?dcs.id:null))===s.id).reduce((a,e)=>a+measure(e),0); });
  }
  let open=0;
  childStates.forEach((s,idx)=>{
    const cm=(typeof tcStateCountMode==='function')?tcStateCountMode(s,idx,childStates,mode):'add';
    const v=perState[s.id]||0;
    // Geo net already carves stabilized ground out of the add-states → open = Σ(add).
    // Scalar fallback can't, so it compensates by subtracting the subtract-states.
    if(geoOk){ if(cm==='add') open+=v; }
    else { if(cm==='add') open+=v; else if(cm==='subtract') open-=v; }
  });
  return { perState, open:Math.max(0,open), geoOk };
}

// Per-state progress bars for schema categories (states + templates, 2026-06-03).
// per-state-vs-plan → one bar per non-planned state vs the planned total + overall (terminal %).
// running-balance/-total → net open disturbance (turf geometry) vs editable cap, warns when over.
function _catStateBars(cid, g, pid){
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(cid,pid):null;
  if(!cat) return '';
  const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ac';
  const mode=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'per-state-vs-plan';
  const states=(typeof tcGetStates==='function')?tcGetStates(cat,pid):[];
  const childStates=states.filter(s=>!s.isPlanned);
  if(!childStates.length) return '';
  // Temporary/maintenance items are provisional — never counted in progress bars.
  const planned=g.entries.filter(e=>e.entryType==='planned'&&!e.temporary);
  const installed=g.entries.filter(e=>e.entryType!=='planned'&&!e.temporary);
  const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cat,pid):null;
  const measure=(e)=>(typeof trEntryMeasure==='function')?trEntryMeasure(e,defUnit,pid):0;
  const fmt=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,defUnit):`${(v||0).toFixed(2)} ${defUnit}`;
  const planTotal=planned.reduce((s,e)=>s+measure(e),0);
  const stateTotal=(sid)=>installed.filter(e=>(e.state||(dcs?dcs.id:null))===sid).reduce((s,e)=>s+measure(e),0);

  if(mode==='running-balance'||mode==='running-total'){
    // Net per-state areas via turf (geo.js) — later state wins overlaps, so each state
    // shows its CURRENT area; open = Σ(add). Scalar fallback signs by countMode.
    const rt=_runningTotals(cid, installed, childStates, defUnit, pid, mode);
    const chips=childStates.map((st,idx)=>{
      const v=rt.perState[st.id]||0;
      if(v<=0) return '';
      const cm=(typeof tcStateCountMode==='function')?tcStateCountMode(st,idx,childStates,mode):'add';
      const c=(st.color&&/^#[0-9A-Fa-f]{6}$/.test(st.color))?st.color:'var(--muted)';
      // Net mode shows current areas (no signs); scalar fallback keeps +/− to convey the math.
      const sign=rt.geoOk?'':(cm==='add'?'+':(cm==='subtract'?'−':'·'));
      const scol=cm==='add'?'var(--text)':(cm==='subtract'?'var(--green,#27AE60)':'var(--muted)');
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:9px;color:${scol}"><span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${c}"></span>${st.label}: ${sign}${fmt(v)}</span>`;
    }).filter(Boolean).join('');
    const net=rt.open;
    const cap=cat.disturbanceCap;
    const over=cap!=null&&net>cap;
    const pct=cap!=null&&cap>0?Math.min(100,(net/cap)*100):(net>0?100:0);
    const color=over?'#e74c3c':(net>0?'var(--amber)':'var(--muted)');
    const headLabel=mode==='running-total'?'Disturbed (cumulative)':'Open disturbed';
    const capText=cap!=null?` / ${fmt(cap)} limit`:'';
    return `<div style="padding:6px 16px 8px;background:var(--s1)">
      <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--muted);margin-bottom:3px">
        <span>${headLabel}: <b style="color:${color}">${fmt(net)}</b>${capText}</span>
        ${over?`<span style="color:#e74c3c;font-weight:700">⚠ OVER LIMIT</span>`:(cap!=null?`<span style="color:${color}">${pct.toFixed(0)}%</span>`:'')}
      </div>
      ${cap!=null?`<div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div style="height:100%;width:${pct.toFixed(1)}%;background:${color};border-radius:2px"></div></div>`:''}
      ${chips?`<div style="display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px">${chips}</div>`:''}
    </div>`;
  }

  // per-state-vs-plan / simple-count: bar per state + overall
  const rows=childStates.map(st=>{
    const tot=stateTotal(st.id);
    if(tot<=0 && planTotal<=0) return '';
    const pct=planTotal>0?Math.min(100,(tot/planTotal)*100):null;
    const col=(st.color&&/^#[0-9A-Fa-f]{6}$/.test(st.color))?st.color:'var(--amber)';
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
      <span style="width:8px;height:8px;border-radius:2px;background:${col};flex-shrink:0"></span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${st.label}: ${fmt(tot)}${planTotal>0?` / ${fmt(planTotal)}`:''}</span>
      ${pct!=null?`<span style="font-family:var(--mono);font-size:9px;color:${col};flex-shrink:0">${pct.toFixed(0)}%</span>`:''}
      <div style="width:54px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;flex-shrink:0"><div style="height:100%;width:${pct!=null?pct.toFixed(1):0}%;background:${col};border-radius:2px"></div></div>
    </div>`;
  }).filter(Boolean).join('');
  if(!rows) return '';
  let overall='';
  if(planTotal>0){
    const overMode=(typeof tcOverallMode==='function')?tcOverallMode(cid,pid):'terminal';
    let opct;
    if(overMode==='average'){
      const ps=childStates.map(st=>Math.min(100,(stateTotal(st.id)/planTotal)*100));
      opct=ps.length?ps.reduce((a,b)=>a+b,0)/ps.length:0;
    } else {
      opct=Math.min(100,(stateTotal(childStates[childStates.length-1].id)/planTotal)*100);
    }
    const ocol=opct>=100?'var(--green)':'var(--amber)';
    overall=`<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--text);margin-top:4px;padding-top:4px;border-top:1px solid var(--border)"><span>Overall complete</span><span style="color:${ocol};font-weight:700">${opct.toFixed(0)}%</span></div>`;
  }
  return `<div style="padding:6px 16px 8px;background:var(--s1)">${rows}${overall}</div>`;
}

// ── Tracker Log modal ── full searchable database of all tracker entries
function clShowTrackerLog(){
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  function _getEntries(){
    return (typeof trGetEntriesForProject==='function')
      ? trGetEntriesForProject(pid).filter(e=>!e.deletedAt&&!e.archivedFromMap)
      : [];
  }

  let _tlSearch='';
  let _tlCat='';
  let _tlFrom='';
  let _tlTo='';
  const _tlCollapsed=new Set();   // category ids collapsed in the grouped view

  const initCats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];
  const chipHtml=[
    `<button class="_tlog-chip active" data-cat="">All</button>`,
    ...initCats.map(c=>`<button class="_tlog-chip" data-cat="${c.id}">${c.name}</button>`)
  ].join('');

  const ov=document.createElement('div');
  ov.className='modal-overlay _tlog-modal';
  ov.style.cssText='z-index:4500;align-items:flex-end;padding:0';
  ov.innerHTML=`
    <div style="width:100%;max-height:92dvh;background:var(--bg);border-top:1px solid var(--border);border-radius:16px 16px 0 0;display:flex;flex-direction:column;overflow:hidden;padding-bottom:env(safe-area-inset-bottom)">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
        <span style="font-family:var(--cond);font-weight:700;font-size:15px;letter-spacing:.06em;text-transform:uppercase;flex:1">Tracker Log</span>
        <button id="_tlog-export" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--amber);font-family:var(--mono);font-size:11px;padding:7px 12px;cursor:pointer;min-height:36px">⬇ Export</button>
        <button id="_tlog-close" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center">✕</button>
      </div>
      <!-- Search -->
      <div style="padding:10px 16px 8px;flex-shrink:0">
        <input type="text" id="_tlog-search" placeholder="🔍 Search category, location, notes, date…" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--body);font-size:16px;padding:8px 12px;outline:none;transition:border-color .15s">
      </div>
      <!-- Category chips -->
      <div id="_tlog-chips" style="display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;padding:0 16px 10px;flex-shrink:0;scrollbar-width:none">${chipHtml}</div>
      <!-- Date range -->
      <div style="display:flex;gap:8px;align-items:center;padding:0 16px 10px;flex-shrink:0">
        <span style="font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap">From</span>
        <input type="date" id="_tlog-from" style="flex:1;min-width:0;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:16px;padding:5px 8px;min-height:36px;box-sizing:border-box">
        <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">to</span>
        <input type="date" id="_tlog-to" style="flex:1;min-width:0;background:var(--s1);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--mono);font-size:16px;padding:5px 8px;min-height:36px;box-sizing:border-box">
        <button id="_tlog-clear-dates" style="background:none;border:none;color:var(--amber);font-family:var(--mono);font-size:10px;cursor:pointer;padding:4px 6px;white-space:nowrap">Clear</button>
      </div>
      <!-- Results -->
      <div id="_tlog-results" style="flex:1;overflow-y:auto;border-top:1px solid var(--border)"></div>
      <!-- Footer -->
      <div id="_tlog-footer" style="padding:8px 16px;border-top:1px solid var(--border);flex-shrink:0;font-family:var(--mono);font-size:10px;color:var(--muted);text-align:center"></div>
    </div>
  `;
  document.body.appendChild(ov);
  ov._tlogRefresh = () => _tlogRender();

  function _tlogFilter(){
    return _getEntries().filter(e=>{
      if(_tlCat && e.categoryId!==_tlCat) return false;
      if(_tlFrom && e.date<_tlFrom) return false;
      if(_tlTo && e.date>_tlTo) return false;
      if(_tlSearch){
        const s=_tlSearch;
        if(!(
          (e.categoryName||'').toLowerCase().includes(s)||
          (e.location||'').toLowerCase().includes(s)||
          (e.notes||'').toLowerCase().includes(s)||
          (e.date||'').includes(s)||
          String(e.acres||'').includes(s)
        )) return false;
      }
      return true;
    }).sort((a,b)=>{
      // Planned (the baseline) pins to the top of its category; then by date desc.
      const ap=a.entryType==='planned'?0:1, bp=b.entryType==='planned'?0:1;
      if(ap!==bp) return ap-bp;
      return b.date>a.date?1:b.date<a.date?-1:0;
    });
  }

  function _tlogRender(){
    const entries=_tlogFilter();
    const liveCats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];
    const totalPhotos=entries.reduce((s,e)=>s+(Array.isArray(e.photoIds)?e.photoIds.length:0),0);
    const res=document.getElementById('_tlog-results');
    const foot=document.getElementById('_tlog-footer');

    if(!entries.length){
      res.innerHTML=`<div style="font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center;padding:40px 20px">No entries match.</div>`;
      foot.textContent='';
      return;
    }

    // Category-chip filter still renders grouped (category header + ramp chip on top,
    // state-colored rows below) — only free-text search / date-range go flat.
    const isGrouped=!_tlSearch&&!_tlFrom&&!_tlTo;

    if(isGrouped){
      // Group by category, newest entry first within each group
      const order=[];
      const groups={};
      entries.forEach(e=>{
        const cid=e.categoryId||'_unknown';
        if(!groups[cid]){
          const cached=liveCats.find(c=>c.id===cid);
          const name=cached?cached.name:(e.categoryName&&!e.categoryName.startsWith('cat-')?e.categoryName:'Unknown');
          const cat=cached||{id:cid,name,color:'#888'};
          groups[cid]={cat,entries:[]};
          order.push(cid);
        }
        groups[cid].entries.push(e);
      });
      res.innerHTML=order.map(cid=>{
        const g=groups[cid];
        const _installed=g.entries.filter(e=>e.entryType!=='planned'&&!e.temporary);
        // Category total respects the category's measurement type + default unit
        // (linear → ft, area → ac, etc.) — never assume acres. Converts each entry
        // into the category default unit before summing.
        const _metaType=(typeof tcGetMeasurementType==='function')?tcGetMeasurementType(cid,pid):'area';
        const _metaUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):(_metaType==='linear'?'ft':'ac');
        const _sumMeas=(arr)=>arr.reduce((s,e)=>{
          const v=parseFloat(e.measurementValue);
          if(!isNaN(v)) return s+((typeof tcConvertMeasurement==='function')?(tcConvertMeasurement(v,e.measurementUnit||_metaUnit,_metaUnit)??v):v);
          if(_metaType!=='linear'&&e.acres) return s+(parseFloat(e.acres)||0); // legacy area fallback
          return s;
        },0);
        // Schema categories (stacked states): the category-row total should read the
        // PLAN (one figure), not the sum of every state overlay — Lime+Fert+Seed on the
        // same ground would otherwise inflate it. Legacy categories keep the installed sum.
        const _catObjMeta=(typeof tcGetCategory==='function')?tcGetCategory(cid,pid):null;
        const _isSchemaMeta=!!(_catObjMeta&&Array.isArray(_catObjMeta.states)&&_catObjMeta.states.length);
        const _metaTotal=_isSchemaMeta
          ?_sumMeas(g.entries.filter(e=>e.entryType==='planned'&&!e.temporary))
          :_sumMeas(_installed);
        const _metaTotalText=_metaTotal>0?((typeof tcFormatMeasurement==='function')?tcFormatMeasurement(_metaTotal,_metaUnit):`${_metaTotal.toFixed(2)} ${_metaUnit}`):'';
        // Disturbance (running-balance/total): list each drawing's NET area (its current
        // contribution after later states carve it) — matches the bar/legend/export. The
        // gross drawn size is misleading once stabilization is drawn on top.
        const _runMode=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'';
        const _isRunning=_runMode==='running-balance'||_runMode==='running-total';
        const _entryNet=(_isRunning && _metaType==='area' && typeof glEntryNetAreasM2==='function')
          ?glEntryNetAreasM2(_installed, (_catObjMeta&&Array.isArray(_catObjMeta.states))?_catObjMeta.states.filter(s=>!s.isPlanned):[])
          :null;
        const gPhotos=_installed.reduce((s,e)=>s+(Array.isArray(e.photoIds)?e.photoIds.length:0),0);
        const gSeeds=_installed.reduce((s,e)=>s+(e.fields?.seedTagCount||0),0);
        const gReports=_installed.reduce((s,e)=>s+(Array.isArray(e.reportIds)?e.reportIds.length:0),0);
        const rows=g.entries.map(e=>{
          const pc=Array.isArray(e.photoIds)?e.photoIds.length:0;
          const rc=Array.isArray(e.reportIds)?e.reportIds.length:0;
          const stc=e.fields?.seedTagCount||0;
          const hasAct=e.fields?.actualAmount!=null;
          const hasReq=e.fields?.requiredAmount!=null;
          let amtText=hasAct&&hasReq
            ?`${e.fields.actualAmount.toLocaleString()} / ${e.fields.requiredAmount.toLocaleString()} ${e.fields.requiredUnit||'lbs'}`
            :hasAct?`${e.fields.actualAmount.toLocaleString()} ${e.fields.actualUnit||'lbs'} used`
            :hasReq?`${e.fields.requiredAmount.toLocaleString()} ${e.fields.requiredUnit||'lbs'} req.`:'';
          const rowMeas=(()=>{
            // Disturbance: show this drawing's NET area (current, after overlaps), not gross.
            if(_entryNet && e.entryType!=='planned' && _entryNet[e.id]!=null){
              const nv=(typeof glAreaConvertM2==='function')?glAreaConvertM2(_entryNet[e.id],_metaUnit):0;
              const txt=(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(nv,_metaUnit):`${nv.toFixed(2)} ${_metaUnit}`;
              return `<span style="font-family:var(--mono);font-size:10px;color:var(--amber);white-space:nowrap;flex-shrink:0">${txt}</span>`;
            }
            if(e.measurementValue!=null&&e.measurementUnit)
              return `<span style="font-family:var(--mono);font-size:10px;color:var(--amber);white-space:nowrap;flex-shrink:0">${(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(e.measurementValue,e.measurementUnit):(e.measurementValue+' '+e.measurementUnit)}</span>`;
            if(e.acres) return `<span style="font-family:var(--mono);font-size:10px;color:var(--amber);white-space:nowrap;flex-shrink:0">${e.acres} ac</span>`;
            return '';
          })();
                const isPlannedRow=e.entryType==='planned';
          const planBadge=isPlannedRow?`<span style="font-family:var(--mono);font-size:9px;font-weight:700;color:var(--amber);white-space:nowrap;flex-shrink:0;letter-spacing:.06em">PLAN</span>`:'';
          // State badge (child overlays of schema categories) — colored dot + label.
          const stBadge=(()=>{
            if(isPlannedRow) return '';
            const st=(typeof tcEntryState==='function')?tcEntryState(e,e.categoryId||e.category,pid):null;
            if(!st||!st.label) return '';
            const col=(st.color&&/^#[0-9A-Fa-f]{6}$/.test(st.color))?st.color:'var(--muted)';
            return `<span style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0;font-family:var(--mono);font-size:9px;color:var(--muted);white-space:nowrap"><span style="width:7px;height:7px;border-radius:2px;background:${col}"></span>${st.label}</span>`;
          })();
          // For linear entries, show measurement context in middle column. Disturbance
          // (running) shows its NET area in rowMeas instead, so skip the gross middle text.
          if(!amtText&&e.measurementValue!=null&&e.measurementUnit&&!_isRunning){
            const fv=parseFloat(e.measurementValue);
            if(!isNaN(fv)){
              if(isPlannedRow){
                amtText=`📍 ${fv.toLocaleString()} ${e.measurementUnit} planned`;
              } else if(e.parentId){
                // Running-balance/total (disturbance) has NO plan — don't show "X / parent"
                // (that framed the first drawing as a total). Just show this drawing's own area.
                const _pm=(typeof tcProgressMode==='function')?tcProgressMode(e.categoryId||e.category,pid):'';
                const _running=_pm==='running-balance'||_pm==='running-total';
                const par=(!_running && typeof trGetEntry==='function')?trGetEntry(e.parentId,pid):null;
                if(par?.measurementValue!=null) amtText=`${fv.toLocaleString()} / ${parseFloat(par.measurementValue).toLocaleString()} ${par.measurementUnit||e.measurementUnit}`;
                else amtText=`${fv.toLocaleString()} ${e.measurementUnit}`;
              }
            }
          }
          return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:8px;padding:9px 16px 9px ${isPlannedRow?'27':'30'}px;border-top:1px solid var(--border);cursor:pointer;${isPlannedRow?'border-left:3px solid var(--amber);background:rgba(201,168,76,0.06)':''}">
            <span style="font-family:var(--mono);font-size:10px;color:var(--text);white-space:nowrap;flex-shrink:0;min-width:68px">${e.date||'—'}</span>
            ${planBadge}
            ${stBadge}
            <span style="font-family:var(--mono);font-size:11px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${amtText}</span>
            ${rowMeas}
            ${pc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">📷 ${pc}</span>`:''}
            ${stc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">🏷️ ${stc}</span>`:''}
            ${rc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">📋 ${rc}</span>`:''}
            <span style="color:var(--muted);flex-shrink:0;font-size:12px">›</span>
          </div>`;
        }).join('');
        const meta=[_metaTotalText,gPhotos>0?`📷 ${gPhotos}`:'',gSeeds>0?`🏷️ ${gSeeds}`:'',gReports>0?`📋 ${gReports}`:'',`${_installed.length} ${_installed.length===1?'entry':'entries'}`].filter(Boolean).join(' · ');
        // Cumulative actual vs required bar — only when entries share the same actual unit
        const catBar=(()=>{
          // Schema categories (custom states/templates) → per-state bars; legacy → existing material/linear bar.
          const _catObj=(typeof tcGetCategory==='function')?tcGetCategory(cid,pid):null;
          if(_catObj&&Array.isArray(_catObj.states)&&_catObj.states.length) return _catStateBars(cid,g,pid);
          const catMeasType=(typeof tcGetMeasurementType==='function')?tcGetMeasurementType(cid,pid):'area';
          if(catMeasType==='linear'){
            const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ft';
            const plannedLin=g.entries.filter(e=>e.entryType==='planned'&&e.measurementValue!=null);
            const installedLin=g.entries.filter(e=>e.entryType!=='planned'&&e.measurementValue!=null);
            if(!plannedLin.length&&!installedLin.length) return '';
            const conv=(e)=>{
              const v=parseFloat(e.measurementValue);
              if(isNaN(v)) return 0;
              return (typeof tcConvertMeasurement==='function')?tcConvertMeasurement(v,e.measurementUnit||defUnit,defUnit)||0:v;
            };
            const totalPlan=plannedLin.reduce((s,e)=>s+conv(e),0);
            const totalInst=installedLin.reduce((s,e)=>s+conv(e),0);
            if(totalPlan<=0&&totalInst<=0) return '';
            const pct=totalPlan>0?Math.min(100,(totalInst/totalPlan)*100):0;
            const color=pct>=100?'var(--green)':totalInst>0?'var(--amber)':'var(--muted)';
            return `<div style="padding:4px 16px 8px;background:var(--s1)">
              <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--muted);margin-bottom:3px">
                <span>Installed: ${totalInst.toLocaleString()} / ${totalPlan.toLocaleString()} ${defUnit}</span>
                <span style="color:${color}">${pct.toFixed(1)}%</span>
              </div>
              <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden">
                <div style="height:100%;width:${pct.toFixed(1)}%;background:${color};border-radius:2px"></div>
              </div>
            </div>`;
          }
          // Area: use planned entries' requiredAmount as denominator; fall back to installed actual/required if no plan
          const plannedArea=g.entries.filter(e=>e.entryType==='planned'&&e.fields?.requiredAmount!=null);
          const installedArea=g.entries.filter(e=>e.entryType!=='planned'&&e.fields?.actualAmount!=null);
          const hasPlan=plannedArea.length>0;
          const withBoth=hasPlan?[]:g.entries.filter(e=>e.fields?.actualAmount!=null&&e.fields?.requiredAmount!=null);
          if(!hasPlan&&!withBoth.length) return '';
          const units=hasPlan
            ?[...new Set(plannedArea.map(e=>e.fields?.requiredUnit||'lbs'))]
            :[...new Set(withBoth.map(e=>e.fields.actualUnit||'lbs'))];
          if(units.length>1) return ''; // mixed units — skip
          const totalReq=hasPlan
            ?plannedArea.reduce((s,e)=>s+(e.fields.requiredAmount||0),0)
            :withBoth.reduce((s,e)=>s+(e.fields.requiredAmount||0),0);
          const totalAct=hasPlan
            ?installedArea.reduce((s,e)=>s+(e.fields.actualAmount||0),0)
            :withBoth.reduce((s,e)=>s+(e.fields.actualAmount||0),0);
          if(totalReq<=0) return '';
          const pct=Math.min(100,(totalAct/totalReq)*100);
          const color=pct>=100?'var(--green)':'var(--amber)';
          const unit=units[0];
          return `<div style="padding:4px 16px 8px;background:var(--s1)">
            <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--muted);margin-bottom:3px">
              <span>Applied: ${totalAct.toLocaleString()} / ${totalReq.toLocaleString()} ${unit}</span>
              <span style="color:${color}">${pct.toFixed(1)}%</span>
            </div>
            <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${pct.toFixed(1)}%;background:${color};border-radius:2px"></div>
            </div>
          </div>`;
        })();
        const collapsed=_tlCollapsed.has(cid);
        return `<div style="border-bottom:1px solid var(--border)">
          <div class="_tlog-cat-head" data-cat="${cid}" style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--s1);cursor:pointer">
            ${(typeof tcRampChip==='function')?tcRampChip(cid,pid,11):`<div style="width:10px;height:10px;border-radius:50%;background:${g.cat.color};flex-shrink:0"></div>`}
            <span style="font-family:var(--cond);font-weight:700;font-size:13px;letter-spacing:.04em;flex:1">${g.cat.name}</span>
            <span style="font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap">${meta}</span>
            <span style="color:var(--muted);font-size:11px;display:inline-block;transition:transform .15s;transform:rotate(${collapsed?'0':'90'}deg)">▸</span>
          </div>
          <div style="display:${collapsed?'none':'block'}">
            ${catBar}
            ${rows}
          </div>
        </div>`;
      }).join('');
      // Re-attach header toggle listeners after each render (innerHTML wipes them).
      res.querySelectorAll('._tlog-cat-head').forEach(h=>{
        h.addEventListener('click',()=>{
          const cid=h.dataset.cat;
          if(_tlCollapsed.has(cid)) _tlCollapsed.delete(cid); else _tlCollapsed.add(cid);
          _tlogRender();
        });
      });
    } else {
      // Flat list — search/filter active
      res.innerHTML=entries.map(e=>{
        const cached=liveCats.find(c=>c.id===e.categoryId);
        const catName=cached?cached.name:(e.categoryName&&!e.categoryName.startsWith('cat-')?e.categoryName:'Unknown');
        const cat=cached||{color:'#888',name:catName};
        // Individual drawing rows show their own STATE color — the ramp chip belongs only
        // on the category header (grouped view), never on every row.
        const _flatSt=(typeof tcEntryState==='function')?tcEntryState(e,e.categoryId||e.category,pid):null;
        const _flatDot=(_flatSt&&_flatSt.color&&/^#[0-9A-Fa-f]{6}$/.test(_flatSt.color))?_flatSt.color:cat.color;
        const pc=Array.isArray(e.photoIds)?e.photoIds.length:0;
        const rc=Array.isArray(e.reportIds)?e.reportIds.length:0;
        const stc=e.fields?.seedTagCount||0;
        const hasActF=e.fields?.actualAmount!=null;
        const hasReqF=e.fields?.requiredAmount!=null;
        const amtTextF=hasActF&&hasReqF
          ?`${e.fields.actualAmount.toLocaleString()} / ${e.fields.requiredAmount.toLocaleString()} ${e.fields.requiredUnit||'lbs'}`
          :hasActF?`${e.fields.actualAmount.toLocaleString()} ${e.fields.actualUnit||'lbs'} used`
          :hasReqF?`${e.fields.requiredAmount.toLocaleString()} ${e.fields.requiredUnit||'lbs'} req.`:'';
        const sub=[e.date||'',amtTextF].filter(Boolean).join(' · ');
        const flatMeas=(e.measurementValue!=null&&e.measurementUnit)
          ?`<span style="font-family:var(--mono);font-size:11px;color:var(--amber);white-space:nowrap;flex-shrink:0">${(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(e.measurementValue,e.measurementUnit):(e.measurementValue+' '+e.measurementUnit)}</span>`
          :e.acres?`<span style="font-family:var(--mono);font-size:11px;color:var(--amber);white-space:nowrap;flex-shrink:0">${e.acres} ac</span>`:'';
        const isPlannedFlat=e.entryType==='planned';
        return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:10px;padding:10px ${isPlannedFlat?'13':'16'}px;border-bottom:1px solid var(--border);cursor:pointer;${isPlannedFlat?'border-left:3px solid var(--amber);background:rgba(201,168,76,0.06)':''}">
          <div style="width:10px;height:10px;border-radius:50%;background:${_flatDot};flex-shrink:0"></div>
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--mono);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cat.name}${isPlannedFlat?' <span style="font-family:var(--mono);font-size:9px;font-weight:700;color:var(--amber);letter-spacing:.06em">PLAN</span>':''}</div>
            <div style="font-family:var(--mono);font-size:10px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub.slice(0,52)}</div>
          </div>
          ${flatMeas}
          ${pc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">📷 ${pc}</span>`:''}
          ${stc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">🏷️ ${stc}</span>`:''}
          ${rc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">📋 ${rc}</span>`:''}
          <span style="color:var(--muted);flex-shrink:0;font-size:12px">›</span>
        </div>`;
      }).join('');
    }

    const all=_getEntries();
    const parts=[`${entries.length} ${entries.length===1?'entry':'entries'}`];
    // No cross-category measurement total — categories use different units (ac vs ft),
    // so summing them into one acreage number is meaningless. Per-category totals
    // live in each group header instead.
    if(totalPhotos>0) parts.push(`📷 ${totalPhotos}`);
    if(entries.length<all.length) parts.push(`of ${all.length} total`);
    foot.textContent=parts.join(' · ');
  }

  _tlogRender();

  // Chip handlers
  ov.querySelectorAll('._tlog-chip').forEach(btn=>{
    btn.addEventListener('click',()=>{
      _tlCat=btn.dataset.cat;
      ov.querySelectorAll('._tlog-chip').forEach(b=>b.classList.toggle('active',b.dataset.cat===_tlCat));
      _tlogRender();
    });
  });

  document.getElementById('_tlog-search').addEventListener('input',e=>{
    _tlSearch=e.target.value.toLowerCase().trim();
    _tlogRender();
  });
  document.getElementById('_tlog-from').addEventListener('change',e=>{_tlFrom=e.target.value;_tlogRender();});
  document.getElementById('_tlog-to').addEventListener('change',e=>{_tlTo=e.target.value;_tlogRender();});
  document.getElementById('_tlog-clear-dates').addEventListener('click',()=>{
    document.getElementById('_tlog-from').value='';
    document.getElementById('_tlog-to').value='';
    _tlFrom=''; _tlTo='';
    _tlogRender();
  });
  document.getElementById('_tlog-close').onclick=()=>ov.remove();

  // Export — opens scheme picker modal
  document.getElementById('_tlog-export').onclick=()=>_showTlogExportModal(_tlogFilter, pid);
}

// ── Download or share a blob — native iOS uses Capacitor Share, web uses blob link ──
async function _glShareOrDownload(blob, filename, mimeType){
  if(window.Capacitor?.isNativePlatform?.()){
    try{
      const [{Filesystem,Directory},{Share}]=await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ]);
      // Convert blob → base64
      const buf=await blob.arrayBuffer();
      const bytes=new Uint8Array(buf);
      let bin='';
      for(let i=0;i<bytes.byteLength;i++) bin+=String.fromCharCode(bytes[i]);
      const b64=btoa(bin);
      // Write to cache
      const tempPath=`gl_exports/${filename}`;
      await Filesystem.writeFile({path:tempPath,data:b64,directory:Directory.Cache,recursive:true});
      const {uri}=await Filesystem.getUri({path:tempPath,directory:Directory.Cache});
      await Share.share({title:filename,files:[uri]});
      // Clean up (best-effort)
      try{await Filesystem.deleteFile({path:tempPath,directory:Directory.Cache});}catch{}
      return;
    }catch(e){ console.warn('Capacitor Share failed:',e.message); }
  }
  // Web fallback
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Tracker log export — scheme picker modal ──
// Per-category deliverables: pick one OR MORE categories — they combine into a single
// report workbook (a tab per category: SWPPP/net sheet for disturbance, coverage-vs-plan
// sheet for seeding). The current filter scopes which entries go in.
function _showTlogExportModal(getEntries, pid){
  const entries=getEntries();
  // Distinct categories present in the filtered set, first-seen order.
  const seen=new Set(); const cats=[];
  entries.forEach(e=>{
    const cid=e.categoryId; if(!cid||seen.has(cid)) return; seen.add(cid);
    const mode=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'';
    const isRunning=mode==='running-balance'||mode==='running-total';
    const name=e.categoryName||((typeof tcGetName==='function')?tcGetName(cid,pid):'Category');
    const n=entries.filter(x=>x.categoryId===cid).length;
    cats.push({cid,name,isRunning,n,
      type:isRunning?'SWPPP · net disturbed':'Coverage · vs plan',
      icon:isRunning?'🟧':'🌱'});
  });

  const selected=new Set();
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9500';
  const rowBase='display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:12px 14px;border-radius:8px;cursor:pointer;border:2px solid var(--border);background:var(--s1);transition:border-color .15s';
  const rowOn ='display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:12px 14px;border-radius:8px;cursor:pointer;border:2px solid var(--amber);background:var(--s1);transition:border-color .15s';

  const render=()=>{
    const nSel=selected.size;
    ov.innerHTML=`
      <div class="modal-box" style="max-width:360px;width:92%">
        <div class="modal-title" style="margin-bottom:4px">Export Deliverable</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:16px">Select one or more categories — combined into one report</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
          ${cats.length?cats.map(c=>`
            <button class="_exp-cat" data-cid="${c.cid}" style="${selected.has(c.cid)?rowOn:rowBase}">
              <span style="font-size:15px;width:18px;flex-shrink:0;text-align:center;color:${selected.has(c.cid)?'var(--amber)':'var(--muted)'}">${selected.has(c.cid)?'☑':'☐'}</span>
              <span style="font-size:19px;flex-shrink:0">${c.icon}</span>
              <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
                <span style="font-family:var(--cond);font-weight:700;font-size:14px;letter-spacing:.03em;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}</span>
                <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">${c.type} · ${c.n} entr${c.n===1?'y':'ies'}</span>
              </span>
            </button>`).join('')
          :`<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:8px 0">No categories in the current filter.</div>`}
        </div>
        <button id="_exp-go" ${nSel?'':'disabled'} style="width:100%;padding:12px;background:${nSel?'var(--amber)':'var(--s2,#1a2a38)'};color:${nSel?'#000':'var(--muted)'};font-family:var(--cond);font-weight:700;font-size:14px;letter-spacing:.06em;border:none;border-radius:8px;cursor:${nSel?'pointer':'default'};margin-bottom:8px">⬇ Export${nSel?` (${nSel})`:''}</button>
        <button class="_exp-zip" style="width:100%;padding:10px;background:none;color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);border-radius:8px;cursor:pointer;margin-bottom:8px">🖼 Photos (ZIP)</button>
        <button id="_exp-cancel" style="width:100%;padding:9px;background:none;color:var(--muted);font-family:var(--mono);font-size:11px;border:1px solid var(--border);border-radius:8px;cursor:pointer">Cancel</button>
      </div>`;
    ov.querySelectorAll('._exp-cat').forEach(btn=>{
      btn.onclick=()=>{ const id=btn.dataset.cid; if(selected.has(id)) selected.delete(id); else selected.add(id); render(); };
    });
    ov.querySelector('#_exp-cancel').onclick=()=>ov.remove();
    const goBtn=ov.querySelector('#_exp-go');
    if(goBtn) goBtn.onclick=async()=>{
      if(!selected.size) return;
      goBtn.textContent='Building…'; ov.querySelectorAll('button').forEach(b=>b.style.pointerEvents='none');
      try{ await _exportCategoriesDeliverable([...selected], getEntries(), pid); }
      catch(err){ console.warn('category export failed',err); }
      ov.remove();
    };
    ov.querySelector('._exp-zip').onclick=async()=>{
      ov.querySelectorAll('button').forEach(b=>b.style.pointerEvents='none');
      try{ await _tlogExportPhotoZip(getEntries(), pid); }
      catch(err){ console.warn('photo zip failed',err); }
      ov.remove();
    };
  };
  render();
  document.body.appendChild(ov);
}

// ── Tracker log export — XLSX generation (ExcelJS, lazy-loaded) ──
function _tlogLightenHex(hex, t){
  const h=hex.replace('#','');
  return [0,2,4].map(i=>{
    const c=parseInt(h.slice(i,i+2),16);
    return Math.round(c+(255-c)*t).toString(16).padStart(2,'0');
  }).join('');
}

// Build + download ONE report workbook for one OR MORE categories — a tab per category.
// Each tab branches on progress mode: running-balance/total → SWPPP net-disturbed sheet;
// everything else → coverage-vs-plan (seeding) sheet. Pick pre-seeding + restoration and
// the whole seed-tracking picture lands in a single file.
async function _exportCategoriesDeliverable(cids, entries, pid){
  if(!Array.isArray(cids) || !cids.length) return;
  const {default:ExcelJS}=await import('exceljs');
  const wb=new ExcelJS.Workbook();
  wb.creator='GroundLog'; wb.created=new Date();
  let allSeeding=true;
  for(const cid of cids){
    const mode=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'';
    const isRunning=mode==='running-balance'||mode==='running-total';
    const isLinear=((typeof tcGetMeasurementType==='function')?tcGetMeasurementType(cid,pid):'')==='linear';
    if(isRunning){ allSeeding=false; await _disturbanceSheet(wb, cid, entries, pid); }
    else if(isLinear){ allSeeding=false; await _linearSheet(wb, cid, entries, pid); }
    else await _seedingSheet(wb, cid, entries, pid);
  }
  // Body font ≥ 12 across the workbook (titles/headline keep their larger size). Skip
  // hidden rows (the collapsed capture-image ranges) so their reserved height holds.
  wb.eachSheet(sheet=>{
    sheet.eachRow(row=>{
      if(row.hidden) return;
      if(!row.height || row.height<16) row.height=16;
      row.eachCell({includeEmpty:false},c=>{ const f=c.font||{}; if((f.size||11)<12) c.font={...f,size:12}; });
    });
  });
  const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
  const today=new Date().toLocaleDateString('en-CA');
  const safeProj=(cfg.projectName||pid).replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-');
  let fname;
  if(cids.length===1){
    const name=(typeof tcGetName==='function')?tcGetName(cids[0],pid):'category';
    const mode=(typeof tcProgressMode==='function')?tcProgressMode(cids[0],pid):'';
    const isRunning=mode==='running-balance'||mode==='running-total';
    const isLinear=((typeof tcGetMeasurementType==='function')?tcGetMeasurementType(cids[0],pid):'')==='linear';
    const safeCat=String(name).replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-')||'category';
    fname=`${isRunning?'disturbance':(isLinear?'bmp':'seeding')}-${safeCat}-${safeProj}-${today}.xlsx`;
  } else {
    fname=`${allSeeding?'seeding':'tracker'}-report-${safeProj}-${today}.xlsx`;
  }
  const buf=await wb.xlsx.writeBuffer();
  const blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await _glShareOrDownload(blob, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

// DEPRECATED — combined "Tracker Log" workbook. Superseded by per-category deliverables
// (_exportCategoryDeliverable); no longer reachable from the UI. Kept temporarily; remove
// in a follow-up cleanup pass.
async function _tlogExportXlsx(scheme, entries, pid){
  const {default:ExcelJS}=await import('exceljs');
  const wb=new ExcelJS.Workbook();
  wb.creator='GroundLog'; wb.created=new Date();
  const ws=wb.addWorksheet('Tracker Log');

  const TEAL='006B75', AMBER='C9A84C', WHITE='FFFFFF';
  const TEAL_LIGHT='E8F4F5', GRAY_LIGHT='F2F2F2', GRAY_ROW='F9F9F9', AMBER_LIGHT='FDF5DC';
  const NCOLS=16;

  const cols=[
    {header:'Date',            width:15},
    {header:'Category',        width:30},
    {header:'Type',            width:40},
    {header:'State',           width:20},
    {header:'Measurement',     width:18},
    {header:'Location',        width:26},
    {header:'Notes',           width:42},
    {header:'Photos',          width:10},
    {header:'Seed Tags',       width:12},
    {header:'Mix / Product',   width:24},
    {header:'Applied Rate',    width:18},
    {header:'Required Amount', width:20},
    {header:'Actual Amount',   width:18},
    {header:'Method',          width:22},
    {header:'Contractor',      width:26},
    {header:'Progress',        width:14},
  ];
  ws.columns=cols.map(c=>({width:c.width}));

  const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
  const today=new Date().toLocaleDateString('en-CA');

  // ── Title row ──
  ws.addRow(['GroundLog Tracker Log Export']);
  ws.mergeCells(1,1,1,NCOLS);
  const titleCell=ws.getCell('A1');
  titleCell.font={name:'Calibri',bold:true,size:14,color:{argb:scheme==='neutral'?'000000':WHITE}};
  titleCell.fill=scheme==='neutral'?{type:'pattern',pattern:'none'}:{type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  titleCell.alignment={vertical:'middle',horizontal:'left',indent:1};
  ws.getRow(1).height=26;

  // ── Info block ──
  const infoRows=[
    ['Project',      cfg.projectName||''],
    ['Location',     cfg.location||''],
    ['Org',          cfg.org||''],
    ['Prepared By',  cfg.preparedBy||''],
    ['Active Phase', cfg.activePhase||''],
    ['Exported',     today],
  ];
  infoRows.forEach(([label,value],i)=>{
    const r=ws.addRow([label,value]);
    const ri=i+2;
    ws.mergeCells(ri,2,ri,NCOLS);
    r.getCell(1).font={name:'Consolas',size:9,bold:true,color:{argb:scheme==='neutral'?'444444':AMBER}};
    r.getCell(2).font={name:'Calibri',size:10};
    r.height=16;
  });

  ws.addRow([]); // row 8 blank

  // ── Column headers row 9 ──
  const hRow=ws.addRow(cols.map(c=>c.header));
  hRow.eachCell({includeEmpty:true},cell=>{
    cell.font={name:'Calibri',bold:true,size:10,color:{argb:scheme==='neutral'?'000000':WHITE}};
    cell.fill=scheme==='neutral'
      ?{type:'pattern',pattern:'solid',fgColor:{argb:GRAY_LIGHT}}
      :{type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
    cell.border={bottom:{style:'thin',color:{argb:'CCCCCC'}}};
    cell.alignment={vertical:'middle',horizontal:'left',wrapText:false};
  });
  hRow.height=18;
  ws.views=[{state:'frozen',ySplit:9,activeCell:'A10'}];

  // ── Helper: build a data row values array (15 cols) ──
  const rowVals=(e,typeLabel)=>{
    const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown');
    const f=e.fields||{};
    const rateUnit=f.requiredUnit?f.requiredUnit+'/ac':'';
    const stLabel=(()=>{
      if(e.entryType==='planned') return '';
      const s=(typeof tcEntryState==='function')?tcEntryState(e,e.categoryId,pid):null;
      return s?s.label:(e.state||'');
    })();
    return [
      e.date||'', catName, typeLabel, stLabel,
      e.measurementValue!=null?`${e.measurementValue} ${e.measurementUnit||''}`:e.acres!=null?`${e.acres} ac`:'',
      e.location||'', e.notes||'',
      Array.isArray(e.photoIds)?e.photoIds.length:'',
      f.seedTagCount!=null?f.seedTagCount:'',
      e.seedMix||'',
      f.appliedRate!=null?(rateUnit?f.appliedRate+' '+rateUnit:f.appliedRate):'',
      f.requiredAmount!=null?f.requiredAmount+' '+(f.requiredUnit||''):'',
      f.actualAmount!=null?f.actualAmount+' '+(f.actualUnit||''):'',
      e.method||'', e.contractor||'',
      '', // Progress — empty on installed rows
    ];
  };

  // ── Helper: apply cell style to a row ──
  const styleRow=(row,bold,fillArgb,isCat)=>{
    row.eachCell({includeEmpty:true},cell=>{
      cell.font={name:'Calibri',size:10,bold:!!bold};
      cell.alignment={vertical:'top',horizontal:'left',wrapText:true};
      if(fillArgb) cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:fillArgb}};
      if(isCat) cell.border={
        top:{style:'thin',color:{argb:'CCCCCC'}},
        left:{style:'thin',color:{argb:'CCCCCC'}},
        bottom:{style:'thin',color:{argb:'CCCCCC'}},
        right:{style:'thin',color:{argb:'CCCCCC'}},
      };
    });
    row.height=15;
  };

  // ── Group entries by category (one Plan Total row per category) ──
  const catOrder=[];
  const catGroups={};
  entries.forEach(e=>{
    const cid=e.categoryId||'_unknown';
    if(!catGroups[cid]){
      catGroups[cid]={cid,planned:[],installed:[]};
      catOrder.push(cid);
    }
    if(e.entryType==='planned') catGroups[cid].planned.push(e);
    else catGroups[cid].installed.push(e);
  });

  catOrder.forEach(cid=>{
    const {planned,installed}=catGroups[cid];
    const catColor=typeof tcGetColor==='function'?tcGetColor(cid,pid):null;

    if(planned.length>0){
      // ── Aggregate all planned entries into one Plan Total row ──
      const totalPlanMeas=planned.reduce((s,e)=>s+(parseFloat(e.measurementValue)||parseFloat(e.acres)||0),0);
      const planMeasUnit=planned.find(e=>e.measurementUnit)?.measurementUnit||'ac';
      const totalReqAmt=planned.reduce((s,e)=>s+(e.fields?.requiredAmount||0),0);
      const reqUnit=planned.find(e=>e.fields?.requiredUnit)?.fields?.requiredUnit||'';
      const totalPlanSeeds=planned.reduce((s,e)=>s+(e.fields?.seedTagCount||0),0);
      const planDates=[...new Set(planned.map(e=>e.date).filter(Boolean))].join(', ');
      const planLocations=planned.map(e=>e.location||'').filter(Boolean).join('; ');
      const planNotes=planned.map(e=>e.notes||'').filter(Boolean).join(' · ');
      const catName=planned[0].categoryName||(typeof tcGetName==='function'?tcGetName(cid,pid):'Unknown');

      const totalActAmt=installed.reduce((s,e)=>s+(e.fields?.actualAmount||0),0);
      const actUnit=installed.find(e=>e.fields?.actualUnit)?.fields?.actualUnit||reqUnit;
      const pct=totalReqAmt>0?Math.min(100,(totalActAmt/totalReqAmt)*100):null;

      const planTypeLabel=planned.length>1?`Plan Total (${planned.length} areas)`:'Plan Total';
      const actualDisplay=totalActAmt>0
        ?`${totalActAmt.toLocaleString()} ${actUnit} (${installed.length} entr${installed.length!==1?'ies':'y'})`
        :installed.length?`${installed.length} entr${installed.length!==1?'ies':'y'} — no amounts`:'';

      const pRow=ws.addRow([
        '', catName, planTypeLabel, '',
        totalPlanMeas>0?`${totalPlanMeas.toFixed(2)} ${planMeasUnit}`:'',
        planLocations, planNotes,
        '', totalPlanSeeds||'', '',
        '',                                                          // Applied Rate (not meaningful for aggregated plan)
        totalReqAmt>0?`${totalReqAmt.toLocaleString()} ${reqUnit}`:'', // Required Amount
        actualDisplay,                                               // Actual Amount
        '', '',
        pct!=null?Math.round(pct):'',
      ]);
      styleRow(pRow,true,AMBER_LIGHT,scheme==='category');
      pRow.eachCell({includeEmpty:true},cell=>{
        cell.border={...(cell.border||{}),bottom:{style:'thin',color:{argb:'C9A84C'}}};
      });

      installed.forEach((e,ci)=>{
        const fill=scheme==='brand'?ci%2===1?TEAL_LIGHT:null
          :scheme==='category'?(catColor?_tlogLightenHex(catColor,0.82):null)
          :ci%2===1?GRAY_ROW:null;
        const iRow=ws.addRow(rowVals(e,'Installed'));
        styleRow(iRow,false,fill,scheme==='category');
      });

    } else {
      // ── No plan — synthetic Category Total row + installed rows ──
      if(installed.length>0){
        const catName=installed[0].categoryName||(typeof tcGetName==='function'?tcGetName(cid,pid):'Unknown');
        const totalMeas=installed.reduce((s,e)=>s+(parseFloat(e.measurementValue)||parseFloat(e.acres)||0),0);
        const measUnit=installed.find(e=>e.measurementUnit)?.measurementUnit||'ac';
        const totalActAmt=installed.reduce((s,e)=>s+(e.fields?.actualAmount||0),0);
        const actUnit=installed.find(e=>e.fields?.actualUnit)?.fields?.actualUnit||'lbs';
        const totalSeeds=installed.reduce((s,e)=>s+(e.fields?.seedTagCount||0),0);
        const totalPhotos=installed.reduce((s,e)=>s+(Array.isArray(e.photoIds)?e.photoIds.length:0),0);
        // Running-balance/total (disturbance) categories: a gross SUM of overlapping
        // drawings is meaningless — show the NET open total instead (see the dedicated
        // Disturbance tab for the per-state breakdown).
        const _mode=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'';
        const _isRunning=_mode==='running-balance'||_mode==='running-total';
        let _measCell, _typeCell;
        if(_isRunning){
          const _childStates=((typeof tcGetStates==='function')?tcGetStates(cid,pid):[]).filter(s=>!s.isPlanned);
          const _defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ac';
          const _rt=(typeof _runningTotals==='function')?_runningTotals(cid,installed,_childStates,_defUnit,pid,_mode):{open:0};
          _measCell=(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(_rt.open,_defUnit):`${(_rt.open||0).toFixed(2)} ${_defUnit}`;
          _typeCell=`Net open disturbed (${installed.length} drawing${installed.length!==1?'s':''}) → see Disturbance tab`;
        } else {
          _measCell=totalMeas>0?`${totalMeas.toFixed(2)} ${measUnit}`:'';
          _typeCell=`Category Total (${installed.length} entr${installed.length!==1?'ies':'y'})`;
        }
        const tRow=ws.addRow([
          '', catName, _typeCell, '',
          _measCell,
          '', '',
          totalPhotos||'', totalSeeds||'', '',
          '', '',
          totalActAmt>0?`${totalActAmt.toLocaleString()} ${actUnit}`:'',
          '', '', '',
        ]);
        styleRow(tRow,true,AMBER_LIGHT,scheme==='category');
        tRow.eachCell({includeEmpty:true},cell=>{
          cell.border={...(cell.border||{}),bottom:{style:'thin',color:{argb:'C9A84C'}}};
        });
      }
      installed.forEach((e,ci)=>{
        const fill=scheme==='brand'?ci%2===1?TEAL_LIGHT:null
          :scheme==='category'?(catColor?_tlogLightenHex(catColor,0.82):null)
          :ci%2===1?GRAY_ROW:null;
        const iRow=ws.addRow(rowVals(e,'Installed'));
        styleRow(iRow,false,fill,scheme==='category');
      });
    }
  });

  // ── Data bar on Progress column (P) — renders on plan rows that have a numeric % value ──
  ws.addConditionalFormatting({
    ref:'P10:P10000',
    rules:[{
      type:'dataBar',
      cfvo:[{type:'num',value:0},{type:'num',value:100}],
      color:{argb:'FFC9A84C'},
    }],
  });

  // ── Dedicated per-category deliverable sheets ──
  // Disturbance (running-balance/total) categories get a purpose-built SWPPP sheet:
  // net per-state areas (turf), total open vs cap + %, and itemized drawings. Each
  // disturbance category becomes its own tab; other types live in the combined sheet above.
  for(const cid of catOrder){
    const m=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'';
    if(m==='running-balance'||m==='running-total'){
      try{ await _disturbanceSheet(wb, cid, entries, pid); }catch(err){ console.warn('disturbance sheet failed for',cid,err); }
    }
  }

  // ── Body font ≥ 12 across the whole workbook (titles keep their larger size) ──
  wb.eachSheet(sheet=>{
    sheet.eachRow(row=>{
      if(!row.height || row.height<16) row.height=16; // fit 12pt text
      row.eachCell({includeEmpty:false},c=>{
        const f=c.font||{};
        if((f.size||11)<12) c.font={...f,size:12};
      });
    });
  });

  // ── Download / Share ──
  const buf=await wb.xlsx.writeBuffer();
  const blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const safeName=(cfg.projectName||pid).replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-');
  await _glShareOrDownload(blob,`tracker-log-${safeName}-${today}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

// hex '#RRGGBB' → ExcelJS argb 'FFRRGGBB' (or null if not a valid hex).
function _xlHex(c){ return (c&&/^#[0-9A-Fa-f]{6}$/.test(c))?('FF'+c.slice(1).toUpperCase()):null; }
// Pick black/white text for legibility on a colored fill (luminance).
function _xlContrast(hex){
  if(!hex||!/^#[0-9A-Fa-f]{6}$/.test(hex)) return 'FF000000';
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return (0.299*r+0.587*g+0.114*b)>150?'FF000000':'FFFFFFFF';
}

function _blobToDataURL(blob){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(blob); }); }

// Dedicated SWPPP-disturbance deliverable sheet for one running-balance/total category:
// a net-per-state summary (current area per state, turf-computed), total open vs the cap
// + % of allowed (with OVER-LIMIT flag), the itemized list of every drawn area, and the
// attached map captures (legend baked in) embedded so the XLSX is one self-contained file.
async function _disturbanceSheet(wb, cid, allEntries, pid){
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(cid,pid):null;
  if(!cat) return;
  const name=(typeof tcGetName==='function')?tcGetName(cid,pid):'Disturbance';
  const mode=(typeof tcProgressMode==='function')?tcProgressMode(cid,pid):'running-balance';
  const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ac';
  const states=(typeof tcGetStates==='function')?tcGetStates(cat,pid):[];
  const childStates=states.filter(s=>!s.isPlanned);
  const installed=allEntries.filter(e=>(e.categoryId===cid)&&e.entryType!=='planned'&&!e.temporary&&!e.deletedAt);
  const rt=(typeof _runningTotals==='function')?_runningTotals(cid,installed,childStates,defUnit,pid,mode):{perState:{},open:0};
  const fmt=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,defUnit):`${(v||0).toFixed(2)} ${defUnit}`;

  const TEAL='006B75', WHITE='FFFFFF', AMBER_LIGHT='FDF5DC';
  const NC=7;
  // Sheet name: ≤31 chars, no \ / ? * [ ] : — and unique within the workbook.
  let base=('Disturbance — '+name).replace(/[\\\/\?\*\[\]:]/g,'').slice(0,31);
  let nm=base, n=2;
  while(wb.getWorksheet(nm)){ nm=base.slice(0,28)+' '+n; n++; }
  const ws=wb.addWorksheet(nm);
  // Native outline groups for the inline collapsed map captures (see seeding sheet).
  ws.properties.outlineProperties={summaryBelow:false,summaryRight:false};
  ws.properties.outlineLevelRow=1;
  ws.columns=[{width:30},{width:24},{width:16},{width:28},{width:42},{width:10},{width:26}];

  // ── Title ── (just the category name — the tab already says "Disturbance —")
  ws.addRow([name]);
  ws.mergeCells(1,1,1,NC);
  const tc=ws.getCell('A1');
  tc.font={name:'Calibri',bold:true,size:14,color:{argb:WHITE}};
  tc.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  tc.alignment={vertical:'middle',horizontal:'left',indent:1};
  ws.getRow(1).height=26;

  const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
  const today=new Date().toLocaleDateString('en-CA');
  [['Project',cfg.projectName||''],['Snapshot date',today],['Prepared By',cfg.preparedBy||'']].forEach(([l,v])=>{
    const r=ws.addRow([l,v]); ws.mergeCells(r.number,2,r.number,NC);
    r.getCell(1).font={name:'Consolas',size:9,bold:true,color:{argb:'FF'+TEAL}};
    r.getCell(2).font={name:'Calibri',size:10}; r.height=15;
  });
  ws.addRow([]);

  // ── Summary (net per-state) ──
  const sh=ws.addRow(['Disturbance Summary (current)']); ws.mergeCells(sh.number,1,sh.number,NC);
  sh.getCell(1).font={bold:true,size:13,color:{argb:WHITE}};
  sh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  sh.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; sh.height=22;
  const hdr=ws.addRow(['State','Area']);
  hdr.getCell(1).font={bold:true,size:10}; hdr.getCell(2).font={bold:true,size:10};
  childStates.forEach(s=>{
    const v=rt.perState[s.id]||0;
    const r=ws.addRow([s.label, fmt(v)]);
    const fill=_xlHex(s.color);
    if(fill){ r.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}}; r.getCell(1).font={name:'Calibri',size:10,color:{argb:_xlContrast(s.color)}}; }
    else r.getCell(1).font={name:'Calibri',size:10};
    r.getCell(2).font={name:'Calibri',size:10}; r.height=15;
  });
  // Total open — the headline number: larger (16pt) + bordered band so it stands out.
  const totR=ws.addRow(['TOTAL open disturbed', fmt(rt.open)]);
  totR.getCell(1).font={bold:true,size:16}; totR.getCell(2).font={bold:true,size:16,color:{argb:'FF006B75'}};
  // Band the amber fill + top rule across the whole row to the last column (col G) so it reads
  // as one unit with the caption below it (Tim: extend the gold all the way over like row 14).
  for(let c=1;c<=NC;c++){
    totR.getCell(c).fill={type:'pattern',pattern:'solid',fgColor:{argb:AMBER_LIGHT}};
    totR.getCell(c).border={top:{style:'medium',color:{argb:'FFC9A84C'}},...(c===1?{left:{style:'medium',color:{argb:'FFC9A84C'}}}:{}),...(c===NC?{right:{style:'medium',color:{argb:'FFC9A84C'}}}:{})};
  }
  totR.height=30;
  // Spell out WHICH states this open total counts (Nick: make clear it's the active + inactive
  // disturbed only — stabilized / closed ground is excluded). Derived from each state's countMode
  // so it stays correct if the state set ever changes.
  const _addLabels=childStates.filter((s,idx)=>((typeof tcStateCountMode==='function')?tcStateCountMode(s,idx,childStates,mode):'add')==='add').map(s=>s.label);
  const _openNote=_addLabels.length?_addLabels.join(' + '):'active + inactive disturbed';
  const noteR=ws.addRow([`↳ counts ${_openNote} only — stabilized / closed areas are excluded`]);
  ws.mergeCells(noteR.number,1,noteR.number,NC);
  noteR.getCell(1).font={italic:true,size:9,color:{argb:'FF7A6A2E'}};
  // Fill + a continuous bottom border across the full merged width so it reads as one band with
  // the total above it (merged-cell borders must be set on every underlying cell).
  for(let c=1;c<=NC;c++){ noteR.getCell(c).fill={type:'pattern',pattern:'solid',fgColor:{argb:AMBER_LIGHT}}; noteR.getCell(c).border={bottom:{style:'medium',color:{argb:'FFC9A84C'}},...(c===1?{left:{style:'medium',color:{argb:'FFC9A84C'}}}:{}),...(c===NC?{right:{style:'medium',color:{argb:'FFC9A84C'}}}:{})}; }
  noteR.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1};
  noteR.height=16;
  const cap=cat.disturbanceCap;
  if(cap!=null){
    const pctRaw=cap>0?(rt.open/cap)*100:0;
    const over=rt.open>cap; const warn=!over && pctRaw>=90;     // amber warning band near the cap
    const remaining=Math.max(0,cap-rt.open);
    // 3-tier status color: green (clear) → amber (≥90%, getting close) → red (over).
    const statusColor=over?'FFC0392B':(warn?'FFE69500':'FF27AE60');
    const aR=ws.addRow(['Allowed (limit)', fmt(cap)]); aR.getCell(1).font={bold:true,size:12}; aR.getCell(2).font={name:'Calibri',size:12};
    const rR=ws.addRow(['Remaining to limit', over?('0 — ⚠ OVER by '+fmt(rt.open-cap)):fmt(remaining)]);
    rR.getCell(1).font={bold:true,size:12}; rR.getCell(2).font={bold:true,size:12,color:{argb:statusColor}};
    const pR=ws.addRow(['% of allowed', Math.round(pctRaw)+'%'+(over?'  ⚠ OVER LIMIT':(warn?'  ⚠ APPROACHING LIMIT':''))]);
    pR.getCell(1).font={bold:true,size:12};
    pR.getCell(2).font={bold:true,size:12,color:{argb:statusColor}};
  }
  ws.addRow([]);

  // ── Itemized drawings ──
  const ih=ws.addRow(['Itemized Drawings']); ws.mergeCells(ih.number,1,ih.number,NC);
  ih.getCell(1).font={bold:true,size:13,color:{argb:WHITE}};
  ih.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  ih.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; ih.height=22;
  const chRow=ws.addRow(['Date','State','Net area','Location','Notes','Photos','Contractor']);
  chRow.eachCell({includeEmpty:true},c=>{ c.font={bold:true,size:10,color:{argb:WHITE}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}}; });
  chRow.height=18;
  const stById={}; childStates.forEach(s=>stById[s.id]=s);
  // Per-drawing NET area (turf): each drawing minus later-state overlays. This is the
  // CURRENT contribution that reconciles with the net summary above — the raw drawn size
  // double-counts ground that's since been stabilized over. Falls back to the drawn size
  // only when geometry is unavailable.
  const netByEntry=(typeof glEntryNetAreasM2==='function')?glEntryNetAreasM2(installed, childStates):null;
  const sorted=installed.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  for(const e of sorted){
    const s=stById[e.state]||null;
    let meas;
    if(netByEntry && netByEntry[e.id]!=null){
      const a=(typeof glAreaConvertM2==='function')?glAreaConvertM2(netByEntry[e.id],defUnit):0;
      meas=fmt(a);
    } else {
      meas=e.measurementValue!=null?`${e.measurementValue} ${e.measurementUnit||defUnit}`:(e.acres!=null?`${e.acres} ac`:'');
    }
    const r=ws.addRow([e.date||'', s?s.label:(e.state||''), meas, e.location||'', e.notes||'', Array.isArray(e.photoIds)?e.photoIds.length:'', e.contractor||'']);
    r.eachCell({includeEmpty:true},c=>{ c.font={name:'Calibri',size:10}; c.alignment={vertical:'top',wrapText:true}; });
    if(s){ const fill=_xlHex(s.color); if(fill){ r.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}}; r.getCell(2).font={name:'Calibri',size:10,color:{argb:_xlContrast(s.color)}}; } }
    r.height=15;
    // This drawing's map captures, collapsed inline right under it (same as seeding).
    await _embedCapturesInline(ws, wb, [e], NC);
  }
  if(!sorted.length){ const r=ws.addRow(['—','No drawings yet']); r.getCell(2).font={italic:true,size:10,color:{argb:'FF999999'}}; }
  // Disturbance tab reads as a standalone deliverable — taller rows than the combined log.
  // Skip hidden rows (collapsed capture images) so their reserved height holds.
  ws.eachRow((row,rn)=>{ if(rn===1||row.hidden) return; if(!row.height || row.height<22) row.height=22; });
}

// Embed every map_capture photo attached to a category's drawings into a worksheet (one
// self-contained deliverable). Shared by the disturbance + seeding sheets. The separate
// photo-ZIP remains for bulk/full-res photos.
async function _embedCaptures(ws, wb, installed, pid, NC){
  const TEAL='006B75', WHITE='FFFFFF';
  const caps=[];
  installed.forEach(e=>{ (e.photoIds||[]).forEach(id=>{
    const ph=(window._phPhotos||[]).find(p=>p.id===id);
    if(ph && ph.type==='map_capture' && ph.storageUrl) caps.push({ph,e});
  }); });
  if(!caps.length) return;
  const ch=ws.addRow(['Map Captures']); ws.mergeCells(ch.number,1,ch.number,NC);
  ch.getCell(1).font={bold:true,size:13,color:{argb:WHITE}};
  ch.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  ch.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; ch.height=22;
  for(const {ph,e} of caps){
    const capR=ws.addRow([(e.photoCaptions||{})[ph.id]||ph.caption||`${e.date||''} map capture`]);
    ws.mergeCells(capR.number,1,capR.number,NC);
    capR.getCell(1).font={italic:true,size:11,color:{argb:'FF555555'}}; capR.height=18;
    try{
      const resp=await fetch(ph.storageUrl); if(!resp.ok) continue;
      const blob=await resp.blob();
      const dataUrl=await _blobToDataURL(blob);
      const raw=dataUrl.substring(dataUrl.indexOf(',')+1);
      const ext=(ph.filename||'png').split('.').pop().toLowerCase();
      const extension=(ext==='jpg'||ext==='jpeg')?'jpeg':(ext==='gif'?'gif':'png');
      const bmp=await createImageBitmap(blob);
      const maxW=680, scale=Math.min(1,maxW/bmp.width);
      const w=Math.round(bmp.width*scale), h=Math.round(bmp.height*scale); bmp.close();
      const imgId=wb.addImage({base64:raw, extension});
      ws.addImage(imgId,{ tl:{col:0,row:ws.rowCount}, ext:{width:w, height:h} });
      // Reserve vertical space so stacked captures don't overlap (rows ~18pt ≈ 24px).
      const spacer=Math.ceil(h/24)+1;
      for(let i=0;i<spacer;i++){ const br=ws.addRow([]); br.height=18; }
    }catch(err){ console.warn('embed capture failed',err); }
  }
}

// Inline, COLLAPSED capture(s) for ONE drawing: a dated/shaded summary row (carries the
// +/- outline toggle) followed by the capture image in a grouped, hidden row range that
// collapses with it (twoCellAnchor → the image hides when the rows collapse). `owners` =
// the drawing's entries (planned parent + its layers) whose map_captures belong here. This
// replaces the separate bottom "Map Captures" list — captures live with their drawing.
async function _embedCapturesInline(ws, wb, owners, NC, opts){
  // opts.allPhotos: embed EVERY attached photo (repair-flag field photos), not just
  // map captures / seed tags — a flag's photo IS its evidence, always belongs inline.
  const caps=[];
  (owners||[]).forEach(e=>{ if(!e) return; const types=e.photoTypes||{}; (e.photoIds||[]).forEach(id=>{
    const ph=(window._phPhotos||[]).find(p=>p.id===id);
    if(!ph||!ph.storageUrl) return;
    const isCap=ph.type==='map_capture';
    const isTag=types[id]==='material_tag';
    if(isCap||isTag) caps.push({ph,e,kind:isCap?'capture':'seedtag'});
    else if(opts&&opts.allPhotos) caps.push({ph,e,kind:'field'});
  }); });
  if(!caps.length) return;
  // Cumulative pixel widths of ALL data columns (≈ charWidth*7+5), read from THIS sheet, so
  // the image can span the full sheet width regardless of the sheet's column layout.
  const cum=[]; { let a=0; for(let i=1;i<=NC;i++){ a+=Math.round((((ws.getColumn(i).width)||10)*7)+5); cum[i-1]=a; } }
  const MAXHPX=1100;  // ceiling on the expanded photo height so tall portraits stay sane
  const ROWMAXPT=380; // one Excel row caps ~409pt — keep each grouped row under it
  for(const {ph,e,kind} of caps){
    const tag=kind==='capture'?'📷 Map capture':(kind==='field'?'📷 Field photo':'🌱 Seed tag photo');
    const fillArgb=kind==='capture'?'FDF5DC':(kind==='field'?'FBEAEA':'EAF5EA'); // amber / red / green tints
    const lbl=ws.addRow([`▸ ${tag} · ${e.date||''}   ( click the + in the far-left margin to expand ↓ )`]);
    ws.mergeCells(lbl.number,1,lbl.number,NC);
    lbl.getCell(1).font={bold:true,size:10,color:{argb:'FF006B75'}};
    lbl.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:fillArgb}};
    lbl.getCell(1).border={top:{style:'thin',color:{argb:'FFC9A84C'}}};
    lbl.height=18;
    try{
      const resp=await fetch(ph.storageUrl); if(!resp.ok) continue;
      const blob=await resp.blob();
      const bmp=await createImageBitmap(blob);
      const aspect=bmp.height/bmp.width;
      // Default: span the FULL sheet width (Nick: expand the photo out to the last column —
      // M on seeding, G on disturbance). If that makes a tall/portrait photo exceed the height
      // ceiling, step the width back to the widest span that fits — keeps aspect, never stretches.
      let brCol=NC, rangeW=cum[NC-1];
      if(Math.round(rangeW*aspect)>MAXHPX){
        for(let i=0;i<cum.length;i++){ if(Math.round(cum[i]*aspect)<=MAXHPX){ brCol=i+1; rangeW=cum[i]; } }
      }
      const totalPt=Math.round(Math.round(rangeW*aspect)*0.75); // px→pt, aspect-correct to the span
      const K=Math.max(1,Math.ceil(totalPt/ROWMAXPT));          // split a tall image across rows
      const perRowPt=Math.max(15,Math.round(totalPt/K));        // so each stays under Excel's cap
      // Re-encode at a modest size + JPEG so the workbook stays small. The originals can be
      // multi-MB each (full phone photos); a ~720px JPEG is tens of KB and is plenty for a
      // report — embedding the originals was bloating the file dozens of × over.
      const EMB=720, es=Math.min(1, EMB/Math.max(bmp.width,bmp.height));
      const cw=Math.max(1,Math.round(bmp.width*es)), chh=Math.max(1,Math.round(bmp.height*es));
      const cv=document.createElement('canvas'); cv.width=cw; cv.height=chh;
      cv.getContext('2d').drawImage(bmp,0,0,cw,chh); bmp.close();
      const jblob=await new Promise(res=>cv.toBlob(res,'image/jpeg',0.72));
      const dataUrl=await _blobToDataURL(jblob);
      const raw=dataUrl.substring(dataUrl.indexOf(',')+1);
      // K grouped rows, all collapsed by default (outline level 1 + hidden) so the photo
      // hides/expands as one unit under the dated toggle row above it.
      let firstNum=null;
      for(let k=0;k<K;k++){ const ir=ws.addRow([]); ir.height=perRowPt; ir.outlineLevel=1; ir.hidden=true; if(k===0) firstNum=ir.number; }
      const r0=firstNum-1; // 0-indexed
      const imgId=wb.addImage({base64:raw, extension:'jpeg'});
      // twoCellAnchor across the full span + all K rows → sizes/collapses with the group.
      ws.addImage(imgId,{ tl:{col:0.08,row:r0+0.03}, br:{col:brCol,row:r0+K-0.03}, editAs:'twoCell' });
    }catch(err){ console.warn('inline capture failed',err); }
  }
}

// Linear-BMP deliverable sheet (silt fence & friends) — installed ft vs the plan per
// state, a 🚩 punchlist section (open repair flags w/ field photos + fixed history),
// and the itemized drawings with inline captures. The contractor-facing read: WHERE
// fence is installed (allowed to move dirt), what's planned, and what needs repair.
async function _linearSheet(wb, cid, allEntries, pid){
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(cid,pid):null;
  if(!cat) return;
  const name=(typeof tcGetName==='function')?tcGetName(cid,pid):'BMP';
  const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ft';
  const states=(typeof tcGetStates==='function')?tcGetStates(cat,pid):[];
  const childStates=states.filter(s=>!s.isPlanned);
  const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cat,pid):null;
  const planned=allEntries.filter(e=>(e.categoryId===cid)&&e.entryType==='planned'&&!e.temporary&&!e.deletedAt);
  const installed=allEntries.filter(e=>(e.categoryId===cid)&&e.entryType!=='planned'&&!e.temporary&&!e.deletedAt);
  const openFlags=allEntries.filter(e=>(e.categoryId===cid)&&e.temporary&&e.tempStatus!=='resolved'&&!e.deletedAt);
  const fixedFlags=allEntries.filter(e=>(e.categoryId===cid)&&e.temporary&&e.tempStatus==='resolved'&&!e.deletedAt)
    .sort((a,b)=>(b.resolvedAt||0)-(a.resolvedAt||0));
  const measure=(e)=>(typeof trEntryMeasure==='function')?trEntryMeasure(e,defUnit,pid):0;
  const fmt=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,defUnit):`${(v||0).toFixed(0)} ${defUnit}`;
  const stOf=(e)=>e.state||(dcs?dcs.id:null);
  const planTotal=planned.reduce((s,e)=>s+measure(e),0);

  const TEAL='006B75', WHITE='FFFFFF', AMBER_LIGHT='FDF5DC';
  const NC=7;
  let base=('BMP — '+name).replace(/[\\\/\?\*\[\]:]/g,'').slice(0,31);
  let nm=base, n=2;
  while(wb.getWorksheet(nm)){ nm=base.slice(0,28)+' '+n; n++; }
  const ws=wb.addWorksheet(nm);
  ws.properties.outlineProperties={summaryBelow:false,summaryRight:false};
  ws.properties.outlineLevelRow=1;
  // Date, State/Item, Length, Location, Notes, Photos, Contractor
  ws.columns=[{width:13},{width:26},{width:16},{width:28},{width:44},{width:9},{width:24}];

  // ── Title ──
  ws.addRow([name]); ws.mergeCells(1,1,1,NC);
  const tc=ws.getCell('A1');
  tc.font={name:'Calibri',bold:true,size:18,color:{argb:WHITE}};
  tc.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  tc.alignment={vertical:'middle',horizontal:'left',indent:1}; ws.getRow(1).height=34;
  const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
  const today=new Date().toLocaleDateString('en-CA');
  [['Project',cfg.projectName||''],['Snapshot date',today],['Prepared By',cfg.preparedBy||'']].forEach(([l,v])=>{
    const r=ws.addRow([l,v]); ws.mergeCells(r.number,2,r.number,NC);
    r.getCell(1).font={name:'Consolas',size:9,bold:true,color:{argb:'FF'+TEAL}};
    r.getCell(2).font={name:'Calibri',size:10}; r.height=15;
  });
  const tip=ws.addRow(['ℹ  Photos are collapsed under each row. Click + in the far-left margin to expand one (or the 1 / 2 buttons at the very top-left for all). If +/- do nothing, click "Enable Editing" first — Protected View disables them.']);
  ws.mergeCells(tip.number,1,tip.number,NC);
  tip.getCell(1).font={italic:true,size:9,color:{argb:'FF666666'}};
  tip.getCell(1).alignment={wrapText:true,vertical:'middle'}; tip.height=24;
  ws.addRow([]);

  // ── Installation Summary — per-state totals vs plan, color-coded bars ──
  const sh=ws.addRow(['INSTALLATION SUMMARY — totals vs plan']); ws.mergeCells(sh.number,1,sh.number,NC);
  sh.getCell(1).font={bold:true,size:15,color:{argb:'FF0F1F2E'}};
  sh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'C9A84C'}};
  sh.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; sh.height=28;
  const hdr=ws.addRow(['','State','Length','% of Plan']);
  hdr.eachCell({includeEmpty:true},c=>{ c.font={bold:true,size:10,color:{argb:WHITE}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}}; });
  hdr.height=18;
  childStates.forEach(s=>{
    const tot=installed.filter(e=>stOf(e)===s.id).reduce((a,e)=>a+measure(e),0);
    const pct=planTotal>0?(tot/planTotal)*100:null;
    const r=ws.addRow(['', s.label, fmt(tot), pct!=null?Math.round(pct):'' ]);
    const fill=_xlHex(s.color);
    if(fill){ r.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}}; r.getCell(2).font={name:'Calibri',size:11,bold:true,color:{argb:_xlContrast(s.color)}}; }
    else r.getCell(2).font={name:'Calibri',size:11,bold:true};
    r.getCell(3).font={name:'Calibri',size:11};
    r.getCell(4).font={name:'Calibri',size:11,bold:true};
    if(pct!=null){
      r.getCell(4).numFmt='0"%"';
      const bc=pct<=50?'FFC0392B':(pct<=90?'FFF1C40F':'FF27AE60');
      ws.addConditionalFormatting({ ref:`D${r.number}`, rules:[{type:'dataBar',cfvo:[{type:'num',value:0},{type:'num',value:100}],color:{argb:bc}}] });
    }
    r.height=20;
  });
  if(!childStates.length){ const r=ws.addRow(['','—','No states defined']); r.getCell(3).font={italic:true,size:10,color:{argb:'FF999999'}}; }
  // Planned total — banded headline (the denominator).
  const pr=ws.addRow(['','Planned (total)', fmt(planTotal)]);
  pr.getCell(2).font={bold:true,size:14}; pr.getCell(3).font={bold:true,size:14,color:{argb:'FF006B75'}};
  const _tb={top:{style:'medium',color:{argb:'FFC9A84C'}},bottom:{style:'medium',color:{argb:'FFC9A84C'}}};
  for(let c=1;c<=NC;c++){
    pr.getCell(c).fill={type:'pattern',pattern:'solid',fgColor:{argb:AMBER_LIGHT}};
    pr.getCell(c).border={..._tb,...(c===1?{left:{style:'medium',color:{argb:'FFC9A84C'}}}:{}),...(c===NC?{right:{style:'medium',color:{argb:'FFC9A84C'}}}:{})};
  }
  pr.height=26;
  ws.addRow([]);

  // ── 🚩 Punchlist — open repairs, each with its field photo collapsed inline ──
  const fh=ws.addRow([`🚩 OPEN REPAIRS — ${openFlags.length}`]); ws.mergeCells(fh.number,1,fh.number,NC);
  fh.getCell(1).font={bold:true,size:15,color:{argb:WHITE}};
  fh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'C0392B'}};
  fh.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; fh.height=28;
  if(openFlags.length){
    const fhd=ws.addRow(['Flagged','What\'s wrong','','Location / parent','Details','Photos','']);
    fhd.eachCell({includeEmpty:true},c=>{ c.font={bold:true,size:10,color:{argb:WHITE}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}}; });
    fhd.height=18;
    for(const f of openFlags.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')))){
      const parent=(typeof trGetEntry==='function')?trGetEntry(f.parentId,pid):null;
      const where=(parent&&(parent.location||parent.categoryName))||'';
      const r=ws.addRow([f.date||'', '🚩 '+(f.tempLabel||'Repair'), '', where, f.notes||'', Array.isArray(f.photoIds)?f.photoIds.length:'', '']);
      r.eachCell({includeEmpty:true},c=>{ c.font={name:'Calibri',size:11}; c.alignment={vertical:'top',wrapText:true}; });
      r.getCell(2).font={name:'Calibri',size:11,bold:true,color:{argb:'FFC0392B'}};
      r.height=18;
      await _embedCapturesInline(ws, wb, [f], NC, {allPhotos:true});
    }
  } else {
    const r=ws.addRow(['','Nothing needs attention.']);
    r.getCell(2).font={italic:true,size:10,color:{argb:'FF27AE60'}};
  }
  // Fixed history — non-destructive record: when + what was done.
  if(fixedFlags.length){
    const rh=ws.addRow([`Fixed history — ${fixedFlags.length}`]); ws.mergeCells(rh.number,1,rh.number,NC);
    rh.getCell(1).font={bold:true,size:11,color:{argb:WHITE}};
    rh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'27AE60'}};
    rh.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; rh.height=20;
    fixedFlags.forEach(f=>{
      const when=f.resolvedAt?new Date(f.resolvedAt).toLocaleDateString('en-CA'):'';
      const r=ws.addRow([f.date||'', '✓ '+(f.tempLabel||'Repair'), '', when?('fixed '+when):'', f.resolveNote||f.notes||'', Array.isArray(f.photoIds)?f.photoIds.length:'', '']);
      r.eachCell({includeEmpty:true},c=>{ c.font={name:'Calibri',size:10,color:{argb:'FF555555'}}; c.alignment={vertical:'top',wrapText:true}; });
      r.getCell(2).font={name:'Calibri',size:10,bold:true,color:{argb:'FF27AE60'}};
      r.height=15;
    });
  }
  ws.addRow([]);

  // ── Itemized drawings ──
  const ih=ws.addRow(['Itemized Drawings']); ws.mergeCells(ih.number,1,ih.number,NC);
  ih.getCell(1).font={bold:true,size:13,color:{argb:WHITE}};
  ih.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  ih.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; ih.height=22;
  const chRow=ws.addRow(['Date','State','Length','Location','Notes','Photos','Contractor']);
  chRow.eachCell({includeEmpty:true},c=>{ c.font={bold:true,size:10,color:{argb:WHITE}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}}; });
  chRow.height=18;
  const stById={}; childStates.forEach(s=>stById[s.id]=s);
  const allDraw=[...planned,...installed].sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  for(const e of allDraw){
    const isPlan=e.entryType==='planned';
    const s=isPlan?null:(stById[stOf(e)]||null);
    const meas=e.measurementValue!=null?`${e.measurementValue} ${e.measurementUnit||defUnit}`:(measure(e)?fmt(measure(e)):'');
    const r=ws.addRow([e.date||'', isPlan?'Planned':(s?s.label:(e.state||'')), meas, e.location||'', e.notes||'', Array.isArray(e.photoIds)?e.photoIds.length:'', e.contractor||'']);
    r.eachCell({includeEmpty:true},c=>{ c.font={name:'Calibri',size:10}; c.alignment={vertical:'top',wrapText:true}; });
    if(s){ const fill=_xlHex(s.color); if(fill){ r.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}}; r.getCell(2).font={name:'Calibri',size:10,color:{argb:_xlContrast(s.color)}}; } }
    else if(isPlan){ r.getCell(2).font={name:'Calibri',size:10,italic:true,color:{argb:'FF8E9BA3'}}; }
    r.height=15;
    await _embedCapturesInline(ws, wb, [e], NC);
  }
  if(!allDraw.length){ const r=ws.addRow(['—','No drawings yet']); r.getCell(2).font={italic:true,size:10,color:{argb:'FF999999'}}; }
  ws.eachRow((row,rn)=>{ if(rn===1||row.hidden) return; if(!row.height || row.height<22) row.height=22; });
}

// Coverage-vs-plan (seeding) deliverable sheet for one per-state-vs-plan category. States
// STACK on the same ground (lime→fert→seed→mulch) so per-state areas are GROSS sums (turf
// net is NOT used). Shows a category-wide Coverage Summary (gross per-state ÷ plan, with
// progress bars) + a By-Drawing breakdown (each planned area's per-state coverage), and the
// attached map captures (legend, no totals) embedded.
async function _seedingSheet(wb, cid, allEntries, pid){
  const cat=(typeof tcGetCategory==='function')?tcGetCategory(cid,pid):null;
  if(!cat) return;
  const name=(typeof tcGetName==='function')?tcGetName(cid,pid):'Seeding';
  const defUnit=(typeof tcGetDefaultUnit==='function')?tcGetDefaultUnit(cid,pid):'ac';
  const states=(typeof tcGetStates==='function')?tcGetStates(cat,pid):[];
  const childStates=states.filter(s=>!s.isPlanned);
  const dcs=(typeof tcDefaultChildState==='function')?tcDefaultChildState(cat,pid):null;
  const planned=allEntries.filter(e=>(e.categoryId===cid)&&e.entryType==='planned'&&!e.temporary&&!e.deletedAt);
  const installed=allEntries.filter(e=>(e.categoryId===cid)&&e.entryType!=='planned'&&!e.temporary&&!e.deletedAt);
  const measure=(e)=>(typeof trEntryMeasure==='function')?trEntryMeasure(e,defUnit,pid):0;
  const fmt=(v)=>(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(v,defUnit):`${(v||0).toFixed(2)} ${defUnit}`;
  const stOf=(e)=>e.state||(dcs?dcs.id:null);
  const planTotal=planned.reduce((s,e)=>s+measure(e),0);

  const TEAL='006B75', WHITE='FFFFFF', AMBER_LIGHT='FDF5DC';
  // Full client-facing column set (the old Tracker Log columns the seed reports need).
  const NC=13;
  let base=('Seeding — '+name).replace(/[\\\/\?\*\[\]:]/g,'').slice(0,31);
  let nm=base, n=2;
  while(wb.getWorksheet(nm)){ nm=base.slice(0,28)+' '+n; n++; }
  const ws=wb.addWorksheet(nm);
  // Outline summary ABOVE its group so each capture's dated toggle row sits above the
  // collapsed image rows (click the + on the toggle to expand the photo inline).
  // Capture images sit in native Excel outline GROUPS, COLLAPSED by default (one image row
  // each). summaryBelow:false puts the +/- toggle on the dated label row above each photo;
  // outlineLevelRow=1 marks the level-1 image rows collapsed so the sheet opens tidy —
  // expand with + (after Protected View's "Enable Editing", which disables outline toggles).
  ws.properties.outlineProperties={summaryBelow:false,summaryRight:false};
  ws.properties.outlineLevelRow=1;
  // State, Coverage, %, Date, Seed Tags, Mix/Product, Applied Rate, Required, Actual, Method, Contractor, Notes, Photos
  ws.columns=[{width:26},{width:14},{width:10},{width:13},{width:11},{width:24},{width:18},{width:18},{width:18},{width:18},{width:22},{width:40},{width:9}];

  // ── Title (category name) — top of the hierarchy: biggest + teal ──
  ws.addRow([name]); ws.mergeCells(1,1,1,NC);
  const tc=ws.getCell('A1');
  tc.font={name:'Calibri',bold:true,size:18,color:{argb:WHITE}};
  tc.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  tc.alignment={vertical:'middle',horizontal:'left',indent:1}; ws.getRow(1).height=34;

  const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
  const today=new Date().toLocaleDateString('en-CA');
  [['Project',cfg.projectName||''],['Snapshot date',today],['Prepared By',cfg.preparedBy||'']].forEach(([l,v])=>{
    const r=ws.addRow([l,v]); ws.mergeCells(r.number,2,r.number,NC);
    r.getCell(1).font={name:'Consolas',size:9,bold:true,color:{argb:'FF'+TEAL}};
    r.getCell(2).font={name:'Calibri',size:10}; r.height=15;
  });
  // Usage note — captures/seed-tag photos are grouped + collapsible per drawing.
  const tip=ws.addRow(['ℹ  Photos are collapsed under each drawing. Click + beside a photo to expand it (or the 1 / 2 buttons at the very top-left to expand / collapse all). If the +/- buttons do nothing, click "Enable Editing" up top first — Protected View disables them.']);
  ws.mergeCells(tip.number,1,tip.number,NC);
  tip.getCell(1).font={italic:true,size:9,color:{argb:'FF666666'}};
  tip.getCell(1).alignment={wrapText:true,vertical:'middle'}; tip.height=24;
  ws.addRow([]);

  // Full client column set + per-state ordering, shared by the Summary + By-Drawing.
  const COLS=['State','Coverage','% of Plan','Date','Seed Tags','Mix / Product','Applied Rate','Required','Actual','Method','Contractor','Notes','Photos'];
  const stById={}; childStates.forEach((s,i)=>{ stById[s.id]={...s,_ord:i}; });
  const stOrd=(e)=>{ const s=stById[stOf(e)]; return s?s._ord:99; };
  // Coverage Summary is a materials line-item schedule: one row per State × Mix × Rate.
  // A single-material state collapses to one row; a state seeded with two mixes shows two.
  const uniq=(arr)=>[...new Set(arr.filter(Boolean))];
  const materialRows=(sid)=>{
    const es=installed.filter(e=>stOf(e)===sid);
    const map=new Map();
    es.forEach(e=>{
      const f=e.fields||{};
      const rate=(f.appliedRate!=null)?f.appliedRate:'';
      const key=`${e.seedMix||''}__${rate}__${f.requiredUnit||''}`;
      if(!map.has(key)) map.set(key,[]);
      map.get(key).push(e);
    });
    return [...map.values()].map(g=>{
      const f0=g[0].fields||{};
      const rateUnit=f0.requiredUnit?f0.requiredUnit+'/ac':'';
      return {
        mix:g[0].seedMix||'',
        rate:f0.appliedRate!=null?(rateUnit?f0.appliedRate+' '+rateUnit:String(f0.appliedRate)):'',
        cov:g.reduce((a,e)=>a+measure(e),0),
        seedTags:g.reduce((a,e)=>a+((e.fields&&e.fields.seedTagCount)||0),0),
        required:g.reduce((a,e)=>a+((e.fields&&e.fields.requiredAmount)||0),0),
        reqUnit:(g.find(e=>e.fields&&e.fields.requiredUnit)||{}).fields?.requiredUnit||'',
        actual:g.reduce((a,e)=>a+((e.fields&&e.fields.actualAmount)||0),0),
        actUnit:(g.find(e=>e.fields&&e.fields.actualUnit)||{}).fields?.actualUnit||'',
        method:uniq(g.map(e=>e.method)).length===1?g[0].method:'',
        contractor:uniq(g.map(e=>e.contractor)).length===1?g[0].contractor:'',
        photos:g.reduce((a,e)=>a+(Array.isArray(e.photoIds)?e.photoIds.length:0),0),
      };
    });
  };

  // ── Coverage Summary — the headline section: AMBER band, larger, all columns ──
  const sh=ws.addRow(['COVERAGE SUMMARY — totals vs plan']); ws.mergeCells(sh.number,1,sh.number,NC);
  sh.getCell(1).font={bold:true,size:15,color:{argb:'FF0F1F2E'}};
  sh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'C9A84C'}};
  sh.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; sh.height=28;
  const hdr=ws.addRow(COLS);
  hdr.eachCell({includeEmpty:true},c=>{ c.font={bold:true,size:10,color:{argb:WHITE}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}}; c.alignment={vertical:'middle',wrapText:true}; });
  hdr.height=20;
  childStates.forEach(s=>{
    const fill=_xlHex(s.color);
    const rows=materialRows(s.id);
    // A state with no drawings still shows one (empty) line so the legend reads complete.
    const list=rows.length?rows:[{mix:'',rate:'',cov:0,seedTags:0,required:0,reqUnit:'',actual:0,actUnit:'',method:'',contractor:'',photos:0}];
    list.forEach(g=>{
      // Uncapped — over-coverage (>100%) shows truthfully; the data bar still maxes at 100.
      const pct=planTotal>0?(g.cov/planTotal)*100:null;
      const r=ws.addRow([
        s.label, fmt(g.cov), pct!=null?Math.round(pct):'', '',
        g.seedTags||'', g.mix||'', g.rate||'',
        g.required?g.required.toLocaleString()+(g.reqUnit?' '+g.reqUnit:''):'',
        g.actual?g.actual.toLocaleString()+(g.actUnit?' '+g.actUnit:''):'',
        g.method||'', g.contractor||'', '', g.photos||'',
      ]);
      r.eachCell({includeEmpty:true},c=>{ c.font={name:'Calibri',size:11}; c.alignment={vertical:'middle',wrapText:true}; });
      if(fill){ r.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}}; r.getCell(1).font={name:'Calibri',size:11,bold:true,color:{argb:_xlContrast(s.color)}}; }
      else r.getCell(1).font={name:'Calibri',size:11,bold:true};
      r.getCell(3).font={name:'Calibri',size:11,bold:true}; if(pct!=null) r.getCell(3).numFmt='0"%"';
      // Color-coded progress bar: red ≤ 50% · yellow 51–90% · green > 90% (per-row rule so
      // each bar takes the color of its own value).
      if(pct!=null){
        const bc=pct<=50?'FFC0392B':(pct<=90?'FFF1C40F':'FF27AE60');
        ws.addConditionalFormatting({ ref:`C${r.number}`, rules:[{type:'dataBar',cfvo:[{type:'num',value:0},{type:'num',value:100}],color:{argb:bc}}] });
      }
      r.height=22;
    });
  });
  // Planned-area total — the denominator, banded headline.
  const pr=ws.addRow(['Planned area (total)', fmt(planTotal)]);
  pr.getCell(1).font={bold:true,size:14}; pr.getCell(2).font={bold:true,size:14,color:{argb:'FF006B75'}};
  // Band the whole row out to the last column (Nick: extend the total-row formatting to col M
  // for consistency) — amber fill across, medium top/bottom rule, closed off left + right.
  const _tb={top:{style:'medium',color:{argb:'FFC9A84C'}},bottom:{style:'medium',color:{argb:'FFC9A84C'}}};
  for(let c=1;c<=NC;c++){
    pr.getCell(c).fill={type:'pattern',pattern:'solid',fgColor:{argb:AMBER_LIGHT}};
    pr.getCell(c).border={..._tb,...(c===1?{left:{style:'medium',color:{argb:'FFC9A84C'}}}:{}),...(c===NC?{right:{style:'medium',color:{argb:'FFC9A84C'}}}:{})};
  }
  pr.height=26;
  // (Per-row color-coded data bars were added in the loop above.)
  if(!childStates.length){ const r=ws.addRow(['—','No states defined']); r.getCell(2).font={italic:true,size:10,color:{argb:'FF999999'}}; }
  ws.addRow([]);

  // ── By Drawing — one row per drawn layer (full client columns), grouped under each
  //    planned area; the Coverage Summary above carries the grand per-state totals. ──
  const bh=ws.addRow(['By Drawing (location)']); ws.mergeCells(bh.number,1,bh.number,NC);
  bh.getCell(1).font={bold:true,size:13,color:{argb:WHITE}};
  bh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:TEAL}};
  bh.getCell(1).alignment={vertical:'middle',horizontal:'left',indent:1}; bh.height=22;

  const renderGroup=async (label, planArea, kids, owners)=>{
    // Per-drawing TITLE bar — drawing name + (location), with the plan area on the right.
    const dh=ws.addRow([label, planArea!=null?`Plan: ${fmt(planArea)}`:'']);
    ws.mergeCells(dh.number,2,dh.number,NC);
    dh.getCell(1).font={bold:true,size:13,color:{argb:'FF006B75'}};
    dh.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'E8F4F5'}};
    dh.getCell(2).font={bold:true,italic:true,size:11,color:{argb:'FF006B75'}};
    dh.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:'E8F4F5'}};
    dh.getCell(2).alignment={horizontal:'right'}; dh.height=24;
    const ch=ws.addRow(COLS);
    ch.eachCell({includeEmpty:true},c=>{ c.font={bold:true,size:10,color:{argb:'FF006B75'}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'E8F4F5'}}; c.border={bottom:{style:'thin',color:{argb:'FF006B75'}}}; c.alignment={vertical:'middle',wrapText:true}; }); ch.height=20;
    const sorted=kids.slice().sort((a,b)=>(stOrd(a)-stOrd(b))||String(a.date||'').localeCompare(String(b.date||'')));
    if(!sorted.length){ const r=ws.addRow(['—','No layers drawn yet']); r.getCell(2).font={italic:true,size:9,color:{argb:'FF999999'}}; r.height=20; }
    sorted.forEach(e=>{
      const s=stById[stOf(e)]||null;
      const f=e.fields||{};
      const rateUnit=f.requiredUnit?f.requiredUnit+'/ac':'';
      const cov=measure(e);
      const pct=(planArea>0)?(cov/planArea)*100:null; // uncapped (truthful over-coverage)
      const r=ws.addRow([
        s?s.label:(e.state||''),
        fmt(cov),
        pct!=null?Math.round(pct):'',
        e.date||'',
        f.seedTagCount!=null?f.seedTagCount:'',
        e.seedMix||'',
        f.appliedRate!=null?(rateUnit?f.appliedRate+' '+rateUnit:f.appliedRate):'',
        f.requiredAmount!=null?f.requiredAmount+' '+(f.requiredUnit||''):'',
        f.actualAmount!=null?f.actualAmount+' '+(f.actualUnit||''):'',
        e.method||'', e.contractor||'', e.notes||'',
        Array.isArray(e.photoIds)?e.photoIds.length:'',
      ]);
      r.eachCell({includeEmpty:true},c=>{ c.font={name:'Calibri',size:10}; c.alignment={vertical:'top',wrapText:true}; });
      const fill=s?_xlHex(s.color):null;
      if(fill){ r.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}}; r.getCell(1).font={name:'Calibri',size:10,bold:true,color:{argb:_xlContrast(s.color)}}; }
      else r.getCell(1).font={name:'Calibri',size:10,bold:true};
      r.getCell(3).font={name:'Calibri',size:10,bold:true}; if(pct!=null) r.getCell(3).numFmt='0"%"';
      r.height=30; // padding so wrapped notes / mix read without expanding the row
    });
    // This drawing's map captures, inline + collapsed right under it (no separate list).
    await _embedCapturesInline(ws, wb, owners, NC);
    ws.addRow([]);
  };

  const planIds=new Set(planned.map(p=>p.id));
  const sortedPlans=planned.slice().sort((a,b)=>String(a.location||'').localeCompare(String(b.location||'')));
  for(let i=0;i<sortedPlans.length;i++){
    const p=sortedPlans[i];
    // p.name = future per-drawing name field (forward-compat); falls back to notes → Area N.
    const nm=p.name||p.notes||`Area ${i+1}`;
    const lbl=p.location?`${nm} (${p.location})`:nm;
    const kids=installed.filter(e=>e.parentId===p.id);
    await renderGroup(lbl, measure(p), kids, [p, ...kids]);
  }
  const unlinked=installed.filter(e=>!e.parentId||!planIds.has(e.parentId));
  if(unlinked.length) await renderGroup('Unlinked drawings', null, unlinked, unlinked);
  if(!planned.length && !installed.length){ const r=ws.addRow(['—','No entries yet']); r.getCell(2).font={italic:true,size:10,color:{argb:'FF999999'}}; }

  // Min-height pass — skip the hidden capture-image rows so their reserved height holds.
  ws.eachRow((row,rn)=>{ if(rn===1||row.hidden) return; if(!row.height||row.height<18) row.height=18; });
}

// ── Material Tag photo ZIP export ──
async function _tlogExportPhotoZip(entries, pid){
  const {default:JSZip}=await import('jszip');
  const zip=new JSZip();
  const cfg=JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
  const today=new Date().toLocaleDateString('en-CA');

  for(const e of entries){
    const types=e.photoTypes||{};
    // Bundle a photo if it's tagged material_tag OR if the photo record type is map_capture
    const includeIds=(e.photoIds||[]).filter(id=>{
      if(types[id]==='material_tag') return true;
      const ph=(window._phPhotos||[]).find(p=>p.id===id);
      return ph?.type==='map_capture';
    });
    if(!includeIds.length) continue;
    const catName=(e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown'))
      .replace(/[^a-zA-Z0-9 _-]/g,'').trim();
    const folder=zip.folder(`${e.date||'unknown'} ${catName}`.trim());
    for(const photoId of includeIds){
      const photo=(window._phPhotos||[]).find(p=>p.id===photoId);
      if(!photo?.storageUrl) continue;
      try{
        const resp=await fetch(photo.storageUrl);
        if(!resp.ok) continue;
        const blob=await resp.blob();
        const ext=(photo.filename||'photo.jpg').split('.').pop()||'jpg';
        const captionSource=(e.photoCaptions||{})[photoId]||photo?.caption||null;
        const idx=includeIds.indexOf(photoId)+1;
        const safeName=captionSource
          ?captionSource.replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,50)
          :`${e.date||'photo'}-${catName}-${idx}`;
        folder.file(`${safeName}.${ext}`,blob);
      }catch{ /* skip failed fetches silently */ }
    }
  }

  const buf=await zip.generateAsync({type:'blob'});
  const safeName=(cfg.projectName||pid).replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-');
  await _glShareOrDownload(new Blob([buf],{type:'application/zip'}),`material-tags-${safeName}-${today}.zip`,'application/zip');
}

// ── Init compliance log ──
async function clInit(){
  clLoadLocal();
  const fromCloud = await clLoadCloud();
  if(!fromCloud) clLoadLocal(); // fallback
  clRender();
  _glMigrateCompliancePhaseD();
}

// ── Expose to window for HTML onclick handlers and cross-module calls ──
window.clInit = clInit;
window.clRender = clRender;
window.clAutoDetect = clAutoDetect;
window.clShowForm = clShowForm;
window.clAutoImport = clAutoImport;
window.clHideForm = clHideForm;
window.clToggleResolvedDate = clToggleResolvedDate;
window.clSubmitForm = clSubmitForm;
window.clEditEntry = clEditEntry;
window.clConfirmDelete = clConfirmDelete;
window.clRenderTrackerCard = clRenderTrackerCard;
window.clShowTrackerDetail = clShowTrackerDetail;
window.clShowTrackerLog = clShowTrackerLog;
window.clShowPhotoAttachPicker = clShowPhotoAttachPicker;
window.clTogglePhotoLink = clTogglePhotoLink;
window.clUnlinkPhoto = clUnlinkPhoto;
window.clRefreshDetailPhotoStrip = clRefreshDetailPhotoStrip;
