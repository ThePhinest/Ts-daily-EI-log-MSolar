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
// v2 (7/30): filter pills + manual order + due-sort toggle. Filter/sort are
// view state; ORDER persists on the item. Legacy items carry no title/order —
// accessors derive both so no migration writes are needed.
var _oiFilter = 'all';                    // all | task | note | check
function _oiSortDue(){ try{ return localStorage.getItem('gl_oi_sortdue')==='1'; }catch{ return false; } }
function _oiTitle(it){
  const t=(it.title||'').trim();
  if(t) return t;
  const first=String(it.text||'').split('\n')[0].trim();
  return first.length>64 ? first.slice(0,61)+'…' : (first||'(untitled)');
}
function _oiBody(it){ return String(it.text||''); }   // legacy items: full text doubles as body
function _oiOrder(it){ return (typeof it.order==='number') ? it.order : (it.createdTs||0); }
function _oiNextOrder(){
  let max=0;
  oiOpenItems().forEach(it=>{ const o=_oiOrder(it); if(o>max) max=o; });
  return max+10;
}
// Report / notification label — title plus body when both exist.
function oiItemLabel(it){
  const t=(it.title||'').trim();
  if(!t) return String(it.text||'');
  const b=String(it.text||'').trim();
  return b ? t+' — '+b : t;
}

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
  _oiNotifInit();
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
  const typed=(inp&&inp.value||'').trim();
  if(!typed) return;
  const uid=_oiUid();
  // v2: the typed line is the TITLE (shows in the list); details/steps get
  // added from the expanded card.
  const it={
    id:_oiGenId(), ownerUid:uid||'', kind:_oiNewKind, title:typed, text:'',
    checkItems:_oiNewKind==='check'?[]:undefined,
    order:_oiNextOrder(),
    source:'manual', sourceRef:null,
    createdDate:_oiToday(), createdTs:Date.now(),
    dueDate:'', remindAt:'', remindRepeat:'', remindDays:[],
    status:'open', resolvedDate:'', resolvedTs:0, resolutionNote:'',
    includeInReport:false, visibility:'private', deleted:false, _mts:Date.now()
  };
  if(it.checkItems===undefined) delete it.checkItems;
  _oiItems.push(it);
  if(inp) inp.value='';
  _oiSaveLocal(); _oiMarkDirty(it.id); _oiFlush();
  _oiExpanded=it.id;             // open the new card so details/steps are one tap away
  oiRender();
  window.glHaptic && window.glHaptic.light && window.glHaptic.light();
}

var _OI_KINDS=[['task','☑︎ Task'],['note','📝 Note'],['check','📋 List']];
function oiToggleNewKind(){
  const i=_OI_KINDS.findIndex(k=>k[0]===_oiNewKind);
  _oiNewKind=_OI_KINDS[(i+1)%_OI_KINDS.length][0];
  const b=document.getElementById('oi-new-kind');
  if(b) b.textContent=_OI_KINDS.find(k=>k[0]===_oiNewKind)[1];
}

function oiSetFilter(f){
  _oiFilter=f;
  oiRender();
}
function oiToggleSortDue(){
  try{ localStorage.setItem('gl_oi_sortdue', _oiSortDue()?'0':'1'); }catch{}
  oiRender();
}

function oiExpand(id){
  _oiExpanded = (_oiExpanded===id) ? null : id;
  oiRender();
}

function oiFieldChange(id, field, value){
  const it=_oiItems.find(x=>x.id===id);
  if(!it) return;
  if(field==='text'){ it.text=String(value); }             // body may be cleared
  else if(field==='title'){ const v=String(value).trim(); if(!v) return; it.title=v; }
  else if(field==='kind'){
    it.kind=(value==='note')?'note':(value==='check')?'check':'task';
    if(it.kind==='check'&&!Array.isArray(it.checkItems)) it.checkItems=[];
  }
  else if(field==='dueDate'){ it.dueDate=value||''; }
  else if(field==='remindAt'){ it.remindAt=value||''; }
  else if(field==='remindRepeat'){ it.remindRepeat=value||''; if(it.remindRepeat!=='weekly') it.remindDays=[]; }
  _oiTouch(it);
  // NO re-render here — iOS fires `change` on the first tap inside a date /
  // datetime picker, and re-rendering destroys the input mid-interaction,
  // slamming the picker shut (Tim, 7/22). The input already shows the new
  // value; chips/labels catch up on the next render (row close, resolve, sync).
  // Exceptions that change the detail card's own structure re-render:
  if(field==='kind'||field==='remindRepeat') oiRender();
  if(field==='remindAt'||field==='remindRepeat') _oiNotifSync();
}

// Weekly-repeat weekday chips (JS day numbers 0=Sun..6=Sat; +1 at scheduling).
function oiRemDayToggle(id, day){
  const it=_oiItems.find(x=>x.id===id);
  if(!it) return;
  const days=Array.isArray(it.remindDays)?it.remindDays.slice():[];
  const i=days.indexOf(day);
  if(i>=0) days.splice(i,1); else days.push(day);
  it.remindDays=days.sort();
  _oiTouch(it);
  oiRender();
  _oiNotifSync();
}

// ── Checklist steps (kind 'check') ──
function oiCkAdd(id){
  const it=_oiItems.find(x=>x.id===id);
  if(!it) return;
  if(!Array.isArray(it.checkItems)) it.checkItems=[];
  it.checkItems.push({t:'',done:false});
  _oiTouch(it);
  oiRender();
  // Focus the new step's text box so add-type-add flows.
  requestAnimationFrame(()=>{
    const rows=document.querySelectorAll('.oi-ck-row input[type="text"]');
    if(rows.length) rows[rows.length-1].focus();
  });
}
function oiCkToggle(id, idx){
  const it=_oiItems.find(x=>x.id===id);
  if(!it||!it.checkItems||!it.checkItems[idx]) return;
  const step=it.checkItems[idx];
  step.done=!step.done;
  // Checking a step sinks it to the bottom of the list — PERSISTENTLY (array
  // order is the stored order). Unchecking flips the flag in place: the step
  // stays where it sank, which doubles as a quick way to reorder a checklist.
  if(step.done){ it.checkItems.splice(idx,1); it.checkItems.push(step); }
  _oiTouch(it);
  oiRender();
  window.glHaptic && window.glHaptic.light && window.glHaptic.light();
}
function oiCkText(id, idx, v){
  const it=_oiItems.find(x=>x.id===id);
  if(!it||!it.checkItems||!it.checkItems[idx]) return;
  it.checkItems[idx].t=String(v);
  _oiTouch(it);
  // no render — value already in the input (blur-time change event)
}
function oiCkDel(id, idx){
  const it=_oiItems.find(x=>x.id===id);
  if(!it||!it.checkItems) return;
  it.checkItems.splice(idx,1);
  _oiTouch(it);
  oiRender();
}

// ── Drag reorder (⠿ handle; manual order only — hidden under filters/sort) ──
function oiDragStart(ev, id){
  ev.preventDefault();
  const row=ev.target.closest('.oi-row');
  const list=document.getElementById('oi-list');
  if(!row||!list) return;
  row.classList.add('oi-dragging');
  const move=e=>{
    const y=(e.clientY!=null)?e.clientY:(e.touches&&e.touches[0]&&e.touches[0].clientY);
    if(y==null) return;
    e.preventDefault();
    const others=[...list.querySelectorAll('.oi-row:not(.oi-dragging)')];
    let before=null;
    for(const r of others){ const b=r.getBoundingClientRect(); if(y<b.top+b.height/2){ before=r; break; } }
    if(before) list.insertBefore(row,before); else list.appendChild(row);
  };
  const up=()=>{
    document.removeEventListener('pointermove',move);
    document.removeEventListener('pointerup',up);
    document.removeEventListener('pointercancel',up);
    row.classList.remove('oi-dragging');
    // Persist the DOM order as the manual order (10-step reindex).
    let n=10, changed=false;
    [...list.querySelectorAll('.oi-row[data-id]')].forEach(r=>{
      const it=_oiItems.find(x=>x.id===r.dataset.id);
      if(it){ if(it.order!==n){ it.order=n; it._mts=Date.now(); _oiMarkDirty(it.id); changed=true; } n+=10; }
    });
    if(changed){ _oiSaveLocal(); _oiFlush(); }
    oiRender();
    window.glHaptic && window.glHaptic.light && window.glHaptic.light();
  };
  document.addEventListener('pointermove',move,{passive:false});
  document.addEventListener('pointerup',up);
  document.addEventListener('pointercancel',up);
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
    +'<div style="font-family:var(--body);font-size:13.5px;color:var(--text);line-height:1.45;margin-bottom:12px;background:rgba(0,107,117,0.08);border:1px solid var(--border2);border-radius:6px;padding:9px 11px">'+_oiEsc(oiItemLabel(it))+'</div>'
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
var _OI_DAYS=['S','M','T','W','T','F','S'];
function oiRender(){
  const list=document.getElementById('oi-list');
  if(!list) return;
  const sortDue=_oiSortDue();
  const all=oiOpenItems();
  let open=all.slice();
  if(_oiFilter!=='all') open=open.filter(it=>(it.kind||'task')===_oiFilter);
  open.sort(sortDue
    ? (a,b)=>((a.dueDate||'9999-99-99')<(b.dueDate||'9999-99-99')?-1:(a.dueDate||'9999-99-99')>(b.dueDate||'9999-99-99')?1:_oiOrder(a)-_oiOrder(b))
    : (a,b)=>_oiOrder(a)-_oiOrder(b));
  const today=_oiToday();
  const canDrag=(_oiFilter==='all')&&!sortDue;

  const badge=document.getElementById('oi-badge');
  if(badge){
    const due=oiDueTodayCount();
    badge.textContent=all.length+' open'+(due?' · '+due+' due':'');
    badge.classList.toggle('oi-badge-due', due>0);
  }

  // Filter pills + sort toggle
  const pills=document.getElementById('oi-pills');
  if(pills){
    const counts={task:0,note:0,check:0};
    all.forEach(it=>{ counts[(it.kind||'task')]=(counts[(it.kind||'task')]||0)+1; });
    const pill=(key,label,n)=>'<button class="oi-pill'+(_oiFilter===key?' on':'')+'" onclick="oiSetFilter(\''+key+'\')">'+label+(n?' '+n:'')+'</button>';
    pills.innerHTML=pill('all','All',all.length)
      +pill('task','☑︎ Tasks',counts.task)
      +pill('note','📝 Notes',counts.note)
      +pill('check','📋 Lists',counts.check)
      +'<button class="oi-pill oi-pill-sort'+(sortDue?' on':'')+'" onclick="oiToggleSortDue()" title="Sort by due date (off = your manual order)">⇅ Due</button>';
  }

  if(!open.length){
    list.innerHTML='<div class="oi-empty">'+(all.length?'Nothing in this filter.':'Nothing carried over — add a task, note, or checklist below. It stays here, day after day, until you check it off.')+'</div>';
  } else {
    list.innerHTML=open.map(it=>{
      const kind=it.kind||'task';
      const age=_oiAgeDays(it);
      const ageChip=age>0?'<span class="oi-chip" title="Opened '+_oiFmtDate(it.createdDate)+'">'+age+'d</span>':'';
      const dueOver=it.dueDate && it.dueDate<=today;
      const dueChip=it.dueDate?'<span class="oi-chip'+(dueOver?' over':'')+'">due '+_oiFmtDate(it.dueDate)+(dueOver?' ⚠':'')+'</span>':'';
      const repChip=(it.remindAt&&it.remindRepeat)?'<span class="oi-chip" title="Repeating reminder">🔁</span>':'';
      const remChip=it.remindAt?'<span class="oi-chip" title="Reminder set">🔔</span>':'';
      const srcChip=it.source==='flag'
        ?'<span class="oi-chip" style="cursor:pointer" onclick="event.stopPropagation();clPunchlistGoto(\''+_oiEsc(it.sourceRef)+'\')" title="Repair flag — tap to view on map">🚩</span>'
        :it.source==='cl'?'<span class="oi-chip" title="Compliance Log entry — resolves both places">§8</span>':'';
      const ck=Array.isArray(it.checkItems)?it.checkItems:[];
      const ckChip=(kind==='check'&&ck.length)?'<span class="oi-chip'+(ck.every(c=>c.done)?' over':'')+'">'+ck.filter(c=>c.done).length+'/'+ck.length+'</span>':'';
      const kindIcon=kind==='note'?'📝':kind==='check'?'📋':'';
      const exp=_oiExpanded===it.id;
      const handle=canDrag?'<span class="oi-handle" onpointerdown="oiDragStart(event,\''+it.id+'\')" title="Drag to reorder">⠿</span>':'';
      const bodyPeek=(!exp&&_oiBody(it)&&(it.title||'').trim())?'<div class="oi-peek">'+_oiEsc(_oiBody(it).split('\n')[0].slice(0,90))+'</div>':'';
      let detail='';
      if(exp){
        // Checklist editor (check kind only)
        let ckHtml='';
        if(kind==='check'){
          // Steps render in STORED order — the sink lives in oiCkToggle, which
          // moves a step to the end of the array when checked and leaves it in
          // place when unchecked (Tim 8/16: staying put after uncheck doubles as
          // a cheap reorder trick).
          const ckOrd=ck.map((c,i)=>({c,i}));
          ckHtml='<div class="field"><label>Steps</label>'
            +ckOrd.map(({c,i})=>'<div class="oi-ck-row">'
              +'<input type="checkbox"'+(c.done?' checked':'')+' onchange="oiCkToggle(\''+it.id+'\','+i+')">'
              +'<textarea rows="1" class="auto-expand auto-line" placeholder="Step…" onchange="oiCkText(\''+it.id+'\','+i+',this.value)"'+(c.done?' style="text-decoration:line-through;color:var(--muted)"':'')+'>'+_oiEsc(c.t)+'</textarea>'
              +'<button class="oi-ck-del" onclick="oiCkDel(\''+it.id+'\','+i+')">✕</button>'
              +'</div>').join('')
            +'<button class="btn btn-outline" style="font-size:10.5px;padding:5px 12px;margin-top:6px" onclick="oiCkAdd(\''+it.id+'\')">＋ Add step</button></div>';
        }
        // Repeat controls — anchor time comes from the reminder datetime.
        const rep=it.remindRepeat||'';
        const dayChips=(rep==='weekly')
          ?'<div class="oi-daychips">'+_OI_DAYS.map((d,i)=>'<button class="oi-day'+((it.remindDays||[]).includes(i)?' on':'')+'" onclick="oiRemDayToggle(\''+it.id+'\','+i+')">'+d+'</button>').join('')+'</div>'
          :'';
        detail='<div class="oi-detail">'
          +'<div class="field"><label>Title</label><textarea rows="1" class="auto-expand auto-line" placeholder="'+_oiEsc((it.title||'').trim()?'':_oiTitle(it))+'" onchange="oiFieldChange(\''+it.id+'\',\'title\',this.value)">'+_oiEsc(it.title||'')+'</textarea></div>'
          +'<div class="field"><label>Details</label><textarea class="short auto-expand" placeholder="Notes, details, anything…" onchange="oiFieldChange(\''+it.id+'\',\'text\',this.value)">'+_oiEsc(_oiBody(it))+'</textarea></div>'
          +ckHtml
          +'<div class="oi-detail-row">'
          +'<div class="field" style="flex:1"><label>Type</label><select onchange="oiFieldChange(\''+it.id+'\',\'kind\',this.value)"><option value="task"'+(kind==='task'?' selected':'')+'>☑︎ Task</option><option value="note"'+(kind==='note'?' selected':'')+'>📝 Note</option><option value="check"'+(kind==='check'?' selected':'')+'>📋 Checklist</option></select></div>'
          +'<div class="field" style="flex:1"><label>Due date</label><input type="date" value="'+_oiEsc(it.dueDate)+'" onchange="oiFieldChange(\''+it.id+'\',\'dueDate\',this.value)"></div>'
          +'</div>'
          +'<div class="oi-detail-row">'
          +'<div class="field" style="flex:1.4"><label>Reminder'+(_oiNative()?'':' <span style="text-transform:none;letter-spacing:0">(fires on the iOS app)</span>')+'</label><input type="datetime-local" value="'+_oiEsc(it.remindAt)+'" onchange="oiFieldChange(\''+it.id+'\',\'remindAt\',this.value)"></div>'
          +'<div class="field" style="flex:1"><label>Repeat</label><select onchange="oiFieldChange(\''+it.id+'\',\'remindRepeat\',this.value)"'+(it.remindAt?'':' disabled title="Set a reminder time first"')+'><option value=""'+(rep===''?' selected':'')+'>Once</option><option value="daily"'+(rep==='daily'?' selected':'')+'>Daily</option><option value="weekly"'+(rep==='weekly'?' selected':'')+'>Weekly</option><option value="monthly"'+(rep==='monthly'?' selected':'')+'>Monthly</option></select></div>'
          +'</div>'
          +dayChips
          +((rep==='monthly'&&it.remindAt)?'<div class="oi-rep-note">Fires on day '+new Date(it.remindAt).getDate()+' of each month at '+new Date(it.remindAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'</div>':'')
          +'<div class="oi-detail-btns">'
          +'<button class="btn btn-outline" style="font-size:10.5px;padding:6px 12px" onclick="oiDelete(\''+it.id+'\')">🗑 Delete</button>'
          +'<button class="btn btn-outline" style="font-size:10.5px;padding:6px 12px;margin-left:auto" onclick="oiExpand(\''+it.id+'\')">Close</button>'
          +'</div></div>';
      }
      return '<div class="oi-row'+(exp?' expanded':'')+'" data-id="'+it.id+'">'
        +'<div class="oi-row-main">'
        +handle
        +'<button class="oi-check" onclick="oiResolve(\''+it.id+'\')" title="'+(kind==='note'?'Archive':'Resolve')+'"></button>'
        +'<div class="oi-text" onclick="oiExpand(\''+it.id+'\')">'+(kindIcon?'<span class="oi-kind">'+kindIcon+'</span> ':'')+_oiEsc(_oiTitle(it))+bodyPeek+'</div>'
        +'<div class="oi-chips">'+srcChip+ckChip+repChip+remChip+dueChip+ageChip+'</div>'
        +'</div>'+detail+'</div>';
    }).join('');
  }

  // Pre-filled Details textareas must size to their content on render —
  // programmatic value never fires 'input', so run the shared autoResize pass
  // (same standing rule as the daily-log / settings / swppp renders).
  requestAnimationFrame(()=>{ if(typeof autoResize==='function') list.querySelectorAll('textarea.auto-expand').forEach(autoResize); });

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
        +'<span class="oi-res-text">'+_oiEsc(_oiTitle(it))+'</span>'
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

// ── Notification sound pref — ON by default (Tim 7/30). ──
// ON: digest plays the goblin "grOUndLog" (Tim's own voice through the chain),
// reminders/snoozes play the stake-taps. OFF: a bundled SILENT wav — omitting
// the field would fall back to the iOS DEFAULT chime, not silence.
function oiSoundGet(){
  try{
    const v=JSON.parse(localStorage.getItem('gl_oi_sound')||'null');
    if(v && typeof v.on==='boolean') return v;
  }catch{}
  return {on:true};
}
function _oiSoundSave(v){
  try{ localStorage.setItem('gl_oi_sound', JSON.stringify(v)); }catch{}
  try{
    if(typeof _udb==='function' && window._fbReady && _udb())
      _udb().collection('settings').doc('_user').set({oiSound:v,_ts:Date.now()},{merge:true}).catch(()=>{});
  }catch{}
  _oiNotifSync();
}
function oiSoundChanged(){
  const tog=document.getElementById('cfg-oi-sound-on');
  if(!tog) return;
  _oiSoundSave({on:!!tog.checked});
}
function _oiSndDigest(){ return oiSoundGet().on ? 'gl_digest.wav' : 'gl_silent.wav'; }
function _oiSndTaps(){ return oiSoundGet().on ? 'gl_taps.wav' : 'gl_silent.wav'; }
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
      const s=doc.exists && doc.data().oiSound;
      if(s && typeof s.on==='boolean'){
        try{ localStorage.setItem('gl_oi_sound', JSON.stringify(s)); }catch{}
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
  if(tog&&time){
    const v=oiDigestGet();
    tog.checked=v.on;
    time.value=String(v.hour).padStart(2,'0')+':'+String(v.min).padStart(2,'0');
  }
  const snd=document.getElementById('cfg-oi-sound-on');
  if(snd) snd.checked=oiSoundGet().on;
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

function oiUnpinFlag(flagId){
  const it=oiFindBySource('flag',flagId);
  if(!it || it.deleted) return;
  it.deleted=true;
  if(_oiExpanded===it.id) _oiExpanded=null;
  _oiTouch(it);
  oiRender();
  _oiNotifSync();
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

// Snooze / Cancel actions on every reminder notification (Tim 7/30) — act
// straight from the lock screen, no app open needed. Registered once per boot.
var _oiActionsReady=false;
async function _oiNotifInit(){
  if(!_oiNative()||_oiActionsReady) return;
  _oiActionsReady=true;
  try{
    const mod=await import('@capacitor/local-notifications');
    const LN=mod.LocalNotifications;
    try{
      await LN.registerActionTypes({types:[{
        id:'GL_OI_REMIND',
        actions:[
          {id:'oi_snooze', title:'⏰ Snooze 10 min'},
          {id:'oi_cancel', title:'✕ Cancel reminder', destructive:true}
        ]
      }]});
    }catch(e){}
    LN.addListener('localNotificationActionPerformed', async (ev)=>{
      try{
        const oiId=ev&&ev.notification&&ev.notification.extra&&ev.notification.extra.oiId;
        if(!oiId) return;
        const it=_oiItems.find(x=>x.id===oiId);
        if(ev.actionId==='oi_snooze'){
          // One-off re-fire in 10 minutes, same content, same actions.
          await LN.schedule({notifications:[{
            id:_oiNotifId(oiId+'::snooze::'+Date.now()),
            title:ev.notification.title||'📌 Open Item reminder',
            body:ev.notification.body||'',
            actionTypeId:'GL_OI_REMIND',
            extra:{oiId},
            sound:_oiSndTaps(),
            schedule:{at:new Date(Date.now()+10*60000), allowWhileIdle:true}
          }]});
        } else if(ev.actionId==='oi_cancel'){
          if(it){ it.remindAt=''; it.remindRepeat=''; it.remindDays=[]; _oiTouch(it); oiRender(); }
          _oiNotifSync();
        }
      }catch(e){ console.warn('openItems notif action:', e.message); }
    });
  }catch(e){ _oiActionsReady=false; console.warn('openItems notif init:', e.message); }
}

async function _oiNotifSync(){
  if(!_oiNative()) return;
  try{
    const mod=await import('@capacitor/local-notifications');
    const LN=mod.LocalNotifications;
    const digest=oiDigestGet();
    const now=Date.now();
    // Once-reminders need a future fire time; repeaters always schedule (the
    // datetime supplies the anchor time-of-day / day-of-month).
    const reminders=oiOpenItems().filter(it=>{
      if(!it.remindAt) return false;
      const t=new Date(it.remindAt).getTime();
      if(!isFinite(t)) return false;
      return it.remindRepeat ? true : t>now;
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
      const base={
        title:'📌 Open Item reminder',
        body:oiItemLabel(it).slice(0,180),
        actionTypeId:'GL_OI_REMIND',
        extra:{oiId:it.id},
        sound:_oiSndTaps()      // ⛏ stake-taps (or bundled silence when muted)
      };
      const at=new Date(it.remindAt);
      const rep=it.remindRepeat||'';
      if(!rep){
        toSchedule.push({...base, id:_oiNotifId(it.id), schedule:{at, allowWhileIdle:true}});
      } else if(rep==='daily'){
        toSchedule.push({...base, id:_oiNotifId(it.id), schedule:{on:{hour:at.getHours(), minute:at.getMinutes()}, allowWhileIdle:true}});
      } else if(rep==='weekly'){
        // One scheduled notification per picked weekday (JS 0-6 → platform 1-7).
        const days=(Array.isArray(it.remindDays)&&it.remindDays.length)?it.remindDays:[at.getDay()];
        days.forEach(d=>{
          toSchedule.push({...base, id:_oiNotifId(it.id+'::w'+d),
            schedule:{on:{weekday:d+1, hour:at.getHours(), minute:at.getMinutes()}, allowWhileIdle:true}});
        });
      } else if(rep==='monthly'){
        toSchedule.push({...base, id:_oiNotifId(it.id+'::m'),
          schedule:{on:{day:at.getDate(), hour:at.getHours(), minute:at.getMinutes()}, allowWhileIdle:true}});
      }
    });
    if(digest.on){
      const n=oiOpenCount(), due=oiDueTodayCount();
      toSchedule.push({
        id:_OI_DIGEST_ID,
        title:'📌 GroundLog — Open Items',
        body:n?(n+' open item'+(n===1?'':'s')+(due?' · '+due+' due today':'')+' — review before you start the day.')
              :'No open items — clean slate today.',
        sound:_oiSndDigest(),   // 👺 "grOUndLog" (Tim's voice, goblin chain)
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
window.oiSoundChanged = oiSoundChanged;
window.oiPinFlag = oiPinFlag;
window.oiUnpinFlag = oiUnpinFlag;
window.oiFlagPinned = oiFlagPinned;
window.oiSyncSources = oiSyncSources;
window.oiRainSync = oiRainSync;
window.oiSetFilter = oiSetFilter;
window.oiToggleSortDue = oiToggleSortDue;
window.oiRemDayToggle = oiRemDayToggle;
window.oiCkAdd = oiCkAdd;
window.oiCkToggle = oiCkToggle;
window.oiCkText = oiCkText;
window.oiCkDel = oiCkDel;
window.oiDragStart = oiDragStart;
window.oiItemLabel = oiItemLabel;
