// ═══════════════════════════════════════════
// PROMPT DEFAULTS — factory baseline for AI report polish
// ═══════════════════════════════════════════
//
// Single source of truth for "what the polish prompt looks like with zero
// customization." Used as:
//   1. The bottom layer of the merge stack when a user has no personal prompt
//      doc yet (lazy seeding — see promptStorage.js).
//   2. The fallback when "Reset to default" deletes the user's prompt doc.
//   3. The starting content rendered in the AI & Branding subpage editor on
//      first open.
//
// This file deconstructs the original baked-in `rptCallClaude` system prompt
// (report.js — predates 2026-05-08) into the 6-section schema locked during
// the C10 design discussion. The rendered output of
// `assemblePrompt({ layers: [PROMPT_DEFAULTS] })` is functionally equivalent
// to that original prompt — see promptAssembly.js for the rendering rules.
//
// SCHEMA SHAPE — forward-compatible with Phase 2 (multi-tenant)
// ─────────────────────────────────────────────────────────────
// Every section here will exist in Phase 2's firm-baseline doc with the
// same field names. The merge function (promptAssembly.js) treats both
// shapes identically — N layers, top of stack wins per field. The user
// doc is sovereign and never moves; firm docs and per-firm-override docs
// are added as new layers in Phase 2 without disturbing this file or the
// user's personal prompt doc.
// See memory project_user_sovereign_architecture.md for the full primitive.
//
// LOCKING — DEFERRED TO PHASE 2
// The `lockedByFirm` flag (per the 2026-05-08 design) lives only on the
// firm-baseline doc in Phase 2; it has no meaning on a personal/user doc
// because there's no layer above to enforce it. This file therefore has no
// lock fields. When the firm doc lands, its schema mirrors this one with
// `{ value, lockedByFirm }` shape per field.

const PROMPT_DEFAULTS = {
  schemaVersion: 1,

  // §1 Brand & Identity
  // Who's writing, what project context, what kind of doc.
  // In Phase 2: firm name / logo / legal masthead become firm-only fields here
  // (lockable). The doc-style and inspector-role fields stay user-overridable.
  brandIdentity: {
    inspectorRole: 'Environmental Inspector (EI) report writer',
    projectContext: 'Moraine Solar Energy Center, a 94 MW AC PV solar facility in the Town of Burns, Allegany County, NY',
    outputDocType: 'Daily Environmental Compliance Report',
    docStyleNotes: 'Polish raw field notes into professional language'
  },

  // §2 Tone & Voice
  // Structured controls. Field-empowered defaults — every field is user-
  // overridable in Phase 2 unless firm explicitly locks it.
  toneVoice: {
    formality: 'professional',          // casual | professional | highly-technical
    person: 'third',                    // first | third | mixed
    sentenceLength: 'standard',         // concise | standard | detailed
    additionalToneNotes: 'Keep language tight and direct — no filler. Contractor language should be collaborative in tone.'
  },

  // §3 Terminology
  // Three editable tables: banned words/phrases, preferred substitutions,
  // required terms (always include where relevant).
  terminology: {
    banned: [],
    preferred: [
      { from: 'performing', to: 'conducting' },
      { from: 'is anticipated to', to: 'will' }
    ],
    required: []
  },

  // §4 Structural Preferences
  // Per-output-section instructions. Each section has a key (matches the
  // JSON output keys returned by Claude), a human label, and free-text
  // instructions. Order matters — sections render in array order.
  // In Phase 2, sections become drag-reorderable in the editor UI; firm can
  // pin/lock individual sections.
  structural: {
    sections: [
      {
        key: 'contractorActivities',
        label: 'Contractor Activities',
        instructions: 'ALWAYS begin with attending the morning safety meeting/tailgate — e.g. "[Contractor] personnel attended the morning safety meeting/tailgate at [TIME], then conducted...".\nFollow with description of work activities from crew block data.'
      },
      {
        key: 'fieldObservations',
        label: 'Field Observations',
        instructions: 'Opening must use the time from TIME IN field and detect work type from crew activities.\nOpening MUST end with the exact phrase: "The following activities were observed:".\nInclude 3-5 specific observation bullets based on crew block data.\nStandard Phase 1 Tree Felling bullets: felling method/equipment, directional felling practices, slash/material management, access/staging.\nClosing must reference LOD compliance and buffer integrity.'
      },
      {
        key: 'agencyInspection',
        label: 'Agency Inspection',
        instructions: 'Polish into a single professional sentence describing who inspected, what was checked, and outcome.\nIf no inspection, return "No agency inspections conducted today."'
      },
      {
        key: 'landownerContact',
        label: 'Landowner / Public Interactions',
        instructions: 'Polish into one or two professional sentences — who, why they were on site, what was discussed.\nCollaborative, neutral tone.\nIf none, return "No landowner or public interactions occurred today."'
      },
      {
        key: 'rteObservation',
        label: 'T&E / Unanticipated Discoveries',
        instructions: 'Polish into professional observation language.\nReference species, location, and whether work was occurring nearby.\nIf none, return "No rare, threatened, or endangered species were observed. No unanticipated archaeological or cultural resource discoveries were encountered."'
      },
      {
        key: 'generalCommunications',
        label: 'General Communications',
        instructions: 'Frame as a documented field discussion with the contractor — professional record of what was communicated on site.\nPhrasing should reflect: "EI discussed [topic] with [contractor/foreman]..." or "EI communicated to contractor...".\nCollaborative tone — not directive or accusatory.\nIf blank, return "No general communications to report."'
      },
      {
        key: 'compliance',
        label: 'Compliance',
        instructions: 'Polish description and corrective action text.\nKeep Level and Status exactly as provided.\nIf no issues: [{"level":"No issues identified","description":"All areas inspected — no compliance concerns observed.","corrective":"N/A","status":"Compliant","dateResolved":""}]'
      }
    ]
  },

  // §5 Custom Instructions
  // Free-text catch-all. In Phase 2 merge, firm baseline appears first then
  // user override appended (additive — both apply, user can't remove firm rules).
  customInstructions: 'Do not mention residential proximity unless explicitly flagged.'
};

// §6 OUTPUT FORMAT — system-enforced, not user-editable.
// Lives in promptAssembly.js as a fixed footer on every assembled prompt.
// Captured here as a constant for documentation only.
const PROMPT_OUTPUT_FORMAT_DIRECTIVE = 'Return ONLY valid JSON — no code fences, no explanation.';

// ── Window exposure ──
// Cross-module access pattern matches the rest of the codebase (db.js, auth.js,
// report.js): top-of-file declares; bottom-of-file attaches to window for
// consumers in other modules. Vite bundles these as side-effect imports.
window.PROMPT_DEFAULTS = PROMPT_DEFAULTS;
window.PROMPT_OUTPUT_FORMAT_DIRECTIVE = PROMPT_OUTPUT_FORMAT_DIRECTIVE;
