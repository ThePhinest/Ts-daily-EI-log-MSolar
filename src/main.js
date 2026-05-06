// ───────────────────────────────────────────────────────────────────────────
// Sentry — initialize FIRST so it captures errors during module load.
// DSN is baked at build time from VITE_SENTRY_DSN; without it, init is a
// no-op (no events sent). See groundlog/wiki/dependency-watch.md and the
// project_privacy_posture.md memory for the full posture decisions.
// ───────────────────────────────────────────────────────────────────────────
import * as Sentry from '@sentry/capacitor'
import * as SentryBrowser from '@sentry/browser'
import { Capacitor } from '@capacitor/core'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  // Skip entirely if DSN missing (local dev with no .env, fork builds, etc.)
  enabled: !!import.meta.env.VITE_SENTRY_DSN,
  // Tag every event with platform so we can split web-vs-iOS in the dashboard.
  initialScope: {
    tags: {
      platform: Capacitor.isNativePlatform() ? 'ios' : 'web',
    },
  },
  // Errors-only: no performance tracing, no Session Replay (privacy posture —
  // Replay deferred until per-tenant opt-in + masking config land).
  tracesSampleRate: 0,
  // CRITICAL: empty propagation targets prevents Sentry from injecting
  // `sentry-trace` and `baggage` HTTP headers into outgoing fetch/XHR.
  // Firebase identitytoolkit and Mapbox tile endpoints reject requests
  // with these unexpected headers as 400 Bad Request. Found 2026-05-06
  // when web sign-in regressed immediately after Sentry deploy.
  tracePropagationTargets: [],
  // Filter out the browserTracing integration entirely — we're not using
  // performance monitoring, and even with tracesSampleRate=0 the integration
  // still installs fetch/XHR instrumentation that can interfere with strict
  // APIs. Belt-and-suspenders alongside tracePropagationTargets above.
  integrations: (defaultIntegrations) =>
    defaultIntegrations.filter((i) => i.name !== 'BrowserTracing'),
  // Privacy: don't auto-send IPs / headers / cookies. We attach user.uid
  // explicitly in auth.js once auth resolves; no email or PII beyond that.
  sendDefaultPii: false,
  // Filter known intentional offline failures so they don't pollute the
  // dashboard. cloudSave warns by design when offline; not a real error.
  beforeSend(event, hint) {
    const msg = (hint && hint.originalException && hint.originalException.message) || event.message || ''
    if (msg.includes('cloudSave failed')) return null
    return event
  },
}, SentryBrowser.init)

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
