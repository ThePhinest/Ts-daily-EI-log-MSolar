// ── 📇 House picker modal — the ONE "choose from a project list" control ──────
// Tim 8/20: "I'd prefer a popup modal — keep that for everything going forward";
// native <datalist> is out (iOS renders it as a cramped keyboard-suggestion strip,
// and every picker in the app should look and search the same way). Contractors,
// materials, known projects, and any future list all come through here.
//
// glPick({
//   title:       'Pick contractor / contact',
//   placeholder: 'Search…',                       // search box hint
//   rows: [{ value, label, sub, meta, accent, icon, children:[{value,label,sub,meta,icon}] }],
//   target:      'input-id' | HTMLElement,        // default onPick: fill + input/change events
//   onPick:      (value,row)=>{},                 // optional override
//   empty:       { text, actionLabel, onAction }  // shown when rows is empty
// })
// Search matches label / sub / meta on a row and its children; a parent that
// matches keeps all its children, a child that matches keeps its parent.
// Tapping a parent picks row.value; tapping a child picks child.value.

function _gpEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

function glPick(opts){
  opts=opts||{};
  const rows=Array.isArray(opts.rows)?opts.rows:[];
  const target=(typeof opts.target==='string')?document.getElementById(opts.target):(opts.target||null);
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.style.cssText='z-index:9600';
  const hit=(s,q)=>!q||String(s||'').toLowerCase().includes(q);
  const rowHtml=(r,isChild)=>{
    const pad=isChild?'8px 12px 8px 26px':'10px 12px';
    const bg=isChild?'var(--bg)':'var(--s1)';
    const accent=(!isChild&&r.accent)?'border-left:3px solid var(--amber);':(!isChild?'border-left:3px solid var(--border);':'');
    const icon=r.icon?`<span style="font-size:12px;flex:none">${_gpEsc(r.icon)}</span>`:'';
    const sub=r.sub?`<div style="font-size:11px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_gpEsc(r.sub)}</div>`:'';
    const meta=r.meta?`<span style="font-family:var(--mono);font-size:${isChild?'10px':'9px'};color:${isChild?'var(--amber)':'var(--muted)'};white-space:nowrap;flex:none">${_gpEsc(r.meta)}</span>`:'';
    return `<div class="gl-pick-row" data-v="${_gpEsc(r.value)}" style="display:flex;align-items:center;gap:8px;padding:${pad};${isChild?'margin-top:3px;':''}border:1px solid var(--border);${accent}border-radius:8px;cursor:pointer;background:${bg}">
      ${icon}<div style="flex:1;min-width:0"><div style="font-family:var(--mono);font-size:${isChild?'12px':'13px'};color:var(--text);${isChild?'':'font-weight:700'}">${_gpEsc(r.label)}</div>${sub}</div>${meta}
    </div>`;
  };
  const listHtml=(q)=>{
    q=String(q||'').trim().toLowerCase();
    const out=rows.map(r=>{
      const kids=Array.isArray(r.children)?r.children.filter(k=>k&&k.label):[];
      const parentHit=hit(r.label,q)||hit(r.sub,q)||hit(r.meta,q);
      const kidHits=parentHit?kids:kids.filter(k=>hit(k.label,q)||hit(k.sub,q)||hit(k.meta,q));
      if(!parentHit&&!kidHits.length) return '';
      return `<div style="margin-bottom:6px">${rowHtml(r,false)}${kidHits.map(k=>rowHtml(k,true)).join('')}</div>`;
    }).join('');
    if(out) return out;
    const e=opts.empty||{};
    return `<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:10px 0;text-align:center">${rows.length?'No match.':_gpEsc(e.text||'Nothing to pick from yet.')}</div>`;
  };
  const e=opts.empty||{};
  ov.innerHTML=`<div class="modal-box" style="max-width:420px;width:94%;max-height:82vh;display:flex;flex-direction:column">
    <div class="modal-title" style="margin-bottom:8px">${_gpEsc(opts.title||'Pick one')}</div>
    <input type="text" class="gl-pick-q" placeholder="${_gpEsc(opts.placeholder||'Search…')}" style="width:100%;box-sizing:border-box;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--body);font-size:16px;padding:9px 12px;outline:none;margin-bottom:10px">
    <div class="gl-pick-rows" style="overflow-y:auto;flex:1;min-height:0">${listHtml('')}</div>
    <div class="modal-btns" style="margin-top:10px">
      <button type="button" class="modal-cancel">Cancel</button>
      ${(!rows.length&&e.actionLabel)?`<button type="button" class="modal-confirm gl-pick-action">${_gpEsc(e.actionLabel)}</button>`:''}
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('.modal-cancel').onclick=close;
  const act=ov.querySelector('.gl-pick-action');
  if(act) act.onclick=()=>{ close(); try{ e.onAction&&e.onAction(); }catch(err){ console.warn('glPick action:',err.message); } };
  const list=ov.querySelector('.gl-pick-rows');
  list.onclick=(ev)=>{
    const r=ev.target.closest('.gl-pick-row'); if(!r) return;
    const v=r.getAttribute('data-v')||'';
    const row=_gpFind(rows,v);
    close();
    if(typeof opts.onPick==='function'){ opts.onPick(v,row); }
    else if(target){
      target.value=v;
      target.dispatchEvent(new Event('input',{bubbles:true}));
      target.dispatchEvent(new Event('change',{bubbles:true}));
      if(typeof autoResize==='function'&&target.tagName==='TEXTAREA') autoResize(target);
    }
    if(typeof glHaptic==='function') try{ glHaptic(); }catch(_){}
  };
  const q=ov.querySelector('.gl-pick-q');
  q.oninput=()=>{ list.innerHTML=listHtml(q.value); };
  return ov;
}
function _gpFind(rows,v){
  for(const r of rows){
    if(r.value===v) return r;
    for(const k of (r.children||[])) if(k.value===v) return k;
  }
  return null;
}
// Button markup shared by every picker-backed input. `onclick` is a JS string.
function glPickBtn(onclick, icon, title){
  return `<button type="button" onclick="${_gpEsc(onclick)}" title="${_gpEsc(title||'Pick from the list')}" style="flex-shrink:0;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--amber);font-size:14px;padding:0 11px;cursor:pointer;line-height:1">${icon||'📇'}</button>`;
}

window.glPick=glPick;
window.glPickBtn=glPickBtn;
export { glPick, glPickBtn };
