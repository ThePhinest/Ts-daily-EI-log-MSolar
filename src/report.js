
// ═══════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════

// Report logo lives in PROJECT DATA (settings/{pid}.reportLogoB64), never in
// code: the Stantec logo that was hardcoded here landed on EVERY account's
// reports (caught 2026-06-11 pre-tester audit; original extracted to OneDrive
// Branding\stantec-report-logo.jpg - re-upload it to Moraine via Settings ->
// Report Generation -> Report Logo). No logo = clean text-only title block.

import { exportImageBlob, exportImageParams, stampIfCamera } from './exportImg.js';

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
// 8/26: own key only. The platform-hosted key never reaches the client any more —
// users without their own key go through the aiComplete Cloud Function (see
// _rptClaude). appConfig/hosted is dead (rules deny reads).
async function rptGetApiKey(){
  let enc=null;
  try{if(db&&_fbReady){const doc=await _udb().collection('appConfig').doc('reportSettings').get();if(doc.exists)enc=doc.data().encApiKey;}}catch(e){}
  if(!enc) enc=localStorage.getItem('pei_enc_api_key');
  if(!enc) return null;
  return rptDecryptKey(enc);
}
// One door to Claude. Own key → direct (their key, their account). No key →
// GroundLog-hosted key via the aiComplete Cloud Function (per-user daily cap).
// Returns the text block or throws a user-readable Error.
async function _rptClaude(systemPrompt,userPrompt,maxTokens){
  const apiKey=await rptGetApiKey();
  if(apiKey){
    const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:'claude-sonnet-5',max_tokens:maxTokens||8000,system:systemPrompt,messages:[{role:'user',content:userPrompt}]})});
    if(!resp.ok){const err=await resp.text();throw new Error('API '+resp.status+': '+err);}
    const data=await resp.json();
    const textBlock=(data.content||[]).find(function(b){return b.type==='text'&&b.text;});
    if(!textBlock){console.error('Claude: no text block in response. Content:',data.content);throw new Error('AI response empty \u2014 see console');}
    return textBlock.text;
  }
  if(!(db&&_fbReady&&window._currentUser)) throw new Error('Sign in (online) to use AI features, or add your own API key in Settings \u2192 Report Generation.');
  try{
    const fn=firebase.app().functions().httpsCallable('aiComplete');
    const res=await fn({system:systemPrompt,user:userPrompt,maxTokens:maxTokens||8000});
    return (res.data&&res.data.text)||'';
  }catch(e){
    // HttpsError messages are written for users (daily cap etc.) — surface them.
    throw new Error((e&&e.message)||'AI service unavailable.');
  }
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
  _polishSelectModal(fields,function(selected){_doPolish(selected);});
}

// ── Formalize Log — Claude API call + field update ──
// E1.3 diagnostics (2026-05-13): the "all checked fields stay unchanged" symptom
// could be caused by (a) Claude returning JSON keys that don't match field IDs,
// (b) JSON.parse failure on a malformed response, or (c) silent API failure.
// This version surfaces in-progress status, counts applied vs requested fields,
// logs missing keys + raw response on parse failure, and keeps the status visible
// longer so the user can spot warnings. Doesn't fix the underlying mystery — but
// next time Tim hits it, the console + status bar will show exactly what's wrong.
async function _doPolish(selectedFields){
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
    const text=await _rptClaude(systemPrompt,userPrompt,8000);
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
async function rptCallClaude(logData, compEntries, systemPromptIn){
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
  const text=await _rptClaude(finalSystemPrompt,userPrompt,8000);
  const clean=text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  return JSON.parse(clean);
}

// ── DOCX Assembly ──
async function rptBuildDocx(logData,polished,photos){
  if(!window.docx) throw new Error('Report library not loaded. Please refresh and try again.');
  const{Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,AlignmentType,BorderStyle,WidthType,ShadingType,ImageRun,Footer,Header,PageNumber,NumberFormat}=window.docx;
  // GroundLog palette (9/2 brand pass — Office blue retired): teal bands, teal-tint info cells,
  // amber rules under sub-heads. Per-tenant branding still overrides via config where wired.
  // 9/5: palette from the project's branding (brand.js); GroundLog colors when none is set.
  const _bd=(typeof window.glBrandDocx==='function')?window.glBrandDocx(_activeProjectId()):null;
  const BLUE=_bd?_bd.BLUE:'006B75',LT_BLUE=_bd?_bd.LT_BLUE:'E4EFEE',MID_BLUE=_bd?_bd.MID_BLUE:'006B75',WHITE=_bd?_bd.HTEXT:'FFFFFF',RULE=_bd?_bd.RULE:'C9A84C';
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
  const h2=(text)=>new Paragraph({children:[new TextRun({text,bold:true,color:MID_BLUE,font:'Arial',size:22})],border:{bottom:{style:BorderStyle.SINGLE,size:6,color:RULE,space:1}},spacing:{before:160,after:60}});
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
  try{ const L=await _rptLoadLogo(); if(L&&L.b64) _logo={b64:String(L.b64).replace(/^data:image\/\w+;base64,/,''),w:L.w||200,h:L.h||50,align:L.align||'center'}; }
  catch(e){ /* no logo is a valid state — never block report generation */ }
  const titleBlock=[];
  if(_logo){
    titleBlock.push(new Paragraph({alignment:_logo.align==='left'?AlignmentType.LEFT:_logo.align==='right'?AlignmentType.RIGHT:AlignmentType.CENTER,children:[new ImageRun({data:_b64ToArrayBuffer(_logo.b64),transformation:{width:_logo.w,height:_logo.h}})],spacing:{before:160,after:60}}));
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
  // 9/5: an entry's photos print directly UNDER its row (Tim: "item and photos, next item and
  // photos") \u2014 a full-width spanned row inside the same table.
  const compRows=[];
  for(const issue of compIssues){
    compRows.push(new TableRow({children:[
      new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.level||'',font:'Arial',size:18})]})]}),
      new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.description||'',font:'Arial',size:18})]})]}),
      new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.corrective||'',font:'Arial',size:18})]})]}),
      new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:issue.status||'',font:'Arial',size:18})]})]})
    ]}));
    const cpList=[];
    (issue.photoIds||[]).forEach(id=>{
      const p=(window._phPhotos||[]).find(x=>x.id===id)||(window._phShared||[]).find(x=>x.id===id);
      if(p) cpList.push({p,cap:p.caption?String(p.caption):(p.date?`Photo \u00b7 ${p.date}`:'Photo')});
    });
    if(!cpList.length) continue;
    const photoRowsHere=[];
    for(let i=0;i<cpList.length;i+=2){
      const cells=[];
      for(let j=i;j<Math.min(i+2,cpList.length);j++){
        const {p,cap}=cpList[j];
        try{
          let imgData;
          let blob=(typeof window.phExportBlobForRef==='function')?await window.phExportBlobForRef(p):null;
          if(!blob&&p.storageUrl) blob=await (await fetch(p.storageUrl)).blob();
          if(blob){blob=await stampIfCamera(p,blob);const ep=exportImageParams(p);blob=await exportImageBlob(blob,ep.maxPx,ep.quality);imgData=await blob.arrayBuffer();}
          else{const raw=p.thumb||'';const b64=raw.includes(',')?raw.split(',')[1]:raw;imgData=_b64ToArrayBuffer(b64);}
          cells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},margins:{top:40,bottom:40,left:40,right:40},children:[
            new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({data:imgData,transformation:{width:300,height:225}})]}),
            new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:cap,font:'Arial',size:18,italics:true})],spacing:{before:40,after:60}})
          ]}));
        }catch(e){cells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},children:[new Paragraph({children:[new TextRun({text:cap,font:'Arial',size:18})]})]}));}
      }
      if(cells.length===1) cells.push(new TableCell({borders:noBorders,width:{size:50,type:WidthType.PERCENTAGE},children:[new Paragraph({children:[]})]}));
      photoRowsHere.push(new TableRow({children:cells}));
    }
    compRows.push(new TableRow({children:[
      new TableCell({borders,columnSpan:4,shading:{fill:'FAFAFA',type:ShadingType.CLEAR},margins:{top:40,bottom:40,left:80,right:80},children:[
        new Table({borders:noBorders,width:{size:100,type:WidthType.PERCENTAGE},rows:photoRowsHere})
      ]})
    ]}));
  }
  const compTable=new Table({rows:[compHdr,...compRows]});
  const cpRows=[];
  const sec3=[
    h1('3.  Compliance Issues'),spacer(60),
    h2('Agency Inspections'),
    body(polished.agencyInspection||'No agency inspections conducted today.'),spacer(60),
    h2('Non-Compliance Observations'),spacer(40),
    body('Compliance Level Reference: Level 1 \u2014 Observation | Level 2 \u2014 Corrective Action | Level 3 \u2014 Non-Compliance | Level 4 \u2014 Stop Work Order'),
    spacer(40),compTable,spacer(60),
    ...(cpRows.length?[h2('Compliance Photos'),spacer(40),new Table({borders:noBorders,width:{size:100,type:WidthType.PERCENTAGE},rows:cpRows}),spacer(60)]:[]),
    h2('Landowner / Public Interactions'),
    body(polished.landownerContact||'No landowner or public interactions occurred today.'),spacer(60),
    h2('T&E Species / Unanticipated Discoveries'),
    body(polished.rteObservation||'No rare, threatened, or endangered species were observed. No unanticipated archaeological or cultural resource discoveries were encountered.')
  ];
  // Open Items resolved today — opt-in per item at resolve time (openItems.js).
  // Data comes straight from the spine (not AI-polished): the item lifecycle
  // (opened → resolved, with the resolution note) is the evidence trail.
  const oiRes=(typeof window.oiResolvedForReport==='function')?window.oiResolvedForReport(logData.reportDate):[];
  if(oiRes.length){
    const oiHdrCell=(t,w)=>new TableCell({borders,shading:{fill:BLUE,type:ShadingType.CLEAR},width:w?{size:w,type:WidthType.DXA}:undefined,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:t,bold:true,color:WHITE,font:'Arial',size:18})]})]});
    const oiCell=(t)=>new TableCell({borders,margins:{top:60,bottom:60,left:80,right:80},children:[new Paragraph({children:[new TextRun({text:t||'',font:'Arial',size:18})]})]});
    const oiFmt=(ds)=>{ if(!ds) return ''; const p=ds.split('-'); return p.length===3?`${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`:ds; };
    const oiTable=new Table({rows:[
      new TableRow({children:[oiHdrCell('Item',3600),oiHdrCell('Opened',1200),oiHdrCell('Resolved',1200),oiHdrCell('Resolution',3360)]}),
      ...oiRes.map(it=>new TableRow({children:[oiCell((typeof window.oiItemLabel==='function')?window.oiItemLabel(it):it.text),oiCell(oiFmt(it.createdDate)),oiCell(oiFmt(it.resolvedDate)),oiCell(it.resolutionNote||'Resolved')]}))
    ]});
    sec3.push(spacer(60),h2('Open Items Resolved'),spacer(40),oiTable);
  }
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
        let imgData;
        let blob=(typeof window.phExportBlobForRef==='function')?await window.phExportBlobForRef(p):null;   // 9/1: Storage → live library copy → thumb
        if(!blob&&p.storageUrl) blob=await (await fetch(p.storageUrl)).blob();
        if(blob){blob=await stampIfCamera(p,blob);const ep=exportImageParams(p);blob=await exportImageBlob(blob,ep.maxPx,ep.quality);imgData=await blob.arrayBuffer();}
        else{const raw=p.thumb||'';const b64=raw.includes(',')?raw.split(',')[1]:raw;imgData=_b64ToArrayBuffer(b64);}
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
    new Paragraph({children:[new TextRun({text:'Report Certification',bold:true,font:'Arial',size:22,color:MID_BLUE})],border:{bottom:{style:BorderStyle.SINGLE,size:6,color:RULE,space:1}},spacing:{before:0,after:60}}),
    body('I certify that the information contained in this Daily Environmental Compliance Report is accurate and complete to the best of my knowledge, and that all observations were conducted in accordance with the applicable Environmental Management and Construction Plan (EM\u0026CP) and all other relevant permit conditions and regulatory requirements.'),
    spacer(80),
    new Table({rows:[
      infoRow('Name:',logData.preparedBy),
      infoRow('Title:','Environmental Inspector'),
      infoRow('Date:',shortDate),
      infoRow('Reviewed by:',logData.reviewedBy)
    ]})
  ];
  // Footer — top border line, centered text, page number (+ 9/5 GroundLog attribution, project toggle)
  const _attribOn=(typeof window.glBrandAttribution==='function')?window.glBrandAttribution(_activeProjectId()):true;
  const _attribParas=()=>_attribOn?[new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:20},children:[new TextRun({text:window.GL_ATTRIB_TEXT||'Generated with GroundLog  ·  groundlog.io',font:'Arial',size:13,color:'AAAAAA'})]})]:[];
  const footer=new Footer({children:[new Paragraph({
    alignment:AlignmentType.CENTER,
    border:{top:{style:BorderStyle.SINGLE,size:6,color:'AAAAAA',space:4}},
    spacing:{before:80},
    children:[
      new TextRun({text:`${logData.project}  |  Environmental Inspector Daily Report  |  Confidential  |  Page `,font:'Arial',size:16,color:'888888'}),
      new TextRun({children:[PageNumber.CURRENT],font:'Arial',size:16,color:'888888'})
    ]
  }),..._attribParas()]});
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

// ── Per-project report logo (shared by the PDF export; the DOCX builder keeps
//    its own internal load) ──
async function _rptLoadLogo(){
  // 9/5: branding doc first (every member), legacy per-user location as fallback.
  try{ if(typeof window.glBrandLogo==='function'){ const b=await window.glBrandLogo(_activeProjectId()); if(b||b===null) return b; } }catch(e){}
  try{
    const _pid=_activeProjectId();
    if(_pid&&_pid!=='active'&&typeof db!=='undefined'&&db&&_fbReady){
      const _pd=await _udb().collection('settings').doc(_pid).get();
      if(_pd.exists&&_pd.data().reportLogoB64)
        return {b64:String(_pd.data().reportLogoB64),w:_pd.data().reportLogoW||200,h:_pd.data().reportLogoH||50};
    }
  }catch(e){}
  return null;
}

// ── §C (8/31): approved reviewer sign-off for this date, if any ──
// Looks up the latest active submission for the date; returns the review stamp
// ONLY when the approved snapshot's hash matches the content being exported —
// a reviewer signs a specific version, never whatever the form says later.
async function _rptApprovedReview(reportDate,inputHash){
  try{
    const pid=(typeof _activeProjectId==='function')?_activeProjectId():'';
    if(!pid||pid==='default'||typeof db==='undefined'||!db||!_fbReady) return null;
    const snap=await db.collection('projects').doc(pid).collection('submissions')
      .where('date','==',reportDate).get();
    let best=null;
    snap.forEach(sd=>{ const v=sd.data(); if(v.status!=='withdrawn'&&(!best||(v.version||1)>(best.version||1))) best=v; });
    if(!best||!best.review||best.review.status!=='approved') return null;
    if(best.reportSnapshot&&best.reportSnapshot.inputHash&&inputHash&&best.reportSnapshot.inputHash!==inputHash)
      return {stale:true};
    const rv=best.review;
    return {name:rv.reviewerName||'',title:rv.reviewerTitle||'',dateMs:rv.reviewedAt||0,signature:rv.signature||null};
  }catch(e){ return null; }
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

// Compliance table rows = the snapshot's entries (authoritative), polished text borrowed
// from Claude's rows when they line up (same count → by index; else by level + overlap).
function _rptWithCurrentCompliance(polished, snapshot){
  try{
    const entries=(snapshot&&Array.isArray(snapshot.compEntries))?snapshot.compEntries:null;
    if(!entries) return polished;
    const prows=(polished&&Array.isArray(polished.complianceIssues))?polished.complianceIssues.slice():[];
    const lvl=e=>{ const v=String(e.level==null?'':e.level).trim(); return /^level/i.test(v)?v:(v?'Level '+v:''); };
    const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>3);
    const aligned=prows.length===entries.length;
    const used=new Set();
    const rows=entries.map((e,i)=>{
      let p=null;
      if(aligned) p=prows[i];
      else{
        const words=norm(e.location);
        let best=-1,score=0;
        prows.forEach((row,j)=>{ if(used.has(j)) return; if(lvl(row)!==lvl(e)) return; const rw=norm(row.description); const s=words.filter(w=>rw.includes(w)).length; if(s>score){ score=s; best=j; } });
        if(best>=0&&score>0){ p=prows[best]; used.add(best); }
      }
      return {level:lvl(e)||(p&&p.level)||'', description:(e.cmpNum?('CMP-'+String(e.cmpNum).padStart(2,'0')+' — '):'')+((p&&p.description)||e.location||''), corrective:(p&&p.corrective)||e.corrective||'', status:e.status||(p&&p.status)||'', dateResolved:e.dateResolved||'', photoIds:Array.isArray(e.photoIds)?e.photoIds.slice():[]};
    });
    if(!rows.length) return polished;   // no entries → the polished "no issues" row stands
    return Object.assign({}, polished, {complianceIssues:rows});
  }catch(err){ console.warn('[report] compliance merge failed, using polished rows:',err); return polished; }
}

function _buildSnapshot(logData, compEntries, skipPolish, photos, effectivePromptHash){
  const toRef = p => {
    const ref = {...p};
    delete ref._localUrl; delete ref._thumbUrl; delete ref._blobUrl;
    // 8/26: the 280px camera thumb (~30 KB base64 per photo, in the doc since 8/24)
    // pushed a 30-photo day's version doc past Firestore's 1 MiB cap → cache save
    // failed silently. Identity/caption/geo fields are the cache key; pixels aren't.
    delete ref.thumb;
    // 9/1: a shot whose upload hasn't landed has no Storage URL for a REVIEWER's
    // device to fetch — keep its thumb in the ref (only then, ~30 KB) so the
    // review PDF prints a low-res copy instead of a caption-only cell.
    if(!ref.storageUrl && p.thumb && String(p.thumb).startsWith('data:')) ref.thumb = p.thumb;
    return ref;
  };
  const photoRefs = (photos||[]).map(toRef).sort((a,b) => String(a.id||'').localeCompare(String(b.id||'')));
  const compRefs = (compEntries||[]).slice().sort((a,b) => String(a.id||'').localeCompare(String(b.id||'')));
  // 9/5: photos attached to the day's compliance entries ride the snapshot as refs too, so a
  // REVIEWER's device (which can't read the author's photo library) prints them in §3.
  const seen = new Set(photoRefs.map(r => r.id));
  const compPhotoRefs = [];
  compRefs.forEach(e => (e.photoIds||[]).forEach(id => {
    if(seen.has(id)) return;
    const p = (window._phPhotos||[]).find(x => x.id===id) || (window._phShared||[]).find(x => x.id===id);
    if(p){ seen.add(id); compPhotoRefs.push(toRef(p)); }
  }));
  compPhotoRefs.sort((a,b) => String(a.id||'').localeCompare(String(b.id||'')));
  // Opted-in resolved Open Items render in the DOCX (openItems.js), so they must
  // be part of the cache key — resolving one after generating must be a cache miss.
  const oiRefs = ((typeof window.oiResolvedForReport==='function')?window.oiResolvedForReport(logData.reportDate):[])
    .map(it => ({id:it.id, text:it.text, title:it.title||'', resolutionNote:it.resolutionNote, createdDate:it.createdDate, resolvedDate:it.resolvedDate}))
    .sort((a,b) => String(a.id||'').localeCompare(String(b.id||'')));
  // effectivePromptHash (added 2026-05-08, C10) folds the user's assembled prompt
  // into the cache key. Identical inputs but different prompt config = cache miss.
  // 9/5: resolved brand colors ride the snapshot — the reviewer renders the author's palette, and a branding change is a real content change (new version).
  const brand = (typeof window.glBrandSnapshot==='function') ? window.glBrandSnapshot(_activeProjectId()) : null;
  return {logData, compEntries: compRefs, skipPolish: !!skipPolish, photoRefs, compPhotoRefs, oiRefs, brand, effectivePromptHash: effectivePromptHash || ''};
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
  // A change in opted-in resolved Open Items is a mechanical (table) change.
  if(JSON.stringify(prevSnap.oiRefs||[]) !== JSON.stringify(currSnap.oiRefs||[])) mechanicalCount++;
  // 9/1: photo selection is mechanical (the pictures re-flow, prose unchanged);
  // compliance entries are NARRATIVE — the report's compliance table is Claude
  // output, so a new/changed entry needs a fresh polish to appear.
  const photoIds=snap=>(snap.photoRefs||[]).map(p=>p.id).sort().join(',');
  const photoChanged=photoIds(prevSnap)!==photoIds(currSnap);
  if(photoChanged) mechanicalCount++;
  if(JSON.stringify(prevSnap.compEntries||[]) !== JSON.stringify(currSnap.compEntries||[])) narrativeFields.push('Compliance issues');
  return {mechanicalCount, narrativeFields, photoChanged};
}

// 9/1 — Generate-Report photo picker (same tap grid as the SWPPP photo picker).
// Resolves to the selected photo records, or null on cancel. Persists the
// choice as reportExclude on each photo so re-exports, the reviewer snapshot
// and the submit-day sheet all agree.
function _rptPickPhotos(reportDate,pool){
  if(!pool.length) return Promise.resolve([]);
  if(!document.getElementById('sw-css')&&!document.getElementById('rpt-pick-css')){
    const st=document.createElement('style'); st.id='rpt-pick-css';
    st.textContent=`.sw-pick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;max-height:46vh;overflow-y:auto}
.sw-pick{position:relative;border:2px solid transparent;border-radius:8px;overflow:hidden;cursor:pointer;height:0;padding-bottom:75%;background:var(--s2,#1a2a38)}
.sw-pick img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.sw-pick.on{border-color:var(--amber)}
.sw-pick.on::after{content:'\u2713';position:absolute;top:4px;right:4px;background:var(--amber);color:#000;border-radius:50%;width:18px;height:18px;font-size:12px;display:flex;align-items:center;justify-content:center}
.sw-pick-date{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#fff;font-family:var(--mono);font-size:8px;padding:2px 4px}`;
    document.head.appendChild(st);
  }
  const sorted=pool.slice().sort((a,b)=>(a.uploadedAt||0)-(b.uploadedAt||0));
  return new Promise(resolve=>{
    const ov=document.createElement('div'); ov.className='modal-overlay'; ov.id='rpt-pick-ov';
    const esc=t=>String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
    const cells=sorted.map(p=>`<div class="sw-pick${p.reportExclude?'':' on'}" data-id="${esc(p.id)}" title="${esc(p.caption)}">
      <img src="${p.thumb||''}" loading="lazy">
      <span class="sw-pick-date">${esc(p.caption||p.date||'')}</span>
    </div>`).join('');
    ov.innerHTML=`<div class="modal-box" style="max-width:560px">
      <h3 style="margin:0 0 4px">Photos for this report</h3>
      <p style="font-size:11px;color:var(--muted);margin:0 0 10px">Tap to include or leave out. Your choice sticks \u2014 it also sets what's checked when you submit the day to the project. <span id="rpt-pick-count"></span></p>
      <div class="sw-pick-grid" id="rpt-pick-grid">${cells}</div>
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:12px">
        <button class="btn btn-outline" style="font-size:11px" id="rpt-pick-all">Select all</button>
        <div style="display:flex;gap:10px">
          <button class="btn btn-outline" id="rpt-pick-cancel">Cancel</button>
          <button class="btn" id="rpt-pick-ok">Use selected</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const grid=ov.querySelector('#rpt-pick-grid');
    const count=()=>{ const n=grid.querySelectorAll('.sw-pick.on').length; ov.querySelector('#rpt-pick-count').textContent=`${n} of ${sorted.length} selected.`; };
    grid.querySelectorAll('.sw-pick').forEach(el=>{ el.onclick=()=>{ el.classList.toggle('on'); count(); }; });
    count();
    ov.querySelector('#rpt-pick-all').onclick=()=>{ const all=grid.querySelectorAll('.sw-pick'); const allOn=grid.querySelectorAll('.sw-pick.on').length===all.length; all.forEach(el=>el.classList.toggle('on',!allOn)); count(); };
    const done=async ok=>{
      if(!ok){ ov.remove(); resolve(null); return; }
      const on=new Set(Array.from(grid.querySelectorAll('.sw-pick.on')).map(el=>el.dataset.id));
      ov.remove();
      const inc=sorted.filter(p=>on.has(p.id)).map(p=>p.id), exc=sorted.filter(p=>!on.has(p.id)).map(p=>p.id);
      if(typeof window.phSetReportExclude==='function'){
        try{ await window.phSetReportExclude(exc,true); await window.phSetReportExclude(inc,false); }catch(e){}
      }
      resolve(sorted.filter(p=>on.has(p.id)));
    };
    ov.querySelector('#rpt-pick-cancel').onclick=()=>done(false);
    ov.querySelector('#rpt-pick-ok').onclick=()=>done(true);
    ov.onclick=e=>{ if(e.target===ov) done(false); };
  });
}

// 9/1 — a camera shot saves local-first with storageUrl '' and heals when the
// background upload lands; a snapshot built in that window has no URL for it,
// so the PDF (which renders from refs) printed caption-only cells. Wait briefly
// for in-flight uploads, kick the retry/recover passes, then continue — the
// author's export still falls back to the local copy (phExportBlobForRef), but
// a reviewer's device can only print what's in Storage, so say so.
async function _rptAwaitUploads(photos,setStatus){
  const missing=()=>photos.filter(p=>!p.storageUrl&&p.filename);
  if(!missing().length) return;
  setStatus('Waiting for photo uploads\u2026');
  const deadline=Date.now()+20000;
  let recovered=false;
  while(missing().length&&Date.now()<deadline){
    try{ if(window.phRetryPendingUploads) await window.phRetryPendingUploads(); }catch(e){}
    if(missing().length&&!recovered){ recovered=true; try{ if(window.phRecoverStorageUrls) await window.phRecoverStorageUrls(); }catch(e){} }
    if(missing().length) await new Promise(r=>setTimeout(r,1500));
  }
  const left=missing().length;
  if(left) setStatus(`\u26a0 ${left} photo${left===1?'':'s'} not uploaded yet \u2014 included from this device; a reviewer copy would miss ${left===1?'it':'them'} until the upload lands.`,'var(--amber)');
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
    setStatus('Preparing\u2026');
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
    // 9/1 (Tim: "isn't showing the open Level 3 issue"): a compliance entry
    // stays in every daily report from the day it's opened until the day it's
    // resolved (inclusive) — not only on the day it was logged. Project-scoped
    // like clGetOpenEntries (legacy rows without a projectId still count).
    let compEntries=[];
    try{
      const all=JSON.parse((window.idbGet&&window.idbGet('cl_entries'))||'[]');
      const pidNow=(typeof _activeProjectId==='function')?_activeProjectId():null;
      compEntries=(typeof window.clEntriesForReport==='function')?window.clEntriesForReport(reportDate,pidNow):all.filter(e=>{
        if(e.deletedAt) return false;
        if(pidNow&&e.projectId&&e.projectId!==pidNow) return false;
        if(e.sourceReport===reportDate||e.date===reportDate) return true;
        if(!e.date||e.date>reportDate) return false;           // opened after this report's day
        if(e.status==='Resolved') return e.dateResolved===reportDate;  // resolved today = last appearance
        return true;                                            // Open / In Progress carries forward
      });
    }catch(e){}
    // 9/1: photo selection — the day's photos minus any flagged reportExclude
    // (set here in the picker OR by unchecking at submit-day; one flag, both
    // places). Picker is the SWPPP-style tap grid, all-in by default.
    const dayPool=_phPhotos.filter(p=>p.date===reportDate);
    const picked=await _rptPickPhotos(reportDate,dayPool);
    if(!picked){ setStatus('Cancelled.'); clearStatusSoon(); return; }
    const photos=picked;
    await _rptAwaitUploads(photos,setStatus);
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

    // Helper: assemble the report + open share sheet from any polished/snapshot
    // pair. 8/31: PDF is the PRIMARY export (GroundLog-branded dailyBuildPdf);
    // DOCX stays available from the Reports-page archive. An approved reviewer
    // sign-off (\u00a7C) stamps in when its snapshot hash matches this content.
    const assembleAndSave=async(polishedToUse,snapshotToUse,hashForUse)=>{
      setStatus('Assembling report\u2026');
      // 9/2 (Tim: "daily report doesn't include the 4 Level 3 observations I added today"):
      // the compliance TABLE used to be whatever Claude returned on the last polish, so a
      // re-export from cache (the mechanical-change path) silently dropped entries added
      // since. Rows now come from the snapshot's entries — Claude's polished wording is
      // kept where a row lines up, raw entry text fills the rest. Level/status/dates are
      // always the entry's own.
      polishedToUse=_rptWithCurrentCompliance(polishedToUse,snapshotToUse);
      const [pdfMod,authorSig,logo]=await Promise.all([
        import('./swpppPdf.js'),
        (typeof window.glSigLoad==='function')?window.glSigLoad().catch(()=>null):Promise.resolve(null),
        _rptLoadLogo()
      ]);
      const review=await _rptApprovedReview(reportDate,hashForUse||null);
      const oiRes=snapshotToUse.oiRefs||((typeof window.oiResolvedForReport==='function')?window.oiResolvedForReport(reportDate):[]);
      setStatus('Opening save sheet\u2026');
      await pdfMod.dailyExportPdfNow(snapshotToUse.logData,polishedToUse,snapshotToUse.photoRefs||[],{
        oiRes,
        compPhotoRefs:snapshotToUse.compPhotoRefs||[],
        brand:snapshotToUse.brand||null,
        authorSig:(authorSig&&authorSig.b64)?authorSig:null,
        logo,
        review:(review&&!review.stale)?review:null
      });
      if(review&&review.stale)
        setStatus('\u26a0 Content changed since the reviewer signed \u2014 exported without the reviewer signature.','var(--amber)');
    };

    // \u2500\u2500\u2500 Decision tree \u2500\u2500\u2500
    if(!latest){
      // No prior version \u2014 fresh polish, save as v1
      setStatus('Polishing report narrative\u2026');
      const polished=await rptCallClaude(logData,compEntries,assembledSystemPrompt);
      _saveReportVersion(reportDate,currSnap,polished,currHash,1,effectivePromptHash).catch(e=>console.warn('[report-cache] write failed:',e));
      await assembleAndSave(polished,currSnap,currHash);
      setStatus('\u2713 Report generated!');
      clearStatusSoon();
      return;
    }

    if(latest.inputHash===currHash){
      // Silent cache hit \u2014 same input, re-export from latest version (no API call)
      await assembleAndSave(latest.polished,latest.inputSnapshot,latest.inputHash);
      setStatus('\u2713 Report re-exported (no changes since last generation).');
      clearStatusSoon();
      return;
    }

    // Input changed since last generation \u2014 surface 3-choice modal
    const diff=_categorizeChanges(latest.inputSnapshot,currSnap);
    const genTime=_fmtGenTime(latest.generatedAtMs);
    let modalMsg;
    if(diff.narrativeFields.length===0){
      const n=diff.mechanicalCount-(diff.photoChanged?1:0);
      const what=[n?`${n} field value${n===1?'':'s'}`:'',diff.photoChanged?'the photo selection':''].filter(Boolean).join(' and ')||'a field value';
      modalMsg=`You generated a report for today at <strong>${genTime}</strong>. You've updated ${what} since then but the narrative content is unchanged.<br><br>Re-exporting will give you that report with the new values and photos filled in. Generating a new version will create a fresh report \u2014 the narrative may read slightly differently.`;
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
      if(diff.narrativeFields.length===0){
        // 9/1: mechanical-only change (values / photo selection / open items) —
        // keep the existing prose but render the CURRENT snapshot, exactly as
        // the modal promises, and save it as a version so the hash on file
        // matches what was exported (the \u00a7C reviewer stamp is hash-gated).
        const newVer=(latest.version||0)+1;
        _saveReportVersion(reportDate,currSnap,latest.polished,currHash,newVer,effectivePromptHash).catch(e=>console.warn('[report-cache] write failed:',e));
        await assembleAndSave(latest.polished,currSnap,currHash);
        setStatus('\u2713 Report re-exported with your updates.');
        clearStatusSoon();
        return;
      }
      // Narrative changed but the user wants the original \u2014 no API call, no new version
      await assembleAndSave(latest.polished,latest.inputSnapshot,latest.inputHash);
      setStatus('\u2713 Existing report re-exported.');
      clearStatusSoon();
      return;
    }
    if(choice==='secondary'){
      // Generate new version \u2014 fresh polish, save as v(latest+1)
      setStatus('Polishing report narrative\u2026');
      const polished=await rptCallClaude(logData,compEntries,assembledSystemPrompt);
      const newVer=(latest.version||0)+1;
      _saveReportVersion(reportDate,currSnap,polished,currHash,newVer,effectivePromptHash).catch(e=>console.warn('[report-cache] write failed:',e));
      await assembleAndSave(polished,currSnap,currHash);
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
    if(!pid||pid==='default') return;
    const L=await _rptLoadLogo();
    if(L&&L.b64){ img.src=L.b64; img.style.display=''; clearBtn.style.display=''; }
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
      const res=await window.glBrandSave(pid,{logoB64:dataUrl,logoW:w,logoH:h});
      rptLoadReportLogoUI();
      _rptLogoStatus(res&&res.ok?'✓ Logo saved':'Saved locally only — a project lead has to set branding',!(res&&res.ok));
    }catch(e){_rptLogoStatus('Save failed: '+(e.message||'error'),true);}
  };
  img.onerror=function(){URL.revokeObjectURL(url);_rptLogoStatus('Could not read that image.',true);};
  img.src=url;
}

async function rptClearReportLogo(){
  const pid=_activeProjectId();
  if(!pid||pid==='default') return;
  try{
    await window.glBrandSave(pid,{logoB64:null,logoW:null,logoH:null});
    rptLoadReportLogoUI();
    _rptLogoStatus('✓ Logo removed');
  }catch(e){_rptLogoStatus('Remove failed: '+(e.message||'error'),true);}
}

window.generateReport = generateReport;
window.rptBuildDocx = rptBuildDocx;   // Reports-page archive re-export (swppp.js)
window._rptLoadLogo = _rptLoadLogo;             // shared by the archive PDF export (swppp.js)
window._rptApprovedReview = _rptApprovedReview; // §C sign-off stamp lookup (swppp.js)
window.rptSaveReportLogo = rptSaveReportLogo;
window.rptClearReportLogo = rptClearReportLogo;
window.rptLoadReportLogoUI = rptLoadReportLogoUI;
window.polishLog = polishLog;
window.saveApiKey = saveApiKey;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
