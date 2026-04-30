// ═══════════════════════════════════════════
// TIMESHEET
// ═══════════════════════════════════════════
const TS_DEFAULTS={weekStartDay:0,perDiem:178,mileageRate:0.725,supervisorName:'',hourlyRate:0,payType:'hourly',otType:'daily'};
function tsLoadConfig(){try{const s=localStorage.getItem('msf_ts_config');return s?Object.assign({},TS_DEFAULTS,JSON.parse(s)):Object.assign({},TS_DEFAULTS);}catch{return Object.assign({},TS_DEFAULTS);}}
function tsFormatDate(d){return d.toISOString().split('T')[0];}
function tsParseDate(s){const[y,m,dd]=s.split('-').map(Number);return new Date(y,m-1,dd);}
function tsGetWeekBounds(date){const cfg=tsLoadConfig();const d=new Date(date);d.setHours(0,0,0,0);const diff=(d.getDay()-cfg.weekStartDay+7)%7;const start=new Date(d);start.setDate(d.getDate()-diff);const end=new Date(start);end.setDate(start.getDate()+6);return{start,end};}
function tsWeekDates(start){const dates=[];for(let i=0;i<7;i++){const d=new Date(start);d.setDate(start.getDate()+i);dates.push(d);}return dates;}
function tsDisplayDate(d){const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];return days[d.getDay()]+' '+(d.getMonth()+1)+'/'+d.getDate();}
function tsWeekLabel(s,e){const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return mo[s.getMonth()]+' '+s.getDate()+' – '+mo[e.getMonth()]+' '+e.getDate()+', '+e.getFullYear();}
function tsGetAllEntries(){try{return JSON.parse(localStorage.getItem('msf_ts_entries')||'{}');}catch{return{};}}
function tsGetProjectEntries(){const pn=(JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName)||'';const all=tsGetAllEntries();return Object.fromEntries(Object.entries(all).filter(([,v])=>!v.projectName||v.projectName===pn));}
function tsGetEntry(ds){const entry=tsGetAllEntries()[ds]||null;if(!entry)return null;const pn=(JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName)||'';if(entry.projectName&&entry.projectName!==pn)return null;return entry;}
function tsSaveEntry(ds,data){const entries=tsGetAllEntries();const pn=(JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName)||'';if(!entries[ds])entries[ds]={projectName:pn};else if(!entries[ds].projectName)entries[ds].projectName=pn;entries[ds]=Object.assign(entries[ds],data);localStorage.setItem('msf_ts_entries',JSON.stringify(entries));try{if(typeof db!=='undefined'&&db&&_fbReady){_udb().collection('timesheetEntries').doc(ds).set(entries[ds]).catch(()=>{});}}catch(e){}}
function tsGetAllArchivedWeeks(){try{return JSON.parse(localStorage.getItem('msf_ts_weeks')||'[]');}catch{return[];}}
function tsGetArchivedWeeks(){const pn=(JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName)||'';return tsGetAllArchivedWeeks().filter(w=>!w.projectName||w.projectName===pn);}
function tsSaveArchivedWeeks(w){
  localStorage.setItem('msf_ts_weeks',JSON.stringify(w));
  if(typeof db!=='undefined'&&db&&_fbReady){
    _udb().collection('timesheetMeta').doc('archivedWeeks').set({weeks:w,_ts:Date.now()}).catch(()=>{});
  }
}
function tsSaveConfig(c){
  localStorage.setItem('msf_ts_config',JSON.stringify(c));
  if(typeof db!=='undefined'&&db&&_fbReady){
    _udb().collection('timesheetMeta').doc('config').set(Object.assign({},c,{_ts:Date.now()})).catch(()=>{});
  }
  _saveProjectSettings({tsConfig: c});
}

async function tsLoadFromFirestore(){
  if(!db) return;
  try{
    const weeksDoc=await _udb().collection('timesheetMeta').doc('archivedWeeks').get();
    if(weeksDoc.exists){
      const data=weeksDoc.data();
      const remoteWeeks=data.weeks||[];
      const remoteTs=data._ts||0;
      let localTs=0;
      try{const lw=JSON.parse(localStorage.getItem('msf_ts_weeks')||'[]');localTs=lw._ts||0;}catch{}
      const localWeeks=tsGetAllArchivedWeeks();
      const merged=Object.values(
        [...localWeeks,...remoteWeeks].reduce((acc,w)=>{
          const key=w.weekStart;
          if(!acc[key]||w.archivedAt>(acc[key].archivedAt||0)) acc[key]=w;
          return acc;
        },{})
      ).sort((a,b)=>a.weekStart>b.weekStart?1:-1);
      localStorage.setItem('msf_ts_weeks',JSON.stringify(merged));
      _udb().collection('timesheetMeta').doc('archivedWeeks').set({weeks:merged,_ts:Date.now()}).catch(()=>{});
    }
    const cfgDoc=await _udb().collection('timesheetMeta').doc('config').get();
    if(cfgDoc.exists){
      const remote=cfgDoc.data();
      let localCfg={};
      try{localCfg=JSON.parse(localStorage.getItem('msf_ts_config')||'{}');}catch{}
      const remoteTs=remote._ts||0;
      const localTs=localCfg._ts||0;
      if(remoteTs>localTs){
        const {_ts,...cfg}=remote;
        localStorage.setItem('msf_ts_config',JSON.stringify(cfg));
      }
    }
    const entriesSnap=await _udb().collection('timesheetEntries').get();
    if(!entriesSnap.empty){
      const local=tsGetAllEntries();
      let changed=false;
      entriesSnap.forEach(doc=>{
        const ds=doc.id;
        const rd=doc.data();if(!local[ds]){local[ds]=rd;changed=true;}else if(!local[ds].projectName&&rd.projectName){local[ds].projectName=rd.projectName;changed=true;}
      });
      if(changed) localStorage.setItem('msf_ts_entries',JSON.stringify(local));
    }
  }catch(e){console.warn('Phinest EI: tsLoadFromFirestore failed —',e.message);}
  if(document.getElementById('page-timesheet')?.classList.contains('active')){
    tsRenderCurrentWeek();tsRenderHistory();tsRenderCumulative();
    tsCheckArchivePrompt();
  }
}

function tsCalcMileage(miles){return(miles*tsLoadConfig().mileageRate).toFixed(2);}

function tsPushFromDailyLog(){
  const dateEl=document.getElementById('reportDate');
  if(!dateEl||!dateEl.value)return;
  const ds=dateEl.value;
  const existing=tsGetEntry(ds)||{};
  const update={};
  if(!existing._manualHours){
    const tin=document.getElementById('p-timeIn')?.value||'';
    const tout=document.getElementById('p-timeOut')?.value||'';
    if(tin&&tout){const[ih,im]=tin.split(':').map(Number);const[oh,om]=tout.split(':').map(Number);const hrs=((oh*60+om)-(ih*60+im))/60;if(hrs>0)update.hours=Math.round(hrs*10)/10;}
  }
  if(!existing._manualMiles){
    const s=parseFloat(document.getElementById('p-odoStart')?.value)||0;
    const e=parseFloat(document.getElementById('p-odoEnd')?.value)||0;
    if(e>s)update.miles=Math.round(e-s);
  }
  if(!existing._manualActivity){
    const sum=document.getElementById('inspSummary')?.value?.trim()||'';
    if(sum){const first=sum.split(/[.!?]/)[0].trim();update.activitySummary=first.length>80?first.substring(0,80)+'…':first;}
  }
  if(!existing._manualPerDiem){update.perDiem=tsLoadConfig().perDiem;}
  if(Object.keys(update).length>0)tsSaveEntry(ds,update);
}

function tsRenderCurrentWeek(){
  const today=new Date();today.setHours(0,0,0,0);
  const{start,end}=tsGetWeekBounds(today);
  const dates=tsWeekDates(start);
  const cfg=tsLoadConfig();
  const lbl=document.getElementById('ts-week-label');
  if(lbl)lbl.textContent='Week of '+tsWeekLabel(start,end);
  const todayStr=tsFormatDate(today);
  let totH=0,totM=0,totPD=0,totMil=0;
  let rows='';
  dates.forEach(d=>{
    const ds=tsFormatDate(d);
    const entry=tsGetEntry(ds)||{};
    const isToday=ds===todayStr;
    const hours=entry.hours!==undefined?entry.hours:'';
    const miles=entry.miles!==undefined?entry.miles:'';
    const perDiem=entry.perDiem!==undefined?entry.perDiem:cfg.perDiem;
    const mileage=miles!==''?tsCalcMileage(Number(miles)):'0.00';
    const activity=entry.activitySummary||'';
    if(hours!=='')totH+=Number(hours);
    if(miles!=='')totM+=Number(miles);
    totPD+=Number(perDiem);
    totMil+=parseFloat(mileage);
    rows+=`<tr class="${isToday?'ts-row-today':''}" data-date="${ds}">
      <td class="ts-td-date">${tsDisplayDate(d)}</td>
      <td><input type="number" class="ts-input" value="${hours}" min="0" max="24" step="0.5" style="width:42px" onchange="tsFieldEdit('${ds}','hours',this.value,'_manualHours')"></td>
      <td><input type="number" class="ts-input" value="${perDiem}" min="0" step="1" style="width:50px" onchange="tsFieldEdit('${ds}','perDiem',this.value,'_manualPerDiem')"></td>
      <td><input type="number" class="ts-input" value="${miles}" min="0" step="1" style="width:46px" onchange="tsFieldEdit('${ds}','miles',this.value,'_manualMiles')"></td>
      <td class="ts-td-calc">$${mileage}</td>
      <td><input type="text" class="ts-input" value="${activity}" style="width:100%;min-width:90px" onchange="tsFieldEdit('${ds}','activitySummary',this.value,'_manualActivity')" placeholder="Activity…"></td>
    </tr>`;
  });
  rows+=`<tr class="ts-row-totals"><td>Total</td><td>${totH.toFixed(1)}</td><td>$${totPD.toFixed(0)}</td><td>${totM}</td><td>$${totMil.toFixed(2)}</td><td></td></tr>`;
  const tbody=document.getElementById('ts-week-tbody');
  if(tbody)tbody.innerHTML=rows;
}

function tsFieldEdit(ds,field,value,manualFlag){
  const update={};
  update[field]=isNaN(Number(value))||field==='activitySummary'?value:Number(value);
  update[manualFlag]=true;
  tsSaveEntry(ds,update);
  tsRenderCurrentWeek();
}

function tsRenderHistory(){
  const weeks=tsGetArchivedWeeks();
  const container=document.getElementById('ts-history-list');
  if(!container)return;
  if(weeks.length===0){container.innerHTML='<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px;">No archived weeks yet.</div>';return;}
  const sorted=[...weeks].sort((a,b)=>b.weekStart.localeCompare(a.weekStart));
  container.innerHTML=sorted.map((w,i)=>{
    const s=tsParseDate(w.weekStart),e=tsParseDate(w.weekEnd);
    const t=w.totals||{};
    return`<div class="ts-hist-row">
      <div class="ts-hist-head" onclick="tsToggleHist(${i})">
        <div><div class="ts-hist-label">${tsWeekLabel(s,e)}</div><div class="ts-hist-meta">${t.hours||0} hrs &nbsp;|&nbsp; ${t.miles||0} mi &nbsp;|&nbsp; $${t.mileage||'0.00'}</div></div>
        <div class="ts-hist-chevron" id="ts-chev-${i}">›</div>
      </div>
      <div class="ts-hist-body" id="ts-hb-${i}" style="display:none;">
        <table class="ts-tbl" style="margin-top:8px;">
          <thead><tr><th>Date</th><th>Hrs</th><th>Per Diem</th><th>Miles</th><th>Mil. $</th><th>Activity</th></tr></thead>
          <tbody>${(w.days||[]).map(d=>`<tr><td class="ts-td-date">${d.display||d.date}</td><td>${d.hours||0}</td><td>$${d.perDiem||0}</td><td>${d.miles||0}</td><td class="ts-td-calc">$${d.mileage||'0.00'}</td><td style="font-size:10px;color:var(--muted2);white-space:normal">${d.activitySummary||''}</td></tr>`).join('')}
          <tr class="ts-row-totals"><td>Total</td><td>${t.hours||0}</td><td>$${t.perDiem||0}</td><td>${t.miles||0}</td><td>$${t.mileage||'0.00'}</td><td></td></tr></tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function tsToggleHist(i){
  const b=document.getElementById('ts-hb-'+i),c=document.getElementById('ts-chev-'+i);
  if(!b)return;
  const open=b.style.display!=='none';
  b.style.display=open?'none':'block';
  if(c)c.style.transform=open?'':'rotate(90deg)';
}

function tsRenderCumulative(){
  const weeks=tsGetArchivedWeeks();
  const entries=tsGetProjectEntries();
  const cfg=tsLoadConfig();
  const allLogs=dlGetAll();
  const activePid=_activeProjectId();
  const inProject=date=>{const l=allLogs[date];return !l||!l.projectId||l.projectId===activePid;};
  let totH=0,totM=0,totMil=0,totPD=0,days=0;
  weeks.forEach(w=>{(w.days||[]).forEach(d=>{if(!inProject(d.date))return;totH+=Number(d.hours||0);totM+=Number(d.miles||0);totMil+=parseFloat(d.mileage||0);totPD+=Number(d.perDiem||0);if(Number(d.hours)>0)days++;});});
  Object.entries(entries).forEach(([date,e])=>{if(Number(e.hours)>0&&inProject(date)){totH+=Number(e.hours||0);totM+=Number(e.miles||0);totMil+=parseFloat(tsCalcMileage(Number(e.miles||0)));totPD+=Number(e.perDiem||0);days++;}});
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  set('ts-cum-hours',totH.toFixed(1));
  set('ts-cum-miles',totM.toLocaleString());
  set('ts-cum-mileage','$'+totMil.toFixed(2));
  set('ts-cum-perdiem','$'+totPD.toLocaleString());
  set('ts-cum-days',days+' days worked');
  const rate=parseFloat(cfg.hourlyRate)||0;
  if(rate>0){
    let grossWages=0;
    if(cfg.payType==='salary'){
      grossWages=totH*rate;
    } else {
      if(cfg.otType==='weekly'){
        const regH=Math.min(totH,40);
        const otH=Math.max(totH-40,0);
        grossWages=(regH*rate)+(otH*rate*1.5);
      } else {
        let calcWages=0;
        weeks.forEach(w=>{
          (w.days||[]).forEach(d=>{
            if(!inProject(d.date))return;
            const h=Number(d.hours||0);
            const reg=Math.min(h,8);
            const ot=Math.max(h-8,0);
            calcWages+=(reg*rate)+(ot*rate*1.5);
          });
        });
        Object.entries(entries).forEach(([date,e])=>{
          const h=Number(e.hours||0);
          if(h>0&&inProject(date)){const reg=Math.min(h,8);const ot=Math.max(h-8,0);calcWages+=(reg*rate)+(ot*rate*1.5);}
        });
        grossWages=calcWages;
      }
    }
    set('ts-cum-wages','$'+grossWages.toFixed(2));
    const subLabel=cfg.payType==='salary'?'straight time':(cfg.otType==='daily'?'w/ daily OT':'w/ weekly OT');
    set('ts-cum-wages-sub',subLabel);
  } else {
    set('ts-cum-wages','—');
    set('ts-cum-wages-sub','set hourly rate in settings');
  }
  const sorted=[...weeks].sort((a,b)=>b.weekStart.localeCompare(a.weekStart));
  const tbody=document.getElementById('ts-cum-tbody');
  if(tbody)tbody.innerHTML=sorted.map(w=>{
    const t=w.totals||{};const s=tsParseDate(w.weekStart),e=tsParseDate(w.weekEnd);
    return`<tr><td style="font-size:10px">${(s.getMonth()+1)+'/'+s.getDate()+' – '+(e.getMonth()+1)+'/'+e.getDate()}</td><td>${t.hours||0}</td><td>${t.miles||0}</td><td class="ts-td-calc">$${t.mileage||'0.00'}</td><td>$${t.perDiem||0}</td></tr>`;
  }).join('');
}

function tsArchiveCurrentWeek(){
  _confirmModal('Archive this week and reset? Archived data is always accessible in History.', function(){
    const today=new Date();
    const{start,end}=tsGetWeekBounds(today);
    _tsDoArchive(start,end);
  });
}

function _tsDoArchive(start,end){
  const cfg=tsLoadConfig();
  const pn=(JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName)||'';
  const dates=tsWeekDates(start);
  let totH=0,totM=0,totMil=0,totPD=0;
  const days=dates.map(d=>{
    const ds=tsFormatDate(d);const entry=tsGetEntry(ds)||{};
    const hours=Number(entry.hours||0),miles=Number(entry.miles||0);
    const perDiem=Number(entry.perDiem!==undefined?entry.perDiem:cfg.perDiem);
    const mileage=parseFloat(tsCalcMileage(miles));
    totH+=hours;totM+=miles;totMil+=mileage;totPD+=perDiem;
    return{date:ds,display:tsDisplayDate(d),hours,miles,perDiem,mileage:mileage.toFixed(2),activitySummary:entry.activitySummary||'',expenses:entry.expenses||''};
  });
  const week={weekStart:tsFormatDate(start),weekEnd:tsFormatDate(end),projectName:pn,archivedAt:Date.now(),days,totals:{hours:totH.toFixed(1),miles:totM,mileage:totMil.toFixed(2),perDiem:totPD.toFixed(0)}};
  const allWeeks=tsGetAllArchivedWeeks().filter(w=>w.weekStart!==week.weekStart);
  allWeeks.push(week);
  tsSaveArchivedWeeks(allWeeks);
  const entries=tsGetAllEntries();
  dates.forEach(d=>delete entries[tsFormatDate(d)]);
  localStorage.setItem('msf_ts_entries',JSON.stringify(entries));
  localStorage.removeItem('msf_ts_snooze');
  if(db&&_fbReady)_udb().collection('timesheetWeeks').doc(week.weekStart).set(week).catch(()=>{});
  const banner=document.getElementById('ts-archive-banner');if(banner)banner.remove();
  tsRenderCurrentWeek();tsRenderHistory();tsRenderCumulative();
}

function tsCheckArchivePrompt(){
  if(!_fbReady) return;
  const today=new Date();today.setHours(0,0,0,0);
  const{start}=tsGetWeekBounds(today);
  const prevEnd=new Date(start);prevEnd.setDate(start.getDate()-1);
  const prevStart=new Date(prevEnd);prevStart.setDate(prevEnd.getDate()-6);
  const entries=tsGetAllEntries();
  const prevDates=tsWeekDates(prevStart);
  const hasPrevData=prevDates.some(d=>tsGetEntry(tsFormatDate(d)));
  if(!hasPrevData)return;
  const archived=tsGetArchivedWeeks();
  if(archived.some(w=>w.weekStart===tsFormatDate(prevStart)))return;
  try{
    const snooze=JSON.parse(localStorage.getItem('msf_ts_snooze')||'{}');
    const count=snooze.count||0,last=snooze.last||0;
    if(count>=3){_tsShowArchiveBanner(tsFormatDate(prevStart),tsFormatDate(prevEnd));return;}
    if(count>0&&(Date.now()-last)<86400000)return;
    localStorage.setItem('msf_ts_snooze',JSON.stringify({count:count+1,last:Date.now()}));
    setTimeout(()=>{
      _confirmModal('Week of '+tsWeekLabel(prevStart,prevEnd)+' is complete. Archive and reset?',function(){
        _tsDoArchive(prevStart,prevEnd);
        localStorage.removeItem('msf_ts_snooze');
      });
    },1500);
  }catch{}
}

function _tsShowArchiveBanner(ws,we){
  if(document.getElementById('ts-archive-banner'))return;
  const s=tsParseDate(ws),e=tsParseDate(we);
  const banner=document.createElement('div');
  banner.id='ts-archive-banner';
  banner.style.cssText='position:fixed;top:56px;left:0;right:0;z-index:999;background:var(--s1);border-bottom:1px solid var(--amber);color:var(--amber);font-family:var(--mono);font-size:12px;padding:8px 18px;display:flex;justify-content:space-between;align-items:center;';
  banner.innerHTML=`<span>Week of ${tsWeekLabel(s,e)} not archived — <button onclick="_tsDoArchive(tsParseDate('${ws}'),tsParseDate('${we}'))" style="background:none;border:none;color:var(--green);cursor:pointer;font-family:var(--mono);font-size:12px;text-decoration:underline;">archive now</button></span><button onclick="document.getElementById('ts-archive-banner').remove()" style="background:none;border:none;color:var(--muted2);cursor:pointer;font-size:16px;">✕</button>`;
  document.body.prepend(banner);
}

function tsShowView(v){
  ['week','history','cumul'].forEach(id=>{
    document.getElementById('ts-view-'+id).style.display='none';
    document.getElementById('ts-btn-'+id).classList.remove('active');
  });
  document.getElementById('ts-view-'+v).style.display='block';
  document.getElementById('ts-btn-'+v).classList.add('active');
  if(v==='week'){tsPushFromDailyLog();tsRenderCurrentWeek();}
  if(v==='history')tsRenderHistory();
  if(v==='cumul')tsRenderCumulative();
}

function saveTsConfig(){
  const cfg={
    weekStartDay:parseInt(document.getElementById('cfg-ts-weekstart')?.value)||0,
    perDiem:parseFloat(document.getElementById('cfg-ts-perdiem')?.value)||178,
    mileageRate:parseFloat(document.getElementById('cfg-ts-mileage')?.value)||0.725,
    supervisorName:document.getElementById('cfg-ts-supervisor')?.value.trim()||'',
    hourlyRate:parseFloat(document.getElementById('cfg-ts-hourlyrate')?.value)||0,
    payType:document.getElementById('cfg-ts-paytype')?.value||'hourly',
    otType:document.getElementById('cfg-ts-ottype')?.value||'daily'
  };
  tsSaveConfig(cfg);
  const st=document.getElementById('cfg-ts-status');
  if(st){st.textContent='✓ Saved';st.style.opacity='1';setTimeout(()=>st.style.opacity='0',2500);}
  tsRenderCurrentWeek();
  tsRenderCumulative();
}

function tsToggleOTWrap(){
  const pt=document.getElementById('cfg-ts-paytype')?.value;
  const wrap=document.getElementById('cfg-ts-ot-wrap');
  if(wrap) wrap.style.display=(pt==='hourly')?'':'none';
}

function toggleMoreMenu(){
  const overlay=document.getElementById('more-overlay');
  const panel=document.getElementById('more-panel');
  const isOpen=panel.classList.contains('open');
  if(isOpen){closeMoreMenu();}else{overlay.classList.add('open');panel.classList.add('open');document.getElementById('tab-more').classList.add('active');}
}
function closeMoreMenu(){
  document.getElementById('more-overlay').classList.remove('open');
  document.getElementById('more-panel').classList.remove('open');
  const active=document.querySelector('.page.active');
  const name=active?active.id.replace('page-',''):'log';
  const inSlot=_navSlots.includes(name);
  document.getElementById('tab-more').classList.toggle('active',!inSlot);
}

function tsInit(){
  tsPushFromDailyLog();
  tsRenderCurrentWeek();
  tsCheckArchivePrompt();
}

// ── Backfill / update a week snapshot from archived daily logs ──
function tsBackfillWeekFromLogs(date){
  const today=localToday();
  const{start:curStart}=tsGetWeekBounds(tsParseDate(today));
  const{start,end}=tsGetWeekBounds(tsParseDate(date));
  if(tsFormatDate(start)===tsFormatDate(curStart)) return;
  const cfg=tsLoadConfig();
  const dates=tsWeekDates(start);
  let totH=0,totM=0,totMil=0,totPD=0;
  const days=dates.map(d=>{
    const ds=tsFormatDate(d);
    const tsEntry=tsGetEntry(ds)||{};
    let hours=Number(tsEntry.hours||0);
    let miles=Number(tsEntry.miles||0);
    let activitySummary=tsEntry.activitySummary||'';
    if(!hours&&!miles){
      const log=dlGet(ds);
      if(log){
        const f=log.fields||{};
        const tin=f['p-timeIn']||''; const tout=f['p-timeOut']||'';
        const os=parseFloat(f['p-odoStart']||0); const oe=parseFloat(f['p-odoEnd']||0);
        if(tin&&tout){
          const[h1,m1]=tin.split(':').map(Number);
          const[h2,m2]=tout.split(':').map(Number);
          const diff=((h2*60+m2)-(h1*60+m1))/60;
          if(diff>0) hours=Math.round(diff*10)/10;
        }
        if(oe>os) miles=oe-os;
        if(!activitySummary&&f.activePhase) activitySummary=f.activePhase;
      }
    }
    const perDiem=Number(tsEntry.perDiem!==undefined?tsEntry.perDiem:cfg.perDiem);
    const mileage=parseFloat(tsCalcMileage(miles));
    totH+=hours; totM+=miles; totMil+=mileage; totPD+=perDiem;
    return{date:ds,display:tsDisplayDate(d),hours,miles,perDiem,mileage:mileage.toFixed(2),activitySummary,expenses:tsEntry.expenses||''};
  });
  const hasData=days.some(d=>d.hours>0||d.miles>0);
  if(!hasData) return;
  const weekStart=tsFormatDate(start);
  const weekEnd=tsFormatDate(end);
  const existing=tsGetAllArchivedWeeks();
  const idx=existing.findIndex(w=>w.weekStart===weekStart);
  const week={
    weekStart,weekEnd,
    projectName:(JSON.parse(localStorage.getItem('msf_projectconfig')||'{}').projectName)||'',
    archivedAt: idx>=0 ? existing[idx].archivedAt : Date.now(),
    _backfilled: true,
    days,
    totals:{hours:totH.toFixed(1),miles:totM,mileage:totMil.toFixed(2),perDiem:totPD.toFixed(0)}
  };
  if(idx>=0) existing[idx]=week; else existing.push(week);
  existing.sort((a,b)=>a.weekStart>b.weekStart?1:-1);
  tsSaveArchivedWeeks(existing);
}

// ═══════════════════════════════════════════
// WINDOW EXPOSURE
// ═══════════════════════════════════════════
window.tsLoadConfig = tsLoadConfig;
window.tsFormatDate = tsFormatDate;
window.tsParseDate = tsParseDate;
window.tsGetAllEntries = tsGetAllEntries;
window.tsGetEntry = tsGetEntry;
window.tsSaveEntry = tsSaveEntry;
window.tsGetAllArchivedWeeks = tsGetAllArchivedWeeks;
window.tsGetArchivedWeeks = tsGetArchivedWeeks;
window.tsSaveArchivedWeeks = tsSaveArchivedWeeks;
window.tsSaveConfig = tsSaveConfig;
window.tsLoadFromFirestore = tsLoadFromFirestore;
window.tsCalcMileage = tsCalcMileage;
window.tsPushFromDailyLog = tsPushFromDailyLog;
window.tsRenderCurrentWeek = tsRenderCurrentWeek;
window.tsFieldEdit = tsFieldEdit;
window.tsRenderHistory = tsRenderHistory;
window.tsToggleHist = tsToggleHist;
window.tsRenderCumulative = tsRenderCumulative;
window.tsArchiveCurrentWeek = tsArchiveCurrentWeek;
window._tsDoArchive = _tsDoArchive;
window.tsCheckArchivePrompt = tsCheckArchivePrompt;
window._tsShowArchiveBanner = _tsShowArchiveBanner;
window.tsShowView = tsShowView;
window.saveTsConfig = saveTsConfig;
window.tsToggleOTWrap = tsToggleOTWrap;
window.toggleMoreMenu = toggleMoreMenu;
window.closeMoreMenu = closeMoreMenu;
window.tsInit = tsInit;
window.tsBackfillWeekFromLogs = tsBackfillWeekFromLogs;

// ═══════════════════════════════════════════
// BOOT CALLS
// ═══════════════════════════════════════════
tsInit();
