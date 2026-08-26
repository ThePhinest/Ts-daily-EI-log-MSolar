const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
// v1 namespace solely for the auth.onDelete trigger — v2 has no auth-delete
// event (its identity triggers are blocking-only). Supported to mix.
const functionsV1 = require('firebase-functions/v1');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

initializeApp();

const WEBHOOK = defineSecret('DISCORD_ERROR_WEBHOOK_URL');

async function postToDiscord(webhookUrl, payload) {
  const cleanUrl = webhookUrl.replace(/^﻿/, '').trim();
  const res = await fetch(cleanUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
}

// Daily digest — 07:00 America/New_York. Queries all users' _debug subcollections
// for errors in the past 24h and posts an aggregated embed to Discord.
exports.errorDigest = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/New_York', secrets: [WEBHOOK] },
  async () => {
    const db = getFirestore();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const usersSnap = await db.collection('users').get();
    const allErrors = [];

    await Promise.all(
      usersSnap.docs.map(async (userDoc) => {
        const uid = userDoc.id;
        const debugSnap = await db
          .collection('users').doc(uid)
          .collection('_debug')
          .where('clientTs', '>=', cutoff)
          .get();
        debugSnap.forEach((doc) => allErrors.push({ uid, ...doc.data() }));
      })
    );

    if (allErrors.length === 0) {
      console.log('No errors in past 24h — digest skipped');
      return;
    }

    const byType = {};
    for (const e of allErrors) {
      const key = e.type || 'unknown';
      byType[key] = (byType[key] || 0) + 1;
    }

    const criticalCount = allErrors.filter((e) => e.severity === 'critical').length;
    const total = allErrors.length;
    const color = criticalCount > 0 ? 0xdc2626 : total > 10 ? 0xf59e0b : 0x22c55e;

    const lines = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `• \`${type}\` × ${count}`)
      .join('\n');

    await postToDiscord(WEBHOOK.value(), {
      embeds: [{
        title: '📊 GroundLog Error Digest (last 24h)',
        description: `**${total}** error${total !== 1 ? 's' : ''} captured${
          criticalCount > 0 ? ` — **${criticalCount} critical**` : ''
        }.\n\n${lines}`,
        color,
        footer: { text: 'GroundLog β.2 · errorDigest' },
        timestamp: new Date().toISOString(),
      }],
    });
  }
);

// ═══════════════════════════════════════════
// ACCOUNT DELETION — full data purge (Apple 5.1.1(v) + privacy policy §5)
// ═══════════════════════════════════════════
// The in-app Delete Account button calls Firebase Auth user.delete(); this
// trigger then makes the privacy policy's sentence true — "Deletion removes
// your account and all associated data from our systems":
//   1. shared-project side: membership doc, published mirrors (photos /
//      fieldMarkers / trackerEntries / trackerCategories stamped ownerUid),
//      submissions; if the project is left with zero members it is an
//      unreachable shell (rules gate on membership) and is deleted whole
//   2. invites minted by the user
//   3. the entire users/{uid} tree (recursiveDelete — logs, photos metadata,
//      markers, KML metadata, sessions, settings, memberships, _debug, the
//      frozen pre-flip project mirrors, everything)
//   4. Storage prefixes photos/{uid}/ and kml/{uid}/
// Every step is uid-scoped and individually try/caught — a failure in one
// step never blocks the rest, and the summary log shows what ran.

async function _purgeQueryDocs(db, query, label, out) {
  try {
    const snap = await query.get();
    if (snap.empty) return;
    let batch = db.batch(), n = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      if (++n % 450 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
    out.push(`${label}:${snap.size}`);
  } catch (e) {
    out.push(`${label}:FAILED(${e.message})`);
  }
}

exports.purgeDeletedUser = functionsV1.auth.user().onDelete(async (user) => {
  const uid = user.uid;
  const db = getFirestore();
  const done = [];

  // 1. Shared-project cleanup — read memberships BEFORE the user tree dies.
  let pids = [];
  try {
    const mems = await db.collection('users').doc(uid).collection('memberships').get();
    pids = mems.docs.map((d) => d.id);
  } catch (e) {
    done.push(`memberships-read:FAILED(${e.message})`);
  }
  for (const pid of pids) {
    const proj = db.collection('projects').doc(pid);
    await _purgeQueryDocs(db, proj.collection('photos').where('ownerUid', '==', uid), `${pid}/photos`, done);
    await _purgeQueryDocs(db, proj.collection('fieldMarkers').where('ownerUid', '==', uid), `${pid}/markers`, done);
    await _purgeQueryDocs(db, proj.collection('trackerEntries').where('ownerUid', '==', uid), `${pid}/entries`, done);
    await _purgeQueryDocs(db, proj.collection('trackerCategories').where('ownerUid', '==', uid), `${pid}/categories`, done);
    await _purgeQueryDocs(db, proj.collection('submissions').where('submittedBy', '==', uid), `${pid}/submissions`, done);
    // 8/26 (App Store 5.1.1(v) — privacy policy promises ALL associated data):
    // the remaining owner-stamped project subcollections.
    for (const col of ['kmlLayers', 'planOverlays', 'docs', 'complianceLog', 'swpppInspections', 'openItems']) {
      await _purgeQueryDocs(db, proj.collection(col).where('ownerUid', '==', uid), `${pid}/${col}`, done);
    }
    try {
      await proj.collection('members').doc(uid).delete();
      const remaining = await proj.collection('members').limit(1).get();
      if (remaining.empty) {
        // Nobody can reach a member-less project (rules gate on membership) —
        // delete the shell so no orphaned config/reference data lingers.
        await db.recursiveDelete(proj);
        done.push(`${pid}:orphan-shell-deleted`);
      } else {
        done.push(`${pid}:member-doc-deleted`);
      }
    } catch (e) {
      done.push(`${pid}/members:FAILED(${e.message})`);
    }
  }

  // 2. Invites the user minted (a dead lead's tokens must not admit anyone).
  await _purgeQueryDocs(db, db.collection('invites').where('createdBy', '==', uid), 'invites', done);

  // 3. The whole personal tree.
  try {
    await db.recursiveDelete(db.collection('users').doc(uid));
    done.push('users-tree:deleted');
  } catch (e) {
    done.push(`users-tree:FAILED(${e.message})`);
  }

  // 4. Storage files.
  for (const prefix of [`photos/${uid}/`, `kml/${uid}/`, `docs/${uid}/`, `planOverlays/${uid}/`]) {
    try {
      await getStorage().bucket().deleteFiles({ prefix });
      done.push(`storage ${prefix}:deleted`);
    } catch (e) {
      done.push(`storage ${prefix}:FAILED(${e.message})`);
    }
  }

  console.log(`purgeDeletedUser ${uid}: ${done.join(' | ')}`);
});

// Instant alert — fires on any new _debug doc with severity:'critical'.
exports.criticalErrorAlert = onDocumentCreated(
  { document: 'users/{uid}/_debug/{docId}', secrets: [WEBHOOK] },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.severity !== 'critical') return;

    const uid = event.params.uid;
    const msg = data.message || '(no message)';
    const stack = data.stack ? data.stack.slice(0, 800) : null;

    const description = [
      `**Message:** \`${msg}\``,
      `**UID:** \`${uid}\``,
      data.url && `**URL:** ${data.url}`,
      data.platform && `**Platform:** ${data.platform}`,
      stack && `\`\`\`\n${stack}\n\`\`\``,
    ]
      .filter(Boolean)
      .join('\n');

    await postToDiscord(WEBHOOK.value(), {
      embeds: [{
        title: '🚨 Critical Error — GroundLog',
        description,
        color: 0xdc2626,
        footer: { text: 'GroundLog β.2 · criticalErrorAlert' },
        timestamp: new Date().toISOString(),
      }],
    });
  }
);


// ═══════════════════════════════════════════════════════════════════════════
// aiComplete — platform-hosted Claude proxy (8/26, App Store v1 / user #2 gate).
//
// Before this, the "hosted" key was an AES blob in appConfig/hosted readable by
// every signed-in user with a hardcoded salt in the client — i.e. recoverable by
// anyone. The key now lives ONLY in the ANTHROPIC_HOSTED_KEY secret. Users with
// their own key still call Anthropic directly from the client (their key, their
// account); everyone else comes through here with a per-user daily cap.
// Cap doc: aiUsage/{uid} { day:'YYYY-MM-DD', n } — rules deny all client access.
// ═══════════════════════════════════════════════════════════════════════════
const ANTHROPIC_HOSTED_KEY = defineSecret('ANTHROPIC_HOSTED_KEY');
const AI_DAILY_CAP = 40;          // calls per user per UTC day on the hosted key
const AI_MODEL = 'claude-sonnet-5';
const AI_MAX_TOKENS = 8000;

exports.aiComplete = onCall({ secrets: [ANTHROPIC_HOSTED_KEY], timeoutSeconds: 120, memory: '256MiB' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const { system, user, maxTokens } = req.data || {};
  if (typeof system !== 'string' || typeof user !== 'string' || !user.trim()) {
    throw new HttpsError('invalid-argument', 'system and user prompts are required.');
  }
  if (system.length + user.length > 120000) throw new HttpsError('invalid-argument', 'Prompt too large.');

  // Daily cap — transactional so parallel taps can't slip past it.
  const db = getFirestore();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection('aiUsage').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists && snap.data().day === day ? (snap.data().n || 0) : 0;
    if (cur >= AI_DAILY_CAP) {
      throw new HttpsError('resource-exhausted', `Daily AI limit reached (${AI_DAILY_CAP}/day on the GroundLog key). Add your own API key in Settings → Report Generation for unlimited use.`);
    }
    tx.set(ref, { day, n: cur + 1, _ts: Date.now() });
  });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_HOSTED_KEY.value().trim(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: Math.min(Number(maxTokens) || AI_MAX_TOKENS, AI_MAX_TOKENS), system, messages: [{ role: 'user', content: user }] }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`aiComplete ${uid}: upstream ${resp.status} ${txt.slice(0, 300)}`);
    throw new HttpsError('internal', `AI service error (${resp.status}).`);
  }
  const data = await resp.json();
  const block = (data.content || []).find((b) => b.type === 'text' && b.text);
  if (!block) throw new HttpsError('internal', 'Empty AI response.');
  return { text: block.text };
});

// ═══════════════════════════════════════════════════════════════════════════
// revokeAppleToken — Sign in with Apple token revocation on account deletion
// (Apple requires it: App Store Review 5.1.1(v)). The client re-authenticates
// with Apple right before deleting and passes the fresh authorizationCode
// (single-use, 5-minute life); we exchange it for tokens and revoke them.
// Secrets: APPLE_SIWA_KEY_ID (10 chars), APPLE_SIWA_PRIVATE_KEY (the .p8 PEM
// of a Sign in with Apple key from developer.apple.com → Keys).
// ═══════════════════════════════════════════════════════════════════════════
const APPLE_SIWA_KEY_ID = defineSecret('APPLE_SIWA_KEY_ID');
const APPLE_SIWA_PRIVATE_KEY = defineSecret('APPLE_SIWA_PRIVATE_KEY');
const APPLE_TEAM_ID = '7YRGVD95PY';
const APPLE_CLIENT_ID = 'io.groundlog.app';   // native app = bundle id (a web Service ID would differ)

async function _appleClientSecret() {
  const { SignJWT, importPKCS8 } = require('jose');
  // Secrets pasted with literal "\n" sequences still parse.
  const pem = APPLE_SIWA_PRIVATE_KEY.value().replace(/\\n/g, '\n').trim();
  const key = await importPKCS8(pem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: APPLE_SIWA_KEY_ID.value().trim() })
    .setIssuer(APPLE_TEAM_ID).setIssuedAt().setExpirationTime('10m')
    .setAudience('https://appleid.apple.com').setSubject(APPLE_CLIENT_ID)
    .sign(key);
}

exports.revokeAppleToken = onCall({ secrets: [APPLE_SIWA_KEY_ID, APPLE_SIWA_PRIVATE_KEY], timeoutSeconds: 60 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const code = req.data && req.data.authorizationCode;
  if (typeof code !== 'string' || !code) throw new HttpsError('invalid-argument', 'authorizationCode required.');
  const secret = await _appleClientSecret();
  const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const tok = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: APPLE_CLIENT_ID, client_secret: secret, code, grant_type: 'authorization_code' }),
  });
  if (!tok.ok) {
    const txt = await tok.text();
    console.error(`revokeAppleToken ${req.auth.uid}: token exchange ${tok.status} ${txt.slice(0, 300)}`);
    throw new HttpsError('failed-precondition', 'Apple token exchange failed.');
  }
  const { refresh_token, access_token } = await tok.json();
  const token = refresh_token || access_token;
  const rev = await fetch('https://appleid.apple.com/auth/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: APPLE_CLIENT_ID, client_secret: secret, token, token_type_hint: refresh_token ? 'refresh_token' : 'access_token' }),
  });
  if (!rev.ok) {
    const txt = await rev.text();
    console.error(`revokeAppleToken ${req.auth.uid}: revoke ${rev.status} ${txt.slice(0, 300)}`);
    throw new HttpsError('internal', 'Apple revocation failed.');
  }
  console.log(`revokeAppleToken ${req.auth.uid}: revoked`);
  return { revoked: true };
});
