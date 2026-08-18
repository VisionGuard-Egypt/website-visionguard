/* =========================================================================
   Attendance arithmetic.

   This is somebody's hours, so being wrong here is being wrong about
   whether a person is doing their job. The two cases below are not
   hypothetical — both were live.

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupDays, summarise, statusOf, isMistap, targetSeconds,
  MISTAP_SECONDS, elapsedSeconds
} from '../lib/attendance.js';

const ENV = {};                       // six-hour default
const TARGET = targetSeconds(ENV);    // 21600
const closed = (date, inIso, outIso, seconds) =>
  ({ id: date, work_date: date, clock_in: inIso, clock_out: outIso, seconds });

/* -------------------------------------------------------------------------
   THE MIS-TAP

   dina rahal, 6 August 2026: clocked in 08:19:17, out 08:19:21. Four
   seconds. The old arithmetic called that a working day, charged it six
   hours of expectation, and reported her 5h 26m BEHIND over a period in
   which she had worked OVER her contract on both real days.
   ------------------------------------------------------------------------- */
const DINA = [
  closed('2026-08-09', '2026-08-09T13:58:38.652Z', '2026-08-09T20:06:31.209Z', 22072),
  closed('2026-08-08', '2026-08-08T13:38:53.491Z', '2026-08-08T20:05:01.911Z', 23168),
  closed('2026-08-06', '2026-08-06T08:19:17.140Z', '2026-08-06T08:19:21.364Z', 4)
];

test('a four-second shift is a mis-tap, not a short day', () => {
  const days = groupDays(DINA, ENV, Date.now());
  const day = days.find((d) => d.date === '2026-08-06');
  assert.equal(day.status, 'mistap');
  assert.equal(day.mistap, true);
  /* Calling it 'short' is what made it cost six hours. */
  assert.notEqual(day.status, 'short');
});

test('a mis-tap has no balance, because there was no day', () => {
  const days = groupDays(DINA, ENV, Date.now());
  assert.equal(days.find((d) => d.date === '2026-08-06').balance, null);
});

test('one mis-tap no longer turns a positive balance negative', () => {
  /* The regression, in one assertion. Her two real days are +8m and +26m. */
  const summary = summarise(groupDays(DINA, ENV, Date.now()), ENV);
  /* 22072 + 23168 - (2 x 21600) = 2040. NOT 2044: the mis-tap's four
     seconds count towards hours actually recorded, and deliberately not
     towards the balance — there is no day for them to be measured against. */
  assert.equal(summary.balance, 2040);        // +34m
  assert.ok(summary.balance > 0, 'she is ahead, and must read as ahead');
  assert.equal(summary.daysWorked, 2);        // not 3
  assert.equal(summary.expected, 2 * TARGET); // not 3 x 6h
  assert.equal(summary.mistaps, 1);
});

test('the mis-tap row is kept and counted, not silently dropped', () => {
  /* A timesheet that quietly deletes rows is worse than one showing an odd
     one: somebody pressed the button twice and that is a fact about the day. */
  const days = groupDays(DINA, ENV, Date.now());
  assert.equal(days.length, 3, 'the day still appears');
  assert.equal(days.find((d) => d.date === '2026-08-06').sessions.length, 1);
  const summary = summarise(days, ENV);
  assert.equal(summary.seconds, 22072 + 23168 + 4, 'every recorded second is still counted');
});

test('the threshold is two minutes, and a genuinely short shift survives it', () => {
  assert.equal(MISTAP_SECONDS, 120);
  const short = groupDays([closed('2026-08-05', '2026-08-05T09:00:00Z', '2026-08-05T09:20:00Z', 1200)], ENV, Date.now());
  assert.equal(short[0].status, 'short', 'twenty minutes is a real, short shift');
  assert.equal(short[0].mistap, false);
  assert.equal(short[0].balance, 1200 - TARGET);
});

/* -------------------------------------------------------------------------
   THE DAY THAT HAS NOT FINISHED

   Clock in, and the screen used to tell you that you were 5h 55m behind.
   Arithmetically true and completely useless: you cannot be behind on a day
   that is still running.
   ------------------------------------------------------------------------- */
const now = Date.parse('2026-08-10T12:00:00.000Z');
const openShiftRow = {
  id: 'o1', work_date: '2026-08-10',
  clock_in: new Date(now - 30 * 60000).toISOString(),   // 30 minutes ago
  clock_out: null, seconds: null
};

test('a day in progress has no balance', () => {
  const days = groupDays([openShiftRow], ENV, now);
  assert.equal(days[0].status, 'open');
  assert.equal(days[0].balance, null);
});

test('an unfinished day is not charged a full day of expectation', () => {
  const summary = summarise(groupDays([openShiftRow], ENV, now), ENV);
  assert.equal(summary.expected, 0, 'nothing is expected of a day still running');
  assert.equal(summary.balance, 0, 'and so nothing is owed');
  assert.equal(summary.daysWorked, 0);
});

test('but the hours already worked today are still counted and visible', () => {
  const summary = summarise(groupDays([openShiftRow], ENV, now), ENV);
  assert.equal(summary.seconds, 1800, 'thirty minutes really were worked');
  assert.equal(summary.openSeconds, 1800, 'and are reported as in-progress');
});

test('a finished day beside an open one is judged normally', () => {
  const days = groupDays([openShiftRow, closed('2026-08-09', '2026-08-09T09:00:00Z', '2026-08-09T15:30:00Z', 23400)], ENV, now);
  const summary = summarise(days, ENV);
  assert.equal(summary.daysWorked, 1);
  assert.equal(summary.expected, TARGET);
  assert.equal(summary.balance, 23400 - TARGET);   // +30m
  assert.equal(summary.openSeconds, 1800);
});

/* -------------------------------------------------------------------------
   Unchanged behaviour that must stay unchanged
   ------------------------------------------------------------------------- */
test('a day with nothing recorded is absent, and absent is not a mis-tap', () => {
  assert.equal(isMistap({ open: false, sessions: [], seconds: 0 }), false);
  assert.equal(statusOf(0, TARGET), 'absent');
});

test('a day that has just started is not a mis-tap', () => {
  /* Open for its first ten seconds is somebody who has just arrived, not
     somebody who tapped twice. Only a CLOSED shift can be a mis-tap. */
  assert.equal(isMistap({ open: true, sessions: [{}], seconds: 10 }), false);
});

test('the six-hour grace either side still holds', () => {
  assert.equal(statusOf(TARGET, TARGET), 'complete');
  assert.equal(statusOf(TARGET - 200, TARGET), 'complete');
  assert.equal(statusOf(TARGET - 400, TARGET), 'short');
  assert.equal(statusOf(TARGET + 400, TARGET), 'overtime');
});

test('elapsed time on an open shift never goes negative', () => {
  assert.equal(elapsedSeconds('2026-08-10T13:00:00Z', Date.parse('2026-08-10T12:00:00Z')), 0);
  assert.equal(elapsedSeconds('nonsense', now), 0);
});
