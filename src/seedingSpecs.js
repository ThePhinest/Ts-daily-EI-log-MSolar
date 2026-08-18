// ═══════════════════════════════════════════
// 🌱 SEEDING SPECS ENGINE — per-project seeding rules (entry-form assist)
// ═══════════════════════════════════════════
//
// Resolves a project's seeding spec rules (where × purpose × date × method)
// into entry-form autofill values, read-only spec notes, and amber warnings.
// Rules live in per-project config — the app stays project-agnostic:
//
//   config: projects/{pid}/config/seedingSpecs   (member-read / lead-write — existing rules)
//
// Two-layer rules: `spec` = what the governing documents call for (with
// citation); optional `practice` = the field-agreed substitute actually in
// use. Autofill uses practice when present; the spec always shows, and a
// deviation renders as a standing amber line — documenting an approved
// substitution, never hiding it.
//
// This module touches NO export path. `seedWhere` is stored on the entry
// (history from day one) but is not rendered into any deliverable yet.

// ── State ──
var _ssCfg = {};       // pid → config object | null (checked and missing)
var _ssLoading = {};   // pid → in-flight load promise

function _ssPid(){ return (typeof _activeProjectId==='function') ? _activeProjectId() : 'default'; }

function ssGetCfg(pid){ const v=_ssCfg[pid]; return v===undefined?null:v; }

// IDB first (instant, offline), then cloud refresh. Callers re-render on resolve.
async function ssEnsureCfg(pid){
  pid = pid || _ssPid();
  if(_ssCfg[pid]!==undefined) return _ssCfg[pid];
  if(_ssLoading[pid]) return _ssLoading[pid];
  _ssLoading[pid] = (async()=>{
    try{ _ssCfg[pid] = (await idbGet('ss_cfg::'+pid)) || null; }catch(e){ _ssCfg[pid] = null; }
    if(typeof db!=='undefined' && db && typeof _fbReady!=='undefined' && _fbReady){
      try{
        const snap = await db.collection('projects').doc(pid).collection('config').doc('seedingSpecs').get();
        if(snap.exists){ _ssCfg[pid] = snap.data(); idbSet('ss_cfg::'+pid, _ssCfg[pid]); }
      }catch(e){ console.warn('seeding specs load failed:', e.message); }
    }
    delete _ssLoading[pid];
    return _ssCfg[pid];
  })();
  return _ssLoading[pid];
}

// ── Resolution (pure — Node-smokeable) ──

// "MM-DD" inside {from:"MM-DD", to:"MM-DD"}; from > to wraps the year end
// (Nov 16 → Apr 15). String compare is safe on zero-padded MM-DD.
function _ssInWindow(md, w){
  if(!w || !w.from || !w.to) return true;
  return (w.from <= w.to) ? (md >= w.from && md <= w.to) : (md >= w.from || md <= w.to);
}

// Map a state's label to temporary/permanent via the config's patterns; null = unknown.
function ssStatePurpose(cfg, stateLabel){
  for(const sp of (cfg && cfg.statePurpose) || []){
    try{ if(new RegExp(sp.match, 'i').test(stateLabel || '')) return sp.purpose; }catch(e){}
  }
  return null;
}

function ssWhereLabel(cfg, id){
  const loc = ((cfg && cfg.locations) || []).find(l=>l.id===id);
  return loc ? loc.label : (id || '');
}

// Rate spec: number, or {broadcast:150, drill:100, default:150} keyed by
// substrings of the entry's Method value (case-insensitive).
function _ssRate(rateSpec, method){
  if(rateSpec==null || typeof rateSpec==='number') return rateSpec;
  const m = (method || '').toLowerCase();
  for(const k of Object.keys(rateSpec)){
    if(k!=='default' && m && m.includes(k.toLowerCase())) return rateSpec[k];
  }
  return rateSpec.default!=null ? rateSpec.default : null;
}

function _ssRateText(rateSpec){
  if(rateSpec==null) return '';
  if(typeof rateSpec==='number') return rateSpec+' lbs/ac';
  return Object.keys(rateSpec).filter(k=>k!=='default').map(k=>rateSpec[k]+' '+k).join(' / ')+' lbs/ac';
}

// Best rule for {where, purpose, date:"YYYY-MM-DD", method}. In-window rules
// always beat out-of-window fallbacks; then most-constrained wins; tie = first.
function ssResolve(cfg, sel){
  if(!cfg || !(cfg.rules||[]).length || !sel || !sel.where) return null;
  const md = (sel.date || '').slice(5);
  let best = null, bestScore = -Infinity;
  for(const r of cfg.rules){
    if(r.where && r.where.length && !r.where.includes(sel.where)) continue;
    if(r.purpose && sel.purpose && r.purpose!==sel.purpose) continue;
    let score = (r.where && r.where.length ? 2 : 0) + (r.purpose ? 1 : 0);
    let inWindow = true;
    if(r.windows && r.windows.length && md){
      inWindow = r.windows.some(w=>_ssInWindow(md, w));
      score += inWindow ? 2 : -100;   // out-of-window = last-resort fallback only
    }
    if(score > bestScore){ best = {rule:r, inWindow}; bestScore = score; }
  }
  if(!best) return null;
  const r = best.rule;
  const layer = r.practice || r.spec || {};
  const rate = _ssRate(layer.rate, sel.method);
  const warnings = [];
  if(r.practice && r.spec){
    warnings.push('Field practice: '+(r.practice.product||'')+' '+_ssRateText(r.practice.rate)+
      ' — spec calls for '+(r.spec.product||'')+' '+_ssRateText(r.spec.rate)+
      (r.spec.cite ? ' ('+r.spec.cite+')' : '')+
      (r.practice.note ? '. '+r.practice.note : ''));
  }
  if(!best.inWindow){
    warnings.push(r.outOfWindowWarning || 'Date is outside this rule’s seeding window — verify before seeding.');
  }
  return {
    ruleId: r.id || null,
    label: r.label || '',
    product: layer.product || null,
    rate: rate,
    spec: r.spec || null,
    mulch: r.mulch || null,
    fertilizer: r.fertilizer || null,
    notes: r.notes || [],
    globalNotes: cfg.globalNotes || [],
    warnings: warnings,
    deviation: !!(r.practice && r.spec),
    inWindow: best.inWindow,
  };
}

// ── Amendment rules (lime / fertilizer / mulch) ──
// cfg.amendments = [{type:'lime'|'fertilizer'|'mulch'|'other', where:[locIds]?,
//   windows:[{from,to}]?, product, rate, rateUnit:'tons/ac'|…, cite?, notes?}]
// Same scoring shape as ssResolve: where-constrained beats generic, in-window
// beats out-of-window fallback. Feeds the lime/fert application-row autofill +
// the amber out-of-spec warning (applications.js).
function ssResolveAmendment(cfg, sel){
  const list=(cfg&&cfg.amendments)||[];
  if(!list.length||!sel||!sel.type) return null;
  const md=(sel.date||'').slice(5);
  let best=null,bestScore=-Infinity;
  for(const r of list){
    if(r.type!==sel.type) continue;
    if(r.where&&r.where.length&&(!sel.where||!r.where.includes(sel.where))) continue;
    let score=(r.where&&r.where.length?2:0);
    if(r.windows&&r.windows.length&&md) score+=r.windows.some(w=>_ssInWindow(md,w))?2:-100;
    if(score>bestScore){ best=r; bestScore=score; }
  }
  if(!best) return null;
  return {product:best.product||null, rate:best.rate!=null?best.rate:null,
    rateUnit:best.rateUnit||null, cite:best.cite||null, notes:best.notes||[]};
}

// ── Setup (paste-JSON, one time per project — QI config pattern) ──
function ssShowSetup(){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-box" style="max-width:520px">
    <h3 style="margin:0 0 8px">🌱 Set up Seeding Specs</h3>
    <p style="font-size:12px;color:var(--muted);margin:0 0 10px">Paste the project's seeding specs JSON (locations, seasonal rules, rates, field-practice substitutions). It saves to the shared project config — entries then autofill seed mix &amp; rate from where you seeded and the date.</p>
    <textarea id="ss-setup-json" style="width:100%;min-height:180px;box-sizing:border-box;font-family:var(--mono);font-size:10px" placeholder='{"formType":"seeding-specs", ...}'></textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn" onclick="ssSaveSetup()">Save configuration</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
async function ssSaveSetup(){
  const ta = document.getElementById('ss-setup-json');
  let cfg;
  try{ cfg = JSON.parse(ta.value); }
  catch(e){ ta.style.borderColor='#e74c3c'; return; }
  if(cfg.formType !== 'seeding-specs'){ ta.style.borderColor='#e74c3c'; return; }
  const pid = _ssPid();
  _ssCfg[pid] = cfg;
  idbSet('ss_cfg::'+pid, cfg);
  try{ if(typeof db!=='undefined' && db && _fbReady) await db.collection('projects').doc(pid).collection('config').doc('seedingSpecs').set(cfg); }
  catch(e){ console.warn('seeding specs cloud save failed (kept locally):', e.message); }
  document.querySelector('.modal-overlay')?.remove();
}

// ── Window seams (Vite ESM cross-module pattern) ──
window.ssGetCfg = ssGetCfg;
window._ssRateText = _ssRateText;
window.ssEnsureCfg = ssEnsureCfg;
window.ssResolve = ssResolve;
window.ssResolveAmendment = ssResolveAmendment;
window.ssStatePurpose = ssStatePurpose;
window.ssWhereLabel = ssWhereLabel;
window.ssShowSetup = ssShowSetup;
window.ssSaveSetup = ssSaveSetup;
