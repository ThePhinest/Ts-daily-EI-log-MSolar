// ── ⟲ Daily log — carry forward from the previous log ─────────────────────────
// Tim 8/21: "each field from the daily log that you'd enter each day… could
// automatically copy from the previous log, just like a button for each field…
// eliminate a lot of copy pasting." Design locked same day: (a) per-field ⟲
// buttons AND (b) a top-level "From previous log" modal with per-section
// checkboxes. The sections he actually re-carries — Inspection Summary, crew
// blocks, General Communication (e.g. telling Herzog about the sediment-trap
// risers every day until it's done), 24-Hour Look Ahead — are checked by
// default; the rest are offered unchecked. Source = the most recent ARCHIVED log
// for this project dated before the log being edited (Monday pulls Friday).
// Rules: crew blocks replace only when today has none, otherwise the modal asks
// Replace / Add; text fields overwrite after one confirm listing what's replaced.
// Carried text wears a "⟲ from <date>" chip until the field is edited, so a
// stale summary never ships unnoticed.

const DL_CARRY_SECTIONS=[
  {key:'inspSummary', label:'Inspection Summary',               fields:['inspSummary'],            def:true},
  {key:'crew',        label:'Crew Blocks',                      crew:true,                         def:true},
  {key:'genComms',    label:'General Communication to Contractors', fields:['genComms'],           def:true},
  {key:'lookahead',   label:'24-Hour Look Ahead',               fields:['lookahead'],              def:true},
  {key:'agency',      label:'Agency / Landowner / RTE notes',   fields:['agencyInsp','landowner','rte'], def:false},
  {key:'nonComp',     label:'Non-Compliance Note',              fields:['nonCompliance'],          def:false},
];
const DL_CARRY_CREW_FIELDS=['name','time','loc','acts','envcomp','issues','notes'];

function _dcEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function _dcPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _dcCurDate(){ return (document.getElementById('reportDate')?.value)||(typeof localToday==='function'?localToday():new Date().toLocaleDateString('en-CA')); }
function _dcFmt(d){ return (typeof dlFmtDisplay==='function')?dlFmtDisplay(d):d; }
function _dcPreview(s){ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>72?s.slice(0,70)+'…':s; }

// Most recent archived log for this project dated strictly before the log in
// the form. Legacy records without projectId count (pre-multi-project days).
function dlPrevRecord(){
  const all=(typeof dlGetAll==='function')?dlGetAll():{};
  const cur=_dcCurDate(); const pid=_dcPid();
  const dates=Object.keys(all).filter(d=>d<cur).sort().reverse();
  for(const d of dates){
    const r=all[d];
    if(!r||!r.fields) continue;
    if(r.projectId&&r.projectId!==pid) continue;
    return Object.assign({_date:d},r);
  }
  return null;
}
// A device that hasn't opened the Calendar this session may not have the
// archive cached yet — pull once (calLoadCloud only fills missing entries).
async function dlPrevRecordAsync(){
  let r=dlPrevRecord();
  if(!r&&typeof calLoadCloud==='function'){ try{ await calLoadCloud(); }catch(_){} r=dlPrevRecord(); }
  return r;
}

// ── Apply helpers ──
function _dcSetField(id, val, fromDate){
  const el=document.getElementById(id); if(!el) return false;
  el.value=val||'';
  el.dispatchEvent(new Event('input',{bubbles:true}));   // autosave + auto-resize + edited-flag, same as typing
  _dcChip(el, fromDate);
  return true;
}
// "⟲ from Aug 20" chip on the field's label; the delegated input listener
// below strips it the moment the field is edited.
function _dcChip(el, fromDate){
  el.dataset.carried=fromDate||'';
  const field=el.closest('.field');
  const label=field?field.querySelector('label'):null;
  if(!label) return;
  label.querySelectorAll('.dl-carry-chip').forEach(c=>c.remove());
  const chip=document.createElement('span');
  chip.className='dl-carry-chip';
  chip.textContent='⟲ from '+_dcFmt(fromDate);
  label.appendChild(chip);
}
document.addEventListener('input',(e)=>{
  const el=e.target;
  if(!el||!el.dataset||!el.dataset.carried) return;
  if(el._dcApplying) return;
  delete el.dataset.carried;
  const field=el.closest('.field');
  if(field) field.querySelectorAll('.dl-carry-chip').forEach(c=>c.remove());
});
function _dcSet(id,val,fromDate){
  const el=document.getElementById(id); if(!el) return;
  el._dcApplying=true;
  try{ _dcSetField(id,val,fromDate); } finally{ delete el._dcApplying; }
}

function _dcApplyCrew(prev, mode){
  const blocks=(prev.crew||[]).filter(b=>b&&DL_CARRY_CREW_FIELDS.some(f=>String(b[f]||'').trim()));
  if(!blocks.length) return 0;
  if(mode==='replace'){
    const c=document.getElementById('crewContainer'); if(c) c.innerHTML='';
    window.crewIds=[]; window.crewSeq=0;
  }
  blocks.forEach(b=>{
    if(typeof addCrew!=='function') return;
    addCrew();
    const id=window.crewSeq;
    DL_CARRY_CREW_FIELDS.forEach(f=>{
      const el=document.getElementById(`crew-${id}-${f}`);
      if(el){ el.value=b[f]||''; if(el.tagName==='TEXTAREA'&&typeof autoResize==='function') autoResize(el); }
    });
    const nameEl=document.getElementById(`crew-${id}-name`);
    if(nameEl) _dcChip(nameEl, prev._date);
  });
  if(typeof updateCrewBadge==='function') updateCrewBadge();
  const c=document.getElementById('crewContainer');
  if(c) c.dispatchEvent(new Event('input',{bubbles:true}));   // one autosave for the batch
  return blocks.length;
}

// ── (a) Per-field ⟲ ──
async function dlCarryField(id){
  const prev=await dlPrevRecordAsync();
  if(!prev){ _dcToast('No earlier log for this project to copy from.'); return; }
  const val=String((prev.fields||{})[id]||'');
  if(!val.trim()){ _dcToast('That field was empty in the previous log ('+_dcFmt(prev._date)+').'); return; }
  const el=document.getElementById(id); if(!el) return;
  const go=()=>{ _dcSet(id,val,prev._date); _dcToast('Copied from '+_dcFmt(prev._date)+'.'); };
  if(el.value.trim()&&el.value.trim()!==val.trim()&&typeof _confirmModal==='function'){
    _confirmModal('Replace what’s in this field with the text from '+_dcFmt(prev._date)+'?', go, '⟲ From previous log', 'Replace');
  } else go();
}

// ── (b) Section modal ──
async function dlCarryModal(opts){
  opts=opts||{};
  const prev=await dlPrevRecordAsync();
  if(!prev){ _dcToast('No earlier log for this project to copy from.'); return; }
  const pf=prev.fields||{};
  const prevCrew=(prev.crew||[]).filter(b=>b&&DL_CARRY_CREW_FIELDS.some(f=>String(b[f]||'').trim()));
  const todayCrew=(window.crewIds||[]).length;
  const only=opts.only||null;   // e.g. 'crew' from the crew-section button
  const rows=DL_CARRY_SECTIONS.map(s=>{
    const has=s.crew?prevCrew.length>0:s.fields.some(f=>String(pf[f]||'').trim());
    const checked=only?(s.key===only):(s.def&&has);
    const preview=s.crew
      ?(prevCrew.length?prevCrew.map(b=>b.name||'(unnamed)').join(' · '):'')
      :_dcPreview(s.fields.map(f=>pf[f]||'').filter(Boolean).join(' / '));
    const todayHas=s.crew?todayCrew>0:s.fields.some(f=>String(document.getElementById(f)?.value||'').trim());
    const crewMode=(s.crew&&todayCrew>0&&prevCrew.length)?`<div class="dl-carry-mode"><label><input type="radio" name="dc-crew-mode" value="replace" checked> Replace today’s ${todayCrew} block${todayCrew===1?'':'s'}</label><label><input type="radio" name="dc-crew-mode" value="add"> Add after them</label></div>`:'';
    return `<div class="dl-carry-row${has?'':' off'}">
      <input type="checkbox" data-key="${s.key}" ${checked?'checked':''} ${has?'':'disabled'}>
      <span class="dl-carry-main"><span class="dl-carry-lbl">${_dcEsc(s.label)}${(!s.crew&&todayHas&&has)?' <em>replaces today’s text</em>':''}</span>
      <span class="dl-carry-prev">${has?_dcEsc(preview):'— empty in the previous log —'}</span>${crewMode}</span>
    </div>`;
  }).join('');
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.innerHTML=`<div class="modal-box" style="max-width:440px;width:94%;max-height:84vh;display:flex;flex-direction:column">
    <div class="modal-title" style="margin-bottom:2px">⟲ From previous log</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px">Copying from <b style="color:var(--amber)">${_dcEsc(_dcFmt(prev._date))}</b> into ${_dcEsc(_dcFmt(_dcCurDate()))}. Edit anything after — carried text is marked until you touch it.</div>
    <div style="overflow-y:auto;flex:1;min-height:0">${rows}</div>
    <div class="modal-btns" style="margin-top:12px">
      <button type="button" class="modal-cancel">Cancel</button>
      <button type="button" class="btn btn-amber" id="dc-apply" style="padding:8px 18px">⟲ Copy selected</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('.modal-cancel').onclick=()=>ov.remove();
  // Whole row toggles its checkbox (the crew Replace/Add radios handle themselves).
  ov.querySelectorAll('.dl-carry-row').forEach(r=>{ r.onclick=(e)=>{
    if(e.target.closest('input,label')) return;
    const cb=r.querySelector('input[type=checkbox]'); if(cb&&!cb.disabled) cb.checked=!cb.checked;
  }; });
  ov.querySelector('#dc-apply').onclick=()=>{
    const picked=[...ov.querySelectorAll('input[type=checkbox][data-key]:checked')].map(c=>c.getAttribute('data-key'));
    if(!picked.length){ ov.remove(); _dcToast('Nothing selected to copy.'); return; }
    const crewMode=(ov.querySelector('input[name=dc-crew-mode]:checked')?.value)||'replace';
    ov.remove();
    const replacing=DL_CARRY_SECTIONS.filter(s=>picked.includes(s.key)&&!s.crew&&s.fields.some(f=>{
      const cur=String(document.getElementById(f)?.value||'').trim(); return cur&&cur!==String(pf[f]||'').trim();
    })).map(s=>s.label);
    const apply=()=>{
      let n=0;
      DL_CARRY_SECTIONS.forEach(s=>{
        if(!picked.includes(s.key)) return;
        if(s.crew){ n+=_dcApplyCrew(prev,crewMode)?1:0; return; }
        s.fields.forEach(f=>{ if(String(pf[f]||'').trim()) _dcSet(f,pf[f],prev._date); });
        n++;
      });
      _dcToast('Copied '+n+' section'+(n===1?'':'s')+' from '+_dcFmt(prev._date)+'.');
      if(typeof glHaptic==='function') try{ glHaptic(); }catch(_){}
    };
    if(replacing.length&&typeof _confirmModal==='function'){
      _confirmModal('Replace today’s text in: '+replacing.join(', ')+'?', apply, '⟲ From previous log', 'Replace');
    } else apply();
  };
}

// Small inline status (the cloud banner renders under modal overlays; this is
// its own short-lived pill at the top of the page).
function _dcToast(msg){
  let el=document.getElementById('dl-carry-toast');
  if(!el){ el=document.createElement('div'); el.id='dl-carry-toast'; document.body.appendChild(el); }
  el.textContent=msg; el.classList.add('on');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('on'),2600);
}
// Button markup for a field label.
function dlCarryBtn(id){
  return `<button type="button" class="dl-carry-btn" onclick="event.stopPropagation();dlCarryField('${id}')" title="Copy this field from the previous log">⟲ prev</button>`;
}

window.dlPrevRecord=dlPrevRecord;
window.dlCarryField=dlCarryField;
window.dlCarryModal=dlCarryModal;
window.dlCarryBtn=dlCarryBtn;
export { dlPrevRecord, dlCarryField, dlCarryModal };
