// Storage security-rules tests — per-uid isolation + the 9/17 size caps.
// Run: npm run test:rules:storage  (wraps vitest in `firebase emulators:exec --only storage`)

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, it } from 'vitest';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

let env;
const MB = 1024 * 1024;
const blob = (mb) => new Uint8Array(Math.round(mb * MB));

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'groundlog-rules-test',
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
afterAll(async () => { await env.cleanup(); });

const st = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();

describe('per-uid isolation (unchanged contract)', () => {
  it('owner writes, reads and deletes in their own prefix', async () => {
    const r = ref(st('tim'), 'photos/tim/p1/a.jpg');
    await assertSucceeds(uploadBytes(r, blob(0.2)));
    await assertSucceeds(getBytes(r));
    await assertSucceeds(deleteObject(r));
  });
  it('a stranger cannot write or read in someone else\'s prefix', async () => {
    await assertSucceeds(uploadBytes(ref(st('tim'), 'docs/tim/d1/plan.pdf'), blob(0.2)));
    await assertFails(uploadBytes(ref(st('mallory'), 'docs/tim/d1/evil.pdf'), blob(0.2)));
    await assertFails(getBytes(ref(st('mallory'), 'docs/tim/d1/plan.pdf')));
    await assertFails(deleteObject(ref(st('mallory'), 'docs/tim/d1/plan.pdf')));
  });
  it('signed-out gets nothing', async () => {
    await assertFails(uploadBytes(ref(st(null), 'photos/tim/p1/a.jpg'), blob(0.1)));
  });
  it('paths outside the four prefixes are closed', async () => {
    await assertFails(uploadBytes(ref(st('tim'), 'other/tim/x.bin'), blob(0.1)));
  });
});

describe('size caps (9/17 launch audit S2)', () => {
  it('photos: 12 MB (largest live photo) passes, 41 MB fails', async () => {
    await assertSucceeds(uploadBytes(ref(st('tim'), 'photos/tim/p2/big.jpg'), blob(12)));
    await assertFails(uploadBytes(ref(st('tim'), 'photos/tim/p2/huge.jpg'), blob(41)));
  });
  it('kml: 41 MB (largest live KML) passes, 101 MB fails', async () => {
    await assertSucceeds(uploadBytes(ref(st('tim'), 'kml/tim/site.kml'), blob(41)));
    await assertFails(uploadBytes(ref(st('tim'), 'kml/tim/huge.kml'), blob(101)));
  });
  it('planOverlays: 5 MB passes, 101 MB fails', async () => {
    await assertSucceeds(uploadBytes(ref(st('tim'), 'planOverlays/tim/s1-sheet.png'), blob(5)));
    await assertFails(uploadBytes(ref(st('tim'), 'planOverlays/tim/s1-huge.png'), blob(101)));
  });
  // The 301 MB denial is not asserted: the Storage emulator errors out on a body that
  // large before rules run. The cap expression is the same one proven on the other paths.
  it('docs: 120 MB (largest live plan set) passes; stored report PDFs path works', async () => {
    await assertSucceeds(uploadBytes(ref(st('tim'), 'docs/tim/_reports/proj1/daily.pdf'), blob(1)));
    await assertSucceeds(uploadBytes(ref(st('tim'), 'docs/tim/d2/planset.pdf'), blob(120)));
  }, 120000);
  it('an over-cap file can still be deleted (delete is not size-gated)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await uploadBytes(ref(ctx.storage(), 'photos/tim/old/legacy.jpg'), blob(45)); });
    await assertSucceeds(deleteObject(ref(st('tim'), 'photos/tim/old/legacy.jpg')));
  });
});
