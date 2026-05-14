// ═══════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════
const PROJECT_CONFIG_DEFAULTS = {
  projectName: 'New Project',
  preparedBy:  '',
  org:         '',
  activePhase: '',
  contractor:  '',
  location:    '',
  reviewedBy:  ''
};

function loadProjectConfig() {
  try {
    const saved = localStorage.getItem('msf_projectconfig');
    return saved ? Object.assign({}, PROJECT_CONFIG_DEFAULTS, JSON.parse(saved)) : PROJECT_CONFIG_DEFAULTS;
  } catch { return PROJECT_CONFIG_DEFAULTS; }
}
function _activeProjectId() {
  return localStorage.getItem('gl_active_project_id') || 'default';
}
function knownProjectsGet(){try{return JSON.parse(localStorage.getItem('gl_known_projects')||'[]');}catch{return[];}}
function knownProjectsUpsert(cfg, projectId){
  const list=knownProjectsGet();
  const idx=list.findIndex(p=>p.projectId ? p.projectId===(projectId||null) : p.projectName===cfg.projectName);
  const entry={projectId:projectId||null,projectName:cfg.projectName,preparedBy:cfg.preparedBy,org:cfg.org,activePhase:cfg.activePhase,contractor:cfg.contractor,location:cfg.location,reviewedBy:cfg.reviewedBy,lastUsed:Date.now()};
  if(idx>=0) list[idx]=entry; else list.push(entry);
  localStorage.setItem('gl_known_projects',JSON.stringify(list));
  // Mirror to Firestore so all devices share the project list
  if(typeof db!=='undefined'&&db&&_fbReady){
    _udb().collection('settings').doc('knownProjects').set({projects:list,_ts:Date.now()}).catch(()=>{});
  }
}
function renderKnownProjectsDatalist(){
  const dl=document.getElementById('known-projects-list');
  if(!dl) return;
  dl.innerHTML='';
  knownProjectsGet().forEach(p=>{const o=document.createElement('option');o.value=p.projectName;dl.appendChild(o);});
}
function onProjectNameInput(val){
  const match=knownProjectsGet().find(p=>p.projectName===val);
  if(!match) return;
  ['preparedBy','org','activePhase','contractor','location','reviewedBy'].forEach(k=>{
    const el=document.getElementById('cfg-'+k);
    if(el) el.value=match[k]||'';
  });
}
async function syncPresetsFromCloud() {
  if(!db) return;
  let waited=0;
  while(!_fbReady && waited<5000){ await new Promise(r=>setTimeout(r,200)); waited+=200; }
  if(!_fbReady) return;
  try{
    // Phase C: read from project doc first
    const pid = _activeProjectId();
    if(pid && pid!=='active' && pid!=='default'){
      const projDoc = await _udb().collection('settings').doc(pid).get();
      if(projDoc.exists && projDoc.data().phaseC_migrated){
        const d = projDoc.data();
        if(d.presets){window.presets=d.presets;ss('msf_presets',window.presets);renderPresetList();renderAllChips();}
        if(d.phases){window.phases=d.phases;ss('msf_phases',window.phases);renderPhaseList();populateSelects();}
        if(d.cardTitles&&Object.keys(d.cardTitles).length){
          loadCardTitles(d.cardTitles);
          try{localStorage.setItem('gl_cardTitles',JSON.stringify(d.cardTitles));}catch{}
        }
        if(d.tsConfig){
          const cfg=Object.assign({},TS_DEFAULTS,d.tsConfig);
          try{localStorage.setItem('msf_ts_config',JSON.stringify(cfg));}catch{}
          tsLoadConfigFields();
        }
        return;
      }
    }
    // Fallback: global paths (pre-Phase C or migration not yet run on this device)
    const [presetsDoc, phasesDoc, cardTitlesDoc] = await Promise.all([
      _udb().collection('settings').doc('presets').get(),
      _udb().collection('settings').doc('phases').get(),
      _udb().collection('settings').doc('cardTitles').get()
    ]);
    if(presetsDoc.exists){
      try{const p=JSON.parse(presetsDoc.data().data);window.presets=p;ss('msf_presets',p);renderPresetList();renderAllChips();}catch{}
    }
    if(phasesDoc.exists){
      try{const p=JSON.parse(phasesDoc.data().data);window.phases=p;ss('msf_phases',p);renderPhaseList();populateSelects();}catch{}
    }
    if(cardTitlesDoc.exists){
      const d=cardTitlesDoc.data();loadCardTitles(d);
      try{localStorage.setItem('gl_cardTitles',JSON.stringify(d));}catch{}
    }
  }catch(e){ console.warn('syncPresets failed:', e.message); }
}
async function syncProjectConfigFromCloud() {
  if(!db) return;
  let waited=0;
  while(!_fbReady && waited<5000){ await new Promise(r=>setTimeout(r,200)); waited+=200; }
  if(!_fbReady) return;
  try {
    // Read per-project doc first; fall back to global projectConfig for legacy/first-run
    const pid = _activeProjectId();
    let doc;
    if (pid && pid !== 'active' && pid !== 'default') {
      doc = await _udb().collection('settings').doc(pid).get();
    }
    if (!doc || !doc.exists) {
      doc = await _udb().collection('settings').doc('projectConfig').get();
    }
    if(doc && doc.exists) {
      const raw = doc.data();
      const data = {
        projectName: raw.projectName || '',
        preparedBy:  raw.preparedBy  || '',
        org:         raw.org         || '',
        activePhase: raw.activePhase || '',
        contractor:  raw.contractor  || '',
        location:    raw.location    || '',
        reviewedBy:  raw.reviewedBy  || ''
      };
      localStorage.setItem('msf_projectconfig', JSON.stringify(data));
        applyProjectConfig();
        ['projectName','preparedBy','org','activePhase','contractor','location','reviewedBy'].forEach(k=>{
          const el=document.getElementById('cfg-'+k);
          if(el) el.value=data[k]||'';
        });
        const apInput=document.getElementById('activePhaseInput');
        if(apInput && data.activePhase) apInput.value=data.activePhase;
        window.activePhaseLabel=data.activePhase||activePhaseLabel;
        ss('msf_activephase',activePhaseLabel);
        renderPhaseList();
        renderAllChips();
    }
  } catch(e) { console.warn('syncProjectConfig failed:', e.message); }
}

function applyProjectConfig() {
  const cfg = loadProjectConfig();
  document.getElementById('projectName').value  = cfg.projectName;
  document.getElementById('preparedBy').value   = cfg.preparedBy;
  document.getElementById('org').value          = cfg.org;
  document.getElementById('activePhase').value  = cfg.activePhase;
  // Contractor: only apply default if field is currently empty (per-day override preserved)
  const contractorEl = document.getElementById('contractor');
  if(contractorEl && contractorEl.value.trim()==='') contractorEl.value = cfg.contractor;
  document.getElementById('location').value     = cfg.location;
  document.getElementById('reviewedBy').value   = cfg.reviewedBy;
  // Update app bar subtitle dynamically from project name
  const sub = document.getElementById('app-bar-sub');
  if (sub && cfg.projectName) sub.textContent = cfg.projectName;
  // Populate config fields
  ['projectName','preparedBy','org','activePhase','contractor','location','reviewedBy'].forEach(k => {
    const el = document.getElementById('cfg-' + k);
    if (el) el.value = cfg[k];
 });
  if (typeof initCardTitles === 'function') initCardTitles();
}

function saveProjectConfig() {
  const oldCfg = loadProjectConfig();
  const cfg = {
    projectName: document.getElementById('cfg-projectName').value.trim() || PROJECT_CONFIG_DEFAULTS.projectName,
    preparedBy:  document.getElementById('cfg-preparedBy').value.trim()  || PROJECT_CONFIG_DEFAULTS.preparedBy,
    org:         document.getElementById('cfg-org').value.trim()         || PROJECT_CONFIG_DEFAULTS.org,
    activePhase: document.getElementById('cfg-activePhase').value.trim() || PROJECT_CONFIG_DEFAULTS.activePhase,
    contractor:  document.getElementById('cfg-contractor').value.trim()  || PROJECT_CONFIG_DEFAULTS.contractor,
    location:    document.getElementById('cfg-location').value.trim()    || PROJECT_CONFIG_DEFAULTS.location,
    reviewedBy:  document.getElementById('cfg-reviewedBy').value.trim()  || PROJECT_CONFIG_DEFAULTS.reviewedBy
  };
  if(cfg.projectName !== oldCfg.projectName){
    // Tag all untagged timesheet entries with the old project name before switching
    const entries=tsGetAllEntries();
    let eChanged=false;
    const taggedDs=[];Object.keys(entries).forEach(ds=>{if(!entries[ds].projectName){entries[ds].projectName=oldCfg.projectName;eChanged=true;taggedDs.push(ds);}});
    if(eChanged){localStorage.setItem('msf_ts_entries',JSON.stringify(entries));if(typeof db!=='undefined'&&db&&_fbReady){taggedDs.forEach(ds=>_udb().collection('timesheetEntries').doc(ds).set(entries[ds]).catch(()=>{}));}}

    // Tag all untagged archived weeks with the old project name
    const allWeeks=tsGetAllArchivedWeeks();
    let wChanged=false;
    allWeeks.forEach(w=>{if(!w.projectName){w.projectName=oldCfg.projectName;wChanged=true;}});
    if(wChanged) tsSaveArchivedWeeks(allWeeks);
  }
  localStorage.setItem('msf_projectconfig', JSON.stringify(cfg));
  const _pid = _activeProjectId();
  try{if(typeof db!=='undefined'&&db&&_fbReady){
    _udb().collection('settings').doc('projectConfig').set(Object.assign({},cfg,{_ts:Date.now()}),{merge:true}).catch(()=>{});
    if (_pid !== 'active') _udb().collection('settings').doc(_pid).set(Object.assign({},cfg,{lastUsed:Date.now(),_ts:Date.now()}),{merge:true}).catch(()=>{});
  }}catch(e){}
  knownProjectsUpsert(cfg, _pid);
  renderKnownProjectsDatalist();
  applyProjectConfig();
  // Also update activePhaseLabel for chip rendering
  window.activePhaseLabel = cfg.activePhase;
  document.getElementById('activePhase').value = cfg.activePhase;
  renderAllChips();
  const st = document.getElementById('cfg-proj-status');
  st.textContent = '✓ Saved'; st.style.opacity = '1';
  setTimeout(() => st.style.opacity = '0', 2500);
}

// ── One-time migration: convert single-project structure → multi-project ──
// Project configs stored in settings/{projectId} docs (uses existing allowed collection).
async function _glMigrateToProjects() {
  const _existingPid = localStorage.getItem('gl_active_project_id');
  if (_existingPid && _existingPid !== 'active') return; // real proj_ ID = already migrated
  if (!_udb()) { console.warn('GroundLog: migration skipped — user not ready'); return; }
  console.log('GroundLog: starting multi-project migration...');
  try {
    // Pull active config from user-scoped Firestore path
    const cfgDoc = await _udb().collection('settings').doc('projectConfig').get();
    const activeCfg = cfgDoc.exists ? Object.assign({}, cfgDoc.data()) : loadProjectConfig();
    delete activeCfg._ts;
    console.log('GroundLog: active project config found:', activeCfg.projectName);

    // Pull full known-projects list from Firestore (cross-device, includes both projects)
    let known = knownProjectsGet();
    try {
      const knownDoc = await _udb().collection('settings').doc('knownProjects').get();
      if (knownDoc.exists && (knownDoc.data().projects || []).length > known.length) {
        known = knownDoc.data().projects;
        console.log('GroundLog: loaded', known.length, 'known projects from Firestore');
      }
    } catch(e) {}

    // Ensure active project is in the list
    if (!known.some(p => p.projectName === activeCfg.projectName)) known.push(activeCfg);
    console.log('GroundLog: migrating', known.length, 'projects:', known.map(p => p.projectName).join(', '));

    const projectIndex = [];
    let activeProjectId = null;
    const now = Date.now();

    for (let i = 0; i < known.length; i++) {
      const p = known[i];
      const isActive = (p.projectName === activeCfg.projectName);
      const projectId = 'proj_' + (now + i);
      const projDoc = {
        projectName: p.projectName || '',
        preparedBy:  p.preparedBy  || '',
        org:         p.org         || '',
        activePhase: p.activePhase || '',
        contractor:  p.contractor  || '',
        location:    p.location    || '',
        reviewedBy:  p.reviewedBy  || '',
        createdAt:   now,
        lastUsed:    isActive ? now : 0,
        _ts:         now
      };
      // Use _udb() — all app data lives under users/{uid}/
      await _udb().collection('settings').doc(projectId).set(projDoc);
      console.log('GroundLog: created project doc', projectId, 'for', p.projectName);
      if (isActive) activeProjectId = projectId;
      projectIndex.push({ projectId, projectName: p.projectName, location: p.location || '', lastUsed: projDoc.lastUsed });
    }

    // Migrate current session: sessions/active → sessions/{activeProjectId}
    const sessionDoc = await _udb().collection('sessions').doc('active').get();
    if (sessionDoc.exists) {
      await _udb().collection('sessions').doc(activeProjectId).set(sessionDoc.data());
      console.log('GroundLog: migrated session to', activeProjectId);
    }

    // Write project tracking docs
    await _udb().collection('settings').doc('activeProject').set({ projectId: activeProjectId, _ts: now });
    await _udb().collection('settings').doc('knownProjects').set({ projects: projectIndex, _ts: now });

    localStorage.setItem('gl_active_project_id', activeProjectId);
    localStorage.setItem('gl_known_projects', JSON.stringify(projectIndex));
    console.log('GroundLog: migration complete. Active:', activeProjectId, '| Projects:', projectIndex.length);
  } catch(e) {
    console.warn('GroundLog: project migration failed —', e.message, e);
    // Do NOT set gl_active_project_id — initFirebaseLoad sessions/active fallback handles it
  }
}

// ── Phase C migration: copy global settings into all per-project docs ──
async function _glMigratePhaseC() {
  if (!_udb()) return;
  const known = knownProjectsGet().filter(p => p.projectId);
  if (!known.length) return;
  // Early-out if every project is already migrated
  let anyNeedsMigration = false;
  for (const proj of known) {
    try {
      const d = await _udb().collection('settings').doc(proj.projectId).get();
      if (!d.exists || !d.data().phaseC_migrated) { anyNeedsMigration = true; break; }
    } catch(e) {}
  }
  if (!anyNeedsMigration) return;
  console.log('GroundLog Phase C: starting settings migration...');
  try {
    const [presetsDoc, phasesDoc, cardTitlesDoc, checklistDoc, flagsDoc, tsCfgDoc] = await Promise.all([
      _udb().collection('settings').doc('presets').get(),
      _udb().collection('settings').doc('phases').get(),
      _udb().collection('settings').doc('cardTitles').get(),
      _udb().collection('config').doc('checklist').get(),
      _udb().collection('config').doc('flags').get(),
      _udb().collection('timesheetMeta').doc('config').get()
    ]);
    let globalPresets = Object.assign({}, DEFAULT_PRESETS);
    try { if (presetsDoc.exists) globalPresets = JSON.parse(presetsDoc.data().data || '{}'); } catch {}
    let globalPhases = [...DEFAULT_PHASES];
    try { if (phasesDoc.exists) globalPhases = JSON.parse(phasesDoc.data().data || '[]'); } catch {}
    const globalCardTitles = cardTitlesDoc.exists ? cardTitlesDoc.data() : {};
    const globalChecklist  = checklistDoc.exists  ? checklistDoc.data()  : {};
    const globalFlags      = flagsDoc.exists       ? flagsDoc.data()       : {};
    const rawTsCfg         = tsCfgDoc.exists       ? tsCfgDoc.data()       : {};
    delete rawTsCfg._ts;
    const globalTsConfig   = Object.assign({}, TS_DEFAULTS, rawTsCfg);
    for (const proj of known) {
      try {
        const doc = await _udb().collection('settings').doc(proj.projectId).get();
        if (doc.exists && doc.data().phaseC_migrated) continue;
        await _udb().collection('settings').doc(proj.projectId).set({
          checklistItems:  globalChecklist.items || DEFAULT_CHECKLIST_ITEMS,
          checklistTitle:  globalChecklist.title || 'Compliance Checklist',
          flagItems:       globalFlags.items     || DEFAULT_FLAG_ITEMS,
          flagsTitle:      globalFlags.title     || 'Regulatory & Incident Flags',
          presets:         globalPresets,
          phases:          globalPhases,
          cardTitles:      globalCardTitles,
          tsConfig:        globalTsConfig,
          phaseC_migrated: true,
          _ts:             Date.now()
        }, {merge: true});
        console.log('GroundLog Phase C: migrated', proj.projectName);
      } catch(e) { console.warn('GroundLog Phase C: failed for', proj.projectName, '—', e.message); }
    }
    console.log('GroundLog Phase C: migration complete.');
  } catch(e) { console.warn('GroundLog Phase C: migration error —', e.message); }
}


// ── Phase D: one-time migration — tag existing daily log archives with active projectId ──
async function _glMigrateDailyLogsPhaseD() {
  if (localStorage.getItem('gl_phaseD_logs_migrated')) return;
  if (!_fbReady) return;
  const pid = _activeProjectId();
  if (!pid || pid === 'default') return;
  const all = dlGetAll();
  const toUpdate = Object.entries(all).filter(([, v]) => !v.projectId);
  if (!toUpdate.length) { localStorage.setItem('gl_phaseD_logs_migrated', '1'); return; }
  toUpdate.forEach(([date, record]) => {
    record.projectId = pid;
    dlSaveLocal(date, record);
  });
  // Firestore: merge-write projectId onto each doc (fire-and-forget)
  toUpdate.forEach(([date]) => {
    try { _udb().collection('dailyLogs').doc(date).set({ projectId: pid }, { merge: true }).catch(() => {}); } catch(e) {}
  });
  localStorage.setItem('gl_phaseD_logs_migrated', '1');
}

// ── Phase D fix: re-tag pre-2026-04-23 daily logs as Moraine Solar Energy Center ──
async function _fixDailyLogProjectsByDate() {
  if (localStorage.getItem('gl_phaseD_logs_date_fixed')) return;
  if (!_fbReady) return;
  const known = knownProjectsGet();
  const morainePid = (known.find(p => /moraine/i.test(p.projectName || '')) || {}).projectId;
  if (!morainePid) return;
  const cutoff = '2026-04-23';
  const all = dlGetAll();
  const toUpdate = [];
  Object.entries(all).forEach(([date, record]) => {
    if (date < cutoff) {
      record.projectId = morainePid;
      dlSaveLocal(date, record);
      toUpdate.push(date);
    }
  });
  toUpdate.forEach(date => {
    try { _udb().collection('dailyLogs').doc(date).set({ projectId: morainePid }, { merge: true }).catch(() => {}); } catch(e) {}
  });
  localStorage.setItem('gl_phaseD_logs_date_fixed', '1');
}

async function _fixOrphanLogProjectIds() {
  if (localStorage.getItem('gl_orphan_ids_fixed')) return;
  if (!_fbReady) return;
  const orphanIds = ['proj_1777250627510', 'proj_1777250627511'];
  const known = knownProjectsGet();
  const srw = known.find(p => p.projectId && !/moraine/i.test(p.projectName || ''));
  if (!srw) return;
  const srwPid = srw.projectId;
  const all = dlGetAll();
  const toUpdate = [];
  Object.entries(all).forEach(([date, record]) => {
    if (record && orphanIds.includes(record.projectId)) {
      record.projectId = srwPid;
      dlSaveLocal(date, record);
      toUpdate.push(date);
    }
  });
  toUpdate.forEach(date => {
    try { _udb().collection('dailyLogs').doc(date).set({ projectId: srwPid }, { merge: true }).catch(() => {}); } catch(e) {}
  });
  if (toUpdate.length > 0) console.log('GroundLog: retagged', toUpdate.length, 'orphan logs →', srwPid, toUpdate);
  localStorage.setItem('gl_orphan_ids_fixed', '1');
}

function _fixTimesheetEntryProjects() {
  if (localStorage.getItem('gl_ts_proj_fixed')) return;
  const known = knownProjectsGet();
  const moraineNm = (known.find(p => /moraine/i.test(p.projectName || '')) || {}).projectName || '';
  const srw = known.find(p => p.projectId && !/moraine/i.test(p.projectName || ''));
  const srwNm = srw ? srw.projectName : '';
  if (!moraineNm || !srwNm) return;
  const cutoff = '2026-04-23';
  const entries = tsGetAllEntries();
  let changed = false;
  Object.entries(entries).forEach(([date, e]) => {
    if (!e.projectName) {
      e.projectName = date < cutoff ? moraineNm : srwNm;
      changed = true;
    }
  });
  if (changed) {
    localStorage.setItem('msf_ts_entries', JSON.stringify(entries));
    if (typeof db !== 'undefined' && db && _fbReady) {
      Object.entries(entries).forEach(([date, e]) => {
        try { _udb().collection('timesheetEntries').doc(date).set(e).catch(() => {}); } catch(err) {}
      });
    }
  }
  localStorage.setItem('gl_ts_proj_fixed', '1');
}

// ── Phase C: merge any data into the active project's settings doc ──
function _saveProjectSettings(mergeData) {
  const pid = _activeProjectId();
  if (!pid || pid === 'active' || !db || !_fbReady) return;
  _udb().collection('settings').doc(pid).set(
    Object.assign({}, mergeData, {_ts: Date.now()}),
    {merge: true}
  ).catch(() => {});
}

// ── Phase C: apply all project-scoped settings from a loaded project doc ──
function _applyProjectSettings(data) {
  if (!data) return;
  if (data.checklistItems) {
    window.checklistItems = data.checklistItems;
    window.checklistTitle = data.checklistTitle || 'Compliance Checklist';
    saveChecklistLocal(); buildChecklist(); renderChecklistList();
  }
  if (data.flagItems) {
    window.flagItems = data.flagItems;
    window.flagsTitle = data.flagsTitle || 'Regulatory & Incident Flags';
    saveFlagsLocal(); buildFlags(); renderFlagsList();
  }
  if (data.presets) {
    window.presets = data.presets;
    ss('msf_presets', presets);
    renderPresetList(); renderAllChips();
  }
  if (data.phases) {
    window.phases = data.phases;
    ss('msf_phases', phases);
    renderPhaseList(); populateSelects();
  }
  if (data.cardTitles && Object.keys(data.cardTitles).length) {
    loadCardTitles(data.cardTitles);
    try { localStorage.setItem('gl_cardTitles', JSON.stringify(data.cardTitles)); } catch {}
  }
  if (data.tsConfig) {
    const cfg = Object.assign({}, TS_DEFAULTS, data.tsConfig);
    // Per-project key (E1.1 Option C — Stage 3 primary path).
    const pid = _activeProjectId();
    try { localStorage.setItem('msf_proj_' + pid + '_ts_config', JSON.stringify(cfg)); } catch {}
    // Legacy global key kept in sync during 30-day overlap so any
    // unmigrated reader still sees the active project's config.
    try { localStorage.setItem('msf_ts_config', JSON.stringify(cfg)); } catch {}
    tsLoadConfigFields();
  }
  // Re-render timesheet surface if it's visible — entries are filtered by
  // projectId on read, so switching projects must trigger a refresh even
  // though localStorage entries didn't change. Cheap no-op if not visible.
  try {
    if (document.getElementById('page-timesheet')?.classList.contains('active')){
      if (typeof tsRenderCurrentWeek === 'function') tsRenderCurrentWeek();
      if (typeof tsRenderHistory === 'function') tsRenderHistory();
      if (typeof tsRenderCumulative === 'function') tsRenderCumulative();
    }
  } catch {}
}

// ── Sync known-projects list from Firestore → localStorage (cross-device) ──
async function _syncProjectListFromCloud() {
  if (!db || !_fbReady) return;
  try {
    const doc = await _udb().collection('settings').doc('knownProjects').get();
    if (!doc.exists) return;
    const remote = doc.data().projects || [];
    if (!remote.length) return;
    // Firestore is authoritative — replace local list to prevent orphan re-injection
    localStorage.setItem('gl_known_projects', JSON.stringify(remote));
  } catch(e) {}
}

// ── Load (switch to) an existing project ──
async function loadProject(projectId, projDataOverride) {
  if (!db || !_fbReady) return;
  try {
    await cloudSave(); // preserve current session before switching
    const projDoc = projDataOverride ? { data: () => projDataOverride, exists: true }
      : await _udb().collection('settings').doc(projectId).get();
    if (!projDoc.exists) return;
    const projData = projDoc.data ? projDoc.data() : projDataOverride;

    // Switch active project
    localStorage.setItem('gl_active_project_id', projectId);
    _udb().collection('settings').doc('activeProject').set({ projectId, _ts: Date.now() }).catch(() => {});

    // Apply project config
    const cfg = { projectName:projData.projectName||'', preparedBy:projData.preparedBy||'',
      org:projData.org||'', activePhase:projData.activePhase||'',
      contractor:projData.contractor||'', location:projData.location||'', reviewedBy:projData.reviewedBy||'' };
    localStorage.setItem('msf_projectconfig', JSON.stringify(cfg));
    applyProjectConfig();
    window.activePhaseLabel = cfg.activePhase || activePhaseLabel;
    ss('msf_activephase', activePhaseLabel);
    const _apInput = document.getElementById('activePhaseInput');
    if (_apInput) _apInput.value = activePhaseLabel;
    renderAllChips();

    // Apply project-scoped settings (Phase C) — must run before restoreFormState
    _applyProjectSettings(projData);

    // Update lastUsed
    _udb().collection('settings').doc(projectId).set({ lastUsed: Date.now() }, { merge: true }).catch(() => {});

    // Load this project's session
    const sessionDoc = await _udb().collection('sessions').doc(projectId).get();
    document.getElementById('crewContainer').innerHTML = '';
    window.crewIds = []; window.crewSeq = 0;
    if (sessionDoc.exists) {
      restoreFormState(sessionDoc.data());
      try { localStorage.setItem('msf_autosave', JSON.stringify(sessionDoc.data())); } catch {}
    } else {
      _resetFormCore();
      try { localStorage.removeItem('msf_autosave'); } catch {}
    }
    showCloudBanner('↳ Switched to ' + (projData.projectName || 'project'));
  } catch(e) { console.warn('loadProject failed:', e.message); }
}

// ── Create a brand-new project ──
async function createProject(name, location, contractor) {
  if (!name || !name.trim() || !db || !_fbReady) return;
  name = name.trim();
  const activeCfg = loadProjectConfig();
  const projectId = 'proj_' + Date.now();
  const projData = {
    projectName:     name,
    preparedBy:      activeCfg.preparedBy  || '',
    org:             activeCfg.org         || '',
    activePhase:     '',
    contractor:      (contractor || '').trim(),
    location:        (location   || '').trim(),
    reviewedBy:      activeCfg.reviewedBy  || '',
    createdAt:       Date.now(),
    lastUsed:        Date.now(),
    _ts:             Date.now(),
    checklistItems:  [...DEFAULT_CHECKLIST_ITEMS],
    checklistTitle:  'Compliance Checklist',
    flagItems:       [...DEFAULT_FLAG_ITEMS],
    flagsTitle:      'Regulatory & Incident Flags',
    presets:         Object.assign({}, DEFAULT_PRESETS),
    phases:          [...DEFAULT_PHASES],
    cardTitles:      {},
    tsConfig:        Object.assign({}, TS_DEFAULTS),
    phaseC_migrated: true
  };
  try {
    await _udb().collection('settings').doc(projectId).set(projData);
    knownProjectsUpsert(projData, projectId);
    await loadProject(projectId, projData);
    showPage('config');
    setTimeout(() => {
      const s = document.getElementById('cfg-proj');
      if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 350);
    showCloudBanner('↳ New project created — fill in your details in Settings.');
  } catch(e) { console.warn('createProject failed:', e.message); }
}

// ── Project Switcher Modal ──
function showProjectSwitcher() {
  if (document.getElementById('_proj-switcher')) return;
  const activeProjId = _activeProjectId();
  const known = knownProjectsGet();

  const ov = document.createElement('div');
  ov.className = 'proj-switcher-overlay';
  ov.id = '_proj-switcher';
  ov.onclick = function(e) { if (e.target === ov) ov.remove(); };

  function renderList() {
    const sorted = [...known].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    return sorted.map(p => {
      const isActive = p.projectId === activeProjId;
      const lastUsedStr = p.lastUsed ? _projRelativeDate(p.lastUsed) : '';
      return `<div class="proj-row${isActive?' active':''}" onclick="_projSwitcherSelect('${p.projectId}')">
        <div class="proj-dot${isActive?' active':''}"></div>
        <div class="proj-row-info">
          <div class="proj-row-name">${p.projectName||'Unnamed Project'}</div>
          <div class="proj-row-meta">${[p.location,lastUsedStr].filter(Boolean).join(' · ')}</div>
        </div>
      </div>`;
    }).join('');
  }

  function buildSheet(showForm) {
    return `<div class="proj-switcher-sheet">
      <div class="proj-switcher-header">
        <span class="proj-switcher-title">${showForm ? 'New Project' : 'Projects'}</span>
        <button class="proj-switcher-close" onclick="document.getElementById('_proj-switcher').remove()">✕</button>
      </div>
      ${showForm ? `
        <div class="proj-new-form">
          <div><label>Project Name *</label><input id="_pnf-name" type="text" placeholder="e.g. Sunrise Wind Phase 2" autofocus></div>
          <div><label>Location (optional)</label><input id="_pnf-loc" type="text" placeholder="e.g. Long Island, NY"></div>
          <div><label>Starting Contractor (optional)</label><input id="_pnf-con" type="text" placeholder="e.g. Jones Excavating"></div>
          <p class="proj-new-hint">Starts fresh — fill in remaining details in Settings after creating.</p>
          <div class="proj-new-actions">
            <button class="modal-cancel" onclick="_projSwitcherShowList()">Cancel</button>
            <button class="btn btn-amber" style="font-size:12px;padding:8px 18px" onclick="_projSwitcherCreate()">Create Project</button>
          </div>
        </div>
      ` : `
        ${renderList()}
        <hr class="proj-divider">
        <button class="proj-new-btn" onclick="_projSwitcherShowForm()">+ New Project</button>
      `}
    </div>`;
  }

  ov.innerHTML = buildSheet(false);
  document.body.appendChild(ov);

  window._projSwitcherShowForm = function() {
    ov.querySelector('.proj-switcher-sheet').outerHTML; // trigger reflow
    ov.innerHTML = buildSheet(true);
    setTimeout(() => { const n = document.getElementById('_pnf-name'); if(n) n.focus(); }, 50);
  };
  window._projSwitcherShowList = function() {
    ov.innerHTML = buildSheet(false);
  };
  window._projSwitcherSelect = async function(projectId) {
    if (projectId === activeProjId) { ov.remove(); return; }
    const proj = known.find(p => p.projectId === projectId);
    const name = proj ? proj.projectName : 'this project';
    _confirmModal('Switch to ' + name + '? Your current log will be saved.', async function() {
      ov.remove();
      await loadProject(projectId);
    }, 'Switch Project', 'Switch');
  };
  window._projSwitcherCreate = async function() {
    const name = (document.getElementById('_pnf-name')||{}).value || '';
    if (!name.trim()) {
      const el = document.getElementById('_pnf-name');
      if (el) { el.style.borderColor = 'var(--red)'; el.focus(); }
      return;
    }
    const loc = (document.getElementById('_pnf-loc')||{}).value || '';
    const con = (document.getElementById('_pnf-con')||{}).value || '';
    ov.remove();
    await createProject(name, loc, con);
  };
}

function _projRelativeDate(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return days + 'd ago';
  const d = new Date(ts);
  return (d.getMonth()+1) + '/' + d.getDate();
}

// ── Expose to window for HTML onclick handlers and cross-module calls ──
window._activeProjectId = _activeProjectId;
window.loadProjectConfig = loadProjectConfig;
window.knownProjectsGet = knownProjectsGet;
window.knownProjectsUpsert = knownProjectsUpsert;
window.renderKnownProjectsDatalist = renderKnownProjectsDatalist;
window.onProjectNameInput = onProjectNameInput;
window.syncPresetsFromCloud = syncPresetsFromCloud;
window.syncProjectConfigFromCloud = syncProjectConfigFromCloud;
window.applyProjectConfig = applyProjectConfig;
window.saveProjectConfig = saveProjectConfig;
window._glMigrateToProjects = _glMigrateToProjects;
window._glMigratePhaseC = _glMigratePhaseC;
window._glMigrateDailyLogsPhaseD = _glMigrateDailyLogsPhaseD;
window._fixDailyLogProjectsByDate = _fixDailyLogProjectsByDate;
window._fixOrphanLogProjectIds = _fixOrphanLogProjectIds;
window._fixTimesheetEntryProjects = _fixTimesheetEntryProjects;
window._saveProjectSettings = _saveProjectSettings;
window._applyProjectSettings = _applyProjectSettings;
window._syncProjectListFromCloud = _syncProjectListFromCloud;
window.loadProject = loadProject;
window.createProject = createProject;
window.showProjectSwitcher = showProjectSwitcher;

// Modules are deferred — run the boot-time project config apply here
// since the inline script's call runs before modules load
applyProjectConfig();
