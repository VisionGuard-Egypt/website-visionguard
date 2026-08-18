/* =========================================================================
   Vision Guard — site.js
   The chrome that every page other than the landing page shares: language,
   nav, menu, and the small helpers the shop and account pages both need.

   index.html deliberately does NOT use this — it has main.js, which owns the
   hero canvas and the weighted scrolling as well. The language mechanism is
   identical in both, and on purpose: Arabic lives in the markup, English in
   data-en, and the original Arabic is captured into data-ar at boot so there
   is never a second dictionary to drift.
   ========================================================================= */

export const root = document.documentElement;

export function $(sel, scope) { return (scope || document).querySelector(sel); }
export function $$(sel, scope) { return [].slice.call((scope || document).querySelectorAll(sel)); }

/* -------------------------------------------------------------------------
   Language
   ------------------------------------------------------------------------- */
const i18nEls = $$('[data-en]');
i18nEls.forEach((el) => el.setAttribute('data-ar', el.innerHTML));

/* Placeholders are an attribute, not content, so they need their own pair:
   the Arabic sits in placeholder=, the English in data-ph-en. */
const phEls = $$('[data-ph-en]');
phEls.forEach((el) => el.setAttribute('data-ph-ar', el.getAttribute('placeholder') || ''));

export let LANG = 'ar';
try { LANG = localStorage.getItem('vg-lang') === 'en' ? 'en' : 'ar'; } catch (e) {}

const renderers = [];

/* Markup translated by data-en swaps itself. Anything built by JS cannot, so
   it re-renders instead — register it here and it stays in step. */
export function onLang(fn) {
  renderers.push(fn);
  return fn;
}

export function applyLang(lang) {
  LANG = lang === 'en' ? 'en' : 'ar';
  root.setAttribute('lang', LANG);
  root.setAttribute('dir', LANG === 'ar' ? 'rtl' : 'ltr');
  i18nEls.forEach((el) => {
    const html = el.getAttribute(LANG === 'en' ? 'data-en' : 'data-ar');
    if (html !== null) el.innerHTML = html;
  });
  phEls.forEach((el) => {
    const ph = el.getAttribute(LANG === 'en' ? 'data-ph-en' : 'data-ph-ar');
    if (ph !== null) el.setAttribute('placeholder', ph);
  });
  const btn = $('#lang');
  if (btn) {
    btn.textContent = LANG === 'ar' ? 'EN' : 'ع';
    btn.setAttribute('aria-label', LANG === 'ar' ? 'Switch to English' : 'التبديل إلى العربية');
  }
  try { localStorage.setItem('vg-lang', LANG); } catch (e) {}
  renderers.forEach((fn) => { try { fn(LANG); } catch (e) { console.error(e); } });

  /* For code that cannot import this module — a classic script such as
     consent.js, which builds its own markup and so has no data-en node to
     be swapped for it. main.js dispatches the identical event on the landing
     page, so one listener covers both halves of the site. */
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: LANG } }));
}

/* Picks the right half of a {ar, en} pair. */
export function t(pair) {
  if (!pair) return '';
  return (LANG === 'en' ? pair.en : pair.ar) || pair.ar || pair.en || '';
}

/* -------------------------------------------------------------------------
   Theme — dark (default) / light

   The stored choice is applied by the inline <head> script before first
   paint; this only wires the button. The logo is an <img>, so its src is
   swapped rather than styled: light mode returns to logo-trim.png, the
   original artwork whose GUARD wordmark is the brand's own #58595B grey.
   ------------------------------------------------------------------------- */
const LOGO = { dark: 'assets/logo-dark.png', light: 'assets/logo-trim.png' };
const PAGE_COLOR = { dark: '#08090B', light: '#F6F7F9' };

export let THEME = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

const themeHooks = [];
export function onTheme(fn) { themeHooks.push(fn); return fn; }

export function applyTheme(theme, persist) {
  THEME = theme === 'light' ? 'light' : 'dark';
  root.setAttribute('data-theme', THEME);

  const src = LOGO[THEME];
  $$('.brand__logo, .boot__mark img').forEach((img) => {
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  });

  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', PAGE_COLOR[THEME]);

  const btn = $('#theme');
  if (btn) {
    btn.setAttribute('aria-pressed', THEME === 'light' ? 'true' : 'false');
    btn.setAttribute('aria-label', THEME === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  }

  if (persist) { try { localStorage.setItem('vg-theme', THEME); } catch (e) {} }
  themeHooks.forEach((fn) => { try { fn(THEME); } catch (e) { console.error(e); } });
}

/* -------------------------------------------------------------------------
   Formatting
   ------------------------------------------------------------------------- */
export function money(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function currency() {
  return LANG === 'en' ? 'EGP' : 'ج.م';
}

export function hhmm(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function hoursLabel(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (LANG === 'en') return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${h} س ${String(m).padStart(2, '0')} د`;
}

/* Every string that reaches innerHTML goes through this. Product names come
   from our own catalogue, but order notes and account names do not. */
export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function localDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LANG === 'en' ? 'en-GB' : 'ar-EG', {
    timeZone: 'Africa/Cairo', day: '2-digit', month: 'short', year: 'numeric'
  }).format(d);
}

export function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LANG === 'en' ? 'en-GB' : 'ar-EG', {
    timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: LANG !== 'en'
  }).format(d);
}

/* -------------------------------------------------------------------------
   API

   Server messages are English. Anything the customer can actually trigger
   gets an Arabic equivalent here, keyed by the stable error code, so the UI
   is never half-translated at the exact moment something goes wrong.
   ------------------------------------------------------------------------- */
const ERRORS_AR = {
  no_database:     'قاعدة البيانات مش متوصلة لسه. راجع إعداد D1 في الـ README.',
  no_secret:       'تسجيل الدخول مش مفعّل لسه على السيرفر. راجع إعداد SESSION_SECRET.',
  server_error:    'حصل خطأ. جرّب تاني بعد لحظات.',
  rate_limited:    'محاولات كتير في وقت قصير. استنى شوية وجرّب تاني.',
  bad_credentials: 'الإيميل أو كلمة السر غير صحيحة.',
  email_taken:     'فيه حساب بالإيميل ده بالفعل. جرّب تسجّل الدخول.',
  weak_password:   'كلمة السر لازم تكون ٨ حروف على الأقل وفيها حرف ورقم.',
  bad_email:       'الإيميل ده شكله مش مظبوط.',
  bad_phone:       'اكتب رقم موبايل مصري صحيح، مثال 01012345678.',
  terms_required:  'لازم توافق على شروط الاستخدام وسياسة الخصوصية.',
  empty_cart:      'السلة فاضية.',
  bad_governorate: 'اختار المحافظة من القائمة.',
  short_address:   'اكتب العنوان بالتفصيل — الشارع والعمارة والدور.',
  missing_field:   'فيه خانة مطلوبة فاضية.',
  unknown_product: 'واحد من المنتجات مابقاش متاح. حدّث الصفحة.',
  bad_qty:         'الكمية لازم تكون رقم صحيح من ١ لـ ٩٩.',
  unauthenticated: 'لازم تسجّل الدخول الأول.',
  not_staff:       'تبويب الحضور لموظفي Vision Guard فقط.',
  not_admin:       'العرض ده لإدارة Vision Guard فقط.',
  bad_date:        'التاريخ لازم يكون بالشكل 2026-08-03.',
  already_in:      'إنت مسجّل حضور بالفعل.',
  not_in:          'إنت مش مسجّل حضور دلوقتي.',
  /* Changing your own password. Without these the server's English reaches
     an Arabic-first page at exactly the moment somebody is confused. */
  bad_current:     'كلمة السر الحالية مش صح.',
  same_password:   'دي نفس كلمة السر الحالية.',
  password_elsewhere: 'الحساب ده بيسجّل دخول عن طريق جوجل، فكلمة السر مش متخزنة هنا. استخدم «نسيت كلمة السر؟» في صفحة الدخول.',
  signin_again:    'لأسباب أمنية، سجّل خروج وادخل تاني قبل ما تغيّر كلمة السر.',
  bad_origin:      'الطلب اترفض لأسباب أمنية. حدّث الصفحة وجرّب تاني.',
  network:         'مافيش اتصال بالسيرفر. اتأكد من الإنترنت وجرّب تاني.',
  /* Firebase Auth. Its own messages are English and name the vendor
     ("Firebase: Error (auth/invalid-credential)"), which is no use to a
     customer on an Arabic page — firebase-auth.js maps its codes onto these. */
  auth_failed:         'تسجيل الدخول ما نجحش. جرّب تاني.',
  auth_not_enabled:    'خدمة الحسابات لسه مش مفعّلة على السيرفر. فعّل Authentication من Firebase console.',
  firebase_unavailable:'مش قادرين نحمّل خدمة الدخول. اتأكد من الإنترنت أو جرّب من غير مانع إعلانات.',
  no_firebase:         'تسجيل الدخول مش متظبط على السيرفر لسه. راجع إعداد FIREBASE_PROJECT_ID.',
  bad_firebase_token:  'جلسة الدخول مش صالحة. حدّث الصفحة وجرّب تاني.',
  firebase_expired:    'انتهت صلاحية الدخول. سجّل دخولك تاني.',
  email_unverified:    'أكّد إيميلك الأول من الرسالة اللي بعتناها لك، وبعدين سجّل الدخول.',
  account_disabled:    'الحساب ده متوقف. كلّمنا على واتساب.',
  popup_blocked:       'المتصفح منع نافذة جوجل. اسمح بالنوافذ المنبثقة وجرّب تاني.',
  provider_disabled:   'طريقة الدخول دي مش مفعّلة. كلّمنا على واتساب.',
  unauthorized_domain: 'الدومين ده مش مسموح له بالدخول عبر Firebase. راجع Authorized domains.',
  bad_google_token:  'الدخول بجوجل ما نجحش. جرّب تاني.',
  google_expired:    'انتهت صلاحية الدخول بجوجل. اضغط الزرار تاني.',
  google_unverified: 'حساب جوجل ده مافيهوش إيميل مؤكّد، فمش هينفع نستخدمه. سجّل بالإيميل وكلمة السر.',
  google_unavailable:'مش قادرين نوصل لجوجل دلوقتي. جرّب تاني أو سجّل بالإيميل.'
};

export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
  /* The message to actually show, in whichever language is on screen. */
  get display() {
    return LANG === 'ar' ? (ERRORS_AR[this.code] || this.message) : this.message;
  }
}

export async function api(path, options) {
  const opts = options || {};
  const init = {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {}
  };
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) {
      init.body = opts.body;
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError('network', 'Could not reach the server. Check your connection.');
  }

  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }

  if (!res.ok || data.ok === false) {
    throw new ApiError(
      data.code || 'server_error',
      data.message || `Request failed (${res.status}).`,
      {
        status: res.status,
        field: data.field,
        retryAfter: data.retryAfter,
        /* The whole body, for the handful of errors that carry something the
           caller can act on rather than just display.

           Named three fields were copied here originally, and anything else an
           endpoint attached to an ApiError was silently dropped on the way —
           which is how "that number already belongs to Mona" arrived without
           the lead id needed to offer a link to her. Passing the body under
           its own key rather than spreading it keeps `code` and `message`
           safe from a payload that happens to contain either. */
        details: data
      }
    );
  }
  return data;
}

/* -------------------------------------------------------------------------
   Chrome: nav shadow, burger menu, language button, footer year
   ------------------------------------------------------------------------- */
export function initChrome() {
  applyLang(LANG);
  applyTheme(THEME, false);

  const langBtn = $('#lang');
  if (langBtn) langBtn.addEventListener('click', () => applyLang(LANG === 'ar' ? 'en' : 'ar'));

  const themeBtn = $('#theme');
  if (themeBtn) themeBtn.addEventListener('click', () => applyTheme(THEME === 'light' ? 'dark' : 'light', true));

  const nav = $('#nav');
  if (nav) {
    let stuck = false;
    const onScroll = () => {
      const now = window.scrollY > 40;
      if (now !== stuck) { nav.classList.toggle('is-stuck', now); stuck = now; }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const burger = $('#burger');
  const menu = $('#menu');
  if (burger && menu) {
    menu.removeAttribute('hidden');
    menu.setAttribute('inert', '');
    const close = () => {
      if (!document.body.classList.contains('is-menu')) return;
      document.body.classList.remove('is-menu');
      burger.setAttribute('aria-expanded', 'false');
      menu.setAttribute('inert', '');
      root.style.overflow = '';
    };
    burger.addEventListener('click', () => {
      if (document.body.classList.contains('is-menu')) return close();
      document.body.classList.add('is-menu');
      burger.setAttribute('aria-expanded', 'true');
      menu.removeAttribute('inert');
      root.style.overflow = 'hidden';
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  initScrollBars();
}

/* =========================================================================
   THE STAFF HINT

   Whether the "Work" link is drawn in the nav. The link itself is built by
   worklink.js — a classic script, because the landing page's chrome is
   main.js and never calls initChrome(), so anything that must appear on
   EVERY page cannot live in this module. Same reasoning as consent.js and
   promo.js, and the same split: this half is the writer, that half is the
   reader.

   IT IS A HINT, NOT A PERMISSION. Forging it draws a link; it does not sign
   anyone in. Every endpoint behind the account page re-checks the session
   server-side — see lib/auth.js -> requireStaff / requireAdmin. The worst a
   stale flag can do is offer a link that lands on the sign-in form, which is
   also how it corrects itself.

   The alternative was asking /api/auth/me on every page load, for every
   visitor, almost all of whom are anonymous customers — a request on every
   page of a shop to decide whether to draw one link.
   ========================================================================= */
export const STAFF_HINT = 'vg-staff';

/* Called by account.js on sign-in and sign-out — the only code that knows. */
export function setStaffHint(on) {
  try {
    if (on) localStorage.setItem(STAFF_HINT, '1');
    else localStorage.removeItem(STAFF_HINT);
  } catch (e) { /* private mode: the link simply never appears */ }
}

/* -------------------------------------------------------------------------
   Visible scroll bars for the wide tables

   .tablewrap in app.css already carries a styled ::-webkit-scrollbar and a
   pair of edge shadows. That covers desktop and Android, and it is not
   enough: iOS Safari ignores ::-webkit-scrollbar on overlay scrollbars
   outright, so on an iPhone the admin tables scrolled with no bar at all and
   nothing to say the Edit and Hide buttons existed off the edge.

   So this draws one. A plain div track with a thumb whose width is the
   visible fraction and whose offset is the scroll progress — the same
   information a native bar carries, in an element every browser renders
   identically. It is aria-hidden and pointer-events:none: it reports, it is
   not a control, and the real scrolling is untouched.

   Direction-agnostic by construction. In RTL scrollLeft counts DOWN from 0 to
   -max, in LTR it counts up from 0 to +max; taking the absolute value gives
   the same 0..1 progress either way, and `inset-inline-start` puts the thumb
   at the correct visual edge without knowing which one that is.
   ------------------------------------------------------------------------- */
export function initScrollBars() {
  $$('.tablewrap').forEach((wrap) => {
    if (wrap.dataset.hscroll) return;      // already wired
    wrap.dataset.hscroll = '1';

    const bar = document.createElement('div');
    bar.className = 'hscroll';
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('i');
    bar.appendChild(thumb);
    wrap.insertAdjacentElement('afterend', bar);

    const sync = () => {
      const max = wrap.scrollWidth - wrap.clientWidth;
      /* A few pixels of slack: sub-pixel layout rounding can leave a 1px
         "overflow" on a table that visibly fits, and a bar for that is
         noise. */
      if (max <= 4) { bar.hidden = true; return; }
      bar.hidden = false;

      const track = bar.clientWidth;
      const w = Math.max(28, Math.round((wrap.clientWidth / wrap.scrollWidth) * track));
      const progress = Math.min(1, Math.abs(wrap.scrollLeft) / max);
      thumb.style.width = w + 'px';
      thumb.style.insetInlineStart = Math.round(progress * (track - w)) + 'px';
    };

    wrap.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync, { passive: true });

    /* The admin tables are re-rendered from JavaScript — a catalogue refresh,
       a new search — so the size changes long after this ran. Watching the
       table itself catches every one of those without each caller having to
       remember to tell us. */
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(sync);
      ro.observe(wrap);
      const inner = wrap.firstElementChild;
      if (inner) ro.observe(inner);
    }

    sync();
  });
}

/* -------------------------------------------------------------------------
   Toast — one at a time, replaced rather than stacked
   ------------------------------------------------------------------------- */
let toastEl, toastTimer;

export function toast(message, kind) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.remove('is-bad', 'is-good');
  if (kind) toastEl.classList.add(kind === 'bad' ? 'is-bad' : 'is-good');
  /* Force a reflow so a repeated message re-triggers the entry transition. */
  void toastEl.offsetWidth;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 4200);
}
