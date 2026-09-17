// Abuse-cap decision logic (functions/limits.js) — 9/17 launch-readiness audit.
// Pure functions, no emulator. Run: npx vitest run tests/functions

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../../functions/limits.js');

const DAY = '2026-09-17';

describe('gateNext — per-account Discord alert buckets', () => {
  it('allows up to the cap, then suppresses and counts the misses', () => {
    let cur = null, allowed = 0;
    for (let i = 0; i < 8; i++) { const r = L.gateNext(cur, DAY, 'critical', L.ALERT_CAPS.critical); if (r.allow) allowed++; cur = r.next; }
    expect(allowed).toBe(5);
    expect(cur.counts.critical).toBe(5);
    expect(cur.suppressed.critical).toBe(3);
  });
  it('buckets are independent: a critical flood does not mute review traffic', () => {
    let cur = null;
    for (let i = 0; i < 10; i++) cur = L.gateNext(cur, DAY, 'critical', 5).next;
    const r = L.gateNext(cur, DAY, 'review', L.ALERT_CAPS.review);
    expect(r.allow).toBe(true);
    expect(r.next.suppressed.critical).toBe(5);
  });
  it('a new UTC day resets counts and suppressed', () => {
    let cur = null;
    for (let i = 0; i < 7; i++) cur = L.gateNext(cur, DAY, 'report', 5).next;
    const r = L.gateNext(cur, '2026-09-18', 'report', 5);
    expect(r.allow).toBe(true);
    expect(r.next.counts).toEqual({ report: 1 });
    expect(r.next.suppressed).toEqual({});
  });
  it('a heavy but honest review day (submit, 2 returns, 2 resubmits, sign, 12 replies) fits', () => {
    let cur = null, ok = true;
    for (let i = 0; i < 18; i++) { const r = L.gateNext(cur, DAY, 'review', L.ALERT_CAPS.review); ok = ok && r.allow; cur = r.next; }
    expect(ok).toBe(true);
  });
});

describe('aiUserCap — account-age tiers', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  it('fresh account gets the small cap', () => { expect(L.aiUserCap(now - 2 * 86400000, now)).toBe(L.AI_NEW_ACCOUNT_CAP); });
  it('week-old account gets the full cap', () => { expect(L.aiUserCap(now - 8 * 86400000, now)).toBe(L.AI_USER_CAP); });
  it('unknown creation time is treated as new (fails closed)', () => { expect(L.aiUserCap(0, now)).toBe(L.AI_NEW_ACCOUNT_CAP); });
});

describe('platform ceiling', () => {
  it('floor of 100 until established users justify more', () => {
    expect(L.aiPlatformCeiling(0)).toBe(100);
    expect(L.aiPlatformCeiling(5)).toBe(100);
    expect(L.aiPlatformCeiling(12)).toBe(240);
  });
  it('alerts once at 50%, once at 100%, then refuses and counts', () => {
    let cur = null, half = 0, full = 0, allowed = 0, halfAt = 0;
    for (let i = 1; i <= 104; i++) {
      const r = L.aiPlatformNext(cur, DAY, 100);
      if (r.crossedHalf) { half++; halfAt = i; }
      if (r.crossedFull) full++;
      if (r.allow) allowed++;
      cur = r.next;
    }
    expect(allowed).toBe(100);
    expect(half).toBe(1);
    expect(halfAt).toBe(50);
    expect(full).toBe(1);
    expect(cur.denied).toBe(4);
  });
  it('resets on a new day', () => {
    let cur = null;
    for (let i = 0; i < 100; i++) cur = L.aiPlatformNext(cur, DAY, 100).next;
    const r = L.aiPlatformNext(cur, '2026-09-18', 100);
    expect(r.allow).toBe(true);
    expect(r.next.n).toBe(1);
    expect(r.next.alertedHalf).toBe(false);
  });
});
