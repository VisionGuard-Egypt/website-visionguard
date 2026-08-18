/* GET  /api/admin/leave?status=pending    the queue
   POST /api/admin/leave                   { id, action: 'approve'|'decline', note? }

   Administrators only, enforced here — see lib/auth.js -> requireAdmin.

   This is where somebody's time off is actually granted, so the write is
   conditional on the row still being pending. Two administrators looking at
   the same queue is not a hypothetical in a team this size, and the second
   one's click must not silently overwrite the first one's decision.
*/
import { json, handle, readJson, requireSameOrigin, ApiError, clean, cairoDate } from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import { balance, VACATION_DAYS_PER_YEAR } from '../../../lib/leave.js';
import { notifyLeaveDecision } from '../../../lib/notify.js';

const STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'all'];

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  await requireAdmin(context, d1);

  const asked = new URL(context.request.url).searchParams.get('status') || 'pending';
  const status = STATUSES.includes(asked) ? asked : 'pending';
  const where = status === 'all' ? '' : 'WHERE r.status = ?1';
  const binds = status === 'all' ? [] : [status];

  /* LEFT JOIN so a request does not vanish from the queue if the account that
     made it was removed — an administrator still needs to see it and clear it. */
  const { results } = await d1.prepare(
    `SELECT r.*, u.name AS who_name, u.email AS who_email
       FROM leave_requests r
       LEFT JOIN users u ON u.id = r.user_id
       ${where}
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100`
  ).bind(...binds).all();

  const rows = results || [];

  /* How much each of these people has already committed this year, so the
     administrator can see "this would take them to 12 of 14" at the moment
     of deciding rather than having to work it out. One grouped query, not
     one per row. */
  const year = String(cairoDate().slice(0, 4));
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const takenBy = new Map();
  if (ids.length) {
    const holes = ids.map((_, i) => `?${i + 2}`).join(',');
    const { results: sums } = await d1.prepare(
      `SELECT user_id, COALESCE(SUM(days), 0) AS n
         FROM leave_requests
        WHERE kind = 'vacation'
          AND status IN ('approved', 'pending')
          AND substr(start_date, 1, 4) = ?1
          AND user_id IN (${holes})
        GROUP BY user_id`
    ).bind(year, ...ids).all();
    for (const s of sums || []) takenBy.set(s.user_id, Number(s.n) || 0);
  }

  return json({
    ok: true,
    status,
    year: Number(year),
    allowance: VACATION_DAYS_PER_YEAR,
    requests: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      startDate: r.start_date,
      endDate: r.end_date,
      days: r.days,
      note: r.note || '',
      status: r.status,
      hasCertificate: !!r.cert_key,
      certificateName: r.cert_name || '',
      decidedAt: r.decided_at || '',
      decisionNote: r.decision_note || '',
      createdAt: r.created_at,
      who: {
        id: r.user_id,
        name: r.who_name || 'Removed account',
        email: r.who_email || ''
      },
      balance: balance(takenBy.get(r.user_id) || 0)
    }))
  });
});

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);
  const body = await readJson(request);

  const id = clean(body.id, 64);
  const action = body.action === 'approve' ? 'approve' : body.action === 'decline' ? 'decline' : '';
  if (!id || !action) {
    throw new ApiError(400, 'bad_request', 'Send an id and approve or decline.');
  }

  const row = await d1.prepare('SELECT * FROM leave_requests WHERE id = ?1').bind(id).first();
  if (!row) throw new ApiError(404, 'no_such_request', 'That request does not exist.');
  if (row.status !== 'pending') {
    throw new ApiError(409, 'already_decided',
      `That request was already ${row.status}.`, { status: row.status });
  }

  const status = action === 'approve' ? 'approved' : 'declined';
  const note = clean(body.note, 400);
  const now = new Date().toISOString();

  /* `AND status = 'pending'` is the whole point: if another administrator got
     there first between the read above and this write, this updates nothing
     and the check below turns that into an honest answer rather than a silent
     overwrite of their decision. */
  const res = await d1.prepare(
    `UPDATE leave_requests
        SET status = ?1, decided_by = ?2, decided_at = ?3, decision_note = ?4
      WHERE id = ?5 AND status = 'pending'`
  ).bind(status, admin.id, now, note || null, id).run();

  const changed = res && res.meta && typeof res.meta.changes === 'number' ? res.meta.changes : 1;
  if (changed === 0) {
    const fresh = await d1.prepare('SELECT status FROM leave_requests WHERE id = ?1').bind(id).first();
    throw new ApiError(409, 'already_decided',
      `Someone else answered that one first — it is ${fresh ? fresh.status : 'no longer pending'}.`);
  }

  context.waitUntil(
    notifyLeaveDecision(d1, row.user_id, {
      id, kind: row.kind, status,
      start_date: row.start_date, end_date: row.end_date,
      decision_note: note
    }).catch((err) => console.error('leave decision notify', err && err.message))
  );

  return json({ ok: true, id, status, decidedAt: now });
});
