/* =========================================================================
   Live chat — the rotation.

   The rule is "one employee at a time, five minutes each, then the next
   one", and every way it can go wrong is a customer sitting there waiting:
   a rotation that hands the chat back to somebody who already let it lapse
   never reaches anyone new, and one that never ends pesters the team
   forever instead of escalating.

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextAgent, offerExpiry, isOfferExpired, secondsLeft, parseOffered,
  publicSession, OFFER_MINUTES
} from '../lib/livechat.js';

const TEAM = [
  { id: 'a', name: 'Amira' },
  { id: 'b', name: 'Basem' },
  { id: 'c', name: 'Carim' }
];

/* -------------------------------------------------------------------------
   Whose turn it is
   ------------------------------------------------------------------------- */
test('the first offer goes to the first person on the rota', () => {
  assert.equal(nextAgent(TEAM, []).id, 'a');
});

test('somebody who has already had their turn is skipped', () => {
  /* Without this a two-person shift hands the same chat back and forth
     every five minutes and never reaches anybody new. */
  assert.equal(nextAgent(TEAM, ['a']).id, 'b');
  assert.equal(nextAgent(TEAM, ['a', 'b']).id, 'c');
});

test('the order of the offered list does not matter', () => {
  assert.equal(nextAgent(TEAM, ['b', 'a']).id, 'c');
});

test('when everybody has had a turn there is no next person', () => {
  /* null is a real state, not a failure: it is what makes the chat become
     unclaimed and the whole team told once, instead of rotating forever. */
  assert.equal(nextAgent(TEAM, ['a', 'b', 'c']), null);
});

test('an empty rota yields nobody rather than throwing', () => {
  assert.equal(nextAgent([], []), null);
  assert.equal(nextAgent(null, null), null);
});

test('an offered id that is no longer on shift does not block the rota', () => {
  /* Somebody clocked out after being offered the chat. The remaining people
     must still get their turn. */
  assert.equal(nextAgent([TEAM[1], TEAM[2]], ['a']).id, 'b');
});

/* -------------------------------------------------------------------------
   The five minutes
   ------------------------------------------------------------------------- */
test('an offer expires exactly five minutes out', () => {
  const base = Date.parse('2026-08-09T12:00:00.000Z');
  assert.equal(offerExpiry(base), '2026-08-09T12:05:00.000Z');
  assert.equal(OFFER_MINUTES, 5);
});

test('a fresh offer is not expired, a stale one is', () => {
  const base = Date.parse('2026-08-09T12:00:00.000Z');
  const expires = offerExpiry(base);
  assert.equal(isOfferExpired(expires, base + 60_000), false);
  assert.equal(isOfferExpired(expires, base + 4 * 60_000), false);
  assert.equal(isOfferExpired(expires, base + 5 * 60_000), true);
  assert.equal(isOfferExpired(expires, base + 6 * 60_000), true);
});

test('a missing or unparseable deadline counts as expired', () => {
  /* Fail towards moving the chat on. The alternative is a customer parked
     on a broken offer that no sweep will ever pick up. */
  assert.equal(isOfferExpired(null), true);
  assert.equal(isOfferExpired(''), true);
  assert.equal(isOfferExpired('not a date'), true);
});

test('the countdown never goes negative', () => {
  /* A clock ticking into minus numbers reads as broken rather than as
     expired. */
  const base = Date.parse('2026-08-09T12:00:00.000Z');
  const expires = offerExpiry(base);
  assert.equal(secondsLeft(expires, base), 300);
  assert.equal(secondsLeft(expires, base + 299_000), 1);
  assert.equal(secondsLeft(expires, base + 600_000), 0);
  assert.equal(secondsLeft(null, base), 0);
});

/* -------------------------------------------------------------------------
   The offered list
   ------------------------------------------------------------------------- */
test('the offered list survives a corrupt column', () => {
  /* Treating it as "nobody asked yet" costs at worst one repeated offer.
     Throwing would stop the rotation dead. */
  assert.deepEqual(parseOffered('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseOffered('[]'), []);
  assert.deepEqual(parseOffered(null), []);
  assert.deepEqual(parseOffered('not json'), []);
  assert.deepEqual(parseOffered('{"a":1}'), []);
  assert.deepEqual(parseOffered('[1,2,"c"]'), ['c']);
});

/* -------------------------------------------------------------------------
   What the customer is told about themselves
   ------------------------------------------------------------------------- */
test('the customer never receives their own session id back', () => {
  /* The id is the only thing authorising the conversation. The browser
     already has it; echoing it in every poll response is how it ends up in
     a log or a screenshot. */
  const view = publicSession({
    id: 'deadbeefdeadbeefdeadbeefdeadbeef',
    status: 'live', agent_name: 'Amira', created_at: 'x', answered_at: 'y'
  });
  assert.equal(view.id, undefined);
  assert.ok(!JSON.stringify(view).includes('deadbeef'));
});

test('the customer is told the name of the person answering, and nothing else about them', () => {
  const view = publicSession({
    status: 'live', agent_name: 'Amira', agent_id: 'user-123',
    phone: '201012345678', created_at: 'x'
  });
  assert.equal(view.agentName, 'Amira');
  const json = JSON.stringify(view);
  assert.ok(!json.includes('user-123'), 'no staff id');
  assert.ok(!json.includes('201012345678'), 'no phone');
});

test('waiting and answered are distinguishable states', () => {
  assert.equal(publicSession({ status: 'waiting', created_at: 'x' }).queued, true);
  assert.equal(publicSession({ status: 'live', created_at: 'x' }).queued, false);
  assert.equal(publicSession({ status: 'closed', created_at: 'x' }).closed, true);
});
