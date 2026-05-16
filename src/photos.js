// ═══════════════════════════════════════════
// PHOTOS
// ═══════════════════════════════════════════
window._phPhotos = window._phPhotos || [];
var _phLbId = null;
var _phPageSize = 7;
var _phDaysShown = 7;

function phGenId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function phFmtDate(d){
  if(!d) return '';
  const p = d.split('-');
  if(p.length!==3) return d;
  return `${parseInt(p[1])}/${parseInt(p[2])}/${p[0].slice(2)}`;
}

function phDayLabel(d){
  if(!d) return '';
  const p = d.split('-');
  if(p.length!==3) return d;
  const dt = new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2]));
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${dt.getDate()}, ${p[0]}`;
}

// ── Parse Solocator filename for date/time ──
function phParseFilename(name){
  // Filename format: Description_text_YYYY-MM-DD_HH-MM-SS.jpeg
  const m = name.match(/^(.+?)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  if(m){
    const date = `${m[2]}-${m[3]}-${m[4]}`;
    // Convert description: underscores to spaces, capitalize first letter
    const raw = m[1].replace(/_/g,' ').trim();
    const caption = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    return { date, caption };
  }
  // No date pattern found — leave caption blank
  return { date: new Date().toLocaleDateString('en-CA'), caption: '' };
}

// ── Parse EXIF data from original file ──
async function phParseExif(file){
  const result = { lat:null, lng:null, direction:null, takenAt:null, software:null, exifCaption:null };
  try{
    if(typeof exifr === 'undefined') return result;
    const exif = await exifr.parse(file, {
      gps: true,
      tiff: true,
      exif: true,
      iptc: true,
      userComment: true
    });
    if(!exif) return result;

    // GPS
    if(exif.latitude)  result.lat = exif.latitude;
    if(exif.longitude) result.lng = exif.longitude;

    // Camera direction (compass bearing)
    if(exif.GPSImgDirection) result.direction = Math.round(exif.GPSImgDirection);

    // Timestamp
    if(exif.DateTimeOriginal) result.takenAt = exif.DateTimeOriginal.getTime
      ? exif.DateTimeOriginal.getTime()
      : Date.parse(exif.DateTimeOriginal);

    // Software tag (Solocator, etc.)
    if(exif.Software) result.software = exif.Software.trim();

    // Caption from Solocator UserComment — format: "PROJECT NAME: x DESCRIPTION: y WATERMARK: z"
    const uc = exif.UserComment || exif.ImageDescription || '';
    if(typeof uc === 'string' && uc.trim()){
      const descMatch = uc.match(/DESCRIPTION:\s*([^\n]+?)(?:\s*WATERMARK:|$)/i);
      const projMatch = uc.match(/PROJECT NAME:\s*([^\n]+?)(?:\s*DESCRIPTION:|$)/i);
      const desc = descMatch?.[1]?.trim();
      const proj = projMatch?.[1]?.trim();
      // Only use if not technical metadata (tilt/roll data)
      if(desc && !/tilt_angle|roll_angle/i.test(desc)) result.exifCaption = desc;
      else if(proj && !/tilt_angle|roll_angle/i.test(proj)) result.exifCaption = proj;
    }
    // Also check IPTC Caption-Abstract — but skip tilt/roll technical data
    if(!result.exifCaption && exif.Caption){
      const cap = exif.Caption.trim();
      if(!/tilt_angle|roll_angle/i.test(cap)) result.exifCaption = cap;
    }
  }catch(e){ console.warn('phParseExif failed:', e.message); }
  return result;
}

// ── Compass bearing to label ──
function phBearingLabel(deg){
  if(deg===null||deg===undefined) return '';
  const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg/22.5)%16];
}

// ── Compress image to base64 ──
function phCompress(file, maxW, maxH, quality){
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > maxW || h > maxH){
          const ratio = Math.min(maxW/w, maxH/h);
          w = Math.round(w*ratio); h = Math.round(h*ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Handle file upload ──
async function phHandleFiles(files){
  if(!files || files.length===0) return;
  const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
  if(arr.length===0) return;

  const prog = document.getElementById('ph-progress');
  const progBar = document.getElementById('ph-progress-bar');
  const progTxt = document.getElementById('ph-progress-txt');
  prog.style.display = 'block';

  for(let i=0; i<arr.length; i++){
    const file = arr[i];
    progTxt.textContent = `Uploading photo ${i+1} of ${arr.length}…`;
    progBar.style.width = `${Math.round(((i)/arr.length)*100)}%`;

    const { date, caption: filenameCaption } = phParseFilename(file.name);
    const id = phGenId();

    // Read EXIF BEFORE compression (compression strips metadata)
    const exif = await phParseExif(file);

    // Caption priority: EXIF description → EXIF project name → filename parse
    const caption = exif.exifCaption || filenameCaption || '';

    // Use EXIF date if available and more precise
    let photoDate = date;
    if(exif.takenAt){
      const d = new Date(exif.takenAt);
      if(!isNaN(d)) photoDate = d.toISOString().split('T')[0];
    }

    // Thumbnail only for in-app display
    const thumb = await phCompress(file, 140, 105, 0.7);

    // Upload original to Firebase Storage at full quality
    let storageUrl = '';
    try{
      const storageRef = storage.ref(`photos/${_currentUser.uid}/${id}/${file.name}`);
      const snapshot = await storageRef.put(file);
      storageUrl = await snapshot.ref.getDownloadURL();
    }catch(e){ console.warn('Storage upload failed:', e.message); }

    const entry = {
      id,
      date: photoDate,
      caption,
      filename: file.name,
      thumb,
      storageUrl,
      uploadedAt: Date.now(),
      projectId: _activeProjectId(),
      ...(exif.lat !== null && { lat: exif.lat, lng: exif.lng }),
      ...(exif.direction !== null && { direction: exif.direction }),
      ...(exif.takenAt && { takenAt: exif.takenAt }),
      ...(exif.software && { software: exif.software })
    };

    window._phPhotos.push(entry);
  }

  progBar.style.width = '100%';
  progTxt.textContent = `${arr.length} photo${arr.length>1?'s':''} uploaded successfully`;
  setTimeout(()=>{ prog.style.display='none'; progBar.style.width='0%'; }, 2500);

  document.getElementById('ph-file-input').value = '';

  phSave();
  phRender();
  mapRenderPhotoPins();
}

// ── Persistence ──
function phSaveLocal(){
  try{ localStorage.setItem('ph_photos', JSON.stringify(window._phPhotos)); }catch{}
}

function phLoadLocal(){
  try{
    const raw = localStorage.getItem('ph_photos');
    if(raw) window._phPhotos = JSON.parse(raw);
  }catch{ window._phPhotos = []; }
}

async function phSaveCloud(){
  if(!db || !_fbReady) return;
  try{
    const batch = db.batch();
    window._phPhotos.forEach(p => {
      const ref = _udb().collection('photos').doc(p.id);
      const doc = {
        id: p.id, date: p.date, caption: p.caption,
        filename: p.filename, thumb: p.thumb, uploadedAt: p.uploadedAt
      };
      if(p.storageUrl) doc.storageUrl = p.storageUrl;
      if(p.lat !== undefined){ doc.lat = p.lat; doc.lng = p.lng; }
      if(p.direction !== undefined) doc.direction = p.direction;
      if(p.takenAt) doc.takenAt = p.takenAt;
      if(p.software) doc.software = p.software;
      if(p.projectId) doc.projectId = p.projectId;
      batch.set(ref, doc);
    });
    await batch.commit();
  }catch(e){ console.warn('phSaveCloud failed:', e.message); }
}

async function phLoadCloud(){
  if(!db) return false;
  // Wait for Firebase to be ready (max 5 seconds)
  let waited = 0;
  while(!_fbReady && waited < 5000){
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
  }
  try{
    const snap = await _udb().collection('photos').get();
    if(!snap.empty){
      window._phPhotos = snap.docs.map(d => d.data());
      phSaveLocal();
      return true;
    }
  }catch(e){ console.warn('phLoadCloud failed:', e.message); }
  return false;
}

function phSave(){
  phSaveLocal();
  phSaveCloud();
}

// ── One-time recovery: re-fetch storageUrl for photos missing it ──
async function phRecoverStorageUrls(){
  if(!storage || !_udb()) return;
  const missing = window._phPhotos.filter(p => !p.storageUrl && p.filename);
  if(!missing.length) return;
  let fixed = 0;
  for(const p of missing){
    try{
      const url = await storage.ref(`photos/${_currentUser.uid}/${p.id}/${p.filename}`).getDownloadURL();
      p.storageUrl = url;
      fixed++;
    }catch(e){}
  }
  if(fixed > 0){
    phSave();
    console.log('phRecoverStorageUrls: recovered ' + fixed + ' photos');
  }
}

// ── Load full image for lightbox ──
async function phGetFull(id){
  const p = window._phPhotos.find(x=>x.id===id);
  if(p && p.storageUrl) return p.storageUrl;
  if(p && p.full) return p.full; // backwards compat for old entries
  return p ? p.thumb : '';
}

// ── Render library ──
function phRender(){
  const fromDate = document.getElementById('ph-filter-from')?.value||'';
  const toDate   = document.getElementById('ph-filter-to')?.value||'';

  let photos = [...window._phPhotos].sort((a,b)=> b.date > a.date ? 1 : b.date < a.date ? -1 : b.uploadedAt - a.uploadedAt);

  if(_projectFilterActive) photos = photos.filter(p => !p.projectId || p.projectId === _activeProjectId());
  if(fromDate) photos = photos.filter(p=>p.date >= fromDate);
  if(toDate)   photos = photos.filter(p=>p.date <= toDate);

  // Stats (all photos, not filtered)
  const allDates = [...new Set(window._phPhotos.map(p=>p.date))];
  const el = document.getElementById('ph-stat-total');
  const ed = document.getElementById('ph-stat-days');
  if(el) el.textContent = window._phPhotos.length;
  if(ed) ed.textContent = allDates.length;

  const lib = document.getElementById('ph-library');
  if(!lib) return;

  if(photos.length===0){
    lib.innerHTML = '<div class="ph-empty">'+(
      window._phPhotos.length===0
        ? 'No photos yet.<br>Tap <strong>+ Upload Photos</strong> or drag photos here.'
        : 'No photos match the current filters.'
    )+'</div>';
    document.getElementById('ph-load-more').style.display = 'none';
    return;
  }

  // Group by date, limit to _phDaysShown unique dates
  const grouped = {};
  photos.forEach(p=>{ if(!grouped[p.date]) grouped[p.date]=[]; grouped[p.date].push(p); });
  const sortedDates = Object.keys(grouped).sort((a,b)=>b>a?1:-1);

  const visibleDates = sortedDates.slice(0, _phDaysShown);
  const hasMore = sortedDates.length > _phDaysShown;

  lib.innerHTML = visibleDates.map(date => `
    <div class="ph-day-group">
      <div class="ph-day-label">${phDayLabel(date)} — ${grouped[date].length} photo${grouped[date].length>1?'s':''}</div>
      <div class="ph-grid">
        ${grouped[date].map(p=>`
          <div class="ph-thumb" onclick="phOpenLightbox('${p.id}')">
            <img src="${p.thumb}" alt="${p.caption||''}" loading="lazy">
            <div class="ph-thumb-caption">${p.caption||'Tap to add caption'}</div>
            <button class="ph-thumb-del" onclick="event.stopPropagation();phConfirmDelete('${p.id}')">✕</button>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  document.getElementById('ph-load-more').style.display = hasMore ? 'block' : 'none';
}

function phLoadMore(){
  _phDaysShown += _phPageSize;
  phRender();
}

function phClearFilters(){
  document.getElementById('ph-filter-from').value='';
  document.getElementById('ph-filter-to').value='';
  phRender();
}

// ── Lightbox ──
async function phOpenLightbox(id){
  _phLbId = id;
  const p = window._phPhotos.find(x=>x.id===id);
  if(!p) return;
  const lb = document.getElementById('ph-lightbox');
  const img = document.getElementById('ph-lb-img');
  const cap = document.getElementById('ph-lb-caption');
  const dat = document.getElementById('ph-lb-date');
  // Show thumb immediately while full loads
  img.src = p.thumb;
  cap.value = p.caption||'';
  dat.textContent = phDayLabel(p.date);
  lb.classList.remove('hidden');
  // Load full image async
  const full = await phGetFull(id);
  if(_phLbId === id) img.src = full; // only update if still viewing same photo
}

function phCloseLightbox(){
  document.getElementById('ph-lightbox').classList.add('hidden');
  _phLbId = null;
}

function phSaveCaption(){
  if(!_phLbId) return;
  const cap = document.getElementById('ph-lb-caption').value.trim();
  const p = window._phPhotos.find(x=>x.id===_phLbId);
  if(p){
    p.caption = cap;
    phSave();
    phRender();
  }
  phCloseLightbox();
}

// ── Delete with confirm ──
function phConfirmDelete(id){
  const p = window._phPhotos.find(x=>x.id===id);
  if(!p) return;
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box">' +
    '<div class="modal-title">⚠ Delete Photo?</div>' +
    '<div class="modal-msg">Delete the photo from <strong>' + phDayLabel(p.date) + '</strong>?<br><br>This cannot be undone.</div>' +
    '<div class="modal-btns">' +
      '<button class="modal-cancel" id="_phmc">Cancel</button>' +
      '<button class="modal-confirm" id="_phmok">Delete</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  document.getElementById('_phmc').onclick = function(){ ov.remove(); };
  document.getElementById('_phmok').onclick = async function(){
    ov.remove();
    const p = window._phPhotos.find(x=>x.id===id);
    window._phPhotos = window._phPhotos.filter(x=>x.id!==id);
    phSaveLocal();
    if(db){
      try{
        await _udb().collection('photos').doc(id).delete();
      }catch(e){ console.warn('phDelete Firestore failed:', e.message); }
    }
    if(p && p.storageUrl && storage){
      try{
        await storage.refFromURL(p.storageUrl).delete();
      }catch(e){ console.warn('phDelete Storage failed:', e.message); }
    }
    phRender();
  };
}

// ── Close lightbox on backdrop tap ──
document.getElementById('ph-lightbox')?.addEventListener('click', function(e){
  if(e.target===this) phCloseLightbox();
});

// ── Phase D migration: tag existing photos with active projectId ──
async function _glMigratePhaseD() {
  if (localStorage.getItem('gl_phaseD_photos_migrated')) return;
  if (!_fbReady) return;
  const pid = _activeProjectId();
  if (!pid || pid === 'default') return;
  let changed = false;
  window._phPhotos.forEach(p => { if (!p.projectId) { p.projectId = pid; changed = true; } });
  if (changed) {
    phSaveLocal();
    await phSaveCloud();
  }
  localStorage.setItem('gl_phaseD_photos_migrated', '1');
}

// ── Init ──
async function phInit(){
  phLoadLocal();
  phRender();
  const fromCloud = await phLoadCloud();
  phRender();
  phRecoverStorageUrls();
  _glMigratePhaseD();
}

// ── Reset day window and re-render (called from showPage) ──
function phResetAndRender(){ _phDaysShown = 7; phRender(); }

// ── Expose to window for HTML onclick handlers and cross-module calls ──
window.phInit = phInit;
window.phResetAndRender = phResetAndRender;
window.phHandleFiles = phHandleFiles;
window.phRender = phRender;
window.phSaveLocal = phSaveLocal;
window.phLoadMore = phLoadMore;
window.phClearFilters = phClearFilters;
window.phOpenLightbox = phOpenLightbox;
window.phCloseLightbox = phCloseLightbox;
window.phSaveCaption = phSaveCaption;
window.phConfirmDelete = phConfirmDelete;
window.phBearingLabel = phBearingLabel;
