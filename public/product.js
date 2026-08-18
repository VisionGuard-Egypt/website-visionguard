import { initChrome, $, onLang, LANG, money, currency, esc, t } from './site.js?v=66';
import { CATEGORIES, findProduct as staticFind, imageFor, productDescription } from './catalog.js?v=66';

initChrome();

const params = new URLSearchParams(location.search);
const productId = params.get('id');
const KEY = 'vg-cart';

/* Start from the static catalogue so the page paints immediately, then swap
   in /api/catalog — which reads the products table — exactly as shop.js does.

   Without this the page was static-only, which meant an administrator could
   upload a new photo, watch it appear on the shop grid, open the product's
   own page and still see the old one. Same for a price or a name: the detail
   page was the one place in the shop that never reflected an edit. */
let LIVE = null;
function findProduct(id) {
  if (LIVE) return LIVE.get(String(id)) || null;
  return staticFind(id);
}

let product = findProduct(productId);

async function refreshCatalog() {
  try {
    const res = await fetch('/api/catalog', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.products) || !data.products.length) return;
    LIVE = new Map(data.products.map((p) => [p.id, p]));
    const fresh = findProduct(productId);
    if (fresh) {
      product = fresh;
      renderProduct();
      renderCartBar();
    }
  } catch (e) {
    /* Static prices are last-known-good; a failed refresh is not a broken
       page. Same reasoning as lib/products.js on the server. */
  }
}

const productName = $('#productName');
const productCategory = $('#productCategory');
const productPhoto = $('#productPhoto');
const productSpec = $('#productSpec');
const productBrand = $('#productBrand');
const productPrice = $('#productPrice');
const productDescriptionNode = $('#productDescription');
const addButton = $('#productAdd');
const productCobar = $('#productCobar');
const productCobarCount = $('#productCobarCount');
const productCobarTotal = $('#productCobarTotal');
const productCobarGo = $('#productCobarGo');

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function saveCart(cart) {
  try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) {}
}

function addToCart() {
  if (!product) return;
  const cart = loadCart();
  const line = cart.find((item) => item.id === product.id);
  if (line) line.qty = Math.min(99, line.qty + 1);
  else cart.push({ id: product.id, qty: 1 });
  saveCart(cart);
  renderCartBar();
  /* The shop grid reported its adds and this page did not, so a customer who
     went straight to a product and bought it produced a Purchase with no
     AddToCart anywhere before it — a funnel with a hole in the middle. */
  if (window.vgTrack) {
    window.vgTrack.addToCart({ id: product.id, qty: 1, unit: product.price, name: product.name });
  }
}

function subtotal() {
  const cart = loadCart();
  return cart.reduce((sum, item) => {
    const pm = findProduct(item.id);
    if (!pm) return sum;
    return sum + (Number(pm.price) || 0) * (Number(item.qty) || 0);
  }, 0);
}

function renderCartBar() {
  const cart = loadCart();
  const count = cart.reduce((n, item) => n + (Number(item.qty) || 0), 0);
  const on = count > 0;

  productCobarCount.textContent = count === 1
    ? (LANG === 'en' ? '1 item in your cart' : 'منتج واحد في السلة')
    : (LANG === 'en' ? `${count} items in your cart` : `${count} منتجات في السلة`);
  productCobarTotal.textContent = `${money(subtotal())} ${currency()}`;
  productCobarGo.textContent = LANG === 'en' ? 'Checkout' : 'الدفع';

  productCobar.hidden = false;
  productCobar.classList.toggle('is-on', on);

  requestAnimationFrame(() => {
    document.body.style.setProperty('--cobar-h', on ? `${productCobar.offsetHeight}px` : '0px');
    productCobar.hidden = !on;
  });
}

function renderProduct() {
  if (!product) {
    productName.textContent = LANG === 'en' ? 'Product not found' : 'المنتج غير موجود';
    productCategory.textContent = LANG === 'en' ? 'Catalogue' : 'الكتالوج';
    productSpec.textContent = LANG === 'en' ? 'Please return to the shop list.' : 'برجاء الرجوع إلى قائمة المتجر.';
    productDescriptionNode.textContent = '';
    addButton.disabled = true;
    return;
  }

  const cat = CATEGORIES.find((c) => c.id === product.cat) || {};
  const brand = product.brand || 'Vision Guard';
  const spec = LANG === 'en' ? product.en : product.ar;

  productName.textContent = product.name;
  productCategory.textContent = t(cat);
  productBrand.textContent = brand;
  productSpec.textContent = spec || product.name;
  productPrice.textContent = `${money(product.price)} ${currency()}`;
  productDescriptionNode.textContent = productDescription(product, LANG);
  productPhoto.src = imageFor(product);
  productPhoto.alt = product.name;
  addButton.disabled = false;
}

addButton.addEventListener('click', addToCart);
window.addEventListener('storage', renderCartBar);
window.addEventListener('pageshow', renderCartBar);

onLang(() => {
  renderProduct();
  renderCartBar();
  renderLive();
});
renderProduct();
renderCartBar();

/* ---------------------------------------------------------------------------
   Live interest

   Real counts of real people, from /api/product-activity. The endpoint decides
   whether there is enough to be worth showing (`show`), so a quiet product
   simply says nothing rather than announcing that nobody is looking at it.
   --------------------------------------------------------------------------- */
const liveBox = $('#productLive');
const liveText = $('#productLiveText');
let liveData = null;

function renderLive() {
  if (!liveBox || !liveText) return;
  if (!liveData || !liveData.show) { liveBox.hidden = true; return; }

  const { viewers, views, purchases, windowHours } = liveData;
  let msg;

  if (viewers >= 3) {
    msg = LANG === 'en'
      ? `${viewers} people are looking at this right now`
      : `${viewers} شخص بيتفرجوا على المنتج ده دلوقتي`;
  } else if (views > 0) {
    msg = LANG === 'en'
      ? `${views} people viewed this in the last ${windowHours} hours`
      : `${views} شخص شافوا المنتج ده في آخر ${windowHours} ساعة`;
  } else if (purchases > 0) {
    msg = LANG === 'en'
      ? `${purchases} bought in the last week`
      : `${purchases} اتباعوا الأسبوع اللي فات`;
  } else {
    liveBox.hidden = true;
    return;
  }

  liveText.textContent = msg;
  liveBox.hidden = false;
}

async function loadLive() {
  if (!product) return;
  try {
    const res = await fetch('/api/product-activity?id=' + encodeURIComponent(product.id), {
      credentials: 'same-origin'
    });
    liveData = await res.json();
    renderLive();
  } catch (e) {
    /* A shop page must not care that a badge could not be fetched. */
  }
}

/* ViewContent for this one product.

   Registered through consent rather than fired outright, the same way
   track.js registers its PageView: on a first visit the region lookup is
   still in flight at this point, and firing now would simply be dropped. */
/* Kept to the very bottom, after every const above has been initialised —
   loadLive() reaches liveBox through renderLive(), and refreshCatalog()
   reaches the render functions. Both are async, so today they would resolve
   after the module body finished either way; putting the calls here means
   that stays true if someone later makes one of them do work up front. */
loadLive();
refreshCatalog();

if (product) {
  const fireView = () => { if (window.vgTrack) window.vgTrack.viewProduct(product); };
  if (window.vgConsent && typeof window.vgConsent.onMarketing === 'function') {
    window.vgConsent.onMarketing(fireView);
  } else {
    fireView();
  }
}


