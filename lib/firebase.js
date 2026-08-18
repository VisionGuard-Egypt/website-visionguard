/* =========================================================================
   Verifying a Firebase Auth ID token.

   Firebase owns the credentials now — the password, the reset email, the
   Google provider, the rate limiting on all three. What it does NOT own is
   who you are to this shop: the role, the staff flag, the order history and
   the attendance record all live in D1, keyed by users.id. This file is the
   join between the two.

   The browser signs in with Firebase, gets an ID token, and posts it to
   /api/auth/firebase. Everything that makes trusting that token safe happens
   here. A Firebase ID token is an ordinary RS256 JWT, so the signature and
   key handling are the shared ones in lib/jwt.js; what is specific to
   Firebase is which keys, which issuer and which audience:

     keys   the securetoken service account's public keys. Note this is the
            /service_accounts/v1/jwk/ endpoint, which serves JWK — not the
            /robot/v1/metadata/x509/ one, which serves X.509 certificates
            that WebCrypto cannot import without a PEM parser nobody wants.
     iss    https://securetoken.google.com/<project id>
     aud    <project id>

   The audience check is what stops a token minted by SOMEBODY ELSE'S
   Firebase project from signing in here. Anyone can create a Firebase
   project; without this check, anyone could mint a token claiming any email
   address and take over the matching account.

   sub is the Firebase uid — stable for the life of the account, and what we
   store. Email addresses are not stable and must never be the key.
   ========================================================================= */
import { ApiError } from './util.js';
import { verifyIdToken } from './jwt.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/* The project id is not a secret — it ships in the browser config on every
   site that uses Firebase — so it lives in wrangler.toml [vars] rather than
   in secrets.

   It has a default rather than being purely configuration, and that is a
   lesson this repository has already paid for once: wrangler.toml [vars] did
   not reach the running Function on this Pages project, WHATSAPP_TEMPLATE was
   empty at runtime, and every order alert silently took a path that could not
   deliver (see lib/whatsapp.js). The identical failure here would be worse —
   an empty audience means no sign-in at all — so the value that must match
   public/firebase-auth.js is written down in both places. An env var still
   wins if one is ever set.

   It is a project identifier, not a credential: knowing it grants nothing.
   What it does is pin the audience, so a token minted by any OTHER Firebase
   project is rejected. */
const DEFAULT_PROJECT_ID = 'visionguard-7425d';

export function firebaseProjectId(env) {
  const v = env && typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID.trim() : '';
  return v || DEFAULT_PROJECT_ID;
}

export async function verifyFirebaseIdToken(idToken, projectId) {
  const claims = await verifyIdToken(idToken, {
    jwksUrl: JWKS_URL,
    issuers: ['https://securetoken.google.com/' + projectId],
    audience: projectId,
    errCode: 'bad_firebase_token',
    expiredCode: 'firebase_expired',
    unavailable: 'firebase_unavailable'
  });

  if (!claims.sub || typeof claims.sub !== 'string') {
    throw new ApiError(401, 'bad_firebase_token', 'That sign-in is missing an account id.');
  }
  /* auth_time is when the user actually proved who they were. A token can be
     refreshed for a year off one sign-in, so this is the honest answer to
     "how long ago did they authenticate". */
  const authTime = Number.isFinite(claims.auth_time) ? claims.auth_time : null;

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) {
    throw new ApiError(
      401, 'firebase_no_email',
      'That sign-in has no email address attached, so it cannot be used here.'
    );
  }

  const provider = (claims.firebase && claims.firebase.sign_in_provider) || 'unknown';

  /* An unverified address is accepted ONLY when it cannot be used to take
     over an existing account — see the linking rules in
     functions/api/auth/firebase.js. Firebase does not verify an address at
     password sign-up until the user clicks the email, and refusing to let
     them in until then would strand every new customer. So the flag is
     passed through honestly rather than being asserted here, and the
     endpoint decides what it is allowed to do with it. */
  return {
    uid: String(claims.sub),
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name : '',
    provider,
    authTime
  };
}
