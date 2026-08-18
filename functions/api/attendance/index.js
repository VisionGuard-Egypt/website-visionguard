/* GET /api/attendance?days=30
   The employee's own record. Staff-only, enforced server-side on the email
   domain — hiding the tab in the UI is presentation, not access control. */
import { json, handle, cairoDate, TZ } from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireStaff } from '../../../lib/auth.js';
import {
  closeStale, openShift, groupDays, summarise, targetSeconds, elapsedSeconds, statusOf
} from '../../../lib/attendance.js';

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  const user = await requireStaff(context, d1);

  await closeStale(d1, user.id, env);

  const url = new URL(request.url);
  const requested = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 180) : 30;

  const from = cairoDate(new Date(Date.now() - (days - 1) * 86400000));

  const { results } = await d1.prepare(
    `SELECT id, work_date, clock_in, clock_out, seconds, note
       FROM attendance
      WHERE user_id = ?1 AND work_date >= ?2
      ORDER BY clock_in DESC`
  ).bind(user.id, from).all();

  const now = Date.now();
  const grouped = groupDays(results, env, now);
  const today = cairoDate();
  const open = await openShift(d1, user.id);
  const target = targetSeconds(env);

  const todayRow = grouped.find((d) => d.date === today) ||
    { date: today, seconds: 0, open: false, sessions: [], target, status: 'absent', balance: -target };

  return json({
    ok: true,
    timezone: TZ,
    targetSeconds: target,
    today: todayRow,
    open: open
      ? { id: open.id, clockIn: open.clock_in, seconds: elapsedSeconds(open.clock_in, now) }
      : null,
    /* Status of the day the OPEN shift belongs to, which is not necessarily
       today once someone works past midnight. */
    openDayStatus: open ? statusOf(todayRow.seconds, target) : null,
    days: grouped,
    summary: summarise(grouped, env),
    range: { from, to: today, days }
  });
});
