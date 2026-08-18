/* =========================================================================
   public/_headers — the response headers, as a test.

   This file has no other coverage and it is one of the highest-consequence
   files in the repository: three separate flows on this site have already
   been broken by a header that was correct in isolation, and every one of
   them failed SILENTLY. The Meta pixel stopped firing. The Google sign-in
   button did nothing. The Cloudflare beacon collected nothing.

   Nothing here checks that the policy is strict. Strictness is easy to see
   by reading the file. What is NOT easy to see is that a value which looks
   like an obvious hardening — same-origin over same-origin-allow-popups —
   breaks a feature nobody will test by hand, so these tests pin the specific
   relaxations that exist for a reason and name the reason.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS = readFileSync(join(ROOT, 'public/_headers'), 'utf8');

/* Header lines only — the file is mostly comment, and a directive named in a
   comment must never satisfy a test about the policy. */
const DIRECTIVES = HEADERS
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

function headerValue(name) {
  const line = DIRECTIVES.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

const CSP = headerValue('Content-Security-Policy');

test('the CSP is actually set, and not only described in the comments', () => {
  assert.ok(CSP.length > 200, 'a Content-Security-Policy line exists outside the comment block');
});

/* -------------------------------------------------------------------------
   COOP — the one that broke Google sign-in
   ------------------------------------------------------------------------- */
test('Cross-Origin-Opener-Policy allows the popups this site opens', () => {
  const coop = headerValue('Cross-Origin-Opener-Policy');

  assert.equal(coop, 'same-origin-allow-popups');

  /* The regression, spelled out. Under `same-origin` a cross-origin popup is
     severed from its opener: window.opener is null on their side and
     .closed reads true on ours. Firebase polls exactly that, concludes the
     customer closed the window, and rejects with auth/popup-closed-by-user —
     which the page treats as a cancel. Every Google sign-in failed, in
     silence, and no account was ever written. */
  assert.notEqual(coop, 'same-origin', 'this exact value broke signInWithPopup — see the note in _headers');
});

/* -------------------------------------------------------------------------
   The CSP entries the auth flow needs. Each of these has already been the
   cause of an outage in this codebase; the comments in _headers say which.
   ------------------------------------------------------------------------- */
const REQUIRED = [
  ['script-src',  'https://www.gstatic.com',   'serves the Firebase ES modules; blocked, the Google button never appears'],
  ['script-src',  'https://apis.google.com',   'serves the gapi loader the hidden auth iframe bootstraps with'],
  ['frame-src',   'https://apis.google.com',   'the same loader, as a frame'],
  ['frame-src',   "'self'",                    'the auth iframe is SAME-ORIGIN now that authDomain is visionguardeg.com'],
  ['connect-src', 'https://identitytoolkit.googleapis.com', 'sign-in, sign-up and password reset'],
  ['connect-src', 'https://securetoken.googleapis.com',     'token refresh'],
  ['script-src',  'https://connect.facebook.net', 'fbevents.js — the Meta pixel'],
  ['form-action', 'https://www.facebook.com',    'the pixel posts big payloads (Purchase) into a hidden iframe']
];

for (const [directive, source, why] of REQUIRED) {
  test(`CSP ${directive} keeps ${source} — ${why}`, () => {
    const section = (CSP.split(';').find((s) => s.trim().startsWith(directive + ' ')) || '').trim();
    assert.ok(section, `${directive} is present in the policy`);
    assert.ok(section.split(/\s+/).includes(source), `${directive} still lists ${source}`);
  });
}

test('the policy still refuses the things it is there to refuse', () => {
  const scriptSrc = CSP.split(';').find((s) => s.trim().startsWith('script-src ')) || '';
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src has no unsafe-inline');
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'script-src has no unsafe-eval');
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /frame-ancestors 'none'/, 'other sites still cannot frame us');
  assert.match(CSP, /base-uri 'self'/);
});

test('the account page is never cached — it renders a signed-in dashboard', () => {
  /* Not a micro-optimisation: a cached account.html on a shared machine is
     somebody else's name and order history on screen. */
  const idx = HEADERS.indexOf('/account.html');
  assert.ok(idx > 0, '/account.html has a rule');
  assert.match(HEADERS.slice(idx, idx + 120), /Cache-Control:\s*no-store/);
});
