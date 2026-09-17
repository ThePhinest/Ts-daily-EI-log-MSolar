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

const { setGlobalOptions } = require('firebase-functions/v2');
const { getAuth } = require('firebase-admin/auth');
const L = require('./limits');

initializeApp();
// 9/17 launch audit (S5): no function may scale without a ceiling.
setGlobalOptions({ maxInstances: 10 });

const WEBHOOK = defineSecret('DISCORD_ERROR_WEBHOOK_URL');
// DISCORD_NEW_ACCOUNTS_WEBHOOK_URL is bound by name on the v1 newAccountAlert trigger below.

const _utcDay = () => new Date().toISOString().slice(0, 10);

// 9/17 launch audit (S1): per-account (and per-project) daily cap on Discord
// alert posts. keys = [[docId, cap], …] in alertUsage/ (no client rule → Admin
// SDK only). Returns false when any key is over its cap; the miss is counted
// as `suppressed` and surfaces in the daily digest. Fails OPEN on a Firestore
// error: a broken counter must never silence a real alert.
async function _alertGate(keys, bucket) {
  const db = getFirestore();
  const day = _utcDay();
  for (const [id, cap] of keys) {
    if (!id) continue;
    try {
      const ref = db.collection('alertUsage').doc(String(id));
      const allow = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const r = L.gateNext(snap.exists ? snap.data() : null, day, bucket, cap);
        tx.set(ref, Object.assign(r.next, { _ts: Date.now() }));
        return r.allow;
      });
      if (!allow) { console.warn(`[alertGate] ${id} over ${bucket} cap (${cap}/day) — suppressed`); return false; }
    } catch (e) { console.warn('[alertGate] counter failed, allowing:', e.message); }
  }
  return true;
}

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

    // 9/17 launch audit: platform health lines (suppressed alerts, hosted-AI use,
    // new accounts / projects) + recompute the AI ceiling's `established` count.
    const health = [];
    try {
      const sup = await db.collection('alertUsage').where('_ts', '>=', cutoff).get();
      let supN = 0; const supWho = [];
      sup.forEach((d) => { const t = Object.values((d.data().suppressed) || {}).reduce((a, b) => a + b, 0); if (t) { supN += t; supWho.push(`\`${d.id}\` × ${t}`); } });
      if (supN) health.push(`🔇 **${supN}** alert${supN !== 1 ? 's' : ''} suppressed by the daily caps: ${supWho.slice(0, 5).join(', ')}`);
      const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const [platY, statY, projNew] = await Promise.all([
        db.collection('aiPlatform').doc(yday).get(),
        db.collection('statsDaily').doc(yday).get(),
        db.collection('projects').where('createdAt', '>=', cutoff).count().get(),
      ]);
      if (platY.exists && (platY.data().n || platY.data().denied)) health.push(`🤖 Hosted AI yesterday: **${platY.data().n || 0}** of ${platY.data().ceiling || '?'} calls${platY.data().denied ? `, **${platY.data().denied} refused at the ceiling**` : ''}`);
      const na = statY.exists ? (statY.data().newAccounts || 0) : 0;
      const np = projNew.data().count || 0;
      if (na || np) health.push(`👤 New accounts yesterday: **${na}** · new projects (24h): **${np}**`);
      const weekAgo = Date.now() - 7 * 86400000;
      const active = await db.collection('aiUsage').where('_ts', '>=', weekAgo).get();
      let established = 0;
      active.forEach((d) => { const c = d.data().created || 0; if (c && c < weekAgo) established++; });
      await db.collection('aiPlatform').doc('config').set({ established, ceiling: L.aiPlatformCeiling(established), computedAt: Date.now() });
    } catch (e) { console.warn('[errorDigest] health lines failed:', e.message); }

    if (allErrors.length === 0 && health.length === 0) {
      console.log('No errors and no platform news in past 24h — digest skipped');
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
        }.${lines ? '\n\n' + lines : ''}${health.length ? '\n\n' + health.join('\n') : ''}`,
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

exports.purgeDeletedUser = functionsV1.runWith({ maxInstances: 5 }).auth.user().onDelete(async (user) => {
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

// 9/17: every new account → the new-accounts Discord channel. Privacy posture:
// NO email, NO name — provider + short uid + running total only. The total lives
// in stats/accounts (seeded once from Auth); statsDaily/{day} feeds the digest.
exports.newAccountAlert = functionsV1.runWith({ secrets: ['DISCORD_NEW_ACCOUNTS_WEBHOOK_URL'], maxInstances: 5 })
  .auth.user().onCreate(async (user) => {
    const db = getFirestore();
    const day = _utcDay();
    let total = null;
    try {
      const ref = db.collection('stats').doc('accounts');
      const snap = await ref.get();
      if (!snap.exists) {
        let n = 0, token;
        do { const page = await getAuth().listUsers(1000, token); n += page.users.length; token = page.pageToken; } while (token);
        total = n;                       // listUsers already includes this account
        await ref.set({ total, seededAt: Date.now() });
      } else {
        total = await db.runTransaction(async (tx) => {
          const s = await tx.get(ref); const t = ((s.data() || {}).total || 0) + 1;
          tx.set(ref, { total: t, _ts: Date.now() }, { merge: true }); return t;
        });
      }
      const dref = db.collection('statsDaily').doc(day);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(dref);
        tx.set(dref, { newAccounts: ((s.exists && s.data().newAccounts) || 0) + 1, _ts: Date.now() }, { merge: true });
      });
    } catch (e) { console.warn('[newAccountAlert] counters failed:', e.message); }
    const provider = ((user.providerData || [])[0] || {}).providerId || 'password';
    const label = provider === 'google.com' ? 'Google' : provider === 'apple.com' ? 'Apple' : 'Email';
    await postToDiscord(process.env.DISCORD_NEW_ACCOUNTS_WEBHOOK_URL, {
      embeds: [{
        title: '👤 New GroundLog account',
        description: `Sign-in: **${label}**\nAccount: \`${String(user.uid).slice(0, 8)}…\`${total != null ? `\nTotal accounts: **${total}**` : ''}`,
        color: 0x006b75, footer: { text: 'GroundLog · newAccountAlert' }, timestamp: new Date().toISOString(),
      }],
    });
  });

// Instant alert — fires on any new _debug doc with severity:'critical'.
exports.criticalErrorAlert = onDocumentCreated(
  { document: 'users/{uid}/_debug/{docId}', secrets: [WEBHOOK] },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.severity !== 'critical') return;

    const uid = event.params.uid;
    if (!(await _alertGate([['u_' + uid, L.ALERT_CAPS.critical]], 'critical'))) return;
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



// ⚑ Content report alert (8/27, App Store Guideline 1.2): every new
// contentReports/{id} doc → support Discord channel (same webhook as the
// error digest). The reporter's identity stays in Firestore; the embed carries
// what support needs to act within 24h.
exports.contentReportAlert = onDocumentCreated(
  { document: 'contentReports/{id}', secrets: [WEBHOOK] },
  async (event) => {
    const r = event.data?.data();
    if (!r) return;
    if (!(await _alertGate([['u_' + (r.reporterUid || 'unknown'), L.ALERT_CAPS.report]], 'report'))) return;
    const description = [
      `**Reason:** ${r.reason || '(none)'}`,
      r.note && `**Note:** ${String(r.note).slice(0, 600)}`,
      `**Target:** ${r.targetType} \`${r.targetId}\`${r.targetLabel ? ' — ' + String(r.targetLabel).slice(0, 120) : ''}`,
      `**Project:** ${r.projectName || ''} \`${r.pid}\``,
      `**Owner UID:** \`${r.targetOwnerUid || '?'}\`  ·  **Reporter:** ${r.reporterName || ''} \`${r.reporterUid}\``,
      r.platform && `**Platform:** ${r.platform}`,
      `Firestore: contentReports/${event.params.id}`,
    ].filter(Boolean).join('\n');
    await postToDiscord(WEBHOOK.value(), {
      embeds: [{
        title: '⚑ Content report — GroundLog',
        description,
        color: 0xf59e0b,
        footer: { text: 'GroundLog · contentReportAlert · act within 24h' },
        timestamp: new Date().toISOString(),
      }],
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// reviewAlert — §C review & sign-off notifications (8/31 build, Forest 9/10).
//
// Fires on submission writes: a NEW pending review notifies the reviewer, a
// pending→approved/returned transition notifies the author. v1 delivery is
// the Discord ops channel (badge-only in-app model, Tim relays); email is
// scaffolded below and switched OFF until a provider is chosen — flip
// EMAIL_ENABLED and fill _sendReviewEmail when we're ready (cost-tracker
// entry required per feedback_track_costs_when_adding_services).
// ═══════════════════════════════════════════════════════════════════════════
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const EMAIL_ENABLED = false;

async function _sendReviewEmail(toUid, subject, bodyText) {
  if (!EMAIL_ENABLED) { console.log('[reviewAlert] email disabled — would send to', toUid, ':', subject); return; }
  // Provider goes here (M365 SMTP via GoDaddy aliases, or Resend). Look up the
  // recipient address from the project membership doc or Auth record, send, done.
}

exports.reviewAlert = onDocumentWritten(
  { document: 'projects/{pid}/submissions/{sid}', secrets: [WEBHOOK] },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !after.review) return;
    const prevStatus = before?.review?.status || null;
    const curStatus = after.review.status;
    // 9/16 review conversation: a message appended to `thread` on an EXISTING doc
    // notifies the other party (author ↔ reviewer). A brand-new doc that carries a
    // note (fix & resubmit) is reported by the pending branch below instead.
    const thrB = Array.isArray(before?.thread) ? before.thread.length : 0;
    const thrA = Array.isArray(after.thread) ? after.thread.length : 0;
    if (before && thrA > thrB) {
      const m = after.thread[thrA - 1] || {};
      const toAuthor = m.by !== after.submittedBy;
      if (!(await _alertGate([['u_' + (m.by || after.submittedBy), L.ALERT_CAPS.review], ['p_' + event.params.pid, L.PROJECT_ALERT_CAP]], 'review'))) return;
      const title = '💬 Reply on report';
      const detail = `**${m.byName || (toAuthor ? 'Reviewer' : 'Author')}** on **${after.date}**${toAuthor ? ' → ' + (after.submittedByName || 'author') : ' → ' + (after.review.reviewerName || 'reviewer')}: ${String(m.text || '').slice(0, 300)}`;
      try {
        await postToDiscord(WEBHOOK.value(), {
          embeds: [{
            title: `${title} — ${after.projectName || event.params.pid}`,
            description: `${detail}\nFirestore: projects/${event.params.pid}/submissions/${event.params.sid}`,
            color: 0x006b75, footer: { text: 'GroundLog · reviewAlert' }, timestamp: new Date().toISOString(),
          }],
        });
      } catch (e) { console.warn('[reviewAlert] Discord post failed:', e.message); }
      await _sendReviewEmail(toAuthor ? after.submittedBy : after.review.reviewerUid, title, detail.replace(/\*\*/g, ''));
      return;
    }
    if (prevStatus === curStatus) return;   // no review transition in this write

    let title = null, detail = null, notifyUid = null;
    if (curStatus === 'pending') {
      const note = thrA ? ` Note: ${String((after.thread[0] || {}).text || '').slice(0, 300)}` : '';
      title = after.fixedFrom ? '✍ Report fixed & resubmitted for review' : '✍ Report sent for review';
      detail = `**${after.submittedByName || 'Author'}** sent **${after.date}**${(after.version || 1) > 1 ? ' v' + after.version : ''} to **${after.review.reviewerName || 'reviewer'}** for review & signature.${note}`;
      notifyUid = after.review.reviewerUid;
    } else if (prevStatus === 'pending' && curStatus === 'approved') {
      title = '✓ Report approved & signed';
      detail = `**${after.review.reviewerName || 'Reviewer'}** signed **${after.date}** (submitted by ${after.submittedByName || 'author'}).`;
      notifyUid = after.submittedBy;
    } else if (prevStatus === 'pending' && curStatus === 'returned') {
      title = '↩ Report returned';
      detail = `**${after.review.reviewerName || 'Reviewer'}** returned **${after.date}**${after.review.comment ? ': ' + String(after.review.comment).slice(0, 300) : ''}.`;
      notifyUid = after.submittedBy;
    }
    if (!title) return;
    const actor = curStatus === 'pending' ? after.submittedBy : after.review.reviewerUid;
    if (!(await _alertGate([['u_' + actor, L.ALERT_CAPS.review], ['p_' + event.params.pid, L.PROJECT_ALERT_CAP]], 'review'))) return;

    try {
      await postToDiscord(WEBHOOK.value(), {
        embeds: [{
          title: `${title} — ${after.projectName || event.params.pid}`,
          description: `${detail}\nFirestore: projects/${event.params.pid}/submissions/${event.params.sid}`,
          color: curStatus === 'approved' ? 0x27ae60 : curStatus === 'returned' ? 0xe74c3c : 0xc9a84c,
          footer: { text: 'GroundLog · reviewAlert' },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (e) { console.warn('[reviewAlert] Discord post failed:', e.message); }
    await _sendReviewEmail(notifyUid, title, detail.replace(/\*\*/g, ''));
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
// Cap doc: aiUsage/{uid} { day:'YYYY-MM-DD', n, created } — rules deny all client access.
// 9/17 launch audit (S3): accounts are free, so a per-account cap alone multiplies.
//   per account: 20/day, 8/day while the account is under 7 days old (functions/limits.js)
//   platform:    aiPlatform/{day} { n, denied, … } against a ceiling of
//                max(100, 20 × established users); `established` is recomputed by
//                the daily digest into aiPlatform/config (fresh accounts never count).
//   Discord ops alert once at 50% and once at 100% of the day's ceiling.
// ═══════════════════════════════════════════════════════════════════════════
const ANTHROPIC_HOSTED_KEY = defineSecret('ANTHROPIC_HOSTED_KEY');
const AI_MODEL = 'claude-sonnet-5';
const AI_MAX_TOKENS = 8000;

exports.aiComplete = onCall({ secrets: [ANTHROPIC_HOSTED_KEY, WEBHOOK], timeoutSeconds: 120, memory: '256MiB' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const { system, user, maxTokens } = req.data || {};
  if (typeof system !== 'string' || typeof user !== 'string' || !user.trim()) {
    throw new HttpsError('invalid-argument', 'system and user prompts are required.');
  }
  if (system.length + user.length > 120000) throw new HttpsError('invalid-argument', 'Prompt too large.');

  // Daily cap — transactional so parallel taps can't slip past it.
  const db = getFirestore();
  const day = _utcDay();
  const ref = db.collection('aiUsage').doc(uid);
  const platRef = db.collection('aiPlatform').doc(day);
  const cfgRef = db.collection('aiPlatform').doc('config');
  // Account age decides the tier; looked up once, then cached on the usage doc.
  let created = 0;
  try {
    const first = await ref.get();
    created = (first.exists && first.data().created) || 0;
    if (!created) created = Date.parse((await getAuth().getUser(uid)).metadata.creationTime) || 0;
  } catch (e) { console.warn('aiComplete: creation-time lookup failed:', e.message); }
  const userCap = L.aiUserCap(created, Date.now());

  const plat = await db.runTransaction(async (tx) => {
    const [snap, platSnap, cfgSnap] = await Promise.all([tx.get(ref), tx.get(platRef), tx.get(cfgRef)]);
    const cur = snap.exists && snap.data().day === day ? (snap.data().n || 0) : 0;
    if (cur >= userCap) {
      throw new HttpsError('resource-exhausted', `Daily AI limit reached (${userCap}/day on the GroundLog key${userCap < L.AI_USER_CAP ? '; it rises to ' + L.AI_USER_CAP + ' after your first week' : ''}). Add your own API key in Settings → Report Generation for unlimited use.`);
    }
    const ceiling = L.aiPlatformCeiling(cfgSnap.exists ? cfgSnap.data().established : 0);
    const r = L.aiPlatformNext(platSnap.exists ? platSnap.data() : null, day, ceiling);
    tx.set(platRef, Object.assign(r.next, { _ts: Date.now() }));
    if (!r.allow) return r;          // commit the denied count, refuse below
    tx.set(ref, { day, n: cur + 1, created, _ts: Date.now() });
    return r;
  });
  if (plat.crossedHalf || plat.crossedFull) {
    try {
      await postToDiscord(WEBHOOK.value(), { embeds: [{
        title: plat.allow && !plat.crossedFull ? '⚠ Hosted AI key at 50% of today\'s ceiling' : '🚨 Hosted AI key hit today\'s ceiling',
        description: `**${plat.next.n}** of **${plat.next.ceiling}** platform calls used (UTC day ${day}). Last caller \`${uid}\`. Normal use is a few calls per inspector per day; check the new-accounts channel for a signup wave.`,
        color: plat.allow && !plat.crossedFull ? 0xf59e0b : 0xdc2626, footer: { text: 'GroundLog · aiComplete' }, timestamp: new Date().toISOString(),
      }] });
    } catch (e) { console.warn('aiComplete: ceiling alert failed:', e.message); }
  }
  if (!plat.allow) {
    throw new HttpsError('resource-exhausted', 'The shared GroundLog AI key is at its limit for today. Add your own API key in Settings → Report Generation to keep going, or try again tomorrow.');
  }

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
