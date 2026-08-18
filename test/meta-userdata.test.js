/* =========================================================================
   Meta customer-information parameters.

   Every value here is SHA-256'd before it leaves, which is exactly what makes
   a mistake invisible: Meta accepts a wrong hash with a 200 and simply
   matches nobody. Nothing downstream fails, no error is logged, and the only
   symptom is an event match quality score that is lower than it should be —
   which looks identical to "we do not have that data".

   So these tests assert the NORMALIZATION, not the plumbing, and they pin the
   two rules that are easy to get wrong and impossible to notice:

     - a value must be normalized the same way on both sides, because
       public/track.js hashes the browser's copy of em / ph / external_id
       independently;
     - an empty value must be DROPPED, never hashed. Hashing "" produces a
       real-looking digest that matches nobody, and Meta counts it as a
       supplied identifier — so a blank field actively lowers the score
       instead of being ignored.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildUserData, splitName, cityEn, _internals as n } from '../lib/meta.js';

/* What the value SHOULD hash to, computed independently of lib/meta.js. */
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* -------------------------------------------------------------------------
   Normalization rules
   ------------------------------------------------------------------------- */

test('email is trimmed and lowercased, the way the browser also does it', () => {
  assert.equal(n.normEmail('  Omar@Example.COM '), 'omar@example.com');
  assert.equal(n.normEmail(''), '');
});

test('phone keeps digits only, country code included', () => {
  /* normPhoneEg already stores this shape; the point is that + and spaces
     and dashes never reach the hash. */
  assert.equal(n.normPhone('+20 101 234 5678'), '201012345678');
  assert.equal(n.normPhone('201012345678'), '201012345678');
});

test('a name loses punctuation, digits and case but keeps its letters', () => {
  assert.equal(n.normName("O'Brien"), 'obrien');
  assert.equal(n.normName('Omar  Bakkar'), 'omar bakkar');
  assert.equal(n.normName('Ahmed2'), 'ahmed');
  assert.equal(n.normName('  Mona-Adel '), 'monaadel');
});

test('an Arabic name survives normalization', () => {
  /* Most customers here type Arabic, and Meta accepts UTF-8 names. A rule
     written as [^a-z] would silently delete the entire name and hash an
     empty string — the exact failure this file exists to catch. */
  assert.equal(n.normName('عمر بكار'), 'عمر بكار');
  assert.ok(n.normName('عمر').length > 0);
});

test('a city drops spaces entirely, unlike a name', () => {
  assert.equal(n.normCity('Port Said'), 'portsaid');
  assert.equal(n.normCity('Cairo'), 'cairo');
});

test('country is two lowercase letters', () => {
  assert.equal(n.normCountry('EG'), 'eg');
  assert.equal(n.normCountry('Egypt'), 'eg');
});

/* -------------------------------------------------------------------------
   The governorate translation, which is where the Arabic bites
   ------------------------------------------------------------------------- */

test('an Arabic governorate becomes a Latin city before it is hashed', () => {
  assert.equal(cityEn('القاهرة'), 'Cairo');
  assert.equal(cityEn('Cairo'), 'Cairo');
  /* Checkout stores whichever language the customer had selected, so the
     Arabic form is the COMMON case. Hashing it directly would produce a
     clean hash that matches nobody in Meta's index. */
  assert.equal(n.normCity(cityEn('القاهرة')), 'cairo');
});

test('a mononym gives a first name and no invented surname', () => {
  assert.deepEqual(splitName('Cher'), { fn: 'Cher', ln: '' });
  assert.deepEqual(splitName('  Omar   Bakkar  '), { fn: 'Omar', ln: 'Bakkar' });
  assert.deepEqual(splitName(''), { fn: '', ln: '' });
});

/* -------------------------------------------------------------------------
   buildUserData — the shape that actually goes to Meta
   ------------------------------------------------------------------------- */

const ORDER = {
  email: 'Omar@Example.com',
  phone: '201012345678',
  name: 'Omar Bakkar',
  city: 'القاهرة',
  country: 'eg',
  externalId: 'usr_abc123',
  fbp: 'fb.1.1596403881668.1116446470',
  fbc: 'fb.1.1554763741205.AbCdEfGh',
  clientIp: '156.200.1.1',
  userAgent: 'Mozilla/5.0'
};

test('a purchase carries nine identifiers, each hashed correctly', async () => {
  const ud = await buildUserData(ORDER);

  assert.deepEqual(ud.em, [sha('omar@example.com')]);
  assert.deepEqual(ud.ph, [sha('201012345678')]);
  assert.deepEqual(ud.fn, [sha('omar')]);
  assert.deepEqual(ud.ln, [sha('bakkar')]);
  assert.deepEqual(ud.ct, [sha('cairo')]);
  assert.deepEqual(ud.country, [sha('eg')]);
  assert.deepEqual(ud.external_id, [sha('usr_abc123')]);

  /* These four are never hashed — Meta rejects a hashed IP or user agent and
     reads its own identifiers verbatim. */
  assert.equal(ud.fbp, ORDER.fbp);
  assert.equal(ud.fbc, ORDER.fbc);
  assert.equal(ud.client_ip_address, '156.200.1.1');
  assert.equal(ud.client_user_agent, 'Mozilla/5.0');

  assert.equal(Object.keys(ud).length, 11, 'seven hashed keys plus four verbatim');
});

test('empty values are dropped, never hashed', async () => {
  /* The regression this pins: hashing "" yields
     e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855,
     which is a perfectly valid hash of nothing. Meta counts it as a supplied
     identifier and matches it to nobody, so a blank field makes the score
     WORSE than omitting it. */
  const emptyHash = sha('');
  const ud = await buildUserData({ email: '', phone: '   ', name: '', city: '', externalId: null });

  assert.deepEqual(ud, {}, 'nothing at all is sent when nothing is known');
  for (const v of Object.values(ud)) {
    assert.notDeepEqual(v, [emptyHash]);
  }
});

test('a name that normalizes away does not become a hash of nothing', async () => {
  /* "123" is a name made entirely of characters normName strips. The result
     must be no fn at all, not sha256(""). */
  const ud = await buildUserData({ name: '123 !!!' });
  assert.ok(!('fn' in ud), 'fn dropped');
  assert.ok(!('ln' in ud), 'ln dropped');
});

test('a guest order still sends everything it does know', async () => {
  /* Guests check out without an email or an account, which is the common
     case here — the phone, the name and the city still match. */
  const ud = await buildUserData({
    phone: '201199887766', name: 'Karim Fathy', city: 'الجيزة', country: 'eg',
    clientIp: '156.200.2.2'
  });
  assert.deepEqual(ud.ph, [sha('201199887766')]);
  assert.deepEqual(ud.fn, [sha('karim')]);
  assert.deepEqual(ud.ct, [sha('giza')]);
  assert.ok(!('em' in ud));
  assert.ok(!('external_id' in ud));
});

test('the browser and the server hash the same three fields identically', async () => {
  /* public/track.js identify() does:
       em          sha256(email.trim().toLowerCase())
       ph          sha256(phone.replace(/\D/g, ''))
       external_id sha256(String(externalId))
     If these drift, the browser event and the server event stop describing
     the same person and Meta deduplicates nothing. */
  const ud = await buildUserData({
    email: ' Omar@Example.com ', phone: '+20 101 234 5678', externalId: 'usr_abc123'
  });

  const browserEm = sha(' Omar@Example.com '.trim().toLowerCase());
  const browserPh = sha('+20 101 234 5678'.replace(/\D/g, ''));
  const browserId = sha(String('usr_abc123'));

  assert.deepEqual(ud.em, [browserEm]);
  assert.deepEqual(ud.ph, [browserPh]);
  assert.deepEqual(ud.external_id, [browserId]);
});
