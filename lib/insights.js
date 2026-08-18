/* =========================================================================
   Reading from Meta — Page, Instagram and Ads.

   The OPPOSITE DIRECTION to lib/meta.js. That file writes: it posts
   conversions to the dataset and never asks Meta anything. This one only
   reads, and the two must not be confused, because they need different
   credentials for the same account:

     lib/meta.js      POST /{dataset}/events        a Conversions API token
     this file        GET  /{page}/insights         pages_read_engagement,
                      GET  /{ig-user}/insights      read_insights,
                      GET  /act_{id}/insights       instagram_basic,
                                                    instagram_manage_insights,
                                                    ads_read

   A CAPI token carries none of those five. Pointing this file at
   META_ACCESS_TOKEN therefore fails with an OAuth error rather than with
   empty numbers — which is the good outcome, and the reason every failure
   below is reported rather than swallowed. META_INSIGHTS_TOKEN is read first
   so the read token can be a System User token from Business Manager without
   disturbing the write path that already works.

   WHY A SYSTEM USER TOKEN. A personal user token expires in about 60 days.
   A dashboard wired to one works for two months and then goes blank on an
   ordinary morning with nothing in the logs to explain it — the token did not
   error, it simply stopped being valid. A System User token with the Page,
   the Instagram account and the ad account assigned to it does not expire,
   and it usually avoids App Review entirely: review governs asking OTHER
   people for these permissions, and this is a business reading its own assets.

   NOTHING HERE THROWS. Every function returns a shaped result whose `ok` says
   whether it worked and whose `error` says what Meta said when it did not.
   A marketing tab that renders "Instagram: (#100) unsupported metric" is
   diagnosable; one that renders a zero is a lie, and one that 500s takes the
   orders half of the panel down with it.
   ========================================================================= */

const GRAPH = 'https://graph.facebook.com/v22.0';

/* Fifteen minutes. Insights move slowly — Meta's own numbers lag by hours —
   and the endpoints are rate-limited hard enough that an uncached dashboard
   burns the account's quota by being opened a few times. The KV binding is
   already there for product images (lib/images.js). */
const CACHE_SECONDS = 900;

/* Graph can hang; a Pages Function cannot. Without a timeout a slow Meta
   response holds the whole request open and the tab spins with no error. */
const TIMEOUT_MS = 8000;

/* -------------------------------------------------------------------------
   THE IDS, RESOLVED FROM THE BUSINESS RATHER THAN FROM MEMORY

   The two ids below were read off the Vision Guard Eg business
   (843979858809446) through the Meta developer tooling, not typed from
   notes. They name assets, and naming an asset is not a credential:

     843967908810641        the "Vision Guard" Page — public, it is in the
                            URL of every post the Page has ever made
     act_2067738330681838   the "vision guard" ad account, EGP, active

   The catalogue id belongs to the same business and is defaulted the same
   way, but it lives in lib/metacatalog.js with the code that writes to it.

   They have defaults for the same reason META_PIXEL_ID does in lib/meta.js,
   and the reason is worth repeating rather than cross-referencing: this
   Pages project's wrangler.toml [vars] have not reliably reached the
   runtime, and an unset id here does not fail loudly. It renders a tab that
   says "not configured" about a Page whose id has been known all along,
   which is the exact half-hour of confusion the file header warns about.

   THE TOKEN STILL HAS NO DEFAULT, AND MUST NOT GET ONE. It is a long-lived
   credential with read access to the business's Page, Instagram and ad
   account, and lib/ is committed. An unset token is a tab that says so.
   ------------------------------------------------------------------------- */
const DEFAULT_PAGE_ID = '843967908810641';
const DEFAULT_AD_ACCOUNT_ID = 'act_2067738330681838';

export function insightsConfig(env) {
  const e = env || {};
  /* The read token, preferred over the write one. See the header. */
  const token = e.META_INSIGHTS_TOKEN || e.META_ACCESS_TOKEN || '';
  const pageId = e.META_PAGE_ID || DEFAULT_PAGE_ID;
  /* No default. The Instagram account is the one id that could not be read
     back from the business: the ad account has no Instagram account linked
     for advertising, so it does not appear in any listing, and guessing it
     would point the tab at somebody else's profile. Get it from the Page —
     GET /843967908810641?fields=instagram_business_account — and set it.
     Until then the Instagram panel says it is missing, which is true. */
  const igUserId = e.META_IG_USER_ID || '';
  /* Accepted with or without the act_ prefix, because Ads Manager shows it
     both ways depending on where you look and a mismatch here reads as an
     empty ads section rather than as a typo. */
  const rawAct = String(e.META_AD_ACCOUNT_ID || '').trim() || DEFAULT_AD_ACCOUNT_ID;
  const adAccountId = rawAct ? (rawAct.startsWith('act_') ? rawAct : 'act_' + rawAct) : '';
  return { token, pageId, igUserId, adAccountId };
}

/* What the account page shows on the "not switched on yet" screen, and what
   /api/marketing reports so the gap is nameable rather than mysterious. */
export function insightsStatus(env) {
  const c = insightsConfig(env);
  return {
    token: Boolean(c.token),
    /* A read token that is merely the write token cannot carry the read
       scopes. Worth saying out loud: it is the single likeliest reason for a
       tab that is configured and still empty. */
    dedicatedToken: Boolean(env && env.META_INSIGHTS_TOKEN),
    /* These two are now true on every deployment, because the ids default
       above. That is not the flag going stale — it is the honest answer:
       the Page and the ad account really are known. Read them as "this
       endpoint knows where to look", and read `token` as whether it is
       allowed to. A configured-and-empty tab is a token problem, and
       `dedicatedToken` is the flag that names it. */
    page: Boolean(c.pageId),
    /* Still genuinely varies — see the note on igUserId above. */
    instagram: Boolean(c.igUserId),
    ads: Boolean(c.adAccountId)
  };
}

/* -------------------------------------------------------------------------
   One Graph call, cached.
   ------------------------------------------------------------------------- */
const kvOf = (env) => (env && env.KV) || null;

function cacheKey(path, params) {
  const parts = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return `insights:${path}?${parts}`;
}

async function graph(env, token, path, params, cacheable) {
  const kv = kvOf(env);
  const key = cacheKey(path, params);

  if (cacheable && kv) {
    try {
      const hit = await kv.get(key, 'json');
      if (hit) return { ok: true, data: hit, cached: true };
    } catch (err) {
      /* A KV read failing is a cache miss, not an error worth surfacing. */
      console.error('insights cache read failed', err && err.message);
    }
  }

  const query = new URLSearchParams(params);
  /* The token goes in the header, not the query string: a URL carrying a
     long-lived credential ends up in logs, and Graph accepts either. */
  const url = `${GRAPH}/${path}?${query}`;

  let res;
  let body;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    body = await res.json();
  } catch (err) {
    const message = err && err.name === 'TimeoutError'
      ? 'Meta did not answer in time.'
      : (err && err.message) || String(err);
    return { ok: false, error: message };
  }

  if (!res.ok || (body && body.error)) {
    /* Meta's own words, passed through. "(#200) Requires ads_read" tells the
       administrator exactly which scope is missing; "unavailable" would send
       them looking in the wrong place. */
    const e = (body && body.error) || {};
    return {
      ok: false,
      error: e.message || `Graph returned ${res.status}`,
      code: e.code,
      type: e.type
    };
  }

  if (cacheable && kv) {
    try {
      await kv.put(key, JSON.stringify(body), { expirationTtl: CACHE_SECONDS });
    } catch (err) {
      console.error('insights cache write failed', err && err.message);
    }
  }

  return { ok: true, data: body, cached: false };
}

/* -------------------------------------------------------------------------
   THE FALLBACK THAT LOOKS LIKE A PERMISSIONS PROBLEM

   insightsConfig() falls back to META_ACCESS_TOKEN when META_INSIGHTS_TOKEN
   is unset. That fallback is deliberate — it means a half-configured
   deployment still ANSWERS rather than going dark — but the failure it
   produces is thoroughly misleading, because the Conversions API token is a
   valid token that simply carries no read scopes. Meta therefore replies
   with per-endpoint permission errors rather than "bad token":

     Page       (#100) ... requires the 'pages_read_engagement' permission
     Instagram  (#100) ... the same, since Instagram is read through the Page
     Ads        (#200) Ad account owner has NOT grant ads_read permission

   Three different-looking errors, one cause, and not one of them names it.
   Every hour spent adding scopes and reassigning assets in Business Manager
   is spent on a token the site is not even using.

   The trigger is usually a token being revoked or rotated: the variable goes,
   the fallback engages, and a panel that worked an hour ago fails everywhere
   at once. Failing EVERYWHERE at once is the tell — a genuine scope problem
   takes out one section, not all three.

   So when the read token is not this file's own, a failure is reported as
   what it is. The call is still attempted first: a single token that legitimately
   carries both the write and the read scopes keeps working, and only a
   deployment that actually failed gets the message. */
const NO_READ_TOKEN =
  'No dedicated read token is set, so the site fell back to the Conversions API token (META_ACCESS_TOKEN). ' +
  'That token can send events but carries none of the read scopes, which is why Facebook, Instagram and Ads all fail at once. ' +
  'Set META_INSIGHTS_TOKEN to a System User token with the read scopes, then redeploy.';

function readFailure(env, error, code) {
  if (!(env && env.META_INSIGHTS_TOKEN)) return { ok: false, configured: true, error: NO_READ_TOKEN };
  return { ok: false, configured: true, error, code };
}

/* -------------------------------------------------------------------------
   THE PAGE ACCESS TOKEN, AND WHY THE ORGANIC HALF NEEDED ONE

   A System User token reads an ad account directly. It does NOT read a Page's
   insights. Meta's "Get Page Insights" guide lists three prerequisites, and
   the third is the one that is easy to miss because it is not a permission:

     pages_read_engagement    permission
     read_insights            permission
     A PAGE ACCESS TOKEN      "The person requesting the token must be able to
                               perform the analyze task on the Page."

   Every sample call in that guide passes access_token={page-access-token}.

   This file used to send the System User token to /{page-id}/insights, which
   produces a failure that reads like a scope problem and is not:

     (#100) Object does not exist, cannot be loaded due to missing permission
     or reviewable feature ... requires the 'pages_read_engagement' permission

   You can hold that permission, have the Page assigned to the System User,
   and still get it — because the token is the wrong KIND of token, not an
   under-scoped one. That message sends people to add scopes they already
   have, which is where the last few hours went.

   THE SYMPTOM THAT NAMES IT: ads work and organic does not. Ad insights take
   the System User token; Page and Instagram insights do not. If both halves
   failed it would be the token or the assets. Only one half failing is this.

   The exchange itself is one call — a Page you can analyze returns its token
   as an ordinary field.

   NOT CACHED, DELIBERATELY. graph() caches responses in KV, and a Page access
   token is a credential rather than a response. It is cheap to re-fetch (the
   insights it guards are themselves cached for fifteen minutes, so this runs
   about as often as those miss) and a credential that is never written down
   cannot leak from where it was written.
   ------------------------------------------------------------------------- */
export async function pageToken(env, token, pageId) {
  const res = await graph(env, token, encodeURIComponent(pageId), { fields: 'access_token' }, false);
  if (!res.ok) return { ok: false, error: res.error, code: res.code };
  const pt = res.data && res.data.access_token;
  if (!pt) {
    /* Reached the Page and it handed back no token: the System User can see
       the Page but cannot ANALYZE it. That is an asset-assignment task level,
       and it is worth saying so rather than falling through to a second
       (#100) from the insights call. */
    return {
      ok: false,
      error: 'The Page returned no access token. Assign the Page to the System User with the Analyze task (Business Settings → Accounts → Pages → Assign partners/people).'
    };
  }
  return { ok: true, token: pt };
}

/* -------------------------------------------------------------------------
   Shaping

   Page and Instagram insights come back as a list of metric objects, each
   with its own array of daily values. Summing is right for counts (reach,
   impressions); the LAST value is right for totals that are already
   cumulative (follower counts). Getting that backwards turns a follower
   count into the sum of every daily follower count, which is a number in the
   millions and obviously wrong — but only obviously if you know to look.
   ------------------------------------------------------------------------- */
function seriesTotal(metric) {
  const values = (metric && metric.values) || [];
  return values.reduce((n, v) => n + (Number(v && v.value) || 0), 0);
}

function seriesLast(metric) {
  const values = (metric && metric.values) || [];
  if (!values.length) return 0;
  return Number(values[values.length - 1].value) || 0;
}

function byName(data) {
  const out = {};
  for (const m of (data && data.data) || []) out[m.name] = m;
  return out;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function dateWindow(days) {
  const until = new Date();
  const since = new Date(Date.now() - days * 86400000);
  return { since: ymd(since), until: ymd(until) };
}

/* -------------------------------------------------------------------------
   Facebook Page — organic
   ------------------------------------------------------------------------- */
export async function fetchPageInsights(env, days) {
  const { token, pageId } = insightsConfig(env);
  if (!token || !pageId) return { ok: false, configured: false };

  /* Page insights need a PAGE token, not the System User token — see the
     note above pageToken(). Sending the wrong kind is what made this section
     fail while ads worked. */
  const pt = await pageToken(env, token, pageId);
  if (!pt.ok) return readFailure(env, pt.error, pt.code);
  const pageAuth = pt.token;

  const { since, until } = dateWindow(days);

  /* ONE METRIC PER REQUEST, AND WHY THAT IS WORTH FOUR CALLS.

     Meta retires Page metrics on a schedule, and a request naming several
     metrics fails ENTIRELY if any one of them is dead:

       (#100) The value must be a valid insights metric

     That is how this panel went blank. It asked for page_impressions,
     page_impressions_unique and page_post_engagements together;
     page_impressions and page_impressions_unique were deprecated on
     15 November 2025 in favour of "views", and the third metric — which is
     still perfectly valid — was lost with them. One stale name took the
     whole organic half down, and the error named none of them.

     Asked separately, a dead metric costs exactly its own tile. The panel
     degrades one number at a time instead of all at once, which is also how
     it survives the NEXT deprecation without anybody editing this file.

     Each candidate list is in preference order, newest name first. The
     fallbacks are kept deliberately: Meta's deprecations land per API
     version, and a name that is dead on v22 may still answer elsewhere.
     Four cached calls, fifteen minutes apart, is a cheap price for a panel
     that cannot be silently emptied by a rename. */
  const firstMetric = async (candidates, pick) => {
    for (const metric of candidates) {
      const res = await graph(env, pageAuth, `${encodeURIComponent(pageId)}/insights`, {
        metric, period: 'day', since, until
      }, true);
      if (!res.ok) continue;
      const found = byName(res.data)[metric];
      /* Graph answers 200 with an empty data array for a metric it knows but
         has nothing for. That is a real zero, not a miss — stop here rather
         than falling through to a legacy name and reporting its number. */
      if (!found) continue;
      return { value: pick(found), metric };
    }
    return { value: 0, metric: null };
  };

  const [views, reach, engagements, followers] = await Promise.all([
    /* "impressions" is gone; "views" replaced it. */
    firstMetric(['page_views_total', 'page_media_view', 'page_impressions'], seriesTotal),
    /* Reach: the unique variant went with it. page_total_media_view_unique is
       the modern unique-viewers count. */
    firstMetric(['page_total_media_view_unique', 'page_impressions_unique'], seriesTotal),
    firstMetric(['page_post_engagements'], seriesTotal),
    /* page_fans was deprecated alongside impressions. page_follows is the
       replacement, and it is cumulative — the LAST value, never the sum. */
    firstMetric(['page_follows', 'page_fans'], seriesLast)
  ]);

  /* Every metric refused means the call itself is not working — say so,
     rather than rendering four confident zeroes. */
  if (!views.metric && !reach.metric && !engagements.metric && !followers.metric) {
    return {
      ok: false,
      configured: true,
      error: 'Meta accepted the token but refused every Page metric requested. They may have been deprecated again — check the Page Insights changelog.'
    };
  }

  return {
    ok: true,
    configured: true,
    impressions: views.value,
    reach: reach.value,
    engagements: engagements.value,
    followers: followers.value,
    /* Which name actually answered. Invisible in the UI, and the first thing
       worth knowing the next time a tile reads zero. */
    metrics: {
      impressions: views.metric,
      reach: reach.metric,
      engagements: engagements.metric,
      followers: followers.metric
    }
  };
}

/* -------------------------------------------------------------------------
   Instagram — organic

   PREREQUISITE NO TOKEN CAN FIX: the account must be a Business or Creator
   account linked to the Page. A personal Instagram account has no insights
   over the API at all. Confirm the link with
       GET /{page-id}?fields=instagram_business_account
   which is what discoverIgAccount() below does.
   ------------------------------------------------------------------------- */
export async function fetchIgInsights(env, days) {
  const { token, pageId } = insightsConfig(env);
  let { igUserId } = insightsConfig(env);
  if (!token || !pageId) return { ok: false, configured: false };

  /* An Instagram business account is reached THROUGH the Page, so this needs
     the same Page token the Facebook half needs. */
  const pt = await pageToken(env, token, pageId);
  if (!pt.ok) return readFailure(env, pt.error, pt.code);
  const pageAuth = pt.token;

  /* THE ID NO LONGER HAS TO BE FOUND BY HAND.

     META_IG_USER_ID was the one value that could not be resolved from the ad
     account — an Instagram account linked to a Page but not attached to the
     ad account for advertising appears in no ads listing, which is why every
     attempt to look it up came back empty. It was never missing; it was being
     asked for in the wrong place.

     The Page knows it, and with a Page token we can simply ask. Setting the
     variable still wins if it is set — this is the fallback, not an override. */
  if (!igUserId) {
    const found = await graph(env, pageAuth, encodeURIComponent(pageId), {
      fields: 'instagram_business_account{id,username}'
    }, true);
    const ig = found.ok && found.data && found.data.instagram_business_account;
    if (ig && ig.id) {
      igUserId = ig.id;
    } else {
      /* Genuinely not linked. No token fixes this one — the account has to be
         a Business or Creator account connected to the Page. */
      return {
        ok: false,
        configured: false,
        error: 'No Instagram business account is linked to this Page. Link a Business or Creator account in the Page settings, or set META_IG_USER_ID.'
      };
    }
  }

  const { since, until } = dateWindow(days);

  /* Same one-metric-per-request treatment as the Page above, and for the same
     reason: Instagram retires metric names too, and a combined request dies
     whole when one of them goes. */
  const igMetric = async (candidates) => {
    let lastError = null;
    for (const metric of candidates) {
      const res = await graph(env, pageAuth, `${encodeURIComponent(igUserId)}/insights`, {
        metric, period: 'day', since, until
      }, true);
      if (!res.ok) { lastError = res; continue; }
      const found = byName(res.data)[metric];
      if (!found) continue;
      return { value: seriesTotal(found), metric, error: null };
    }
    return { value: 0, metric: null, error: lastError };
  };

  const [reachM, viewsM] = await Promise.all([
    igMetric(['reach']),
    igMetric(['profile_views', 'views'])
  ]);

  if (!reachM.metric && !viewsM.metric) {
    const err = reachM.error || viewsM.error || {};
    /* (#10) on an Instagram insights call is almost always one specific
       thing, and Meta's own wording — "Application does not have permission
       for this action" — does not say which permission. Naming it turns a
       dead end into a five-minute fix.

       instagram_basic is enough to SEE the account; reading its insights
       needs instagram_manage_insights as well, and it is easy to generate a
       System User token with the first and not the second. */
    const hint = err.code === 10 || /does not have permission/i.test(String(err.error || ''))
      ? 'Instagram insights need the instagram_manage_insights scope. instagram_basic alone can see the account but not read its numbers — regenerate the System User token with both.'
      : (err.error || 'Instagram refused every metric requested.');
    return readFailure(env, hint, err.code);
  }

  /* Follower count is a field on the user, not a metric on insights. Cheap,
     and it is the number people actually ask about. */
  let followers = 0;
  const profile = await graph(env, pageAuth, encodeURIComponent(igUserId), {
    fields: 'followers_count,media_count'
  }, true);
  if (profile.ok) followers = Number(profile.data.followers_count) || 0;

  return {
    ok: true,
    configured: true,
    reach: reachM.value,
    profileViews: viewsM.value,
    followers,
    /* Which names answered, and the id that was used — the latter matters
       because it may have been discovered from the Page rather than set. */
    igUserId,
    metrics: { reach: reachM.metric, profileViews: viewsM.metric }
  };
}

/* Finds the Instagram business account attached to the Page, so the id does
   not have to be hunted for by hand. Used by the setup check in
   /api/marketing rather than on every load. */
export async function discoverIgAccount(env) {
  const { token, pageId } = insightsConfig(env);
  if (!token || !pageId) return { ok: false, configured: false };
  /* Reading a field off the Page needs the Page's own token, the same as the
     insights above. */
  const pt = await pageToken(env, token, pageId);
  if (!pt.ok) return readFailure(env, pt.error);
  const res = await graph(env, pt.token, encodeURIComponent(pageId), {
    fields: 'instagram_business_account{id,username}'
  }, false);
  if (!res.ok) return { ok: false, configured: true, error: res.error };
  const ig = res.data && res.data.instagram_business_account;
  return {
    ok: true,
    configured: true,
    linked: Boolean(ig && ig.id),
    id: (ig && ig.id) || '',
    username: (ig && ig.username) || ''
  };
}

/* -------------------------------------------------------------------------
   Ads — the money

   ADMIN ONLY. Enforced in functions/api/marketing.js, not here: this file is
   a data source and has no idea who is asking.
   ------------------------------------------------------------------------- */
export async function fetchAdInsights(env, days) {
  const { token, adAccountId } = insightsConfig(env);
  if (!token || !adAccountId) return { ok: false, configured: false };

  const { since, until } = dateWindow(days);
  const res = await graph(env, token, `${encodeURIComponent(adAccountId)}/insights`, {
    fields: 'spend,impressions,reach,clicks,cpc,cpm,ctr,actions,action_values',
    time_range: JSON.stringify({ since, until }),
    level: 'account'
  }, true);

  if (!res.ok) return readFailure(env, res.error, res.code);

  const row = (res.data && res.data.data && res.data.data[0]) || {};

  /* Meta's own view of what the ads produced. Kept SEPARATE from the D1
     figure the endpoint computes, and labelled as Meta's, because the two
     disagree by design: this one counts pixel-attributed conversions, which
     under-report against ad blockers and iOS, and attributes them to the ad
     rather than to the order. Presenting either as "revenue" without saying
     which is how a dashboard ends up with two different true answers. */
  const actionValue = (name) => {
    const list = (row.action_values || []).find((a) => a.action_type === name);
    return list ? Number(list.value) || 0 : 0;
  };
  const actionCount = (name) => {
    const list = (row.actions || []).find((a) => a.action_type === name);
    return list ? Number(list.value) || 0 : 0;
  };

  return {
    ok: true,
    configured: true,
    cached: res.cached,
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    clicks: Number(row.clicks) || 0,
    cpc: Number(row.cpc) || 0,
    cpm: Number(row.cpm) || 0,
    ctr: Number(row.ctr) || 0,
    metaPurchases: actionCount('purchase') || actionCount('offsite_conversion.fb_pixel_purchase'),
    metaRevenue: actionValue('purchase') || actionValue('offsite_conversion.fb_pixel_purchase')
  };
}

/* Per-campaign, for the table under the headline numbers. Its own call
   because the account-level row above is what the headline needs and this is
   the part somebody scrolls to. */
export async function fetchCampaignInsights(env, days, limit) {
  const { token, adAccountId } = insightsConfig(env);
  if (!token || !adAccountId) return { ok: false, configured: false };

  const { since, until } = dateWindow(days);
  const res = await graph(env, token, `${encodeURIComponent(adAccountId)}/insights`, {
    fields: 'campaign_name,spend,impressions,clicks,ctr,actions',
    time_range: JSON.stringify({ since, until }),
    level: 'campaign',
    limit: String(Math.min(Math.max(limit || 10, 1), 50))
  }, true);

  if (!res.ok) return readFailure(env, res.error, res.code);

  const rows = (res.data && res.data.data) || [];
  return {
    ok: true,
    configured: true,
    cached: res.cached,
    campaigns: rows.map((r) => {
      const purchases = (r.actions || []).find(
        (a) => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase'
      );
      return {
        name: r.campaign_name || '',
        spend: Number(r.spend) || 0,
        impressions: Number(r.impressions) || 0,
        clicks: Number(r.clicks) || 0,
        ctr: Number(r.ctr) || 0,
        purchases: purchases ? Number(purchases.value) || 0 : 0
      };
    }).sort((a, b) => b.spend - a.spend)
  };
}
