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

// Terminology lists held in module scope — the editor renders them by
// regenerating <li> markup on every mutation, so we need the data outside
// the DOM. aiBrandingInit hydrates this from saved/defaults; collect reads
// it; add/remove handlers mutate it and trigger re-render + preview update.
let _abTerminology = { banned: [], preferred: [], required: [] };

// Structural sections — array of {key, label, instructions}. Same lifecycle
// as _abTerminology: hydrated by init, read by collect, mutated in-place by
// the structural-edit handler. We do NOT re-render the list on edit (would
// destroy the focused textarea); state mutation alone is enough since the
// textarea holds its own value until next init.
let _abStructural = [];

// Lightweight HTML-escape for user-typed list content rendered into innerHTML.
function _abEscapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

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

  // Brand & Identity (Stage 7-5) — four text inputs at the top of the editor.
  const dBi = (window.PROMPT_DEFAULTS && window.PROMPT_DEFAULTS.brandIdentity) || {};
  const sBi = (saved && saved.brandIdentity) || {};
  const _setInput = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val == null ? '' : val;
  };
  _setInput('ab-bi-inspectorRole',  (sBi.inspectorRole  !== undefined) ? sBi.inspectorRole  : (dBi.inspectorRole  || ''));
  _setInput('ab-bi-projectContext', (sBi.projectContext !== undefined) ? sBi.projectContext : (dBi.projectContext || ''));
  _setInput('ab-bi-outputDocType',  (sBi.outputDocType  !== undefined) ? sBi.outputDocType  : (dBi.outputDocType  || ''));
  _setInput('ab-bi-docStyleNotes',  (sBi.docStyleNotes  !== undefined) ? sBi.docStyleNotes  : (dBi.docStyleNotes  || ''));

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

  // Terminology (Stage 7-3) — hydrate module-scoped lists from saved or defaults.
  const dTerm = (window.PROMPT_DEFAULTS && window.PROMPT_DEFAULTS.terminology) || {};
  const sTerm = (saved && saved.terminology) || {};
  _abTerminology = {
    banned:    Array.isArray(sTerm.banned)    ? sTerm.banned.slice()    : (Array.isArray(dTerm.banned)    ? dTerm.banned.slice()    : []),
    preferred: Array.isArray(sTerm.preferred) ? JSON.parse(JSON.stringify(sTerm.preferred)) : (Array.isArray(dTerm.preferred) ? JSON.parse(JSON.stringify(dTerm.preferred)) : []),
    required:  Array.isArray(sTerm.required)  ? sTerm.required.slice()  : (Array.isArray(dTerm.required)  ? dTerm.required.slice()  : [])
  };
  _aiBrandingRenderTerms();
  _aiBrandingWireTermInputs();

  // Structural Preferences (Stage 7-4) — hydrate from saved or defaults.
  // Saved sections take precedence (user can have customized any subset);
  // defaults provide the canonical 7-section list as fallback.
  const dStruct = (window.PROMPT_DEFAULTS && window.PROMPT_DEFAULTS.structural) || {};
  const sStruct = (saved && saved.structural) || {};
  const sourceSections = (Array.isArray(sStruct.sections) && sStruct.sections.length)
    ? sStruct.sections
    : (Array.isArray(dStruct.sections) ? dStruct.sections : []);
  _abStructural = JSON.parse(JSON.stringify(sourceSections));
  _aiBrandingRenderStructural();

  _abDirty = false;
  _aiBrandingUpdateSaveButton();
  await _aiBrandingUpdatePreview();
}

// ─────────────────────────────────────────────────────────────────────────
// TERMINOLOGY EDITOR (Stage 7-3) — render + add/remove handlers
// ─────────────────────────────────────────────────────────────────────────

function _aiBrandingRenderTerms() {
  // Banned
  const bannedUl = document.getElementById('ab-list-banned');
  if (bannedUl) {
    bannedUl.innerHTML = (_abTerminology.banned || []).map((word, i) =>
      `<li><span class="ab-list-text">${_abEscapeHtml(word)}</span><button class="ab-list-remove" onclick="aiBrandingTermsRemove('banned',${i})" title="Remove">×</button></li>`
    ).join('');
  }
  // Preferred substitutions
  const prefUl = document.getElementById('ab-list-preferred');
  if (prefUl) {
    prefUl.innerHTML = (_abTerminology.preferred || []).map((p, i) =>
      `<li><span class="ab-list-text">"${_abEscapeHtml(p && p.from)}" <span class="ab-list-arrow">→</span> "${_abEscapeHtml(p && p.to)}"</span><button class="ab-list-remove" onclick="aiBrandingTermsRemove('preferred',${i})" title="Remove">×</button></li>`
    ).join('');
  }
  // Required
  const reqUl = document.getElementById('ab-list-required');
  if (reqUl) {
    reqUl.innerHTML = (_abTerminology.required || []).map((word, i) =>
      `<li><span class="ab-list-text">${_abEscapeHtml(word)}</span><button class="ab-list-remove" onclick="aiBrandingTermsRemove('required',${i})" title="Remove">×</button></li>`
    ).join('');
  }
}

// Wire Enter-key submit on the add-input rows. Re-runs on every aiBrandingInit
// (each navigation to the page) — replacing prior handlers, no leak.
function _aiBrandingWireTermInputs() {
  const _wire = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handler(); }
    };
  };
  _wire('ab-banned-input',   () => aiBrandingTermsAdd('banned'));
  _wire('ab-required-input', () => aiBrandingTermsAdd('required'));
  _wire('ab-preferred-from', () => aiBrandingTermsAddPair());
  _wire('ab-preferred-to',   () => aiBrandingTermsAddPair());
}

function aiBrandingTermsAdd(listType) {
  const inputId = listType === 'banned' ? 'ab-banned-input' : 'ab-required-input';
  const input = document.getElementById(inputId);
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  // Dedupe — silently skip if same string already present
  const list = Array.isArray(_abTerminology[listType]) ? _abTerminology[listType] : [];
  if (list.includes(val)) {
    input.value = '';
    return;
  }
  _abTerminology[listType] = [...list, val];
  input.value = '';
  _aiBrandingRenderTerms();
  aiBrandingScheduleUpdatePreview();
}

function aiBrandingTermsAddPair() {
  const fromEl = document.getElementById('ab-preferred-from');
  const toEl = document.getElementById('ab-preferred-to');
  if (!fromEl || !toEl) return;
  const from = fromEl.value.trim();
  const to = toEl.value.trim();
  if (!from || !to) return;
  // Dedupe by from-key — last write wins (matches the merge function's Map semantics)
  const list = Array.isArray(_abTerminology.preferred) ? _abTerminology.preferred : [];
  const filtered = list.filter(p => !p || p.from !== from);
  _abTerminology.preferred = [...filtered, { from, to }];
  fromEl.value = '';
  toEl.value = '';
  if (fromEl.focus) fromEl.focus();
  _aiBrandingRenderTerms();
  aiBrandingScheduleUpdatePreview();
}

function aiBrandingTermsRemove(listType, index) {
  const list = Array.isArray(_abTerminology[listType]) ? _abTerminology[listType] : [];
  if (index < 0 || index >= list.length) return;
  _abTerminology[listType] = list.filter((_, i) => i !== index);
  _aiBrandingRenderTerms();
  aiBrandingScheduleUpdatePreview();
}

// ─────────────────────────────────────────────────────────────────────────
// STRUCTURAL EDITOR (Stage 7-4) — accordion render + per-section edit
// ─────────────────────────────────────────────────────────────────────────
//
// Render strategy: regenerate the entire #ab-structural-list innerHTML on
// hydrate (init) only. On user edit (textarea input), we mutate state but do
// NOT re-render — that would destroy the focused textarea. The textarea
// holds the latest value authoritatively in the DOM until the next init.
// On collect, we read the latest values directly from the textareas (since
// state may be stale between input events) — see aiBrandingCollect below.

function _aiBrandingRenderStructural() {
  const container = document.getElementById('ab-structural-list');
  if (!container) return;
  container.innerHTML = (_abStructural || []).map((s, i) => {
    const label = _abEscapeHtml((s && (s.label || s.key)) || ('Section ' + (i + 1)));
    const instructions = _abEscapeHtml((s && s.instructions) || '');
    return (
      '<div class="ab-struct-item collapsed" id="ab-struct-' + i + '">' +
        '<div class="ab-struct-head" onclick="aiBrandingStructToggle(' + i + ')">' +
          '<span class="ab-struct-label">' + label + '</span>' +
          '<span class="ab-struct-chevron">▾</span>' +
        '</div>' +
        '<div class="ab-struct-body">' +
          '<textarea oninput="aiBrandingStructEdit(' + i + ', this.value)" placeholder="Instructions for this section…">' + instructions + '</textarea>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

function aiBrandingStructToggle(idx) {
  const item = document.getElementById('ab-struct-' + idx);
  if (item) item.classList.toggle('collapsed');
}

function aiBrandingStructEdit(idx, value) {
  if (idx < 0 || idx >= _abStructural.length) return;
  // Mutate state in place — no re-render, textarea keeps focus
  _abStructural[idx] = Object.assign({}, _abStructural[idx], { instructions: value });
  aiBrandingScheduleUpdatePreview();
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
  const dBi = defaults.brandIdentity || {};

  // Brand & Identity (Stage 7-5)
  const _readInput = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
  };
  const brandIdentity = {
    inspectorRole:  _readInput('ab-bi-inspectorRole',  dBi.inspectorRole  || ''),
    projectContext: _readInput('ab-bi-projectContext', dBi.projectContext || ''),
    outputDocType:  _readInput('ab-bi-outputDocType',  dBi.outputDocType  || ''),
    docStyleNotes:  _readInput('ab-bi-docStyleNotes',  dBi.docStyleNotes  || '')
  };

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

  // Terminology (Stage 7-3) — read from module-scoped state, deep-cloned
  const terminology = JSON.parse(JSON.stringify(_abTerminology || {}));

  // Structural Preferences (Stage 7-4) — read from state. State is mutated
  // in place by aiBrandingStructEdit on each textarea input, so it should
  // be current. As a safety net we also harvest the latest textarea values
  // directly from the DOM in case any input event was missed (e.g. paste
  // without an input event in older browsers).
  const structuralSections = (_abStructural || []).map((s, i) => {
    const item = document.getElementById('ab-struct-' + i);
    const ta = item && item.querySelector('textarea');
    const liveValue = ta ? ta.value : (s && s.instructions);
    return Object.assign({}, s, { instructions: liveValue == null ? '' : liveValue });
  });
  const structural = { sections: JSON.parse(JSON.stringify(structuralSections)) };

  return {
    schemaVersion: defaults.schemaVersion || 1,
    brandIdentity,
    toneVoice,
    terminology,
    structural,
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

  // Brand & Identity (Stage 7-5)
  const baseBI = baseline.brandIdentity || {};
  const nextBI = next.brandIdentity || {};
  if ((baseBI.inspectorRole  || '') !== (nextBI.inspectorRole  || '')) paths.push('brandIdentity.inspectorRole');
  if ((baseBI.projectContext || '') !== (nextBI.projectContext || '')) paths.push('brandIdentity.projectContext');
  if ((baseBI.outputDocType  || '') !== (nextBI.outputDocType  || '')) paths.push('brandIdentity.outputDocType');
  if ((baseBI.docStyleNotes  || '') !== (nextBI.docStyleNotes  || '')) paths.push('brandIdentity.docStyleNotes');

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

  // Terminology (Stage 7-3) — three lists; compare by JSON shape
  const baseT = baseline.terminology || {};
  const nextT = next.terminology || {};
  if (JSON.stringify(baseT.banned    || []) !== JSON.stringify(nextT.banned    || [])) paths.push('terminology.banned');
  if (JSON.stringify(baseT.preferred || []) !== JSON.stringify(nextT.preferred || [])) paths.push('terminology.preferred');
  if (JSON.stringify(baseT.required  || []) !== JSON.stringify(nextT.required  || [])) paths.push('terminology.required');

  // Structural Preferences (Stage 7-4) — single path entry covers the whole
  // sections array. Granular paths (per-section-index) would help auditing
  // but get noisy; the version doc holds full content for forensics anyway.
  const baseStr = baseline.structural || {};
  const nextStr = next.structural || {};
  if (JSON.stringify(baseStr.sections || []) !== JSON.stringify(nextStr.sections || [])) {
    paths.push('structural.sections');
  }

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
window.aiBrandingTermsAdd = aiBrandingTermsAdd;
window.aiBrandingTermsAddPair = aiBrandingTermsAddPair;
window.aiBrandingTermsRemove = aiBrandingTermsRemove;
window.aiBrandingStructToggle = aiBrandingStructToggle;
window.aiBrandingStructEdit = aiBrandingStructEdit;
