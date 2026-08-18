/* =========================================================================
   Pushing products into the Meta catalogue.

   Three things are being tested and they fail in different ways.

   THE PRICE. lib/metafeed.js decides which of the shop's two numbers is the
   selling price, and this file sends that decision to a live catalogue.
   Getting it backwards no longer merely publishes the purchase price in a
   spreadsheet somebody might read — it advertises it. Same assertion as
   test/export.test.js makes about the .xlsx, made again on the API path,
   because the whole point of catalogRow() is that the two agree.

   THE TOKEN. A Conversions API token cannot write a product. If
   catalogConfig ever fell back to it, the panel would report an OAuth error
   that reads like a broken integration instead of "you have not set this
   up".

   THE ENVELOPE. `warnings` is ours and must not travel inside the item;
   sale_price must travel even when blank, because blank is how a discount
   that ended gets cleared. Both are silent when wrong.

   No framework — node:test ships with Node. `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  catalogConfig, catalogStatus, productItem, buildBatches, chunk
} from '../lib/metacatalog.js';

const ORIGIN = 'https://visionguardeg.com';

const PRODUCT = {
  id: 'unv-2mp',
  cat: 'cameras',
  brand: 'Uniview',
  name: 'UNV 2MP Bullet',
  en: 'Two megapixel bullet camera',
  ar: 'كاميرا يونيفيو ٢ ميجا',
  img: 'assets/products/unv-2mp.jpg',
  price: 1200,
  was: 0,
  sort: 1,
  active: 1
};

/* -------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */
test('prefers the catalogue token over the insights one', () => {
  const c = catalogConfig({ META_CATALOG_TOKEN: 'cat-token', META_INSIGHTS_TOKEN: 'read-token' });
  assert.equal(c.token, 'cat-token');
});

test('borrows the insights token, because one System User token can carry both', () => {
  assert.equal(catalogConfig({ META_INSIGHTS_TOKEN: 'read-token' }).token, 'read-token');
});

test('never borrows the Conversions API token', () => {
  /* The distinction this pins: a CAPI token authenticates and then cannot
     write a product. Falling back to it would turn "not configured" into a
     permissions error, which is a much worse thing to read. */
  assert.equal(catalogConfig({ META_ACCESS_TOKEN: 'capi-token' }).token, '');
  assert.equal(catalogConfig({}).token, '');
  assert.equal(catalogConfig(undefined).token, '');
});

test('defaults to the shop catalogue, not the older CCTV one', () => {
  /* Uploading into 1411420710903781 would succeed and no ad would read a
     single product of it. */
  assert.equal(catalogConfig({}).catalogId, '1385708380173785');
});

test('an explicit catalogue id overrides the default', () => {
  assert.equal(catalogConfig({ META_CATALOG_ID: '123' }).catalogId, '123');
});

test('status names the token as the only missing piece on a fresh deployment', () => {
  const s = catalogStatus({});
  assert.equal(s.token, false);
  assert.equal(s.dedicatedToken, false);
  assert.equal(s.catalog, true);
  assert.equal(s.catalogId, '1385708380173785');
});

test('status distinguishes a dedicated catalogue token from a borrowed one', () => {
  assert.equal(catalogStatus({ META_INSIGHTS_TOKEN: 'y' }).dedicatedToken, false);
  assert.equal(catalogStatus({ META_INSIGHTS_TOKEN: 'y' }).token, true);
  assert.equal(catalogStatus({ META_CATALOG_TOKEN: 'x' }).dedicatedToken, true);
});

/* -------------------------------------------------------------------------
   The item envelope
   ------------------------------------------------------------------------- */
test('an item is an upsertable UPDATE carrying Meta-named fields', () => {
  const item = productItem(PRODUCT, ORIGIN);
  assert.equal(item.method, 'UPDATE');
  assert.equal(item.data.id, 'unv-2mp');
  assert.equal(item.data.title, 'UNV 2MP Bullet');
  assert.equal(item.data.description, 'Two megapixel bullet camera');
  assert.equal(item.data.brand, 'Uniview');
  assert.equal(item.data.condition, 'new');
  assert.equal(item.data.link, 'https://visionguardeg.com/product?id=unv-2mp');
  assert.equal(item.data.image_link, 'https://visionguardeg.com/assets/products/unv-2mp.jpg');
});

test('our warnings never travel inside the item', () => {
  /* `warnings` is this repository's word about a row, not a catalogue field.
     Sending it would put an unknown key in every product Meta stores. */
  const item = productItem({ ...PRODUCT, img: '' }, ORIGIN);
  assert.equal('warnings' in item.data, false);
  assert.equal('warnings' in item, false);
});

test('sends the selling price, never the purchase price', () => {
  /* The money assertion. products.price is what orders.js charges. */
  assert.equal(productItem(PRODUCT, ORIGIN).data.price, '1200 EGP');
});

test('a discount sends was as the price and price as the sale price', () => {
  /* was is validated as strictly greater than price, so this is the only
     orientation that satisfies Meta's sale_price <= price. */
  const item = productItem({ ...PRODUCT, price: 400, was: 500 }, ORIGIN);
  assert.equal(item.data.price, '500 EGP');
  assert.equal(item.data.sale_price, '400 EGP');
});

test('an undiscounted product still sends sale_price, blank', () => {
  /* Blank is how a discount that ENDED gets cleared. Omitting the field
     would leave Meta advertising last month's sale price forever, and
     nothing would report it. */
  const item = productItem(PRODUCT, ORIGIN);
  assert.equal('sale_price' in item.data, true);
  assert.equal(item.data.sale_price, '');
});

test('a withdrawn product goes out of stock rather than being skipped', () => {
  /* Keeping the id keeps its history and its ad performance. Skipping it
     would leave Meta advertising it as in stock. */
  assert.equal(productItem({ ...PRODUCT, active: 0 }, ORIGIN).data.availability, 'out of stock');
  assert.equal(productItem(PRODUCT, ORIGIN).data.availability, 'in stock');
});

test('a trailing slash on the origin does not double up in links', () => {
  const item = productItem(PRODUCT, 'https://visionguardeg.com/');
  assert.equal(item.data.link, 'https://visionguardeg.com/product?id=unv-2mp');
  assert.equal(item.data.image_link, 'https://visionguardeg.com/assets/products/unv-2mp.jpg');
});

/* -------------------------------------------------------------------------
   Batching
   ------------------------------------------------------------------------- */
test('chunk splits on an exact multiple without emitting an empty tail', () => {
  /* The arithmetic that is right until the length divides evenly. */
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1], 5), [[1]]);
});

test('chunk survives a nonsense size rather than looping forever', () => {
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
});

test('buildBatches collects the rows Meta will refuse, before sending them', () => {
  const { requests, warnings } = buildBatches(
    [PRODUCT, { ...PRODUCT, id: 'junction-box', img: 'assets/products/junction-box.svg' }],
    ORIGIN
  );
  assert.equal(requests.length, 2);
  assert.match(warnings.join(' '), /junction-box: image is an SVG/);
});

test('buildBatches warns about a row with no image at all', () => {
  const { warnings } = buildBatches([{ ...PRODUCT, img: '' }], ORIGIN);
  assert.match(warnings.join(' '), /unv-2mp: no image/);
});

test('a clean catalogue produces no warnings', () => {
  assert.deepEqual(buildBatches([PRODUCT], ORIGIN).warnings, []);
});

test('buildBatches splits at the requested size', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...PRODUCT, id: `p-${i}` }));
  const { batches, requests } = buildBatches(many, ORIGIN, 2);
  assert.equal(requests.length, 5);
  assert.equal(batches.length, 3);
  assert.equal(batches[2].length, 1);
});

test('an empty product list is a no-op, not a crash', () => {
  const { requests, batches, warnings } = buildBatches([], ORIGIN);
  assert.deepEqual(requests, []);
  assert.deepEqual(batches, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(buildBatches(undefined, ORIGIN).requests, []);
});
