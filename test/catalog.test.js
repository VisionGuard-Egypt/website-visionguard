/* =========================================================================
   Where prices come from.

   lib/products.js reads the catalogue from D1 and falls back to
   public/catalog.js when it cannot. That fallback is the reason a database
   hiccup does not turn into a shop that answers "unknown_product" for
   everything, so it is worth a test that actually exercises the failure —
   the path nobody notices is broken until the day it is needed.

   D1 is faked here rather than mocked with a library: the module only ever
   calls .prepare().all(), so a five-line stand-in covers it.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog } from '../lib/products.js';
import { PRODUCTS as STATIC_PRODUCTS } from '../public/catalog.js';

const fakeD1 = (behaviour) => ({
  prepare: () => ({ all: behaviour })
});

/* loadCatalog logs to console.error on every fallback, which is correct in
   production and noise in a test run. Swallow it and hand back what was said,
   so the tests can assert the operator actually gets told.

   AWAITED INSIDE, not outside. loadCatalog is async, so returning its promise
   and restoring console.error in a finally would put the real console back
   before the logging this is trying to capture has happened — which is
   exactly what the first version of this helper did, and it failed by
   reporting "the fallback was not logged" about a fallback that logs fine. */
async function captureErrors(fn) {
  const original = console.error;
  const said = [];
  console.error = (...args) => said.push(args.join(' '));
  try {
    const result = await fn();
    return { result, said };
  } finally {
    console.error = original;
  }
}

test('uses D1 when the products table has rows', async () => {
  const d1 = fakeD1(async () => ({
    results: [
      { id: 'x', cat: 'ip', brand: 'B', name: 'X', ar: 'س', en: 'X', img: 'i.jpg', price: 500, was: 600 }
    ]
  }));
  const cat = await loadCatalog(d1);
  assert.equal(cat.source, 'd1');
  assert.equal(cat.products.length, 1);
  assert.equal(cat.resolve('x').price, 500);
  assert.equal(cat.resolve('nope'), null);
});

test('falls back to the static file when the D1 read throws', async () => {
  const d1 = fakeD1(async () => { throw new Error('D1 is down'); });
  const { result: cat, said } = await captureErrors(() => loadCatalog(d1));
  assert.equal(cat.source, 'static');
  assert.equal(cat.products, STATIC_PRODUCTS);
  /* A shop quietly serving week-old prices is exactly what this log exists to
     prevent, so its absence is a real failure. */
  assert.ok(said.some((s) => /D1 read failed/.test(s)), 'the fallback must be logged');
});

test('falls back when the products table is present but empty', async () => {
  const d1 = fakeD1(async () => ({ results: [] }));
  const { result: cat, said } = await captureErrors(() => loadCatalog(d1));
  assert.equal(cat.source, 'static');
  assert.ok(said.some((s) => /empty/.test(s)), 'an empty table must be logged');
});

test('the fallback resolver still prices real products', async () => {
  const d1 = fakeD1(async () => { throw new Error('down'); });
  const { result: cat } = await captureErrors(() => loadCatalog(d1));
  const first = STATIC_PRODUCTS[0];
  const found = cat.resolve(first.id);
  assert.ok(found, 'a product in the static catalogue must resolve');
  assert.equal(found.price, first.price);
});

test('normalises the nullable columns so a row is never half-formed', async () => {
  /* brand/ar/en/img are nullable in the schema. They reach the shop as
     strings, and priceCart copies them onto the order line. */
  const d1 = fakeD1(async () => ({
    results: [{ id: 'y', cat: 'ip', brand: null, name: 'Y', ar: null, en: null, img: null, price: '300', was: null }]
  }));
  const cat = await loadCatalog(d1);
  const p = cat.resolve('y');
  assert.equal(p.brand, '');
  assert.equal(p.ar, '');
  assert.equal(p.en, '');
  assert.equal(p.img, '');
  assert.equal(p.price, 300, 'price must be a number, not the string D1 returned');
  assert.equal(p.was, 0);
});

test('resolve() takes an id of any type without throwing', async () => {
  const d1 = fakeD1(async () => ({
    results: [{ id: '7', cat: 'ip', name: 'Seven', price: 10, was: 0 }]
  }));
  const cat = await loadCatalog(d1);
  assert.equal(cat.resolve(7).name, 'Seven', 'a numeric id must still match');
  assert.equal(cat.resolve(null), null);
  assert.equal(cat.resolve(undefined), null);
});

/* -------------------------------------------------------------------------
   The static catalogue itself — the fallback is only safe if it is sane
   ------------------------------------------------------------------------- */
test('every static product has an id, a name and a positive price', () => {
  for (const p of STATIC_PRODUCTS) {
    assert.ok(p.id, 'product missing an id');
    assert.ok(p.name, `product ${p.id} missing a name`);
    assert.equal(typeof p.price, 'number', `product ${p.id} price is not a number`);
    assert.ok(p.price > 0, `product ${p.id} has a non-positive price`);
  }
});

test('static product ids are unique', () => {
  const ids = STATIC_PRODUCTS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate product id in public/catalog.js');
});
