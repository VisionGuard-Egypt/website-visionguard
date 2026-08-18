/* Catch-all for /api/* paths that match no route.

   Cloudflare Pages serves the static site for anything Functions do not
   claim, so an unknown /api/ URL used to return index.html with a 200. In a
   browser that renders as the shop's homepage, unstyled, at an API address —
   which is what the Conversions API Gateway onboarding produced when Meta
   requested /api/capi/capig/autoconfig: a page that looks like a broken
   website instead of a plain "there is nothing here".

   A JSON 404 makes the failure legible to whoever is looking — a person
   pasting a URL, a script checking a response code, or Meta's onboarding
   flow probing for endpoints it expects to exist.

   Pages matches more specific files first, so every real route continues to
   win over this one. It only ever answers what nothing else did.
*/
import { json } from '../../lib/util.js';

const KNOWN = [
  'GET  /api/catalog',
  'GET  /api/geo',
  'POST /api/orders',
  'GET  /api/orders',
  'POST /api/newsletter',
  'POST /api/assist',
  'POST /api/capi',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET  /api/auth/me',
  'POST /api/auth/firebase',
  'POST /api/account/preferences',
  'GET  /api/attendance',
  'POST /api/attendance/clock',
  'GET  /api/attendance/team',
  'GET  /api/admin/stats',
  'GET  /api/notifications',
  'POST /api/notifications',
  'GET  /api/messages',
  'POST /api/messages',
  'GET  /api/leave',
  'POST /api/leave',
  'GET  /api/leave/certificate',
  'GET  /api/admin/leave',
  'POST /api/admin/leave',
  'GET  /api/leads',
  'POST /api/leads',
  'GET  /api/notify-optin',
  'POST /api/notify-optin'
];

export const onRequest = async ({ request }) => {
  const url = new URL(request.url);
  return json({
    ok: false,
    code: 'no_such_endpoint',
    message: `No API endpoint at ${request.method} ${url.pathname}.`,
    endpoints: KNOWN
  }, 404);
};
