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
import './maps.js'
import './photos.js'
import './compliance.js'
import './projects.js'
import './settings.js'
import './timesheet.js'
import './calendar.js'
import './daily-log.js'
import './report.js'

window.firebase = firebase
window.mapboxgl = mapboxgl
window.exifr = exifr
window.docx = docx
