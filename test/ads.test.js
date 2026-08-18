/* =========================================================================
   Ad creatives.

   The name is the URL and the URL is the KV key, so name validation is the
   whole security surface here: whatever passes ends up in a public path that
   Meta will fetch and in a key beside every other value in the namespace.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAdName, slugifyName, extensionFor, typeForExtension, adKey, adPath,
  AD_PREFIX, MAX_AD_BYTES
} from '../lib/ads.js';

test('a name is lower-case letters, digits and hyphens', () => {
  for (const good of ['vg-10off-ar-9x16', 'ad1', 'a-b-c', 'x'.repeat(64)]) {
    assert.equal(isAdName(good), true, good);
  }
});

test('anything that could climb out of the prefix is refused', () => {
  const bad = [
    '', 'a', 'UPPER', 'has space', 'has.dot', 'has/slash', '../escape',
    'trailing-', '-leading', 'unicode-é', 'x'.repeat(65), null, undefined
  ];
  for (const name of bad) {
    assert.equal(isAdName(name), false, JSON.stringify(name));
  }
});

test('the KV key and the public path are built from the same name', () => {
  assert.equal(adKey('vg-10off-ar-9x16'), `${AD_PREFIX}vg-10off-ar-9x16`);
  assert.equal(adPath('vg-10off-ar-9x16', 'png'), 'assets/ads/vg-10off-ar-9x16.png');
});

test('a filename a person chose becomes a usable name', () => {
  /* The admin picks "Ramadan Ad 9x16.PNG" from their desktop and expects the
     obvious thing rather than a validation error. */
  assert.equal(slugifyName('Ramadan Ad 9x16.PNG'), 'ramadan-ad-9x16');
  assert.equal(slugifyName('  vg 10off  ar '), 'vg-10off-ar');
  assert.equal(slugifyName('WhatsApp Image 2026-08-17 at 10.29.04 AM.jpeg'), 'whatsapp-image-2026-08-17-at-10-29-04-am');
});

test('slugifying never produces something that fails validation', () => {
  /* Everything the slugifier can emit has to be acceptable, or an upload
     fails after the file was read — the worst moment to find out. */
  for (const input of ['---', '!!!', 'a', 'Ad.png', '  ', 'ok name']) {
    const out = slugifyName(input);
    if (out) assert.equal(isAdName(out), true, `${input} -> ${out}`);
  }
});

test('an unusable slug is left empty rather than invented', () => {
  /* A generated name is a URL nobody can guess or remember, so the endpoint
     asks for one instead — and anything too short to be a valid name is the
     same answer as no name at all, decided BEFORE the file is read. */
  assert.equal(slugifyName('!!!'), '');
  assert.equal(slugifyName(''), '');
  assert.equal(slugifyName('a'), '', 'one character is not a name');
});

test('the extension comes from the content type, never the filename', () => {
  /* A filename is attacker-controlled text about to go in a URL. */
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('image/webp'), 'webp');
  assert.equal(extensionFor('IMAGE/PNG; charset=binary'), 'png');
  assert.equal(typeForExtension('jpg'), 'image/jpeg');
});

test('SVG is not an image here', () => {
  /* It is a document that can carry script, served from this origin next to
     a session cookie. Same rule as product images. */
  assert.equal(extensionFor('image/svg+xml'), '');
  assert.equal(typeForExtension('svg'), '');
});

test('the size cap leaves room for a real 1080x1920 export', () => {
  /* The creatives in the shipped pack are about 1.8 MB each; a cap that
     refused them would refuse the work this feature exists for. */
  assert.ok(MAX_AD_BYTES >= 4 * 1024 * 1024);
  assert.ok(MAX_AD_BYTES <= 25 * 1024 * 1024, 'and stays inside what KV takes');
});
