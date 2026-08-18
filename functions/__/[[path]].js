/* Firebase Auth helper, served from OUR origin.

   Everything under /__/ is proxied to the Firebase project's own host. It
   exists for two problems that turn out to be the same problem.

   1. THE CONSENT SCREEN SAID THE WRONG NAME. Google shows the host of the
      OAuth redirect_uri, and that host is Firebase's `authDomain`. With the
      default it reads "signing in to visionguard-7425d.firebaseapp.com" —
      a domain the customer has never heard of, on the one screen where you
      most want them to recognise where they are.

   2. SIGN-IN SILENTLY DID NOTHING FOR SOME PEOPLE. signInWithPopup opens
      the handler on the authDomain and the result comes back to this page
      through cross-origin storage. Safari, and Chrome as it winds down
      third-party cookies, block exactly that. The popup completes on
      Google's side, the opener never hears back, and the page just sits
      there still showing "sign in or create account" — no error, because
      from the page's point of view nothing failed. Firebase's own guidance
      for browsers that block third-party storage access is to serve the
      helper from your own domain, which is what this does.

   A PROXY, NOT A REDIRECT. The whole point is that the handler runs on
   visionguardeg.com so the storage it touches is first-party. A 302 to
   firebaseapp.com would put it straight back where it started.

   FIREBASE HOSTING WOULD DO THIS AUTOMATICALLY. This site is on Cloudflare
   Pages, so it has to be done here — the same job Firebase's nginx snippet
   does for people who reverse-proxy it themselves.
*/

/* The project's own Firebase host. Hardcoded rather than read from env: it
   is public (it is in public/firebase-auth.js), it is not a credential, and
   an unset variable here would mean a broken sign-in rather than a missing
   feature. It must match `projectId` in public/firebase-auth.js. */
const FIREBASE_HOST = 'https://visionguard-7425d.firebaseapp.com';

/* Hop-by-hop and Cloudflare-added headers that must not be forwarded to the
   origin, plus the ones that would make the response wrong on the way back. */
const STRIP_REQUEST = ['host', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'x-forwarded-proto', 'x-real-ip'];
const STRIP_RESPONSE = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  /* Only /__/ is proxied, and only ever to the one host above. The path is
     rebuilt from the parsed URL rather than concatenated from user input, so
     a crafted path cannot walk out of the prefix and turn this into an open
     proxy. */
  if (!url.pathname.startsWith('/__/')) {
    return new Response('Not found', { status: 404 });
  }

  const target = FIREBASE_HOST + url.pathname + url.search;

  const headers = new Headers(request.headers);
  for (const h of STRIP_REQUEST) headers.delete(h);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      /* GET and HEAD carry no body; passing one is a TypeError. */
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
      redirect: 'manual'
    });
  } catch (err) {
    console.error('firebase auth proxy', err && err.message);
    return new Response('Sign-in helper is unavailable.', { status: 502 });
  }

  const out = new Headers(upstream.headers);
  for (const h of STRIP_RESPONSE) out.delete(h);
  /* The handler carries a one-time state; a cached copy of it is a broken
     sign-in for the next person through. */
  out.set('cache-control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out
  });
}
