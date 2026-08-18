/* =========================================================================
   Leave arithmetic.

   These decide how many days somebody actually gets off, so an off-by-one
   here is not cosmetic — it is a person losing a day of their year, or the
   cap being quietly exceeded. The date handling in particular is worth
   pinning: leave ranges cross month ends, leap days and New Year, and every
   one of those is somewhere a naive implementation drops or repeats a day.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOLIDAYS, VACATION_DAYS_PER_YEAR, MAX_REQUEST_DAYS,
  isDate, datesBetween, holidaysIn, countDays, checkRange, yearOf, balance
} from '../lib/leave.js';

/* -------------------------------------------------------------------------
   Dates
   ------------------------------------------------------------------------- */
test('accepts real dates and rejects impossible ones', () => {
  for (const ok of ['2026-01-01', '2026-12-31', '2028-02-29']) {
    assert.equal(isDate(ok), true, `${ok} should be valid`);
  }
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '20260101', '', null, undefined, 42]) {
    assert.equal(isDate(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('rejects 29 February in a common year and accepts it in a leap year', () => {
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2028-02-29'), true);
});

test('a single day is one day, not zero', () => {
  const { days, dates } = countDays('2026-09-01', '2026-09-01');
  assert.equal(days, 1);
  assert.deepEqual(dates, ['2026-09-01']);
});

test('both ends are included', () => {
  const { days } = countDays('2026-09-01', '2026-09-05');
  assert.equal(days, 5);
});

test('counts correctly across a month end', () => {
  const { days, dates } = countDays('2026-01-30', '2026-02-02');
  assert.equal(days, 4);
  assert.deepEqual(dates, ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
});

test('counts correctly across New Year', () => {
  const { days, dates } = countDays('2026-12-30', '2027-01-02');
  assert.equal(days, 4);
  assert.deepEqual(dates, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('counts correctly across a leap day', () => {
  const { days, dates } = countDays('2028-02-27', '2028-03-01');
  assert.equal(days, 4);
  assert.ok(dates.includes('2028-02-29'), 'the leap day must be counted');
});

test('every date produced is a real date, over a long range', () => {
  /* A timezone bug shows up as a repeated or skipped day somewhere in the
     middle of a long run, not at the ends. */
  const { dates } = countDays('2026-01-01', '2026-01-14');
  assert.equal(new Set(dates).size, dates.length, 'a date was repeated');
  for (const d of dates) assert.equal(isDate(d), true, `${d} is not a real date`);
  assert.equal(dates[0], '2026-01-01');
  assert.equal(dates[dates.length - 1], '2026-01-14');
});

/* -------------------------------------------------------------------------
   The policy: holidays are counted
   ------------------------------------------------------------------------- */
test('a public holiday inside the range STILL costs a day', () => {
  /* 2026-07-23 is Revolution Day. The policy is that it comes out of the
     allowance anyway. If this test ever fails because someone made holidays
     free, the header of lib/leave.js is where the decision is written down. */
  const { days, holidays } = countDays('2026-07-22', '2026-07-24');
  assert.equal(days, 3, 'the holiday must not be discounted');
  assert.equal(holidays.length, 1);
  assert.equal(holidays[0].date, '2026-07-23');
});

test('reports the holidays in a range so the form can show them', () => {
  /* Eid al-Adha 2026 runs 27-29 May with Arafat on the 26th. */
  const { days, holidays } = countDays('2026-05-25', '2026-05-30');
  assert.equal(days, 6);
  assert.deepEqual(holidays.map((h) => h.date), ['2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29']);
});

test('finds holidays either side of a New Year boundary', () => {
  const found = holidaysIn('2026-12-20', '2027-01-10');
  assert.deepEqual(found.map((h) => h.date), ['2027-01-07']);
});

test('a year with no calendar entry returns nothing rather than throwing', () => {
  assert.deepEqual(holidaysIn('2099-01-01', '2099-12-31'), []);
  const { days } = countDays('2099-01-01', '2099-01-05');
  assert.equal(days, 5, 'the deduction must not depend on the calendar');
});

test('holidays come back in date order', () => {
  const found = holidaysIn('2026-01-01', '2026-12-31');
  const sorted = found.map((h) => h.date).slice().sort();
  assert.deepEqual(found.map((h) => h.date), sorted);
});

/* -------------------------------------------------------------------------
   The calendar itself
   ------------------------------------------------------------------------- */
test('every holiday entry is a real date, named in both languages, in its own year', () => {
  for (const year of Object.keys(HOLIDAYS)) {
    for (const h of HOLIDAYS[year]) {
      assert.equal(isDate(h.date), true, `${h.date} is not a real date`);
      assert.equal(h.date.slice(0, 4), year, `${h.date} is filed under ${year}`);
      assert.ok(h.ar && h.en, `${h.date} is missing a name`);
    }
  }
});

test('no duplicate holiday dates within a year', () => {
  for (const year of Object.keys(HOLIDAYS)) {
    const dates = HOLIDAYS[year].map((h) => h.date);
    assert.equal(new Set(dates).size, dates.length, `duplicate date in ${year}`);
  }
});

test('the lunar holidays are flagged as estimates', () => {
  /* Eid, the Hijri New Year and the Prophet's Birthday are fixed by Cabinet
     announcement after a moon sighting. Anything presenting them as certain
     is claiming more than we know. */
  for (const year of Object.keys(HOLIDAYS)) {
    const lunar = HOLIDAYS[year].filter((h) => h.lunar);
    assert.ok(lunar.length >= 6, `${year} should mark its Islamic holidays as lunar`);
  }
});

/* -------------------------------------------------------------------------
   Validation
   ------------------------------------------------------------------------- */
test('accepts a sane range', () => {
  assert.equal(checkRange('2026-09-01', '2026-09-05'), '');
  assert.equal(checkRange('2026-09-01', '2026-09-01'), '');
});

test('refuses a range that ends before it starts', () => {
  assert.equal(checkRange('2026-09-05', '2026-09-01'), 'end_before_start');
});

test('refuses malformed dates, naming which end is wrong', () => {
  assert.equal(checkRange('nonsense', '2026-09-05'), 'bad_start');
  assert.equal(checkRange('2026-09-01', 'nonsense'), 'bad_end');
  assert.equal(checkRange('2026-02-30', '2026-03-02'), 'bad_start');
});

test('refuses a request longer than the whole annual allowance', () => {
  /* The typo case: 2027 for 2026 in the end date. */
  assert.equal(checkRange('2026-12-20', '2027-12-20'), 'too_long');
  assert.equal(checkRange('2026-09-01', '2026-09-15'), 'too_long', '15 days is over the cap');
  assert.equal(checkRange('2026-09-01', '2026-09-14'), '', '14 days is exactly the cap');
});

test('the single-request cap is the annual allowance', () => {
  assert.equal(MAX_REQUEST_DAYS, VACATION_DAYS_PER_YEAR);
});

/* -------------------------------------------------------------------------
   Balance
   ------------------------------------------------------------------------- */
test('a range is charged to the year it starts in', () => {
  assert.equal(yearOf('2026-12-30'), 2026);
  assert.equal(yearOf('2027-01-02'), 2027);
});

test('balance subtracts what has been taken', () => {
  assert.deepEqual(balance(0), { allowance: 14, taken: 0, remaining: 14 });
  assert.deepEqual(balance(5), { allowance: 14, taken: 5, remaining: 9 });
  assert.deepEqual(balance(14), { allowance: 14, taken: 14, remaining: 0 });
});

test('remaining never goes negative, however the total got there', () => {
  assert.equal(balance(20).remaining, 0);
  assert.equal(balance(-3).remaining, 14, 'a negative total is treated as nothing taken');
  assert.equal(balance('abc').remaining, 14);
  assert.equal(balance(null).remaining, 14);
});
