/* =========================================================================
   Vision Guard — home.js
   Renders the landing page's two catalogue-driven sections — the category
   cards and the price list — from catalog.js.

   Both used to be hand-written markup. With fifteen products in five
   categories that was merely tedious; at sixty in eight it is a guarantee
   that the front page and the shop will eventually quote different prices
   for the same recorder, which is the one bug a price list must not have.

   Kept separate from main.js because this is the only part of the landing
   page that needs to be a module (catalog.js is one), and because main.js
   owns behaviour while this owns content.
   ========================================================================= */
import { CATEGORIES, PRODUCTS } from './catalog.js?v=66';

const cats  = document.querySelector('.cats');
const plist = document.querySelector('.plist');
if (cats || plist) {
  const root = document.documentElement;

  function lang() {
    return root.getAttribute('lang') === 'en' ? 'en' : 'ar';
  }
  function t(pair) {
    if (!pair) return '';
    return (lang() === 'en' ? pair.en : pair.ar) || pair.ar || pair.en || '';
  }
  function money(n) {
    return Number(n || 0).toLocaleString('en-US');
  }
  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /* -----------------------------------------------------------------------
     WHAT A LANGUAGE SWITCH ACTUALLY CHANGES

     Almost nothing. Of everything built below, the only things that differ
     between Arabic and English are five pieces of text: a category's name and
     blurb, a product's spec line, and the currency suffix. The images, the
     links, the prices, the ordering, the numbering and the whole element tree
     are identical in both.

     This used to be redrawn by tearing down both sections and rebuilding
     every node from scratch on each switch — roughly five hundred elements,
     and every product image dropped and re-fetched — to end up with the same
     tree carrying five hundred identical attributes and a handful of
     different words.

     So the nodes whose text depends on the language register themselves as
     they are built, each with the function that produces its text. Switching
     languages then re-runs those functions and writes the results back. Same
     visible result, no DOM churn, no image reload.
     ----------------------------------------------------------------------- */
  const langNodes = [];

  /* Sets the text now and re-sets it on every later switch. */
  function langText(node, produce) {
    langNodes.push({ node, produce });
    node.textContent = produce();
  }

  function paintLang() {
    for (let i = 0; i < langNodes.length; i++) {
      langNodes[i].node.textContent = langNodes[i].produce();
    }
  }

  /* -----------------------------------------------------------------------
     Category cards

     The old markup alternated two wide cards among three normal ones to fill
     the six-column grid. With eight categories the same trick is: make the
     first and the last wide, so both rows of the 6-col grid come out even
     (3+3 / 2+2+2 …). Rather than encode that per card, the class is applied
     by index — the layout follows the list length instead of the list
     following the layout.
     ----------------------------------------------------------------------- */
  /* The list currently on screen. Starts as the static one — it paints with
     no request — and is replaced by the rows from /api/catalog when those
     turn out to differ. Held so paintLang() keeps translating whichever list
     is actually rendered. */
  let shownCats = CATEGORIES;

  function renderCats(list) {
    if (!cats) return;
    shownCats = list || shownCats;
    cats.textContent = '';
    /* The cards that just detached took their language closures with them.
       Dropping those keeps paintLang() from walking a list that grows by
       eight on every re-render and writing into nodes nobody can see. Only
       reachable because this function can now be called a second time, with
       the live categories — the price list's nodes are still connected and
       survive the sweep. */
    for (let i = langNodes.length - 1; i >= 0; i--) {
      if (!langNodes[i].node.isConnected) langNodes.splice(i, 1);
    }
    shownCats.forEach((c, i) => {
      const a = el('a', 'cat reveal');
      /* two wide cards per eight keeps the 6-column grid square */
      if (i === 0 || i === shownCats.length - 1) a.classList.add('cat--wide');
      a.href = `shop.html?cat=${encodeURIComponent(c.id)}`;
      a.style.setProperty('--d', `${i * 70}ms`);

      const plate = el('span', 'cat__plate');
      const img = document.createElement('img');
      /* The static path paints immediately; liveCategories() replaces it with
         the cover product's CURRENT photograph once /api/catalog answers.
         Marked with the category id so that swap can find it without
         re-rendering the card and restarting its entrance animation. */
      img.src = c.img || '';
      img.alt = '';
      img.loading = 'lazy';
      img.dataset.cat = c.id;
      plate.appendChild(img);

      const meta = el('span', 'cat__meta');
      const idx = el('span', 'cat__idx');
      idx.textContent = String(i + 1).padStart(2, '0');
      const name = el('span', 'cat__name');
      langText(name, () => t(c));
      const desc = el('span', 'cat__desc');
      langText(desc, () => t(c.blurb));
      meta.append(idx, name, desc);

      a.append(plate, meta);
      cats.appendChild(a);
    });
  }

  /* -----------------------------------------------------------------------
     Price list — one group per category, in catalogue order
     ----------------------------------------------------------------------- */
  function renderList() {
    if (!plist) return;
    plist.textContent = '';

    /* Grouped in one pass instead of re-scanning the whole product list once
       per category. At eight categories and sixty products the old form was
       eight full passes to place sixty items. */
    const byCat = new Map();
    for (const p of PRODUCTS) {
      const group = byCat.get(p.cat);
      if (group) group.push(p);
      else byCat.set(p.cat, [p]);
    }

    CATEGORIES.forEach((c) => {
      const rows = byCat.get(c.id);
      if (!rows || !rows.length) return;

      const group = el('div', 'pgroup reveal');
      const h = el('h3', 'pgroup__title');
      const label = document.createElement('span');
      langText(label, () => t(c));
      const brands = el('i');
      /* the brands actually present in this category, not a fixed caption */
      brands.textContent = [...new Set(rows.map((p) => p.brand))].join(' · ');
      h.append(label, brands);

      const ul = el('ul', 'prods');
      rows.forEach((p) => {
        const li = el('li', 'prod');
        const nm = el('span', 'prod__name');
        nm.textContent = p.name;
        const spec = el('span', 'prod__spec');
        langText(spec, () => (lang() === 'en' ? p.en : p.ar));

        const price = el('span', 'prod__price');
        const b = document.createElement('b');
        b.textContent = money(p.price);
        price.appendChild(b);
        if (p.was) {
          const s = document.createElement('s');
          s.textContent = money(p.was);
          price.appendChild(s);
        }
        const em = document.createElement('em');
        langText(em, () => (lang() === 'en' ? 'EGP' : 'ج.م'));
        price.appendChild(em);

        li.append(nm, spec, price);
        ul.appendChild(li);
      });

      group.append(h, ul);
      plist.appendChild(group);
    });
  }

  /* Built once. Nothing below this point rebuilds it — see paintLang above. */
  function renderAll() {
    langNodes.length = 0;
    renderCats();
    renderList();
    /* main.js has already run its IntersectionObserver over the markup that
       was in the document at load, and these nodes were not. Rather than
       reach into its observer, they simply skip the entrance animation —
       they are below the fold either way. */
    document.querySelectorAll('.cats .reveal, .plist .reveal')
      .forEach((n) => n.classList.add('is-in'));
  }

  renderAll();

  /* -----------------------------------------------------------------------
     THE CATEGORY CARDS FOLLOW THE CATALOGUE

     Each card used to hard-code an image path, so replacing a product's
     photograph in the admin panel updated the shop and left the front page
     showing the old picture indefinitely — and nothing connected the two, so
     there was nowhere to notice.

     Each category now names a `cover` PRODUCT (see catalog.js), and this
     reads the live products table and takes that product's current `img`.
     Change the photo in the admin, and the homepage card changes with it.

     Deliberately a swap rather than a re-render: the cards are already on
     screen with their entrance animation done, and rebuilding them to change
     one attribute would restart it under a reader.

     Everything here fails soft. No answer, a bad answer, a category with no
     cover, a cover naming a product that no longer exists, or an identical
     path — each simply leaves the static image in place, which is the
     picture the card had before and is never wrong, only possibly old.
     ----------------------------------------------------------------------- */
  async function liveCategories() {
    if (!cats) return;
    let data;
    try {
      const res = await fetch('/api/catalog', { credentials: 'same-origin' });
      if (!res.ok) return;
      data = await res.json();
    } catch (e) {
      return;                       // offline, or the API is down
    }

    const live = Array.isArray(data && data.categories) ? data.categories : [];
    const products = Array.isArray(data && data.products) ? data.products : [];
    if (!live.length) return;       // never blank the section on a bad answer

    /* Re-render only if the categories themselves changed — a different set,
       a different order, or different words. An administrator editing them
       is rare; a visitor loading the homepage is not, and rebuilding eight
       cards to produce identical markup would discard eight images the
       browser has already decoded. */
    const shape = (l) => l.map((c) =>
      `${c.id}|${c.ar}|${c.en}|${(c.blurb && c.blurb.ar) || ''}|${(c.blurb && c.blurb.en) || ''}`
    ).join('~');
    if (shape(live) !== shape(shownCats)) {
      renderCats(live);
      cats.querySelectorAll('.reveal').forEach((n) => n.classList.add('is-in'));
    } else {
      shownCats = live;             // same words, but carries the live covers
    }

    /* Then the pictures. A cover names a PRODUCT, so the card follows that
       product's current photograph — change it in the admin and the card
       changes. Fails soft at every step: a missing cover, a cover naming a
       product that no longer exists, or an identical path each leave the
       image alone, which is never wrong, only possibly old. */
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const c of shownCats) {
      if (!c.cover) continue;
      const product = byId.get(c.cover);
      if (!product || !product.img) continue;

      const node = cats.querySelector(`img[data-cat="${c.id}"]`);
      /* Comparing before assigning: setting src to the value it already has
         still makes some browsers re-decode the image. */
      if (!node || node.getAttribute('src') === product.img) continue;
      node.src = product.img;
    }
  }

  liveCategories();

  /* main.js writes lang on <html> when the language button is used. Only the
     words change; the tree that holds them does not. */
  new MutationObserver(paintLang)
    .observe(root, { attributes: true, attributeFilter: ['lang'] });
}
