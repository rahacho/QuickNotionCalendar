/**
 * iOS launch screens (review D7): every iPhone size has a dark AND a light splash, index.html picks
 * them by `prefers-color-scheme`, and each file has the right pixel size and the app's background
 * for that scheme (so launch → app never flashes the wrong theme).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { SPLASH_BG, SPLASH_SCHEMES, SPLASH_SCREENS, splashFileName, splashMedia } from './generate-icons.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** All `<link rel="apple-touch-startup-image">` tags in index.html → { media, href }. */
const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g)].map((m) => ({
  media: m[1],
  href: m[2],
}));

const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

describe('iOS splash screens', () => {
  it('index.html links exactly one dark and one light splash per screen', () => {
    const expected = SPLASH_SCREENS.flatMap((s) => SPLASH_SCHEMES.map((scheme) => ({ media: splashMedia(s, scheme), href: `/${splashFileName(s, scheme)}` })));
    expect(links).toEqual(expected);
    for (const l of links) expect(l.media).toMatch(/and \(prefers-color-scheme: (light|dark)\)$/);
  });

  it.each(SPLASH_SCREENS.flatMap((s) => SPLASH_SCHEMES.map((scheme) => [splashFileName(s, scheme), s, scheme])))(
    '%s has the device size and the %s… background',
    async (file, s, scheme) => {
      const img = sharp(join(root, 'public', file));
      const meta = await img.metadata();
      expect([meta.width, meta.height]).toEqual([s.w * s.dpr, s.h * s.dpr]);
      const { data, info } = await img.extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      expect(hex([...data.subarray(0, Math.min(3, info.channels))])).toBe(SPLASH_BG[scheme].toUpperCase());
    },
  );
});
