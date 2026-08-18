/* =========================================================================
   Every order becomes a lead.

   The rule is small and the ways it can go quietly wrong are not: a second
   card for a customer who already has one splits their history between two
   employees, and a lead created as `won` drops straight off the board it was
   created to appear on.

   D1 is stubbed rather than mocked with a library — the surface used is
   prepare().bind().first()/run(), which is small enough to implement
   honestly and keeps the assertions about SQL that really was issued.

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  leadFromOrder, orderLeadNote, reopensLead, LEAD_STATUSES, CLOSED_STATUSES
} from '../lib/leads.js';

/* A D1 stand-in that records what it was asked to do and answers the one
   SELECT with whatever the test set up. */
function fakeDb(existing) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const entry = { sql, binds: null };
      return {
        bind(...binds) {
          entry.binds = binds;
          return {
            async first() { calls.push(Object.assign({ op: 'first' }, entry)); return existing; },
            async run() { calls.push(Object.assign({ op: 'run' }, entry)); return { meta: { changes: 1 } }; }
          };
        }
      };
    }
  };
}

const ORDER = {
  id: 'VG-260809-AB12',
  name: 'Mona Adel',
  phone: '201012345678',
  email: 'mona@example.com',
  governorate: 'Cairo',
  total: 4500,
  currency: 'EGP'
};

/* -------------------------------------------------------------------------
   A customer nobody has met
   ------------------------------------------------------------------------- */
test('creates a lead when the number is new', async () => {
  const d1 = fakeDb(null);
  const r = await leadFromOrder(d1, ORDER, 'lead-1');
  assert.equal(r.created, true);
  assert.equal(r.leadId, 'lead-1');

  const insert = d1.calls.find((c) => /INSERT INTO leads/.test(c.sql));
  assert.ok(insert, 'expected an INSERT');
  assert.ok(insert.binds.includes('Mona Adel'));
  assert.ok(insert.binds.includes('201012345678'));
  assert.ok(insert.binds.includes('VG-260809-AB12'));
});

test('the new lead is open, not won', async () => {
  /* `won` is a closed status: it drops off the default board, which is the
     opposite of "so we can follow up". This is the assertion that keeps it
     that way. */
  const d1 = fakeDb(null);
  await leadFromOrder(d1, ORDER, 'lead-1');
  const insert = d1.calls.find((c) => /INSERT INTO leads/.test(c.sql));
  assert.match(insert.sql, /'new'/);
  assert.doesNotMatch(insert.sql, /'won'/);
});

test('the source is recorded as the website', async () => {
  const d1 = fakeDb(null);
  await leadFromOrder(d1, ORDER, 'lead-1');
  const insert = d1.calls.find((c) => /INSERT INTO leads/.test(c.sql));
  assert.match(insert.sql, /'website'/);
});

/* -------------------------------------------------------------------------
   A customer who is already on the board
   ------------------------------------------------------------------------- */
test('a returning customer does NOT get a second card', async () => {
  /* The failure this prevents: two employees looking after one person from
     two cards, each blind to the other's notes. */
  const d1 = fakeDb({ id: 'lead-existing', status: 'contacted', order_id: null });
  const r = await leadFromOrder(d1, ORDER, 'lead-new');
  assert.equal(r.created, false);
  assert.equal(r.leadId, 'lead-existing');
  assert.ok(!d1.calls.some((c) => /INSERT INTO leads/.test(c.sql)), 'must not insert');
  assert.ok(d1.calls.some((c) => /UPDATE leads/.test(c.sql)), 'must update');
});

test('the newest order becomes the linked one', async () => {
  const d1 = fakeDb({ id: 'lead-existing', status: 'new', order_id: 'VG-OLD' });
  await leadFromOrder(d1, ORDER, 'x');
  const update = d1.calls.find((c) => /UPDATE leads/.test(c.sql));
  assert.ok(update.binds.includes('VG-260809-AB12'));
});

test('a repeat order reopens a lead that was closed', async () => {
  for (const status of CLOSED_STATUSES) {
    assert.equal(reopensLead(status), true, `${status} should reopen`);
  }
  for (const status of LEAD_STATUSES.filter((s) => !CLOSED_STATUSES.includes(s))) {
    assert.equal(reopensLead(status), false, `${status} should stay as it is`);
  }
});

test('reopening is done in SQL, conditionally, not by blanket overwrite', async () => {
  /* An open lead sitting at `quoted` must not be knocked back to `new` — the
     employee's progress is real information. The CASE is what protects it. */
  const d1 = fakeDb({ id: 'lead-existing', status: 'quoted', order_id: null });
  await leadFromOrder(d1, ORDER, 'x');
  const update = d1.calls.find((c) => /UPDATE leads/.test(c.sql));
  assert.match(update.sql, /CASE WHEN status IN \('won','lost'\)/);
  assert.match(update.sql, /THEN 'new' ELSE status END/);
});

test('an employee’s corrections are never overwritten by the checkout form', async () => {
  /* Somebody who fixed a misspelled name or set a governorate by hand keeps
     it. Only blanks get filled. */
  const d1 = fakeDb({ id: 'lead-existing', status: 'new', order_id: null });
  await leadFromOrder(d1, ORDER, 'x');
  const update = d1.calls.find((c) => /UPDATE leads/.test(c.sql));
  assert.match(update.sql, /email\s*=\s*COALESCE\(NULLIF\(email, ''\)/);
  assert.match(update.sql, /governorate\s*=\s*COALESCE\(NULLIF\(governorate, ''\)/);
  /* And the name is not in the UPDATE at all. */
  assert.doesNotMatch(update.sql, /\bname\s*=/);
});

/* -------------------------------------------------------------------------
   The timeline line
   ------------------------------------------------------------------------- */
test('the note names the order and what it was worth', () => {
  assert.equal(
    orderLeadNote('VG-260809-AB12', 4500, 'EGP'),
    'Ordered VG-260809-AB12 — 4500 EGP from the website'
  );
});

test('the note survives a missing total or currency', () => {
  assert.equal(orderLeadNote('VG-1', null, null), 'Ordered VG-1 — 0 EGP from the website');
  assert.equal(orderLeadNote('VG-1', undefined, undefined), 'Ordered VG-1 — 0 EGP from the website');
});

test('a lead is looked up by phone, which is the identity everywhere else', async () => {
  const d1 = fakeDb(null);
  await leadFromOrder(d1, ORDER, 'x');
  const select = d1.calls.find((c) => c.op === 'first');
  assert.match(select.sql, /FROM leads WHERE phone = \?1/);
  assert.deepEqual(select.binds, ['201012345678']);
});
