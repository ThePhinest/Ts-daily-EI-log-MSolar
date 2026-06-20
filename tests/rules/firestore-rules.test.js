// Firestore security-rules tests — the multi-user access contract
// (forest-onboarding-gate Tier-2 #7; contract defined in submission-sharing-model).
//
// Run: npm run test:rules   (wraps vitest in `firebase emulators:exec --only firestore`)

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where,
} from 'firebase/firestore';

let env;
const PID = 'moraine';
const FUTURE = Date.now() + 14 * 86400000;
const PAST = Date.now() - 1000;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'groundlog-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
afterAll(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `projects/${PID}`), { name: 'Moraine Solar', createdBy: 'tim' });
    await setDoc(doc(db, `projects/${PID}/members/tim`),    { role: 'lead' });
    await setDoc(doc(db, `projects/${PID}/members/boots`),  { role: 'field' });
    await setDoc(doc(db, `projects/${PID}/members/forest`), { role: 'reviewer' });
    await setDoc(doc(db, `projects/${PID}/trackerEntries/pub1`),
      { ownerUid: 'tim', published: true,  acres: 2.1 });
    await setDoc(doc(db, `projects/${PID}/trackerEntries/draft1`),
      { ownerUid: 'tim', published: false, acres: 0.4 });
    await setDoc(doc(db, `projects/${PID}/trackerEntries/bootsdraft`),
      { ownerUid: 'boots', published: false, acres: 1.0 });
    await setDoc(doc(db, `projects/${PID}/kmlLayers/lod`), { ownerUid: 'tim', name: 'LOD' });
    await setDoc(doc(db, `projects/${PID}/docs/plan1`), { ownerUid: 'tim', title: 'PV.C04.20' });
    await setDoc(doc(db, `projects/${PID}/config/main`), { cap: 5 });
    await setDoc(doc(db, `projects/${PID}/submissions/s1`),
      { submittedBy: 'tim', version: 1, status: 'active', date: '2026-06-09' });
    // Invites are TOP-LEVEL (token = doc id = the link/code/QR capability).
    await setDoc(doc(db, 'invites/tok-glasses'),
      { pid: PID, role: 'reviewer', status: 'active', createdBy: 'tim',
        projectName: 'Moraine Solar', createdByName: 'Tim', expiresAt: FUTURE });
    await setDoc(doc(db, 'invites/tok-expired'),
      { pid: PID, role: 'reviewer', status: 'active', createdBy: 'tim', expiresAt: PAST });
    await setDoc(doc(db, 'invites/tok-used'),
      { pid: PID, role: 'reviewer', status: 'used', usedBy: 'someone', createdBy: 'tim', expiresAt: FUTURE });
    await setDoc(doc(db, 'users/tim/dailyLogs/2026-06-10'),
      { summary: 'private notes', personalNotes: 'never shared' });
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

describe('reviewer (Glasses) — sees published, edits nothing', () => {
  it('reads published work product', () =>
    assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}/trackerEntries/pub1`))));
  it('cannot read unpublished work product', () =>
    assertFails(getDoc(doc(as('forest'), `projects/${PID}/trackerEntries/draft1`))));
  it('lists work product when query is constrained to published', () =>
    assertSucceeds(getDocs(query(
      collection(as('forest'), `projects/${PID}/trackerEntries`),
      where('published', '==', true)))));
  it('cannot list unconstrained work product', () =>
    assertFails(getDocs(collection(as('forest'), `projects/${PID}/trackerEntries`))));
  it('reads live reference data (KML, docs, config, project meta)', async () => {
    await assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}/kmlLayers/lod`)));
    await assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}/docs/plan1`)));
    await assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}/config/main`)));
    await assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}`)));
  });
  it('reads submissions', () =>
    assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}/submissions/s1`))));
  it('CANNOT read the owner private daily log', () =>
    assertFails(getDoc(doc(as('forest'), 'users/tim/dailyLogs/2026-06-10'))));
  it('cannot write anything', async () => {
    await assertFails(setDoc(doc(as('forest'), `projects/${PID}/trackerEntries/x`),
      { ownerUid: 'forest', published: true }));
    await assertFails(updateDoc(doc(as('forest'), `projects/${PID}`), { name: 'hax' }));
    await assertFails(setDoc(doc(as('forest'), `projects/${PID}/submissions/s2`),
      { submittedBy: 'forest', version: 1 }));
    await assertFails(updateDoc(doc(as('forest'), `projects/${PID}/config/main`), { cap: 125 }));
    await assertFails(setDoc(doc(as('forest'), `projects/${PID}/docs/x`),
      { ownerUid: 'forest', title: 'hax' }));
  });
});

describe('owner / lead (Tim)', () => {
  it('reads own unpublished drafts', () =>
    assertSucceeds(getDoc(doc(as('tim'), `projects/${PID}/trackerEntries/draft1`))));
  it('lists own drafts via ownerUid-constrained query', () =>
    assertSucceeds(getDocs(query(
      collection(as('tim'), `projects/${PID}/trackerEntries`),
      where('ownerUid', '==', 'tim')))));
  it('creates self-attributed work product', () =>
    assertSucceeds(setDoc(doc(as('tim'), `projects/${PID}/trackerEntries/new1`),
      { ownerUid: 'tim', published: false })));
  it('cannot forge ownerUid on create', () =>
    assertFails(setDoc(doc(as('tim'), `projects/${PID}/trackerEntries/forged`),
      { ownerUid: 'boots', published: false })));
  it('publishes own draft (Share now / submit-day stamp)', () =>
    assertSucceeds(updateDoc(doc(as('tim'), `projects/${PID}/trackerEntries/draft1`),
      { published: true })));
  it('lead may edit another member\'s work product', () =>
    assertSucceeds(updateDoc(doc(as('tim'), `projects/${PID}/trackerEntries/bootsdraft`),
      { acres: 1.2 })));
  it('creates submissions self-attributed; withdraws via status only', async () => {
    await assertSucceeds(setDoc(doc(as('tim'), `projects/${PID}/submissions/s2`),
      { submittedBy: 'tim', version: 2, status: 'active' }));
    await assertSucceeds(updateDoc(doc(as('tim'), `projects/${PID}/submissions/s1`),
      { status: 'withdrawn', statusChangedAt: 1 }));
    await assertFails(updateDoc(doc(as('tim'), `projects/${PID}/submissions/s1`),
      { date: '2026-06-08' })); // payload is immutable — resubmit = new version doc
    await assertFails(deleteDoc(doc(as('tim'), `projects/${PID}/submissions/s1`)));
  });
  it('manages members and invites', async () => {
    await assertSucceeds(setDoc(doc(as('tim'), 'invites/tok2'),
      { pid: PID, role: 'field', status: 'active', createdBy: 'tim', expiresAt: FUTURE }));
    await assertSucceeds(deleteDoc(doc(as('tim'), `projects/${PID}/members/forest`)));
  });
});

describe('field (Boots) — works in the project, own records only', () => {
  it('creates self-attributed entries', () =>
    assertSucceeds(setDoc(doc(as('boots'), `projects/${PID}/trackerEntries/b2`),
      { ownerUid: 'boots', published: false })));
  it('shares a doc to the project (self-attributed)', () =>
    assertSucceeds(setDoc(doc(as('boots'), `projects/${PID}/docs/bdoc`),
      { ownerUid: 'boots', title: 'spec' })));
  it('cannot edit someone else\'s record', () =>
    assertFails(updateDoc(doc(as('boots'), `projects/${PID}/trackerEntries/pub1`),
      { acres: 99 })));
  it('cannot manage members or project settings', async () => {
    await assertFails(setDoc(doc(as('boots'), `projects/${PID}/members/pal`), { role: 'field' }));
    await assertFails(updateDoc(doc(as('boots'), `projects/${PID}`), { name: 'x' }));
  });
});

describe('publish mirrors — photos + field markers (explicit publish, keep your original)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, `projects/${PID}/photos/ph-pub`),
        { ownerUid: 'tim', published: true, storageUrl: 'https://x/token', date: '2026-06-11' });
      await setDoc(doc(db, `projects/${PID}/fieldMarkers/fm-pub`),
        { ownerUid: 'tim', published: true, emoji: '⚠️', lat: 1, lng: 2 });
      await setDoc(doc(db, `projects/${PID}/fieldMarkers/fm-draft`),
        { ownerUid: 'tim', published: false, emoji: '🚧', lat: 1, lng: 2 });
    });
  });
  it('reviewer reads published photo mirror (storageUrl capability rides the doc)', () =>
    assertSucceeds(getDoc(doc(as('forest'), `projects/${PID}/photos/ph-pub`))));
  it('reviewer lists published mirrors via constrained query', async () => {
    await assertSucceeds(getDocs(query(
      collection(as('forest'), `projects/${PID}/photos`), where('published', '==', true))));
    await assertSucceeds(getDocs(query(
      collection(as('forest'), `projects/${PID}/fieldMarkers`), where('published', '==', true))));
  });
  it('reviewer cannot read an unpublished marker mirror', () =>
    assertFails(getDoc(doc(as('forest'), `projects/${PID}/fieldMarkers/fm-draft`))));
  it('reviewer cannot create or delete mirrors', async () => {
    await assertFails(setDoc(doc(as('forest'), `projects/${PID}/photos/ph-evil`),
      { ownerUid: 'forest', published: true }));
    await assertFails(deleteDoc(doc(as('forest'), `projects/${PID}/photos/ph-pub`)));
  });
  it('owner publishes (mirror create, self-attributed) and unshares (mirror delete)', async () => {
    await assertSucceeds(setDoc(doc(as('tim'), `projects/${PID}/photos/ph-new`),
      { ownerUid: 'tim', published: true, storageUrl: 'https://x/t2' }));
    await assertSucceeds(deleteDoc(doc(as('tim'), `projects/${PID}/photos/ph-pub`)));
    await assertSucceeds(deleteDoc(doc(as('tim'), `projects/${PID}/fieldMarkers/fm-pub`)));
  });
  it('owner cannot forge a mirror attributed to someone else', () =>
    assertFails(setDoc(doc(as('tim'), `projects/${PID}/photos/ph-forged`),
      { ownerUid: 'boots', published: true })));
  it('field member cannot delete another member\'s mirror', () =>
    assertFails(deleteDoc(doc(as('boots'), `projects/${PID}/fieldMarkers/fm-pub`))));
  it('non-member reads no mirror, even published', () =>
    assertFails(getDoc(doc(as('stranger'), `projects/${PID}/photos/ph-pub`))));
});

describe('non-member / unauthenticated — nothing', () => {
  it('non-member reads nothing in the project', async () => {
    await assertFails(getDoc(doc(as('stranger'), `projects/${PID}`)));
    await assertFails(getDoc(doc(as('stranger'), `projects/${PID}/trackerEntries/pub1`)));
    await assertFails(getDoc(doc(as('stranger'), `projects/${PID}/submissions/s1`)));
  });
  it('non-member cannot self-enroll', () =>
    assertFails(setDoc(doc(as('stranger'), `projects/${PID}/members/stranger`),
      { role: 'reviewer' })));
  it('unauthenticated reads nothing', async () => {
    await assertFails(getDoc(doc(anon(), `projects/${PID}`)));
    await assertFails(getDoc(doc(anon(), 'users/tim/dailyLogs/2026-06-10')));
  });
});

describe('appConfig — shared hosted key (reconciled live block)', () => {
  const ADMIN = 'Z1RZWSUTXfR1Ys76VMd8FTqydaq1';
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'appConfig/hosted'), { encApiKey: 'enc-blob' });
    });
  });
  it('any authed user reads the hosted key doc', () =>
    assertSucceeds(getDoc(doc(as('forest'), 'appConfig/hosted'))));
  it('unauthenticated cannot read', () =>
    assertFails(getDoc(doc(anon(), 'appConfig/hosted'))));
  it('non-admin authed user CANNOT write (tightened from live rules)', () =>
    assertFails(setDoc(doc(as('stranger'), 'appConfig/hosted'), { encApiKey: 'evil' })));
  it('admin writes (Share-key button keeps working)', () =>
    assertSucceeds(setDoc(doc(as(ADMIN), 'appConfig/hosted'), { encApiKey: 'enc-blob2' })));
});

describe('project creation + invite flow', () => {
  it('any signed-in user creates a self-attributed project then self-enrolls as lead', async () => {
    const db = as('newbie');
    await assertSucceeds(setDoc(doc(db, 'projects/p2'), { name: 'My Job', createdBy: 'newbie' }));
    await assertSucceeds(setDoc(doc(db, 'projects/p2/members/newbie'), { role: 'lead' }));
  });
  it('cannot create a project attributed to someone else', () =>
    assertFails(setDoc(doc(as('newbie'), 'projects/p3'), { name: 'x', createdBy: 'tim' })));
  it('cannot bootstrap as lead into a project you did not create', () =>
    assertFails(setDoc(doc(as('stranger'), `projects/${PID}/members/stranger`),
      { role: 'lead' })));
  it('invite accept: token grants exactly the invited role', async () => {
    const db = as('glasses-guy');
    await assertSucceeds(setDoc(doc(db, `projects/${PID}/members/glasses-guy`),
      { role: 'reviewer', inviteToken: 'tok-glasses' }));
  });
  it('invite accept with escalated role is rejected', () =>
    assertFails(setDoc(doc(as('glasses-guy'), `projects/${PID}/members/glasses-guy`),
      { role: 'lead', inviteToken: 'tok-glasses' })));
  it('invite accept with a bogus token is rejected', () =>
    assertFails(setDoc(doc(as('glasses-guy'), `projects/${PID}/members/glasses-guy`),
      { role: 'reviewer', inviteToken: 'nope' })));
  it('invite accept with an EXPIRED invite is rejected', () =>
    assertFails(setDoc(doc(as('glasses-guy'), `projects/${PID}/members/glasses-guy`),
      { role: 'reviewer', inviteToken: 'tok-expired' })));
  it('invite accept with an already-used invite is rejected', () =>
    assertFails(setDoc(doc(as('glasses-guy'), `projects/${PID}/members/glasses-guy`),
      { role: 'reviewer', inviteToken: 'tok-used' })));
  it('invitee consumes the invite (status flip, self-attributed)', () =>
    assertSucceeds(updateDoc(doc(as('glasses-guy'), 'invites/tok-glasses'),
      { status: 'used', usedBy: 'glasses-guy', usedAt: Date.now() })));
  it('invitee cannot rewrite invite payload while consuming', () =>
    assertFails(updateDoc(doc(as('glasses-guy'), 'invites/tok-glasses'),
      { status: 'used', usedBy: 'glasses-guy', role: 'lead' })));
});

describe('invites — top-level token capability', () => {
  it('any signed-in token holder reads the invite (pre-membership accept screen)', () =>
    assertSucceeds(getDoc(doc(as('stranger'), 'invites/tok-glasses'))));
  it('unauthenticated cannot read an invite', () =>
    assertFails(getDoc(doc(anon(), 'invites/tok-glasses'))));
  it('non-lead member cannot mint an invite', () =>
    assertFails(setDoc(doc(as('boots'), 'invites/tok-boots-made'),
      { pid: PID, role: 'reviewer', status: 'active', createdBy: 'boots', expiresAt: FUTURE })));
  it('non-member cannot mint an invite for a project', () =>
    assertFails(setDoc(doc(as('stranger'), 'invites/tok-stranger'),
      { pid: PID, role: 'reviewer', status: 'active', createdBy: 'stranger', expiresAt: FUTURE })));
  it('lead MAY mint a LEAD invite (super-trusted delegate)', () =>
    assertSucceeds(setDoc(doc(as('tim'), 'invites/tok-lead'),
      { pid: PID, role: 'lead', status: 'active', createdBy: 'tim', expiresAt: FUTURE })));
  it('invite with an unknown role key is rejected', () =>
    assertFails(setDoc(doc(as('tim'), 'invites/tok-admin'),
      { pid: PID, role: 'admin', status: 'active', createdBy: 'tim', expiresAt: FUTURE })));
  it('lead-invite accept enrolls a second lead', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'invites/tok-colead'),
        { pid: PID, role: 'lead', status: 'active', createdBy: 'tim', expiresAt: FUTURE });
    });
    await assertSucceeds(setDoc(doc(as('co-lead'), `projects/${PID}/members/co-lead`),
      { role: 'lead', inviteToken: 'tok-colead' }));
  });
  it('lead cannot forge createdBy', () =>
    assertFails(setDoc(doc(as('tim'), 'invites/tok-forged'),
      { pid: PID, role: 'field', status: 'active', createdBy: 'boots', expiresAt: FUTURE })));
  it('invite without expiresAt is rejected', () =>
    assertFails(setDoc(doc(as('tim'), 'invites/tok-noexp'),
      { pid: PID, role: 'field', status: 'active', createdBy: 'tim' })));
  it('lead lists own invites via createdBy-constrained query', () =>
    assertSucceeds(getDocs(query(
      collection(as('tim'), 'invites'),
      where('createdBy', '==', 'tim'), where('pid', '==', PID)))));
  it('cannot list invites unconstrained (no token fishing)', () =>
    assertFails(getDocs(collection(as('stranger'), 'invites'))));
  it('lead revokes an invite (status flip + delete)', async () => {
    await assertSucceeds(updateDoc(doc(as('tim'), 'invites/tok-glasses'),
      { status: 'revoked' }));
    await assertSucceeds(deleteDoc(doc(as('tim'), 'invites/tok-used')));
  });
  it('random member cannot revoke or delete someone\'s invite', async () => {
    await assertFails(updateDoc(doc(as('boots'), 'invites/tok-glasses'), { status: 'revoked' }));
    await assertFails(deleteDoc(doc(as('boots'), 'invites/tok-glasses')));
  });
});
