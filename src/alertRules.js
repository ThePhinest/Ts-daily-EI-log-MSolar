// ═══════════════════════════════════════════
// ⚡ ALERT RULES — user-controlled triggers (delta #114, design locked with Tim 9/2)
// ═══════════════════════════════════════════
//
// "Give automatic priority alert when there's above 0.5" of rain… could have this as a
// setting for other items too" (8/23) + "make sure the user CONTROLS the parameters" (8/29, 9/2).
//
// Two scopes (Tim 9/2):
//   PROJECT rules  projects/{pid}/config/alertRules      lead-only write (existing config rule),
//                                                        every member receives them
//   PERSONAL rules users/{uid}/projects/{pid}/settings/alertRules   anyone, own use only
//   Device mutes   localStorage gl_alert_mute_<pid>       any member can silence a project rule
//                                                        on THIS device without editing it
// v1 delivery is LOCAL (Tim 9/2): a fired rule becomes a ⚡ PRIORITY Open Item (deduped per rule
// per day through the spine's any-state source/sourceRef) plus a one-off local notification
// on the iOS app. True server push (alerts while the app is closed) is its own delta item.
//
// Rule shape: { id, type, label, on, threshold (in), maxDays, days:[0-6], time:'HH:MM', createdBy, createdAt }
// Loader follows the config-loader pattern (await idbReady, cloud-checked, newest updatedAtMs wins,
// never write before the cloud check) — see project_config_loader_pattern.

const AR_TYPES={
  'rain-observed':     {icon:'🌧', label:'Rain observed at the site',   hint:'IEMRE radar + gauge rainfall for the project site (yesterday / today) at or over the threshold'},
  'rain-forecast':     {icon:'🌦', label:'Rain in the forecast',        hint:'Open-Meteo 7-day outlook shows a day at or over the threshold'},
  'inspection-overdue':{icon:'📋', label:'SWPPP inspection overdue',    hint:'No SWPPP inspection recorded within the last N days'},
  'weekday':           {icon:'📅', label:'Weekday reminder',            hint:'A repeating priority reminder on the days and time you pick'}
};
const AR_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

var _arProj={}, _arPers={}, _arProjChecked={}, _arPersChecked={}, _arLoading={};
var _arWx={};          // pid → {week:[{d,r,p}], past:{days:[{d,r,partial}]}}
var _arEditing=null;   // {scope, id|null}

function _arPid(){ return (typeof _activeProjectId==='function')?_activeProjectId():'default'; }
function _arUid(){ return (typeof _currentUser!=='undefined'&&_currentUser)?_currentUser.uid:null; }
function _arEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function _arId(){ return 'ar-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function _arToday(){ return (typeof window.localToday==='function')?window.localToday():new Date().toLocaleDateString('en-CA'); }
function _arAddDays(ds,n){ const d=new Date(ds+'T12:00:00'); d.setDate(d.getDate()+n); return d.toLocaleDateString('en-CA'); }
function _arIsLead(pid){ return (typeof glMyRoleFor==='function')?glMyRoleFor(pid)==='lead':true; }
function _arCanPersonal(pid){ return !!_arUid(); }

// ── mutes (device pref) ──
function _arMutes(pid){ try{ return new Set(JSON.parse(localStorage.getItem('gl_alert_mute_'+pid)||'[]')); }catch{ return new Set(); } }
function _arSetMute(pid,id,on){
  const m=_arMutes(pid); if(on) m.add(id); else m.delete(id);
  try{ localStorage.setItem('gl_alert_mute_'+pid, JSON.stringify([...m])); }catch{}
}

// ── loaders ──
async function _arLoadDoc(kind,pid){
  const cache=kind==='proj'?_arProj:_arPers, checked=kind==='proj'?_arProjChecked:_arPersChecked;
  const key='ar_'+kind+'::'+pid+(kind==='pers'?('::'+(_arUid()||'anon')):'');
  try{ if(window.idbReady) await window.idbReady; }catch(_){}
  let local=null; try{ local=(typeof idbGet==='function')?(idbGet(key)||null):null; }catch(_){}
  if(cache[pid]===undefined||(cache[pid]===null&&local)) cache[pid]=local;
  if(typeof db!=='undefined'&&db&&typeof _fbReady!=='undefined'&&_fbReady&&_arUid()){
    try{
      const ref=kind==='proj'
        ? db.collection('projects').doc(pid).collection('config').doc('alertRules')
        : _udb().collection('projects').doc(pid).collection('settings').doc('alertRules');
      const snap=await ref.get();
      if(snap.exists){
        const cloud=snap.data(); const cur=cache[pid];
        if(!cur||((cloud.updatedAtMs||0)>=(cur.updatedAtMs||0))){ cache[pid]=cloud; try{ idbSet(key,cloud); }catch(_){} }
      }
      checked[pid]=true;
    }catch(e){ console.warn('alertRules load ('+kind+') failed:',e.message); }
  }
  return cache[pid];
}
async function arEnsure(pid){
  pid=pid||_arPid();
  if(pid==='default') return;
  if(_arProjChecked[pid]&&_arPersChecked[pid]) return;
  if(_arLoading[pid]) return _arLoading[pid];
  _arLoading[pid]=(async()=>{ try{ await Promise.all([_arLoadDoc('proj',pid),_arLoadDoc('pers',pid)]); } finally{ delete _arLoading[pid]; } })();
  return _arLoading[pid];
}
function _arRules(kind,pid){ const c=(kind==='proj'?_arProj:_arPers)[pid]; return (c&&Array.isArray(c.rules))?c.rules:[]; }
async function _arSave(kind,pid,rules){
  const cache=kind==='proj'?_arProj:_arPers;
  const doc={rules, updatedAtMs:Date.now(), updatedBy:_arUid()||null};
  cache[pid]=doc;
  const key='ar_'+kind+'::'+pid+(kind==='pers'?('::'+(_arUid()||'anon')):'');
  try{ idbSet(key,doc); }catch(_){}
  if(typeof db!=='undefined'&&db&&_fbReady&&_arUid()){
    try{
      const ref=kind==='proj'
        ? db.collection('projects').doc(pid).collection('config').doc('alertRules')
        : _udb().collection('projects').doc(pid).collection('settings').doc('alertRules');
      await ref.set(doc);
    }catch(e){ console.warn('alertRules save failed:',e.message); if(typeof showCloudBanner==='function') showCloudBanner('⚠ Alert rule saved on this device only — cloud write failed.'); }
  }
}

// Active rules for evaluation: project rules (unless muted on this device) + personal rules, all on.
function _arActive(pid){
  const m=_arMutes(pid);
  return [
    ..._arRules('proj',pid).filter(r=>r&&r.on!==false&&!m.has(r.id)).map(r=>({...r,scope:'proj'})),
    ..._arRules('pers',pid).filter(r=>r&&r.on!==false).map(r=>({...r,scope:'pers'}))
  ];
}
// Any enabled rule of a type (mute-independent) — the daily-log's built-in 0.5" forecast spawn
// steps aside once the user runs their own forecast rule (user controls the parameters).
function arHasRule(type,pid){ pid=pid||_arPid(); return [..._arRules('proj',pid),..._arRules('pers',pid)].some(r=>r&&r.type===type&&r.on!==false); }

// ── weather feed (daily-log.js hooks) ──
function arWeatherUpdate(o){
  const pid=_arPid(); if(!o) return;
  _arWx[pid]=Object.assign(_arWx[pid]||{}, o);
  arEvaluate(pid);
}

// ── evaluation ──
var _arEvalTimer=null;
function arEvaluate(pid){
  pid=pid||_arPid();
  clearTimeout(_arEvalTimer);
  _arEvalTimer=setTimeout(()=>_arEvaluateNow(pid),400);   // coalesce boot + weather + settings bursts
}
async function _arEvaluateNow(pid){
  try{
    await arEnsure(pid);
    if(typeof window.oiSpawnAlert!=='function') return;
    const rules=_arActive(pid); if(!rules.length) return;
    const today=_arToday(), yday=_arAddDays(today,-1);
    const wx=_arWx[pid]||{};
    const soon=()=>{ const d=new Date(Date.now()+90000); return d.toLocaleDateString('en-CA')+'T'+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
    const dayLbl=ds=>{ const d=new Date(ds+'T12:00:00'); return d.toLocaleDateString('en-US',{weekday:'short'})+' '+(d.getMonth()+1)+'/'+d.getDate(); };
    let inspDates=null;
    for(const r of rules){
      const thr=(r.threshold>0)?+r.threshold:0.5;
      const name=r.label?(' · '+r.label):'';
      if(r.type==='rain-observed'&&wx.past&&Array.isArray(wx.past.days)){
        wx.past.days.filter(x=>x&&(x.d===today||x.d===yday)&&typeof x.r==='number'&&x.r>=thr).forEach(x=>{
          window.oiSpawnAlert({sourceRef:'rule:'+r.id+':'+x.d, kind:'task', priority:true,
            text:'⚡ '+x.r.toFixed(2)+'" observed '+dayLbl(x.d)+(x.partial?' (so far)':'')+' — at/over your '+thr+'" trigger'+name+'. SWPPP inspection within 24 hrs of storm end.',
            dueDate:_arAddDays(x.d,1), remindAt:soon()});
        });
      } else if(r.type==='rain-forecast'&&Array.isArray(wx.week)){
        wx.week.filter(w=>w&&w.d&&w.d>=today&&typeof w.r==='number'&&w.r>=thr).forEach(w=>{
          window.oiSpawnAlert({sourceRef:'rule:'+r.id+':'+w.d, kind:'task', priority:true,
            text:'⚡ '+w.r.toFixed(2)+'" forecast '+dayLbl(w.d)+(typeof w.p==='number'?' ('+w.p+'%)':'')+' — at/over your '+thr+'" trigger'+name+'. Plan the post-storm inspection.',
            dueDate:_arAddDays(w.d,1)});
        });
      } else if(r.type==='inspection-overdue'){
        const maxDays=(r.maxDays>0)?+r.maxDays:7;
        if(inspDates===null){ try{ inspDates=(typeof window.swInspectionDates==='function')?await window.swInspectionDates(pid):[]; }catch{ inspDates=[]; } }
        if(!Array.isArray(inspDates)||!inspDates.length){
          window.oiSpawnAlert({sourceRef:'rule:'+r.id+':'+today, kind:'task', priority:true, text:'⚡ No SWPPP inspection on record for this project'+name+' — limit '+maxDays+' days.', dueDate:today, remindAt:soon()});
        } else {
          const last=inspDates[inspDates.length-1];
          const gap=Math.round((new Date(today+'T12:00:00')-new Date(last+'T12:00:00'))/86400000);
          if(gap>maxDays){
            window.oiSpawnAlert({sourceRef:'rule:'+r.id+':'+today, kind:'task', priority:true, text:'⚡ SWPPP inspection overdue — last one '+dayLbl(last)+' ('+gap+' days ago, limit '+maxDays+')'+name+'.', dueDate:today, remindAt:soon()});
          }
        }
      } else if(r.type==='weekday'){
        const days=(Array.isArray(r.days)&&r.days.length)?r.days.map(Number):[1];
        const time=/^\d{2}:\d{2}$/.test(r.time||'')?r.time:'06:30';
        let next=today; for(let i=0;i<8;i++){ const d=_arAddDays(today,i); if(days.includes(new Date(d+'T12:00:00').getDay())){ next=d; break; } }
        window.oiSpawnAlert({sourceRef:'rule:'+r.id, kind:'task', priority:true,
          text:'⚡ '+(r.label||'Weekday reminder')+' — '+days.slice().sort().map(d=>AR_DOW[d]).join('/')+' '+time,
          dueDate:next, remindAt:next+'T'+time, repeat:'weekly', repeatDays:days.slice().sort()}, true);
      }
    }
  }catch(e){ console.warn('alertRules evaluate:',e.message); }
}
function arOnProjectLoaded(){ const pid=_arPid(); arEnsure(pid).then(()=>{ arRenderCard(); arEvaluate(pid); }); }

// ── Settings card ──
function _arSummary(r){
  const t=AR_TYPES[r.type]||{icon:'⚡',label:r.type};
  let p='';
  if(r.type==='rain-observed'||r.type==='rain-forecast') p='≥ '+((r.threshold>0)?+r.threshold:0.5)+'"';
  else if(r.type==='inspection-overdue') p='> '+((r.maxDays>0)?+r.maxDays:7)+' days';
  else if(r.type==='weekday') p=((Array.isArray(r.days)&&r.days.length)?r.days.slice().sort().map(d=>AR_DOW[d]).join('/'):'Mon')+' · '+(r.time||'06:30');
  return {icon:t.icon, label:(r.label&&r.label.trim())?r.label:t.label, params:p};
}
function _arSafeId(id){ return String(id||'').replace(/[^\w-]/g,''); }
function _arRow(r,scope,pid){
  const sid=_arSafeId(r.id); if(!sid||sid!==String(r.id)) return '';   // never render a rule whose id could break out of an attribute
  const s=_arSummary(r), lead=_arIsLead(pid), canEdit=scope==='pers'||lead;
  const muted=scope==='proj'&&_arMutes(pid).has(r.id);
  const off=r.on===false;
  const state=off?'<span class="oi-chip">off</span>':(muted?'<span class="oi-chip over">🔕 silenced here</span>':'<span class="oi-chip" style="color:var(--amber);border-color:var(--amber)">on</span>');
  const btn='background:var(--s1);border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:10px;padding:5px 9px;border-radius:5px;cursor:pointer';
  const actions=canEdit
    ? `<button style="${btn}" onclick="arToggle('${scope}','${sid}')">${off?'Turn on':'Turn off'}</button><button style="${btn}" onclick="arEdit('${scope}','${sid}')">✏️</button><button style="${btn}" onclick="arDelete('${scope}','${sid}')">🗑</button>`
    : `<button style="${btn}" onclick="arMute('${sid}',${muted?'false':'true'})" title="Silence or restore this project alert on this device only">${muted?'🔔 Restore here':'🔕 Silence here'}</button>`;
  return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
    <span style="font-size:16px;flex:none">${s.icon}</span>
    <div style="flex:1 1 160px;min-width:0"><div style="font-size:13px;color:var(--text)">${_arEsc(s.label)}</div><div style="font-family:var(--mono);font-size:10px;color:var(--muted)">${_arEsc(s.params)}${scope==='proj'&&!lead?' · project rule (lead edits)':''}</div></div>
    ${state}<div style="display:flex;gap:6px;margin-left:auto">${actions}</div></div>`;
}
function _arEditor(scope,r){
  r=r||{type:'rain-observed',threshold:0.5,maxDays:7,days:[1,4],time:'06:30',label:''};
  const typeOpts=Object.keys(AR_TYPES).map(k=>`<option value="${k}"${k===r.type?' selected':''}>${AR_TYPES[k].icon} ${AR_TYPES[k].label}</option>`).join('');
  const days=Array.isArray(r.days)?r.days.map(Number):[];
  const dayChips=AR_DOW.map((d,i)=>`<button type="button" class="oi-day${days.includes(i)?' on':''}" data-d="${i}" onclick="this.classList.toggle('on')">${d}</button>`).join('');
  return `<div id="ar-editor" data-scope="${scope}" data-id="${_arSafeId(r.id)}" style="border:1px solid var(--amber);border-radius:8px;padding:12px;margin:10px 0;background:var(--amber-bg)">
    <div class="field"><label>Trigger</label><select id="ar-type" onchange="arEditorTypeChanged()">${typeOpts}</select></div>
    <div class="field"><label>Label (optional)</label><input type="text" id="ar-label" maxlength="60" value="${_arEsc(r.label||'')}" placeholder="e.g. SWPPP 0.5&quot; trigger"></div>
    <div id="ar-f-threshold" class="field" style="max-width:220px"><label>Rain threshold (inches)</label><input type="number" id="ar-threshold" inputmode="decimal" step="0.05" min="0.05" value="${(r.threshold>0)?+r.threshold:0.5}"></div>
    <div id="ar-f-maxdays" class="field" style="max-width:220px"><label>Alert when no inspection in (days)</label><input type="number" id="ar-maxdays" inputmode="numeric" step="1" min="1" value="${(r.maxDays>0)?+r.maxDays:7}"></div>
    <div id="ar-f-days" class="field"><label>Days</label><div class="oi-daychips" id="ar-days">${dayChips}</div></div>
    <div id="ar-f-time" class="field" style="max-width:200px"><label>Time</label><input type="time" id="ar-time" value="${/^\d{2}:\d{2}$/.test(r.time||'')?r.time:'06:30'}"></div>
    <p class="config-hint" id="ar-hint"></p>
    <div style="display:flex;gap:8px"><button class="btn btn-amber" style="font-size:11px;padding:7px 14px" onclick="arEditorSave()">Save rule</button><button class="btn btn-outline" style="font-size:11px;padding:7px 14px" onclick="arEditorCancel()">Cancel</button></div>
  </div>`;
}
function arEditorTypeChanged(){
  const t=document.getElementById('ar-type')?.value||'rain-observed';
  const show=(id,on)=>{ const el=document.getElementById(id); if(el) el.style.display=on?'':'none'; };
  show('ar-f-threshold', t==='rain-observed'||t==='rain-forecast');
  show('ar-f-maxdays', t==='inspection-overdue');
  show('ar-f-days', t==='weekday'); show('ar-f-time', t==='weekday');
  const h=document.getElementById('ar-hint'); if(h) h.textContent=(AR_TYPES[t]||{}).hint||'';
}
function arRenderCard(){
  const host=document.getElementById('cfg-alerts-body'); if(!host) return;
  const pid=_arPid(); const lead=_arIsLead(pid);
  const proj=_arRules('proj',pid), pers=_arRules('pers',pid);
  const addBtn=(scope,label)=>`<button class="btn btn-outline" style="font-size:11px;padding:7px 14px;margin-top:8px" onclick="arEdit('${scope}',null)">＋ ${label}</button>`;
  const sec=(title,sub)=>`<div style="font-family:var(--cond);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted2);margin:14px 0 2px">${title}</div><div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:4px">${sub}</div>`;
  const ed=(scope)=>(_arEditing&&_arEditing.scope===scope)?_arEditor(scope,_arEditing.id?( _arRules(scope,pid).find(x=>x.id===_arEditing.id)||null):null):'';
  host.innerHTML=
    sec('Project alerts', lead?'Everyone on the project receives these. Only a lead can edit them.':'Set by the project lead. You can silence any of them on this device.')+
    (proj.length?proj.map(r=>_arRow(r,'proj',pid)).join(''):'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:6px 0">No project alerts yet.</div>')+
    (lead?addBtn('proj','Add project alert'):'')+ed('proj')+
    sec('My alerts','Only you receive these, on every device you sign in to.')+
    (pers.length?pers.map(r=>_arRow(r,'pers',pid)).join(''):'<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:6px 0">No personal alerts yet.</div>')+
    (_arCanPersonal(pid)?addBtn('pers','Add my alert'):'')+ed('pers');
  if(_arEditing) arEditorTypeChanged();
}
function arEdit(scope,id){ _arEditing={scope,id:id||null}; arRenderCard(); setTimeout(()=>{ document.getElementById('ar-editor')?.scrollIntoView({behavior:'smooth',block:'nearest'}); },50); }
function arEditorCancel(){ _arEditing=null; arRenderCard(); }
async function arEditorSave(){
  const ed=document.getElementById('ar-editor'); if(!ed||!_arEditing) return;
  const pid=_arPid(), scope=_arEditing.scope;
  if(scope==='proj'&&!_arIsLead(pid)){ if(typeof showCloudBanner==='function') showCloudBanner('Only the project lead can change project alerts.'); return; }
  const type=document.getElementById('ar-type')?.value||'rain-observed';
  const rules=_arRules(scope,pid).slice();
  const prev=_arEditing.id?rules.find(x=>x.id===_arEditing.id):null;
  const r={
    id:prev?prev.id:_arId(), type, on:prev?prev.on!==false:true,
    label:(document.getElementById('ar-label')?.value||'').trim().slice(0,60),
    threshold:Math.max(0.05, parseFloat(document.getElementById('ar-threshold')?.value)||0.5),
    maxDays:Math.max(1, parseInt(document.getElementById('ar-maxdays')?.value)||7),
    days:[...document.querySelectorAll('#ar-days .oi-day.on')].map(b=>+b.dataset.d),
    time:document.getElementById('ar-time')?.value||'06:30',
    createdBy:prev?prev.createdBy:(_arUid()||null), createdAt:prev?prev.createdAt:Date.now(), updatedAt:Date.now()
  };
  if(type==='weekday'&&!r.days.length){ if(typeof showCloudBanner==='function') showCloudBanner('Pick at least one day.'); return; }
  const idx=rules.findIndex(x=>x.id===r.id); if(idx>=0) rules[idx]=r; else rules.push(r);
  _arEditing=null;
  await _arSave(scope,pid,rules);
  arRenderCard(); arEvaluate(pid);
  window.glHaptic&&window.glHaptic.success&&window.glHaptic.success();
}
async function arToggle(scope,id){
  const pid=_arPid(); if(scope==='proj'&&!_arIsLead(pid)) return;
  const rules=_arRules(scope,pid).map(r=>r.id===id?{...r,on:r.on===false,updatedAt:Date.now()}:r);
  await _arSave(scope,pid,rules); arRenderCard(); arEvaluate(pid);
}
async function arDelete(scope,id){
  const pid=_arPid(); if(scope==='proj'&&!_arIsLead(pid)) return;
  const go=async()=>{ await _arSave(scope,pid,_arRules(scope,pid).filter(r=>r.id!==id)); if(typeof window.oiRetireAlertRule==='function') window.oiRetireAlertRule(id); arRenderCard(); };
  if(typeof _confirmModal==='function') _confirmModal('Delete this alert rule? Open items it already created stay until you check them off.', go, 'Delete alert', 'Delete'); else go();
}
function arMute(id,on){
  const pid=_arPid(); _arSetMute(pid,id,!!on);
  if(on&&typeof window.oiRetireAlertRule==='function') window.oiRetireAlertRule(id);   // silence = its open reminder goes too (un-silence re-pins)
  arRenderCard(); if(!on) arEvaluate(pid);
}

if(typeof window!=='undefined'){
  window.arEnsure=arEnsure; window.arEvaluate=arEvaluate; window.arHasRule=arHasRule; window.arWeatherUpdate=arWeatherUpdate;
  window.arOnProjectLoaded=arOnProjectLoaded; window.arRenderCard=arRenderCard;
  window.arEdit=arEdit; window.arEditorCancel=arEditorCancel; window.arEditorSave=arEditorSave; window.arEditorTypeChanged=arEditorTypeChanged;
  window.arToggle=arToggle; window.arDelete=arDelete; window.arMute=arMute;
}
