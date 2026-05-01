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
document.addEventListener('DOMContentLoaded', function _initFirebase() {
  if (typeof firebase !== 'undefined') {
    try {
      const _fbApp = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(_fbConfig);
      window.db = _fbApp.firestore();
      window.storage = _fbApp.storage();
      window.auth = _fbApp.auth();
      console.log('Phinest EI: Firebase initialized OK');
    } catch(e) {
      console.error('Phinest EI: Firebase init failed —', e.message);
    }
  } else {
    console.error('Phinest EI: firebase global not defined');
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
      const offset=window.innerHeight-window.visualViewport.height-window.visualViewport.offsetTop;
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
      const offset=window.innerHeight-window.visualViewport.height-window.visualViewport.offsetTop;
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
window.addEventListener('online', function() {
    _reconnectFirebase();
});
window.addEventListener('offline', function() {
    setSyncStatus('offline');
});

// ── Visibility change — re-sync when device wakes or user returns to tab ──
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (!db || !_fbReady) return;
  _udb().collection('sessions').doc(_activeProjectId()).get().then(function(doc) {
    if (!doc.exists) return;
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
  }).catch(function() {});
});

// ── Cloud save (called with debounce from autoSave) ──
let _cloudTimer = null;
async function cloudSave() {
  if (!db || !_fbReady) { return; } // not ready — skip silently, don't show offline
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
  banner.style.cssText = 'position:fixed;top:56px;left:0;right:0;z-index:999;background:#001a1c;border-bottom:1px solid #006A75;color:#7ab5b8;font-family:monospace;font-size:12px;padding:8px 18px;display:flex;justify-content:space-between;align-items:center;';
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
  const today = new Date().toISOString().split('T')[0];
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

// ── Firebase init load — runs async after page restores from localStorage ──
async function initFirebaseLoad() {
  if (!db) { setSyncStatus('offline');  return; }

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
          let localTs2 = 0;
          try { localTs2 = JSON.parse(localStorage.getItem('msf_autosave') || '{}')._ts || 0; } catch {}
          if (fallbackTs >= localTs2) {
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
      _rptInitHostedKeyBtn();
      checkNewDay();
      loadChecklistCloud();
      loadFlagsCloud();
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
      _rptInitHostedKeyBtn();
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
      _rptInitHostedKeyBtn();
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
      _rptInitHostedKeyBtn();
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
}

// ── User namespace helper — all post-migration paths use this ──
function _udb() {
  if (!db || !_currentUser) return null;
  return db.collection('users').doc(_currentUser.uid);
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
