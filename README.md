# Vision Guard — site, shop and staff attendance

Three pages and a small API for the real Vision Guard catalogue. Bilingual
Arabic (RTL, default) / English (LTR), dark by default with a full light theme.

| | |
| --- | --- |
| `/` | The marketing page — scroll-scrubbed hero, categories, price list. |
| `/shop` | Filterable catalogue, cart, checkout. Orders land in the database and push a WhatsApp notification to the shop. |
| `/account` | Sign in / sign up with separate consent boxes, order history, preferences, an attendance tab for `@visionguardeg.com` addresses, and a team timesheet for administrators. |
| `/privacy` | The privacy policy, in both languages. Linked from every footer and from each consent box. |

**No build step and no front-end framework.** The pages are hand-written HTML,
CSS and ES modules. The back end is Cloudflare Pages Functions over a D1
database — same deploy, same repo, no separate server.

---

## The direction

**Editorial restraint over decoration.** One chromatic colour — the azure lifted
from the logo (`#1B9DD9`). Everything else is near-black, hairline greys and
white. The accent is rationed: primary buttons, active states, price figures,
the live dots, and the hero canvas. Nowhere else.

**A real dark-mode logo.** The supplied logo's "GUARD" wordmark is `#58595B`,
which lands around **1.9:1 contrast** on the near-black background — unreadable.
`assets/logo-dark.png` is the dark-mode variant: every greyscale pixel mapped to
white, every chromatic pixel left alone, alpha preserved so the antialiasing
stays clean. VISION keeps its exact azure; GUARD and the swoosh go white. The
split was done by saturation (`sat < 0.25` → white), which caught 13,756 grey
pixels and left 10,459 blue ones untouched.

**Light plates for catalogue photography only.** Every product shot is on a white
studio ground, so category images sit on a near-white plate (`--plate`) with
`mix-blend-mode: multiply`, which melts their white ground into the plate instead
of showing a hard rectangle. The logo does *not* use a plate.

**Typography does the work.** Cairo for Arabic, Inter for Latin, switched by
`html[lang]`. Arabic is never letter-spaced (it breaks the joining rhythm) and
gets looser leading — both handled in a dedicated block in the stylesheet.
Product model numbers stay in Inter even inside Arabic copy.

**Motion is physical, not ornamental.** Weighted scrolling, a scroll-scrubbed
hero, word-by-word headline reveals. Each one paces the reading rather than
calling attention to itself.

### The hero

Scrolling scrubs a canvas-rendered sensor field through the four layers listed
in the HUD — cameras, recorder, storage, phone. The field is already lit at
rest, so the page has presence before you touch it; scrolling deepens it rather
than switching it on. In Arabic the detection brackets mirror to the opposite
side so they never sit under the headline.

---

## Files

```
public/                     <- served verbatim. Everything here is public.
  index.html  shop.html  account.html  privacy.html
  styles.css  app.css
  main.js  site.js  shop.js  account.js  page.js
  catalog.js                <- products + prices. Imported by BOTH sides.
  _headers                  <- Cloudflare Pages security + caching rules
  assets/
functions/                  <- compiled into Pages Functions, served at /api/*
  api/
    catalog.js  orders.js  newsletter.js
    auth/       signup.js  login.js  logout.js  me.js
    account/    preferences.js
    attendance/ index.js   clock.js   team.js
lib/                        <- server-only helpers. NOT served.
  util.js  db.js  auth.js  orders.js  attendance.js  whatsapp.js
scripts/create-admin.mjs    <- creates the one administrator account
schema.sql                  <- D1 tables (also applied automatically)
brand/logo-original.png     <- pristine source, kept out of the deploy
wrangler.toml               <- Pages project config + D1 binding
.dev.vars.example           <- the environment variables, documented
```

| File | What it is |
| --- | --- |
| `public/index.html` | Marketing page. Arabic inline, English in `data-en`. |
| `public/shop.html` `shop.js` | Catalogue, cart, checkout, confirmation. |
| `public/account.html` `account.js` | Auth, orders, consent preferences, attendance, team timesheet. |
| `public/privacy.html` `page.js` | The privacy policy. `page.js` is the whole script for it — one line, because the CSP allows only the one hashed inline block every page shares. |
| `public/catalog.js` | **The prices.** One module, read by the browser *and* by the order endpoint. |
| `public/styles.css` | Tokens, both themes, layout, RTL, responsive, reduced-motion. |
| `public/app.css` | Shop and account surfaces only. The landing page never loads it. |
| `public/main.js` | Landing page: language, theme, smooth scroll, hero canvas, reveals. |
| `public/site.js` | Shared chrome for shop/account: language, theme, API client, toasts. |
| `lib/*.js` | Server-side only. Lives outside `functions/` so it is not routable. |
| `public/assets/logo-dark.png` | Dark-theme logo — white GUARD, azure VISION. |
| `public/assets/logo-trim.png` | Original colours. Light theme, favicon, `og:image`. |
| `brand/logo-original.png` | Exactly as downloaded, untouched. Not served. |
| `.claude/launch.json` | Local dev-server config. Gitignored, not deployed. |

**The site lives in `public/` on purpose.** Cloudflare Pages serves its output
directory verbatim, so a flat layout would publish `README.md` — including the
pricing notes below — at `https://yoursite/README.md`. Keeping the site in a
subdirectory means only the site ships, and it is why `lib/` is safe to keep at
the repo root.

**Why `lib/` is not inside `functions/`.** Every file under `functions/` becomes
a route. A helper placed there would be fetchable at its path. Shared server
code lives outside and is imported by relative path; Wrangler bundles it in.

**Runtime dependencies: none.** No npm packages ship. The only external request
the browser makes is Cairo + Inter from Google Fonts.

### About the logo file

`logo.png` came from your store's own CDN at 500×200. It has 81px of transparent
margin on each side and a 5px vertical divider bar at x=414–418 that is not
present in the version you sent. `logo-trim.png` is that file cropped to the
wordmark only (322×190) — padding and the stray bar removed, colours untouched.
`logo-dark.png` is `logo-trim.png` with the greyscale ink remapped to white for
the dark background.

The favicon and `og:image` deliberately stay on `logo-trim.png`: a white wordmark
would vanish against a light browser tab bar or a light social-card background.

If you have the original vector, drop in two SVGs (light and dark) and swap the
`<img src>` references — three for the dark variant, two in `<head>` for the
light one.

---

## Deploying to Cloudflare Pages

There is no build step. Pick one of the two routes below — but do the one
mandatory setup step first.

### Before the first deploy

1. **Set `SESSION_SECRET`** in **Workers & Pages → visionguard → Settings →
   Variables and Secrets**, as an encrypted secret. Nothing else is required to
   go live, but without this, sign-in and sign-up return a 503 telling you so.
   Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. **Optionally set a WhatsApp provider** so order alerts reach your phone. See
   *Orders on WhatsApp* below. Without it, orders are still taken and stored —
   you just have to read them with `npm run db:orders`.

The D1 database (`visionguardegdata`) is already created, bound in
`wrangler.toml`, and has its schema applied. If you deploy through the Pages
dashboard rather than Wrangler, confirm the D1 binding is attached to the
project under **Settings → Bindings**; the dashboard does not always inherit it
from `wrangler.toml`.

### Route A — Git integration (recommended)

The repo points at `github.com/Mahmoudnabil03/worldwidewebvisionai`. Push first:

```bash
git add -A && git commit -m "Add Vision Guard site and Cloudflare Pages config" && git push
```

Then set the build configuration in **Workers & Pages → your project → Settings →
Build**:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler pages deploy` |
| Build output directory | `public` |
| Root directory | `/` |

Every push to `main` publishes; every other branch gets a preview URL.

> **The deploy command matters.** The default is `npx wrangler deploy`, which is
> the *Workers* command. Running it against a Pages project fails with
> *"It looks like you've run a Workers-specific command in a Pages project."*
> It must be `wrangler pages **deploy**`. If your project has no "Deploy command"
> field at all, it is a classic Pages project — leave the build command empty and
> just set the output directory to `public`; Cloudflare uploads it directly and
> wrangler is never invoked.

> **`name` in `wrangler.toml` must match the project name.** `wrangler pages
> deploy` takes the target project from that field. If your Cloudflare project is
> not called `visionguard`, either change the `name` in `wrangler.toml` or use
> `npx wrangler pages deploy --project-name=<actual-name>` as the deploy command.
> A mismatch fails with "project not found".

### Route B — Direct upload from this machine

```bash
npm install
npx wrangler login
npm run deploy
```

`npm run deploy` runs `wrangler pages deploy`, which reads both the project name
and the output directory from `wrangler.toml` — no arguments to keep in sync.
Use `npm run deploy:preview` for a preview branch instead of production, and
`npm run dev` to serve locally *through Wrangler* — that is the only local server
that also applies `_headers`.

Wrangler is pinned to `^4.116.0`. The failing build installed `3.114.17` (from an
earlier `^3.90.0` range) and warned it was out of date; that warning is gone now.

### Custom domain

In the Pages project: **Custom domains → Set up a domain**. If `visionguardeg.com`
stays on the EasyOrders store, put this on a subdomain (`www`, `info`, or
`new`) so the storefront keeps working. Cloudflare issues the certificate
automatically.

---

## Headers

`public/_headers` sets caching and security. Two things to know before editing it:

**The CSP allow-lists the one inline script by hash.** `index.html` has a single
inline `<script>` in `<head>` that swaps `no-js` → `js`; it must run before paint,
so it cannot move to an external file without causing a flash of hidden content.
Its hash is pinned in the CSP:

```
'sha256-Kujm0/4azSdOPOSA6aaqqQwa4A5Ur08aglfQkpthXJo='
```

**If you change that script by even one character the hash breaks**, the script is
blocked, and the page loses every reveal animation *and* the pre-paint theme
application — silently, with content still visible. All three pages carry the
script byte for byte identically so they can share one hash; keep it that way.
Recompute with:

```bash
node -e "const c=require('crypto');const f=require('fs').readFileSync('public/index.html','utf8');const m=f.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/);console.log('sha256-'+c.createHash('sha256').update(m[1]).digest('base64'))"
```

The policy was verified against the real page: the inline script runs, Cairo and
Inter load from Google Fonts, the canvas paints, the grain `data:` URI resolves,
and the language toggle works — with zero console violations.

**Caching** is deliberately split: HTML revalidates on every request so redeploys
appear immediately; `styles.css` and `main.js` get one hour (they have unhashed
filenames, so they cannot be immutable); `assets/*` gets a year as `immutable`.
**If you change an image, change its filename** — otherwise visitors keep the old
one for up to a year.

---

## Local preview

```bash
npm install && npm run dev
```

That is `wrangler pages dev --port 5173`, and it is now the **only** local
server worth using: it serves the static files, compiles `functions/` so
`/api/*` works, applies `_headers` (so you are testing the real CSP), and
creates a local SQLite database under `.wrangler/` — production data is never
touched.

A plain static server (`python -m http.server`) will still render all three
pages, but every API call fails, so the cart cannot check out and nobody can
sign in.

> **Local caching gotcha.** `_headers` gives CSS and JS a one-hour
> `max-age`, and Wrangler honours it. After editing a stylesheet, a normal
> reload can serve you the old one. Hard-reload (Ctrl+Shift+R) or use
> DevTools → Network → *Disable cache*.

---

## Where the content came from

Everything was pulled from **visionguardeg.com** on 31 July 2026. Nothing on this
page is invented — the previous draft's statistics, street address and monitoring
claims have all been removed.

- **17 products** across 5 collections, with the discounted and pre-discount
  prices as listed.
- **Contact**: phone `01260087815`, WhatsApp `01105006854`, hours 12م–8م with
  Friday closed — taken from the announcement bar that appears on every page of
  the store. Facebook and Instagram from the footer.
- **Category descriptions** are condensed from your own collection pages.

Two notes on this:

1. **No email or street address exists anywhere on the live store**, so neither
   appears here. Send them and I will add them to the contact block and footer.
2. Your `robots.txt` carries Cloudflare's managed AI block list, which includes
   `ClaudeBot: Disallow: /` and `Content-Signal: ai-train=no`. I read the site at
   your explicit direction, as the owner, to move your own content — but if you
   want AI assistants to be able to read the store normally in future, that
   setting is in your Cloudflare dashboard.

### Amazon.eg price check — 31 July 2026

Searched amazon.eg for all 16 line items. **Only 5 had an exact model match.**
Those are updated (floored to the nearest 10, as asked); the rest keep their
visionguardeg.com prices, because substituting a different model's price would
put wrong figures in front of customers.

**Updated — exact model match on amazon.eg:**

| Product | Was | Amazon.eg | Now |
| --- | --- | --- | --- |
| Tapo C310 Wi-Fi Outdoor 3MP | 1,550 | 1,690.00 | **1,690** |
| Skyworth LC2308 Outdoor 3MP | 2,200 | 1,919.00 | **1,910** |
| Skyworth LC2103 Outdoor 4MP | 2,250 | 2,446.00 | **2,440** |
| Skyworth 64GB Surveillance microSD | 550 | 610.00 | **610** |
| Skyworth SKY-T128 128GB microSD | 800 | 960.00 | **960** |

Four of the five go *up*; LC2308 comes down by 290. Updated rows show a single
price — the old strike-through "before discount" figure was a store promotion and
does not apply to an Amazon-sourced price.

**Not updated — no exact match on amazon.eg:**

| Product | Why |
| --- | --- |
| Dahua XVR1B04-I-T | Only plain `DH-XVR1B04 value` (1,899) — different variant |
| Dahua XVR1B08-I-T | Only `XVR1B08-I` without the `-T` (2,999) |
| Dahua XVR5104HS-I3 | No listing at all |
| Dahua XVR5108HS-I3 | Only a third-party `OEM XVR5108H-I3` (3,349), different product |
| Dahua HAC-T5E20P ×2 | `T5E20P` returns zero results; only T1A21P / B1A21P exist |
| Dahua HAC-HDW1800RP | Zero results; nearest is HDW1200TRQ-A, a 2MP part |
| Seagate 500GB Surveillance | No SkyHawk under 8TB; the cheap 500GB hit is a refurbished desktop drive |
| WD Purple 1TB | Only `WD10PURX` at 2,750 — an older revision than `WD10PURZ`, and **+53% over your price** |
| Power supplies ×2 | Generic unbranded parts; amazon.eg spans 199–1,417 for the same rating |

**Worth thinking about before pushing these live:** these are competitor retail
prices, not your cost. Amazon.eg runs a visible markup on surveillance hardware —
the WD Purple gap above is the clearest example. Matching Amazon raises four of
your five verified prices, which may not be what you want commercially.

### Other things to check before launch

- The list is stamped "آخر تحديث للأسعار ٣١ يوليو ٢٠٢٦" in the markup — update
  that line whenever you refresh the figures.
- **Storage and Power Supply** spec lines are minimal; I never reached those
  individual product pages.
- Product rows are **not** individually linked — only three product URLs were
  discoverable, and guessing the other fourteen slugs would have produced broken
  links. Every category card and footer link points at a verified collection URL.

---

## Bilingual system

Arabic is the source of truth in the markup; English lives in `data-en`:

```html
<h2 data-en="Current stock and prices.">المتوفر حاليًا وأسعاره.</h2>
```

On load, `main.js` copies each element's Arabic `innerHTML` into `data-ar`, so
there is no separate dictionary to drift out of sync — **edit the HTML and both
languages stay correct**. The toggle swaps `innerHTML`, flips `lang` and `dir`,
switches the font stack, rebuilds the split-text spans, and persists the choice
to `localStorage`. Modules that own their own strings (the sticky note in "How to
order") listen for the `langchange` event.

To add a translatable string, just add `data-en`. To change the default language,
change the `lang`/`dir` on `<html>` and the fallback in `applyLang`.

---

## Why no GSAP or Lenis

The original brief referenced both. The behaviour is implemented directly:

- **No render-blocking CDN.** ~70 KB gzipped and a third-party point of failure
  on a page whose job is signalling reliability.
- **One rAF loop.** Every scroll-linked effect subscribes to a single scheduler
  (`onFrame`) and returns `true` only while it still needs frames. When they all
  return `false` the loop *stops completely* — no idle battery cost.
- **Composited properties only.** Animations touch `transform` and `opacity`. The
  hero canvas is the only per-frame paint, and it runs only while on screen.

Smooth scrolling lerps the *real* scroll position rather than translating a
wrapper, so `position: sticky`, anchors, the scrollbar and find-in-page keep
working. It is off on touch and coarse pointers, where hijacking native momentum
always feels worse. `onFrame` is the only seam to replace if you later want the
libraries.

---

## Customising

### Accent colour

One line drives hairlines, glows, buttons, price figures *and* the canvas hero,
which reads the value back out of CSS at runtime:

```css
:root { --accent-rgb: 27, 157, 217; }   /* #1B9DD9 */
```

### The light plate

```css
:root { --plate: #F4F6F8; }
```

Used by the logo badge, the boot curtain and every category image.

### Animation feel

| What | Where | Default |
| --- | --- | --- |
| Scroll weight | `main.js` → `smooth.current += diff * .105` | lower = heavier |
| **Hero scrub length** | `styles.css` → `.hero__track { height }` | **`185vh`** (was `340vh`) |
| Word reveal stagger | `main.js` → `splitWords` | `38ms` |
| Word reveal duration | `styles.css` → `.js [data-split] .wi` | `.72s` |
| Boot curtain | `styles.css` → `.boot` animation delay | out at `.52s` |
| Hero copy entrance | `main.js` → `introDelay` | `560ms` |

**On the hero scrub.** The canvas choreography is normalised to 0–1 across the
track, so the track height is the only speed control — every beat (power-on,
scan pass, detection locks, the link to the phone, the frame) compresses
proportionally. It was `340vh`, which meant roughly 2,000px of scrolling before
the page moved on; it is now `185vh` (~730px on a 860px-tall window), a 65% cut.
The responsive and reduced-motion overrides at the bottom of the stylesheet
(`165vh`, `150vh`, `110vh`) must be changed with it or narrow screens will keep
the old pacing.

### Theme

Dark is the default. The light palette is a full second set of tokens in
`styles.css` under `:root[data-theme="light"]` — not a filter — and the accent
hex is identical in both, so the brand colour never shifts. Translucent
overlays are written against `--bg-rgb` / `--ink-rgb` so they flip with the
theme; **if you add a hard-coded `rgba(255,255,255,…)` or `rgba(8,9,11,…)`
anywhere, it will be wrong in one of the two themes.**

The logo swaps with the theme: `logo-dark.png` (white GUARD) on dark,
`logo-trim.png` — the original artwork with the brand's own `#58595B` grey
GUARD — on light. That grey is the whole reason the dark variant exists: it
lands at about 1.9:1 on near-black, and about 6.4:1 on the light background.
The swap is done in JS because it is an `<img src>`, not a background.

The choice persists in `localStorage` and is re-applied by the inline `<head>`
script *before first paint*, so there is no flash of the other theme. The hero
canvas re-reads `--canvas-ink-rgb` on `themechange` — a near-white dot field
would be invisible on a light page.

---

## Accessibility & resilience

- Skip link, focus rings, `aria-expanded` on the menu toggle, `inert` on the
  closed overlay, `lang`/`dir` kept correct in both languages.
- `prefers-reduced-motion` fully honoured: boot curtain removed, hero scrub cut to
  `110vh`, every reveal rendered in its final state.
- Reveals use IntersectionObserver **plus a scroll-idle rescue sweep**. IO never
  fires for content the viewport jumps clean over — a hash landing, browser scroll
  restoration, a hard flick — and without the sweep that content would stay
  invisible permanently. Verified: jumping straight to the footer leaves 0 of 28
  elements stuck.
- The hero canvas derives its visibility from the rect it already measures for
  scroll progress rather than an observer, so there is no observer lifecycle that
  can strand it frozen.
- With JavaScript off, all content renders (reveal styles are scoped to a `.js`
  class) and the page stays Arabic — only motion and the language toggle are lost.

---

## The shop

`/shop` is a normal online shop: filter, search, sort, add to cart, check out.
The cart lives in `localStorage` as `{id, qty}` pairs and survives a reload; a
second tab editing it is picked up through the `storage` event rather than being
silently overwritten.

**Prices are never taken from the browser.** The cart sent at checkout is a list
of ids and quantities. `POST /api/orders` re-prices every line from
`public/catalog.js` — the same module the shop page renders from — and computes
the total itself. Editing `localStorage`, or the request body, changes nothing
about what an order costs. This is verified: a request carrying
`{"id":"xvr5108hs-i3","qty":1,"price":1}` is stored at 3,800.

Also enforced server-side: unknown product ids are rejected, quantities are
whole numbers from 1 to 99, the governorate must be one of the 27 in the list,
the address must be substantial, the terms box must be ticked, and cross-origin
POSTs are refused outright.

**To change a price, edit `public/catalog.js`.** That is the whole change —
there is no second list. The landing page's static price table in `index.html`
is separate and still hand-maintained; keep the two in step.

### The welcome discount

**Two tiers: `WELCOME10` — 10% off — on the customer's first day, then
`WELCOME5` at 5% for the remaining four.** Nothing on the sixth. The steeper
number is there for the hour somebody is actually deciding; the gentler one
keeps the week worth coming back for. Both are shared codes, not per-account
generated ones: the code is not the control, `orders` is. Eligibility is
checked against three identities — the account, the **phone number**, and the
email — and any of them having ordered before disqualifies. That is what stops
"sign up again with a fresh email", which is otherwise free.

**Which tier applies is read off the account, never off the code that was
typed.** Somebody entering `WELCOME10` on their third day is given the 5% they
are entitled to rather than an error: the code is how they ask, the tier is
the answer. Editing `WELCOME_TIERS` at the top of `lib/coupon.js` is the whole
change — the window, the copy and the popup all derive from it.

Two rules decide it, both in `lib/coupon.js`:

1. **Never ordered before.** Cancelled orders do not count as having ordered —
   only an administrator can cancel, so this cannot be self-served into a loop.
2. **Within the tier's window of `users.created_at`.** Measured in hours from
   the signup, not in calendar days, so "you have today" is true of somebody
   who joined at breakfast and somebody who joined at eleven at night alike. A
   date the code cannot parse fails *closed*: better a discount somebody has to
   ask about than one that never expires.

**A popup announces it once**, right after an account is created — never on
sign-in — and it is dismissible by button, backdrop or Escape. Its numbers come
from `/api/coupon` rather than from constants in the page, so the popup, the
checkout and the order cannot quote three different offers; if that call fails
the popup does not appear at all, and the discount still applies, because it is
applied from the account rather than from having read a dialog.

### Promo codes the owner issues

**Work › Promos**, administrators only. Two different jobs on one screen:

- **A code** — `RAMADAN20`, 20% or a flat amount, with a start, an end, a
  maximum number of uses, a minimum basket, and a *new sign-ups only* switch.
  For people you have not met. Codes get forwarded within the hour, so what
  protects the shop is not secrecy but those limits, every one of them enforced
  server-side in `lib/promos.js` against the `promos` table.
- **A discount on one existing order** — for the customer on the phone right
  now. No code to invent, publish, expire, or explain to whoever finds it
  later. The total is recomputed from the order's own subtotal, so applying it
  twice *replaces* rather than stacks.

`resolveDiscount()` in `lib/promos.js` is the single entry point for both kinds
of code and the welcome offer, used by `/api/coupon` to draw the cart line and
by `/api/orders` to decide what is charged — so the two can never disagree. An
**empty** code is not an error there: it means "whatever this person is
entitled to", which is how a customer who types nothing still gets their
welcome discount.

Two guards worth knowing: `WELCOME10`/`WELCOME5` are refused as code names
(they are decided by the account's age, so a stored row by that name would
silently never apply), and a code that has been used on real orders cannot be
deleted — only switched off, because deleting it would leave those orders with
a total that disagrees with their subtotal and nothing explaining why.

It requires being signed in — a guest checkout has no identity to have used it
before — and `/api/coupon` answers `canSignInFor` so the cart can say
"sign in and save 5%" to the one group that would benefit, and say nothing to
the returning customer who cannot.

**The cart's answer is advisory.** `/api/coupon` exists so the summary can show
a line before checkout; `POST /api/orders` runs the same `evaluateCoupon()`
again, against the same table, with a subtotal it built itself — and what that
returns is what is charged. A coupon that lapsed between opening the cart and
pressing the button is refused **silently**: the customer gets their order at
the honest price, and the confirmation states what was actually charged.

Orders already placed keep the code they were sold under in
`orders.discount_code`, so the history stays readable whatever the offer
becomes later.

### Payment

**Cash on delivery is gone. Transfer is the only method left** — InstaPay or
an e-wallet. An order is placed *unpaid*, the customer is taken to the shop's
own WhatsApp, the transfer details are sent there, and the purchase completes
when the money arrives. `PAYMENTS` in `lib/orders.js` is therefore a one-entry
list (`transfer`); `cod` keeps its label alongside it so the hundreds of rows
already in D1 still read correctly in the back office. A browser posting the
withdrawn method — a cached copy of the old checkout — is normalised to the
surviving one rather than rejected.

No code was invented for "pays on WhatsApp": WhatsApp is where the
conversation happens, not a way of paying, and naming the channel instead of
the instrument would make the `payment` column answer a question nobody asks
of it.

**No card details are collected anywhere on this site** and no payment
processor is integrated. Nothing here talks to a bank, which is why the paid /
not-paid state below is a person's judgement rather than a webhook.

**Two states per order, not one.** `status` is where the parcel is — `new`,
`confirmed`, `shipped`, `done`, `cancelled`. `payment_status` is where the
money is:

| `payment_status` | Means |
| --- | --- |
| `pending` | placed, not paid for yet. Every order starts here. |
| `paid` | somebody checked and the money arrived. |
| `failed` | the transfer was attempted and did not land, or the customer went quiet — a thing that happened, not merely waiting. |

They are separate columns because the money now moves *before* the parcel
rather than with the courier at the end of it; folding them together means
inventing "confirmed but unpaid" and "shipped and paid" by hand.

**Employees and administrators can both set either state.** An employee does
it from the leads board (`POST /api/leads`, actions `confirm` and `payment`),
an administrator from the orders table (`POST /api/admin/manage`, actions
`status` and `payment`). Cancelling and deleting an order remain
administrator-only, as they were. Every payment change writes a line into the
lead's timeline naming who recorded it.

Shipping shows as *quoted per governorate at confirmation* rather than a made-up
flat rate, because the store publishes no shipping table. If you want a fixed
fee, set `SHIPPING_FLAT` to a whole number of pounds and it is applied and shown
everywhere automatically.

### What the customer sees

A **pending-order screen**: the order number (`VG-260731-K3QX`, drawn from an
alphabet with no `0`/`O` or `1`/`I` because these get read down a phone line),
the words *pending payment*, the amount owed, and one button — **Contact us on
WhatsApp to pay**. The order also appears in their account if they were signed
in, still carrying its payment state and the same button for as long as it is
owed.

**The page does not navigate itself.** An earlier version jumped to WhatsApp a
beat after the confirmation rendered, which undoes the screen's purpose:
somebody thrown out of a confirmation before reading it cannot tell whether
their order was taken. The button opens WhatsApp in a new tab, so the pending
order is still on screen behind it — and still there tomorrow.

The link is `payUrl` on the API's answer, built server-side, and it carries a
short message written as the *customer* speaking: the order number and the
amount, and nothing else. Their address, second number, email and notes are
deliberately absent — that message opens on their screen, in a queue, where
somebody else can read it.

**Which number the button points at is not `WHATSAPP_TO`.** That variable is
where the shop's own order alerts go, and it is routinely somebody's personal
phone; if the customer-facing link inherited it, every buyer would be messaging
that phone. `contactWa()` resolves the *published* number instead — the one in
the strip, the menu, both footers and the assistant's answers — and falls back
to it rather than to the alerts destination. Move it with `PUBLIC_WHATSAPP`,
and only to a number the shop is happy to publish.

**The back-office alert is still not the customer's.** The WhatsApp
notification described below goes to the shop; it is never shown or offered to
the customer, and its body — which contains their full details and the internal
summary — is not returned to the browser at all.

---

## Order alerts (back office)

When an order is written, a summary is pushed to the shop — by default to a
Telegram bot, with the WhatsApp providers still supported. It is Arabic-first
and ordered so the top two lines are what you need on a lock screen: what it
is, and its number.

**It cannot delay or break an order.** The sequence is validate → re-price →
write to D1 → respond to the customer → *then* notify, via `waitUntil`. A dead
token, an expired 24-hour window or a provider outage costs you the alert, not
the order. The outcome is recorded on the order row (`notified`, `notify_error`)
so failures are visible instead of silent.

Five providers are supported; the first one whose credentials you set wins, or
force one with `NOTIFY_PROVIDER`. All of them are optional.

| Provider | Set | Notes |
| --- | --- | --- |
| `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | **Recommended, and it wins over the rest when its token is set.** Free, official, no template approval and no sending window — the whole multi-line Arabic summary arrives as written. |
| `meta` | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | Official Cloud API, free tier. Business-initiated messages outside a 24-hour window **must** use an approved template — set `WHATSAPP_TEMPLATE` to a template whose body is a single `{{1}}`. |
| `ultramsg` | `ULTRAMSG_INSTANCE`, `ULTRAMSG_TOKEN` | Bridges a normal WhatsApp account. No template approval, no 24-hour rule. Paid, and not Meta-sanctioned. |
| `twilio` | `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Same template rules as Meta. |
| `callmebot` | `CALLMEBOT_KEY` | Free, one recipient, plain text. Fine for "ping my phone". |

**With none of them set, orders are still taken and stored** — you just have to
read them out of the database (`npm run db:orders`) instead of getting a push.
Set one before launch, or you will not know an order arrived.

### Setting up the Telegram bot

1. Message **@BotFather**, send `/newbot`, and copy the token it hands back —
   it looks like `8961198092:AA…`.
2. Open your new bot and **send it any message**. A bot cannot start a
   conversation with you, so without this it has nowhere to post. For a group
   or channel, add the bot to it instead.
3. Read the chat id:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   Take `result[].message.chat.id` — your own user id for a direct message, a
   negative id like `-1001234567890` for a group.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as **encrypted secrets**
   (Workers & Pages → visionguard → Settings → Variables and Secrets), or in
   `.dev.vars` locally.

Leaving `TELEGRAM_CHAT_ID` unset still works — `lib/whatsapp.js` falls back to
the most recent chat in `getUpdates`. That is a convenience, not the intended
setup: `getUpdates` only reaches back 24 hours and returns nothing at all once
a webhook is registered on the bot.

The token is a credential — anyone who has it controls the bot. Keep it out of
`wrangler.toml` and out of commits, and `/revoke` it in @BotFather if it leaks.

---

## Accounts, consent and the mailing list

`/account` has sign-in and sign-up. Guest checkout stays fully available —
requiring registration to buy loses orders.

Sign-up has **three separate boxes**, and the separation is the point:

1. **Terms of use + privacy policy** — required. Without it, no account.
2. **Newsletter** — optional. Email only.
3. **Marketing on WhatsApp / SMS** — optional, and separate again.

Bundling marketing into the terms checkbox would make the consent worthless, so
they are never combined. Both optional consents are editable from *Preferences*
at any time, and **unticking the newsletter box stamps `unsub_at` on the mailing
list row** rather than only flipping a flag on the account — withdrawal has to be
as easy as consent was. `/api/newsletter` also exists for a bare subscribe, and
answers identically whether or not the address was already on the list, so it
cannot be used to test who is subscribed.

Export the list with `npm run db:newsletter`.

### Meta Pixel events

Pixel **visionguardeg**, id `2037293923502315`. `public/pixel.js` loads it and
fires PageView; `public/track.js` owns everything else and is the only place
the event vocabulary lives.

**None of it runs without consent.** `public/consent.js` is the switch, and it
must load before `pixel.js` on every page — both are `defer`, so document order
is execution order, and `pixel.js` refuses to load at all if `window.vgConsent`
is not there yet. Which regime a visitor gets is decided per visitor by
`GET /api/geo` from Cloudflare's `cf-ipcountry`:

| Regime | Where | Behaviour |
| --- | --- | --- |
| `optin` | EU, EEA, UK, Switzerland, and unknown/Tor | `fbevents.js` is not requested until **Accept**. Reject means no pixel, no `/api/capi`, and no server-side Purchase relay. |
| `notice` | everywhere else, Egypt included | The pixel runs as it always has. The bar explains it and offers the same off switch. |

Three consequences worth knowing before you debug a "missing" event:

- **Returning visitors cost nothing.** A stored decision is applied from
  `localStorage` synchronously, so there is no bar and no `/api/geo` call. The
  lookup happens on a first visit only, and is cached in `sessionStorage` for
  the rest of the session.
- **The server-side Purchase relay is gated too.** `public/shop.js` sends
  `adConsent` with the order and `functions/api/orders.js` skips
  `sendMetaPurchaseEvent` unless it is `true`. A missing field counts as *no* —
  that path does not go through the browser, so nothing the browser blocks
  could otherwise stop it, and Reject would be a lie.
- **The `<noscript>` beacons are gone.** They fired a tracking request from the
  markup, ahead of any consent, for visitors who by definition could not be
  shown a bar. The Conversions API already covers the visitors the browser
  pixel misses.

"Cookie settings" in every footer reopens the choice — anything with
`data-consent="open"` does, delegated. Withdrawing also clears `_fbp` and
`_fbc`. Section 6 of `public/privacy.html` describes all of this to the
customer and is anchored at `#cookies`; keep the two in step.

**No vendor names in customer-facing copy — this is deliberate, do not "fix"
it.** The bar and the privacy policy say *"we measure how well our ads work"*
and never say Meta, Facebook, Instagram, "pixel", `_fbp`, or SHA-256. Naming
the plumbing on a shopfront tells a customer nothing they can act on and reads
as something to be suspicious of, which is the opposite of what a consent
notice is for. It costs nothing legally either: GDPR Art. 13(1)(e) asks for
the recipients **"or categories of recipients"**, so *"advertising and
measurement providers — the social platforms we advertise on"* is a complete
disclosure on its own. The vendor is named only where it has to be — in the
code, in `wrangler.toml`, and in this file.

| Event | Fires when | Carries |
| --- | --- | --- |
| `PageView` | every page | — |
| `ViewContent` | a category listing is opened, including via `?cat=` from the landing page | `content_category`, the ids in that category |
| `Search` | catalogue search, debounced, 3+ characters, once per distinct term | `search_string` |
| `AddToCart` | a unit is added, by button or by the `+` stepper | product id, quantity, price, value |
| `InitiateCheckout` | the checkout view opens, from either entry point | full cart contents, `num_items`, value |
| `AddPaymentInfo` | the customer leaves for WhatsApp to pay, from the confirmation screen | method (`transfer`), order lines, value |
| `Purchase` | the order is confirmed | contents, value, **`eventID` = order number** |
| `CompleteRegistration` | an account is actually created (not on sign-in) | method (`email` / `google`) |
| `Lead` | someone opts into the mailing list, at checkout or sign-up | source |
| `Contact` | a phone, WhatsApp or email link is used, once per type per page | which kind |

**Purchase is deduplicated, and it was not before.** The event is sent twice
on purpose — from the browser, and from the server through the Conversions
API, because the server copy survives ad blockers and Safari. Meta collapses
the pair into one conversion **only when both carry the same `event_id`**, and
neither copy had one: every order was counted as two purchases at twice the
revenue, with nothing anywhere reporting it, because both events are
individually valid. Both now send the order number.

**Nine standard events are deliberately absent.** There is no wishlist,
nothing to donate to, no appointments, no free trial, no paid subscription, no
application to submit, no product configurator and no branch finder — so
`AddToWishlist`, `Donate`, `Schedule`, `StartTrial`, `Subscribe`,
`SubmitApplication`, `CustomizeProduct` and `FindLocation` would all be
fiction. Firing events that do not correspond to something a customer really
did trains ad delivery on noise and makes the funnel in Ads Manager lie.

Two mappings worth knowing, because neither is literal:

- **`ViewContent` is a category, not a product.** This shop has no per-product
  page, and firing one event per card as it scrolls past would bury the real
  signal. `content_type` is `product_group` so the shape does not claim
  otherwise.
- **`AddPaymentInfo` is the customer leaving to send the transfer.** It used
  to mean "picked one of two radios"; there is one method now, so it fires on
  the jump to WhatsApp instead — a later and rarer moment, and a truer one. No
  card details are entered on this site at all; the event marks the same
  funnel step.

The pixel now also loads on `/account`, which it did not before, so
`CompleteRegistration` has somewhere to fire. The privacy policy lists every
event by name.

### Sign-in: Firebase Auth holds the credential, D1 holds the person

Firebase Auth is the credential authority — the password, the reset email, the
Google provider, and the rate limiting on all three. It is **not** the source
of truth for who you are to this shop: the role, the staff flag, the consents,
the orders and the attendance record all live in D1 keyed by `users.id`, and
none of them means anything to Firebase.

The join is one endpoint. The browser signs in with Firebase, gets an ID
token, and posts it to `/api/auth/firebase`, which verifies the signature
server-side and mints this site's own session cookie. Everything downstream —
orders, preferences, attendance, the team timesheet — reads that cookie
exactly as before and never learns Firebase was involved.

**The check that matters** is the audience. Anyone can create a Firebase
project and mint a token claiming any email address; `lib/firebase.js` rejects
any token whose `aud` is not this project. Leave that check out and the whole
thing is decorative.

**The linking rules** in `functions/api/auth/firebase.js` are the rest of the
security, and the middle one is the one to understand:

| Situation | What happens |
| --- | --- |
| Known `firebase_uid` | That account. The uid is stable; an email address is not, so the uid is the key. |
| New uid, address matches an existing row, **verified** | Linked. They demonstrably control the mailbox. |
| New uid, address matches an existing row, **unverified** | **Refused (403).** Firebase does not verify an address at password sign-up, so without this anyone could register `admin@visionguardeg.com` in Firebase and inherit the administrator row. |
| New uid, new address | A new customer account, with whatever consent the form collected. |

Administrator addresses can never *create* a row this way, exactly as they
cannot through the old signup form.

`/api/auth/signup` is **closed** (410) — it wrote a `pw_hash` Firebase knows
nothing about, so every account it made would be one the sign-in form could no
longer sign into. `/api/auth/login` is deliberately **still live** as
break-glass: it is the only way into the timesheet before the admin exists in
Firebase, and the way back in if Firebase is unreachable. `/api/auth/google`
(the older Google Identity Services path) still works and is no longer called.

#### Turning it on — console steps, none of them optional

Creating a Firebase project does not enable Authentication. Until you do this,
every sign-in fails with `CONFIGURATION_NOT_FOUND`, which the UI reports as
*"خدمة الحسابات لسه مش مفعّلة"*.

1. **Firebase console → Authentication → Get started.**
2. **Sign-in method → Email/Password → Enable.**
3. **Sign-in method → Google → Enable**, and set a support email.
4. **Settings → Authorized domains**, add: `visionguardeg.com`,
   `www.visionguardeg.com`, and `visionguard-3dx.pages.dev`. Missing these
   breaks the Google popup only, with `auth/unauthorized-domain`.
5. **Users → Add user** — create `admin@visionguardeg.com`. The console cannot
   mark an address verified, and rule 2 above will refuse to link an
   unverified one, so then use **"نسيت كلمة السر؟"** on the sign-in form and
   complete the reset: finishing a password reset is what marks the address
   verified in Firebase, and the next sign-in links it to the admin row.
   Until that is done, sign in with the break-glass password route instead.

The web config in `public/firebase-auth.js` is public by design — an API key
there identifies the project, it does not authorise anything. The project id
is duplicated in `lib/firebase.js` as a default for the same reason
`WHATSAPP_TEMPLATE` has one: `wrangler.toml [vars]` have not reliably reached
this project's runtime, and an empty audience would mean no sign-in at all.
Change one, change both.

### The privacy policy

`public/privacy.html` is a real page on this site, in both languages, linked
from every footer and from the consent box on both the signup form and
checkout. It used to point at `visionguardeg.com/pages/privacy-policy`, a path
this deployment does not serve.

It is written against what the code actually does, which is the only way a
policy stays true: the fields each form collects, the session cookie and the
local storage, the Meta pixel and the server-side purchase events, the order
alert pushed to internal messaging, and the attendance records kept for staff.

On marketing specifically — the part most likely to be read — it separates
**service messages** (order confirmations, delivery updates, notices about the
account: part of the contract, sent regardless of any tick box) from
**marketing and product updates** (newsletter, offers, new arrivals, and
similar-product email to people who have bought before), which are consented
to and carry an unsubscribe in every message. WhatsApp/SMS marketing is a
third, separate consent. That mirrors the three-box split the signup form
already implements.

Two things to finish, neither of them code:

- **`privacy@visionguardeg.com` must exist** — the policy names it as the
  address for access, correction and deletion requests. Point it at a mailbox
  someone reads, or change it to the WhatsApp number.
- **Have a lawyer read it.** It is a factual, plain-language description of
  this system, not legal advice, and Egypt's PDPL has specific requirements
  (including how consent is recorded) that are a matter for counsel.

The links to the terms of use and the refund and shipping policies still point
at `visionguardeg.com/pages/...`. Those pages were out of scope here; if that
path does not serve them, they need the same treatment.

### How the passwords are stored

PBKDF2-SHA256, per-user salt, iteration count stored inside each hash string,
plus a **server-side pepper**: the password is HMAC'd with `SESSION_SECRET`
before the KDF runs. A stolen `users` table is not attackable offline without
also stealing the secret, which lives in the platform and is never written to
the database.

The default is 25,000 iterations rather than OWASP's 210,000 for one concrete
reason: Pages Functions on the Cloudflare **Free** plan get 10 ms of CPU per
request, and 210k blows straight through it — logins would fail outright, not
just slowly. On the Workers **Paid** plan set `PBKDF2_ITERATIONS=210000`;
existing hashes keep verifying, because each one records the count it was made
with.

Sessions are stateless HMAC-signed cookies (HttpOnly, SameSite=Lax, 30 days) —
no session table, no cleanup job. The trade-off: signing out clears the cookie
on that device only. Rotate `SESSION_SECRET` to invalidate every session
everywhere — but note that also invalidates every stored password hash, so set
it once and leave it alone.

---

## Attendance

The tab appears in `/account` when the signed-in address ends in
`@visionguardeg.com`. **Hiding the tab is presentation, not access control** —
every attendance endpoint re-checks the domain server-side, so an ordinary
customer calling the API directly gets a 403.

- **The contracted day is 6 hours**, set by `WORK_DAY_HOURS`. Every target,
  status and balance is derived from that one number.
- **Times come from the server clock**, never the browser. A device with a wrong
  clock — or one set wrong deliberately — cannot change a shift length. The
  on-screen timer counts locally between actions purely for display, and is
  re-synced from the server on every clock action.
- **Days are Cairo days**, resolved through `Intl` so Egypt's DST is handled per
  instant rather than hard-coded. A shift belongs to the day it *started*, so
  23:00 → 01:00 counts against the day it began.
- **A day can hold several shifts.** A break is a clock-out and a clock-in, and
  the day's total is the sum.
- **A double clock-in is impossible at the storage layer**, not just in the
  handler: a partial unique index (`WHERE clock_out IS NULL`) permits at most one
  open shift per person, so a double-tap or a racing second tab cannot create
  two.
- **A forgotten clock-out is closed automatically** after 16 hours, at exactly
  the contracted day length, and the row is labelled `auto-closed: no clock-out
  recorded` — visible in the table. An estimate that announces itself, rather
  than a silent invention.

Statuses are `complete` / `short` / `overtime` against the 6-hour target with a
five-minute grace either side, plus `open` while a shift is running and `absent`
for a day with nothing recorded. A day with a recorded shift is never `absent`,
even if it rounds to zero — the two must not look the same on a timesheet.

Read the raw records with `npm run db:attendance`, and the staff list with
`npm run db:staff`.

### The Team tab — did everyone do their six hours

An **administrator** sees one more tab: every account on the company domain,
for one Cairo day, ordered so the rows that need action come first (absent,
then short, then still-clocked-in). Above the table is the one-line answer —
*everyone completed their day*, or *some days need a look* — and behind it a
rolling range (1–31 days) with each person's total, expected, balance and
count of short days.

"Everyone completed their day" means exactly that: nobody absent, nobody
short, and nobody still clocked in. An open shift is not a finished day,
however long it has been running.

Forgotten clock-outs are closed before the sheet is read, so one person who
never clocked out cannot make every total behind them nonsense.

**The view is read-only.** Editing an employment record from a browser tab is
not something this grants, and the API has no write path for it.

### Creating the administrator

An admin can read every employee's timesheet, so the account is not creatable
from the internet: `/api/auth/signup` refuses the administrator addresses
outright, and there is no bootstrap URL to find. It is created by a script,
run by someone who already holds the deployment's credentials:

On macOS/Linux (bash, zsh):

```bash
SESSION_SECRET="the-real-secret" npm run admin:create -- --password "a-password"
```

On Windows (PowerShell) — there is no `VAR=value command` prefix, so it is two
statements:

```powershell
$env:SESSION_SECRET = "the-real-secret"
```

```powershell
npm run admin:create -- --password "a-password"
```

`the-real-secret` is the literal value of `SESSION_SECRET` from **Workers &
Pages → visionguard → Settings → Variables and Secrets**, not a placeholder to
leave in place.

That creates **admin@visionguardeg.com** with the password you pass, `role`
set to `admin`. Add `--local` to write to the local D1 instead, `--email`
for a different address, or `--print` to see the SQL without running it.

`SESSION_SECRET` is not optional and it must be the **same value the
deployment uses** — passwords are peppered with it before PBKDF2 (see
`lib/auth.js`), so a hash built with a different secret produces an account
that looks fine in the database and can never be signed into. The script reads
it from the environment first, then from `.dev.vars`.

Re-running resets that account's password and re-asserts the role. Nothing
else about the row is touched.

Who counts as an admin: `role = 'admin'`, **or** an address listed in
`ADMIN_EMAILS` (default: the one address above). The second is a deliberate
way back in — a restored database with a wrong role column would otherwise
lock the company out of its own timesheets with no route back through the UI.

---

## Database

Cloudflare D1, bound as `DB`.

| Name | `visionguardegdata` |
| --- | --- |
| ID | `b538d110-35d6-43bd-b821-233c26e173bd` |

Both are already in `wrangler.toml`, and the schema has been applied. `lib/db.js`
also applies the same `CREATE TABLE IF NOT EXISTS` statements once per isolate,
so a fresh or replaced database heals itself on first request rather than
failing until someone remembers a migration.

Tables: `users`, `orders`, `attendance`, `newsletter`, `rate`. Money is stored as
whole Egyptian pounds in `INTEGER` columns — the catalogue has no piastres, and
integers cannot drift the way floats do.

```bash
npm run db:orders        # last 20 orders, with WhatsApp delivery status
npm run db:attendance    # last 50 shifts, with employee names
npm run db:newsletter    # the mailing list
npm run db:init          # re-apply schema.sql (idempotent)
```

`wrangler pages dev` ignores the ID and uses a local SQLite file under
`.wrangler/`, so **local development can never touch production data.**

---

## Environment variables

Set these under **Workers & Pages → visionguard → Settings → Variables and
Secrets**, as *encrypted secrets* — not plaintext variables. Locally they go in
`.dev.vars`, which is gitignored. `.dev.vars.example` documents every one.

| Variable | Required | What it does |
| --- | --- | --- |
| `SESSION_SECRET` | **Yes** | Signs session cookies and peppers password hashes. 32+ random characters. Without it, sign-in returns a clear 503 rather than running insecurely. |
| `TELEGRAM_BOT_TOKEN` | No | Bot token from @BotFather. Setting it makes Telegram the alert channel. Secret. |
| `TELEGRAM_CHAT_ID` | No | Chat the bot posts into. Falls back to the latest chat in `getUpdates`. |
| `WHATSAPP_TO` | No | Where WhatsApp order alerts go — **internal**. Defaults to the published number. Never used for customer-facing links. |
| `PUBLIC_WHATSAPP` | No | The number customers are sent to from the pending-order screen and their order list. Defaults to `201105006854`, the number published across the site. |
| `WHATSAPP_*` / `ULTRAMSG_*` / `TWILIO_*` / `CALLMEBOT_KEY` | No | Pick one provider — see the table above. |
| `NOTIFY_PROVIDER` | No | Force a provider instead of auto-detecting: `telegram`, `meta`, `ultramsg`, `twilio`, `callmebot`. |
| `ADMIN_EMAILS` | No | Who may read the team timesheet, on top of `role='admin'`. Comma-separated. Default `admin@visionguardeg.com`. These addresses cannot be registered through the signup form. |
| `WORK_DAY_HOURS` | No | Contracted day. Default `6`. Already set in `wrangler.toml`. |
| `SHIPPING_FLAT` | No | Flat shipping fee in EGP. Default `0` = quoted at confirmation. |
| `META_PIXEL_ID` | No | Meta Pixel ID for browser and server-side conversion tracking. |
| `META_DATASET_ID` | No | Optional Meta dataset ID to send CAPI events to instead of a pixel. |
| `META_ACCESS_TOKEN` | No | Meta Conversions API secret token. Keep this in secrets only. |
| `META_CURRENCY` | No | Currency code for events. Defaults to `EGP`. |
| `META_TEST_EVENT_CODE` | No | Optional Meta test event code for debugging. |
| `META_ATTRIBUTION_SHARE` | No | Optional attribution share, default `0.3`. |
| `META_INSIGHTS_TOKEN` | No | System User token with the five read scopes, for the Marketing tab. Falls back to `META_ACCESS_TOKEN`, which authenticates and then returns nothing — see `dedicatedToken`. Secret. |
| `META_PAGE_ID` | No | Defaults to `843967908810641` ("Vision Guard"). |
| `META_IG_USER_ID` | No | **The one id that has to be set by hand** — the ad account has no Instagram account linked, so it could not be resolved. `GET /843967908810641?fields=instagram_business_account`. |
| `META_AD_ACCOUNT_ID` | No | Defaults to `act_2067738330681838` ("vision guard"). `act_` prefix optional. |
| `META_CATALOG_TOKEN` | No | System User token carrying `catalog_management`, for `/api/admin/meta-catalog`. Falls back to `META_INSIGHTS_TOKEN` so one token can serve both. Never falls back to `META_ACCESS_TOKEN`. Secret. |
| `META_CATALOG_ID` | No | Defaults to `1385708380173785` ("VisonGuardEg-Cataogue"). The other catalogue on the business, `1411420710903781` ("CCTV"), is **not** this feed's destination. |
| `SITE_ORIGIN` | No | Canonical origin the catalogue's `link` and `image_link` are built on. Pins which of the site's two hosts Meta stores. No trailing slash. |
| `PBKDF2_ITERATIONS` | No | Default `25000`. Raise to `210000` on the Workers Paid plan. |

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## API

Everything is same-origin JSON. Mutating requests require a matching `Origin`,
on top of the `SameSite=Lax` cookie. Rate limits are per IP (and per email for
login) in fixed windows, and fail *open* — a misbehaving counter must not lock
customers out of checkout.

| Route | Method | Notes |
| --- | --- | --- |
| `/api/catalog` | GET | Products, categories, governorates as JSON. |
| `/api/coupon` | GET | "May I show this discount?" Advisory — `/api/orders` re-decides it. Handles the welcome tiers and issued codes alike; an empty `code` asks what the customer is entitled to. |
| `/api/admin/promos` | GET | **Admin only.** Every issued code with its window and usage. |
| `/api/admin/promos` | POST | **Admin only.** `create`, `update` (window/limit/on-off), `delete` (unused codes only), and `discount-order` for a one-off discount on an existing order. |
| `/api/orders` | POST | Place an order. Guest or signed in. |
| `/api/orders` | GET | The signed-in customer's own orders. |
| `/api/auth/signup` | POST | Creates the account and signs in. |
| `/api/auth/login` | POST | Same message either way, so it cannot be used to discover registered addresses. |
| `/api/auth/logout` | POST | Clears the cookie on this device. |
| `/api/auth/me` | GET | Returns `user: null` with a 200 when signed out, so a page can boot without treating that as an error. |
| `/api/account/preferences` | POST | Name, phone, and the two consents. |
| `/api/newsletter` | POST | Bare subscribe. |
| `/api/attendance` | GET | Staff only. Days, sessions, totals. |
| `/api/attendance/clock` | POST | Staff only. `{action: "in" \| "out"}`. |
| `/api/attendance/team` | GET | **Admin only.** Every employee for one Cairo day, plus a rolling range. `?date=YYYY-MM-DD&days=1..31`. |
| `/api/leads` | GET | Staff. The board, a search, or one lead with its timeline. Also answers `canDelete` for this session. |
| `/api/leads` | POST | Staff. `create`, `update`, `note`, `status`, `link`, `confirm` (order status) and `payment` (paid / pending / failed). **`delete` is administrator-only** and needs `confirm: true` — it removes the lead and its whole timeline, and nothing else. |
| `/api/admin/manage` | GET | **Admin only.** The orders and users lists behind the dashboard. |
| `/api/admin/manage` | POST | **Admin only.** Order `status`, `payment`, `cancel`, `delete`; user `create`, `reset`, `password`, `terminate`. |
| `/api/marketing` | GET | Staff see Page and Instagram reach; **admins** also see ad spend and return on ad spend. Answers `configured: false` with the missing piece named rather than erroring. |
| `/api/admin/meta-catalog` | GET | **Admin only.** What is configured, and a dry run of exactly what would be sent to the Meta catalogue — including the rows Meta will refuse. |
| `/api/admin/meta-catalog` | POST | **Admin only.** `sync` — push every product into the Meta catalogue over the Batch API. Upserts only; it never deletes (see `lib/metacatalog.js`). |

---

## Still to do

- **Editing an attendance record.** The Team tab reads; it does not write.
  Correcting someone's forgotten clock-out is still a SQL statement.
- **Confirming a payment automatically.** `orders.payment_status` is moved by a
  person who looked at the transfer, because nothing on this site is connected
  to a bank. If a payment provider is ever integrated, that is the thing that
  should be writing this column.
- **The payment state of orders placed before the change.** The migration sets
  every existing row to `pending`, which is honest rather than accurate: they
  were cash-on-delivery orders and most were paid on the doorstep. Nothing
  guesses on their behalf — correct the ones that matter from the orders table.
- **Password reset.** There is no email sender wired up, so a forgotten password
  currently needs you to reset the row.
- **The landing page's static price table** in `index.html` is maintained
  separately from `catalog.js`. Worth generating one from the other.
