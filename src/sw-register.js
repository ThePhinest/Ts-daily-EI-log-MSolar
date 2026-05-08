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

  const updateSW = registerSW({
    onRegisteredSW(_, registration) { _swRegistration = registration },
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

        // 3. Listen for the new SW taking control — this is the "happy path"
        if (navigator.serviceWorker) {
          navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true })
        }

        // 4. Tell the waiting worker to skip waiting (kicks off the activation)
        if (_swRegistration?.waiting) {
          _swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' })
        }

        // 5. Also call updateSW(true) for vite-plugin-pwa's own reload path
        try { updateSW(true) } catch (_) { /* swallow — fallback handles it */ }

        // 6. Hard-reload fallback — fires if controllerchange never lands
        // (waiting SW couldn't activate, multi-tab lock, browser quirk, etc.)
        setTimeout(doReload, 1500)
      })
    },
    onOfflineReady() {
      // silent — app is ready for offline use
    },
  })
}
