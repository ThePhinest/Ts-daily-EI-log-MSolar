// ═══════════════════════════════════════════
// 🌱 APPLICATIONS — one drawing, N material applications (seed / lime / fert / …)
// ═══════════════════════════════════════════
//
// One drawing = one treated area; `applications[]` on the entry carries what
// went on it (lime Monday, seed Tuesday — per-row date defaults to the entry
// date). Zero migration both directions:
//   read  — entries without applications[] derive one row from the legacy
//           seedMix/fields.* data (typed from the state label for Limed/
//           Fertilized state recordings, else seed);
//   write — the first seed application mirrors back into seedMix/fields.* so
//           every existing reader (exports, popups, KMZ, photo ZIP) is untouched.
//
// Seed-bag ledger (Tim's design, 8/18): the SEED TAG PHOTO is the bag — no
// per-bag records, no entry-time picking. Setup = one per-project list of
// product → bag weight (config/seedBags, lead-write). A tag photo's capacity =
// tags-in-photo × bag weight (count defaults from the entry's Tags 🏷️ field
// when it's the entry's only tag photo); remaining = capacity − Σ seed lbs of
// every entry the photo is attached to, drained in attachment order across
// entries chronologically. All DERIVED, nothing stored but an optional per-photo
// count override. Exhausted tags go amber + confirm — nothing blocks an entry.

// ── Types ──
const GL_APP_TYPES=[
  {id:'seed',       label:'Seed',  icon:'🌱'},
  {id:'lime',       label:'Lime',  icon:'⚪'},
  {id:'fertilizer', label:'Fert',  icon:'🧪'},
  {id:'mulch',      label:'Mulch', icon:'🌾'},
  {id:'other',      label:'Other', icon:'📦'},
];
const GL_APP_TYPE_LABELS={seed:'Seed',lime:'Lime',fertilizer:'Fertilizer',mulch:'Mulch',other:'Other'};
const _APP_RATE_UNITS=['lbs/ac','tons/ac','kg/ac','gal/ac'];
const _APP_ACT_UNITS=['lbs','tons','kg','bags','gal'];

// State label → amendment type. Deliberately narrow (lime/fertilizer only) so a
// state named e.g. "Stabilized (mulch+seed)" never silently reclassifies.
function glAppTypeFromState(label){
  const s=String(label||'');
  if(/lime/i.test(s)) return 'lime';
  if(/fertili/i.test(s)) return 'fertilizer';
  return null;
}

function _appStateLabel(entry, pid){
  if(!entry||!entry.state) return '';
  const cid=entry.categoryId||entry.category;
  const st=(cid&&typeof tcGetState==='function')?tcGetState(cid,entry.state,pid):null;
  return st?st.label:'';
}

// Canonical read: the entry's applications, derived from legacy fields when the
// array isn't stored. Rows come back with date defaulted to the entry date.
function glEntryApplications(entry, pid){
  pid=pid||((typeof _activeProjectId==='function')?_activeProjectId():'default');
  if(!entry) return [];
  if(Array.isArray(entry.applications)&&entry.applications.length){
    return entry.applications.map(a=>({...a, date:a.date||entry.date||null}));
  }
  const f=entry.fields||{};
  const hasData=!!(entry.seedMix||f.appliedRate!=null||f.seedTagCount!=null||f.actualAmount!=null);
  const stType=glAppTypeFromState(_appStateLabel(entry,pid));
  if(!hasData&&!stType) return [];
  return [{
    type:hasData?(stType||'seed'):stType,
    product:entry.seedMix||null,
    rate:f.appliedRate!=null?f.appliedRate:null,
    rateUnit:f.requiredUnit?f.requiredUnit+'/ac':'lbs/ac',
    actual:f.actualAmount!=null?f.actualAmount:null,
    actualUnit:f.actualUnit||'lbs',
    seedTags:f.seedTagCount!=null?f.seedTagCount:null,
    date:entry.date||null,
    notes:null,
    _derived:true,
  }];
}

// Deterministic one-line summary — the old "↓ Append to notes" line, per
// application, generated as-you-go so nobody has to remember a button.
function glAppSummaryLine(app, acres){
  if(!app) return '';
  // No meaningful data yet → no line (a bare "Seed:" must never count as content).
  if(!app.product&&(app.rate==null||app.rate==='')&&(app.actual==null||app.actual==='')) return '';
  const parts=[];
  const t=GL_APP_TYPE_LABELS[app.type]||'Material';
  let head=t+':';
  if(app.product) head+=' '+app.product;
  parts.push(head);
  const ru=app.rateUnit||'lbs/ac';
  if(app.rate!=null&&app.rate!==''){
    let seg='@ '+app.rate+' '+ru;
    if(acres>0){
      const req=app.rate*acres;
      seg+=' × '+(+acres.toFixed(2))+' ac = '+(+req.toFixed(req>=100?0:1)).toLocaleString('en-US')+' '+ru.split('/')[0];
    }
    parts.push(seg);
  }
  const extras=[];
  if(app.actual!=null&&app.actual!=='') extras.push('used '+app.actual+' '+(app.actualUnit||'lbs'));
  if(app.type==='seed'&&app.seedTags) extras.push(app.seedTags+' seed tag'+(app.seedTags>1?'s':''));
  if(extras.length) parts.push('('+extras.join(', ')+')');
  return parts.join(' ').trim();
}

// ═══ Seed-bag weights (product → lbs per bag) + tag-photo ledger ═══
var _sbCfg={};      // pid → {products:[{product,weightLbs}]} | null
var _sbLoading={};
function _sbPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _sbNorm(s){ return String(s||'').trim().toLowerCase(); }
function sbGetProducts(pid){ const v=_sbCfg[pid||_sbPid()]; return (v&&Array.isArray(v.products))?v.products:[]; }
// Same normalization as the export summaries — name variants match as one product.
function sbWeightFor(product, pid){
  const n=_sbNorm(product);
  if(!n) return null;
  const hit=sbGetProducts(pid).find(p=>_sbNorm(p.product)===n);
  return (hit&&hit.weightLbs>0)?hit.weightLbs:null;
}
async function sbEnsureCfg(pid){
  pid=pid||_sbPid();
  if(_sbCfg[pid]!==undefined) return _sbCfg[pid];
  if(_sbLoading[pid]) return _sbLoading[pid];
  _sbLoading[pid]=(async()=>{
    try{ _sbCfg[pid]=(await idbGet('sb_cfg::'+pid))||null; }catch(e){ _sbCfg[pid]=null; }
    if(typeof db!=='undefined'&&db&&typeof _fbReady!=='undefined'&&_fbReady){
      try{
        const snap=await db.collection('projects').doc(pid).collection('config').doc('seedBags').get();
        if(snap.exists){ _sbCfg[pid]=snap.data(); idbSet('sb_cfg::'+pid,_sbCfg[pid]); }
      }catch(e){ console.warn('seed bags load failed:',e.message); }
    }
    delete _sbLoading[pid];
    return _sbCfg[pid];
  })();
  return _sbLoading[pid];
}
async function sbSaveProducts(products, pid){
  pid=pid||_sbPid();
  const cfg={products:products,updatedAtMs:Date.now()};
  _sbCfg[pid]=cfg;
  idbSet('sb_cfg::'+pid,cfg);
  try{
    if(typeof db!=='undefined'&&db&&_fbReady)
      await db.collection('projects').doc(pid).collection('config').doc('seedBags').set(cfg);
  }catch(e){
    console.warn('seed bag weights cloud save failed (kept locally):',e.message);
    if(typeof showCloudBanner==='function'&&/permission/i.test(e.message||''))
      showCloudBanner('Only a project lead can edit seed bag weights — kept on this device only.');
  }
}
// ── Tag-photo ledger — the whole bag tracker, fully derived ──
// Every live entry, chronologically: its seed lbs drain into its attached tag
// photos in attachment order. A photo's capacity = tags-in-photo × bag weight;
// count comes from the photo's override (tagCount) or infers from the entry's
// Tags 🏷️ field when the photo is the entry's ONLY tag photo (Tim's 6-tags-in-
// one-shot workflow), else 1. Overflow lands on the last tag so over-usage
// reads truthfully as negative remaining.
function sbPhotoLedger(pid){
  pid=pid||_sbPid();
  const entries=((typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid):[])
    .filter(e=>e&&!e.deletedAt&&!e.temporary&&e.entryType!=='planned')
    .sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||((a.createdAt||0)-(b.createdAt||0)));
  const led=new Map();
  for(const e of entries){
    const types=e.photoTypes||{};
    const tagIds=(e.photoIds||[]).filter(id=>types[id]==='material_tag');
    if(!tagIds.length) continue;
    const seedApp=((typeof glEntryApplications==='function')?glEntryApplications(e,pid):[]).find(a=>a&&a.type==='seed')||null;
    const product=(seedApp&&seedApp.product)||e.seedMix||null;
    tagIds.forEach(id=>{
      if(led.has(id)) return;
      const ph=(window._phPhotos||[]).find(p=>p.id===id);
      const tags=(seedApp&&seedApp.seedTags!=null)?seedApp.seedTags:((e.fields&&e.fields.seedTagCount!=null)?e.fields.seedTagCount:null);
      const count=(ph&&ph.tagCount>0)?ph.tagCount:((tagIds.length===1&&tags>0)?tags:1);
      const w=sbWeightFor(product,pid);
      led.set(id,{product,count,weight:w,capacity:(w!=null)?count*w:null,used:0,countInferred:!(ph&&ph.tagCount>0)});
    });
    let lbs=(seedApp&&seedApp.actual!=null&&(seedApp.actualUnit||'lbs')==='lbs')?(+seedApp.actual||0):0;
    if(!lbs) continue;
    for(let i=0;i<tagIds.length&&lbs>0;i++){
      const L=led.get(tagIds[i]);
      const last=(i===tagIds.length-1);
      const take=last?lbs:(L.capacity!=null?Math.min(lbs,Math.max(0,L.capacity-L.used)):lbs);
      L.used+=take; lbs-=take;
    }
  }
  return led;
}
function sbPhotoInfo(photoId, pid){
  const L=sbPhotoLedger(pid).get(photoId);
  if(!L) return null;
  return {...L, remaining:(L.capacity!=null)?(L.capacity-L.used):null};
}
// Badge text for a tag photo — remaining when computable, setup hints otherwise.
function sbPhotoBadge(photoId, pid){
  const info=sbPhotoInfo(photoId,pid);
  if(!info) return null;
  if(info.remaining==null) return {txt:'⚖ set bag wt',amber:false,info};
  const r=+info.remaining.toFixed(1);
  return {txt:(r<=0?'⚠ ':'🌱 ')+r.toLocaleString('en-US')+' lbs left',amber:r<=0,info};
}
// Per-photo tag-count override — synced through the photos dirty-ID pipeline
// (phSaveCloudOne routes through the dirty flush so a failed write stays pending).
function sbSetPhotoTagCount(photoId, count){
  const ph=(window._phPhotos||[]).find(p=>p.id===photoId);
  if(!ph) return;
  const n=parseInt(count);
  if(n>0) ph.tagCount=n; else delete ph.tagCount;
  if(typeof phSaveLocal==='function') phSaveLocal();
  if(typeof phSaveCloudOne==='function') phSaveCloudOne(ph);
}

// ═══ Entry-form application rows ═══
// _appRows = live edit state; the DOM re-renders from it. Per-field `auto`
// stamps carry the never-clobber rule (state/spec prefills fill only while the
// field is empty or still holds the last auto value).
var _appRows=[];
var _appEditingEntryId=null;   // excluded from bag draw-down while editing

function _appNewRow(type){
  return {type:type||'seed',product:'',rate:'',rateUnit:'lbs/ac',actual:'',actualUnit:'lbs',
    seedTags:'',date:'',notes:'',_autoProduct:'',_autoRate:'',_autoNotes:''};
}
function appRowsReset(opts){
  _appRows=[_appNewRow('seed')];
  _appEditingEntryId=null;
  const n=document.getElementById('map-tr-notes');
  if(n) n.dataset.auto='';
  if(opts&&opts.rate!=null&&opts.rate!==''){ _appRows[0].rate=String(opts.rate); _appRows[0]._autoRate=String(opts.rate); }
  _appRows.forEach(r=>_appRowAutoNotes(r));
  appRowsRender();
  appSyncEntryNotes();
  // Bag-weight config loads async — the tag-photo badges (strip) depend on it.
  sbEnsureCfg().then(()=>{ if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip(); });
}
function appRowsSet(apps, entryId){
  _appEditingEntryId=entryId||null;
  _appRows=(apps||[]).map(a=>({
    type:a.type||'seed',
    product:a.product||'',
    rate:a.rate!=null?String(a.rate):'',
    rateUnit:a.rateUnit||'lbs/ac',
    actual:a.actual!=null?String(a.actual):'',
    actualUnit:a.actualUnit||'lbs',
    seedTags:a.seedTags!=null?String(a.seedTags):'',
    date:a.date&&a.date!==(document.getElementById('map-tr-date')?.value||'')?a.date:'',
    notes:a.notes||'',
    // Stored values are user data — auto stamps stay empty so prefills never clobber.
    _autoProduct:'',_autoRate:'',_autoNotes:a.notes&&a.notesAuto===a.notes?a.notes:'',
  }));
  if(!_appRows.length) _appRows=[_appNewRow('seed')];
  const n=document.getElementById('map-tr-notes');
  if(n) n.dataset.auto='';
  appRowsRender();
  sbEnsureCfg().then(()=>{ if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip(); });
}
// Rows → storable applications array (empty rows dropped).
function appRowsGet(){
  const out=[];
  _appRows.forEach(r=>{
    const has=r.product||r.rate!==''||r.actual!==''||r.seedTags!==''||r.notes;
    if(!has) return;
    const app={
      type:r.type,
      product:r.product.trim()||null,
      rate:r.rate!==''?parseFloat(r.rate):null,
      rateUnit:r.rateUnit||'lbs/ac',
      actual:r.actual!==''?parseFloat(r.actual):null,
      actualUnit:r.actualUnit||'lbs',
      notes:r.notes.trim()||null,
      notesAuto:(r.notes.trim()&&r.notes===r._autoNotes)?r.notes:null,
      date:r.date||null,
    };
    if(r.type==='seed'&&r.seedTags!=='') app.seedTags=parseInt(r.seedTags)||0;
    out.push(app);
  });
  return out;
}
function appRowsHasData(){
  return _appRows.some(r=>r.product||r.rate!==''||r.actual!==''||r.seedTags!==''||r.notes);
}
// The application legacy readers mirror from: first seed row, else the FIRST row.
// The fallback matters — a Limed-state entry records lime through the same legacy
// seedMix/fields columns today (that's how lime reaches the Coverage Summary as a
// State × Mix × Rate line); a seed-only mirror would wipe it on re-save.
function appMirrorRow(apps){ return (apps||[]).find(a=>a.type==='seed')||(apps&&apps[0])||null; }

// Current drawn area in ACRES (rate math is per-acre).
function _appAcres(){
  const el=document.getElementById('map-tr-acres');
  const v=parseFloat(el?.value)||0;
  if(!v) return 0;
  const unit=document.getElementById('map-tr-unit')?.value||el?.dataset.unit||'ac';
  if(unit==='ac') return v;
  if(typeof TC_AREA_UNITS!=='undefined'&&TC_AREA_UNITS.includes(unit)&&typeof tcConvertMeasurement==='function')
    return parseFloat(tcConvertMeasurement(v,unit,'ac'))||0;
  return 0; // linear units — no per-acre math
}

// ── Render ──
const _APP_IN='box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-family:var(--mono);font-size:12px';
function _appEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

function appRowsRender(){
  const host=document.getElementById('map-tr-apps');
  if(!host) return;
  host.innerHTML=_appRows.map((r,i)=>{
    const chips=GL_APP_TYPES.map(t=>{
      const on=r.type===t.id;
      return `<button type="button" onclick="appRowType(${i},'${t.id}')" style="flex:1;min-width:0;background:${on?'rgba(201,168,76,0.22)':'none'};border:1px solid ${on?'var(--amber)':'var(--border)'};border-radius:5px;color:${on?'var(--amber)':'var(--muted2)'};font-family:var(--mono);font-size:9px;padding:5px 2px;cursor:pointer;white-space:nowrap">${t.icon} ${t.label}</button>`;
    }).join('');
    const acres=_appAcres();
    const req=(r.rate!==''&&acres>0)?(parseFloat(r.rate)*acres):null;
    const reqTxt=req!=null?((+req.toFixed(req>=100?0:1)).toLocaleString('en-US')+' '+(r.rateUnit||'lbs/ac').split('/')[0]):'—';
    const isSeed=r.type==='seed';
    const specWarn=r._specWarn?`<div style="color:var(--amber);font-family:var(--mono);font-size:10px;margin-top:6px">⚠ ${_appEsc(r._specWarn)}</div>`:'';
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:9px 10px;margin-bottom:8px;background:var(--bg)">
      <div style="display:flex;gap:5px;align-items:center;margin-bottom:8px">
        <div style="display:flex;gap:5px;flex:1;min-width:0">${chips}</div>
        ${_appRows.length>1?`<button type="button" onclick="appRowRemove(${i})" title="Remove application" style="background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:2px 4px;flex-shrink:0">✕</button>`:''}
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:8px">
        <input type="text" value="${_appEsc(r.product)}" oninput="appRowField(${i},'product',this.value)" placeholder="${isSeed?'Seed mix / product':'Product (e.g. ag lime, 10-10-10)'}" style="width:100%;${_APP_IN}">
      </div>
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end">
        <div>
          <label style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Rate</label>
          <input type="number" step="0.1" min="0" value="${_appEsc(r.rate)}" oninput="appRowField(${i},'rate',this.value)" placeholder="0" style="width:100%;${_APP_IN}">
        </div>
        <select onchange="appRowField(${i},'rateUnit',this.value)" style="${_APP_IN}">${_APP_RATE_UNITS.map(u=>`<option${r.rateUnit===u?' selected':''}>${u}</option>`).join('')}</select>
        <div style="text-align:right;min-width:74px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Required</div>
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--amber);padding-bottom:5px">${reqTxt}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto${isSeed?' auto':''};gap:8px;align-items:end;margin-top:8px">
        <div>
          <label style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Actual applied</label>
          <input type="number" step="0.1" min="0" value="${_appEsc(r.actual)}" oninput="appRowField(${i},'actual',this.value)" placeholder="Amount used" style="width:100%;${_APP_IN}">
        </div>
        <select onchange="appRowField(${i},'actualUnit',this.value)" style="${_APP_IN}">${_APP_ACT_UNITS.map(u=>`<option${r.actualUnit===u?' selected':''}>${u}</option>`).join('')}</select>
        ${isSeed?`<div><label style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Tags 🏷️</label>
          <input type="number" step="1" min="0" value="${_appEsc(r.seedTags)}" oninput="appRowField(${i},'seedTags',this.value)" placeholder="0" style="width:64px;${_APP_IN}"></div>`:''}
      </div>
      <div style="margin-top:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
          <label style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Application date <span style="text-transform:none;opacity:.6">(blank = entry date)</span></label>
        </div>
        <input type="date" value="${_appEsc(r.date)}" onchange="appRowField(${i},'date',this.value)" style="width:100%;${_APP_IN}">
      </div>
      <div style="margin-top:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
          <label style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Application notes <span style="text-transform:none;opacity:.6">(auto-fills)</span></label>
          <button type="button" onclick="appRowNotesRegen(${i})" title="Regenerate from entered info" style="background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;padding:0 2px">⟲</button>
        </div>
        <textarea rows="1" oninput="appRowField(${i},'notes',this.value)" style="width:100%;resize:vertical;${_APP_IN}">${_appEsc(r.notes)}</textarea>
      </div>
      ${specWarn}
    </div>`;
  }).join('');
}

// ── Row event handlers ──
function appRowType(i,type){
  const r=_appRows[i]; if(!r) return;
  r.type=type;
  if(type!=='seed') r.seedTags='';
  _appRowAutoNotes(r);
  _appAmendmentFill(r);
  appRowsRender(); appSyncEntryNotes();
  if(typeof _trSeedSectionSync==='function') _trSeedSectionSync();
}
function appRowField(i,k,v){
  const r=_appRows[i]; if(!r) return;
  r[k]=v;
  // A hand-typed product/rate ends its auto stamp (never re-clobbered after).
  if(k==='product'&&v!==r._autoProduct) r._autoProduct='';
  if(k==='rate'&&v!==r._autoRate) r._autoRate='';
  if(k!=='notes') _appRowAutoNotes(r);
  if(k==='rate'||k==='rateUnit') _appRowsRenderSoft(i);   // required readout updates live
  appSyncEntryNotes();
  if(typeof _trSeedSectionSync==='function') _trSeedSectionSync();
}
function appRowRemove(i){
  _appRows.splice(i,1);
  if(!_appRows.length) _appRows=[_appNewRow('seed')];
  appRowsRender(); appSyncEntryNotes();
  if(typeof _trSeedSectionSync==='function') _trSeedSectionSync();
}
function appRowAdd(){
  // Sensible next type: seed → lime → fertilizer → mulch → other.
  const used=new Set(_appRows.map(r=>r.type));
  const next=GL_APP_TYPES.find(t=>!used.has(t.id));
  const r=_appNewRow(next?next.id:'other');
  _appRows.push(r);
  _appAmendmentFill(r);
  appRowsRender();
  if(typeof _trSeedSectionSync==='function') _trSeedSectionSync();
}
function appRowNotesRegen(i){
  const r=_appRows[i]; if(!r) return;
  const gen=glAppSummaryLine(_rowAsApp(r),_appAcres());
  r.notes=gen; r._autoNotes=gen;
  appRowsRender(); appSyncEntryNotes();
}
// Re-render ONE row's required readout without rebuilding the DOM mid-keystroke.
function _appRowsRenderSoft(i){
  const host=document.getElementById('map-tr-apps');
  const box=host?host.children[i]:null;
  if(!box) return;
  const r=_appRows[i];
  const acres=_appAcres();
  const req=(r.rate!==''&&acres>0)?(parseFloat(r.rate)*acres):null;
  const el=[...box.querySelectorAll('div')].find(d=>d.previousElementSibling&&/Required/i.test(d.previousElementSibling.textContent||''));
  if(el) el.textContent=req!=null?((+req.toFixed(req>=100?0:1)).toLocaleString('en-US')+' '+(r.rateUnit||'lbs/ac').split('/')[0]):'—';
}
function _rowAsApp(r){
  return {type:r.type,product:r.product.trim()||null,rate:r.rate!==''?parseFloat(r.rate):null,
    rateUnit:r.rateUnit,actual:r.actual!==''?parseFloat(r.actual):null,actualUnit:r.actualUnit,
    seedTags:r.seedTags!==''?parseInt(r.seedTags):null};
}
// Fill-as-you-go notes: regenerate while untouched (empty or still the last auto value).
function _appRowAutoNotes(r){
  const gen=glAppSummaryLine(_rowAsApp(r),_appAcres());
  if(!r.notes||r.notes===r._autoNotes){ r.notes=gen; r._autoNotes=gen; }
  const host=document.getElementById('map-tr-apps');
  const i=_appRows.indexOf(r);
  const box=host?host.children[i]:null;
  const ta=box?box.querySelector('textarea'):null;
  if(ta&&ta.value!==r.notes&&document.activeElement!==ta) ta.value=r.notes;
}
// Entry Notes auto block — the forgotten-button fix. One line per application,
// maintained while the field is untouched (dataset.auto pattern); ⟲ restores.
function appSyncEntryNotes(force){
  const el=document.getElementById('map-tr-notes');
  if(!el) return;
  // Planned areas: notes double as the export's group label — never auto-fill.
  if(typeof window._glEntryIsPlanned==='function'&&window._glEntryIsPlanned()) return;
  const acres=_appAcres();
  const block=_appRows.filter(r=>r.product||r.rate!==''||r.actual!=='')
    .map(r=>glAppSummaryLine(_rowAsApp(r),acres)).filter(Boolean).join('\n');
  if(force||el.value===''||el.value===el.dataset.auto){
    el.value=block; el.dataset.auto=block;
  }
}
function appEntryNotesRegen(){ appSyncEntryNotes(true); }
// Acres changed → refresh every row's required + auto notes.
function appRowsRecalc(){
  _appRows.forEach(r=>_appRowAutoNotes(r));
  appRowsRender();
  appSyncEntryNotes();
}

// ── Prefills (state material + specs engine) — never-clobber ──
function appStatePrefill(st){
  const r=_appRows.find(x=>x.type==='seed')||_appRows[0];
  if(!r||!st) return;
  if(st.targetRate!=null&&(!r.rate||r.rate===r._autoRate)){ r.rate=String(st.targetRate); r._autoRate=r.rate; }
  if(st.productName&&(!r.product||r.product===r._autoProduct)){ r.product=st.productName; r._autoProduct=st.productName; }
  _appRowAutoNotes(r);
  appRowsRender(); appSyncEntryNotes();
}
function appSpecFill(res){
  const r=_appRows.find(x=>x.type==='seed');
  if(!r||!res) return;
  if(res.rate!=null&&(!r.rate||r.rate===r._autoRate)){ r.rate=String(res.rate); r._autoRate=r.rate; }
  if(res.product&&(!r.product||r.product===r._autoProduct)){ r.product=res.product; r._autoProduct=res.product; }
  _appRowAutoNotes(r);
  appRowsRender(); appSyncEntryNotes();
}
// Amendment rules (seedingSpecs cfg.amendments) → lime/fert row autofill + amber deviation.
function _appAmendmentFill(r){
  if(r.type==='seed'||typeof ssResolveAmendment!=='function') return;
  const pid=_sbPid();
  const cfg=(typeof ssGetCfg==='function')?ssGetCfg(pid):null;
  if(!cfg) return;
  const sel={
    type:r.type,
    where:document.getElementById('map-tr-where')?.value||'',
    date:document.getElementById('map-tr-date')?.value||'',
  };
  const rule=ssResolveAmendment(cfg,sel);
  r._specWarn='';
  if(!rule) return;
  if(rule.rate!=null&&(!r.rate||r.rate===r._autoRate)){ r.rate=String(rule.rate); r._autoRate=r.rate; }
  if(rule.rateUnit&&r.rateUnit==='lbs/ac') r.rateUnit=rule.rateUnit;
  if(rule.product&&(!r.product||r.product===r._autoProduct)){ r.product=rule.product; r._autoProduct=rule.product; }
  // Out-of-spec: a user rate that disagrees with the rule gets a standing amber line.
  if(rule.rate!=null&&r.rate!==''&&parseFloat(r.rate)!==rule.rate&&r.rate!==r._autoRate)
    r._specWarn=`Spec calls for ${rule.product||GL_APP_TYPE_LABELS[r.type]} @ ${rule.rate} ${rule.rateUnit||'lbs/ac'}${rule.cite?' ('+rule.cite+')':''} — entered rate differs.`;
  _appRowAutoNotes(r);
}
// Where/date changed in the entry form → re-run amendment fills.
function appAmendmentsSync(){
  _appRows.forEach(r=>{ if(r.type!=='seed') _appAmendmentFill(r); });
  appRowsRender(); appSyncEntryNotes();
}

// ── 🌱 Seed bag weights (Settings → one list per project, done once a season) ──
function sbShowWeights(){
  const pid=_sbPid();
  const render=()=>{
    const list=sbGetProducts(pid).map((p,i)=>`
      <div style="display:flex;gap:8px;align-items:center;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="flex:1;min-width:0;font-family:var(--mono);font-size:12px;color:var(--text)">${_appEsc(p.product)}</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--amber);white-space:nowrap">${p.weightLbs} lbs/bag</div>
        <button onclick="sbDeleteWeight(${i})" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:5px 8px;cursor:pointer">🗑</button>
      </div>`).join('')
      ||'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:8px 0">No bag weights yet — add your mixes below (e.g. Annual rye — 50).</div>';
    const box=document.getElementById('sb-wt-body');
    if(box) box.innerHTML=list;
  };
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.innerHTML=`<div class="modal-box" style="max-width:420px">
    <h3 style="margin:0 0 4px">🌱 Seed Bag Weights</h3>
    <p style="font-size:11px;color:var(--muted);margin:0 0 10px">One line per product: how many lbs a bag holds. Seed-tag photos then track themselves — a tag photo's capacity is tags-in-photo × bag weight, and every entry it's attached to draws it down. Nothing else to enter in the field.</p>
    <div id="sb-wt-body" style="max-height:44vh;overflow-y:auto"></div>
    <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
      <div style="display:grid;grid-template-columns:1fr 100px;gap:6px">
        <input type="text" id="sb-wt-product" placeholder="Product / mix (matches entry mix)" style="width:100%;${_APP_IN}">
        <input type="number" id="sb-wt-lbs" step="0.1" min="0" placeholder="lbs/bag" style="width:100%;${_APP_IN}">
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px">
        <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Close</button>
        <button class="btn" onclick="sbAddWeight()">＋ Add</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  window._sbWtRender=render;
  render();
  sbEnsureCfg(pid).then(render);
}
async function sbAddWeight(){
  const pid=_sbPid();
  const product=document.getElementById('sb-wt-product')?.value.trim();
  const w=parseFloat(document.getElementById('sb-wt-lbs')?.value);
  if(!product||isNaN(w)||w<=0) return;
  // Same product again = update its weight, never a duplicate line.
  const products=sbGetProducts(pid).filter(p=>_sbNorm(p.product)!==_sbNorm(product));
  products.push({product,weightLbs:w});
  await sbSaveProducts(products,pid);
  ['sb-wt-product','sb-wt-lbs'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  if(window._sbWtRender) window._sbWtRender();
  if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip();
}
async function sbDeleteWeight(i){
  const pid=_sbPid();
  const products=sbGetProducts(pid).slice();
  if(!products[i]) return;
  products.splice(i,1);
  await sbSaveProducts(products,pid);
  if(window._sbWtRender) window._sbWtRender();
  if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip();
}

// ── Window seams (Vite ESM cross-module pattern) ──
window.GL_APP_TYPE_LABELS=GL_APP_TYPE_LABELS;
window.glAppTypeFromState=glAppTypeFromState;
window.glEntryApplications=glEntryApplications;
window.glAppSummaryLine=glAppSummaryLine;
window.appRowsReset=appRowsReset;
window.appRowsSet=appRowsSet;
window.appRowsGet=appRowsGet;
window.appRowsHasData=appRowsHasData;
window.appMirrorRow=appMirrorRow;
window.appRowsRecalc=appRowsRecalc;
window.appRowsRender=appRowsRender;
window.appRowType=appRowType;
window.appRowField=appRowField;
window.appRowRemove=appRowRemove;
window.appRowAdd=appRowAdd;
window.appRowNotesRegen=appRowNotesRegen;
window.appEntryNotesRegen=appEntryNotesRegen;
window.appStatePrefill=appStatePrefill;
window.appSpecFill=appSpecFill;
window.appAmendmentsSync=appAmendmentsSync;
window.appSyncEntryNotes=appSyncEntryNotes;
window.sbShowWeights=sbShowWeights;
window.sbAddWeight=sbAddWeight;
window.sbDeleteWeight=sbDeleteWeight;
window.sbEnsureCfg=sbEnsureCfg;
window.sbGetProducts=sbGetProducts;
window.sbWeightFor=sbWeightFor;
window.sbPhotoLedger=sbPhotoLedger;
window.sbPhotoInfo=sbPhotoInfo;
window.sbPhotoBadge=sbPhotoBadge;
window.sbSetPhotoTagCount=sbSetPhotoTagCount;
