# tests/analysis — open-area replay harness

`open-area-series.mjs` replays the SWPPP Disturbance tracker week by week with the app's OWN
net-area engine (`src/geoCore.js`: chronological precedence, later drawing wins), splits the
result by the project's "Regions" category polygons, and validates against the signed QI report
totals. Built 2026-09-10 for the AES 5-acre-waiver phasing question (Moraine); reusable for any
project that tracks disturbance in the app.

## Input: a tracker dump from the live app

Open app.groundlog.io on the desktop with the project active, F12 → Console, paste:

```js
(async () => {
  const pid = _activeProjectId();
  const ents = (trGetEntriesForProject(pid) || []).map(e => Object.assign({}, e));
  const catIds = [...new Set(ents.map(e => e.categoryId).filter(Boolean))];
  const cats = catIds.map(id => { try { return tcGetCategory(id, pid); } catch (e) { return { id, error: String(e) }; } });
  let summary = null;
  try {
    const dist = cats.find(c => c && c.template === 'disturbance') || cats.find(c => c && /disturb/i.test(c.name || ''));
    if (dist) {
      const de = ents.filter(e => e.categoryId === dist.id && !e.deletedAt);
      const r = glStateNetAreasM2(de, dist.states);
      summary = { category: dist.name, states: dist.states.map(s => ({ id: s.id, label: s.label, countMode: s.countMode, acres: +glAreaConvertM2(r.netM2[s.id] || 0, 'ac').toFixed(2) })), totalEverTouchedAc: +glAreaConvertM2(r.totalM2 || 0, 'ac').toFixed(2) };
    }
  } catch (e) { summary = { error: String(e) }; }
  const dump = { exportedAt: new Date().toISOString(), pid, uid: (window._currentUser || {}).uid || '', entryCount: ents.length, categories: cats, summary, entries: ents };
  const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'groundlog-tracker-dump-' + pid + '-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  console.log('dumped', ents.length, 'entries,', cats.length, 'categories; summary:', summary);
})();
```

The file lands in Downloads; the console line should match the current QI report's Condition-1 block.

## Run

```
node tests/analysis/open-area-series.mjs [out.json]
```

Reads the newest `groundlog-tracker-dump-*.json` in Downloads. Prints the validation table (signed
report total vs replay at each inspection date), the weekly open-acreage series by region, and
today's snapshot; writes the JSON the workbook builder consumes.

Category / state ids are Moraine's today (`DIST`, region category matched by name "region");
parameterize before pointing it at another project.
