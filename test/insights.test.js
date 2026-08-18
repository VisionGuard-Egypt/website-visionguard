/* =========================================================================
   Reading from Meta — the configuration half.

   The network half of lib/insights.js cannot be tested without Meta, but the
   part that decides WHICH credential and WHICH account gets used can, and it
   is the part that fails silently when it is wrong: a token picked from the
   wrong variable produces an OAuth error the tab shows, but an ad account id
   assembled wrongly produces an empty ads section that reads as "no spend".

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { insightsConfig, insightsStatus } from '../lib/insights.js';

/* -------------------------------------------------------------------------
   Which token gets used

   The single most likely misconfiguration: pointing the read path at the
   Conversions API token, which cannot read insights. The fallback exists so
   a deployment that sets only META_ACCESS_TOKEN still ATTEMPTS the call and
   surfaces Meta's scope error, rather than reporting "not configured" and
   sending the administrator to look for a variable that is already set.
   ------------------------------------------------------------------------- */
test('prefers the dedicated read token over the Conversions API one', () => {
  const c = insightsConfig({ META_INSIGHTS_TOKEN: 'read-token', META_ACCESS_TOKEN: 'capi-token' });
  assert.equal(c.token, 'read-token');
});

test('falls back to the CAPI token so the scope error is visible rather than silent', () => {
  const c = insightsConfig({ META_ACCESS_TOKEN: 'capi-token' });
  assert.equal(c.token, 'capi-token');
});

test('no token at all is an empty string, never undefined', () => {
  assert.equal(insightsConfig({}).token, '');
  assert.equal(insightsConfig(undefined).token, '');
});

/* -------------------------------------------------------------------------
   The ad account id

   Ads Manager shows it both ways depending on where you look. Graph only
   accepts one. Accepting both is what stops a correct-looking id from
   producing an empty section.
   ------------------------------------------------------------------------- */
test('adds the act_ prefix when it is missing', () => {
  assert.equal(insightsConfig({ META_AD_ACCOUNT_ID: '123456789' }).adAccountId, 'act_123456789');
});

test('leaves an id that already carries the prefix alone', () => {
  assert.equal(insightsConfig({ META_AD_ACCOUNT_ID: 'act_123456789' }).adAccountId, 'act_123456789');
});

test('never produces the bare string "act_" from a blank ad account', () => {
  /* The bug this pins: prefixing unconditionally yields 'act_', which is
     truthy, so every check downstream believes ads are configured and the
     panel reports Meta's "invalid account" error instead of "not set up".

     What changed is where a blank value lands, not that it is dangerous.
     The ad account now defaults to the business's real one — an id names an
     asset and is not a credential, see the note in insightsConfig — so blank
     resolves to that rather than to nothing. 'act_' on its own is still the
     one answer that must never come out of here. */
  assert.equal(insightsConfig({}).adAccountId, 'act_2067738330681838');
  assert.equal(insightsConfig({ META_AD_ACCOUNT_ID: '   ' }).adAccountId, 'act_2067738330681838');
  assert.notEqual(insightsConfig({ META_AD_ACCOUNT_ID: '   ' }).adAccountId, 'act_');
});

test('an explicit ad account still overrides the default', () => {
  /* The default must not be sticky — a second business, or a test account,
     has to be reachable by setting the variable. */
  assert.equal(insightsConfig({ META_AD_ACCOUNT_ID: '999' }).adAccountId, 'act_999');
  assert.equal(insightsConfig({ META_PAGE_ID: '888' }).pageId, '888');
});

/* -------------------------------------------------------------------------
   What the tab reports as missing
   ------------------------------------------------------------------------- */
test('an unconfigured deployment is missing the token, not the ids', () => {
  /* The Page and the ad account are known to this repository now, so
     reporting them as absent would be a lie that sends an administrator
     looking for two ids that were never the problem. The token is the only
     thing a fresh deployment is actually short of, and Instagram is the only
     id that genuinely could not be resolved from the business. */
  const s = insightsStatus({});
  assert.deepEqual(s, {
    token: false, dedicatedToken: false, page: true, instagram: false, ads: true
  });
});

test('distinguishes a dedicated read token from a borrowed CAPI one', () => {
  /* The warning this drives is the difference between "you have not set this
     up" and "you set it up with a token that cannot work". */
  assert.equal(insightsStatus({ META_ACCESS_TOKEN: 'x' }).dedicatedToken, false);
  assert.equal(insightsStatus({ META_ACCESS_TOKEN: 'x' }).token, true);
  assert.equal(insightsStatus({ META_INSIGHTS_TOKEN: 'y' }).dedicatedToken, true);
});

test('reports each id independently, so a partial setup names only what is left', () => {
  const s = insightsStatus({
    META_INSIGHTS_TOKEN: 'y',
    META_PAGE_ID: '111',
    META_AD_ACCOUNT_ID: '222'
  });
  assert.equal(s.page, true);
  assert.equal(s.ads, true);
  assert.equal(s.instagram, false);
});
