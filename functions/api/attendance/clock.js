/* POST /api/attendance/clock  { action: "in" | "out", note?: string }

   Times come from the server clock, never from the browser. A device whose
   clock is wrong — or set wrong on purpose — cannot change a shift length.
   The database also carries a partial unique index that makes a second open
   shift impossible, so a double-tap or a racing second tab cannot create one.
*/
import {
  json, handle, readJson, requireSameOrigin, ApiError,
  clean, clientIp, cairoDate, cairoTime
} from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireStaff, randomId, adminEmails, STAFF_DOMAIN } from '../../../lib/auth.js';
import {
  closeStale, openShift, targetSeconds, elapsedSeconds, statusOf
} from '../../../lib/attendance.js';
import { staffRecipients, adminsAmong, notifyClock } from '../../../lib/notify.js';

/* Tell the administrators, without making the employee wait for it.

   Through waitUntil for the same reason the WhatsApp order alert is: the
   person tapping the button is standing there, and a notification is a
   consequence of the shift being recorded rather than part of recording it.
   notify() swallows its own errors, so nothing in here can turn a successful
   clock-in into a failed one. */
function announceClock(context, d1, user, action, at) {
  context.waitUntil((async () => {
    const staff = await staffRecipients(d1, STAFF_DOMAIN);
    const admins = adminsAmong(staff, adminEmails(context.env));
    await notifyClock(d1, admins, user, action, at);
  })().catch((err) => console.error('clock notify', err && err.message)));
}

async function secondsToday(d1, userId, date, now) {
  const { results } = await d1.prepare(
    'SELECT clock_in, clock_out, seconds FROM attendance WHERE user_id = ?1 AND work_date = ?2'
  ).bind(userId, date).all();
  return (results || []).reduce((sum, r) => {
    if (r.clock_out === null || r.clock_out === undefined) return sum + elapsedSeconds(r.clock_in, now);
    return sum + (Number(r.seconds) || 0);
  }, 0);
}

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const user = await requireStaff(context, d1);
  await enforceRate(d1, `clock:${user.id}`, 40, 3600);

  const body = await readJson(request);
  const action = body.action === 'out' ? 'out' : body.action === 'in' ? 'in' : '';
  if (!action) throw new ApiError(400, 'bad_action', 'action must be "in" or "out".', { field: 'action' });

  await closeStale(d1, user.id, env);

  const nowDate = new Date();
  const now = nowDate.getTime();
  const iso = nowDate.toISOString();
  const ip = clientIp(request);
  const target = targetSeconds(env);
  const note = clean(body.note, 200);

  const open = await openShift(d1, user.id);

  if (action === 'in') {
    if (open) {
      throw new ApiError(409, 'already_in', 'You are already clocked in.', {
        clockIn: open.clock_in,
        seconds: elapsedSeconds(open.clock_in, now)
      });
    }
    const id = randomId(12);
    const workDate = cairoDate(nowDate);
    try {
      await d1.prepare(
        `INSERT INTO attendance (id, user_id, work_date, clock_in, in_ip, note)
         VALUES (?1,?2,?3,?4,?5,?6)`
      ).bind(id, user.id, workDate, iso, ip, note || null).run();
    } catch (err) {
      /* The partial unique index caught a race with another tab. */
      if (String(err && err.message).includes('UNIQUE')) {
        throw new ApiError(409, 'already_in', 'You are already clocked in.');
      }
      throw err;
    }

    announceClock(context, d1, user, 'in', cairoTime(nowDate));

    const dayTotal = await secondsToday(d1, user.id, workDate, now);
    return json({
      ok: true,
      action: 'in',
      shift: { id, clockIn: iso, seconds: 0 },
      at: cairoTime(nowDate),
      date: workDate,
      todaySeconds: dayTotal,
      targetSeconds: target
    }, 201);
  }

  /* ---- clock out ---- */
  if (!open) {
    throw new ApiError(409, 'not_in', 'You are not clocked in right now.');
  }

  const seconds = elapsedSeconds(open.clock_in, now);
  await d1.prepare(
    `UPDATE attendance
        SET clock_out = ?1, seconds = ?2, out_ip = ?3,
            note = COALESCE(NULLIF(?4, ''), note)
      WHERE id = ?5 AND clock_out IS NULL`
  ).bind(iso, seconds, ip, note, open.id).run();

  announceClock(context, d1, user, 'out', cairoTime(nowDate));

  const dayTotal = await secondsToday(d1, user.id, open.work_date, now);
  return json({
    ok: true,
    action: 'out',
    shift: { id: open.id, clockIn: open.clock_in, clockOut: iso, seconds },
    at: cairoTime(nowDate),
    date: open.work_date,
    todaySeconds: dayTotal,
    targetSeconds: target,
    status: statusOf(dayTotal, target),
    balance: dayTotal - target
  });
});
