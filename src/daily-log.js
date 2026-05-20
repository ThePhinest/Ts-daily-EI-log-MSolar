// ═══════════════════════════════════════════
// DAILY LOG
// ═══════════════════════════════════════════

// Module-level state
let _ldPending = null;
let _dnCurrentDate = null;
const DN_KEY = 'pei_day_notes';

// ── Collect all form state (for download/archive) ──
function collectFormState(){
  // Simple fields
  const fields=['projectName','reportDate','preparedBy','org','activePhase','contractor','reviewedBy',
    'tempAM','tempPM','wind','precip','soilCond','upcomingWeather',
    'wxSunrise','wxSunset','wxDaylight',
    'inspSummary','agencyInsp','landowner','rte','nonCompliance',
    'genComms','lookahead','lookaheadWeather',
    'p-timeIn','p-timeOut','p-odoStart','p-odoEnd','p-notes'];
  const state={fields:{},sky:[],checkboxes:{},flagNotes:{},checklist:{},crew:[],crewSeq,crewIds:[...crewIds]};
  fields.forEach(id=>{const el=document.getElementById(id);if(el)state.fields[id]=el.value});
  // Sky — collect all checked
  state.sky=[...document.querySelectorAll('input[name="sky"]:checked')].map(el=>el.value);
  // Flags + flag notes
  flagItems.forEach(f=>{
    state.checkboxes[f.id]=document.getElementById(f.id)?.checked||false;
    state.flagNotes[f.id.replace('flag-','')]=document.getElementById(f.id+'-note')?.value||'';
  });
  // Checklist
  checklistItems.forEach(c=>{
    state.checklist[c.id]={checked:document.getElementById(c.id)?.checked||false,note:document.getElementById(c.id+'-note')?.value||''};
  });
  // Crew blocks
  crewIds.forEach(id=>{
    const block={id};
    ['name','time','loc','acts','envcomp','issues','notes'].forEach(f=>{
      block[f]=document.getElementById(`crew-${id}-${f}`)?.value||'';
    });
    state.crew.push(block);
  });
  return state;
}

// ── Restore form state (on re-open) ──
function restoreFormState(state){
  if(!state)return;
  // Fields
  Object.entries(state.fields||{}).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.value=val});
  // Sky — support both old string and new array format
  const skyVals=Array.isArray(state.sky)?state.sky:(state.sky?[state.sky]:[]);
  skyVals.forEach(v=>{const r=document.querySelector(`input[name="sky"][value="${v}"]`);if(r)r.checked=true});
  // Checkboxes + flag notes
  Object.entries(state.checkboxes||{}).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.checked=val});
  Object.entries(state.flagNotes||{}).forEach(([f,val])=>{
    const el=document.getElementById('flag-'+f+'-note');if(el)el.value=val;
  });
  // Show note wraps for all checked flags
  flagItems.forEach(f=>{
    if(document.getElementById(f.id)?.checked){const nw=document.getElementById(f.id+'-nw');if(nw)nw.classList.add('vis');}
  });
  // Checklist
  Object.entries(state.checklist||{}).forEach(([id,{checked,note}])=>{
    const cb=document.getElementById(id);if(cb){cb.checked=checked;if(checked){const nw=document.getElementById(id+'-nw');if(nw)nw.classList.add('vis')}}
    const nt=document.getElementById(id+'-note');if(nt)nt.value=note;
  });
  // Crew — restore sequence
  window.crewSeq=state.crewSeq||0;
  (state.crew||[]).forEach(block=>{
    crewIds.push(block.id);
    const d=document.createElement('div');d.className='crew-block';d.id=`crew-${block.id}`;
    const idx=crewIds.indexOf(block.id);
    d.innerHTML=buildCrewHTML(block.id, idx+1);
    document.getElementById('crewContainer').appendChild(d);
    ['acts','envcomp'].forEach(f=>{ if(typeof renderChips==='function') renderChips(`crew-${block.id}-${f}`,f==='acts'?'act':'env'); });
    ['name','time','loc','acts','envcomp','issues','notes'].forEach(f=>{
      const el=document.getElementById(`crew-${block.id}-${f}`);if(el)el.value=block[f]||'';
    });
  });
  if(typeof updateCrewBadge==='function') updateCrewBadge();
  calcMiles();calcHours();
  // Sync persisted sunrise/sunset/daylight hidden inputs into the visible
  // strong tags. Field loop above sets hidden input values; the strong tags
  // are display-only siblings that don't get touched by the generic loop.
  ['wxSunrise|wx-sunrise','wxSunset|wx-sunset','wxDaylight|wx-daylight'].forEach(pair=>{
    const [hiddenId,visibleId]=pair.split('|');
    const hv=document.getElementById(hiddenId)?.value;
    const vEl=document.getElementById(visibleId);
    if(hv && vEl) vEl.textContent=hv;
  });
  requestAnimationFrame(()=>requestAnimationFrame(()=>document.querySelectorAll('textarea.auto-expand').forEach(autoResize)));
}

function buildCrewHTML(id, num){
  return `<div class="crew-block-head">
      <span class="crew-lbl">Crew Block ${num}</span>
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
        <div class="field"><label>Additional Notes</label><textarea class="short auto-expand" id="crew-${id}-notes" placeholder="Any other notes…"></textarea></div>
      </div>
    </div>`;
}

// ── Copy JSON export ──
function copyJSON(){
  const flagsWithoutDesc=flagItems.filter(f=>document.getElementById(f.id)?.checked&&!document.getElementById(f.id+'-note')?.value.trim());
  if(flagsWithoutDesc.length>0){
    _confirmModal(`⚠ ${flagsWithoutDesc.length} regulatory flag(s) are checked without a description — they will appear in the report without detail. Export anyway?`,_buildAndCopyJSON);
    return;
  }
  _buildAndCopyJSON();
}
function _buildAndCopyJSON(){
  const sky=[...document.querySelectorAll('input[name="sky"]:checked')].map(el=>el.value).join(', ')||'';
  const checklist=checklistItems.map(c=>({item:c.text,checked:!!document.getElementById(c.id)?.checked,note:document.getElementById(c.id+'-note')?.value.trim()||''}));
  const flags=flagItems.filter(f=>document.getElementById(f.id)?.checked).map(f=>{
    const note=document.getElementById(f.id+'-note')?.value.trim()||'';
    return note?`${f.text} — ${note}`:f.text;
  });
  const crew=crewIds.map(id=>({
    name:    document.getElementById(`crew-${id}-name`)?.value.trim()||'',
    time:    document.getElementById(`crew-${id}-time`)?.value.trim()||'',
    location:document.getElementById(`crew-${id}-loc`)?.value.trim()||'',
    activities:   document.getElementById(`crew-${id}-acts`)?.value.trim()||'',
    envCompliance:document.getElementById(`crew-${id}-envcomp`)?.value.trim()||'',
    issues:  document.getElementById(`crew-${id}-issues`)?.value.trim()||'',
    notes:   document.getElementById(`crew-${id}-notes`)?.value.trim()||'',
  }));
  const lookaheadWx=document.getElementById('lookaheadWeather').value.trim();
  const lookaheadText=document.getElementById('lookahead').value.trim();
  const lookahead=lookaheadWx ? `Expected Weather: ${lookaheadWx}${lookaheadText?'\n'+lookaheadText:''}` : lookaheadText;
  const data={
    _source:'GroundLog Daily Log',
    project:    document.getElementById('projectName').value,
    reportDate: document.getElementById('reportDate').value,
    preparedBy: document.getElementById('preparedBy').value,
    org:        document.getElementById('org').value,
    activePhase:document.getElementById('activePhase').value,
    contractor: document.getElementById('contractor').value,
    location:   document.getElementById('location').value,
    reviewedBy: document.getElementById('reviewedBy').value,
    weather:{sky,tempAM:document.getElementById('tempAM').value,tempPM:document.getElementById('tempPM').value,wind:document.getElementById('wind').value,precip:document.getElementById('precip').value,soilConditions:document.getElementById('soilCond').value,upcomingForecast:document.getElementById('upcomingWeather').value},
    inspectionSummary:document.getElementById('inspSummary').value.trim(),
    agencyInspection: document.getElementById('agencyInsp').value.trim(),
    landownerContact: document.getElementById('landowner').value.trim(),
    rteObservation:   document.getElementById('rte').value.trim(),
    nonCompliance:    document.getElementById('nonCompliance').value.trim(),
    crewBlocks:crew,
    complianceChecklist:checklist,
    regulatoryFlags:flags,
    generalComms:document.getElementById('genComms').value.trim(),
    lookahead,
  };
  const out=`EI FIELD LOG — MORAINE SOLAR ENERGY CENTER\nBuild today's report.\n\n\`\`\`json\n${JSON.stringify(data,null,2)}\n\`\`\``;
  const fn=()=>{const s=document.getElementById('copyStatus');s.classList.add('show');setTimeout(()=>s.classList.remove('show'),3500)};
  if(navigator.clipboard){navigator.clipboard.writeText(out).then(fn).catch(()=>fbCopy(out,fn))}else{fbCopy(out,fn)}
}
function fbCopy(text,cb){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);cb()}

// ── Download filled log ──
async function downloadLog(){
  const state=collectFormState();
  const stateJSON=JSON.stringify(state);
  let src=document.documentElement.outerHTML;
  src=src.replace('const SAVED_DATA = null;',`const SAVED_DATA = ${stateJSON};`);
  const raw=document.getElementById('reportDate').value||new Date().toLocaleDateString('en-CA');
  const [y,m,d]=raw.split('-');
  const _projName=(document.getElementById('cfg-projectName')?.value?.trim()||'GroundLog');
  const _projSlug=_projName.replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'GroundLog';
  const filename=`${m}-${d}-${y}_${_projSlug}-Daily_Inspection_Report.html`;
  const blob=new Blob([src],{type:'text/html;charset=utf-8'});
  const showStatus=()=>{const s=document.getElementById('dlStatus');s.classList.add('show');setTimeout(()=>s.classList.remove('show'),3500);};
  try{
    // Routes to iOS share sheet on native, navigator.share/anchor on web.
    // See src/saveFile.js for branch logic.
    await window.saveFileNative(blob,filename,'text/html');
    showStatus();
  }catch(e){
    console.error('downloadLog:',e);
    fallbackDownload(blob,filename);
    showStatus();
  }
}
function fallbackDownload(blob,filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=filename;a.click();
  URL.revokeObjectURL(url);
}

// ── Reset core (Firebase-aware resetForm defined in Firebase block) ──
function _resetFormCore(){
  window._editingArchivedDate = null; // clear any pending edit tracking
  document.querySelectorAll('#page-log input[type=text]:not([readonly]),#page-log input[type=number],#page-log input[type=time],#page-log textarea').forEach(el=>el.value='');
  document.querySelectorAll('#page-log input[type=date]').forEach(el=>el.value='');
  document.querySelectorAll('#page-log input[type=checkbox],#page-log input[type=radio]').forEach(el=>el.checked=false);
  document.getElementById('soilCond').value='';
  document.querySelectorAll('.check-note-wrap,.flag-note-wrap').forEach(el=>el.classList.remove('vis'));
  document.getElementById('crewContainer').innerHTML='';window.crewIds=[];window.crewSeq=0;updateCrewBadge();
  document.getElementById('p-miles').textContent='— mi';
  document.getElementById('p-hours').textContent='— hrs';
  document.getElementById('reportDate').value=localToday();
  applyProjectConfig();
  try{ localStorage.removeItem('msf_autosave'); }catch{}
}

// ═══════════════════════════════════════════
// DAY NOTES
// ═══════════════════════════════════════════
function dnGetAll(){try{return JSON.parse(localStorage.getItem(DN_KEY)||'{}');}catch{return{};}}
function dnGet(date){return dnGetAll()[date]||null;}
function dnSaveLocal(date,note){const all=dnGetAll();if(note){all[date]={note,_ts:Date.now()};}else{delete all[date];}localStorage.setItem(DN_KEY,JSON.stringify(all));}
async function dnSaveCloud(date,note){
  if(!db||!_fbReady)return;
  try{
    if(note){await _udb().collection('dayNotes').doc(date).set({note,_ts:Date.now()});}
    else{await _udb().collection('dayNotes').doc(date).delete();}
  }catch(e){}
}
async function dnLoadCloud(){
  if(!db||!_fbReady)return;
  try{
    const snap=await _udb().collection('dayNotes').get();
    if(snap.empty)return;
    const all=dnGetAll();
    snap.forEach(doc=>{all[doc.id]=doc.data();});
    localStorage.setItem(DN_KEY,JSON.stringify(all));
  }catch(e){}
}

// ── Day note modal ──
async function dayNoteOpen(date){
  _dnCurrentDate=date;
  await dnLoadCloud();
  const existing=dnGet(date);
  const title=document.getElementById('daynote-title');
  const textarea=document.getElementById('daynote-text');
  const clearBtn=document.getElementById('daynote-clear-btn');
  if(title) title.textContent='Note for '+dlFmtDisplay(date);
  if(textarea) textarea.value=existing?existing.note:'';
  if(clearBtn) clearBtn.style.display=existing?'':'none';
  document.getElementById('daynote-overlay').style.display='flex';
  setTimeout(()=>{textarea?.focus();if(textarea)autoResize(textarea);},100);
}
async function dayNoteSave(){
  if(!_dnCurrentDate)return;
  const note=document.getElementById('daynote-text')?.value.trim()||'';
  dnSaveLocal(_dnCurrentDate,note||null);
  await dnSaveCloud(_dnCurrentDate,note||null);
  dayNoteClose();
  calRenderGrid();
  calRenderDayViewGrid();
}
function dayNoteClear(){
  const textarea=document.getElementById('daynote-text');
  if(textarea) textarea.value='';
  document.getElementById('daynote-clear-btn').style.display='none';
}
function dayNoteClose(){
  document.getElementById('daynote-overlay').style.display='none';
  _dnCurrentDate=null;
}

// ═══════════════════════════════════════════
// AUTO WEATHER — Open-Meteo (no API key)
// ═══════════════════════════════════════════
function getMyWeather(){
  const btn=document.getElementById('wx-btn');
  if(btn){btn.textContent='📍 Getting location…';btn.disabled=true;}
  if(!navigator.geolocation){
    alert('Geolocation is not supported on this device.');
    if(btn){btn.textContent='⛅ Get My Weather';btn.disabled=false;}
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async function(pos){
      const lat=pos.coords.latitude.toFixed(4);
      const lon=pos.coords.longitude.toFixed(4);
      if(btn) btn.textContent='⛅ Fetching weather…';
      try{
        const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`+
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,windgusts_10m_max,winddirection_10m_dominant,weathercode,sunrise,sunset`+
          `&hourly=precipitation,windspeed_10m,weathercode,soil_moisture_0_to_7cm,soil_temperature_0_to_7cm`+
          `&past_days=1&current_weather=true`+
          `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=3`;
        const res=await fetch(url);
        if(!res.ok) throw new Error('HTTP '+res.status);
        const data=await res.json();
        _applyWeatherData(data);
        if(btn){btn.textContent='✓ Weather filled';btn.style.color='var(--green)';
          setTimeout(()=>{btn.textContent='⛅ Get My Weather';btn.style.color='';btn.disabled=false;},3000);}
      }catch(e){
        let msg='Weather service is temporarily unavailable. Try again in a moment.';
        if(!navigator.onLine) msg='No internet connection. Connect and try again.';
        alert(msg);
        if(btn){btn.textContent='⛅ Get My Weather';btn.disabled=false;}
      }
    },
    function(err){
      alert('Location access denied. Please allow location access and try again.');
      if(btn){btn.textContent='⛅ Get My Weather';btn.disabled=false;}
    },
    {timeout:10000,maximumAge:0}
  );
}

// ── C-pack weather helpers ──
// Active inspection window — 6 AM to 7 PM in user's local timezone (per Tim 2026-05-07)
function _findTodayActiveRange(data){
  // Use Open-Meteo's reported current_weather time as the source of truth for "today"
  // (avoids UTC-vs-local-date pitfalls). past_days=1 means the hourly array starts
  // 24h before today, so today's 6 AM is somewhere in the second day of the array.
  const todayStr = (data.current_weather?.time || '').slice(0,10);
  if(!todayStr) return {startIdx:-1, endIdx:-1};
  const startIdx = data.hourly.time.indexOf(`${todayStr}T06:00`);
  const endIdx   = data.hourly.time.indexOf(`${todayStr}T19:00`);
  return {startIdx, endIdx};
}

function _meanActive(arr, startIdx, endIdx){
  if(!arr || startIdx < 0 || endIdx < 0) return null;
  let sum = 0, count = 0;
  for(let i = startIdx; i <= endIdx; i++){
    if(typeof arr[i] === 'number'){ sum += arr[i]; count++; }
  }
  return count > 0 ? sum / count : null;
}

function _windRangeActive(data, startIdx, endIdx){
  if(!data.hourly?.windspeed_10m || startIdx < 0 || endIdx < 0) return null;
  const speeds = data.hourly.windspeed_10m.slice(startIdx, endIdx + 1).filter(v => typeof v === 'number');
  if(!speeds.length) return null;
  return {min: Math.min(...speeds), max: Math.max(...speeds)};
}

// Sum hourly precipitation for the 24 hours leading up to current_weather time
function _past24hrPrecip(data){
  if(!data.hourly?.precipitation || !data.current_weather?.time) return 0;
  const nowMs = new Date(data.current_weather.time).getTime();
  let currentIdx = -1;
  for(let i = data.hourly.time.length - 1; i >= 0; i--){
    if(new Date(data.hourly.time[i]).getTime() <= nowMs){ currentIdx = i; break; }
  }
  if(currentIdx < 0) return 0;
  const startIdx = Math.max(0, currentIdx - 24);
  let sum = 0;
  for(let i = startIdx; i < currentIdx; i++) sum += (data.hourly.precipitation[i] || 0);
  return sum;
}

// Fixed-threshold soil descriptor (per Tim 2026-05-07)
function _classifySoil(soilTempF, soilMoisture, hadSnowCode){
  if(hadSnowCode && soilTempF <= 32) return 'Snow Cover';
  if(soilTempF <= 32) return 'Frozen';
  if(soilTempF <= 36) return 'Frost / Partially Frozen';
  if(soilMoisture >= 0.40) return 'Saturated';
  if(soilMoisture >= 0.25) return 'Moist';
  return 'Dry';
}

function _wmoToSkyId(code){
  if(code === 0) return 'sky-clear';
  if(code <= 2) return 'sky-partly';
  if(code === 3) return 'sky-overcast';
  if(code <= 49) return 'sky-fog';
  if(code <= 59) return 'sky-rain';
  if(code <= 69) return 'sky-mix';
  if(code <= 79) return 'sky-snow';
  if(code <= 84) return 'sky-rain';
  if(code <= 94) return 'sky-mix';
  return 'sky-overcast';  // thunder
}

// Multi-check sky checkboxes from a list of WMO codes (dedupes by category)
function _applySkyCheckboxes(codes){
  document.querySelectorAll('input[name="sky"]').forEach(cb => cb.checked = false);
  if(!codes || !codes.length) return;
  const matched = new Set();
  codes.forEach(c => { const id = _wmoToSkyId(c); if(id) matched.add(id); });
  matched.forEach(id => { const el = document.getElementById(id); if(el) el.checked = true; });
}

function _formatTimeAmPm(d){
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

function _formatDaylight(sunriseISO, sunsetISO){
  if(!sunriseISO || !sunsetISO) return null;
  const sr = new Date(sunriseISO), ss = new Date(sunsetISO);
  if(isNaN(sr) || isNaN(ss)) return null;
  const lengthMs = ss - sr;
  const lengthH = Math.floor(lengthMs / 3600000);
  const lengthM = Math.round((lengthMs % 3600000) / 60000);
  return {sunrise: _formatTimeAmPm(sr), sunset: _formatTimeAmPm(ss), length: `${lengthH}h ${lengthM}m`};
}

function _applyWeatherData(data){
  const d=data.daily;
  const cw=data.current_weather;
  if(!d||!cw) return;
  // past_days=1 means daily array has [yesterday, today, tomorrow, day_after]
  // Find today's index using current_weather time so we don't depend on positional assumptions
  const todayStr = cw.time.slice(0,10);
  const TODAY = d.time.findIndex(t => t === todayStr);
  if(TODAY < 0) return;
  const TMR = TODAY + 1;
  const range = _findTodayActiveRange(data);

  // ── Temps: today's low = AM, today's high = PM ──
  const hiF=Math.round(d.temperature_2m_max[TODAY]);
  const loF=Math.round(d.temperature_2m_min[TODAY]);
  const amEl=document.getElementById('tempAM');
  const pmEl=document.getElementById('tempPM');
  if(amEl) amEl.value=loF;
  if(pmEl) pmEl.value=hiF;

  // ── Daylight: persisted via hidden inputs (wxSunrise/wxSunset/wxDaylight)
  // so calendar reload of archived day shows real values, not placeholder.
  // Hidden inputs are NOT in report.js logData builder, so they don't bust
  // the report cache hash.
  const daylight = _formatDaylight(d.sunrise?.[TODAY], d.sunset?.[TODAY]);
  if(daylight){
    const srEl = document.getElementById('wx-sunrise');
    const ssEl = document.getElementById('wx-sunset');
    const dlEl = document.getElementById('wx-daylight');
    if(srEl) srEl.textContent = daylight.sunrise;
    if(ssEl) ssEl.textContent = daylight.sunset;
    if(dlEl) dlEl.textContent = daylight.length;
    const srHidden = document.getElementById('wxSunrise');
    const ssHidden = document.getElementById('wxSunset');
    const dlHidden = document.getElementById('wxDaylight');
    if(srHidden) srHidden.value = daylight.sunrise;
    if(ssHidden) ssHidden.value = daylight.sunset;
    if(dlHidden) dlHidden.value = daylight.length;
  }

  // ── Wind: range across 6 AM–7 PM + gusts + cardinal direction ──
  const wRange = _windRangeActive(data, range.startIdx, range.endIdx);
  const gustsMph = Math.round(d.windgusts_10m_max?.[TODAY] || 0);
  const wdir = d.winddirection_10m_dominant[TODAY];
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const cardDir = dirs[Math.round(wdir/22.5)%16];
  const windEl = document.getElementById('wind');
  if(windEl){
    let speedStr;
    if(wRange){
      const minS = Math.round(wRange.min), maxS = Math.round(wRange.max);
      speedStr = (minS === maxS) ? `${maxS}` : `${minS}–${maxS}`;
    } else {
      speedStr = String(Math.round(d.windspeed_10m_max[TODAY]));
    }
    const gustStr = gustsMph > 0 ? `, gusts to ${gustsMph}` : '';
    windEl.value = `${speedStr} mph ${cardDir}${gustStr}`;
  }

  // ── Precip: past 24 hours from hourly (more accurate than today's daily total) ──
  const past24 = _past24hrPrecip(data);
  const precipEl = document.getElementById('precip');
  if(precipEl) precipEl.value = past24.toFixed(2);

  // ── Soil Conditions: classify by mean of active-hour samples ──
  if(data.hourly?.soil_temperature_0_to_7cm && data.hourly?.soil_moisture_0_to_7cm){
    const meanTemp = _meanActive(data.hourly.soil_temperature_0_to_7cm, range.startIdx, range.endIdx);
    const meanMoisture = _meanActive(data.hourly.soil_moisture_0_to_7cm, range.startIdx, range.endIdx);
    const codesForSnow = (range.startIdx >= 0 && range.endIdx >= 0)
      ? data.hourly.weathercode.slice(range.startIdx, range.endIdx + 1)
      : [];
    const hadSnow = codesForSnow.some(c => c >= 71 && c <= 77);
    if(meanTemp !== null && meanMoisture !== null){
      const soilDescriptor = _classifySoil(meanTemp, meanMoisture, hadSnow);
      const soilEl = document.getElementById('soilCond');
      if(soilEl) soilEl.value = soilDescriptor;
    }
  }

  // ── Sky: multi-check across active hours, fall back to daily code if no active range ──
  if(range.startIdx >= 0 && range.endIdx >= 0){
    const codes = data.hourly.weathercode.slice(range.startIdx, range.endIdx + 1);
    _applySkyCheckboxes(codes.length ? codes : [d.weathercode[TODAY]]);
  } else {
    _applySkyCheckboxes([d.weathercode[TODAY]]);
  }

  // ── Forecast: tomorrow with gusts ──
  if(TMR < d.time.length){
    const tmrHi = Math.round(d.temperature_2m_max[TMR]);
    const tmrLo = Math.round(d.temperature_2m_min[TMR]);
    const tmrWmo = d.weathercode[TMR];
    const tmrWspd = Math.round(d.windspeed_10m_max[TMR]);
    const tmrGusts = Math.round(d.windgusts_10m_max?.[TMR] || 0);
    const tmrDesc = _wmoToDesc(tmrWmo);
    const gustTail = tmrGusts > 0 ? ` (gusts ${tmrGusts})` : '';
    const fcastStr = `Tomorrow: ${tmrDesc}, High ${tmrHi}°F / Low ${tmrLo}°F, Winds up to ${tmrWspd} mph${gustTail}`;
    const fcastEl = document.getElementById('upcomingWeather');
    if(fcastEl) fcastEl.value = fcastStr;
    // Push forecast to look-ahead if empty
    const lookaheadEl = document.getElementById('lookaheadWeather');
    if(lookaheadEl && !lookaheadEl.value.trim()) lookaheadEl.value = fcastStr;
  }

  // Trigger autosave
  debouncedAutoSave();
}

function _wmoToDesc(code){
  if(code===0) return 'Clear';
  if(code<=2) return 'Partly Cloudy';
  if(code===3) return 'Overcast';
  if(code<=49) return 'Fog';
  if(code<=59) return 'Rain / Drizzle';
  if(code<=69) return 'Freezing Rain';
  if(code<=79) return 'Snow';
  if(code<=84) return 'Rain Showers';
  if(code<=94) return 'Snow Showers';
  return 'Thunderstorms';
}

// ═══════════════════════════════════════════
// DAILY LOG ARCHIVE SYSTEM
// ═══════════════════════════════════════════

// ── Storage helpers ──
function dlGetAll(){
  try{ return JSON.parse(localStorage.getItem('pei_daily_logs')||'{}'); }catch{ return {}; }
}
function dlGet(date){
  return dlGetAll()[date]||null;
}
function dlSaveLocal(date, record){
  try{
    const all=dlGetAll();
    all[date]=record;
    localStorage.setItem('pei_daily_logs',JSON.stringify(all));
  }catch{}
}

// ── Archive current log to a given date ──
async function dlArchive(date){
  if(!date) return;
  const state=collectFormState();
  if(!state) return;
  const existing=dlGet(date)||{};
  const record=Object.assign({},state,{
    _archivedAt: existing._archivedAt||Date.now(),
    _archivedDate: date,
    _edited: existing._edited||false,
    _editLog: existing._editLog||[],
    projectId: _activeProjectId()
  });
  dlSaveLocal(date, record);
  localStorage.removeItem('gl_formalized_date'); window._logFormalized = false;
  try{
    if(typeof db!=='undefined'&&db&&_fbReady){
      await _udb().collection('dailyLogs').doc(date).set(record);
    }
  }catch(e){}
  // ── Auto-push hours & miles to timesheet on archive (manual overrides preserved) ──
  try{
    const f=state.fields||{};
    const tin=f['p-timeIn']||''; const tout=f['p-timeOut']||'';
    const os=parseFloat(f['p-odoStart']||0); const oe=parseFloat(f['p-odoEnd']||0);
    const miles=(oe>os)?(oe-os):0;
    // Calculate hours from time in/out
    let hours=0;
    if(tin&&tout){
      const [h1,m1]=tin.split(':').map(Number);
      const [h2,m2]=tout.split(':').map(Number);
      const diff=((h2*60+m2)-(h1*60+m1))/60;
      if(diff>0) hours=Math.round(diff*10)/10;
    }
    // Resolve projectId at write time (E1.1 Option C). Daily log is always
    // editing the active project's session, so active project is the right
    // binding for the timesheet entry created from this log.
    const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
    const existing=tsGetEntry(date,pid)||{};
    const update={};
    if(!existing._manualHours && hours>0) update.hours=hours;
    if(!existing._manualMiles && miles>0) update.miles=miles;
    if(!existing._manualActivity && f.activePhase) update.activitySummary=f.activePhase;
    if(!existing._manualPerDiem) update.perDiem=tsLoadConfig(pid).perDiem;
    if(Object.keys(update).length>0) tsSaveEntry(date, update, pid);
  }catch(e){}
  // ── Option C: backfill past week snapshot if this date is in a past week ──
  try{ tsBackfillWeekFromLogs(date); }catch(e){}
}

// ── Format date for display: "Mon, Mar 18" ──
function dlFmtDisplay(dateStr){
  if(!dateStr) return '';
  try{
    const [y,m,d]=dateStr.split('-').map(Number);
    const dt=new Date(y,m-1,d);
    const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return days[dt.getDay()]+', '+months[m-1]+' '+d;
  }catch{ return dateStr; }
}

// ── Local date helper — always returns YYYY-MM-DD in device local time, never UTC ──
function localToday(){const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');const dd=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${dd}`;}

// ── New day detection + modal ──
function checkNewDay(){
  const today=localToday();
  // Check suppression — if already handled today, skip
  const suppressed=localStorage.getItem('pei_newday_suppress')||'';
  if(suppressed===today) return;
  // Get last log date from autosave — stored under fields.reportDate
  let savedDate='';
  try{
    const saved=localStorage.getItem('msf_autosave');
    if(saved){
      const state=JSON.parse(saved);
      savedDate=(state.fields&&state.fields.reportDate)||state.reportDate||'';
    }
  }catch{}
  // Only trigger if we have a saved log from a previous day
  if(!savedDate||savedDate===today) return;
  // Show modal
  const el=document.getElementById('nd-prev-date');
  if(el) el.textContent='Last log: '+dlFmtDisplay(savedDate)+' ('+savedDate+')';
  // Show day note reminder if one exists for today
  const dn=dnGet(today);
  const noteBox=document.getElementById('nd-day-note');
  const noteText=document.getElementById('nd-day-note-text');
  if(dn&&dn.note&&noteBox&&noteText){
    noteText.textContent=dn.note;
    noteBox.style.display='block';
  } else if(noteBox){
    noteBox.style.display='none';
  }
  document.getElementById('nd-overlay').style.display='flex';
  // Store the previous date for use in reset handler
  document.getElementById('nd-overlay').dataset.prevDate=savedDate;
}

async function newDayStartFresh(){
  const overlay=document.getElementById('nd-overlay');
  const prevDate=overlay.dataset.prevDate||'';
  overlay.style.display='none';
  // Archive the previous day's log
  if(prevDate) await dlArchive(prevDate);
  // Suppress for today
  const today=localToday();
  localStorage.setItem('pei_newday_suppress',today);
  // Reset form — _resetFormCore sets today's date automatically
  if(typeof db!=='undefined'&&db&&_fbReady){
    try{ await _udb().collection('sessions').doc(_activeProjectId()).delete(); }catch{}
  }
  _resetFormCore();
  setSyncStatus&&setSyncStatus('synced');
}

function newDayKeepContinue(){
  document.getElementById('nd-overlay').style.display='none';
  const today=localToday();
  localStorage.setItem('pei_newday_suppress',today);
}

async function newDayLoadPrevious(){
  const overlay=document.getElementById('nd-overlay');
  const prevDate=overlay.dataset.prevDate||'';
  overlay.style.display='none';
  // Archive current log first
  if(prevDate) await dlArchive(prevDate);
  // Suppress new day for today
  const today=localToday();
  localStorage.setItem('pei_newday_suppress',today);
  // Navigate to calendar
  showPage('calendar');
}

// ═══════════════════════════════════════════
// LOAD LOG SYSTEM
// ═══════════════════════════════════════════

async function dlLoadFromCalendar(date){
  const record = dlGet(date);
  if(!record){ alert('No archived log found for '+date); return; }
  _ldPending = date;
  // Show confirmation modal
  const dateEl = document.getElementById('ld-date');
  const msgEl = document.getElementById('ld-msg');
  if(dateEl) dateEl.textContent = dlFmtDisplay(date)+' ('+date+')';
  if(msgEl) msgEl.textContent = 'Your current log will be archived before loading.';
  document.getElementById('ld-overlay').style.display='flex';
}

async function dlConfirmLoad(){
  document.getElementById('ld-overlay').style.display='none';
  if(!_ldPending) return;
  // Archive current log state before replacing
  const currentDate = document.getElementById('reportDate')?.value||'';
  if(currentDate) await dlArchive(currentDate);
  // Load the selected log
  const record = dlGet(_ldPending);
  if(!record){ _ldPending=null; return; }
  // Track which date we loaded — edited flag set only if user actually changes something
  // Never flag today as edited just because it was auto-archived when loading another day
  const _today = new Date().toLocaleDateString('en-CA');
  window._editingArchivedDate = (record._archivedAt && _ldPending !== _today) ? _ldPending : null;
  // Restore into form
  document.getElementById('crewContainer').innerHTML='';
  window.crewIds=[]; window.crewSeq=0;
  restoreFormState(record);
  try{ localStorage.setItem('msf_autosave', JSON.stringify(record)); }catch{}
  if(typeof db!=='undefined'&&db&&_fbReady){
    try{ await _udb().collection('sessions').doc(_activeProjectId()).set(record); }catch{}
  }
  _ldPending=null;
  showPage('log');
}

function dlCancelLoad(){
  document.getElementById('ld-overlay').style.display='none';
  _ldPending=null;
}

// ── Window exposure ──
window.collectFormState = collectFormState;
window.restoreFormState = restoreFormState;
window.buildCrewHTML = buildCrewHTML;
window.copyJSON = copyJSON;
window._buildAndCopyJSON = _buildAndCopyJSON;
window.fbCopy = fbCopy;
window.downloadLog = downloadLog;
window.fallbackDownload = fallbackDownload;
window._resetFormCore = _resetFormCore;
window.dnGetAll = dnGetAll;
window.dnGet = dnGet;
window.dnSaveLocal = dnSaveLocal;
window.dnSaveCloud = dnSaveCloud;
window.dnLoadCloud = dnLoadCloud;
window.dayNoteOpen = dayNoteOpen;
window.dayNoteSave = dayNoteSave;
window.dayNoteClear = dayNoteClear;
window.dayNoteClose = dayNoteClose;
window.getMyWeather = getMyWeather;
window._applyWeatherData = _applyWeatherData;
window._wmoToDesc = _wmoToDesc;
window.dlGetAll = dlGetAll;
window.dlGet = dlGet;
window.dlSaveLocal = dlSaveLocal;
window.dlArchive = dlArchive;
window.dlFmtDisplay = dlFmtDisplay;
window.localToday = localToday;
window.checkNewDay = checkNewDay;
window.newDayStartFresh = newDayStartFresh;
window.newDayKeepContinue = newDayKeepContinue;
window.newDayLoadPrevious = newDayLoadPrevious;
window.dlLoadFromCalendar = dlLoadFromCalendar;
window.dlConfirmLoad = dlConfirmLoad;
window.dlCancelLoad = dlCancelLoad;

// ── Boot: restore form state after module loads ──
(function dlBoot() {
  // Restore SAVED_DATA (for downloaded HTML files — SAVED_DATA baked in by downloadLog())
  if (window.SAVED_DATA) {
    restoreFormState(window.SAVED_DATA);
    return;
  }
  // Restore autosave
  try {
    const autoSaved = localStorage.getItem('msf_autosave');
    if (autoSaved) {
      const state = JSON.parse(autoSaved);
      restoreFormState(state);
      const banner = document.createElement('div');
      banner.id = 'autosave-banner';
      banner.style.cssText = 'position:fixed;top:56px;left:0;right:0;z-index:999;background:#001a1c;border-bottom:1px solid #006A75;color:#7ab5b8;font-family:monospace;font-size:12px;padding:8px 18px;display:flex;justify-content:space-between;align-items:center;';
      banner.innerHTML = '<span>⟳ Auto-saved session restored — your entries are back.</span><button onclick="document.getElementById(\'autosave-banner\').remove()" style="background:none;border:none;color:#6ecf6e;cursor:pointer;font-size:16px;line-height:1;">✕</button>';
      document.body.prepend(banner);
      setTimeout(() => { const b = document.getElementById('autosave-banner'); if (b) b.remove(); }, 6000);
    }
  } catch {}
})();
