import { registerSW } from 'virtual:pwa-register'

// Capacitor native shell serves bundled assets locally — runtime SW caching
// is pointless and risks confusing the precache manifest under the spoofed
// https://app.groundlog.io origin. Skip registration on native; web unchanged.
if (!window.Capacitor?.isNativePlatform?.()) {
  // Capture the SW registration so the RELOAD button can talk to the waiting
  // worker directly. vite-plugin-pwa's updateSW(true) is supposed to skipWaiting
  // + reload, but in v1.3.0 the controllerchange-driven reload doesn't fire
  // reliably from a click handler — banner stays up, button looks dead, user
  // is stranded on the old SW (and never sees new deploys). Fix: manually post
  // SKIP_WAITING + listen for controllerchange + 1.5s hard-reload fallback.
  let _swRegistration = null

  // ── SW lifecycle breadcrumbs (8/16) — ring buffer in localStorage so a sticky
  // banner recurrence stops being a guessing game: paste localStorage.gl_sw_log
  // and we read what actually happened (shown / suppressed / skip / reload / hops).
  const _swLog = (ev) => {
    try {
      const l = JSON.parse(localStorage.getItem('gl_sw_log') || '[]')
      l.push(new Date().toISOString().slice(5, 19) + ' ' + ev)
      while (l.length > 30) l.shift()
      localStorage.setItem('gl_sw_log', JSON.stringify(l))
    } catch (_) {}
  }

  // ── Post-reload cooldown (8/16, banner v4). Root-cause hypothesis for every
  // sticky-banner sighting since 8/7: GitHub Pages' CDN caches sw.js (~10-min
  // TTL) across multiple edges — minutes after a deploy, an update check can
  // fetch the PREVIOUS sw.js from a stale edge, the browser sees "different =
  // new", parks it waiting, and re-prompts for the version the user just left.
  // Our web-first cadence (push → Tim tests 1–2 min later) sits inside that
  // window every time. So: for 10 min after a banner-driven reload, park any
  // "new" version silently (no banner, no activation churn); a genuinely newer
  // deploy re-prompts after the window or at the next natural boot.
  const COOL_KEY = 'gl_sw_cooldown_until'
  const _inCooldown = () => Date.now() < (parseInt(localStorage.getItem(COOL_KEY) || '0', 10) || 0)

  // Message SKIP_WAITING to whatever worker can take it: the waiting one, or —
  // when a newer deploy superseded the banner's version mid-flight — the
  // installing one, as soon as it reaches 'installed'. Returns false if there's
  // nothing to message (registration missing / already active).
  const _postSkip = (reg) => {
    if (!reg) return false
    if (reg.waiting) { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); return true }
    const inst = reg.installing
    if (inst) {
      inst.addEventListener('statechange', () => {
        if (inst.state === 'installed') inst.postMessage({ type: 'SKIP_WAITING' })
      })
      return true
    }
    return false
  }

  // ── Sticky-banner heal v2 (Tim 8/15 — the 8/7 heal had two gaps) ──
  // Gap 1: the boot heal only messaged a WAITING worker; a superseding version
  // still INSTALLING at that instant (or whose update check hadn't landed yet)
  // was missed, parked as waiting moments later, and re-raised the banner.
  // Gap 2: nothing suppressed that re-raise — the user who just hit RELOAD got
  // prompted again for a version they already asked for.
  // v2: a hop counter rides sessionStorage. While a heal chain is live (≤3
  // hops — loop breaker), BOTH the boot heal and onNeedRefresh finish updates
  // silently via _postSkip (waiting AND installing covered); the banner only
  // shows for genuinely new updates outside a chain.
  const HOPS_KEY = 'gl_sw_activating'
  let _healHops = 0
  try { _healHops = parseInt(sessionStorage.getItem(HOPS_KEY) || '0', 10) || 0; sessionStorage.removeItem(HOPS_KEY) } catch (_) {}
  let _healing = false
  const _silentActivate = (reg) => {
    if (_healing) return true            // a chain is already driving a reload
    if (!_postSkip(reg)) return false    // nothing to activate — chain is done
    _healing = true
    let reloaded = false
    const doReload = () => {
      if (reloaded) return
      reloaded = true
      try { sessionStorage.setItem(HOPS_KEY, String(_healHops + 1)) } catch (_) {}
      _swLog('silent-activate reload hops→' + (_healHops + 1))
      window.location.reload()
    }
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true })
    }
    // NO blind timeout here (8/15 loop lesson): the ~16 MB precache can take
    // well over 3s to install, and a timer reload lands with the worker STILL
    // installing — boot heals again, reloads again, loops to the hop cap
    // ("auto reloaded like 4 times"). controllerchange is the only truthful
    // "new version took over" signal. If it never comes, stay put: the page
    // keeps working on the current version and the chain resolves at the next
    // boot or update check.
    return true
  }

  const updateSW = registerSW({
    onRegisteredSW(_, registration) {
      _swRegistration = registration
      _swLog('registered hops=' + _healHops + ' waiting=' + !!registration?.waiting + ' installing=' + !!registration?.installing)
      if (_healHops > 0 && _healHops <= 3) _silentActivate(registration)
    },
    onNeedRefresh() {
      // Mid-chain: the superseding version just reached waiting — the user
      // already asked for "latest", finish silently instead of re-prompting.
      if (_healHops > 0 && _healHops <= 3 && _silentActivate(_swRegistration)) { _swLog('needRefresh mid-chain silent hops=' + _healHops) ; return }
      // Post-reload cooldown: park CDN ping-pong versions without prompting or
      // activating (activating could ping the OLD version back in and would
      // also let cleanupOutdatedCaches pull hashed chunks out from under the
      // running page). The waiting worker just sits; a newer install replaces it.
      if (_inCooldown()) { _swLog('needRefresh SUPPRESSED (cooldown)'); return }
      if (document.getElementById('gl-update-banner')) return
      _swLog('needRefresh banner shown')
      const banner = document.createElement('div')
      banner.id = 'gl-update-banner'
      banner.style.cssText = [
        'position:fixed',
        'bottom:calc(64px + env(safe-area-inset-bottom))',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:9999',
        'background:var(--amber)',
        'color:#000',
        'font-family:var(--mono)',
        'font-size:12px',
        'font-weight:600',
        'padding:10px 14px',
        'border-radius:8px',
        'display:flex',
        'align-items:center',
        'gap:12px',
        'box-shadow:0 4px 20px rgba(0,0,0,.5)',
        'white-space:nowrap',
      ].join(';')
      banner.innerHTML =
        '<span>App updated</span>' +
        '<button id="gl-reload-btn" style="background:#000;color:var(--amber);border:none;border-radius:5px;padding:5px 11px;font-family:var(--mono);font-size:11px;font-weight:700;cursor:pointer;letter-spacing:.05em">RELOAD</button>' +
        '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#000;opacity:.5;cursor:pointer;font-size:16px;padding:0 2px;line-height:1">✕</button>'
      document.body.appendChild(banner)
      document.getElementById('gl-reload-btn').addEventListener('click', () => {
        // 1. Visual feedback so the user knows the click landed
        const btn = document.getElementById('gl-reload-btn')
        if (btn) { btn.textContent = 'RELOADING…'; btn.disabled = true }

        // 2. Reload-once latch (prevents double-reload between controllerchange + fallback)
        let reloaded = false
        const doReload = (src) => { if (!reloaded) { reloaded = true; _swLog('reload via ' + (src || 'controllerchange')); window.location.reload() } }

        // 3. Mark that this reload came from the RELOAD button — if activation
        // races a superseding install, the boot-time heal in onRegisteredSW
        // finishes it silently instead of re-showing the banner. Arm the 10-min
        // CDN-ping-pong cooldown at the same time (banner v4).
        try { sessionStorage.setItem('gl_sw_activating', '1') } catch (_) {}
        try { localStorage.setItem(COOL_KEY, String(Date.now() + 10 * 60 * 1000)) } catch (_) {}
        _swLog('RELOAD click waiting=' + !!_swRegistration?.waiting + ' installing=' + !!_swRegistration?.installing)

        // 4. Listen for the new SW taking control — this is the "happy path"
        if (navigator.serviceWorker) {
          navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true })
        }

        // 5. Skip-waiting the waiting worker — or the superseding installing one
        _postSkip(_swRegistration)

        // 6. Also call updateSW(true) for vite-plugin-pwa's own reload path
        try { updateSW(true) } catch (_) { /* swallow — fallback handles it */ }

        // 7. Hard-reload fallback — ONLY when a waiting worker existed at
        // click time (activation of a waiting worker is sub-second; 3s covers
        // the v1.3.0 controllerchange-misfire case). When the new version is
        // still INSTALLING, a timer reload fires before handover and seeds the
        // reload loop (8/15) — so we wait for controllerchange instead; the
        // button honestly shows RELOADING… until the install lands.
        if (_swRegistration && _swRegistration.waiting) setTimeout(() => doReload('3s-fallback'), 3000)
      })
    },
    onOfflineReady() {
      // silent — app is ready for offline use
    },
  })
}
