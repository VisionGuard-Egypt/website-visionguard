/* =========================================================================
   Pushing the shop's products INTO the Meta catalogue.

   THE THIRD DIRECTION. lib/meta.js writes conversions, lib/insights.js reads
   Page and Ads numbers, and this file writes products:

     lib/meta.js       POST /{dataset}/events         a Conversions API token
     lib/insights.js   GET  /{page}/insights          read scopes
     this file         POST /{catalog}/items_batch    catalog_management

   Three different credentials for one business, and the reason they are
   three is that Meta scopes them separately — a token that can send a
   Purchase cannot list a Page's reach, and neither of them can touch a
   product. Pointing this file at META_ACCESS_TOKEN fails with an OAuth error
   rather than with a half-updated catalogue, which is the good outcome.

   ---------------------------------------------------------------------------
   WHAT THIS REPLACES, AND WHAT IT DOES NOT
   ---------------------------------------------------------------------------
   /api/admin/export?kind=catalog still builds the .xlsx an administrator can
   download and upload by hand. That path is not going anywhere: it is the
   one that works when the token is missing, when App Review is mid-flight,
   and when somebody wants to read the feed before it goes anywhere near
   production.

   This is the same rows, sent directly, for the case the spreadsheet handles
   badly — a price that changed this morning. Meta's scheduled Feed pull runs
   at most hourly and the manual upload runs when somebody remembers; the
   Batch API is what makes "I dropped the price" true in the catalogue in the
   time it takes to answer one HTTP request. Both paths call catalogRow() in
   lib/metafeed.js, so they cannot disagree about what a product is.

   ---------------------------------------------------------------------------
   WHAT IT DELIBERATELY DOES NOT DO: DELETE
   ---------------------------------------------------------------------------
   Every request here is an UPDATE with allow_upsert, so this creates and
   revises and never removes. That is not an oversight.

   Withdrawing a product from the shop already works without deletion:
   `active = 0` maps to availability "out of stock", which is what the shop
   wants — the item keeps its id, its history and its ad performance, and
   stops being sellable. Deleting is only correct for a row an administrator
   actually removed from D1, and knowing which rows those are means diffing
   against what Meta currently holds, not reading what we have. A sync that
   inferred deletions from absence would empty the catalogue the first time
   this ran against a partial product list, which is exactly the kind of
   irreversible-looking accident worth not building by accident.

   Delete a product in Commerce Manager if it truly has to go.
   ========================================================================= */
import { catalogRow } from './metafeed.js';

const GRAPH = 'https://graph.facebook.com/v22.0';

/* Meta caps a batch at 5000 items and recommends staying under 3000. This
   catalogue is ~64 rows, so the chunking below will not trigger for years —
   it exists so that the day it does, the failure is a second HTTP request
   rather than a 28 MB body rejected whole. */
const BATCH_LIMIT = 1000;

/* Longer than the 8s lib/insights.js allows itself. That file serves a
   dashboard panel where a slow answer is worse than no answer; this one is
   an explicit button press writing to a catalogue, and giving up on it
   halfway is the expensive outcome. */
const TIMEOUT_MS = 20000;

/* -------------------------------------------------------------------------
   The catalogue this writes to.

   Read off the Vision Guard Eg business (843979858809446) rather than typed
   from notes. There are TWO catalogues on that business and picking the
   wrong one is a silent failure — products would upload cleanly into a
   catalogue no ad reads:

     1385708380173785  "VisonGuardEg-Cataogue"   <- the shop's, and this default
     1411420710903781  "CCTV"                     an older separate catalogue

   A catalogue id is not a credential; it names a destination, the same way
   META_PIXEL_ID names a dataset in lib/meta.js. The token below is the
   credential and has no default anywhere.
   ------------------------------------------------------------------------- */
const DEFAULT_CATALOG_ID = '1385708380173785';

export function catalogConfig(env) {
  const e = env || {};
  /* META_CATALOG_TOKEN first, falling back to the insights token, because
     one System User token generated with both catalog_management and the
     five read scopes serves this file and lib/insights.js at once — which is
     the setup worth encouraging, since it is one thing to rotate rather than
     two. It does NOT fall back to META_ACCESS_TOKEN: that is the Conversions
     API token, it certainly cannot write a product, and falling back to it
     would turn a missing-configuration message into an OAuth error that
     reads like a broken integration. */
  const token = e.META_CATALOG_TOKEN || e.META_INSIGHTS_TOKEN || '';
  const catalogId = String(e.META_CATALOG_ID || DEFAULT_CATALOG_ID).trim();
  /* The origin every image_link and link is built on. Same variable and same
     reasoning as functions/api/admin/export.js: the live site answers on
     both visionguardeg.com and www.visionguardeg.com with no redirect
     between them, and Meta treats those as two different products. Unset is
     allowed — the route passes the request's own origin, which is right
     locally — so this is only the pin. */
  const origin = String(e.SITE_ORIGIN || '').replace(/\/+$/, '');
  return { token, catalogId, origin };
}

/* What the admin panel shows before anybody presses anything, so a missing
   piece is nameable rather than a failed request. Mirrors insightsStatus(). */
export function catalogStatus(env) {
  const c = catalogConfig(env);
  return {
    token: Boolean(c.token),
    /* Whether the token is this file's own or borrowed from the insights
       side. Borrowed is fine IF it was generated with catalog_management —
       and is the single likeliest reason for a sync that authenticates and
       then rejects every item with a permissions error. */
    dedicatedToken: Boolean(env && env.META_CATALOG_TOKEN),
    catalog: Boolean(c.catalogId),
    catalogId: c.catalogId,
    origin: Boolean(c.origin)
  };
}

/* -------------------------------------------------------------------------
   One product -> one batch request.

   catalogRow() does the thinking (which of the two prices is the selling
   price, whether the image will be rejected, how a withdrawn product reads).
   This only turns its named fields into the envelope Meta wants.
   ------------------------------------------------------------------------- */
export function productItem(product, origin) {
  /* Delegates rather than repeating the envelope. buildBatches() below is
     the only place that turns a row into a request, so the single-item path
     a test exercises and the many-item path production uses cannot shape a
     product differently — which is the same argument catalogRow() exists
     for, one level down. */
  return buildBatches([product], origin).requests[0];
}

/* Split a list into fixed-size chunks. Exported for the tests — the boundary
   arithmetic is the kind that is right until the list length is an exact
   multiple of the size. */
export function chunk(list, size) {
  const out = [];
  const items = Array.isArray(list) ? list : [];
  const step = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/* Build the whole payload without sending it. Separated so a test — and the
   endpoint's dry run — can inspect exactly what would go to Meta. */
export function buildBatches(products, origin, size) {
  const list = Array.isArray(products) ? products : [];
  const warnings = [];
  const requests = [];

  const base = String(origin || '').replace(/\/+$/, '');
  for (const p of list) {
    const row = catalogRow(p, base);
    warnings.push(...row.warnings);

    /* `warnings` is ours, not Meta's — it must not travel inside the item.
       Everything else catalogRow() returns is already named exactly as the
       Batch API names it, so the rest of the row goes as-is.

       That includes sale_price WHEN IT IS BLANK, deliberately. Meta leaves a
       field alone when a batch UPDATE omits it, so a product whose discount
       ENDED would keep advertising the old sale price forever if this only
       sent the column when it had a value. An empty string is how the field
       is cleared, and this is the one column where absence and emptiness
       mean different things. */
    const { warnings: _ours, ...fields } = row;
    requests.push({ method: 'UPDATE', data: fields });
  }

  return { requests, batches: chunk(requests, size || BATCH_LIMIT), warnings };
}

/* -------------------------------------------------------------------------
   One batch, posted.

   NOTHING HERE THROWS, for the same reason lib/insights.js does not: this is
   reached from an admin screen, and a rejected batch is information, not a
   500. Every return is shaped and says what Meta said.
   ------------------------------------------------------------------------- */
async function postBatch(token, catalogId, requests) {
  const url = `${GRAPH}/${encodeURIComponent(catalogId)}/items_batch`;

  let res;
  let body;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        /* The token goes in the header, not the query string — a URL
           carrying a long-lived credential ends up in logs. Same choice as
           lib/insights.js, and Graph accepts either. */
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        item_type: 'PRODUCT_ITEM',
        /* Creates items that are not there yet instead of rejecting them,
           which is what makes the first run of this work at all. */
        allow_upsert: true,
        requests
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    body = await res.json();
  } catch (err) {
    const message = err && err.name === 'TimeoutError'
      ? 'Meta did not answer in time.'
      : (err && err.message) || String(err);
    return { ok: false, count: requests.length, error: message };
  }

  if (!res.ok || (body && body.error)) {
    const e = (body && body.error) || {};
    return {
      ok: false,
      count: requests.length,
      status: res.status,
      /* Meta's own words. 190 is a bad token, 200 is a token without
         catalog_management, 80014 is too many batch calls — all three read
         very differently to somebody looking at the panel, and collapsing
         them into "sync failed" would waste the afternoon. */
      error: e.message || `Meta answered ${res.status}.`,
      code: e.code,
      subcode: e.error_subcode
    };
  }

  /* validation_status is per-item and is where a bad image or a missing
     description actually surfaces — the call succeeds, the item does not.
     Passing it back is the difference between "synced 64 products" and
     "synced 64 products, 7 of which Meta refused". */
  const validation = Array.isArray(body && body.validation_status) ? body.validation_status : [];
  const rejected = [];
  const flagged = [];
  for (const v of validation) {
    const id = (v && v.retailer_id) || '';
    for (const err of (v && v.errors) || []) {
      rejected.push(`${id}: ${(err && err.message) || 'rejected'}`);
    }
    for (const warn of (v && v.warnings) || []) {
      flagged.push(`${id}: ${(warn && warn.message) || 'warning'}`);
    }
  }

  return {
    ok: true,
    count: requests.length,
    /* An empty handles array means Meta ingested nothing. Worth carrying:
       it is the one success response that is not one. */
    handles: Array.isArray(body && body.handles) ? body.handles : [],
    rejected,
    flagged
  };
}

/* -------------------------------------------------------------------------
   The whole catalogue, synced.

   `products` are D1 rows exactly as functions/api/admin/catalog.js returns
   them. `origin` is the canonical site origin the links are built on.
   ------------------------------------------------------------------------- */
export async function syncCatalog(env, products, origin) {
  const { token, catalogId, origin: pinned } = catalogConfig(env);

  if (!token || !catalogId) {
    /* Skipped, not failed — the same shape and the same distinction
       sendMetaEvent() makes. A deployment without the token is not broken,
       it is not switched on, and the panel says which. */
    return {
      ok: false,
      skipped: true,
      reason: 'missing_config',
      status: catalogStatus(env)
    };
  }

  const base = pinned || String(origin || '').replace(/\/+$/, '');
  const { batches, warnings, requests } = buildBatches(products, base);

  if (!requests.length) {
    return { ok: true, sent: 0, batches: 0, warnings, handles: [], rejected: [], flagged: [] };
  }

  const handles = [];
  const rejected = [];
  const flagged = [];
  let sent = 0;

  /* Sequential, not Promise.all. These write to one catalogue and Meta rate
     limits batch uploads per catalogue (error 80014); firing four at once is
     how a 64-product shop discovers that limit. The catalogue is small
     enough that this is one request in practice. */
  for (const batch of batches) {
    const result = await postBatch(token, catalogId, batch);
    if (!result.ok) {
      /* Stop at the first failure and report what did land. Carrying on
         after a token or rate-limit error just produces the same error N
         more times and makes the report harder to read. */
      return {
        ok: false,
        sent,
        batches: batches.length,
        error: result.error,
        code: result.code,
        subcode: result.subcode,
        status: result.status,
        warnings,
        handles,
        rejected,
        flagged
      };
    }
    sent += result.count;
    handles.push(...result.handles);
    rejected.push(...result.rejected);
    flagged.push(...result.flagged);
  }

  return {
    ok: true,
    sent,
    batches: batches.length,
    catalogId,
    origin: base,
    /* Ours — rows we already know Meta will not like. */
    warnings,
    /* Meta's — rows it actually refused, and rows it took with a complaint. */
    rejected,
    flagged,
    handles
  };
}
