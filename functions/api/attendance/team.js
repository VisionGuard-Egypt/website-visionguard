/* GET /api/attendance/team?date=YYYY-MM-DD&days=7

   The manager's timesheet: every staff account, for one Cairo day, plus a
   rolling range behind it. It answers one question directly — did everybody
   clock in, clock out, and record the full contracted day.

   Admin only, enforced here on the server. The tab is hidden in the UI for
   everyone else, but that is presentation; this is the control. See
   lib/auth.js -> requireAdmin.

   Two things it does NOT do, deliberately:

   - it does not edit anything. Correcting a forgotten clock-out is a
     conversation and then a database change, not a button that rewrites an
     employment record from a browser session.
   - it does not expose customer or order data. An admin here sees times and
     names of employees, nothing else.
*/
import { json, handle, ApiError, cairoDate, TZ } from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireAdmin, isAdminUser, STAFF_DOMAIN } from '../../../lib/auth.js';
import { closeStale, groupDays, summarise, targetSeconds } from '../../../lib/attendance.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* A day for one person, in the shape the timesheet renders.

   `absent` and "recorded but empty" are kept apart here for the same reason
   lib/attendance.js keeps them apart: on a timesheet, "did not come in" and
   "came in and something went wrong with the record" must never look alike.*/
function dayDetail(day, date, target) {
  if (!day || !day.sessions.length) {
    return {
      date, seconds: 0, status: 'absent', balance: -target,
      open: false, firstIn: null, lastOut: null, sessions: []
    };
  }
  /* groupDays keeps sessions in the order the rows arrived — newest first. */
  const first = day.sessions[day.sessions.length - 1];
  const last = day.sessions[0];
  return {
    date,
    seconds: day.seconds,
    status: day.status,
    balance: day.balance,
    open: day.open,
    firstIn: first.in,
    lastOut: day.open ? null : last.out,
    sessions: day.sessions
  };
}

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  await requireAdmin(context, d1);

  const url = new URL(request.url);

  const dateParam = (url.searchParams.get('date') || '').trim();
  if (dateParam && !DATE_RE.test(dateParam)) {
    throw new ApiError(400, 'bad_date', 'date must look like 2026-08-03.', { field: 'date' });
  }
  const today = cairoDate();
  /* A future date would return an empty sheet that reads like mass absence.
     Clamping to today makes that impossible to reach by editing the URL. */
  const date = dateParam && dateParam <= today ? dateParam : today;

  const requested = parseInt(url.searchParams.get('days') || '7', 10);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 31) : 7;

  /* The range ends on the day being viewed, not on today: picking a date last
     week should show that week, not a window that runs past it. */
  const to = date;
  const from = cairoDate(new Date(new Date(`${date}T12:00:00Z`).getTime() - (days - 1) * 86400000));

  const { results: staffRows } = await d1.prepare(
    `SELECT id, email, name, role
       FROM users
      WHERE lower(email) LIKE ?1
      ORDER BY name COLLATE NOCASE`
  ).bind('%@' + STAFF_DOMAIN).all();

  /* ADMINISTRATORS ARE NOT ON THE TIMESHEET.

     They watch attendance; they do not keep it. The owner does not clock in,
     so every day of theirs was being recorded as `absent` — a permanent red
     row in their own report, and worse, counted in the totals: a shop where
     both employees worked a full day still read "1 absent" forever, which is
     exactly the number this screen exists to make meaningful.

     Filtered here rather than by role in SQL because there are two ways to
     be an administrator — the role column and ADMIN_EMAILS — and lib/auth.js
     is the only thing that knows both. See isAdminUser. */
  const staff = (staffRows || []).filter((person) => !isAdminUser(env, person));
  const target = targetSeconds(env);
  const now = Date.now();

  /* Close forgotten shifts before reading, or one employee who never clocked
     out shows a shift 40 hours long and every total behind it is nonsense.
     Sequential rather than parallel: D1 gives a request one connection, and
     the staff list is a handful of rows. */
  for (const person of staff) {
    await closeStale(d1, person.id, env);
  }

  const people = [];
  for (const person of staff) {
    const { results } = await d1.prepare(
      `SELECT id, work_date, clock_in, clock_out, seconds, note
         FROM attendance
        WHERE user_id = ?1 AND work_date >= ?2 AND work_date <= ?3
        ORDER BY clock_in DESC`
    ).bind(person.id, from, to).all();

    const grouped = groupDays(results, env, now);
    const day = dayDetail(grouped.find((d) => d.date === date), date, target);

    people.push({
      id: person.id,
      name: person.name,
      email: person.email,
      admin: isAdminUser(env, person),
      day,
      days: grouped,
      summary: summarise(grouped, env)
    });
  }

  /* Sorted so the rows that need action are the ones you read first. */
  const ORDER = { absent: 0, short: 1, open: 2, complete: 3, overtime: 4 };
  people.sort((a, b) => {
    const d = (ORDER[a.day.status] ?? 9) - (ORDER[b.day.status] ?? 9);
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
  });

  const count = (status) => people.filter((p) => p.day.status === status).length;
  const totals = {
    staff: people.length,
    absent: count('absent'),
    short: count('short'),
    open: count('open'),
    complete: count('complete'),
    overtime: count('overtime'),
    seconds: people.reduce((sum, p) => sum + p.day.seconds, 0)
  };
  /* "Everyone did their six hours" means exactly that: nobody absent, nobody
     short, and nobody still clocked in — an open shift is not yet a finished
     day, however long it has run. */
  totals.allComplete = people.length > 0 &&
    totals.absent === 0 && totals.short === 0 && totals.open === 0;

  return json({
    ok: true,
    timezone: TZ,
    targetSeconds: target,
    date,
    isToday: date === today,
    range: { from, to, days },
    totals,
    staff: people
  });
});
