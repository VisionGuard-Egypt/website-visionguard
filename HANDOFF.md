# VisionGuard — handoff

Paste this into a new chat to continue. Everything below is current as of
commit `5e17c12`, cache-buster **v=59**, all deployed and live.

**Git note.** Pushes were failing with a 403 for a while: Windows Credential
Manager had `git:https://github.com` stored as **mahmoudznabil**, which has no
write access to `Mahmoudnabil03/worldwidewebvisionai`. Erasing that entry and
pushing again re-authenticated as **Mahmoudnabil03**, which is the account
this repo needs. If a push 403s again, that is the first thing to check:

```
printf "protocol=https\nhost=github.com\n\n" | git credential fill
```

---

## The project

`C:\Users\mahmo\Desktop\worldwidewebvisionai-main` — visionguardeg.com, an
Arabic-first (RTL) CCTV shop in Egypt, cash on delivery.

**Stack, and it is not what a generic prompt assumes:**

- **Vanilla ES modules, no bundler, no framework.** Not React. `public/*.js`
  are plain modules loaded with `<script type="module">`.
- **Cloudflare Pages Functions**, not Node/Express. `functions/**` are routes.
- **Cloudflare D1** (SQLite), not Postgres/Mongo. Plus **KV** (images,
  avatars, insight caching) and the **AI** binding (the chatbot).
- **Stateless signed cookies**, not JWT. `lib/auth.js`.
- Firebase Auth holds customer credentials; the seeded admin has a local
  PBKDF2 hash in D1 as break-glass.
- Tests are `node:test`, no framework: `npm test`. **212 passing.**

---

## Rules that will bite you if you skip them

1. **Deploy with `npx wrangler pages deploy --branch=main`.**
   The local branch is `master`; the Pages production branch is `main`. Plain
   `npm run deploy` publishes a *preview* while the live site keeps serving
   the old build, and the success message looks identical either way.
   Pages is Git-connected, so `git push origin master:main` also triggers a
   real production build — that is the normal path now.

2. **Bump the `?v=` cache-buster on ANY css/js change**, in every file at
   once (there is a script pattern in the git log; 21 files, ~86 refs).
   `public/account.html` documents why. Skipping it serves returning
   visitors a half-updated mix of modules — this has already caused two real
   bugs.

3. **Adding a table or column to `lib/db.js` means THREE places**: the DDL,
   the `MIGRATIONS` array, and `EXPECTED_TABLES` / `EXPECTED_*_COLUMNS`.
   Miss the third and `schemaReady()` keeps answering yes on a database that
   predates it, `migrate()` never runs, and it fails on production and
   nowhere else.

4. **Edge cache lies to you right after a deploy.** A plain fetch can return
   the previous asset or a stale 404 for a minute or two. Always verify with
   a `?cb=$RANDOM` cache-buster before concluding something is broken.

5. **`grep` treats the Arabic HTML files as binary** and silently reports
   nothing. Use `grep -a`.

6. **The Bash tool mangles `$('#id')`, backticks and Arabic** in `node -e`
   and heredocs. Prefer the Edit/Write tools for source changes; when you
   must script it, write the script to a file first.

7. **Never leave `/tmp` paths in Bash** — on Windows they resolve to
   `C:\tmp` and silently fail. Use the session scratchpad.

---

## Done and live (this session)

| Commit | What |
|---|---|
| `3334285` | Marketing tab (Meta Page/IG/Ads insights), Meta verification banner |
| `3dfe1aa` | Doc fix: Pages binds env vars **per deployment** — you must redeploy after adding a secret |
| `5b7ab6b` | Live chat handoff (bot → employee, 5-min rota), leads-from-orders, Google sign-in fixes |
| `be5dbfa` | Attendance mis-tap fix, self-service password change |
| `47678d7` | WELCOME10 first-order 10% coupon |
| `a096e84` | **Panel restructure** — 13 flat tabs → My account / Work / Admin workspaces, hash routing |
| `10891f7` | Promo bar was invisible on the homepage; `--lift` token for light-theme cards |
| `af90125` | Planner step vs question badge (1 vs 1/3) |
| `fb9b380` | **Planner wall editing** — resize building, move walls, reference drawing in sessionStorage |
| `6e8527b` | **Profile pictures** — KV, URL keyed on random token not user id |

---

## Done in the session after that

| Commit | What |
|---|---|
| `a1d5670` | **Catalogue + data exports** as real .xlsx, and the COOP header that was killing Google sign-in |

### 1. Catalogue export — DONE

Admin → Shop → Catalogue → **Export for Meta (.xlsx)**.
`lib/xlsx.js` writes a real workbook by hand (a ZIP of OOXML — there is no
bundler and no npm package reaches the Workers runtime). `lib/metafeed.js`
shapes the rows, `functions/api/admin/export.js` serves them.

**The price question was answered.** The supplied VG_Meta_Catalog.xlsx has
`sale_price` 25% ABOVE `price` on all 64 rows because that sheet's `price`
column is the PURCHASE price — the shop buys at cost and resells at cost +
25%. Confirmed against the live catalogue: of the five rows whose link
resolves to a product that still exists, all five have sale_price equal to
the shop price and none has `price` equal to it.

So the feed reads `products.price` out of D1 — what checkout charges — and
**never emits cost**. `sale_price` stays blank unless a product has a real
`was`; every product has `was = 0` today, so it is blank throughout, which
is correct rather than missing. Read the header of `lib/metafeed.js` before
touching a price column.

`id` is the D1 slug, NOT the sheet's VG-UNI-CAM-0001 codes: Meta matches a
catalogue entry to a pixel event on content_ids and `public/track.js` sends
the slug. The sheet's codes match nothing, and 59 of its 64 links point at
product ids that do not exist.

### 2. Data export — DONE

Admin → Growth → Performance → **Export data (.xlsx)**. Four sheets:
Offline Conversions (Meta upload shape), Customer List (custom audience),
Orders (the shop's own detail), Daily Events (meta_events pivoted).

Only people who ticked marketing consent reach the Customer List — an order
is measurement, an audience upload is advertising, and they are not the same
permission. Cancelled orders never count as revenue.

Production has **0 orders**, so three of those four sheets come back as
headers only until somebody buys something. That is the empty case, and it
is tested.

### 3. Google sign-in — DONE, and it was not account management

`Cross-Origin-Opener-Policy: same-origin` in `public/_headers`. That severs
a cross-origin popup from its opener: `window.opener` is null on their side,
`.closed` reads true on ours. Firebase polls exactly that, decides the
customer closed the window, and rejects with `auth/popup-closed-by-user` —
which `account.js` treated as a deliberate cancel and deliberately said
NOTHING about. Click Google, pick an account, land back on the sign-in form,
no error, nothing written to D1. Hence zero Google customers in `users`.

Now `same-origin-allow-popups`, pinned in `test/headers.test.js` along with
the four CSP entries that have each already caused a silent outage here.
**Do not harden it back.**

Verified healthy before concluding it was the header: the `/__/` proxy and
its handler.js, Firebase's authorized domains, the Google provider, and the
redirect_uri Google actually accepts.

Also: a Google account had no phone and checkout requires one, so customers
without a number now get a dashboard prompt that lands them on the field.

### Fixed in passing

`tapo-c70` in the PRODUCTION products table had its Arabic destroyed —
`ar` was `? ???????? ? ??????`. The live Arabic shop was serving that. Restored
from `public/catalog.js`; all 60 rows now scan clean. Apply Arabic to D1 with
`--file=`, never `--command`, which is almost certainly how it happened.

### 4. Nav work — DONE

**The planner promo comes out of the planner button.** It used to hang off the
burger, which only exists below 900px. promo.js now measures the
"المخطّط" / "Planner" link and the card grows out of it (tail under the
button, transform-origin on the tail), falling back to the burger where that
link sits inside the closed menu. Four measured custom properties, all read
by the stylesheet. Tail lands on the link centre to within 0.02px in both
directions.

**A "Work" link in the nav for @visionguardeg.com accounts**, beside Shop and
Planner, in the bar and the burger menu, going to `account.html#work` — where
the employee tabs and (for an admin) the Admin workspace both live.

`public/worklink.js` is a CLASSIC SCRIPT and that is load-bearing: the first
version lived in site.js and never appeared on the landing page, because
index.html's chrome is main.js, which is a classic script and never calls
`initChrome()`. consent.js and promo.js are classic for the same reason. If
you add a page, give it the `worklink.js` tag or the link will not be there.

Visibility is a `vg-staff` localStorage hint written by account.js. **It is a
hint, not a permission** — forging it draws a link and nothing more;
requireStaff/requireAdmin still gate everything behind it. Verified signed
out, as a customer, and with a forged hint on a customer account, which
account.js clears rather than ignores.

### 5. Link previews — DONE

`og:image` was a RELATIVE path, so every share of this site anywhere had no
picture on it. Open Graph resolves nothing relative. Six pages had no Open
Graph block at all.

Now: `public/assets/og-card.jpg`, 1200×630, drawn on the site's own dark
ground in Cairo, plus absolute `og:image` (+width/height/alt), `og:url`,
`og:locale`, `twitter:card` and a `canonical` on all nine pages. Verified
live by fetching each page as `facebookexternalhit` and then fetching the
image it points at.

Canonicals all point at the APEX, which also settles the apex-vs-www
duplicate below. `/account` additionally carries `noindex`.

**The product page's tags are static**, so every product shares one preview.
Per-product titles and images need the page rendered server-side — Facebook's
crawler does not run JavaScript — which is a Pages Function, not a meta tag.

## Production readiness — what a full check found

Driven against the live site. Everything not listed here passed: checkout end
to end, server-side re-pricing, order validation, every admin/staff endpoint
refusing anonymous callers, CSRF, rate limits, security headers, HTTP→HTTPS,
all 60 product images and links, coupon, geo, newsletter, the assistant, and
199 tests.

**FIXED since that check:**

1. **Order alerts reach Telegram again.** `pickProvider()` picks Telegram
   first (its token is set) and there is NO fallback to the WhatsApp
   credentials that are also configured — so when the group was upgraded to
   a supergroup and the stored chat id went stale, every alert failed with
   `migrate_to_chat_id` and nothing else was tried. `TELEGRAM_CHAT_ID` is
   now `-1004451412269`. Proved by placing one order on production and
   reading `notified = 1, notify_error = none` off the row, then deleting
   it. **Pages binds variables per DEPLOYMENT** — a variable change does
   nothing until the next build.

   The missing fallback is still real: if Telegram breaks again, nothing
   picks up. Worth wiring one day.

2. **`public/catalog.js` resynced to D1** — nine rows, five of which were
   quoted BELOW what checkout charges. The assistant now answers 900 for
   `unv-2mp-nv` instead of 875. See the header of that file for why three
   separate live things depended on it, and note that any price edited in
   the admin drifts again.

3. **Soft 404s are gone.** `public/404.html` exists, so Pages answers a real
   404 for anything unmatched — every unknown path used to return 200 with
   the homepage. Verified live; every real route still 200s.

4. **`/sitemap.xml` is a Function**, not a file: `functions/sitemap.xml.js`
   generates it from the products table — seven fixed pages plus every
   active product, `lastmod` from `products.updated_at`. 67 URLs, validated
   well-formed. A file in `public/` would have gone stale the first time
   somebody added a product, silently, because there is no build step here.
   It answers with the fixed pages rather than 500ing if D1 is down.

5. **`public/robots.txt` now exists**, and its absence had been worse than
   nothing: Cloudflare served its managed AI-crawler block and Pages appended
   the whole HTML of the homepage after it. It now carries the `Sitemap:`
   line and disallows `/account`. **Cloudflare's managed block is added
   around it by the zone** between BEGIN/END markers — do not paste a copy
   into the file, it is maintained upstream.

6. **`SITE_ORIGIN` is set on production** to `https://visionguardeg.com`, so
   the sitemap and the catalogue export both pin to the apex instead of
   echoing whichever host was asked. The www host now emits apex URLs too.

7. **Product pages are server-rendered for crawlers.**
   `functions/product.js` intercepts `/product`, looks the row up in D1 and
   rewrites the head with HTMLRewriter — `og:type=product`, the product's own
   title/description/image, a canonical carrying the id, the full
   `product:*` set and a JSON-LD Product block. The body is untouched, so
   product.js still renders the page for shoppers.

   This is what makes **the website usable as a Meta catalogue data source**.
   Before it, all 60 product URLs returned the same shell — no name, no
   price, no id anywhere in the bytes — because Meta's crawler does not run
   JavaScript.

   **`product:retailer_item_id` must equal the pixel's `content_ids`.** Both
   are the D1 slug, and so is the `id` column in the spreadsheet export, so
   `functions/product.js`, `public/track.js` and `lib/metafeed.js` all agree
   by construction. Break that and dynamic ads match nothing, silently.

   Verified by crawling all 60 URLs as `facebookexternalhit`: 0 missing
   fields, 0 id mismatches, 0 price mismatches, 60 distinct ids.

8. **The Purchase event now sends 11 match keys, not 2.** It was sending a
   hashed email and a hashed phone while the order object carried a name and
   a governorate, the request carried the IP, user agent and Meta's own
   _fbp / _fbc cookies, and the session carried the user id. Now:

   ```
   em ph fn ln ct country external_id      hashed, SHA-256
   fbp fbc client_ip_address client_user_agent   verbatim
   ```

   **Meta's parameter-builder SDKs were NOT used**, and cannot be: the
   server-side ones are Node packages and this runs on Workers with no
   bundler and nothing from npm at runtime — the same constraint behind
   `lib/xlsx.js`. The rules are implemented natively in `lib/meta.js`. The
   only loss is the SDK's 8-character appendix, which is Meta's telemetry for
   measuring library adoption, not a matching signal.

   **Two things here fail silently and are pinned by
   `test/meta-userdata.test.js`:**

   - A hash only matches if BOTH sides normalized identically first.
     `public/track.js` hashes the browser's `em`, `ph` and `external_id`
     independently — change one, change both.
   - An empty value must be **dropped, never hashed**. `sha256("")` is a
     valid-looking digest that matches nobody, and Meta counts it as a
     supplied identifier, so a blank field *lowers* the score.

   Arabic shaped this. Names normalize with `\p{L}`, not `[a-z]` — the
   obvious rule would delete `عمر بكار` and hash nothing. Governorates are
   stored in whichever language the customer chose, so `القاهرة` is
   translated to a Latin city before hashing. `cityEn` and `splitName` live
   in `lib/meta.js` and `lib/metafeed.js` imports them; two copies would
   drift.

9. **Categories are ROWS now, with an admin tab** — Admin → Shop → Categories.
   The homepage cards and the shop's filter chips were a constant in
   `public/catalog.js`, so renaming a group or changing the picture it
   advertises with meant a deploy. `lib/categories.js` reads the table with
   the static list as the fallback, the same shape `lib/products.js` uses.

   **A category owns how it is PRESENTED** — two labels, two blurbs, the
   cover product, the order, whether it shows — **not which products are in
   it**. That is `products.cat`, one tab across.

   Three things that are easy to get wrong and are handled:
   - **Hiding is not withdrawing.** Hiding drops the card and the chip; the
     products stay on sale and reachable. Verified.
   - **Delete refuses while products remain** (409 with the count). Nothing
     in SQLite enforces `products.cat`, so deleting would orphan them —
     invisible in the shop, still being sold.
   - **`functions/api/admin/catalog.js` now reads the table** for its valid
     category ids. It used to use the static constant, which would have made
     every newly-added category reject every product put into it.

   Seeded from `public/catalog.js` on first open. Production is still
   `categorySource: static` until an admin opens the tab once.

10. **The shop's filter chips carry icons**, drawn inline on `currentColor`
    so they invert with the active chip and follow the theme. Category
    cards on the homepage take their picture from a `cover` PRODUCT, so
    changing a product photo in the admin changes the card.

**STILL OPEN:**

11. **apex and www both answer 200 with no redirect.** Canonicals and
    SITE_ORIGIN both name the apex, which is enough for crawlers; an actual
    host redirect needs a Cloudflare rule, not anything in this repo.
12. **`lib/assistant.js` still reads the static CATEGORIES** for the
    chatbot's group list. Harmless today; a category renamed in the admin
    will read as its old name to the assistant until that is threaded
    through D1 like the rest.
9. **No fallback if Telegram fails.** `pickProvider()` returns one provider
   and gives up if it errors, even though WhatsApp credentials are set.

## Still worth knowing

- **`google_sub` is never written.** The column and its unique index exist
  and `functions/api/auth/firebase.js` does not set it, so a Google account
  is indistinguishable from a password one in the database. Harmless today;
  it means you cannot report on sign-in method.
- **Production `orders` has columns the repo has never heard of** —
  `deposit`, `paid`, `pay_status`, `pay_ref`, `pay_txn`, `paid_at`,
  `promo_code` — all empty, all unreferenced. Something added a
  payment/promo schema straight to production. The exports do not touch
  them. Ask before building on them.
- **`tenda-ch9` shows the CP3 photo** — right brand, wrong model. Fine on
  the shop, less fine now that the same image goes into an ad catalogue.
- **SVG images are flagged, not blocked.** Production images are all JPEG
  today, but `public/catalog.js` ships .svg line drawings for the commodity
  parts; if any are ever seeded, the export names them and Meta would
  refuse those rows.

## Still outstanding from the user, not code

- **Marketing tab: THREE ids and one token — not six secrets.** Older notes
  here asked for six. `META_PAGE_TOKEN` and `META_APP_SECRET` were for the
  Meta social inbox, which was removed, and **no code reads either name any
  more** — verified by grepping every `META_*` the codebase touches. Setting
  them does nothing.

  What is actually needed:

  | Variable | What it is | Who can set it |
  |---|---|---|
  | `META_PAGE_ID` | an identifier | anyone with the value |
  | `META_IG_USER_ID` | an identifier | anyone with the value |
  | `META_AD_ACCOUNT_ID` | an identifier, `act_` optional | anyone with the value |
  | `META_INSIGHTS_TOKEN` | a **credential** | the owner, in their own terminal |

  `insightsConfig()` falls back to `META_ACCESS_TOKEN`, which production
  already has — so the tab starts answering the moment the three ids are set,
  and will very likely show EMPTY page and ads sections, because the CAPI
  token is a write token with none of the read scopes. That is exactly what
  the `dedicatedToken` flag in `insightsStatus()` is for: configured,
  answering, and empty. Only a System User read token fixes it.

  **Set, then REDEPLOY** — Pages binds variables per deployment.
- **Meta business verification** — the admin banner shows until the
  marketing connection works.
- The live-chat inbox needs the webhook registered at
  `https://www.visionguardeg.com/api/webhooks/meta` — though note the Meta
  social inbox was REMOVED at the user's request; only the on-site live chat
  remains.

---

## Verification habit that has paid off repeatedly

Do not trust that a change works because it was written. Every real bug this
session was found by driving the running site:

- the promo had no CSS on the homepage (16,000px down the page, invisible)
- `resizeScene` broke floor tiling by 1.5 m² through independent rounding
- `moveWall` left a 40 m² overlap by skipping a room update
- the sign-in nudge never appeared because the cart is empty at page load
- a backtick in a SQL comment terminated a template literal and broke
  `lib/db.js` entirely — `node --check` caught it, the tests did not

Use `preview_start` + `javascript_tool` to drive the page, and `node --check`
on every file you touch (the test suite does not import `lib/db.js`).
