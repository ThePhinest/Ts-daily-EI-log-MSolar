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
// application, generated as-you-go so nobody has to remember a button. Compact
// (Tim 8/18): mix/tags/actual live in their own columns, so the note is just
// the calc line — "100 lbs/ac × 0.43 ac = 43 lbs" — with a type prefix on
// non-seed lines only (readable in entry notes; the seed tab filters on it).
function glAppSummaryLine(app, acres){
  if(!app) return '';
  if(!app.product&&(app.rate==null||app.rate==='')&&(app.actual==null||app.actual==='')) return '';
  const ru=app.rateUnit||'lbs/ac';
  const prefix=(app.type&&app.type!=='seed')?((GL_APP_TYPE_LABELS[app.type]||'Material')+': '):'';
  if(app.rate!=null&&app.rate!==''&&acres>0){
    const req=app.rate*acres;
    return prefix+app.rate+' '+ru+' × '+(+acres.toFixed(2))+' ac = '
      +(+req.toFixed(req>=100?0:1)).toLocaleString('en-US')+' '+ru.split('/')[0];
  }
  // No rate/area yet — fall back to what IS known.
  const bits=[];
  if(app.product) bits.push(app.product);
  if(app.actual!=null&&app.actual!=='') bits.push('used '+app.actual+' '+(app.actualUnit||'lbs'));
  return bits.length?(prefix+bits.join(' — ')):'';
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
// Default application rate (lbs/ac) for a material — the lime/fert half of the
// list (bulk totes / truck drops have no bags to count; the useful number is
// the rate, auto-filled onto the row the moment the product matches).
function sbRateFor(product, pid){
  const n=_sbNorm(product);
  if(!n) return null;
  const hit=sbGetProducts(pid).find(p=>_sbNorm(p.product)===n);
  return (hit&&hit.rateLbsAc>0)?hit.rateLbsAc:null;
}
// ⚠ Same boot race that lost the contractor list 8/20 (see ctrEnsureCfg): the
// IDB mirror hydrates async and _fbReady is false at boot, so an early call used
// to cache "nothing" for the whole session — badges read "no bag weight set"
// until Settings or a drawing happened to reload it (Tim 8/21), and an Add from
// the Materials modal in that window would have overwritten the cloud list.
// Rules: await idbReady → a result is final only once Firestore was consulted
// (_sbCloudChecked; every later call retries the cloud until it lands) →
// newest updatedAtMs wins → never write a default before the cloud check.
var _sbCloudChecked={};   // pid → true once Firestore has actually been consulted this session
function sbCloudChecked(pid){ return !!_sbCloudChecked[pid||_sbPid()]; }
async function sbEnsureCfg(pid){
  pid=pid||_sbPid();
  if(_sbCfg[pid]!==undefined&&_sbCloudChecked[pid]) return _sbCfg[pid];
  if(_sbLoading[pid]) return _sbLoading[pid];
  _sbLoading[pid]=(async()=>{
    try{ if(window.idbReady) await window.idbReady; }catch(_){}
    let local=null;
    try{ local=idbGet('sb_cfg::'+pid)||null; }catch(_){}
    if(_sbCfg[pid]===undefined||(_sbCfg[pid]===null&&local)) _sbCfg[pid]=local;
    if(typeof db!=='undefined'&&db&&typeof _fbReady!=='undefined'&&_fbReady){
      try{
        const snap=await db.collection('projects').doc(pid).collection('config').doc('seedBags').get();
        if(snap.exists){
          const cloud=snap.data();
          const cur=_sbCfg[pid];
          if(!cur||((cloud.updatedAtMs||0)>=(cur.updatedAtMs||0))){ _sbCfg[pid]=cloud; idbSet('sb_cfg::'+pid,cloud); }
        }
        _sbCloudChecked[pid]=true;
      }catch(e){ console.warn('seed bags load failed:',e.message); }
    }
    delete _sbLoading[pid];
    return _sbCfg[pid];
  })();
  return _sbLoading[pid];
}
// The list is editable once the cloud has been consulted — or, when Firebase
// still isn't up / the device is offline after a 6 s grace from opening the
// modal, locally (newest-wins reconciles it on the next cloud check).
var _sbEditGraceAt=0;
function sbEditable(pid){
  pid=pid||_sbPid();
  if(_sbCloudChecked[pid]) return true;
  const graced=_sbEditGraceAt>0&&(Date.now()-_sbEditGraceAt)>6000;
  if(!graced) return false;
  const fbUp=(typeof db!=='undefined'&&db&&typeof _fbReady!=='undefined'&&_fbReady);
  return !fbUp||navigator.onLine===false;
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
// ── Tag-photo ledger — the whole bag tracker, fully derived, any material ──
// Every live entry, chronologically: each attached tag photo resolves to a
// PRODUCT (its stored tagProduct override, else the entry's seed mix — the
// default material a tag photo means), and that product's application lbs
// drain into its photos in attachment order. A photo's capacity =
// tags-in-photo × bag weight; count comes from the photo's override (tagCount)
// or infers from the entry's Tags 🏷️ field when it's the entry's only SEED tag
// photo (Tim's 6-tags-in-one-shot workflow), else 1. Overflow lands on the
// last tag so over-usage reads truthfully as negative remaining. Lime/fert
// bags ride the same rails: weight-list line + tag photo assigned to that
// material in the tag popup.
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
    const apps=(typeof glEntryApplications==='function')?glEntryApplications(e,pid):[];
    const seedApp=apps.find(a=>a&&a.type==='seed')||null;
    const defProduct=(seedApp&&seedApp.product)||e.seedMix||null;
    // Photo → product, then group the entry's tags per product.
    const groups=new Map();   // normProduct → {product, app, ids:[]}
    tagIds.forEach(id=>{
      const ph=(window._phPhotos||[]).find(p=>p.id===id);
      const product=(ph&&ph.tagProduct)?ph.tagProduct:defProduct;
      const key=_sbNorm(product);
      if(!groups.has(key)){
        const app=apps.find(a=>a&&_sbNorm(a.product)===key)||((key===_sbNorm(defProduct))?seedApp:null);
        groups.set(key,{product,app,ids:[]});
      }
      groups.get(key).ids.push(id);
    });
    for(const g of groups.values()){
      const isSeedGroup=!!(g.app&&g.app.type==='seed');
      g.ids.forEach(id=>{
        if(led.has(id)) return;
        const ph=(window._phPhotos||[]).find(p=>p.id===id);
        const tags=isSeedGroup?((g.app.seedTags!=null)?g.app.seedTags:((e.fields&&e.fields.seedTagCount!=null)?e.fields.seedTagCount:null)):null;
        // ↪ A carried-in tag's capacity IS the snapshot that was transferred to it
        // (one leftover tag, re-photographed alone) — bag weight doesn't apply.
        const carry=(ph&&ph.carryLbs>0)?+ph.carryLbs:null;
        const count=carry!=null?1:((ph&&ph.tagCount>0)?ph.tagCount:((isSeedGroup&&g.ids.length===1&&tags>0)?tags:1));
        const w=sbWeightFor(g.product,pid);
        const capacity=carry!=null?carry:((w!=null)?count*w:null);
        led.set(id,{product:g.product,count,weight:w,capacity,used:0,countInferred:!(ph&&ph.tagCount>0),
          type:isSeedGroup?'seed':(g.app?(g.app.type||'other'):'seed'),   // a tag with no matching application is a seed tag by default
          carry,carryFrom:(ph&&ph.carryFrom)||null,closed:!!(ph&&ph.tagClosed),entryDate:e.date||null});
      });
      let lbs=(g.app&&g.app.actual!=null&&(g.app.actualUnit||'lbs')==='lbs')?(+g.app.actual||0):0;
      if(!lbs) continue;
      for(let i=0;i<g.ids.length&&lbs>0;i++){
        const L=led.get(g.ids[i]);
        const last=(i===g.ids.length-1);
        const take=last?lbs:(L.capacity!=null?Math.min(lbs,Math.max(0,L.capacity-L.used)):lbs);
        L.used+=take; lbs-=take;
      }
    }
  }
  return led;
}
// Task-scoped ledger memo: one synchronous render pass (sheet totals, a grid of
// badges, per-row counts) shares a single derivation instead of rebuilding per
// row. It lives only until the end of the current event-loop turn — any
// mutation (transfer, retire, tag-count edit, attach) runs in a later task and
// therefore always derives fresh. Explicit ledgers passed by callers still win.
let _sbLedMemo={pid:null,led:null};
function sbLedgerCached(pid){
  pid=pid||_sbPid();
  if(_sbLedMemo.led&&_sbLedMemo.pid===pid) return _sbLedMemo.led;
  const led=sbPhotoLedger(pid); _sbLedMemo={pid,led};
  setTimeout(()=>{ _sbLedMemo.led=null; },0);
  return led;
}
// Physical seed tags across a set of entries (8/24, Tim: "list the actual number
// of bags used"). One tag photographed once and attached to three locations is
// ONE tag: count = Σ over DISTINCT seed-tag photos of tags-in-photo (the ledger
// count — override, else inferred from the entry's Tags field, else 1); a
// carried-in continuation photo is the same physical tag as its source → 0.
// Entries with no tag photo at all fall back to their typed Tags 🏷️ field, so
// pre-ledger history still counts. Returns {count, ids:Set, shared} — shared =
// one of the counted photos is also attached to an entry OUTSIDE this set (the
// export marks such rows with *; the grand total is taken over all rows at once
// so a shared tag lands once).
function sbTagCountFor(entries, pid, led, allEntries){
  pid=pid||_sbPid();
  led=led||sbLedgerCached(pid);
  const ids=new Set(); let count=0;
  (entries||[]).forEach(e=>{
    if(!e) return;
    const types=e.photoTypes||{};
    const seedIds=(e.photoIds||[]).filter(id=>types[id]==='material_tag'&&(led.get(id)?led.get(id).type==='seed':true));
    if(!seedIds.length){ count+=(+(e.fields&&e.fields.seedTagCount)||0); return; }
    seedIds.forEach(id=>{
      if(ids.has(id)) return;
      ids.add(id);
      const L=led.get(id);
      if(L&&L.carryFrom) return;
      const ph=L?null:(window._phPhotos||[]).find(p=>p.id===id);
      count+=(L&&L.count>0)?L.count:((ph&&ph.tagCount>0)?ph.tagCount:1);
    });
  });
  let shared=false;
  if(allEntries&&ids.size){
    const inSet=new Set((entries||[]).map(e=>e&&e.id));
    shared=allEntries.some(e=>e&&!inSet.has(e.id)&&(e.photoIds||[]).some(id=>ids.has(id)&&(e.photoTypes||{})[id]==='material_tag'));
  }
  return {count,ids,shared};
}
function sbPhotoInfo(photoId, pid, led){
  const L=(led||sbLedgerCached(pid)).get(photoId);
  if(!L) return null;
  // leftover = the raw math; remaining = what's still usable (0 once retired/carried on).
  const leftover=(L.capacity!=null)?(L.capacity-L.used):null;
  return {...L, leftover, remaining:(leftover==null)?null:(L.closed?0:leftover)};
}
// Badge text for a tag photo — remaining when computable, setup hints otherwise.
// Returns {txt, amber, info, closed}; every surface (entry strip, attach picker,
// map popup, Photos grid, lightbox) renders from this one function.
function sbPhotoBadge(photoId, pid, led){
  const info=sbPhotoInfo(photoId,pid,led);
  if(!info) return null;
  if(info.remaining==null) return {txt:'⚖ set bag wt',amber:false,info,closed:false};
  if(info.closed){
    const lo=+(info.leftover||0).toFixed(1);
    return {txt:'✔ retired'+(lo>0?' · '+lo.toLocaleString('en-US')+' lbs carried on':''),amber:false,info,closed:true};
  }
  const r=+info.remaining.toFixed(1);
  return {txt:(r<=0?'⚠ ':(info.carry!=null?'↪ ':'🌱 '))+r.toLocaleString('en-US')+' lbs left',amber:r<=0,info,closed:false};
}
// Full ledger sentence for the tag modal / lightbox: "3 tags × 50 lbs (mix) = 150 lbs · 120 used · 30 left".
function sbPhotoLedgerLine(photoId, pid){
  const info=sbPhotoInfo(photoId,pid);
  if(!info||info.capacity==null) return '';
  const esc=s=>String(s||'').replace(/</g,'&lt;');
  const src=info.carry!=null
    ?`↪ ${info.carry.toLocaleString('en-US')} lbs carried in (${esc(info.product)})`
    :`${info.count} tag${info.count>1?'s':''} × ${info.weight} lbs (${esc(info.product)})`;
  const rem=+info.remaining.toFixed(1);
  const tail=info.closed?`<b>retired</b>`:`<b>${rem.toLocaleString('en-US')} left</b>`;
  return `${src} = ${info.capacity.toLocaleString('en-US')} lbs · ${info.used.toLocaleString('en-US')} used · ${tail}`;
}
// ── ↪ Leftover-tag transfer (Tim 8/20) ──
// A 9-tag photo closing an area that only needed 1 tag leaves one bag's worth
// on the ledger. Rather than re-using the 9-tag photo to burn it down, the EI
// RETIRES that photo's leftover and photographs the single leftover tag on the
// new area; the new photo CONTINUES FROM the old one and inherits the leftover
// as a snapshot. One transfer per source (you only ever have one leftover tag —
// otherwise you'd have used one less bag). Reopen/undo is symmetric.
function _sbPhSave(ph){
  if(typeof phSaveLocal==='function') phSaveLocal();
  if(typeof phSaveCloudOne==='function') phSaveCloudOne(ph);
}
function sbRetireTag(photoId){
  const ph=(window._phPhotos||[]).find(p=>p.id===photoId);
  if(!ph) return false;
  ph.tagClosed=true; _sbPhSave(ph); return true;
}
function sbReopenTag(photoId){
  const ph=(window._phPhotos||[]).find(p=>p.id===photoId);
  if(!ph) return false;
  // A source that was carried on can't reopen while the carry stands — undo the carry instead.
  if((window._phPhotos||[]).some(p=>p.carryFrom===photoId&&p.carryLbs>0)) return false;
  delete ph.tagClosed; _sbPhSave(ph); return true;
}
// Tag photos this one could continue from: open, same product (when known), with leftover.
function sbCarryCandidates(photoId, product, pid){
  pid=pid||_sbPid();
  const n=_sbNorm(product);
  const out=[];
  sbPhotoLedger(pid).forEach((L,id)=>{
    if(id===photoId||L.closed||L.capacity==null) return;
    const rem=L.capacity-L.used;
    if(rem<=0) return;
    if(n&&_sbNorm(L.product)!==n) return;
    out.push({id,product:L.product,remaining:+rem.toFixed(1),date:L.entryDate});
  });
  return out.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
}
function sbTransferCarry(fromId, toId){
  const from=(window._phPhotos||[]).find(p=>p.id===fromId);
  const to=(window._phPhotos||[]).find(p=>p.id===toId);
  if(!from||!to||fromId===toId) return false;
  const info=sbPhotoInfo(fromId);
  if(!info||info.closed||info.remaining==null||info.remaining<=0) return false;
  to.carryLbs=+info.remaining.toFixed(2);   // SNAPSHOT — never recomputed
  to.carryFrom=fromId;
  to.tagCount=1;
  if(info.product) to.tagProduct=info.product;
  from.tagClosed=true;
  _sbPhSave(from); _sbPhSave(to);
  return true;
}
function sbUndoCarry(toId){
  const to=(window._phPhotos||[]).find(p=>p.id===toId);
  if(!to||!to.carryFrom) return false;
  const from=(window._phPhotos||[]).find(p=>p.id===to.carryFrom);
  delete to.carryLbs; delete to.carryFrom;
  _sbPhSave(to);
  if(from){ delete from.tagClosed; _sbPhSave(from); }
  return true;
}
// Per-photo tag-count + material overrides — synced through the photos dirty-ID
// pipeline (phSaveCloudOne routes through the dirty flush so a failed write
// stays pending).
function sbSetPhotoTagCount(photoId, count){
  const ph=(window._phPhotos||[]).find(p=>p.id===photoId);
  if(!ph) return;
  const n=parseInt(count);
  if(n>0) ph.tagCount=n; else delete ph.tagCount;
  if(typeof phSaveLocal==='function') phSaveLocal();
  if(typeof phSaveCloudOne==='function') phSaveCloudOne(ph);
}
function sbSetPhotoTagProduct(photoId, product){
  const ph=(window._phPhotos||[]).find(p=>p.id===photoId);
  if(!ph) return;
  const v=String(product||'').trim();
  if(v) ph.tagProduct=v; else delete ph.tagProduct;
  if(typeof phSaveLocal==='function') phSaveLocal();
  if(typeof phSaveCloudOne==='function') phSaveCloudOne(ph);
}
// The entry form's current application products (for the tag popup's material picker).
function appRowProducts(){
  const seen=new Set(); const out=[];
  _appRows.forEach(r=>{
    const p=r.product.trim();
    if(!p||seen.has(_sbNorm(p))) return;
    seen.add(_sbNorm(p));
    out.push({type:r.type,product:p});
  });
  return out;
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
  // #61 (9/2): dataset.auto is set by the edit-form opener from entry.notesAuto —
  // don't wipe it here, or the drawing note stops following rate edits after a save.
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
  // Product comes from the 🎒 picker (materials list, Settings) or free text;
  // matching a materials line triggers the lbs/ac rate autofill either way.
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
        <div style="display:flex;gap:6px"><input type="text" data-f="product" value="${_appEsc(r.product)}" oninput="appRowField(${i},'product',this.value)" placeholder="${isSeed?'Seed mix / product':'Product (e.g. ag lime, 10-10-10)'}" style="flex:1;min-width:0;${_APP_IN}">${glPickBtn(`sbPickProduct(${i})`,'🎒',"Pick from the project's materials list")}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end">
        <div>
          <label style="font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Rate</label>
          <input type="number" data-f="rate" step="0.1" min="0" value="${_appEsc(r.rate)}" oninput="appRowField(${i},'rate',this.value)" placeholder="0" style="width:100%;${_APP_IN}">
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
  // Materials-list rate default (lime 2000 lbs/ac etc.): product matches a line
  // with lbs/ac → the rate fills itself, never clobbering a hand-entered one.
  if(k==='product'){
    const rt=sbRateFor(v);
    if(rt!=null&&(!r.rate||r.rate===r._autoRate)){
      r.rate=String(rt); r._autoRate=r.rate;
      const box=document.getElementById('map-tr-apps')?.children[i];
      const rEl=box?box.querySelector('input[data-f="rate"]'):null;
      if(rEl&&document.activeElement!==rEl) rEl.value=r.rate;
    }
  }
  if(k!=='notes') _appRowAutoNotes(r);
  if(k==='product'||k==='rate'||k==='rateUnit') _appRowsRenderSoft(i);   // required readout updates live
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
// 9/2 evening (Tim: "nothing updates on a saved entry — not the drawing note, not the seeding
// note"): the never-clobber stamps used to die with the modal, so a SAVED entry's product /
// rate / notes could never follow a spec or rate change again. On edit-open the stamps are
// recovered by CONTENT IDENTITY: a stored value that still equals what the engine would
// generate for it is treated as auto (keeps flowing); anything hand-typed stays untouched.
// `res` = the seeding-spec resolution for the entry's stored where/purpose/date/method.
function appMarkAutoByContent(res){
  const acres=_appAcres();
  const pid=_sbPid();
  const cfg=(typeof ssGetCfg==='function')?ssGetCfg(pid):null;
  const amendSel={where:document.getElementById('map-tr-where')?.value||'', date:document.getElementById('map-tr-date')?.value||''};
  _appRows.forEach(r=>{
    const gen=glAppSummaryLine(_rowAsApp(r),acres);
    if(r.notes&&r.notes===gen) r._autoNotes=gen;
    if(r.type==='seed'){
      if(res&&res.product&&r.product===res.product) r._autoProduct=r.product;
      if(res&&res.rate!=null&&r.rate!==''&&String(+r.rate)===String(+res.rate)) r._autoRate=r.rate;
    } else if(cfg&&typeof ssResolveAmendment==='function'){
      try{ const rule=ssResolveAmendment(cfg,{type:r.type,...amendSel}); if(rule&&rule.rate!=null&&r.rate!==''&&String(+r.rate)===String(+rule.rate)) r._autoRate=r.rate; }catch{}
    }
    if(r.rate!==''&&!r._autoRate&&r.product){ const rt=sbRateFor(r.product); if(rt!=null&&String(+r.rate)===String(+rt)) r._autoRate=r.rate; }   // materials-list default rate
  });
  const el=document.getElementById('map-tr-notes');
  if(el&&!el.dataset.auto&&!(typeof window._glEntryIsPlanned==='function'&&window._glEntryIsPlanned())){
    const block=_appRows.filter(r=>r.product||r.rate!==''||r.actual!=='').map(r=>glAppSummaryLine(_rowAsApp(r),acres)).filter(Boolean).join('\n');
    if(block&&el.value.trim()===block.trim()) el.dataset.auto=el.value;
  }
}
window.appMarkAutoByContent=appMarkAutoByContent;
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
  _sbEditGraceAt=Date.now();
  const render=()=>{
    const ed=sbEditable(pid);
    const list=sbGetProducts(pid).map((p,i)=>{
      const bits=[];
      if(p.weightLbs>0) bits.push(p.weightLbs+' lbs/bag');
      if(p.rateLbsAc>0) bits.push(p.rateLbsAc+' lbs/ac');
      return `
      <div style="display:flex;gap:8px;align-items:center;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="flex:1;min-width:0;font-family:var(--mono);font-size:12px;color:var(--text)">${_appEsc(p.product)}</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--amber);white-space:nowrap">${bits.join(' · ')||'—'}</div>
        <button onclick="sbRenameProduct(${i})" title="Rename everywhere (entries, tag photos, this list)" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:5px 8px;cursor:pointer">✏️</button>
        <button onclick="sbDeleteWeight(${i})" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:5px 8px;cursor:pointer">🗑</button>
      </div>`;
    }).join('')
      ||(ed
        ?'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:8px 0">No materials yet — e.g. "Annual rye · 50 lbs/bag" or "Lime · 2000 lbs/ac".</div>'
        :'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:8px 0">Loading the materials list…</div>');
    const box=document.getElementById('sb-wt-body');
    if(box) box.innerHTML=(ed?'':'<div style="font-family:var(--mono);font-size:10px;color:var(--amber);padding:0 0 8px">⏳ Syncing with the cloud — editing unlocks in a moment.</div>')+list;
    const add=document.getElementById('sb-wt-add');
    if(add){ add.disabled=!ed; add.style.opacity=ed?'':'.5'; }
  };
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.innerHTML=`<div class="modal-box" style="max-width:440px">
    <h3 style="margin:0 0 4px">🎒 Materials — Bags &amp; Rates</h3>
    <p style="font-size:11px;color:var(--muted);margin:0 0 10px">One line per material. <b>lbs/bag</b> (seed mixes): tag photos track their own remaining pounds. <b>lbs/ac</b> (lime, fertilizer — bulk totes &amp; truck drops have no bags): the rate auto-fills on the entry the moment the product matches. Fill either or both.</p>
    <div id="sb-wt-body" style="max-height:44vh;overflow-y:auto"></div>
    <div id="sb-wt-status" style="display:none;font-family:var(--mono);font-size:11px;color:var(--green,#27AE60);padding:8px 0 0;line-height:1.5"></div>
    <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">🧹 Fresh start — retire old leftovers</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--muted)">Tag photos on drawings dated before</span>
        <input type="date" id="sb-ret-date" value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10)}" onchange="sbRetireBeforeCount()" style="${_APP_IN};width:auto">
        <button class="btn btn-outline" id="sb-ret-btn" onclick="sbRetireBefore()" style="font-size:11px;white-space:nowrap">Retire leftovers</button>
      </div>
      <div id="sb-ret-hint" style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:6px;line-height:1.5">Retired tags keep their record; they just stop showing pounds left and drop out of "Continues from".</div>
    </div>
    <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
      <div style="display:grid;grid-template-columns:1fr 86px 86px;gap:6px">
        <input type="text" id="sb-wt-product" placeholder="Product / mix" style="width:100%;${_APP_IN}">
        <input type="number" id="sb-wt-lbs" step="0.1" min="0" placeholder="lbs/bag" style="width:100%;${_APP_IN}">
        <input type="number" id="sb-wt-rate" step="0.1" min="0" placeholder="lbs/ac" style="width:100%;${_APP_IN}">
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px">
        <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Close</button>
        <button class="btn" id="sb-wt-add" onclick="sbAddWeight()">＋ Add</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  window._sbWtRender=render;
  render();
  // Keep asking until the cloud has been consulted (or the offline grace lapses)
  // — the Add button stays disabled until then, so nothing can overwrite a list
  // that simply hasn't arrived yet.
  const poll=(n)=>{ if(!document.body.contains(ov)) return; sbEnsureCfg(pid).then(()=>{ render(); if(!sbEditable(pid)&&n<30) setTimeout(()=>poll(n+1),500); }); };
  poll(0);
  sbRetireBeforeCount();
}
// Status line INSIDE the materials modal (the cloud banner sits under modal overlays).
function _sbStatus(msg){
  const el=document.getElementById('sb-wt-status');
  if(!el) return;
  el.innerHTML=msg; el.style.display=msg?'':'none';
}
// 🧹 Bulk retire (Tim 8/20: "how do I just retire the leftover old ones… so we're
// fresh and starting from today going forward?"). Every OPEN tag photo with pounds
// left whose drawing is dated before the cutoff gets tagClosed. Count previews on
// the button; nothing is deleted, Reopen still works per photo.
function _sbRetirable(dateStr){
  const out=[];
  if(!dateStr) return out;
  sbPhotoLedger().forEach((L,id)=>{
    if(L.closed||L.capacity==null) return;
    if(L.capacity-L.used<=0) return;
    if(String(L.entryDate||'')>=dateStr) return;
    out.push(id);
  });
  return out;
}
function sbRetireBeforeCount(){
  const d=document.getElementById('sb-ret-date')?.value||'';
  const n=_sbRetirable(d).length;
  const btn=document.getElementById('sb-ret-btn');
  if(btn){ btn.textContent=n?`Retire ${n} leftover${n===1?'':'s'}`:'Nothing to retire'; btn.disabled=!n; btn.style.opacity=n?'':'.5'; }
}
function sbRetireBefore(){
  const d=document.getElementById('sb-ret-date')?.value||'';
  const ids=_sbRetirable(d);
  if(!ids.length) return;
  ids.forEach(id=>sbRetireTag(id));
  sbRetireBeforeCount();
  _sbStatus(`✔ Retired ${ids.length} leftover tag photo${ids.length===1?'':'s'} dated before ${d}.`);
  if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip();
  if(typeof phRender==='function') try{ phRender(); }catch(_){}
}
async function sbAddWeight(){
  const pid=_sbPid();
  if(!sbEditable(pid)){ _sbStatus('⏳ Still syncing the materials list with the cloud — try again in a moment.'); return; }
  const product=document.getElementById('sb-wt-product')?.value.trim();
  const w=parseFloat(document.getElementById('sb-wt-lbs')?.value);
  const rt=parseFloat(document.getElementById('sb-wt-rate')?.value);
  const hasW=!isNaN(w)&&w>0, hasR=!isNaN(rt)&&rt>0;
  if(!product||(!hasW&&!hasR)) return;
  // Same product again = update its line, never a duplicate.
  const products=sbGetProducts(pid).filter(p=>_sbNorm(p.product)!==_sbNorm(product));
  const rec={product};
  if(hasW) rec.weightLbs=w;
  if(hasR) rec.rateLbsAc=rt;
  products.push(rec);
  await sbSaveProducts(products,pid);
  ['sb-wt-product','sb-wt-lbs','sb-wt-rate'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  if(window._sbWtRender) window._sbWtRender();
  if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip();
}
// ✏️ Rename a material EVERYWHERE (#39, Tim 8/20: "Bedrock grazing seed mix",
// "Annual rye"). Names live in project DATA, not code — the materials list, every
// entry's seedMix + applications[].product, and tag photos' tagProduct — so a
// rename has to cascade or exports split one product into two. Case-insensitive
// match (same normalization the export roll-ups use); entries re-save through
// trSaveEntry (cloud mirror + net-memo invalidation), photos through the dirty flush.
async function sbRenameProduct(i){
  const pid=_sbPid();
  if(!sbEditable(pid)){ _sbStatus('⏳ Still syncing the materials list with the cloud — try again in a moment.'); return; }
  const products=sbGetProducts(pid).slice();
  const cur=products[i]; if(!cur) return;
  const next=prompt(`Rename "${cur.product}" everywhere — entries, tag photos, and this list:`,cur.product);
  if(next==null) return;
  const nn=String(next).trim();
  if(!nn||nn===cur.product) return;
  const key=_sbNorm(cur.product);
  if(products.some((p,j)=>j!==i&&_sbNorm(p.product)===_sbNorm(nn))){ alert('A material with that name already exists.'); return; }
  let nE=0,nP=0;
  const entries=(typeof trGetEntriesForProject==='function')?trGetEntriesForProject(pid):[];
  entries.forEach(e=>{
    let hit=false;
    if(_sbNorm(e.seedMix)===key){ e.seedMix=nn; hit=true; }
    if(Array.isArray(e.applications)) e.applications.forEach(a=>{ if(a&&_sbNorm(a.product)===key){ a.product=nn; hit=true; } });
    if(hit){ nE++; if(typeof trSaveEntry==='function') trSaveEntry(e,pid); }
  });
  (window._phPhotos||[]).forEach(ph=>{ if(_sbNorm(ph.tagProduct)===key){ ph.tagProduct=nn; nP++; _sbPhSave(ph); } });
  products[i]={...cur,product:nn};
  await sbSaveProducts(products,pid);
  if(window._sbWtRender) window._sbWtRender();
  if(typeof mapRefreshEntryPhotoStrip==='function') mapRefreshEntryPhotoStrip();
  if(typeof mapRenderTrackerLayers==='function') try{ mapRenderTrackerLayers(); }catch(_){}
  appRowsRender();
  _sbStatus(`✔ Renamed "${_appEsc(cur.product)}" → "${_appEsc(nn)}" — ${nE} drawing${nE===1?'':'s'}, ${nP} tag photo${nP===1?'':'s'} updated.`);
}
async function sbDeleteWeight(i){
  const pid=_sbPid();
  if(!sbEditable(pid)){ _sbStatus('⏳ Still syncing the materials list with the cloud — try again in a moment.'); return; }
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
window.sbRenameProduct=sbRenameProduct;
window.sbRetireBefore=sbRetireBefore;
window.sbRetireBeforeCount=sbRetireBeforeCount;
window.sbEnsureCfg=sbEnsureCfg;
window.sbCloudChecked=sbCloudChecked;
window.sbEditable=sbEditable;
window.sbPickProduct=sbPickProduct;
window.sbTagCountFor=sbTagCountFor;
window.sbLedgerCached=sbLedgerCached;

// 🎒 Product picker on an application row (house modal, never a datalist — Tim
// 8/20). Picking runs the same path as typing the product, so the lbs/ac rate
// autofill, auto-notes and the Required readout all follow.
function sbPickProduct(i){
  sbEnsureCfg().then(()=>{
    const rows=sbGetProducts().filter(p=>p.product).map(p=>{
      const bits=[]; if(p.weightLbs>0) bits.push(p.weightLbs+' lbs/bag'); if(p.rateLbsAc>0) bits.push(p.rateLbsAc+' lbs/ac');
      return {value:p.product,label:p.product,meta:bits.join(' · ')};
    });
    glPick({title:'Pick a material',placeholder:'Search materials…',rows,
      onPick:(v)=>{
        const box=document.getElementById('map-tr-apps')?.children[i];
        const el=box?box.querySelector('input[data-f="product"]'):null;
        if(el) el.value=v;
        appRowField(i,'product',v);
      },
      empty:{text:'No materials yet — add bag weights and rates in Settings → 🎒 Materials.',actionLabel:'Open Materials',onAction:()=>sbShowWeights()}});
  });
}

// Boot: load the materials list for the active project so tag-photo badges read
// right on first paint (Tim 8/21: "have to go in settings or open a drawing
// first, otherwise it says set bag weights"). Re-runs on project switch and,
// with a 5 s backoff, whenever the cloud still hasn't been consulted once
// Firebase is up (boot runs before _fbReady flips).
(function(){
  let _lastPid=null, _lastTry=0;
  const kick=()=>{
    const pid=_sbPid();
    const retry=!_sbCloudChecked[pid]&&window._fbReady&&!_sbLoading[pid]&&(Date.now()-_lastTry>5000);
    if(pid===_lastPid&&!retry) return;
    _lastPid=pid; _lastTry=Date.now();
    sbEnsureCfg(pid).then(()=>{ if(typeof mapRefreshEntryPhotoStrip==='function') try{ mapRefreshEntryPhotoStrip(); }catch(_){} }).catch(e=>console.warn('materials boot:',e.message));
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',kick); else setTimeout(kick,0);
  new MutationObserver(()=>{ try{ kick(); }catch(_){} }).observe(document.body,{childList:true,subtree:true});
})();
window.sbGetProducts=sbGetProducts;
window.sbWeightFor=sbWeightFor;
window.sbPhotoLedger=sbPhotoLedger;
window.sbPhotoInfo=sbPhotoInfo;
window.sbPhotoBadge=sbPhotoBadge;
window.sbSetPhotoTagCount=sbSetPhotoTagCount;
window.sbSetPhotoTagProduct=sbSetPhotoTagProduct;
window.sbPhotoLedgerLine=sbPhotoLedgerLine;
window.sbRetireTag=sbRetireTag;
window.sbReopenTag=sbReopenTag;
window.sbCarryCandidates=sbCarryCandidates;
window.sbTransferCarry=sbTransferCarry;
window.sbUndoCarry=sbUndoCarry;
window.appRowProducts=appRowProducts;
