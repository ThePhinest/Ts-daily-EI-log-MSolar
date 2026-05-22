// Sentry — initialized in main.js; we just attach user identity here.
// Privacy posture: only the opaque Firebase UID, never email or display name.
import * as Sentry from '@sentry/capacitor'

// ── Module-level state (onboarding carousel) ──
let _obSlideIndex = 0;
let _obTotalSlides = 9;

// ═══════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════

async function obCheck() {
  try {
    const udb = _udb();
    if (udb) {
      const doc = await udb.collection('profile').doc('onboarding').get();
      if (doc.exists && doc.data().complete) {
        initFirebaseLoad();
        return;
      }
    }
  } catch(e) {}
  obShow();
}

function obShow() {
  document.getElementById('ob-overlay').classList.add('ob-active');
  document.getElementById('ob-tos').style.display = 'flex';
  document.getElementById('ob-carousel').style.display = 'none';
}

function obStartTour() {
  document.getElementById('ob-tos').style.display = 'none';
  const car = document.getElementById('ob-carousel');
  car.style.display = 'flex';
  _obSlideIndex = 0;
  _obRenderDots();
  _obUpdateSlide();
  _obInitSwipe();
}

function _obRenderDots() {
  const wrap = document.getElementById('ob-dots');
  wrap.innerHTML = '';
  for (var i = 0; i < _obTotalSlides; i++) {
    var d = document.createElement('button');
    d.className = 'ob-dot' + (i === 0 ? ' ob-dot-active' : '');
    d.setAttribute('aria-label', 'Slide ' + (i + 1));
    (function(idx){ d.onclick = function(){ _obGoTo(idx); }; })(i);
    wrap.appendChild(d);
  }
}

function _obGoTo(idx) {
  _obSlideIndex = idx;
  _obUpdateSlide();
}

function _obUpdateSlide() {
  document.getElementById('ob-slides').style.transform = 'translateX(-' + (_obSlideIndex * 100) + '%)';
  document.querySelectorAll('.ob-dot').forEach(function(d, i) {
    d.classList.toggle('ob-dot-active', i === _obSlideIndex);
  });
  var back = document.getElementById('ob-btn-back');
  var next = document.getElementById('ob-btn-next');
  var skip = document.getElementById('ob-btn-skip');
  back.style.display = _obSlideIndex > 0 ? '' : 'none';
  skip.style.display = _obSlideIndex === 0 ? '' : 'none';
  var isLast = _obSlideIndex === _obTotalSlides - 1;
  if (isLast) {
    next.textContent = "LET'S GO →";
    next.style.background = 'var(--amber)';
    next.style.borderColor = 'var(--amber)';
    next.style.color = '#0e0e0e';
    next.style.boxShadow = '0 6px 28px rgba(201,160,39,0.4)';
  } else {
    next.textContent = 'NEXT →';
    next.style.background = 'var(--s3)';
    next.style.borderColor = 'var(--s3)';
    next.style.color = '#fff';
    next.style.boxShadow = '0 5px 22px rgba(0,107,117,0.35)';
  }
}

function obSlide(dir) {
  if (dir === 1 && _obSlideIndex === _obTotalSlides - 1) {
    obComplete();
    return;
  }
  _obSlideIndex = Math.max(0, Math.min(_obTotalSlides - 1, _obSlideIndex + dir));
  _obUpdateSlide();
}

async function obComplete() {
  document.getElementById('ob-overlay').classList.remove('ob-active');
  try {
    var udb = _udb();
    if (udb) {
      await udb.collection('profile').doc('onboarding').set({ complete: true, completedAt: Date.now() });
    }
  } catch(e) {}
  initFirebaseLoad();
}

function _obInitSwipe() {
  var startX = 0;
  var track = document.getElementById('ob-slides').parentElement;
  track.addEventListener('touchstart', function(e){ startX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', function(e){
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) obSlide(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ═══════════════════════════════════════════
// AUTH — SIGN IN / REGISTER / SIGN OUT
// ═══════════════════════════════════════════

// Apple Sign-In requires a nonce to prevent replay attacks. Generate one
// locally, pass the SHA-256 hash to Apple, and the raw value to Firebase.
function _generateNonce(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, function(v) { return chars[v % chars.length]; }).join('');
}

async function _sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// Hide Google sign-in on iOS PWA — OAuth redirect breaks in that context.
// Capacitor native uses the @capacitor-firebase/authentication plugin path
// which DOES work in WKWebView, so the hide must skip when running native.
if (window.navigator.standalone === true && !window.Capacitor?.isNativePlatform?.()) {
  document.querySelectorAll('.si-btn-google, .si-divider').forEach(function(el) {
    el.style.display = 'none';
  });
}
// Show Sign in with Apple only on native Capacitor — web path requires
// a Service ID registered with Apple (future work if web Apple sign-in needed).
if (window.Capacitor?.isNativePlatform?.()) {
  document.querySelectorAll('.si-btn-apple').forEach(function(el) {
    el.style.display = '';
  });
}

function siShowTab(tab) {
  document.getElementById('si-panel-signin').style.display = tab === 'signin' ? '' : 'none';
  document.getElementById('si-panel-register').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('si-tab-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('si-tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('si-error').textContent = '';
}

function siSetError(msg) {
  document.getElementById('si-error').textContent = msg;
}

function siSignIn() {
  if (!auth) return siSetError('Auth not available.');
  const email = document.getElementById('si-email').value.trim();
  const pw = document.getElementById('si-password').value;
  if (!email || !pw) return siSetError('Please enter your email and password.');
  siSetError('');
  auth.signInWithEmailAndPassword(email, pw)
    .catch(function(e) { siSetError(_siAuthError(e.code)); });
}

function siCreateAccount() {
  if (!auth) return siSetError('Auth not available.');
  const name = document.getElementById('si-reg-name').value.trim();
  const email = document.getElementById('si-reg-email').value.trim();
  const pw = document.getElementById('si-reg-password').value;
  const confirm = document.getElementById('si-reg-confirm').value;
  if (!name) return siSetError('Please enter your name.');
  if (!email) return siSetError('Please enter your email.');
  if (pw.length < 6) return siSetError('Password must be at least 6 characters.');
  if (pw !== confirm) return siSetError('Passwords do not match.');
  siSetError('');
  auth.createUserWithEmailAndPassword(email, pw)
    .then(function(cred) {
      return Promise.all([
        cred.user.updateProfile({ displayName: name }),
        db ? db.collection('users').doc(cred.user.uid).collection('profile').doc('info').set({
          displayName: name, email: email, createdAt: Date.now()
        }) : Promise.resolve()
      ]);
    })
    .catch(function(e) { siSetError(_siAuthError(e.code)); });
}

async function siGoogleSignIn() {
  if (!auth) return siSetError('Auth not available.');
  siSetError('');

  // Native Capacitor path: native iOS Google Sign-In SDK via plugin.
  // signInWithRedirect/Popup is broken in WKWebView; the plugin opens
  // the system in-app auth sheet, returns an OAuth credential, and we
  // hand it to the JS Firebase SDK so JS-side auth state stays the
  // single source of truth (skipNativeAuth: true in capacitor.config).
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const result = await FirebaseAuthentication.signInWithGoogle();
      if (!result || !result.credential || !result.credential.idToken) {
        return siSetError('Google sign-in was cancelled.');
      }
      const credential = firebase.auth.GoogleAuthProvider.credential(
        result.credential.idToken,
        result.credential.accessToken
      );
      await auth.signInWithCredential(credential);
      return;
    } catch(e) {
      return siSetError(_siAuthError(e && e.code) || (e && e.message) || 'Google sign-in failed.');
    }
  }

  // Web path: popup-based sign-in. Redirect breaks because Firebase's
  // auth handler iframe ({authDomain}.firebaseapp.com) can't access its
  // own storage in the third-party context that modern browsers (Edge
  // tracking prevention, Safari ITP, Chrome partitioned storage) enforce
  // — getRedirectResult returns {credential:null, user:null} after Google
  // bounces back. Popup avoids the cross-origin iframe entirely.
  // iOS Safari PWA case is handled separately by the visibility guard at
  // the top of this file (button hidden when window.navigator.standalone
  // is true and Capacitor is not native).
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .then(function() { return auth.signInWithPopup(provider); })
    .catch(function(e) {
      // Filter the two benign popup-cancel codes — user closing the
      // popup or initiating a second one is not an error to surface.
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        siSetError(_siAuthError(e.code));
      }
    });
}

async function siAppleSignIn() {
  if (!auth) return siSetError('Auth not available.');
  siSetError('');

  // Native Capacitor path — uses the system Apple sign-in sheet (ASAuthorizationController).
  // signInWithPopup is not available in WKWebView; the plugin opens the native sheet
  // and returns an idToken + rawNonce we exchange with Firebase.
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const rawNonce = _generateNonce(32);
      const hashedNonce = await _sha256Hex(rawNonce);
      const result = await FirebaseAuthentication.signInWithApple({ nonce: hashedNonce });
      if (!result || !result.credential || !result.credential.idToken) {
        return siSetError('Apple sign-in was cancelled.');
      }
      const provider = new firebase.auth.OAuthProvider('apple.com');
      const credential = provider.credential({ idToken: result.credential.idToken, rawNonce: rawNonce });
      await auth.signInWithCredential(credential);
      return;
    } catch(e) {
      return siSetError(_siAuthError(e && e.code) || (e && e.message) || 'Apple sign-in failed.');
    }
  }

  // Web fallback via popup (requires Apple Service ID configured in Firebase console).
  const provider = new firebase.auth.OAuthProvider('apple.com');
  auth.signInWithPopup(provider)
    .catch(function(e) {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        siSetError(_siAuthError(e.code) || e.message || 'Apple sign-in failed.');
      }
    });
}

function siForgotPassword() {
  if (!auth) return siSetError('Auth not available.');
  const email = document.getElementById('si-email').value.trim();
  if (!email) return siSetError('Enter your email above first.');
  auth.sendPasswordResetEmail(email)
    .then(function() { siSetError('Password reset email sent — check your inbox.'); })
    .catch(function(e) { siSetError(_siAuthError(e.code)); });
}

async function glMigrateData() {
  if (!_currentUser || !db) return;
  const uref = db.collection('users').doc(_currentUser.uid);
  const log = [];

  // Single documents
  const singles = [
    ['sessions','active'],['timesheetMeta','archivedWeeks'],['timesheetMeta','config'],
    ['settings','projectConfig'],['settings','presets'],['settings','phases'],['settings','cardTitles'],
    ['config','checklist'],['config','flags'],['kml','layers'],
    ['compliance','entries'],['appConfig','reportSettings'],
  ];
  for (const [col, docId] of singles) {
    try {
      const snap = await db.collection(col).doc(docId).get();
      if (snap.exists) {
        await uref.collection(col).doc(docId).set(snap.data());
        log.push('✓ ' + col + '/' + docId);
      } else {
        log.push('— ' + col + '/' + docId + ' (empty)');
      }
    } catch(e) { log.push('✗ ' + col + '/' + docId + ': ' + e.message); }
  }

  // Collections with multiple docs
  const cols = ['timesheetEntries','timesheetWeeks','photos','dailyLogs','fieldMarkers','dayNotes'];
  for (const col of cols) {
    try {
      const snap = await db.collection(col).get();
      for (const doc of snap.docs) {
        await uref.collection(col).doc(doc.id).set(doc.data());
      }
      log.push('✓ ' + col + ' (' + snap.size + ' docs)');
    } catch(e) { log.push('✗ ' + col + ': ' + e.message); }
  }
  return log;
}

function glRunMigration() {
  _confirmModal(
    'This will copy all existing data to your user account. Original data is not deleted — you can verify before removing it from Firebase console.',
    async function() {
      setSyncStatus('syncing');
      const el = document.getElementById('cfg-migrate-btn');
      if (el) { el.disabled = true; el.textContent = 'Migrating…'; }
      try {
        const log = await glMigrateData();
        setSyncStatus('synced');
        if (el) { el.disabled = false; el.textContent = 'Migrate Data'; }
        _confirmModal('Migration complete:\n\n' + log.join('\n'), function(){}, '✓ Migration Complete', 'Done');
      } catch(e) {
        setSyncStatus('offline');
        if (el) { el.disabled = false; el.textContent = 'Migrate Data'; }
        _confirmModal('Migration failed: ' + e.message, null, '✗ Migration Failed', 'Close');
      }
    },
    'Migrate Data', 'Migrate'
  );
}

async function glMigrateStorage() {
  if (!_currentUser || !storage || !_udb()) return [];
  const uid = _currentUser.uid;
  const log = [];

  // ── Photos ──
  let photosSaved = false;
  for (const p of _phPhotos) {
    if (!p.storageUrl || !p.filename) { log.push('— photos/' + p.id + ' (no storageUrl)'); continue; }
    if (p.storageUrl.includes(`photos%2F${uid}%2F`)) { log.push('— photos/' + p.id + ' (already migrated)'); continue; }
    try {
      const resp = await fetch(p.storageUrl);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const snapshot = await storage.ref(`photos/${uid}/${p.id}/${p.filename}`).put(blob);
      p.storageUrl = await snapshot.ref.getDownloadURL();
      await _udb().collection('photos').doc(p.id).update({ storageUrl: p.storageUrl });
      log.push('✓ photos/' + p.id);
      photosSaved = true;
    } catch(e) { log.push('✗ photos/' + p.id + ': ' + e.message); }
  }
  if (photosSaved) phSaveLocal();

  // ── KML ──
  try {
    const doc = await _udb().collection('kml').doc('layers').get();
    if (!doc.exists) { log.push('— kml/layers (empty)'); }
    else {
      const layers = doc.data().data || [];
      const seenPaths = {};
      const updatedLayers = [];
      for (const layer of layers) {
        if (!layer.storagePath) { updatedLayers.push(layer); continue; }
        const oldPath = layer.storagePath;
        if (oldPath.startsWith(`kml/${uid}/`)) { updatedLayers.push(layer); log.push('— ' + oldPath + ' (already migrated)'); continue; }
        if (seenPaths[oldPath] !== undefined) { updatedLayers.push({...layer, storagePath: seenPaths[oldPath]}); continue; }
        const newPath = `kml/${uid}/${oldPath.replace('kml/', '')}`;
        try {
          const url = await storage.ref(oldPath).getDownloadURL();
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          await storage.ref(newPath).put(await resp.blob());
          seenPaths[oldPath] = newPath;
          updatedLayers.push({...layer, storagePath: newPath});
          log.push('✓ ' + oldPath + ' → kml/' + uid.slice(0,8) + '/...');
        } catch(e) { seenPaths[oldPath] = oldPath; updatedLayers.push(layer); log.push('✗ ' + oldPath + ': ' + e.message); }
      }
      const anyMoved = layers.some((l,i) => updatedLayers[i] && l.storagePath !== updatedLayers[i].storagePath);
      if (anyMoved) {
        await _udb().collection('kml').doc('layers').set({data: updatedLayers, _ts: Date.now()});
        _mapKmlLayers.forEach(l => { const u = updatedLayers.find(x=>x.id===l.id); if(u) l.storagePath = u.storagePath; });
        localStorage.setItem('gl_kml_layers', JSON.stringify(updatedLayers));
        log.push('✓ KML metadata updated');
      }
    }
  } catch(e) { log.push('✗ KML: ' + e.message); }

  return log;
}

function glRunStorageMigration() {
  _confirmModal(
    'This will copy your photos and KML files to your user folder in Storage. Original files are not deleted — verify in Firebase console before removing them.',
    async function() {
      setSyncStatus('syncing');
      const el = document.getElementById('cfg-migrate-storage-btn');
      if (el) { el.disabled = true; el.textContent = 'Migrating…'; }
      try {
        const log = await glMigrateStorage();
        setSyncStatus('synced');
        if (el) { el.disabled = false; el.textContent = 'Migrate Storage'; }
        _confirmModal('Storage migration complete:\n\n' + log.join('\n'), function(){}, '✓ Storage Migration Complete', 'Done');
      } catch(e) {
        setSyncStatus('offline');
        if (el) { el.disabled = false; el.textContent = 'Migrate Storage'; }
        _confirmModal('Migration failed: ' + e.message, function(){}, '✗ Migration Failed', 'Close');
      }
    },
    'Migrate Storage', 'Migrate'
  );
}

function glSignOut() {
  if (!auth) return;
  _confirmModal('Sign out of GroundLog on this device?', function() {
    auth.signOut();
  }, 'Sign Out', 'Sign Out');
}

function _siAuthError(code) {
  const map = {
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-email': 'Invalid email address.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts — try again later.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/invalid-credential': 'Incorrect email or password.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// ═══════════════════════════════════════════
// AUTH STATE — called by db.js after Firebase init sets window.auth
// ═══════════════════════════════════════════

function _initAuth() {
  window.auth.getRedirectResult().catch(function(e) {
    if (e.code && e.code !== 'auth/no-current-user') {
      const errEl = document.getElementById('si-error');
      if (errEl) errEl.textContent = _siAuthError(e.code);
    }
  });
  window.auth.onAuthStateChanged(function(user) {
    document.getElementById('page-auth-loading').style.display = 'none';
    if (user) {
      window._currentUser = user;
      // Tag Sentry events with the opaque UID only (no email/name) so we
      // can correlate per-user issues without leaking PII to Sentry.
      Sentry.setUser({ id: user.uid });
      document.getElementById('page-signin').style.display = 'none';
      obCheck();
    } else {
      window._currentUser = null;
      // Clear Sentry user identity so post-signout errors aren't attributed
      // to the prior user.
      Sentry.setUser(null);
      // Reset Firestore-ready flag on sign-out so any pending debounced
      // writes (cloudSave, autosave, etc.) fail-safe instead of firing
      // _udb()→null→.collection() and crashing. Re-set true by
      // initFirebaseLoad on next sign-in.
      window._fbReady = false;
      document.getElementById('page-signin').style.display = 'flex';
    }
  });
}

// ═══════════════════════════════════════════
// ACCOUNT SETTINGS
// ═══════════════════════════════════════════

function acctRenderLinkedProviders() {
  const user = window._currentUser;
  if (!user) return;
  const providers = user.providerData || [];
  const providerIds = providers.map(function(p) { return p.providerId; });

  const list = document.getElementById('acct-linked-list');
  if (list) {
    const canUnlink = providers.length > 1;
    list.innerHTML = providers.map(function(p) {
      const name = p.providerId === 'google.com' ? 'Google'
                 : p.providerId === 'apple.com'  ? 'Apple'
                 : p.providerId === 'password'   ? 'Email & Password'
                 : p.providerId;
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">'
        + '<span style="font-family:var(--mono);font-size:12px;color:var(--text)">' + name + '</span>'
        + (canUnlink ? '<button class="btn btn-outline" style="font-size:10px;padding:4px 10px;color:var(--muted)" onclick="acctUnlink(\'' + p.providerId + '\')">Unlink</button>' : '')
        + '</div>';
    }).join('');
  }

  // Link Apple — native only, hidden if already linked
  const linkAppleBtn = document.getElementById('acct-link-apple-btn');
  if (linkAppleBtn) {
    const isNative = window.Capacitor?.isNativePlatform?.();
    linkAppleBtn.style.display = (isNative && !providerIds.includes('apple.com')) ? '' : 'none';
  }

  // Link Google — hidden if already linked
  const linkGoogleBtn = document.getElementById('acct-link-google-btn');
  if (linkGoogleBtn) {
    linkGoogleBtn.style.display = providerIds.includes('google.com') ? 'none' : '';
  }

  // Link Email & Password — hidden if already linked
  const linkEmailBtn = document.getElementById('acct-link-email-btn');
  if (linkEmailBtn) {
    linkEmailBtn.style.display = providerIds.includes('password') ? 'none' : '';
  }
}

async function acctLinkApple() {
  const user = window._currentUser;
  if (!user) return;
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const rawNonce = _generateNonce(32);
      const hashedNonce = await _sha256Hex(rawNonce);
      const result = await FirebaseAuthentication.signInWithApple({ nonce: hashedNonce });
      if (!result?.credential?.idToken) return _acctShowStatus('acct-link-status', 'Apple sign-in was cancelled.', true);
      const provider = new firebase.auth.OAuthProvider('apple.com');
      const credential = provider.credential({ idToken: result.credential.idToken, rawNonce: rawNonce });
      await user.linkWithCredential(credential);
    } else {
      await user.linkWithPopup(new firebase.auth.OAuthProvider('apple.com'));
    }
    window._currentUser = auth.currentUser;
    acctRenderLinkedProviders();
    _acctShowStatus('acct-link-status', '✓ Apple linked', false);
  } catch(e) {
    const msg = e.code === 'auth/credential-already-in-use'
      ? 'This Apple account is already linked to another GroundLog account.'
      : (e.message || 'Could not link Apple.');
    _acctShowStatus('acct-link-status', msg, true);
  }
}

async function acctLinkGoogle() {
  const user = window._currentUser;
  if (!user) return;
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const result = await FirebaseAuthentication.signInWithGoogle();
      if (!result?.credential?.idToken) return _acctShowStatus('acct-link-status', 'Google sign-in was cancelled.', true);
      const credential = firebase.auth.GoogleAuthProvider.credential(result.credential.idToken, result.credential.accessToken);
      await user.linkWithCredential(credential);
    } else {
      await user.linkWithPopup(new firebase.auth.GoogleAuthProvider());
    }
    window._currentUser = auth.currentUser;
    acctRenderLinkedProviders();
    _acctShowStatus('acct-link-status', '✓ Google linked', false);
  } catch(e) {
    const msg = e.code === 'auth/credential-already-in-use'
      ? 'This Google account is already linked to another GroundLog account.'
      : (e.message || 'Could not link Google.');
    _acctShowStatus('acct-link-status', msg, true);
  }
}

function acctShowLinkEmailForm() {
  const form = document.getElementById('acct-link-email-form');
  const btn = document.getElementById('acct-link-email-btn');
  if (form) form.style.display = '';
  if (btn) btn.style.display = 'none';
}

function acctHideLinkEmailForm() {
  const form = document.getElementById('acct-link-email-form');
  const btn = document.getElementById('acct-link-email-btn');
  if (form) form.style.display = 'none';
  const emailInput = document.getElementById('acct-link-email');
  const pwInput = document.getElementById('acct-link-email-pw');
  if (emailInput) emailInput.value = '';
  if (pwInput) pwInput.value = '';
  const user = window._currentUser;
  const linked = (user?.providerData || []).some(function(p){ return p.providerId === 'password'; });
  if (btn) btn.style.display = linked ? 'none' : '';
}

function acctLinkEmail() {
  const user = window._currentUser;
  if (!user) return;
  const email = (document.getElementById('acct-link-email')?.value || '').trim();
  const pw = document.getElementById('acct-link-email-pw')?.value || '';
  if (!email) return _acctShowStatus('acct-link-status', 'Enter an email address.', true);
  if (pw.length < 6) return _acctShowStatus('acct-link-status', 'Password must be at least 6 characters.', true);
  const credential = firebase.auth.EmailAuthProvider.credential(email, pw);
  user.linkWithCredential(credential)
    .then(function() {
      window._currentUser = auth.currentUser;
      acctHideLinkEmailForm();
      acctRenderLinkedProviders();
      _acctShowStatus('acct-link-status', '✓ Email & Password linked', false);
    })
    .catch(function(e) {
      const msg = e.code === 'auth/email-already-in-use'
        ? 'That email is already linked to another GroundLog account.'
        : e.code === 'auth/invalid-email'
        ? 'Invalid email address.'
        : (e.message || 'Could not link email.');
      _acctShowStatus('acct-link-status', msg, true);
    });
}

function acctUnlink(providerId) {
  const user = window._currentUser;
  if (!user) return;
  if ((user.providerData || []).length <= 1) {
    return _acctShowStatus('acct-link-status', 'Cannot remove the only sign-in method.', true);
  }
  const name = providerId === 'google.com' ? 'Google'
             : providerId === 'apple.com'  ? 'Apple'
             : providerId === 'password'   ? 'Email & Password'
             : providerId;
  _confirmModal('Remove ' + name + ' as a sign-in method?', function() {
    user.unlink(providerId)
      .then(function() {
        window._currentUser = auth.currentUser;
        acctRenderLinkedProviders();
        _acctShowStatus('acct-link-status', '✓ ' + name + ' unlinked', false);
      })
      .catch(function(e) { _acctShowStatus('acct-link-status', e.message || 'Could not unlink.', true); });
  }, 'Unlink ' + name, 'Unlink');
}

function acctInitPage() {
  const user = window._currentUser;
  if (!user) return;

  const nameEl = document.getElementById('acct-display-name');
  if (nameEl) nameEl.value = user.displayName || '';

  const emailEl = document.getElementById('acct-email');
  if (emailEl) emailEl.value = user.email || '';

  const provEl = document.getElementById('acct-providers');
  if (provEl) {
    const providers = (user.providerData || []).map(function(p) {
      if (p.providerId === 'google.com') return 'Google';
      if (p.providerId === 'password') return 'Email & Password';
      return p.providerId;
    });
    provEl.value = providers.length ? providers.join(', ') : '—';
  }

  // Sync theme buttons to current active theme
  const storedTheme = localStorage.getItem('phinest_theme') || 'dark';
  ['dark', 'light', 'system'].forEach(function(t) {
    const btn = document.getElementById('acct-theme-' + t);
    if (btn) btn.classList.toggle('active', t === storedTheme);
  });

  // Reset change-password form
  acctHideChangePassword();
  const pwNew = document.getElementById('acct-pw-new');
  const pwConfirm = document.getElementById('acct-pw-confirm');
  if (pwNew) pwNew.value = '';
  if (pwConfirm) pwConfirm.value = '';

  // Reset status spans
  ['acct-name-status', 'acct-verify-status', 'acct-pw-status', 'acct-link-status'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.style.opacity = '0'; }
  });

  acctRenderLinkedProviders();
}

function _acctShowStatus(id, msg, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : 'var(--green)';
  el.style.opacity = '1';
  setTimeout(function() { el.style.opacity = '0'; }, 3000);
}

function acctSaveName() {
  const user = window._currentUser;
  if (!user) return;
  const name = (document.getElementById('acct-display-name')?.value || '').trim();
  if (!name) return _acctShowStatus('acct-name-status', 'Enter a display name.', true);
  user.updateProfile({ displayName: name })
    .then(function() { _acctShowStatus('acct-name-status', '✓ Saved', false); })
    .catch(function(e) { _acctShowStatus('acct-name-status', e.message || 'Error saving name.', true); });
}

function acctShowChangePassword() {
  const form = document.getElementById('acct-pw-form');
  const btn = document.getElementById('acct-pw-toggle');
  if (form) form.style.display = '';
  if (btn) btn.style.display = 'none';
}

function acctHideChangePassword() {
  const form = document.getElementById('acct-pw-form');
  const btn = document.getElementById('acct-pw-toggle');
  if (form) form.style.display = 'none';
  if (btn) btn.style.display = '';
}

function acctChangePassword() {
  const user = window._currentUser;
  if (!user) return;
  const newPw = document.getElementById('acct-pw-new')?.value || '';
  const confirmPw = document.getElementById('acct-pw-confirm')?.value || '';
  if (newPw.length < 6) return _acctShowStatus('acct-pw-status', 'Password must be at least 6 characters.', true);
  if (newPw !== confirmPw) return _acctShowStatus('acct-pw-status', 'Passwords do not match.', true);
  user.updatePassword(newPw)
    .then(function() {
      _acctShowStatus('acct-pw-status', '✓ Password updated', false);
      document.getElementById('acct-pw-new').value = '';
      document.getElementById('acct-pw-confirm').value = '';
      acctHideChangePassword();
    })
    .catch(function(e) { _acctShowStatus('acct-pw-status', e.message || 'Error updating password.', true); });
}

function acctSendVerificationEmail() {
  const user = window._currentUser;
  if (!user) return;
  user.sendEmailVerification()
    .then(function() { _acctShowStatus('acct-verify-status', '✓ Verification email sent', false); })
    .catch(function(e) { _acctShowStatus('acct-verify-status', e.message || 'Error sending email.', true); });
}

function acctDeleteAccount() {
  const user = window._currentUser;
  if (!user) return;
  _confirmModal(
    'Permanently delete your GroundLog account and all data? This cannot be undone.',
    function() {
      user.delete()
        .catch(function(e) {
          _confirmModal(e.message || 'Could not delete account. You may need to sign out and sign back in first.', null, 'Delete Failed', 'Close');
        });
    },
    'Delete Account', 'Delete'
  );
}

// ── Window exposure ──
window._initAuth = _initAuth;
window.obCheck = obCheck;
window.obStartTour = obStartTour;
window.obSlide = obSlide;
window.obComplete = obComplete;
window._obGoTo = _obGoTo;
window.siShowTab = siShowTab;
window.siSignIn = siSignIn;
window.siCreateAccount = siCreateAccount;
window.siGoogleSignIn = siGoogleSignIn;
window.siAppleSignIn = siAppleSignIn;
window.siForgotPassword = siForgotPassword;
window.glSignOut = glSignOut;
window.glRunMigration = glRunMigration;
window.glRunStorageMigration = glRunStorageMigration;
window.acctInitPage = acctInitPage;
window.acctRenderLinkedProviders = acctRenderLinkedProviders;
window.acctLinkApple = acctLinkApple;
window.acctLinkGoogle = acctLinkGoogle;
window.acctLinkEmail = acctLinkEmail;
window.acctShowLinkEmailForm = acctShowLinkEmailForm;
window.acctHideLinkEmailForm = acctHideLinkEmailForm;
window.acctUnlink = acctUnlink;
window.acctSaveName = acctSaveName;
window.acctShowChangePassword = acctShowChangePassword;
window.acctHideChangePassword = acctHideChangePassword;
window.acctChangePassword = acctChangePassword;
window.acctSendVerificationEmail = acctSendVerificationEmail;
window.acctDeleteAccount = acctDeleteAccount;
