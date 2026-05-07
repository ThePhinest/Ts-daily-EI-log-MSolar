// ═══════════════════════════════════════════
// FILE SAVE — unified web + iOS native (Capacitor)
// ═══════════════════════════════════════════
//
// Why this exists:
//   In iOS WKWebView, the classic <a download> trick is a no-op — the
//   synthetic click fires, no save dialog ever appears, the blob evaporates.
//   navigator.share with files is also unreliable in WKWebView for non-image
//   MIME types like DOCX. Without this helper, "Generate Report" looks like
//   it works but produces no file the user can find.
//
//   On native, we write the blob to Capacitor's Cache directory and open the
//   iOS share sheet via the Share plugin — the user picks Save to Files,
//   Mail, AirDrop, Messages, etc.
//
//   On web/PWA, we keep the existing navigator.share → <a download>
//   fallback chain, which works correctly in Mobile Safari + desktop browsers.
//
// Used by:
//   - src/report.js  (Generate Report → DOCX)
//   - src/daily-log.js (HTML log download)

import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// Blob → base64 string (no data: prefix). Filesystem.writeFile expects raw
// base64 when writing binary data without an encoding hint.
function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || '';
      // FileReader gives "data:<mime>;base64,<payload>" — strip prefix.
      const comma = String(result).indexOf(',');
      resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Web-only last-resort save. Anchor download trick — works in real browsers,
// no-ops in WKWebView (which is why we route past it on native).
function _fallbackDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Save a Blob as a file. Branches on Capacitor.isNativePlatform().
//   - native  → Filesystem.writeFile (Cache) → Share.share opens iOS sheet
//   - web/PWA → navigator.share files → fallbackDownload
// Returns nothing on success. Logs and re-throws on hard failures so callers
// can show a status. AbortError (user dismisses share sheet) is treated as
// success — a deliberate user action, not an error.
export async function saveFileNative(blob, filename, mimeType) {
  const isNative = !!(window.Capacitor
    && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());

  if (isNative) {
    const base64 = await _blobToBase64(blob);
    const result = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache
    });
    try {
      await Share.share({
        title: filename,
        files: [result.uri],
        dialogTitle: 'Save or send'
      });
    } catch (e) {
      // User dismissed share sheet — not a failure.
      if (e && (e.message === 'Share canceled' || /cancel/i.test(String(e.message || '')))) return;
      throw e;
    }
    return;
  }

  // Web path
  if (navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], filename, { type: mimeType });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user dismissed
      // any other error → fall through to anchor download
    }
  }
  _fallbackDownload(blob, filename);
}

// Expose on window so any legacy code path can use it without an import.
// Internal modules should still import { saveFileNative } directly.
window.saveFileNative = saveFileNative;
