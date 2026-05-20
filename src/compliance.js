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

  clRenderTrackerCard();
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
function clRenderTrackerCard(search){
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
  const totals=(typeof trGetCumulativeTotals==='function')?trGetCumulativeTotals(pid):[];
  if(!entries.length && !totals.length){ el.style.display='none'; return; }

  const todayRows=entries.map(e=>{
    const catColor=(typeof tcGetColor==='function')?tcGetColor(e.categoryId,pid):'#888';
    const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown');
    const photoCount=Array.isArray(e.photoIds)?e.photoIds.length:0;
    const measDisplay=e.measurementValue!=null&&e.measurementUnit
      ?(typeof tcFormatMeasurement==='function'?tcFormatMeasurement(e.measurementValue,e.measurementUnit):`${e.measurementValue} ${e.measurementUnit}`)
      :(e.acres?`${e.acres} ac`:'');
    return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:4px">
      <div style="width:12px;height:12px;border-radius:50%;background:${catColor};flex-shrink:0"></div>
      <span style="font-family:var(--mono);font-size:12px;color:var(--text);flex:1">${catName}</span>
      ${measDisplay?`<span style="font-family:var(--mono);font-size:12px;color:var(--muted)">${measDisplay}</span>`:''}
      ${photoCount?`<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">📷${photoCount}</span>`:''}
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">›</span>
    </div>`;
  }).join('');

  const todaySection=entries.length?`<div style="padding:0 4px 4px">${todayRows}</div>`:'';

  const totalsSection=totals.length?`<div style="border-top:${entries.length?'2px solid var(--border2)':'none'};padding:10px 4px 4px">
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Project Totals</div>
    ${totals.map(t=>{
      const catColor=(typeof tcGetColor==='function')?tcGetColor(t.categoryId,pid):'#888';
      const totalFmt=(typeof tcFormatMeasurement==='function')
        ?tcFormatMeasurement(t.totalValue??t.totalAcres??0,t.displayUnit||'ac')
        :`${(t.totalValue??t.totalAcres??0).toFixed(2)} ${t.displayUnit||'ac'}`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
        <div style="width:10px;height:10px;border-radius:50%;background:${catColor};flex-shrink:0"></div>
        <span style="font-family:var(--mono);font-size:12px;color:var(--text);flex:1">${t.categoryName}</span>
        <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${t.entryCount} ${t.entryCount===1?'entry':'entries'}</span>
        <span style="font-family:var(--mono);font-size:12px;color:var(--amber);font-weight:600">${totalFmt}</span>
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
        <button id="_tlog-export" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--amber);font-family:var(--mono);font-size:11px;padding:7px 12px;cursor:pointer;min-height:36px">⬇ CSV</button>
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
    }).sort((a,b)=>b.date>a.date?1:b.date<a.date?-1:0);
  }

  function _tlogRender(){
    const entries=_tlogFilter();
    const liveCats=(typeof tcGetCategories==='function')?tcGetCategories(pid):[];
    const totalAcres=entries.reduce((s,e)=>s+(parseFloat(e.acres)||0),0);
    const totalPhotos=entries.reduce((s,e)=>s+(Array.isArray(e.photoIds)?e.photoIds.length:0),0);
    const res=document.getElementById('_tlog-results');
    const foot=document.getElementById('_tlog-footer');

    if(!entries.length){
      res.innerHTML=`<div style="font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center;padding:40px 20px">No entries match.</div>`;
      foot.textContent='';
      return;
    }

    const isGrouped=!_tlSearch&&!_tlFrom&&!_tlTo&&!_tlCat;

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
        const gAcres=g.entries.reduce((s,e)=>s+(parseFloat(e.acres)||0),0);
        const gPhotos=g.entries.reduce((s,e)=>s+(Array.isArray(e.photoIds)?e.photoIds.length:0),0);
        const rows=g.entries.map(e=>{
          const pc=Array.isArray(e.photoIds)?e.photoIds.length:0;
          const rc=Array.isArray(e.reportIds)?e.reportIds.length:0;
          const stc=e.fields?.seedTagCount||0;
          const rowMeas=(e.measurementValue!=null&&e.measurementUnit)
            ?`<span style="font-family:var(--mono);font-size:10px;color:var(--amber);white-space:nowrap;flex-shrink:0">${(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(e.measurementValue,e.measurementUnit):(e.measurementValue+' '+e.measurementUnit)}</span>`
            :e.acres?`<span style="font-family:var(--mono);font-size:10px;color:var(--amber);white-space:nowrap;flex-shrink:0">${e.acres} ac</span>`:'';
          return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:8px;padding:9px 16px 9px 30px;border-top:1px solid var(--border);cursor:pointer">
            <span style="font-family:var(--mono);font-size:10px;color:var(--text);white-space:nowrap;flex-shrink:0;min-width:68px">${e.date||'—'}</span>
            <span style="font-family:var(--mono);font-size:11px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(e.notes||'').slice(0,42)}</span>
            ${rowMeas}
            ${pc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">📷 ${pc}</span>`:''}
            ${stc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">🏷️ ${stc}</span>`:''}
            ${rc?`<span style="font-size:10px;flex-shrink:0;color:var(--text)">📋 ${rc}</span>`:''}
            <span style="color:var(--muted);flex-shrink:0;font-size:12px">›</span>
          </div>`;
        }).join('');
        const meta=[gAcres>0?`${gAcres.toFixed(2)} ac`:'',gPhotos>0?`📷 ${gPhotos}`:'',`${g.entries.length} ${g.entries.length===1?'entry':'entries'}`].filter(Boolean).join(' · ');
        // Cumulative actual vs required bar — only when entries share the same actual unit
        const catBar=(()=>{
          const withBoth=g.entries.filter(e=>e.fields?.actualAmount!=null&&e.fields?.requiredAmount!=null);
          if(!withBoth.length) return '';
          const units=[...new Set(withBoth.map(e=>e.fields.actualUnit||'lbs'))];
          if(units.length>1) return ''; // mixed units — skip
          const totalReq=withBoth.reduce((s,e)=>s+(e.fields.requiredAmount||0),0);
          const totalAct=withBoth.reduce((s,e)=>s+(e.fields.actualAmount||0),0);
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
        return `<div style="border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--s1)">
            <div style="width:10px;height:10px;border-radius:50%;background:${g.cat.color};flex-shrink:0"></div>
            <span style="font-family:var(--cond);font-weight:700;font-size:13px;letter-spacing:.04em;flex:1">${g.cat.name}</span>
            <span style="font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap">${meta}</span>
          </div>
          ${catBar}
          ${rows}
        </div>`;
      }).join('');
    } else {
      // Flat list — search/filter active
      res.innerHTML=entries.map(e=>{
        const cached=liveCats.find(c=>c.id===e.categoryId);
        const catName=cached?cached.name:(e.categoryName&&!e.categoryName.startsWith('cat-')?e.categoryName:'Unknown');
        const cat=cached||{color:'#888',name:catName};
        const pc=Array.isArray(e.photoIds)?e.photoIds.length:0;
        const rc=Array.isArray(e.reportIds)?e.reportIds.length:0;
        const stc=e.fields?.seedTagCount||0;
        const sub=[e.date||'',e.notes||''].filter(Boolean).join(' · ');
        const flatMeas=(e.measurementValue!=null&&e.measurementUnit)
          ?`<span style="font-family:var(--mono);font-size:11px;color:var(--amber);white-space:nowrap;flex-shrink:0">${(typeof tcFormatMeasurement==='function')?tcFormatMeasurement(e.measurementValue,e.measurementUnit):(e.measurementValue+' '+e.measurementUnit)}</span>`
          :e.acres?`<span style="font-family:var(--mono);font-size:11px;color:var(--amber);white-space:nowrap;flex-shrink:0">${e.acres} ac</span>`:'';
        return `<div onclick="clShowTrackerDetail('${e.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer">
          <div style="width:10px;height:10px;border-radius:50%;background:${cat.color};flex-shrink:0"></div>
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--mono);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cat.name}</div>
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
    if(totalAcres>0) parts.push(`${totalAcres.toFixed(2)} ac total`);
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

  // CSV export — always exports currently filtered view
  document.getElementById('_tlog-export').onclick=()=>{
    const rows=[['Date','Category','Acres','Location','Notes','Photos (count)']];
    _tlogFilter().forEach(e=>{
      const catName=e.categoryName||(typeof tcGetName==='function'?tcGetName(e.categoryId,pid):'Unknown');
      rows.push([
        e.date||'',
        catName,
        e.acres||'',
        e.location||'',
        e.notes||'',
        Array.isArray(e.photoIds)?e.photoIds.length:0
      ]);
    });
    const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
    const blob=new Blob([csv],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`tracker-log-${pid}-${new Date().toLocaleDateString('en-CA')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
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
