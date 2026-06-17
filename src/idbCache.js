// ═══════════════════════════════════════════
// IndexedDB CACHE — Tier 1 device store
// ═══════════════════════════════════════════
// Storage architecture (locked 2026-06-17, see KB storage-architecture.md):
//   Tier 0 — Firestore (cloud): source of truth
//   Tier 1 — IndexedDB (THIS): large/unbounded device data — photos+thumbnails
//            now; daily logs / tracker / timesheet / compliance / KML next.
//   Tier 2 — localStorage: tiny bounded prefs ONLY (uid stamp, active project,
//            theme, nav slots, map view, flags, today's autosave).
//
// Why this exists: localStorage is ~5 MB (stricter on iOS WKWebView), sync, and
// string-only. ph_photos (base64 thumbnails) filled it to the ceiling, so after
// the uid-fence purge the daily-log history couldn't repopulate — the 6/17
// "calendar only since June 11" regression. IndexedDB gives hundreds of MB+.
//
// Design: reads stay SYNCHRONOUS via an in-memory mirror (_mem) hydrated from
// IDB on boot, so existing phLoadLocal()/dlGetAll()-style call sites don't have
// to become async. Writes are write-through — _mem updates synchronously, IDB
// persists asynchronously. Records are stored ONE KEY PER RECORD (e.g.
// `ph:<id>`) — not one giant blob — so a single change writes one small record
// (a step toward the local-first end state, not just a relocation).
//
// Quota / write failures are REPORTED via window._reportError, never swallowed —
// a silently-swallowed QuotaExceededError is exactly what hid the 6/17 bug.

import {
  set as idbKvSet,
  del as idbKvDel,
  clear as idbKvClear,
  entries as idbKvEntries,
  setMany as idbKvSetMany,
  delMany as idbKvDelMany,
} from 'idb-keyval'

const _mem = new Map();

function _report(where, err) {
  const quota = err && (err.name === 'QuotaExceededError' || (err.message || '').indexOf('quota') !== -1);
  const message = (quota ? 'IndexedDB quota exceeded' : 'IndexedDB write failed') + ' (' + where + ')'
    + (err && err.message ? ': ' + err.message : '');
  console.error('idbCache:', message);
  try {
    if (typeof window._reportError === 'function') {
      window._reportError({ type: 'idb_write', message, stack: err && err.stack ? err.stack : null });
    }
  } catch (_) {}
}

// Hydrate the in-memory mirror from IndexedDB on boot. Anything that reads the
// cache synchronously must first `await window.idbReady`.
window.idbReady = (async function _hydrate() {
  try {
    const all = await idbKvEntries();
    for (const [k, v] of all) _mem.set(k, v);
  } catch (e) {
    console.warn('idbCache hydrate failed:', e && e.message);
  }
})();

// ── Synchronous reads (from the in-memory mirror) ──
window.idbGet = function (key) { return _mem.has(key) ? _mem.get(key) : null; };
window.idbGetPrefix = function (prefix) {
  const out = [];
  for (const [k, v] of _mem) { if (k.indexOf(prefix) === 0) out.push(v); }
  return out;
};
window.idbKeysWithPrefix = function (prefix) {
  const out = [];
  for (const k of _mem.keys()) { if (k.indexOf(prefix) === 0) out.push(k); }
  return out;
};

// ── Write-through writes (sync mem, async persist) ──
window.idbSet = function (key, val) {
  _mem.set(key, val);
  idbKvSet(key, val).catch(e => _report('set ' + key, e));
};
window.idbSetMany = function (pairs) {
  pairs.forEach(([k, v]) => _mem.set(k, v));
  if (pairs.length) idbKvSetMany(pairs).catch(e => _report('setMany(' + pairs.length + ')', e));
};
window.idbDel = function (key) {
  _mem.delete(key);
  idbKvDel(key).catch(e => console.warn('idbCache del failed:', e && e.message));
};
window.idbDelMany = function (keys) {
  keys.forEach(k => _mem.delete(k));
  if (keys.length) idbKvDelMany(keys).catch(e => console.warn('idbCache delMany failed:', e && e.message));
};

// Full purge — used by the device uid-fence (privacy gate): the cross-account
// leak the fence closes must extend to the IDB cache, not just localStorage.
window.idbClearAll = function () {
  _mem.clear();
  return idbKvClear();
};
