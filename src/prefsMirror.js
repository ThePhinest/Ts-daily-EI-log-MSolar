// Per-project VIEW preferences (map label mode, flag visibility, capture
// selections, category order, map style) live in localStorage — tiny, fast,
// the right home for prefs (project_storage_architecture). But the device-uid
// fence + sign-out wipe localStorage on purpose (auth.js _glUidFence), so every
// sign-out reset the map back to defaults (Tim, 8/26 build-160 test). Same
// pattern as the nav-slot mirror (settings.js _glSaveNavSlotsCloud): mirror the
// whitelisted keys into users/{uid}/settings/prefs and hydrate any MISSING keys
// at boot. localStorage stays the source the code reads; the cloud doc is the
// backup that survives the fence and roams across devices.
const _PM_PREFIXES = [
  'gl_lbl_mode::', 'gl_flags_vis::', 'gl_cap_flags::',
  'gl_seed_cap_sel::', 'gl_esc_cap_sel::', 'gl_dist_cap_sel::',
  'gl_tcf_order_', 'gl_tcf_map_', 'gl_tc_order_', 'gl_kfl_order_',
  'gl_map_style',
];
const _pmWatched = (k) => typeof k === 'string' && _PM_PREFIXES.some((p) => k.startsWith(p));
const _pmOrigSet = Storage.prototype.setItem;
const _pmOrigRemove = Storage.prototype.removeItem;
let _pmPending = {};
let _pmTimer = null;
let _pmHydrating = false;

function _pmReady() {
  return !!(window._fbReady && window._currentUser && typeof window._udb === 'function' && window._udb());
}
function _pmFlush() {
  _pmTimer = null;
  const batch = _pmPending; _pmPending = {};
  if (!Object.keys(batch).length || !_pmReady()) return;
  try {
    const FV = window.firebase.firestore.FieldValue;
    const doc = {};
    for (const k of Object.keys(batch)) doc[k] = batch[k] === null ? FV.delete() : batch[k];
    window._udb().collection('settings').doc('prefs').set(doc, { merge: true }).catch(() => {});
  } catch {}
}
function _pmQueue(key, value) {
  _pmPending[key] = value;
  if (_pmTimer) clearTimeout(_pmTimer);
  _pmTimer = setTimeout(_pmFlush, 1500);
}

Storage.prototype.setItem = function (key, value) {
  _pmOrigSet.call(this, key, value);
  if (this === window.localStorage && !_pmHydrating && _pmWatched(key)) _pmQueue(key, String(value));
};
Storage.prototype.removeItem = function (key) {
  _pmOrigRemove.call(this, key);
  if (this === window.localStorage && !_pmHydrating && _pmWatched(key)) _pmQueue(key, null);
};

// Boot: fill in keys the fence wiped. Never overwrite a key the device already
// has (this device's most recent choice wins over an older cloud copy).
async function _glHydratePrefsFromCloud() {
  if (!_pmReady()) return;
  try {
    const snap = await window._udb().collection('settings').doc('prefs').get();
    if (!snap.exists) return;
    const data = snap.data() || {};
    _pmHydrating = true;
    let n = 0;
    for (const k of Object.keys(data)) {
      if (!_pmWatched(k) || typeof data[k] !== 'string') continue;
      if (localStorage.getItem(k) === null) { _pmOrigSet.call(localStorage, k, data[k]); n++; }
    }
    _pmHydrating = false;
    if (n && typeof window.glBootMark === 'function') window.glBootMark('prefs:hydrated ' + n);
  } catch { _pmHydrating = false; }
}
window._glHydratePrefsFromCloud = _glHydratePrefsFromCloud;
