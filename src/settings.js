// ═══════════════════════════════════════════
// CARD LABELS
// ═══════════════════════════════════════════
const CARD_REGISTRY = [
  { id:'sec-01',  titleId:'ctitle-01',    cfgSubId:null,       inputId:'cfg-ct-01',    def:'Project & Report Info' },
  { id:'sec-ts',  titleId:'ctitle-ts',    cfgSubId:null,       inputId:'cfg-ct-ts',    def:'Daily Timesheet Entry' },
  { id:'sec-02',  titleId:'ctitle-02',    cfgSubId:null,       inputId:'cfg-ct-02',    def:'Weather Conditions' },
  { id:'sec-03',  titleId:'ctitle-03',    cfgSubId:'csub-03',  inputId:'cfg-ct-03',    def:'Inspection Summary' },
  { id:'sec-04',  titleId:'ctitle-04',    cfgSubId:null,       inputId:'cfg-ct-04',    def:'Contractor Crew Observations' },
  { id:'sec-05',  titleId:'ctitle-05',    cfgSubId:null,       inputId:'cfg-ct-05',    def:'Compliance Checklist' },
  { id:'sec-06',  titleId:'ctitle-06',    cfgSubId:null,       inputId:'cfg-ct-06',    def:'Regulatory & Incident Flags' },
  { id:'sec-07',  titleId:'ctitle-07',    cfgSubId:'csub-07',  inputId:'cfg-ct-07',    def:'General Communication to Contractors' },
  { id:'sec-08',  titleId:'ctitle-08',    cfgSubId:'csub-08',  inputId:'cfg-ct-08',    def:'24-Hour Look Ahead' },
  { id:'sec-notes',titleId:'ctitle-notes',cfgSubId:null,       inputId:'cfg-ct-notes', def:'Personal Notes' },
];

let _cardTitles = {};

function loadCardTitles(data){
  CARD_REGISTRY.forEach(c=>{
    const val = (data && data[c.id]) ? data[c.id] : c.def;
    _cardTitles[c.id] = val;
    // Update daily log card header
    const titleEl = document.getElementById(c.titleId);
    if(titleEl) titleEl.textContent = val;
    // Update linked settings config-sub span
    if(c.cfgSubId){ const subEl = document.getElementById(c.cfgSubId); if(subEl) subEl.textContent = val; }
    // Update settings input field
    const inputEl = document.getElementById(c.inputId);
    if(inputEl) inputEl.value = val;
  });
}

function saveCardLabels(){
  const data = {};
  CARD_REGISTRY.forEach(c=>{
    const el = document.getElementById(c.inputId);
    data[c.id] = el ? el.value.trim() || c.def : c.def;
  });
  try{ localStorage.setItem('gl_cardTitles', JSON.stringify(data)); }catch{}
  if(db && _fbReady){
    try{ _udb().collection('settings').doc('cardTitles').set(data).catch(()=>{}); }catch{}
  }
  loadCardTitles(data);
}

async function initCardTitles(){
  // Try Firestore first
  if(db && _fbReady){
    try{
      const doc = await _udb().collection('settings').doc('cardTitles').get();
      if(doc.exists){ loadCardTitles(doc.data()); return; }
    }catch(e){ console.warn('initCardTitles Firestore failed:',e.message); }
  }
  // Fall back to localStorage
  try{
    const raw = localStorage.getItem('gl_cardTitles');
    if(raw){ loadCardTitles(JSON.parse(raw)); return; }
  }catch{}
  // Fall back to defaults
  loadCardTitles({});
}

// ═══════════════════════════════════════════
// DEFAULT CHECKLIST + FLAG ITEMS
// ═══════════════════════════════════════════
const DEFAULT_CHECKLIST_ITEMS=[
  {id:'c1', text:'Morning safety meeting / tailgate conducted prior to work start'},
  {id:'c2', text:'All active work areas within approved Limits of Disturbance (LOD)'},
  {id:'c3', text:'Equipment fueling and storage >100 ft from water resources — secondary containment in place'},
  {id:'c4', text:'No turbid discharge or sediment-laden runoff observed at site perimeter or water resources'},
  {id:'c5', text:'No unanticipated cultural, archaeological, or hazardous material discoveries'},
  {id:'c6', text:'No RTE / State-listed species or habitat disturbance observed during operations'},
  {id:'c7', text:'Erosion and sediment controls maintained and functional'},
];
const DEFAULT_FLAG_ITEMS=[
  {id:'flag-stormwater',text:'Turbid discharge observed — potential stormwater permit exceedance'},
  {id:'flag-storm',     text:'Precipitation event >0.5 in. — post-storm inspection required'},
  {id:'flag-buffer',    text:'Sensitive area buffer encroachment observed'},
  {id:'flag-discovery', text:'Unanticipated cultural, archaeological, or hazardous material discovery'},
  {id:'flag-spill',     text:'Fuel or hydraulic fluid spill observed'},
  {id:'flag-nci',       text:'Non-compliance notice issued (NCI)'},
  {id:'flag-stop',      text:'Stop-work condition observed'},
];

// ═══════════════════════════════════════════
// CHECKLIST + FLAGS CONFIG
// ═══════════════════════════════════════════
function loadChecklistConfig(){
  try{const raw=localStorage.getItem('msf_checklist_config');if(raw){const d=JSON.parse(raw);window.checklistItems=d.items||DEFAULT_CHECKLIST_ITEMS;window.checklistTitle=d.title||'Compliance Checklist';}}catch{}
}
function saveChecklistLocal(){
  try{localStorage.setItem('msf_checklist_config',JSON.stringify({title:checklistTitle,items:checklistItems}));}catch{}
}
async function saveChecklistCloud(){
  _saveProjectSettings({checklistItems, checklistTitle});
}
async function loadChecklistCloud(){
  if(!db)return;
  function _restoreChecklistAutosave(){try{const s=JSON.parse(localStorage.getItem('msf_autosave')||'{}');Object.entries(s.checklist||{}).forEach(([id,{checked,note}])=>{const cb=document.getElementById(id);if(cb){cb.checked=checked;if(checked){const nw=document.getElementById(id+'-nw');if(nw)nw.classList.add('vis')}}const nt=document.getElementById(id+'-note');if(nt)nt.value=note;});}catch{}}
  try{
    const pid=_activeProjectId();
    if(pid&&pid!=='active'&&pid!=='default'){
      const projDoc=await _udb().collection('settings').doc(pid).get();
      if(projDoc.exists&&projDoc.data().checklistItems){
        const d=projDoc.data();window.checklistItems=d.checklistItems;window.checklistTitle=d.checklistTitle||'Compliance Checklist';
        saveChecklistLocal();buildChecklist();renderChecklistList();_restoreChecklistAutosave();return;
      }
    }
    // Fallback: global path (pre-Phase C migration)
    const doc=await _udb().collection('config').doc('checklist').get();
    if(doc.exists){const d=doc.data();window.checklistItems=d.items||DEFAULT_CHECKLIST_ITEMS;window.checklistTitle=d.title||'Compliance Checklist';saveChecklistLocal();buildChecklist();renderChecklistList();_restoreChecklistAutosave();}
  }catch(e){}
}
function loadFlagsConfig(){
  try{const raw=localStorage.getItem('msf_flags_config');if(raw){const d=JSON.parse(raw);window.flagItems=d.items||DEFAULT_FLAG_ITEMS;window.flagsTitle=d.title||'Regulatory & Incident Flags';}}catch{}
}
function saveFlagsLocal(){
  try{localStorage.setItem('msf_flags_config',JSON.stringify({title:flagsTitle,items:flagItems}));}catch{}
}
async function saveFlagsCloud(){
  _saveProjectSettings({flagItems, flagsTitle});
}
async function loadFlagsCloud(){
  if(!db)return;
  function _restoreFlagsAutosave(){try{const s=JSON.parse(localStorage.getItem('msf_autosave')||'{}');Object.entries(s.checkboxes||{}).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.checked=val});Object.entries(s.flagNotes||{}).forEach(([f,val])=>{const el=document.getElementById('flag-'+f+'-note');if(el)el.value=val;});flagItems.forEach(f=>{if(document.getElementById(f.id)?.checked){const nw=document.getElementById(f.id+'-nw');if(nw)nw.classList.add('vis');}});}catch{}}
  try{
    const pid=_activeProjectId();
    if(pid&&pid!=='active'&&pid!=='default'){
      const projDoc=await _udb().collection('settings').doc(pid).get();
      if(projDoc.exists&&projDoc.data().flagItems){
        const d=projDoc.data();window.flagItems=d.flagItems;window.flagsTitle=d.flagsTitle||'Regulatory & Incident Flags';
        saveFlagsLocal();buildFlags();renderFlagsList();_restoreFlagsAutosave();return;
      }
    }
    // Fallback: global path (pre-Phase C migration)
    const doc=await _udb().collection('config').doc('flags').get();
    if(doc.exists){const d=doc.data();window.flagItems=d.items||DEFAULT_FLAG_ITEMS;window.flagsTitle=d.title||'Regulatory & Incident Flags';saveFlagsLocal();buildFlags();renderFlagsList();_restoreFlagsAutosave();}
  }catch(e){}
}
function renderChecklistList(){
  const ul=document.getElementById('list-checklist');if(!ul)return;
  ul.innerHTML='';
  checklistItems.forEach((item,i)=>{
    const li=document.createElement('li');
    li.dataset.idx=i;li.dataset.origIdx=i;li.dataset.key='checklist';
    li.innerHTML=`<span class="drag-handle" title="Drag to reorder">≡</span><span class="p-text">${item.text}</span><button class="del-p" onclick="removeChecklistItem(${i})">✕</button>`;
    ul.appendChild(li);
  });
  const titleEl=document.getElementById('cfg-checklist-title');
  if(titleEl)titleEl.value=checklistTitle;
}
function renderFlagsList(){
  const ul=document.getElementById('list-flags');if(!ul)return;
  ul.innerHTML='';
  flagItems.forEach((item,i)=>{
    const li=document.createElement('li');
    li.dataset.idx=i;li.dataset.origIdx=i;li.dataset.key='flags';
    li.innerHTML=`<span class="drag-handle" title="Drag to reorder">≡</span><span class="p-text">${item.text}</span><button class="del-p" onclick="removeFlagItem(${i})">✕</button>`;
    ul.appendChild(li);
  });
  const titleEl=document.getElementById('cfg-flags-title');
  if(titleEl)titleEl.value=flagsTitle;
}
function addChecklistItem(){
  const t=document.getElementById('new-checklist-text');if(!t||!t.value.trim())return;
  checklistItems.push({id:'c'+Date.now(),text:t.value.trim()});
  t.value='';saveChecklistLocal();saveChecklistCloud();renderChecklistList();buildChecklist();
}
function removeChecklistItem(idx){
  checklistItems.splice(idx,1);saveChecklistLocal();saveChecklistCloud();renderChecklistList();buildChecklist();
}
function addFlagItem(){
  const t=document.getElementById('new-flags-text');if(!t||!t.value.trim())return;
  flagItems.push({id:'flag-'+Date.now(),text:t.value.trim()});
  t.value='';saveFlagsLocal();saveFlagsCloud();renderFlagsList();buildFlags();
}
function removeFlagItem(idx){
  flagItems.splice(idx,1);saveFlagsLocal();saveFlagsCloud();renderFlagsList();buildFlags();
}
async function saveChecklistConfig(){
  window.checklistTitle=document.getElementById('cfg-checklist-title')?.value.trim()||'Compliance Checklist';
  saveChecklistLocal();await saveChecklistCloud();buildChecklist();
  const s=document.getElementById('cfg-checklist-status');
  if(s){s.textContent='Saved!';s.style.opacity='1';setTimeout(()=>s.style.opacity='0',2000);}
}
async function saveFlagsConfig(){
  window.flagsTitle=document.getElementById('cfg-flags-title')?.value.trim()||'Regulatory & Incident Flags';
  saveFlagsLocal();await saveFlagsCloud();buildFlags();
  const s=document.getElementById('cfg-flags-status');
  if(s){s.textContent='Saved!';s.style.opacity='1';setTimeout(()=>s.style.opacity='0',2000);}
}
// ═══════════════════════════════════════════
// AMENDMENT TRACKING CONFIG
// ═══════════════════════════════════════════
const DEFAULT_AMENDMENT_PHASES  = ['N/A','Initial','1st Reseed','2nd Reseed','3rd Reseed','Final'];
const DEFAULT_AMENDMENT_METHODS = ['N/A','Hydro Seeding','Drill Seeding','Broadcast Seeding','Hand Seeding','Lime Application','Fertilizer Application','Mulch Application'];
window._amendmentPhases  = [...DEFAULT_AMENDMENT_PHASES];
window._amendmentMethods = [...DEFAULT_AMENDMENT_METHODS];

function loadAmendmentConfig(){
  try{const raw=localStorage.getItem('gl_amendment_config');if(raw){const d=JSON.parse(raw);window._amendmentPhases=d.phases||[...DEFAULT_AMENDMENT_PHASES];window._amendmentMethods=d.methods||[...DEFAULT_AMENDMENT_METHODS];}}catch{}
}
function saveAmendmentLocal(){
  try{localStorage.setItem('gl_amendment_config',JSON.stringify({phases:window._amendmentPhases,methods:window._amendmentMethods}));}catch{}
}
function saveAmendmentCloud(){
  if(typeof _saveProjectSettings==='function') _saveProjectSettings({amendmentPhases:window._amendmentPhases,amendmentMethods:window._amendmentMethods});
}
function renderAmendmentConfig(){
  ['phases','methods'].forEach(type=>{
    const ul=document.getElementById('list-amendment-'+type);
    if(!ul) return;
    const arr=type==='phases'?window._amendmentPhases:window._amendmentMethods;
    ul.innerHTML='';
    const isReordering=ul.classList.contains('reorder-mode');
    (arr||[]).forEach((item,i)=>{
      const li=document.createElement('li');
      li.dataset.idx=i; li.dataset.origIdx=i;
      li.innerHTML=`<span class="drag-handle" title="Drag to reorder">≡</span><span class="p-text">${item}</span><button class="del-p" onclick="${type==='phases'?'removeAmendmentPhase':'removeAmendmentMethod'}(${i})">✕</button>`;
      if(isReordering) li.classList.add('reorder-mode');
      ul.appendChild(li);
    });
    if(isReordering) _initDrag(ul, type==='phases'?'amendment-phases':'amendment-methods');
  });
}
function addAmendmentPhase(){
  const t=document.getElementById('new-amendment-phase');if(!t||!t.value.trim())return;
  window._amendmentPhases.push(t.value.trim());t.value='';saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();
}
function removeAmendmentPhase(idx){
  window._amendmentPhases.splice(idx,1);saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();
}
function addAmendmentMethod(){
  const t=document.getElementById('new-amendment-method');if(!t||!t.value.trim())return;
  window._amendmentMethods.push(t.value.trim());t.value='';saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();
}
function removeAmendmentMethod(idx){
  window._amendmentMethods.splice(idx,1);saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();
}
async function saveAmendmentConfig(){
  saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();
  const s=document.getElementById('cfg-amendment-status');
  if(s){s.textContent='Saved!';s.style.opacity='1';setTimeout(()=>s.style.opacity='0',2000);}
}

// ── Init checklist + flags on load ──
loadChecklistConfig();
loadFlagsConfig();
loadAmendmentConfig();
buildChecklist();
buildFlags();
// Cloud load deferred — called after Firebase ready (see initFirebaseLoad)
function buildChecklist(){
  const c=document.getElementById('checklistBody');if(!c)return;c.innerHTML='';
  checklistItems.forEach(ch=>{
    const d=document.createElement('div');d.className='check-item';
    d.innerHTML=`<div class="check-row">
      <input type="checkbox" id="${ch.id}" onchange="toggleNote('${ch.id}')">
      <span class="check-text">${ch.text}</span>
    </div>
    <div class="check-note-wrap" id="${ch.id}-nw">
      <textarea class="check-note" id="${ch.id}-note" placeholder="Note or deficiency detail…"></textarea>
    </div>`;
    c.appendChild(d);
  });
  const t=document.getElementById('checklist-card-title');
  if(t)t.textContent=checklistTitle;
}
function buildFlags(){
  const c=document.getElementById('flagsBody');if(!c)return;c.innerHTML='';
  flagItems.forEach(fl=>{
    const d=document.createElement('div');d.className='flag-row';
    d.innerHTML=`<div class="flag-main">
      <input type="checkbox" id="${fl.id}" onchange="toggleFlagNote('${fl.id}')">
      <span class="flag-text">${fl.text}</span>
    </div>
    <div class="flag-note-wrap" id="${fl.id}-nw">
      <textarea class="flag-note" id="${fl.id}-note" placeholder="Description required for report…"></textarea>
    </div>`;
    c.appendChild(d);
  });
  const t=document.getElementById('flags-card-title');
  if(t)t.textContent=flagsTitle;
}
function toggleNote(id){document.getElementById(id+'-nw').classList.toggle('vis',document.getElementById(id).checked)}
function toggleFlagNote(id){
  const fullId=id.startsWith('flag-')?id:'flag-'+id;
  document.getElementById(fullId+'-nw').classList.toggle('vis',document.getElementById(fullId).checked);
}

// ═══════════════════════════════════════════
// CREW BLOCKS
// ═══════════════════════════════════════════
function addCrew(){
  window.crewSeq++;const id=window.crewSeq;crewIds.push(id);updateCrewBadge();
  const d=document.createElement('div');d.className='crew-block';d.id=`crew-${id}`;
  d.innerHTML=`
    <div class="crew-block-head">
      <span class="crew-lbl">Crew Block ${crewIds.length}</span>
      <button class="btn btn-ghost" onclick="removeCrew(${id})">✕ Remove</button>
    </div>
    <div class="crew-body">
      <div class="g g3" style="margin-bottom:11px">
        <div class="field span2"><label>Contractor / Foreman Name</label><input type="text" id="crew-${id}-name" placeholder="Full name"></div>
        <div class="field"><label>Hours on Site</label><input type="text" id="crew-${id}-time" placeholder="e.g. 6:30 AM – 4:30 PM"></div>
        <div class="field full"><label>Work Location / Area</label><input type="text" id="crew-${id}-loc" placeholder="e.g. Station 00+00, laydown yard, etc."></div>
      </div>
      <div class="field" style="margin-bottom:10px">
        <label>Activities Observed</label>
        <div class="preset-strip" id="chips-crew-${id}-acts"></div>
        <textarea class="short auto-expand" id="crew-${id}-acts" placeholder="Describe contractor activities observed…"></textarea>
      </div>
      <div class="field" style="margin-bottom:10px">
        <label>Env. Compliance Observations</label>
        <div class="preset-strip" id="chips-crew-${id}-envcomp"></div>
        <textarea class="short auto-expand" id="crew-${id}-envcomp" placeholder="Note compliance or any deficiency observed for this crew…"></textarea>
      </div>
      <div class="g g2">
        <div class="field"><label>Issues / Non-Compliance (Level 1–4 if known)</label><textarea class="short auto-expand" id="crew-${id}-issues" placeholder="e.g. Level 2 — material observed beyond approved boundary…"></textarea></div>
        <div class="field"><label>Additional Notes</label><textarea class="short auto-expand" id="crew-${id}-notes" placeholder="Any other notes for this crew member or area…"></textarea></div>
      </div>
    </div>`;
  document.getElementById('crewContainer').appendChild(d);
  renderChips(`crew-${id}-acts`,'act');
  renderChips(`crew-${id}-envcomp`,'env');
  debouncedAutoSave();
}
function removeCrew(id){
  const el=document.getElementById(`crew-${id}`);if(el)el.remove();
  window.crewIds=window.crewIds.filter(x=>x!==id);updateCrewBadge();renumberCrew();
  debouncedAutoSave();
}
function updateCrewBadge(){document.getElementById('crewBadge').textContent=`${crewIds.length} block${crewIds.length!==1?'s':''}`}
function renumberCrew(){crewIds.forEach((id,i)=>{const l=document.querySelector(`#crew-${id} .crew-lbl`);if(l)l.textContent=`Crew Block ${i+1}`})}

// ═══════════════════════════════════════════
// PRESET CHIPS
// ═══════════════════════════════════════════
function renderChips(stripId, key){
  const strip=document.getElementById('chips-'+stripId);if(!strip)return;
  strip.innerHTML='';
  const items=presets[key]||[];
  items.forEach(item=>{
    const btn=document.createElement('button');btn.className='preset-chip';btn.type='button';btn.title=item.text;
    btn.textContent=item.text.length>58?item.text.slice(0,56)+'…':item.text;
    btn.onclick=()=>appendField(stripId,item.text);
    strip.appendChild(btn);
  });
}
function appendField(fieldId,text){
  const el=document.getElementById(fieldId);if(!el)return;
  const cur=el.value.trim();el.value=cur?cur+'\n'+text:text;
  el.focus();el.scrollTop=el.scrollHeight;
  debouncedAutoSave();
}
function renderAllChips(){
  renderChips('inspSummary','obs');renderChips('genComms','comms');renderChips('lookahead','look');
  crewIds.forEach(id=>{renderChips(`crew-${id}-acts`,'act');renderChips(`crew-${id}-envcomp`,'env')});
}

// ── Nav picker slot state (module-scoped) ──
let _navPickerSlot=0;

function navLoadSlots(){
  try{
    const s=localStorage.getItem('pei_nav_slots');
    if(s){ const p=JSON.parse(s); if(Array.isArray(p)&&p.length===3)return p; }
  }catch{}
  return _NAV_DEFAULTS.slice();
}

function navSaveSlots(){
  try{ localStorage.setItem('pei_nav_slots',JSON.stringify(_navSlots)); }catch{}
}

function renderNav(){
  window._navSlots=navLoadSlots();
  for(let i=0;i<3;i++){
    const pageId=_navSlots[i];
    const page=PAGE_REGISTRY.find(p=>p.id===pageId)||PAGE_REGISTRY[0];
    const btn=document.getElementById('nav-slot-'+(i+1));
    if(!btn)continue;
    btn.dataset.page=page.id;
    btn.querySelector('.nav-icon').textContent=page.icon;
    btn.querySelector('.nav-label').textContent=page.label;
    btn.onclick=()=>showPage(page.id);
    // Remove old long-press listeners by cloning
    const fresh=btn.cloneNode(true);
    fresh.onclick=()=>showPage(page.id);
    btn.parentNode.replaceChild(fresh,btn);
    navAddLongPress(document.getElementById('nav-slot-'+(i+1)),i);
  }
}

// ── Long-press detection ──
function navAddLongPress(btn,slotIdx){
  if(!btn)return;
  let _lpt=null;
  const cancel=()=>{ clearTimeout(_lpt); _lpt=null; };
  btn.addEventListener('touchstart',e=>{
    _lpt=setTimeout(()=>{ e.preventDefault(); showNavPicker(btn,slotIdx); },620);
  },{passive:false});
  btn.addEventListener('touchend',cancel);
  btn.addEventListener('touchmove',cancel);
  btn.addEventListener('touchcancel',cancel);
  // Desktop support
  btn.addEventListener('mousedown',e=>{ if(e.button!==0)return; _lpt=setTimeout(()=>showNavPicker(btn,slotIdx),620); });
  btn.addEventListener('mouseup',cancel);
  btn.addEventListener('mouseleave',cancel);
}

// ── Picker popup ──
function showNavPicker(btn,slotIdx){
  _navPickerSlot=slotIdx;
  const inner=document.getElementById('nav-picker-inner');
  inner.innerHTML=PAGE_REGISTRY.map(p=>`
    <div class="np-row ${_navSlots[slotIdx]===p.id?'np-active':''}" onclick="navSetSlot(${slotIdx},'${p.id}')">
      <span class="np-icon">${p.icon}</span>
      <span class="np-label">${p.label}</span>
      ${_navSlots[slotIdx]===p.id?'<span class="np-check">✓</span>':''}
    </div>`).join('');
  const picker=document.getElementById('nav-picker');
  const card=document.getElementById('nav-picker-card');
  picker.style.display='block';
  // Position above button
  const rect=btn.getBoundingClientRect();
  const cardW=200;
  let left=rect.left+rect.width/2-cardW/2;
  left=Math.max(8,Math.min(left,window.innerWidth-cardW-8));
  const bottom=window.innerHeight-rect.top+10;
  card.style.width=cardW+'px';
  card.style.left=left+'px';
  card.style.bottom=bottom+'px';
}

function hideNavPicker(){
  document.getElementById('nav-picker').style.display='none';
}

function navSetSlot(slotIdx,pageId){
  _navSlots[slotIdx]=pageId;
  navSaveSlots();
  renderNav();
  hideNavPicker();
}

// ── Settings nav config renderer ──
function renderNavConfig(){
  const container=document.getElementById('nav-config-slots');
  if(!container)return;
  container.innerHTML=_navSlots.map((pageId,i)=>{
    const opts=PAGE_REGISTRY.map(p=>`<option value="${p.id}"${pageId===p.id?' selected':''}>${p.icon} ${p.label}</option>`).join('');
    return `<div class="field"><label>Slot ${i+1}</label>
      <select id="cfg-nav-slot-${i}" style="background:var(--bg);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:var(--body);font-size:17px;padding:8px 11px;width:100%">${opts}</select>
    </div>`;
  }).join('');
}

function saveNavConfig(){
  for(let i=0;i<3;i++){
    const sel=document.getElementById('cfg-nav-slot-'+i);
    if(sel)_navSlots[i]=sel.value;
  }
  navSaveSlots();
  renderNav();
  // Re-highlight active slot
  const activePage=document.querySelector('.page.active');
  if(activePage){
    const name=activePage.id.replace('page-','');
    const slotIdx=_navSlots.indexOf(name);
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
    if(slotIdx>=0) document.getElementById('nav-slot-'+(slotIdx+1))?.classList.add('active');
    else document.getElementById('tab-more')?.classList.add('active');
  }
  const s=document.getElementById('cfg-nav-status');
  if(s){s.textContent='Saved!';s.style.opacity='1';setTimeout(()=>s.style.opacity='0',2000);}
}

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
function renderConfig(){
  document.getElementById('activePhaseInput').value=activePhaseLabel;
  initCardTitles();
  renderPhaseList();populateSelects();
  ['obs','act','env','comms','look'].forEach(k=>renderPresetList(k));
  renderChecklistList();
  renderFlagsList();
  renderAmendmentConfig();
  renderKnownProjectsDatalist();
}
function renderPhaseList(){
  const ul=document.getElementById('list-phases');if(!ul)return;ul.innerHTML='';
  phases.forEach((ph,i)=>{
    const li=document.createElement('li');
    li.innerHTML=`<span class="p-text">${ph}</span>${ph===activePhaseLabel?'<span class="phase-badge">active</span>':''}<button class="del-p" onclick="removePhase(${i})">✕</button>`;
    ul.appendChild(li);
  });
}
function renderPresetList(key){
  const ids={obs:'list-obs',act:'list-act',env:'list-env',comms:'list-comms',look:'list-look'};
  const ul=document.getElementById(ids[key]);if(!ul)return;ul.innerHTML='';
  const isReordering=ul.classList.contains('reorder-mode');
  (presets[key]||[]).forEach((item,i)=>{
    const li=document.createElement('li');
    li.dataset.idx=i;li.dataset.origIdx=i;li.dataset.key=key;
    li.innerHTML=`<span class="drag-handle" title="Drag to reorder">≡</span><span class="p-text">${item.text}</span><span class="p-phase">${item.phase}</span><button class="del-p" onclick="removePreset('${key}',${i})">✕</button>`;
    if(isReordering) li.classList.add('reorder-mode');
    ul.appendChild(li);
  });
  if(isReordering) _initDrag(ul,key);
}
function populateSelects(){
  ['obs','act','env','comms','look'].forEach(k=>{
    const sel=document.getElementById(`new-${k}-phase`);if(!sel)return;
    sel.innerHTML=phases.map(p=>`<option value="${p}">${p}</option>`).join('');
    sel.value=activePhaseLabel;
  });
}
function addPreset(key){
  const t=document.getElementById(`new-${key}-text`),ph=document.getElementById(`new-${key}-phase`);
  if(!t.value.trim())return;
  if(!presets[key])presets[key]=[];
  presets[key].push({text:t.value.trim(),phase:ph.value});
  ss('msf_presets',presets);t.value='';renderPresetList(key);renderAllChips();
  _saveProjectSettings({presets});
}
function removePreset(key,idx){
  presets[key].splice(idx,1);ss('msf_presets',presets);renderPresetList(key);renderAllChips();
  _saveProjectSettings({presets});
}
function addPhase(){
  const inp=document.getElementById('new-phase-text');const val=inp.value.trim();
  if(!val||phases.includes(val))return;
  phases.push(val);ss('msf_phases',phases);inp.value='';renderPhaseList();populateSelects();
  _saveProjectSettings({phases});
}
function removePhase(idx){
  if(phases[idx]===activePhaseLabel){alert('Cannot remove the current activity label while it is active.');return}
  phases.splice(idx,1);ss('msf_phases',phases);renderPhaseList();populateSelects();
  _saveProjectSettings({phases});
}

// ── Preset reorder mode ──
function toggleReorderMode(key){
  const ids={obs:'list-obs',act:'list-act',env:'list-env',comms:'list-comms',look:'list-look',checklist:'list-checklist',flags:'list-flags','amendment-phases':'list-amendment-phases','amendment-methods':'list-amendment-methods'};
  const ul=document.getElementById(ids[key]);
  const btn=document.getElementById('reorder-btn-'+key);
  if(!ul||!btn)return;
  const isActive=ul.classList.contains('reorder-mode');
  if(isActive){
    ul.classList.remove('reorder-mode');
    btn.classList.remove('active');
    btn.textContent='⇅ Reorder';
    // Save new order based on current DOM order
    const domItems=[...ul.querySelectorAll('li')];
    const isAmendPhases=key==='amendment-phases', isAmendMethods=key==='amendment-methods';
    const srcArr=key==='checklist'?checklistItems:key==='flags'?flagItems
      :isAmendPhases?window._amendmentPhases:isAmendMethods?window._amendmentMethods
      :presets[key];
    const newOrder=domItems.map(li=>{
      const origIdx=parseInt(li.dataset.origIdx!==undefined?li.dataset.origIdx:li.dataset.idx);
      return srcArr[origIdx];
    }).filter(Boolean);
    if(key==='checklist'){window.checklistItems=newOrder;saveChecklistLocal();saveChecklistCloud();renderChecklistList();buildChecklist();}
    else if(key==='flags'){window.flagItems=newOrder;saveFlagsLocal();saveFlagsCloud();renderFlagsList();buildFlags();}
    else if(isAmendPhases){window._amendmentPhases=newOrder;saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();}
    else if(isAmendMethods){window._amendmentMethods=newOrder;saveAmendmentLocal();saveAmendmentCloud();renderAmendmentConfig();}
    else{presets[key]=newOrder;ss('msf_presets',presets);renderPresetList(key);renderAllChips();_saveProjectSettings({presets});}
    // Clean up event listeners using stored refs
    ul.onmouseover=null;
    if(ul._touchMove) ul.removeEventListener('touchmove',ul._touchMove);
    if(ul._touchEnd) ul.removeEventListener('touchend',ul._touchEnd);
    if(ul._mouseUp) document.removeEventListener('mouseup',ul._mouseUp);
    ul._touchMove=null;ul._touchEnd=null;ul._mouseUp=null;
  } else {
    ul.classList.add('reorder-mode');
    btn.classList.add('active');
    btn.textContent='✓ Done';
    // Add reorder-mode class to all li items and init drag
    ul.querySelectorAll('li').forEach(li=>li.classList.add('reorder-mode'));
    _initDrag(ul,key);
  }
}

function _initDrag(ul,key){
  // Clean up any previous handlers first
  ul.onmouseover=null;
  const oldTouchMove=ul._touchMove;
  const oldTouchEnd=ul._touchEnd;
  if(oldTouchMove) ul.removeEventListener('touchmove',oldTouchMove);
  if(oldTouchEnd) ul.removeEventListener('touchend',oldTouchEnd);
  const oldMouseUp=ul._mouseUp;
  if(oldMouseUp) document.removeEventListener('mouseup',oldMouseUp);

  let dragEl=null;
  ul.querySelectorAll('.drag-handle').forEach(handle=>{
    const li=handle.closest('li');
    handle.onmousedown=function(e){
      dragEl=li;
      li.classList.add('dragging');
      e.preventDefault();
    };
    handle.ontouchstart=function(e){
      dragEl=li;
      li.classList.add('dragging');
    };
  });
  ul.onmouseover=function(e){
    const target=e.target.closest('li');
    if(dragEl&&target&&target!==dragEl){
      ul.querySelectorAll('li').forEach(l=>l.classList.remove('drag-over'));
      target.classList.add('drag-over');
    }
  };
  const touchMove=function(e){
    if(!dragEl) return;
    e.preventDefault();
    const touch=e.touches[0];
    const target=document.elementFromPoint(touch.clientX,touch.clientY)?.closest('li');
    if(target&&target!==dragEl&&ul.contains(target)){
      ul.querySelectorAll('li').forEach(l=>l.classList.remove('drag-over'));
      target.classList.add('drag-over');
    }
  };
  const drop=function(){
    if(!dragEl)return;
    const overEl=ul.querySelector('.drag-over');
    if(overEl&&overEl!==dragEl){
      const items=[...ul.querySelectorAll('li')];
      const fromIdx=items.indexOf(dragEl);
      const toIdx=items.indexOf(overEl);
      if(fromIdx<toIdx) ul.insertBefore(dragEl,overEl.nextSibling);
      else ul.insertBefore(dragEl,overEl);
      [...ul.querySelectorAll('li')].forEach((li,i)=>li.dataset.idx=i);
    }
    dragEl.classList.remove('dragging');
    ul.querySelectorAll('li').forEach(l=>l.classList.remove('drag-over'));
    dragEl=null;
  };
  // Store refs so we can remove them later
  ul._touchMove=touchMove;
  ul._touchEnd=drop;
  ul._mouseUp=drop;
  ul.addEventListener('touchmove',touchMove,{passive:false});
  ul.addEventListener('touchend',drop);
  document.addEventListener('mouseup',drop);
}

function savePhaseLabel(){
  const val=document.getElementById('activePhaseInput').value.trim();if(!val)return;
  window.activePhaseLabel=val;ss('msf_activephase',activePhaseLabel);
  document.getElementById('activePhase').value=val;
  renderPhaseList();renderAllChips();
}

function tsLoadConfigFields(){
  const cfg=tsLoadConfig();
  const ws=document.getElementById('cfg-ts-weekstart');
  const pd=document.getElementById('cfg-ts-perdiem');
  const mr=document.getElementById('cfg-ts-mileage');
  const sv=document.getElementById('cfg-ts-supervisor');
  const hr=document.getElementById('cfg-ts-hourlyrate');
  const pt=document.getElementById('cfg-ts-paytype');
  const ot=document.getElementById('cfg-ts-ottype');
  if(ws)ws.value=cfg.weekStartDay;
  if(pd)pd.value=cfg.perDiem;
  if(mr)mr.value=cfg.mileageRate;
  if(sv)sv.value=cfg.supervisorName;
  if(hr)hr.value=cfg.hourlyRate||'';
  if(pt){pt.value=cfg.payType||'hourly';pt.onchange=tsToggleOTWrap;}
  if(ot)ot.value=cfg.otType||'daily';
  tsToggleOTWrap();
}

// ═══════════════════════════════════════════
// THEME TOGGLE
// ═══════════════════════════════════════════
function applyTheme(t){
  const prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isLight = t==='light' || (t==='system' && !prefersDark);
  document.body.classList.toggle('theme-light', isLight);
  const btn=document.getElementById('theme-btn');
  if(btn) btn.textContent = t==='light' ? '☀' : t==='system' ? '⊙' : '🌙';
  try{ localStorage.setItem('phinest_theme', t); }catch{}
}
function toggleTheme(){
  const current=localStorage.getItem('phinest_theme')||'dark';
  const next = current==='dark' ? 'light' : current==='light' ? 'system' : 'dark';
  applyTheme(next);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(){
  const current=localStorage.getItem('phinest_theme')||'dark';
  if(current==='system') applyTheme('system');
});
(function initTheme(){
  const saved=localStorage.getItem('phinest_theme')||'dark';
  applyTheme(saved);
})();

// ═══════════════════════════════════════════
// WINDOW EXPOSURE
// ═══════════════════════════════════════════
window.loadCardTitles = loadCardTitles;
window.saveCardLabels = saveCardLabels;
window.initCardTitles = initCardTitles;
window.loadChecklistConfig = loadChecklistConfig;
window.saveChecklistLocal = saveChecklistLocal;
window.saveChecklistCloud = saveChecklistCloud;
window.loadChecklistCloud = loadChecklistCloud;
window.loadFlagsConfig = loadFlagsConfig;
window.saveFlagsLocal = saveFlagsLocal;
window.saveFlagsCloud = saveFlagsCloud;
window.loadFlagsCloud = loadFlagsCloud;
window.renderChecklistList = renderChecklistList;
window.renderFlagsList = renderFlagsList;
window.addChecklistItem = addChecklistItem;
window.removeChecklistItem = removeChecklistItem;
window.addFlagItem = addFlagItem;
window.removeFlagItem = removeFlagItem;
window.saveChecklistConfig = saveChecklistConfig;
window.saveFlagsConfig = saveFlagsConfig;
window.buildChecklist = buildChecklist;
window.buildFlags = buildFlags;
window.toggleNote = toggleNote;
window.toggleFlagNote = toggleFlagNote;
window.addCrew = addCrew;
window.removeCrew = removeCrew;
window.updateCrewBadge = updateCrewBadge;
window.renumberCrew = renumberCrew;
window.renderChips = renderChips;
window.appendField = appendField;
window.renderAllChips = renderAllChips;
window.navLoadSlots = navLoadSlots;
window.navSaveSlots = navSaveSlots;
window.renderNav = renderNav;
window.navAddLongPress = navAddLongPress;
window.showNavPicker = showNavPicker;
window.hideNavPicker = hideNavPicker;
window.navSetSlot = navSetSlot;
window.renderNavConfig = renderNavConfig;
window.saveNavConfig = saveNavConfig;
window.renderConfig = renderConfig;
window.renderPhaseList = renderPhaseList;
window.renderPresetList = renderPresetList;
window.populateSelects = populateSelects;
window.addPreset = addPreset;
window.removePreset = removePreset;
window.addPhase = addPhase;
window.removePhase = removePhase;
window.toggleReorderMode = toggleReorderMode;
window.savePhaseLabel = savePhaseLabel;
window.tsLoadConfigFields = tsLoadConfigFields;
window.applyTheme = applyTheme;
window.toggleTheme = toggleTheme;
window.loadAmendmentConfig = loadAmendmentConfig;
window.saveAmendmentLocal = saveAmendmentLocal;
window.saveAmendmentCloud = saveAmendmentCloud;
window.renderAmendmentConfig = renderAmendmentConfig;
window.addAmendmentPhase = addAmendmentPhase;
window.removeAmendmentPhase = removeAmendmentPhase;
window.addAmendmentMethod = addAmendmentMethod;
window.removeAmendmentMethod = removeAmendmentMethod;
window.saveAmendmentConfig = saveAmendmentConfig;

// ═══════════════════════════════════════════
// BOOT CALLS (functions called at sync init, now deferred to module load)
// ═══════════════════════════════════════════
initCardTitles();
renderAllChips();
renderNav();
updateCrewBadge();
