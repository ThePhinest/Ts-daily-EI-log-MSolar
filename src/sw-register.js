import { registerSW } from 'virtual:pwa-register'

const updateSW = registerSW({
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
    document.getElementById('gl-reload-btn').addEventListener('click', () => updateSW(true))
  },
  onOfflineReady() {
    // silent — app is ready for offline use
  },
})
