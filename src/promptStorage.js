// ═══════════════════════════════════════════
// PROMPT STORAGE — Firestore I/O for AI prompt config
// ═══════════════════════════════════════════
//
// Persistence layer for the AI & Branding subpage. All paths live under the
// user-sovereign namespace (`users/{uid}/...`).
//
// USER-SOVEREIGN ARCHITECTURE — see memory project_user_sovereign_architecture.md
// ─────────────────────────────────────────────────────────────────────────────
// The user doc is the unit of identity and never moves. Firm docs and
// firm-override docs are added as additional layers in Phase 2 — this file
// is unchanged by that migration. Audit log path is permanent.
//
// PATHS
// ─────
// users/{uid}/settings/reportPrompt
//   → current personal prompt config (the "live" doc)
//   → also carries meta fields: latestVersion, updatedAt, updatedAtMs
//
// users/{uid}/settings/reportPrompt/versions/{vN}
//   → append-only version history (one doc per Save click)
//   → each carries: { version, content, createdAt, createdAtMs, action? }
//   → action: 'save' (default) | 'reset' (defaults restored)
//
// users/{uid}/settings/reportPrompt/auditLog/{auto-id}
//   → thin metadata index pointing to versions/
//   → one entry per Save / Reset event
//   → carries: { eventId, action, version, changedFieldPaths, actorUid, timestamp }
//
// users/{uid}/projectPromptOverrides/{projectId}
//   → per-project override doc (single layer)
//   → No UI in Phase 1 — read+merge logic only (dogfood via DevTools).
//   → Purpose: validate the layer-cake design before Phase 2 surfaces it.
//
// MIGRATION CONTRACT (Phase 2 multi-tenant)
// ─────────────────────────────────────────
// - Personal prompt path stays at users/{uid}/settings/reportPrompt forever.
// - Versions and audit log paths stay forever.
// - Project override migrates from users/{uid}/projectPromptOverrides/{projectId}
//   to users/{uid}/projects/{projectId}/promptOverride when project structure
//   deepens — but the DATA is unchanged, only the path. Existing data copied.
// - Firm baseline doc (Phase 2) lives at firms/{firmId}/settings/reportPrompt
//   with the same schema as the personal doc plus per-field `lockedByFirm` flag.
// - Firm-user override (Phase 2) lives at users/{uid}/firmOverrides/{firmId}/reportPrompt.
//
// LAZY SEEDING (per Decision 5A)
// ──────────────────────────────
// The personal prompt doc only exists when the user has explicitly saved.
// Until then, loadPersonalPrompt() returns null and the merge stack falls
// through to PROMPT_DEFAULTS as the only layer. "Reset to default" deletes
// the doc — version history and audit log are preserved (append-only forever).

// ─────────────────────────────────────────────────────────────────────────
// LOAD — returns null if missing (no error). Errors logged, never thrown.
// ─────────────────────────────────────────────────────────────────────────

// Load the user's current personal prompt config doc.
// Returns: the content fields only (meta fields stripped), or null.
async function loadPersonalPrompt() {
  if (!db || !_currentUser || !_fbReady) return null;
  try {
    const snap = await _udb().collection('settings').doc('reportPrompt').get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    // Strip meta fields, return just the schema content
    const { latestVersion, updatedAt, updatedAtMs, ...content } = data;
    return content;
  } catch (e) {
    console.warn('[prompt-storage] loadPersonalPrompt failed:', e);
    return null;
  }
}

// Load the per-project override doc (no UI in Phase 1; dogfood-only).
// Returns the doc content or null.
async function loadProjectOverride(projectId) {
  if (!db || !_currentUser || !_fbReady || !projectId) return null;
  try {
    const snap = await _udb().collection('projectPromptOverrides').doc(projectId).get();
    if (!snap.exists) return null;
    return snap.data() || null;
  } catch (e) {
    console.warn('[prompt-storage] loadProjectOverride failed:', e);
    return null;
  }
}

// Load full version history, newest first. Capped to a sane upper bound
// because version subcollections grow without bound across the lifetime
// of a user. UI shows a paginated view; raw load is for the reverter.
async function loadPromptVersions(limit = 100) {
  if (!db || !_currentUser || !_fbReady) return [];
  try {
    const snap = await _udb().collection('settings').doc('reportPrompt')
      .collection('versions').orderBy('version', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.warn('[prompt-storage] loadPromptVersions failed:', e);
    return [];
  }
}

// Load audit log, newest first. UI surface for "who changed what when."
async function loadPromptAuditLog(limit = 50) {
  if (!db || !_currentUser || !_fbReady) return [];
  try {
    const snap = await _udb().collection('settings').doc('reportPrompt')
      .collection('auditLog').orderBy('timestampMs', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.warn('[prompt-storage] loadPromptAuditLog failed:', e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SAVE — writes current doc + version doc + audit entry in one batch
// ─────────────────────────────────────────────────────────────────────────

// Determine the next version number by reading the highest existing version.
// One read per save — negligible cost; can be optimized to a meta-doc counter
// if write throughput ever matters (it won't at human-edit cadence).
async function _nextVersionNumber() {
  try {
    const snap = await _udb().collection('settings').doc('reportPrompt')
      .collection('versions').orderBy('version', 'desc').limit(1).get();
    if (snap.empty) return 1;
    const top = snap.docs[0].data();
    return (typeof top.version === 'number' ? top.version : 0) + 1;
  } catch (e) {
    console.warn('[prompt-storage] _nextVersionNumber failed, defaulting to 1:', e);
    return 1;
  }
}

// Save a new prompt config. Creates current doc + version doc + audit entry.
// `content` is the full prompt config (matches PROMPT_DEFAULTS shape).
// `changedFieldPaths` is an array of dotted paths describing what changed
// since the last save (e.g. ['toneVoice.formality', 'terminology.banned']).
// Returns the new version number on success; throws on failure.
async function savePersonalPrompt(content, changedFieldPaths) {
  if (!db || !_currentUser || !_fbReady) {
    throw new Error('Not signed in or Firebase not ready');
  }
  if (!content || typeof content !== 'object') {
    throw new Error('savePersonalPrompt: content must be an object');
  }

  const uid = _currentUser.uid;
  const docRef = _udb().collection('settings').doc('reportPrompt');
  const versionsRef = docRef.collection('versions');
  const auditRef = docRef.collection('auditLog');

  const nextVersion = await _nextVersionNumber();
  const now = Date.now();
  const fst = window.firebase.firestore.FieldValue.serverTimestamp();

  // Strip undefined for Firestore-safety (round-trip via JSON)
  const cleanContent = JSON.parse(JSON.stringify(content));

  const batch = db.batch();

  // Current doc — full content + meta fields
  batch.set(docRef, {
    ...cleanContent,
    latestVersion: nextVersion,
    updatedAt: fst,
    updatedAtMs: now
  });

  // Version doc — append-only history
  batch.set(versionsRef.doc('v' + nextVersion), {
    version: nextVersion,
    action: 'save',
    content: cleanContent,
    createdAt: fst,
    createdAtMs: now
  });

  // Audit entry — thin metadata index pointing to the version
  const auditDoc = auditRef.doc();
  batch.set(auditDoc, {
    eventId: auditDoc.id,
    action: 'save',
    version: nextVersion,
    changedFieldPaths: Array.isArray(changedFieldPaths) ? changedFieldPaths.slice(0, 100) : [],
    actorUid: uid,
    timestamp: fst,
    timestampMs: now
  });

  await batch.commit();
  return nextVersion;
}

// ─────────────────────────────────────────────────────────────────────────
// RESET — delete current doc, append a "reset" version + audit entry
// ─────────────────────────────────────────────────────────────────────────
//
// After reset: loadPersonalPrompt() returns null again → merge stack uses
// PROMPT_DEFAULTS only. Versions and audit log preserved (append-only).
// Version count never decrements; the next save lands at v(N+1) where N was
// the previous max, so version numbers remain monotonically increasing.

async function resetPersonalPromptToDefault() {
  if (!db || !_currentUser || !_fbReady) {
    throw new Error('Not signed in or Firebase not ready');
  }

  const uid = _currentUser.uid;
  const docRef = _udb().collection('settings').doc('reportPrompt');
  const versionsRef = docRef.collection('versions');
  const auditRef = docRef.collection('auditLog');

  const nextVersion = await _nextVersionNumber();
  const now = Date.now();
  const fst = window.firebase.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.delete(docRef);

  batch.set(versionsRef.doc('v' + nextVersion), {
    version: nextVersion,
    action: 'reset',
    content: null, // null content signals "reset to defaults"
    createdAt: fst,
    createdAtMs: now
  });

  const auditDoc = auditRef.doc();
  batch.set(auditDoc, {
    eventId: auditDoc.id,
    action: 'reset',
    version: nextVersion,
    changedFieldPaths: [],
    actorUid: uid,
    timestamp: fst,
    timestampMs: now
  });

  await batch.commit();
  return nextVersion;
}

// ─────────────────────────────────────────────────────────────────────────
// REVERT — write a new version that copies an older version's content
// ─────────────────────────────────────────────────────────────────────────
//
// Reverts are non-destructive: the version being reverted to stays in place
// in version history. A new version is appended with the older version's
// content + an audit entry tagged with sourceVersion. This means the
// monotonic version sequence is preserved and the revert is itself history.

async function revertPersonalPromptToVersion(sourceVersion) {
  if (!db || !_currentUser || !_fbReady) {
    throw new Error('Not signed in or Firebase not ready');
  }
  if (typeof sourceVersion !== 'number' || sourceVersion < 1) {
    throw new Error('revertPersonalPromptToVersion: sourceVersion must be a positive integer');
  }

  const uid = _currentUser.uid;
  const docRef = _udb().collection('settings').doc('reportPrompt');
  const versionsRef = docRef.collection('versions');
  const auditRef = docRef.collection('auditLog');

  // Read the source version
  const srcSnap = await versionsRef.doc('v' + sourceVersion).get();
  if (!srcSnap.exists) {
    throw new Error('Version v' + sourceVersion + ' not found');
  }
  const srcData = srcSnap.data();
  const srcContent = srcData && srcData.content;
  if (!srcContent) {
    // Source was a 'reset' marker — revert to defaults instead
    return resetPersonalPromptToDefault();
  }

  const nextVersion = await _nextVersionNumber();
  const now = Date.now();
  const fst = window.firebase.firestore.FieldValue.serverTimestamp();
  const cleanContent = JSON.parse(JSON.stringify(srcContent));

  const batch = db.batch();

  batch.set(docRef, {
    ...cleanContent,
    latestVersion: nextVersion,
    updatedAt: fst,
    updatedAtMs: now
  });

  batch.set(versionsRef.doc('v' + nextVersion), {
    version: nextVersion,
    action: 'revert',
    sourceVersion,
    content: cleanContent,
    createdAt: fst,
    createdAtMs: now
  });

  const auditDoc = auditRef.doc();
  batch.set(auditDoc, {
    eventId: auditDoc.id,
    action: 'revert',
    version: nextVersion,
    sourceVersion,
    changedFieldPaths: [],
    actorUid: uid,
    timestamp: fst,
    timestampMs: now
  });

  await batch.commit();
  return nextVersion;
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE A VERSION FROM HISTORY (Stage 8)
// ─────────────────────────────────────────────────────────────────────────
//
// Removes a single version doc from the versions subcollection and writes
// an audit log entry recording the deletion. The user's CURRENT saved state
// is unaffected — that lives in the parent reportPrompt doc, not in the
// versions subcollection. Deleting the latest version doesn't break next-save
// either: _nextVersionNumber re-queries the subcollection so a fresh save
// after deletion lands at (current_max + 1), preserving monotonicity.

async function deletePromptVersion(versionNum) {
  if (!db || !_currentUser || !_fbReady) {
    throw new Error('Not signed in or Firebase not ready');
  }
  if (typeof versionNum !== 'number' || versionNum < 1) {
    throw new Error('deletePromptVersion: versionNum must be a positive integer');
  }

  const uid = _currentUser.uid;
  const docRef = _udb().collection('settings').doc('reportPrompt');
  const versionsRef = docRef.collection('versions');
  const auditRef = docRef.collection('auditLog');

  const now = Date.now();
  const fst = window.firebase.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.delete(versionsRef.doc('v' + versionNum));

  const auditDoc = auditRef.doc();
  batch.set(auditDoc, {
    eventId: auditDoc.id,
    action: 'delete-version',
    version: versionNum, // the version that was deleted
    actorUid: uid,
    timestamp: fst,
    timestampMs: now
  });

  await batch.commit();
}

// ─────────────────────────────────────────────────────────────────────────
// PROJECT OVERRIDE WRITERS — Phase 1 has no UI; included for dogfooding
// via DevTools and ready for Phase 2 to wire to the editor.
// ─────────────────────────────────────────────────────────────────────────

async function saveProjectOverride(projectId, content) {
  if (!db || !_currentUser || !_fbReady) {
    throw new Error('Not signed in or Firebase not ready');
  }
  if (!projectId) throw new Error('saveProjectOverride: projectId required');
  const cleanContent = JSON.parse(JSON.stringify(content || {}));
  await _udb().collection('projectPromptOverrides').doc(projectId).set({
    ...cleanContent,
    updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
    updatedAtMs: Date.now()
  });
}

async function deleteProjectOverride(projectId) {
  if (!db || !_currentUser || !_fbReady) {
    throw new Error('Not signed in or Firebase not ready');
  }
  if (!projectId) throw new Error('deleteProjectOverride: projectId required');
  await _udb().collection('projectPromptOverrides').doc(projectId).delete();
}

// ── Window exposure ──
window.loadPersonalPrompt = loadPersonalPrompt;
window.loadProjectOverride = loadProjectOverride;
window.loadPromptVersions = loadPromptVersions;
window.loadPromptAuditLog = loadPromptAuditLog;
window.savePersonalPrompt = savePersonalPrompt;
window.resetPersonalPromptToDefault = resetPersonalPromptToDefault;
window.revertPersonalPromptToVersion = revertPersonalPromptToVersion;
window.deletePromptVersion = deletePromptVersion;
window.saveProjectOverride = saveProjectOverride;
window.deleteProjectOverride = deleteProjectOverride;
