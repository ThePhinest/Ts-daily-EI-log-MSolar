// ═══════════════════════════════════════════
// PROMPT ASSEMBLY — pure-function merge + render module
// ═══════════════════════════════════════════
//
// PURE FUNCTIONS ONLY. No Firestore reads, no Anthropic calls, no DOM.
// Input: a layer stack of prompt config docs (highest precedence first).
// Output: { systemPrompt, effectivePromptHash, merged }.
//
// USER-SOVEREIGN ARCHITECTURE — see memory project_user_sovereign_architecture.md
// ─────────────────────────────────────────────────────────────────────────────
// The merge function is N-layer-capable from day one. The user doc is the
// unit of identity; firm docs are overlays.
//
// Today (Phase 1, single-user):
//   layers = [PROMPT_DEFAULTS]
//        OR [personalPromptDoc, PROMPT_DEFAULTS]
//        OR [projectOverrideDoc, personalPromptDoc, PROMPT_DEFAULTS]
//
// Phase 2 (multi-tenant, working in a firm project):
//   layers = [projectOverride, personal, firmProjectOverride, firmUserOverride, firmBaseline, PROMPT_DEFAULTS]
//
// Phase 2 (multi-tenant, same user working on a personal project):
//   layers = [personal, PROMPT_DEFAULTS]
//
// Same function, different stack composition. The merge function does not
// know or care which layer is which — it just walks the stack and merges.
//
// PHASE 2 SERVER-SIDE MIGRATION
// This entire module is pure JS that drops into a Cloud Function with zero
// rewrite. The trust boundary moves from client to server in Phase 2; the
// function signature and behavior do not change. The only change is WHERE
// it executes (and that the client sends structured intent rather than the
// pre-assembled prompt).

// ─────────────────────────────────────────────────────────────────────────
// MERGE — combine N layer docs into one effective config doc
// ─────────────────────────────────────────────────────────────────────────

// Deep-merge two prompt config docs. `over` (higher precedence) wins per field,
// EXCEPT for arrays/lists where the merge is union-with-precedence (see below).
// `over` and `under` may be null; null is treated as an empty layer.
function _mergePromptDocs(under, over) {
  if (!under) return over || null;
  if (!over) return under;

  return {
    schemaVersion: over.schemaVersion || under.schemaVersion || 1,

    // §1 Brand & Identity — field-level merge, over wins
    brandIdentity: {
      ...(under.brandIdentity || {}),
      ...(over.brandIdentity || {})
    },

    // §2 Tone & Voice — field-level merge, over wins per field via spread.
    // additionalToneNotes uses REPLACE semantics (over wins entirely when set).
    //
    // Why replace, not append: in the editor, the user sees the full textarea
    // value as their saved content. If they type defaults verbatim and add
    // their own line, the saved layer holds the COMBINED text. Appending it
    // again to defaults would render defaults twice.
    //
    // Phase 2 (firm layer) introduces additive semantics for textareas via a
    // separate editor surface: "inherited from firm" (read-only) + "your
    // additions" (editable, only this part stored). At that point the merge
    // function gets a layer-aware additive mode for text fields.
    toneVoice: {
      ...(under.toneVoice || {}),
      ...(over.toneVoice || {})
    },

    // §3 Terminology — three lists, each merged differently
    terminology: {
      // banned: union, deduped (a higher layer cannot un-ban a firm-banned word)
      banned: Array.from(new Set([
        ...((under.terminology && under.terminology.banned) || []),
        ...((over.terminology && over.terminology.banned) || [])
      ])),
      // preferred: from→to map, over wins on conflict; preserves insertion order
      preferred: (() => {
        const map = new Map();
        const u = (under.terminology && under.terminology.preferred) || [];
        const o = (over.terminology && over.terminology.preferred) || [];
        for (const p of u) if (p && p.from) map.set(p.from, p.to || '');
        for (const p of o) if (p && p.from) map.set(p.from, p.to || '');
        return Array.from(map, ([from, to]) => ({ from, to }));
      })(),
      // required: union, deduped (a higher layer can add but not remove firm-required terms)
      required: Array.from(new Set([
        ...((under.terminology && under.terminology.required) || []),
        ...((over.terminology && over.terminology.required) || [])
      ]))
    },

    // §4 Structural — sections merged by key; over wins on conflict, new sections appended
    structural: {
      sections: (() => {
        const map = new Map();
        const u = (under.structural && under.structural.sections) || [];
        const o = (over.structural && over.structural.sections) || [];
        for (const s of u) if (s && s.key) map.set(s.key, s);
        for (const s of o) if (s && s.key) map.set(s.key, s);
        return Array.from(map.values());
      })()
    },

    // §5 Custom Instructions — REPLACE semantics (over wins when set).
    // Same rationale as §2 additionalToneNotes above: textarea content is
    // the user's full saved value; appending to defaults would duplicate.
    // Phase 2 firm-baseline + user-addition split lands when firm layer ships.
    customInstructions: (over.customInstructions !== undefined)
      ? over.customInstructions
      : (under.customInstructions || '')
  };
}

// Merge an array of layer docs. layers[0] = highest precedence (user/personal/project),
// layers[N-1] = lowest precedence (defaults).
// Reduces from least precedent to most precedent so each step's `over` truly wins.
function mergeLayers(layers) {
  const filtered = (layers || []).filter(l => l && typeof l === 'object');
  if (filtered.length === 0) return null;
  return filtered.reduceRight((acc, current) => _mergePromptDocs(acc, current), null);
}

// ─────────────────────────────────────────────────────────────────────────
// RENDER — turn a merged config doc into the plain-text system prompt
// ─────────────────────────────────────────────────────────────────────────

// Determinism guarantee: same input doc → same output string. Object iteration
// happens in fixed order (we never iterate Object.keys without an explicit sort
// or fixed structure). Arrays preserve their input order; we never sort them.
function renderSystemPrompt(merged) {
  if (!merged) return '';
  const lines = [];

  // §1 Opening — brand & identity
  const bi = merged.brandIdentity || {};
  const role = (bi.inspectorRole || 'report writer').trim();
  const project = bi.projectContext ? ` for the ${String(bi.projectContext).trim()}` : '';
  const docType = bi.outputDocType ? String(bi.outputDocType).trim() : 'report';
  const styleNote = (bi.docStyleNotes || 'Polish raw field notes into professional language').trim();
  lines.push(`You are an ${role}${project}. ${styleNote} for a ${docType}.`);
  lines.push('');

  // §2 Style rules (tone & voice)
  const tv = merged.toneVoice || {};
  lines.push('STYLE RULES:');
  if (tv.formality) lines.push(`- Formality: ${tv.formality}`);
  if (tv.person) {
    if (tv.person === 'third') {
      lines.push('- Refer to the inspector in third person — do not use first person');
    } else if (tv.person === 'first') {
      lines.push('- Use first person');
    } else if (tv.person === 'mixed') {
      lines.push('- Mixed person — use first person sparingly, prefer third for inspector references');
    } else {
      lines.push(`- Person: ${tv.person}`);
    }
  }
  if (tv.sentenceLength) lines.push(`- Sentence length: ${tv.sentenceLength}`);
  if (tv.additionalToneNotes && String(tv.additionalToneNotes).trim()) {
    // Each line of additional tone notes becomes its own bullet
    const notes = String(tv.additionalToneNotes).split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (const n of notes) lines.push(`- ${n}`);
  }
  lines.push('');

  // §3 Terminology
  const t = merged.terminology || {};
  const hasPreferred = t.preferred && t.preferred.length;
  const hasBanned = t.banned && t.banned.length;
  const hasRequired = t.required && t.required.length;
  if (hasPreferred || hasBanned || hasRequired) {
    lines.push('TERMINOLOGY:');
    if (hasPreferred) {
      for (const p of t.preferred) {
        if (p && p.from && p.to) lines.push(`- Use "${p.to}" not "${p.from}"`);
      }
    }
    if (hasBanned) {
      lines.push(`- Avoid these terms: ${t.banned.join(', ')}`);
    }
    if (hasRequired) {
      lines.push(`- Always include where relevant: ${t.required.join(', ')}`);
    }
    lines.push('');
  }

  // §4 Structural — per-output-section instructions
  const sections = (merged.structural && merged.structural.sections) || [];
  if (sections.length) {
    lines.push('OUTPUT SECTIONS:');
    for (const s of sections) {
      if (!s || !s.key) continue;
      lines.push('');
      const heading = String(s.label || s.key).toUpperCase();
      lines.push(`${heading}:`);
      if (s.instructions) {
        const instr = String(s.instructions).split(/\n+/).map(line => line.trim()).filter(Boolean);
        for (const line of instr) lines.push(`- ${line}`);
      }
    }
    lines.push('');
  }

  // §5 Custom Instructions (additional notes)
  if (merged.customInstructions && String(merged.customInstructions).trim()) {
    lines.push('ADDITIONAL NOTES:');
    lines.push(String(merged.customInstructions).trim());
    lines.push('');
  }

  // §6 Output Format — system-enforced footer (not user-editable)
  // Mirrors PROMPT_OUTPUT_FORMAT_DIRECTIVE from promptDefaults.js but kept
  // inline to make this module self-contained and fully testable in isolation.
  lines.push('Return ONLY valid JSON — no code fences, no explanation.');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// HASH — deterministic SHA-256 of the rendered prompt
// ─────────────────────────────────────────────────────────────────────────
//
// Used as the per-user/per-effective-prompt cache key in report.js (Stage 4).
// Same logical pattern as `_hashSnapshot` in report.js — Web Crypto API for
// browser + WebView compatibility. Same hash IS produced by Node's
// crypto.subtle in a future Cloud Function migration (Phase 2).

async function _hashPrompt(systemPromptText) {
  const buf = new TextEncoder().encode(systemPromptText);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────
//
// assemblePrompt({ layers })
//   layers: array of prompt config docs, [0] = highest precedence.
//   returns: { systemPrompt, effectivePromptHash, merged }
//   - systemPrompt: plain-text string ready to pass to Anthropic system role
//   - effectivePromptHash: hex SHA-256 of systemPrompt (cache key)
//   - merged: the merged config doc (useful for the editor's preview pane)

async function assemblePrompt({ layers }) {
  const merged = mergeLayers(layers);
  const systemPrompt = renderSystemPrompt(merged);
  const effectivePromptHash = await _hashPrompt(systemPrompt);
  return { systemPrompt, effectivePromptHash, merged };
}

// ─────────────────────────────────────────────────────────────────────────
// SELF-TEST — Stage 2 verification helper
// ─────────────────────────────────────────────────────────────────────────
//
// Verifies merge + render is deterministic and produces a non-empty prompt
// from PROMPT_DEFAULTS alone. Call from DevTools console:
//   await window._assemblePromptSelfTest()
// Expected: { ok: true, sample: "...first 200 chars...", hash: "..." }

async function _assemblePromptSelfTest() {
  if (!window.PROMPT_DEFAULTS) {
    return { ok: false, error: 'PROMPT_DEFAULTS not loaded — promptDefaults.js missing or imported after this module' };
  }
  try {
    const r1 = await assemblePrompt({ layers: [window.PROMPT_DEFAULTS] });
    const r2 = await assemblePrompt({ layers: [window.PROMPT_DEFAULTS] });
    const deterministic = r1.effectivePromptHash === r2.effectivePromptHash && r1.systemPrompt === r2.systemPrompt;
    return {
      ok: deterministic && r1.systemPrompt.length > 100,
      deterministic,
      promptLength: r1.systemPrompt.length,
      hash: r1.effectivePromptHash,
      sample: r1.systemPrompt.slice(0, 400) + (r1.systemPrompt.length > 400 ? '…' : '')
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Window exposure ──
window.assemblePrompt = assemblePrompt;
window.mergeLayers = mergeLayers;
window.renderSystemPrompt = renderSystemPrompt;
window._assemblePromptSelfTest = _assemblePromptSelfTest;
