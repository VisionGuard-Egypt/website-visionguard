/* GET  /api/leave              the caller's own requests, balance and calendar
   POST /api/leave              submit one (multipart when a sick note rides along)
   POST /api/leave  {cancel:id} withdraw one that has not been answered yet

   Staff only. Every statement is scoped to the caller — an administrator
   reviewing other people's requests uses /api/admin/leave, not this.
*/
import {
  json, handle, requireSameOrigin, ApiError, clean, cairoDate
} from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireStaff, randomId, adminEmails, STAFF_DOMAIN } from '../../../lib/auth.js';
import {
  LEAVE_KINDS, VACATION_DAYS_PER_YEAR, MAX_REQUEST_DAYS,
  countDays, checkRange, yearOf, balance, holidaysIn
} from '../../../lib/leave.js';
import { putCertificate, deleteCertificate, MAX_CERT_BYTES } from '../../../lib/certificates.js';
import { staffRecipients, adminsAmong, notifyLeaveRequest } from '../../../lib/notify.js';

/* Turned into an ApiError here rather than in lib/leave.js, so that file stays
   free of HTTP and can be tested without one. */
const RANGE_ERRORS = {
  bad_start: ['bad_start', 'That start date is not a real date.', 'startDate'],
  bad_end: ['bad_end', 'That end date is not a real date.', 'endDate'],
  end_before_start: ['end_before_start', 'The end date is before the start date.', 'endDate'],
  too_long: ['too_long', `A single request cannot be longer than ${MAX_REQUEST_DAYS} days.`, 'endDate']
};

/* Days already committed for a year: approved AND still pending.

   Pending has to count. Two requests submitted before either is answered
   would otherwise both pass the cap, and the administrator would approve them
   one at a time and only discover the overspend afterwards. */
async function daysTaken(d1, userId, year) {
  const row = await d1.prepare(
    `SELECT COALESCE(SUM(days), 0) AS n
       FROM leave_requests
      WHERE user_id = ?1
        AND kind = 'vacation'
        AND status IN ('approved', 'pending')
        AND substr(start_date, 1, 4) = ?2`
  ).bind(userId, String(year)).first();
  return Number(row && row.n) || 0;
}

function publicRequest(r) {
  return {
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
    createdAt: r.created_at
  };
}

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);

  const year = Number(new URL(context.request.url).searchParams.get('year')) || Number(cairoDate().slice(0, 4));

  const [mine, taken] = await Promise.all([
    d1.prepare(
      `SELECT * FROM leave_requests WHERE user_id = ?1 ORDER BY start_date DESC LIMIT 60`
    ).bind(user.id).all(),
    daysTaken(d1, user.id, year)
  ]);

  return json({
    ok: true,
    year,
    balance: balance(taken),
    /* Sent so the form can show which days in a chosen range are public
       holidays. It does NOT change the arithmetic — every day in a range is
       deducted, holiday or not. See the header of lib/leave.js. */
    holidays: holidaysIn(`${year}-01-01`, `${year}-12-31`),
    holidaysCountAgainstAllowance: true,
    maxRequestDays: MAX_REQUEST_DAYS,
    allowance: VACATION_DAYS_PER_YEAR,
    requests: (mine.results || []).map(publicRequest)
  });
});

/* Both shapes, because a sick note has to ride along with the fields in one
   request. Reading the content type first — rather than calling formData()
   unconditionally — is the same lesson functions/api/admin/catalog.js records
   in its header: formData() on a JSON body throws, and the failure surfaces
   as a generic error with nothing pointing at the cause. */
async function readRequestBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const fields = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
    const file = form.get('certificate');
    return {
      fields,
      file: file && typeof file === 'object' && typeof file.arrayBuffer === 'function' ? file : null
    };
  }
  let parsed = {};
  try { parsed = await request.json(); } catch (e) { /* an empty body is {} */ }
  return { fields: parsed && typeof parsed === 'object' ? parsed : {}, file: null };
}

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const user = await requireStaff(context, d1);

  const { fields, file } = await readRequestBody(request);

  /* ---- withdrawing one ---- */
  if (fields.cancel) {
    const id = clean(fields.cancel, 64);
    const row = await d1.prepare(
      'SELECT id, status, cert_key FROM leave_requests WHERE id = ?1 AND user_id = ?2'
    ).bind(id, user.id).first();
    if (!row) throw new ApiError(404, 'no_such_request', 'That request does not exist.');
    if (row.status !== 'pending') {
      throw new ApiError(409, 'already_decided', 'That request has already been answered.');
    }
    await d1.prepare(
      `UPDATE leave_requests SET status = 'cancelled' WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`
    ).bind(id, user.id).run();
    /* The note goes with it. It was collected for a request that no longer
       exists, so there is no reason to keep holding it. */
    if (row.cert_key) context.waitUntil(deleteCertificate(env, row.cert_key));
    return json({ ok: true, id, status: 'cancelled' });
  }

  /* ---- submitting one ---- */
  await enforceRate(d1, `leave:${user.id}`, 20, 3600);

  const kind = LEAVE_KINDS.includes(fields.kind) ? fields.kind : '';
  if (!kind) throw new ApiError(400, 'bad_kind', 'Choose sick leave or vacation.', { field: 'kind' });

  const startDate = clean(fields.startDate, 10);
  const endDate = clean(fields.endDate, 10);
  const bad = checkRange(startDate, endDate);
  if (bad) {
    const [code, message, field] = RANGE_ERRORS[bad];
    throw new ApiError(400, code, message, { field });
  }

  const { days, holidays } = countDays(startDate, endDate);
  const note = clean(fields.note, 600);

  /* The cap applies to vacation only. Capping sick leave would push somebody
     to come in ill; the certificate is what controls that instead. */
  if (kind === 'vacation') {
    const year = yearOf(startDate);
    const taken = await daysTaken(d1, user.id, year);
    const bal = balance(taken);
    if (days > bal.remaining) {
      throw new ApiError(
        400, 'over_allowance',
        `That is ${days} days and you have ${bal.remaining} left for ${year}.`,
        { field: 'endDate', remaining: bal.remaining, requested: days, year }
      );
    }
  }

  /* A sick note is required, because it is the only thing making uncapped
     sick leave workable. Asked for plainly rather than accepted-then-chased. */
  let cert = null;
  if (kind === 'sick') {
    if (!file) {
      throw new ApiError(400, 'certificate_required', 'Attach the medical certificate.', { field: 'certificate' });
    }
    try {
      cert = await putCertificate(env, randomId(16), file);
    } catch (err) {
      const why = String(err && err.message);
      if (why === 'bad_type') {
        throw new ApiError(400, 'bad_certificate', 'Attach a photo or a PDF.', { field: 'certificate' });
      }
      if (why === 'too_large') {
        throw new ApiError(413, 'certificate_too_large',
          `That file is over ${Math.round(MAX_CERT_BYTES / 1024 / 1024)} MB.`, { field: 'certificate' });
      }
      if (why === 'empty_file') {
        throw new ApiError(400, 'bad_certificate', 'That file is empty.', { field: 'certificate' });
      }
      if (why === 'no_kv') {
        throw new ApiError(503, 'storage_off', 'File storage is not configured yet.');
      }
      throw err;
    }
  }

  const id = randomId(12);
  const now = new Date().toISOString();
  const row = {
    id, user_id: user.id, kind, start_date: startDate, end_date: endDate,
    days, note: note || null,
    cert_key: cert ? cert.key : null,
    cert_name: file ? clean(file.name, 120) : null,
    cert_type: file ? clean(file.type, 80) : null,
    status: 'pending', created_at: now
  };

  try {
    await d1.prepare(
      `INSERT INTO leave_requests
         (id, user_id, kind, start_date, end_date, days, note, cert_key, cert_name, cert_type, status, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11)`
    ).bind(
      row.id, row.user_id, row.kind, row.start_date, row.end_date, row.days,
      row.note, row.cert_key, row.cert_name, row.cert_type, row.created_at
    ).run();
  } catch (err) {
    /* The row failed, so the file it points at is now unreferenced. Clean it
       up rather than leaving a medical document in KV that nothing knows
       about and nothing will ever delete. */
    if (cert) context.waitUntil(deleteCertificate(env, cert.key));
    throw err;
  }

  context.waitUntil((async () => {
    const staff = await staffRecipients(d1, STAFF_DOMAIN);
    const admins = adminsAmong(staff, adminEmails(env));
    await notifyLeaveRequest(d1, admins, user, row);
  })().catch((err) => console.error('leave notify', err && err.message)));

  return json({
    ok: true,
    request: publicRequest(row),
    /* Echoed back so the confirmation can say what was spent, and on what. */
    holidaysInRange: holidays
  }, 201);
});
