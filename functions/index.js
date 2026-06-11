const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
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
  for (const prefix of [`photos/${uid}/`, `kml/${uid}/`]) {
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
