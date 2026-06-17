// ── Window globals — Firebase state (initialized here, assigned at DOMContentLoaded) ──
window.db = null;
window.storage = null;
window.auth = null;
window._currentUser = null;
window._fbReady = false;

// ═══════════════════════════════════════════
// FIREBASE — CLOUD SYNC
// ═══════════════════════════════════════════
const _fbConfig = {
  apiKey: "AIzaSyDmIA95GAAEkjesADQC3hp7IscNXcZrFUE",
  authDomain: "moraine-ei-log.firebaseapp.com",
  projectId: "moraine-ei-log",
  storageBucket: "moraine-ei-log.firebasestorage.app",
  messagingSenderId: "242008020472",
  appId: "1:242008020472:web:33d7ca5b291382b200320d"
};

// Firebase init — deferred to DOMContentLoaded so src/main.js (npm modules) are ready first
// Auth state gate is registered here (not separately) to guarantee it fires AFTER auth is set up.
// If registered in a classic script DOMContentLoaded, it would fire before this module's listener.
document.addEventListener('DOMContentLoaded', function _initFirebase() {
  if (typeof firebase !== 'undefined') {
    try {
      const _fbApp = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(_fbConfig);
      window.db = _fbApp.firestore();
      window.storage = _fbApp.storage();
      window.auth = _fbApp.auth();
      console.log('Phinest EI: Firebase initialized OK');
      if (typeof window._initAuth === 'function') window._initAuth();
    } catch(e) {
      console.error('Phinest EI: Firebase init failed —', e.message);
      document.getElementById('page-auth-loading').style.display = 'none';
    }
  } else {
    console.error('Phinest EI: firebase global not defined');
    document.getElementById('page-auth-loading').style.display = 'none';
    if (typeof window.initFirebaseLoad === 'function') window.initFirebaseLoad();
  }
});

// ── Inject sync status indicator into app bar ──
(function(){
  const bar = document.querySelector('.app-bar');
  if(!bar) return;
  const el = document.createElement('span');
  el.id = 'sync-dot';
  el.style.cssText = 'font-family:var(--mono);font-size:10px;letter-spacing:.05em;transition:color .3s;white-space:nowrap;margin-left:2px';
  bar.appendChild(el);
})();

// ── iPad/iOS keyboard nav fix — relock bottom nav when keyboard resizes viewport ──
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',function(){
      const nav=document.querySelector('.bottom-nav');
      if(!nav) return;
      let offset=window.innerHeight-window.visualViewport.height-window.visualViewport.offsetTop;
      if(offset>0&&offset<100)offset=0; // keyboard-only compensation: sub-100px deltas are safe-area/inset jitter, real keyboards are 200px+
      nav.style.transform=offset>0?`translateY(-${offset}px) translateZ(0)`:'translateZ(0)';
      // Scroll focused element into view after keyboard opens
      const focused=document.activeElement;
      if(focused && (focused.tagName==='INPUT'||focused.tagName==='TEXTAREA')){
        setTimeout(()=>{ focused.scrollIntoView({block:'center',behavior:'smooth'}); },100);
      }
    });
  window.visualViewport.addEventListener('scroll',function(){
      const nav=document.querySelector('.bottom-nav');
      if(!nav) return;
      if(window.visualViewport.offsetTop < 0) return;
      let offset=window.innerHeight-window.visualViewport.height-window.visualViewport.offsetTop;
      if(offset>0&&offset<100)offset=0; // keyboard-only compensation: sub-100px deltas are safe-area/inset jitter, real keyboards are 200px+
      nav.style.transform=offset>0?`translateY(-${offset}px) translateZ(0)`:'translateZ(0)';
    });
}

function setSyncStatus(s) {
  const el = document.getElementById('sync-dot');
  if (!el) return;
  if (s === 'syncing') {
    el.textContent = '⟳ syncing'; el.style.color = 'var(--amber)'; el.title = '';
  } else if (s === 'synced') {
    el.textContent = '✓ synced'; el.style.color = 'var(--green)'; el.title = '';
  } else if (s === 'offline') {
    el.textContent = '✗ offline — tap to retry'; el.style.color = 'var(--red)'; el.style.cursor = 'pointer';
    el.title = 'Click to retry Firebase connection';
    el.onclick = function() {
            _reconnectFirebase();
    };
  } else {
    el.textContent = ''; el.onclick = null;
  }
}

function _reconnectFirebase() {
  if (!db) {
    try {
      const _fbApp = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(_fbConfig);
      window.db = _fbApp.firestore();
      cloudSave();
    } catch(e) {}
    return;
  }
  db.enableNetwork().then(function() {
    setSyncStatus('syncing');
    _udb().collection('sessions').doc(_activeProjectId()).get().then(function(doc) {
      const cloudTs = doc.exists ? (doc.data()._ts || 0) : 0;
      let localTs = 0;
      try { localTs = JSON.parse(localStorage.getItem('msf_autosave') || '{}')._ts || 0; } catch {}
      if (localTs > cloudTs) {
        cloudSave();
      } else if (cloudTs > localTs && doc.exists) {
        const cloudState = doc.data();
        document.getElementById('crewContainer').innerHTML = '';
        window.crewIds = []; window.crewSeq = 0;
        restoreFormState(cloudState);
        try { localStorage.setItem('msf_autosave', JSON.stringify(cloudState)); } catch {}
        showCloudBanner('☁ Synced — picked up changes from another device.');
        setSyncStatus('synced');
      } else {
        setSyncStatus('synced');
      }
    }).catch(function() { cloudSave(); });
  }).catch(function(e) {});
}

// ── Browser online/offline events ──
// Debounce the offline handler — iOS fires a spurious 'offline' event during hard refresh.
let _offlineDebounce = null;
window.addEventListener('online', function() {
    if (_offlineDebounce) { clearTimeout(_offlineDebounce); _offlineDebounce = null; }
    _reconnectFirebase();
});
window.addEventListener('offline', function() {
    _offlineDebounce = setTimeout(function() {
        _offlineDebounce = null;
        setSyncStatus('offline');
    }, 2500);
});

// ── Visibility change — re-sync when device wakes or user returns to tab ──
// Also re-runs new-day detection on WEB foreground: native is covered by the
// Capacitor appStateChange listener (main.js), but a PWA tab left open across a
// weekend never re-checked the day, so the "start new day" prompt was missed on
// Monday (Discord 6/15). checkNewDay() self-suppresses (pei_newday_suppress), so
// it's safe to call on every return-to-foreground; it runs AFTER the session
// re-sync so a day already advanced on another device is respected.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (!db || !_fbReady) { if (typeof checkNewDay === 'function') checkNewDay(); return; }
  _udb().collection('sessions').doc(_activeProjectId()).get().then(function(doc) {
    if (doc.exists) {
      const cloudState = doc.data();
      const cloudTs = cloudState._ts || 0;
      let localTs = 0;
      try { localTs = JSON.parse(localStorage.getItem('msf_autosave') || '{}')._ts || 0; } catch {}
      if (cloudTs > localTs) {
        document.getElementById('crewContainer').innerHTML = '';
        window.crewIds = []; window.crewSeq = 0;
        restoreFormState(cloudState);
        try { localStorage.setItem('msf_autosave', JSON.stringify(cloudState)); } catch {}
        showCloudBanner('☁ Synced — picked up changes from another device.');
      }
    }
    if (typeof checkNewDay === 'function') checkNewDay();
  }).catch(function() { if (typeof checkNewDay === 'function') checkNewDay(); });
});

// ── Cloud save (called with debounce from autoSave) ──
let _cloudTimer = null;
async function cloudSave() {
  if (!db || !_fbReady || !_currentUser) { return; } // not ready — skip silently, don't show offline
  try {
    setSyncStatus('syncing');
    const state = collectFormState();
    state._ts = Date.now();
    await _udb().collection('sessions').doc(_activeProjectId()).set(state);
    try { localStorage.setItem('msf_autosave', JSON.stringify(state)); } catch {}
    setSyncStatus('synced');
  } catch(e) {
    setSyncStatus('offline');
    console.warn('Phinest EI: cloudSave failed —', e.message);
  }
}

// ── Wire debouncedAutoSave to call both local + cloud save ──
function debouncedAutoSave() {
  clearTimeout(_asTimer);
  _asTimer = setTimeout(function() {
    // If user is editing a previously archived log, mark it as edited on first change
    if (_editingArchivedDate) {
      try {
        const record = dlGet(_editingArchivedDate);
        if (record && !record._edited) {
          const cfg = JSON.parse(localStorage.getItem('msf_projectconfig')||'{}');
          const editor = cfg.preparedBy||'EI';
          record._edited = true;
          record._editLog = record._editLog||[];
          record._editLog.push({ at: Date.now(), by: editor, action: 'Edited after archive' });
          dlSaveLocal(_editingArchivedDate, record);
          if (typeof db!=='undefined'&&db&&_fbReady){
            _udb().collection('dailyLogs').doc(_editingArchivedDate).set(record).catch(()=>{});
          }
        }
      } catch(e) {}
      window._editingArchivedDate = null; // only flag once
    }
    _autoSaveLocal();
    clearTimeout(_cloudTimer);
    _cloudTimer = setTimeout(cloudSave, 2500);
  }, 600);
}

// ── Banner helper ──
function showCloudBanner(msg) {
  const existing = document.getElementById('cloud-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'cloud-banner';
  banner.style.cssText = 'position:fixed;top:var(--app-bar-h);left:0;right:0;z-index:999;background:#001a1c;border-bottom:1px solid #006A75;color:#7ab5b8;font-family:monospace;font-size:12px;padding:8px 18px;display:flex;justify-content:space-between;align-items:center;';
  banner.innerHTML = `<span>${msg}</span><button onclick="document.getElementById('cloud-banner').remove()" style="background:none;border:none;color:#6ecf6e;cursor:pointer;font-size:16px;line-height:1;">✕</button>`;
  document.body.prepend(banner);
  setTimeout(() => { const b = document.getElementById('cloud-banner'); if(b) b.remove(); }, 7000);
}

// ── Custom confirm modal (replaces confirm() which is unreliable in iOS PWA) ──
function _confirmModal(msg, onConfirm, title, confirmLabel) {
  title = title || '⚠ Confirm Reset';
  confirmLabel = confirmLabel || 'Reset';
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box">' +
    '<div class="modal-title">' + title + '</div>' +
    '<div class="modal-msg">' + msg + '</div>' +
    '<div class="modal-btns">' +
      '<button class="modal-cancel" id="_mc">Cancel</button>' +
      '<button class="modal-confirm" id="_mok">' + confirmLabel + '</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_mc').onclick = function() { ov.remove(); };
  document.getElementById('_mok').onclick = function() { ov.remove(); if (typeof onConfirm === 'function') onConfirm(); };
}

// ── resetForm: clears cloud + form — only permitted on today's log ──
function resetForm() {
  const today = new Date().toLocaleDateString('en-CA');
  let savedDate = '';
  try {
    const saved = localStorage.getItem('msf_autosave');
    if (saved) {
      const state = JSON.parse(saved);
      savedDate = (state.fields && state.fields.reportDate) || state.reportDate || '';
    }
  } catch {}
  // Block reset if the active log is from a previous day
  if (savedDate && savedDate !== today) {
    _confirmModal('This log is from ' + dlFmtDisplay(savedDate) + '. Previous day logs cannot be reset — use the Calendar to load and edit them instead.', function(){});
    // Override the modal button to be informational only
    setTimeout(function(){
      const btn = document.getElementById('_mok');
      if (btn) { btn.style.display = 'none'; }
      const cancel = document.getElementById('_mc');
      if (cancel) { cancel.textContent = 'OK'; }
    }, 10);
    return;
  }
  _confirmModal('Reset the daily log? All entries will be cleared. Config and presets are preserved.', function() {
    if (db) _udb().collection('sessions').doc(_activeProjectId()).delete().catch(function(e){});
    _resetFormCore();
    setSyncStatus('idle');
  });
}

// Re-sync tracker when app comes back to foreground (covers truck/field multi-device scenario).
let _trackerVisibilityTs = 0;
document.addEventListener('visibilitychange', function(){
  if(document.visibilityState !== 'visible') return;
  const now = Date.now();
  if(now - _trackerVisibilityTs < 30000) return; // throttle: once per 30s
  _trackerVisibilityTs = now;
  if(typeof _fbReady !== 'undefined' && _fbReady) _trackerStartupLoad();
});

// Load tracker categories + entries from Firestore on startup, then re-render map/panel/compliance.
function _trackerStartupLoad(){
  if(typeof tcLoadForProject !== 'function') return;
  tcLoadForProject()
    .then(()=>{ if(typeof trLoadFromFirestore==='function') return trLoadFromFirestore(); })
    .then(()=>{
      // Non-map UI updates immediately.
      if(typeof window._renderTrackerSheet==='function') window._renderTrackerSheet();
      if(typeof clRenderTrackerCard==='function') clRenderTrackerCard();
      // Map render — defer to idle if style not fully loaded yet (tiles still downloading on iOS).
      if(typeof mapRenderTrackerLayers==='function'){
        const map = typeof window.getMapInstance==='function' ? window.getMapInstance() : null;
        if(map && map.isStyleLoaded()){
          mapRenderTrackerLayers();
          if(typeof mapUpdateKmlLayerList==='function') mapUpdateKmlLayerList();
        } else if(map){
          map.once('idle', ()=>{
            mapRenderTrackerLayers();
            if(typeof mapUpdateKmlLayerList==='function') mapUpdateKmlLayerList();
          });
        }
        // if no map yet: style.load handler in maps.js calls mapRenderTrackerLayers when ready.
      }
    })
    .catch(e => console.warn('tcLoad/trLoad (startup):', e.message));
}

// ── Firebase init load — runs async after page restores from localStorage ──
async function initFirebaseLoad() {
  if (!db) { setSyncStatus('offline');  return; }

  // Tier-1 cache gate: hydrate IndexedDB and migrate the daily-log / compliance
  // archive blobs out of localStorage BEFORE any downstream read (session
  // restore, checkNewDay, clInit). dlGetAll()/clLoadLocal() now read the IDB
  // cache synchronously, so the mirror must be populated first. (Storage
  // architecture Stage 2 — see KB storage-architecture.md.)
  if (window.idbReady) { try { await window.idbReady; } catch (e) {} }
  if (window.idbMigrateKey) { window.idbMigrateKey('pei_daily_logs'); window.idbMigrateKey('cl_entries'); }
  // Per-project tracker + KML caches (dynamic msf_proj_<pid>_* keys). Suffix-matched
  // so timesheet's msf_proj_<pid>_ts_config is left in localStorage (own session).
  if (window.idbMigrateBySuffix) { window.idbMigrateBySuffix(['_tracker_entries', '_kml_layers']); }

  // If this is an archived file being re-opened, push its state to cloud and exit
  if (typeof SAVED_DATA !== 'undefined' && SAVED_DATA !== null) {
    cloudSave();
    return;
  }

  // Recover if localStorage was wiped OR if stored project ID is not in Firestore known projects
  const _storedPid = localStorage.getItem('gl_active_project_id');
  if (!_storedPid) {
    try {
      const apDoc = await _udb().collection('settings').doc('activeProject').get();
      if (apDoc.exists && apDoc.data().projectId) {
        localStorage.setItem('gl_active_project_id', apDoc.data().projectId);
      }
    } catch(e) {}
  } else {
    try {
      const knownDoc = await _udb().collection('settings').doc('knownProjects').get();
      if (knownDoc.exists) {
        const validIds = (knownDoc.data().projects || []).map(p => p.projectId).filter(Boolean);
        if (validIds.length > 0 && !validIds.includes(_storedPid)) {
          const apDoc = await _udb().collection('settings').doc('activeProject').get();
          if (apDoc.exists && apDoc.data().projectId && validIds.includes(apDoc.data().projectId)) {
            const recoveredId = apDoc.data().projectId;
            localStorage.setItem('gl_active_project_id', recoveredId);
            localStorage.setItem('gl_known_projects', JSON.stringify(knownDoc.data().projects || []));
            console.log('GroundLog: stale project ID recovered', _storedPid, '→', recoveredId);
          }
        }
      }
    } catch(e) {}
  }

  // One-time migrations
  await _glMigrateToProjects();
  await _glMigratePhaseC();

  try {
    const doc = await _udb().collection('sessions').doc(_activeProjectId()).get();

    if (!doc.exists) {
      // Project session missing — try sessions/active as fallback (handles fresh migration)
      let fallbackRestored = false;
      try {
        const fallbackDoc = await _udb().collection('sessions').doc('active').get();
        if (fallbackDoc.exists) {
          const fallbackState = fallbackDoc.data();
          const fallbackTs = fallbackState._ts || 0;
          // Only adopt the legacy sessions/active fallback if it's actually TODAY's session.
          // A stale legacy doc (a pre-projects-migration session frozen on an old date) must
          // never become the live form — that was the "always reverts to <old date>" boot bug.
          const _fbToday = (window.localToday ? window.localToday() : new Date().toLocaleDateString('en-CA'));
          const fbDate = (fallbackState.fields && fallbackState.fields.reportDate) || fallbackState.reportDate || '';
          let localTs2 = 0;
          try { localTs2 = JSON.parse(localStorage.getItem('msf_autosave') || '{}')._ts || 0; } catch {}
          if (fallbackTs >= localTs2 && fbDate === _fbToday) {
            document.getElementById('crewContainer').innerHTML = '';
            window.crewIds = []; window.crewSeq = 0;
            restoreFormState(fallbackState);
            try { localStorage.setItem('msf_autosave', JSON.stringify(fallbackState)); } catch {}
            // Promote sessions/active to project-scoped path
            _udb().collection('sessions').doc(_activeProjectId()).set(fallbackState).catch(() => {});
            showCloudBanner('☁ Session restored from cloud — picked up where you left off.');
            fallbackRestored = true;
          }
        }
      } catch(e) {}

      if (!fallbackRestored) {
        // True first use or cloud was intentionally reset on another device
        let localTs = 0;
        try { const local = JSON.parse(localStorage.getItem('msf_autosave') || '{}'); localTs = local._ts || 0; } catch {}
        if (localTs > 0) {
          _resetFormCore();
          showCloudBanner('↺ Log was reset on another device — starting fresh.');
        }
      }
      window._fbReady = true;
      setSyncStatus('synced');
      phInit();
      clInit();
      tsLoadFromFirestore();
      syncProjectConfigFromCloud();
      syncPresetsFromCloud();
      _syncProjectListFromCloud();
      window._rptInitHostedKeyBtn();
      checkNewDay();
      loadChecklistCloud();
      loadFlagsCloud();
      _glSharedBoot(); // runs _trackerStartupLoad after membership backfill
      return;
    }

    const cloudState = doc.data();
    const cloudTs = cloudState._ts || 0;

    let localTs = 0;
    try {
      const local = JSON.parse(localStorage.getItem('msf_autosave') || '{}');
      localTs = local._ts || 0;
    } catch {}

    if (cloudTs > localTs) {
      document.getElementById('crewContainer').innerHTML = '';
      window.crewIds = []; window.crewSeq = 0;
      restoreFormState(cloudState);
      try { localStorage.setItem('msf_autosave', JSON.stringify(cloudState)); } catch {}
      showCloudBanner('☁ Session restored from cloud — picked up where you left off.');
      window._fbReady = true;
      setSyncStatus('synced');
      phInit();
      clInit();
      tsLoadFromFirestore();
      syncProjectConfigFromCloud();
      syncPresetsFromCloud();
      _syncProjectListFromCloud();
      window._rptInitHostedKeyBtn();
      checkNewDay();
      loadChecklistCloud();
      loadFlagsCloud();
    } else if (localTs > cloudTs) {
      window._fbReady = true;
      cloudSave();
      phInit();
      tsLoadFromFirestore();
      syncProjectConfigFromCloud();
      syncPresetsFromCloud();
      _syncProjectListFromCloud();
      window._rptInitHostedKeyBtn();
      checkNewDay();
      loadChecklistCloud();
      loadFlagsCloud();
    } else {
      window._fbReady = true;
      setSyncStatus('synced');
      phInit();
      tsLoadFromFirestore();
      syncProjectConfigFromCloud();
      syncPresetsFromCloud();
      _syncProjectListFromCloud();
      window._rptInitHostedKeyBtn();
      checkNewDay();
      loadChecklistCloud();
      loadFlagsCloud();
    }

  } catch(e) {
    setSyncStatus('offline');
    console.warn('GroundLog: Firebase init load failed —', e.message);
    checkNewDay(); // still check even if Firebase fails — local data may have previous day
    loadChecklistCloud();
    loadFlagsCloud();
  }
  window._fbReady = true; // allow cloudSave from this point forward
  _glSharedBoot(); // runs _trackerStartupLoad after membership backfill
}

// ── User namespace helper — all post-migration paths use this ──
function _udb() {
  if (!db || !_currentUser) return null;
  return db.collection('users').doc(_currentUser.uid);
}

// ── Project-data root — THE path-abstraction choke point (Phase 4.5) ──
// FLIPPED 2026-06-11: work product (trackerEntries, trackerCategories) now
// lives at the SHARED root projects/{pid}. Rules gate it: members-only,
// publish-gated reads for non-owners (published == true), role-gated writes
// (firestore.rules + tests/rules). The old per-user mirror
// users/{uid}/projects/{pid} is left untouched as a frozen backup;
// _glMigrateWorkProductFlip (members.js) copies it forward once per project.
// NOTE: lists on publish-gated collections must use rules-provable queries
// (ownerUid == me / published == true) — unconstrained .get() is denied.
function _projData(pid) {
  if (!db || !_currentUser) return null;
  return db.collection('projects').doc(pid || _activeProjectId());
}

// Personal per-project view state (e.g. the KML layer-visibility copy) stays
// in the user's own subtree — view state is personal, never shared.
function _projDataUser(pid) {
  const u = _udb();
  if (!u) return null;
  return u.collection('projects').doc(pid || _activeProjectId());
}

// ── Shared-projects boot hooks (members.js) — called from every
// initFirebaseLoad exit path once _fbReady is true. Backfill mints the shared
// projects/{pid} + members + memberships mirror for locally-known projects;
// the work-product flip migration MUST run after backfill (membership is what
// authorizes the shared-root writes) and refreshes the tracker if it copied;
// the pending-invite check completes a ?join= / typed-code accept after auth.
async function _glSharedBoot() {
  try {
    if (typeof glBackfillSharedProjects === 'function') await glBackfillSharedProjects();
  } catch(e) { console.warn('shared-projects backfill:', e.message); }
  // Tracker loads read the shared root projects/{pid} — on a brand-new account
  // they must WAIT for backfill to mint the membership doc, or the rules deny
  // them (first-boot race: tcLoadForProject/trLoadFromFirestore permission
  // warnings on fresh-account signup, found 2026-06-11). Sits outside the
  // try blocks so a backfill failure never blocks the tracker on existing
  // accounts (their membership already exists).
  _trackerStartupLoad();
  try {
    if (typeof glRepairSharedStubs === 'function') glRepairSharedStubs();
    if (typeof _glMigrateWorkProductFlip === 'function') {
      const copied = await _glMigrateWorkProductFlip();
      if (copied) _trackerStartupLoad();
    }
    if (typeof glCheckPendingInvite === 'function') setTimeout(glCheckPendingInvite, 600);
    if (typeof _glInitMapShareBtn === 'function') _glInitMapShareBtn();
    if (typeof _glInitMapHostBtn === 'function') _glInitMapHostBtn();
    // Restore the per-project nav layout from the user's cloud profile — the
    // device-uid purge wiped its localStorage on the last account switch.
    if (typeof _glHydrateNavSlotsFromCloud === 'function') _glHydrateNavSlotsFromCloud();
  } catch(e) { console.warn('shared-projects boot:', e.message); }
}

// ── Window exposure ──
window.setSyncStatus = setSyncStatus;
window._reconnectFirebase = _reconnectFirebase;
window.cloudSave = cloudSave;
window.debouncedAutoSave = debouncedAutoSave;
window.showCloudBanner = showCloudBanner;
window._confirmModal = _confirmModal;
window.resetForm = resetForm;
window.initFirebaseLoad = initFirebaseLoad;
window._udb = _udb;
window._projData = _projData;
window._projDataUser = _projDataUser;
window._glSharedBoot = _glSharedBoot;
