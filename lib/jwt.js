/* =========================================================================
   RS256 ID-token verification.

   Firebase Auth hands us a JWT signed by Google infrastructure
   (lib/firebase.js), and this does the signature check, the key fetching and
   the key-rotation handling for it.

   It is written as a general verifier rather than a Firebase-specific one
   because it used to have two callers: Google Identity Services tokens went
   through here as well, via a lib/google.js that no longer exists. That path
   was retired when the site moved to a single sign-in stack — see the note in
   public/account.js. The shape is worth keeping: a caller supplies only what
   differs (key set URL, expected issuer, expected audience), so a second
   provider can be added later without a second copy of this code, which is
   how the two copies would start drifting.

   Every check below matters:

     alg/kid    — pinned to RS256 with a key id. Accepting whatever the token
                  names is how "alg: none" and HMAC-with-the-public-key
                  forgeries get in.
     signature  — proves Google minted it and nobody edited the claims.
     iss        — must be the issuer the caller expects.
     aud        — must be OUR application. Without this, a token minted for
                  any other project would be accepted. This is the check
                  people leave out.
     exp / iat  — a token lives about an hour; a stolen old one is not valid.
   ========================================================================= */
import { ApiError } from './util.js';

/* Small clock tolerance. Workers clocks are good, but a token can
   legitimately arrive a second either side of a boundary. */
const SKEW_SEC = 60;

export function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlToJson(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

/* One cache entry per key-set URL, per isolate. Google rotates these keys and
   the response says how long it may be held; honouring that is what keeps a
   rotation from causing an hour of failed sign-ins. */
const caches = new Map();

async function fetchKeys(url, errCode, errMessage) {
  const now = Date.now();
  const hit = caches.get(url);
  if (hit && hit.keys && now < hit.expires) return hit.keys;

  const res = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new ApiError(502, errCode, errMessage);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) {
    throw new ApiError(502, errCode, 'The sign-in provider returned an unexpected key set.');
  }

  const cc = res.headers.get('cache-control') || '';
  const m = /max-age=(\d+)/.exec(cc);
  const ttl = m ? Math.min(86400, Math.max(300, parseInt(m[1], 10))) : 3600;
  caches.set(url, { keys: body.keys, expires: now + ttl * 1000 });
  return body.keys;
}

async function verifyWith(jwk, token) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const dot = token.lastIndexOf('.');
  const signed = new TextEncoder().encode(token.slice(0, dot));
  const sig = b64urlToBytes(token.slice(dot + 1));
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
}

async function verifySignature(token, kid, url, errCode, errMessage) {
  const keys = await fetchKeys(url, errCode, errMessage);
  const jwk = keys.find((k) => k.kid === kid);
  if (jwk) return verifyWith(jwk, token);

  /* Almost always a rotation we have cached past. Drop the cache and take one
     more look before calling it a forgery. */
  caches.delete(url);
  const fresh = await fetchKeys(url, errCode, errMessage);
  const retry = fresh.find((k) => k.kid === kid);
  return retry ? verifyWith(retry, token) : false;
}

/* -------------------------------------------------------------------------
   opts: { jwksUrl, issuers: [], audience, errCode, expiredCode, unavailable }

   Returns the verified claims. Throws ApiError on anything at all wrong —
   the caller never sees an unverified claim.
   ------------------------------------------------------------------------- */
export async function verifyIdToken(idToken, opts) {
  const bad = (message, code, status) =>
    new ApiError(status || 401, code || opts.errCode, message);

  if (typeof idToken !== 'string' || idToken.length < 40 || idToken.length > 8192) {
    throw bad('That sign-in could not be read. Please try again.', opts.errCode, 400);
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw bad('That sign-in could not be read. Please try again.', opts.errCode, 400);
  }

  let header, claims;
  try {
    header = b64urlToJson(parts[0]);
    claims = b64urlToJson(parts[1]);
  } catch (e) {
    throw bad('That sign-in could not be read. Please try again.', opts.errCode, 400);
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw bad('That sign-in was not signed in a form we accept.');
  }

  const ok = await verifySignature(
    idToken, header.kid, opts.jwksUrl, opts.unavailable || opts.errCode,
    'Could not reach the sign-in provider to verify the sign-in.'
  );
  if (!ok) throw bad('That sign-in could not be verified.');

  if (!opts.issuers.includes(claims.iss)) {
    throw bad('That sign-in did not come from the expected issuer.');
  }
  if (claims.aud !== opts.audience) {
    throw bad('That sign-in was issued for a different application.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_SEC < now) {
    throw bad('That sign-in has expired. Please try again.', opts.expiredCode || opts.errCode);
  }
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_SEC > now) {
    throw bad('That sign-in is dated in the future.');
  }

  return claims;
}
