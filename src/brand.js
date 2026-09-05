// ═══════════════════════════════════════════════════════════════════════════
// 🎨 REPORT BRANDING — per-project output colors + logo, per-user saved presets
// ═══════════════════════════════════════════════════════════════════════════
//
// App chrome is GroundLog forever; OUTPUT branding is per tenant (memory
// project_groundlog_brand_identity). Tim 9/2 ("report colors, company/firm
// branding, style … for all reports editable ASAP") + 9/5 design:
//
//   project doc:  projects/{pid}/config/branding
//                 { primary, accent, applyToQi, logoB64, logoW, logoH, name, _mts }
//                 member-read / lead-write (rules: /config/{doc}); every member's
//                 exports of the project match, and the review snapshot carries the
//                 resolved colors so the reviewer's signed PDF matches the author's.
//   user presets: users/{uid}/brandPresets/{id}
//                 { name, primary, accent, applyToQi, logoB64, logoW, logoH, createdAt }
//                 "the user IS the firm" for now (Tim 9/5): whoever sets up the next
//                 project picks a previously used branding or creates a new one.
//
// Loader = the config-loader pattern (project_config_loader_pattern): IDB first, cloud
// refresh, newest-wins by _mts, never seeded early. Logo: the branding doc wins; the
// pre-9/5 per-user location (users/{uid}/settings/{pid}.reportLogoB64) is read as a
// fallback so existing projects keep their logo. An explicit logoB64:null means
// "removed" (no fallback).
//
// Consumers ask for a palette, never raw colors:
//   glBrandPdfPal(pid,{forQi})  → {h,lt,mid,hot,rule,hText}     pdfmake builders
//   glBrandDocx(pid,{forQi})    → {BLUE,LT_BLUE,MID_BLUE,RULE,HOT,HTEXT} (no '#')  docx
//   glBrandXl(pid)              → {teal,am,amLt,tl,htx,ftl,fam}  exceljs (ARGB-ready)
// forQi: the SWPPP QI report follows the branding only when applyToQi is on (a
// mid-project freeze keeps Office blue) — a per-project toggle, never a code branch
// on a project name (feedback_no_project_specific_hardcoding).

const GL_BRAND_DEFAULT = { primary:'#006B75', accent:'#C9A84C', applyToQi:false };
const GL_BRAND_OFFICE  = { primary:'#1F3864', accent:'#2E5496' };
const _OFFICE_PDF  = { h:'#1F3864', lt:'#D9E2F3', mid:'#2E5496', hot:'#FFF2CC', rule:'#2E5496', hText:'#FFFFFF' };
const _OFFICE_DOCX = { BLUE:'1F3864', LT_BLUE:'D9E2F3', MID_BLUE:'2E5496', RULE:'2E5496', HOT:'FFF2CC', HTEXT:'FFFFFF' };

var _brCfg = {};      // pid → cfg | null (checked, none)
var _brLoading = {};  // pid → promise

function _brPid(pid){ return pid || ((typeof _activeProjectId==='function') ? _activeProjectId() : 'default'); }
function _brUdb(){ return (typeof _udb==='function') ? _udb() : null; }
function _brCloudOk(){ return typeof db!=='undefined' && db && typeof _fbReady!=='undefined' && _fbReady; }

// ── color math ──
function brHex(h){
  const s = String(h||'').trim().replace(/^#/,'');
  if(/^[0-9a-fA-F]{6}$/.test(s)) return '#'+s.toUpperCase();
  if(/^[0-9a-fA-F]{3}$/.test(s)) return '#'+s.split('').map(c=>c+c).join('').toUpperCase();
  return null;
}
function _brRgb(hex){ const h=brHex(hex)||'#000000'; return [1,3,5].map(i=>parseInt(h.slice(i,i+2),16)); }
function brMix(hex, withHex, t){   // t = share of withHex (0..1)
  const a=_brRgb(hex), b=_brRgb(withHex);
  const m=a.map((v,i)=>Math.round(v*(1-t)+b[i]*t));
  return '#'+m.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function brLum(hex){
  const [r,g,b]=_brRgb(hex).map(v=>{ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
  return 0.2126*r+0.7152*g+0.0722*b;
}
function brTextOn(hex){ return brLum(hex) > 0.45 ? '#1A1A1A' : '#FFFFFF'; }

// ── resolve: cfg (or nothing) → the full palette every consumer derives from ──
function glBrandResolveCfg(cfg){
  const c = cfg || {};
  const primary = brHex(c.primary) || GL_BRAND_DEFAULT.primary;
  const accent  = brHex(c.accent)  || GL_BRAND_DEFAULT.accent;
  return {
    primary, accent,
    tint:  brMix(primary,'#FFFFFF',0.88),   // info-cell / header-strip fill
    hot:   brMix(accent, '#FFFFFF',0.80),   // overdue / warning fill
    amberLight: brMix(accent,'#FFFFFF',0.82),
    ink:   '#1A1A1A',
    hText: brTextOn(primary),
    applyToQi: !!c.applyToQi,
    isDefault: !cfg || (!brHex(c.primary) && !brHex(c.accent))
  };
}
function glBrandGet(pid){ const v=_brCfg[_brPid(pid)]; return v===undefined ? null : v; }
function glBrandResolve(pid){ return glBrandResolveCfg(glBrandGet(pid)); }

async function glBrandEnsure(pid){
  pid = _brPid(pid);
  if(_brCfg[pid]!==undefined) return _brCfg[pid];
  if(_brLoading[pid]) return _brLoading[pid];
  _brLoading[pid] = (async()=>{
    let local=null;
    try{ local = (typeof idbGet==='function') ? (await idbGet('brand_cfg::'+pid)) || null : null; }catch(e){}
    _brCfg[pid] = local;
    if(_brCloudOk() && pid!=='default'){
      try{
        const snap = await db.collection('projects').doc(pid).collection('config').doc('branding').get();
        if(snap.exists){
          const cloud = snap.data();
          if(!local || (cloud._mts||0) >= (local._mts||0)){ _brCfg[pid]=cloud; try{ idbSet('brand_cfg::'+pid, cloud); }catch(e){} }
        }
      }catch(e){ console.warn('[brand] load failed:', e.message); }
    }
    delete _brLoading[pid];
    return _brCfg[pid];
  })();
  return _brLoading[pid];
}

// Merge a patch into the project's branding doc (local first, cloud when allowed).
async function glBrandSave(pid, patch){
  pid = _brPid(pid);
  await glBrandEnsure(pid);
  const next = Object.assign({}, _brCfg[pid]||{}, patch||{}, { _mts: Date.now() });
  _brCfg[pid] = next;
  try{ idbSet('brand_cfg::'+pid, next); }catch(e){}
  if(!_brCloudOk() || pid==='default') return { ok:true, local:true };
  try{
    await db.collection('projects').doc(pid).collection('config').doc('branding').set(next, { merge:false });
    return { ok:true };
  }catch(e){
    console.warn('[brand] cloud save failed (kept locally):', e.message);
    return { ok:false, error:e, permission:/permission/i.test(String(e&&e.message)) };
  }
}

// ── logo (branding doc → legacy per-user project settings) ──
async function glBrandLogo(pid){
  pid = _brPid(pid);
  const cfg = await glBrandEnsure(pid);
  if(cfg && cfg.logoB64) return { b64:String(cfg.logoB64), w:cfg.logoW||200, h:cfg.logoH||50 };
  if(cfg && cfg.logoB64===null) return null;   // explicitly removed
  // legacy location (pre-9/5): only the author's device can read it
  try{
    const u=_brUdb();
    if(u && _brCloudOk() && pid!=='default'){
      const d = await u.collection('settings').doc(pid).get();
      if(d.exists && d.data().reportLogoB64) return { b64:String(d.data().reportLogoB64), w:d.data().reportLogoW||200, h:d.data().reportLogoH||50 };
    }
  }catch(e){}
  return null;
}

// ── palettes ──
function _brPalFromResolved(r){ return { h:r.primary, lt:r.tint, mid:r.primary, hot:r.hot, rule:r.accent, hText:r.hText }; }
function glBrandPalFromCfg(cfg){ return _brPalFromResolved(glBrandResolveCfg(cfg)); }
function glBrandPdfPal(pid, o){
  const r = glBrandResolve(pid);
  if(o && o.forQi && !r.applyToQi) return _OFFICE_PDF;
  return _brPalFromResolved(r);
}
function glBrandDocx(pid, o){
  const r = glBrandResolve(pid);
  if(o && o.forQi && !r.applyToQi) return _OFFICE_DOCX;
  const s = h => String(h).replace('#','');
  return { BLUE:s(r.primary), LT_BLUE:s(r.tint), MID_BLUE:s(r.primary), RULE:s(r.accent), HOT:s(r.hot), HTEXT:s(r.hText) };
}
function glBrandXl(pid){
  const r = glBrandResolve(pid);
  const s = h => String(h).replace('#','');
  return { teal:s(r.primary), am:s(r.accent), amLt:s(r.amberLight), tl:s(r.tint), htx:s(r.hText), ftl:'FF'+s(r.primary), fam:'FF'+s(r.accent) };
}
// What rides the review snapshot: the resolved colors only (logo already rides separately).
function glBrandSnapshot(pid){ const r=glBrandResolve(pid); return { primary:r.primary, accent:r.accent }; }

// ── user presets ──
async function glBrandPresetsList(){
  const u=_brUdb(); if(!u || !_brCloudOk()) return [];
  try{
    const qs = await u.collection('brandPresets').orderBy('createdAt','desc').get();
    return qs.docs.map(d=>Object.assign({id:d.id}, d.data()));
  }catch(e){ console.warn('[brand] presets load failed:', e.message); return []; }
}
async function glBrandPresetSave(name, pid){
  const u=_brUdb(); if(!u || !_brCloudOk()) throw new Error('Sign in to save presets');
  pid=_brPid(pid);
  const cfg = (await glBrandEnsure(pid)) || {};
  const r = glBrandResolveCfg(cfg);
  const logo = await glBrandLogo(pid);
  const doc = { name:String(name||'').trim()||'Branding', primary:r.primary, accent:r.accent, applyToQi:!!r.applyToQi,
    logoB64: logo?logo.b64:null, logoW: logo?logo.w:null, logoH: logo?logo.h:null, createdAt: Date.now() };
  const ref = await u.collection('brandPresets').add(doc);
  return Object.assign({id:ref.id}, doc);
}
async function glBrandPresetApply(preset, pid){
  const patch = { primary:preset.primary, accent:preset.accent, applyToQi:!!preset.applyToQi, name:preset.name||'' };
  if(preset.logoB64){ patch.logoB64=preset.logoB64; patch.logoW=preset.logoW||200; patch.logoH=preset.logoH||50; }
  return glBrandSave(pid, patch);
}
async function glBrandPresetDelete(id){
  const u=_brUdb(); if(!u || !_brCloudOk()) return;
  try{ await u.collection('brandPresets').doc(id).delete(); }catch(e){ console.warn('[brand] preset delete failed:', e.message); }
}

// ── Settings UI (Settings → Report Generation → Report Branding) ──
function _brStatus(msg, isErr){
  const el=document.getElementById('cfg-brand-status'); if(!el) return;
  el.textContent=msg; el.style.color=isErr?'#c0392b':'var(--green)'; el.style.opacity='1';
  clearTimeout(el._t); el._t=setTimeout(()=>{ el.style.opacity='0'; }, 3200);
}
function _brField(id){ return document.getElementById(id); }
function _brUIValues(){
  const p=brHex(_brField('cfg-brand-primary-hex')?.value)||brHex(_brField('cfg-brand-primary')?.value)||GL_BRAND_DEFAULT.primary;
  const a=brHex(_brField('cfg-brand-accent-hex')?.value)||brHex(_brField('cfg-brand-accent')?.value)||GL_BRAND_DEFAULT.accent;
  return { primary:p, accent:a, applyToQi:!!_brField('cfg-brand-qi')?.checked };
}
function _brUISet(primary, accent, applyToQi){
  const P=brHex(primary)||GL_BRAND_DEFAULT.primary, A=brHex(accent)||GL_BRAND_DEFAULT.accent;
  if(_brField('cfg-brand-primary')) _brField('cfg-brand-primary').value=P;
  if(_brField('cfg-brand-primary-hex')) _brField('cfg-brand-primary-hex').value=P;
  if(_brField('cfg-brand-accent')) _brField('cfg-brand-accent').value=A;
  if(_brField('cfg-brand-accent-hex')) _brField('cfg-brand-accent-hex').value=A;
  if(applyToQi!==undefined && _brField('cfg-brand-qi')) _brField('cfg-brand-qi').checked=!!applyToQi;
  glBrandUIPreview();
}
function glBrandUIPreview(){
  const v=_brUIValues(); const r=glBrandResolveCfg(v);
  // color inputs follow the hex fields and vice versa
  const pc=_brField('cfg-brand-primary'), ac=_brField('cfg-brand-accent');
  if(pc && pc.value.toUpperCase()!==r.primary) pc.value=r.primary;
  if(ac && ac.value.toUpperCase()!==r.accent) ac.value=r.accent;
  const band=_brField('cfg-brand-pv-band'); if(band){ band.style.background=r.primary; band.style.color=r.hText; }
  const cellL=_brField('cfg-brand-pv-cell'); if(cellL){ cellL.style.background=r.tint; }
  const rule=_brField('cfg-brand-pv-rule'); if(rule){ rule.style.borderBottomColor=r.accent; rule.style.color=r.primary; }
  const hot=_brField('cfg-brand-pv-hot'); if(hot){ hot.style.background=r.hot; }
}
function glBrandUIHex(which, val){
  const h=brHex(val); if(!h) return;
  const c=_brField('cfg-brand-'+which); if(c) c.value=h;
  glBrandUIPreview();
}
function glBrandUIColor(which, val){
  const hx=_brField('cfg-brand-'+which+'-hex'); if(hx) hx.value=String(val||'').toUpperCase();
  glBrandUIPreview();
}
function glBrandUIPreset(kind){
  if(kind==='office') _brUISet(GL_BRAND_OFFICE.primary, GL_BRAND_OFFICE.accent);
  else _brUISet(GL_BRAND_DEFAULT.primary, GL_BRAND_DEFAULT.accent);
}
async function glBrandInitUI(){
  const pid=_brPid();
  const cfg = await glBrandEnsure(pid);
  const r = glBrandResolveCfg(cfg);
  _brUISet(r.primary, r.accent, r.applyToQi);
  const nm=_brField('cfg-brand-name'); if(nm) nm.textContent = cfg&&cfg.name ? ('Preset: '+cfg.name) : '';
}
async function glBrandUISave(){
  const pid=_brPid();
  if(!pid || pid==='default'){ _brStatus('Create a project first.', true); return; }
  const v=_brUIValues();
  const res = await glBrandSave(pid, { primary:v.primary, accent:v.accent, applyToQi:v.applyToQi });
  if(res.ok) _brStatus(res.local ? '✓ Saved on this device' : '✓ Branding saved — every export of this project uses it');
  else _brStatus(res.permission ? 'Saved locally only — a project lead has to set branding' : 'Save failed: '+(res.error&&res.error.message||'error'), true);
}
async function glBrandPickPreset(){
  const list = await glBrandPresetsList();
  if(typeof glPick!=='function') return;
  glPick({
    title:'Use a saved branding',
    placeholder:'Search brandings…',
    rows: list.map(p=>({ value:p.id, label:p.name||'Branding', sub:`${p.primary} · ${p.accent}${p.logoB64?' · logo':''}${p.applyToQi?' · QI branded':''}`, meta:new Date(p.createdAt||0).toLocaleDateString(), icon:'🎨' })),
    empty:{ text:'No saved brandings yet — set this project up, then tap "Save as preset".' },
    onPick: async (id)=>{
      const p=list.find(x=>x.id===id); if(!p) return;
      const res = await glBrandPresetApply(p, _brPid());
      await glBrandInitUI();
      if(typeof rptLoadReportLogoUI==='function') rptLoadReportLogoUI();
      _brStatus(res.ok ? `✓ "${p.name}" applied to this project` : 'Applied locally — a project lead has to save branding', !res.ok);
    }
  });
}
function glBrandSaveAsPreset(){
  const ov=document.createElement('div'); ov.className='modal-overlay'; ov.style.cssText='z-index:9600';
  const cur=glBrandGet(_brPid());
  ov.innerHTML=`<div class="modal-box" style="max-width:340px;width:92%">
    <div class="modal-title" style="margin-bottom:8px">Save branding as preset</div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px;line-height:1.5">Saves this project's logo, colors and QI setting to your account so the next project can reuse it.</div>
    <input type="text" id="_brPresetName" placeholder="e.g. London Environmental" value="${(cur&&cur.name)?String(cur.name).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'):''}" style="width:100%;margin-bottom:12px">
    <div class="modal-btns"><button class="modal-cancel" onclick="this.closest('.modal-overlay').remove()">Cancel</button><button class="modal-confirm" id="_brPresetOk">Save</button></div>
  </div>`;
  document.body.appendChild(ov);
  const inp=ov.querySelector('#_brPresetName'); setTimeout(()=>inp&&inp.focus(),50);
  ov.querySelector('#_brPresetOk').onclick=async()=>{
    const name=(inp.value||'').trim(); if(!name){ inp.focus(); return; }
    // unsaved field edits count — save the project first so the preset matches what's on screen
    const v=_brUIValues(); await glBrandSave(_brPid(), { primary:v.primary, accent:v.accent, applyToQi:v.applyToQi, name });
    try{ await glBrandPresetSave(name, _brPid()); ov.remove(); await glBrandInitUI(); _brStatus(`✓ Preset "${name}" saved to your account`); }
    catch(e){ _brStatus('Preset save failed: '+(e.message||'error'), true); }
  };
}

// ── seams ──
window.glBrandEnsure=glBrandEnsure;
window.glBrandGet=glBrandGet;
window.glBrandResolve=glBrandResolve;
window.glBrandResolveCfg=glBrandResolveCfg;
window.glBrandSave=glBrandSave;
window.glBrandLogo=glBrandLogo;
window.glBrandPdfPal=glBrandPdfPal;
window.glBrandPalFromCfg=glBrandPalFromCfg;
window.glBrandDocx=glBrandDocx;
window.glBrandXl=glBrandXl;
window.glBrandSnapshot=glBrandSnapshot;
window.glBrandInitUI=glBrandInitUI;
window.glBrandUIPreview=glBrandUIPreview;
window.glBrandUIHex=glBrandUIHex;
window.glBrandUIColor=glBrandUIColor;
window.glBrandUIPreset=glBrandUIPreset;
window.glBrandUISave=glBrandUISave;
window.glBrandPickPreset=glBrandPickPreset;
window.glBrandSaveAsPreset=glBrandSaveAsPreset;
export { glBrandEnsure, glBrandGet, glBrandResolve, glBrandPalFromCfg, glBrandPdfPal, glBrandDocx, glBrandXl, glBrandLogo, glBrandSnapshot };
