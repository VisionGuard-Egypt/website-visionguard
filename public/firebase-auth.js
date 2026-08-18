/* =========================================================================
   Vision Guard — firebase-auth.js

   Firebase Auth, loaded straight from Google's CDN as ES modules. There is no
   bundler in this project, so the `import { initializeApp } from "firebase/app"`
   form that Firebase's own docs give you cannot work here — a bare specifier
   like "firebase/app" is not something a browser can resolve. The npm package
   is equally useless without a build step. The gstatic build below is the
   same code, published as real modules with real URLs.

   The version is pinned. An unpinned CDN import means Google can change the
   code running on this page without a deploy, and an auth library is the last
   place to want that.

   WHAT LIVES WHERE
   ----------------
   Firebase holds the credentials: the password, the reset email, the Google
   provider, and the rate limiting on all three. It does NOT decide who you
   are to this shop. The browser signs in here, gets an ID token, and posts it
   to /api/auth/firebase, which verifies the signature server-side and mints
   this site's own session cookie. Roles, staff status, orders and attendance
   all continue to key off the D1 user record. See lib/firebase.js.

   Nothing here is a secret. A Firebase web config is public by design — it
   identifies the project, it does not authorise anything. The security is the
   audience check on the server plus the provider rules in the Firebase
   console.
   ========================================================================= */
const SDK = 'https://www.gstatic.com/firebasejs/12.17.0/';

/* THE DOMAIN GOOGLE SHOWS, AND THE ONE THE POPUP TALKS TO.

   This is our own domain, not visionguard-7425d.firebaseapp.com, and it is
   load-bearing twice over:

     The consent screen reads "signing in to <this>". Customers were being
     asked to sign in to a firebaseapp.com address they have never heard of.

     signInWithPopup opens <this>/__/auth/handler and passes the result back
     through storage on that origin. When it is a third-party domain, Safari
     and Chrome's third-party-storage restrictions can block the handshake:
     the popup finishes, the opener never hears back, and the page sits there
     still showing the sign-in form with no error at all. Serving the handler
     first-party is Firebase's own recommended fix.

   IT ONLY WORKS BECAUSE /__/ IS PROXIED — see functions/__/[[path]].js. That
   proxy has to be deployed for this value to be usable; without it every
   Google sign-in 404s at the handler.

   TWO CONSOLE SETTINGS BELONG TO THIS LINE. If Google starts refusing with
   redirect_uri_mismatch, one of them is missing:

     Google Cloud console -> APIs & Services -> Credentials -> the OAuth 2.0
     client for this project -> Authorised redirect URIs must include
       https://visionguardeg.com/__/auth/handler

     Firebase console -> Authentication -> Settings -> Authorised domains
     must include visionguardeg.com

   To revert, put 'visionguard-7425d.firebaseapp.com' back here. Nothing else
   in this file depends on the choice. */
const AUTH_DOMAIN = 'visionguardeg.com';

const CONFIG = {
  apiKey: 'AIzaSyAhtUvqMWOeeL6zh-Dn4-NhIux3vFFKnZQ',
  authDomain: AUTH_DOMAIN,
  projectId: 'visionguard-7425d',
  storageBucket: 'visionguard-7425d.firebasestorage.app',
  messagingSenderId: '54729456085',
  appId: '1:54729456085:web:14d275585c11b2136a655c'
  /* measurementId is deliberately absent: Analytics is not loaded here. It is
     a separate product with its own privacy consequences, and this file does
     authentication. */
};

/* One load, one app, however many callers. */
let loading = null;

async function sdk() {
  if (!loading) {
    loading = (async () => {
      const [app, auth] = await Promise.all([
        import(SDK + 'firebase-app.js'),
        import(SDK + 'firebase-auth.js')
      ]);
      const instance = auth.getAuth(app.initializeApp(CONFIG));
      /* Firebase keeps its own session in IndexedDB. Ours is the cookie the
         server sets, and that is the one that authorises anything — so
         Firebase's copy is kept only for the length of the tab. Two session
         lifetimes that disagree is a bug generator, and the shorter one
         belongs to the party that is not the authority. */
      await auth.setPersistence(instance, auth.inMemoryPersistence);
      instance.useDeviceLanguage();
      return { ...auth, instance };
    })().catch((err) => {
      loading = null;                 // a blocked CDN must not poison retries
      throw err;
    });
  }
  return loading;
}

/* Whether Firebase can be reached at all. The CDN is a third-party host: an
   ad blocker, a corporate proxy or a bad day at Google all end here, and the
   page needs to say something honest rather than hang on a dead button. */
export async function firebaseReady() {
  try {
    await sdk();
    return true;
  } catch (e) {
    console.error('firebase load', e && e.message);
    return false;
  }
}

/* -------------------------------------------------------------------------
   Firebase's error codes -> the codes site.js already has Arabic for.

   Left unmapped, every failure reaches the customer as
   "Firebase: Error (auth/invalid-credential)." in English, on an
   Arabic-first page.
   ------------------------------------------------------------------------- */
const CODES = {
  'auth/invalid-credential':       'bad_credentials',
  'auth/wrong-password':           'bad_credentials',
  'auth/user-not-found':           'bad_credentials',
  'auth/invalid-login-credentials':'bad_credentials',
  'auth/email-already-in-use':     'email_taken',
  'auth/weak-password':            'weak_password',
  'auth/invalid-email':            'bad_email',
  'auth/missing-password':         'missing_field',
  'auth/too-many-requests':        'rate_limited',
  'auth/network-request-failed':   'network',
  'auth/user-disabled':            'account_disabled',
  'auth/popup-blocked':            'popup_blocked',
  'auth/popup-closed-by-user':     'cancelled',
  'auth/cancelled-popup-request':  'cancelled',
  'auth/operation-not-allowed':    'provider_disabled',
  'auth/unauthorized-domain':      'unauthorized_domain',
  /* Firebase refuses a password change on a session it considers stale.
     changePassword() reauthenticates first so this should be rare, but it
     also fires when the tab was reloaded since sign-in and Firebase's
     in-memory copy of the user is gone. */
  'auth/requires-recent-login':    'signin_again',
  /* Not a user error at all: Authentication has never been switched on for
     the Firebase project, so there is no provider configuration to sign in
     against. Worth its own message, because everything else about the page
     looks fine and the generic "try again" sends you debugging the wrong
     end. Fix: Firebase console -> Authentication -> Get started. */
  'auth/configuration-not-found':  'auth_not_enabled'
};

export class FirebaseAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function translate(err) {
  const raw = (err && err.code) || '';
  const code = CODES[raw] || 'auth_failed';
  /* Firebase prefixes its own messages with "Firebase: ". Strip it — the
     customer did not ask which vendor is involved. */
  const message = String((err && err.message) || 'Sign-in failed.')
    .replace(/^Firebase:\s*/, '')
    .replace(/\s*\(auth\/[a-z-]+\)\.?$/, '');
  return new FirebaseAuthError(code, message || 'Sign-in failed.');
}

async function run(fn) {
  let api;
  try {
    api = await sdk();
  } catch (e) {
    throw new FirebaseAuthError('firebase_unavailable', 'Could not load the sign-in service.');
  }
  try {
    return await fn(api);
  } catch (err) {
    throw translate(err);
  }
}

/* -------------------------------------------------------------------------
   The four things the account page can do
   ------------------------------------------------------------------------- */
export function emailSignIn(email, password) {
  return run((api) => api.signInWithEmailAndPassword(api.instance, String(email).trim(), password));
}

export function emailSignUp(email, password) {
  return run((api) => api.createUserWithEmailAndPassword(api.instance, String(email).trim(), password));
}

export function googleSignIn() {
  return run((api) => {
    const provider = new api.GoogleAuthProvider();
    /* Always ask which account. Silently reusing whichever Google session the
       browser happens to hold is how people end up signed in as someone
       else's account on a shared machine. */
    provider.setCustomParameters({ prompt: 'select_account' });
    return api.signInWithPopup(api.instance, provider);
  });
}

export function passwordReset(email) {
  return run((api) => api.sendPasswordResetEmail(api.instance, String(email).trim()));
}

/* Change the password of the account signed in RIGHT NOW.

   Two steps and both are required. Firebase refuses updatePassword on a
   session it considers stale — anything more than a few minutes old — with
   auth/requires-recent-login, so the current password is used to
   reauthenticate first. That is not a workaround; it is the same protection
   /api/account/password enforces for local accounts, and for the same
   reason: a thirty-day cookie survives an unlocked laptop, and without
   proving the current password anyone sitting at one could lock the owner
   out for good.

   THE CATCH THAT MATTERS. This site's session is its own cookie and does not
   depend on Firebase, so a password change here does not sign anybody out
   and does not need to. Firebase's own persistence is inMemory (see sdk()
   above), which is why `instance.currentUser` can be null on a page that was
   reloaded since sign-in — that case is reported honestly rather than
   pretended away, because the alternative is a form that silently does
   nothing. */
export async function changePassword(currentPassword, newPassword) {
  return run(async (api) => {
    const user = api.instance.currentUser;
    if (!user || !user.email) {
      throw { code: 'auth/requires-recent-login' };
    }
    const credential = api.EmailAuthProvider.credential(user.email, currentPassword);
    await api.reauthenticateWithCredential(user, credential);
    await api.updatePassword(user, newPassword);
    return true;
  });
}

/* Whether Firebase currently holds a signed-in user in this tab. The account
   page uses it to decide which half of the change flow to try first. */
export async function firebaseUser() {
  try {
    const api = await sdk();
    return api.instance.currentUser || null;
  } catch (e) {
    return null;
  }
}

/* Sent after a password sign-up so the address can be linked to an existing
   record later — see the linking rules in functions/api/auth/firebase.js.
   Never allowed to fail the sign-up itself: the account exists either way. */
export async function sendVerification(credential) {
  try {
    const api = await sdk();
    if (credential && credential.user) await api.sendEmailVerification(credential.user);
    return true;
  } catch (err) {
    console.error('verification email', err && err.message);
    return false;
  }
}

export async function firebaseSignOut() {
  try {
    const api = await sdk();
    await api.signOut(api.instance);
  } catch (e) { /* our cookie is the session that matters; it is already gone */ }
}

/* The ID token for a credential. Kept in a variable and posted once — never
   stored, because our session cookie is what persists. */
export async function idTokenOf(credential) {
  if (!credential || !credential.user) {
    throw new FirebaseAuthError('auth_failed', 'Sign-in did not return an account.');
  }
  return credential.user.getIdToken();
}

export function emailVerifiedOf(credential) {
  return !!(credential && credential.user && credential.user.emailVerified);
}
