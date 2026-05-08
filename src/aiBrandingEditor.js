// ═══════════════════════════════════════════
// AI & BRANDING EDITOR — UI logic for the AI & Branding subpage
// ═══════════════════════════════════════════
//
// Stage 7-1 (2026-05-08) — minimum-viable editor:
//   - Custom Instructions textarea (only currently-editable field)
//   - Save / Reset to Default buttons wired to promptStorage.js
//   - Effective Prompt Preview (live, debounced ~200ms)
//
// Stages 7-2..7-5 layer in additional editor sections (Tone & Voice,
// Terminology, Structural Preferences, Brand & Identity). Each adds:
//   - markup inside #ai-branding-body
//   - field reads in aiBrandingCollect()
//   - field writes in aiBrandingInit()
//   - path detection in _aiBrandingChangedFieldPaths()
// Save/load/preview plumbing here doesn't change.
//
// USER-SOVEREIGN ARCHITECTURE — see memory project_user_sovereign_architecture.md
// All edits land in users/{uid}/settings/reportPrompt and never move.

// ─────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────

// Last saved snapshot from Firestore (deep-cloned). null if user has never
// saved a personal prompt — in that case PROMPT_DEFAULTS is the implicit
// "last saved state" for dirty-checking purposes.
let _abLastSavedSnapshot = null;

// True when current editor state differs from _abLastSavedSnapshot. Drives
// Save button enabled/disabled.
let _abDirty = false;

// Debounce handle for live preview updates.
let _abPreviewTimer = null;

// ─────────────────────────────────────────────────────────────────────────
// INIT — called from showPage('aiBranding') on every navigation to the page
// ─────────────────────────────────────────────────────────────────────────

async function aiBrandingInit() {
  if (!window.PROMPT_DEFAULTS || !window.assemblePrompt) {
    console.warn('[ai-branding] prompt modules not loaded yet');
    return;
  }

  // Load saved doc; null if user has never customized.
  let saved = null;
  try {
    if (typeof loadPersonalPrompt === 'function') {
      saved = await loadPersonalPrompt();
    }
  } catch (e) {
    console.warn('[ai-branding] loadPersonalPrompt failed:', e);
  }
  _abLastSavedSnapshot = saved ? JSON.parse(JSON.stringify(saved)) : null;

  // Field-fallback rule: saved value if present (even if empty string —
  // an explicit empty save is a real user choice), else PROMPT_DEFAULTS.

  // Custom Instructions (Stage 7-1)
  const ciValue = (saved && saved.customInstructions !== undefined)
    ? saved.customInstructions
    : (window.PROMPT_DEFAULTS.customInstructions || '');
  const ciEl = document.getElementById('ab-customInstructions');
  if (ciEl) ciEl.value = ciValue;

  // Tone & Voice (Stage 7-2)
  const dTv = (window.PROMPT_DEFAULTS && window.PROMPT_DEFAULTS.toneVoice) || {};
  const sTv = (saved && saved.toneVoice) || {};
  const _setSelect = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  _setSelect('ab-tv-formality',      sTv.formality      || dTv.formality      || 'professional');
  _setSelect('ab-tv-person',         sTv.person         || dTv.person         || 'third');
  _setSelect('ab-tv-sentenceLength', sTv.sentenceLength || dTv.sentenceLength || 'standard');
  const atnEl = document.getElementById('ab-tv-additionalNotes');
  if (atnEl) {
    atnEl.value = (sTv.additionalToneNotes !== undefined)
      ? sTv.additionalToneNotes
      : (dTv.additionalToneNotes || '');
  }

  _abDirty = false;
  _aiBrandingUpdateSaveButton();
  await _aiBrandingUpdatePreview();
}

// ─────────────────────────────────────────────────────────────────────────
// COLLECT — read all editor fields, return a full prompt config doc
// ─────────────────────────────────────────────────────────────────────────
//
// Stage 7-1: only customInstructions is user-editable. Other fields are
// returned at PROMPT_DEFAULTS values so the merge produces the same
// effective prompt as defaults-only when those fields aren't yet wired.
//
// As Stages 7-2..7-5 land, each section's collect logic appends here.
// The collected doc is the source of truth for both Save and Preview.

function aiBrandingCollect() {
  const defaults = window.PROMPT_DEFAULTS || {};
  const dTv = defaults.toneVoice || {};

  // Custom Instructions (Stage 7-1)
  const ciEl = document.getElementById('ab-customInstructions');
  const customInstructions = ciEl ? ciEl.value : (defaults.customInstructions || '');

  // Tone & Voice (Stage 7-2)
  const _readSelect = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
  };
  const _readTextarea = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
  };
  const toneVoice = {
    formality:           _readSelect('ab-tv-formality',      dTv.formality      || 'professional'),
    person:              _readSelect('ab-tv-person',         dTv.person         || 'third'),
    sentenceLength:      _readSelect('ab-tv-sentenceLength', dTv.sentenceLength || 'standard'),
    additionalToneNotes: _readTextarea('ab-tv-additionalNotes', dTv.additionalToneNotes || '')
  };

  return {
    schemaVersion: defaults.schemaVersion || 1,
    brandIdentity: { ...(defaults.brandIdentity || {}) },
    toneVoice,
    terminology: JSON.parse(JSON.stringify(defaults.terminology || {})),
    structural: JSON.parse(JSON.stringify(defaults.structural || {})),
    customInstructions
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PREVIEW — live render of the assembled effective prompt
// ─────────────────────────────────────────────────────────────────────────

async function _aiBrandingUpdatePreview() {
  const previewEl = document.getElementById('ab-preview');
  if (!previewEl) return;
  try {
    const collected = aiBrandingCollect();
    const layers = [collected, window.PROMPT_DEFAULTS].filter(Boolean);
    const { systemPrompt } = await window.assemblePrompt({ layers });
    previewEl.textContent = systemPrompt;
  } catch (e) {
    console.warn('[ai-branding] preview render failed:', e);
    previewEl.textContent = '(preview render failed: ' + (e.message || 'unknown') + ')';
  }
}

// Debounced preview update — called from input handlers on every keystroke.
// Also updates the Save button dirty state in the same tick.
function aiBrandingScheduleUpdatePreview() {
  clearTimeout(_abPreviewTimer);
  _abPreviewTimer = setTimeout(() => {
    _aiBrandingUpdateSaveButton();
    _aiBrandingUpdatePreview();
  }, 200);
}

// ─────────────────────────────────────────────────────────────────────────
// DIRTY-STATE TRACKING — drives Save button enabled/disabled
// ─────────────────────────────────────────────────────────────────────────

function _aiBrandingComputeDirty() {
  const collected = aiBrandingCollect();
  const baseline = _abLastSavedSnapshot || window.PROMPT_DEFAULTS;
  return JSON.stringify(collected) !== JSON.stringify(baseline);
}

function _aiBrandingUpdateSaveButton() {
  _abDirty = _aiBrandingComputeDirty();
  const btn = document.getElementById('ab-save-btn');
  if (btn) {
    btn.disabled = !_abDirty;
    btn.style.opacity = _abDirty ? '1' : '0.5';
  }
}

// Compute changed field paths between two prompt config objects, for the
// audit log. Stage 7-1 only checks customInstructions; future stages walk
// more paths as their fields become editable.
function _aiBrandingChangedFieldPaths(prev, next) {
  const paths = [];
  const baseline = prev || window.PROMPT_DEFAULTS || {};

  // Custom Instructions (Stage 7-1)
  if ((baseline.customInstructions || '') !== (next.customInstructions || '')) {
    paths.push('customInstructions');
  }

  // Tone & Voice (Stage 7-2)
  const baseTV = baseline.toneVoice || {};
  const nextTV = next.toneVoice || {};
  if ((baseTV.formality           || '') !== (nextTV.formality           || '')) paths.push('toneVoice.formality');
  if ((baseTV.person              || '') !== (nextTV.person              || '')) paths.push('toneVoice.person');
  if ((baseTV.sentenceLength      || '') !== (nextTV.sentenceLength      || '')) paths.push('toneVoice.sentenceLength');
  if ((baseTV.additionalToneNotes || '') !== (nextTV.additionalToneNotes || '')) paths.push('toneVoice.additionalToneNotes');

  return paths;
}

// ─────────────────────────────────────────────────────────────────────────
// SAVE
// ─────────────────────────────────────────────────────────────────────────

function _aiBrandingSetStatus(msg, isError) {
  const status = document.getElementById('ab-status');
  if (!status) return;
  status.textContent = msg;
  status.className = isError ? 'ab-status error' : 'ab-status';
  status.style.opacity = '1';
  setTimeout(() => { status.style.opacity = '0'; }, isError ? 6000 : 3000);
}

async function aiBrandingSave() {
  if (!_abDirty) {
    _aiBrandingSetStatus('No changes to save.');
    return;
  }
  const btn = document.getElementById('ab-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const collected = aiBrandingCollect();
    const changedPaths = _aiBrandingChangedFieldPaths(_abLastSavedSnapshot, collected);
    await window.savePersonalPrompt(collected, changedPaths);
    _abLastSavedSnapshot = JSON.parse(JSON.stringify(collected));
    _abDirty = false;
    _aiBrandingSetStatus('✓ Saved');
    _aiBrandingUpdateSaveButton();
  } catch (e) {
    console.error('[ai-branding] save failed:', e);
    _aiBrandingSetStatus('✗ ' + (e.message || 'Save failed'), true);
  } finally {
    if (btn) btn.textContent = 'Save';
    _aiBrandingUpdateSaveButton();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// RESET TO DEFAULT
// ─────────────────────────────────────────────────────────────────────────
//
// Confirms via the existing _confirmModal pattern, then deletes the user's
// personal prompt doc (versions + audit log preserved per promptStorage.js).
// Editor fields re-populate from PROMPT_DEFAULTS via aiBrandingInit().

async function aiBrandingResetToDefault() {
  if (typeof _confirmModal !== 'function') {
    console.warn('[ai-branding] _confirmModal unavailable');
    return;
  }
  _confirmModal(
    'Reset all AI & Branding settings to factory defaults? Your version history is preserved — you can revert to a prior version later if needed.',
    async () => {
      try {
        await window.resetPersonalPromptToDefault();
        _abLastSavedSnapshot = null;
        await aiBrandingInit();
        _aiBrandingSetStatus('✓ Reset to defaults');
      } catch (e) {
        console.error('[ai-branding] reset failed:', e);
        _aiBrandingSetStatus('✗ ' + (e.message || 'Reset failed'), true);
      }
    },
    '↺ Reset to Default',
    'Reset'
  );
}

// ── Window exposure ──
window.aiBrandingInit = aiBrandingInit;
window.aiBrandingCollect = aiBrandingCollect;
window.aiBrandingSave = aiBrandingSave;
window.aiBrandingResetToDefault = aiBrandingResetToDefault;
window.aiBrandingScheduleUpdatePreview = aiBrandingScheduleUpdatePreview;
