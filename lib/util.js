/* =========================================================================
   Shared request helpers for the Pages Functions.

   Lives outside functions/ on purpose: everything inside functions/ is a
   route, so a helper placed there would be publicly fetchable.
   ========================================================================= */

export const CORS_SAFE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

/* `set` for everything except set-cookie, which must be able to appear more
   than once.

   It used to append unconditionally, which is right for cookies and wrong
   for everything else: a caller passing its own cache-control got BOTH the
   default and its own — `no-store, public, max-age=300` — and no-store wins,
   so the override silently did nothing. Only /api/catalog overrides a
   default header today, and it is the one endpoint whose whole point is to
   be cacheable. */
export function json(data, status, extraHeaders) {
  const headers = new Headers(CORS_SAFE_HEADERS);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (k.toLowerCase() === 'set-cookie') headers.append(k, v);
      else headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

export function fail(status, code, message, extra) {
  return json(Object.assign({ ok: false, code, message }, extra || {}), status);
}

/* A thrown ApiError is turned into a clean JSON body by handle(). Keeps the
   route bodies linear instead of a ladder of early returns. */
export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

export function handle(fn) {
  return async function (context) {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.status, err.code, err.message, err.extra);
      }
      console.error('unhandled', err && err.stack ? err.stack : err);
      return fail(500, 'server_error', 'Something went wrong. Please try again.');
    }
  };
}

/* -------------------------------------------------------------------------
   Body reading
   ------------------------------------------------------------------------- */
const MAX_BODY = 64 * 1024;

export async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new ApiError(413, 'too_large', 'Request body too large.');
  let text;
  try {
    text = await request.text();
  } catch (e) {
    throw new ApiError(400, 'bad_body', 'Could not read the request body.');
  }
  if (text.length > MAX_BODY) throw new ApiError(413, 'too_large', 'Request body too large.');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch (e) {
    throw new ApiError(400, 'bad_json', 'Expected a JSON object.');
  }
}

/* -------------------------------------------------------------------------
   CSRF

   The session cookie is SameSite=Lax, which already blocks cross-site POSTs
   from forms and fetches. This is the belt to that braces: every mutating
   request must carry an Origin that matches the host it is hitting. Requests
   with no Origin at all (curl, server-to-server) are allowed through — they
   carry no ambient cookie, so they are not the attack this defends against.
   ------------------------------------------------------------------------- */
export function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    throw new ApiError(403, 'bad_origin', 'Bad origin.');
  }
  if (host !== new URL(request.url).host) {
    throw new ApiError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
  }
}

export function requireMethod(request, method) {
  if (request.method !== method) {
    throw new ApiError(405, 'method_not_allowed', `Use ${method}.`);
  }
}

/* -------------------------------------------------------------------------
   Input cleaning
   ------------------------------------------------------------------------- */

/* Strips control characters (including the bidi overrides that can be used to
   make a stored order line render as something other than what was saved) and
   collapses whitespace. */
export function clean(value, max) {
  if (value === null || value === undefined) return '';
  const s = String(value)
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return max ? s.slice(0, max) : s;
}

export function required(value, field, max) {
  const s = clean(value, max);
  if (!s) throw new ApiError(400, 'missing_field', `Missing field: ${field}`, { field });
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normEmail(value) {
  const s = clean(value, 254).toLowerCase();
  if (!EMAIL_RE.test(s)) throw new ApiError(400, 'bad_email', 'That email address does not look right.', { field: 'email' });
  return s;
}

/* Arabic-Indic and Eastern Arabic-Indic digits, mapped to ASCII. People
   routinely type their number on an Arabic keyboard. */
const DIGIT_MAP = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

export function asciiDigits(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] || d);
}

/* Egyptian mobiles: 11 digits starting 010/011/012/015, with or without the
   +20 country code. Returns E.164 without the plus (2010…), which is the form
   both wa.me and the WhatsApp Cloud API want. */
export function normPhoneEg(value, field, optional) {
  const raw = asciiDigits(value).replace(/[^\d+]/g, '');
  if (!raw) {
    if (optional) return '';
    throw new ApiError(400, 'bad_phone', 'A mobile number is required.', { field: field || 'phone' });
  }
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('0020')) d = d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^1[0125]\d{8}$/.test(d)) {
    throw new ApiError(400, 'bad_phone', 'Enter an Egyptian mobile number, e.g. 01012345678.', { field: field || 'phone' });
  }
  return '20' + d;
}

export function displayPhoneEg(e164) {
  return e164 && e164.startsWith('20') ? '0' + e164.slice(2) : e164 || '';
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-forwarded-for') ||
         '0.0.0.0';
}

/* -------------------------------------------------------------------------
   Cairo-local calendar helpers

   Attendance is a human, local-calendar concept: a shift that starts 23:00
   and ends 01:00 belongs to the day it started. Egypt observes DST, so the
   offset is never hard-coded — Intl resolves it per instant.
   ------------------------------------------------------------------------- */
export const TZ = 'Africa/Cairo';

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
});

export function cairoDate(date) {
  return DATE_FMT.format(date || new Date());        // YYYY-MM-DD
}

export function cairoTime(date) {
  return TIME_FMT.format(date || new Date());        // HH:MM
}

export function cairoStamp(date) {
  const d = date || new Date();
  return cairoDate(d) + ' ' + cairoTime(d);
}
