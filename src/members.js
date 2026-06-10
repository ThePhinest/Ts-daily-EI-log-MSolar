// ═══════════════════════════════════════════
// SHARED PROJECTS — membership, invites, members UI (Phase 4.5 chunk 1)
//
// The shared world lives at projects/{pid} (meta + members + invites-by-token
// at top-level /invites). This module owns every write to it. Work-product
// collections still live at users/{uid}/projects/{pid}/... (see _projData in
// db.js) — the publish-gated data flip is the next chunk; this chunk makes
// membership real: create/backfill shared project docs, mint + accept invites,
// render the members card.
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
(function _glCaptureJoinParam() {
  try {
    const url = new URL(window.location.href);
    const tok = url.searchParams.get('join')
      || (window.location.hash.match(/join=([A-Za-z0-9-]+)/) || [])[1];
    if (tok) {
      localStorage.setItem('gl_pending_invite', _glNormToken(tok));
      url.searchParams.delete('join');
      url.hash = url.hash.replace(/join=[A-Za-z0-9-]+&?/, '').replace(/[#&]$/, '');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch (e) { /* malformed URL — ignore */ }
})();

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
// INVITES — mint + skins (lead side)
// ═══════════════════════════════════════════

async function glCreateInvite(role) {
  const d = _sdb();
  if (!d || !GL_ROLES[role] || role === 'lead') return null;
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
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-invite-modal';
  ov.style.zIndex = '9100';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  const roleCard = (key) => {
    const r = GL_ROLES[key];
    return `<div class="gl-role-pick" onclick="_glInvitePickRole('${key}')">
      <div class="gl-role-pick-name">${r.icon} ${r.name}</div>
      <div class="gl-role-pick-sub">${r.sub}</div>
    </div>`;
  };
  ov.innerHTML = `<div class="modal-box" style="max-width:360px">
    <div class="modal-title">Invite to this project</div>
    <div class="modal-msg" style="margin-bottom:12px">Pick the role for this invite — one invite, one person.</div>
    ${roleCard('reviewer')}
    ${roleCard('field')}
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
async function glCheckPendingInvite() {
  const token = localStorage.getItem('gl_pending_invite');
  if (!token) return;
  const d = _sdb();
  if (!d) return; // not signed in yet — stash survives for the post-auth run
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
    return _confirmModal('Couldn\'t look up the invite: ' + e.message, function(){}, 'Invite', 'OK');
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
  document.getElementById('_gl-accept-no').onclick = () => { clear(); ov.remove(); };
  document.getElementById('_gl-accept-yes').onclick = async () => {
    const btn = document.getElementById('_gl-accept-yes');
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      await glAcceptInvite(inv, token);
      clear(); ov.remove();
    } catch (e) {
      clear(); ov.remove();
      _confirmModal('Couldn\'t join: ' + e.message, function(){}, 'Join failed', 'OK');
    }
  };
}

async function glAcceptInvite(inv, token) {
  const d = _sdb();
  if (!d) throw new Error('not signed in');
  const uid = _currentUser.uid;
  const now = Date.now();
  // 1. Membership — the rules-checked write (invite must be live + role match).
  await d.collection('projects').doc(inv.pid).collection('members').doc(uid).set({
    role: inv.role, level: 1,
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
  const stub = {
    projectName: inv.projectName || 'Shared project',
    preparedBy: _glMyName(), org: '', activePhase: '',
    contractor: '', location: '', reviewedBy: '',
    createdAt: now, lastUsed: now, _ts: now,
    shared: true, sharedRole: inv.role,
    checklistItems: (typeof DEFAULT_CHECKLIST_ITEMS !== 'undefined') ? [...DEFAULT_CHECKLIST_ITEMS] : [],
    checklistTitle: 'Compliance Checklist',
    flagItems: (typeof DEFAULT_FLAG_ITEMS !== 'undefined') ? [...DEFAULT_FLAG_ITEMS] : [],
    flagsTitle: 'Regulatory & Incident Flags',
    presets: (typeof DEFAULT_PRESETS !== 'undefined') ? Object.assign({}, DEFAULT_PRESETS) : {},
    phases: (typeof DEFAULT_PHASES !== 'undefined') ? [...DEFAULT_PHASES] : [],
    cardTitles: {},
    tsConfig: (typeof TS_DEFAULTS !== 'undefined') ? Object.assign({}, TS_DEFAULTS) : {},
    phaseC_migrated: true
  };
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
function glShowJoinByCode() {
  const existing = document.getElementById('_proj-switcher');
  if (existing) existing.remove();
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
      <button class="modal-cancel" onclick="document.getElementById('_gl-join-modal').remove()">Cancel</button>
      <button class="modal-confirm" id="_gl-join-go" style="background:var(--amber);border-color:var(--amber);color:#0e0e0e">Look up invite</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const input = document.getElementById('_gl-join-code');
  setTimeout(() => input.focus(), 60);
  document.getElementById('_gl-join-go').onclick = () => {
    const tok = _glNormToken(input.value);
    if (tok.length < 6) { input.style.borderColor = 'var(--red)'; return; }
    localStorage.setItem('gl_pending_invite', tok);
    ov.remove();
    glCheckPendingInvite();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('_gl-join-go').click(); });
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
  host.innerHTML = rows + invitesHtml;
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

// ── Window exposure ──
window.GL_ROLES = GL_ROLES;
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
window._glCopy = _glCopy;
