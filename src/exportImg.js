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
