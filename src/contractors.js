// ── 🏗 Contractor registry (per project) ─────────────────────────────────────
// Tim 8/20: "expand on the section in settings for contractors, be able to list
// a description for each one… only need the names to make it to the daily log".
// Built as a REGISTRY (not a description field): one list per project that feeds
// every place the app already asks for a contractor — the daily-log Active
// Contractor header (on-site names joined), crew-block Contractor/Foreman, the
// map entry's Contractor/Applicator, via one shared datalist. Descriptions and
// contacts are reference-only (never printed in the report header). Storage
// mirrors the bag-weights list: projects/{pid}/config/contractors, lead-write,
// IDB-cached. Multiple contacts per contractor; the picker lists each contact as
// its own option ("Herzog · Will Johnson (PM)") so a crew block can name the
// person on site that day.
//
// Record: {id, name, tier:'epc'|'sub'|'subsub'|'owner'|'other', desc, onSite:true,
//          contacts:[{name,title,phone}]}

const CTR_TIERS={epc:'EPC / GC',sub:'Subcontractor',subsub:'Sub-tier',owner:'Owner / Owner’s rep',other:'Other'};
var _ctrCfg={};      // pid → {list:[...]} | null
var _ctrLoading={};
var _ctrCloudChecked={};   // pid → true once Firestore has actually been consulted this session
function _ctrPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _ctrEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function _ctrId(){ return 'ctr-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function ctrGetList(pid){ const v=_ctrCfg[pid||_ctrPid()]; return (v&&Array.isArray(v.list))?v.list:[]; }

// ⚠ 8/20 data-loss lesson: idbGet reads an in-memory mirror that hydrates ASYNC
// (window.idbReady) and _fbReady is false at boot. The first cut cached "null" from
// both, then the card's seed step saw an empty list and overwrote the real cloud
// list with names-only. Rules now: (1) await idbReady before the local read;
// (2) a result only counts as final once Firestore was actually consulted
// (_ctrCloudChecked) — until then every ensure() retries the cloud; (3) newest
// updatedAtMs wins between local and cloud, so a save made before the cloud check
// resolves is never clobbered by an older cloud doc.
async function ctrEnsureCfg(pid){
  pid=pid||_ctrPid();
  if(_ctrCfg[pid]!==undefined&&_ctrCloudChecked[pid]) return _ctrCfg[pid];
  if(_ctrLoading[pid]) return _ctrLoading[pid];
  _ctrLoading[pid]=(async()=>{
    try{ if(window.idbReady) await window.idbReady; }catch(_){}
    let local=null;
    try{ local=idbGet('ctr_cfg::'+pid)||null; }catch(_){}
    if(_ctrCfg[pid]===undefined||(_ctrCfg[pid]===null&&local)) _ctrCfg[pid]=local;
    if(typeof db!=='undefined'&&db&&typeof _fbReady!=='undefined'&&_fbReady){
      try{
        const snap=await db.collection('projects').doc(pid).collection('config').doc('contractors').get();
        if(snap.exists){
          const cloud=snap.data();
          const cur=_ctrCfg[pid];
          if(!cur||((cloud.updatedAtMs||0)>=(cur.updatedAtMs||0))){ _ctrCfg[pid]=cloud; idbSet('ctr_cfg::'+pid,cloud); }
        }
        _ctrCloudChecked[pid]=true;
      }catch(e){ console.warn('contractors load failed:',e.message); }
    }
    delete _ctrLoading[pid];
    ctrRenderDatalist();
    return _ctrCfg[pid];
  })();
  return _ctrLoading[pid];
}
async function ctrSaveList(list, pid, opts){
  pid=pid||_ctrPid();
  opts=opts||{};
  const cfg={list:list,updatedAtMs:Date.now()};
  _ctrCfg[pid]=cfg;
  idbSet('ctr_cfg::'+pid,cfg);
  try{
    if(typeof db!=='undefined'&&db&&_fbReady)
      await db.collection('projects').doc(pid).collection('config').doc('contractors').set(cfg);
  }catch(e){
    console.warn('contractors cloud save failed (kept locally):',e.message);
    if(typeof showCloudBanner==='function'&&/permission/i.test(e.message||''))
      showCloudBanner('Only a project lead can edit the contractor list — kept on this device only.');
  }
  ctrRenderDatalist();
  if(opts.sync!==false) ctrSyncActiveField();
}

// On-site names joined → the project's Active Contractor default (cfg.contractor).
// Writes through saveProjectConfig so the report header, shared project meta, and
// the daily log (empty-field default only — per-day overrides survive) all follow.
function ctrActiveNames(pid){
  return ctrGetList(pid).filter(c=>c.onSite!==false&&c.name).map(c=>c.name).join(', ');
}
function ctrSyncActiveField(){
  const el=document.getElementById('cfg-contractor');
  if(!el) return;
  // saveProjectConfig reads EVERY cfg-* input — never fire it before the config
  // has been applied to the form (an empty project name = not loaded yet).
  if(!(document.getElementById('cfg-projectName')?.value||'').trim()) return;
  const names=ctrActiveNames();
  if(el.value.trim()===names) return;
  el.value=names;
  if(typeof saveProjectConfig==='function') try{ saveProjectConfig(); }catch(e){ console.warn('ctr sync:',e.message); }
}

// One-time seed: an existing free-text contractor string becomes the first rows
// (split on commas / slashes / ampersands) so nothing has to be retyped.
function ctrSeedFromConfig(){
  if(ctrGetList().length) return false;
  // Never seed until the cloud has been consulted — "empty" before that just
  // means "not loaded yet", and seeding would overwrite the real list.
  if(!_ctrCloudChecked[_ctrPid()]) return false;
  const raw=(document.getElementById('cfg-contractor')?.value||'').trim();
  if(!raw) return false;
  const names=raw.split(/\s*(?:,|\/|&|\band\b)\s*/i).map(s=>s.trim()).filter(Boolean);
  if(!names.length) return false;
  const list=names.map((n,i)=>({id:_ctrId(),name:n,tier:i===0?'epc':'sub',desc:'',onSite:true,contacts:[]}));
  _ctrCfg[_ctrPid()]={list,updatedAtMs:Date.now()};
  return true;
}

// ── Shared datalist: every contractor input points at #gl-ctr-list ──
// Options = each contractor name, then "Contractor · Contact (title)" per contact,
// on-site first. Free text still allowed everywhere (datalist, not select).
function ctrRenderDatalist(){
  let dl=document.getElementById('gl-ctr-list');
  if(!dl){ dl=document.createElement('datalist'); dl.id='gl-ctr-list'; document.body.appendChild(dl); }
  const list=ctrGetList().slice().sort((a,b)=>(b.onSite!==false)-(a.onSite!==false));
  const opts=[];
  list.forEach(c=>{
    if(!c.name) return;
    opts.push(`<option value="${_ctrEsc(c.name)}">${_ctrEsc([CTR_TIERS[c.tier]||'',c.desc].filter(Boolean).join(' — '))}</option>`);
    (c.contacts||[]).forEach(k=>{ if(k.name) opts.push(`<option value="${_ctrEsc(c.name+' · '+k.name)}">${_ctrEsc([k.title,k.phone].filter(Boolean).join(' · '))}</option>`); });
  });
  dl.innerHTML=opts.join('');
  // Late-rendered inputs (crew blocks are built per day) pick the list up here.
  document.querySelectorAll('input[id^="crew-"][id$="-name"], #map-tr-contractor').forEach(i=>{ if(!i.getAttribute('list')) i.setAttribute('list','gl-ctr-list'); });
}

// ── Settings card ──
function ctrRenderCard(){
  const box=document.getElementById('ctr-card-body');
  if(!box) return;
  const list=ctrGetList();
  const rows=list.map((c,i)=>{
    const contacts=(c.contacts||[]).filter(k=>k.name).map(k=>`<span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:10px;padding:1px 7px">👤 ${_ctrEsc(k.name)}${k.title?` <span style="opacity:.7">· ${_ctrEsc(k.title)}</span>`:''}${k.phone?` <a href="tel:${_ctrEsc(k.phone)}" style="color:var(--amber);text-decoration:none">${_ctrEsc(k.phone)}</a>`:''}</span>`).join(' ');
    return `<div style="border:1px solid var(--border);border-left:3px solid ${c.onSite!==false?'var(--amber)':'var(--border)'};border-radius:8px;padding:8px 10px;margin-bottom:6px;opacity:${c.onSite!==false?1:.6}">
      <div style="display:flex;gap:8px;align-items:center">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--mono);font-size:12px;color:var(--text);font-weight:700">${_ctrEsc(c.name)} <span style="font-weight:400;color:var(--muted);font-size:10px">· ${_ctrEsc(CTR_TIERS[c.tier]||'')}</span></div>
          ${c.desc?`<div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.4">${_ctrEsc(c.desc)}</div>`:''}
          ${contacts?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px">${contacts}</div>`:''}
        </div>
        <label title="On site = counted in the daily log's Active Contractor line" style="display:flex;flex-direction:column;align-items:center;gap:2px;font-family:var(--mono);font-size:9px;color:var(--muted);cursor:pointer"><input type="checkbox" ${c.onSite!==false?'checked':''} onchange="ctrToggleOnSite(${i},this.checked)">on site</label>
        <button onclick="ctrEdit(${i})" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:5px 8px;cursor:pointer">✏️</button>
        <button onclick="ctrDelete(${i})" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:5px 8px;cursor:pointer">🗑</button>
      </div>
    </div>`;
  }).join('')||(_ctrCloudChecked[_ctrPid()]
    ?'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:6px 0">No contractors yet — add the EPC and each sub with what they do (e.g. "Supreme — clearing, grading, civil").</div>'
    :'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:6px 0">Loading the contractor list…</div>');
  box.innerHTML=rows;
  const st=document.getElementById('ctr-active-line');
  if(st) st.textContent=ctrActiveNames()?('Daily log Active Contractor → '+ctrActiveNames()):'No one marked on site — the Active Contractor line stays blank.';
}
// Settings-card open: load, seed from the legacy string if the list is empty (a
// one-time migration — done here, not at boot, so a non-lead member never trips
// the lead-only write on app start), render.
async function ctrBootCard(){
  await ctrEnsureCfg();
  if(ctrSeedFromConfig()) await ctrSaveList(ctrGetList(),null,{sync:false});
  ctrRenderCard();
}
async function ctrToggleOnSite(i,on){
  const list=ctrGetList().slice(); if(!list[i]) return;
  list[i]={...list[i],onSite:!!on};
  await ctrSaveList(list); ctrRenderCard();
}
async function ctrDelete(i){
  const list=ctrGetList().slice(); if(!list[i]) return;
  const c=list[i];
  const go=()=>{ list.splice(i,1); ctrSaveList(list).then(ctrRenderCard); };
  if(typeof _confirmModal==='function') _confirmModal(`Remove <b>${_ctrEsc(c.name)}</b> from this project's contractor list? Past daily logs and drawings keep the name they already have.`,go,'Remove contractor','Remove');
  else go();
}

// Add / edit modal — name, tier, description, on-site, and a contacts repeater.
function ctrEdit(i){
  const list=ctrGetList();
  const c=(i!=null&&list[i])?JSON.parse(JSON.stringify(list[i])):{id:_ctrId(),name:'',tier:'sub',desc:'',onSite:true,contacts:[]};
  if(!c.contacts.length) c.contacts.push({name:'',title:'',phone:''});
  const IN='width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 10px;outline:none';
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  const contactRows=()=>c.contacts.map((k,j)=>`<div style="display:grid;grid-template-columns:1.2fr 1fr 1fr 28px;gap:6px;margin-bottom:6px">
      <input type="text" placeholder="Name" value="${_ctrEsc(k.name)}" oninput="window._ctrDraft.contacts[${j}].name=this.value" style="${IN}">
      <input type="text" placeholder="Title / role" value="${_ctrEsc(k.title)}" oninput="window._ctrDraft.contacts[${j}].title=this.value" style="${IN}">
      <input type="tel" placeholder="Phone" value="${_ctrEsc(k.phone)}" oninput="window._ctrDraft.contacts[${j}].phone=this.value" style="${IN}">
      <button onclick="window._ctrDraft.contacts.splice(${j},1);window._ctrDrawContacts()" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer;padding:0">✕</button>
    </div>`).join('');
  ov.innerHTML=`<div class="modal-box" style="max-width:480px;width:94%">
    <h3 style="margin:0 0 10px">${i!=null?'Edit contractor':'Add contractor'}</h3>
    <div style="display:grid;grid-template-columns:1fr 150px;gap:8px;margin-bottom:8px">
      <input type="text" id="_ctr-name" placeholder="Company / contractor" value="${_ctrEsc(c.name)}" style="${IN}">
      <select id="_ctr-tier" style="${IN}">${Object.keys(CTR_TIERS).map(t=>`<option value="${t}"${c.tier===t?' selected':''}>${CTR_TIERS[t]}</option>`).join('')}</select>
    </div>
    <textarea id="_ctr-desc" class="auto-expand" placeholder="What they do here — e.g. EPC; clearing, grading, civil; seeding & E&SC" style="${IN};min-height:54px;resize:vertical;margin-bottom:8px">${_ctrEsc(c.desc)}</textarea>
    <label style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:12px;cursor:pointer"><input type="checkbox" id="_ctr-onsite" ${c.onSite!==false?'checked':''}> Currently on site (joins the daily log's Active Contractor line)</label>
    <div style="font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Contacts <span style="text-transform:none;letter-spacing:0">· each one becomes its own pick in the crew-block selector</span></div>
    <div id="_ctr-contacts">${contactRows()}</div>
    <button onclick="window._ctrDraft.contacts.push({name:'',title:'',phone:''});window._ctrDrawContacts()" class="btn btn-outline" style="font-size:11px;margin-bottom:14px">＋ Contact</button>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn" id="_ctr-save">Save</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  window._ctrDraft=c;
  window._ctrDrawContacts=()=>{ const b=ov.querySelector('#_ctr-contacts'); if(b) b.innerHTML=contactRows(); };
  ov.querySelector('#_ctr-name').focus();
  ov.querySelector('#_ctr-save').onclick=async()=>{
    const name=ov.querySelector('#_ctr-name').value.trim();
    if(!name){ ov.querySelector('#_ctr-name').focus(); return; }
    const rec={id:c.id,name,tier:ov.querySelector('#_ctr-tier').value,desc:ov.querySelector('#_ctr-desc').value.trim(),onSite:ov.querySelector('#_ctr-onsite').checked,
      contacts:c.contacts.map(k=>({name:String(k.name||'').trim(),title:String(k.title||'').trim(),phone:String(k.phone||'').trim()})).filter(k=>k.name)};
    const next=ctrGetList().slice();
    if(i!=null&&next[i]) next[i]=rec; else next.push(rec);
    ov.remove();
    await ctrSaveList(next); ctrRenderCard();
  };
}

// Boot: load the list for the active project so the datalist is ready before the
// first crew block or map entry opens. Re-runs on project switch via applyProjectConfig.
(function(){
  let _lastPid=null;
  const kick=()=>{
    const pid=_ctrPid();
    // Re-run on a project switch, or whenever the cloud still hasn't been
    // consulted and Firebase is now ready (boot runs before _fbReady flips).
    const need=(pid!==_lastPid)||(!_ctrCloudChecked[pid]&&window._fbReady&&!_ctrLoading[pid]);
    if(!need) return;
    _lastPid=pid;
    ctrEnsureCfg().then(()=>{ ctrRenderDatalist(); ctrRenderCard(); }).catch(e=>console.warn('contractors boot:',e.message));
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',kick); else setTimeout(kick,0);
  // Project switches call applyProjectConfig module-internally (not via window), so
  // the DOM observer below doubles as the switch detector: any re-render re-checks
  // the active pid (cheap — a cached pid returns immediately).
  new MutationObserver(()=>{
    try{ kick(); }catch(_){}
    const dl=document.getElementById('gl-ctr-list');
    if(dl&&dl.children.length) document.querySelectorAll('input[id^="crew-"][id$="-name"]:not([list])').forEach(i=>i.setAttribute('list','gl-ctr-list'));
  }).observe(document.body,{childList:true,subtree:true});
})();

window.CTR_TIERS=CTR_TIERS;
window.ctrGetList=ctrGetList;
window.ctrEnsureCfg=ctrEnsureCfg;
window.ctrActiveNames=ctrActiveNames;
window.ctrRenderDatalist=ctrRenderDatalist;
window.ctrRenderCard=ctrRenderCard;
window.ctrBootCard=ctrBootCard;
window.ctrToggleOnSite=ctrToggleOnSite;
window.ctrDelete=ctrDelete;
window.ctrEdit=ctrEdit;
export { ctrGetList, ctrEnsureCfg, ctrActiveNames };
