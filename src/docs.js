// ═══════════════════════════════════════════
// DOCUMENTS LIBRARY  (Stage 1 MVP + foundation hardening)
// ═══════════════════════════════════════════
// Design-of-record: KB documents-library-plan.md (locked 2026-06-20).
//
// What this is: upload plans / permits / drawings / specs once, read them IN-APP
// (no more share→Books→rename dance), organize in real folders (incl. subfolders),
// pin for offline field reading, and share project plans with collaborators. Built
// on the same trust model as photos/KML — file in Firebase Storage, metadata in
// Firestore, the persisted downloadURL is the share capability.
//
// CCUSF: this is the foundation of a Procore-grade document library, but ours ties
// documents to the live map (Stage 4, fields reserved below) and travels with the
// user across firms. Links use BRAND teal, never Procore blue.
//
// ── Data model (record shape carries all 4 stages — no migration later) ──
//   users/{uid}/docs/{docId}            own copy (private by default)
//   users/{uid}/docFolders/{folderId}   own folder tree (private organization)
//   projects/{pid}/docs/{docId}         mirror copy when shared (live reference data)
//   doc:    { id, ownerUid, projectId, title, type:'pdf'|'img'|'office', ext,
//             storagePath, downloadUrl, folderId, folder(name), size,
//             createdAt, updatedAt, aiAccessOptIn:false, offline(local-only), shared,
//             // RESERVED (Stages 2-4): sheetNumber, sheetTitle, revision,
//             // supersedesId, links[], geo{} }
//   folder: { id, ownerUid, projectId, name, parentId|null, createdAt, updatedAt }
//
// Folders are an OWNER-PRIVATE organization layer over your own docs. Shared docs
// appear flat in the "Shared by teammates" card — folder structure does not cross
// the share boundary (the owner's tree is theirs).
//
// ── Offline (the deliberate per-doc pin) ──
// Pinned file BLOBS live in their OWN idb-keyval store (groundlog-docs/blobs), NOT
// the shared idbCache — idbCache hydrates its whole store into memory on every
// boot, and a pinned 50 MB plan set must never load into RAM at launch. Un-pinned
// docs stream from Storage on demand.
//
// ── Viewer (#18 fix) ──
// The PDF viewer is VIRTUALIZED continuous-scroll with a hard CAP on canvas pixel
// area. The old single-canvas viewer sized the canvas base×fit×zoom×dpr with no
// limit; a large sheet at high zoom hit ~300M px ≈ 1 GB and the iOS WKWebView ran
// out of memory and RELOADED ("the app just re-opened" symptom). Now: only pages
// near the viewport hold a canvas, each capped to _MAX_CANVAS_PX, dpr clamped, and
// off-screen canvases are released. Memory stays bounded no matter the doc size.

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { get as idbKvGet, set as idbKvSet, del as idbKvDel, keys as idbKvKeys, clear as idbKvClear, createStore } from 'idb-keyval'

// pdfjs is heavy (~1.2 MB). Lazy-load it only when a PDF is actually opened so it
// stays OUT of the main bundle.
let _pdfjs = null;
async function _loadPdfjs(){
  if(!_pdfjs){
    _pdfjs = await import('pdfjs-dist');
    _pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  return _pdfjs;
}

// Auxiliary asset dirs (copied to dist/pdfjs/ by vite-plugin-static-copy).
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
window._docFoldersList = window._docFoldersList || []; // own folder records (active project)
let _docFolderOpen = {};                          // folderId -> expanded bool ('__unfiled__' for unfiled)
let _docOfflineIds = new Set();                   // ids with a pinned blob present
let _docUploadFolderId = null;                    // folderId target for the next upload (null = Unfiled)
let _docQuery = '';                               // library search text

const _DOC_CARDS_KEY = 'pei_doc_cards';           // collapsed top-level cards (#16)
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
// Professional file-type badge (inline SVG — a document glyph with a folded
// corner and a colored type label), instead of emoji. Scales crisply, on-brand,
// no asset files. Used in rows, modal titles, and the viewer title bar.
function _docBadgeFor(d){
  if(d.type==='pdf') return { c:'#E5484D', t:'PDF' };
  if(d.type==='img') return { c:'#2A9BA6', t:(d.ext||'IMG').toUpperCase().slice(0,4) };
  if(['xls','xlsx'].indexOf(d.ext)>=0) return { c:'#1E9E5A', t:'XLS' };
  if(d.ext==='csv') return { c:'#1E9E5A', t:'CSV' };
  if(['doc','docx','rtf','txt'].indexOf(d.ext)>=0) return { c:'#2F6BD8', t:(d.ext||'DOC').toUpperCase().slice(0,4) };
  if(['ppt','pptx'].indexOf(d.ext)>=0) return { c:'#E07820', t:'PPT' };
  return { c:'#7A7F8A', t:(d.ext||'FILE').toUpperCase().slice(0,4) };
}
function _docIcon(d){
  const b = _docBadgeFor(d);
  const lbl = _docEsc(b.t);
  const fs = lbl.length >= 4 ? 5 : 6.5;
  return `<svg class="gl-doc-fileicon" viewBox="0 0 28 32" width="23" height="26" aria-hidden="true">`
    + `<path d="M5 2h12l6 6v20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill="#fcfcfc" stroke="#c9cdd6" stroke-width="1.3"/>`
    + `<path d="M17 2v6h6" fill="none" stroke="#c9cdd6" stroke-width="1.3" stroke-linejoin="round"/>`
    + `<rect x="2.5" y="16.5" width="17" height="9.5" rx="2" fill="${b.c}"/>`
    + `<text x="11" y="23.6" font-size="${fs}" font-weight="700" letter-spacing="0.2" text-anchor="middle" fill="#fff" font-family="Arial,Helvetica,sans-serif">${lbl}</text>`
    + `</svg>`;
}
function _docFmtSize(n){
  if(!n) return '';
  if(n < 1024) return n+' B';
  if(n < 1048576) return (n/1024).toFixed(0)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}

function _docCacheDocs(){ try{ window.idbSet && window.idbSet('gl_docs::'+_docPid(), JSON.stringify(window._docs)); }catch(e){} }
function _docCacheFolders(){ try{ window.idbSet && window.idbSet('gl_docfolders::'+_docPid(), JSON.stringify(window._docFoldersList)); }catch(e){} }

// ── Collapsed top-level cards (#16) ──
function _docGetCards(){ try{ return JSON.parse(localStorage.getItem(_DOC_CARDS_KEY)||'[]'); }catch(e){ return []; } }
function _docSaveCards(arr){ try{ localStorage.setItem(_DOC_CARDS_KEY, JSON.stringify(arr)); }catch(e){} }
function docToggleCard(key){
  const el = document.getElementById('doc-card-'+key);
  const collapsed = _docGetCards();
  const i = collapsed.indexOf(key);
  if(el && el.classList.contains('collapsed')){ el.classList.remove('collapsed'); if(i>-1) collapsed.splice(i,1); }
  else { if(el) el.classList.add('collapsed'); if(i<0) collapsed.push(key); }
  _docSaveCards(collapsed);
}

// ── Folder helpers ──
function _docFolderById(id){ return (window._docFoldersList||[]).find(f=>f.id===id) || null; }
function _docChildFolders(parentId){
  return (window._docFoldersList||[]).filter(f => (f.parentId||null)===(parentId||null))
    .sort((a,b)=> String(a.name).localeCompare(String(b.name)));
}
function _docFolderName(id){ const f=_docFolderById(id); return f ? f.name : 'Unfiled'; }

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
async function glRenderDocsPage(){
  if(!document.getElementById('docs-root')) return;
  const pid = _docPid();

  // 1. Instant paint from cache (offline-capable).
  try{
    if(window.idbReady) await window.idbReady;
    const cd = (typeof window.idbGet==='function') ? window.idbGet('gl_docs::'+pid) : null;
    if(cd){ window._docs = JSON.parse(cd) || []; }
    const cf = (typeof window.idbGet==='function') ? window.idbGet('gl_docfolders::'+pid) : null;
    if(cf){ window._docFoldersList = JSON.parse(cf) || []; }
  }catch(e){ /* cache miss is fine */ }
  await _docRefreshOfflineSet();
  _docRenderLibrary();

  // 2. Refresh from cloud.
  if(_docReady() && pid && pid !== 'default'){
    try{
      const fsnap = await _udb().collection('docFolders').where('projectId','==',pid).get();
      const flist = []; fsnap.forEach(f => flist.push(f.data()));
      window._docFoldersList = flist;
      _docCacheFolders();
    }catch(e){ console.warn('docFolders load:', e && e.message); }
    try{
      const snap = await _udb().collection('docs').where('projectId','==',pid).get();
      const list = []; snap.forEach(d => list.push(d.data()));
      window._docs = list;
      await _docMigrateFolders();   // old folder-name string → folderId (one-time, idempotent)
      _docCacheDocs();
      _docRenderLibrary();
    }catch(e){ console.warn('docLoad:', e && e.message); }
    _docLoadShared(pid);
  }
}

// One-time migration: Stage-1 docs stored a folder NAME string and no folderId.
// Promote each named folder to a real folder record and set the doc's folderId.
// Idempotent — once folderId is set + persisted, later loads skip the doc.
async function _docMigrateFolders(){
  const pid = _docPid();
  let changed = false;
  for(const d of (window._docs||[])){
    if(d.folderId === undefined){   // never migrated; null = already normalized to Unfiled
      const nm = (d.folder||'').trim();
      if(nm && nm.toLowerCase() !== 'unfiled'){
        let f = (window._docFoldersList||[]).find(x => (x.parentId==null) && x.name===nm);
        if(!f) f = await _docCreateFolder(nm, null);
        d.folderId = f.id;
      } else {
        d.folderId = null;
      }
      d.updatedAt = Date.now();
      changed = true;
      try{ await _udb().collection('docs').doc(d.id).set({ folderId: d.folderId, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
    }
  }
  if(changed) _docCacheDocs();
}

// Full render: THREE collapsible cards.
//   1. 📁 Documents — upload & organize (stats, drop-zone, new folder)
//   2. 📚 Library   — searchable nested folder tree of your own docs
//   3. 👥 Shared by teammates — incoming shared docs (flat)
function _docRenderLibrary(){
  const root = document.getElementById('docs-root');
  if(!root) return;
  const nDocs = (window._docs||[]).length;
  const nFolders = (window._docFoldersList||[]).length;
  const cc = _docGetCards();
  const isC = k => cc.includes(k) ? ' collapsed' : '';

  root.innerHTML = `
    <div class="card gl-doc-card${isC('documents')}" id="doc-card-documents">
      <div class="card-head gl-doc-head" onclick="docToggleCard('documents')">
        <span class="card-num">📁</span><span class="card-title">Documents</span><span class="card-chevron">▾</span>
      </div>
      <div class="card-body">
        <div class="gl-doc-stats">
          <div class="gl-doc-stat"><span class="gl-doc-stat-num">${nDocs}</span><span class="gl-doc-stat-lbl">Documents</span></div>
          <div class="gl-doc-stat"><span class="gl-doc-stat-num">${nFolders}</span><span class="gl-doc-stat-lbl">${nFolders===1?'Folder':'Folders'}</span></div>
        </div>
        <div class="gl-doc-drop" id="doc-drop"
          ondragover="event.preventDefault();this.classList.add('drag')"
          ondragleave="this.classList.remove('drag')"
          ondrop="event.preventDefault();this.classList.remove('drag');docDropRoot(event.dataTransfer.files)"
          onclick="docPickRoot()">
          <div class="gl-doc-drop-icon">📄</div>
          <div class="gl-doc-drop-txt">Tap to upload or drop documents here</div>
          <div class="gl-doc-drop-sub">PDFs, images, plans &amp; specs</div>
        </div>
        <div class="gl-doc-uploadrow"><button class="gl-doc-newfolder" onclick="docNewFolder()">＋ New folder</button></div>
        <input type="file" id="doc-file-input" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.rtf" style="display:none" onchange="docHandleFiles(this.files)">
        <div id="doc-upload-prog" class="gl-doc-prog" style="display:none"><div id="doc-upload-prog-bar" class="gl-doc-prog-bar"></div><div id="doc-upload-prog-txt" class="gl-doc-prog-txt"></div></div>
      </div>
    </div>

    <div class="card gl-doc-card${isC('library')}" id="doc-card-library">
      <div class="card-head gl-doc-head" onclick="docToggleCard('library')">
        <span class="card-num">📚</span><span class="card-title">Library</span><span class="card-chevron">▾</span>
      </div>
      <div class="card-body">
        <input id="doc-search" class="gl-doc-search" type="text" placeholder="Search documents…" value="${_docEsc(_docQuery)}" oninput="docSearch(this.value)" autocomplete="off">
        <div id="doc-list"></div>
      </div>
    </div>

    <div class="card gl-doc-card${isC('shared')}" id="doc-card-shared">
      <div class="card-head gl-doc-head" onclick="docToggleCard('shared')">
        <span class="card-num">👥</span><span class="card-title">Shared by teammates</span><span class="card-badge" id="doc-shared-count">0</span><span class="card-chevron">▾</span>
      </div>
      <div class="card-body" id="doc-shared-body"></div>
    </div>`;
  _docRenderList();
  _docRenderSharedBody();
}

// Renders ONLY the Library tree into #doc-list — leaves the search input + cards
// untouched so search never loses focus.
function _docRenderList(){
  const box = document.getElementById('doc-list');
  if(!box) return;
  const q = (_docQuery||'').trim().toLowerCase();
  const allDocs = (window._docs||[]).slice().sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));

  // Search: flat result list across every folder.
  if(q){
    const hits = allDocs.filter(d => (d.title||'').toLowerCase().includes(q) || _docFolderName(d.folderId).toLowerCase().includes(q));
    box.innerHTML = `<div class="gl-doc-results">${hits.length} result${hits.length===1?'':'s'} for “${_docEsc(_docQuery.trim())}”</div>`
      + (hits.length ? hits.map(_docRow).join('') : '<div class="gl-doc-empty-line">No documents match your search.</div>');
    return;
  }

  if(!allDocs.length && !(window._docFoldersList||[]).length){
    box.innerHTML = '<div class="gl-doc-empty-line">No documents yet — upload your first plan set above, or make a folder.</div>';
    return;
  }

  let html = '';
  _docChildFolders(null).forEach(f => html += _docFolderHtml(f, 0));

  // Unfiled docs (no folderId) get their own pseudo-folder at the bottom.
  const unfiled = allDocs.filter(d => !d.folderId);
  if(unfiled.length){
    const open = _docFolderOpen['__unfiled__'] !== false;
    html += `
      <div class="gl-doc-folder">
        <div class="gl-doc-folder-head" style="padding-left:6px" onclick="docToggleFolder('__unfiled__')">
          <span class="gl-doc-chev">${open?'▾':'▸'}</span>
          <span class="gl-doc-folder-name">🗂 Unfiled</span>
          <span class="gl-doc-folder-count">${unfiled.length}</span>
        </div>
        ${open ? `<div class="gl-doc-folder-body">${unfiled.map(_docRow).join('')}</div>` : ''}
      </div>`;
  }

  box.innerHTML = html || '<div class="gl-doc-empty-line">No documents yet — upload your first plan set above.</div>';
}

// Recursive folder node: child folders first, then its docs. Indented by depth.
function _docFolderHtml(f, depth){
  const open = _docFolderOpen[f.id] !== false; // default expanded
  const kids = _docChildFolders(f.id);
  const docs = (window._docs||[]).filter(d => d.folderId===f.id).sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
  const count = kids.length + docs.length;
  const pad = 6 + depth*16;
  let inner = '';
  if(open){
    inner = `<div class="gl-doc-folder-body">`
      + kids.map(k => _docFolderHtml(k, depth+1)).join('')
      + docs.map(_docRow).join('')
      + (count===0 ? `<div class="gl-doc-empty-line" style="text-align:left;padding-left:${pad+18}px">Empty — upload here (⋯) or move documents in.</div>` : '')
      + `</div>`;
  }
  return `
    <div class="gl-doc-folder">
      <div class="gl-doc-folder-head" style="padding-left:${pad}px" onclick="docToggleFolder('${f.id}')">
        <span class="gl-doc-chev">${open?'▾':'▸'}</span>
        <span class="gl-doc-folder-name">📂 ${_docEsc(f.name)}</span>
        <span class="gl-doc-folder-count">${count}</span>
        <button class="gl-doc-folder-menu" title="Folder actions" onclick="event.stopPropagation();docFolderMenu('${f.id}')">⋯</button>
      </div>
      ${inner}
    </div>`;
}

function docSearch(q){ _docQuery = q || ''; _docRenderList(); }

function _docRow(d){
  const pinned = _docOfflineIds.has(d.id);
  const meta = [d.ext ? d.ext.toUpperCase() : '', _docFmtSize(d.size)].filter(Boolean).join(' · ');
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

async function _docCreateFolder(name, parentId){
  const pid = _docPid();
  const id = _docGenId();
  const rec = { id, ownerUid: window._currentUser.uid, projectId: pid, name: String(name).trim(),
    parentId: parentId || null, createdAt: Date.now(), updatedAt: Date.now() };
  window._docFoldersList.push(rec);
  try{ await _udb().collection('docFolders').doc(id).set(rec); }catch(e){ console.warn('createFolder:', e && e.message); }
  _docCacheFolders();
  return rec;
}

// Create an EMPTY top-level folder — no forced upload (the old behaviour that made
// "create folder" feel broken). The folder persists immediately and is ready to
// upload into or move docs into.
function docNewFolder(parentId){
  if(!_docReady() || !_docPid() || _docPid()==='default'){
    if(typeof showCloudBanner==='function') showCloudBanner('⚠ Open or create a real project first — folders live under a project.');
    return;
  }
  _docPrompt(parentId? 'New subfolder' : 'New folder', '', 'Create', async (name)=>{
    name = (name||'').trim();
    if(!name) return;
    await _docCreateFolder(name, parentId||null);
    if(parentId) _docFolderOpen[parentId] = true; // reveal the new child
    if(window.glHaptic && window.glHaptic.light) window.glHaptic.light();
    _docRenderLibrary();
  });
}

function docFolderMenu(id){
  const f = _docFolderById(id); if(!f) return;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_doc-fmenu';
  ov.innerHTML = `<div class="modal-box" style="max-width:340px">
    <div class="modal-title">📂 ${_docEsc(f.name)}</div>
    <div class="gl-doc-menu-list">
      <button onclick="_docFolderCloseMenu();docUploadToFolder('${id}')">⬆ Upload into this folder</button>
      <button onclick="_docFolderCloseMenu();docNewFolder('${id}')">📁 New subfolder</button>
      <button onclick="_docFolderCloseMenu();docRenameFolder('${id}')">✏️ Rename folder</button>
      <button class="gl-doc-menu-danger" onclick="_docFolderCloseMenu();docDeleteFolder('${id}')">🗑 Delete folder</button>
    </div>
    <div class="modal-btns"><button class="modal-cancel" onclick="_docFolderCloseMenu()">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
}
function _docFolderCloseMenu(){ const m=document.getElementById('_doc-fmenu'); if(m) m.remove(); }

function docUploadToFolder(id){ _docUploadFolderId = id || null; docPickFiles(); }

function docRenameFolder(id){
  const f = _docFolderById(id); if(!f) return;
  _docPrompt('Rename folder', f.name, 'Save', async (val)=>{
    val = (val||'').trim(); if(!val) return;
    f.name = val; f.updatedAt = Date.now();
    try{ await _udb().collection('docFolders').doc(id).set({ name: val, updatedAt: f.updatedAt }, { merge:true }); }catch(e){}
    // Keep shared mirrors' folder-name string in sync for any shared docs in here.
    const pid = _docPid();
    for(const d of (window._docs||[]).filter(x=>x.folderId===id && x.shared)){
      d.folder = val;
      try{ await db.collection('projects').doc(pid).collection('docs').doc(d.id).set({ folder: val, updatedAt: Date.now() }, { merge:true }); }catch(e){}
    }
    _docCacheFolders(); _docCacheDocs();
    _docRenderLibrary();
  });
}

// Delete a folder WITHOUT losing anything: child folders + docs are reparented to
// this folder's parent (or Unfiled if it was top-level), then the record is removed.
function docDeleteFolder(id){
  const f = _docFolderById(id); if(!f) return;
  const parentId = f.parentId || null;
  const doDelete = async ()=>{
    const pid = _docPid();
    // reparent child folders
    for(const c of (window._docFoldersList||[]).filter(x=>(x.parentId||null)===id)){
      c.parentId = parentId; c.updatedAt = Date.now();
      try{ await _udb().collection('docFolders').doc(c.id).set({ parentId: parentId, updatedAt: c.updatedAt }, { merge:true }); }catch(e){}
    }
    // move docs up to the parent
    const newName = parentId ? _docFolderName(parentId) : 'Unfiled';
    for(const d of (window._docs||[]).filter(x=>x.folderId===id)){
      d.folderId = parentId; d.folder = newName; d.updatedAt = Date.now();
      try{ await _udb().collection('docs').doc(d.id).set({ folderId: parentId, folder: newName, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
      if(d.shared){ try{ await db.collection('projects').doc(pid).collection('docs').doc(d.id).set({ folder: newName, updatedAt: d.updatedAt }, { merge:true }); }catch(e){} }
    }
    window._docFoldersList = (window._docFoldersList||[]).filter(x=>x.id!==id);
    try{ await _udb().collection('docFolders').doc(id).delete(); }catch(e){}
    _docCacheFolders(); _docCacheDocs();
    if(typeof showCloudBanner==='function') showCloudBanner('🗑 Folder deleted — its documents moved to '+(parentId?('“'+newName+'”'):'Unfiled')+'.');
    _docRenderLibrary();
  };
  const msg = 'Delete the folder "'+_docEsc(f.name)+'"? Its documents and any subfolders are kept — they move up to '+(parentId?('“'+_docEsc(newNameOf(parentId))+'”'):'Unfiled')+'. Nothing is deleted.';
  if(typeof _confirmModal==='function') _confirmModal(msg, doDelete, '🗑 Delete folder', 'Delete');
  else if(confirm('Delete this folder? Documents are kept and moved up.')) doDelete();
}
function newNameOf(pid){ return pid ? _docFolderName(pid) : 'Unfiled'; }

// ═══════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════
function docPickFiles(){ const el = document.getElementById('doc-file-input'); if(el) el.click(); }
// Root uploader (the drop zone) always targets the current top level, never a
// stale folder left over from a cancelled "upload into folder" dialog.
function docPickRoot(){ _docUploadFolderId = null; docPickFiles(); }
function docDropRoot(files){ _docUploadFolderId = null; docHandleFiles(files); }

async function docHandleFiles(fileList){
  const files = Array.from(fileList || []);
  // capture + clear the folder target immediately (a stray later pick shouldn't inherit it)
  const targetFolderId = _docUploadFolderId; _docUploadFolderId = null;
  if(!files.length) return;
  if(!_docReady()){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Sign in and pick a project before uploading documents.'); return; }
  const pid = _docPid();
  if(!pid || pid === 'default'){ if(typeof showCloudBanner==='function') showCloudBanner('⚠ Open or create a real project first — documents are filed under a project.'); return; }

  const folderId = targetFolderId && _docFolderById(targetFolderId) ? targetFolderId : null;
  const folderName = folderId ? _docFolderName(folderId) : 'Unfiled';

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
        storagePath, downloadUrl, folderId, folder: folderName,
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

  if(folderId) _docFolderOpen[folderId] = true;
  _docCacheDocs();
  if(window.glHaptic) window.glHaptic.success && window.glHaptic.success();
  _docRenderLibrary();

  // AI access opt-in (locked 2026-05-12: per-document, DEFAULT OFF).
  if(newIds.length) _docShowAiOptIn(newIds);
}

// ── AI access opt-in modal ──
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
  document.getElementById('_docai-later').onclick = close;
  document.getElementById('_docai-no').onclick = close;
  document.getElementById('_docai-yes').onclick = ()=>{ ids.forEach(id => _docSetAi(id, true)); close(); };
}

async function _docSetAi(id, on){
  const d = (window._docs||[]).find(x=>x.id===id);
  if(!d) return;
  d.aiAccessOptIn = !!on; d.updatedAt = Date.now();
  try{ await _udb().collection('docs').doc(id).set({ aiAccessOptIn: d.aiAccessOptIn, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
  _docCacheDocs();
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

// ── Virtualized continuous-scroll PDF viewer (#18) ──
// Memory-bounded: each page gets a placeholder sized from its real dimensions; only
// pages within RENDER_MARGIN of the viewport hold a live canvas, each capped to
// _MAX_CANVAS_PX. Pages beyond KEEP_MARGIN release their canvas. dpr clamped to 2.
const _MAX_CANVAS_PX = 6_000_000;  // ~24 MB per canvas worst case; a few alive = safe
const _PAGE_GAP = 10;              // px between pages (must match CSS .gl-doc-vpages gap)
const _PAGE_PAD = 8;               // top padding of #_dv-pages (must match CSS)
async function _docOpenPdf(d){
  const ov = document.createElement('div');
  ov.className = 'modal-overlay gl-doc-viewer';
  ov.id = '_doc-viewer';
  ov.innerHTML = `<div class="gl-doc-vbox">
    <div class="gl-doc-vbar">
      <span class="gl-doc-vtitle">${_docIcon(d)} ${_docEsc(d.title)}</span>
      <div class="gl-doc-vctrl">
        <span id="_dv-page" class="gl-doc-vpage">…</span>
        <button id="_dv-zout" title="Zoom out">−</button>
        <button id="_dv-zin" title="Zoom in">＋</button>
        <button id="_dv-close" title="Close">✕</button>
      </div>
    </div>
    <div class="gl-doc-vscroll" id="_dv-scroll"><div id="_dv-pages" class="gl-doc-vpages"></div></div>
    <div id="_dv-loading" class="gl-doc-vloading">Loading…</div>
  </div>`;
  document.body.appendChild(ov);
  const scroll = document.getElementById('_dv-scroll');
  const pagesEl = document.getElementById('_dv-pages');
  const pageLbl = document.getElementById('_dv-page');
  let pdf = null, zoom = 1, numPages = 0;
  const pages = [];   // { index, baseW, baseH, wrap, canvas, top, w, h, rendered, rendering, task }

  const _cleanupFns = [];
  let _alive = true;
  function cleanup(){
    _alive = false;
    _cleanupFns.forEach(fn=>{ try{ fn(); }catch(e){} });
    pages.forEach(p=>{ if(p.task){ try{ p.task.cancel(); }catch(e){} } });
    try{ if(pdf) pdf.destroy(); }catch(e){}
    ov.remove();
  }
  document.getElementById('_dv-close').onclick = cleanup;

  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const containerW = ()=> Math.max(120, scroll.clientWidth - (_PAGE_PAD*2));
  const cssScaleFor = m => (containerW() / m.baseW) * zoom;

  function layout(){
    let y = _PAGE_PAD;
    pages.forEach(m=>{
      const cssScale = cssScaleFor(m);
      m.w = Math.round(m.baseW * cssScale);
      m.h = Math.round(m.baseH * cssScale);
      m.top = y;
      if(m.wrap){ m.wrap.style.width = m.w+'px'; m.wrap.style.height = m.h+'px'; }
      y += m.h + _PAGE_GAP;
    });
  }

  function releaseCanvas(m){
    if(m.task){ try{ m.task.cancel(); }catch(e){} m.task = null; }
    m.rendering = false; m.rendered = false; m.renderedZoom = undefined;
    if(m.wrap) m.wrap.classList.remove('rendered');
    if(m.canvas){ m.canvas.width = 0; m.canvas.height = 0; }
  }

  async function renderPage(m){
    if(!pdf || !_alive || m.rendering) return;
    if(m.rendered && m.renderedZoom === zoom) return;   // already crisp at this zoom
    m.rendering = true;
    const renderZoom = zoom;
    try{
      const pg = await pdf.getPage(m.index+1);
      if(!_alive){ m.rendering = false; return; }
      // Correct the placeholder if this page's real size differs from the estimate.
      const base = pg.getViewport({ scale:1 });
      if(Math.abs(base.width - m.baseW) > 1 || Math.abs(base.height - m.baseH) > 1){
        m.baseW = base.width; m.baseH = base.height; layout();
      }
      const cssScale = (containerW() / m.baseW) * renderZoom;
      let renderScale = cssScale * DPR;
      const px = (m.baseW*renderScale) * (m.baseH*renderScale);
      if(px > _MAX_CANVAS_PX) renderScale *= Math.sqrt(_MAX_CANVAS_PX/px);
      const vp = pg.getViewport({ scale: renderScale });
      // Render into a FRESH canvas so the currently-displayed one stays visible
      // (CSS-scaled to the new wrapper size = instant zoom) until the crisp render
      // is ready, then swap. This kills the white flash on zoom — we never blank a
      // page that's already showing something.
      const nc = document.createElement('canvas');
      nc.width = Math.floor(vp.width); nc.height = Math.floor(vp.height);
      const task = pg.render({ canvasContext: nc.getContext('2d'), viewport: vp });
      m.task = task;
      await task.promise;
      m.task = null;
      if(!_alive) return;
      if(m.canvas && m.canvas.parentNode === m.wrap) m.wrap.replaceChild(nc, m.canvas);
      else m.wrap.insertBefore(nc, m.wrap.firstChild);
      m.canvas = nc;
      m.rendered = true; m.renderedZoom = renderZoom;
      if(m.wrap) m.wrap.classList.add('rendered');
    }catch(e){ if(!(e && e.name==='RenderingCancelledException')) console.warn('pdf page render:', e && e.message); }
    m.rendering = false;
    // Zoom changed while rendering? Re-render to the latest if still near the viewport.
    if(_alive && m.renderedZoom !== zoom){
      const st = scroll.scrollTop, vh = scroll.clientHeight;
      if(m.top + m.h > st - RENDER_MARGIN && m.top < st + vh + RENDER_MARGIN) renderPage(m);
    }
  }

  const RENDER_MARGIN = 1400;  // pre-render this far above/below the viewport
  const KEEP_MARGIN = 2800;    // release canvases beyond this
  function updateVisible(){
    if(!_alive) return;
    const st = scroll.scrollTop, vh = scroll.clientHeight;
    pages.forEach(m=>{
      const top = m.top, bot = m.top + m.h;
      const near = bot > st - RENDER_MARGIN && top < st + vh + RENDER_MARGIN;
      const keep = bot > st - KEEP_MARGIN && top < st + vh + KEEP_MARGIN;
      if(near) renderPage(m);
      else if(!keep && (m.rendered || m.rendering)) releaseCanvas(m);
    });
    if(numPages){
      const mid = st + vh/2;
      let cur = 1;
      for(let i=0;i<pages.length;i++){ if(pages[i].top <= mid) cur = i+1; else break; }
      pageLbl.textContent = cur + ' / ' + numPages;
    }
  }

  let _scrollRaf = 0;
  scroll.addEventListener('scroll', ()=>{
    if(_scrollRaf) return;
    _scrollRaf = requestAnimationFrame(()=>{ _scrollRaf = 0; updateVisible(); });
  });

  // Zoom toward a focal client point (fx,fy) — keeps that spot under the cursor /
  // pinch center fixed (a getBoundingClientRect delta on the anchor page handles
  // the padding/gap/centering math). Omit fx/fy to zoom about the viewport center
  // (the +/- buttons). layout() resizes wrappers first so existing canvases CSS-
  // scale instantly (no white flash), then visible pages re-render crisp.
  function setZoom(nz, fx, fy){
    nz = Math.min(6, Math.max(0.4, nz));
    if(Math.abs(nz - zoom) < 0.001) return;
    const rect = scroll.getBoundingClientRect();
    const useX = (fx==null) ? rect.left + rect.width/2  : fx;
    const useY = (fy==null) ? rect.top  + rect.height/2 : fy;
    const sy = scroll.scrollTop + (useY - rect.top);
    let m = pages[0];
    for(let i=0;i<pages.length;i++){ if(pages[i].top <= sy) m = pages[i]; else break; }
    if(!m){ zoom = nz; layout(); updateVisible(); return; }
    const r0 = m.wrap.getBoundingClientRect();
    const rx = r0.width  ? Math.min(1, Math.max(0, (useX - r0.left)/r0.width))  : 0.5;
    const ry = r0.height ? Math.min(1, Math.max(0, (useY - r0.top )/r0.height)) : 0;
    zoom = nz;
    layout();
    const r1 = m.wrap.getBoundingClientRect();   // forces reflow → new geometry
    scroll.scrollLeft += (r1.left + rx*r1.width)  - useX;
    scroll.scrollTop  += (r1.top  + ry*r1.height) - useY;
    updateVisible();
  }
  document.getElementById('_dv-zin').onclick  = ()=> setZoom(zoom*1.25);
  document.getElementById('_dv-zout').onclick = ()=> setZoom(zoom/1.25);

  // Desktop: ctrl/cmd + wheel zooms (trackpad pinch arrives as ctrl+wheel); plain
  // wheel scrolls natively (no preventDefault).
  scroll.addEventListener('wheel', e=>{
    if(!pdf) return;
    if(e.ctrlKey || e.metaKey){ e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1/1.12), e.clientX, e.clientY); }
  }, { passive:false });

  // Touch pinch-zoom: live CSS transform on the pages container for feedback,
  // commit a crisp re-render on release. Anchored to the current top page.
  let _pinching = false, _pDist = 0, _pZoom = 1, _pCx = 0, _pCy = 0;
  const _tDist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroll.addEventListener('touchstart', e=>{
    if(e.touches.length===2){
      _pinching = true; _pDist = _tDist(e.touches) || 1; _pZoom = zoom;
      _pCx = (e.touches[0].clientX + e.touches[1].clientX)/2;
      _pCy = (e.touches[0].clientY + e.touches[1].clientY)/2;
      pagesEl.style.transformOrigin = 'center top'; e.preventDefault();
    }
  }, { passive:false });
  scroll.addEventListener('touchmove', e=>{
    if(_pinching && e.touches.length===2){
      e.preventDefault();
      let r = _tDist(e.touches) / _pDist;
      r = Math.min(Math.max(r, 0.4/_pZoom), 6/_pZoom);
      pagesEl.style.transform = 'scale(' + r + ')';
    }
  }, { passive:false });
  const _endPinch = ()=>{
    if(!_pinching) return;
    _pinching = false;
    const m = (pagesEl.style.transform.match(/scale\(([^)]+)\)/) || [])[1];
    pagesEl.style.transform = ''; pagesEl.style.transformOrigin = '';
    setZoom(_pZoom * (m ? parseFloat(m) : 1), _pCx, _pCy);
  };
  scroll.addEventListener('touchend', e=>{ if(_pinching && e.touches.length<2) _endPinch(); }, { passive:false });
  scroll.addEventListener('touchcancel', _endPinch, { passive:false });

  // Desktop click-drag panning (grab the page to move it — essential once zoomed
  // wider/taller than the viewport; native wheel still scrolls vertically).
  let _drag = false, _dx = 0, _dy = 0, _dsl = 0, _dst = 0;
  scroll.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    _drag = true; _dx = e.clientX; _dy = e.clientY; _dsl = scroll.scrollLeft; _dst = scroll.scrollTop;
    scroll.classList.add('grabbing'); e.preventDefault();
  });
  const _onMove = e=>{ if(!_drag) return; scroll.scrollLeft = _dsl - (e.clientX - _dx); scroll.scrollTop = _dst - (e.clientY - _dy); };
  const _onUp = ()=>{ if(_drag){ _drag = false; scroll.classList.remove('grabbing'); } };
  window.addEventListener('mousemove', _onMove);
  window.addEventListener('mouseup', _onUp);
  _cleanupFns.push(()=> window.removeEventListener('mousemove', _onMove));
  _cleanupFns.push(()=> window.removeEventListener('mouseup', _onUp));

  // Re-fit on rotation / resize.
  const _onResize = ()=>{ if(!_alive) return; const st = scroll.scrollTop; let a=0,fr=0; for(let i=0;i<pages.length;i++){ if(pages[i].top<=st){a=i;fr=(st-pages[i].top)/(pages[i].h||1);} else break; } layout(); if(pages[a]) scroll.scrollTop = pages[a].top + fr*pages[a].h; updateVisible(); };
  window.addEventListener('resize', _onResize);
  _cleanupFns.push(()=> window.removeEventListener('resize', _onResize));

  try{
    const pdfjsLib = await _loadPdfjs();
    const src = await _docSource(d);
    let params;
    if(src.blob){ params = { data: new Uint8Array(await src.blob.arrayBuffer()), ..._PDF_DOC_OPTS }; }
    else { params = { url: src.url, ..._PDF_DOC_OPTS }; }
    pdf = await pdfjsLib.getDocument(params).promise;
    if(!_alive){ try{ pdf.destroy(); }catch(e){} return; }
    numPages = pdf.numPages;

    // Estimate every placeholder from page 1's size (corrected per-page on render).
    const p1 = await pdf.getPage(1);
    const b = p1.getViewport({ scale:1 });
    for(let i=0;i<numPages;i++){
      const wrap = document.createElement('div');
      wrap.className = 'gl-doc-vpage-wrap';
      const canvas = document.createElement('canvas');
      const spin = document.createElement('div');
      spin.className = 'gl-doc-vpage-spin';
      spin.textContent = 'Page ' + (i+1);
      wrap.appendChild(canvas); wrap.appendChild(spin);
      pagesEl.appendChild(wrap);
      pages.push({ index:i, baseW:b.width, baseH:b.height, wrap, canvas, top:0, w:0, h:0, rendered:false, rendering:false, task:null });
    }
    const ld = document.getElementById('_dv-loading'); if(ld) ld.remove();
    layout();
    updateVisible();
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
        folder: _docFolderName(d.folderId), size: d.size||0, shared:true, createdAt: d.createdAt||Date.now(), updatedAt: Date.now() };
      await mref.set(m);
    } else {
      await mref.delete();
    }
    d.shared = willShare; d.updatedAt = Date.now();
    await _udb().collection('docs').doc(id).set({ shared: willShare, updatedAt: d.updatedAt }, { merge:true });
    _docCacheDocs();
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
    _docCacheDocs();
    _docRenderLibrary();
  });
}

// Move = a real folder PICKER (the old text-prompt couldn't pick existing folders).
function docMove(id){
  const d = (window._docs||[]).find(x=>x.id===id); if(!d) return;
  _docCloseMenu();
  let opts = `<button class="gl-doc-pick${!d.folderId?' cur':''}" onclick="_docMoveTo('${id}','')">🗂 Unfiled (no folder)</button>`;
  const walk = (parentId, depth)=>{
    _docChildFolders(parentId).forEach(f=>{
      opts += `<button class="gl-doc-pick${d.folderId===f.id?' cur':''}" style="padding-left:${13+depth*16}px" onclick="_docMoveTo('${id}','${f.id}')">📂 ${_docEsc(f.name)}</button>`;
      walk(f.id, depth+1);
    });
  };
  walk(null, 0);
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_doc-move';
  ov.innerHTML = `<div class="modal-box" style="max-width:380px">
    <div class="modal-title">📂 Move “${_docEsc(d.title)}”</div>
    <div class="gl-doc-pick-list">${opts}</div>
    <div class="modal-btns" style="gap:8px">
      <button class="modal-cancel" onclick="document.getElementById('_doc-move').remove()">Cancel</button>
      <button class="modal-confirm" onclick="_docMoveNewFolder('${id}')">＋ New folder…</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
}
function _docMoveClose(){ const m=document.getElementById('_doc-move'); if(m) m.remove(); }

async function _docMoveTo(id, folderId){
  const d = (window._docs||[]).find(x=>x.id===id); if(!d) return;
  _docMoveClose();
  const fid = folderId || null;
  const name = fid ? _docFolderName(fid) : 'Unfiled';
  d.folderId = fid; d.folder = name; d.updatedAt = Date.now();
  try{ await _udb().collection('docs').doc(id).set({ folderId: fid, folder: name, updatedAt: d.updatedAt }, { merge:true }); }catch(e){}
  if(d.shared){ try{ await db.collection('projects').doc(_docPid()).collection('docs').doc(id).set({ folder: name, updatedAt: d.updatedAt }, { merge:true }); }catch(e){} }
  if(fid) _docFolderOpen[fid] = true;
  _docCacheDocs();
  if(window.glHaptic && window.glHaptic.light) window.glHaptic.light();
  _docRenderLibrary();
}
function _docMoveNewFolder(id){
  _docMoveClose();
  _docPrompt('New folder', '', 'Create & move', async (name)=>{
    name = (name||'').trim(); if(!name) return;
    const f = await _docCreateFolder(name, null);
    _docMoveTo(id, f.id);
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
    _docCacheDocs();
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
window._docsPurgeOffline = function(){
  _docOfflineIds = new Set();
  try { return idbKvClear(_docBlobStore); } catch(e){ return Promise.resolve(); }
};

// ── Window exposure (inline onclick handlers) ──
window.glRenderDocsPage = glRenderDocsPage;
window.docSearch = docSearch;
window.docPickFiles = docPickFiles;
window.docPickRoot = docPickRoot;
window.docDropRoot = docDropRoot;
window.docHandleFiles = docHandleFiles;
window.docOpen = docOpen;
window.docToggleOffline = docToggleOffline;
window.docToggleShare = docToggleShare;
window.docToggleFolder = docToggleFolder;
window.docToggleCard = docToggleCard;
window.docNewFolder = docNewFolder;
window.docFolderMenu = docFolderMenu;
window._docFolderCloseMenu = _docFolderCloseMenu;
window.docUploadToFolder = docUploadToFolder;
window.docRenameFolder = docRenameFolder;
window.docDeleteFolder = docDeleteFolder;
window.docMenu = docMenu;
window._docCloseMenu = _docCloseMenu;
window.docRename = docRename;
window.docMove = docMove;
window._docMoveTo = _docMoveTo;
window._docMoveNewFolder = _docMoveNewFolder;
window.docDelete = docDelete;
window._docToggleAiFromMenu = _docToggleAiFromMenu;
