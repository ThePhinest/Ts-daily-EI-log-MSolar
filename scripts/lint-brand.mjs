#!/usr/bin/env node
// ── Branding architecture guard (2026-09-05) ─────────────────────────────────
// Output branding is per tenant and flows ONLY through src/brand.js (project doc →
// per-report profile → user presets). This guard fails the build when an export
// module reintroduces a hardcoded brand-palette color or a project-name branch.
//
//   npm run lint:brand            → scan every export module
//   node scripts/lint-brand.mjs <file…>  → scan just those files (Claude Code hook)
//
// A line that MUST carry a literal (a last-resort fallback when brand.js isn't
// loaded) ends with the marker  // brand-fallback  — keep those to a handful.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_MODULES = ['report.js', 'swpppPdf.js', 'compliance.js', 'swppp.js', 'agencyVisits.js', 'exportImg.js'];
// The brand-palette family: GroundLog teal/amber + tints, Office blue + tints.
const PALETTE = /(006B75|C9A84C|1F3864|2E5496|2F5496|D9E2F3|FFF2CC|E4EFEE|FDF5DC|F7EFD9)/i;
// Project names never belong in export code (feedback_no_project_specific_hardcoding).
const PROJECT_NAMES = /\b(Moraine|Jennison)\b/;
const MARK = 'brand-fallback';

const args = process.argv.slice(2);
const targets = (args.length ? args : EXPORT_MODULES.map(f => path.join(ROOT, 'src', f)))
  .map(p => path.resolve(p))
  .filter(p => EXPORT_MODULES.includes(path.basename(p)) && fs.existsSync(p));

// strip // and /* */ comments so documentation can name colors and projects freely
function stripComments(line, state) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (state.block) { if (line[i] === '*' && line[i + 1] === '/') { state.block = false; i++; } continue; }
    if (line[i] === '/' && line[i + 1] === '*') { state.block = true; i++; continue; }
    if (line[i] === '/' && line[i + 1] === '/') break;
    out += line[i];
  }
  return out;
}

const findings = [];
for (const file of targets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const state = { block: false };
  lines.forEach((raw, i) => {
    let code = stripComments(raw, state);
    if (!code.trim()) return;
    if (raw.includes(MARK)) return;
    // App-chrome CSS tokens with a fallback — var(--amber,#C9A84C) — are UI, not output branding.
    code = code.replace(/var\(--[a-z0-9-]+\s*,\s*#?[0-9a-fA-F]{3,8}\)/gi, 'var(--token)');
    if (PALETTE.test(code)) findings.push(`${rel}:${i + 1}  hardcoded brand color → ask brand.js (glBrandPdfPal / glBrandDocx / glBrandXl)  ${code.trim().slice(0, 90)}`);
    if (PROJECT_NAMES.test(code)) findings.push(`${rel}:${i + 1}  project name in export code → per-project config, never a name branch  ${code.trim().slice(0, 90)}`);
  });
}

if (findings.length) {
  console.log(`\n✗ Branding guard: ${findings.length} finding${findings.length === 1 ? '' : 's'}\n`);
  findings.forEach(f => console.log('  ' + f));
  console.log(`\n  Rule: output colors/logos come from src/brand.js (project doc → per-report profile → presets).\n  A genuine last-resort fallback line may end with  // ${MARK}\n`);
  process.exit(1);
}
console.log(`✓ Branding guard clean (${targets.length} file${targets.length === 1 ? '' : 's'})`);
