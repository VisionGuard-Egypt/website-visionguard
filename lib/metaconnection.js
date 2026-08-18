/* =========================================================================
   What are we actually connected to, and is it firing?

   The marketing tab could already tell you how many people a post reached.
   It could not tell you WHICH Page it was asking about, which dataset the
   pixel reports to, or whether anything had reached Meta at all this week.
   Those are the questions somebody asks when the numbers look wrong, and
   they were the ones the panel could not answer.

   ---------------------------------------------------------------------------
   NOTHING SENSITIVE LEAVES THIS FILE
   ---------------------------------------------------------------------------
   Every value here is an identifier or a timestamp. Ids name assets: a Page
   id is in the URL of every post the Page has made, a pixel id ships in the
   markup of every page on this site, and neither is a credential.

   The token is read, used, and never returned. There is no field on the
   object below that could carry one, which is deliberate — this feeds an
   admin screen, and "only ever display non-sensitive ids" is a rule that
   holds much better when the sensitive thing is structurally absent than
   when it depends on the template remembering not to print it.

   ---------------------------------------------------------------------------
   WHY last_fired_time IS THE HEALTH CHECK
   ---------------------------------------------------------------------------
   There is no Meta endpoint that answers "is the pixel installed correctly".
   What there is, is when the dataset last received an event, split by where
   it came from:

     last_fired_time         the BROWSER pixel — public/pixel.js
     server_last_fired_time  the CONVERSIONS API — lib/meta.js

   Two timestamps, and the gap between them is the diagnosis. Both recent is
   healthy. Browser recent and server silent means the token or the dataset
   id is wrong. Server recent and browser silent means the pixel is blocked,
   or consent is never granted, or the script stopped loading. Neither means
   nothing is reaching Meta at all, whatever the dashboard shows.

   That distinction is the whole reason this file exists rather than a single
   green tick, and it is exactly the split that caught the id mismatch in
   lib/meta.js: "WEB" firing on both paths while "visionguardeg" had never
   received a server event in its life.
   ========================================================================= */
import { insightsConfig, pageToken } from './insights.js';

const GRAPH = 'https://graph.facebook.com/v22.0';

/* Short. This is four small reads behind an admin screen that also renders
   without them — a slow answer here should degrade to "unknown", never hold
   the tab open. */
const TIMEOUT_MS = 6000;

/* An event within this window means the path is alive. A day rather than an
   hour because this is a small shop: a quiet night is normal and must not
   render as a fault, or the indicator becomes noise nobody reads. */
const FRESH_MS = 24 * 60 * 60 * 1000;

/* The app the System User token is issued against. Not a secret — it is the
   id in every OAuth URL the app would ever generate. The SECRET is the app
   secret, which this project does not use, does not store, and must never
   store: nothing here performs the server-side OAuth exchange that would
   need one. */
const DEFAULT_APP_ID = '1620559926365637';

const DEFAULT_CATALOG_ID = '1385708380173785';

export function connectionConfig(env) {
  const e = env || {};
  const base = insightsConfig(e);
  return {
    token: base.token,
    dedicatedToken: Boolean(e.META_INSIGHTS_TOKEN),
    appId: String(e.META_APP_ID || DEFAULT_APP_ID).trim(),
    pageId: base.pageId,
    igUserId: base.igUserId,
    adAccountId: base.adAccountId,
    catalogId: String(e.META_CATALOG_ID || DEFAULT_CATALOG_ID).trim(),
    /* The dataset the SERVER posts to, resolved exactly the way
       lib/meta.js resolves it — dataset first, pixel second. Duplicating that
       precedence would be how this panel ends up confidently reporting the
       health of an object the site does not use. */
    pixelId: String(
      e.META_DATASET_ID || e.META_DATASET || e.DATASET_ID ||
      e.META_PIXEL_ID || e.META_PIXEL || e.PIXEL_ID ||
      '3744427775716864'
    ).trim()
  };
}

/* One read. Never throws — a failure is a shaped result whose `error` is
   Meta's own words, the same contract as lib/insights.js. */
async function node(token, id, fields) {
  if (!id) return { ok: false, error: 'not configured' };
  const url = `${GRAPH}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`;
  try {
    const res = await fetch(url, {
      /* Header, not query string: a URL carrying a long-lived credential
         ends up in logs. */
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body = await res.json();
    if (!res.ok || (body && body.error)) {
      const err = (body && body.error) || {};
      return { ok: false, error: err.message || `Meta answered ${res.status}.`, code: err.code };
    }
    return { ok: true, data: body };
  } catch (err) {
    return {
      ok: false,
      error: err && err.name === 'TimeoutError' ? 'Meta did not answer in time.' : (err && err.message) || String(err)
    };
  }
}

/* Meta returns these as ISO strings. Missing means "never", which is a real
   and important answer here — not an error, and not zero. */
function firedAt(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  /* Meta reports a dataset that has never fired as the Unix epoch rather
     than as null. Treated as a date it renders "1 Jan 1970", which reads
     like a bug in this panel rather than like the fact it is. */
  if (t <= 86400000) return null;
  return new Date(t).toISOString();
}

const isFresh = (iso) => Boolean(iso) && (Date.now() - Date.parse(iso)) < FRESH_MS;

/* browser + server -> one verdict, and the verdict names the fault rather
   than grading it. "degraded" is useless to somebody trying to fix it;
   "server_silent" tells them to look at the token. */
export function pixelHealth(browserIso, serverIso) {
  const browser = isFresh(browserIso);
  const server = isFresh(serverIso);
  if (browser && server) return 'ok';
  if (browser && !server) return 'server_silent';
  if (!browser && server) return 'browser_silent';
  return 'silent';
}

export async function fetchConnection(env, options) {
  const c = connectionConfig(env);
  const admin = Boolean(options && options.admin);

  if (!c.token) {
    return {
      ok: false,
      configured: false,
      error: 'No token set. The marketing tab reads Meta with META_INSIGHTS_TOKEN.',
      app: { id: c.appId },
      page: { id: c.pageId },
      pixel: { id: c.pixelId },
      catalogue: { id: c.catalogId },
      adAccount: admin ? { id: c.adAccountId } : null
    };
  }

  /* The Page is read with a PAGE token, not the System User token — the same
     distinction that made the organic half of this tab fail while ads worked;
     see the note above pageToken() in lib/insights.js. Without it this panel
     would report a red error against a Page whose insights are working, which
     is a worse lie than showing nothing. */
  const pt = await pageToken(env, c.token, c.pageId);
  const pageAuth = pt.ok ? pt.token : c.token;

  /* Issued together. None reads another's result, and this sits behind a tab
     somebody opens expecting it to be instant. */
  const [page, pixel, catalogue] = await Promise.all([
    node(pageAuth, c.pageId, 'name'),
    /* server_last_fired_time is what separates "the pixel is blocked" from
       "the token is wrong", and it is the field this whole panel turns on. */
    node(c.token, c.pixelId, 'name,last_fired_time,server_last_fired_time'),
    node(c.token, c.catalogId, 'name,product_count')
  ]);

  const browserFired = pixel.ok ? firedAt(pixel.data.last_fired_time) : null;
  const serverFired = pixel.ok ? firedAt(pixel.data.server_last_fired_time) : null;

  return {
    ok: true,
    configured: true,
    /* Whether the token is a dedicated read token or the borrowed
       Conversions API one. The single likeliest reason for a panel that
       answers and is empty. */
    dedicatedToken: c.dedicatedToken,
    app: { id: c.appId },
    page: {
      id: c.pageId,
      name: page.ok ? page.data.name : null,
      error: page.ok ? null : page.error
    },
    pixel: {
      id: c.pixelId,
      name: pixel.ok ? pixel.data.name : null,
      browserFired,
      serverFired,
      health: pixel.ok ? pixelHealth(browserFired, serverFired) : 'unknown',
      error: pixel.ok ? null : pixel.error
    },
    catalogue: {
      id: c.catalogId,
      name: catalogue.ok ? catalogue.data.name : null,
      products: catalogue.ok && catalogue.data.product_count !== undefined
        ? Number(catalogue.data.product_count)
        : null,
      error: catalogue.ok ? null : catalogue.error
    },
    /* Admin only, matching the split /api/marketing already makes: an
       employee sees the organic side, spend belongs to the administrator. */
    adAccount: admin ? { id: c.adAccountId } : null
  };
}
