// ═══════════════════════════════════════════
// TIMESHEET MIGRATION v2 — Multi-Project State Isolation
// ═══════════════════════════════════════════
// One-time migration that re-keys localStorage timesheet entries from the
// flat single-date shape  {YYYY-MM-DD: {...}}
// to a compound-key shape {projectId_YYYY-MM-DD: {...}}.
//
// Enables same-day multi-project work without entries bleeding across
// projects, and fixes the 2026-05-07 regression (commit 970e645 Track D)
// where tsGetEntry stopped filtering by project under the wrong assumption
// that "each date can only have one entry."
//
// Foundation for E1.1 Option C (multi-project state isolation rework,
// locked 2026-05-13). See groundlog/wiki/backlog.md § E1.1.
//
// Storage tier (Stage 2c, 2026-06-17): the entry/week/backup blobs this file
// reads and writes (msf_ts_entries, msf_ts_entries_v2, msf_ts_weeks,
// msf_ts_entries_premigrate_v2_backup) live in the Tier-1 IDB cache, NOT
// localStorage — accessed via window.idbGet/idbSet/idbDel (JSON string
// verbatim). The migration FLAGS (msf_ts_migrated_v2[_at]) stay in
// localStorage (Tier 2 tiny prefs). This runs from the tail of
// tsLoadFromFirestore(), after the boot gate has migrated these keys into the
// IDB mirror, so idbGet is populated. See KB storage-architecture.md.
//
// Safety:
//   • Idempotent: re-running re-sweeps but never overwrites existing v2 keys
//   • Backup once: msf_ts_entries → msf_ts_entries_premigrate_v2_backup (IDB)
//     (untouched; 30-day rollback window)
//   • Additive on archived weeks (stamps projectId; no re-key)
//   • Read paths in src/timesheet.js stay compatible during 30-day overlap
//     (Stage 3 dual-writes to both shapes)
//
// Called from:
//   1. src/db.js immediately after window._fbReady = true (local-only sweep)
//   2. tail of tsLoadFromFirestore() (catches cross-device cloud-pulled
//      entries that arrive in old shape from iPhone TestFlight builds)
//
// Safe to delete this file + its wiring after the 30-day overlap window
// ends and the iPhone build has migrated to v2 reads. The TS_BACKUP_KEY
// can also be cleared at that point.

const TS_MIGRATION_FLAG_KEY = 'msf_ts_migrated_v2';
const TS_BACKUP_KEY         = 'msf_ts_entries_premigrate_v2_backup';
const TS_V2_KEY             = 'msf_ts_entries_v2';

// ── projectName → projectId resolution map from gl_known_projects ──
function _tsMigBuildResolutionMap(){
  const known = (typeof window.knownProjectsGet === 'function')
    ? window.knownProjectsGet()
    : [];
  const map = {};
  known.forEach(p => {
    if (p && p.projectName && p.projectId) map[p.projectName] = p.projectId;
  });
  return map;
}

function _tsMigResolveProjectId(entry, resolutionMap, activePid){
  if (entry && entry.projectName && resolutionMap[entry.projectName]){
    return resolutionMap[entry.projectName];
  }
  return activePid; // fallback for genuinely orphan entries (pre-Phase D)
}

// ── Seed per-project tsConfig from current global, only if not already set ──
// Preserves today's behavior (both projects share Tim's current per-diem /
// mileage / hourly settings) while enabling divergence going forward.
function _tsMigSeedPerProjectConfigs(){
  const known = (typeof window.knownProjectsGet === 'function')
    ? window.knownProjectsGet()
    : [];
  let globalCfg = null;
  try { globalCfg = JSON.parse(localStorage.getItem('msf_ts_config') || 'null'); } catch {}
  if (!globalCfg) return 0;
  let seeded = 0;
  known.forEach(p => {
    if (!p || !p.projectId) return;
    const key = 'msf_proj_' + p.projectId + '_ts_config';
    if (localStorage.getItem(key) === null){
      try {
        localStorage.setItem(key, JSON.stringify(globalCfg));
        seeded++;
      } catch {}
    }
  });
  return seeded;
}

// ── Stamp projectId on archived weeks (additive — no re-key) ──
// Archived weeks already carry projectName; this adds projectId so the
// cross-project cumulative filter strip (Session B Stage 5) can prefix-filter.
function _tsMigStampArchivedWeeks(resolutionMap, activePid){
  let stamped = 0;
  try {
    const weeks = JSON.parse((window.idbGet && window.idbGet('msf_ts_weeks')) || '[]');
    weeks.forEach(w => {
      if (!w.projectId){
        w.projectId = (w.projectName && resolutionMap[w.projectName]) || activePid;
        stamped++;
      }
    });
    if (stamped > 0 && window.idbSet){
      window.idbSet('msf_ts_weeks', JSON.stringify(weeks));
    }
  } catch {}
  return stamped;
}

// ── Fire-and-forget Firestore mirror of v2 entries ──
// Writes each entry to users/{uid}/timesheetEntries_v2/{projectId}_{date}.
// Old timesheetEntries collection is left untouched for 30-day overlap;
// Stage 3 write path dual-writes both collections for new edits during that
// window.
function _tsMigMirrorToFirestore(v2Entries){
  try {
    if (typeof window.db === 'undefined' || !window.db || !window._fbReady) return;
    const udb = (typeof window._udb === 'function') ? window._udb() : null;
    if (!udb) return;
    const col = udb.collection('timesheetEntries_v2');
    Object.entries(v2Entries).forEach(([key, entry]) => {
      col.doc(key).set(entry).catch(() => {});
    });
  } catch {}
}

// ── Public entry point ──
// Safe to call repeatedly. Backup + flag are one-shot; re-key sweep runs
// every call (cheap; O(n) over entries). Returns a summary object for
// console diagnostics.
async function runTimesheetMigrationV2(){
  try {
    // Read current old-shape state (Tier-1 IDB cache)
    let oldEntries = {};
    try { oldEntries = JSON.parse((window.idbGet && window.idbGet('msf_ts_entries')) || '{}'); } catch {}
    const oldCount = Object.keys(oldEntries).length;

    // Read existing v2 state (may be partial from a prior run)
    let v2Entries = {};
    try { v2Entries = JSON.parse((window.idbGet && window.idbGet(TS_V2_KEY)) || '{}'); } catch {}
    const v2PreCount = Object.keys(v2Entries).length;

    // First-run housekeeping (only fires once, regardless of entry count).
    // The flag stays in localStorage (Tier 2 tiny pref).
    const firstRun = localStorage.getItem(TS_MIGRATION_FLAG_KEY) !== '1';

    // Backup once on first run if we have entries to migrate (into IDB)
    if (firstRun && oldCount > 0 && (!window.idbGet || window.idbGet(TS_BACKUP_KEY) == null)){
      if (window.idbSet) window.idbSet(TS_BACKUP_KEY, JSON.stringify(oldEntries));
    }

    const resolutionMap = _tsMigBuildResolutionMap();
    const activePid = (typeof window._activeProjectId === 'function')
      ? window._activeProjectId()
      : 'default';

    // Re-key sweep — never overwrite existing v2 keys (v2 wins as newer)
    let migrated = 0, orphansAssigned = 0, newlyMirrored = {};
    const resolutionLog = {};

    Object.entries(oldEntries).forEach(([date, entry]) => {
      const projectId = _tsMigResolveProjectId(entry, resolutionMap, activePid);
      const wasOrphan = !entry.projectName || !resolutionMap[entry.projectName];
      const compoundKey = projectId + '_' + date;

      if (!v2Entries[compoundKey]){
        v2Entries[compoundKey] = Object.assign({}, entry, { projectId, date });
        newlyMirrored[compoundKey] = v2Entries[compoundKey];
        migrated++;
        if (wasOrphan) orphansAssigned++;
      }
      resolutionLog[date] = {
        from: entry.projectName || '(none)',
        to: projectId,
        orphan: wasOrphan,
        wasInV2: !!v2Entries[compoundKey] && !newlyMirrored[compoundKey]
      };
    });

    // Commit v2 store (Tier-1 IDB cache)
    if (window.idbSet) window.idbSet(TS_V2_KEY, JSON.stringify(v2Entries));

    // First-run only — stamp archived weeks + seed per-project configs
    let archivedStamped = 0, configsSeeded = 0;
    if (firstRun){
      archivedStamped = _tsMigStampArchivedWeeks(resolutionMap, activePid);
      configsSeeded = _tsMigSeedPerProjectConfigs();
      localStorage.setItem(TS_MIGRATION_FLAG_KEY, '1');
      localStorage.setItem(TS_MIGRATION_FLAG_KEY + '_at', String(Date.now()));
    }

    // Fire-and-forget Firestore mirror of newly-migrated entries only
    if (migrated > 0){
      _tsMigMirrorToFirestore(newlyMirrored);
    }

    // Diagnostics — full report on first run, compact on incremental sweeps
    if (firstRun){
      console.group('[ts-migration-v2] initial migration complete');
      console.info('Entries:', { oldShape: oldCount, v2Before: v2PreCount, migrated, v2Total: Object.keys(v2Entries).length });
      console.info('Orphans assigned to active project (' + activePid + '):', orphansAssigned);
      console.info('Archived weeks stamped with projectId:', archivedStamped);
      console.info('Per-project ts configs seeded from global:', configsSeeded);
      console.info('Backup at IDB cache key ' + TS_BACKUP_KEY + ' (30-day rollback window)');
      console.info('ProjectId resolution map:', resolutionMap);
      console.info('Per-entry resolution log:', resolutionLog);
      console.groupEnd();
    } else if (migrated > 0){
      console.info('[ts-migration-v2] incremental sweep:', { migrated, orphansAssigned, v2Total: Object.keys(v2Entries).length });
    }

    return {
      ok: true,
      firstRun,
      oldCount,
      migrated,
      orphansAssigned,
      archivedStamped,
      configsSeeded,
      v2Total: Object.keys(v2Entries).length
    };
  } catch(e){
    console.error('[ts-migration-v2] failed:', e && e.message, e && e.stack);
    return { error: e && e.message };
  }
}

// ── Rollback helper (developer/debug only — exposed for console use) ──
// Reverts localStorage to the pre-migration state. Does NOT touch Firestore.
// Console usage:  await tsMigrationRollbackV2()
async function tsMigrationRollbackV2(){
  try {
    // Backup + entry stores live in the Tier-1 IDB cache (JSON string verbatim);
    // migration flags stay in localStorage.
    const backup = window.idbGet && window.idbGet(TS_BACKUP_KEY);
    if (!backup){
      console.warn('[ts-migration-v2] no backup found at ' + TS_BACKUP_KEY);
      return { ok: false, reason: 'no-backup' };
    }
    if (window.idbSet) window.idbSet('msf_ts_entries', backup);
    if (window.idbDel) window.idbDel(TS_V2_KEY);
    localStorage.removeItem(TS_MIGRATION_FLAG_KEY);
    localStorage.removeItem(TS_MIGRATION_FLAG_KEY + '_at');
    console.info('[ts-migration-v2] rolled back to pre-migration localStorage state');
    console.info('[ts-migration-v2] reload the page to re-run boot flow');
    return { ok: true };
  } catch(e){
    console.error('[ts-migration-v2] rollback failed:', e && e.message);
    return { error: e && e.message };
  }
}

window.runTimesheetMigrationV2 = runTimesheetMigrationV2;
window.tsMigrationRollbackV2 = tsMigrationRollbackV2;
