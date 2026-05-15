const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

const WEBHOOK = defineSecret('DISCORD_ERROR_WEBHOOK_URL');

async function postToDiscord(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
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
