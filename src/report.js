
// ═══════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════

// Report logo lives in PROJECT DATA (settings/{pid}.reportLogoB64), never in
// code: the Stantec logo that was hardcoded here landed on EVERY account's
// reports (caught 2026-06-11 pre-tester audit; original extracted to OneDrive
// Branding\stantec-report-logo.jpg - re-upload it to Moraine via Settings ->
// Report Generation -> Report Logo). No logo = clean text-only title block.

function _b64ToArrayBuffer(b64){
  const bin=atob(b64);
  const buf=new ArrayBuffer(bin.length);
  const arr=new Uint8Array(buf);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return buf;
}

// ── AES-GCM encryption using Web Crypto — cross-device (fixed app salt) ──
const _RPT_SALT='PhinestEI-rpt-2026';
async function _rptDeriveKey(){
  const enc=new TextEncoder();
  const km=await crypto.subtle.importKey('raw',enc.encode(_RPT_SALT),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:enc.encode('pei-v1'),iterations:100000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function rptEncryptKey(plaintext){
  const key=await _rptDeriveKey();
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const enc=new TextEncoder();
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(plaintext));
  const combined=new Uint8Array(12+encrypted.byteLength);
  combined.set(iv);combined.set(new Uint8Array(encrypted),12);
  return btoa(String.fromCharCode(...combined));
}
async function rptDecryptKey(ciphertext){
  try{
    const combined=Uint8Array.from(atob(ciphertext),c=>c.charCodeAt(0));
    const iv=combined.slice(0,12);const data=combined.slice(12);
    const key=await _rptDeriveKey();
    const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,data);
    return new TextDecoder().decode(dec);
  }catch(e){return null;}
}
async function rptGetApiKey(){
  let enc=null;
  try{if(db&&_fbReady){const doc=await _udb().collection('appConfig').doc('reportSettings').get();if(doc.exists)enc=doc.data().encApiKey;}}catch(e){}
  if(!enc) enc=localStorage.getItem('pei_enc_api_key');
  if(!enc){try{if(db&&_fbReady){const doc=await db.collection('appConfig').doc('hosted').get();if(doc.exists)enc=doc.data().encApiKey;}}catch(e){}}
  if(!enc) return null;
  return rptDecryptKey(enc);
}
async function _rptInitHostedKeyBtn(){
  // Show "Share key with invited users" only for users who have their own API key saved
  let hasKey = !!localStorage.getItem('pei_enc_api_key');
  if(!hasKey && db && _fbReady){
    try{const doc=await _udb().collection('appConfig').doc('reportSettings').get();if(doc.exists&&doc.data().encApiKey)hasKey=true;}catch(e){}
  }
  const btn=document.getElementById('cfg-hosted-key-btn');
  if(btn) btn.style.display=hasKey?'':'none';
}
async function rptSaveHostedKey(){
  let enc=null;
  try{if(db&&_fbReady){const doc=await _udb().collection('appConfig').doc('reportSettings').get();if(doc.exists)enc=doc.data().encApiKey;}}catch(e){}
  if(!enc) enc=localStorage.getItem('pei_enc_api_key');
  if(!enc){alert('Save your API key in Report Generation first.');return;}
  try{
    await db.collection('appConfig').doc('hosted').set({encApiKey:enc,_ts:Date.now()});
    const btn=document.getElementById('cfg-hosted-key-btn');
    if(btn){btn.textContent='✓ Shared';btn.disabled=true;setTimeout(()=>{btn.textContent='Share key with invited users';btn.disabled=false;},3000);}
  }catch(e){alert('Failed to share key: '+e.message);}
}
async function saveApiKey(){
  const val=document.getElementById('cfg-api-key').value.trim();
  if(!val){alert('Please enter an API key.');return;}
  try{
    const encrypted=await rptEncryptKey(val);
    localStorage.setItem('pei_enc_api_key',encrypted);
    if(db&&_fbReady) await _udb().collection('appConfig').doc('reportSettings').set({encApiKey:encrypted,_ts:Date.now()});
    document.getElementById('cfg-api-key').value='';
    document.getElementById('cfg-api-key').placeholder='✓ Key saved securely';
    const st=document.getElementById('cfg-api-status');
    st.textContent='✓ Encrypted & saved';st.style.opacity='1';setTimeout(()=>st.style.opacity='0',2500);
    _rptInitHostedKeyBtn();
  }catch(e){alert('Error saving key: '+e.message);}
}
function toggleApiKeyVisibility(){
  const f=document.getElementById('cfg-api-key');
  f.type=f.type==='password'?'text':'password';
}

// ── Formalize Log — flag helpers ──
function _setFormalized(){
  localStorage.setItem('gl_formalized_date', localToday());
  window._logFormalized = true;
}
function _isFormalized(){
  if(_logFormalized) return true;
  return localStorage.getItem('gl_formalized_date') === localToday();
}

// ── Formalize Log — field-select modal ──
function _polishSelectModal(fields, onConfirm){
  var ov=document.createElement('div');
  ov.className='modal-overlay';
  var checkboxes=fields.map(function(f,i){
    return '<label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:13px;color:var(--text);cursor:pointer">'+
      '<input type="checkbox" id="_pf'+i+'" checked style="margin-top:2px;accent-color:var(--amber)">'+
      '<span>'+f.label+'</span></label>';
  }).join('');
  ov.innerHTML='<div class="modal-box">'+
    '<div class="modal-title">✦ Formalize Log</div>'+
    '<div class="modal-msg" style="margin-bottom:14px">Select fields to rewrite in professional language:</div>'+
    '<div style="margin-bottom:18px">'+checkboxes+'</div>'+
    '<div id="_pmw" style="display:none;color:var(--amber);font-size:12px;margin-bottom:10px;text-align:center">Select at least one field to polish.</div>'+
    '<div class="modal-btns">'+
      '<button class="modal-cancel" id="_pmc">Cancel</button>'+
      '<button class="modal-confirm" id="_pmok" style="background:var(--amber);border-color:var(--amber);color:#111">✦ Polish</button>'+
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_pmc').onclick=function(){ov.remove();};
  document.getElementById('_pmok').onclick=function(){
    var selected=fields.filter(function(f,i){
      var cb=document.getElementById('_pf'+i);
      return cb&&cb.checked;
    });
    // E1.3 fix: previously a 0-selected click silently closed the modal with no
    // feedback. Now we keep the modal open and surface an inline warning so the
    // user knows their click registered and what to do next.
    if(!selected.length){
      document.getElementById('_pmw').style.display='block';
      return;
    }
    ov.remove();
    onConfirm(selected);
  };
}

// ── Formalize Log — two-option choice modal ──
function _polishChoiceModal(msg, labelA, labelB, onChoice){
  var ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.innerHTML='<div class="modal-box">'+
    '<div class="modal-title">✦ Formalize Log</div>'+
    '<div class="modal-msg">'+msg+'</div>'+
    '<div class="modal-btns">'+
      '<button class="modal-cancel" id="_pcA">'+labelA+'</button>'+
      '<button class="modal-confirm" id="_pcB" style="background:var(--amber);border-color:var(--amber);color:#111">'+labelB+'</button>'+
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_pcA').onclick=function(){ov.remove();onChoice(true);};
  document.getElementById('_pcB').onclick=function(){ov.remove();onChoice(false);};
}

// ── Formalize Log — gate ──
async function polishLog(){
  const apiKey=await rptGetApiKey();
  if(!apiKey){_confirmModal('No API key configured. Add your Anthropic API key in Settings → Report Generation.',()=>{});return;}
  const STATIC_FIELDS=[
    {id:'inspSummary',  label:'Field Observations'},
    {id:'nonCompliance',label:'Non-Compliance Note'},
    {id:'genComms',     label:'General Communications'},
    {id:'agencyInsp',   label:'Agency Inspection'},
    {id:'landowner',    label:'Landowner Contact'},
    {id:'rte',          label:'RTE Species Observation'},
    {id:'lookahead',    label:'24-Hour Look Ahead'},
  ];
  const fields=[];
  STATIC_FIELDS.forEach(function(f){
    const el=document.getElementById(f.id);
    if(el&&el.value.trim()) fields.push({id:f.id,label:f.label,value:el.value.trim()});
  });
  crewIds.forEach(function(cid){
    [['acts','Activities Observed'],['envcomp','Env. Compliance Obs.'],['issues','Issues / Non-Compliance']].forEach(function(pair){
      const el=document.getElementById('crew-'+cid+'-'+pair[0]);
      if(el&&el.value.trim()) fields.push({id:'crew-'+cid+'-'+pair[0],label:'Crew '+cid+' — '+pair[1],value:el.value.trim()});
    });
  });
  if(!fields.length){_confirmModal('Nothing to formalize — fill in some fields first.',()=>{},'✦ Formalize Log','OK');return;}
  _polishSelectModal(fields,function(selected){_doPolish(selected,apiKey);});
}

// ── Formalize Log — Claude API call + field update ──
// E1.3 diagnostics (2026-05-13): the "all checked fields stay unchanged" symptom
// could be caused by (a) Claude returning JSON keys that don't match field IDs,
// (b) JSON.parse failure on a malformed response, or (c) silent API failure.
// This version surfaces in-progress status, counts applied vs requested fields,
// logs missing keys + raw response on parse failure, and keeps the status visible
// longer so the user can spot warnings. Doesn't fix the underlying mystery — but
// next time Tim hits it, the console + status bar will show exactly what's wrong.
async function _doPolish(selectedFields, apiKey){
  const btn=document.getElementById('btn-formalize-log');
  const status=document.getElementById('rpt-status');
  const setStatus=function(msg,color){if(status){status.textContent=msg;status.style.color=color||'var(--green)';status.style.opacity='1';}};
  const n=selectedFields.length;
  if(btn){btn.disabled=true;btn.textContent='Formalizing…';}
  setStatus('Polishing '+n+' field'+(n===1?'':'s')+'…','var(--amber)');
  try{
    const payload=Object.fromEntries(selectedFields.map(function(f){return[f.id,f.value];}));
    const systemPrompt='You are a professional field inspector writing assistant. Rewrite the provided field log text into clean, professional language suitable for a regulatory compliance report. Rules: use "conducting" not "performing"; use definitive language ("will" not "anticipated to"); contractor compliance language must be collaborative in tone; do not use first person; preserve all specific facts, measurements, locations, and compliance levels exactly as entered; do not add information not present in the original; do not remove relevant observations. Return a JSON object with the same keys as provided, containing the rewritten text for each field. Return ONLY the JSON object — no preamble, no markdown, no code fences.';
    const userPrompt='Rewrite these daily log fields:\n'+JSON.stringify(payload);
    const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:4000,system:systemPrompt,messages:[{role:'user',content:userPrompt}]})});
    if(!resp.ok){const err=await resp.text();throw new Error('API '+resp.status+': '+err);}
    const data=await resp.json();
    const text=data.content[0].text;
    const j0=text.indexOf('{'),j1=text.lastIndexOf('}');
    if(j0===-1||j1===-1){
      console.error('Formalize Log: no JSON object in Claude response. Raw text:',text);
      throw new Error('Polish response malformed — see console');
    }
    let polished;
    try{
      polished=JSON.parse(text.slice(j0,j1+1));
    }catch(parseErr){
      console.error('Formalize Log: JSON.parse failed. Raw slice:',text.slice(j0,j1+1));
      throw new Error('Polish JSON parse failed — see console');
    }
    let appliedCount=0;
    const missingIds=[];
    selectedFields.forEach(function(f){
      if(polished[f.id]!=null){
        const el=document.getElementById(f.id);
        if(el){ el.value=polished[f.id]; appliedCount++; }
      } else {
        missingIds.push(f.id);
      }
    });
    if(missingIds.length){
      console.warn('Formalize Log: Claude response missing keys for fields:',missingIds,
        '— requested ids:',selectedFields.map(function(f){return f.id;}),
        '— returned keys:',Object.keys(polished));
    }
    if(typeof debouncedAutoSave==='function') debouncedAutoSave();
    _setFormalized();
    if(appliedCount===n){
      setStatus('✓ Polished '+appliedCount+' field'+(appliedCount===1?'':'s'));
    } else if(appliedCount>0){
      setStatus('⚠ Polished '+appliedCount+' of '+n+' — see console','var(--amber)');
    } else {
      setStatus('⚠ No fields updated — see console','var(--amber)');
    }
    setTimeout(function(){if(status)status.style.opacity='0';},5000);
  }catch(e){
    console.error('Formalize Log error:',e);
    setStatus('✗ '+e.message.slice(0,80),'var(--red)');
    setTimeout(function(){if(status)status.style.opacity='0';},8000);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='✦ Formalize Log';}
  }
}

// ── Claude API polish call ──
// ── Convert HH:MM (24hr) to H:MM AM/PM ──
function _rptFmtTime(t){
  if(!t) return '';
  const[h,m]=t.split(':').map(Number);
  if(isNaN(h)||isNaN(m)) return t;
  const ampm=h>=12?'PM':'AM';
  const h12=h%12||12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

// rptCallClaude — make the polish API call.
//
// Stage 4 (C10, 2026-05-08): system prompt is now ASSEMBLED in _doGenerate via
// promptAssembly.js + promptDefaults.js + the user's saved layers, then passed
// in here. This function no longer hardcodes the prompt.
//
// The skip-polish suffix is appended at runtime — it is NOT folded into
// effectivePromptHash because skipPolish is already a separate dimension of
// the cache snapshot (so cache-key partitioning by skipPolish is automatic).
async function rptCallClaude(apiKey, logData, compEntries, systemPromptIn){
  if(!systemPromptIn || typeof systemPromptIn !== 'string'){
    throw new Error('rptCallClaude: systemPrompt parameter required (Stage 4 / C10 contract). Call site must pass an assembled system prompt from promptAssembly.js.');
  }
  const crewSummary=(logData.crewBlocks||[]).map(b=>`Crew: ${b.name} | Time: ${b.time} | Location: ${b.location}\nActivities: ${b.activities}\nEnv Compliance: ${b.envCompliance}\nIssues: ${b.issues}\nNotes: ${b.notes}`).join('\n\n');
  const compSummary=compEntries.length>0
    ?compEntries.map(e=>`Level ${e.level} — ${e.location}|Corrective: ${e.corrective}|Status: ${e.status}${e.dateResolved?'|Resolved: '+e.dateResolved:''}`).join('\n')
    :'No compliance issues';
  const timeIn=_rptFmtTime(logData['p-timeIn'])||'6:30 AM';
  const userPrompt=`REPORT DATE: ${logData.reportDate}\nACTIVE PHASE: ${logData.activePhase}\nCONTRACTOR: ${logData.contractor}\nTIME IN: ${timeIn}\n\nCREW BLOCKS:\n${crewSummary}\n\nINSPECTION SUMMARY:\n${logData.inspectionSummary||''}\n\nAGENCY INSPECTION:\n${logData.agencyInspection||''}\n\nCOMPLIANCE ISSUES:\n${compSummary}\n\nLANDOWNER/PUBLIC:\n${logData.landownerContact||''}\n\nT&E/RTE:\n${logData.rteObservation||''}\n\nGENERAL COMMS:\n${logData.generalComms||''}\n\n24-HOUR LOOK AHEAD:\n${logData.lookahead||''}\n\nReturn ONLY valid JSON — no markdown, no preamble:\n{"contractorActivities":"...","fieldObservationsOpening":"...","fieldObservationsBullets":["..."],"fieldObservationsClosing":"...","agencyInspection":"...","complianceIssues":[{"level":"...","description":"...","corrective":"...","status":"...","dateResolved":""}],"landownerContact":"...","rteObservation":"...","generalComms":"...","lookaheadBullets":["..."]}`;
  const finalSystemPrompt=(window._rptSkipPolish===true)
    ? systemPromptIn + '\n\nIMPORTANT: The user has already professionally formalized the narrative text fields. Include ALL narrative content VERBATIM — do NOT rephrase, restructure, or alter any provided text.'
    : systemPromptIn;
  const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:4000,system:finalSystemPrompt,messages:[{role:'user',content:userPrompt}]})});
  if(!resp.ok){const err=await resp.text();throw new Error('Claude API error '+resp.status+': '+err);}
  const data=await resp.json();
  const text=data.content[0].text;
  const clean=text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  return JSON.parse(clean);
}

// ── DOCX Assembly ──
async function rptBuildDocx(logData,polished,photos){
  if(!window.docx) throw new Error('Report library not loaded. Please refresh and try again.');
  const{Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,AlignmentType,BorderStyle,WidthType,ShadingType,ImageRun,Footer,Header,PageNumber,NumberFormat}=window.docx;
  const BLUE='1F3864',LT_BLUE='D9E2F3',MID_BLUE='2E5496',WHITE='FFFFFF';
  const bdr={style:BorderStyle.SINGLE,size:1,color:'AAAAAA'};
  const borders={top:bdr,bottom:bdr,left:bdr,right:bdr};
  const noBdr={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
  const noBorders={top:noBdr,bottom:noBdr,left:noBdr,right:noBdr};
  // Date formatting
  const[y,m,d]=logData.reportDate.split('-');
  const dt=new Date(parseInt(y),parseInt(m)-1,parseInt(d));
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const longDate=`${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${parseInt(d)}, ${y}`;
  const shortDate=`${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
  // Helpers
  const spacer=(pts=80)=>new Paragraph({spacing:{before:0,after:pts}});
  const h1=(text)=>new Paragraph({children:[new TextRun({text,bold:true,color:WHITE,font:'Arial',size:24})],shading:{fill:BLUE,type:ShadingType.CLEAR},spacing:{before:200,after:100}});
  const h2=(text)=>new Paragraph({children:[new TextRun({text,bold:true,color:MID_BLUE,font:'Arial',size:22})],border:{bottom:{style:BorderStyle.SINGLE,size:6,color:MID_BLUE,space:1}},spacing:{before:160,after:60}});
  const body=(text)=>new Paragraph({children:[new TextRun({text,font:'Arial',size:20})],spacing:{before:40,after:40}});
  const bullet=(text)=>new Paragraph({children:[new TextRun({text:'\u2022  '+text,font:'Arial',size:20})],indent:{left:360},spacing:{before:20,after:20}});
  const infoRow=(label,value)=>new TableRow({children:[
    new TableCell({borders,width:{size:2800,type:WidthType.DXA},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},margins:{top:80,bottom:80,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:label,bold:true,font:'Arial',size:20})]})] }),
    new TableCell({borders,width:{size:6560,type:WidthType.DXA},margins:{top:80,bottom:80,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:value,font:'Arial',size:20})]})] })
  ]});
  // Header table (appears at top of document body)
  const headerTable=new Table({width:{size:100,type:WidthType.PERCENTAGE},borders:noBorders,rows:[
    new TableRow({children:[
      new TableCell({borders:{top:bdr,left:bdr,bottom:noBdr,right:noBdr},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},width:{size:60,type:WidthType.PERCENTAGE},margins:{top:80,bottom:40,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:logData.project.toUpperCase(),bold:true,font:'Arial',size:22,color:BLUE})]})]}),
      new TableCell({borders:{top:bdr,left:noBdr,bottom:noBdr,right:bdr},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},width:{size:40,type:WidthType.PERCENTAGE},margins:{top:80,bottom:40,left:120,right:120},children:[new Paragraph({alignment:AlignmentType.RIGHT,children:[new TextRun({text:logData.location,font:'Arial',size:18})]})]}),
    ]}),
    new TableRow({children:[
      new TableCell({borders:{top:noBdr,left:bdr,bottom:bdr,right:noBdr},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},width:{size:60,type:WidthType.PERCENTAGE},margins:{top:40,bottom:80,left:120,right:120},children:[new Paragraph({children:[new TextRun({text:'Daily Environmental Compliance Report',font:'Arial',size:18,color:MID_BLUE})]})]}),
      new TableCell({borders:{top:noBdr,left:noBdr,bottom:bdr,right:bdr},shading:{fill:LT_BLUE,type:ShadingType.CLEAR},width:{size:40,type:WidthType.PERCENTAGE},margins:{top:40,bottom:80,left:120,right:120},children:[new Paragraph({children:[]})]}),
    ]})
  ]});
  // Logo + subtitle block — logo is per-project data (see header comment).
  let _logo=null;
  try{
    const _pid=_activeProjectId();
    if(_pid&&_pid!=='active'&&typeof db!=='undefined'&&db&&_fbReady){
      const _pd=await _udb().collection('settings').doc(_pid).get();
      if(_pd.exists&&_pd.data().reportLogoB64){
        _logo={
          b64:String(_pd.data().reportLogoB64).replace(/^data:image\/\w+;base64,/,''),
          w:_pd.data().reportLogoW||200,
          h:_pd.data().reportLogoH||50
        };
      }
    }
  }catch(e){ /* no logo is a valid state — never block report generation */ }
  const titleBlock=[];
  if(_logo){
    titleBlock.push(new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({data:_b64ToArrayBuffer(_logo.b64),transformation:{width:_logo.w,height:_logo.h}})],spacing:{before:160,after:60}}));
  }
  titleBlock.push(new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Daily Environmental Compliance Report',font:'Arial',size:22,color:MID_BLUE})],spacing:{before:_logo?0:160,after:160}}));
  // Info table
  const infoTable=new Table({rows:[
    infoRow('Report Date:',longDate),
    infoRow('Prepared By:',logData.preparedBy+' \u2014 Environmental Inspector'),
    infoRow('Organization:',logData.org),
    infoRow('Project:',logData.project),
    infoRow('Current Activity:',logData.activePhase),
    infoRow('Active Contractors:',logData.contractor||'\u2014')
  ]});
  // Section 1: Weather
  const wx=logData.weather||{};
  const sky=Array.isArray(wx.sky)?wx.sky.join(', '):(wx.sky||'');
  const weatherTable=new Table({rows:[
    infoRow('Sky Conditions:',sky||'\u2014'),
    infoRow('Temperature (AM / PM):',(wx.tempAM||'\u2014')+'\u00b0F / '+(wx.tempPM||'\u2014')+'\u00b0F'),
    infoRow('Precipitation:',wx.precip||'None'),
    infoRow('Wind:',wx.wind||'\u2014'),
    infoRow('Soil Conditions:',wx.soilConditions||'\u2014'),
    infoRow('Upcoming Weather:',wx.upcomingForecast||'\u2014')
  ]});
  // Section 2: Inspection Summary
  const sec2=[
    h1('2.  Inspection Summary'),spacer(60),
    h2('Contractor Activities'),
    body(polished.contractorActivities||''),spacer(60),
    h2('Field Observations'),
    body(polished.fieldObservationsOpening||''),spacer(40),
    ...(polished.fieldObservationsBullets||[]).map(b=>bullet(b)),
    spacer(40),body(polished.fieldObservationsClosing||'')
  ];
  // Section 3: Compliance
  const compIssues=polished.complianceIssues||[{level:'No issues identified',description:'All areas inspected \u2014 no compliance concerns observed.',corrective:'N/A',status:'Compliant',dateResolved:''}];
  const compHdr=new TableRow({children:[
    new TableCell({borders,shading:{fill:BLUE,type:ShadingType.CLEAR},margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:'Level',bold:true,color:WHITE,font:'Arial',size:18})]})]}),
    new TableCell({borders,shading:{fill:BLUE,type:ShadingType.CLEAR},margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:'Location / Description',bold:true,color:WHITE,font:'Arial',size:18})]})]}),
    new TableCell({borders,shading:{fill:BLUE,type:ShadingType.CLEAR},margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:'Corrective Action',bold:true,color:WHITE,font:'Arial',size:18})]})]}),
    new TableCell({borders,shading:{fill:BLUE,type:ShadingType.CLEAR},margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:'Status',bold:true,color:WHITE,font:'Arial',size:18})]})]})
  ]});
  const compRows=compIssues.map(issue=>new TableRow({children:[
    new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.level||'',font:'Arial',size:18})]})]}),
    new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.description||'',font:'Arial',size:18})]})]}),
    new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.corrective||'',font:'Arial',size:18})]})]}),
    new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.status||'',font:'Arial',size:18})]})]})
  ]}));
  const compTable=new Table({rows:[compHdr,...compRows]});
  const sec3=[
    h1('3.  Compliance Issues'),spacer(60),
    h2('Agency Inspections'),
    body(polished.agencyInspection||'No agency inspections conducted today.'),spacer(60),
    h2('Non-Compliance Observations'),spacer(40),
    body('Compliance Level Reference: Level 1 \u2014 Observation | Level 2 \u2014 Corrective Action | Level 3 \u2014 Non-Compliance | Level 4 \u2014 Stop Work Order'),
    spacer(40),compTable,spacer(60),
    h2('Landowner / Public Interactions'),
    body(polished.landownerContact||'No landowner or public interactions occurred today.'),spacer(60),
    h2('T&E Species / Unanticipated Discoveries'),
    body(polished.rteObservation||'No rare, threatened, or endangered species were observed. No unanticipated archaeological or cultural resource discoveries were encountered.')
  ];
  // Section 4: General Comms
  const sec4=[h1('4.  General Communication to Contractors'),spacer(60),body(polished.generalComms||'No general communications to report.')];
  // Section 5: Look Ahead
  const laItems=polished.lookaheadBullets||(logData.lookahead?logData.lookahead.split('\n').filter(l=>l.trim()):[]);
  const upcomingWx=(logData.weather&&logData.weather.upcomingForecast)?logData.weather.upcomingForecast.trim():'';
  const sec5=[
    h1('5.  24-Hour Look Ahead'),spacer(60),
    ...(upcomingWx?[body(`Expected Weather: ${upcomingWx}`),spacer(40)]:[]),
    ...(laItems.length>0?laItems.map(b=>bullet(b)):[body(logData.lookahead||'No look ahead items recorded.')])
  ];
  // Section 6: Photos
  const dayPhotos=photos.filter(p=>p.date===logData.reportDate).sort((a,b)=>a.uploadedAt-b.uploadedAt);
  const photoRows=[];
  for(let i=0;i<dayPhotos.length;i+=2){
    const cells=[];
    for(let j=i;j<Math.min(i+2,dayPhotos.length);j++){
      const p=dayPhotos[j];
      try{
        let imgData;if(p.storageUrl){const resp=await fetch(p.storageUrl);imgData=await resp.arrayBuffer();}else{const raw=p.thumb;const b64=raw.includes(',')?raw.split(',')[1]:raw;imgData=_b64ToArrayBuffer(b64);}
        cells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},margins:{top:40,bottom:40,left:40,right:40},children:[
          new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({data:imgData,transformation:{width:331,height:248}})]}),
          new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:`Photo ${j+1} \u2014 ${p.caption||''}`,font:'Arial',size:18,italics:true})],spacing:{before:40,after:60}})
        ]}));
      }catch(e){cells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},children:[new Paragraph({children:[new TextRun({text:`Photo ${j+1}`,font:'Arial',size:18})]})]}));}
    }
    if(cells.length===1) cells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},children:[new Paragraph({children:[]})]}));
    photoRows.push(new TableRow({children:cells}));
  }
  const sec6=[
    h1('6.  Photo Log'),spacer(60),
    body(`The following photographs were taken during the inspection on ${parseInt(m)}/${parseInt(d)}/${y.slice(2)}.`),
    spacer(60),
    ...(photoRows.length>0?[new Table({borders:noBorders,width:{size:100,type:WidthType.PERCENTAGE},rows:photoRows})]:[body('No photographs recorded for this inspection.')])
  ];
  // Certification
  const certBlock=[
    spacer(120),
    new Paragraph({children:[new TextRun({text:'Report Certification',bold:true,font:'Arial',size:22,color:MID_BLUE})],border:{bottom:{style:BorderStyle.SINGLE,size:6,color:MID_BLUE,space:1}},spacing:{before:0,after:60}}),
    body('I certify that the information contained in this Daily Environmental Compliance Report is accurate and complete to the best of my knowledge, and that all observations were conducted in accordance with the applicable Environmental Management and Construction Plan (EM\u0026CP) and all other relevant permit conditions and regulatory requirements.'),
    spacer(80),
    new Table({rows:[
      infoRow('Name:',logData.preparedBy),
      infoRow('Title:','Environmental Inspector'),
      infoRow('Date:',shortDate),
      infoRow('Reviewed by:',logData.reviewedBy)
    ]})
  ];
  // Footer — top border line, centered text, page number
  const footer=new Footer({children:[new Paragraph({
    alignment:AlignmentType.CENTER,
    border:{top:{style:BorderStyle.SINGLE,size:6,color:'AAAAAA',space:4}},
    spacing:{before:80},
    children:[
      new TextRun({text:`${logData.project}  |  Environmental Inspector Daily Report  |  Confidential  |  Page `,font:'Arial',size:16,color:'888888'}),
      new TextRun({children:[PageNumber.CURRENT],font:'Arial',size:16,color:'888888'})
    ]
  })]});
  // Word header — repeats on every page
  const wordHeader=new Header({children:[headerTable]});
  // Assemble — headerTable now in section header, not body
  const children=[
    ...titleBlock,infoTable,spacer(120),
    h1('1.  Weather Conditions'),spacer(60),weatherTable,spacer(80),
    ...sec2,spacer(80),...sec3,spacer(80),...sec4,spacer(80),...sec5,spacer(80),...sec6,
    ...certBlock
  ];
  const doc=new Document({sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1800,bottom:1080,left:1080,right:1080},header:{value:720}}},headers:{default:wordHeader},footers:{default:footer},children}]});
  return Packer.toBlob(doc);
}

// ── Report versioning + cache (B keystone) ──
// Architecture: every Generate Report writes a versioned snapshot to
//   users/{uid}/reports/{reportDate}/versions/{v1, v2, ...}
// Each version stores polish output + input snapshot + hash of input. On
// re-tap of Generate Report:
//   - no prior version → fresh polish, save as v1
//   - hash matches latest → silent cache hit, re-export from latest (no API call)
//   - hash differs → 3-choice modal: Cancel / Generate new / Re-export existing
// Re-export uses cached polish + cached input snapshot — same DOCX every time.
// This makes polished narratives durable, deterministic, and free to regenerate.

// Bump when rptCallClaude's CALL-LAYER architecture changes — invalidates ALL
// cached polish across all users at once. Use sparingly; for ordinary user-
// driven prompt edits, use the per-call effectivePromptHash dimension instead
// (which only invalidates the affected user's cache).
//
// 2026-05-08: bumped 1→2 for the C10 architectural shift. The system prompt
// is no longer hardcoded inline — it is assembled at runtime from a layer
// stack of user/project/(future-firm) prompt config docs via promptAssembly.js
// over promptDefaults.js. The integer captures system-level changes (model
// swap, message-format change, call-pattern change). Per-user content edits
// flow through effectivePromptHash and do not require a bump here.
const _RPT_PROMPT_VERSION = 2;

// Friendly labels for top-level logData fields. Presence here implies the
// field's value flows through Anthropic polish (narrative). Absent fields
// default to mechanical. Crew block subfields are handled by pattern below.
// To add a new narrative field: add an entry here. Mechanical fields need none.
const _FIELD_INFO = {
  inspectionSummary: {label:'Inspection Summary',     narrative:true},
  agencyInspection:  {label:'Agency Inspection',      narrative:true},
  landownerContact:  {label:'Landowner Contact',      narrative:true},
  rteObservation:    {label:'RTE Observation',        narrative:true},
  nonCompliance:     {label:'Non-Compliance',         narrative:true},
  generalComms:      {label:'General Communications', narrative:true},
  lookahead:         {label:'24-Hour Look Ahead',     narrative:true}
};

function _getFieldInfo(path){
  const m = path.match(/^crewBlocks\[(\d+)\]\.(\w+)$/);
  if(m){
    const n = parseInt(m[1])+1, sub = m[2];
    const subLabels = {name:'Name',time:'Time',location:'Location',activities:'Activities Observed',envCompliance:'Env Compliance',issues:'Issues',notes:'Notes'};
    return {label:`Crew ${n} — ${subLabels[sub]||sub}`, narrative:['activities','envCompliance','issues','notes'].includes(sub)};
  }
  return _FIELD_INFO[path] || {label:path, narrative:false};
}

// Walk an object and yield leaf paths like "weather.tempAM" or "crewBlocks[0].activities"
function _walkPaths(obj, prefix=''){
  const out = [];
  if(obj === null || obj === undefined) return out;
  if(Array.isArray(obj)){
    obj.forEach((item, i) => {
      const p = `${prefix}[${i}]`;
      if(item && typeof item === 'object') out.push(..._walkPaths(item, p));
      else out.push(p);
    });
  } else if(typeof obj === 'object'){
    for(const k of Object.keys(obj)){
      const p = prefix ? `${prefix}.${k}` : k;
      const v = obj[k];
      if(v && typeof v === 'object') out.push(..._walkPaths(v, p));
      else out.push(p);
    }
  } else {
    out.push(prefix);
  }
  return out;
}

function _getAtPath(obj, path){
  const parts = path.split(/[\.\[\]]/).filter(Boolean);
  let cur = obj;
  for(const p of parts){
    if(cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Recursive sort by key for stable JSON.stringify (hashes must be deterministic)
function _canonicalize(v){
  if(v === null || typeof v !== 'object') return v;
  if(Array.isArray(v)) return v.map(_canonicalize);
  const out = {};
  for(const k of Object.keys(v).sort()) out[k] = _canonicalize(v[k]);
  return out;
}

async function _hashSnapshot(snapshot){
  const canonical = _canonicalize({...snapshot, _promptVersion: _RPT_PROMPT_VERSION});
  const buf = new TextEncoder().encode(JSON.stringify(canonical));
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function _buildSnapshot(logData, compEntries, skipPolish, photos, effectivePromptHash){
  const photoRefs = (photos||[]).map(p => {
    const ref = {...p};
    delete ref._localUrl; delete ref._thumbUrl; delete ref._blobUrl;
    return ref;
  }).sort((a,b) => String(a.id||'').localeCompare(String(b.id||'')));
  const compRefs = (compEntries||[]).slice().sort((a,b) => String(a.id||'').localeCompare(String(b.id||'')));
  // effectivePromptHash (added 2026-05-08, C10) folds the user's assembled prompt
  // into the cache key. Identical inputs but different prompt config = cache miss.
  return {logData, compEntries: compRefs, skipPolish: !!skipPolish, photoRefs, effectivePromptHash: effectivePromptHash || ''};
}

function _categorizeChanges(prevSnap, currSnap){
  const allPaths = new Set([..._walkPaths(prevSnap.logData||{}), ..._walkPaths(currSnap.logData||{})]);
  let mechanicalCount = 0;
  const narrativeFields = [];
  for(const path of allPaths){
    const a = _getAtPath(prevSnap.logData, path);
    const b = _getAtPath(currSnap.logData, path);
    if((a||'') === (b||'')) continue;  // treat null/undefined/'' as equivalent
    const info = _getFieldInfo(path);
    if(info.narrative) narrativeFields.push(info.label);
    else mechanicalCount++;
  }
  return {mechanicalCount, narrativeFields};
}

async function _loadReportVersions(reportDate){
  if(!db || !_currentUser || !_fbReady) return [];
  try{
    const snap = await _udb().collection('reports').doc(reportDate).collection('versions').orderBy('version','desc').get();
    return snap.docs.map(d => d.data());
  } catch(e){
    console.warn('[report-cache] load failed:', e);
    return [];
  }
}

async function _saveReportVersion(reportDate, snapshot, polished, inputHash, version, effectivePromptHash){
  if(!db || !_currentUser || !_fbReady) return;
  try{
    // JSON round-trip strips undefined and ensures Firestore-compatible payload
    const cleanSnap = JSON.parse(JSON.stringify(snapshot));
    const cleanPolished = JSON.parse(JSON.stringify(polished));
    const verRef = _udb().collection('reports').doc(reportDate).collection('versions').doc('v'+version);
    await verRef.set({
      version,
      polished: cleanPolished,
      inputSnapshot: cleanSnap,
      inputHash,
      promptVersion: _RPT_PROMPT_VERSION,
      // effectivePromptHash stamped explicitly (in addition to being inside
      // inputSnapshot) so future migration logic can identify pre-vs-post-C10
      // versions without parsing the snapshot. Empty string for legacy rows.
      effectivePromptHash: effectivePromptHash || '',
      generatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      generatedAtMs: Date.now()
    });
    await _udb().collection('reports').doc(reportDate).set({
      reportDate,
      latestVersion: version,
      updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: Date.now()
    }, {merge:true});
  } catch(e){
    console.warn('[report-cache] save failed:', e);
    // Non-fatal — DOCX still ships to user, cache miss next time
  }
}

// Generic 3-choice modal: Cancel | secondary | primary (rightmost = default action)
function _3choiceModal(msg, title, primaryLabel, secondaryLabel, onChoice){
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box">'+
    '<div class="modal-title">'+title+'</div>'+
    '<div class="modal-msg">'+msg+'</div>'+
    '<div class="modal-btns">'+
      '<button class="modal-cancel" id="_3c">Cancel</button>'+
      '<button class="modal-confirm" id="_3b" style="background:transparent;border:1px solid var(--border2);color:var(--muted2)">'+secondaryLabel+'</button>'+
      '<button class="modal-confirm" id="_3a" style="background:var(--amber);border-color:var(--amber);color:#111">'+primaryLabel+'</button>'+
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_3c').onclick = function(){ ov.remove(); onChoice('cancel'); };
  document.getElementById('_3b').onclick = function(){ ov.remove(); onChoice('secondary'); };
  document.getElementById('_3a').onclick = function(){ ov.remove(); onChoice('primary'); };
}

function _fmtGenTime(ms){
  if(!ms) return '';
  const d = new Date(ms);
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ── Main generateReport function ──
async function generateReport(){
  if(!window.docx){_confirmModal('The report library is still loading. Please wait a moment and try again.',()=>{}, 'One Moment…', 'OK');return;}
  if(_isFormalized()){
    _polishChoiceModal(
      'You\'ve already formalized today\'s log language. Use your text as-is, or re-polish during report generation?',
      'Use As-Is',
      'Re-Polish',
      function(useAsIs){
        window._rptSkipPolish=useAsIs;
        const flagsND=flagItems.filter(f=>document.getElementById(f.id)?.checked&&!document.getElementById(f.id+'-note')?.value.trim());
        if(flagsND.length>0){
          _confirmModal(`${flagsND.length} regulatory flag(s) are checked without a description. Generate report anyway?`,()=>_doGenerate(),'⚠ Regulatory Flags','Generate Anyway');
          return;
        }
        _confirmModal('Boots to Boardroom — turn today\'s field log into a formal compliance report?',()=>_doGenerate(),'✦ Generate Report','Generate Report');
      }
    );
    return;
  }
  window._rptSkipPolish=false;
  const flagsWithoutDesc=flagItems.filter(f=>document.getElementById(f.id)?.checked&&!document.getElementById(f.id+'-note')?.value.trim());
  if(flagsWithoutDesc.length>0){
    _confirmModal(`${flagsWithoutDesc.length} regulatory flag(s) are checked without a description. Generate report anyway?`,()=>_doGenerate(), '⚠ Regulatory Flags', 'Generate Anyway');
    return;
  }
  _confirmModal('Boots to Boardroom — turn today\'s field log into a formal compliance report?',()=>_doGenerate(), '✦ Generate Report', 'Generate Report');
}
async function _doGenerate(){
  if(!window.docx){return;}
  const btn=document.getElementById('btn-generate-report');
  const status=document.getElementById('rpt-status');
  const setStatus=(msg,color)=>{if(status){status.textContent=msg;status.style.color=color||'var(--green)';status.style.opacity='1';}};
  const clearStatusSoon=()=>setTimeout(()=>{if(status)status.style.opacity='0';},3000);
  if(btn){btn.disabled=true;btn.textContent='\u29d7 Generating...';}
  try{
    setStatus('Retrieving API key\u2026');
    const apiKey=await rptGetApiKey();
    if(!apiKey) throw new Error('No API key found. Add your Anthropic API key in Settings \u2192 Report Generation.');
    // Collect log data
    const sky=[...document.querySelectorAll('input[name="sky"]:checked')].map(el=>el.value).join(', ')||'';
    const crew=crewIds.map(id=>({
      name:document.getElementById(`crew-${id}-name`)?.value.trim()||'',
      time:document.getElementById(`crew-${id}-time`)?.value.trim()||'',
      location:document.getElementById(`crew-${id}-loc`)?.value.trim()||'',
      activities:document.getElementById(`crew-${id}-acts`)?.value.trim()||'',
      envCompliance:document.getElementById(`crew-${id}-envcomp`)?.value.trim()||'',
      issues:document.getElementById(`crew-${id}-issues`)?.value.trim()||'',
      notes:document.getElementById(`crew-${id}-notes`)?.value.trim()||''
    }));
    const logData={
      project:document.getElementById('projectName').value,
      reportDate:document.getElementById('reportDate').value,
      preparedBy:document.getElementById('preparedBy').value,
      org:document.getElementById('org').value,
      activePhase:document.getElementById('activePhase').value,
      contractor:document.getElementById('contractor').value,
      location:document.getElementById('location').value,
      reviewedBy:document.getElementById('reviewedBy').value,
      weather:{sky,tempAM:document.getElementById('tempAM').value,tempPM:document.getElementById('tempPM').value,wind:document.getElementById('wind').value,precip:document.getElementById('precip').value,soilConditions:document.getElementById('soilCond').value,upcomingForecast:document.getElementById('upcomingWeather').value},
      inspectionSummary:document.getElementById('inspSummary').value.trim(),
      agencyInspection:document.getElementById('agencyInsp').value.trim(),
      landownerContact:document.getElementById('landowner').value.trim(),
      rteObservation:document.getElementById('rte').value.trim(),
      nonCompliance:document.getElementById('nonCompliance').value.trim(),
      crewBlocks:crew,
      generalComms:document.getElementById('genComms').value.trim(),
      lookahead:document.getElementById('lookahead').value.trim(),
      'p-timeIn':document.getElementById('p-timeIn').value
    };
    const reportDate=logData.reportDate;
    // Get compliance entries for this report date
    let compEntries=[];
    try{const all=JSON.parse((window.idbGet&&window.idbGet('cl_entries'))||'[]');compEntries=all.filter(e=>e.sourceReport===reportDate||e.date===reportDate);}catch(e){}
    const photos=_phPhotos.filter(p=>p.date===reportDate);
    const skipPolish=(window._rptSkipPolish===true);

    // Stage 4 (C10, 2026-05-08): assemble effective system prompt from the
    // user-sovereign layer stack BEFORE building the snapshot. The
    // effectivePromptHash flows into the snapshot so the cache key
    // automatically invalidates when the user edits their prompt config.
    //
    // Layer order (top of stack = highest precedence):
    //   1. project-specific override (per-project tone tweaks; no UI in Phase 1, dogfood-only)
    //   2. personal prompt (the user's saved customizations from the AI & Branding subpage)
    //   3. PROMPT_DEFAULTS (factory baseline; bottom of stack, always present)
    //
    // Phase 2 (multi-tenant) will add firm-baseline + firm-user-override + firm-project-override
    // layers BELOW the personal layer without disturbing this call site — see promptAssembly.js.
    setStatus('Loading prompt config…');
    const _activeProjId = (typeof _activeProjectId === 'function') ? _activeProjectId() : null;
    const [_personalPromptLayer, _projectOverrideLayer] = await Promise.all([
      (typeof loadPersonalPrompt === 'function') ? loadPersonalPrompt() : Promise.resolve(null),
      (typeof loadProjectOverride === 'function' && _activeProjId) ? loadProjectOverride(_activeProjId) : Promise.resolve(null)
    ]);
    const _promptLayers = [_projectOverrideLayer, _personalPromptLayer, window.PROMPT_DEFAULTS].filter(Boolean);
    const { systemPrompt: assembledSystemPrompt, effectivePromptHash } = await window.assemblePrompt({ layers: _promptLayers });

    // Build current snapshot + hash for cache lookup
    const currSnap=_buildSnapshot(logData,compEntries,skipPolish,photos,effectivePromptHash);
    const currHash=await _hashSnapshot(currSnap);

    // Look up prior versions from Firestore
    setStatus('Checking cache\u2026');
    const versions=await _loadReportVersions(reportDate);
    const latest=versions.length?versions[0]:null;  // sorted desc by version

    // Helper: assemble DOCX + open share sheet from any polished/snapshot pair
    const assembleAndSave=async(polishedToUse,snapshotToUse)=>{
      setStatus('Assembling report\u2026');
      const blob=await rptBuildDocx(snapshotToUse.logData,polishedToUse,snapshotToUse.photoRefs||[]);
      const[y,m,d]=reportDate.split('-');
      const _projName=(document.getElementById('cfg-projectName')?.value?.trim()||'GroundLog');
      const _projSlug=_projName.replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'GroundLog';
      const filename=`${m}-${d}-${y}_${_projSlug}-Daily_Inspection_Report.docx`;
      const mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      setStatus('Opening save sheet\u2026');
      await window.saveFileNative(blob,filename,mimeType);
    };

    // \u2500\u2500\u2500 Decision tree \u2500\u2500\u2500
    if(!latest){
      // No prior version \u2014 fresh polish, save as v1
      setStatus('Polishing report narrative\u2026');
      const polished=await rptCallClaude(apiKey,logData,compEntries,assembledSystemPrompt);
      _saveReportVersion(reportDate,currSnap,polished,currHash,1,effectivePromptHash).catch(e=>console.warn('[report-cache] write failed:',e));
      await assembleAndSave(polished,currSnap);
      setStatus('\u2713 Report generated!');
      clearStatusSoon();
      return;
    }

    if(latest.inputHash===currHash){
      // Silent cache hit \u2014 same input, re-export from latest version (no API call)
      await assembleAndSave(latest.polished,latest.inputSnapshot);
      setStatus('\u2713 Report re-exported (no changes since last generation).');
      clearStatusSoon();
      return;
    }

    // Input changed since last generation \u2014 surface 3-choice modal
    const diff=_categorizeChanges(latest.inputSnapshot,currSnap);
    const genTime=_fmtGenTime(latest.generatedAtMs);
    let modalMsg;
    if(diff.narrativeFields.length===0){
      const n=diff.mechanicalCount;
      modalMsg=`You generated a report for today at <strong>${genTime}</strong>. You've updated ${n} field value${n===1?'':'s'} since then but the narrative content is unchanged.<br><br>Re-exporting will give you that report with the new values filled in. Generating a new version will create a fresh report \u2014 the narrative may read slightly differently.`;
    } else {
      const fieldList=diff.narrativeFields.slice(0,5).map(f=>`<em>${f}</em>`).join(', ')+(diff.narrativeFields.length>5?', \u2026':'');
      const n=diff.narrativeFields.length;
      modalMsg=`You generated a report for today at <strong>${genTime}</strong>. You've edited ${n} narrative field${n===1?'':'s'} since then (${fieldList}).<br><br>Re-exporting will give you the original report unchanged. Generating a new version will produce a fresh report with new prose.`;
    }

    setStatus('Awaiting your choice\u2026');
    const choice=await new Promise(resolve=>{
      _3choiceModal(modalMsg,'Report already generated for today','Re-export existing','Generate new version',resolve);
    });

    if(choice==='cancel'){
      setStatus('Cancelled.');
      clearStatusSoon();
      return;
    }
    if(choice==='primary'){
      // Re-export existing \u2014 no API call, no new version
      await assembleAndSave(latest.polished,latest.inputSnapshot);
      setStatus('\u2713 Existing report re-exported.');
      clearStatusSoon();
      return;
    }
    if(choice==='secondary'){
      // Generate new version \u2014 fresh polish, save as v(latest+1)
      setStatus('Polishing report narrative\u2026');
      const polished=await rptCallClaude(apiKey,logData,compEntries,assembledSystemPrompt);
      const newVer=(latest.version||0)+1;
      _saveReportVersion(reportDate,currSnap,polished,currHash,newVer,effectivePromptHash).catch(e=>console.warn('[report-cache] write failed:',e));
      await assembleAndSave(polished,currSnap);
      setStatus(`\u2713 Report v${newVer} generated!`);
      clearStatusSoon();
      return;
    }
  }catch(e){
    setStatus('\u2717 '+e.message,'var(--red)');
    console.error('generateReport:',e);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='\u2756 Generate Report';}
  }
}

// ── Window exposures — called from HTML onclick attributes ──
// ── Per-project report logo (Settings → Report Generation) ──
function _rptLogoStatus(msg,isErr){
  const el=document.getElementById('cfg-report-logo-status');
  if(!el) return;
  el.textContent=msg;
  el.style.color=isErr?'#c0392b':'var(--green)';
  el.style.opacity='1';
  setTimeout(()=>{el.style.opacity='0';},3000);
}

async function rptLoadReportLogoUI(){
  const img=document.getElementById('cfg-report-logo-preview');
  const clearBtn=document.getElementById('cfg-report-logo-clear');
  if(!img||!clearBtn) return;
  img.style.display='none'; clearBtn.style.display='none';
  try{
    const pid=_activeProjectId();
    if(!pid||pid==='default'||typeof db==='undefined'||!db||!_fbReady) return;
    const d=await _udb().collection('settings').doc(pid).get();
    if(d.exists&&d.data().reportLogoB64){
      img.src=d.data().reportLogoB64;
      img.style.display='';
      clearBtn.style.display='';
    }
  }catch(e){}
}

function rptSaveReportLogo(files){
  const f=files&&files[0];
  if(!f) return;
  const pid=_activeProjectId();
  if(!pid||pid==='default'){_rptLogoStatus('Create a project first.',true);return;}
  const img=new Image();
  const url=URL.createObjectURL(f);
  img.onload=async function(){
    URL.revokeObjectURL(url);
    // Normalize: downscale to ≤600px wide, JPEG on white (DOCX page is white;
    // also caps the base64 well under the 1 MiB Firestore doc limit).
    const scale=Math.min(1,600/img.naturalWidth);
    const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(img.naturalWidth*scale));
    c.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=c.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
    ctx.drawImage(img,0,0,c.width,c.height);
    const dataUrl=c.toDataURL('image/jpeg',0.85);
    if(dataUrl.length>250000){_rptLogoStatus('Image too large — try a simpler logo.',true);return;}
    // Display dims in the DOCX: height 50, keep ratio, cap width 260.
    let h=50,w=Math.round(50*c.width/c.height);
    if(w>260){w=260;h=Math.round(260*c.height/c.width);}
    try{
      await _udb().collection('settings').doc(pid).set({reportLogoB64:dataUrl,reportLogoW:w,reportLogoH:h,_ts:Date.now()},{merge:true});
      rptLoadReportLogoUI();
      _rptLogoStatus('✓ Logo saved');
    }catch(e){_rptLogoStatus('Save failed: '+(e.message||'error'),true);}
  };
  img.onerror=function(){URL.revokeObjectURL(url);_rptLogoStatus('Could not read that image.',true);};
  img.src=url;
}

async function rptClearReportLogo(){
  const pid=_activeProjectId();
  if(!pid||pid==='default') return;
  try{
    const del=window.firebase.firestore.FieldValue.delete();
    await _udb().collection('settings').doc(pid).set({reportLogoB64:del,reportLogoW:del,reportLogoH:del,_ts:Date.now()},{merge:true});
    rptLoadReportLogoUI();
    _rptLogoStatus('✓ Logo removed');
  }catch(e){_rptLogoStatus('Remove failed: '+(e.message||'error'),true);}
}

window.generateReport = generateReport;
window.rptSaveReportLogo = rptSaveReportLogo;
window.rptClearReportLogo = rptClearReportLogo;
window.rptLoadReportLogoUI = rptLoadReportLogoUI;
window.polishLog = polishLog;
window.saveApiKey = saveApiKey;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.rptSaveHostedKey = rptSaveHostedKey;
window._rptInitHostedKeyBtn = _rptInitHostedKeyBtn;
