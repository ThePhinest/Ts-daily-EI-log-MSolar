// ───────────────────────────────────────────────────────────────────────────
// Sentry — TEMPORARILY DISABLED 2026-05-06.
//
// Initial Sentry baseline shipped 2026-05-06 broke Firebase email/password
// sign-in on web (and likely iOS WebView too). Firebase identitytoolkit
// returned 400 INVALID_LOGIN_CREDENTIALS for known-correct credentials
// (autofilled from password manager). Confirmed not a credential issue;
// confirmed not a Service Worker stale-cache issue (SW was unregistered
// and site data cleared, password still rejected). Hypothesis: Sentry v10
// (`@sentry/browser@10.43.0` + `@sentry/capacitor@4.0.0`) installs fetch/XHR
// instrumentation that mangles the request body or related state in a way
// Firebase rejects. Disabling BrowserTracing (commit 2b33793) did not
// resolve it, so the issue lives in another integration we haven't
// pinpointed.
//
// To get web back to working state immediately, the Sentry.init call is
// commented out. Imports remain so build still resolves; setUser calls in
// auth.js are no-ops without an active client.
//
// FOLLOW-UP — own focused session:
//  - Reproduce in isolation (minimal Vite repro, no Capacitor) to confirm
//    Sentry is the cause, NOT some bundle interaction
//  - Test each default integration on/off to find the exact culprit
//  - OR consider switching to manual error capture (Sentry.captureException
//    wired only into specific catch blocks, no auto-instrumentation)
//  - Map-page debug payoff still wanted but not at the cost of broken auth
//
// See groundlog/wiki/dependency-watch.md Outstanding Items + memory
// project_privacy_posture.md for the original posture decisions.
// ───────────────────────────────────────────────────────────────────────────
import * as Sentry from '@sentry/capacitor'
import * as SentryBrowser from '@sentry/browser'
import { Capacitor } from '@capacitor/core'

// Sentry init temporarily disabled — see comment above.
// Sentry.init({
//   dsn: import.meta.env.VITE_SENTRY_DSN,
//   enabled: !!import.meta.env.VITE_SENTRY_DSN,
//   initialScope: { tags: { platform: Capacitor.isNativePlatform() ? 'ios' : 'web' } },
//   tracesSampleRate: 0,
//   tracePropagationTargets: [],
//   integrations: (defaultIntegrations) =>
//     defaultIntegrations.filter((i) => i.name !== 'BrowserTracing'),
//   sendDefaultPii: false,
//   beforeSend(event, hint) {
//     const msg = (hint && hint.originalException && hint.originalException.message) || event.message || ''
//     if (msg.includes('cloudSave failed')) return null
//     return event
//   },
// }, SentryBrowser.init)
// Suppress unused-import lint; symbols remain in scope for the future re-enable.
void Sentry; void SentryBrowser; void Capacitor;

import firebase from 'firebase/compat/app'
import 'firebase/compat/auth'
import 'firebase/compat/firestore'
import 'firebase/compat/storage'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as exifr from 'exifr'
import * as docx from 'docx'
import './db.js'
import './auth.js'
import './errorReporter.js'
import './sw-register.js'
import './saveFile.js'
import './maps.js'
import './photos.js'
import './compliance.js'
import './projects.js'
import './members.js'
import './settings.js'
import './timesheet.js'
import './timesheetMigration.js'
import './trackerEntries.js'
import './trackerCategories.js'
import './kmlImport.js'
import './kmlImportModal.js'
import './calendar.js'
import './daily-log.js'
import './promptDefaults.js'
import './promptAssembly.js'
import './promptStorage.js'
import './aiBrandingEditor.js'
import './report.js'

window.firebase = firebase
window.mapboxgl = mapboxgl
window.exifr = exifr
window.docx = docx

// ─── Capacitor native context flag ─────────────────────────────────────────
// Adds `is-native` class to <body> when running inside the Capacitor iOS
// WebView. Used by CSS rules that need to differ web vs. native (currently:
// input font-size bump to 16px to prevent iOS WKWebView auto-zoom on focus
// — see index.html style block).
import { Keyboard } from '@capacitor/keyboard'
import { App as CapApp } from '@capacitor/app'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
if (Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
  document.body.classList.add('is-native')

  // Re-run new-day detection on foreground. checkNewDay() is fired during
  // Firebase init / auth-state-change at cold boot, but a backgrounded app
  // reopened the next morning resumes the WebView from memory — Firebase
  // doesn't re-init, so the boot-time check never re-fires. Without this
  // listener the user only sees the "start new day" prompt after navigating
  // to Calendar. checkNewDay() is window-scoped from daily-log.js and is
  // self-suppressing (pei_newday_suppress key), so calling it on every
  // resume is safe.
  CapApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive && typeof window.checkNewDay === 'function') {
      window.checkNewDay()
    }
  })
}

// ─── Haptics (native only) ─────────────────────────────────────────────────
// Light tactile tap on any button/tappable control, plus helpers for success
// and warning feedback at key action points. window.glHaptic is ALWAYS defined
// (no-ops on web) so callers never need to guard the platform.
const _glNative = Capacitor.isNativePlatform && Capacitor.isNativePlatform()
window.glHaptic = _glNative ? {
  light:   () => Haptics.impact({ style: ImpactStyle.Light }).catch(()=>{}),
  medium:  () => Haptics.impact({ style: ImpactStyle.Medium }).catch(()=>{}),
  success: () => Haptics.notification({ type: NotificationType.Success }).catch(()=>{}),
  warning: () => Haptics.notification({ type: NotificationType.Warning }).catch(()=>{}),
} : { light(){}, medium(){}, success(){}, warning(){} }
if (_glNative) {
  // Capture-phase pointerdown = instant feedback the moment a control is pressed
  // (more native than waiting for click). Matches only real tappable controls.
  document.addEventListener('pointerdown', function(e){
    const tgt = e.target
    // [onclick] catches the app's dominant tappable pattern (div/span with an inline
    // handler — popup buttons, category rows, tracker rows). The trailing classes are
    // controls wired via addEventListener (no onclick attr) that still need feedback.
    const hit = tgt && tgt.closest && tgt.closest('button,[role="button"],[onclick],.nav-item,.more-row,.more-tile,.map-cat-pill,.map-fab-btn,.proj-row,._tlog-chip,._tlog-cat-head')
    if (!hit || hit.disabled) return
    window.glHaptic.light()
  }, true)
}

// ─── Keep --app-bar-h synced to the REAL app-bar height ────────────────────
// The bar grows/shrinks (wordmark + project-name sub-line + safe-area inset), so no
// hardcoded constant is right on every device. Measure it and publish the value the
// top banners + bottom-sheet/popup max-height caps read off --app-bar-h. (The CSS
// fallback value only applies for the split second before this first runs.)
function _setAppBarH(){
  const bar=document.querySelector('.app-bar');
  if(!bar) return;
  const h=Math.ceil(bar.getBoundingClientRect().bottom);
  if(h>0) document.documentElement.style.setProperty('--app-bar-h', h+'px');
}
window._setAppBarH=_setAppBarH;
_setAppBarH();
window.addEventListener('load',_setAppBarH);
window.addEventListener('resize',_setAppBarH);
window.addEventListener('orientationchange',()=>setTimeout(_setAppBarH,120));
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(_setAppBarH);
setTimeout(_setAppBarH,400); setTimeout(_setAppBarH,1500); // project name + fonts settle async

// ─── Tap-outside dismisses keyboard ────────────────────────────────────────
// iOS WKWebView's default behavior for input.blur() vs. soft-keyboard dismiss
// is undefined — sometimes it dismisses, sometimes it doesn't. Owning this
// explicitly: any pointerdown that moves focus away from an input also calls
// Keyboard.hide() on native. Web-side .blur() handles soft-keyboard dismiss
// via standard browser behavior. Capture-phase listener so it fires before
// element-level handlers.
document.addEventListener('pointerdown', function(e){
  const active = document.activeElement
  if (!active) return
  const t = active.tagName
  if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') return
  const tgt = e.target
  // Tapping the focused input itself or its descendants — no-op
  if (tgt === active || (active.contains && active.contains(tgt))) return
  // Tapping into a different input — let it focus naturally
  const tt = tgt.tagName
  if (tt === 'INPUT' || tt === 'TEXTAREA' || tt === 'SELECT') return
  // Tapping a button/link — DON'T dismiss here. Hiding the keyboard on pointerdown
  // shifts the layout and cancels the control's click on iOS (the dead Save/Cancel
  // bug). The control's own action changes the view, which dismisses the keyboard.
  if (tgt.closest && tgt.closest('button,[role="button"],a')) return
  // Tapped elsewhere — dismiss keyboard
  active.blur()
  if (Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
    Keyboard.hide().catch(()=>{})
  }
}, true)
