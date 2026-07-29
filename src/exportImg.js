// ═══════════════════════════════════════════
// EXPORT IMAGE PREP — shared re-encode helper
// ═══════════════════════════════════════════
//
// Report exports (QI DOCX/PDF, daily-report DOCX) embed photos and map
// captures, but the stored originals are full resolution — map captures are
// lossless canvas PNGs at 1–2+ MB each — while the documents render them
// ~3 in wide. Embedding the raw bytes bloats every report ~10x. This caps
// the long edge and re-encodes to JPEG before the bytes reach docx/pdfmake.
// Full-quality originals always remain in Storage and the Photos ZIP export
// — report copies are display copies.

// blob → JPEG blob capped at maxPx on the long edge (never upscales).
// Already-small JPEGs pass through untouched; any failure returns the
// original blob so an export can never break on re-encode.
export async function exportImageBlob(blob, maxPx, quality){
  maxPx = maxPx || 1400; quality = quality || 0.82;
  let bmp = null;
  try{
    bmp = await createImageBitmap(blob);
    const long = Math.max(bmp.width, bmp.height);
    if(blob.type === 'image/jpeg' && long <= maxPx){ bmp.close && bmp.close(); return blob; }
    const sc = Math.min(1, maxPx / long);
    const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // JPEG has no alpha channel
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close(); bmp = null;
    const out = await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
    return (out && out.size < blob.size) ? out : blob;  // keep whichever is smaller
  }catch(e){
    try{ if(bmp && bmp.close) bmp.close(); }catch(_){ }
    return blob;
  }
}

// Map captures carry linework + legend text → gentler compression than photos.
export function exportImageParams(photoRec){
  const cap = photoRec && photoRec.type === 'map_capture';
  return cap ? {maxPx:1600, quality:0.88} : {maxPx:1400, quality:0.82};
}

// ── 🏷 Camera photos leave the app STAMPED (Tim 7/29: "every photo shows up
// stamped how the user sets it, everywhere, every time") ──
// The branded overlay renders from the photo's metadata record at export time,
// per the user's element toggles (gl_cam_stamp — adjustable on the Photos page).
// Stored originals stay clean (two-layer model); non-camera photos pass through
// untouched, and ANY stamp failure returns the clean original so no export can
// break on stamping. Call BEFORE exportImageBlob so the stamp renders at full
// resolution and downscales with the image. Lazy-imports the camera chunk only
// when a camera photo actually passes through an export.
let _camMod = null;
export async function stampIfCamera(photoRec, blob){
  if(!photoRec || photoRec.type !== 'camera' || !blob) return blob;
  try{
    if(!_camMod) _camMod = await import('./camera.js');
    const out = await _camMod.camStampBlob(photoRec, blob);
    return out || blob;
  }catch(e){
    console.warn('stampIfCamera failed (using clean original):', e);
    return blob;
  }
}
window.stampIfCamera = stampIfCamera;
