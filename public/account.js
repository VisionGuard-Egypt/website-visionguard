/* =========================================================================
   Vision Guard — account.js
   Sign in / sign up, order history, consent preferences, the staff
   attendance tab and the administrator's team timesheet.

   The attendance tab is shown when the signed-in address is on the company
   domain, and the team tab when the account is an administrator — but
   showing either is only presentation. Every attendance endpoint re-checks
   server-side, so hiding a tab is a courtesy, not the control. See
   lib/auth.js -> requireStaff and requireAdmin.
   ========================================================================= */
import {
  $, $$, initChrome, onLang, LANG, t, money, currency, esc, api, toast,
  hoursLabel, hhmm, localDate, localTime, THEME, onTheme, ApiError, setStaffHint
} from './site.js?v=66';
import {
  firebaseReady, emailSignIn, emailSignUp, googleSignIn, passwordReset,
  sendVerification, firebaseSignOut, idTokenOf, changePassword, firebaseUser
} from './firebase-auth.js?v=66';
import {
  T, me, setMe, statusTag, signed, busy, unbusy, showFormError, checkPassword
} from './account-shared.js?v=66';

initChrome();

const STAFF_DOMAIN = '@visionguardeg.com';

let attData = null;
let tickTimer = null;

/* =========================================================================
   THE ADMINISTRATOR CONSOLE, FETCHED ONLY IF IT IS OPENED

   The four admin panels are roughly half of what this page used to be, and
   nobody but an administrator can do anything with them. They now live in
   account-admin.js and are fetched by the click that first needs them, so a
   customer signing in to check an order never downloads them at all.

   The promise is cached, not the module, so two fast clicks on two admin tabs
   share one fetch instead of racing two. A failed import is logged and
   dropped: the tab does nothing, which is the same as it doing nothing for a
   customer, and it must not take the rest of the dashboard down.

   `admin` is the resolved module once it has ever loaded, so the language
   hook and sign-out can ask it to repaint or clear without triggering a fetch
   for a page that never opened an admin tab.
   ========================================================================= */
let adminPromise = null;
let admin = null;

function loadAdmin() {
  if (!adminPromise) {
    adminPromise = import('./account-admin.js?v=66')
      .then((mod) => { admin = mod; return mod; })
      .catch((err) => {
        adminPromise = null;                 // let a later click try again
        console.error('admin console failed to load', err && err.message);
        return null;
      });
  }
  return adminPromise;
}

/* The staff features — notifications, internal messages and leave — on the
   same terms and for the same reason. A customer signing in to look at an
   order has no use for any of it, so it is fetched when a STAFF account
   signs in rather than shipped to everybody.

   Unlike the admin console this one is fetched on sign-in rather than on a
   tab click, because the notification bell has to appear straight away —
   waiting for a click would mean nobody ever sees the badge that is supposed
   to prompt the click. */
let staffPromise = null;
let staff = null;

function loadStaff() {
  if (!staffPromise) {
    staffPromise = import('./account-staff.js?v=66')
      .then((mod) => { staff = mod; return mod; })
      .catch((err) => {
        staffPromise = null;
        console.error('staff tools failed to load', err && err.message);
        return null;
      });
  }
  return staffPromise;
}

/* The leads centre. Its own module rather than part of account-staff.js: it
   is the largest of the three and the only one somebody might never open, so
   it is fetched on the tab click rather than on sign-in. */
let leadsPromise = null;
let leads = null;

function loadLeadsModule() {
  if (!leadsPromise) {
    leadsPromise = import('./account-leads.js?v=66')
      .then((mod) => { leads = mod; return mod; })
      .catch((err) => {
        leadsPromise = null;
        console.error('leads centre failed to load', err && err.message);
        return null;
      });
  }
  return leadsPromise;
}

/* The marketing tab. Fetched on the tab click rather than on sign-in, like
   the leads centre: it is the one panel that waits on a third-party API, and
   most people who sign in never open it. */
let marketingPromise = null;
let marketing = null;

function loadMarketingModule() {
  if (!marketingPromise) {
    marketingPromise = import('./account-marketing.js?v=66')
      .then((mod) => { marketing = mod; return mod; })
      .catch((err) => {
        marketingPromise = null;
        console.error('marketing tab failed to load', err && err.message);
        return null;
      });
  }
  return marketingPromise;
}

/* Live chat with customers handed over from the assistant. Fetched when a
   staff account signs in rather than on the tab click, because the badge has
   to appear before anything is clicked — a chat being offered to you with
   five minutes on it is no use discovered by browsing to the tab. */
let supportPromise = null;
let support = null;

function loadSupportModule() {
  if (!supportPromise) {
    supportPromise = import('./account-support.js?v=66')
      .then((mod) => { support = mod; return mod; })
      .catch((err) => {
        supportPromise = null;
        console.error('live chat failed to load', err && err.message);
        return null;
      });
  }
  return supportPromise;
}

/* =========================================================================
   1. VIEWS
   ========================================================================= */
const views = { loading: $('#viewLoading'), auth: $('#viewAuth'), dash: $('#viewDash') };

function showView(name) {
  Object.keys(views).forEach((k) => { views[k].hidden = k !== name; });
}

/* =========================================================================
   2. AUTH TABS
   ========================================================================= */
function showAuthTab(which) {
  const login = which === 'login';
  $('#tabLogin').classList.toggle('is-on', login);
  $('#tabSignup').classList.toggle('is-on', !login);
  $('#tabLogin').setAttribute('aria-selected', String(login));
  $('#tabSignup').setAttribute('aria-selected', String(!login));
  $('#paneLogin').hidden = !login;
  $('#paneSignup').hidden = login;
}

$('#tabLogin').addEventListener('click', () => showAuthTab('login'));
$('#tabSignup').addEventListener('click', () => showAuthTab('signup'));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showAuthTab(b.getAttribute('data-goto'))));

/* Tells an employee they are at the right door before they submit. */
function wireStaffHint(inputSel, hintSel) {
  const input = $(inputSel);
  const hint = $(hintSel);
  const check = () => { hint.hidden = !input.value.trim().toLowerCase().endsWith(STAFF_DOMAIN); };
  input.addEventListener('input', check);
  input.addEventListener('blur', check);
}
wireStaffHint('#lEmail', '#loginStaffHint');
wireStaffHint('#sEmail', '#signupStaffHint');


/* =========================================================================
   AUTHENTICATION — Firebase holds the credentials, this site holds the session

   Every path below is the same three steps:

     1. Firebase verifies the credential (password, or the Google popup) and
        hands back an ID token.
     2. That token goes to /api/auth/firebase, which checks its signature and
        audience server-side — a token minted by anyone else's Firebase
        project is refused there, which is the whole security of this.
     3. The server sets this site's own session cookie, and from that moment
        nothing else on the page knows or cares that Firebase was involved.
        Orders, preferences, attendance and the team timesheet all read the
        cookie exactly as they did before.

   The password never reaches our server, which is the point of the change.
   ========================================================================= */


/* Firebase errors carry a code but no Arabic. Re-wrapping them as the site's
   own ApiError is what gives them a .display in the language on screen. */
function asApiError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError((err && err.code) || 'auth_failed', (err && err.message) || 'Sign-in failed.');
}

/* Step 2 and 3, shared by all four entry points. */
async function exchange(credential, extra) {
  const idToken = await idTokenOf(credential);
  const data = await api('/api/auth/firebase', {
    body: Object.assign({ idToken, lang: LANG }, extra || {})
  });

  /* CompleteRegistration, on `created` only. The server sets that flag when
     it actually inserted a row, so a returning customer signing in does not
     get reported as a new registration — which is the mistake that makes
     this event useless, because every sign-in inflates it. */
  if (data.created && window.vgTrack) {
    window.vgTrack.completeRegistration(
      (extra && extra.method) || 'email',
      data.user && data.user.id
    );
    if (extra && extra.newsletter) window.vgTrack.lead('signup');
  }

  await enter(data.user);

  /* THE WELCOME POPUP, and only on `created`.

     Same flag the CompleteRegistration event above trusts, for the same
     reason: it is set when a row was actually inserted, so a returning
     customer signing in is never congratulated on joining. Fired after
     enter() so the dashboard is behind the dialog rather than appearing
     underneath it a moment later. */
  if (data.created) showWelcomePopup();

  return data;
}

/* =========================================================================
   WHAT THE NEW CUSTOMER JUST EARNED

   The numbers come from /api/coupon rather than from constants in this file,
   so the popup, the checkout summary and the order all quote the same offer.
   If that call fails the popup does not appear at all: a dialog that says
   "you have {pct}% off" with a blank in it is worse than no dialog, and the
   discount still applies either way — it is applied from the account, not
   from having read this.
   ========================================================================= */
async function showWelcomePopup() {
  let data;
  try {
    /* subtotal=0 asks purely about entitlement — there is no cart yet. */
    data = await api('/api/coupon?subtotal=0');
  } catch (e) {
    return;
  }
  if (!data || !data.eligible || !Number(data.percent)) return;

  const pop = $('#welcomePop');
  if (!pop) return;

  const pct = Number(data.percent);
  const next = Number(data.nextPercent) || 0;
  const days = Number(data.days) || 5;

  $('#wpopBadge').textContent = `${pct}%`;
  /* Two sentences at most, and the second one is the deadline. An offer
     without its expiry is the half people remember wrongly. */
  $('#wpopBody').textContent = next > 0
    ? t(T.wpopTiered).replace('{pct}', String(pct)).replace('{next}', String(next))
    : t(T.wpopFlat).replace('{pct}', String(pct));
  $('#wpopFine').textContent = t(T.wpopFine).replace('{days}', String(days));

  pop.hidden = false;
  /* Focus moves into the dialog so a keyboard can dismiss it without
     hunting, and Escape closes it like any other dialog on the web. */
  const close = $('#wpopClose');
  if (close) close.focus();
}

function hideWelcomePopup() {
  const pop = $('#welcomePop');
  if (pop) pop.hidden = true;
}

/* Every way out: the X, the "later" button, the backdrop, and Escape. A
   popup with one escape route is a popup somebody feels trapped by. */
if ($('#welcomePop')) {
  $('#welcomePop').addEventListener('click', (e) => {
    if (e.target.closest('#wpopClose, #wpopLater, [data-wpop-close]')) hideWelcomePopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#welcomePop').hidden) hideWelcomePopup();
  });
}

/* Google sign-in goes through Firebase, and only through Firebase.

   There used to be two stacks: Google Identity Services posting an ID token
   to /api/auth/google, and Firebase's popup posting a Firebase token to
   /api/auth/firebase. They belonged to DIFFERENT Google Cloud projects —
   GSI used client 523216293057-…, while Firebase is project 54729456085
   (visionguard-7425d) — and only one of them was ever going to be the one
   whose authorised origins someone remembered to update. That is what the
   "Error 400: origin_mismatch" was: the domains were correctly registered on
   the Firebase project while the button on the page belonged to the other
   one.

   One project, one path. Firebase already lists visionguardeg.com and
   www.visionguardeg.com in its authorizedDomains, the server already verifies
   its tokens in lib/firebase.js against FIREBASE_PROJECT_ID, and the popup
   still collects credentials on accounts.google.com — the real Google page,
   not a look-alike. */
let authBusy = false;

async function googleFlow(errSel) {
  if (authBusy) return;
  authBusy = true;
  const errEl = $(errSel);
  if (errEl) errEl.hidden = true;
  try {
    const credential = await googleSignIn();
    /* Google has already verified the address, so the server may link it to
       an existing record. No consent flags: a Google sign-up accepts the
       terms by the note next to the button, and marketing stays off until
       someone actually ticks it in Preferences. */
    await exchange(credential, { terms: true, method: 'google' });
  } catch (err) {
    const e = asApiError(err);
    /* `cancelled` used to return here without a word, on the reasoning that
       somebody who closes the Google window does not need to be told they
       closed it. That reasoning is sound and it still hid a real bug for
       weeks: Firebase reports a popup whose handshake it cannot complete with
       the SAME code it reports for a deliberate close (auth/popup-closed-by-
       user), so when Cross-Origin-Opener-Policy severed the popup — see
       public/_headers — every Google sign-in failed in total silence.

       There is no way to tell the two apart from here, so the page no longer
       tries. It says the same mild, true thing either way: the window closed
       before sign-in finished. Somebody who meant to cancel reads it and
       ignores it. Somebody hitting a real failure finds out there was one,
       and is pointed at the path that does not involve a popup. */
    const text = e.code === 'cancelled'
      ? t(T.googleIncomplete)
      : (e.display || e.message);
    if (errEl) {
      errEl.textContent = text;
      errEl.hidden = false;
    }
    /* Belt to those braces. Setting text on an element that is inside a
       hidden pane — or hidden for any other reason — displays nothing, and a
       failed sign-in that says nothing is indistinguishable from a button
       that does not work. offsetParent is null for anything not actually
       laid out, which covers a hidden ancestor as well as the element
       itself. If it cannot be seen, say it out loud instead. */
    if (!errEl || errEl.offsetParent === null) {
      toast(text, 'bad');
    }
  } finally {
    authBusy = false;
  }
}

/* The Google buttons.

   They are the site's own markup now, styled like every other button here and
   translated with the same data-en mechanism, rather than an iframe Google
   renders and owns. That is a deliberate consequence of moving to Firebase:
   signInWithPopup is triggered by an ordinary click handler, so there is no
   rendered widget to host — and no second theme to keep in step with ours,
   which is what the light/dark bug was.

   It is still Google's real sign-in. The popup goes to accounts.google.com
   and the password is typed there; nothing on this page ever sees it. What is
   NOT allowed, and is not done here, is a form of our own that collects a
   Google password — that is the phishing pattern, and it is a different thing
   from a button that opens Google's page. */
const googleButtons = [$('#googleLogin'), $('#googleSignup')];

firebaseReady().then((ok) => {
  /* No Firebase, no Google button. Email and password still work, and an
     enabled button that cannot complete is worse than an absent one. */
  $$('.gauth').forEach((g) => { g.hidden = !ok; });
  googleButtons.forEach((b) => { if (b) b.hidden = !ok; });

  if (!ok) {
    console.warn('Firebase Auth was not reachable; Google sign-in is hidden and email sign-in still works.');
    return;
  }

  /* Each button reports into the error line in ITS OWN pane.

     Both used to pass '#googleErr', which lives in the sign-in pane — so a
     failure on the Create-account tab set the text on a hidden element and
     the customer saw nothing at all. The whole flow then looks like a button
     that does nothing, which is how it was reported: "after Google sign-in it
     still shows sign in or create account". The sign-in HAD failed; the
     reason was written somewhere invisible. */
  const errorFor = { googleLogin: '#googleErr', googleSignup: '#googleErrSignup' };
  googleButtons.forEach((b) => {
    if (b) b.addEventListener('click', () => googleFlow(errorFor[b.id] || '#googleErr'));
  });
});

/* ---- sign in ----

   Firebase first, then the local password path.

   The fallback is not belt-and-braces, it is load-bearing. Firebase owns
   customer credentials, but it cannot hold the ADMINISTRATOR account: that
   one is seeded straight into D1 by scripts/create-admin.mjs, because
   creating a Firebase user needs a service-account key this project does not
   have. Without this fallback the administrator has no way to sign in
   through the site at all — which is exactly what happened when sign-in
   moved to Firebase and this form stopped calling /api/auth/login.

   It is not a weakening. /api/auth/login is unchanged: same peppered PBKDF2,
   same rate limit, same deliberately identical error either way. Every
   account Firebase creates carries the GOOGLE_ONLY_PW sentinel in pw_hash,
   which can never verify against any input — so the only accounts this can
   let in are ones seeded out of band on purpose. */
const FIREBASE_CANT_AUTHENTICATE = new Set([
  'bad_credentials',      // no such Firebase user, or wrong password there
  'auth_not_enabled',     // Authentication not switched on for the project
  'firebase_unavailable', // CDN blocked, offline, ad blocker
  'provider_disabled',    // email/password provider turned off
  'auth_failed'           // anything else Firebase would not explain
]);

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').hidden = true;
  $('#loginOk').hidden = true;
  const btn = $('#loginBtn');
  const email = $('#lEmail').value;
  const password = $('#lPass').value;
  busy(btn, t(T.signingIn));

  try {
    const credential = await emailSignIn(email, password);
    $('#lPass').value = '';
    await exchange(credential);
  } catch (err) {
    const e1 = asApiError(err);

    if (FIREBASE_CANT_AUTHENTICATE.has(e1.code)) {
      try {
        const data = await api('/api/auth/login', { body: { email, password } });
        $('#lPass').value = '';
        await enter(data.user);
        return;
      } catch (localErr) {
        /* Show the local failure, not Firebase's. If neither knows this
           address, "email or password is incorrect" is the honest answer and
           the one that does not leak which system holds the account. */
        showFormError('#loginErr', localErr);
        return;
      } finally {
        unbusy(btn, t(T.signIn));
      }
    }

    showFormError('#loginErr', e1);
  } finally {
    unbusy(btn, t(T.signIn));
  }
});

/* ---- forgot password ----
   New with Firebase: there was no way to reset a password before, because
   nothing here can send email. Firebase does.

   The answer is identical whether or not the address is registered. Saying
   "no such account" would turn this box into a way to test who has one. */
$('#forgotBtn').addEventListener('click', async () => {
  const email = $('#lEmail').value.trim();
  $('#loginErr').hidden = true;
  $('#loginOk').hidden = true;

  if (!email) {
    $('#lEmail').focus();
    return showFormError('#loginErr', new ApiError('missing_field', 'Type your email address first, then tap this again.'));
  }

  try {
    await passwordReset(email);
  } catch (err) {
    const e = asApiError(err);
    /* Only a genuinely broken address or a rate limit is worth reporting. */
    if (e.code === 'bad_email' || e.code === 'rate_limited') {
      return showFormError('#loginErr', e);
    }
  }
  $('#loginOk').textContent = t(T.resetSent);
  $('#loginOk').hidden = false;
});

/* ---- sign up ---- */
$('#signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#signupErr').hidden = true;
  const btn = $('#signupBtn');

  if (!$('#sTerms').checked) {
    return showFormError('#signupErr', {
      display: t({
        ar: 'لازم توافق على شروط الاستخدام وسياسة الخصوصية.',
        en: 'You need to accept the terms of use and the privacy policy.'
      })
    });
  }

  busy(btn, t(T.creating));
  try {
    checkPassword($('#sPass').value);
    const credential = await emailSignUp($('#sEmail').value, $('#sPass').value);
    $('#sPass').value = '';

    /* Fired off but not waited on. The account exists either way, and the
       verification email only matters later — see the linking rules in
       functions/api/auth/firebase.js. */
    sendVerification(credential);

    await exchange(credential, {
      name: $('#sName').value,
      phone: $('#sPhone').value,
      terms: true,
      newsletter: $('#sNews').checked,
      marketing: $('#sMarketing').checked
    });
    toast(t(T.verifySent), 'good');
  } catch (err) {
    showFormError('#signupErr', asApiError(err));
  } finally {
    unbusy(btn, t(T.create));
  }
});

/* =========================================================================
   3. DASHBOARD
   ========================================================================= */
/* =========================================================================
   The Meta business-verification banner.

   Shown to an administrator on the dashboard while the marketing connection
   is not finished, and it treats "finished" as: a dedicated read token, a
   Page id, and an ad account id. Business verification is the gate in front
   of all three — Meta will not issue a System User token carrying ads_read
   to an unverified business — so a configuration that works is proof the
   verification happened, and there is no separate state to store.

   That is why it is keyed off configuration rather than off a "dismissed"
   flag. A banner that can be dismissed forever is a banner that stops being
   true without anyone noticing; this one disappears by being fixed.

   `Later` hides it for the session only. It returns at the next sign-in,
   which is the point — the owner should be reminded every time they come
   back, without being blocked from working today.
   ========================================================================= */
const MV_SNOOZE = 'vg_meta_verify_snooze';

function showMetaVerify(setup) {
  const box = $('#metaVerify');
  if (!box) return;

  /* The three that verification actually gates. `page` alone is not enough:
     an unverified business can still hold a Page id, so a banner keyed on
     that would vanish while the ads half stayed broken. */
  const ready = Boolean(setup && setup.dedicatedToken && setup.page && setup.ads);
  let snoozed = false;
  try {
    snoozed = sessionStorage.getItem(MV_SNOOZE) === '1';
  } catch (e) {
    /* Private mode with storage disabled. Showing the banner is the safe
       side of that failure. */
  }

  if (ready || snoozed) {
    box.hidden = true;
    return;
  }

  $('#metaVerifyTitle').textContent = t(T.mvTitle);
  $('#metaVerifyBody').textContent = t(T.mvBody);
  $('#metaVerifyGo').textContent = t(T.mvGo);
  $('#metaVerifyLater').textContent = t(T.mvLater);
  box.hidden = false;
}

$('#metaVerifyLater').addEventListener('click', () => {
  try { sessionStorage.setItem(MV_SNOOZE, '1'); } catch (e) { /* see above */ }
  $('#metaVerify').hidden = true;
});

/* `setup` arrives with /api/auth/me on boot. The two sign-in paths answer
   from /api/auth/login and /api/auth/firebase, which do not carry it — so an
   administrator who has just typed a password gets one extra request, once,
   rather than those two endpoints growing a field they have no other use
   for. A failure here costs the banner and nothing else. */
async function paintMetaVerify(user, setup) {
  if (!user.admin) {
    $('#metaVerify').hidden = true;
    return;
  }
  if (setup) return showMetaVerify(setup);
  try {
    const fresh = await api('/api/auth/me');
    showMetaVerify(fresh.metaSetup);
  } catch (err) {
    console.error('meta setup check failed', err && err.message);
  }
}

/* The missing-phone prompt.

   Google supplies a verified email and a name and no phone number, and
   nothing on the sign-in path ever asked for one — so a Google-created
   account arrived at checkout with phone NULL and was refused there, by a
   field the customer had never been shown. See the banner in account.html.

   Keyed on the absence of the number, not on how the account was created:
   that also covers rows made before the field mattered, and it means an
   account that later fills the number in stops being nagged without anything
   having to remember why it was being nagged.

   Staff and administrators are exempt. They do not check out, and an
   employee's contact number is an HR record rather than a delivery detail. */
function paintNeedPhone(user) {
  const el = $('#needPhone');
  if (!el) return;
  const needed = !!user && !user.staff && !user.admin && !String(user.phone || '').trim();
  el.hidden = !needed;
}

async function enter(user, metaSetup) {
  setMe(user);
  $('#dashName').textContent = `${t(T.hello)}${LANG === 'en' ? ', ' : ' يا '}${user.name}`;
  $('#dashEmail').textContent = user.email;
  /* Administrators are staff too — isStaffEmail() in lib/auth.js is true for
     every @visionguardeg.com address, admin@ included — so the admin check
     has to come first or the administrator is labelled an employee, which is
     exactly what it used to do. */
  $('#dashBadge').hidden = !user.staff;
  $('#dashBadgeAdmin').hidden = !user.admin;
  $('#dashBadgeStaff').hidden = !(user.staff && !user.admin);
  /* Which tabs exist is no longer decided here, one line per tab. ROUTES
     holds the tree and `need` on each entry decides who sees it, so the
     navigation is drawn from the same table that describes it — and a new
     feature cannot be added without saying where it belongs. */

  /* Advanced Matching: from here on, events from this browser carry a hashed
     identifier, so Meta can attribute them. Signed-in customers only — a
     visitor who has not told us who they are is not identified. */
  if (window.vgTrack) {
    window.vgTrack.identify({ email: user.email, phone: user.phone, externalId: user.id });
  }

  $('#pName').value = user.name || '';
  $('#pPhone').value = user.phone ? '0' + String(user.phone).replace(/^20/, '') : '';
  $('#pNews').checked = !!user.newsletter;
  $('#pMarketing').checked = !!user.marketing;
  paintAvatar();
  paintNeedPhone(user);
  /* Set on every sign-in and every page load of this page, and cleared for a
     customer — so an account that loses its staff status stops advertising a
     console it can no longer open, without needing to be signed out. */
  setStaffHint(!!user.staff);

  /* Not awaited: the banner must never delay the dashboard appearing, and on
     the sign-in path it costs a request. It paints itself when it arrives. */
  paintMetaVerify(user, metaSetup);

  /* One read on sign-in so the live-chat badge is right immediately. A chat
     being offered to you with five minutes on the clock is no use if it is
     only discovered by wandering into the tab. This does NOT start the
     polling loop — that begins when the tab is actually opened. */
  if (user.staff) {
    loadSupportModule().then((mod) => { if (mod) mod.loadSupport(); });
  }

  showView('dash');

  /* An address in the URL wins over the default, so a notification or a
     bookmark lands on the thing it names. Otherwise: anyone on the company
     domain opens on Work — which is now the whole of it, an administrator's
     groups included — and a customer on their orders. Nobody's first screen
     should be somebody else's job. */
  const asked = migrateRoute(routeFromHash());
  if (asked.ws) {
    showRoute(asked.ws, asked.group, asked.sub, { push: false });
  } else if (user.staff) {
    showRoute('work', '', '');
  } else {
    showRoute('account', 'orders', '');
  }

  loadOrders();
  /* Employees, not administrators. An administrator does not clock in, has no
     Hours panel to fill, and fetching their attendance would be a request for
     a screen that no longer exists for them. */
  if (user.staff && !user.admin) loadAttendance();
  /* The bell has to be there before anything is clicked — see loadStaff(). */
  if (user.staff) loadStaff().then((mod) => { if (mod) mod.start(); });
}

$('#logoutBtn').addEventListener('click', async () => {
  /* Both sessions, in that order: ours is the one that authorises anything,
     so it goes first and a slow Firebase call cannot leave someone looking
     signed out while their cookie is still live. */
  try { await api('/api/auth/logout', { body: {} }); } catch (e) {}
  try { await firebaseSignOut(); } catch (e) {}
  setMe(null);
  /* Drop the Work link from the rest of the site. Cleared before anything
     else that can throw, because a hint left behind after a sign-out is the
     one stale state a customer on a shared machine would actually notice. */
  setStaffHint(false);
  attData = null;
  /* Only if they were ever opened — asking for them here would fetch a whole
     module during sign-out, for a page that plainly no longer needs it. */
  if (admin) admin.reset();
  if (staff) staff.reset();
  if (leads) leads.reset();
  if (marketing) marketing.reset();
  if (support) support.reset();
  stopTick();
  showView('auth');
  showAuthTab('login');
});

/* =========================================================================
   YOUR PROFILE PICTURE

   Uploaded to KV through /api/account/avatar and drawn from a URL keyed on a
   random token — see lib/avatars.js for why the filename is not the user id.

   INITIALS WHEN THERE IS NO PICTURE, rather than a placeholder image. Every
   account has a name, nobody has to upload anything to look like a real
   account, and it means this page never requests a URL that does not exist —
   which on Pages would come back as the homepage HTML with a 200 and render
   as a broken image.
   ========================================================================= */
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '؟';
  const first = [...parts[0]][0] || '';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
  return (first + second).toUpperCase();
}

function paintAvatar() {
  const box = $('#avPreview');
  if (!box || !me) return;
  if (me.avatar) {
    box.innerHTML = `<img src="${esc(me.avatar)}" alt="">`;
    box.classList.remove('is-empty');
  } else {
    box.textContent = initialsOf(me.name);
    box.classList.add('is-empty');
  }
  $('#avRemove').hidden = !me.avatar;
}

$('#avFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                       // so the same file can be re-picked
  if (!file) return;

  const err = $('#avErr'), ok = $('#avOk');
  err.hidden = true; ok.hidden = true;

  const body = new FormData();
  body.append('image', file);
  try {
    const data = await api('/api/account/avatar', { method: 'POST', body });
    /* setMe rather than assigning to me.avatar: `me` is an imported binding
       and read-only to this module — see the note in account-shared.js. */
    setMe(Object.assign({}, me, { avatar: data.avatar }));
    paintAvatar();
    ok.textContent = t(T.avSaved);
    ok.hidden = false;
  } catch (e2) {
    err.textContent = e2.display || e2.message;
    err.hidden = false;
  }
});

$('#avRemove').addEventListener('click', async () => {
  const err = $('#avErr'), ok = $('#avOk');
  err.hidden = true; ok.hidden = true;
  try {
    await api('/api/account/avatar', { method: 'DELETE' });
    setMe(Object.assign({}, me, { avatar: '' }));
    paintAvatar();
    ok.textContent = t(T.avRemoved);
    ok.hidden = false;
  } catch (e) {
    err.textContent = e.display || e.message;
    err.hidden = false;
  }
});

/* =========================================================================
   CHANGING YOUR OWN PASSWORD

   One form, two credential stores, and the order matters.

   Firebase holds almost every account here, and a Firebase password can only
   be changed by the browser — setting one server-side needs a service-account
   key this project deliberately does not hold. The seeded administrator is
   the other way round: its hash is in D1 and Firebase has never heard of it.

   So: try Firebase when Firebase actually has a user in this tab, and fall
   back to /api/account/password otherwise. Exactly the shape /api/auth/login
   already uses, for exactly the same reason.

   The current password is required by both halves. A session cookie lasts
   thirty days and outlives an unlocked laptop; without proving the current
   password, anyone who sat down at one could lock the owner out for good.
   ========================================================================= */
async function changeOwnPassword(current, next) {
  const fbUser = await firebaseUser();
  if (fbUser) {
    await changePassword(current, next);
    return;
  }
  await api('/api/account/password', { method: 'POST', body: { current, next } });
}

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#pwBtn');
  const err = $('#pwErr');
  const ok = $('#pwOk');
  err.hidden = true;
  ok.hidden = true;

  const current = $('#pwCurrent').value;
  const next = $('#pwNext').value;
  if (!current || !next) {
    err.textContent = t(T.pwNeedBoth);
    err.hidden = false;
    return;
  }
  if (current === next) {
    err.textContent = t(T.pwSame);
    err.hidden = false;
    return;
  }
  /* Checked here as well as on both servers, so somebody is told before
     they submit rather than after. */
  try {
    checkPassword(next);
  } catch (e2) {
    err.textContent = e2.display || e2.message;
    err.hidden = false;
    return;
  }

  busy(btn, t(T.pwChanging));
  try {
    await changeOwnPassword(current, next);
    $('#pwCurrent').value = '';
    $('#pwNext').value = '';
    ok.textContent = t(T.pwDone);
    ok.hidden = false;
  } catch (e3) {
    const wrapped = asApiError(e3);
    err.textContent = wrapped.display || wrapped.message;
    err.hidden = false;
  } finally {
    unbusy(btn, t(T.pwChange));
  }
});

const panels = {
  orders: $('#panelOrders'),
  attendance: $('#panelAttendance'),
  team: $('#panelTeam'),
  perf: $('#panelPerf'),
  marketing: $('#panelMarketing'),
  support: $('#panelSupport'),
  manage: $('#panelManage'),
  accounts: $('#panelAccounts'),
  catalog: $('#panelCatalog'),
  categories: $('#panelCategories'),
  promos: $('#panelPromos'),
  ads: $('#panelAds'),
  leads: $('#panelLeads'),
  inbox: $('#panelInbox'),
  leave: $('#panelLeave'),
  leaveAdmin: $('#panelLeaveAdmin'),
  prefs: $('#panelPrefs')
};

/* =========================================================================
   THE MAP OF THE DASHBOARD

   This page used to be thirteen buttons in one flat row, added one at a time
   over as many features. Role decided which of them you could see and
   nothing decided how they related, so an employee met eight unrelated tabs
   and an administrator thirteen, in the order they happened to be built —
   with my hours and everyone's hours four apart, asking for leave and
   approving it at opposite ends, and two inboxes called almost the same
   thing.

   It is a tree now, and the tree is DATA. Adding a feature is an entry in
   this table, not another button welded onto a strip, and the question "where
   does this belong" has to be answered before it can ship — which is the
   conversation that never happened across the last thirteen additions.

   `need` is who may SEE it. It is not a permission: every endpoint behind
   every panel re-checks the caller with requireStaff or requireAdmin, and
   that is the control. This only decides what is worth drawing.

     staff     anybody on the company domain, administrators included
     employee  staff who are NOT administrators
     admin     administrators

   WHY `employee` EXISTS. An administrator does not clock in and does not
   ask themselves for leave — they watch attendance rather than keep it. So
   "My record" is not theirs, and neither is the clock. They were also being
   listed on their own timesheet as absent every single day; see the note in
   functions/api/attendance/team.js.

   TWO WORKSPACES, NOT THREE. There was an "Admin" workspace beside "Work",
   which asked everybody who ran the shop to decide, every time, whether what
   they were about to do counted as work or as administration. It is one
   thing: running the shop IS the administrator's work. So the admin groups
   are groups of Work now, each carrying need: 'admin' — an employee sees
   three, an administrator sees six, and there is one place to look.

   That also means the workspace switcher shows at most two tabs, and a
   customer still sees none: renderNav() hides it when there is only one, so
   nobody who is not staff learns the other exists.
   ========================================================================= */
const ROUTES = [
  {
    id: 'account',
    label: { ar: 'حسابي', en: 'My account' },
    groups: [
      { id: 'orders',   label: { ar: 'طلباتي', en: 'Orders' },     panel: 'orders' },
      { id: 'settings', label: { ar: 'الإعدادات', en: 'Settings' }, panel: 'prefs' }
    ]
  },
  {
    id: 'work',
    label: { ar: 'الشغل', en: 'Work' },
    need: 'staff',
    groups: [
      {
        id: 'customers', label: { ar: 'العملاء', en: 'Customers' },
        subs: [
          { id: 'chat',  label: { ar: 'المحادثات', en: 'Live chat' }, panel: 'support', dot: 'supportDot' },
          { id: 'leads', label: { ar: 'العملاء المحتملين', en: 'Leads' }, panel: 'leads' }
        ]
      },
      {
        id: 'team', label: { ar: 'الفريق', en: 'Team' },
        subs: [
          { id: 'messages', label: { ar: 'الرسائل', en: 'Messages' }, panel: 'inbox', dot: 'inboxDot' }
        ]
      },
      {
        id: 'record', label: { ar: 'سجلي', en: 'My record' }, need: 'employee',
        subs: [
          { id: 'hours', label: { ar: 'الحضور', en: 'Hours' }, panel: 'attendance' },
          { id: 'leave', label: { ar: 'الإجازات', en: 'Leave' }, panel: 'leave' }
        ]
      },

      /* ---- the administrator's half of Work ----

         These three were a workspace of their own, "Admin", sitting beside
         Work. That made two answers to one question — an administrator
         wanting the catalogue editor had to know it was filed under Admin
         rather than Work, when running the shop IS their work — and it put
         a third switcher tab on screen for the two people who have one.

         They are groups of Work now, gated individually with need: 'admin',
         so an employee sees the three above and an administrator sees all
         six. Nothing about who may open them changed: `need` is presentation
         and every endpoint behind these panels re-checks the session
         server-side. See requireAdmin in lib/auth.js. */
      {
        id: 'shop', label: { ar: 'المتجر', en: 'Shop' }, need: 'admin',
        subs: [
          { id: 'orders',     label: { ar: 'الطلبات', en: 'Orders' },   panel: 'manage' },
          { id: 'catalogue',  label: { ar: 'الكتالوج', en: 'Catalogue' }, panel: 'catalog' },
          /* Presentation of the groups — the homepage cards and the shop's
             filter chips. Next to the catalogue because they are two halves
             of the same job: what is for sale, and how it is shelved. */
          { id: 'categories', label: { ar: 'الأقسام', en: 'Categories' }, panel: 'categories' },
          /* Discounts, next to the catalogue and the orders: what things
             cost is the same job as what is for sale. */
          { id: 'promos',     label: { ar: 'الخصومات', en: 'Promos' },     panel: 'promos' },
          /* The images the ads are built from. Filed under Shop because
             that is where what-we-sell and how-it-looks already live. */
          { id: 'ads',        label: { ar: 'تصاميم الإعلانات', en: 'Ad creatives' }, panel: 'ads' }
        ]
      },
      {
        id: 'people', label: { ar: 'الموظفين', en: 'People' }, need: 'admin',
        subs: [
          { id: 'timesheet', label: { ar: 'الحضور', en: 'Timesheet' },      panel: 'team' },
          { id: 'leave',     label: { ar: 'طلبات الإجازة', en: 'Leave requests' }, panel: 'leaveAdmin', dot: 'leaveDot' },
          { id: 'accounts',  label: { ar: 'الحسابات', en: 'Accounts' },     panel: 'accounts' }
        ]
      },
      {
        id: 'growth', label: { ar: 'النمو', en: 'Growth' }, need: 'admin',
        subs: [
          { id: 'performance', label: { ar: 'الأداء', en: 'Performance' }, panel: 'perf' },
          { id: 'marketing',   label: { ar: 'التسويق', en: 'Marketing' },  panel: 'marketing' }
        ]
      }
    ]
  }
];

/* Addresses that used to work, and still do.

   The admin panels lived at #admin/shop/catalogue and the like for as long
   as the restructure has been live. Those URLs are in bookmarks, in the
   notes in this repository, and in the comments of two other files. They
   cost one line to keep working, and silently landing somebody on the wrong
   screen is the kind of small betrayal that makes people stop trusting
   links. The group ids are unique across the merged list, so the workspace
   is the only part that has to change. */
function migrateRoute(r) {
  return r && r.ws === 'admin' ? { ws: 'work', group: r.group, sub: r.sub } : r;
}

/* Which of the three `need` levels this account satisfies. */
function may(need) {
  if (!need) return true;
  if (!me) return false;
  if (need === 'admin') return !!me.admin;
  if (need === 'staff') return !!me.staff;
  if (need === 'employee') return !!me.staff && !me.admin;
  return false;
}

const visibleWorkspaces = () => ROUTES.filter((w) => may(w.need));
const visibleGroups = (w) => (w ? w.groups.filter((g) => may(g.need)) : []);
const visibleSubs = (g) => (g && g.subs ? g.subs.filter((s) => may(s.need)) : []);

/* Where we are. Kept here rather than read back out of the DOM. */
let route = { ws: 'account', group: 'orders', sub: '' };

function findRoute(wsId, groupId, subId) {
  const ws = visibleWorkspaces().find((w) => w.id === wsId) || visibleWorkspaces()[0];
  const groups = visibleGroups(ws);
  const group = groups.find((g) => g.id === groupId) || groups[0];
  const subs = visibleSubs(group);
  const sub = subs.find((s) => s.id === subId) || subs[0] || null;
  return { ws, group, sub };
}

const panelOf = (group, sub) => (sub ? sub.panel : group && group.panel) || '';

/* -------------------------------------------------------------------------
   Drawing the three levels
   ------------------------------------------------------------------------- */
function navButton(cls, id, label, on, dotId) {
  const dot = dotId ? `<span class="tab__dot" id="${dotId}" hidden></span>` : '';
  return `<button class="${cls}${on ? ' is-on' : ''}" type="button" role="tab"
            aria-selected="${on}" data-nav="${esc(id)}">${esc(t(label))}${dot}</button>`;
}

function renderNav() {
  const spaces = visibleWorkspaces();

  /* One workspace means no switcher. A customer must never learn that the
     other two exist, and a lone tab that cannot be switched away from is
     furniture. */
  const wsWrap = $('#wsSwitch');
  wsWrap.hidden = spaces.length < 2;
  wsWrap.innerHTML = spaces.length < 2 ? ''
    : spaces.map((w) => navButton('ws__btn', w.id, w.label, w.id === route.ws)).join('');

  const ws = spaces.find((w) => w.id === route.ws);
  const groups = visibleGroups(ws);
  $('#wsNav').innerHTML = groups
    .map((g) => {
      /* A dot on a group when any of its children is asking for attention,
         so somebody one level up still sees it. */
      const childDot = visibleSubs(g).find((s) => s.dot);
      return navButton('tab', g.id, g.label, g.id === route.group, childDot ? childDot.dot + 'Group' : '');
    }).join('');

  const group = groups.find((g) => g.id === route.group);
  const subs = visibleSubs(group);
  const subWrap = $('#wsSub');
  /* A single child is not a choice; showing one sub-tab alone is clutter
     pretending to be navigation. */
  subWrap.hidden = subs.length < 2;
  subWrap.innerHTML = subs.length < 2 ? ''
    : subs.map((s) => navButton('subtab', s.id, s.label, route.sub === s.id, s.dot)).join('');

  /* Breadcrumbs only where the nesting is real — two levels deep. */
  const crumbs = $('#wsCrumbs');
  if (subs.length > 1 && ws && group) {
    const current = subs.find((s) => s.id === route.sub);
    crumbs.hidden = false;
    crumbs.innerHTML =
      `<span>${esc(t(ws.label))}</span><span class="crumb__sep">›</span>` +
      `<span>${esc(t(group.label))}</span><span class="crumb__sep">›</span>` +
      `<b>${esc(current ? t(current.label) : '')}</b>`;
  } else {
    crumbs.hidden = true;
    crumbs.innerHTML = '';
  }
}

/* -------------------------------------------------------------------------
   Going somewhere
   ------------------------------------------------------------------------- */
function hashOf(r) {
  return '#' + [r.ws, r.group, r.sub].filter(Boolean).join('/');
}

function showRoute(wsId, groupId, subId, options) {
  const found = findRoute(wsId, groupId, subId);
  if (!found.ws || !found.group) return;

  route = {
    ws: found.ws.id,
    group: found.group.id,
    sub: found.sub ? found.sub.id : ''
  };

  const panel = panelOf(found.group, found.sub);

  /* Live chat polls while it is on screen. Leaving it has to stop that, or a
     dashboard parked on Orders keeps talking to the server all day. */
  if (panel !== 'support' && support) support.leavePanel();

  Object.keys(panels).forEach((k) => { if (panels[k]) panels[k].hidden = k !== panel; });
  renderNav();

  if (!options || options.push !== false) {
    const next = hashOf(route);
    if (location.hash !== next) history.pushState(null, '', next);
  }

  loadPanelFor(panel);
}

/* Which module owns which panel. Was a ladder of string comparisons inside
   showTab; a table means adding a panel is one line and cannot be half-done. */
function loadPanelFor(panel) {
  if (!panel) return;
  if (panel === 'attendance') return loadAttendance();
  if (panel === 'leads') return loadLeadsModule().then((m) => { if (m) m.loadPanel(); });
  if (panel === 'marketing') return loadMarketingModule().then((m) => { if (m) m.loadPanel(); });
  if (panel === 'support') return loadSupportModule().then((m) => { if (m) m.loadPanel(); });
  if (panel === 'inbox' || panel === 'leave' || panel === 'leaveAdmin') {
    return loadStaff().then((m) => { if (m) m.loadPanel(panel); });
  }
  /* The admin console. `accounts` is the half of the old Manage panel that
     handles staff accounts; it shares one loader with Shop › Orders because
     /api/admin/manage answers both in a single request. */
  if (panel === 'team' || panel === 'perf' || panel === 'catalog' ||
      panel === 'categories' || panel === 'promos' || panel === 'ads') {
    return loadAdmin().then((m) => { if (m) m.loadPanel(panel); });
  }
  if (panel === 'manage' || panel === 'accounts') {
    return loadAdmin().then((m) => { if (m) m.loadPanel('manage'); });
  }
}

/* Every nav level goes through one handler: the button says which level it
   belongs to by which container it is in. */
$('#wsSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (b) showRoute(b.getAttribute('data-nav'), '', '');
});
$('#wsNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (b) showRoute(route.ws, b.getAttribute('data-nav'), '');
});
$('#wsSub').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (b) showRoute(route.ws, route.group, b.getAttribute('data-nav'));
});

/* The back button, and any link pointing into the dashboard.

   There were no addresses here before, which meant a notification could not
   link to the thing it was about and going back left the page. */
function routeFromHash() {
  const [ws, group, sub] = String(location.hash || '').replace(/^#/, '').split('/');
  return { ws: ws || '', group: group || '', sub: sub || '' };
}

window.addEventListener('popstate', () => {
  const r = migrateRoute(routeFromHash());
  showRoute(r.ws, r.group, r.sub, { push: false });
});

/* ---- orders ---- */
async function loadOrders() {
  const box = $('#ordersList');
  try {
    const { orders } = await api('/api/orders');
    if (!orders.length) {
      box.innerHTML = `
        <p class="card__note">${esc(t(T.noOrders))}</p>
        <p class="card__note">${esc(t(T.noOrdersHint))}</p>`;
      return;
    }
    box.innerHTML = orders.map((o) => {
      const count = (o.items || []).reduce((n, i) => n + i.qty, 0);
      const names = (o.items || []).map((i) => `${i.name} × ${i.qty}`).join(' · ');
      const statusKey = 'o_' + o.status;
      /* Where the money is, next to where the parcel is. An order that has
         not been paid for is the customer's job to finish, not ours, and
         this list is where they will come back to look for it — so the same
         WhatsApp link the confirmation screen offered is here too, for as
         long as it is owed. The server decides that: `payUrl` is absent on
         anything already paid. See publicOrder() in lib/orders.js. */
      const payKey = 'pay_' + (o.paymentStatus || 'pending');
      const payTag = `<span class="pill pill--${esc(o.paymentStatus || 'pending')}">${esc(t(T[payKey] || T.pay_pending))}</span>`;
      /* A button rather than a text link: on an order that still owes money
         this is the one thing to do about it, and it opens the same WhatsApp
         thread the confirmation screen offered. New tab, so the order list
         is still here behind it. */
      const payBtn = o.payUrl
        ? `<a class="btn btn--wa btn--sm orow__pay" href="${esc(o.payUrl)}" target="_blank" rel="noopener">${esc(t(T.payNow))}</a>`
        : '';
      return `
        <div class="orow">
          <span class="orow__id" dir="ltr">${esc(o.id)}</span>
          <span class="orow__meta">
            ${esc(localDate(o.createdAt))} ·
            ${count} ${esc(t(T.items))} ·
            <span class="pill${o.status === 'new' ? ' pill--new' : ''}">${esc(t(T[statusKey] || T.o_new))}</span>
            ${payTag}
            ${payBtn}
          </span>
          <span class="orow__total">${money(o.total)} ${esc(currency())}</span>
          <span class="orow__items" dir="ltr">${esc(names)}</span>
        </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<p class="card__note">${esc(err.display || err.message)}</p>`;
  }
}

/* ---- preferences ---- */
/* Straight to the field, focused, not merely to the tab that contains it.
   Settings holds a picture, a password form and the preferences form; landing
   somebody at the top of it and expecting them to find the one box being
   asked for is how a prompt gets ignored. */
$('#needPhoneGo').addEventListener('click', () => {
  showRoute('account', 'settings', '');
  const field = $('#pPhone');
  if (!field) return;
  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  field.focus();
});

$('#prefsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#prefsErr').hidden = true;
  $('#prefsOk').hidden = true;
  const btn = $('#prefsBtn');
  busy(btn, t(T.saving));
  try {
    const { user } = await api('/api/account/preferences', {
      body: {
        name: $('#pName').value,
        phone: $('#pPhone').value,
        newsletter: $('#pNews').checked,
        marketing: $('#pMarketing').checked,
        lang: LANG
      }
    });
    setMe(user);
    $('#dashName').textContent = `${t(T.hello)}${LANG === 'en' ? ', ' : ' يا '}${user.name}`;
    /* The prompt is answered the moment a number is stored, so it goes away
       here rather than waiting for the next sign-in to re-evaluate. */
    paintNeedPhone(user);
    $('#prefsOk').textContent = t(T.saved);
    $('#prefsOk').hidden = false;
    toast(t(T.saved), 'good');
  } catch (err) {
    showFormError('#prefsErr', err);
  } finally {
    unbusy(btn, t(T.save));
  }
});

/* =========================================================================
   4. ATTENDANCE
   ========================================================================= */
const DIAL_LEN = 2 * Math.PI * 52;      // must match r=52 in account.html

function paintDial(seconds, target) {
  const ratio = target > 0 ? seconds / target : 0;
  const fill = $('#dialFill');
  fill.style.strokeDasharray = String(DIAL_LEN);
  fill.style.strokeDashoffset = String(DIAL_LEN * (1 - Math.min(1, ratio)));
  fill.classList.toggle('is-over', ratio >= 1);
  $('#dialBig').textContent = hhmm(seconds);
  $('#dialSub').textContent = `${Math.round(ratio * 100)}% ${t(T.ofTarget)}`;
}

function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

/* The open shift keeps counting on screen without asking the server every
   second: the server gave us the start instant, so the browser can do the
   arithmetic itself. Any drift is corrected on the next clock action. */
function startTick() {
  stopTick();
  if (!attData || !attData.open) return;
  const startedAt = new Date(attData.open.clockIn).getTime();
  const baseline = attData.today.seconds - attData.open.seconds;
  tickTimer = setInterval(() => {
    const live = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    paintDial(baseline + live, attData.targetSeconds);
  }, 1000);
}


function renderAttendance() {
  if (!attData) return;
  const target = attData.targetSeconds;
  const today = attData.today;
  const open = attData.open;

  $('#attTarget').textContent = t(T.targetNote);
  $('#attFoot').textContent = t(T.attFoot);

  paintDial(today.seconds, target);

  const state = $('#clockState');
  state.classList.toggle('is-live', !!open);
  state.classList.toggle('is-off', !open);
  $('#clockStateText').textContent = open ? t(T.working) : t(T.notWorking);
  $('#clockSince').innerHTML = open
    ? `${esc(t(T.since))} <b dir="ltr">${esc(localTime(open.clockIn))}</b>`
    : '';

  const btn = $('#clockBtn');
  btn.textContent = open ? t(T.clockOut) : t(T.clockIn);
  btn.classList.toggle('btn--out', !!open);

  /* stats */
  const s = attData.summary;
  $('#attStats').innerHTML = `
    <div class="stat"><span class="stat__k">${esc(t(T.daysWorked))}</span><span class="stat__v">${s.daysWorked}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.totalHours))}</span><span class="stat__v">${esc(hoursLabel(s.seconds))}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.expected))}</span><span class="stat__v">${esc(hoursLabel(s.expected))}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.balance))}</span><span class="stat__v ${s.balance >= 0 ? 'is-pos' : 'is-neg'}">${esc(signed(s.balance))}</span></div>`;

  /* table */
  const rows = attData.days.filter((d) => d.sessions.length);
  $('#attRows').innerHTML = rows.length
    ? rows.map((d) => {
        const first = d.sessions[d.sessions.length - 1];
        const last = d.sessions[0];
        const outLabel = last.out ? localTime(last.out) : t(T.stillIn);
        const note = d.sessions.find((x) => x.note);
        return `
          <tr class="${d.date === attData.today.date ? 'is-today' : ''}">
            <td>${esc(localDate(d.sessions[0].in))}</td>
            <td class="num" dir="ltr">${esc(localTime(first.in))} — ${esc(outLabel)}</td>
            <td class="num">${esc(hoursLabel(d.seconds))}</td>
            <!-- null for a day still running and for a mis-tap: neither can
                 be behind or ahead, so a dash is the honest cell. See the
                 note on balance in lib/attendance.js. -->
            <td class="num">${d.balance === null ? '—' : esc(signed(d.balance))}</td>
            <td>${statusTag(d.status)}${note ? `<div class="att__note">${esc(note.note)}</div>` : ''}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="5">${esc(t(T.noAtt))}</td></tr>`;

  startTick();
}

async function loadAttendance() {
  if (!me || !me.staff) return;
  try {
    attData = await api('/api/attendance?days=30');
    $('#attErr').hidden = true;
    renderAttendance();
  } catch (err) {
    stopTick();
    $('#attErr').textContent = err.display || err.message;
    $('#attErr').hidden = false;
  }
}

let clocking = false;
$('#clockBtn').addEventListener('click', async () => {
  if (clocking || !attData) return;
  clocking = true;
  const btn = $('#clockBtn');
  btn.disabled = true;
  $('#attErr').hidden = true;
  try {
    const action = attData.open ? 'out' : 'in';
    const res = await api('/api/attendance/clock', { body: { action } });
    toast(
      action === 'in'
        ? t({ ar: `اتسجل حضورك ${res.at}`, en: `Clocked in at ${res.at}` })
        : t({ ar: `اتسجل انصرافك ${res.at} — ${hoursLabel(res.shift.seconds)}`, en: `Clocked out at ${res.at} — ${hoursLabel(res.shift.seconds)}` }),
      'good'
    );
    await loadAttendance();
  } catch (err) {
    /* "already in" / "not in" means our snapshot is stale, not that the user
       did something wrong — resync and let them try again. */
    if (err.code === 'already_in' || err.code === 'not_in') await loadAttendance();
    $('#attErr').textContent = err.display || err.message;
    $('#attErr').hidden = false;
  } finally {
    clocking = false;
    btn.disabled = false;
  }
});


/* =========================================================================
   9. LANGUAGE + BOOT
   ========================================================================= */
onLang(() => {
  /* The Google button is ordinary markup with a data-en attribute now, so
     site.js translates it for us — nothing to re-render here for it any more.
     That was only ever needed because Google rendered it inside an iframe. */
  if (!me) return;
  $('#dashName').textContent = `${t(T.hello)}${LANG === 'en' ? ', ' : ' يا '}${me.name}`;
  loadOrders();
  if (me.staff && attData) renderAttendance();

  /* The admin panels redraw themselves — including the file picker's "no
     image chosen" label, which is owned by JavaScript rather than by a
     data-en attribute and so is not something site.js can swap for us.

     Only if the console has actually been loaded. Switching language on a
     page whose admin tabs were never opened has nothing there to repaint,
     and fetching the module to discover that would be the one thing this
     split exists to avoid. */
  if (admin) admin.repaint(me.admin && !(panels.manage.hidden && panels.accounts.hidden));
  if (staff) staff.repaint();
  if (leads) leads.repaint();
  if (marketing) marketing.repaint();
  if (support) support.repaint();

  /* The navigation labels live in ROUTES, so they are drawn rather than
     marked up and site.js cannot swap them for us. */
  if (me) renderNav();

  /* The banner's copy is in T, so a language switch has to redraw it — but
     only if it is on screen. Re-deriving the state would mean another
     request for something the user can already see. */
  if (!$('#metaVerify').hidden) {
    $('#metaVerifyTitle').textContent = t(T.mvTitle);
    $('#metaVerifyBody').textContent = t(T.mvBody);
    $('#metaVerifyGo').textContent = t(T.mvGo);
    $('#metaVerifyLater').textContent = t(T.mvLater);
  }
});

(async function boot() {
  try {
    const { user, metaSetup } = await api('/api/auth/me');
    if (user) return enter(user, metaSetup);
  } catch (err) {
    /* A backend that is not wired up yet must not leave a blank page. */
    if (err.code !== 'unauthenticated') {
      toast(err.display || err.message, 'bad');
    }
  }
  showView('auth');
  showAuthTab('login');
})();
