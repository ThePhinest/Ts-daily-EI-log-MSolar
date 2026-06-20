// ═══════════════════════════════════════════
// DOCUMENTS LIBRARY  (Stage 1 — the pain-killer MVP)
// ═══════════════════════════════════════════
// Design-of-record: KB documents-library-plan.md (locked 2026-06-20).
//
// What this is: upload plans / permits / drawings / specs once, read them IN-APP
// (no more share→Books→rename dance), organize in folders, pin for offline field
// reading, and share project plans with collaborators. Built on the same trust
// model as photos/KML — file in Firebase Storage, metadata in Firestore, the
// persisted downloadURL is the share capability.
//
// CCUSF: this is the foundation of a Procore-grade document library, but ours
// ties documents to the live map (Stage 4, fields reserved below) and travels
// with the user across firms. Links use BRAND teal, never Procore blue.
//
// ── Data model (record shape carries all 4 stages — no migration later) ──
//   users/{uid}/docs/{docId}        own copy (private by default)
//   projects/{pid}/docs/{docId}     mirror copy when shared (live reference data)
//   { id, ownerUid, projectId, title, type:'pdf'|'img'|'office', ext,
//     storagePath, downloadUrl, folder, size, createdAt, updatedAt,
//     aiAccessOptIn:false, offline(local-only), shared,
//     // RESERVED (Stages 2-4, not written in Stage 1):
//     sheetNumber, sheetTitle, revision, supersedesId, links[], geo{} }
//
// ── Offline (the deliberate per-doc pin) ──
// Pinned file BLOBS live in their OWN idb-keyval store (groundlog-docs/blobs),
// NOT the shared idbCache — idbCache hydrates its whole store into memory on
// every boot, and a pinned 50 MB plan set must never load into RAM at launch.
// Un-pinned docs stream from Storage on demand. This is what keeps Procore's
// "cache everything and choke" failure mode off our table.

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { get as idbKvGet, set as idbKvSet, del as idbKvDel, keys as idbKvKeys, clear as idbKvClear, createStore } from 'idb-keyval'

// pdfjs is heavy (~1.2 MB). Lazy-load it only when a PDF is actually opened so it
// stays OUT of the main bundle — keeps us well under the Workbox precache cap and
// speeds first paint on every page that isn't the viewer. Vite emits it as its own
// chunk (still precached as a separate sub-cap file, so offline viewing works).
let _pdfjs = null;
async function _loadPdfjs(){
  if(!_pdfjs){
    _pdfjs = await import('pdfjs-dist');
    _pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  return _pdfjs;
}

// Auxiliary asset dirs (copied to dist/pdfjs/ by vite-plugin-static-copy).
// Lets the viewer decode JPEG2000/JBIG2 images (wasm), ICC color (iccs), CJK
// text (cmaps), and non-embedded standard fonts. base is '/' so '/pdfjs/...'
// resolves on web (Pages root) and in the Capacitor WebView alike.
const _PDF_ASSETS = (import.meta.env.BASE_URL || '/') + 'pdfjs/';
const _PDF_DOC_OPTS = {
  wasmUrl: _PDF_ASSETS + 'wasm/',
  iccUrl: _PDF_ASSETS + 'iccs/',
  cMapUrl: _PDF_ASSETS + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: _PDF_ASSETS + 'standard_fonts/',
};

// Separate device store for pinned blobs — kept OUT of the shared idbCache mirror.
const _docBlobStore = createStore('groundlog-docs', 'blobs');

window._docs = window._docs || [];              // own docs metadata (active project)
window._docsShared = window._docsShared || [];  // teammates' shared docs (active project)
let _docFolderOpen = {};                          // folder -> expanded bool
let _docSharedOpen = false;
let _docOfflineIds = new Set();                   // ids with a pinned blob present
let _docFilterFolder = null;                      // upload target / current folder context
let _docQuery = '';                               // library search text

const _DOC_OFFICE_EXT = ['doc','docx','xls','xlsx','ppt','pptx','csv','txt','rtf'];
const _DOC_IMG_EXT    = ['jpg','jpeg','png','gif','webp','heic','heif','bmp'];

function _docGenId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function _docPid(){ return (typeof _activeProjectId==='function') ? _activeProjectId() : 'default'; }
function _docReady(){ return typeof db!=='undefined' && db && window._fbReady && window._currentUser; }
function _docEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _docExt(name){ const m = String(name||'').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
function _docTypeFor(ext){
  if(ext==='pdf') return 'pdf';
  if(_DOC_IMG_EXT.indexOf(ext)>=0) return 'img';
  return 'office';
}
function _docIcon(d){
  if(d.type==='pdf') return '📕';
  if(d.type==='img') return '🖼️';
  if(['xls','xlsx','csv'].indexOf(d.ext)>=0) return '📊';
  if(['ppt','pptx'].indexOf(d.ext)>=0) return '📈';
  return '📄';
}
function _docFmtSize(n){
  if(!n) return '';
  if(n < 1024) return n+' B';
  if(n < 1048576) return (n/1024).toFixed(0)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}

// ── Boot helper: which ids have a pinned blob on this device ──
async function _docRefreshOfflineSet(){
  try{
    const ks = await idbKvKeys(_docBlobStore);
    _docOfflineIds = new Set(ks.map(String));
  }catch(e){ _docOfflineIds = new Set(); }
}

// ═══════════════════════════════════════════
// LOAD + RENDER
// ═══════════════════════════════════════════
// Instant render from the offline metadata cache, then refresh from Firestore.
async function glRenderDocsPage(){
  if(!document.getElementById('docs-root')) return;
  const pid = _docPid();

  // 1. Instant paint from cache (offline-capable list).
  try{
    if(window.idbReady) await window.idbReady;
    const cached = (typeof window.idbGet==='function') ? window.idbGet('gl_docs::'+pid) : null;
    if(cached){ window._docs = JSON.parse(cached) || []; }
  }catch(e){ /* cache miss is fine */ }
  await _docRefreshOfflineSet();
  _docRenderLibrary();

  // 2. Refresh own docs from cloud.
  if(_docReady() && pid && pid !== 'default'){
    try{
      const snap = await _udb().collection('docs').where('projectId','==',pid).get();
      const list = [];
      snap.forEach(d => list.push(d.data()));
      window._docs = list;
      try{ window.idbSet && window.idbSet('gl_docs::'+pid, JSON.stringify(list)); }catch(e){}
      _docRenderLibrary();
    }catch(e){ console.warn('docLoad:', e.message); }
    _docLoadShared(pid);
  }
}

function _docFolders(){
  const set = new Set();
  (window._docs||[]).forEach(d => set.add(d.folder || 'Unfiled'));
  // Stable order: Unfiled last, others alphabetical.
  const arr = Array.from(set).filter(f => f !== 'Unfiled').sort((a,b)=>a.localeCompare(b));
  if(set.has('Unfiled') || !arr.length) arr.push('Unfiled');
  return arr;
}

// Full render: THREE distinct cards (Tim's call) for the strongest separation —
//   1. 📁 Documents — upload & organize (stats, drop-zone, new folder)
//   2. 📚 Library   — searchable folders of your own docs
//   3. 👥 Shared by teammates — incoming shared docs, its own section
// Search re-renders ONLY #doc-list (see _docRenderList) so the input keeps focus;
// the shared card refreshes on its own via _docRenderSharedBody.
function _docRenderLibrary(){
  const root = document.getElementById('docs-root');
  if(!root) return;
  const nDocs = (window._docs||[]).length;
  const nFolders = _docFolders().filter(f => (window._docs||[]).some(d => (d.folder||'Unfiled')===f)).length;

  root.innerHTML = `
    <div class="card gl-doc-card">
      <div class="card-head gl-doc-head"><span class="card-num">📁</span><span class="card-title">Documents</span></div>
      <div class="card-body">
        <div class="gl-doc-stats">
          <div class="gl-doc-stat"><span class="gl-doc-stat-num">${nDocs}</span><span class="gl-doc-stat-lbl">Documents</span></div>
          <div class="gl-doc-stat"><span class="gl-doc-stat-num">${nFolders}</span><span class="gl-doc-stat-lbl">${nFolders===1?'Folder':'Folders'}</span></div>
        </div>
        <div class="gl-doc-drop" id="doc-drop"
          ondragover="event.preventDefault();this.classList.add('drag')"
          ondragleave="this.classList.remove('drag')"
          ondrop="event.preventDefault();this.classList.remove('drag');docHandleFiles(event.dataTransfer.files)"
          onclick="docPickFiles()">
          <div class="gl-doc-drop-icon">📄</div>
          <div class="gl-doc-drop-txt">Tap to upload or drop documents here</div>
          <div class="gl-doc-drop-sub">PDFs, images, plans &amp; specs</div>
        </div>
        <div class="gl-doc-uploadrow"><button class="gl-doc-newfolder" onclick="docNewFolder()">＋ New folder</button></div>
        <input type="file" id="doc-file-input" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.rtf" style="display:none" onchange="docHandleFiles(this.files)">
        <div id="doc-upload-prog" class="gl-doc-prog" style="display:none"><div id="doc-upload-prog-bar" class="gl-doc-prog-bar"></div><div id="doc-upload-prog-txt" class="gl-doc-prog-txt"></div></div>
      </div>
    </div>

    <div class="card gl-doc-card">
      <div class="card-head gl-doc-head"><span class="card-num">📚</span><span class="card-title">Library</span></div>
      <div class="card-body">
        <input id="doc-search" class="gl-doc-search" type="text" placeholder="Search documents…" value="${_docEsc(_docQuery)}" oninput="docSearch(this.value)" autocomplete="off">
        <div id="doc-list"></div>
      </div>
    </div>

    <div class="card gl-doc-card">
      <div class="card-head gl-doc-head"><span class="card-num">👥</span><span class="card-title">Shared by teammates</span><span class="card-badge" id="doc-shared-count">0</span></div>
      <div class="card-body" id="doc-shared-body"></div>
    </div>`;
  _docRenderList();
  _docRenderSharedBody();
}

// Renders ONLY the Library folder list into #doc-list — leaves the upload card,
// search input, and shared card untouched (search never loses focus).
function _docRenderList(){
  const box = document.getElementById('doc-list');
  if(!box) return;
  const q = (_docQuery||'').trim().toLowerCase();
  const docs = (window._docs||[]).slice().sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));

  // Search: flat result list across every folder.
  if(q){
    const hits = docs.filter(d => (d.title||'').toLowerCase().includes(q) || (d.folder||'').toLowerCase().includes(q));
    box.innerHTML = `<div class="gl-doc-results">${hits.length} result${hits.length===1?'':'s'} for “${_docEsc(_docQuery.trim())}”</div>`
      + (hits.length ? hits.map(_docRow).join('') : '<div class="gl-doc-empty-line">No documents match your search.</div>');
    return;
  }

  if(!docs.length){
    box.innerHTML = '<div class="gl-doc-empty-line">No documents yet — upload your first plan set above.</div>';
    return;
  }

  const folders = _docFolders();
  const byFolder = {};
  folders.forEach(f => byFolder[f] = []);
  docs.forEach(d => { const f = d.folder || 'Unfiled'; (byFolder[f] = byFolder[f] || []).push(d); });

  let html = '';
  folders.forEach(f => {
    const items = byFolder[f] || [];
    if(!items.length) return;
    const open = _docFolderOpen[f] !== false; // default expanded
    html += `
      <div class="gl-doc-folder">
        <div class="gl-doc-folder-head" onclick="docToggleFolder('${_docEsc(f).replace(/'/g,"\\'")}')">
          <span class="gl-doc-chev">${open?'▾':'▸'}</span>
          <span class="gl-doc-folder-name">📂 ${_docEsc(f)}</span>
          <span class="gl-doc-folder-count">${items.length}</span>
        </div>
        ${open ? `<div class="gl-doc-folder-body">${items.map(_docRow).join('')}</div>` : ''}
      </div>`;
  });
  box.innerHTML = html;
}

function docSearch(q){ _docQuery = q || ''; _docRenderList(); }

function _docRow(d){
  const pinned = _docOfflineIds.has(d.id);
  const meta = [d.ext ? d.ext.toUpperCase() : '', _docFmtSize(d.size)].filter(Boolean).join(' · ');
  // Single ⋯ menu keeps rows compact; current state shows as inline tags instead
  // of always-present buttons (offline/share now live in the menu).
  const tags = (pinned ? ' · <span class="gl-doc-offline-tag">⬇ offline</span>' : '')
    + (d.shared ? ' · <span class="gl-doc-shared-tag">🤝 shared</span>' : '')
    + (d.aiAccessOptIn ? ' · <span class="gl-doc-ai-tag">AI ✓</span>' : '');
  return `
    <div class="gl-doc-row" id="doc-row-${d.id}">
      <span class="gl-doc-icon" onclick="docOpen('${d.id}')">${_docIcon(d)}</span>
      <div class="gl-doc-info" onclick="docOpen('${d.id}')">
        <div class="gl-doc-title">${_docEsc(d.title)}</div>
        <div class="gl-doc-meta">${_docEsc(meta)}${tags}</div>
      </div>
      <div class="gl-doc-actions">
        <button class="gl-doc-btn" title="Actions" onclick="docMenu('${d.id}')">⋯</button>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════
// FOLDERS
// ═══════════════════════════════════════════
function docToggleFolder(f){ _docFolderOpen[f] = (_docFolderOpen[f] === false); _docRenderList(); }

function docNewFolder(){
  _docPrompt('New folder', '', 'Create', (name)=>{
    name = (name||'').trim();
    if(!name) return;
    _docFilterFolder = name;
    // A folder only "exists" once it has a doc; jump straight into upload for it.
    docPickFiles();
  });
}

// ═══════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════
function docPickFiles(){ const el = document.getElementById('doc-file-input'); if(el) el.click(); }

async function docHandleFiles(fileList){
  const files = Array.from(fileList || []);
  if(!files.length) return;
  if(!_docReady()){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Sign in and pick a project before uploading documents.'); return; }
  const pid = _docPid();
  if(!pid || pid === 'default'){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Open or create a real project first — documents are filed under a project.'); return; }

  const folder = (_docFilterFolder && _docFilterFolder.trim()) || 'Unfiled';
  _docFilterFolder = null;

  const prog = document.getElementById('doc-upload-prog');
  const bar = document.getElementById('doc-upload-prog-bar');
  const txt = document.getElementById('doc-upload-prog-txt');
  if(prog) prog.style.display = 'block';

  const newIds = [];
  for(let i=0;i<files.length;i++){
    const file = files[i];
    if(txt) txt.textContent = `Uploading ${i+1} of ${files.length}: ${file.name}`;
    if(bar) bar.style.width = Math.round((i/files.length)*100)+'%';
    try{
      const id = _docGenId();
      const ext = _docExt(file.name);
      const safeName = file.name.replace(/[^\w.\-]+/g,'_');
      const storagePath = `docs/${window._currentUser.uid}/${id}/${safeName}`;
      const snap = await storage.ref(storagePath).put(file);
      const downloadUrl = await snap.ref.getDownloadURL();
      const now = Date.now();
      const meta = {
        id, ownerUid: window._currentUser.uid, projectId: pid,
        title: file.name.replace(/\.[a-z0-9]+$/i,''),
        type: _docTypeFor(ext), ext,
        storagePath, downloadUrl, folder,
        size: file.size || 0,
        aiAccessOptIn: false, shared: false,
        createdAt: now, updatedAt: now
      };
      await _udb().collection('docs').doc(id).set(meta);
      window._docs.push(meta);
      newIds.push(id);
    }catch(e){
      console.warn('doc upload failed:', e && e.message);
      if(typeof showCloudBanner==='function') showCloudBanner('⚠ Upload failed for '+file.name+' ('+(e&&e.message||'error')+')');
    }
  }

  if(bar) bar.style.width = '100%';
  if(txt) txt.textContent = `${newIds.length} document${newIds.length===1?'':'s'} uploaded`;
  setTimeout(()=>{ if(prog) prog.style.display='none'; if(bar) bar.style.width='0%'; }, 2200);
  const fi = document.getElementById('doc-file-input'); if(fi) fi.value='';

  try{ window.idbSet && window.idbSet('gl_docs::'+pid, JSON.stringify(window._docs)); }catch(e){}
  if(window.glHaptic) window.glHaptic.success && window.glHaptic.success();
  _docRenderLibrary();

  // AI access opt-in (locked 2026-05-12: per-document, DEFAULT OFF).
  if(newIds.length) _docShowAiOptIn(newIds);
}

// ── AI access opt-in modal ──
// Privacy lock: sharing a doc with the team does NOT grant AI access; AI access
// is a separate, explicit, per-document opt-in that defaults OFF. Reggie (the
// regulatory assistant) arrives in a later phase; this stores the decision now.
function _docShowAiOptIn(ids){
  const n = ids.length;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_doc-ai-optin';
  ov.innerHTML = `<div class="modal-box" style="max-width:440px">
    <div class="modal-title">🔒 AI access — ${n} document${n===1?'':'s'}</div>
    <div class="modal-msg" style="text-align:left">
      Allow GroundLog's AI assistant (coming later) to read ${n===1?'this document':'these documents'} so it can answer questions about ${n===1?'it':'them'}?<br><br>
      <span style="color:var(--muted2)">This is OFF by default and separate from sharing. You can change it per-document anytime.</span>
    </div>
    <div class="modal-btns" style="flex-wrap:wrap;gap:8px">
      <button class="modal-cancel" id="_docai-later">Decide later</button>
      <button class="modal-cancel" id="_docai-no">Keep private</button>
      <button class="modal-confirm" id="_docai-yes">Allow AI</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = ()=> ov.remove();
  document.getElementById('_docai-later').onclick = close; // leaves default OFF
  document.getElementById('_docai-no').onclick = close;    // already false
  document.getElementById('_docai-yes').onclick = ()=>{ ids.forEach(id => _docSetAi(id, true)); close(); };
}

async function _docSetAi(id, on){
  const d = (window._docs||[]).find(x=>x.id===id);
  if(!d) return;
  d.aiAccessOptIn = !!on; d.updatedAt = Date.now();
  try{ await _udb().collection('docs').doc(id).set({ aiAccessOptIn: d.aiAccessOptIn, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
  try{ window.idbSet && window.idbSet('gl_docs::'+_docPid(), JSON.stringify(window._docs)); }catch(e){}
  _docRenderLibrary();
}

// ═══════════════════════════════════════════
// VIEW  (in-app — kills the "open in Books" dance)
// ═══════════════════════════════════════════
function docOpen(id){
  const d = (window._docs||[]).find(x=>x.id===id) || (window._docsShared||[]).find(x=>x.id===id);
  if(!d) return;
  if(window.glHaptic && window.glHaptic.light) window.glHaptic.light();
  if(d.type==='pdf') return _docOpenPdf(d);
  if(d.type==='img') return _docOpenImage(d);
  return _docOpenExternal(d);
}

// Resolve the bytes/URL to read: pinned blob (offline) wins, else stream the URL.
async function _docSource(d){
  if(_docOfflineIds.has(d.id)){
    try{
      const blob = await idbKvGet(d.id, _docBlobStore);
      if(blob) return { blob };
    }catch(e){}
  }
  return { url: d.downloadUrl };
}

async function _docOpenPdf(d){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay gl-doc-viewer';
  ov.id = '_doc-viewer';
  ov.innerHTML = `<div class="gl-doc-vbox">
    <div class="gl-doc-vbar">
      <span class="gl-doc-vtitle">${_docIcon(d)} ${_docEsc(d.title)}</span>
      <div class="gl-doc-vctrl">
        <button id="_dv-prev" title="Previous page">‹</button>
        <span id="_dv-page" class="gl-doc-vpage">…</span>
        <button id="_dv-next" title="Next page">›</button>
        <button id="_dv-zout" title="Zoom out">−</button>
        <button id="_dv-zin" title="Zoom in">＋</button>
        <button id="_dv-close" title="Close">✕</button>
      </div>
    </div>
    <div class="gl-doc-vscroll" id="_dv-scroll"><canvas id="_dv-canvas"></canvas><div id="_dv-loading" class="gl-doc-vloading">Loading…</div></div>
  </div>`;
  document.body.appendChild(ov);
  const scroll = document.getElementById('_dv-scroll');
  const canvas = document.getElementById('_dv-canvas');
  const ctx = canvas.getContext('2d');
  const pageLbl = document.getElementById('_dv-page');
  let pdf=null, page=1, zoom=1, rendering=false;

  const _cleanupFns = [];
  function cleanup(){ _cleanupFns.forEach(fn=>{ try{ fn(); }catch(e){} }); try{ if(pdf) pdf.destroy(); }catch(e){} ov.remove(); }
  document.getElementById('_dv-close').onclick = cleanup;
  ov.addEventListener('click', e=>{ if(e.target===ov) cleanup(); });

  async function render(){
    if(!pdf || rendering) return;
    rendering = true;
    try{
      const pg = await pdf.getPage(page);
      const dpr = window.devicePixelRatio || 1;
      const base = pg.getViewport({ scale:1 });
      const fit = Math.max(0.2, (scroll.clientWidth - 12) / base.width);
      const vp = pg.getViewport({ scale: fit * zoom * dpr });
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = (vp.width/dpr)+'px';
      canvas.style.height = (vp.height/dpr)+'px';
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      pageLbl.textContent = page + ' / ' + pdf.numPages;
    }catch(e){ console.warn('pdf render:', e && e.message); }
    rendering = false;
  }
  document.getElementById('_dv-prev').onclick = ()=>{ if(page>1){ page--; scroll.scrollTop=0; render(); } };
  document.getElementById('_dv-next').onclick = ()=>{ if(pdf && page<pdf.numPages){ page++; scroll.scrollTop=0; render(); } };
  document.getElementById('_dv-zin').onclick  = ()=>{ zoom = Math.min(5, zoom*1.3); render(); };
  document.getElementById('_dv-zout').onclick = ()=>{ zoom = Math.max(0.5, zoom/1.3); render(); };

  // Pinch-to-zoom + one-finger pan (iOS/touch). Smooth CSS transform during the
  // gesture, then a crisp re-render at the final scale; panning uses native scroll
  // (the scroll container is touch-action:pan-x pan-y so the browser won't also
  // page-zoom). Two-finger pinch is handled here and preventDefault'd.
  let _pDist = 0, _pZoom = 1, _pinching = false;
  const _tDist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroll.addEventListener('touchstart', e=>{
    if(e.touches.length===2){
      _pinching = true; _pDist = _tDist(e.touches) || 1; _pZoom = zoom;
      const r = canvas.getBoundingClientRect();
      canvas.style.transformOrigin =
        ((e.touches[0].clientX + e.touches[1].clientX)/2 - r.left) + 'px ' +
        ((e.touches[0].clientY + e.touches[1].clientY)/2 - r.top) + 'px';
      e.preventDefault();
    }
  }, { passive:false });
  scroll.addEventListener('touchmove', e=>{
    if(_pinching && e.touches.length===2){
      e.preventDefault();
      let ratio = _tDist(e.touches) / _pDist;
      ratio = Math.min(Math.max(ratio, 0.5/_pZoom), 5/_pZoom);   // keep final zoom in [0.5, 5]
      canvas.style.transform = 'scale(' + ratio + ')';
    }
  }, { passive:false });
  const _endPinch = ()=>{
    if(!_pinching) return;
    _pinching = false;
    const m = (canvas.style.transform.match(/scale\(([^)]+)\)/) || [])[1];
    canvas.style.transform = ''; canvas.style.transformOrigin = '';
    zoom = Math.min(5, Math.max(0.5, _pZoom * (m ? parseFloat(m) : 1)));
    render();
  };
  scroll.addEventListener('touchend', e=>{ if(_pinching && e.touches.length<2) _endPinch(); }, { passive:false });
  scroll.addEventListener('touchcancel', _endPinch, { passive:false });

  // Desktop (PWA): mouse-wheel zoom (live CSS transform for feedback, crisp
  // re-render when the wheel settles) + click-drag pan.
  let _wTimer = null, _wScale = 1;
  scroll.addEventListener('wheel', e=>{
    if(!pdf) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    _wScale = Math.min(5/zoom, Math.max(0.5/zoom, _wScale * factor));
    canvas.style.transformOrigin = 'center top';
    canvas.style.transform = 'scale(' + _wScale + ')';
    clearTimeout(_wTimer);
    _wTimer = setTimeout(()=>{
      canvas.style.transform = ''; canvas.style.transformOrigin = '';
      zoom = Math.min(5, Math.max(0.5, zoom * _wScale)); _wScale = 1;
      render();
    }, 150);
  }, { passive:false });

  let _drag = false, _dx = 0, _dy = 0, _dsl = 0, _dst = 0;
  scroll.addEventListener('mousedown', e=>{
    _drag = true; _dx = e.clientX; _dy = e.clientY; _dsl = scroll.scrollLeft; _dst = scroll.scrollTop;
    scroll.style.cursor = 'grabbing'; e.preventDefault();
  });
  const _onMove = e=>{ if(!_drag) return; scroll.scrollLeft = _dsl - (e.clientX - _dx); scroll.scrollTop = _dst - (e.clientY - _dy); };
  const _onUp   = ()=>{ if(_drag){ _drag = false; scroll.style.cursor = 'grab'; } };
  window.addEventListener('mousemove', _onMove);
  window.addEventListener('mouseup', _onUp);
  _cleanupFns.push(()=>window.removeEventListener('mousemove', _onMove));
  _cleanupFns.push(()=>window.removeEventListener('mouseup', _onUp));

  try{
    const pdfjsLib = await _loadPdfjs();
    const src = await _docSource(d);
    let params;
    if(src.blob){ params = { data: new Uint8Array(await src.blob.arrayBuffer()), ..._PDF_DOC_OPTS }; }
    else { params = { url: src.url, ..._PDF_DOC_OPTS }; }
    pdf = await pdfjsLib.getDocument(params).promise;
    const ld = document.getElementById('_dv-loading'); if(ld) ld.remove();
    await render();
  }catch(e){
    const ld = document.getElementById('_dv-loading');
    if(ld) ld.textContent = 'Could not open this PDF' + (navigator.onLine ? '' : ' (offline — pin it for offline first)') + '.';
    console.warn('pdf open:', e && e.message);
  }
}

async function _docOpenImage(d){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay gl-doc-viewer';
  ov.id = '_doc-viewer';
  ov.innerHTML = `<div class="gl-doc-vbox">
    <div class="gl-doc-vbar">
      <span class="gl-doc-vtitle">${_docIcon(d)} ${_docEsc(d.title)}</span>
      <div class="gl-doc-vctrl"><button id="_dv-close" title="Close">✕</button></div>
    </div>
    <div class="gl-doc-vscroll"><img id="_dv-img" alt="${_docEsc(d.title)}" style="max-width:100%;display:block;margin:0 auto"></div>
  </div>`;
  document.body.appendChild(ov);
  const cleanup = ()=>{ const img=document.getElementById('_dv-img'); if(img && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); ov.remove(); };
  document.getElementById('_dv-close').onclick = cleanup;
  ov.addEventListener('click', e=>{ if(e.target===ov) cleanup(); });
  const img = document.getElementById('_dv-img');
  const src = await _docSource(d);
  img.src = src.blob ? URL.createObjectURL(src.blob) : src.url;
}

// Office files: no in-app renderer in Stage 1 (locked) — open in the OS viewer.
function _docOpenExternal(d){
  if(d.downloadUrl){
    try{ window.open(d.downloadUrl, '_blank'); }
    catch(e){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Could not open this file type in-app.'); }
  }
  if(typeof showCloudBanner==='function') showCloudBanner('📄 Office files open in your device viewer — in-app reading lands in a later update.');
}

// ═══════════════════════════════════════════
// OFFLINE PIN
// ═══════════════════════════════════════════
async function docToggleOffline(id){
  const d = (window._docs||[]).find(x=>x.id===id) || (window._docsShared||[]).find(x=>x.id===id);
  if(!d) return;
  if(_docOfflineIds.has(id)){
    try{ await idbKvDel(id, _docBlobStore); }catch(e){}
    _docOfflineIds.delete(id);
    if(typeof showCloudBanner==='function') showCloudBanner('🗑 Removed offline copy.');
  } else {
    if(!d.downloadUrl){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ No file URL to download.'); return; }
    try{
      if(typeof showCloudBanner==='function') showCloudBanner('⬇ Downloading for offline…');
      const resp = await fetch(d.downloadUrl);
      const blob = await resp.blob();
      await idbKvSet(id, blob, _docBlobStore);
      _docOfflineIds.add(id);
      if(window.glHaptic && window.glHaptic.success) window.glHaptic.success();
      if(typeof showCloudBanner==='function') showCloudBanner('✓ Saved for offline.');
    }catch(e){
      if(typeof showCloudBanner==='function') showCloudBanner('⚠ Offline download failed ('+(e&&e.message||'error')+').');
      return;
    }
  }
  _docRenderLibrary();
}

// ═══════════════════════════════════════════
// SHARE  (mirror copy into the project — live reference data, like KML)
// ═══════════════════════════════════════════
async function docToggleShare(id){
  const d = (window._docs||[]).find(x=>x.id===id);
  if(!d) return;
  const pid = _docPid();
  if(!_docReady() || !pid || pid==='default'){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Sharing needs a real project.'); return; }
  const willShare = !d.shared;
  try{
    const mref = db.collection('projects').doc(pid).collection('docs').doc(id);
    if(willShare){
      const m = { id:d.id, ownerUid: d.ownerUid, projectId: pid, title: d.title,
        type: d.type, ext: d.ext, storagePath: d.storagePath, downloadUrl: d.downloadUrl,
        folder: d.folder||'Unfiled', size: d.size||0, shared:true, createdAt: d.createdAt||Date.now(), updatedAt: Date.now() };
      await mref.set(m);
    } else {
      await mref.delete();
    }
    d.shared = willShare; d.updatedAt = Date.now();
    await _udb().collection('docs').doc(id).set({ shared: willShare, updatedAt: d.updatedAt }, { merge:true });
    try{ window.idbSet && window.idbSet('gl_docs::'+pid, JSON.stringify(window._docs)); }catch(e){}
    if(window.glHaptic && window.glHaptic.light) window.glHaptic.light();
    if(typeof showCloudBanner==='function') showCloudBanner(willShare?'🤝 Shared with the project.':'Stopped sharing with the project.');
  }catch(e){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Share failed ('+(e&&e.message||'error')+').'); }
  _docRenderLibrary();
}

async function _docLoadShared(pid){
  window._docsShared = [];
  if(!_docReady() || !pid || pid==='default') return;
  try{
    const snap = await db.collection('projects').doc(pid).collection('docs').get();
    const mine = window._currentUser.uid;
    snap.forEach(s => { const m = s.data(); if(m.ownerUid !== mine) window._docsShared.push(m); });
  }catch(e){ /* not a member / nothing shared */ }
  _docRenderSharedBody();
}

// Fills the Shared-by-teammates CARD body (its own section, card #3).
function _docRenderSharedBody(){
  const box = document.getElementById('doc-shared-body');
  if(!box) return;
  const shared = (window._docsShared||[]);
  const cnt = document.getElementById('doc-shared-count');
  if(cnt) cnt.textContent = shared.length;
  box.innerHTML = shared.length
    ? shared.map(_docSharedRow).join('')
    : '<div class="gl-doc-empty-line">Plans your teammates share to this project show up here. Your own shared docs stay in your folders above with a 🤝 tag.</div>';
}
function _docSharedRow(d){
  const pinned = _docOfflineIds.has(d.id);
  const meta = [d.ext ? d.ext.toUpperCase() : '', _docFmtSize(d.size)].filter(Boolean).join(' · ');
  return `
    <div class="gl-doc-row">
      <span class="gl-doc-icon" onclick="docOpen('${d.id}')">${_docIcon(d)}</span>
      <div class="gl-doc-info" onclick="docOpen('${d.id}')">
        <div class="gl-doc-title">${_docEsc(d.title)}</div>
        <div class="gl-doc-meta">${_docEsc(meta)}${pinned?' · <span class="gl-doc-offline-tag">⬇ offline</span>':''}</div>
      </div>
      <div class="gl-doc-actions">
        <button class="gl-doc-btn" title="Actions" onclick="docMenu('${d.id}')">⋯</button>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════
// PER-DOC MENU  (open / offline / share / rename / move / AI / delete)
// ═══════════════════════════════════════════
// One menu for own + teammates' shared docs — keeps rows to a single ⋯ button.
// Open/Offline/Share live here now (used to be always-present row buttons).
function docMenu(id){
  let d = (window._docs||[]).find(x=>x.id===id);
  const own = !!d;
  if(!d) d = (window._docsShared||[]).find(x=>x.id===id);
  if(!d) return;
  const pinned = _docOfflineIds.has(id);
  let items = `
      <button onclick="_docCloseMenu();docOpen('${id}')">📖 Open</button>
      <button onclick="_docCloseMenu();docToggleOffline('${id}')">${pinned?'✓ Remove offline copy':'⬇ Download for offline'}</button>`;
  if(own){
    items += `
      <button onclick="_docCloseMenu();docToggleShare('${id}')">${d.shared?'🤝 Stop sharing with project':'🤝 Share with project'}</button>
      <button onclick="docRename('${id}')">✏️ Rename</button>
      <button onclick="docMove('${id}')">📂 Move to folder</button>
      <button onclick="_docToggleAiFromMenu('${id}')">${d.aiAccessOptIn?'🔒 Turn OFF AI access':'🤖 Allow AI access'}</button>
      <button class="gl-doc-menu-danger" onclick="docDelete('${id}')">🗑 Delete</button>`;
  }
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_doc-menu';
  ov.innerHTML = `<div class="modal-box" style="max-width:340px">
    <div class="modal-title">${_docIcon(d)} ${_docEsc(d.title)}</div>
    <div class="gl-doc-menu-list">${items}</div>
    <div class="modal-btns"><button class="modal-cancel" onclick="document.getElementById('_doc-menu').remove()">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
}
function _docCloseMenu(){ const m=document.getElementById('_doc-menu'); if(m) m.remove(); }
function _docToggleAiFromMenu(id){ const d=(window._docs||[]).find(x=>x.id===id); if(d){ _docSetAi(id, !d.aiAccessOptIn); } _docCloseMenu(); }

function docRename(id){
  const d = (window._docs||[]).find(x=>x.id===id); if(!d) return;
  _docCloseMenu();
  _docPrompt('Rename document', d.title, 'Save', async (val)=>{
    val = (val||'').trim(); if(!val) return;
    d.title = val; d.updatedAt = Date.now();
    try{ await _udb().collection('docs').doc(id).set({ title: val, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
    if(d.shared){ try{ await db.collection('projects').doc(_docPid()).collection('docs').doc(id).set({ title: val, updatedAt: d.updatedAt }, { merge:true }); }catch(e){} }
    try{ window.idbSet && window.idbSet('gl_docs::'+_docPid(), JSON.stringify(window._docs)); }catch(e){}
    _docRenderLibrary();
  });
}
function docMove(id){
  const d = (window._docs||[]).find(x=>x.id===id); if(!d) return;
  _docCloseMenu();
  _docPrompt('Move to folder', d.folder||'Unfiled', 'Move', async (val)=>{
    val = (val||'').trim() || 'Unfiled';
    d.folder = val; d.updatedAt = Date.now();
    try{ await _udb().collection('docs').doc(id).set({ folder: val, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
    if(d.shared){ try{ await db.collection('projects').doc(_docPid()).collection('docs').doc(id).set({ folder: val, updatedAt: d.updatedAt }, { merge:true }); }catch(e){} }
    try{ window.idbSet && window.idbSet('gl_docs::'+_docPid(), JSON.stringify(window._docs)); }catch(e){}
    _docRenderLibrary();
  });
}
function docDelete(id){
  const d = (window._docs||[]).find(x=>x.id===id); if(!d) return;
  _docCloseMenu();
  const doDelete = async ()=>{
    const pid = _docPid();
    try{ await _udb().collection('docs').doc(id).delete(); }catch(e){}
    if(d.shared){ try{ await db.collection('projects').doc(pid).collection('docs').doc(id).delete(); }catch(e){} }
    try{ if(d.storagePath) await storage.ref(d.storagePath).delete(); }catch(e){}
    try{ await idbKvDel(id, _docBlobStore); }catch(e){}
    _docOfflineIds.delete(id);
    window._docs = (window._docs||[]).filter(x=>x.id!==id);
    try{ window.idbSet && window.idbSet('gl_docs::'+pid, JSON.stringify(window._docs)); }catch(e){}
    if(typeof showCloudBanner==='function') showCloudBanner('🗑 Document deleted.');
    _docRenderLibrary();
  };
  if(typeof _confirmModal==='function') _confirmModal('Delete "'+_docEsc(d.title)+'"? This removes it from the cloud, the project share, and your offline copy. This cannot be undone.', doDelete, '🗑 Delete document', 'Delete');
  else if(confirm('Delete this document?')) doDelete();
}

// ── Tiny prompt modal (no native prompt() on iOS PWA) ──
function _docPrompt(title, value, okLabel, onOk){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-box" style="max-width:360px">
    <div class="modal-title">${_docEsc(title)}</div>
    <input id="_docprompt-in" class="gl-doc-prompt-in" type="text" value="${_docEsc(value)}" autocomplete="off">
    <div class="modal-btns">
      <button class="modal-cancel" id="_docprompt-x">Cancel</button>
      <button class="modal-confirm" id="_docprompt-ok">${_docEsc(okLabel||'OK')}</button>
    </div></div>`;
  document.body.appendChild(ov);
  const input = document.getElementById('_docprompt-in');
  setTimeout(()=>{ try{ input.focus(); input.select(); }catch(e){} }, 50);
  const close = ()=> ov.remove();
  document.getElementById('_docprompt-x').onclick = close;
  document.getElementById('_docprompt-ok').onclick = ()=>{ const v=input.value; close(); if(typeof onOk==='function') onOk(v); };
  input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const v=input.value; close(); if(typeof onOk==='function') onOk(v); } });
}

// ── Privacy: purge pinned offline blobs on account switch / sign-out ──
// The uid-fence's idbClearAll() only clears idb-keyval's DEFAULT store; our
// pinned doc blobs live in a separate store, so they must be purged here too or
// they'd be cross-account residue (the f73334d incident's failure mode).
window._docsPurgeOffline = function(){
  _docOfflineIds = new Set();
  try { return idbKvClear(_docBlobStore); } catch(e){ return Promise.resolve(); }
};

// ── Window exposure (inline onclick handlers) ──
window.glRenderDocsPage = glRenderDocsPage;
window.docSearch = docSearch;
window.docPickFiles = docPickFiles;
window.docHandleFiles = docHandleFiles;
window.docOpen = docOpen;
window.docToggleOffline = docToggleOffline;
window.docToggleShare = docToggleShare;
window.docToggleFolder = docToggleFolder;
window.docNewFolder = docNewFolder;
window.docMenu = docMenu;
window._docCloseMenu = _docCloseMenu;
window.docRename = docRename;
window.docMove = docMove;
window.docDelete = docDelete;
window._docToggleAiFromMenu = _docToggleAiFromMenu;
