/* =========================================================================
   Attendance rules.

   The contract is six hours a day. Everything here is expressed against that
   one number so changing it is a single environment variable, not a hunt
   through the code.

   A day is a Cairo day, and a shift belongs to the day it STARTED — a shift
   from 23:00 to 01:00 counts entirely against the day it began on, which is
   how a person would describe it themselves.
   ========================================================================= */
import { cairoDate } from './util.js';

export const DEFAULT_TARGET_HOURS = 6;

/* A shift left open past this is not a real shift, it is a forgotten
   clock-out. See closeStale(). */
export const STALE_HOURS = 16;

/* The other end of the same problem: a shift SHORTER than this is not a
   short day, it is a finger.

   This is not hypothetical. dina rahal clocked in at 08:19:17 on 6 August
   and out at 08:19:21 — four seconds, an obvious double-tap. The old
   arithmetic counted that as a day she had worked, charged it the full six
   hours of expectation, and reported her as five and a half hours BEHIND
   across a period in which she had actually worked over her contract on
   both real days (+8 and +26 minutes). One mis-tap turned +34 minutes into
   −5h 26m.

   Two minutes, because no genuine shift is shorter and every mis-tap is.
   The row is kept and labelled rather than deleted or hidden: somebody
   pressing the button twice is a fact about the day, and a timesheet that
   quietly drops rows is worse than one that shows an odd one. */
export const MISTAP_SECONDS = 120;

/* Was this day a mis-tap rather than work? Only meaningful once the shift is
   closed — a day still in progress is under two minutes for its first two
   minutes, and that is not a mis-tap, it is somebody who has just arrived. */
export const isMistap = (day) =>
  !day.open && day.sessions.length > 0 && day.seconds < MISTAP_SECONDS;

export function targetSeconds(env) {
  const h = parseFloat((env && env.WORK_DAY_HOURS) || '');
  const hours = Number.isFinite(h) && h > 0 && h <= 24 ? h : DEFAULT_TARGET_HOURS;
  return Math.round(hours * 3600);
}

export function statusOf(seconds, target) {
  if (seconds <= 0) return 'absent';
  if (seconds < target - 300) return 'short';        // 5-minute grace either side
  if (seconds > target + 300) return 'overtime';
  return 'complete';
}

/* Someone who forgets to clock out would otherwise accrue an open shift
   forever, and every later total would be nonsense. We close it at exactly
   the contracted length and label the row, so the number is visibly an
   estimate a manager can correct rather than a silent invention. */
export async function closeStale(d1, userId, env) {
  const target = targetSeconds(env);
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600000).toISOString();
  const open = await d1.prepare(
    'SELECT id, clock_in FROM attendance WHERE user_id = ?1 AND clock_out IS NULL AND clock_in < ?2'
  ).bind(userId, cutoff).first();
  if (!open) return null;

  const out = new Date(new Date(open.clock_in).getTime() + target * 1000).toISOString();
  await d1.prepare(
    `UPDATE attendance
        SET clock_out = ?1, seconds = ?2, note = 'auto-closed: no clock-out recorded'
      WHERE id = ?3`
  ).bind(out, target, open.id).run();
  return open.id;
}

export async function openShift(d1, userId) {
  return d1.prepare(
    'SELECT id, work_date, clock_in FROM attendance WHERE user_id = ?1 AND clock_out IS NULL'
  ).bind(userId).first();
}

export function elapsedSeconds(clockInIso, now) {
  const start = new Date(clockInIso).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor(((now || Date.now()) - start) / 1000));
}

/* Groups raw rows into Cairo days. Rows are expected newest-first. */
export function groupDays(rows, env, now) {
  const target = targetSeconds(env);
  const byDate = new Map();

  for (const row of rows || []) {
    const date = row.work_date || cairoDate(new Date(row.clock_in));
    if (!byDate.has(date)) byDate.set(date, { date, seconds: 0, open: false, sessions: [] });
    const day = byDate.get(date);

    const live = row.clock_out === null || row.clock_out === undefined;
    const seconds = live
      ? elapsedSeconds(row.clock_in, now)
      : (Number(row.seconds) || 0);

    day.seconds += seconds;
    if (live) day.open = true;
    day.sessions.push({
      id: row.id,
      in: row.clock_in,
      out: row.clock_out || null,
      seconds,
      live,
      note: row.note || ''
    });
  }

  /* A day with a recorded shift is never "absent", even if the shift rounds
     to zero seconds — absent means nothing was recorded at all, and the two
     must not look the same on a timesheet. */
  const days = Array.from(byDate.values()).map((d) => {
    const mistap = isMistap(d);
    return Object.assign(d, {
      target,
      mistap,
      status: d.open ? 'open'
            : mistap ? 'mistap'
            : d.sessions.length ? (d.seconds > 0 ? statusOf(d.seconds, target) : 'short')
            : 'absent',
      /* NULL, not a number, for a day that cannot be judged yet.

         An open day was reporting the full shortfall the moment somebody
         clocked in: arrive, and the screen tells you that you are 5h 55m
         behind. That is arithmetically true and completely useless — you
         cannot be behind on a day that has not finished. A mis-tap has no
         balance for the same reason: there was no day.

         Consumers must handle null. account.js and account-admin.js print a
         dash for it, which is the honest thing to show. */
      balance: (d.open || mistap) ? null : d.seconds - target
    });
  });

  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return days;
}

/* =========================================================================
   The totals for a range.

   THREE KINDS OF DAY, AND ONLY ONE OF THEM CAN BE JUDGED.

     finished  a closed shift of real length. Counts towards hours AND
               towards what was expected. This is the only kind the balance
               is computed from.
     open      still running. The hours are real and are counted; the
               expectation is NOT, because a day in progress cannot be
               behind. Charging it a full six hours the moment somebody
               clocks in is what made an employee at her desk read as five
               hours short.
     mis-tap   clocked in and out again within two minutes. Neither hours
               nor expectation — there was no day. Counted separately so it
               is visible rather than silently dropped.

   `seconds` is every second actually recorded, including open and mis-tap,
   because "how long have I been here" should not lie. `expected` and
   `balance` describe finished days only, because those are the only ones
   there is anything to say about.
   ========================================================================= */
export function summarise(days, env) {
  const target = targetSeconds(env);
  const all = days || [];

  const recorded = all.filter((d) => (d.sessions ? d.sessions.length > 0 : d.seconds > 0));
  const mistaps = recorded.filter((d) => d.mistap);
  const openDays = recorded.filter((d) => d.open);
  /* Counted by "did they clock in", not "did the total round above zero" —
     otherwise a genuinely short shift silently vanishes from the month. The
     mis-tap exclusion is a different thing: those are not short days, they
     are non-days. */
  const finished = recorded.filter((d) => !d.open && !d.mistap);

  const finishedSeconds = finished.reduce((sum, d) => sum + d.seconds, 0);
  const openSeconds = openDays.reduce((sum, d) => sum + d.seconds, 0);
  const expected = finished.length * target;

  return {
    targetSeconds: target,
    /* Days there is something to judge. A mis-tap is not one of them, which
       is the whole fix: three rows where one was a four-second slip is two
       working days, not three. */
    daysWorked: finished.length,
    /* Everything recorded, so the hours on screen match the clock. */
    seconds: finishedSeconds + openSeconds + mistaps.reduce((s, d) => s + d.seconds, 0),
    expected,
    balance: finishedSeconds - expected,
    /* Surfaced so neither can hide: time on an unfinished day, and days that
       were a slip of the finger and want a manager's eye. */
    openSeconds,
    mistaps: mistaps.length
  };
}
