import { GOVERNORATES } from '../public/catalog.js';
import { cookieValue } from './auth.js';

const DEFAULT_CURRENCY = 'EGP';
const DEFAULT_ATTRIBUTION_SHARE = '0.3';

/* =========================================================================
   CUSTOMER INFORMATION PARAMETERS — normalization, then one hash

   Meta matches an event to a person by comparing SHA-256 hashes of
   identifiers. A hash only matches if BOTH sides normalized the value the
   same way first, so these rules are not cosmetic: "Omar@Example.com " and
   "omar@example.com" produce completely different hashes and the second one
   is the only one that matches anybody.

   Everything here follows Meta's Customer Information Parameters spec, which
   is also what the official parameter-builder SDKs implement. Those SDKs are
   not usable in this project — the server-side builders are Node packages
   and this runs on Workers with no bundler and nothing from npm reaching the
   runtime, the same constraint that made lib/xlsx.js hand-written — so the
   rules are implemented here instead. The one thing that costs is the SDK's
   8-character appendix, which is Meta's telemetry for measuring library
   adoption rather than a matching signal.

   public/track.js hashes the browser-side copy of em, ph and external_id
   with these same rules. If you change one, change both, or the browser
   event and the server event stop describing the same person and Meta
   deduplicates nothing.

   THE RULE THAT IS EASY TO GET WRONG: never hash an empty string. It
   produces a real-looking hash that matches nobody, and Meta counts it as a
   supplied identifier — so a blank field actively LOWERS the match quality
   score rather than being ignored. Everything below drops empties instead.
   ========================================================================= */

/* trim + lowercase. */
function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/* Digits only, country code included, no plus and no leading zero — which is
   exactly the form normPhoneEg() already stores ("201012345678"). */
function normPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

/* Lowercase, no punctuation, no digits, collapsed whitespace. Letters in any
   script are kept: Meta accepts UTF-8 names, and most customers here type
   Arabic. \p{L} rather than a-z is the whole point. */
function normName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\p{N}\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* City drops spaces entirely, unlike a name — Meta's spec is explicit about
   it, so "port said" has to hash as "portsaid". */
function normCity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\p{N}\p{P}\p{S}\s]/gu, '')
    .trim();
}

/* Two-letter ISO 3166-1 alpha-2, lowercase. */
function normCountry(value) {
  return String(value || '').trim().toLowerCase().slice(0, 2);
}

/* -------------------------------------------------------------------------
   Governorate -> a Latin city name

   Checkout stores whichever language the customer had selected, because
   isGovernorate() accepts either, so this column is Arabic for most orders.
   Meta matches `ct` against a Latin-alphabet city, so the Arabic form is
   translated back before it is normalized and hashed. Sending the Arabic
   would hash cleanly and match nobody.
   ------------------------------------------------------------------------- */
const GOV_EN = new Map();
for (const g of GOVERNORATES) {
  GOV_EN.set(g.ar, g.en);
  GOV_EN.set(g.en, g.en);
}

export function cityEn(value) {
  return GOV_EN.get(String(value || '').trim()) || String(value || '');
}

/* Meta takes the two names separately. A single-word name gives a first name
   and nothing else, which is what it expects for a mononym — better than
   duplicating the word into both fields and inventing a surname. */
export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { fn: '', ln: '' };
  if (parts.length === 1) return { fn: parts[0], ln: '' };
  return { fn: parts[0], ln: parts.slice(1).join(' ') };
}

async function hashValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------------------
   Meta's click id, rebuilt when the cookie is not there yet

   If the visitor arrived on an ad, fbclid is in the URL and fbevents.js turns
   it into an _fbc cookie — but only once it has loaded, which is exactly what
   a blocked pixel never does. Rebuilding it from the URL keeps the click
   attributable in the case the server-side path exists for.

   Format per Meta: fb.{subdomain_index}.{creation_time}.{fbclid}
   ------------------------------------------------------------------------- */
export function fbcFrom(request, sourceUrl) {
  const existing = cookieValue(request, '_fbc');
  if (existing) return existing;
  try {
    const fbclid = new URL(sourceUrl).searchParams.get('fbclid');
    if (fbclid) return `fb.1.${Date.now()}.${fbclid}`;
  } catch (e) { /* not a URL we can parse; no click id then */ }
  return '';
}

/* -------------------------------------------------------------------------
   One user_data builder, used by every event this file sends.

   It existed twice before, differently: the /api/capi relay collected six
   identifiers and the server-side Purchase — the most valuable event there
   is — collected two, despite the order carrying a name, a governorate, an
   IP and a user id. That asymmetry was invisible because both halves
   "worked".
   ------------------------------------------------------------------------- */
async function hashed(target, key, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return;                 // never hash an empty string
  target[key] = [await hashValue(normalized)];
}

export async function buildUserData(raw) {
  const ud = {};
  const r = raw || {};

  await hashed(ud, 'em', normEmail(r.email));
  await hashed(ud, 'ph', normPhone(r.phone));

  const { fn, ln } = splitName(r.name);
  await hashed(ud, 'fn', normName(fn));
  await hashed(ud, 'ln', normName(ln));

  await hashed(ud, 'ct', normCity(cityEn(r.city)));
  await hashed(ud, 'country', normCountry(r.country));

  /* Our own stable id for the person, hashed the same way public/track.js
     hashes it — raw string in, SHA-256 out, no normalization — so the
     browser and the server produce the same digest. */
  await hashed(ud, 'external_id', r.externalId);

  /* NEVER hashed. Meta rejects a hashed IP or user agent, and fbp/fbc are
     its own identifiers which it reads verbatim. */
  if (r.fbp) ud.fbp = r.fbp;
  if (r.fbc) ud.fbc = r.fbc;
  if (r.clientIp) ud.client_ip_address = r.clientIp;
  if (r.userAgent) ud.client_user_agent = r.userAgent;

  return ud;
}

/* Exported for the tests, which assert the normalization rules directly —
   getting one wrong is silent, and Meta accepts the event either way. */
export const _internals = { normEmail, normPhone, normName, normCity, normCountry };

function configFromEnv(env) {
  /* The pixel — which Meta now also calls the dataset; one object, one id.
     Here it is "WEB", 3744427775716864.

     It has a default for the third time in this repository, and for the same
     reason each time (see WHATSAPP_TEMPLATE in lib/whatsapp.js and
     FIREBASE_PROJECT_ID in lib/firebase.js): wrangler.toml [vars] have not
     reliably reached this Pages project's runtime, and an empty value here
     does not fail loudly — sendMetaEvent returns `missing_config` and every
     conversion is silently dropped. The id is public: it ships in the markup
     of every page and identifies the dataset, nothing more. It is NOT the
     access token, which is a real credential and has no default anywhere.

     It must stay identical to PIXEL_ID in public/pixel.js, or the browser
     and the server would report to two different datasets and neither set of
     numbers would be complete. Change one, change both.

     AND IT DID NOT. This default was '2037293923502315' ("visionguardeg")
     while public/pixel.js has fired to '3744427775716864' ("WEB"). The rule
     above was written and then broken, which is worth spelling out because
     the breakage was invisible: production sets META_PIXEL_ID in the
     dashboard, so the wrong default never took effect and nothing ever
     reported a split. Lose that variable — a fresh environment, a preview
     deployment, a dashboard edit — and every server-side conversion silently
     goes to a dataset that has not received a server event in its life.

     Meta's own numbers settle which id is right, and they are not close:

       3744427775716864  "WEB"           browser AND server fired today
       2037293923502315  "visionguardeg" browser last fired 5 Aug,
                                         server NEVER

     So the default is now the id the site actually reports to. */
  const pixelId = (env && (env.META_PIXEL_ID || env.META_PIXEL || env.PIXEL_ID)) || '3744427775716864';
  /* The dataset (or pixel) events are posted to.

     There used to be a hardcoded default here — '37444427775716864' — and it
     was wrong by one digit: the real dataset on this account is
     3744427775716864, sixteen digits, not seventeen. Because sendMetaEvent
     prefers the dataset over the pixel, EVERY server-side event was posted to
     an object that does not exist. Graph answers "Object with ID ... does not
     exist", the send fails, and nothing downstream notices, because the
     failure is logged and the order carries on. Server-side Purchase events
     had therefore never arrived, whatever the token said.

     No default now. Unset means "use the pixel id", which is always correct
     and always exists — the pixel is what the browser already reports to, so
     the two halves land in the same place by construction. Set
     META_DATASET_ID only if you deliberately want a different destination,
     and then a typo shows up as events missing from ONE named place rather
     than silently vanishing. */
  const datasetId = (env && (env.META_DATASET_ID || env.META_DATASET || env.DATASET_ID)) || '';
  /* No hardcoded fallback, deliberately. A Conversions API token is a
     long-lived credential with write access to the ad account's dataset, and
     lib/ is committed — a default here is a secret published to whoever can
     read the repository. If the variable is missing, sendMetaEvent returns a
     'not configured' result and the site carries on; that is the correct
     failure, and it is visible. */
  const accessToken = (env && (env.META_ACCESS_TOKEN || env.META_TOKEN || env.FB_ACCESS_TOKEN)) || '';
  const currency = (env && (env.META_CURRENCY || env.META_CURRENCY_CODE)) || DEFAULT_CURRENCY;
  const attributionShare = Number((env && env.META_ATTRIBUTION_SHARE) || DEFAULT_ATTRIBUTION_SHARE);
  return { pixelId, datasetId, accessToken, currency, attributionShare };
}

/* =========================================================================
   A single conversion, sent server-to-server.

   This is what /api/capi uses. It is the same Conversions API the Purchase
   event below has always used, generalised so any event the browser fires
   can be mirrored from the server.

   WHY MIRROR AT ALL. The browser pixel is blocked for a large share of real
   traffic — ad blockers, Safari's tracking protection, privacy browsers. A
   server-sent copy is not blocked, because it does not come from the
   browser. Meta collapses the pair into one event when both carry the same
   event_id, which is why track.js generates one per event and sends it to
   both.

   WHAT MAKES IT MATCH. An event with no identifiers is nearly useless to
   Meta — it cannot attribute it to anyone who saw an ad. The three things
   that matter most here are the _fbp / _fbc cookies (Meta's own browser and
   click identifiers), the customer's IP, and the user agent. All three are
   read server-side, where the browser cannot get them wrong and an ad
   blocker cannot strip them.

   WHAT NEVER LEAVES RAW. Email and phone are hashed with SHA-256 before the
   request is built, which is what Meta requires and what makes this safe:
   Meta receives an irreversible fingerprint it can match against its own
   hashes, never the address itself.
   ========================================================================= */
export async function sendMetaConversion(env, event) {
  const { currency, attributionShare } = configFromEnv(env);

  /* fbp is the browser id Meta sets itself; fbc is derived from the fbclid on
     an ad click and is the single strongest attribution signal there is. */
  const userData = await buildUserData(event);

  const custom = Object.assign({}, event.customData || {});
  if (custom.value !== undefined) custom.value = Number(custom.value) || 0;
  if (!custom.currency) custom.currency = currency;
  if (Number.isFinite(custom.value)) custom.value = Number(custom.value.toFixed(2));

  const eventTime = Math.floor(Date.now() / 1000);
  const payload = {
    data: [{
      event_name: event.eventName,
      event_time: eventTime,
      event_id: event.eventId || '',
      action_source: 'website',
      event_source_url: event.sourceUrl || '',
      user_data: userData,
      attribution_data: { attribution_share: attributionShare },
      custom_data: custom,
      original_event_data: {
        event_name: event.eventName,
        event_time: eventTime
      }
    }]
  };

  if (env && env.META_TEST_EVENT_CODE) {
    payload.data[0].test_event_code = env.META_TEST_EVENT_CODE;
  }

  return sendMetaEvent(env, payload);
}

export async function sendMetaEvent(env, payload) {
  const { pixelId, datasetId, accessToken } = configFromEnv(env);
  if (!pixelId || !accessToken) {
    return { ok: false, skipped: true, reason: 'missing_config' };
  }

  if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
    return { ok: false, skipped: false, error: 'missing_data' };
  }

  const targetId = datasetId || pixelId;
  const endpoint = `https://graph.facebook.com/v22.0/${encodeURIComponent(targetId)}/events?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const bodyText = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body: bodyText,
      skipped: false
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

/* =========================================================================
   Purchase, server side.

   DEDUPLICATION — the part that was missing and silently doubled every
   number in Ads Manager.

   This event is deliberately sent twice: once from the browser (public/
   track.js, when the confirmation screen appears) and once from here. The
   server copy is the one that survives ad blockers and Safari's tracking
   protection, which is most of this shop's traffic; the browser copy carries
   the cookies Meta matches on. Sending both is correct and is what Meta
   recommends.

   But Meta only collapses the pair into ONE conversion when both copies
   carry the same `event_id` alongside the same `event_name`. Neither copy
   had one. Every order was therefore counted as two purchases at twice the
   revenue — and nothing anywhere reports that, because both events are
   individually valid.

   The order number is the id. It already exists, it is unique per order by
   construction, it is known to both sides at the moment each fires, and it
   is not personal data.
   ========================================================================= */
export async function sendMetaPurchaseEvent(env, order, requestUrl) {
  const { currency, attributionShare } = configFromEnv(env);

  /* THE ONE EVENT WORTH GETTING RIGHT.

     This used to send two identifiers — a hashed email and a hashed phone —
     while the order object in front of it already carried a name, a
     governorate, the customer's id and their IP, and the request carried the
     user agent and Meta's own _fbp / _fbc cookies. Nine identifiers were
     available and two were sent, on the event every ad's attribution turns
     on. Nothing failed; the match quality was simply a quarter of what the
     shop already knew.

     `country` is 'eg' because this shop delivers in Egypt and nowhere else —
     checkout only offers Egyptian governorates. It is a constant here rather
     than a column because there is no case where it is anything else. */
  const userData = await buildUserData({
    email: order && order.email,
    phone: order && order.phone,
    name: order && order.name,
    city: order && order.governorate,
    country: 'eg',
    externalId: order && order.userId,
    fbp: order && order.fbp,
    fbc: order && order.fbc,
    clientIp: order && order.clientIp,
    userAgent: order && order.userAgent
  });

  const value = Number(order && (order.total ?? order.value ?? order.subtotal) || 0);
  const eventTime = Math.floor(Date.now() / 1000);
  const eventId = order && order.id ? String(order.id) : '';

  /* The same contents the browser sends, so the two copies describe one
     order rather than merely agreeing on a total. */
  const items = Array.isArray(order && order.items) ? order.items : [];
  const contents = items.map((i) => ({
    id: String(i.id),
    quantity: Number(i.qty) || 0,
    item_price: Number(i.unit) || 0
  }));

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime,
      /* Must match the browser's eventID exactly, or Meta counts this order
         twice. See the note above. */
      event_id: eventId,
      action_source: 'website',
      event_source_url: requestUrl || '',
      user_data: userData,
      attribution_data: {
        attribution_share: attributionShare
      },
      custom_data: {
        currency,
        value: Number.isFinite(value) ? Number(value.toFixed(2)) : 0,
        content_type: 'product',
        order_id: eventId,
        ...(contents.length
          ? {
              contents,
              content_ids: contents.map((c) => c.id),
              num_items: contents.reduce((n, c) => n + c.quantity, 0)
            }
          : {})
      },
      original_event_data: {
        event_name: 'Purchase',
        event_time: eventTime
      }
    }]
  };

  if (env && env.META_TEST_EVENT_CODE) {
    payload.data[0].test_event_code = env.META_TEST_EVENT_CODE;
  }

  return await sendMetaEvent(env, payload);
}
