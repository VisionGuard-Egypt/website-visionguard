/* =========================================================================
   Vision Guard — account-marketing.js
   The marketing tab: Page and Instagram for everyone on staff, ad spend and
   real return for administrators.

   Loaded lazily on the tab click, the same as account-leads.js — most people
   who sign in never open it, and it is the only module that waits on a
   third-party API.

   TWO HALVES, ONE PANEL. The organic half renders for any staff account. The
   money half renders only when the server says `admin`, and it says so
   because it decided — not because this file asked. The tab being hidden for
   a customer is a courtesy; /api/marketing re-checks, and the ads fields are
   never in the response for a non-admin at all.

   THE EMPTY STATE IS THE IMPORTANT STATE. This tab ships before the Meta ids
   exist, and it will sit unconfigured until someone adds them. "Nothing to
   show" would read as "the marketing did nothing". So an unconfigured section
   says which of the four settings is missing, by name, and a section Meta
   rejected shows what Meta said — an OAuth scope error is a fifteen-second
   fix if you can read it and a week of confusion if you cannot.
   ========================================================================= */
import { $, t, esc, api, money, currency } from './site.js?v=66';
import { T } from './account-shared.js?v=66';

const L = {
  organic:      { ar: 'الوصول الطبيعي', en: 'Organic reach' },
  facebookWord: { ar: 'فيسبوك', en: 'Facebook' },
  instagramWord:{ ar: 'إنستجرام', en: 'Instagram' },
  adsWord:      { ar: 'الإعلانات', en: 'Ads' },
  reachWord:    { ar: 'الوصول', en: 'Reach' },
  impressionsW: { ar: 'الظهور', en: 'Impressions' },
  engagementsW: { ar: 'تفاعل', en: 'Engagements' },
  followersWord:{ ar: 'متابعين', en: 'Followers' },
  profileViews: { ar: 'زيارات الحساب', en: 'Profile views' },
  spendWord:    { ar: 'المصروف', en: 'Spend' },
  clicksWord:   { ar: 'ضغطات', en: 'Clicks' },
  cpcWord:      { ar: 'تكلفة الضغطة', en: 'Cost per click' },
  cpmWord:      { ar: 'تكلفة الألف', en: 'CPM' },
  ctrWord:      { ar: 'نسبة الضغط', en: 'CTR' },
  campaignWord: { ar: 'الحملة', en: 'Campaign' },
  purchasesW:   { ar: 'مشتريات', en: 'Purchases' },
  roasReal:     { ar: 'العائد الحقيقي', en: 'Real return' },
  roasMeta:     { ar: 'عائد Meta', en: 'Meta’s estimate' },
  roasNote:     {
    ar: 'العائد الحقيقي = مصروف الإعلانات ÷ الإيرادات الفعلية من قاعدة البيانات. رقم Meta بيعتمد على البيكسل، وبيقل عن الحقيقة لأن مانعات الإعلانات وiOS بيوقفوا جزء من الأحداث.',
    en: 'Real return divides ad spend into revenue that actually arrived, from the shop’s own database. Meta’s figure counts pixel-attributed purchases only, and under-reports because ad blockers and iOS strip a share of the events.'
  },
  realRevenue:  { ar: 'إيرادات فعلية', en: 'Real revenue' },
  metaRevenue:  { ar: 'إيرادات حسب Meta', en: 'Revenue per Meta' },
  notSetUp:     { ar: 'التبويب ده لسه ماتفعلش.', en: 'This tab is not switched on yet.' },
  needsSetup:   { ar: 'ناقص الإعدادات دي:', en: 'Still missing:' },
  needToken:    { ar: 'توكن القراءة (META_INSIGHTS_TOKEN)', en: 'A read token (META_INSIGHTS_TOKEN)' },
  needPage:     { ar: 'رقم صفحة فيسبوك (META_PAGE_ID)', en: 'The Facebook Page id (META_PAGE_ID)' },
  needIg:       { ar: 'رقم حساب إنستجرام (META_IG_USER_ID)', en: 'The Instagram account id (META_IG_USER_ID)' },
  needAds:      { ar: 'رقم الحساب الإعلاني (META_AD_ACCOUNT_ID)', en: 'The ad account id (META_AD_ACCOUNT_ID)' },
  sharedToken:  {
    ar: 'التوكن المستخدم هو توكن الـ Conversions API. ده بيبعت أحداث بس ومش بيقرا إحصائيات — محتاج توكن System User بصلاحيات القراءة.',
    en: 'The token in use is the Conversions API token. That one only sends events; reading insights needs a System User token with the read scopes.'
  },
  /* The connection panel. Ids and timestamps, never a token — see
     lib/metaconnection.js for why the secret is structurally absent rather
     than merely not printed. */
  appWord:      { ar: 'التطبيق', en: 'App' },
  pageWord:     { ar: 'الصفحة', en: 'Page' },
  pixelWord:    { ar: 'البيكسل', en: 'Pixel' },
  catalogueWord:{ ar: 'الكتالوج', en: 'Catalogue' },
  adAccountWord:{ ar: 'الحساب الإعلاني', en: 'Ad account' },
  productsWord: { ar: 'منتج', en: 'products' },
  browserLast:  { ar: 'آخر حدث من المتصفح', en: 'Last browser event' },
  serverLast:   { ar: 'آخر حدث من السيرفر', en: 'Last server event' },
  neverFired:   { ar: 'ولا مرة', en: 'never' },
  /* Four verdicts, and each NAMES the fault rather than grading it. "Not
     healthy" sends somebody looking everywhere; "the server is silent" sends
     them to the token, which is where the answer is. */
  healthOk:     { ar: 'شغّال — المتصفح والسيرفر الاتنين بيبعتوا.', en: 'Healthy — browser and server are both sending.' },
  healthNoSrv:  {
    ar: 'المتصفح بيبعت بس السيرفر ساكت. غالبًا التوكن أو رقم الـ dataset غلط.',
    en: 'The browser is sending, the server is silent. That is usually the token or the dataset id.'
  },
  healthNoBrw:  {
    ar: 'السيرفر بيبعت بس المتصفح ساكت. يا إما البيكسل متحجوب، يا إما الموافقة مش متاخدة، يا إما السكريبت وقف.',
    en: 'The server is sending, the browser is silent. Either the pixel is blocked, consent is never granted, or the script stopped loading.'
  },
  healthSilent: {
    ar: 'مافيش أي حدث وصل Meta خلال ٢٤ ساعة، لا من المتصفح ولا من السيرفر.',
    en: 'Nothing has reached Meta in 24 hours, from either the browser or the server.'
  },
  healthUnknown:{ ar: 'مش قادرين نقرا حالة البيكسل.', en: 'The pixel status could not be read.' },
  metaSaid:     { ar: 'Meta ردّت:', en: 'Meta said:' },
  noCampaigns:  { ar: 'مافيش حملات شغّالة في الفترة دي.', en: 'No campaigns ran in this period.' },
  organicNote:  {
    ar: 'الأرقام دي للمحتوى الطبيعي — من غير إعلانات. Meta بتحدّثها كل كام ساعة، والصفحة بتحتفظ بالنتيجة ربع ساعة.',
    en: 'These are organic numbers — posts, not ads. Meta refreshes them every few hours, and this page holds each result for fifteen minutes.'
  }
};
const ls = (k) => t(L[k] || { ar: '', en: '' });

let data = null;

/* ------------------------------------------------------------------------- */
function statTile(label, value, cls) {
  return `<div class="stat"><span class="stat__k">${esc(label)}</span><span class="stat__v ${cls || ''}">${esc(value)}</span></div>`;
}

function num(n) {
  return money(Math.round(Number(n) || 0));
}

/* One block, one failure. Same reasoning as perfBlock in account-admin.js:
   the first missing field must not take the rest of the panel with it. */
function block(id, render) {
  const node = $(id);
  if (!node) return;
  try {
    render(node);
  } catch (err) {
    console.error('marketing block failed', id, err && err.message);
    node.innerHTML = `<p class="card__note is-bad">${esc(t(T.noData))}</p>`;
  }
}

/* What a section shows when it has no numbers. Three genuinely different
   cases, and telling them apart is the whole point:

     not configured  — an id or the token is missing. Nameable, fixable.
     Meta refused    — configured, but the token lacks the scope or the id is
                       wrong. Meta's own words are the fix.
     configured, 0   — it really was zero. Rare, and it should look different
                       from the two above. */
function sourceNote(src, missingKey) {
  if (!src || src.configured === false) {
    return `<p class="card__note">${esc(ls('notSetUp'))} ${esc(ls(missingKey))}</p>`;
  }
  if (!src.ok) {
    return `<p class="card__note is-bad">${esc(ls('metaSaid'))} ${esc(src.error || '')}</p>`;
  }
  return '';
}

/* ------------------------------------------------------------------------- */
function render() {
  if (!data) return;
  const d = data;

  /* The setup banner. Shown only while something is missing, so a working
     deployment never sees it. */
  block('#mktSetup', (node) => {
    const s = d.setup || {};
    const missing = [];
    if (!s.token) missing.push(ls('needToken'));
    if (!s.page) missing.push(ls('needPage'));
    if (!s.instagram) missing.push(ls('needIg'));
    if (d.admin && !s.ads) missing.push(ls('needAds'));

    /* Configured, but with the write token. The likeliest reason for a tab
       that looks set up and returns OAuth errors on every section. */
    const shared = s.token && !s.dedicatedToken;

    if (!missing.length && !shared) {
      node.hidden = true;
      node.innerHTML = '';
      return;
    }
    node.hidden = false;
    node.innerHTML = `
      ${missing.length ? `
        <p class="card__note"><strong>${esc(ls('needsSetup'))}</strong></p>
        <ul class="card__note">${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${shared ? `<p class="card__note is-bad">${esc(ls('sharedToken'))}</p>` : ''}`;
  });

  /* ---- What we are connected to, and whether it is firing ----

     Renders even when the token is missing: the ids are known from the
     configuration alone, and "here is the Page we would ask about, and we
     cannot reach it" is a far more useful empty state than a blank card. */
  block('#mktConnection', (node) => {
    const c = d.connection || {};
    const px = c.pixel || {};

    const when = (iso) => (iso ? new Date(iso).toLocaleString() : ls('neverFired'));

    /* One line per asset. The id is always shown — it is the thing somebody
       compares against Business Manager when a number looks wrong — and the
       name is shown when Meta would give us one. */
    const row = (label, obj, extra) => {
      const o = obj || {};
      if (!o.id) return '';
      const name = o.name ? `<strong>${esc(o.name)}</strong> ` : '';
      const err = o.error ? `<span class="is-bad"> — ${esc(o.error)}</span>` : '';
      return `<li>${esc(label)}: ${name}<code>${esc(o.id)}</code>${esc(extra || '')}${err}</li>`;
    };

    const healthKey = {
      ok: 'healthOk',
      server_silent: 'healthNoSrv',
      browser_silent: 'healthNoBrw',
      silent: 'healthSilent'
    }[px.health] || 'healthUnknown';
    /* Only 'ok' is good news. Everything else is a fault worth the red. */
    const healthCls = px.health === 'ok' ? '' : 'is-bad';

    node.innerHTML = `
      <ul class="card__note">
        ${row(ls('appWord'), c.app)}
        ${row(ls('pageWord'), c.page)}
        ${row(ls('pixelWord'), c.pixel)}
        ${row(ls('catalogueWord'), c.catalogue,
              c.catalogue && c.catalogue.products !== null && c.catalogue.products !== undefined
                ? ` — ${c.catalogue.products} ${ls('productsWord')}` : '')}
        ${row(ls('adAccountWord'), c.adAccount)}
      </ul>
      <p class="card__note ${healthCls}">${esc(ls(healthKey))}</p>
      <div class="stats">
        ${statTile(ls('browserLast'), when(px.browserFired))}
        ${statTile(ls('serverLast'), when(px.serverFired))}
      </div>
      ${c.configured === false && c.error ? `<p class="card__note">${esc(c.error)}</p>` : ''}`;
  });

  /* ---- Facebook, organic ---- */
  block('#mktPage', (node) => {
    const p = d.page || {};
    const note = sourceNote(p, 'needPage');
    node.innerHTML = note || [
      statTile(ls('reachWord'), num(p.reach)),
      statTile(ls('impressionsW'), num(p.impressions)),
      statTile(ls('engagementsW'), num(p.engagements)),
      statTile(ls('followersWord'), num(p.followers))
    ].join('');
  });

  /* ---- Instagram, organic ---- */
  block('#mktIg', (node) => {
    const g = d.instagram || {};
    const note = sourceNote(g, 'needIg');
    node.innerHTML = note || [
      statTile(ls('reachWord'), num(g.reach)),
      statTile(ls('profileViews'), num(g.profileViews)),
      statTile(ls('followersWord'), num(g.followers))
    ].join('');
  });

  /* ---- Ads. Admin only; the card is hidden outright otherwise, because an
     employee seeing an empty "Spend" card would reasonably read it as zero
     spend rather than as none of their business. ---- */
  const adsCard = $('#mktAdsCard');
  const roasCard = $('#mktRoasCard');
  if (adsCard) adsCard.hidden = !d.admin;
  if (roasCard) roasCard.hidden = !d.admin;

  if (d.admin) {
    block('#mktAds', (node) => {
      const a = d.ads || {};
      const note = sourceNote(a, 'needAds');
      node.innerHTML = note || [
        statTile(ls('spendWord'), `${num(a.spend)} ${currency()}`),
        statTile(ls('impressionsW'), num(a.impressions)),
        statTile(ls('reachWord'), num(a.reach)),
        statTile(ls('clicksWord'), num(a.clicks)),
        statTile(ls('ctrWord'), `${(Number(a.ctr) || 0).toFixed(2)}%`),
        statTile(ls('cpcWord'), `${(Number(a.cpc) || 0).toFixed(2)} ${currency()}`)
      ].join('');
    });

    /* The point of the whole tab. */
    block('#mktRoas', (node) => {
      const r = d.roas;
      if (!r) {
        node.innerHTML = `<p class="card__note">${esc(t(T.noData))}</p>`;
        return;
      }
      node.innerHTML = [
        statTile(ls('roasReal'), `${r.real}×`, r.real >= 1 ? 'is-pos' : 'is-neg'),
        statTile(ls('roasMeta'), r.meta === null ? '—' : `${r.meta}×`),
        statTile(ls('spendWord'), `${num(r.spend)} ${currency()}`),
        statTile(ls('realRevenue'), `${num(r.realRevenue)} ${currency()}`),
        statTile(ls('metaRevenue'), `${num(r.metaRevenue)} ${currency()}`)
      ].join('');
    });

    block('#mktCampaigns', (node) => {
      const c = (d.campaigns && d.campaigns.campaigns) || [];
      if (!c.length) {
        node.innerHTML = `<tr><td colspan="5">${esc(ls('noCampaigns'))}</td></tr>`;
        return;
      }
      node.innerHTML = c.map((row) => `
        <tr>
          <td>${esc(row.name)}</td>
          <td>${esc(num(row.spend))} ${esc(currency())}</td>
          <td>${esc(num(row.clicks))}</td>
          <td>${esc((Number(row.ctr) || 0).toFixed(2))}%</td>
          <td>${esc(num(row.purchases))}</td>
        </tr>`).join('');
    });
  }
}

/* ------------------------------------------------------------------------- */
export async function loadMarketing() {
  const err = $('#mktErr');
  if (err) err.hidden = true;
  const days = ($('#mktDays') && $('#mktDays').value) || '30';
  try {
    data = await api(`/api/marketing?days=${encodeURIComponent(days)}`);
    render();
  } catch (e) {
    if (err) {
      err.textContent = e.display || e.message;
      err.hidden = false;
    }
  }
}

/* Wired at module load, which only happens on the first click of the tab —
   by which point the markup has been in the document since the page was
   parsed, the same as #perfDays in account-admin.js. */
$('#mktDays').addEventListener('change', () => loadMarketing());

export function loadPanel() { return loadMarketing(); }

export function repaint() {
  if (data) render();
}

export function reset() {
  data = null;
}
