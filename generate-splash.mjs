// generate-splash.mjs
//
// Builds assets/splash.png and assets/splash-dark.png from assets/icon.png
// for use by `npx capacitor-assets generate --ios`.
//
// Why this exists:
//   - The icon master (assets/icon.png) is 1254×1254 with the brand mark
//     centered on a near-black canvas (RGB 21,21,20). It is the canonical
//     source for the iOS app icon.
//   - When @capacitor/assets composes a splash from icon.png alone, it uses
//     a default `logoSplashScale` of 0.2 (20% of canvas) — too small per
//     Tim 2026-05-07 ("that damn tiny splash page on app open").
//   - Just bumping logoSplashScale makes the existing icon (with its dark
//     bg) larger on the navy splash, amplifying the visible dark-square
//     outline around the logo.
//   - This script pre-trims the icon's dark border (sharp .trim()), then
//     composites the trimmed logo onto a 2732×2732 navy canvas at the
//     desired width (LOGO_WIDTH_RATIO). The splash PNGs are written to
//     assets/splash.png and assets/splash-dark.png, which @capacitor/assets
//     prefers over icon.png when present.
//
// Usage:
//   node generate-splash.mjs
//   npx capacitor-assets generate --ios --iconBackgroundColor "#0F1F2E" --splashBackgroundColor "#0F1F2E" --splashBackgroundColorDark "#0F1F2E"
//   npx cap sync ios
//
// Tweaks:
//   - LOGO_WIDTH_RATIO controls how wide the logo is relative to the canvas.
//     Apple HIG suggests roughly 25-45% of the shorter edge for splash logos.
//     0.50 is a confident, brand-prominent choice.
//   - SPLASH_BG is GroundLog navy; matches the rest of the app's brand bg.

import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, 'assets');
const ICON   = join(ASSETS, 'icon.png');
const OUT    = join(ASSETS, 'splash.png');
const OUT_DK = join(ASSETS, 'splash-dark.png');

const CANVAS = 2732;
const SPLASH_BG = { r: 0x0F, g: 0x1F, b: 0x2E, alpha: 1 }; // GroundLog navy
const LOGO_WIDTH_RATIO = 0.50;                              // 50% of canvas width

const targetLogoW = Math.round(CANVAS * LOGO_WIDTH_RATIO);

async function build() {
  // Step 1: trim the icon's near-black border so we get just the logo.
  // .trim() auto-detects content-vs-background by sampling corners.
  // Threshold of 30 covers the icon's RGB(21,21,20) corner color while
  // safely preserving any darker logo internals (the brand mark interior
  // is amber/teal, not near-black).
  const trimmedLogo = await sharp(ICON)
    .trim({ threshold: 30 })
    .toBuffer();

  // Step 2: resize trimmed logo so its WIDTH = targetLogoW.
  // Use { fit: 'contain' } and a transparent background so the logo's
  // own aspect ratio is preserved on the way to the navy canvas.
  const resizedLogo = await sharp(trimmedLogo)
    .resize({ width: targetLogoW, fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Step 3: composite the resized logo onto a 2732×2732 navy canvas.
  for (const out of [OUT, OUT_DK]) {
    await sharp({
      create: { width: CANVAS, height: CANVAS, channels: 4, background: SPLASH_BG }
    })
      .composite([{ input: resizedLogo, gravity: 'center' }])
      .png()
      .toFile(out);
    console.log('Wrote', out);
  }
}

build().catch(e => { console.error(e); process.exit(1); });
