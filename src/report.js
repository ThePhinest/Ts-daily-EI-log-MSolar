
// ═══════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════

// ── Stantec logo (JPEG, base64) ──
const _RPT_LOGO_B64 = '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';

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
  // Show "Share key with pilot users" only for users who have their own API key saved
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
    if(btn){btn.textContent='✓ Shared';btn.disabled=true;setTimeout(()=>{btn.textContent='Share key with pilot users';btn.disabled=false;},3000);}
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
    ov.remove();
    if(selected.length) onConfirm(selected);
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
async function _doPolish(selectedFields, apiKey){
  const btn=document.getElementById('btn-formalize-log');
  const status=document.getElementById('rpt-status');
  const setStatus=function(msg,color){if(status){status.textContent=msg;status.style.color=color||'var(--green)';status.style.opacity='1';}};
  if(btn){btn.disabled=true;btn.textContent='Formalizing…';}
  try{
    const payload=Object.fromEntries(selectedFields.map(function(f){return[f.id,f.value];}));
    const systemPrompt='You are a professional field inspector writing assistant. Rewrite the provided field log text into clean, professional language suitable for a regulatory compliance report. Rules: use "conducting" not "performing"; use definitive language ("will" not "anticipated to"); contractor compliance language must be collaborative in tone; do not use first person; preserve all specific facts, measurements, locations, and compliance levels exactly as entered; do not add information not present in the original; do not remove relevant observations. Return a JSON object with the same keys as provided, containing the rewritten text for each field. Return ONLY the JSON object — no preamble, no markdown, no code fences.';
    const userPrompt='Rewrite these daily log fields:\n'+JSON.stringify(payload);
    const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:4000,system:systemPrompt,messages:[{role:'user',content:userPrompt}]})});
    if(!resp.ok){const err=await resp.text();throw new Error('API '+resp.status+': '+err);}
    const data=await resp.json();
    const text=data.content[0].text;
    const j0=text.indexOf('{'),j1=text.lastIndexOf('}');
    if(j0===-1||j1===-1) throw new Error('No JSON in response');
    const polished=JSON.parse(text.slice(j0,j1+1));
    selectedFields.forEach(function(f){
      if(polished[f.id]!=null){
        const el=document.getElementById(f.id);
        if(el) el.value=polished[f.id];
      }
    });
    if(typeof debouncedAutoSave==='function') debouncedAutoSave();
    _setFormalized();
    setStatus('✓ Log formalized');
    setTimeout(function(){if(status)status.style.opacity='0';},3000);
  }catch(e){
    console.error('Formalize Log error:',e);
    setStatus('✗ '+e.message.slice(0,60),'var(--red)');
    setTimeout(function(){if(status)status.style.opacity='0';},6000);
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
  // Logo + subtitle block
  const logoImg=new ImageRun({data:_b64ToArrayBuffer(_RPT_LOGO_B64),transformation:{width:200,height:50}});
  const titleBlock=[
    new Paragraph({alignment:AlignmentType.CENTER,children:[logoImg],spacing:{before:160,after:60}}),
    new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Daily Environmental Compliance Report',font:'Arial',size:22,color:MID_BLUE})],spacing:{before:0,after:160}})
  ];
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
    try{const all=JSON.parse(localStorage.getItem('cl_entries')||'[]');compEntries=all.filter(e=>e.sourceReport===reportDate||e.date===reportDate);}catch(e){}
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
      const filename=`${m}-${d}-${y}_Moraine_Solar-Daily_Inspection_Report.docx`;
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
window.generateReport = generateReport;
window.polishLog = polishLog;
window.saveApiKey = saveApiKey;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.rptSaveHostedKey = rptSaveHostedKey;
window._rptInitHostedKeyBtn = _rptInitHostedKeyBtn;
