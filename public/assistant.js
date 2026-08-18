/* =========================================================================
   Vision Guard — assistant.js
   The floating assistant that replaced the WhatsApp button.

   Deliberately standalone: it imports nothing. index.html runs main.js and
   the shop and account pages run site.js, and those two own the language
   switch in incompatible ways — main.js fires a `langchange` event, site.js
   calls registered callbacks. Rather than depend on either, this watches the
   one thing both of them set, the lang attribute on <html>, and re-renders
   off that. One file, three pages, no coupling.

   The thread lives in sessionStorage so walking from the shop to the landing
   page does not throw away the conversation, and dies with the tab. Nothing
   is stored on the server — see functions/api/assist.js.
   ========================================================================= */
(function () {
  'use strict';

  var WA = 'https://wa.me/201105006854';
  var KEY = 'vg-assist';
  var MAX_TURNS = 12;
  var MAX_CHARS = 1200;

  var COPY = {
    open:    { ar: 'افتح المساعد الذكي', en: 'Open the AI assistant' },
    close:   { ar: 'إغلاق المساعد', en: 'Close the assistant' },
    title:   { ar: 'مساعد Vision Guard', en: 'Vision Guard assistant' },
    sub:     { ar: 'بيرد على أسئلة الكاميرات وأنظمة المراقبة', en: 'Answers questions about cameras and CCTV systems' },
    hello:   {
      ar: 'أهلاً بيك. اسألني عن أي كاميرا أو جهاز تسجيل، أو قول لي المكان اللي عايز تغطيه وأنا أرشّحلك النظام المناسب.',
      en: 'Hello. Ask me about any camera or recorder, or tell me the place you want covered and I will size the right system for it.'
    },
    ph:      { ar: 'اكتب سؤالك…', en: 'Type your question…' },
    send:    { ar: 'إرسال', en: 'Send' },
    think:   { ar: 'بيفكر…', en: 'Thinking…' },
    human:   { ar: 'تحب تكلم حد من الفريق؟ واتساب', en: 'Rather talk to a person? WhatsApp' },
    clear:   { ar: 'محادثة جديدة', en: 'New chat' },

    /* ---- live chat with a person ---- */
    askHuman:  { ar: 'اتكلم مع موظف', en: 'Talk to a person' },
    connecting:{ ar: 'بندوّر على حد من الفريق…', en: 'Finding someone from the team…' },
    queued:    {
      ar: 'طلبك وصل لفريق خدمة العملاء. أول ما حد يرد هتلاقي رسالته هنا — سيب الصفحة مفتوحة.',
      en: 'Your request has reached the team. The first person free will answer right here — keep this page open.'
    },
    joined:    { ar: 'دخل معاك في المحادثة', en: 'joined the chat' },
    liveNow:   { ar: 'بتتكلم مع موظف', en: 'You are talking to a person' },
    chatEnded: {
      ar: 'المحادثة اتقفلت. لو محتاج حاجة تانية اسأل المساعد أو راسلنا على واتساب.',
      en: 'This chat has ended. Ask the assistant again, or message us on WhatsApp.'
    },
    noStaff:   {
      ar: 'مافيش حد متاح دلوقتي. راسلنا على واتساب وهنرد عليك بأسرع وقت.',
      en: 'Nobody is available right now. Message us on WhatsApp and we will get back to you.'
    },
    waFallback:{ ar: 'أو راسلنا على واتساب', en: 'Or message us on WhatsApp' },
    chips:   {
      ar: ['عايز أغطي شقة', 'إيه الفرق بين الوايرلس والأنالوج؟', 'كام كاميرا أحتاج لمحل؟'],
      en: ['Cover a flat', 'Wi-Fi or analog?', 'How many cameras for a shop?']
    },
    /* Keyed by the server's error code so the wording never half-translates
       at the exact moment something breaks. */
    err: {
      assistant_off:         { ar: 'المساعد مش مفعّل على النسخة دي. راسلنا على واتساب وهنرد عليك.', en: 'The assistant is not switched on here yet. Message us on WhatsApp and we will answer.' },
      assistant_unavailable: { ar: 'مش قادر أرد دلوقتي. جرّب تاني، أو راسلنا على واتساب.', en: 'I could not answer just now. Try again, or message us on WhatsApp.' },
      rate_limited:          { ar: 'أسئلة كتير في وقت قصير. استنى شوية وجرّب تاني.', en: 'Too many questions in a short time. Wait a moment and try again.' },
      network:               { ar: 'مافيش اتصال بالسيرفر. اتأكد من الإنترنت وجرّب تاني.', en: 'Could not reach the server. Check your connection and try again.' },
      fallback:              { ar: 'حصل خطأ. جرّب تاني، أو راسلنا على واتساب.', en: 'Something went wrong. Try again, or message us on WhatsApp.' }
    }
  };

  function lang() {
    return document.documentElement.getAttribute('lang') === 'en' ? 'en' : 'ar';
  }
  function t(pair) {
    return pair ? (lang() === 'en' ? pair.en : pair.ar) : '';
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ---------------- thread ---------------- */
  var thread = [];
  try {
    var saved = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) {
      thread = saved
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
        .slice(-MAX_TURNS);
    }
  } catch (e) {}

  function persist() {
    try { sessionStorage.setItem(KEY, JSON.stringify(thread.slice(-MAX_TURNS))); } catch (e) {}
  }

  /* ---------------- markup ---------------- */
  var wrap   = el('div', 'vga');
  var fab    = el('button', 'vga__fab');
  var panel  = el('section', 'vga__panel');
  var head   = el('header', 'vga__head');
  var titles = el('div', 'vga__titles');
  var title  = el('p', 'vga__title');
  var sub    = el('p', 'vga__sub');
  var newBtn = el('button', 'vga__new');
  var log    = el('div', 'vga__log');
  var chips  = el('div', 'vga__chips');
  var form   = el('form', 'vga__form');
  var input  = el('input', 'vga__input');
  var send   = el('button', 'vga__send');
  var foot   = el('p', 'vga__foot');
  var humanBtn = el('button', 'vga__human');
  var waLink = el('a');

  fab.type = 'button';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'vgaPanel');
  fab.innerHTML =
    '<svg class="vga__i vga__i--open" viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.6c0 4-3.9 7.2-8.7 7.2a10 10 0 0 1-2.4-.3L4.6 21l1.2-3.9A6.8 6.8 0 0 1 3.6 11.6C3.6 7.6 7.5 4.4 12.3 4.4S21 7.6 21 11.6Z"/>' +
      '<path d="M9.4 11.6h.01M12.3 11.6h.01M15.2 11.6h.01"/>' +
    '</svg>' +
    '<svg class="vga__i vga__i--close" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6 6 18"/>' +
    '</svg>';

  panel.id = 'vgaPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'vgaTitle');
  panel.setAttribute('inert', '');

  title.id = 'vgaTitle';
  newBtn.type = 'button';
  newBtn.className = 'vga__new';

  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('tabindex', '0');

  input.type = 'text';
  input.autocomplete = 'off';
  input.maxLength = MAX_CHARS;
  input.className = 'vga__input';

  send.type = 'submit';
  send.className = 'vga__send';
  send.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 12h15M13 6l6 6-6 6"/>' +
    '</svg>';

  humanBtn.type = 'button';

  waLink.href = WA;
  waLink.target = '_blank';
  waLink.rel = 'noopener';

  titles.appendChild(title);
  titles.appendChild(sub);
  head.appendChild(titles);
  head.appendChild(newBtn);
  form.appendChild(input);
  form.appendChild(send);
  /* Talking to a person first, WhatsApp as the way out if nobody is free.
     The order matters: WhatsApp used to be the ONLY way through to a human,
     which meant every such customer left the site to get one. */
  foot.appendChild(humanBtn);
  foot.appendChild(waLink);
  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(chips);
  panel.appendChild(form);
  panel.appendChild(foot);
  wrap.appendChild(panel);
  wrap.appendChild(fab);
  document.body.appendChild(wrap);

  /* ---------------- rendering ---------------- */
  /* Model output is text, and it is put on the page as text. It is the one
     string here that neither we nor the customer wrote. */
  function bubble(role, text) {
    var b = el('div', 'vga__msg vga__msg--' + (role === 'user' ? 'me' : 'bot'), text);
    log.appendChild(b);
    return b;
  }

  function renderThread() {
    log.textContent = '';
    bubble('assistant', t(COPY.hello));
    thread.forEach(function (m) { bubble(m.role, m.content); });
    log.scrollTop = log.scrollHeight;
  }

  function renderChips() {
    chips.textContent = '';
    /* Only worth the space before the customer has said anything. */
    if (thread.length) { chips.hidden = true; return; }
    chips.hidden = false;
    (lang() === 'en' ? COPY.chips.en : COPY.chips.ar).forEach(function (q) {
      var c = el('button', 'vga__chip', q);
      c.type = 'button';
      c.addEventListener('click', function () { ask(q); });
      chips.appendChild(c);
    });
  }

  function applyCopy() {
    fab.setAttribute('aria-label', t(open_ ? COPY.close : COPY.open));
    fab.title = t(open_ ? COPY.close : COPY.open);
    title.textContent = t(COPY.title);
    newBtn.textContent = t(COPY.clear);
    input.placeholder = t(COPY.ph);
    send.setAttribute('aria-label', t(COPY.send));
    send.title = t(COPY.send);
    humanBtn.textContent = t(COPY.askHuman);
    waLink.textContent = t(COPY.waFallback);

    /* Mid-conversation with a person, the header says so and the thread on
       screen is theirs — redrawing it from the bot's `thread` array would
       wipe everything the employee has said. */
    if (live.session) {
      sub.textContent = live.status === 'live'
        ? t(COPY.liveNow)
        : t(COPY.connecting);
      humanBtn.hidden = true;
      return;
    }

    sub.textContent = t(COPY.sub);
    humanBtn.hidden = false;
    renderThread();
    renderChips();
  }

  /* ---------------- open / close ---------------- */
  var open_ = false;

  function setOpen(next) {
    open_ = !!next;
    wrap.classList.toggle('is-open', open_);
    fab.setAttribute('aria-expanded', open_ ? 'true' : 'false');
    fab.setAttribute('aria-label', t(open_ ? COPY.close : COPY.open));
    fab.title = t(open_ ? COPY.close : COPY.open);
    if (open_) {
      panel.removeAttribute('inert');
      log.scrollTop = log.scrollHeight;
      input.focus();
    } else {
      panel.setAttribute('inert', '');
    }
  }

  fab.addEventListener('click', function () { setOpen(!open_); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open_) { setOpen(false); fab.focus(); }
  });

  newBtn.addEventListener('click', function () {
    thread = [];
    persist();
    renderThread();
    renderChips();
    input.focus();
  });

  /* ---------------- asking ---------------- */
  var busy = false;

  function errorFor(code) {
    return t(COPY.err[code] || COPY.err.fallback);
  }

  async function ask(text) {
    var question = String(text || '').trim().slice(0, MAX_CHARS);
    if (!question || busy) return;

    busy = true;
    input.value = '';
    input.disabled = true;
    send.disabled = true;

    thread.push({ role: 'user', content: question });
    persist();
    bubble('user', question);
    renderChips();

    var pending = bubble('assistant', t(COPY.think));
    pending.classList.add('is-pending');
    log.scrollTop = log.scrollHeight;

    var res, data = {};
    try {
      res = await fetch('/api/assist', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: thread.slice(-MAX_TURNS) })
      });
      try { data = await res.json(); } catch (e) {}
    } catch (e) {
      data = { ok: false, code: 'network' };
    }

    pending.classList.remove('is-pending');

    if (res && res.ok && data.ok && data.reply) {
      pending.textContent = data.reply;
      thread.push({ role: 'assistant', content: data.reply });
      persist();
    } else {
      pending.classList.add('is-err');
      pending.textContent = errorFor(data.code);
      /* The failed turn is dropped so the next question does not resend a
         question the model never actually answered. */
      thread.pop();
      persist();
      renderChips();
    }

    busy = false;
    input.disabled = false;
    send.disabled = false;
    log.scrollTop = log.scrollHeight;
    if (open_) input.focus();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    /* One box, two destinations. Once a person is on the other end the same
       field talks to them instead of to the model — asking the customer to
       find a different place to type would be a strange thing to do to
       somebody who has just been put through to a human. */
    if (live.session) sendToAgent(input.value);
    else ask(input.value);
  });

  /* =========================================================================
     LIVE CHAT — from the assistant to a person

     The bot answers until somebody asks for a human. From that moment the
     conversation is on the server (functions/api/chat.js), one employee is
     offered it, and this widget polls for their replies.

     POLLING, NOT SOCKETS. A WebSocket needs a Durable Object to hold the
     other end, which is a different runtime and a different bill for a shop
     that will have a handful of these a day. A poll every few seconds is one
     indexed read and is indistinguishable to the customer.

     THE POLL IS ALSO WHAT MOVES THE QUEUE. Pages has no cron, so the
     five-minute deadline on each offer is evaluated by whoever asks — and a
     waiting customer's browser is the one thing guaranteed to still be
     asking. See the header of lib/livechat.js.
     ========================================================================= */
  var live = { session: null, timer: null, after: '', status: '' };
  var POLL_MS = 4000;

  function liveBubble(role, text) {
    var cls = role === 'customer' ? 'me' : (role === 'system' ? 'sys' : 'bot');
    var b = el('div', 'vga__msg vga__msg--' + cls, text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function stopPolling() {
    if (live.timer) { clearInterval(live.timer); live.timer = null; }
  }

  async function poll() {
    if (!live.session) return;
    var data = {};
    var res;
    try {
      res = await fetch(
        '/api/chat?session=' + encodeURIComponent(live.session) +
        (live.after ? '&after=' + encodeURIComponent(live.after) : ''),
        { credentials: 'same-origin' }
      );
      data = await res.json();
    } catch (e) {
      /* A dropped poll is not worth telling the customer about; the next one
         is four seconds away. */
      return;
    }

    /* A session the server does not know about is never coming back — it was
       closed and swept, or the id is stale after a deploy. Stopping matters:
       without this the widget polls a 404 every four seconds for as long as
       the tab stays open, which is a request per customer per four seconds
       for nothing. */
    if (res.status === 404 || data.code === 'no_session') {
      liveBubble('system', t(COPY.chatEnded));
      endLive();
      return;
    }
    if (!res.ok || !data.ok) return;   // transient; try again next tick

    (data.messages || []).forEach(function (m) {
      /* The customer's own lines are already on screen — they were drawn the
         moment they were typed, and drawing the echo would double them. */
      if (m.role === 'customer') { live.after = m.at; return; }
      if (m.role === 'bot') { live.after = m.at; return; }
      liveBubble(m.role, m.role === 'system' ? m.body : m.body);
      live.after = m.at;
    });

    var s = data.session || {};
    if (s.status === 'live' && live.status !== 'live') {
      live.status = 'live';
      sub.textContent = t(COPY.liveNow) + (s.agentName ? ' — ' + s.agentName : '');
    }
    if (s.status === 'closed') {
      liveBubble('system', t(COPY.chatEnded));
      endLive();
    }
  }

  function endLive() {
    stopPolling();
    live.session = null;
    live.status = '';
    live.after = '';
    applyCopy();
  }

  async function sendToAgent(text) {
    var body = String(text || '').trim().slice(0, MAX_CHARS);
    if (!body || busy) return;
    busy = true;
    input.value = '';
    liveBubble('customer', body);
    try {
      await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send', session: live.session, body: body })
      });
    } catch (e) { /* the poll will reconcile */ }
    busy = false;
    if (open_) input.focus();
  }

  async function requestHuman() {
    if (live.session || busy) return;
    busy = true;
    humanBtn.disabled = true;
    var pending = liveBubble('system', t(COPY.connecting));

    var data = {};
    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          page: location.pathname,
          /* What the customer has already said, so whoever picks it up is
             not making them start again. */
          history: thread.slice(-12)
        })
      });
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.code || 'failed');
    } catch (e) {
      pending.classList.add('is-err');
      pending.textContent = errorFor((data && data.code) || 'fallback');
      busy = false;
      humanBtn.disabled = false;
      return;
    }

    live.session = data.session;
    live.status = 'waiting';
    /* Everything already on screen came from the bot and is now stored
       server-side too, so the poll starts from now rather than replaying it. */
    live.after = new Date().toISOString();

    pending.textContent = data.staffed ? t(COPY.queued) : t(COPY.noStaff);
    if (!data.staffed) pending.classList.add('is-err');

    busy = false;
    humanBtn.hidden = true;
    sub.textContent = t(COPY.connecting);
    stopPolling();
    live.timer = setInterval(poll, POLL_MS);
    poll();
  }

  humanBtn.addEventListener('click', requestHuman);

  /* The tab going away should not leave a poll running against a session
     nobody is reading. */
  window.addEventListener('pagehide', stopPolling);

  /* ---------------- language ---------------- */
  /* main.js and site.js both write lang on <html>; neither knows this file
     exists. Watching the attribute keeps all three independent. */
  new MutationObserver(function () { applyCopy(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  applyCopy();
})();
