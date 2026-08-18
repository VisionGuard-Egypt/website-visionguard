/* GET /api/leave/certificate?id=<leave request id>

   The only way a sick note comes back out. There is deliberately no public
   route to these — nothing in functions/assets/ serves them, and the KV key
   is random rather than derived from anything guessable.

   WHO MAY READ ONE
   ----------------
   The person it belongs to, and an administrator. Not "any staff account":
   the two moderators have no business reading each other's medical
   documents, and a team being small is not a reason for the code to be
   relaxed about it — it is the reason nobody would notice if it were.

   The check is done against the ROW, after loading it by id, rather than by
   trusting anything in the request. An id is enough to ask; it is not enough
   to receive.
*/
import { handle, ApiError, clean } from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireStaff, isAdminUser } from '../../../lib/auth.js';
import { getCertificate } from '../../../lib/certificates.js';

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  const user = await requireStaff(context, d1);

  const id = clean(new URL(request.url).searchParams.get('id'), 64);
  if (!id) throw new ApiError(400, 'no_id', 'Which request?');

  const row = await d1.prepare(
    'SELECT id, user_id, cert_key, cert_name, cert_type FROM leave_requests WHERE id = ?1'
  ).bind(id).first();

  /* Same answer for "no such request" and "not yours".

     Telling the two apart would let somebody walk ids and learn which ones
     exist — and on this table the existence of a row is itself information
     about a colleague's health. */
  const mayRead = row && (row.user_id === user.id || isAdminUser(env, user));
  if (!mayRead) throw new ApiError(404, 'no_certificate', 'No certificate there.');
  if (!row.cert_key) throw new ApiError(404, 'no_certificate', 'No certificate there.');

  const stored = await getCertificate(env, row.cert_key);
  if (!stored) throw new ApiError(404, 'no_certificate', 'No certificate there.');

  const meta = stored.metadata || {};
  const type = meta.ct || row.cert_type || 'application/octet-stream';

  /* The filename is quoted and stripped of anything that could break out of
     the header — it came from the employee's own device. */
  const name = String(meta.name || row.cert_name || 'certificate')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(0, 100);

  return new Response(stored.body, {
    headers: {
      'content-type': type,
      /* inline, so an administrator can look at it without downloading a copy
         onto their machine. */
      'content-disposition': `inline; filename="${name}"`,
      /* NEVER cached, anywhere. Not by the browser, not by a proxy, not at
         Cloudflare's edge. This is the one response on the site where a
         cached copy outliving the permission check would be a real problem. */
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
      /* It is a document from an uploaded file. Stop it being framed, and
         stop any script inside a PDF reaching anything of ours. */
      'content-security-policy': "default-src 'none'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer'
    }
  });
});
