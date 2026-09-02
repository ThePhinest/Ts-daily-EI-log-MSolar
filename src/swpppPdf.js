// ═══════════════════════════════════════════
// SWPPP QI REPORT — PDF EXPORT (house render)
// ═══════════════════════════════════════════
//
// Mirrors swpppBuildDocx (swppp.js) section-for-section so the PDF is the
// same document as the DOCX — the DOCX stays the working/signing format
// (signatures happen in Word); the PDF is the distributed record.
//
// Lazy-loaded: swppp.js dynamic-imports this module on first PDF export, so
// pdfmake (+ its embedded Roboto fonts) never touches the main bundle.
//
// Fonts: pdfmake's Roboto covers the body text but has no checkbox glyphs —
// GLSym below is a ~3.5 KB subset of DejaVu Sans (free Bitstream Vera /
// public-domain license) carrying just ☐ (U+2610), ☒ (U+2612), ✔ (U+2714).
// Checkbox runs switch to it inline; everything else stays Roboto.

import { saveFileNative } from './saveFile.js';
import { exportImageBlob, exportImageParams, stampIfCamera } from './exportImg.js';

const GLSYM_B64 = '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A2cRQgVm/gNl/gNk/gNj/gNi/gNhOgNg+gNeDANd/gNb/gNa/gNZWAoFWfoDWAoDVxYZBVcyA1b+A1VUFQVVQgNUFQNTARAFUxgDUhQDUUoTBVH+A1ALA0/+A05NEAVO/gNNEANM/gNLShMFS/4DSkkQBUoTA0kdDQVJEANIDQNH/gNGlgNFlgNE/gNDAi0FQ/oDQrsDQUsDQP4DP/4DPj0SBT4UAz08DwU9EgM8Ow0FPED/DwM7DQM6/gM5/gM4NxQFOPoDNzYQBTcUAzY1CwU2EAM1CwM0HgMzDQMyMQsFMv4DMQsDMC8LBTANAy8LAy4tCQUuEAMtCQMsMgMrKiUFK2QDKikSBSolAykSAygnJQUoQQMnJQMmJQsFJg8DJQsDJP4DI/4DIg8DIQEQBSESAyBkAx/6Ax4dDQUeZAMdDQMcEUIFHP4DG/oDGkIDGRFCBRn+AxhkAxcWGQUX/gMWARAFFhkDFf4DFP4DE/4DEhFCBRL+AxECLQURQgMQfQMPZAMO/gMNDBYFDf4DDAEQBQwWAwv+AwoQAwn+AwgCLQUI/gMHFAMGZAMEARAFBP4DQBUDAi0FA/4DAgEQBQItAwEQAwD+AwG4AWSFjQErKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysAKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKx0BNQC4AMsAywDBAKoAnAGmALgAZgAAAHEAywCgArIAhQB1ALgAwwHLAYkCLQDLAKYA8ADTAKoAhwDLA6oEAAFKADMAywAAANkFAgD0AVQAtACcATkBFAE5BwYEAAROBLQEUgS4BOcEzQA3BHMEzQRgBHMBMwOiBVYFpgVWBTkDxQISAMkAHwC4Ad8AcwC6A+kDMwO8BEQEDgDfA80DqgDlA6oEBAAAAMsAjwCkAHsAuAAUAW8AfwJ7AlIAjwDHBc0AmgCaAG8AywDNAZ4B0wDwALoBgwDVAJgDBAJIAJ4B1QDBAMsA9gCDA1QCfwAAAzMCZgDTAMcApADNAI8AmgBzBAAF1QEKAP4CKwCkALQAnAAAAGIAnAAAAB0DLQXVBdUF1QXwAH8AewBUAKQGuAYUByMB0wC4AMsApgHDAewGkwCgANMDXANxA9sBhQQjBKgESACPATkBFAE5A2AAjwXVAZoGFAcjBmYBeQRgBGAEYAR7AJwAAAJ3BGABqgDpBGAHYgB7AMUAfwJ7AAAAtAJSBc0AZgC8AGYAdwYQAM0BOwGFA4kAjwB7AAAAHQDNB0oELwCcAJwAAAd9AG8AAABvAzUAagBvAHsArgCyAC0DlgCPAnsA9gCDA1QGNwX2AI8AnAThAmYAjwGNAvYAzQNEACkAZgTuAHMAABQAAJYAAAAAAAAABgAAAAMAAAAAAAD/fgBaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAgAAv//AAMAAQAAAAwAAAAAAAAAAgABAAEABAABAAAAAQAAAAoAHAAeAAFERkxUAAgABAAAAAD//wAAAAAAAAABAAAACgCSAJQAFERGTFQAemFyYWIAhGFybW4AhGJyYWkAhGNhbnMAhGNoZXIAhGN5cmwAhGdlb3IAhGdyZWsAhGhhbmkAhGhlYnIAhGthbmEAhGxhbyAAhGxhdG4AhG1hdGgAhG5rbyAAhG9nYW0AhHJ1bnIAhHRmbmcAhHRoYWkAhAAEAAAAAP//AAAAAAAAAAAAAAAAAAEAAAAKAOAA6ABQADwMAAfdAAAAAAKCAAAEYAAABdUAAAAAAAAEYAAAAAAAAAAAAAAAAAAABGAAAAAAAAABaAAABGAAAABVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEOAAACdgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWgAAAQ4AAABaAAAAWgAAAQ4AAAAAAAAAAAAAAQ4AAABaAAAAWgAAAQ4AAABaAAAAWgAAAFoAAAFyAAAAWgAAAFoAAAI4AAD7jwAAADwAAAAAAAAAAAAoAAoACgAAAAAAAQAAAAA=';

// ── pdfmake singleton (fonts registered once) ──
let _pm = null;
async function _getPdfMake(){
  if(_pm) return _pm;
  const mod = await import('pdfmake/build/pdfmake.js');
  const pdfMake = mod.default || mod;
  const robotoMod = await import('pdfmake/build/fonts/Roboto.js');
  pdfMake.addFontContainer(robotoMod.default || robotoMod);
  pdfMake.addFontContainer({
    vfs: { 'GLSym.ttf': { data: GLSYM_B64, encoding: 'base64' } },
    fonts: { GLSym: { normal:'GLSym.ttf', bold:'GLSym.ttf', italics:'GLSym.ttf', bolditalics:'GLSym.ttf' } }
  });
  _pm = pdfMake;
  return _pm;
}

// ── palette + metrics (DOCX constants; sizes are half-points there → pt here) ──
const BLUE='#1F3864', LT_BLUE='#D9E2F3', MID_BLUE='#2E5496', AMBER='#FFF2CC', HAIR='#AAAAAA';
// Palette switch for the shared builders (9/2 brand pass): the QI report keeps the Office
// blue its recipients have seen all project (Tim 8/31: QI stays blue until the mid-project
// freeze lifts); every other PDF built here runs GroundLog teal/amber. Each builder sets it.
const PAL_OFFICE={h:BLUE,lt:LT_BLUE,mid:MID_BLUE,hot:AMBER};
const PAL_GL={h:'#006B75',lt:'#E4EFEE',mid:'#006B75',hot:'#F7EFD9'};
let _pal=PAL_OFFICE;
const PAGE_W=612, MARG=54, CONTENT_W=PAGE_W-2*MARG;   // Letter, 0.75" side margins
// Column widths for a hairLayout table: pdfmake ADDS cell padding (6+6/col) and the
// 0.5pt hairlines ON TOP of fixed widths, so raw %-of-content columns overpack the
// table and the trailing '*' column collapses below its min word width → the table
// bleeds past the right margin. cols(...pcts) budgets the percentages against the
// width actually available to columns (content − padding − lines) and appends the
// '*' column, so every table lands flush on both margins like the section headers.
const cols=(...pcts)=>{
  const n=pcts.length+1;                              // + the trailing '*' column
  const usable=CONTENT_W - 12*n - 0.5*(n+1);          // hairLayout: 6+6 padding, 0.5 lines
  return [...pcts.map(p=>Math.floor(usable*p/100)),'*'];
};

// Checkbox run — GLSym font carries ☐/☒ (Roboto doesn't)
const cb=(on)=>({text:(on?'☒':'☐')+' ',font:'GLSym'});

// ── table layouts ──
const hairLayout={
  hLineWidth:()=>0.5, vLineWidth:()=>0.5,
  hLineColor:()=>HAIR, vLineColor:()=>HAIR,
  paddingLeft:()=>6, paddingRight:()=>6, paddingTop:()=>3.5, paddingBottom:()=>3.5
};
const imgGridLayout={
  hLineWidth:()=>0, vLineWidth:()=>0,
  paddingLeft:()=>2, paddingRight:()=>2, paddingTop:()=>2, paddingBottom:()=>2
};

// ── shared builders ──
const h1=(text)=>({table:{widths:['*'],body:[[{text,bold:true,color:'#FFFFFF',fontSize:12,fillColor:_pal.h,border:[false,false,false,false]}]]},
  layout:{hLineWidth:()=>0,vLineWidth:()=>0,paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>3,paddingBottom:()=>3},
  headlineLevel:1, margin:[0,10,0,5]});
const note=(text)=>text?{text,fontSize:8,italics:true,color:'#555555',margin:[0,0,0,3]}:{text:'',margin:[0,0,0,0]};
const body=(textOrRuns,opts)=>Object.assign({text:textOrRuns,fontSize:10,margin:[0,2,0,2]},opts||{});
const hcell=(text)=>({text,bold:true,color:'#FFFFFF',fillColor:_pal.h,fontSize:9});
const cell=(text,o)=>{o=o||{};return {text:String(text==null?'':text),fontSize:o.size||9,bold:!!o.bold,italics:!!o.i,fillColor:o.fill,color:o.color};};
const infoRow=(label,value)=>[
  {text:label,bold:true,fontSize:10,fillColor:_pal.lt},
  (value&&value.text!==undefined)||Array.isArray(value)?{text:value,fontSize:10}:{text:String(value==null?'':value),fontSize:10}
];
const infoTable=(rows)=>({table:{dontBreakRows:true,widths:[160,'*'],body:rows},layout:hairLayout,margin:[0,2,0,4]});

// Photo/sketch → {dataUrl,w,h} sized like the DOCX (px→pt ×0.75), thumb fallback
async function _imgFor(pId,maxWpx,maxHpx){
  maxHpx=maxHpx||700;
  const p=(window._phPhotos||[]).find(x=>x.id===pId);
  if(!p) return null;
  try{
    // 9/1: photos.js resolves the bytes (Storage → author's live library copy →
    // thumb) so a shot still uploading at generate time prints on the author's
    // device instead of a caption-only cell (Tim, 9/1: photos 15 + 17 missing).
    let blob=(typeof window.phExportBlobForRef==='function')?await window.phExportBlobForRef(p):null;
    if(!blob&&p.storageUrl){ try{ blob=await (await fetch(p.storageUrl)).blob(); }catch(e){} }
    if(!blob&&p.thumb){ const raw=p.thumb,b64=raw.includes(',')?raw.split(',')[1]:raw; const bin=atob(b64); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i); blob=new Blob([arr],{type:'image/jpeg'}); }
    if(!blob){ console.warn('[daily-pdf] no image bytes for photo',p.id,{caption:p.caption,hasUrl:!!p.storageUrl,hasThumb:!!p.thumb,inLibrary:!!((window._phPhotos||[]).find(x=>x.id===p.id))}); return null; }
    blob=await stampIfCamera(p,blob);   // camera photos embed stamped, everywhere
    const ep=exportImageParams(p); blob=await exportImageBlob(blob,ep.maxPx,ep.quality);
    let w=maxWpx,h=Math.round(maxWpx*0.72);
    try{ const bmp=await createImageBitmap(blob); const sc=maxWpx/bmp.width; w=maxWpx; h=Math.round(bmp.height*sc); if(h>maxHpx){ h=maxHpx; w=Math.round(bmp.width*(maxHpx/bmp.height)); } bmp.close&&bmp.close(); }catch(e){}
    const dataUrl=await new Promise((res,rej)=>{ const r=new FileReader(); r.onloadend=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(blob); });
    return {dataUrl,w:Math.round(w*0.75),h:Math.round(h*0.75),p};
  }catch(e){ return null; }
}

// 2-up image grid rows (sketches + photos share the shape)
function _imgPairRows(items){
  const rows=[];
  for(let i=0;i<items.length;i+=2){
    const r=[];
    for(let j=i;j<Math.min(i+2,items.length);j++){
      const it=items[j];
      r.push(it.im
        ? {stack:[{image:it.im.dataUrl,width:it.im.w,height:it.im.h,alignment:'center'},{text:it.cap,fontSize:8,italics:true,alignment:'center',margin:[0,3,0,4]}],border:[false,false,false,false]}
        : {text:it.cap,fontSize:8,border:[false,false,false,false]});
    }
    if(r.length===1) r.push({text:'',border:[false,false,false,false]});
    rows.push(r);
  }
  return rows;
}

// ═══ the builder — same data prep as swpppBuildDocx, pdfmake doc-definition out ═══
export async function swpppBuildPdf(insp,cfg,sig){
  _pal=PAL_OFFICE;   // QI report: Office blue by decision (mid-project freeze)
  const pdfMake=await _getPdfMake();

  // Date formatting
  const [y,m,d]=(insp.date||new Date().toLocaleDateString('en-CA')).split('-');
  const dt=new Date(parseInt(y),parseInt(m)-1,parseInt(d));
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const longDate=`${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${parseInt(d)}, ${y}`;
  const H=cfg.header||{};

  // Header info table
  const typeLine={text:[
    cb(insp.inspType==='routine'),{text:'Routine — 2×/week (≥2 business days apart)    '},
    cb(insp.inspType==='post-storm'),{text:'Post-Storm — within 1 business day of ≥0.5" rain    '},
    cb(insp.inspType==='other'),{text:'Other'+(insp.inspType==='other'&&insp.inspTypeOther?': '+insp.inspTypeOther:'')}
  ]};
  const headerTbl=infoTable([
    infoRow('Inspection Date:',longDate),
    infoRow('Inspection Type:',typeLine.text),
    infoRow('Storm Date / Time:',insp.stormDateTime||'—'),
    infoRow('SQI Name:',H.inspectorName||''),
    infoRow('Role / Credential:',H.roleCredential||''),
    infoRow('SWT #:',`${H.swtNumber||''}   |   Expires: ${H.swtExpires||''}`),
    infoRow('Organization:',H.organization||''),
    infoRow('Project:',H.project||cfg.projectTitle||''),
    infoRow('SPDES Permit No.:',H.spdesPermit||''),
    infoRow('SWPTS Application ID:',H.swptsId||''),
    infoRow('Contractor POC:',H.contractorPoc||''),
    infoRow('Supervising QI / QP:',H.supervisingQi||'')
  ]);

  // Disturbed Area Summary
  const S=insp.daSummary||{};
  const das=cfg.disturbedAreaSummary||{};
  const fmtAc=(v)=>(v===''||v==null)?'______':`${v}`;
  const amberRow=(label,value)=>[
    {text:label,bold:true,fontSize:10,fillColor:AMBER},
    {text:value,bold:true,fontSize:10,fillColor:AMBER}
  ];
  const dasTbl=infoTable([
    infoRow('Active disturbed',fmtAc(S.active)+' ac'),
    infoRow('Inactive disturbed',fmtAc(S.inactive)+' ac'),
    infoRow('Temporary stabilization',fmtAc(S.tempStab)+' ac'),
    infoRow('Final / permanent stabilization',fmtAc(S.finalStab)+' ac'),
    amberRow(das.totalLabel||'TOTAL OPEN disturbed (Active + Inactive)',fmtAc(S.totalOpen)+' ac'),
    infoRow(das.capLabel||'Authorization cap — max open at one time',`${das.capAcres||125} ac`),
    infoRow('Currently over 5 acres open?',[cb(S.over5==='yes'),{text:'Yes    '},cb(S.over5==='no'),{text:'No'}]),
    infoRow('Enhanced inspection frequency in effect?',[cb(S.enhanced==='yes'),{text:'Yes (2×/wk + post-storm)    '},cb(S.enhanced==='no'),{text:'No'}])
  ]);
  const dasBlock=[
    {text:'Disturbed Area Summary — >5-Acre Authorization (Condition 1)',bold:true,fontSize:11,color:BLUE,margin:[0,8,0,2],headlineLevel:1},
    note(das.note||''), dasTbl
  ];

  // §1 Weather
  const W=insp.weather||{};
  const wxTbl=infoTable([
    infoRow('Sky Conditions:',W.sky||'—'),
    infoRow('Temperature (AM/PM):',W.temp||'—'),
    infoRow('Precipitation:',W.precip||'—'),
    infoRow('Wind:',W.wind||'—'),
    infoRow('Soil Conditions:',W.soil||'—'),
    infoRow('Site Access:',W.access||'—'),
    infoRow('General Site Conditions:',W.general||'—')
  ]);

  // §2 Drainage areas
  const daBody=[[hcell('Drainage Area ID'),hcell('General Location / Description'),hcell('Condition'),hcell('Action Required')]];
  (cfg.drainageAreas||[]).forEach(da=>{
    const st=(insp.drainageAreas||{})[da.id]||{};
    daBody.push([cell(da.id,{bold:true,size:8}),cell(da.desc,{size:8}),
      {text:[cb(st.condition==='acceptable'),{text:'Acceptable   '},cb(st.condition==='deficient'),{text:'Deficient'}],fontSize:8},
      cell(st.action||'',{size:8})]);
  });
  const daTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(18,42,22),body:daBody},layout:hairLayout,margin:[0,2,0,4]};

  // §3 Discharge points
  const dpBody=[[hcell('Discharge Point ID'),hcell('Location Description'),hcell('Receiving Water'),hcell('Condition / Notes')]];
  (cfg.dischargePoints||[]).forEach(dp=>{
    const st=(insp.dischargePoints||{})[dp.id]||{};
    dpBody.push([cell(dp.id,{bold:true,size:8}),cell(dp.location,{size:8,i:true}),cell(dp.receiving,{size:8,i:true}),
      {text:[cb(st.condition==='acceptable'),{text:'Acceptable   '},cb(st.condition==='deficient'),{text:'Deficient'+(st.notes?` — ${st.notes}`:'')}],fontSize:8}]);
  });
  const dpTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(14,36,26),body:dpBody},layout:hairLayout,margin:[0,2,0,4]};

  // §4 Waterbodies
  const wbBody=[[hcell('Waterbody'),hcell('Type'),hcell('Location on Site'),hcell('303(d) Impaired?')]];
  (cfg.waterbodies||[]).forEach(w=>{ wbBody.push([cell(w.name,{size:8,bold:true}),cell(w.type,{size:8}),cell(w.location,{size:8}),cell(w.impaired,{size:8})]); });
  const wbTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(28,14,40),body:wbBody},layout:hairLayout,margin:[0,2,0,4]};

  // §5 ESC BMPs
  const bmpBody=[[hcell('BMP / Practice'),hcell('Location / Ref'),hcell('Installed'),hcell('Condition'),hcell('Maint. Needed'),hcell('Corrective / Status')]];
  (cfg.bmps||[]).forEach(b=>{
    const st=(insp.bmps||{})[b.name]||{};
    bmpBody.push([
      cell(b.name,{bold:true,size:8}),
      cell(b.location,{size:8,i:true}),
      {text:[cb(st.installed==='y'),{text:'Y  '},cb(st.installed==='n'),{text:'N'}],fontSize:8},
      {stack:[
        {text:[cb(st.condition==='acceptable'),{text:'Acceptable'}],fontSize:8},
        {text:[cb(st.condition==='attention'),{text:'Needs Attention'}],fontSize:8},
        {text:[cb(st.condition==='deficient'),{text:'Deficient'}],fontSize:8}]},
      {text:[cb(st.maintenance==='y'),{text:'Y  '},cb(st.maintenance==='n'),{text:'N'}],fontSize:8},
      {stack:[
        {text:[cb(st.corrective==='compliant'),{text:'Compliant  '},cb(st.corrective==='action'),{text:'Action Req'}],fontSize:8},
        ...(st.status?[{text:`Status: ${st.status}`,fontSize:8}]:[])]}
    ]);
  });
  const bmpTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(18,22,10,20,10),body:bmpBody},layout:hairLayout,margin:[0,2,0,4]};
  const cond4Line=body([cb(insp.escVerified==='verified'),{text:'Verified    '},cb(insp.escVerified==='na'),{text:'N/A this inspection — '+(cfg.escCondition4||'')}],{fontSize:8,italics:true});

  // §6 Pollution prevention
  const ppBody=[[hcell('Pollution Source / Activity'),hcell('Controls in Place'),hcell('Condition / Observations'),hcell('Action Required')]];
  (cfg.pollutionSources||[]).forEach(name=>{
    const st=(insp.pollution||{})[name]||{};
    ppBody.push([cell(name,{size:8}),
      {text:[cb(st.controls==='y'),{text:'Y  '},cb(st.controls==='n'),{text:'N  '},cb(st.controls==='na'),{text:'N/A'}],fontSize:8},
      cell(st.obs||'',{size:8}),cell(st.action||'',{size:8})]);
  });
  const ppTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(34,22,28),body:ppBody},layout:hairLayout,margin:[0,2,0,4]};

  // §7 SMPs
  const smpBody=[[hcell('SMP Practice'),hcell('Location'),hcell('Construction Status'),hcell('SWPPP Compliance'),hcell('Notes / Action')]];
  (cfg.smps||[]).forEach(s=>{
    const st=(insp.smps||{})[s.name]||{};
    smpBody.push([cell(s.name,{bold:true,size:8}),cell(s.location,{size:8,i:true}),
      {text:[cb(st.status==='not-started'),{text:'Not Started '},cb(st.status==='in-progress'),{text:'In Progress '},cb(st.status==='complete'),{text:'Complete'}],fontSize:8},
      {text:[cb(st.compliance==='compliant'),{text:'Compliant '},cb(st.compliance==='non'),{text:'Non-Compliant '},cb(st.compliance==='na'),{text:'N/A'}],fontSize:8},
      cell(st.notes||'',{size:8})]);
  });
  const smpTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(24,26,20,18),body:smpBody},layout:hairLayout,margin:[0,2,0,4]};

  // §8 Corrective actions
  const caBody=[[hcell('Date Identified'),hcell('Location / BMP'),hcell('Description of Deficiency'),hcell('Required Action / Deadline / Status')]];
  const caList=(insp.corrective&&insp.corrective.length)?insp.corrective:[];
  caList.forEach(c=>{ caBody.push([cell(c.dateId||'',{size:8}),cell(c.location||'',{size:8}),cell(c.desc||'',{size:8}),cell(c.action||'',{size:8})]); });
  if(!caList.length) caBody.push([cell('—',{size:8}),cell('None identified this inspection',{size:8}),cell('',{size:8}),cell('',{size:8})]);
  const caTbl={table:{headerRows:1,dontBreakRows:true,widths:cols(14,22,34),body:caBody},layout:hairLayout,margin:[0,2,0,4]};

  // §10 sketches — meta table + 2-up grid (px caps match the DOCX)
  const skMetaBody=[[hcell('Sketch #'),hcell('Date'),hcell('Status / Description')]];
  let skN=0;
  for(const pId of (insp.sketches||[])){
    skN++;
    const meta=(insp.sketchMeta||{})[pId]||{};
    skMetaBody.push([cell(String(skN),{size:8}),cell(meta.date||'',{size:8}),cell(meta.desc||'',{size:8})]);
  }
  const skItems=[];
  const skIds=(insp.sketches||[]);
  for(let j=0;j<skIds.length;j++){
    const im=await _imgFor(skIds[j],340,500);
    const meta=(insp.sketchMeta||{})[skIds[j]]||{};
    skItems.push({im,cap:`Sketch ${j+1} — ${[meta.area,meta.desc].filter(Boolean).join(' · ')}`});
  }

  // §11 photos — no meta table; captions carry the date
  const mdy=(iso)=>{ const s=String(iso||'').split('-'); return s.length===3?`${parseInt(s[1])}/${parseInt(s[2])}/${s[0].slice(2)}`:(iso||''); };
  const phItems=[];
  const phIds=(insp.photos||[]);
  for(let j=0;j<phIds.length;j++){
    const im=await _imgFor(phIds[j],300,440);
    const p=(window._phPhotos||[]).find(x=>x.id===phIds[j])||{};
    const meta=(insp.photoMeta||{})[phIds[j]]||{};
    phItems.push({im,cap:`Photo ${j+1} — ${[mdy(p.date),meta.loc,meta.subject].filter(Boolean).join(' · ')}`});
  }

  // Certification — drawn signature stamps in when saved, typed name fallback
  const C=cfg.certification||{};
  const sigRow=(sig&&sig.b64)
    ? [{text:'Signature:',bold:true,fontSize:10,fillColor:LT_BLUE},{image:sig.b64,width:128,height:41}]
    : infoRow('Signature:',(insp.cert&&insp.cert.signedName)||'');
  // One unbreakable node: the cert never splits across pages, and its last element
  // carries NO bottom margin — a trailing margin that lands exactly past the page
  // boundary is what spawned the header/footer-only blank last page.
  const certTbl=infoTable([
    infoRow('QI Name:',C.qiName||''),
    infoRow('Role / Credential:',C.roleCredential||''),
    infoRow('SWT #:',`${C.swtNumber||''}   |   Expires: ${C.swtExpires||''}`),
    infoRow('Organization:',C.organization||''),
    sigRow,
    infoRow('Date:',(insp.cert&&insp.cert.signedDate)||''),
    infoRow('Supervising QI / QP:',C.supervisingQi||''),
    infoRow('QP Signature:','')
  ]);
  certTbl.margin=[0,2,0,0];
  const certBlock=[{unbreakable:true,stack:[
    {text:'Report Certification',bold:true,fontSize:11,color:MID_BLUE,margin:[0,14,0,3]},
    {canvas:[{type:'line',x1:0,y1:0,x2:CONTENT_W,y2:0,lineWidth:0.8,lineColor:MID_BLUE}],margin:[0,0,0,5]},
    body(C.text||''),
    {text:'',margin:[0,0,0,4]},
    certTbl
  ]}];

  const content=[
    {text:cfg.projectTitle||'',bold:true,fontSize:15,color:BLUE,alignment:'center',margin:[0,4,0,2]},
    {text:cfg.title||'SPDES Stormwater — Qualified Inspector Inspection Report',fontSize:11,color:MID_BLUE,alignment:'center',margin:[0,0,0,8]},
    headerTbl,
    ...dasBlock,
    h1('1.  Weather & Site Conditions'),wxTbl,
    h1('2.  Drainage Areas Inspected'),note(cfg.drainageAreasNote||''),
    ...(insp.daBulkNote?[body('Grouped note: '+insp.daBulkNote,{italics:true})]:[]),
    daTbl,
    h1('3.  Points of Discharge'),note(cfg.dischargePointsNote||''),dpTbl,
    h1('4.  Receiving Waterbodies'),note(cfg.waterbodiesNote||''),wbTbl,
    ...(insp.waterbodyNotes?[body('Notes: '+insp.waterbodyNotes)]:[]),
    h1('5.  E&SC / BMP Inspection'),cond4Line,note(cfg.escNote||''),bmpTbl,
    h1('6.  Pollution Prevention Measures'),note(cfg.pollutionNote||''),ppTbl,
    h1('7.  Post-Construction Stormwater Management Practices'),note(cfg.smpNote||''),smpTbl,
    h1('8.  Corrective Actions Summary'),note(cfg.correctiveNote||''),caTbl,
    h1('9.  General Notes / Additional Observations'),body(insp.notes||'None.'),
    h1('10.  Disturbance Sketches'),note(cfg.sketchesNote||''),
    ...(skMetaBody.length>1
      ? [{table:{headerRows:1,dontBreakRows:true,widths:cols(12,18),body:skMetaBody},layout:hairLayout,margin:[0,2,0,4]}]
      : [body('No sketches attached.')]),
    ...(skItems.length?[{table:{dontBreakRows:true,widths:['*','*'],body:_imgPairRows(skItems)},layout:imgGridLayout,margin:[0,4,0,4]}]:[]),
    h1('11.  Photographic Documentation'),note(cfg.photosNote||''),
    ...(phItems.length
      ? [{table:{dontBreakRows:true,widths:['*','*'],body:_imgPairRows(phItems)},layout:imgGridLayout,margin:[0,4,0,4]}]
      : [body('No photographs attached.')]),
    ...certBlock
  ];

  const dd={
    pageSize:'LETTER',
    pageMargins:[MARG,80,MARG,58],
    defaultStyle:{font:'Roboto',fontSize:10},
    header:()=>({
      margin:[MARG,22,MARG,0],
      table:{widths:['60%','40%'],body:[[
        {text:(cfg.projectTitle||'').toUpperCase(),bold:true,fontSize:10,color:BLUE,fillColor:LT_BLUE},
        {text:'QI Inspection Report',fontSize:9,color:MID_BLUE,fillColor:LT_BLUE,alignment:'right'}
      ]]},
      layout:{hLineWidth:()=>0.5,vLineWidth:(i,node)=>(i===0||i===node.table.widths.length)?0.5:0,hLineColor:()=>HAIR,vLineColor:()=>HAIR,paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>3,paddingBottom:()=>3}
    }),
    footer:(currentPage)=>({
      margin:[MARG,14,MARG,0],
      stack:[
        {canvas:[{type:'line',x1:0,y1:0,x2:CONTENT_W,y2:0,lineWidth:0.6,lineColor:HAIR}]},
        {text:`${cfg.projectTitle||''}  |  SPDES QI Stormwater Inspection Report  |  ${parseInt(m)}/${parseInt(d)}/${y.slice(2)}  |  Page ${currentPage}`,
         fontSize:8,color:'#888888',alignment:'center',margin:[0,4,0,0]}
      ]
    }),
    // keepNext equivalent: never strand a section header at the bottom of a page
    pageBreakBefore:(node,followingNodesOnPage)=>node.headlineLevel===1&&followingNodesOnPage.length===0,
    content
  };

  const doc=pdfMake.createPdf(dd);
  return doc.getBlob();
}

// ── export-now flow (called from swppp.js via dynamic import) ──
export async function swpppExportPdfNow(insp,cfg,sig){
  const blob=await swpppBuildPdf(insp,cfg,sig);
  const [y,m,d]=(insp.date||new Date().toLocaleDateString('en-CA')).split('-');
  const fname=`${(cfg.projectTitle||'Project').replace(/[^\w]+/g,'_')}-QI_Stormwater_Inspection_Report_${parseInt(m)}-${parseInt(d)}-${y.slice(2)}.pdf`;
  await saveFileNative(blob,fname,'application/pdf');
}

// ═══ DAILY REPORT PDF — the primary daily export (8/31, PDF-primary decision) ═══
// Mirrors rptBuildDocx (report.js) section-for-section, but in the GroundLog
// palette (teal/amber — feedback_branded_exports; the QI report keeps its blue
// until the mid-project freeze lifts). Renders ENTIRELY from a snapshot triple
// (logData, polished, photoRefs) so a REVIEWER'S device can produce the exact
// same document from a submission's attached report snapshot — photos load
// from each ref's own storageUrl, never from the local _phPhotos cache.
// opts: { logo:{b64,w,h}, authorSig:{b64,w,h}, review:{name,title,dateMs,
//         signature:{b64,w,h}}, oiRes:[…] (snapshot oiRefs), watermark }
const G_TEAL='#006B75', G_TEAL_LT='#E4EFEE', G_AMBER='#C9A84C', G_INK='#1A1A1A';
const dh1=(text)=>({table:{widths:['*'],body:[[{text,bold:true,color:'#FFFFFF',fontSize:12,fillColor:G_TEAL,border:[false,false,false,false]}]]},
  layout:{hLineWidth:()=>0,vLineWidth:()=>0,paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>3,paddingBottom:()=>3},
  headlineLevel:1, margin:[0,10,0,5]});
const dh2=(text)=>({stack:[
  {text,bold:true,fontSize:11,color:G_TEAL,margin:[0,8,0,2]},
  {canvas:[{type:'line',x1:0,y1:0,x2:CONTENT_W,y2:0,lineWidth:1,lineColor:G_AMBER}],margin:[0,0,0,4]}
]});
const dInfoRow=(label,value)=>[
  {text:label,bold:true,fontSize:10,fillColor:G_TEAL_LT,color:G_INK},
  (value&&value.text!==undefined)||Array.isArray(value)?{text:value,fontSize:10}:{text:String(value==null?'':value),fontSize:10}
];
const dInfoTable=(rows)=>({table:{dontBreakRows:true,widths:[160,'*'],body:rows},layout:hairLayout,margin:[0,2,0,4]});
const dhcell=(text)=>({text,bold:true,color:'#FFFFFF',fillColor:G_TEAL,fontSize:9});

// Photo ref (snapshot shape: storageUrl, caption, camera fields; NO thumb) → sized dataUrl
async function _dailyImg(p,maxWpx,maxHpx){
  maxWpx=maxWpx||331; maxHpx=maxHpx||700;
  try{
    let blob=null;
    if(p.storageUrl){ try{ blob=await (await fetch(p.storageUrl)).blob(); }catch(e){} }
    if(!blob&&p.thumb){ const raw=p.thumb,b64=raw.includes(',')?raw.split(',')[1]:raw; const bin=atob(b64); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i); blob=new Blob([arr],{type:'image/jpeg'}); }
    if(!blob) return null;
    blob=await stampIfCamera(p,blob);
    const ep=exportImageParams(p); blob=await exportImageBlob(blob,ep.maxPx,ep.quality);
    let w=maxWpx,h=Math.round(maxWpx*0.75);
    try{ const bmp=await createImageBitmap(blob); const sc=maxWpx/bmp.width; w=maxWpx; h=Math.round(bmp.height*sc); if(h>maxHpx){ h=maxHpx; w=Math.round(bmp.width*(maxHpx/bmp.height)); } bmp.close&&bmp.close(); }catch(e){}
    const dataUrl=await new Promise((res,rej)=>{ const r=new FileReader(); r.onloadend=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(blob); });
    return {dataUrl,w:Math.round(w*0.75),h:Math.round(h*0.75)};
  }catch(e){ return null; }
}

export async function dailyBuildPdf(logData,polished,photoRefs,opts){
  opts=opts||{};
  const pdfMake=await _getPdfMake();
  const [y,m,d]=(logData.reportDate||new Date().toLocaleDateString('en-CA')).split('-');
  const dt=new Date(parseInt(y),parseInt(m)-1,parseInt(d));
  const longDate=dt.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const shortDate=`${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;

  // Title block (logo is per-project data, passed in — never fetched here)
  const titleBlock=[];
  if(opts.logo&&opts.logo.b64){
    const lb=opts.logo.b64.startsWith('data:')?opts.logo.b64:('data:image/png;base64,'+opts.logo.b64);
    titleBlock.push({image:lb,width:Math.round((opts.logo.w||200)*0.75),height:Math.round((opts.logo.h||50)*0.75),alignment:'center',margin:[0,4,0,3]});
  }
  titleBlock.push({text:'Daily Environmental Compliance Report',fontSize:11,color:G_TEAL,alignment:'center',margin:[0,0,0,8]});

  const infoTbl=dInfoTable([
    dInfoRow('Report Date:',longDate),
    dInfoRow('Prepared By:',(logData.preparedBy||'')+' — Environmental Inspector'),
    dInfoRow('Organization:',logData.org||''),
    dInfoRow('Project:',logData.project||''),
    dInfoRow('Current Activity:',logData.activePhase||''),
    dInfoRow('Active Contractors:',logData.contractor||'—')
  ]);

  // 1. Weather
  const wx=logData.weather||{};
  const sky=Array.isArray(wx.sky)?wx.sky.join(', '):(wx.sky||'');
  const wxTbl=dInfoTable([
    dInfoRow('Sky Conditions:',sky||'—'),
    dInfoRow('Temperature (AM / PM):',(wx.tempAM||'—')+'°F / '+(wx.tempPM||'—')+'°F'),
    dInfoRow('Precipitation:',wx.precip||'None'),
    dInfoRow('Wind:',wx.wind||'—'),
    dInfoRow('Soil Conditions:',wx.soilConditions||'—'),
    dInfoRow('Upcoming Weather:',wx.upcomingForecast||'—')
  ]);

  // 2. Inspection Summary
  const bullets=(arr)=>({ul:(arr||[]),fontSize:10,margin:[10,2,0,2]});
  const sec2=[
    dh1('2.  Inspection Summary'),
    dh2('Contractor Activities'),
    body(polished.contractorActivities||''),
    dh2('Field Observations'),
    body(polished.fieldObservationsOpening||''),
    ...((polished.fieldObservationsBullets||[]).length?[bullets(polished.fieldObservationsBullets)]:[]),
    body(polished.fieldObservationsClosing||'')
  ];

  // 3. Compliance
  const compIssues=polished.complianceIssues||[{level:'No issues identified',description:'All areas inspected — no compliance concerns observed.',corrective:'N/A',status:'Compliant',dateResolved:''}];
  const compBody=[[dhcell('Level'),dhcell('Location / Description'),dhcell('Corrective Action'),dhcell('Status')],
    ...compIssues.map(i=>[cell(i.level),cell(i.description),cell(i.corrective),cell(i.status)])];
  const sec3=[
    dh1('3.  Compliance Issues'),
    dh2('Agency Inspections'),
    body(polished.agencyInspection||'No agency inspections conducted today.'),
    dh2('Non-Compliance Observations'),
    {text:'Compliance Level Reference: Level 1 — Observation | Level 2 — Corrective Action | Level 3 — Non-Compliance | Level 4 — Stop Work Order',fontSize:8.5,italics:true,color:'#555555',margin:[0,2,0,4]},
    {table:{headerRows:1,dontBreakRows:true,widths:cols(14,32,30),body:compBody},layout:hairLayout,margin:[0,2,0,4]},
    dh2('Landowner / Public Interactions'),
    body(polished.landownerContact||'No landowner or public interactions occurred today.'),
    dh2('T&E Species / Unanticipated Discoveries'),
    body(polished.rteObservation||'No rare, threatened, or endangered species were observed. No unanticipated archaeological or cultural resource discoveries were encountered.')
  ];
  const oiRes=opts.oiRes||[];
  if(oiRes.length){
    const oiFmt=(ds)=>{ if(!ds) return ''; const p=String(ds).split('-'); return p.length===3?`${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`:ds; };
    const oiBody=[[dhcell('Item'),dhcell('Opened'),dhcell('Resolved'),dhcell('Resolution')],
      ...oiRes.map(it=>[cell(it.title||it.text||''),cell(oiFmt(it.createdDate)),cell(oiFmt(it.resolvedDate)),cell(it.resolutionNote||'Resolved')])];
    sec3.push(dh2('Open Items Resolved'),
      {table:{headerRows:1,dontBreakRows:true,widths:cols(38,11,11),body:oiBody},layout:hairLayout,margin:[0,2,0,4]});
  }

  // 4 + 5
  const sec4=[dh1('4.  General Communication to Contractors'),body(polished.generalComms||'No general communications to report.')];
  const laItems=polished.lookaheadBullets||(logData.lookahead?logData.lookahead.split('\n').filter(l=>l.trim()):[]);
  const upcomingWx=(wx.upcomingForecast||'').trim();
  const sec5=[
    dh1('5.  24-Hour Look Ahead'),
    ...(upcomingWx?[body('Expected Weather: '+upcomingWx)]:[]),
    ...(laItems.length?[bullets(laItems)]:[body(logData.lookahead||'No look ahead items recorded.')])
  ];

  // 6. Photo Log — from the snapshot refs, 2-up
  const dayPhotos=(photoRefs||[]).filter(p=>p.date===logData.reportDate).sort((a,b)=>(a.uploadedAt||0)-(b.uploadedAt||0));
  const phItems=[];
  for(let j=0;j<dayPhotos.length;j++){
    const p=dayPhotos[j];
    const im=await _dailyImg(p,331);
    phItems.push({im,cap:`Photo ${j+1} — ${p.caption||''}`});
  }
  const sec6=[
    dh1('6.  Photo Log'),
    body(`The following photographs were taken during the inspection on ${shortDate}.`),
    ...(phItems.length
      ? [{table:{dontBreakRows:true,widths:['*','*'],body:_imgPairRows(phItems)},layout:imgGridLayout,margin:[0,4,0,4]}]
      : [body('No photographs recorded for this inspection.')])
  ];

  // Certification — author row always; drawn signatures stamp in when present;
  // the reviewer block renders ONLY from an approved review (never free text
  // when a real countersign exists).
  const rv=opts.review||null;
  const authorSigRow=(opts.authorSig&&opts.authorSig.b64)
    ? [{text:'Signature:',bold:true,fontSize:10,fillColor:G_TEAL_LT,color:G_INK},{image:opts.authorSig.b64,width:128,height:41}]
    : null;
  const certRows=[
    dInfoRow('Name:',logData.preparedBy||''),
    dInfoRow('Title:','Environmental Inspector'),
    ...(authorSigRow?[authorSigRow]:[]),
    dInfoRow('Date:',shortDate)
  ];
  if(rv){
    const rvDate=rv.dateMs?new Date(rv.dateMs).toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'2-digit'}):'';
    certRows.push(dInfoRow('Reviewed by:',(rv.name||'')+(rv.title?', '+rv.title:'')+(rvDate?' — '+rvDate:'')));
    if(rv.signature&&rv.signature.b64)
      certRows.push([{text:'Reviewer signature:',bold:true,fontSize:10,fillColor:G_TEAL_LT,color:G_INK},{image:rv.signature.b64,width:128,height:41}]);
  } else {
    certRows.push(dInfoRow('Reviewed by:',logData.reviewedBy||''));
  }
  const certTbl=dInfoTable(certRows);
  certTbl.margin=[0,2,0,0];
  const certBlock=[{unbreakable:true,stack:[
    {text:'Report Certification',bold:true,fontSize:11,color:G_TEAL,margin:[0,14,0,2]},
    {canvas:[{type:'line',x1:0,y1:0,x2:CONTENT_W,y2:0,lineWidth:1,lineColor:G_AMBER}],margin:[0,0,0,5]},
    body('I certify that the information contained in this Daily Environmental Compliance Report is accurate and complete to the best of my knowledge, and that all observations were conducted in accordance with the applicable Environmental Management and Construction Plan (EM&CP) and all other relevant permit conditions and regulatory requirements.'),
    {text:'',margin:[0,0,0,4]},
    certTbl
  ]}];

  const content=[
    ...titleBlock,infoTbl,
    dh1('1.  Weather Conditions'),wxTbl,
    ...sec2,...sec3,...sec4,...sec5,...sec6,
    ...certBlock
  ];

  const dd={
    pageSize:'LETTER',
    pageMargins:[MARG,80,MARG,58],
    defaultStyle:{font:'Roboto',fontSize:10,color:G_INK},
    header:()=>({
      margin:[MARG,22,MARG,0],
      table:{widths:['60%','40%'],body:[[
        {text:(logData.project||'').toUpperCase(),bold:true,fontSize:10,color:G_TEAL,fillColor:G_TEAL_LT},
        {text:'Daily Compliance Report',fontSize:9,color:G_TEAL,fillColor:G_TEAL_LT,alignment:'right'}
      ]]},
      layout:{hLineWidth:()=>0.5,vLineWidth:(i,node)=>(i===0||i===node.table.widths.length)?0.5:0,hLineColor:()=>HAIR,vLineColor:()=>HAIR,paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>3,paddingBottom:()=>3}
    }),
    footer:(currentPage)=>({
      margin:[MARG,14,MARG,0],
      stack:[
        {canvas:[{type:'line',x1:0,y1:0,x2:CONTENT_W,y2:0,lineWidth:0.6,lineColor:HAIR}]},
        {text:`${logData.project||''}  |  Environmental Inspector Daily Report  |  Confidential  |  Page ${currentPage}`,
         fontSize:8,color:'#888888',alignment:'center',margin:[0,4,0,0]}
      ]
    }),
    ...(opts.watermark?{watermark:{text:opts.watermark,color:G_AMBER,opacity:0.08,bold:true}}:{}),
    pageBreakBefore:(node,followingNodesOnPage)=>node.headlineLevel===1&&followingNodesOnPage.length===0,
    content
  };
  const doc=pdfMake.createPdf(dd);
  return doc.getBlob();
}

export async function dailyExportPdfNow(logData,polished,photoRefs,opts){
  const blob=await dailyBuildPdf(logData,polished,photoRefs,opts);
  const [y,m,d]=(logData.reportDate||new Date().toLocaleDateString('en-CA')).split('-');
  const slug=String(logData.project||'GroundLog').replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'GroundLog';
  const fname=`${m}-${d}-${y}_${slug}-Daily_Inspection_Report.pdf`;
  await saveFileNative(blob,fname,'application/pdf');
  return blob;
}

// ═══ ESC PUNCHLIST PDF — the cross-category repair-flag deliverable ═══
// Contractor-facing (ProSeed et al): every open 🚩 flag as a numbered item with
// flag date, permit-derived due date (correction window), category, coordinates,
// and the field photos taken at flag time; fixed items as a verification record.
// Same house chrome as the QI report; photos ride exportImg like every export.
export async function punchlistBuildPdf(opts){
  opts=opts||{};
  _pal=PAL_GL;   // GroundLog deliverable → house palette (9/2 brand pass)
  const pdfMake=await _getPdfMake();
  const pid=(typeof _activeProjectId==='function')?_activeProjectId():'default';
  const cfg=(typeof loadProjectConfig==='function')?loadProjectConfig():{};
  const projName=cfg.projectName||'Project';
  if(typeof trEnsurePlNums==='function'){ try{ trEnsurePlNums(pid); }catch(e){} }
  const open=(typeof trGetOpenTemporary==='function')?trGetOpenTemporary(pid):[];
  const fixed=(opts.includeFixed!==false&&typeof trGetResolvedTemporary==='function')?trGetResolvedTemporary(pid):[];
  const winHrs=(typeof clAmberHours==='function')?clAmberHours():48;
  const now=Date.now();
  const fmtD=ds=>{ if(!ds) return '—'; const p=String(ds).split('-'); return p.length===3?`${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`:String(ds); };
  const fmtTs=ts=>{ if(!ts) return '—'; const d=new Date(ts); return `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
  const dueOf=e=>{ const t=new Date((e.date||'')+'T00:00:00').getTime(); return isNaN(t)?null:t+winHrs*3600000; };
  const catName=e=>e.categoryName||((typeof tcGetName==='function')?tcGetName(e.categoryId,pid):'')||'—';
  const coordsOf=e=>{ const g=e.geometry; return (g&&g.type==='Point'&&Array.isArray(g.coordinates))?`${g.coordinates[1].toFixed(5)}, ${g.coordinates[0].toFixed(5)}`:'—'; };
  const esc=s=>String(s==null?'':s);

  const sorted=[...open].sort((a,b)=>(a.date||'')<(b.date||'')?-1:1);   // oldest (most overdue) first
  const overdue=sorted.filter(e=>{ const du=dueOf(e); return du&&now>du; }).length;
  const today=new Date();
  const longDate=today.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

  const infoRows=[
    infoRow('Project:',projName),
    infoRow('Date issued:',longDate),
    infoRow('Prepared by:',`${cfg.preparedBy||''}${cfg.org?'  |  '+cfg.org:''}`),
    ...(opts.attention?[infoRow('Attention:',esc(opts.attention))]:[]),
    infoRow('Correction window:',`${winHrs} hours from identification`),
    infoRow('Open items:',String(sorted.length)+(overdue?`   —   ${overdue} past the correction window`:'')),
    ...(fixed.length?[infoRow('Fixed to date:',String(fixed.length))]:[])
  ];

  // Item ids are the flags' PERMANENT plNum (assigned at creation, backfilled
  // above) — a fixed item keeps its number in the verification table, so this
  // export's numbers line up with every earlier printed copy. Positional
  // numbering (the pre-7/30 behavior) is only the fallback for a missing num.
  const plId=(e,i)=>e.plNum?('PL-'+String(e.plNum).padStart(2,'0')):('PL-'+String(i+1).padStart(2,'0'));
  const daysOpen=e=>{ const t=new Date((e.date||'')+'T00:00:00').getTime(); return isNaN(t)?null:Math.max(0,Math.floor((now-t)/86400000)); };
  const itemBlocks=[];
  for(let i=0;i<sorted.length;i++){
    const e=sorted[i];
    const id=plId(e,i);
    const du=dueOf(e), over=du&&now>du;
    const hot=over?{fill:_pal.hot,bold:true}:{};
    const dOpen=daysOpen(e);
    const ims=[];
    for(const pId of (e.photoIds||[])){
      const im=await _imgFor(pId,250,300);
      // 9/2 (#54): the caption saved on the flag (photoCaptions) or the photo's own caption
      // wins; "photographed at flag time" is only the fallback for an uncaptioned shot.
      if(im){ const c=String((e.photoCaptions||{})[pId]||(im.p&&im.p.caption)||'').trim(); ims.push({im,cap:`${id} — ${c||'photographed at flag time'}`}); }
    }
    itemBlocks.push(
      {table:{headerRows:1,dontBreakRows:true,widths:cols(12,22,16,16),body:[
        [hcell('Item'),hcell('BMP / Category'),hcell('Flagged'),hcell('Due'),hcell('Status')],
        [cell(id,{bold:true}),cell(catName(e)),cell(fmtD(e.date)+(dOpen!=null?`  (${dOpen}d)`:'')),cell(du?fmtTs(du):'—',hot),cell(over?'OPEN — OVERDUE':'OPEN',Object.assign({bold:true},hot))]
      ]},layout:hairLayout,margin:[0,8,0,2]},
      body([{text:'Deficiency / corrective action:  ',bold:true},{text:esc(e.tempLabel||'Repair needed')}]),
      body([{text:'GPS:  ',bold:true},{text:coordsOf(e)}],{fontSize:8,color:'#555555',margin:[0,0,0,2]}),
      ...(ims.length?[{table:{dontBreakRows:true,widths:['*','*'],body:_imgPairRows(ims)},layout:imgGridLayout,margin:[0,3,0,2]}]:[])
    );
  }

  const fxSorted=[...fixed].sort((a,b)=>(b.resolvedAt||0)-(a.resolvedAt||0));
  const fxBody=[[hcell('Item'),hcell('Deficiency'),hcell('BMP / Category'),hcell('Flagged'),hcell('Fixed'),hcell('Resolution')]];
  fxSorted.forEach(e=>fxBody.push([cell(e.plNum?('PL-'+String(e.plNum).padStart(2,'0')):'—',{bold:true}),cell(esc(e.tempLabel||'Repair')),cell(catName(e)),cell(fmtD(e.date)),cell(fmtTs(e.resolvedAt)),cell(esc(e.resolveNote||'—'))]));

  // 🚩 Overview captures (FAB punchlist capture flow) — every shot from the
  // NEWEST capture day fronts the report, so "where is PL-NN" is answered
  // before the item list starts (the map labels in the capture carry the same
  // permanent PL numbers as the items below).
  const plCaps=(window._phPhotos||[]).filter(p=>p.plCap&&p.projectId===pid&&!p.deletedAt);
  const capDay=plCaps.length?plCaps.map(p=>p.date).sort().pop():null;
  const dayCaps=capDay?plCaps.filter(p=>p.date===capDay).sort((a,b)=>(a.uploadedAt||0)-(b.uploadedAt||0)):[];
  const overviewIms=[];
  for(const p of dayCaps){
    const im=await _imgFor(p.id,660,700);
    if(im) overviewIms.push(im);
  }
  let sec=0;
  const content=[
    infoTable(infoRows),
    ...(overviewIms.length?[
      h1(`${++sec}.  Site Overview — Flag Locations`),
      note(`Map capture${overviewIms.length>1?'s':''} from ${fmtD(capDay)}. Each flag label carries the item's permanent PL number, matching the list below.`),
      ...overviewIms.map(im=>({image:im.dataUrl,width:Math.min(im.w,CONTENT_W),margin:[0,4,0,8]}))
    ]:[]),
    h1(`${++sec}.  Open Items — Corrective Action Required`),
    note(`Items are listed oldest first. Photos were taken in the field at the time each item was flagged; GPS coordinates locate the flag on the site map.`),
    ...(sorted.length?itemBlocks:[body('No open items — nothing currently requires attention.')]),
    ...(fixed.length?[
      h1(`${++sec}.  Fixed — Verification Record`),
      {table:{headerRows:1,dontBreakRows:true,widths:cols(9,24,17,10,10),body:fxBody},layout:hairLayout,margin:[0,2,0,4]}
    ]:[])
  ];

  const dd={
    pageSize:'LETTER',
    pageMargins:[MARG,80,MARG,58],
    defaultStyle:{font:'Roboto',fontSize:10},
    header:()=>({
      margin:[MARG,22,MARG,0],
      table:{widths:['60%','40%'],body:[[
        {text:projName.toUpperCase(),bold:true,fontSize:10,color:_pal.h,fillColor:_pal.lt},
        {text:'ESC Punchlist',fontSize:9,color:_pal.mid,fillColor:_pal.lt,alignment:'right'}
      ]]},
      layout:{hLineWidth:()=>0.5,vLineWidth:(i,node)=>(i===0||i===node.table.widths.length)?0.5:0,hLineColor:()=>HAIR,vLineColor:()=>HAIR,paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>3,paddingBottom:()=>3}
    }),
    footer:(currentPage)=>({
      margin:[MARG,14,MARG,0],
      stack:[
        {canvas:[{type:'line',x1:0,y1:0,x2:CONTENT_W,y2:0,lineWidth:0.6,lineColor:HAIR}]},
        {text:`${projName}  |  ESC Punchlist  |  ${today.getMonth()+1}/${today.getDate()}/${String(today.getFullYear()).slice(2)}  |  Page ${currentPage}`,
         fontSize:8,color:'#888888',alignment:'center',margin:[0,4,0,0]}
      ]
    }),
    pageBreakBefore:(node,followingNodesOnPage)=>node.headlineLevel===1&&followingNodesOnPage.length===0,
    content
  };

  const doc=pdfMake.createPdf(dd);
  return doc.getBlob();
}

// ═══ AGENCY VISIT REPORT / LOG PDF (#54) ═══
// One visit (record photos included) or the full running log (notes-only lean
// file for forwarding to the contractor). Same house chrome as everything else.
export async function avBuildPdf(visits, cfg, opts){
  opts=opts||{};
  _pal=PAL_GL;   // GroundLog deliverable → house palette (9/2 brand pass)
  const pdfMake=await _getPdfMake();
  const pretty=(d)=>{ const p=String(d||'').split('-'); return p.length===3?`${parseInt(p[1])}/${parseInt(p[2])}/${p[0]}`:String(d||''); };
  const content=[
    {table:{widths:['*'],body:[[{
      stack:[
        {text:opts.single?'AGENCY VISIT REPORT':'AGENCY VISIT LOG',bold:true,fontSize:16,color:'#FFFFFF'},
        {text:cfg.projectName||'',fontSize:10,color:'#E4EFEE',margin:[0,2,0,0]}
      ],fillColor:_pal.h,border:[false,false,false,false],margin:[0,4,0,4]
    }]]},layout:{hLineWidth:()=>0,vLineWidth:()=>0,paddingLeft:()=>8,paddingRight:()=>8,paddingTop:()=>4,paddingBottom:()=>4},margin:[0,0,0,6]},
    infoTable([
      infoRow('Generated', pretty(new Date().toLocaleDateString('en-CA'))),
      infoRow('Prepared by', cfg.preparedBy||''),
      ...(opts.single?[]:[infoRow('Visits on record', String(visits.length))])
    ])
  ];
  for(const v of visits){
    content.push(h1(`${pretty(v.date)} — ${v.agency||'Agency visit'}${v.inspector?' · '+v.inspector:''}`));
    const rows=[];
    if(v.inspector) rows.push(infoRow('Inspector(s)', v.inspector));
    if(v.weatherLine) rows.push(infoRow('Site conditions', v.weatherLine));
    if(v.preparedBy) rows.push(infoRow('Recorded by', v.preparedBy));
    if(rows.length) content.push(infoTable(rows));
    if(v.legacy) content.push(note('Recorded in the daily log (pre-dates visit records).'));
    content.push(body(v.notes||'—'));
    if(v.followUps){
      content.push({table:{widths:['*'],body:[[{
        stack:[{text:'FOLLOW-UP ITEMS',bold:true,fontSize:8,color:'#8B6914'},{text:v.followUps,fontSize:10,margin:[0,2,0,0]}],
        fillColor:_pal.hot,border:[false,false,false,false]
      }]]},layout:{hLineWidth:()=>0,vLineWidth:()=>0,paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>4,paddingBottom:()=>4},margin:[0,4,0,4]});
    }
    if(Array.isArray(v.photoIds)&&v.photoIds.length){
      const items=[];
      for(const pId of v.photoIds){
        const im=await _imgFor(pId,320);
        const p=(window._phPhotos||[]).find(x=>x.id===pId);
        items.push({im,cap:(p&&p.caption)||''});
      }
      if(items.length) content.push({table:{widths:['*','*'],body:_imgPairRows(items)},layout:imgGridLayout,margin:[0,4,0,6]});
    }
  }
  const dd={
    pageSize:'LETTER', pageMargins:[MARG,MARG,MARG,MARG],
    defaultStyle:{font:'Roboto',fontSize:10},
    footer:(page,total)=>({columns:[
      {text:cfg.projectName||'',fontSize:7,color:'#888888',margin:[MARG,0,0,0]},
      {text:`${page} / ${total}`,alignment:'right',fontSize:7,color:'#888888',margin:[0,0,MARG,0]}
    ],margin:[0,10,0,0]}),
    content
  };
  const doc=pdfMake.createPdf(dd);
  return doc.getBlob();
}

export async function punchlistExportPdfNow(opts){
  const blob=await punchlistBuildPdf(opts);
  const cfg=(typeof loadProjectConfig==='function')?loadProjectConfig():{};
  const t=new Date();
  const fname=`${(cfg.projectName||'Project').replace(/[^\w]+/g,'_')}-ESC_Punchlist_${t.getMonth()+1}-${t.getDate()}-${String(t.getFullYear()).slice(2)}.pdf`;
  await saveFileNative(blob,fname,'application/pdf');
}
