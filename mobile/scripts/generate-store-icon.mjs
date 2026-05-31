// Generate the Google Play "high-res icon" (512x512, 32-bit PNG) for the store
// listing. This is a SEPARATE upload from the in-build launcher icon — Play
// Console asks for a 512x512 PNG in the Store listing → Graphics section.
//
// The artwork is pixel-consistent with the launcher icon (assets/icon.png):
// the amber chart-frame mark on the dark brand background (#0b0d10), same
// geometry as src/components/FinlynqLogo.tsx and generate-app-icons.mjs.
//
//   Run from pf-app/ (where `sharp` is installed):
//     node mobile/scripts/generate-store-icon.mjs
//
// Output:
//   mobile/store/store-icon-512.png   512² dark bg, full mark, opaque RGBA

import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const AMBER = "#f5a623";
const BG = "#0b0d10"; // darkColors.background (matches the redesign theme)
const SIZE = 512;
const FRACTION = 0.52; // matches assets/icon.png so the store icon == launcher icon

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "store");
mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "store-icon-512.png");

// The amber mark, scaled+centered to occupy `fraction` of an S×S canvas
// (artwork authored in a 22-unit box, identical to generate-app-icons.mjs).
const scale = (FRACTION * SIZE) / 22;
const offset = (SIZE * (1 - FRACTION)) / 2;
const mark = `<g transform="translate(${offset} ${offset}) scale(${scale})">
    <rect x="1" y="1" width="20" height="20" rx="2" fill="none" stroke="${AMBER}" stroke-width="1.5"/>
    <path d="M5 16 L5 9 L10 13 L10 6 L17 11" fill="none" stroke="${AMBER}" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square"/>
    <circle cx="17" cy="11" r="1.6" fill="${AMBER}"/>
  </g>`;

const svg = `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg"><rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>${mark}</svg>`;

await sharp(Buffer.from(svg))
  .ensureAlpha() // Play wants a 32-bit PNG; opaque pixels, alpha channel present
  .png()
  .toFile(out);

console.log(`Wrote ${out} (${SIZE}², 32-bit PNG, mark ${Math.round(FRACTION * 100)}%, bg ${BG})`);
