// ═══════════════════════════════════════════
// OPEN ITEMS — carryover notes & tasks (the spine)
// ═══════════════════════════════════════════
// Project-scoped personal working memory: notes and tasks that persist until
// resolved — they are NOT day-keyed, so nothing "carries over" by copying;
// items simply live until checked off. The daily-log 📌 card is the field
// view; resolutions can opt into that day's report (evidence trail).
//
// Storage: projects/{pid}/openItems/{id} per-item docs (private-by-default,
// owner-only reads/writes — see firestore.rules), IDB cache `oi_entries::{pid}`,
// dirty-ID flush batched (photos pattern), `_mts` newest-wins merge per item,
// deletes are tombstones (45-day purge). Sources: 'manual' today; 'flag' /
// 'qi' / 'auto' (rain trigger) join the same spine in the next chunk.
// Reminders: per-item + daily digest via @capacitor/local-notifications
// (native only, lazy-imported); web gets the in-app new-day summary.

var _oiItems = [];
var _oiLoadedPid = null;
var _oiExpanded = null;
var _oiResolvedOpen = false;
var _oiNewKind = 'task';

// ── Helpers ──
function _oiPid(){ return (typeof window._activeProjectId==='function') ? window._activeProjectId() : 'default'; }
function _oiUid(){ return (typeof _currentUser!=='undefined' && _currentUser) ? _currentUser.uid : null; }
function _oiToday(){ return (typeof window.localToday==='function') ? window.localToday() : new Date().toISOString().slice(0,10); }
function _oiGenId(){ return 'oi'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function _oiEsc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _oiNative(){ return document.body.classList.contains('is-native'); }
function _oiFmtDate(d){
  if(!d) return '';
  const p=String(d).split('-');
  if(p.length!==3) return d;
  return parseInt(p[1])+'/'+parseInt(p[2])+'/'+p[0].slice(2);
}
function _oiAgeDays(it){
  if(!it.createdTs) return 0;
  return Math.floor((Date.now()-it.createdTs)/86400000);
}

// ── Persistence: IDB cache + dirty flush (photos dirty-ID pattern, small scale) ──
function _oiSaveLocal(){
  try{ if(window.idbSet) window.idbSet('oi_entries::'+_oiPid(), JSON.stringify(_oiItems)); }catch{}
}
function _oiLoadLocal(pid){
  try{
    const raw = window.idbGet && window.idbGet('oi_entries::'+pid);
    _oiItems = raw ? JSON.parse(raw) : [];
  }catch{ _oiItems = []; }
}
function _oiDirtyKey(){ return 'gl_oi_dirty::'+_oiPid(); }
function _oiDirtyGet(){ try{ return JSON.parse(localStorage.getItem(_oiDirtyKey())||'[]'); }catch{ return []; } }
function _oiMarkDirty(id){
  const d=_oiDirtyGet();
  if(!d.includes(id)) d.push(id);
  try{ localStorage.setItem(_oiDirtyKey(), JSON.stringify(d)); }catch{}
}
function _oiDirtyClear(ids){
  const d=_oiDirtyGet().filter(x=>!ids.includes(x));
  try{ localStorage.setItem(_oiDirtyKey(), JSON.stringify(d)); }catch{}
}

async function _oiFlush(){
  const pid=_oiPid(), uid=_oiUid();
  if(!uid || pid==='default' || typeof _projData!=='function' || !window._fbReady) return;
  const dirty=_oiDirtyGet();
  if(!dirty.length) return;
  const ref=_projData(pid).collection('openItems');
  const docs=dirty.map(id=>_oiItems.find(it=>it.id===id)).filter(Boolean);
  try{
    // Batched, awaited — never per-doc fire-and-forget (write-discipline rule).
    const batch=db.batch();
    docs.forEach(it=>batch.set(ref.doc(it.id), it));
    await batch.commit();
    _oiDirtyClear(docs.map(it=>it.id));
  }catch(e){
    console.warn('openItems flush failed (stays pending):', e.message);
  }
}

// ── Cloud load + per-item newest-wins merge ──
async function oiLoadForProject(){
  const pid=_oiPid();
  _oiLoadedPid=pid;
  _oiExpanded=null;
  _oiLoadLocal(pid);
  oiRender();
  const uid=_oiUid();
  if(!uid || pid==='default' || typeof _projData!=='function' || !window._fbReady) return;
  try{
    const snap=await _projData(pid).collection('openItems').where('ownerUid','==',uid).get();
    if(_oiLoadedPid!==pid) return; // project switched mid-flight
    const cloud={};
    snap.forEach(d=>{ cloud[d.id]=d.data(); });
    const dirty=_oiDirtyGet();
    const merged={};
    _oiItems.forEach(it=>{ merged[it.id]=it; });
    Object.keys(cloud).forEach(id=>{
      const c=cloud[id], l=merged[id];
      // local wins only when newer or still pending push
      if(!l || ((c._mts||0)>=(l._mts||0) && !dirty.includes(id))) merged[id]=c;
    });
    // local-only items not yet in cloud → ensure queued
    Object.keys(merged).forEach(id=>{ if(!cloud[id]) _oiMarkDirty(id); });
    // tombstone purge (display already skips them)
    const cutoff=Date.now()-45*86400000;
    _oiItems=Object.values(merged).filter(it=>!(it.deleted && (it._mts||0)<cutoff));
    _oiSaveLocal();
    oiRender();
    _oiFlush();
  }catch(e){ console.warn('openItems load failed:', e.message); }
  oiSyncSources();
  _oiNotifSync();
}

function oiBoot(){
  _oiDigestHydrate();
  oiSettingsInit();
  oiLoadForProject();
}

// ── Queries ──
function oiOpenItems(){ return _oiItems.filter(it=>!it.deleted && it.status==='open'); }
function oiOpenCount(){ return oiOpenItems().length; }
function oiDueTodayCount(){
  const t=_oiToday();
  return oiOpenItems().filter(it=>it.dueDate && it.dueDate<=t).length;
}
function oiResolvedForReport(dateStr){
  return _oiItems.filter(it=>!it.deleted && it.status==='resolved'
    && it.includeInReport && it.resolvedDate===dateStr);
}
function _oiResolvedToday(){
  const t=_oiToday();
  return _oiItems.filter(it=>!it.deleted && it.status==='resolved' && it.resolvedDate===t);
}

// ── Mutations ──
function _oiTouch(it){
  it._mts=Date.now();
  _oiSaveLocal();
  _oiMarkDirty(it.id);
  _oiFlush();
}

function oiAdd(){
  const inp=document.getElementById('oi-new-text');
  const text=(inp&&inp.value||'').trim();
  if(!text) return;
  const uid=_oiUid();
  const it={
    id:_oiGenId(), ownerUid:uid||'', kind:_oiNewKind, text,
    source:'manual', sourceRef:null,
    createdDate:_oiToday(), createdTs:Date.now(),
    dueDate:'', remindAt:'',
    status:'open', resolvedDate:'', resolvedTs:0, resolutionNote:'',
    includeInReport:false, visibility:'private', deleted:false, _mts:Date.now()
  };
  _oiItems.push(it);
  if(inp) inp.value='';
  _oiSaveLocal(); _oiMarkDirty(it.id); _oiFlush();
  oiRender();
  window.glHaptic && window.glHaptic.light && window.glHaptic.light();
}

function oiToggleNewKind(){
  _oiNewKind = (_oiNewKind==='task') ? 'note' : 'task';
  const b=document.getElementById('oi-new-kind');
  if(b) b.textContent = (_oiNewKind==='task') ? '☑︎ Task' : '📝 Note';
}

function oiExpand(id){
  _oiExpanded = (_oiExpanded===id) ? null : id;
  oiRender();
}

function oiFieldChange(id, field, value){
  const it=_oiItems.find(x=>x.id===id);
  if(!it) return;
  if(field==='text'){ const v=String(value).trim(); if(!v) return; it.text=v; }
  else if(field==='kind'){ it.kind = (value==='note')?'note':'task'; }
  else if(field==='dueDate'){ it.dueDate=value||''; }
  else if(field==='remindAt'){ it.remindAt=value||''; }
  _oiTouch(it);
  // NO re-render here — iOS fires `change` on the first tap inside a date /
  // datetime picker, and re-rendering destroys the input mid-interaction,
  // slamming the picker shut (Tim, 7/22). The input already shows the new
  // value; chips/labels catch up on the next render (row close, resolve, sync).
  if(field==='remindAt') _oiNotifSync();
}

function oiDelete(id){
  const it=_oiItems.find(x=>x.id===id);
  if(!it) return;
  window._confirmModal('Delete this item? It will be removed from your Open Items (not from any report it was already included in).', function(){
    it.deleted=true;
    _oiExpanded=null;
    _oiTouch(it);
    oiRender();
    _oiNotifSync();
  }, '🗑 Delete Item', 'Delete');
}

// ── Resolve modal — note + opt-in report stamping ──
function oiResolve(id){
  const it=_oiItems.find(x=>x.id===id);
  if(!it || it.status!=='open') return;
  // Flag-born items route into the flag's own Fix flow (one source of truth —
  // its note + history land on the punchlist); the sync pass then resolves
  // this item automatically off the fixed flag.
  if(it.source==='flag' && typeof window.mapResolveTemporary==='function'){
    window.mapResolveTemporary(it.sourceRef);
    return;
  }
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:5000';
  ov.innerHTML='<div class="modal-box" style="max-width:360px;width:92%;text-align:left">'
    +'<div class="modal-title" style="margin-bottom:6px">✓ Resolve Item</div>'
    +'<div style="font-family:var(--body);font-size:13.5px;color:var(--text);line-height:1.45;margin-bottom:12px;background:rgba(0,107,117,0.08);border:1px solid var(--border2);border-radius:6px;padding:9px 11px">'+_oiEsc(it.text)+'</div>'
    +'<div class="field" style="margin-bottom:12px"><label>Resolution note <span style="text-transform:none;letter-spacing:0">(optional)</span></label>'
    +'<textarea id="_oi-res-note" class="short" style="min-height:64px" placeholder="What was done / outcome…"></textarea></div>'
    +'<label style="display:flex;align-items:center;gap:9px;margin-bottom:16px;cursor:pointer;font-family:var(--mono);font-size:11.5px;letter-spacing:.05em;color:var(--muted2);text-transform:uppercase">'
    +'<input type="checkbox" id="_oi-res-rpt" style="width:17px;height:17px;accent-color:var(--amber)">Include in today’s daily report</label>'
    +'<div style="display:flex;gap:8px">'
    +'<button class="btn btn-outline" style="flex:1" id="_oi-res-cancel">Cancel</button>'
    +'<button class="btn btn-amber" style="flex:2" id="_oi-res-ok">✓ Resolve</button>'
    +'</div></div>';
  document.body.appendChild(ov);
  ov.querySelector('#_oi-res-cancel').onclick=()=>ov.remove();
  ov.querySelector('#_oi-res-ok').onclick=()=>{
    it.status='resolved';
    it.resolvedDate=_oiToday();
    it.resolvedTs=Date.now();
    it.resolutionNote=(ov.querySelector('#_oi-res-note').value||'').trim();
    it.includeInReport=!!ov.querySelector('#_oi-res-rpt').checked;
    ov.remove();
    _oiExpanded=null;
    _oiTouch(it);
    // Compliance-born: push the resolution back to the Compliance Log entry
    // so the two never diverge (status + dateResolved only — corrective text
    // stays the entry's own).
    if(it.source==='cl' && typeof window.clGetEntries==='function'){
      const e=window.clGetEntries().find(x=>x.id===it.sourceRef);
      if(e && e.status!=='Resolved'){
        e.status='Resolved'; e.dateResolved=_oiToday();
        if(typeof window.clSave==='function') window.clSave();
        if(typeof window.clRender==='function'){ try{ window.clRender(); }catch{} }
      }
    }
    oiRender();
    _oiNotifSync();
    window.glHaptic && window.glHaptic.success && window.glHaptic.success();
  };
}

function oiReopen(id){
  const it=_oiItems.find(x=>x.id===id);
  if(!it) return;
  it.status='open';
  it.resolvedDate=''; it.resolvedTs=0; it.resolutionNote=''; it.includeInReport=false;
  _oiTouch(it);
  // Sourced items reopen their source too — mirrors never diverge.
  if(it.source==='flag' && typeof window.trReopenTemporary==='function'){
    window.trReopenTemporary(it.sourceRef);
    if(typeof window.mapRenderTrackerLayers==='function'){ try{ window.mapRenderTrackerLayers(); }catch{} }
    if(typeof window.clRenderPunchlist==='function'){ try{ window.clRenderPunchlist(); }catch{} }
  }
  if(it.source==='cl' && typeof window.clGetEntries==='function'){
    const e=window.clGetEntries().find(x=>x.id===it.sourceRef);
    if(e && e.status==='Resolved'){
      e.status='Open'; e.dateResolved='';
      if(typeof window.clSave==='function') window.clSave();
      if(typeof window.clRender==='function'){ try{ window.clRender(); }catch{} }
    }
  }
  oiRender();
  _oiNotifSync();
}

function oiToggleResolved(){
  _oiResolvedOpen=!_oiResolvedOpen;
  oiRender();
}

// ── Render ──
function oiRender(){
  const list=document.getElementById('oi-list');
  if(!list) return;
  const open=oiOpenItems().slice().sort((a,b)=>(a.createdTs||0)-(b.createdTs||0));
  const today=_oiToday();

  const badge=document.getElementById('oi-badge');
  if(badge){
    const due=oiDueTodayCount();
    badge.textContent=open.length+' open'+(due?' · '+due+' due':'');
    badge.classList.toggle('oi-badge-due', due>0);
  }

  if(!open.length){
    list.innerHTML='<div class="oi-empty">Nothing carried over — add a note or task below and it stays here, day after day, until you check it off.</div>';
  } else {
    list.innerHTML=open.map(it=>{
      const age=_oiAgeDays(it);
      const ageChip=age>0?'<span class="oi-chip" title="Opened '+_oiFmtDate(it.createdDate)+'">'+age+'d</span>':'';
      const dueOver=it.dueDate && it.dueDate<=today;
      const dueChip=it.dueDate?'<span class="oi-chip'+(dueOver?' over':'')+'">due '+_oiFmtDate(it.dueDate)+(dueOver?' ⚠':'')+'</span>':'';
      const remChip=it.remindAt?'<span class="oi-chip" title="Reminder set">🔔</span>':'';
      const srcChip=it.source==='flag'
        ?'<span class="oi-chip" style="cursor:pointer" onclick="event.stopPropagation();clPunchlistGoto(\''+_oiEsc(it.sourceRef)+'\')" title="Repair flag — tap to view on map">🚩</span>'
        :it.source==='cl'?'<span class="oi-chip" title="Compliance Log entry — resolves both places">§8</span>':'';
      const kindIcon=it.kind==='note'?'📝':'';
      const exp=_oiExpanded===it.id;
      let detail='';
      if(exp){
        detail='<div class="oi-detail">'
          +'<div class="field"><label>Text</label><textarea class="short auto-expand" onchange="oiFieldChange(\''+it.id+'\',\'text\',this.value)">'+_oiEsc(it.text)+'</textarea></div>'
          +'<div class="oi-detail-row">'
          +'<div class="field" style="flex:1"><label>Type</label><select onchange="oiFieldChange(\''+it.id+'\',\'kind\',this.value)"><option value="task"'+(it.kind!=='note'?' selected':'')+'>☑︎ Task</option><option value="note"'+(it.kind==='note'?' selected':'')+'>📝 Note</option></select></div>'
          +'<div class="field" style="flex:1"><label>Due date</label><input type="date" value="'+_oiEsc(it.dueDate)+'" onchange="oiFieldChange(\''+it.id+'\',\'dueDate\',this.value)"></div>'
          +'</div>'
          +'<div class="field"><label>Reminder'+(_oiNative()?'':' <span style="text-transform:none;letter-spacing:0">(fires on the iOS app)</span>')+'</label><input type="datetime-local" value="'+_oiEsc(it.remindAt)+'" onchange="oiFieldChange(\''+it.id+'\',\'remindAt\',this.value)"></div>'
          +'<div class="oi-detail-btns">'
          +'<button class="btn btn-outline" style="font-size:10.5px;padding:6px 12px" onclick="oiDelete(\''+it.id+'\')">🗑 Delete</button>'
          +'<button class="btn btn-outline" style="font-size:10.5px;padding:6px 12px;margin-left:auto" onclick="oiExpand(\''+it.id+'\')">Close</button>'
          +'</div></div>';
      }
      return '<div class="oi-row'+(exp?' expanded':'')+'">'
        +'<div class="oi-row-main">'
        +'<button class="oi-check" onclick="oiResolve(\''+it.id+'\')" title="Resolve">'+'</button>'
        +'<div class="oi-text" onclick="oiExpand(\''+it.id+'\')">'+(kindIcon?'<span class="oi-kind">'+kindIcon+'</span> ':'')+_oiEsc(it.text)+'</div>'
        +'<div class="oi-chips">'+srcChip+remChip+dueChip+ageChip+'</div>'
        +'</div>'+detail+'</div>';
    }).join('');
  }

  // Resolved today — collapsed history strip
  const wrap=document.getElementById('oi-resolved-wrap');
  const rlist=document.getElementById('oi-resolved-list');
  if(wrap && rlist){
    const res=_oiResolvedToday().sort((a,b)=>(b.resolvedTs||0)-(a.resolvedTs||0));
    if(!res.length){ wrap.style.display='none'; }
    else{
      wrap.style.display='block';
      const head=document.getElementById('oi-resolved-head');
      if(head) head.innerHTML='✓ Resolved today ('+res.length+') <span style="margin-left:auto">'+(_oiResolvedOpen?'▾':'▸')+'</span>';
      rlist.style.display=_oiResolvedOpen?'block':'none';
      rlist.innerHTML=res.map(it=>'<div class="oi-res-row">'
        +'<span class="oi-res-text">'+_oiEsc(it.text)+'</span>'
        +(it.includeInReport?'<span class="oi-chip" title="Will appear in today’s report">📄</span>':'')
        +'<button class="oi-reopen" onclick="oiReopen(\''+it.id+'\')" title="Reopen">↩</button>'
        +'</div>').join('');
    }
  }

  // New-day modal race heal: checkNewDay can fire before the spine loads on
  // boot — if the modal is up, refresh its Open Items summary now.
  const ndBox=document.getElementById('nd-open-items');
  const ndOv=document.getElementById('nd-overlay');
  if(ndBox && ndOv && ndOv.style.display==='flex'){
    const html=oiNdSummaryHtml();
    ndBox.innerHTML=html;
    ndBox.style.display=html?'block':'none';
  }
}

// ── New-day summary (in-app, all platforms) ──
function oiNdSummaryHtml(){
  const n=oiOpenCount();
  if(!n) return '';
  const due=oiDueTodayCount();
  return '📌 <strong>'+n+' open item'+(n===1?'':'s')+'</strong> carried over'
    +(due?' — <strong style="color:var(--amber)">'+due+' due today</strong>':'')+'.';
}

// ── Daily digest prefs — ON by default, 6:00 AM; per-user, cross-device ──
function oiDigestGet(){
  try{
    const v=JSON.parse(localStorage.getItem('gl_oi_digest')||'null');
    if(v && typeof v.on==='boolean') return v;
  }catch{}
  return {on:true, hour:6, min:0};
}
function _oiDigestSave(v){
  try{ localStorage.setItem('gl_oi_digest', JSON.stringify(v)); }catch{}
  try{
    if(typeof _udb==='function' && window._fbReady && _udb())
      _udb().collection('settings').doc('_user').set({oiDigest:v,_ts:Date.now()},{merge:true}).catch(()=>{});
  }catch{}
  _oiNotifSync();
}
var _oiDigestHydrated=false;
function _oiDigestHydrate(){
  if(_oiDigestHydrated) return;
  _oiDigestHydrated=true;
  try{
    if(typeof _udb!=='function' || !window._fbReady || !_udb()) return;
    _udb().collection('settings').doc('_user').get().then(doc=>{
      const v=doc.exists && doc.data().oiDigest;
      if(v && typeof v.on==='boolean'){
        try{ localStorage.setItem('gl_oi_digest', JSON.stringify(v)); }catch{}
        oiSettingsInit();
        _oiNotifSync();
      }
    }).catch(()=>{});
  }catch{}
}

// ── Settings UI (cfg-openitems section) ──
function oiSettingsInit(){
  const tog=document.getElementById('cfg-oi-digest-on');
  const time=document.getElementById('cfg-oi-digest-time');
  if(!tog||!time) return;
  const v=oiDigestGet();
  tog.checked=v.on;
  time.value=String(v.hour).padStart(2,'0')+':'+String(v.min).padStart(2,'0');
}
function oiDigestChanged(){
  const tog=document.getElementById('cfg-oi-digest-on');
  const time=document.getElementById('cfg-oi-digest-time');
  if(!tog||!time) return;
  const parts=(time.value||'06:00').split(':');
  _oiDigestSave({on:!!tog.checked, hour:parseInt(parts[0])||6, min:parseInt(parts[1])||0});
}

// ── Chunk 2: spine sources — 🚩 flags (opt-in), §8 compliance (auto), 🌧 rain (auto) ──
function _oiAmberDays(){
  const h=(typeof window.clAmberHours==='function')?window.clAmberHours():48;
  return Math.max(1, Math.ceil(h/24));
}
function _oiAddDays(dateStr,n){
  const d=new Date((dateStr||_oiToday())+'T12:00:00');
  if(isNaN(d.getTime())) return '';
  d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
// Any-state lookup — tombstoned/resolved items count, so auto sources never
// respawn something the user already dealt with or deleted.
function oiFindBySource(source,ref){
  return _oiItems.find(x=>x.source===source && x.sourceRef===ref);
}
function _oiSpawn(opts,force){
  const existing=oiFindBySource(opts.source,opts.sourceRef);
  if(existing){
    if(force && existing.deleted){ // explicit re-pin un-tombstones
      existing.deleted=false; existing.status='open';
      existing.resolvedDate=''; existing.resolvedTs=0; existing.resolutionNote=''; existing.includeInReport=false;
      _oiTouch(existing); oiRender();
    }
    return existing;
  }
  const uid=_oiUid();
  if(!uid) return null;
  const cd=opts.createdDate||_oiToday();
  const cts=new Date(cd+'T12:00:00').getTime();
  const it={
    id:_oiGenId(), ownerUid:uid, kind:opts.kind||'task', text:opts.text||'',
    source:opts.source, sourceRef:opts.sourceRef,
    createdDate:cd, createdTs:isFinite(cts)?cts:Date.now(),
    dueDate:opts.dueDate||'', remindAt:'',
    status:'open', resolvedDate:'', resolvedTs:0, resolutionNote:'',
    includeInReport:false, visibility:'private', deleted:false, _mts:Date.now()
  };
  _oiItems.push(it);
  _oiTouch(it);
  oiRender();
  return it;
}

// 🚩 Flags are OPT-IN (Tim's call 7/22): 📌 button on punchlist rows.
function oiFlagPinned(flagId){
  const it=oiFindBySource('flag',flagId);
  return !!(it && !it.deleted);
}
function oiPinFlag(flagId){
  const pid=_oiPid();
  const f=((typeof window.trGetOpenTemporary==='function')?window.trGetOpenTemporary(pid):[]).find(x=>x.id===flagId);
  if(!f) return;
  const catName=f.categoryName||((typeof window.tcGetName==='function')?window.tcGetName(f.categoryId,pid):'')||'';
  _oiSpawn({
    source:'flag', sourceRef:flagId, kind:'task',
    text:(f.tempLabel||'Repair')+(catName?' · '+catName:''),
    createdDate:f.date||_oiToday(),
    dueDate:_oiAddDays(f.date||_oiToday(),_oiAmberDays())
  }, true);
  window.glHaptic && window.glHaptic.light && window.glHaptic.light();
  if(typeof window.clRenderPunchlist==='function'){ try{ window.clRenderPunchlist(); }catch{} }
}

// Idempotent reconcile pass — mirrors follow their sources. Called from
// oiLoadForProject, clSave, and clRenderPunchlist (the flag-lifecycle choke
// point). Never tombstones on a missing flag: an empty tracker list may just
// mean the tracker hasn't loaded yet.
var _oiSyncing=false;
function oiSyncSources(){
  if(_oiSyncing) return;
  if(_oiLoadedPid!==_oiPid()) return; // wrong/unloaded project — don't mirror across
  _oiSyncing=true;
  try{
    const pid=_oiPid();
    let changed=false;
    const touch=it=>{ it._mts=Date.now(); _oiMarkDirty(it.id); changed=true; };
    // Pinned flag mirrors ← flag lifecycle
    const openFlags=(typeof window.trGetOpenTemporary==='function')?window.trGetOpenTemporary(pid):[];
    const fixedFlags=(typeof window.trGetResolvedTemporary==='function')?window.trGetResolvedTemporary(pid):[];
    _oiItems.forEach(it=>{
      if(it.deleted || it.source!=='flag') return;
      const openF=openFlags.find(f=>f.id===it.sourceRef);
      const fixedF=fixedFlags.find(f=>f.id===it.sourceRef);
      if(fixedF && it.status==='open'){
        it.status='resolved';
        it.resolvedDate=fixedF.resolvedAt?new Date(fixedF.resolvedAt).toLocaleDateString('en-CA'):_oiToday();
        it.resolvedTs=fixedF.resolvedAt||Date.now();
        it.resolutionNote=fixedF.resolveNote||'Fixed on map';
        touch(it);
      } else if(openF && it.status==='resolved'){
        it.status='open'; it.resolvedDate=''; it.resolvedTs=0; it.resolutionNote=''; it.includeInReport=false;
        touch(it);
      }
    });
    // §8 compliance mirrors ← automatic for open entries; resolution both ways
    const entries=(typeof window.clGetEntries==='function')?window.clGetEntries():[];
    const uid=_oiUid();
    entries.forEach(e=>{
      if(!e || !e.id) return;
      if(e.projectId && e.projectId!==pid) return;
      const it=oiFindBySource('cl',e.id);
      if(e.status!=='Resolved'){
        if(!it){
          if(!uid) return;
          const cd=e.date||_oiToday();
          const cts=new Date(cd+'T12:00:00').getTime();
          _oiItems.push({
            id:_oiGenId(), ownerUid:uid, kind:'task',
            text:(e.location||'Compliance entry')+(e.corrective?' — '+e.corrective:''),
            source:'cl', sourceRef:e.id,
            createdDate:cd, createdTs:isFinite(cts)?cts:Date.now(),
            dueDate:_oiAddDays(cd,_oiAmberDays()), remindAt:'',
            status:'open', resolvedDate:'', resolvedTs:0, resolutionNote:'',
            includeInReport:false, visibility:'private', deleted:false, _mts:Date.now()
          });
          _oiMarkDirty(_oiItems[_oiItems.length-1].id);
          changed=true;
        } else if(!it.deleted && it.status==='resolved'){
          it.status='open'; it.resolvedDate=''; it.resolvedTs=0; it.resolutionNote=''; it.includeInReport=false;
          touch(it);
        }
      } else if(it && !it.deleted && it.status==='open'){
        it.status='resolved';
        it.resolvedDate=e.dateResolved||_oiToday();
        it.resolvedTs=Date.now();
        it.resolutionNote=e.corrective||'Resolved in Compliance Log';
        touch(it);
      }
    });
    if(changed){ _oiSaveLocal(); _oiFlush(); oiRender(); _oiNotifSync(); }
  } finally { _oiSyncing=false; }
}

// 🌧 Rain auto-items — spawned from the same forecast data as the ⚠ tiles.
// One per forecast date; a delete or resolve is final (any-state dedupe).
function oiRainSync(week,trig){
  if(!Array.isArray(week)) return;
  if(_oiLoadedPid!==_oiPid()) return;
  trig=(typeof trig==='number')?trig:0.5;
  const today=_oiToday();
  week.forEach(w=>{
    if(!w || !w.d || w.d<today) return;
    if(typeof w.r!=='number' || w.r<trig) return;
    const dt=new Date(w.d+'T12:00:00');
    const label=dt.toLocaleDateString('en-US',{weekday:'short'})+' '+(dt.getMonth()+1)+'/'+dt.getDate();
    _oiSpawn({
      source:'auto', sourceRef:'rain:'+w.d, kind:'task',
      text:'🌧 Post-storm inspection — '+w.r.toFixed(2)+'" expected '+label+' (inspect within 24 hrs of storm end)',
      dueDate:_oiAddDays(w.d,1)
    });
  });
}

// ── Scheduled notifications (native only — @capacitor/local-notifications) ──
function _oiNotifId(id){
  let h=0;
  for(let i=0;i<id.length;i++){ h=((h<<5)-h+id.charCodeAt(i))|0; }
  return Math.abs(h)%2000000000 || 1;
}
const _OI_DIGEST_ID=1999999999;

async function _oiNotifSync(){
  if(!_oiNative()) return;
  try{
    const mod=await import('@capacitor/local-notifications');
    const LN=mod.LocalNotifications;
    const digest=oiDigestGet();
    const now=Date.now();
    const reminders=oiOpenItems().filter(it=>{
      if(!it.remindAt) return false;
      const t=new Date(it.remindAt).getTime();
      return isFinite(t) && t>now;
    });
    const wantAny=digest.on || reminders.length>0;

    // Cancel everything we scheduled last pass (tracked ids) before rescheduling.
    let prev=[];
    try{ prev=JSON.parse(localStorage.getItem('gl_oi_notif_ids')||'[]'); }catch{}
    if(prev.length){ try{ await LN.cancel({notifications:prev.map(id=>({id}))}); }catch{} }
    if(!wantAny){ try{ localStorage.setItem('gl_oi_notif_ids','[]'); }catch{} return; }

    // Permission — only prompt when there is actually something to schedule.
    let perm=await LN.checkPermissions();
    if(perm.display==='prompt') perm=await LN.requestPermissions();
    if(perm.display!=='granted') return;

    const toSchedule=[];
    reminders.forEach(it=>{
      toSchedule.push({
        id:_oiNotifId(it.id),
        title:'📌 Open Item reminder',
        body:it.text.slice(0,180),
        schedule:{at:new Date(it.remindAt), allowWhileIdle:true}
      });
    });
    if(digest.on){
      const n=oiOpenCount(), due=oiDueTodayCount();
      toSchedule.push({
        id:_OI_DIGEST_ID,
        title:'📌 GroundLog — Open Items',
        body:n?(n+' open item'+(n===1?'':'s')+(due?' · '+due+' due today':'')+' — review before you start the day.')
              :'No open items — clean slate today.',
        schedule:{on:{hour:digest.hour, minute:digest.min}, allowWhileIdle:true}
      });
    }
    if(toSchedule.length) await LN.schedule({notifications:toSchedule});
    try{ localStorage.setItem('gl_oi_notif_ids', JSON.stringify(toSchedule.map(x=>x.id))); }catch{}
  }catch(e){ console.warn('openItems notif sync:', e.message); }
}

// ── Window exposure (Vite ESM cross-module seams) ──
window.oiBoot = oiBoot;
window.oiLoadForProject = oiLoadForProject;
window.oiAdd = oiAdd;
window.oiToggleNewKind = oiToggleNewKind;
window.oiExpand = oiExpand;
window.oiFieldChange = oiFieldChange;
window.oiDelete = oiDelete;
window.oiResolve = oiResolve;
window.oiReopen = oiReopen;
window.oiToggleResolved = oiToggleResolved;
window.oiRender = oiRender;
window.oiOpenCount = oiOpenCount;
window.oiDueTodayCount = oiDueTodayCount;
window.oiNdSummaryHtml = oiNdSummaryHtml;
window.oiResolvedForReport = oiResolvedForReport;
window.oiSettingsInit = oiSettingsInit;
window.oiDigestChanged = oiDigestChanged;
window.oiPinFlag = oiPinFlag;
window.oiFlagPinned = oiFlagPinned;
window.oiSyncSources = oiSyncSources;
window.oiRainSync = oiRainSync;
