// Abuse caps — pure decision logic (9/17 launch-readiness audit, S1 + S3).
// No Firebase imports here so the rules of the caps are unit-testable
// (tests/functions/limits.test.js); index.js wraps these in transactions.
//
// Why caps at all: every account can write in its own space (users/{uid}/…,
// its own free project), and three Firestore triggers turn such writes into
// Discord posts; the hosted AI key is per-account capped but accounts are free.
// Over-cap events are never dropped silently: they are counted as `suppressed`
// and the daily digest reports them — a suppressed count IS the abuse signal.

// Discord alert posts per account per UTC day, by bucket.
const ALERT_CAPS = { review: 25, critical: 5, report: 5 };
// Backstop per project per day (review traffic), whoever the actors are.
const PROJECT_ALERT_CAP = 60;

// Hosted-key AI calls per account per UTC day.
const AI_USER_CAP = 20;
const AI_NEW_ACCOUNT_CAP = 8;       // accounts younger than AI_NEW_ACCOUNT_DAYS
const AI_NEW_ACCOUNT_DAYS = 7;
// Platform-wide ceiling per UTC day: grows with ESTABLISHED users only
// (older than a week AND used AI in the last 7 days), so a wave of fresh
// throwaway accounts cannot raise its own ceiling.
const AI_PLATFORM_FLOOR = 100;
const AI_PER_ESTABLISHED = 20;

function gateNext(cur, day, bucket, cap) {
  const same = cur && cur.day === day;
  const counts = same ? Object.assign({}, cur.counts) : {};
  const suppressed = same ? Object.assign({}, cur.suppressed) : {};
  const n = counts[bucket] || 0;
  const allow = n < cap;
  if (allow) counts[bucket] = n + 1;
  else suppressed[bucket] = (suppressed[bucket] || 0) + 1;
  return { allow, next: { day, counts, suppressed } };
}

function aiUserCap(createdMs, nowMs) {
  if (!createdMs) return AI_NEW_ACCOUNT_CAP;
  return (nowMs - createdMs) < AI_NEW_ACCOUNT_DAYS * 86400000 ? AI_NEW_ACCOUNT_CAP : AI_USER_CAP;
}

function aiPlatformCeiling(established) {
  return Math.max(AI_PLATFORM_FLOOR, AI_PER_ESTABLISHED * (Number(established) || 0));
}

// cur = today's platform doc (or null). Returns whether this call may run and
// whether it is the call that crosses 50% / 100% (each alerts once per day).
function aiPlatformNext(cur, day, ceiling) {
  const same = cur && cur.day === day;
  const n = same ? (cur.n || 0) : 0;
  const denied = same ? (cur.denied || 0) : 0;
  if (n >= ceiling) return { allow: false, crossedHalf: false, crossedFull: false, next: { day, n, denied: denied + 1, alertedHalf: !!(same && cur.alertedHalf), alertedFull: !!(same && cur.alertedFull), ceiling } };
  const nn = n + 1;
  const half = Math.ceil(ceiling / 2);
  const crossedHalf = nn >= half && !(same && cur.alertedHalf);
  const crossedFull = nn >= ceiling && !(same && cur.alertedFull);
  return { allow: true, crossedHalf, crossedFull, next: { day, n: nn, denied, alertedHalf: (same && cur.alertedHalf) || crossedHalf, alertedFull: (same && cur.alertedFull) || crossedFull, ceiling } };
}

module.exports = {
  ALERT_CAPS, PROJECT_ALERT_CAP, AI_USER_CAP, AI_NEW_ACCOUNT_CAP, AI_NEW_ACCOUNT_DAYS,
  AI_PLATFORM_FLOOR, AI_PER_ESTABLISHED,
  gateNext, aiUserCap, aiPlatformCeiling, aiPlatformNext,
};
