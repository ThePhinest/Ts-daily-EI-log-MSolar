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
const SPLASH_BG = { r: 0x00, g: 0x00, b: 0x00, alpha: 1 }; // Pure black per Tim 2026-05-07
                                                            // (was navy #0F1F2E — read poorly on iPhone:
                                                            // the icon master's near-black bg created a
                                                            // visible square outline against navy. Even with
                                                            // chroma-key applied below, the OLED-friendly
                                                            // black is the visual identity Tim wants for the
                                                            // splash specifically. App chrome stays navy.)
const LOGO_WIDTH_RATIO = 0.45;                              // 45% of canvas width
                                                            // (50% felt slightly oversized on iPhone per Tim 2026-05-07)

// Icon master's background color — sampled from corner pixels of assets/icon.png.
// The chroma-key step below uses color-distance from THIS color to derive alpha.
const ICON_BG_R = 21, ICON_BG_G = 21, ICON_BG_B = 20;

// Color-distance over which alpha ramps from 0 -> 255. 60 gives a soft 1-2px
// edge on the boot strokes; tighter values (e.g. 20) give harder cutoffs
// (visible aliasing); wider values (e.g. 120) bleed too much logo content
// into transparency.
const ALPHA_SOFT_RANGE = 60;

const targetLogoW = Math.round(CANVAS * LOGO_WIDTH_RATIO);

async function build() {
  // Step 1: read icon as raw RGB.
  const { data, info } = await sharp(ICON).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;

  // Step 2: chroma-key — build an RGBA buffer where alpha is derived from
  // color-distance to the icon's near-black background. Pixels matching the
  // bg exactly become alpha=0; pixels far from bg (the amber boot strokes)
  // become alpha=255. Soft gradient avoids hard cutoff artifacts on the
  // anti-aliased boot edges.
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const dr = r - ICON_BG_R, dg = g - ICON_BG_G, db = b - ICON_BG_B;
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    rgba[j]     = r;
    rgba[j + 1] = g;
    rgba[j + 2] = b;
    rgba[j + 3] = Math.min(255, Math.max(0, Math.round(dist * 255 / ALPHA_SOFT_RANGE)));
  }

  // Step 3: compute the bbox of visible (non-transparent) pixels so we can
  // crop tight to the logo before resizing. Without this, the resize would
  // shrink the entire 1254×1254 (mostly empty) image into targetLogoW, making
  // the actual boot way smaller than intended.
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 32) { // visible-enough threshold
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;

  // Step 4: extract the logo bbox and resize to target width.
  const resizedLogo = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: bboxW, height: bboxH })
    .resize({ width: targetLogoW, fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
    .png()
    .toBuffer();

  // Step 5: composite the transparent-bg logo onto the navy canvas. Because
  // the logo is now alpha-keyed (no near-black bg to fight the navy), the
  // boot strokes float cleanly on the navy — the visible dark-square outline
  // that existed at any logo size is now gone.
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
