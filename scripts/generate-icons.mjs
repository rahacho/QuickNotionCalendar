#!/usr/bin/env node
/**
 * Generates every icon / splash asset the PWA needs into public/ (run: `npm run icons`).
 *
 * The mark is a minimal Notion-style glyph: a #191919 rounded calendar outline (two binder rings
 * and a header rule) holding a bold checkmark, on a white tile. Geometry lives on a 24-unit grid
 * (like lucide) so strokes land on whole pixels at the common sizes; tiny renditions (favicons,
 * iOS Settings at 29pt) use a heavier "small" cut so the strokes stay crisp instead of going grey.
 *
 * Outputs (all deterministic):
 *   favicon.svg            small cut, rounded tile (browser tabs, light + dark chrome)
 *   favicon-32.png         small cut, rounded tile
 *   apple-touch-icon.png   180×180, full-bleed square (iOS applies its own mask; must be opaque)
 *   pwa-192.png / pwa-512.png   rounded tile on transparent (manifest purpose "any")
 *   maskable-512.png       full-bleed, glyph inside the 80% safe zone (manifest purpose "maskable")
 *   badge-96.png           white glyph on transparent (Android notification badge, monochrome)
 *   splash/*.png           iOS apple-touch-startup-image, portrait, centered tile, one set per color
 *                          scheme: iphone-WxH.png on #191919 (dark) and iphone-WxH-light.png on #FFFFFF
 *                          (light; the tile gets a hairline ring). index.html picks one with
 *                          `prefers-color-scheme`, so a light-mode launch isn't a dark flash before
 *                          the white app (Notion's light --bg is #FFFFFF, dark --bg #191919).
 *   icon.svg               master artwork (full-bleed) for reference / store listings
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');

const INK = '#191919';
const PAPER = '#FFFFFF';
/** Launch-screen backgrounds = the app's --bg per theme (tokens.css), so launch → app is seamless. */
export const SPLASH_BG = { dark: '#191919', light: '#FFFFFF' };
/** Light splash: the white tile on a white screen keeps its shape with Notion's hairline (--border). */
const LIGHT_RING = { color: '#37352F', opacity: 0.16 };
export const SPLASH_SCHEMES = ['dark', 'light'];

/**
 * Glyph geometry on a 24×24 grid. `weight` scales the outline/check strokes for small renditions.
 * Bounding box (incl. strokes) ≈ x 2.6…21.4, y 2.1…21.4 → visually centred on (12, 11.75).
 */
function glyph({ ink = INK, outline = 1.9, check = 2.5 } = {}) {
  return [
    `<g fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">`,
    // Calendar body
    `<rect x="3.5" y="5" width="17" height="15.5" rx="3.2" stroke-width="${outline}"/>`,
    // Header rule
    `<path d="M3.5 9.6H20.5" stroke-width="${outline}"/>`,
    // Binder rings
    `<path d="M8.25 3V6.6M15.75 3V6.6" stroke-width="${outline}"/>`,
    // Bold checkmark
    `<path d="M8.6 14.75L11 17.1L15.6 12.5" stroke-width="${check}"/>`,
    `</g>`,
  ].join('');
}

const GLYPH_CENTER = { x: 12, y: 11.75 };
const GLYPH_EXTENT = 19.3; // max(width, height) of the glyph incl. strokes, in grid units

/**
 * Full SVG for an icon tile.
 * @param {object} o
 * @param {number} o.size        canvas size in px (viewBox is size×size)
 * @param {number} o.glyphRatio  glyph extent / canvas size
 * @param {number} [o.radius]    tile corner radius as a fraction of size (0 = full-bleed square)
 * @param {boolean} [o.small]    heavier strokes for ≤ 48px renditions
 * @param {string|null} [o.bg]   tile color (null = transparent)
 * @param {string} [o.ink]
 * @param {{color: string, opacity: number}|null} [o.ring]  hairline just inside the tile edge
 */
function iconSvg({ size, glyphRatio, radius = 0, small = false, bg = PAPER, ink = INK, ring = null }) {
  const scale = (size * glyphRatio) / GLYPH_EXTENT;
  const tx = size / 2 - GLYPH_CENTER.x * scale;
  const ty = size / 2 - GLYPH_CENTER.y * scale;
  const strokes = small ? { outline: 2.3, check: 2.9 } : { outline: 1.9, check: 2.5 };
  const tile =
    bg === null
      ? ''
      : radius > 0
        ? `<rect width="${size}" height="${size}" rx="${(size * radius).toFixed(2)}" fill="${bg}"/>`
        : `<rect width="${size}" height="${size}" fill="${bg}"/>`;
  const ringWidth = Math.max(1, size / 96);
  const ringSvg =
    ring === null
      ? ''
      : `<rect x="${ringWidth / 2}" y="${ringWidth / 2}" width="${size - ringWidth}" height="${size - ringWidth}" rx="${(size * radius - ringWidth / 2).toFixed(2)}" fill="none" stroke="${ring.color}" stroke-opacity="${ring.opacity}" stroke-width="${ringWidth}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    tile,
    ringSvg,
    `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(5)})">`,
    glyph({ ink, ...strokes }),
    `</g></svg>`,
  ].join('');
}

/**
 * Rasterises an SVG string (density keeps edges sharp before the resize). `opaque` flattens onto the
 * paper color and drops the alpha channel — iOS renders any alpha in a touch icon as black.
 */
async function png(svg, size, { opaque = false } = {}) {
  let img = sharp(Buffer.from(svg), { density: 384 }).resize(size, size, { fit: 'fill', kernel: 'lanczos3' });
  if (opaque) img = img.flatten({ background: PAPER }).removeAlpha();
  return img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer();
}

/** iOS corner radius of a home-screen tile (continuous corner approximated by a circle arc). */
const TILE_RADIUS = 0.2237;

/**
 * Current iPhones, portrait (CSS px × DPR = physical px). Shared sizes are listed once.
 * Covers iPhone SE 2/3, 11/XR, 11 Pro Max, 12/13 mini, 12–14, 12–13 Pro Max/14 Plus, 14 Pro–16,
 * 14 Pro Max–16 Plus, 16 Pro/17/17 Pro, Air, 16 Pro Max/17 Pro Max, 16e.
 */
export const SPLASH_SCREENS = [
  { w: 375, h: 667, dpr: 2, label: 'iPhone SE (2nd/3rd gen), 8' },
  { w: 414, h: 896, dpr: 2, label: 'iPhone 11, XR' },
  { w: 414, h: 896, dpr: 3, label: 'iPhone 11 Pro Max, XS Max' },
  { w: 375, h: 812, dpr: 3, label: 'iPhone 12 mini, 13 mini, 11 Pro, X, XS' },
  { w: 390, h: 844, dpr: 3, label: 'iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e' },
  { w: 428, h: 926, dpr: 3, label: 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus' },
  { w: 393, h: 852, dpr: 3, label: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { w: 430, h: 932, dpr: 3, label: 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus' },
  { w: 402, h: 874, dpr: 3, label: 'iPhone 16 Pro, 17, 17 Pro' },
  { w: 420, h: 912, dpr: 3, label: 'iPhone Air' },
  { w: 440, h: 956, dpr: 3, label: 'iPhone 16 Pro Max, 17 Pro Max' },
];

/** @param {'dark'|'light'} [scheme] */
export function splashFileName(s, scheme = 'dark') {
  return `splash/iphone-${s.w * s.dpr}x${s.h * s.dpr}${scheme === 'light' ? '-light' : ''}.png`;
}

/** @param {'dark'|'light'} [scheme] */
export function splashMedia(s, scheme = 'dark') {
  return `screen and (device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})`;
}

/** The `<link rel="apple-touch-startup-image">` block for index.html (`node scripts/generate-icons.mjs --links`). */
export function splashLinks() {
  return SPLASH_SCREENS.flatMap((s) => [
    `<!-- ${s.label} -->`,
    ...SPLASH_SCHEMES.map((scheme) => `<link rel="apple-touch-startup-image" media="${splashMedia(s, scheme)}" href="/${splashFileName(s, scheme)}" />`),
  ]).join('\n');
}

/** @param {'dark'|'light'} scheme */
async function splash(s, scheme) {
  const W = s.w * s.dpr;
  const H = s.h * s.dpr;
  // ~96pt tile, like a native launch mark; rendered at the device's pixel density.
  const tile = Math.round(96 * s.dpr);
  const ring = scheme === 'light' ? LIGHT_RING : null;
  const tilePng = await png(iconSvg({ size: tile, glyphRatio: 0.52, radius: TILE_RADIUS, ring }), tile);
  return sharp({ create: { width: W, height: H, channels: 3, background: SPLASH_BG[scheme] } })
    .composite([{ input: tilePng, left: Math.round((W - tile) / 2), top: Math.round((H - tile) / 2) }])
    .png({ compressionLevel: 9, palette: true, colors: 64 })
    .toBuffer();
}

async function main() {
  await mkdir(out, { recursive: true });
  await rm(join(out, 'splash'), { recursive: true, force: true });
  await mkdir(join(out, 'splash'), { recursive: true });

  const files = new Map();

  // Vector favicon: small cut on a rounded tile (reads on light and dark tab strips).
  const faviconSvg = iconSvg({ size: 64, glyphRatio: 0.7, radius: TILE_RADIUS, small: true });
  files.set('favicon.svg', Buffer.from(`${faviconSvg}\n`));
  files.set('favicon-32.png', await png(faviconSvg, 32));

  // Master artwork (full-bleed) for reference.
  const master = iconSvg({ size: 1024, glyphRatio: 0.52 });
  files.set('icon.svg', Buffer.from(`${master}\n`));

  // iOS home screen: opaque, full-bleed, iOS rounds it.
  files.set('apple-touch-icon.png', await png(iconSvg({ size: 180, glyphRatio: 0.54 }), 180, { opaque: true }));

  // Manifest "any": rounded tile on transparent (desktop docks/launchers show it as-is).
  files.set('pwa-192.png', await png(iconSvg({ size: 192, glyphRatio: 0.54, radius: TILE_RADIUS }), 192));
  files.set('pwa-512.png', await png(iconSvg({ size: 512, glyphRatio: 0.52, radius: TILE_RADIUS }), 512));

  // Manifest "maskable": full-bleed; glyph diagonal stays inside the 80% safe circle.
  files.set('maskable-512.png', await png(iconSvg({ size: 512, glyphRatio: 0.5 }), 512, { opaque: true }));

  // Android status-bar badge: monochrome white on transparent.
  files.set('badge-96.png', await png(iconSvg({ size: 96, glyphRatio: 0.84, bg: null, ink: PAPER, small: true }), 96));

  for (const s of SPLASH_SCREENS) {
    for (const scheme of SPLASH_SCHEMES) files.set(splashFileName(s, scheme), await splash(s, scheme));
  }

  for (const [name, buf] of files) {
    await writeFile(join(out, name), buf);
  }
  const total = [...files.values()].reduce((n, b) => n + b.length, 0);
  console.log(`icons: wrote ${files.size} files to public/ (${(total / 1024).toFixed(1)} KiB)`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly && process.argv.includes('--links')) {
  console.log(splashLinks());
} else if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
