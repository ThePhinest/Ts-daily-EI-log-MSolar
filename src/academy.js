// ═══════════════════════════════════════════
// GROUNDLOG ACADEMY — short video walkthroughs
// ═══════════════════════════════════════════
// Hub page for in-app tutorials: short (60–120s) narrated clips, one task
// each, played with a native <video> element — no YouTube/third-party embeds
// (privacy posture: no outside trackers inside the app). Empty states
// deep-link here via glAcademyGo(topicId).
//
// Hosting (decided 2026-06-11): the groundlog.io site repo (GitHub Pages) —
// free bandwidth vs Storage egress, CDN range-requests so seeking works.
// Adding a video = drop the MP4 in the site repo at /academy/{id}.mp4, set
// the topic's url to https://groundlog.io/academy/{id}.mp4, ship. Topics
// with no URL render as COMING SOON. Record against a DEMO project only —
// never real project data.

const GL_ACADEMY_TOPICS = [
  { id: 'getting-started', icon: '📋', title: 'Getting started',              min: 2, url: 'https://groundlog.io/academy/getting-started.mp4',
    blurb: 'Create your project and file your first daily log.' },
  { id: 'map-categories',  icon: '🗂️', title: 'Tracker categories & templates', min: 2, url: '',
    blurb: 'Set up categories from templates — seeding, ground disturbance, linear BMPs.' },
  { id: 'map-plans-layers', icon: '📐', title: 'Plans, layers & states',      min: 2, url: '',
    blurb: 'Draw a plan, stack state layers on top (lime → fertilizer → seed), watch progress fill in.' },
  { id: 'map-drawing',     icon: '✏️', title: 'Drawing & snapping',           min: 2, url: '',
    blurb: 'Polygons, lines, snapping to existing work, measuring areas.' },
  { id: 'map-photos',      icon: '📸', title: 'Photo pins & linked photos',   min: 2, url: '',
    blurb: 'Photos on the map, linking photos to drawings, branded map captures.' },
  { id: 'tracker-log',     icon: '📊', title: 'The tracker log',              min: 1, url: '',
    blurb: 'Reading progress bars, filtering, per-state totals.' },
  { id: 'exports',         icon: '📤', title: 'Exports',                      min: 2, url: '',
    blurb: 'XLSX tracker exports, KML, photo ZIPs, and the daily .docx report.' },
  { id: 'sharing',         icon: '🤝', title: 'Shared projects',              min: 2, url: '',
    blurb: 'Invites, publishing your work, submitting a day, member roles.' },
];

function glRenderAcademyPage() {
  const host = document.getElementById('academy-body');
  if (!host) return;
  host.innerHTML = `
    <div style="font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--muted);margin-bottom:14px">
      Short video walkthroughs — one task, a couple of minutes each. Watch the one you need, when you need it.
    </div>
    ${GL_ACADEMY_TOPICS.map(t => `
      <div class="gl-ac-row" id="ac-row-${t.id}" onclick="glAcademyOpen('${t.id}')">
        <span class="gl-ac-icon">${t.icon}</span>
        <div class="gl-ac-info">
          <div class="gl-ac-title">${t.title}</div>
          <div class="gl-ac-blurb">${t.blurb}</div>
        </div>
        ${t.url
          ? `<span class="gl-ac-badge gl-ac-badge-live">▶ ${t.min} min</span>`
          : '<span class="gl-ac-badge">COMING SOON</span>'}
      </div>`).join('')}`;
}

function glAcademyOpen(id) {
  const t = GL_ACADEMY_TOPICS.find(x => x.id === id);
  if (!t) return;
  if (!t.url) {
    const row = document.getElementById('ac-row-' + id);
    if (row) {
      row.classList.add('gl-ac-flash');
      setTimeout(() => row.classList.remove('gl-ac-flash'), 1200);
    }
    if (typeof showCloudBanner === 'function') showCloudBanner('🎬 “' + t.title + '” is coming soon — walkthroughs are being filmed now.');
    return;
  }
  document.getElementById('_gl-ac-player')?.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = '_gl-ac-player';
  ov.style.zIndex = '9100';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:520px;padding:14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:16px">${t.icon}</span>
      <span class="modal-title" style="margin:0;flex:1">${t.title}</span>
      <button onclick="document.getElementById('_gl-ac-player').remove()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1;padding:2px 6px">✕</button>
    </div>
    <video controls playsinline autoplay preload="metadata" src="${t.url}"
      style="width:100%;border-radius:10px;background:#000;max-height:70dvh"></video>
  </div>`;
  document.body.appendChild(ov);
}

// Deep link used by empty states: jump to the Academy and flash the topic.
function glAcademyGo(id) {
  showPage('academy');
  if (typeof closeMoreMenu === 'function') closeMoreMenu();
  setTimeout(() => {
    const row = document.getElementById('ac-row-' + id);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('gl-ac-flash');
      setTimeout(() => row.classList.remove('gl-ac-flash'), 1600);
    }
  }, 350);
}

// ═══════════════════════════════════════════
// EMPTY STATES — shared branded component
// ═══════════════════════════════════════════
// Polish #9: branded icon + title + body + action button, applied wherever a
// fresh account hits a blank page. Lives here because the optional
// “▶ Watch” action couples it to the Academy deep link.

function glEmptyState(o) {
  const actions = (o.actions || []).map(a =>
    `<button class="gl-es-btn${a.primary ? ' gl-es-btn-primary' : ''}" onclick="${a.onclick}">${a.label}</button>`).join('');
  const watch = o.academy
    ? `<button class="gl-es-btn gl-es-watch" onclick="glAcademyGo('${o.academy}')">▶ Watch: ${o.academyLabel}</button>`
    : '';
  return `<div class="gl-empty-state">
    <div class="gl-es-icon">${o.icon}</div>
    <div class="gl-es-title">${o.title}</div>
    <div class="gl-es-body">${o.body}</div>
    ${actions || watch ? `<div class="gl-es-actions">${actions}${watch}</div>` : ''}
  </div>`;
}

// ── Window exposure ──
window.glRenderAcademyPage = glRenderAcademyPage;
window.glAcademyOpen = glAcademyOpen;
window.glAcademyGo = glAcademyGo;
window.glEmptyState = glEmptyState;
