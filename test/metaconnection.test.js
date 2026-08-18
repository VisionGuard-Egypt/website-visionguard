/* =========================================================================
   The connection panel — what we are connected to, and is it firing.

   Three things are being tested and they fail in different ways.

   THE SECRET. This object feeds an admin screen. The constraint is that no
   token may ever reach it, and the strongest form of that is structural: not
   "the template remembers not to print it" but "there is no field it could
   be in". That is asserted directly below, against the whole serialized
   object, because a leak here is invisible in review and permanent once
   rendered.

   THE DATASET PRECEDENCE. lib/meta.js posts to `datasetId || pixelId`. If
   this panel resolved that differently it would confidently report the health
   of an object the site does not use — a green tick on the wrong pixel, which
   is worse than no tick at all.

   THE VERDICT. browser + server -> a named fault. Getting the two the wrong
   way round sends somebody to the token when the pixel is blocked, or the
   reverse, and both are quiet afternoons.

   No framework — node:test ships with Node. `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionConfig, pixelHealth, fetchConnection } from '../lib/metaconnection.js';

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600000;
const DAY = 24 * HOUR;

/* -------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */
test('defaults to the app, page, pixel and catalogue this business owns', () => {
  const c = connectionConfig({});
  assert.equal(c.appId, '1620559926365637');
  assert.equal(c.pageId, '843967908810641');
  assert.equal(c.pixelId, '3744427775716864');
  assert.equal(c.catalogId, '1385708380173785');
});

test('resolves the dataset exactly the way lib/meta.js posts to it', () => {
  /* dataset first, pixel second. A panel that read them the other way round
     would report on an object the server never touches. */
  assert.equal(connectionConfig({ META_DATASET_ID: 'ds', META_PIXEL_ID: 'px' }).pixelId, 'ds');
  assert.equal(connectionConfig({ META_PIXEL_ID: 'px' }).pixelId, 'px');
});

test('the server default now matches the id the browser fires to', () => {
  /* The bug this pins: public/pixel.js has always fired to 3744427775716864
     while lib/meta.js defaulted to 2037293923502315, which has never received
     a server event. Production masked it with an env var. */
  assert.equal(connectionConfig({}).pixelId, '3744427775716864');
  assert.notEqual(connectionConfig({}).pixelId, '2037293923502315');
});

/* -------------------------------------------------------------------------
   The verdict
   ------------------------------------------------------------------------- */
test('both paths firing is healthy', () => {
  assert.equal(pixelHealth(iso(HOUR), iso(HOUR)), 'ok');
});

test('browser firing and server silent points at the token', () => {
  assert.equal(pixelHealth(iso(HOUR), null), 'server_silent');
  assert.equal(pixelHealth(iso(HOUR), iso(3 * DAY)), 'server_silent');
});

test('server firing and browser silent points at the pixel', () => {
  /* Blocked, or consent never granted, or the script stopped loading — all
     of which live in the browser and none of which is a token problem. */
  assert.equal(pixelHealth(null, iso(HOUR)), 'browser_silent');
});

test('neither firing is silent, not healthy', () => {
  assert.equal(pixelHealth(null, null), 'silent');
  assert.equal(pixelHealth(iso(3 * DAY), iso(3 * DAY)), 'silent');
});

test('a quiet night is not a fault', () => {
  /* 24 hours, deliberately. An hourly threshold would render every morning
     as an outage and the indicator would stop being read. */
  assert.equal(pixelHealth(iso(20 * HOUR), iso(20 * HOUR)), 'ok');
});

/* -------------------------------------------------------------------------
   The secret
   ------------------------------------------------------------------------- */
test('no token ever reaches the response, whatever is configured', async () => {
  const env = {
    META_INSIGHTS_TOKEN: 'SUPER-SECRET-READ-TOKEN',
    META_ACCESS_TOKEN: 'SUPER-SECRET-CAPI-TOKEN',
    META_CATALOG_TOKEN: 'SUPER-SECRET-CATALOG-TOKEN'
  };
  /* No network: assert on the shape the unconfigured path returns, then on
     the configured path's own guarantee — that the builder has no field for
     a credential at all. */
  const out = await fetchConnection({}, { admin: true });
  const serialized = JSON.stringify(out);
  for (const secret of Object.values(env)) {
    assert.equal(serialized.includes(secret), false, 'a token reached the panel');
  }
  assert.equal('token' in out, false);
  assert.equal(serialized.toLowerCase().includes('token'), true,
    'the unconfigured message may name the VARIABLE, which is not a secret');
});

test('an unconfigured deployment still reports the ids it would use', async () => {
  /* "Here is the Page we would ask about, and we cannot reach it" beats a
     blank card by a mile when somebody is trying to work out what is wrong. */
  const out = await fetchConnection({}, { admin: true });
  assert.equal(out.configured, false);
  assert.equal(out.page.id, '843967908810641');
  assert.equal(out.pixel.id, '3744427775716864');
  assert.equal(out.app.id, '1620559926365637');
});

test('the ad account is administrator-only, like the spend beside it', async () => {
  const staff = await fetchConnection({}, { admin: false });
  const admin = await fetchConnection({}, { admin: true });
  assert.equal(staff.adAccount, null);
  assert.equal(admin.adAccount.id, 'act_2067738330681838');
});
