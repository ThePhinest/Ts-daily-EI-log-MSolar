// ───────────────────────────────────────────────────────────────────────────
// β.1 — Homegrown JS error reporter.
//
// Captures uncaught JS errors and unhandled promise rejections and writes
// them to Firestore at users/{uid}/_debug/{auto-id} for the developer's UID
// only. Single-user gated; everyone else is a silent no-op.
//
// Privacy posture:
//  - Per-user isolated by existing Firestore security rules (users/{uid}/**)
//  - No third-party egress; data never leaves the project's Firebase
//  - β.2 (next) will replace the hardcoded UID gate with an opt-in toggle in
//    Account Settings + a tightened scrub list before we onboard a 2nd user
//
// Why this exists: iPhone WebView has no Safari Web Inspector available
// without a Mac, so we have no other way to see JS errors in production
// builds. Used to diagnose the map-tile render bug carried over from
// Capacitor Session 3 (Build 5+7+8+12 all show black tiles, mapboxgl chrome
// + photo pins render correctly, suggesting a tile-fetch/render layer issue
// that JS error visibility should illuminate).
//
// Read path: Firebase Console → moraine-ei-log project → Firestore →
// users/{uid}/_debug → sort by serverTs descending. In-app viewer is a
// β.2 task.
//
// Safeguards (in order):
//  1. UID gate — only listed UIDs are enabled
//  2. Per-session cap (50) prevents runaway-loop flooding
//  3. Dedupe within 5s prevents identical-error spam
//  4. try/catch around every write — reporter must never throw
// ───────────────────────────────────────────────────────────────────────────

const ENABLED_UIDS = [
  'Z1RZWSUTXfR1Ys76VMd8FTqydaq1', // Tim
];

const MAX_ERRORS_PER_SESSION = 50;
const DEDUPE_WINDOW_MS = 5000;

let _errorCount = 0;
const _recentErrors = new Map(); // message → last-seen-ts

function _shouldReport() {
  if (_errorCount >= MAX_ERRORS_PER_SESSION) return false;
  const u = window._currentUser;
  if (!u || !u.uid) return false;
  if (!ENABLED_UIDS.includes(u.uid)) return false;
  return true;
}

function _isDuplicate(message) {
  const now = Date.now();
  const last = _recentErrors.get(message);
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  _recentErrors.set(message, now);
  // Tidy old entries when the map grows
  if (_recentErrors.size > 50) {
    for (const [k, v] of _recentErrors) {
      if (now - v > DEDUPE_WINDOW_MS) _recentErrors.delete(k);
    }
  }
  return false;
}

function _platformContext() {
  let platform = 'web';
  try {
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform()) {
      platform = 'native';
    }
  } catch (_) {}
  return {
    clientTs: Date.now(),
    url: location.href,
    pathname: location.pathname,
    hash: location.hash,
    userAgent: navigator.userAgent,
    platform,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    online: navigator.onLine,
  };
}

async function _writeError(payload) {
  try {
    if (!_shouldReport()) return;
    if (_isDuplicate(payload.message)) return;
    _errorCount++;
    const udb = (typeof window._udb === 'function') ? window._udb() : null;
    if (!udb) return;
    await udb.collection('_debug').add({
      ...payload,
      serverTs: window.firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {
    // Reporter must never throw; an error in the error path would loop.
  }
}

window.addEventListener('error', function(event) {
  const err = event.error || {};
  _writeError({
    type: 'error',
    message: event.message || err.message || 'unknown error',
    stack: err.stack || null,
    filename: event.filename || null,
    lineno: event.lineno || null,
    colno: event.colno || null,
    ..._platformContext(),
  });
});

window.addEventListener('unhandledrejection', function(event) {
  const reason = event.reason;
  const message = (reason && reason.message) ? reason.message : String(reason || 'unknown rejection');
  _writeError({
    type: 'unhandledrejection',
    message,
    stack: (reason && reason.stack) ? reason.stack : null,
    ..._platformContext(),
  });
});

// Public helper for non-exception failures that need explicit reporting —
// e.g. Mapbox `map.on('error', ...)` events that don't bubble to window.error,
// WebGL context-lost canvas events, fetch-without-throw failures.
// Call from anywhere with a partial payload; platform context is added here.
// Caller payload should include at minimum {type, message}; stack and any
// custom fields are passed through to Firestore unchanged.
window._reportError = function(payload) {
  try {
    _writeError({
      ...payload,
      ..._platformContext(),
    });
  } catch (_) {
    // Reporter must never throw.
  }
};
