// ═══════════════════════════════════════════
// FIRST-RUN SETUP — guided project creation for brand-new accounts
// ═══════════════════════════════════════════
// A fresh account lands with no project: the daily log isn't usable until
// Settings → Project & Report Info is filled in by hand (the #1 friction
// find from the 2026-06-11 purge-test signups, with 4 testers incoming).
// This sheet fires once — right after the onboarding carousel, or at boot
// for an account that finished onboarding but never made a project — and
// turns that dead end into: name your project → you're logging.

// Per-uid: a purge-tested or signed-out account must not suppress the sheet
// for the NEXT new account on the same browser.
function _frDoneKey() {
  const u = window._currentUser;
  return 'gl_first_run_done_' + ((u && u.uid) || 'anon');
}

function _frEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function glMaybeFirstRunSetup() {
  try {
    if (localStorage.getItem(_frDoneKey())) return;
    // The invite flow delivers this user's project — don't compete with it.
    if (localStorage.getItem('gl_pending_invite')) return;
    if (_activeProjectId() !== 'default') return;
    if (knownProjectsGet().length) return;
    // Empty LOCAL storage doesn't prove the ACCOUNT is new — a fresh device
    // for an existing user looks identical until the cloud project list
    // syncs. Firestore is the authority: any known project or any membership
    // means this is not a first run.
    if (typeof db === 'undefined' || !db || !window._currentUser) return;
    const [kp, mem] = await Promise.all([
      _udb().collection('settings').doc('knownProjects').get(),
      _udb().collection('memberships').limit(1).get()
    ]);
    if ((kp.exists && (kp.data().projects || []).length > 0) || !mem.empty) return;
  } catch (e) { return; } // can't verify ⇒ never nag a possibly-existing account
  _frShowSheet();
}

function _frShowSheet() {
  if (document.getElementById('_gl-first-run')) return;
  const u = window._currentUser;
  const myName = (u && u.displayName) || '';
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-first-run';
  ov.style.zIndex = '9000';
  ov.innerHTML = `<div class="modal-box" style="max-width:380px">
    <div style="font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--amber);margin-bottom:6px">FIRST THINGS FIRST</div>
    <div class="modal-title">Set up your first project</div>
    <div class="modal-msg" style="margin-bottom:14px">Everything in GroundLog — daily logs, photos, drawings, reports — lives inside a project. Name yours and you're ready to log. You can fine-tune the rest in Settings anytime.</div>
    <label style="display:block;font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--muted);margin-bottom:4px">PROJECT NAME</label>
    <input id="_fr-proj-name" autocomplete="off" placeholder="e.g. Maple Ridge Solar" style="width:100%;box-sizing:border-box;background:var(--s2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:16px;padding:10px;margin-bottom:12px">
    <label style="display:block;font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--muted);margin-bottom:4px">YOUR NAME <span style="text-transform:none;letter-spacing:0;color:var(--muted)">— shows as &ldquo;Prepared By&rdquo; on reports</span></label>
    <input id="_fr-my-name" autocomplete="name" value="${_frEsc(myName)}" placeholder="e.g. Justin Spect" style="width:100%;box-sizing:border-box;background:var(--s2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:16px;padding:10px">
    <div class="modal-btns" style="margin-top:16px">
      <button class="modal-confirm" id="_fr-create" style="background:var(--amber);border-color:var(--amber);color:#0e0e0e;flex:1">CREATE PROJECT →</button>
    </div>
    <div style="text-align:center;margin-top:14px">
      <span id="_fr-join" style="font-family:var(--mono);font-size:11px;color:var(--s3,#3fa7b0);cursor:pointer;text-decoration:underline">Have an invite code? Join a project instead</span>
    </div>
    <div style="text-align:center;margin-top:9px">
      <span id="_fr-skip" style="font-family:var(--mono);font-size:10.5px;color:var(--muted);cursor:pointer">Skip for now — I'll set up later</span>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const nameInput = ov.querySelector('#_fr-proj-name');
  setTimeout(() => nameInput.focus(), 60);

  ov.querySelector('#_fr-skip').onclick = () => {
    localStorage.setItem(_frDoneKey(), '1');
    ov.remove();
  };
  ov.querySelector('#_fr-join').onclick = () => {
    // Joining delivers a project, so the sheet's job is done either way.
    localStorage.setItem(_frDoneKey(), '1');
    ov.remove();
    if (typeof glShowJoinByCode === 'function') glShowJoinByCode();
  };
  const createBtn = ov.querySelector('#_fr-create');
  createBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.style.borderColor = 'var(--amber)'; nameInput.focus(); return; }
    const preparedBy = ov.querySelector('#_fr-my-name').value.trim();
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    // createProject no-ops before Firebase is ready — wait it out (boot race).
    let waited = 0;
    while (!window._fbReady && waited < 6000) { await new Promise(r => setTimeout(r, 200)); waited += 200; }
    try {
      // createProject returns the new id — an early no-op return (Firebase
      // still not ready) must NOT close the sheet as if it succeeded.
      const pid = await createProject(name, '', '', { preparedBy: preparedBy, landOn: 'log' });
      if (!pid) throw new Error('still connecting — try again in a moment');
      localStorage.setItem(_frDoneKey(), '1');
      ov.remove();
    } catch (e) {
      createBtn.disabled = false;
      createBtn.textContent = 'CREATE PROJECT →';
      if (typeof showCloudBanner === 'function') showCloudBanner('⚠ Could not create the project: ' + (e.message || 'unknown error'));
    }
  };
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') ov.querySelector('#_fr-my-name').focus(); });
  ov.querySelector('#_fr-my-name').addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
}

// ── Window exposure ──
window.glMaybeFirstRunSetup = glMaybeFirstRunSetup;
