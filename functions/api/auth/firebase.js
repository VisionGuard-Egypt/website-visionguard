/* POST /api/auth/firebase   { idToken, name?, phone?, terms?, newsletter?, marketing?, lang? }

   Exchanges a Firebase ID token for this site's own session cookie.

   Firebase is the credential authority: it holds the password, sends the
   reset email, runs the Google provider and rate-limits all three. D1 remains
   the record store — role, staff flag, consents, orders, attendance — because
   every one of those is keyed by users.id and none of them means anything to
   Firebase. This endpoint is the join, and it is the only place a Firebase
   identity turns into a Vision Guard session.

   ---------------------------------------------------------------------------
   The linking rules, which are the whole security of this file
   ---------------------------------------------------------------------------
   1. Known firebase_uid  -> that account. The uid is stable for the life of
      the Firebase account; an email address is not, and must never be the
      key.

   2. Unknown uid, but the address matches an existing row:

        verified address   -> link. They demonstrably control the mailbox, so
                              they are the person that row belongs to.

        unverified address -> REFUSED. This is the takeover: Firebase does not
                              verify an address at password sign-up, so
                              without this rule anyone could register
                              admin@visionguardeg.com in Firebase and inherit
                              the administrator row sitting in D1. Making them
                              click the verification email first closes it.

   3. Unknown uid, unknown address -> a new customer account, with whatever
      consent the sign-up form actually collected.

   Administrator addresses can never create a row here (rule 3 refuses them),
   exactly as they cannot through /api/auth/signup. They can only ever arrive
   at an existing admin row through rule 2, which requires a verified mailbox.
*/
import {
  json, handle, readJson, requireSameOrigin, ApiError,
  clean, normPhoneEg, clientIp
} from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import {
  signSession, sessionCookie, randomId, publicUser, isStaffEmail,
  secretOf, adminEmails, GOOGLE_ONLY_PW
} from '../../../lib/auth.js';
import { verifyFirebaseIdToken, firebaseProjectId } from '../../../lib/firebase.js';

const SELECT = `SELECT id, email, name, phone, role, marketing, newsletter, lang, avatar, created_at
                  FROM users`;

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);
  secretOf(env);                     // fail loudly and early if unconfigured
  const projectId = firebaseProjectId(env);

  const d1 = await db(env);
  await enforceRate(d1, `fbauth:${clientIp(request)}`, 30, 3600);

  const body = await readJson(request);
  const profile = await verifyFirebaseIdToken(body.idToken, projectId);

  const lang = body.lang === 'en' ? 'en' : 'ar';
  const now = new Date().toISOString();

  /* ---- 1. known uid ---- */
  let row = await d1.prepare(`${SELECT} WHERE firebase_uid = ?1`).bind(profile.uid).first();
  let created = false;

  if (!row) {
    const byEmail = await d1.prepare(`${SELECT} WHERE email = ?1`).bind(profile.email).first();

    if (byEmail) {
      /* ---- 2. same address, different (or first) Firebase account ---- */
      if (!profile.emailVerified) {
        throw new ApiError(
          403, 'email_unverified',
          'Check your inbox and confirm your email address, then sign in again.',
          { email: profile.email }
        );
      }
      await d1.prepare('UPDATE users SET firebase_uid = ?1 WHERE id = ?2')
        .bind(profile.uid, byEmail.id).run();
      row = byEmail;
    } else {
      /* ---- 3. a new account ---- */
      if (adminEmails(env).includes(profile.email)) {
        /* Same wording as an ordinary clash, so this cannot be used to
           discover which addresses are privileged. */
        throw new ApiError(409, 'email_taken', 'An account already exists with that email. Try signing in.', { field: 'email' });
      }

      const name = clean(body.name, 120) || clean(profile.name, 120) || profile.email.split('@')[0];
      const phone = body.phone ? normPhoneEg(body.phone, 'phone', true) : '';
      const marketing = body.marketing === true ? 1 : 0;
      const newsletter = body.newsletter === true ? 1 : 0;
      const role = isStaffEmail(profile.email) ? 'staff' : 'customer';

      /* The consent is recorded as given only when the form actually
         collected it. A sign-IN never sets it, so an account created before
         the box existed does not silently acquire one. */
      const termsAt = body.terms === true ? now : null;

      const id = randomId(16);
      try {
        await d1.prepare(
          `INSERT INTO users
             (id, email, name, phone, pw_hash, firebase_uid, role, marketing, newsletter,
              terms_at, lang, created_at, last_login_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)`
        ).bind(
          id, profile.email, name, phone || null, GOOGLE_ONLY_PW, profile.uid,
          role, marketing, newsletter, termsAt, lang, now
        ).run();
        created = true;
        row = {
          id, email: profile.email, name, phone, role,
          marketing, newsletter, lang, created_at: now
        };
      } catch (err) {
        /* Two tabs racing, or an account created between the two SELECTs. */
        if (String(err && err.message).includes('UNIQUE')) {
          row = await d1.prepare(`${SELECT} WHERE firebase_uid = ?1 OR email = ?2`)
            .bind(profile.uid, profile.email).first();
          if (!row) throw err;
        } else {
          throw err;
        }
      }

      if (newsletter) {
        try {
          await d1.prepare(
            `INSERT INTO newsletter (email, name, marketing, source, lang, created_at)
             VALUES (?1,?2,?3,'signup',?4,?5)
             ON CONFLICT(email) DO UPDATE SET
               marketing = MAX(newsletter.marketing, ?3),
               unsub_at  = NULL`
          ).bind(profile.email, row.name, marketing, lang, now).run();
        } catch (err) {
          console.error('newsletter at firebase signup', err && err.message);
        }
      }
    }
  }

  await d1.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2').bind(now, row.id).run();

  const token = await signSession(env, row.id);
  return json(
    { ok: true, created, user: publicUser(row, env) },
    created ? 201 : 200,
    { 'set-cookie': sessionCookie(request, token) }
  );
});
