// ── ⚖ Jurisdiction profile (per project) ─────────────────────────────────────
// Launch audit A1-A3 (9/17): the spill reportability test, the agency dropdown
// and the QI permit label were New York law baked into app code, shown to every
// account. They now come from ONE per-project config doc, projects/{pid}/config/
// jurisdiction, lead-write, IDB-cached, loaded with the contractors.js pattern
// (await idbReady → local → cloud-checked → newest updatedAtMs wins → never seed
// early). A project with no doc gets the NEUTRAL preset: federal facts only
// (National Response Center), no state-specific exemption test, generic agency
// list. A lead picks "New York" in Settings → ⚖ Jurisdiction and saves — that one
// config write is how a NY job gets its profile (feedback_no_project_specific_
// hardcoding: never a project-name branch in code). Fields stay editable after a
// preset is applied so a state we have no preset for can still be typed in.
//
// Profile: {preset, state, spillHotlineName, spillHotlinePhone, spillNote,
//           exemptCriteria:[[key,label],...]|[], exemptHeading, agencies:[...],
//           defaultAgency, permitProgram, permitLabel, updatedAtMs}

const JUR_PRESETS = {
  neutral: {
    preset:'neutral', state:'',
    spillHotlineName:'National Response Center', spillHotlinePhone:'1-800-424-8802',
    spillNote:'Reporting thresholds and deadlines vary by state and permit. Check your permit and your state spill hotline; the National Response Center takes federal reports 24/7.',
    exemptHeading:'', exemptCriteria:[],
    agencies:['State environmental agency','State utility / siting agency','EPA','USACE','Local municipality','Other'],
    defaultAgency:'',
    permitProgram:'Stormwater', permitLabel:'Construction stormwater general permit'
  },
  ny: {
    preset:'ny', state:'NY',
    spillHotlineName:'NYSDEC', spillHotlinePhone:'1-800-457-7362',
    spillNote:'State spill hotline within 2 hours of discovery; the EM/CM makes the call, the EI documents and verifies it happened.',
    exemptHeading:'NY PETROLEUM-SPILL EXEMPTION TEST (6 NYCRR 613) — exempt from state reporting ONLY if all four are true',
    exemptCriteria:[
      ['exUnder5',   'Known to be less than 5 gallons'],
      ['exContained','Contained and under the control of the spiller'],
      ['exNoContact','Has not and will not reach the State\'s waters or any land (bare soil counts as land)'],
      ['exWithin2h', 'Cleaned up within 2 hours of discovery']
    ],
    agencies:['NYSDPS','NYSDEC','ORES','EPA','USACE','Other'],
    defaultAgency:'NYSDPS',
    permitProgram:'SPDES', permitLabel:'SPDES GP-0-25-001'
  }
};
const JUR_PRESET_NAMES = { neutral:'Neutral (federal only)', ny:'New York' };

var _jurCfg = {};           // pid → profile | null
var _jurLoading = {};
var _jurCloudChecked = {};
function _jurPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _jurEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function _jurClone(p){ return JSON.parse(JSON.stringify(p)); }

// Sync read: the stored profile merged over NEUTRAL (so a doc saved by an older
// build never leaves a field undefined). Before the load resolves this is NEUTRAL.
function jurGet(pid){
  pid = pid || _jurPid();
  const stored = _jurCfg[pid];
  if(!stored) return _jurClone(JUR_PRESETS.neutral);
  const merged = Object.assign(_jurClone(JUR_PRESETS.neutral), stored);
  // Firestore rejects nested arrays, so the doc stores criteria as {k,l} objects;
  // in memory they are [key,label] pairs (what the spill form iterates).
  merged.exemptCriteria = Array.isArray(merged.exemptCriteria) ? merged.exemptCriteria.map(c=>Array.isArray(c)?c:[c.k,c.l]).filter(c=>c[0]&&c[1]) : [];
  if(!Array.isArray(merged.agencies) || !merged.agencies.length) merged.agencies = JUR_PRESETS.neutral.agencies.slice();
  return merged;
}
function jurSpill(pid){ const j=jurGet(pid); return { hotlineName:j.spillHotlineName, hotlinePhone:j.spillHotlinePhone, note:j.spillNote, criteria:j.exemptCriteria, heading:j.exemptHeading }; }
function jurAgencies(pid){ return jurGet(pid).agencies.slice(); }
function jurDefaultAgency(pid){ const j=jurGet(pid); return j.defaultAgency || ''; }
function jurPermitLabel(pid){ return jurGet(pid).permitLabel; }
function jurPermitProgram(pid){ return jurGet(pid).permitProgram; }

async function jurEnsure(pid){
  pid = pid || _jurPid();
  if(_jurCfg[pid]!==undefined && _jurCloudChecked[pid]) return jurGet(pid);
  if(_jurLoading[pid]) return _jurLoading[pid];
  _jurLoading[pid] = (async()=>{
    try{ if(window.idbReady) await window.idbReady; }catch(_){}
    let local=null;
    try{ local = idbGet('jur_cfg::'+pid) || null; }catch(_){}
    if(_jurCfg[pid]===undefined || (_jurCfg[pid]===null && local)) _jurCfg[pid]=local;
    if(typeof db!=='undefined' && db && typeof _fbReady!=='undefined' && _fbReady && pid!=='default'){
      try{
        const snap = await db.collection('projects').doc(pid).collection('config').doc('jurisdiction').get();
        if(snap.exists){
          const cloud = snap.data();
          const cur = _jurCfg[pid];
          if(!cur || ((cloud.updatedAtMs||0) >= (cur.updatedAtMs||0))){ _jurCfg[pid]=cloud; idbSet('jur_cfg::'+pid, cloud); }
        }
        _jurCloudChecked[pid]=true;
      }catch(e){ console.warn('jurisdiction load failed:', e.message); }
    }
    delete _jurLoading[pid];
    return jurGet(pid);
  })();
  return _jurLoading[pid];
}

async function jurSave(profile, pid){
  pid = pid || _jurPid();
  const cfg = Object.assign({}, profile, { updatedAtMs: Date.now() });
  cfg.exemptCriteria = (cfg.exemptCriteria||[]).map(c=>Array.isArray(c)?{k:c[0],l:c[1]}:c);
  _jurCfg[pid] = cfg;
  idbSet('jur_cfg::'+pid, cfg);
  try{
    if(typeof db!=='undefined' && db && _fbReady && pid!=='default')
      await db.collection('projects').doc(pid).collection('config').doc('jurisdiction').set(cfg);
  }catch(e){
    console.warn('jurisdiction cloud save failed (kept locally):', e.message);
    if(typeof showCloudBanner==='function' && /permission/i.test(e.message||''))
      showCloudBanner('Only a project lead can change the jurisdiction — kept on this device only.');
  }
}

// ── Settings card ──
function _jurField(id, label, val, opts){
  opts=opts||{};
  const inner = opts.rows
    ? `<textarea rows="${opts.rows}" class="auto-expand" id="jur-${id}" style="width:100%;box-sizing:border-box">${_jurEsc(val)}</textarea>`
    : `<input type="text" id="jur-${id}" value="${_jurEsc(val)}" placeholder="${_jurEsc(opts.ph||'')}" style="width:100%;box-sizing:border-box">`;
  return `<div class="field${opts.span2?' span2':''}"><label>${label}${opts.hint?` <span style="text-transform:none;letter-spacing:0">${opts.hint}</span>`:''}</label>${inner}</div>`;
}
function jurRenderCard(){
  const box=document.getElementById('jur-card-body');
  if(!box) return;
  const pid=_jurPid();
  const j=jurGet(pid);
  const loaded=!!_jurCloudChecked[pid] || pid==='default';
  const presetOpts=Object.keys(JUR_PRESET_NAMES).map(k=>`<option value="${k}"${j.preset===k?' selected':''}>${JUR_PRESET_NAMES[k]}</option>`).join('')
    + (JUR_PRESET_NAMES[j.preset]?'':`<option value="${_jurEsc(j.preset||'custom')}" selected>Custom</option>`);
  box.innerHTML=`
    <div class="g g2" style="margin-bottom:10px">
      <div class="field"><label>Preset</label><select id="jur-preset" onchange="jurApplyPreset(this.value)">${presetOpts}</select></div>
      ${_jurField('state','State / province',j.state,{ph:'e.g. NY'})}
      ${_jurField('spillHotlineName','Spill hotline (agency)',j.spillHotlineName)}
      ${_jurField('spillHotlinePhone','Spill hotline phone',j.spillHotlinePhone)}
      ${_jurField('spillNote','Spill reporting note',j.spillNote,{rows:2,span2:true,hint:'(shown on every spill form)'})}
      ${_jurField('exemptHeading','Exemption test heading',j.exemptHeading,{span2:true,hint:'(blank = no state exemption test on the form)'})}
      ${_jurField('exemptCriteria','Exemption criteria',(j.exemptCriteria||[]).map(c=>c[1]).join('\n'),{rows:3,span2:true,hint:'(one per line; ALL must hold for a spill to be exempt)'})}
      ${_jurField('agencies','Agencies',(j.agencies||[]).join(', '),{span2:true,hint:'(comma separated; the agency-visit dropdown)'})}
      ${_jurField('defaultAgency','Default agency',j.defaultAgency,{ph:'blank = user picks'})}
      ${_jurField('permitProgram','Stormwater program',j.permitProgram,{ph:'e.g. SPDES, NPDES'})}
      ${_jurField('permitLabel','Permit label',j.permitLabel,{span2:true,hint:'(QI inspection section header)'})}
    </div>
    <button class="btn btn-amber" style="font-size:11px;padding:7px 14px" onclick="jurSaveFromCard()">Save &amp; Apply</button>
    <span id="jur-status" style="font-family:var(--mono);font-size:11px;color:var(--green);margin-left:12px;opacity:0;transition:opacity .4s">${loaded?'':'Loading…'}</span>`;
}
function jurApplyPreset(key){
  const p=JUR_PRESETS[key]; if(!p) return;
  const pid=_jurPid();
  _jurCfg[pid]=Object.assign(_jurClone(p),{updatedAtMs:(_jurCfg[pid]||{}).updatedAtMs||0});
  jurRenderCard();
}
// Reads the card back into a profile. Criteria keys are stable per line index
// (ex1..exN) unless the label matches a preset criterion, whose key is kept so
// existing spill records keep lining up.
function _jurReadCard(){
  const v=id=>{ const el=document.getElementById('jur-'+id); return el?el.value.trim():''; };
  const known={}; Object.values(JUR_PRESETS).forEach(p=>p.exemptCriteria.forEach(([k,l])=>{ known[l]=k; }));
  const criteria=v('exemptCriteria').split('\n').map(s=>s.trim()).filter(Boolean).map((l,i)=>[known[l]||('ex'+(i+1)),l]);
  const agencies=v('agencies').split(',').map(s=>s.trim()).filter(Boolean);
  const presetEl=document.getElementById('jur-preset');
  const preset=presetEl?presetEl.value:'custom';
  const base=JUR_PRESETS[preset];
  const out={ preset, state:v('state'), spillHotlineName:v('spillHotlineName'), spillHotlinePhone:v('spillHotlinePhone'),
    spillNote:v('spillNote'), exemptHeading:v('exemptHeading'), exemptCriteria:criteria,
    agencies:agencies.length?agencies:JUR_PRESETS.neutral.agencies.slice(), defaultAgency:v('defaultAgency'),
    permitProgram:v('permitProgram')||'Stormwater', permitLabel:v('permitLabel') };
  // Edited away from the preset → label it custom so the picker is honest.
  if(base && JSON.stringify(Object.assign({},base,{preset:undefined}))!==JSON.stringify(Object.assign({},out,{preset:undefined}))) out.preset='custom';
  return out;
}
async function jurSaveFromCard(){
  const profile=_jurReadCard();
  await jurSave(profile);
  jurRenderCard();
  const st=document.getElementById('jur-status');
  if(st){ st.textContent='✓ Saved'; st.style.opacity='1'; setTimeout(()=>{ st.style.opacity='0'; },1800); }
}
async function jurBootCard(){ await jurEnsure(); jurRenderCard(); }

// Boot + project-switch loader (same shape as contractors.js).
(function(){
  let _lastPid=null, _lastTry=0;
  const kick=()=>{
    const pid=_jurPid();
    const retry=!_jurCloudChecked[pid]&&window._fbReady&&!_jurLoading[pid]&&(Date.now()-_lastTry>5000);
    if(pid===_lastPid&&!retry) return;
    _lastPid=pid; _lastTry=Date.now();
    jurEnsure().then(()=>{ jurRenderCard(); }).catch(e=>console.warn('jurisdiction boot:',e.message));
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',kick); else setTimeout(kick,0);
  new MutationObserver(()=>{ try{ kick(); }catch(_){} }).observe(document.body,{childList:true,subtree:true});
})();

window.jurGet=jurGet;
window.jurSpill=jurSpill;
window.jurAgencies=jurAgencies;
window.jurDefaultAgency=jurDefaultAgency;
window.jurPermitLabel=jurPermitLabel;
window.jurPermitProgram=jurPermitProgram;
window.jurEnsure=jurEnsure;
window.jurRenderCard=jurRenderCard;
window.jurBootCard=jurBootCard;
window.jurApplyPreset=jurApplyPreset;
window.jurSaveFromCard=jurSaveFromCard;
window.JUR_PRESETS=JUR_PRESETS;
export { jurGet, jurSpill, jurAgencies, jurDefaultAgency, jurPermitLabel, jurPermitProgram, jurEnsure, jurSave };
