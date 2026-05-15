// ═══════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════

// ── Calendar view state ──
let _calView = 'grid';
let _calYear = new Date().getFullYear();
let _calMonth = new Date().getMonth();

// ── E2.5: does this daily-log record represent actual user activity? ──
// "Start new day" creates a default-state record before the user enters anything
// (see calOpenNewDay). That empty shell shouldn't render as has-log on the
// calendar grid. Returns true only if the user has entered narrative content,
// time on site, mileage, crew data, or flagged any items. Auto-fetched weather
// + project metadata alone do NOT count as "logged."
function _calHasContent(rec){
  if(!rec) return false;
  const f=rec.fields||{};
  // Time on site / mileage / personal notes
  if(f['p-timeIn']||f['p-timeOut']||f['p-odoStart']||f['p-odoEnd']) return true;
  if((f['p-notes']||'').trim()) return true;
  // Narrative fields the user actually fills
  const narrative=['inspSummary','agencyInsp','landowner','rte','nonCompliance','genComms','lookahead','contractor'];
  if(narrative.some(k=>(f[k]||'').trim())) return true;
  // Crew blocks with any content
  if(Array.isArray(rec.crew)&&rec.crew.some(b=>
    (b.name||'').trim()||(b.time||'').trim()||(b.loc||'').trim()||
    (b.acts||'').trim()||(b.envcomp||'').trim()||(b.issues||'').trim()||(b.notes||'').trim()
  )) return true;
  // Any flag manually checked
  if(rec.checkboxes&&Object.values(rec.checkboxes).some(v=>v===true)) return true;
  return false;
}

function calGetIndicators(record){
  const indicators=[];
  if(record._edited) indicators.push('<span title="Edited after archive">⚠️</span>');
  else indicators.push('<span style="color:var(--green)" title="Log saved">●</span>');
  try{
    const cl=JSON.parse(localStorage.getItem('cl_entries')||'[]');
    const hasComp=cl.some(e=>e.date===record._archivedDate);
    if(hasComp) indicators.push('<span title="Compliance entries">❗</span>');
  }catch{}
  try{
    const ph=JSON.parse(localStorage.getItem('ph_photos')||'[]');
    const hasPh=ph.some(p=>(p.date||'').startsWith(record._archivedDate));
    if(hasPh) indicators.push('<span title="Photos">📸</span>');
  }catch{}
  const f=record.fields||{};
  const tin=f['p-timeIn']||''; const tout=f['p-timeOut']||'';
  if(tin&&tout) indicators.push('<span title="Hours logged">🕒</span>');
  // Active-project scoped: indicators reflect THIS project's timesheet
  // entry for that date. With multi-project state isolation (E1.1 Option C),
  // a different project's entry on the same date doesn't surface here.
  const _calPid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  try{
    const trEntries=(typeof trGetEntriesForDate==='function')?trGetEntriesForDate(record._archivedDate||'',_calPid):[];
    if(trEntries.length) indicators.push('<span title="Tracker entries">📍</span>');
  }catch{}
  const tsE=tsGetEntry(record._archivedDate||'',_calPid);
  if(tsE&&tsE.miles){
    indicators.push('<span title="Miles logged">🚚</span>');
  } else {
    const os=parseFloat(f['p-odoStart']||0); const oe=parseFloat(f['p-odoEnd']||0);
    if(os&&oe&&oe>os) indicators.push('<span title="Miles logged">🚚</span>');
  }
  return indicators.join('');
}

async function calLoadCloud(){
  try{
    if(typeof db==='undefined'||!db||!_fbReady) return;
    const snap=await _udb().collection('dailyLogs').get();
    if(snap.empty) return;
    const all=dlGetAll();
    snap.forEach(doc=>{ if(!all[doc.id]) all[doc.id]=doc.data(); });
    localStorage.setItem('pei_daily_logs',JSON.stringify(all));
  }catch{}
}

async function calRender(){
  await calLoadCloud();
  await _glMigrateDailyLogsPhaseD();
  await _fixDailyLogProjectsByDate();
  await _fixOrphanLogProjectIds();
  _fixTimesheetEntryProjects();
  await dnLoadCloud();
  document.getElementById('cal-day-view').style.display='none';
  document.getElementById('cal-view-toggle').style.display='flex';
  const now=new Date();
  _calYear=now.getFullYear(); _calMonth=now.getMonth();
  calSetView(_calView);
}

function calOpenDay(date){
  const rec=dlGet(date);
  if(!rec) return;
  document.getElementById('cal-grid-view').style.display='none';
  document.getElementById('cal-list-view').style.display='none';
  document.getElementById('cal-view-toggle').style.display='none';
  document.getElementById('cal-day-view').style.display='block';

  const title=document.getElementById('cal-day-title');
  if(title){
    const indicators=calGetDotIndicators(rec);
    const projectName=(rec.fields&&rec.fields.projectName||'').trim();
    const projectPill=projectName
      ? '<span style="display:inline-block;margin-left:10px;padding:2px 8px;background:rgba(201,160,39,.12);border:1px solid rgba(201,160,39,.4);border-radius:10px;font-family:var(--mono);font-size:9px;color:var(--amber);letter-spacing:.04em;text-transform:none;vertical-align:middle">'+projectName+'</span>'
      : '';
    title.innerHTML=dlFmtDisplay(date)+projectPill+'<span style="margin-left:10px;font-size:13px;vertical-align:middle">'+indicators+'</span>';
  }
  const content=document.getElementById('cal-day-content');
  if(!content) return;

  const f=rec.fields||{};
  let tin='—', tout='—', hours='—', miles='—';
  try{
    const _dayPid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
    const tsEntry=tsGetEntry(date,_dayPid);
    if(tsEntry){
      if(tsEntry.hours) hours=tsEntry.hours+' hrs';
      if(tsEntry.miles) miles=tsEntry.miles+' mi';
    }
  }catch{}
  if(f['p-timeIn']) tin=f['p-timeIn'];
  if(f['p-timeOut']) tout=f['p-timeOut'];
  if(miles==='—'){
    const os=parseFloat(f['p-odoStart']||0); const oe=parseFloat(f['p-odoEnd']||0);
    if(oe>os) miles=(oe-os)+' mi';
  }

  let weather='—';
  try{
    const sky=Array.isArray(rec.sky)?rec.sky.join(', '):(rec.sky||'');
    const parts=[
      sky||'',
      f.tempAM?f.tempAM+'° AM':'',
      f.tempPM?f.tempPM+'° PM':'',
      f.wind?'Wind: '+f.wind:'',
      f.precip?'Precip: '+f.precip+'"':''
    ].filter(Boolean);
    weather=parts.join(' · ')||'—';
  }catch{}

  const summary=(f.inspSummary||f.inspectionSummary||'').trim()||'No summary recorded.';
  const contractor=(f.contractor||'—');

  let compSection='';
  try{
    const cl=JSON.parse(localStorage.getItem('cl_entries')||'[]');
    const entries=cl.filter(e=>e.date===date);
    if(entries.length>0){
      const levelLabel={1:'L1 — Observation',2:'L2 — Corrective Action',3:'L3 — Non-Compliance',4:'L4 — Stop Work'};
      const levelColor={1:'var(--muted2)',2:'var(--amber)',3:'#e67e22',4:'var(--red)'};
      const rows=entries.map(e=>`
        <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span style="font-family:var(--mono);font-size:9px;color:${levelColor[e.level]||'var(--muted)'};white-space:nowrap;padding-top:1px">${levelLabel[e.level]||'L?'}</span>
          <span style="font-family:var(--body);font-size:12px;color:var(--text);flex:1">${e.location||'No description'}</span>
          <span style="font-family:var(--mono);font-size:9px;color:var(--muted2);white-space:nowrap;cursor:pointer;text-decoration:underline" onclick="showPage('compliance')" title="View in compliance log">${e.status||''}</span>
        </div>`).join('');
      compSection=`<div class="cal-day-section" style="flex-direction:column;align-items:flex-start">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;width:100%">
          <div class="cal-day-icon">❗</div>
          <div class="cal-day-label">Compliance — ${entries.length} entr${entries.length===1?'y':'ies'}</div>
        </div>
        <div style="width:100%;padding-left:32px">${rows}</div>
      </div>`;
    }
  }catch{}

  let photoSection='';
  try{
    const ph=JSON.parse(localStorage.getItem('ph_photos')||'[]');
    const dayPhotos=ph.filter(p=>(p.date||'').startsWith(date));
    if(dayPhotos.length>0){
      const thumbs=dayPhotos.slice(0,6).map(p=>
        p.thumb?`<img src="${p.thumb}" style="width:52px;height:52px;object-fit:cover;border-radius:5px;border:1px solid var(--border);cursor:pointer" onclick="showPage('photos')" title="${p.caption||''}">`
               :`<div style="width:52px;height:52px;background:var(--s2);border-radius:5px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px">📸</div>`
      ).join('');
      const extra=dayPhotos.length>6?`<div style="font-family:var(--mono);font-size:10px;color:var(--muted);align-self:center">+${dayPhotos.length-6} more</div>`:'';
      photoSection=`<div class="cal-day-section" style="flex-direction:column;align-items:flex-start">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;width:100%">
          <div class="cal-day-icon">📸</div>
          <div class="cal-day-label">Photos — ${dayPhotos.length}</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;padding-left:32px">${thumbs}${extra}</div>
      </div>`;
    }
  }catch{}

  let editSection='';
  if(rec._edited&&rec._editLog&&rec._editLog.length>0){
    const entries=rec._editLog.map(e=>{
      const dt=new Date(e.at);
      return `<div style="padding:3px 0;border-bottom:1px solid var(--border)">${dt.toLocaleDateString()+' '+dt.toLocaleTimeString()} — <strong>${e.by}</strong>: ${e.action}</div>`;
    }).join('');
    editSection=`<div class="cal-day-section" style="flex-direction:column;align-items:flex-start">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;width:100%">
        <div class="cal-day-icon">⚠️</div>
        <div class="cal-day-label">Edited After Archive <span class="cal-edit-badge">MODIFIED</span></div>
      </div>
      <div class="cal-edit-log" style="width:100%;margin-left:32px">${entries}</div>
    </div>`;
  }

  content.innerHTML=`
    <div class="cal-day-card">
      <div class="cal-day-section">
        <div class="cal-day-icon">🏗️</div>
        <div><div class="cal-day-label">Contractor</div><div class="cal-day-val">${contractor}</div></div>
      </div>
      <div class="cal-day-section">
        <div class="cal-day-icon">🌤️</div>
        <div><div class="cal-day-label">Weather</div><div class="cal-day-val">${weather}</div></div>
      </div>
      <div class="cal-day-section">
        <div class="cal-day-icon">🕒</div>
        <div>
          <div class="cal-day-label">Time on Site</div>
          <div class="cal-day-val">${tin} – ${tout}${hours!=='—'?' &nbsp;·&nbsp; <strong>'+hours+'</strong>':''}</div>
        </div>
      </div>
      <div class="cal-day-section">
        <div class="cal-day-icon">🚚</div>
        <div><div class="cal-day-label">Miles Driven</div><div class="cal-day-val">${miles}</div></div>
      </div>
      <div class="cal-day-section">
        <div class="cal-day-icon">📋</div>
        <div><div class="cal-day-label">Inspection Summary</div><div class="cal-day-val" style="white-space:pre-line">${summary.length>300?summary.substring(0,300)+'…':summary}</div></div>
      </div>
      ${compSection}
      ${photoSection}
      ${editSection}
    </div>
    <button class="btn btn-amber" style="width:100%;margin-top:8px;padding:13px;font-size:13px" onclick="dlLoadFromCalendar('${date}')">
      📂 Load This Log into Form
    </button>`;
  calRenderDayViewGrid();
}

function _toggleProjectFilter() {
  _projectFilterActive = !_projectFilterActive;
  const label = _projectFilterActive ? '🏗️ Active Project' : '🌐 All Projects';
  ['ph-proj-filter-btn','cal-proj-filter-btn','cl-proj-filter-btn'].forEach(function(id){
    const btn = document.getElementById(id);
    if(!btn) return;
    btn.textContent = label;
    btn.classList.toggle('btn-proj-active', _projectFilterActive);
  });
  phRender();
  clRender();
  calSetView(_calView);
}

function calSetView(v){
  _calView = v;
  document.getElementById('cal-grid-view').style.display = v==='grid' ? 'block' : 'none';
  document.getElementById('cal-list-view').style.display = v==='list' ? 'block' : 'none';
  document.getElementById('cal-toggle-grid').classList.toggle('active', v==='grid');
  document.getElementById('cal-toggle-list').classList.toggle('active', v==='list');
  if(v==='grid') calRenderGrid();
  if(v==='list') calRenderList();
}

function calMonthNav(dir){
  _calMonth += dir;
  if(_calMonth < 0){ _calMonth=11; _calYear--; }
  if(_calMonth > 11){ _calMonth=0; _calYear++; }
  calRenderGrid();
}

function calDayViewMonthNav(dir){
  _calMonth += dir;
  if(_calMonth < 0){ _calMonth=11; _calYear--; }
  if(_calMonth > 11){ _calMonth=0; _calYear++; }
  calRenderDayViewGrid();
}

function calRenderDayViewGrid(){
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const label=document.getElementById('cal-dv-month-label');
  if(label) label.textContent=months[_calMonth]+' '+_calYear;
  const body=document.getElementById('cal-dv-grid-body');
  if(!body) return;
  const all=dlGetAll();
  const today=localToday();
  const firstDay=new Date(_calYear,_calMonth,1).getDay();
  const daysInMonth=new Date(_calYear,_calMonth+1,0).getDate();
  let cells='';
  for(let i=0;i<firstDay;i++){
    cells+=`<div class="cal-cell empty"><div class="cal-cell-num"></div></div>`;
  }
  for(let d=1;d<=daysInMonth;d++){
    const mm=String(_calMonth+1).padStart(2,'0');
    const dd=String(d).padStart(2,'0');
    const dateStr=`${_calYear}-${mm}-${dd}`;
    const rec=all[dateStr]||null;
    const isToday=dateStr===today;
    if(rec&&_calHasContent(rec)){
      cells+=`<div class="cal-cell has-log${isToday?' today':''}" onclick="calOpenDay('${dateStr}')">
        <div class="cal-cell-num">${d}</div>
        <div class="cal-cell-dots">${calGetDotIndicators(rec)}</div>
      </div>`;
    } else {
      const isPast=dateStr<=today;
      if(isPast){
        cells+=`<div class="cal-cell no-log${isToday?' today':''}" style="cursor:pointer;opacity:0.5" onclick="calOpenNewDay('${dateStr}')" title="Start log for this day">
          <div class="cal-cell-num">${d}</div>
        </div>`;
      } else {
        const dn=dnGet(dateStr);
        cells+=`<div class="cal-cell no-log" style="cursor:pointer" onclick="dayNoteOpen('${dateStr}')" title="Add note for this day">
          <div class="cal-cell-num">${d}</div>
          ${dn?'<div class="cal-cell-dots"><span class="cal-dot" title="Day note">📝</span></div>':''}
        </div>`;
      }
    }
  }
  body.innerHTML=cells;
}

function calGetDotIndicators(record){
  const dots=[];
  if(record._edited) dots.push('<span class="cal-dot" title="Edited">⚠️</span>');
  else dots.push('<span class="cal-dot" style="color:var(--green)" title="Log saved">●</span>');
  try{
    const cl=JSON.parse(localStorage.getItem('cl_entries')||'[]');
    if(cl.some(e=>e.date===record._archivedDate)) dots.push('<span class="cal-dot" title="Compliance">❗</span>');
  }catch{}
  try{
    const ph=JSON.parse(localStorage.getItem('ph_photos')||'[]');
    if(ph.some(p=>(p.date||'').startsWith(record._archivedDate))) dots.push('<span class="cal-dot" title="Photos">📸</span>');
  }catch{}
  const tin=record.p_timeIn||''; const tout=record.p_timeOut||'';
  if(tin&&tout) dots.push('<span class="cal-dot" title="Hours">🕒</span>');
  const os=parseFloat(record.p_odoStart||0); const oe=parseFloat(record.p_odoEnd||0);
  if(os&&oe&&oe>os) dots.push('<span class="cal-dot" title="Miles">🚚</span>');
  return dots.join('');
}

function calRenderGrid(){
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const label=document.getElementById('cal-month-label');
  if(label) label.textContent=months[_calMonth]+' '+_calYear;
  const body=document.getElementById('cal-grid-body');
  if(!body) return;
  const _allLogs=dlGetAll();
  const all=_projectFilterActive
    ? Object.fromEntries(Object.entries(_allLogs).filter(([,v])=> !v.projectId || v.projectId===_activeProjectId()))
    : _allLogs;
  const today=localToday();
  const firstDay=new Date(_calYear,_calMonth,1).getDay();
  const daysInMonth=new Date(_calYear,_calMonth+1,0).getDate();
  let cells='';
  for(let i=0;i<firstDay;i++){
    cells+=`<div class="cal-cell empty"><div class="cal-cell-num"></div></div>`;
  }
  for(let d=1;d<=daysInMonth;d++){
    const mm=String(_calMonth+1).padStart(2,'0');
    const dd=String(d).padStart(2,'0');
    const dateStr=`${_calYear}-${mm}-${dd}`;
    const rec=all[dateStr]||null;
    const isToday=dateStr===today;
    if(rec&&_calHasContent(rec)){
      cells+=`<div class="cal-cell has-log${isToday?' today':''}" onclick="calOpenDay('${dateStr}')">
        <div class="cal-cell-num">${d}</div>
        <div class="cal-cell-dots">${calGetDotIndicators(rec)}</div>
      </div>`;
    } else {
      const isPast=dateStr<=today;
      if(isPast){
        cells+=`<div class="cal-cell no-log${isToday?' today':''}" style="cursor:pointer;opacity:0.5" onclick="calOpenNewDay('${dateStr}')" title="Start log for this day">
          <div class="cal-cell-num">${d}</div>
        </div>`;
      } else {
        const dn=dnGet(dateStr);
        cells+=`<div class="cal-cell no-log" style="cursor:pointer" onclick="dayNoteOpen('${dateStr}')" title="Add note for this day">
          <div class="cal-cell-num">${d}</div>
          ${dn?'<div class="cal-cell-dots"><span class="cal-dot" title="Day note">📝</span></div>':''}
        </div>`;
      }
    }
  }
  body.innerHTML=cells;
}

function calRenderList(){
  const _allLogsL=dlGetAll();
  const all=_projectFilterActive
    ? Object.fromEntries(Object.entries(_allLogsL).filter(([,v])=> !v.projectId || v.projectId===_activeProjectId()))
    : _allLogsL;
  // E2.5: filter out "empty new day" records that have no actual user content
  const dates=Object.keys(all).filter(d=>_calHasContent(all[d])).sort((a,b)=>b.localeCompare(a));
  const list=document.getElementById('cal-list');
  const empty=document.getElementById('cal-empty');
  const count=document.getElementById('cal-count');
  if(!list) return;
  if(dates.length===0){
    list.innerHTML=''; if(empty)empty.style.display='block';
    if(count)count.textContent='';
    return;
  }
  if(empty)empty.style.display='none';
  if(count)count.textContent=dates.length+' day'+(dates.length===1?'':'s');
  list.innerHTML=dates.map(date=>{
    const rec=all[date];
    const rf=rec.fields||{};
    const summary=(rf.inspSummary||rf.inspectionSummary||'').trim().replace(/\r?\n.*/,'').split(/[.!?]/)[0].trim();
    const displaySummary=summary.length>60?summary.substring(0,60)+'…':summary||'No summary';
    return `<div class="cal-row" onclick="calOpenDay('${date}')">
      <div class="cal-row-date">${dlFmtDisplay(date)}</div>
      <div class="cal-row-summary">${displaySummary}</div>
      <div class="cal-row-indicators">${calGetIndicators(rec)}</div>
    </div>`;
  }).join('');
}

function calOpenNewDay(date){
  const today=localToday();
  _confirmModal('No log exists for '+dlFmtDisplay(date)+'. Start a new log for this day?', function(){
    _resetFormCore();
    const el=document.getElementById('reportDate');
    if(el){ el.value=date; }
    const isBackdated = date < today;
    const record = Object.assign(collectFormState(),{
      _archivedDate: date,
      _archivedAt: Date.now(),
      _edited: isBackdated,
      _editLog: isBackdated ? [{at:Date.now(), by:'EI', action:'Backdated log created'}] : []
    });
    dlSaveLocal(date, record);
    showPage('log');
  });
  setTimeout(function(){
    const btn=document.getElementById('_mok');
    if(btn) btn.textContent='Start Log';
  },10);
}

function calCloseDayView(){
  document.getElementById('cal-day-view').style.display='none';
  document.getElementById('cal-view-toggle').style.display='flex';
  calSetView(_calView);
}

// ═══════════════════════════════════════════
// WINDOW EXPOSURE
// ═══════════════════════════════════════════
window.calRender = calRender;
window.calLoadCloud = calLoadCloud;
window.calOpenDay = calOpenDay;
window.calCloseDayView = calCloseDayView;
window.calOpenNewDay = calOpenNewDay;
window._toggleProjectFilter = _toggleProjectFilter;
window.calSetView = calSetView;
window.calMonthNav = calMonthNav;
window.calDayViewMonthNav = calDayViewMonthNav;
window.calRenderDayViewGrid = calRenderDayViewGrid;
window.calGetDotIndicators = calGetDotIndicators;
window.calGetIndicators = calGetIndicators;
window.calRenderGrid = calRenderGrid;
window.calRenderList = calRenderList;
