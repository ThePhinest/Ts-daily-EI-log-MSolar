import { registerPlugin } from '@capacitor/core';

// Native iOS PDF viewer. On web there is no native implementation, so calls
// reject — callers must branch on Capacitor.isNativePlatform() and only invoke
// present() on native (web keeps the pdf.js viewer). See src/docs.js.
//
// NOTE: kept at the package root (NOT dist/) because the app repo's root
// .gitignore ignores every `dist/` dir, which would drop this file from the repo.
const GroundLogPdf = registerPlugin('GroundLogPdf');

export { GroundLogPdf };
