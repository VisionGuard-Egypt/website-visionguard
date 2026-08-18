/* =========================================================================
   Vision Guard — shop.js
   Browse, cart, checkout. One page, three views.

   The cart holds {id, qty} and nothing else. Prices are read from
   catalog.js for display and re-derived from the same module on the server
   at checkout, so what the customer sees and what the order costs cannot
   drift — and a hand-edited localStorage cart buys nothing cheaply.
   ========================================================================= */
import {
  PRODUCTS as STATIC_PRODUCTS, CATEGORIES, GOVERNORATES,
  findProduct as staticFind, imageFor
} from './catalog.js?v=66';

/* The catalogue the page renders and prices FROM DISPLAY only.

   It starts as the static file so the grid can paint immediately even if
   the network is slow, then is replaced by /api/catalog — which reads the
   products table — so an admin's edit shows up on the next page load rather
   than the next deploy.

   None of this decides what an order costs. functions/api/orders.js prices
   every line server-side from the same table; the cart still travels as
   {id, qty} and nothing else. If this list were stale, or edited in the
   browser, the checkout would simply disagree with it — which is the point. */
let PRODUCTS = STATIC_PRODUCTS;
let BY_ID = null;

function findProduct(id) {
  if (!BY_ID) return staticFind(id);
  return BY_ID.get(String(id)) || null;
}
/* LANG is a live binding: site.js reassigns it on a language switch and this
   module sees the new value without re-importing. */
import {
  $, $$, initChrome, onLang, LANG, t, money, currency, esc, api, toast
} from './site.js?v=66';

initChrome();

/* =========================================================================
   1. CART STATE
   ========================================================================= */
const KEY = 'vg-cart';
const MAX_QTY = 99;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    /* Anything the catalogue no longer has is dropped silently — a product
       that was discontinued between visits must not wedge the cart. */
    return raw
      .map((l) => ({ id: String(l && l.id), qty: Math.min(MAX_QTY, Math.max(1, Math.floor(Number(l && l.qty)) || 0)) }))
      .filter((l) => l.qty > 0 && findProduct(l.id));
  } catch (e) {
    return [];
  }
}

let cart = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) {}
}

function qtyOf(id) {
  const line = cart.find((l) => l.id === id);
  return line ? line.qty : 0;
}

/* The cart in the shape the pixel wants, derived from cartLines() below
   rather than rebuilt — one definition of what is in the cart.

   These prices are for measurement only. What an order actually costs is
   recomputed on the server from the catalogue and never taken from the
   browser; see lib/orders.js. */
function pixelLines() {
  return cartLines()
    .map((l) => ({ id: l.product.id, qty: l.qty, unit: l.product.price, name: l.product.name }));
}

function setQty(id, qty) {
  const n = Math.max(0, Math.min(MAX_QTY, Math.floor(qty) || 0));
  const i = cart.findIndex((l) => l.id === id);
  if (n === 0) { if (i >= 0) cart.splice(i, 1); }
  else if (i >= 0) cart[i].qty = n;
  else cart.push({ id, qty: n });
  save();
  renderCart();
  renderGridQuantities();
}

function cartCount() {
  return cartLines().reduce((n, l) => n + l.qty, 0);
}

/* A line whose product the catalogue can no longer resolve is DROPPED here,
   and this is the only place that decision is made.

   It used to read `p.price` straight off the lookup, which throws the moment
   the lookup returns null — and the file already knew that could happen,
   because pixelLines() below was filtering the result for exactly that case.
   The two disagreed, and the renderers sided with the optimistic one:
   renderCart() and renderSummary() both dereference product.name.

   It is reachable. game.html's coverage planner writes ids into this same
   vg-cart key, and liveCatalog() below swaps the catalogue out from under a
   cart that was loaded against the static file — so any id the products
   table does not have (deactivated, deleted, planner-only) lands here. The
   old code turned that into a TypeError inside renderCart, which takes out
   the cart drawer and the checkout summary together: the customer sees a
   cart that will not open and no explanation.

   Dropping is what the rest of the file already does with an unknown id —
   load() filters on it, liveCatalog() re-filters after the swap — so this
   makes the renderers agree with them rather than inventing a third rule. */
function cartLines() {
  const lines = [];
  for (const l of cart) {
    const p = findProduct(l.id);
    if (!p) continue;
    lines.push({ product: p, qty: l.qty, line: p.price * l.qty });
  }
  return lines;
}

function subtotal() {
  return cartLines().reduce((sum, l) => sum + l.line, 0);
}

/* =========================================================================
   2. COPY OWNED BY JS
   ========================================================================= */
const T = {
  all:          { ar: 'الكل', en: 'All' },
  add:          { ar: 'أضف للسلة', en: 'Add to cart' },
  inCart:       { ar: 'في السلة', en: 'In cart' },
  remove:       { ar: 'حذف', en: 'Remove' },
  empty:        { ar: 'السلة فاضية لسه.', en: 'Your cart is empty.' },
  emptyHint:    { ar: 'ضيف منتج وابدأ الطلب.', en: 'Add a product to start an order.' },
  subtotal:     { ar: 'الإجمالي', en: 'Subtotal' },
  firstOrderOff:{ ar: 'خصم أول طلب', en: 'First-order discount' },
  afterOff:     { ar: 'بعد الخصم', en: 'After discount' },
  welcomeApplied:{
    ar: 'خصم {pct}% على أول طلب ليك — متطبّق تحت.',
    en: '{pct}% off your first order — applied below.'
  },
  /* Appended to the line above. The offer runs out five days after the
     account is made, and somebody who is not told that finds out by losing
     it. Singular and plural are separate strings because "1 days" is the
     kind of small wrongness that makes a whole screen look automated. */
  welcomeDaysLeft:{
    ar: 'باقي {n} أيام.',
    en: '{n} days left.'
  },
  welcomeLastDay:{
    ar: 'النهارده آخر يوم.',
    en: 'Today is the last day.'
  },
  welcomeSignIn:{
    ar: 'سجّل دخولك وخُد {pct}% خصم على أول طلب — صالح {days} أيام من تاريخ إنشاء حسابك.',
    en: 'Sign in and take {pct}% off your first order — valid for {days} days from the day you join.'
  },
  /* The account exists, has never ordered, and the five days are gone. Said
     plainly rather than by showing nothing: an offer that vanishes without
     explanation reads as a bug. */
  welcomeExpired:{
    ar: 'خصم الترحيب انتهى — كان صالح {days} أيام من تاريخ إنشاء حسابك.',
    en: 'Your welcome discount has ended — it ran for {days} days from the day you joined.'
  },
  /* A code the shop handed out, as opposed to the automatic welcome offer.
     Every refusal is its own sentence: "not valid" for a code that has run
     out tells somebody holding a flyer nothing they can act on, and the
     remedy is different in each case — wait, spend more, sign in, or give
     up. */
  promoApplied: { ar: 'كود {code} اتفعّل.', en: '{code} applied.' },
  promoUnknown: { ar: 'كود {code} مش صحيح.', en: '{code} is not a valid code.' },
  promoNotYet:  { ar: 'كود {code} لسه ما بدأش.', en: '{code} has not started yet.' },
  promoOver:    { ar: 'كود {code} انتهى.', en: '{code} has ended.' },
  promoUsedUp:  { ar: 'كود {code} خلص عدد مرات استخدامه.', en: '{code} has been fully used.' },
  promoMin:     {
    ar: 'كود {code} بيشتغل على طلبات من {min} ج.م وفوق.',
    en: '{code} applies to orders of {min} EGP and over.'
  },
  promoNewOnly: {
    ar: 'كود {code} لعملاء أول مرة بس.',
    en: '{code} is for first-time customers only.'
  },
  promoSignIn:  {
    ar: 'سجّل دخولك عشان تستخدم كود {code}.',
    en: 'Sign in to use {code}.'
  },
  savedWord:    { ar: 'وفّرت', en: 'You saved' },
  shipping:     { ar: 'الشحن', en: 'Shipping' },
  shipTbd:      { ar: 'يتحدد حسب المحافظة', en: 'Quoted per governorate' },
  checkout:     { ar: 'إتمام الطلب', en: 'Checkout' },
  results:      { ar: 'منتج', en: 'products' },
  resultsOne:   { ar: 'منتج واحد', en: '1 product' },
  details:      { ar: 'عرض التفاصيل', en: 'View details' },
  placing:      { ar: 'جاري إرسال الطلب…', en: 'Sending your order…' },
  place:        { ar: 'أكّد الطلب', en: 'Place the order' },
  added:        { ar: 'اتضاف للسلة', en: 'Added to cart' },
  chooseGov:    { ar: 'اختار المحافظة', en: 'Choose a governorate' },
  orderNo:      { ar: 'رقم الطلب', en: 'Order number' },
  doneNote:     {
    ar: 'استلمنا طلبك وهو دلوقتي عندنا في انتظار الدفع. كلّمنا على واتساب عشان نبعتلك بيانات التحويل ونأكد التفاصيل والشحن.',
    en: 'Your order is with us and is pending payment. Message us on WhatsApp and we will send you the transfer details and confirm the shipping.'
  },
  /* The fallback when the server answered without a link — an older API, or
     an order that is already paid for. Saying the number in words is the one
     route that works with no link at all. */
  payManual:    {
    ar: 'كلّمنا على واتساب 01105006854 وقول لنا رقم الطلب عشان تكمّل الدفع.',
    en: 'Message us on WhatsApp 01105006854 with the order number to complete the payment.'
  },
  qtyLabel:     { ar: 'الكمية', en: 'Quantity' },
  minus:        { ar: 'قلل واحد', en: 'Decrease by one' },
  plus:         { ar: 'زوّد واحد', en: 'Increase by one' },
  barOne:       { ar: 'منتج واحد في السلة', en: '1 item in your cart' },
  barMany:      { ar: 'منتجات في السلة', en: 'items in your cart' }
};

/* =========================================================================
   3. FILTER STATE + GRID
   ========================================================================= */
const grid = $('#grid');
const chipsWrap = $('#chips');
const resultLine = $('#resultLine');
const emptyMsg = $('#empty');

const params = new URLSearchParams(location.search);
let activeCat = CATEGORIES.some((c) => c.id === params.get('cat')) ? params.get('cat') : 'all';
let query = '';
let sort = 'default';

function visible() {
  const q = query.trim().toLowerCase();
  return PRODUCTS
    .filter((p) => activeCat === 'all' || p.cat === activeCat)
    .filter((p) => {
      if (!q) return true;
      return (p.name + ' ' + p.brand + ' ' + p.ar + ' ' + p.en + ' ' + p.id).toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      if (sort === 'low') return a.price - b.price;
      if (sort === 'high') return b.price - a.price;
      if (sort === 'name') return a.name.localeCompare(b.name);
      return 0;
    });
}

/* =========================================================================
   THE FILTER ICONS

   A row of nine pills in two languages is a wall of text, and the one thing a
   customer is actually doing there is "show me the wireless ones". A glyph is
   read before the label is, and it is read at the same speed in Arabic and in
   English — which matters on a site that switches between them.

   Drawn inline rather than loaded, for three reasons that each rule out an
   image file: nine more requests on the page that already loads sixty product
   photos; `currentColor`, which is what lets a chip invert cleanly when it
   becomes the active one (`.chip.is-on` flips to --accent-ink) and follow the
   light/dark theme without a second asset; and no flash of an unstyled pill
   while a sprite is still in flight.

   Geometry matches the icons already in the page chrome — a 24 box, no fill,
   1.7 stroke, round caps — so these sit beside the theme and cart glyphs
   without looking imported from somewhere else.

   Each one says what the CATEGORY is, not what a particular product is:
   `analog` is the bullet camera every HD line in this catalogue is, `ip` is a
   dome because the only IP entry is a pan-tilt dome. Keyed by category id,
   so a new category simply gets no icon rather than the wrong one — see the
   fallback in chipIcon().
   ========================================================================= */
const CAT_ICONS = {
  /* Four panes: everything. */
  all: '<rect x="3.2" y="3.2" width="7.2" height="7.2" rx="1.6"/><rect x="13.6" y="3.2" width="7.2" height="7.2" rx="1.6"/><rect x="3.2" y="13.6" width="7.2" height="7.2" rx="1.6"/><rect x="13.6" y="13.6" width="7.2" height="7.2" rx="1.6"/>',

  /* A camera body with signal arcs over it. */
  wireless: '<path d="M6.6 6.6a7.6 7.6 0 0 1 10.8 0"/><path d="M9.3 9.4a3.9 3.9 0 0 1 5.4 0"/><rect x="3.2" y="12.4" width="10" height="7" rx="2"/><path d="M13.2 15l5.3-2.5v6.8L13.2 16.8z"/>',

  /* The bullet camera on a bracket that every HD line here is. */
  analog: '<rect x="2.8" y="6.6" width="12.6" height="6.4" rx="3.2"/><path d="M15.4 9.8h4"/><path d="M9.1 13v3.4"/><path d="M6.1 19.4h6"/>',

  /* A dome, because the IP entry in this catalogue is a pan-tilt dome. */
  ip: '<path d="M4.4 14.2a7.6 7.6 0 0 1 15.2 0"/><path d="M3.2 14.2h17.6"/><circle cx="12" cy="11.4" r="2.1"/><path d="M12 17.4v3.2"/>',

  /* A rack unit with a status lamp. */
  dvr: '<rect x="2.6" y="7.4" width="18.8" height="9.2" rx="2.2"/><circle cx="6.4" cy="12" r="1.05"/><path d="M9.8 12h8.4"/>',

  /* A platter and spindle. */
  storage: '<rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.4"/><circle cx="12" cy="12" r="3.7"/><circle cx="12" cy="12" r="0.85" fill="currentColor" stroke="none"/>',

  /* A plug. */
  power: '<path d="M9 2.8v5.1M15 2.8v5.1"/><path d="M5.4 7.9h13.2v3.2a6.6 6.6 0 0 1-13.2 0z"/><path d="M12 17.7v3.5"/>',

  /* A run of cable between two connectors. */
  cable: '<path d="M5.4 17.2c0-4.1 3.1-4.1 3.1-8.2a3.5 3.5 0 0 1 7 0c0 4.1 3.1 4.1 3.1 8.2"/><circle cx="5.4" cy="19.2" r="1.7"/><circle cx="18.6" cy="19.2" r="1.7"/>',

  /* A spanner: the brackets, boxes and connectors that go with a fit-out. */
  accessory: '<path d="M15.1 6.1a4.6 4.6 0 0 0-6.2 6.1l-5 5 3.2 3.2 5-5a4.6 4.6 0 0 0 6.1-6.2l-2.8 2.8-2.2-2.2z"/>'
};

/* A category with no icon gets none, and the chip still reads correctly —
   the label was always the thing carrying the meaning. */
function chipIcon(id) {
  const paths = CAT_ICONS[id];
  if (!paths) return '';
  return `<svg class="chip__ico" viewBox="0 0 24 24" width="15" height="15" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${paths}</svg>`;
}

/* The categories currently drawn. Starts as the imported list so the chips
   paint with no request, and is replaced by the rows from /api/catalog when
   those differ — see liveCatalog() at the bottom of this file. */
let LIVE_CATS = CATEGORIES;

function renderChips() {
  const cats = [{ id: 'all', ar: T.all.ar, en: T.all.en }].concat(LIVE_CATS);
  chipsWrap.innerHTML = cats.map((c) => `
    <button class="chip${c.id === activeCat ? ' is-on' : ''}" type="button"
            data-cat="${esc(c.id)}" aria-pressed="${c.id === activeCat}">
      ${chipIcon(c.id)}<span>${esc(t(c))}</span>
    </button>`).join('');
}

/* Everything the grid actually draws, flattened to one string.

   The products table is SEEDED from public/catalog.js, so on most page loads
   /api/catalog returns exactly the catalogue the static file has already
   painted. Rebuilding the grid then means discarding sixty <article>s and
   sixty <img>s to produce byte-identical markup — which forces a full
   re-layout and makes the browser re-decode every product photo, under a
   customer who is already looking at the page and may already be scrolling
   it.

   So the second render has to earn itself. Comparing costs one pass over the
   list; not comparing costs the re-layout every single time. Only the fields
   below reach the markup — imageFor() derives from `img` and `cat`, both of
   which are here — so if this string is unchanged, the grid would be too. */
/* Control characters, so that nothing a product name or spec could contain
   is able to forge a field boundary and make two different catalogues
   produce the same signature. */
const FIELD_SEP = '\u0001';
const ROW_SEP = '\u0002';

/* `was` and the spec strings are normalised because the static file leaves
   them undefined where D1 returns 0 and '' — the markup renders those cases
   identically, so the signature has to agree, or it would see a difference on
   every load and never skip anything. */
function gridSignature(list) {
  return list.map((p) => [
    p.id, p.name, p.price, p.was || 0, p.cat,
    p.ar || '', p.en || '', p.img || ''
  ].join(FIELD_SEP)).join(ROW_SEP);
}

let lastGridSig = null;

function renderGrid() {
  const list = visible();
  lastGridSig = gridSignature(list);

  resultLine.textContent = list.length === 1
    ? t(T.resultsOne)
    : `${list.length} ${t(T.results)}`;

  emptyMsg.hidden = list.length > 0;

  grid.innerHTML = list.map((p) => {
    const qty = qtyOf(p.id);
    return `
    <article class="pcard" data-id="${esc(p.id)}">
      <div class="pcard__plate">
        <img src="${esc(imageFor(p))}" alt="" loading="lazy" width="500" height="500">
      </div>
      <div class="pcard__body">
        <p class="pcard__cat">${esc(t(CATEGORIES.find((c) => c.id === p.cat) || {}))}</p>
        <h3 class="pcard__name" dir="ltr">${esc(p.name)}</h3>
        <p class="pcard__spec">${esc(LANG === 'en' ? p.en : p.ar)}</p>
        <div class="pcard__foot">
          <p class="pcard__price">
            <b>${money(p.price)}</b>
            ${p.was ? `<s>${money(p.was)}</s>` : ''}
            <em>${esc(currency())}</em>
          </p>
          <div class="pcard__buy">${qty ? stepper(p.id, qty) : addButton(p.id)}</div>
        </div>
        <a class="link pcard__link" href="product.html?id=${esc(p.id)}">${esc(t(T.details))}</a>
      </div>
    </article>`;
  }).join('');
}

function addButton(id) {
  return `<button class="btn btn--sm add" type="button" data-add="${esc(id)}">${esc(t(T.add))}</button>`;
}

function stepper(id, qty) {
  return `
    <div class="step2" role="group" aria-label="${esc(t(T.qtyLabel))}">
      <button type="button" class="step2__btn" data-dec="${esc(id)}" aria-label="${esc(t(T.minus))}">−</button>
      <span class="step2__n" aria-live="polite">${qty}</span>
      <button type="button" class="step2__btn" data-inc="${esc(id)}" aria-label="${esc(t(T.plus))}"
              ${qty >= MAX_QTY ? 'disabled' : ''}>+</button>
    </div>`;
}

/* Only the buy control changes when a quantity does, so the whole grid does
   not get rebuilt (and images do not flicker) on every tap. */
function renderGridQuantities() {
  $$('.pcard', grid).forEach((card) => {
    const id = card.getAttribute('data-id');
    const qty = qtyOf(id);
    const slot = $('.pcard__buy', card);
    if (!slot) return;
    const next = qty ? stepper(id, qty) : addButton(id);
    if (slot.innerHTML.trim() !== next.trim()) slot.innerHTML = next;
    card.classList.toggle('is-in-cart', qty > 0);
  });
}

chipsWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat]');
  if (!btn) return;
  activeCat = btn.getAttribute('data-cat');
  const url = new URL(location.href);
  if (activeCat === 'all') url.searchParams.delete('cat');
  else url.searchParams.set('cat', activeCat);
  history.replaceState(null, '', url);
  renderChips();
  renderGrid();
  trackCategory();
});

/* ViewContent.

   This shop has no per-product page, so there is no "product viewed" moment
   to report — and firing one per card as it scrolls past would bury the real
   signal under dozens of events per visit. A category listing is the page
   here that corresponds to intent, so that is what ViewContent describes,
   with content_type 'product_group' rather than 'product' so the shape does
   not claim to be something it is not. Once per category per page load. */
function trackCategory() {
  if (!window.vgTrack) return;
  const shown = PRODUCTS.filter((p) => activeCat === 'all' || p.cat === activeCat);
  window.vgTrack.viewCategory(activeCat, shown.map((p) => ({ id: p.id })));
}

/* Including the one the page opened on — arriving from a category card on
   the landing page is exactly the case worth measuring. */
trackCategory();

/* One unit added is one AddToCart, whether it came from the add button or
   from the + stepper. Removing one is not an event — Meta has no
   RemoveFromCart standard event, and inventing one as a custom event would
   put a number in Ads Manager that no report knows what to do with. */
function trackAdd(id, qty) {
  if (!window.vgTrack) return;
  const p = findProduct(id);
  if (!p) return;
  window.vgTrack.addToCart({ id: p.id, qty: qty || 1, unit: p.price, name: p.name });
}

grid.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    setQty(add.getAttribute('data-add'), 1);
    trackAdd(add.getAttribute('data-add'), 1);
    toast(t(T.added), 'good');
    return;
  }
  const inc = e.target.closest('[data-inc]');
  if (inc) {
    setQty(inc.getAttribute('data-inc'), qtyOf(inc.getAttribute('data-inc')) + 1);
    trackAdd(inc.getAttribute('data-inc'), 1);
    return;
  }
  const dec = e.target.closest('[data-dec]');
  if (dec) return setQty(dec.getAttribute('data-dec'), qtyOf(dec.getAttribute('data-dec')) - 1);

  const card = e.target.closest('.pcard');
  if (!card) return;
  if (e.target.closest('.pcard__buy, .pcard__link')) return;

  const id = card.getAttribute('data-id');
  if (id) location.href = `product.html?id=${encodeURIComponent(id)}`;
});

let searchTimer;
let lastTrackedQuery = '';
$('#q').addEventListener('input', (e) => {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = value;
    renderGrid();
    /* Not per keystroke: the same debounce that redraws the grid, plus a
       floor of three characters and a check that the term actually changed.
       Otherwise "كاميرا" is seven Search events for one search. */
    const term = value.trim();
    if (term.length >= 3 && term !== lastTrackedQuery && window.vgTrack) {
      lastTrackedQuery = term;
      window.vgTrack.search(term);
    }
  }, 140);
});

$('#sort').addEventListener('change', (e) => { sort = e.target.value; renderGrid(); });

/* =========================================================================
   4. CART DRAWER
   ========================================================================= */
const cartEl = $('#cart');
const cartBtn = $('#cartBtn');
const scrim = $('#scrim');
const cartBody = $('#cartBody');
const cartFoot = $('#cartFoot');
const cartCountEl = $('#cartCount');

function openCart() {
  cartEl.classList.add('is-on');
  cartEl.removeAttribute('inert');
  cartEl.setAttribute('aria-hidden', 'false');
  cartBtn.setAttribute('aria-expanded', 'true');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-on'));
  document.documentElement.style.overflow = 'hidden';
  renderCheckoutBar();
  const first = $('button, a, input', cartEl);
  if (first) first.focus();
}

function closeCart() {
  cartEl.classList.remove('is-on');
  cartEl.setAttribute('inert', '');
  cartEl.setAttribute('aria-hidden', 'true');
  cartBtn.setAttribute('aria-expanded', 'false');
  scrim.classList.remove('is-on');
  setTimeout(() => { if (!scrim.classList.contains('is-on')) scrim.hidden = true; }, 350);
  document.documentElement.style.overflow = '';
  renderCheckoutBar();
}

cartBtn.addEventListener('click', () => {
  cartEl.classList.contains('is-on') ? closeCart() : openCart();
});
$('#cartClose').addEventListener('click', closeCart);
scrim.addEventListener('click', closeCart);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cartEl.classList.contains('is-on')) closeCart();
});

/* =========================================================================
   4b. CHECKOUT BAR
   Up the moment the cart stops being empty, down when it empties again.
   Checkout otherwise lives only at the bottom of the drawer, which costs a
   tap to open and gives no reason to open it.
   ========================================================================= */
let currentView = 'shop';
const cobar = $('#cobar');
const cobarCount = $('#cobarCount');
const cobarTotal = $('#cobarTotal');
const cobarGo = $('#cobarGo');

/* Anything else pinned to the bottom of the viewport offsets by this. It is
   measured rather than assumed: the pill grows when the total wraps, and in
   Arabic the copy is a different length. */
function publishBarHeight(on) {
  document.body.style.setProperty('--cobar-h', on ? `${cobar.offsetHeight}px` : '0px');
}

function renderCheckoutBar() {
  const count = cartCount();
  /* Keep the checkout bar visible as long as the customer still has items in
     the cart, even if they have moved into the checkout step. It disappears
     only once the cart is empty or the final confirmation view is reached.
     It also stays off while the cart drawer itself is open, because the drawer
     already exposes its own checkout entry point. */
  const on = count > 0 && currentView !== 'done' && !cartEl.classList.contains('is-on');

  cobarCount.textContent = count === 1 ? t(T.barOne) : `${count} ${t(T.barMany)}`;
  cobarTotal.textContent = `${money(subtotal())} ${currency()}`;
  cobarGo.textContent = t(T.checkout);

  cobar.classList.toggle('is-on', on);
  if (on) cobar.removeAttribute('inert');
  else cobar.setAttribute('inert', '');
  publishBarHeight(on);
}

cobarGo.addEventListener('click', () => showView('checkout'));

function renderCart() {
  const lines = cartLines();
  /* Counted off the lines already in hand rather than through cartCount(),
     which would resolve every product a second time to reach the same
     number. */
  const count = lines.reduce((n, l) => n + l.qty, 0);

  cartCountEl.textContent = String(count);
  cartCountEl.hidden = count === 0;
  cartBtn.classList.toggle('has-items', count > 0);

  if (!lines.length) {
    cartBody.innerHTML = `
      <div class="cart__empty">
        <p class="cart__emptytitle">${esc(t(T.empty))}</p>
        <p class="cart__emptyhint">${esc(t(T.emptyHint))}</p>
      </div>`;
    cartFoot.innerHTML = '';
    renderSummary();
    renderCheckoutBar();
    return;
  }

  cartBody.innerHTML = lines.map(({ product: p, qty, line }) => `
    <div class="cline" data-id="${esc(p.id)}">
      <div class="cline__plate"><img src="${esc(imageFor(p))}" alt="" loading="lazy" width="120" height="120"></div>
      <div class="cline__meta">
        <p class="cline__name" dir="ltr">${esc(p.name)}</p>
        <p class="cline__spec">${esc(LANG === 'en' ? p.en : p.ar)}</p>
        ${stepper(p.id, qty)}
      </div>
      <div class="cline__end">
        <p class="cline__price">${money(line)} <em>${esc(currency())}</em></p>
        <button class="cline__rm" type="button" data-rm="${esc(p.id)}">${esc(t(T.remove))}</button>
      </div>
    </div>`).join('');

  cartFoot.innerHTML = `
    <div class="crow">
      <span>${esc(t(T.subtotal))}</span>
      <b>${money(subtotal())} ${esc(currency())}</b>
    </div>
    <div class="crow crow--muted">
      <span>${esc(t(T.shipping))}</span>
      <span>${esc(t(T.shipTbd))}</span>
    </div>
    <button class="btn btn--wide" type="button" id="toCheckout">${esc(t(T.checkout))}</button>`;

  $('#toCheckout').addEventListener('click', () => { closeCart(); showView('checkout'); });
  renderSummary();
  renderCheckoutBar();
}

cartBody.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) return setQty(rm.getAttribute('data-rm'), 0);
  const inc = e.target.closest('[data-inc]');
  if (inc) return setQty(inc.getAttribute('data-inc'), qtyOf(inc.getAttribute('data-inc')) + 1);
  const dec = e.target.closest('[data-dec]');
  if (dec) return setQty(dec.getAttribute('data-dec'), qtyOf(dec.getAttribute('data-dec')) - 1);
});

/* =========================================================================
   5. VIEWS
   ========================================================================= */
const views = {
  shop: $('#viewShop'),
  checkout: $('#viewCheckout'),
  done: $('#viewDone')
};

function showView(name) {
  if (name === 'checkout' && !cart.length) { openCart(); return; }
  Object.keys(views).forEach((k) => { views[k].hidden = k !== name; });
  currentView = name;
  renderCheckoutBar();
  window.scrollTo(0, 0);
  if (name === 'checkout') {
    renderSummary();
    /* Asked here, not only at page load. The lookup needs a subtotal and at
       page load the cart is usually empty, so the first attempt returns
       nothing — which meant a signed-out visitor was never shown that
       signing in would save them 5%, unless they happened to type in the
       phone field. This is the one place every route into checkout passes
       through, the same reason InitiateCheckout is fired here. */
    refreshWelcome();
    /* InitiateCheckout belongs here rather than on the two buttons that lead
       here — the cart drawer's and the sticky bar's — because this is the
       one place both of them end up, and a third entry point added later
       gets it for free. Fired on every entry, not once: going back to the
       shop and returning is a real second attempt at checking out, and
       suppressing it would hide the drop-off this event exists to show. */
    if (window.vgTrack) window.vgTrack.initiateCheckout(pixelLines());
    const first = $('#oName');
    if (first && !first.value) first.focus();
  }
}

$('#backToShop').addEventListener('click', () => showView('shop'));

/* AddPaymentInfo used to fire when one of two payment radios was chosen.
   There is no choice left — every order is settled on WhatsApp — so the
   event moved to the moment the customer actually goes to pay: the jump to
   WhatsApp from the confirmation screen, or the tap on its button. See
   markPaymentStarted() below.

   That is a later and rarer moment than picking a radio was, and it should
   be: it now reports someone leaving to send money rather than someone
   glancing at a form, which is the more honest reading of the event and the
   one worth optimising ads against. */

/* =========================================================================
   6. CHECKOUT
   ========================================================================= */
const govSelect = $('#oGov');

function renderGovernorates() {
  const current = govSelect.value;
  govSelect.innerHTML =
    `<option value="" disabled ${current ? '' : 'selected'}>${esc(t(T.chooseGov))}</option>` +
    GOVERNORATES.map((g) => {
      const value = LANG === 'en' ? g.en : g.ar;
      return `<option value="${esc(value)}">${esc(value)}</option>`;
    }).join('');
  /* The value is the localised name, so a language flip has to re-map it. */
  if (current) {
    const match = GOVERNORATES.find((g) => g.ar === current || g.en === current);
    if (match) govSelect.value = LANG === 'en' ? match.en : match.ar;
  }
}

function renderSummary() {
  const lines = cartLines();
  const sumLines = $('#sumLines');
  const sumTotals = $('#sumTotals');
  if (!sumLines || !sumTotals) return;

  sumLines.innerHTML = lines.map(({ product: p, qty, line }) => `
    <div class="sline">
      <span class="sline__name" dir="ltr">${esc(p.name)}</span>
      <span class="sline__qty">× ${qty}</span>
      <span class="sline__price">${money(line)}</span>
    </div>`).join('');

  const sub = subtotal();
  const off = welcome.eligible ? welcome.discount : 0;

  sumTotals.innerHTML = `
    <div class="crow">
      <span>${esc(t(T.subtotal))}</span>
      <b>${money(sub)} ${esc(currency())}</b>
    </div>
    ${off > 0 ? `
    <div class="crow crow--off">
      <span>${esc(welcome.kind === 'promo' && welcome.code ? welcome.code : t(T.firstOrderOff))}</span>
      <b dir="ltr">−${money(off)} ${esc(currency())}</b>
    </div>
    <div class="crow">
      <span>${esc(t(T.afterOff))}</span>
      <b>${money(sub - off)} ${esc(currency())}</b>
    </div>` : ''}
    <div class="crow crow--muted">
      <span>${esc(t(T.shipping))}</span>
      <span>${esc(t(T.shipTbd))}</span>
    </div>`;

  /* The nudge for somebody who is entitled to it but is not signed in. It
     is the only case worth interrupting the checkout for: they can have ten
     percent off by signing in, and nobody would guess that unprompted. */
  const note = $('#welcomeNote');
  if (note) {
    if (welcome.eligible) {
      /* What they have, and how long they have it for. The countdown is
         part of the same sentence rather than a second line: it is a fact
         about this discount, not another announcement. */
      const left = welcome.daysLeft > 1
        ? ' ' + t(T.welcomeDaysLeft).replace('{n}', String(welcome.daysLeft))
        : (welcome.daysLeft === 1 ? ' ' + t(T.welcomeLastDay) : '');
      note.className = 'conote is-good';
      note.textContent = t(T.welcomeApplied).replace('{pct}', String(welcome.percent)) + left;
      note.hidden = false;
    } else if (welcome.canSignInFor) {
      note.className = 'conote';
      note.textContent = t(T.welcomeSignIn)
        .replace('{pct}', String(welcome.percent))
        .replace('{days}', String(welcome.days));
      note.hidden = false;
    } else if (welcome.expired) {
      note.className = 'conote';
      note.textContent = t(T.welcomeExpired).replace('{days}', String(welcome.days));
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }
}

/* =========================================================================
   THE FIRST-ORDER DISCOUNT

   The cart asks the server whether this person may have it, so the summary
   can show a line before the order is placed. The answer is ADVISORY and
   this file never decides anything: functions/api/orders.js runs the whole
   evaluation again against the orders table when the order arrives, and
   that is what is charged. A tampered `welcome` object here changes what is
   drawn on one screen and nothing about the money.

   Re-asked when the phone number changes, because in this shop the phone IS
   the identity — it is what the order is chased on and what the payment
   conversation happens over. A returning customer who signs up again under a
   new email is caught by their number, and offering them a discount the
   checkout then quietly refuses would be worse than never offering it.
   ========================================================================= */
/* No welcome code is named in this file any more. There are two of them now
   — ten per cent on the first day, five for the four after — and which one
   an account is on is read from its age by the server. Naming either here
   would be this file having an opinion it cannot keep up to date.

   `percent`, `days` and `daysLeft` all arrive with the answer; the values
   below are only what to draw before it does. */
let welcome = {
  eligible: false, discount: 0, percent: 0, amount: 0, canSignInFor: false,
  expired: false, days: 5, daysLeft: 0, kind: 'welcome', code: '', reason: '',
  minSubtotal: 0
};
let welcomeTimer = null;

/* The code the customer typed, if any. Empty means "whatever I am entitled
   to", which is what the server reads an empty code as — so the welcome
   discount keeps applying to somebody who never touches the box. */
let typedCode = '';

async function refreshWelcome() {
  const sub = subtotal();
  if (!sub) return;
  /* The typed code when there is one, and nothing when there is not. Sending
     WELCOME10 explicitly would be this file having an opinion about which
     tier the customer is on; the server reads that off the account. */
  const qs = new URLSearchParams({ subtotal: String(sub) });
  if (typedCode) qs.set('code', typedCode);
  const phone = ($('#oPhone') && $('#oPhone').value || '').trim();
  if (phone) qs.set('phone', phone);
  try {
    const data = await api('/api/coupon?' + qs.toString());
    welcome = {
      eligible: !!data.eligible,
      discount: Number(data.discount) || 0,
      percent: Number(data.percent) || 0,
      amount: Number(data.amount) || 0,
      canSignInFor: !!data.canSignInFor,
      expired: !!data.expired,
      days: Number(data.days) || 5,
      daysLeft: Number(data.daysLeft) || 0,
      /* Which kind of discount answered, and what it was called. The
         summary line says "PARTY20" for an issued code and "first order"
         for the welcome one. */
      kind: data.kind || 'welcome',
      code: data.code || '',
      reason: data.reason || '',
      minSubtotal: Number(data.minSubtotal) || 0
    };
  } catch (e) {
    /* Never block checkout over a discount lookup. No answer means no line
       on the summary, and the order still goes through at full price — the
       server would have applied it anyway if they were entitled. */
    welcome = {
      eligible: false, discount: 0, percent: 0, amount: 0, canSignInFor: false,
      expired: false, days: 5, daysLeft: 0, kind: 'welcome', code: '', reason: '',
      minSubtotal: 0
    };
  }
  renderSummary();
  renderPromoNote();
}

/* -------------------------------------------------------------------------
   A CODE THE SHOP HANDED OUT

   Applied by asking the server, exactly as the welcome offer is: this file
   never decides that a code is good. What it does decide is what to SAY
   about the answer, which is a different job and the reason the refusals
   come back as reason codes rather than as sentences.
   ------------------------------------------------------------------------- */
const PROMO_REASONS = {
  unknown_code:       T.promoUnknown,
  code_inactive:      T.promoUnknown,
  code_not_started:   T.promoNotYet,
  code_expired:       T.promoOver,
  code_used_up:       T.promoUsedUp,
  below_minimum:      T.promoMin,
  not_a_new_customer: T.promoNewOnly,
  not_signed_in:      T.promoSignIn
};

function renderPromoNote() {
  const note = $('#promoNote');
  if (!note) return;

  /* Nothing typed: this line is about the typed code and there is none. The
     welcome offer has its own line above. */
  if (!typedCode) { note.hidden = true; return; }

  if (welcome.eligible && welcome.kind === 'promo') {
    note.className = 'conote is-good';
    note.textContent = t(T.promoApplied).replace('{code}', welcome.code || typedCode);
    note.hidden = false;
    return;
  }

  const copy = PROMO_REASONS[welcome.reason] || T.promoUnknown;
  note.className = 'conote is-bad';
  note.textContent = t(copy)
    .replace('{code}', typedCode)
    .replace('{min}', String(welcome.minSubtotal || 0));
  note.hidden = false;
}

/* Debounced: this fires on every keystroke in the phone field. */
function scheduleWelcome() {
  clearTimeout(welcomeTimer);
  welcomeTimer = setTimeout(refreshWelcome, 400);
}

/* Prefills from the account when there is one. Signed-out checkout stays
   fully available — making people register to buy loses orders. */
(async function prefill() {
  try {
    const { user } = await api('/api/auth/me');
    if (!user) return;
    if (!$('#oName').value) $('#oName').value = user.name || '';
    if (!$('#oPhone').value && user.phone) $('#oPhone').value = '0' + String(user.phone).replace(/^20/, '');
    if (!$('#oEmail').value) $('#oEmail').value = user.email || '';
    if (user.newsletter) $('#oNews').checked = true;
  } catch (e) {
    /* Signed out, or the API is not wired up yet. Checkout still works. */
  }
  /* After the prefill, so the first lookup already carries the phone number
     the account supplied — otherwise a returning customer is shown the
     discount for a moment and then has it taken away as they type. */
  refreshWelcome();
})();

/* Applying a code is just re-asking the server with it. Submitting the tiny
   form rather than reacting to keystrokes is deliberate: a code is typed in
   one go and half of one is not a question worth asking, let alone asking on
   every letter. */
if ($('#promoForm')) {
  $('#promoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    typedCode = ($('#oPromo').value || '').trim().toUpperCase().replace(/\s+/g, '');
    $('#oPromo').value = typedCode;
    refreshWelcome();
  });
  /* Clearing the box goes back to "whatever I am entitled to" without
     needing the button — otherwise a customer who changes their mind is
     stuck with a refusal message they cannot dismiss. */
  $('#oPromo').addEventListener('input', () => {
    if (!$('#oPromo').value.trim() && typedCode) {
      typedCode = '';
      refreshWelcome();
    }
  });
}

/* The phone is the identity here, so changing it can change the answer.
   Debounced, because this is every keystroke. */
if ($('#oPhone')) {
  $('#oPhone').addEventListener('input', scheduleWelcome);
  $('#oPhone').addEventListener('blur', refreshWelcome);
}

/* =========================================================================
   THE PENDING ORDER

   The shop takes no card and no cash on delivery. An order is written
   UNPAID, and the transfer is arranged in the shop's own WhatsApp — so this
   screen has one job: show that the order exists and is pending, and give
   one button that reaches us about it.

   IT DOES NOT NAVIGATE ITSELF ANY MORE. An earlier version jumped to
   WhatsApp a beat after the confirmation rendered, and that undoes the
   screen's whole purpose: somebody thrown out of a confirmation before
   reading it cannot tell whether their order was taken. The button opens
   WhatsApp in a new tab instead, so this page — the order number, the
   amount, the word "pending" — is still here when they come back, and is
   still here tomorrow if they come back tomorrow.

   The order number travels inside the WhatsApp message as well, so the
   conversation can start without them copying anything down. See
   paymentMessage() in lib/orders.js.
   ========================================================================= */
let payLines = [];

/* The customer is on their way to pay. This is the honest moment for Meta's
   AddPaymentInfo — see the note where the payment radios used to be. It
   fires once per page, because track.js keys the event on the method. */
function markPaymentStarted() {
  if (window.vgTrack) window.vgTrack.addPaymentInfo('transfer', payLines);
}

function showPayment(order) {
  const box = $('#donePay');
  const link = $('#donePayLink');
  if (!box || !link) return;

  /* What is owed, next to the word "pending". A status without a number is
     half an answer — this is the figure the customer is about to transfer. */
  const amount = $('#donePayAmount');
  if (amount) {
    const total = Number(order && order.total) || 0;
    amount.textContent = total > 0 ? `${money(total)} ${currency()}` : '';
    amount.hidden = total <= 0;
  }

  /* No link means the server did not offer one — an already-paid order, or
     an older API. Say the number instead of showing a button that goes
     nowhere. */
  const url = order && order.payUrl;
  if (!url) {
    link.hidden = true;
    $('#donePayNote').textContent = t(T.payManual);
    box.hidden = false;
    return;
  }

  link.hidden = false;
  link.href = url;
  box.hidden = false;
}

/* Tapping through to WhatsApp is the funnel step worth reporting. The link
   opens in a new tab and needs nothing else done to it — no preventDefault,
   no navigation of our own. */
$('#viewDone').addEventListener('click', (e) => {
  if (e.target.closest('#donePayLink')) markPaymentStarted();
});

const orderForm = $('#orderForm');
const orderErr = $('#orderErr');
const placeBtn = $('#placeBtn');

function showError(err) {
  orderErr.textContent = err.display || err.message;
  orderErr.hidden = false;
  const field = err.field && ({
    name: '#oName', phone: '#oPhone', phoneAlt: '#oPhoneAlt', email: '#oEmail',
    governorate: '#oGov', address: '#oAddress', terms: '#oTerms'
  })[err.field];
  const el = field && $(field);
  if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  else orderErr.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

let placing = false;

orderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (placing) return;
  orderErr.hidden = true;

  if (!cart.length) { showView('shop'); openCart(); return; }

  if (!$('#oTerms').checked) {
    return showError({ code: 'terms_required', field: 'terms', display: t({
      ar: 'لازم توافق على الشروط وسياسة الاستبدال قبل تأكيد الطلب.',
      en: 'Please accept the terms and the exchange policy before ordering.'
    }) });
  }

  placing = true;
  placeBtn.disabled = true;
  placeBtn.innerHTML = `<span>${esc(t(T.placing))}</span>`;

  try {
    /* No `payment` field any more. There is one way to pay and the server
       owns what it is called — sending a value from here would be this file
       having an opinion about it, and a cached copy of an older shop.js
       would then be able to disagree with the shop. */
    const data = await api('/api/orders', {
      body: {
        name: $('#oName').value,
        phone: $('#oPhone').value,
        phoneAlt: $('#oPhoneAlt').value,
        email: $('#oEmail').value,
        governorate: govSelect.value,
        address: $('#oAddress').value,
        notes: $('#oNotes').value,
        terms: true,
        /* Sent only as "please consider this code", and empty when the
           customer typed nothing — which the server reads as "whatever they
           are entitled to" and answers with the welcome offer. It re-decides
           the whole thing from its own tables and ignores this if they are
           not entitled; see the note in functions/api/orders.js about why
           that is silent rather than an error. */
        coupon: typedCode,
        newsletter: $('#oNews').checked,
        marketing: $('#oNews').checked,
        lang: LANG,
        /* The advertising-measurement answer from the cookie bar, which is a
           different thing from the newsletter box above it: one is about
           emails we send, this is about whether the order may be reported to
           Meta at all.

           It has to travel with the order because the server relays Purchase
           to the Conversions API on its own, in functions/api/orders.js —
           that path does not go through the browser, so nothing the browser
           blocks can stop it. Without this field a visitor who pressed
           Reject would still have their order sent, which would make the
           Reject button a lie. */
        adConsent: !!(window.vgConsent && window.vgConsent.marketing()),
        cart: cart.map((l) => ({ id: l.id, qty: l.qty }))
      }
    });

    cart = [];
    save();
    renderCart();
    renderGridQuantities();

    $('#doneNum').textContent = data.order.id;
    $('#doneNote').textContent = t(T.doneNote);

    /* What they actually saved, read off the SERVER's order rather than the
       local `welcome` object. The two can legitimately disagree — the
       server has the final say and may have refused a discount this screen
       was still showing — and the confirmation must state what was
       charged, not what was hoped for. */
    const saved = $('#doneSaved');
    if (saved) {
      const off = Number(data.order.discount) || 0;
      saved.textContent = off > 0
        ? `${t(T.savedWord)} ${money(off)} ${currency()}`
        : '';
      saved.hidden = off <= 0;
    }

    /* Read off data.order, not the local cart: the cart has already been
       emptied above, and the server's copy is the priced, authoritative one.
       Held on `payLines` as well, because AddPaymentInfo now fires on the
       way to WhatsApp — after this handler has returned and long after the
       cart stopped existing. */
    const orderLines = (data.order.items || [])
      .map((i) => ({ id: i.id, qty: i.qty, unit: i.unit, name: i.name }));
    payLines = orderLines;

    /* Purchase, browser side. The order number is passed as the event id and
       functions/api/orders.js sends the same one to the Conversions API, so
       Meta collapses the two copies into a single conversion. Without that
       every order was reported twice, at twice the revenue. See track.js. */
    if (window.vgTrack) {
      /* Guest checkout is most of this shop's orders, so this is where the
         majority of identifiable events come from. Identify BEFORE the
         Purchase fires, so the purchase itself carries the matching rather
         than only whatever comes after it. */
      window.vgTrack.identify({ email: $('#oEmail').value, phone: $('#oPhone').value });
      window.vgTrack.purchase(data.order.id, orderLines, data.order.total);
      /* A ticked newsletter box at checkout is a mailing-list opt-in, which
         is the thing Meta calls a Lead. */
      if ($('#oNews').checked) window.vgTrack.lead('checkout');
    }

    showView('done');
    /* After the view is on screen, so the panel is filled into something
       already drawn rather than into a hidden section. */
    showPayment(data.order);
  } catch (err) {
    showError(err);
  } finally {
    placing = false;
    placeBtn.disabled = false;
    placeBtn.innerHTML = `<span>${esc(t(T.place))}</span>`;
  }
});

/* =========================================================================
   7. BOOT + LANGUAGE
   ========================================================================= */
onLang(() => {
  renderChips();
  renderGrid();
  renderCart();
  renderGovernorates();
  const num = $('#doneNum');
  if (num && num.textContent) $('#doneNote').textContent = t(T.doneNote);
});

renderChips();
renderGrid();

/* Live prices. Deliberately after the first paint: a slow or failed fetch
   must never leave a customer looking at an empty shop, so the static list
   is what they see until the real one arrives, and the grid is redrawn once
   it does. A failure here is logged and otherwise ignored — the static
   prices are the ones the site shipped with, not nonsense. */
(async function liveCatalog() {
  try {
    const res = await fetch('/api/catalog', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.products) || !data.products.length) return;

    PRODUCTS = data.products;
    BY_ID = new Map(PRODUCTS.map(function (p) { return [p.id, p]; }));

    /* Anything already in the cart that no longer exists is dropped, and
       quantities are kept. A cart holding a withdrawn product would fail at
       checkout with "no longer available"; better to clear it here, while
       the customer can still see what changed. */
    const before = cart.length;
    cart = cart.filter(function (l) { return findProduct(l.id); });
    if (cart.length !== before) save();

    /* The chips ARE redrawn now, but only when the categories actually
       changed. They used to be drawn purely from the CATEGORIES import, so
       this block changed nothing about them and calling renderChips() here
       rebuilt identical buttons on every page load.

       Categories are rows now — an administrator can rename, reorder or hide
       one — so the live list has to be able to replace the imported one. The
       comparison is what keeps the old waste from coming back with it, and
       it matters more than it looks: rebuilding the chips would drop the
       one the customer has focused mid-tab. */
    if (Array.isArray(data.categories) && data.categories.length) {
      const shape = (l) => l.map((c) => `${c.id}|${c.ar}|${c.en}`).join('~');
      if (shape(data.categories) !== shape(LIVE_CATS)) {
        LIVE_CATS = data.categories;
        /* A category can be hidden while a customer is filtered on it. Fall
           back to everything rather than showing an empty grid under a chip
           that is no longer there. */
        if (activeCat !== 'all' && !LIVE_CATS.some((c) => c.id === activeCat)) {
          activeCat = 'all';
        }
        renderChips();
      }
    }

    /* The grid only gets rebuilt if what it would draw actually differs; see
       gridSignature above for why that check is worth making. */
    if (gridSignature(visible()) !== lastGridSig) renderGrid();

    /* Always, though: the buy controls follow the CART, not the catalogue,
       and the prune above may have emptied one even when the grid itself is
       untouched. This is the cheap targeted update, not a rebuild. */
    renderGridQuantities();
    renderCart();
  } catch (e) {
    console.info('live catalogue unavailable, using the built-in prices', e && e.message);
  }
})();
renderCart();
renderGovernorates();

/* #checkout on arrival.

   The coverage planner (game.html) builds a whole system — cameras, recorder,
   drive, power, cable — writes it into this same cart, and sends the customer
   straight here. Without this they landed on the product grid with a full
   cart and no indication that anything had happened.

   Guarded on the cart being non-empty, so a stale bookmarked #checkout on an
   empty cart still shows the shop rather than an empty checkout form. */
if (location.hash === '#checkout' && cart.length) showView('checkout');

/* A cart edited in a second tab should not be silently overwritten by this
   one the next time something is added. */
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  cart = load();
  renderCart();
  renderGridQuantities();
});
