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

// ── Persistence: localStorage ──
function clSaveLocal(){
  try{ localStorage.setItem('cl_entries', JSON.stringify(_clEntries)); }catch{}
}

function clLoadLocal(){
  try{
    const raw = localStorage.getItem('cl_entries');
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

  clRenderTrackerCard(search);
  const list = document.getElementById('cl-list');
  if(!list) return;

  if(entries.length===0){
    list.innerHTML = '<div class="cl-empty">'+(
      _clEntries.length===0
        ? 'No compliance entries yet.<br>Tap <strong>+ Add Entry</strong> to log an observation.'
        : 'No entries match the current filters.'
    )+'</div>';
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
  document.getElementById('cl-f-date').value = new Date().toISOString().split('T')[0];
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
    document.getElementById('cl-f-resolved').value = new Date().toISOString().split('T')[0];
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
function clRenderTrackerCard(search){
  const el=document.getElementById('cl-tracker-card');
  if(!el) return;
  const today=new Date().toISOString().split('T')[0];
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
  if(!entries.length){ el.style.display='none'; return; }
  const rows=entries.map(e=>{
    const catColor=(typeof tcGetColor==='function')?tcGetColor(e.categoryId,pid):'#888';
    const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown');
    const photoCount=Array.isArray(e.photoIds)?e.photoIds.length:0;
    return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:4px">
      <div style="width:10px;height:10px;border-radius:50%;background:${catColor};flex-shrink:0"></div>
      <span style="font-family:var(--mono);font-size:11px;color:var(--text);flex:1">${catName}</span>
      ${e.acres?`<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${e.acres} ac</span>`:''}
      ${photoCount?`<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">📷${photoCount}</span>`:''}
      <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">›</span>
    </div>`;
  }).join('');
  el.innerHTML=`<div class="card">
    <div class="card-head"><span class="card-num">🗺️</span><span class="card-title">Today's Tracker Activity</span><span class="card-badge">${entries.length}</span></div>
    <div class="card-body" style="padding-top:4px">${rows}</div>
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
      ${entry.acres?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Area</span><div style="margin-top:2px">${entry.acres} acres</div></div>`:''}
      ${entry.location?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Location</span><div style="margin-top:2px">${entry.location}</div></div>`:''}
      ${entry.notes?`<div><span style="color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Notes</span><div style="margin-top:2px;line-height:1.5">${entry.notes}</div></div>`:''}
    </div>
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
  document.getElementById('_cltrdelete').onclick=async()=>{
    if(typeof trDeleteEntry==='function') await trDeleteEntry(entryId,pid);
    ov.remove();
    if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
  };
  document.getElementById('_cltrattach').onclick=()=>clShowPhotoAttachPicker(entryId);
  document.getElementById('_cltredit').onclick=()=>{
    ov.remove();
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
window.clShowPhotoAttachPicker = clShowPhotoAttachPicker;
window.clTogglePhotoLink = clTogglePhotoLink;
window.clUnlinkPhoto = clUnlinkPhoto;
window.clRefreshDetailPhotoStrip = clRefreshDetailPhotoStrip;
