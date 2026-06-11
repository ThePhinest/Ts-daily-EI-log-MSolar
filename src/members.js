// ═══════════════════════════════════════════
// SHARED PROJECTS — membership, invites, members UI, publish flow (Phase 4.5)
//
// The shared world lives at projects/{pid} (meta + members + invites-by-token
// at top-level /invites). This module owns membership (create/backfill shared
// project docs, mint + accept invites, members card) and the PUBLISH flow:
// work product (trackerEntries/trackerCategories) lives at the shared root
// since the 2026-06-11 _projData flip (db.js) — publish-gated per record;
// photos + field markers publish as mirror copies ("explicit publish, keep
// your original"); the submit-day review sheet batch-publishes a day and
// posts the close-day submission snapshot.
//
// Design contract: submission-sharing-model.md + multi-tenant-data-model.md.
// Rules contract: firestore.rules (proven by tests/rules — npm run test:rules).
// ═══════════════════════════════════════════
import QRCode from 'qrcode'

// ── Roles v1 — display name does the brand work, subtitle does the parsing work.
// Code keys are generic (lead/field/reviewer) so renames stay a one-line change.
const GL_ROLES = {
  lead:     { name: 'Lead',    icon: '⭐', sub: 'Full control — runs the project.' },
  field:    { name: 'Boots',   icon: '🥾', sub: 'Works in the project — own logs, drawings, photos, submissions.' },
  reviewer: { name: 'Glasses', icon: '👓', sub: 'Reviewer access — sees everything published, edits nothing.' }
};

const INVITE_TTL_MS = 14 * 86400000; // invites live 14 days

// ── Pending-invite capture — runs at module import, before auth exists.
// Either skin lands here: link/QR (?join=TOKEN) or typed code (stored directly).
// NOTE (iOS): a QR scanned with the camera opens SAFARI, not the installed PWA —
// and iOS gives them separate localStorage. A stash made in one context is
// invisible in the other; the typed-code skin is the cross-context recovery.
(function _glCaptureJoinParam() {
  try {
    const url = new URL(window.location.href);
    const tok = url.searchParams.get('join')
      || (window.location.hash.match(/join=([A-Za-z0-9-]+)/) || [])[1];
    if (tok) {
      localStorage.setItem('gl_pending_invite', _glNormToken(tok));
      console.log('GroundLog invite: token captured from URL');
      url.searchParams.delete('join');
      url.hash = url.hash.replace(/join=[A-Za-z0-9-]+&?/, '').replace(/[#&]$/, '');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch (e) { /* malformed URL — ignore */ }
})();

// Sign-in page hint — keeps the invite visible through the sign-in/sign-up wall
// (the "I created an account and the invite vanished" disorientation).
function _glSigninInviteHint() {
  try {
    if (!localStorage.getItem('gl_pending_invite')) return;
    const page = document.getElementById('page-signin');
    if (!page || document.getElementById('_gl-si-invite-hint')) return;
    const card = page.querySelector('.si-card');
    if (!card) return;
    const hint = document.createElement('div');
    hint.id = '_gl-si-invite-hint';
    hint.style.cssText = 'max-width:340px;margin:0 auto 14px;background:rgba(201,160,39,.1);border:1px solid rgba(201,160,39,.45);border-radius:8px;padding:10px 14px;font-family:var(--mono);font-size:11.5px;line-height:1.55;color:var(--amber);text-align:center';
    hint.textContent = '📩 You have a project invite waiting — sign in or create your account to accept it.';
    card.parentNode.insertBefore(hint, card);
  } catch (e) { /* cosmetic only */ }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _glSigninInviteHint);
} else { _glSigninInviteHint(); }

// ── Helpers ──
function _sdb() {
  if (typeof db === 'undefined' || !db || !_currentUser) return null;
  return db;
}
function _glMyName() {
  const u = window._currentUser;
  return (u && (u.displayName || (u.email || '').split('@')[0])) || 'A GroundLog user';
}
// Token: 10 chars, no ambiguous glyphs (I/L/O/0/1) — readable over the phone.
function _glToken() {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(10);
  crypto.getRandomValues(buf);
  let t = '';
  for (let i = 0; i < 10; i++) t += alpha[buf[i] % alpha.length];
  return t;
}
function _glNormToken(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function _glFmtToken(t) { return t.slice(0, 5) + '-' + t.slice(5); }
function _glJoinUrl(token) {
  return location.origin + location.pathname + '?join=' + token;
}
// Member/project strings are cross-user input — always escape before innerHTML.
function _glEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function _glCopy(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = old; }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => _glCopyFallback(text, done));
  } else { _glCopyFallback(text, done); }
}
function _glCopyFallback(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch (e) { /* copy unavailable — code is visible to transcribe */ }
}

// ── My role on a project, synchronously (no Firestore round-trip).
// Shared projects carry role on the known-projects entry (stamped at accept);
// anything not shared is my own project — I'm its lead. Used by write guards
// (the rules are the real gate; this keeps local caches from diverging).
function glMyRoleFor(pid) {
  try {
    if (typeof knownProjectsGet === 'function') {
      const p = knownProjectsGet().find(x => x.projectId === pid);
      if (p && p.shared) return p.role || 'reviewer';
    }
  } catch (e) { /* fall through to lead */ }
  return 'lead';
}

// ═══════════════════════════════════════════
// SHARED PROJECT CREATE + BACKFILL
// ═══════════════════════════════════════════

// Creates the shared trio for a project this user owns: projects/{pid} meta,
// members/{uid} lead doc, users/{uid}/memberships/{pid} mirror. Idempotent —
// safe to re-run; rules allow re-set as lead once membership exists.
async function glEnsureSharedProject(pid, cfg) {
  const d = _sdb();
  if (!d || !pid || pid === 'default' || pid === 'active') return false;
  const uid = _currentUser.uid;
  const now = Date.now();
  cfg = cfg || {};
  await d.collection('projects').doc(pid).set({
    name:       cfg.projectName || cfg.name || '',
    phase:      cfg.activePhase || '',
    contractor: cfg.contractor  || '',
    location:   cfg.location    || '',
    firmId:     null,
    createdBy:  uid,
    createdAt:  cfg.createdAt || now,
    _ts:        now
  }, { merge: true });
  await d.collection('projects').doc(pid).collection('members').doc(uid).set({
    role: 'lead', level: 0,
    addedBy: uid, addedAt: now,
    displayName: _glMyName(), email: _currentUser.email || ''
  }, { merge: true });
  await _udb().collection('memberships').doc(pid).set({
    pid, projectName: cfg.projectName || cfg.name || '',
    role: 'lead', joinedAt: now
  }, { merge: true });
  return true;
}

// Boot backfill: every locally-known own project gets its shared trio.
// Idempotency key = the memberships mirror (own subtree, always readable).
async function glBackfillSharedProjects() {
  if (!_sdb() || typeof knownProjectsGet !== 'function') return;
  const known = knownProjectsGet().filter(p => p.projectId && !p.shared);
  for (const p of known) {
    try {
      const mir = await _udb().collection('memberships').doc(p.projectId).get();
      if (mir.exists) continue;
      await glEnsureSharedProject(p.projectId, p);
      console.log('GroundLog: shared project backfilled —', p.projectName, '(' + p.projectId + ')');
    } catch (e) {
      console.warn('GroundLog: shared backfill failed for', p.projectName, '—', e.message);
    }
  }
}

// ═══════════════════════════════════════════
// WORK-PRODUCT FLIP MIGRATION (2026-06-11)
// ═══════════════════════════════════════════
// One-time per project: copy the old per-user mirror
// users/{uid}/projects/{pid}/{trackerEntries,trackerCategories,kml} forward to
// the shared root projects/{pid}/... that _projData now points at. COPY ONLY —
// the old docs stay untouched as a frozen backup. Everything lands stamped
// ownerUid + published:false (fails safe: members see nothing until published).
// Runs after glBackfillSharedProjects (membership authorizes the writes).
// Returns the number of docs copied so the boot path can refresh the tracker.
async function _glMigrateWorkProductFlip() {
  if (!_sdb() || typeof knownProjectsGet !== 'function') return 0;
  const uid = _currentUser.uid;
  let copiedTotal = 0;
  for (const p of knownProjectsGet()) {
    const pid = p.projectId;
    if (!pid || pid === 'default') continue;
    if (p.shared && p.role === 'reviewer') continue;   // no write caps, nothing of ours to move
    const key = 'gl_flip_workproduct_' + pid;
    if (localStorage.getItem(key)) continue;
    try {
      const oldRoot = _udb().collection('projects').doc(pid);
      const newRoot = db.collection('projects').doc(pid);
      let batch = db.batch(), n = 0;
      const queue = async (ref, payload) => {
        batch.set(ref, payload);
        copiedTotal++;
        if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
      };

      // Tracker entries — geometry is already a JSON string in Firestore docs.
      const [oldE, ownE, pubE] = await Promise.all([
        oldRoot.collection('trackerEntries').get(),
        newRoot.collection('trackerEntries').where('ownerUid', '==', uid).get(),
        newRoot.collection('trackerEntries').where('published', '==', true).get()
      ]);
      const have = new Map();
      [ownE, pubE].forEach(s => s.forEach(d => {
        const x = d.data();
        const prev = have.get(d.id);
        if (!prev || (x.updatedAt || 0) >= (prev.updatedAt || 0)) have.set(d.id, x);
      }));
      for (const d of oldE.docs) {
        const e = d.data();
        const cur = have.get(d.id);
        if (cur && (cur.updatedAt || 0) >= (e.updatedAt || 0)) continue;
        if (!e.ownerUid) e.ownerUid = e.createdBy || uid;
        if (e.ownerUid !== uid) continue;                // rules: can only create own
        if (e.published === undefined) e.published = false;
        await queue(newRoot.collection('trackerEntries').doc(d.id), e);
      }

      // Categories — live reference data; most already mirrored by chunk 2a.
      const [oldC, newC] = await Promise.all([
        oldRoot.collection('trackerCategories').get(),
        newRoot.collection('trackerCategories').get()
      ]);
      const haveCats = new Set(newC.docs.map(d => d.id));
      for (const d of oldC.docs) {
        if (haveCats.has(d.id)) continue;
        const c = d.data();
        if (!c.ownerUid) c.ownerUid = uid;
        if (c.ownerUid !== uid) continue;
        await queue(newRoot.collection('trackerCategories').doc(d.id), c);
      }

      // KML layer list — shared doc already canonical if kmlSaveLayers ran since 2a.
      const sharedKml = await newRoot.collection('kmlLayers').doc('layers').get();
      if (!sharedKml.exists) {
        const oldKml = await oldRoot.collection('kml').doc('layers').get();
        if (oldKml.exists && Array.isArray(oldKml.data().data) && oldKml.data().data.length) {
          await queue(newRoot.collection('kmlLayers').doc('layers'),
            { data: oldKml.data().data, ownerUid: uid, _ts: Date.now() });
        }
      }

      if (n) await batch.commit();
      localStorage.setItem(key, '1');
      if (copiedTotal) console.log('GroundLog flip: migrated work product for', p.projectName || pid);
    } catch (e) {
      console.warn('GroundLog flip migration failed for', pid, '—', e.message);
      // No localStorage stamp on failure — retried next boot.
    }
  }
  return copiedTotal;
}

// ═══════════════════════════════════════════
// INVITES — mint + skins (lead side)
// ═══════════════════════════════════════════

async function glCreateInvite(role) {
  const d = _sdb();
  if (!d || !GL_ROLES[role]) return null;
  const pid = _activeProjectId();
  const cfg = (typeof loadProjectConfig === 'function') ? loadProjectConfig() : {};
  const token = _glToken();
  const now = Date.now();
  const inv = {
    pid, role, status: 'active',
    createdBy: _currentUser.uid, createdByName: _glMyName(),
    projectName: cfg.projectName || '',
    createdAt: now, expiresAt: now + INVITE_TTL_MS
  };
  await d.collection('invites').doc(token).set(inv);
  return Object.assign({ token }, inv);
}

// Role picker → mint → skins. Lead-only button renders this.
function glShowInviteModal() {
  document.getElementById('_gl-invite-modal')?.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-invite-modal';
  ov.style.zIndex = '9100';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  const roleCard = (key, extra) => {
    const r = GL_ROLES[key];
    return `<div class="gl-role-pick" onclick="_glInvitePickRole('${key}')">
      <div class="gl-role-pick-name">${r.icon} ${r.name}</div>
      <div class="gl-role-pick-sub">${r.sub}${extra ? '<br><span style="color:var(--amber)">' + extra + '</span>' : ''}</div>
    </div>`;
  };
  ov.innerHTML = `<div class="modal-box" style="max-width:360px">
    <div class="modal-title">Invite to this project</div>
    <div class="modal-msg" style="margin-bottom:12px">Pick the role for this invite — one invite, one person.</div>
    ${roleCard('reviewer')}
    ${roleCard('field')}
    ${roleCard('lead', 'Equal control to you — including members and invites. Only for someone you completely trust.')}
    <div class="modal-btns" style="margin-top:14px">
      <button class="modal-cancel" onclick="document.getElementById('_gl-invite-modal').remove()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}

async function _glInvitePickRole(role) {
  const ov = document.getElementById('_gl-invite-modal');
  if (ov) ov.querySelectorAll('.gl-role-pick').forEach(el => { el.style.opacity = '.4'; el.onclick = null; });
  try {
    const inv = await glCreateInvite(role);
    if (ov) ov.remove();
    if (inv) glShowInviteSkins(inv);
    if (typeof glRenderMembersCard === 'function') glRenderMembersCard();
  } catch (e) {
    if (ov) ov.remove();
    _confirmModal('Could not create the invite: ' + e.message, function(){}, 'Invite failed', 'OK');
  }
}

// One token, three skins: link · short code · QR.
function glShowInviteSkins(inv) {
  document.getElementById('_gl-skins-modal')?.remove();
  const r = GL_ROLES[inv.role] || GL_ROLES.reviewer;
  const url = _glJoinUrl(inv.token);
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-skins-modal';
  ov.style.zIndex = '9100';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:380px">
    <div class="modal-title">Invite ready — ${r.icon} ${r.name}</div>
    <div class="modal-msg" style="margin-bottom:6px">${_glEsc(r.sub)}</div>
    <div class="gl-inv-label">Send the link</div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <input readonly value="${_glEsc(url)}" id="_gl-inv-url" style="flex:1;min-width:0;background:var(--s2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:11px;padding:8px 10px">
      <button class="btn btn-amber" style="font-size:11px;padding:7px 12px;white-space:nowrap" onclick="_glCopy(document.getElementById('_gl-inv-url').value,this)">Copy</button>
      ${navigator.share ? `<button class="btn btn-outline" style="font-size:11px;padding:7px 12px" onclick='navigator.share({title:"GroundLog project invite",url:document.getElementById("_gl-inv-url").value}).catch(function(){})'>Share</button>` : ''}
    </div>
    <div class="gl-inv-label">…or read the code out loud</div>
    <div class="gl-inv-code" onclick="_glCopy('${inv.token}',this)" title="Tap to copy">${_glFmtToken(inv.token)}</div>
    <div class="gl-inv-label" style="margin-top:14px">…or have them scan it</div>
    <div style="display:flex;justify-content:center;margin:6px 0 4px"><canvas id="_gl-inv-qr" style="border-radius:8px;background:#fff;padding:8px"></canvas></div>
    <div class="modal-msg" style="font-size:11px;color:var(--muted2);margin:10px 0 14px">They'll get an accept step before anything is shared. Invite expires in 14 days — you can revoke it any time from Project Members.</div>
    <div class="modal-btns">
      <button class="modal-cancel" onclick="document.getElementById('_gl-skins-modal').remove()">Done</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  try {
    QRCode.toCanvas(document.getElementById('_gl-inv-qr'), url, { width: 168, margin: 0 });
  } catch (e) { const c = document.getElementById('_gl-inv-qr'); if (c) c.style.display = 'none'; }
}

// ═══════════════════════════════════════════
// INVITES — accept (invitee side)
// ═══════════════════════════════════════════

// Called post-auth from initFirebaseLoad. Reads the stashed token, validates,
// shows the accept sheet. Clears the stash on every terminal outcome.
let _glInviteCheckBusy = false;
async function glCheckPendingInvite() {
  const token = localStorage.getItem('gl_pending_invite');
  if (!token) return;
  const d = _sdb();
  if (!d) { console.log('GroundLog invite: pending token waiting for sign-in'); return; }
  if (_glInviteCheckBusy) return;   // boot timeout + manual entry can overlap
  _glInviteCheckBusy = true;
  console.log('GroundLog invite: checking pending token');
  const clear = () => localStorage.removeItem('gl_pending_invite');
  let inv;
  try {
    const doc = await d.collection('invites').doc(token).get();
    if (!doc.exists) {
      clear();
      return _confirmModal('That invite code wasn\'t found. Double-check the code, or ask for a fresh invite.', function(){}, 'Invite not found', 'OK');
    }
    inv = doc.data();
  } catch (e) {
    clear();
    console.warn('GroundLog invite: lookup failed —', e.message);
    return _confirmModal('Couldn\'t look up the invite: ' + e.message, function(){}, 'Invite', 'OK');
  } finally {
    _glInviteCheckBusy = false;
  }
  if (inv.status !== 'active') {
    clear();
    return _confirmModal('This invite has already been ' + (inv.status === 'used' ? 'used' : 'revoked') + '. Ask for a fresh one.', function(){}, 'Invite unavailable', 'OK');
  }
  if (inv.expiresAt && Date.now() > inv.expiresAt) {
    clear();
    return _confirmModal('This invite has expired. Ask for a fresh one.', function(){}, 'Invite expired', 'OK');
  }
  try {
    const mine = await _udb().collection('memberships').doc(inv.pid).get();
    if (mine.exists) {
      clear();
      showCloudBanner('✓ You\'re already a member of ' + (inv.projectName || 'that project') + '.');
      return;
    }
  } catch (e) { /* mirror read failed — proceed to accept; rules are the gate */ }
  _glShowAcceptSheet(inv, token, clear);
}

function _glShowAcceptSheet(inv, token, clear) {
  // Singleton — a boot-time check and a manual code entry can both land here;
  // two stacked sheets share button ids and the visible one ends up with no
  // handlers (the dead "Join project" bug). Replace, never stack.
  document.getElementById('_gl-accept-modal')?.remove();
  console.log('GroundLog invite: showing accept sheet for', inv.projectName || inv.pid);
  const r = GL_ROLES[inv.role] || GL_ROLES.reviewer;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-accept-modal';
  ov.style.zIndex = '9100';
  ov.innerHTML = `<div class="modal-box" style="max-width:360px">
    <div class="modal-title">Project invite</div>
    <div class="modal-msg"><b>${_glEsc(inv.createdByName || 'Someone')}</b> invited you to
      <b>${_glEsc(inv.projectName || 'a project')}</b> as <b>${r.icon} ${r.name}</b>.<br>
      <span style="font-size:12px;color:var(--muted2)">${_glEsc(r.sub)}</span></div>
    <div class="modal-btns">
      <button class="modal-cancel" id="_gl-accept-no">Not now</button>
      <button class="modal-confirm" id="_gl-accept-yes" style="background:var(--amber);border-color:var(--amber);color:#0e0e0e">Join project</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  // Handlers bind to THIS sheet's nodes (never id-lookups that can hit a stale twin).
  const noBtn = ov.querySelector('#_gl-accept-no');
  const yesBtn = ov.querySelector('#_gl-accept-yes');
  noBtn.onclick = () => { clear(); ov.remove(); };
  yesBtn.onclick = async () => {
    yesBtn.disabled = true; yesBtn.textContent = 'Joining…';
    console.log('GroundLog invite: accepting…');
    try {
      await glAcceptInvite(inv, token);
      clear(); ov.remove();
      console.log('GroundLog invite: joined', inv.pid);
    } catch (e) {
      clear(); ov.remove();
      console.warn('GroundLog invite: join failed —', e.message);
      _confirmModal('Couldn\'t join: ' + e.message, function(){}, 'Join failed', 'OK');
    }
  };
}

// Per-project settings stub for a joined project. Defaults are read off
// window (vite-esm-cross-module: settings.js consts are module-local — a bare
// typeof check silently yielded [] and emptied the joiner's checklist/flags).
function _glDefaultStub(projectName, role, now) {
  return {
    projectName,
    preparedBy: _glMyName(), org: '', activePhase: '',
    contractor: '', location: '', reviewedBy: '',
    createdAt: now, lastUsed: now, _ts: now,
    shared: true, sharedRole: role,
    checklistItems: [...(window.DEFAULT_CHECKLIST_ITEMS || [])],
    checklistTitle: 'Compliance Checklist',
    flagItems: [...(window.DEFAULT_FLAG_ITEMS || [])],
    flagsTitle: 'Regulatory & Incident Flags',
    presets: Object.assign({}, window.DEFAULT_PRESETS || {}),
    phases: [...(window.DEFAULT_PHASES || [])],
    cardTitles: {},
    tsConfig: Object.assign({}, window.TS_DEFAULTS || {}),
    phaseC_migrated: true
  };
}

// One-time repair for stubs written before the window-exposure fix: joined
// projects whose settings doc carries empty checklist/flags (and the old
// 178 per-diem default) get the real defaults merged in.
async function glRepairSharedStubs() {
  if (!_sdb() || typeof knownProjectsGet !== 'function') return;
  const shared = knownProjectsGet().filter(p => p.projectId && p.shared);
  for (const p of shared) {
    try {
      const ref = _udb().collection('settings').doc(p.projectId);
      const doc = await ref.get();
      if (!doc.exists || !doc.data().shared) continue;
      const d = doc.data();
      const fix = {};
      if (!Array.isArray(d.checklistItems) || !d.checklistItems.length)
        fix.checklistItems = [...(window.DEFAULT_CHECKLIST_ITEMS || [])];
      if (!Array.isArray(d.flagItems) || !d.flagItems.length)
        fix.flagItems = [...(window.DEFAULT_FLAG_ITEMS || [])];
      if (!d.phases || !d.phases.length) fix.phases = [...(window.DEFAULT_PHASES || [])];
      if (!d.presets || !Object.keys(d.presets).length) fix.presets = Object.assign({}, window.DEFAULT_PRESETS || {});
      if (d.tsConfig && d.tsConfig.perDiem === 178) fix.tsConfig = Object.assign({}, d.tsConfig, { perDiem: 0 });
      if (Object.keys(fix).length) {
        await ref.set(Object.assign(fix, { _ts: Date.now() }), { merge: true });
        console.log('GroundLog: repaired shared-project stub for', p.projectName);
        if (p.projectId === _activeProjectId() && typeof _applyProjectSettings === 'function') {
          _applyProjectSettings(Object.assign({}, d, fix));
        }
      }
    } catch (e) { /* repair is best-effort */ }
  }
}

async function glAcceptInvite(inv, token) {
  const d = _sdb();
  if (!d) throw new Error('not signed in');
  const uid = _currentUser.uid;
  const now = Date.now();
  // 1. Membership — the rules-checked write (invite must be live + role match).
  await d.collection('projects').doc(inv.pid).collection('members').doc(uid).set({
    role: inv.role, level: inv.role === 'lead' ? 0 : 1,
    addedBy: inv.createdBy, addedAt: now, inviteToken: token,
    displayName: _glMyName(), email: _currentUser.email || ''
  });
  // 2. Consume the token (single-use). Membership already granted if this fails.
  try {
    await d.collection('invites').doc(token).update({ status: 'used', usedBy: uid, usedAt: now });
  } catch (e) { console.warn('invite consume failed (membership granted):', e.message); }
  // 3. Mirror for "my projects" listing.
  await _udb().collection('memberships').doc(inv.pid).set({
    pid: inv.pid, projectName: inv.projectName || '', role: inv.role, joinedAt: now
  });
  // 4. Own per-project settings stub — loadProject/syncs work unchanged for
  //    shared projects, and per-project personal prefs get a home (nav defaults later).
  const stub = _glDefaultStub(inv.projectName || 'Shared project', inv.role, now);
  await _udb().collection('settings').doc(inv.pid).set(stub, { merge: true });
  // 5. Local known-projects entry (shared-flagged) so the switcher lists it.
  try {
    const list = knownProjectsGet();
    if (!list.some(p => p.projectId === inv.pid)) {
      list.push({ projectId: inv.pid, projectName: stub.projectName, location: '',
        shared: true, role: inv.role, lastUsed: now });
      localStorage.setItem('gl_known_projects', JSON.stringify(list));
      _udb().collection('settings').doc('knownProjects').set({ projects: list, _ts: now }).catch(() => {});
    }
  } catch (e) { /* listing only — membership is already real */ }
  showCloudBanner('✓ Joined ' + (inv.projectName || 'project') + ' as ' + (GL_ROLES[inv.role] || {}).name + '.');
  _glShowOrientation(inv);
  // 6. Switch into the project they just joined.
  if (typeof loadProject === 'function') {
    try { await loadProject(inv.pid, stub); } catch (e) { console.warn('post-join loadProject:', e.message); }
  }
}

// Role-scoped orientation — the "what just happened" card shown once on join.
function _glShowOrientation(inv) {
  const r = GL_ROLES[inv.role] || GL_ROLES.reviewer;
  const pts = inv.role === 'reviewer' ? [
    'You see what gets <b>published</b> to this project — submitted logs, shared drawings and photos.',
    'Nothing here is editable by you, and nobody sees <b>your</b> private work.',
    'Project setup data (maps, categories) is visible right away; daily work appears as it\'s shared.'
  ] : [
    'Your daily logs and notes stay <b>yours</b> until you publish or submit them.',
    'Drawings, photos and tracker entries you create are stamped as yours.',
    'Submitting a day shares a snapshot — you can keep editing, never silently.'
  ];
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-orient-modal';
  ov.style.zIndex = '9100';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:360px">
    <div class="modal-title">${r.icon} You're ${r.name} on ${_glEsc(inv.projectName || 'this project')}</div>
    <div class="modal-msg">
      <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px">
        ${pts.map(p => '<li>' + p + '</li>').join('')}
      </ul>
    </div>
    <div class="modal-btns">
      <button class="modal-confirm" style="background:var(--amber);border-color:var(--amber);color:#0e0e0e" onclick="document.getElementById('_gl-orient-modal').remove()">Got it</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}

// Manual code entry — the phone skin. Reachable from the project switcher.
// Also the cross-context recovery when a QR/link stash landed in a different
// browser context (Safari tab vs installed PWA).
function glShowJoinByCode() {
  document.getElementById('_proj-switcher')?.remove();
  document.getElementById('_gl-join-modal')?.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-join-modal';
  ov.style.zIndex = '9100';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:340px">
    <div class="modal-title">Join with a code</div>
    <div class="modal-msg" style="margin-bottom:10px">Enter the invite code you were given — like <span style="font-family:var(--mono)">7H2KM-9XQ4D</span>.</div>
    <input id="_gl-join-code" autocomplete="off" autocapitalize="characters" placeholder="XXXXX-XXXXX" style="width:100%;box-sizing:border-box;background:var(--s2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:18px;letter-spacing:.12em;text-align:center;padding:10px;margin-bottom:14px">
    <div class="modal-btns">
      <button class="modal-cancel" id="_gl-join-cancel">Cancel</button>
      <button class="modal-confirm" id="_gl-join-go" style="background:var(--amber);border-color:var(--amber);color:#0e0e0e">Look up invite</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('#_gl-join-code');
  const goBtn = ov.querySelector('#_gl-join-go');
  ov.querySelector('#_gl-join-cancel').onclick = () => ov.remove();
  setTimeout(() => input.focus(), 60);
  goBtn.onclick = () => {
    const tok = _glNormToken(input.value);
    if (tok.length < 6) { input.style.borderColor = 'var(--red)'; return; }
    localStorage.setItem('gl_pending_invite', tok);
    ov.remove();
    glCheckPendingInvite();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });
}

// ═══════════════════════════════════════════
// MEMBERS CARD (Settings → Project Members)
// ═══════════════════════════════════════════

async function glRenderMembersCard() {
  const host = document.getElementById('members-card-body');
  if (!host) return;
  const d = _sdb();
  const pid = _activeProjectId();
  if (!d || !pid || pid === 'default') {
    host.innerHTML = '<div class="gl-mem-empty">Sign in and open a project to manage members.</div>';
    return;
  }
  host.innerHTML = '<div class="gl-mem-empty">Loading members…</div>';
  let members = [], myRole = null;
  try {
    const snap = await d.collection('projects').doc(pid).collection('members').get();
    snap.forEach(m => members.push(Object.assign({ uid: m.id }, m.data())));
    const me = members.find(m => m.uid === _currentUser.uid);
    myRole = me ? me.role : null;
  } catch (e) {
    // Most likely: shared doc not backfilled yet (or offline).
    host.innerHTML = `<div class="gl-mem-empty">This project isn't set up for sharing yet.
      <button class="btn btn-outline" style="font-size:10px;padding:4px 10px;margin-left:8px" onclick="glEnableSharing()">Enable sharing</button></div>`;
    return;
  }
  const isLead = myRole === 'lead';
  const order = { lead: 0, field: 1, reviewer: 2 };
  members.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || (a.addedAt || 0) - (b.addedAt || 0));
  const leadCount = members.filter(m => m.role === 'lead').length;
  const rows = members.map(m => {
    const r = GL_ROLES[m.role] || { name: m.role, icon: '·', sub: '' };
    const self = m.uid === _currentUser.uid;
    const canRemove = (isLead && !self) || (self && !(m.role === 'lead' && leadCount === 1));
    return `<div class="gl-mem-row">
      <div class="gl-mem-info">
        <div class="gl-mem-name">${_glEsc(m.displayName || m.email || m.uid.slice(0, 8))}${self ? ' <span class="gl-mem-you">you</span>' : ''}</div>
        <div class="gl-mem-sub">${_glEsc(m.email || '')}</div>
      </div>
      <span class="gl-role-chip" title="${_glEsc(r.sub)}">${r.icon} ${r.name}</span>
      ${canRemove ? `<button class="gl-mem-x" title="${self ? 'Leave project' : 'Remove member'}" onclick="glRemoveMember('${m.uid}',${self})">✕</button>` : ''}
    </div>`;
  }).join('');
  let invitesHtml = '';
  if (isLead) {
    let pending = [];
    try {
      const isnap = await d.collection('invites')
        .where('createdBy', '==', _currentUser.uid)
        .where('pid', '==', pid).get();
      isnap.forEach(i => { const v = i.data(); if (v.status === 'active' && (!v.expiresAt || v.expiresAt > Date.now())) pending.push(Object.assign({ token: i.id }, v)); });
    } catch (e) { /* listing failure is non-blocking */ }
    invitesHtml = `
      <div class="gl-inv-label" style="margin-top:14px">Pending invites</div>
      ${pending.length ? pending.map(i => {
        const r = GL_ROLES[i.role] || { name: i.role, icon: '·' };
        return `<div class="gl-mem-row">
          <div class="gl-mem-info">
            <div class="gl-mem-name" style="font-family:var(--mono)">${_glFmtToken(i.token)}</div>
            <div class="gl-mem-sub">expires ${new Date(i.expiresAt).toLocaleDateString()}</div>
          </div>
          <span class="gl-role-chip">${r.icon} ${r.name}</span>
          <button class="gl-mem-x" title="Revoke invite" onclick="glRevokeInvite('${i.token}')">✕</button>
        </div>`;
      }).join('') : '<div class="gl-mem-sub" style="padding:4px 0 2px">None — mint one below.</div>'}
      <button class="btn btn-amber" style="font-size:11px;padding:7px 14px;margin-top:10px" onclick="glShowInviteModal()">+ Invite someone</button>`;
  }
  host.innerHTML = rows
    + `<button class="btn btn-outline" style="font-size:11px;padding:7px 14px;margin-top:10px" onclick="glShowProjectSpace()">📁 Project Space</button>`
    + invitesHtml;
}

// Manual fallback if boot backfill didn't reach this project yet.
async function glEnableSharing() {
  try {
    const cfg = (typeof loadProjectConfig === 'function') ? loadProjectConfig() : {};
    await glEnsureSharedProject(_activeProjectId(), cfg);
    glRenderMembersCard();
  } catch (e) {
    _confirmModal('Could not enable sharing: ' + e.message, function(){}, 'Sharing', 'OK');
  }
}

function glRemoveMember(uid, isSelf) {
  const d = _sdb();
  if (!d) return;
  const pid = _activeProjectId();
  const msg = isSelf
    ? 'Leave this project? You\'ll lose access to everything shared in it. Your own account data is untouched.'
    : 'Remove this member? They lose access to the project now — everything they already exported stays theirs.';
  _confirmModal(msg, async function() {
    try {
      await d.collection('projects').doc(pid).collection('members').doc(uid).delete();
      if (isSelf) {
        await _udb().collection('memberships').doc(pid).delete().catch(() => {});
        try {
          const list = knownProjectsGet().filter(p => p.projectId !== pid);
          localStorage.setItem('gl_known_projects', JSON.stringify(list));
          _udb().collection('settings').doc('knownProjects').set({ projects: list, _ts: Date.now() }).catch(() => {});
        } catch (e) {}
        showCloudBanner('You left the project.');
      }
      glRenderMembersCard();
    } catch (e) {
      _confirmModal('Could not remove: ' + e.message, function(){}, 'Members', 'OK');
    }
  }, isSelf ? 'Leave project' : 'Remove member', isSelf ? 'Leave' : 'Remove');
}

function glRevokeInvite(token) {
  const d = _sdb();
  if (!d) return;
  _confirmModal('Revoke this invite? The link and code stop working immediately.', async function() {
    try {
      await d.collection('invites').doc(token).update({ status: 'revoked' });
      glRenderMembersCard();
    } catch (e) {
      _confirmModal('Could not revoke: ' + e.message, function(){}, 'Invites', 'OK');
    }
  }, 'Revoke invite', 'Revoke');
}

// ═══════════════════════════════════════════
// PROJECT-SHARED MAP TOKEN (api-key-scoping: project-scoped, never global)
// ═══════════════════════════════════════════
// Lead shares their Mapbox token to projects/{pid}/config/mapKey (rules:
// members read, lead writes — already deployed). Members' mapInit falls back
// to it after their own token sources. Mapbox pk tokens are public-by-design;
// usage meters to the lead's Mapbox account.

// Show the share button (Settings → Map Settings) only to a lead of the
// active shared project.
async function _glInitMapShareBtn() {
  const wrap = document.getElementById('cfg-map-share-wrap');
  if (!wrap) return;
  if (!_sdb()) { wrap.style.display = 'none'; return; }
  try {
    const pid = _activeProjectId();
    if (!pid || pid === 'default') { wrap.style.display = 'none'; return; }
    const mir = await _udb().collection('memberships').doc(pid).get();
    wrap.style.display = (mir.exists && mir.data().role === 'lead') ? '' : 'none';
  } catch (e) { wrap.style.display = 'none'; }
}

async function glShareMapToken() {
  const d = _sdb();
  if (!d) return;
  const st = document.getElementById('cfg-map-share-status');
  const say = (msg, bad) => {
    if (!st) return;
    st.textContent = msg;
    st.style.color = bad ? 'var(--red)' : 'var(--green)';
    st.style.opacity = '1';
    setTimeout(() => { st.style.opacity = '0'; }, 3500);
  };
  try {
    // Own settings doc is the cross-platform source (web + native token fields);
    // current platform's localStorage is the fallback.
    const cfgDoc = await _udb().collection('settings').doc('projectConfig').get();
    const cfg = cfgDoc.exists ? cfgDoc.data() : {};
    const web = (cfg.mapboxToken || localStorage.getItem('gl_map_token') || '').trim();
    const native = (cfg.mapboxTokenNative || localStorage.getItem('gl_map_token_native') || '').trim();
    if (!web && !native) return say('Save your Mapbox token above first.', true);
    await d.collection('projects').doc(_activeProjectId()).collection('config').doc('mapKey').set({
      mapboxToken: web, mapboxTokenNative: native,
      sharedBy: _currentUser.uid, sharedByName: _glMyName(), _ts: Date.now()
    });
    say('✓ Map token shared with project members');
  } catch (e) {
    say('Share failed: ' + e.message, true);
  }
}

// ═══════════════════════════════════════════
// SUBMISSIONS — close-day snapshots (v1)
// ═══════════════════════════════════════════
// Submit = the integrity watermark: an immutable, versioned snapshot of the
// day shared to the project. Post-submit edits stay private until an explicit
// resubmit (new version doc). Personal fields (p-*) are excluded at the data
// layer — they never exist in any snapshot. Checklist/flag item TEXT is
// embedded so the snapshot stays self-contained when configs change later.

function glBuildSubmissionPayload() {
  if (typeof collectFormState !== 'function') return null;
  const state = collectFormState();
  const fields = {};
  Object.entries(state.fields || {}).forEach(([id, val]) => {
    if (!id.startsWith('p-')) fields[id] = val;   // personal data never leaves user space
  });
  const checklist = (window.checklistItems || []).map(c => ({
    id: c.id, text: c.text,
    checked: !!(state.checklist && state.checklist[c.id] && state.checklist[c.id].checked),
    note: (state.checklist && state.checklist[c.id] && state.checklist[c.id].note) || ''
  }));
  const flags = (window.flagItems || []).map(f => ({
    id: f.id, text: f.text,
    flagged: !!(state.checkboxes && state.checkboxes[f.id]),
    note: (state.flagNotes && state.flagNotes[f.id.replace('flag-', '')]) || ''
  }));
  const crew = (state.crew || []).map(b => ({
    name: b.name || '', time: b.time || '', loc: b.loc || '', acts: b.acts || '',
    envcomp: b.envcomp || '', issues: b.issues || '', notes: b.notes || ''
  }));
  return { fields, sky: state.sky || [], checklist, flags, crew };
}

function _glSubmitSay(msg, bad) {
  const st = document.getElementById('submit-day-status');
  if (!st) return;
  st.textContent = msg;
  st.style.color = bad ? 'var(--red)' : 'var(--green)';
  st.style.opacity = '1';
  setTimeout(() => { st.style.opacity = '0'; }, 4500);
}

// Entry point — the submit-day REVIEW SHEET (submission-sharing-model §publish
// mechanics): log summary + that day's unpublished work product, all checked by
// default; uncheck to hold back. Held items stay private and reappear in the
// next submit (or Share-now later). Earlier unpublished items ride along as a
// collapsed, default-unchecked group — that's also the bulk-publish-history lever.
function glSubmitDay() {
  const d = _sdb();
  if (!d) return _glSubmitSay('Sign in first.', true);
  const pid = _activeProjectId();
  if (!pid || pid === 'default') return _glSubmitSay('Open a project first.', true);
  const payload = glBuildSubmissionPayload();
  if (!payload) return _glSubmitSay('Nothing to submit.', true);
  const date = payload.fields.reportDate || new Date().toLocaleDateString('en-CA');
  _glShowSubmitReview(payload, date, pid)
    .catch(e => _glSubmitSay('Could not open the review sheet: ' + e.message, true));
}

async function _glShowSubmitReview(payload, date, pid) {
  const projName = (typeof loadProjectConfig === 'function' ? loadProjectConfig().projectName : '') || 'this project';
  // Unpublished work product, this project. Entries/photos come from the live
  // local caches; markers from the user's own collection (small).
  const entries = (typeof trGetEntriesForProject === 'function' ? trGetEntriesForProject(pid) : [])
    .filter(e => !e.published);
  const photos = (window._phPhotos || []).filter(p => p.projectId === pid && !p.published);
  const markersById = {};
  let markers = [];
  try {
    // Markers are scoped by the RAW config projectName (matching
    // mapRenderFieldMarkers) — not the 'this project' display fallback.
    const cfgName = (typeof loadProjectConfig === 'function' ? loadProjectConfig().projectName : '') || '';
    const snap = await _udb().collection('fieldMarkers').get();
    snap.forEach(m => {
      const v = Object.assign({ id: m.id }, m.data());
      if (v.scope !== 'global' && cfgName && v.projectName === cfgName && !v.published) {
        markers.push(v);
        markersById[m.id] = v;
      }
    });
  } catch (e) { /* markers are optional in the sheet */ }

  const mDate = m => new Date(m.createdAt || 0).toLocaleDateString('en-CA');
  // Row text = main text color, date = amber — keeps the fields visually
  // separated instead of one teal wall (Tim, 6/11).
  const row = (type, id, label, sub, checked) =>
    `<label style="display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,.07);cursor:pointer">
      <input type="checkbox" data-type="${type}" data-id="${_glEsc(id)}"${checked ? ' checked' : ''} style="width:17px;height:17px;accent-color:var(--amber,#C9A84C);flex-shrink:0">
      <span style="flex:1;min-width:0;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
      ${sub ? `<span style="font-size:10.5px;color:var(--amber,#C9A84C);flex-shrink:0">${sub}</span>` : ''}
    </label>`;
  const entryRow = (e, c) => row('entry', e.id,
    '✏️ ' + _glEsc(e.categoryName || 'Drawing') + (e.entryType === 'planned' ? ' · plan' : ''), _glEsc(e.date || ''), c);
  const photoRow = (p, c) => row('photo', p.id, '📷 ' + _glEsc(p.caption || p.filename || 'Photo'), _glEsc(p.date || ''), c);
  const markerRow = (m, c) => row('marker', m.id, (m.emoji || '📍') + ' ' + _glEsc(m.label || 'Field marker'), _glEsc(mDate(m)), c);

  const dayE = entries.filter(e => e.date === date), preE = entries.filter(e => e.date !== date);
  const dayP = photos.filter(p => p.date === date),  preP = photos.filter(p => p.date !== date);
  const dayM = markers.filter(m => mDate(m) === date), preM = markers.filter(m => mDate(m) !== date);
  const dayCount = dayE.length + dayP.length + dayM.length;
  const preCount = preE.length + preP.length + preM.length;

  document.getElementById('_gl-review-sheet')?.remove();
  const ov = document.createElement('div');
  ov.className = 'proj-switcher-overlay';
  ov.id = '_gl-review-sheet';
  ov.style.zIndex = '9080';
  ov.onclick = e => { if (e.target === ov) { window._glAfterSubmitStartToday = false; ov.remove(); } };
  ov.innerHTML = `<div class="proj-switcher-sheet" style="max-height:88vh">
    <div class="proj-switcher-header">
      <span class="proj-switcher-title">Submit ${_glEsc(_glSubFmtDate(date))}</span>
      <button class="proj-switcher-close" id="_gl-rev-close">✕</button>
    </div>
    <div class="proj-row-meta" style="margin:-8px 0 12px;white-space:normal;overflow:visible;text-overflow:unset">to <b style="color:var(--amber,#C9A84C)">${_glEsc(projName)}</b> — everything checked below becomes visible to project members. <span style="color:var(--text)">Your personal section is never included.</span></div>
    <div style="display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,.12)">
      <span style="width:17px;text-align:center;color:var(--s3);flex-shrink:0">✓</span>
      <span style="flex:1;font-size:12px;font-weight:700;color:var(--text)">📋 Daily log snapshot</span>
      <span style="font-size:10.5px;color:var(--muted2)">always included</span>
    </div>
    ${dayCount ? `<div class="gl-inv-label" style="margin-top:12px;color:var(--amber,#C9A84C)">This day's items (${dayCount})</div>
      ${dayE.map(e => entryRow(e, true)).join('')}${dayP.map(p => photoRow(p, true)).join('')}${dayM.map(m => markerRow(m, true)).join('')}`
    : '<div class="proj-row-meta" style="margin-top:12px;white-space:normal;overflow:visible;text-overflow:unset">No unpublished drawings, photos or markers for this day.</div>'}
    ${preCount ? `<div style="margin-top:12px;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
        <input type="checkbox" id="_gl-rev-preall" style="width:17px;height:17px;accent-color:var(--amber,#C9A84C);flex-shrink:0">
        <span id="_gl-rev-pretoggle" style="flex:1;font-size:12px;color:var(--text)">Earlier unpublished items <b style="color:var(--amber,#C9A84C)">(${preCount})</b> <span style="color:var(--muted2)">— from other days; check to publish too</span></span>
        <span id="_gl-rev-prechev" style="color:var(--muted2)">▸</span>
      </div>
      <div id="_gl-rev-prelist" style="display:none;margin-top:6px">
        ${preE.map(e => entryRow(e, false)).join('')}${preP.map(p => photoRow(p, false)).join('')}${preM.map(m => markerRow(m, false)).join('')}
      </div>
    </div>` : ''}
    <div style="margin-top:14px;padding:9px 12px;border:1px solid rgba(255,255,255,.12);border-radius:8px;font-family:var(--mono);font-size:10.5px;line-height:1.55;color:var(--text)">✍ By submitting, I certify this record is accurate and complete to the best of my knowledge.<div style="color:var(--muted2);margin-top:3px">Recorded as ${_glEsc(_glMyName())} · attested by your account, date and version trail.</div></div>
    <div class="modal-btns" style="margin-top:14px">
      <button class="modal-cancel" id="_gl-rev-cancel">Cancel</button>
      <button class="modal-confirm" id="_gl-rev-submit" style="background:var(--s3);border-color:var(--s3)">Submit day</button>
    </div>
    <div class="proj-row-meta" style="margin-top:10px;white-space:normal;overflow:visible;text-overflow:unset">Unchecked items stay private — they'll be offered again next submit, or share them any time from the map. You can keep editing after submitting; reviewers see a resubmit only when you post one.</div>
  </div>`;
  document.body.appendChild(ov);
  // Bailing out of the sheet also cancels any pending "then start today" chain
  // from the next-day prompt — nothing was submitted, so nothing advances.
  const bail = () => { window._glAfterSubmitStartToday = false; ov.remove(); };
  ov.querySelector('#_gl-rev-close').onclick = bail;
  ov.querySelector('#_gl-rev-cancel').onclick = bail;
  const preAll = ov.querySelector('#_gl-rev-preall');
  const preToggle = ov.querySelector('#_gl-rev-pretoggle');
  if (preToggle) {
    const flip = () => {
      const list = ov.querySelector('#_gl-rev-prelist');
      const open = list.style.display === 'none';
      list.style.display = open ? '' : 'none';
      ov.querySelector('#_gl-rev-prechev').textContent = open ? '▾' : '▸';
    };
    preToggle.onclick = flip;
    ov.querySelector('#_gl-rev-prechev').onclick = flip;
    preAll.onchange = () => {
      ov.querySelectorAll('#_gl-rev-prelist input[type=checkbox]').forEach(cb => { cb.checked = preAll.checked; });
    };
  }
  ov.querySelector('#_gl-rev-submit').onclick = () => _glReviewSubmit(ov, payload, date, pid, markersById);
}

// Publish everything checked, then post the close-day snapshot.
async function _glReviewSubmit(ov, payload, date, pid, markersById) {
  const btn = ov.querySelector('#_gl-rev-submit');
  btn.disabled = true; btn.textContent = 'Submitting…';
  const picks = { entry: [], photo: [], marker: [] };
  ov.querySelectorAll('input[type=checkbox][data-type]').forEach(cb => {
    if (cb.checked && picks[cb.dataset.type]) picks[cb.dataset.type].push(cb.dataset.id);
  });
  let published = 0;
  try {
    if (picks.entry.length && typeof trSetPublished === 'function')
      published += await trSetPublished(picks.entry, true, pid);
    if (picks.photo.length && typeof phSetPublished === 'function')
      published += await phSetPublished(picks.photo, true, pid);
    if (picks.marker.length)
      published += await glSetMarkersPublished(markersById, picks.marker, true, pid);
  } catch (e) { console.warn('submit-day publish batch:', e.message); }
  ov.remove();
  await _glDoSubmitDay(payload, date, published);
}

// Publish/unpublish field markers: stamp the user's own doc + maintain the
// project-space mirror copy (capability model — same as photos).
async function glSetMarkersPublished(markersById, ids, publish, pid) {
  const d = _sdb();
  if (!d || !ids.length) return 0;
  const now = Date.now();
  const batch = d.batch();
  let n = 0;
  ids.forEach(id => {
    const m = markersById[id];
    if (!m) return;
    batch.set(_udb().collection('fieldMarkers').doc(id),
      { published: !!publish, publishedAt: publish ? now : null }, { merge: true });
    const mref = d.collection('projects').doc(pid).collection('fieldMarkers').doc(id);
    if (publish) {
      batch.set(mref, {
        emoji: m.emoji || '📍', label: m.label || '', lat: m.lat, lng: m.lng,
        projectName: m.projectName || '', createdAt: m.createdAt || now,
        ownerUid: _currentUser.uid, ownerName: _glMyName(),
        published: true, publishedAt: now
      });
    } else {
      batch.delete(mref);
    }
    n++;
  });
  if (n) await batch.commit().catch(e => console.warn('glSetMarkersPublished:', e.message));
  return n;
}

async function _glDoSubmitDay(payload, date, publishedCount) {
  const d = _sdb();
  if (!d) return;
  const pid = _activeProjectId();
  const say = _glSubmitSay;
  const btn = document.getElementById('btn-submit-day');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  let version = 1;
  try {
    const snap = await d.collection('projects').doc(pid).collection('submissions')
      .where('date', '==', date).get();
    snap.forEach(s => { const v = s.data().version || 1; if (v >= version) version = v + 1; });
  } catch (e) { /* first submission for the project */ }
  try {
    await d.collection('projects').doc(pid).collection('submissions').doc(date + '_v' + version).set({
      date, version, status: 'active', audience: 'project',
      submittedBy: _currentUser.uid, submittedByName: _glMyName(),
      submittedAt: Date.now(),
      projectName: (typeof loadProjectConfig === 'function' ? (loadProjectConfig().projectName || '') : ''),
      payload
    });
    const pubNote = publishedCount ? (' · ' + publishedCount + ' item' + (publishedCount > 1 ? 's' : '') + ' published') : '';
    say((version > 1 ? ('✓ Resubmitted — v' + version + ' posted') : '✓ Day submitted to the project') + pubNote);
    showCloudBanner('✓ ' + date + ' submitted to the project' + (version > 1 ? ' (v' + version + ')' : '') + pubNote + '.');
    console.log('GroundLog submissions: posted', date, 'v' + version, publishedCount ? ('+' + publishedCount + ' published') : '');
    _glMarkSubmitted(pid, date, version);
    glUpdateSubmitBadge();
    // Next-day prompt chain: yesterday is submitted — offer to start today.
    if (window._glAfterSubmitStartToday) {
      window._glAfterSubmitStartToday = false;
      if (typeof _confirmModal === 'function' && typeof newDayStartFresh === 'function')
        _confirmModal('Day submitted ✓ — start today’s log now?',
          function () { newDayStartFresh(); }, '🌅 New Day', 'Start Today');
    }
  } catch (e) {
    say(e.code === 'permission-denied'
      ? 'Your role on this project is view-only — nothing to submit.'
      : ('Submit failed: ' + e.message), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📤 Submit Day to Project'; }
  }
}

function _glSubFmtDate(ds) {
  try {
    const [y, m, dd] = (ds || '').split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return ds || ''; }
}

// ═══════════════════════════════════════════
// SUBMIT DISCIPLINE — next-day prompt + open-day tracking
// ═══════════════════════════════════════════
// (submission-sharing-model §Next-day flow.) A local cache of MY submitted
// dates per project makes the prompt and badges instant + offline-tolerant;
// the submissions collection stays the source of truth (cache refreshes via
// one members-readable query). Self-calibrating: a project where I've never
// submitted never nags, and reviewers (view-only) are never asked.

function _glMySubsKey(pid) { return 'gl_my_subs_' + pid; }

function glMySubmittedDates(pid) {
  try { return JSON.parse(localStorage.getItem(_glMySubsKey(pid)) || '{}'); } catch (e) { return {}; }
}

function _glMarkSubmitted(pid, date, version) {
  try {
    const m = glMySubmittedDates(pid);
    m[date] = version || 1;
    localStorage.setItem(_glMySubsKey(pid), JSON.stringify(m));
  } catch (e) { /* cache only */ }
}

async function glRefreshMySubmittedDates(pid) {
  const d = _sdb();
  if (!d || !pid || pid === 'default') return glMySubmittedDates(pid);
  try {
    const snap = await d.collection('projects').doc(pid).collection('submissions')
      .where('submittedBy', '==', _currentUser.uid).get();
    // Withdrawn = no active snapshot → the day counts as unsubmitted again.
    const live = {}, withdrawn = {};
    snap.forEach(s => {
      const v = s.data();
      if (!v.date) return;
      const tgt = v.status === 'withdrawn' ? withdrawn : live;
      if (!tgt[v.date] || (v.version || 1) > tgt[v.date]) tgt[v.date] = v.version || 1;
    });
    Object.keys(withdrawn).forEach(dt => { if (live[dt] && withdrawn[dt] >= live[dt]) delete live[dt]; });
    localStorage.setItem(_glMySubsKey(pid), JSON.stringify(live));
    return live;
  } catch (e) { return glMySubmittedDates(pid); }
}

function _glDayHasContent(rec) {
  if (!rec) return false;
  if ((rec.crew || []).length) return true;
  const f = rec.fields || {};
  return Object.entries(f).some(([k, v]) =>
    k !== 'reportDate' && !k.startsWith('p-') && typeof v === 'string' && v.trim());
}

// Past days with log content that have no active submission. Floored at the
// first date ever submitted on this project — days from before the user
// started using submissions aren't debt, they're history.
function glUnsubmittedDates(pid) {
  if (!pid || pid === 'default') return [];
  if (glMyRoleFor(pid) === 'reviewer') return [];
  const subs = glMySubmittedDates(pid);
  const subDates = Object.keys(subs);
  if (!subDates.length) return [];
  const floor = subDates.sort()[0];
  const today = (typeof localToday === 'function') ? localToday() : new Date().toLocaleDateString('en-CA');
  const all = (typeof dlGetAll === 'function') ? dlGetAll() : {};
  const open = {};
  Object.entries(all).forEach(([dt, rec]) => {
    if (dt >= floor && dt < today && !subs[dt] && (!rec.projectId || rec.projectId === pid) && _glDayHasContent(rec)) open[dt] = 1;
  });
  // The live form's day may not be archived yet.
  try {
    const cur = document.getElementById('reportDate')?.value || '';
    if (cur && cur >= floor && cur < today && !subs[cur]) open[cur] = 1;
  } catch (e) {}
  return Object.keys(open).sort();
}

// ── Log-page badge: how many past days are still unsubmitted. Passive,
//    reassure-don't-alarm — a pointer, not a blocker. Renders instantly from
//    the local cache; a throttled background refresh keeps it honest when a
//    day was submitted from another device.
let _glSubsRefreshTs = 0;
function _glRenderSubmitBadge() {
  const el = document.getElementById('submit-open-days');
  if (!el) return;
  const open = glUnsubmittedDates(_activeProjectId());
  if (!open.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const last = open[open.length - 1];
  el.style.display = 'block';
  el.innerHTML = '⏳ ' + (open.length === 1
    ? _glSubFmtDate(last) + ' hasn’t been submitted yet'
    : open.length + ' past days haven’t been submitted yet') +
    ' — <span onclick="showPage(\'calendar\')" style="text-decoration:underline;cursor:pointer">see Calendar</span>';
}
function glUpdateSubmitBadge() {
  _glRenderSubmitBadge();
  const pid = _activeProjectId();
  if (pid && pid !== 'default' && Object.keys(glMySubmittedDates(pid)).length &&
      Date.now() - _glSubsRefreshTs > 300000) {
    _glSubsRefreshTs = Date.now();
    glRefreshMySubmittedDates(pid).then(() => _glRenderSubmitBadge()).catch(() => {});
  }
}

// ── New Day modal hook: offer "review & submit yesterday first" when the
//    previous day is unsubmitted on a project where submissions are in use.
async function _ndMaybeOfferSubmit(prevDate) {
  const block = document.getElementById('nd-submit-block');
  if (!block) return;
  block.style.display = 'none';
  const pid = _activeProjectId();
  if (!pid || pid === 'default' || !prevDate) return;
  if (glMyRoleFor(pid) === 'reviewer') return;
  let subs = glMySubmittedDates(pid);
  if (!Object.keys(subs).length) subs = await glRefreshMySubmittedDates(pid);
  else glRefreshMySubmittedDates(pid).then(m => {       // a submit from another device counts
    if (m[prevDate]) block.style.display = 'none';
  }).catch(() => {});
  if (!Object.keys(subs).length) return;                 // submissions not in use here — don't nag
  if (subs[prevDate]) return;                            // already submitted
  const projName = (typeof loadProjectConfig === 'function' ? loadProjectConfig().projectName : '') || 'the project';
  const open = glUnsubmittedDates(pid);
  const msg = document.getElementById('nd-submit-msg');
  if (msg) msg.innerHTML = '<b>' + _glEsc(_glSubFmtDate(prevDate)) + '</b> hasn’t been submitted to <b style="color:var(--amber,#C9A84C)">' + _glEsc(projName) + '</b> yet.' +
    (open.length > 1 ? ' <span style="color:var(--muted2)">(' + open.length + ' open days total — they’re marked on the Calendar.)</span>' : '');
  const btnLabel = document.getElementById('nd-submit-btn-label');
  if (btnLabel) btnLabel.textContent = 'Review & Submit ' + ((typeof dlFmtDisplay === 'function') ? dlFmtDisplay(prevDate) : prevDate);
  block.style.display = 'block';
}

// The prompt's Review path: the form still holds the previous day, so the
// regular submit review sheet targets exactly that day. No suppression is set —
// if the user bails out of the sheet, the New Day modal comes back on the next
// foreground check and nothing was lost.
function newDaySubmitFirst() {
  const ov = document.getElementById('nd-overlay');
  if (ov) ov.style.display = 'none';
  window._glAfterSubmitStartToday = true;
  glSubmitDay();
}

// ── Member identity chip — stable per-person color (uid hash) + initial.
// The calendar (and future member-attributed surfaces) use this to tell
// people apart at a glance: same person = same color everywhere.
const GL_CHIP_COLORS = ['#4FD1C5', '#E8B84B', '#9B59B6', '#E67E22', '#4A90E2', '#27AE60', '#E74C3C', '#D4A5E8'];
function glMemberChip(uid, name, size) {
  let h = 0;
  const u = uid || '';
  for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) >>> 0;
  const c = GL_CHIP_COLORS[h % GL_CHIP_COLORS.length];
  const initial = ((name || '?').trim().charAt(0) || '?').toUpperCase();
  const s = size || 14;
  return `<span title="${_glEsc(name || '')}" style="display:inline-flex;align-items:center;justify-content:center;width:${s}px;height:${s}px;border-radius:50%;background:${c};color:#0e0e0e;font-family:var(--mono);font-size:${Math.round(s * 0.62)}px;font-weight:700;line-height:1;flex-shrink:0">${initial}</span>`;
}

// ── Teammates' submissions for the calendar — { 'YYYY-MM-DD': [sub, …] }.
// Latest version per (date, person); withdrawn hidden; OWN submissions
// excluded (your days already render from your own logs). Also feeds
// _glPSpaceCache so glShowSubmission works straight from the calendar.
async function glLoadCalendarSubmissions() {
  window._glSubsByDate = {};
  const d = _sdb();
  if (!d) return;
  const pid = _activeProjectId();
  if (!pid || pid === 'default') return;
  try {
    const snap = await d.collection('projects').doc(pid).collection('submissions').get();
    const latest = new Map();
    window._glPSpaceCache = window._glPSpaceCache || {};
    snap.forEach(s => {
      const v = Object.assign({ _id: s.id }, s.data());
      window._glPSpaceCache[s.id] = v;
      if (v.submittedBy === _currentUser.uid) return;
      const k = v.date + '|' + v.submittedBy;
      const cur = latest.get(k);
      if (!cur || (v.version || 1) > (cur.version || 1)) latest.set(k, v);
    });
    latest.forEach(v => {
      if (v.status === 'withdrawn') return;
      (window._glSubsByDate[v.date] = window._glSubsByDate[v.date] || []).push(v);
    });
  } catch (e) { /* not a member of a shared project */ }
}

// Project Space — its own page (page-projectSpace); this renders the
// submissions feed into it. Members-readable by rules.
function glShowProjectSpace() {
  if (typeof showPage === 'function') showPage('projectSpace');
}

async function glRenderProjectSpacePage() {
  const list = document.getElementById('pspace-list');
  if (!list) return;
  const nameEl = document.getElementById('pspace-proj-name');
  if (nameEl && typeof loadProjectConfig === 'function') nameEl.textContent = loadProjectConfig().projectName || '';
  const d = _sdb();
  if (!d) {
    list.innerHTML = '<div class="gl-mem-empty">Sign in to see this project\'s shared space.</div>';
    return;
  }
  list.innerHTML = '<div class="gl-mem-empty">Loading submissions…</div>';
  const pid = _activeProjectId();
  const subs = [];
  try {
    const snap = await d.collection('projects').doc(pid).collection('submissions').get();
    snap.forEach(s => subs.push(Object.assign({ _id: s.id }, s.data())));
  } catch (e) {
    list.innerHTML = '<div class="gl-mem-empty">No access to this project\'s submissions.</div>';
    return;
  }
  if (!subs.length) {
    list.innerHTML = '<div class="gl-mem-empty">Nothing submitted yet — daily logs submitted with 📤 appear here for everyone on the project.</div>';
    return;
  }
  // Latest version per date, newest first; older versions stay in the trail.
  const byDate = new Map();
  subs.forEach(s => {
    const cur = byDate.get(s.date);
    if (!cur || (s.version || 1) > (cur.version || 1)) byDate.set(s.date, s);
  });
  window._glPSpaceCache = {};
  subs.forEach(s => { window._glPSpaceCache[s._id] = s; });
  list.innerHTML = [...byDate.values()]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(s => {
      const withdrawn = s.status === 'withdrawn';
      return `<div class="proj-row" onclick="glShowSubmission('${s._id}')"${withdrawn ? ' style="opacity:.45"' : ''}>
        <div class="proj-row-info">
          <div class="proj-row-name">${_glEsc(_glSubFmtDate(s.date))}${(s.version || 1) > 1 ? ' <span class="gl-role-chip">v' + s.version + '</span>' : ''}${withdrawn ? ' <span class="gl-mem-you">withdrawn</span>' : ''}</div>
          <div class="proj-row-meta">${_glEsc(s.submittedByName || '')} · ${new Date(s.submittedAt || 0).toLocaleString()}</div>
        </div>
        <span style="color:var(--muted2)">›</span>
      </div>`;
    }).join('');
}

// Rendered read-only view of one submission snapshot.
function glShowSubmission(id) {
  const s = (window._glPSpaceCache || {})[id];
  if (!s) return;
  document.getElementById('_gl-sub-detail')?.remove();
  const p = s.payload || {}, f = p.fields || {};
  const kv = (label, val) => val ? `<div class="gl-sub-kv"><span>${label}</span><b>${_glEsc(val)}</b></div>` : '';
  const para = (label, val) => val ? `<div class="gl-sub-para"><div class="gl-inv-label">${label}</div><div>${_glEsc(val)}</div></div>` : '';
  const checked = (p.checklist || []).filter(c => c.checked);
  const flagged = (p.flags || []).filter(fl => fl.flagged);
  const mine = window._currentUser && s.submittedBy === _currentUser.uid;
  const ov = document.createElement('div');
  ov.className = 'proj-switcher-overlay';
  ov.id = '_gl-sub-detail';
  ov.style.zIndex = '9050';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="proj-switcher-sheet" style="max-height:88vh">
    <div class="proj-switcher-header">
      <span class="proj-switcher-title">${_glEsc(_glSubFmtDate(s.date))}${(s.version || 1) > 1 ? ' · v' + s.version : ''}</span>
      <button class="proj-switcher-close" onclick="document.getElementById('_gl-sub-detail').remove()">✕</button>
    </div>
    <div class="proj-row-meta" style="margin:-8px 0 12px">Submitted by ${_glEsc(s.submittedByName || '')} · ${new Date(s.submittedAt || 0).toLocaleString()}${s.status === 'withdrawn' ? ' · <b>WITHDRAWN</b>' : ''}</div>
    <div class="gl-sub-sect">
      ${kv('Project', f.projectName)}${kv('Prepared by', f.preparedBy)}${kv('Organization', f.org)}
      ${kv('Activity', f.activePhase)}${kv('Contractor', f.contractor)}${kv('Reviewed by', f.reviewedBy)}
    </div>
    <div class="gl-sub-sect">
      <div class="gl-inv-label">Weather</div>
      ${kv('Sky', (p.sky || []).join(', '))}${kv('Temp AM / PM', [f.tempAM, f.tempPM].filter(Boolean).join(' / '))}
      ${kv('Wind', f.wind)}${kv('Precip', f.precip)}${kv('Soil', f.soilCond)}
      ${kv('Sun', [f.wxSunrise, f.wxSunset].filter(Boolean).join(' – '))}
    </div>
    ${para('Inspection summary', f.inspSummary)}
    ${para('Agency inspections', f.agencyInsp)}${para('Landowner', f.landowner)}
    ${para('RTE / species', f.rte)}${para('Non-compliance', f.nonCompliance)}
    ${checked.length ? `<div class="gl-sub-sect"><div class="gl-inv-label">Checklist (${checked.length} checked)</div>
      ${checked.map(c => `<div class="gl-sub-kv"><span>✓</span><b>${_glEsc(c.text)}${c.note ? ' — ' + _glEsc(c.note) : ''}</b></div>`).join('')}</div>` : ''}
    ${flagged.length ? `<div class="gl-sub-sect" style="border-color:rgba(192,57,43,.4)"><div class="gl-inv-label" style="color:var(--red)">⚑ Flags (${flagged.length})</div>
      ${flagged.map(fl => `<div class="gl-sub-kv"><span>⚑</span><b>${_glEsc(fl.text)}${fl.note ? ' — ' + _glEsc(fl.note) : ''}</b></div>`).join('')}</div>` : ''}
    ${(p.crew || []).map((b, i) => `<div class="gl-sub-sect"><div class="gl-inv-label">Crew block ${i + 1}${b.name ? ' — ' + _glEsc(b.name) : ''}</div>
      ${kv('Hours', b.time)}${kv('Location', b.loc)}
      ${para('Activities', b.acts)}${para('Env. compliance', b.envcomp)}${para('Issues', b.issues)}${para('Notes', b.notes)}</div>`).join('')}
    ${para('General communications', f.genComms)}
    ${para('Lookahead', f.lookahead)}${para('Expected weather', f.lookaheadWeather)}
    ${mine && s.status !== 'withdrawn' ? `<button class="btn btn-outline" style="font-size:11px;padding:7px 14px;margin-top:8px;color:var(--red)" onclick="glWithdrawSubmission('${s._id}')">Withdraw submission</button>` : ''}
  </div>`;
  document.body.appendChild(ov);
}

function glWithdrawSubmission(id) {
  const d = _sdb();
  const s = (window._glPSpaceCache || {})[id];
  if (!d || !s) return;
  _confirmModal('Withdraw this submission? Project members lose access to it now. Your own log is untouched, and the version trail keeps the record that it existed.', async function() {
    try {
      const pid = _activeProjectId();
      await d.collection('projects').doc(pid).collection('submissions').doc(id)
        .update({ status: 'withdrawn', statusChangedAt: Date.now() });
      // A withdrawn day has no active snapshot — it counts as unsubmitted again.
      try {
        const m = glMySubmittedDates(pid);
        if (s.date && m[s.date]) { delete m[s.date]; localStorage.setItem(_glMySubsKey(pid), JSON.stringify(m)); }
      } catch (e2) {}
      glUpdateSubmitBadge();
      document.getElementById('_gl-sub-detail')?.remove();
      glShowProjectSpace();
    } catch (e) {
      _confirmModal('Could not withdraw: ' + e.message, function(){}, 'Submissions', 'OK');
    }
  }, 'Withdraw submission', 'Withdraw');
}

// ── Platform-hosted DEFAULT map token (tier 4 of the key chain) ──
// A new user on their own project must get a working map with ZERO setup.
// Admin (Tim) publishes the platform token once to appConfig/mapKey — rules
// already allow any-authed read / admin-only write on appConfig/*. Per-user
// and per-project tokens still override (tiers 1-3).
const GL_ADMIN_UID = 'Z1RZWSUTXfR1Ys76VMd8FTqydaq1';

function _glInitMapHostBtn() {
  const wrap = document.getElementById('cfg-map-host-wrap');
  if (!wrap) return;
  wrap.style.display = (window._currentUser && _currentUser.uid === GL_ADMIN_UID) ? '' : 'none';
}

async function glHostMapToken() {
  const d = _sdb();
  if (!d) return;
  const st = document.getElementById('cfg-map-host-status');
  const say = (msg, bad) => {
    if (!st) return;
    st.textContent = msg;
    st.style.color = bad ? 'var(--red)' : 'var(--green)';
    st.style.opacity = '1';
    setTimeout(() => { st.style.opacity = '0'; }, 3500);
  };
  try {
    const cfgDoc = await _udb().collection('settings').doc('projectConfig').get();
    const cfg = cfgDoc.exists ? cfgDoc.data() : {};
    const web = (cfg.mapboxToken || localStorage.getItem('gl_map_token') || '').trim();
    const native = (cfg.mapboxTokenNative || localStorage.getItem('gl_map_token_native') || '').trim();
    if (!web && !native) return say('Save your Mapbox token above first.', true);
    await d.collection('appConfig').doc('mapKey').set({
      mapboxToken: web, mapboxTokenNative: native, _ts: Date.now()
    });
    say('✓ Hosted — every signed-in user now gets a map by default');
  } catch (e) {
    say('Hosting failed: ' + e.message, true);
  }
}

// ── Window exposure ──
window.GL_ROLES = GL_ROLES;
// ── Role-aware Daily Log state ([[feedback_role_view_sovereignty]]: the page
//    stays open and usable — this is a defaults/affordance pass, never a lock).
//    Glasses: gentle pointer to Project Space + no Submit button (a view-only
//    role has nothing to submit). Lead/Boots: open-days badge.
function glUpdateReviewerLogState() {
  const pid = (typeof _activeProjectId === 'function') ? _activeProjectId() : '';
  const isReviewer = !!pid && pid !== 'default' && glMyRoleFor(pid) === 'reviewer';
  const note = document.getElementById('log-reviewer-note');
  if (note) note.style.display = isReviewer ? 'block' : 'none';
  const btn = document.getElementById('btn-submit-day');
  if (btn) btn.style.display = isReviewer ? 'none' : '';
  if (isReviewer) {
    const b = document.getElementById('submit-open-days');
    if (b) b.style.display = 'none';
  } else {
    glUpdateSubmitBadge();
  }
}

window.glMyRoleFor = glMyRoleFor;
window.glMySubmittedDates = glMySubmittedDates;
window.glRefreshMySubmittedDates = glRefreshMySubmittedDates;
window.glUnsubmittedDates = glUnsubmittedDates;
window.glUpdateSubmitBadge = glUpdateSubmitBadge;
window.glUpdateReviewerLogState = glUpdateReviewerLogState;
window._ndMaybeOfferSubmit = _ndMaybeOfferSubmit;
window.newDaySubmitFirst = newDaySubmitFirst;

// Boot: apply role-aware log-page state for the boot project context (the
// banner/buttons read localStorage synchronously; the badge fills in as the
// submitted-dates cache refreshes on use).
try { glUpdateReviewerLogState(); } catch (e) { /* DOM not ready in tests */ }
window._glMigrateWorkProductFlip = _glMigrateWorkProductFlip;
window.glSetMarkersPublished = glSetMarkersPublished;
window.glMemberChip = glMemberChip;
window.glLoadCalendarSubmissions = glLoadCalendarSubmissions;
window.glEnsureSharedProject = glEnsureSharedProject;
window.glBackfillSharedProjects = glBackfillSharedProjects;
window.glCreateInvite = glCreateInvite;
window.glShowInviteModal = glShowInviteModal;
window._glInvitePickRole = _glInvitePickRole;
window.glShowInviteSkins = glShowInviteSkins;
window.glCheckPendingInvite = glCheckPendingInvite;
window.glAcceptInvite = glAcceptInvite;
window.glShowJoinByCode = glShowJoinByCode;
window.glRenderMembersCard = glRenderMembersCard;
window.glEnableSharing = glEnableSharing;
window.glRemoveMember = glRemoveMember;
window.glRevokeInvite = glRevokeInvite;
window.glRepairSharedStubs = glRepairSharedStubs;
window._glInitMapShareBtn = _glInitMapShareBtn;
window.glShareMapToken = glShareMapToken;
window._glInitMapHostBtn = _glInitMapHostBtn;
window.glHostMapToken = glHostMapToken;
window.glBuildSubmissionPayload = glBuildSubmissionPayload;
window.glSubmitDay = glSubmitDay;
window.glShowProjectSpace = glShowProjectSpace;
window.glRenderProjectSpacePage = glRenderProjectSpacePage;
window.glShowSubmission = glShowSubmission;
window.glWithdrawSubmission = glWithdrawSubmission;
window._glCopy = _glCopy;
