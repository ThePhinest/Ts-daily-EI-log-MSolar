// Net-area engine Web Worker (8/25 boot perf): the suffix-union pass over a
// running-mode category (252 disturbance drawings ≈ 5 s on an iPhone) used to
// run on the main thread on the first map / Compliance visit — the first-touch
// freeze. geo.js posts {id, entries, states} here right after the tracker
// loads; the result fills the same memo the synchronous functions read.
import { computeAll } from './geoCore.js';
self.onmessage = (ev) => {
  const { id, entries, states } = ev.data || {};
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  let v = null, err = null;
  try { v = computeAll(entries, states); } catch (e) { err = (e && e.message) || String(e); }
  const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  self.postMessage({ id, v, err, ms: Math.round(t1 - t0), n: (entries || []).length });
};
