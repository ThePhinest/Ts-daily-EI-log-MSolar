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

  const updateSW = registerSW({
    onRegisteredSW(_, registration) {
      _swRegistration = registration
      // Sticky-banner heal (Tim 8/7): with several deploys a day, RELOAD can
      // race a superseding install — the click messages a worker that's already
      // redundant, the fallback reload fires, and the page comes back with the
      // NEWER version parked in waiting → banner again. If we arrived from a
      // RELOAD click, silently finish the job once instead of re-prompting.
      if (sessionStorage.getItem('gl_sw_activating')) {
        sessionStorage.removeItem('gl_sw_activating')
        if (registration && registration.waiting && navigator.serviceWorker) {
          navigator.serviceWorker.addEventListener('controllerchange',
            () => window.location.reload(), { once: true })
          registration.waiting.postMessage({ type: 'SKIP_WAITING' })
        }
      }
    },
    onNeedRefresh() {
      if (document.getElementById('gl-update-banner')) return
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
        const doReload = () => { if (!reloaded) { reloaded = true; window.location.reload() } }

        // 3. Mark that this reload came from the RELOAD button — if activation
        // races a superseding install, the boot-time heal in onRegisteredSW
        // finishes it silently instead of re-showing the banner.
        try { sessionStorage.setItem('gl_sw_activating', '1') } catch (_) {}

        // 4. Listen for the new SW taking control — this is the "happy path"
        if (navigator.serviceWorker) {
          navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true })
        }

        // 5. Skip-waiting the waiting worker — or the superseding installing one
        _postSkip(_swRegistration)

        // 6. Also call updateSW(true) for vite-plugin-pwa's own reload path
        try { updateSW(true) } catch (_) { /* swallow — fallback handles it */ }

        // 7. Hard-reload fallback — fires if controllerchange never lands.
        // 3s (was 1.5s): activation + clientsClaim on the ~16 MB precache can
        // outrun the shorter window, which forced reloads BEFORE handover —
        // the old worker stayed in control and the banner returned.
        setTimeout(doReload, 3000)
      })
    },
    onOfflineReady() {
      // silent — app is ready for offline use
    },
  })
}
