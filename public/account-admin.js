/* =========================================================================
   Vision Guard — account-admin.js
   The four administrator panels: the team timesheet, the performance report,
   order/user management, and the catalogue editor.

   WHY THIS IS A SEPARATE FILE, AND LOADED SEPARATELY
   --------------------------------------------------
   It used to be the second half of account.js, which meant every visitor who
   signed in downloaded and parsed it — the whole administrator console —
   before they could look at their own order history. On a shop whose
   customers are almost all not administrators, that is the majority of the
   page's JavaScript delivered to the people who can never invoke a line of it.

   account.js now imports this with a dynamic import(), the first time an
   administrator actually opens one of these four tabs. A customer never
   fetches it. A member of staff never fetches it. An administrator fetches it
   once, on the click that needs it, and the browser caches it from there.

   Nothing here is a security boundary and none of it was before: every
   endpoint these panels call re-checks the caller server-side. Withholding
   the file is about not shipping ~35 KB to people with no use for it, not
   about hiding it — see lib/auth.js -> requireAdmin for the real control.

   The code below is unchanged from where it lived in account.js. What it
   needs from the other half — the copy table, the signed-in user, and four
   formatting helpers — now comes from account-shared.js.
   ========================================================================= */
import { $, t, esc, api, money, currency, localDate, localTime, hoursLabel, toast } from './site.js?v=66';
import {
  T, me, statusTag, signed, busy, unbusy, showFormError, checkPassword
} from './account-shared.js?v=66';

/* Panel state. Module-scoped rather than passed in: this module is the only
   reader and the only writer of all five, which was not visible when they sat
   in a block of eight `let`s at the top of account.js next to the ones the
   customer view uses. */
let teamData = null;
let perfData = null;
let manageDebounce = null;
let catalogData = null;
let catalogDebounce = null;
let categoryData = null;
let promoData = null;
let adData = null;

/* =========================================================================
   5. TEAM — the administrator's timesheet

   Read-only by design. The question it answers is "did everyone work their
   six hours", and the answer to that is a fact about the records, not
   something to be edited from a browser tab. Correcting a forgotten
   clock-out is a conversation and then a deliberate database change.
   ========================================================================= */
function teamLabel(person) {
  return person.id === (me && me.id) ? `${person.name} (${t(T.you)})` : person.name;
}

/* Days that were recorded but came up short. An absent day is counted
   separately — nobody was there to be short. */
function shortDayCount(person) {
  return (person.days || []).filter((d) => d.sessions.length && d.status === 'short').length;
}

function renderTeam() {
  if (!teamData) return;

  $('#teamNote').textContent = t(T.teamNote);
  $('#teamFoot').textContent = t(T.teamFoot);
  $('#teamRangeTitle').textContent =
    `${t(T.rangeTitle)} — ${localDate(teamData.range.from + 'T12:00:00Z')} → ${localDate(teamData.range.to + 'T12:00:00Z')}`;
  $('#teamDate').value = teamData.date;
  /* The server clamps a future date anyway; this stops the picker offering
     one. Cairo's today, not the browser's. */
  if (teamData.isToday) $('#teamDate').max = teamData.date;
  $('#teamDays').value = String(teamData.range.days);

  const totals = teamData.totals;
  const verdict = $('#teamVerdict');
  verdict.textContent = totals.staff === 0
    ? t(T.noStaff)
    : (totals.allComplete ? t(T.allComplete) : t(T.notComplete));
  verdict.classList.toggle('is-good', totals.staff > 0 && totals.allComplete);
  verdict.classList.toggle('is-bad', totals.staff > 0 && !totals.allComplete);

  $('#teamStats').innerHTML = `
    <div class="stat"><span class="stat__k">${esc(t(T.employees))}</span><span class="stat__v">${totals.staff}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.complete))}</span><span class="stat__v ${totals.complete + totals.overtime === totals.staff ? 'is-pos' : ''}">${totals.complete + totals.overtime}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.shortCount))}</span><span class="stat__v ${totals.short ? 'is-neg' : ''}">${totals.short}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.absentCount))}</span><span class="stat__v ${totals.absent ? 'is-neg' : ''}">${totals.absent}</span></div>
    <div class="stat"><span class="stat__k">${esc(t(T.openCount))}</span><span class="stat__v">${totals.open}</span></div>`;

  $('#teamRows').innerHTML = teamData.staff.length
    ? teamData.staff.map((p) => {
        const inOut = p.day.firstIn
          ? `${localTime(p.day.firstIn)} — ${p.day.lastOut ? localTime(p.day.lastOut) : t(T.stillIn)}`
          : '—';
        const note = (p.day.sessions || []).find((s) => s.note);
        return `
          <tr>
            <td>
              <b>${esc(teamLabel(p))}</b>
              <div class="att__note" dir="ltr">${esc(p.email)}</div>
            </td>
            <td class="num" dir="ltr">${esc(inOut)}</td>
            <td class="num">${esc(hoursLabel(p.day.seconds))}</td>
            <td class="num">${p.day.sessions.length && p.day.balance !== null ? esc(signed(p.day.balance)) : '—'}</td>
            <td>${statusTag(p.day.status)}${note ? `<div class="att__note">${esc(note.note)}</div>` : ''}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="5">${esc(t(T.noStaff))}</td></tr>`;

  $('#teamRange').innerHTML = teamData.staff.length
    ? teamData.staff.map((p) => {
        const s = p.summary;
        const short = shortDayCount(p);
        return `
          <tr>
            <td>${esc(teamLabel(p))}</td>
            <td class="num">${s.daysWorked}</td>
            <td class="num">${esc(hoursLabel(s.seconds))}</td>
            <td class="num">${esc(hoursLabel(s.expected))}</td>
            <td class="num ${s.balance >= 0 ? 'is-pos' : 'is-neg'}">${esc(signed(s.balance))}</td>
            <td class="num ${short ? 'is-neg' : ''}">${short}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="6">${esc(t(T.noStaff))}</td></tr>`;
}

async function loadTeam(overrideDate) {
  if (!me || !me.admin) return;
  const qs = new URLSearchParams({ days: $('#teamDays').value || '7' });
  /* No date parameter on the first load: the server knows what "today" is in
     Cairo, and the browser — which may be in another timezone entirely —
     does not. Its answer comes back and fills the picker. */
  const date = overrideDate !== undefined ? overrideDate : $('#teamDate').value;
  if (date) qs.set('date', date);

  try {
    teamData = await api('/api/attendance/team?' + qs.toString());
    $('#teamErr').hidden = true;
    renderTeam();
  } catch (err) {
    $('#teamErr').textContent = err.display || err.message;
    $('#teamErr').hidden = false;
  }
}

$('#teamDate').addEventListener('change', () => loadTeam());
$('#teamDays').addEventListener('change', () => loadTeam());
$('#teamToday').addEventListener('click', () => loadTeam(''));

/* =========================================================================
   6. PERFORMANCE — how the shop is doing

   Business numbers, not web analytics. Page views and ad attribution live in
   the Meta pixel, which does that properly; this answers what the pixel
   cannot — what happened to the orders once they arrived.
   ========================================================================= */
function pct(n) {
  if (n === null || n === undefined) return '';
  const s = n >= 0 ? '+' : '−';
  return ` ${s}${Math.abs(n)}%`;
}

function statTile(label, value, cls) {
  return `<div class="stat"><span class="stat__k">${esc(label)}</span><span class="stat__v ${cls || ''}">${esc(value)}</span></div>`;
}

/* A bar per day, drawn with divs. A charting library for twelve bars would
   be a bigger download than the whole page. */
function renderSpark(daily) {
  const box = $('#perfSpark');
  if (!daily.length) {
    box.innerHTML = `<p class="card__note">${esc(t(T.noData))}</p>`;
    $('#perfSparkNote').textContent = '';
    return;
  }
  const max = Math.max(...daily.map((d) => d.orders), 1);
  box.innerHTML = daily.map((d) => {
    const h = Math.max(4, Math.round((d.orders / max) * 100));
    const title = `${d.day} — ${d.orders} ${t(T.ordersWord)} · ${money(d.revenue)} ${currency()}`;
    return `<div class="spark__bar" style="height:${h}%" title="${esc(title)}"><span>${d.orders}</span></div>`;
  }).join('');
  const busiest = daily.slice().sort((a, b) => b.orders - a.orders)[0];
  $('#perfSparkNote').textContent =
    `${t(T.busiest)}: ${localDate(busiest.day + 'T12:00:00Z')} — ${busiest.orders} ${t(T.ordersWord)}`;
}

/* Every block below is rendered through this.

   The panel used to be one straight run of assignments, which meant the FIRST
   missing field took every block after it with it: `d.traffic.totalEvents` on
   a response with no `traffic` key threw, and the tab rendered its headline
   stats and then simply stopped — no error, no empty state, just nothing.
   That is the worst way for a dashboard to fail, because it looks like the
   numbers are zero rather than like something is broken.

   One try/catch per block means a section that cannot render says so and the
   other nine still work. `safe()` supplies the shape each block expects, so
   an older or partial /api/admin/stats response degrades to empty states
   instead of a blank tab. */
function perfBlock(id, render) {
  const node = $(id);
  if (!node) return;
  try {
    render(node);
  } catch (err) {
    console.error('perf block failed', id, err && err.message);
    node.innerHTML = `<p class="card__note is-bad">${esc(t(T.noData))}</p>`;
  }
}

/* Defaults for every section this panel reads, so a missing key is an empty
   state rather than a thrown TypeError. */
function perfShape(d) {
  const o = d || {};
  return {
    orders: Object.assign(
      { revenue: 0, count: 0, average: 0, customers: 0, unnotified: 0, cancelled: 0, change: {} },
      o.orders
    ),
    today: Object.assign({ orders: 0, revenue: 0 }, o.today),
    traffic: Object.assign(
      { totalEvents: 0, uniqueVisitors: 0, pageViews: 0, searches: 0, addToCart: 0, checkoutStarted: 0, purchases: 0 },
      o.traffic
    ),
    marketing: Object.assign({ pixelConfigured: false, eventBreakdown: [] }, o.marketing),
    accounts: Object.assign({ total: 0, created: 0, subscribed: 0 }, o.accounts),
    newsletter: Object.assign({ total: 0, unsubscribed: 0 }, o.newsletter),
    staff: Object.assign({ onShift: 0 }, o.staff),
    statuses: o.statuses || [],
    paymentStatuses: o.paymentStatuses || [],
    governorates: o.governorates || [],
    daily: o.daily || [],
    topProducts: o.topProducts || []
  };
}

function renderPerf() {
  if (!perfData) return;
  const d = perfShape(perfData);

  perfBlock('#perfHeadline', (n) => {
    n.innerHTML = [
      statTile(t(T.revenue), `${money(d.orders.revenue)} ${currency()}`),
      statTile(t(T.ordersWord), String(d.orders.count)),
      statTile(t(T.avgOrder), `${money(d.orders.average)} ${currency()}`),
      statTile(t(T.customersWord), String(d.orders.customers)),
      statTile(t(T.todayWord), `${d.today.orders} · ${money(d.today.revenue)} ${currency()}`)
    ].join('');
  });

  perfBlock('#perfTraffic', (n) => {
    n.innerHTML = [
      statTile(t(T.trafficWord), String(d.traffic.totalEvents)),
      statTile(t(T.visitorsWord), String(d.traffic.uniqueVisitors)),
      statTile(t(T.pageViews), String(d.traffic.pageViews)),
      statTile(t(T.searchesWord), String(d.traffic.searches)),
      statTile(t(T.addToCartWord), String(d.traffic.addToCart)),
      statTile(t(T.checkoutWord), String(d.traffic.checkoutStarted)),
      statTile(t(T.purchasesWord), String(d.traffic.purchases))
    ].join('');
  });

  perfBlock('#perfMarketing', (n) => {
    n.innerHTML = [
      statTile(t(T.pixelStatus), d.marketing.pixelConfigured ? 'OK' : 'OFF'),
      statTile(t(T.marketingWord), String(d.marketing.eventBreakdown.length))
    ].join('');
  });

  perfBlock('#perfEvents', (n) => {
    n.innerHTML = d.marketing.eventBreakdown.length
      ? d.marketing.eventBreakdown.map((row) => `
          <tr><td>${esc(row.event)}</td><td class="num">${row.n}</td></tr>`).join('')
      : `<tr><td colspan="2">${esc(t(T.noData))}</td></tr>`;
  });

  /* Events by product — "3 views of the Imou 3MP, 2 purchases of the UNV 2MP".

     The columns are derived from the events actually present rather than
     hard-coded, so adding an event to track.js makes a column appear here
     with no change to this function or to account.html. EVENT_ORDER just
     fixes the funnel order for the ones we know; anything new lands after
     them in whatever order it arrives. */
  perfBlock('#perfProductEvents', (body) => {
    const rows = d.marketing.productEvents || [];
    const head = $('#perfProductEventsHead');

    if (!rows.length) {
      if (head) head.innerHTML = `<th data-en="Product">المنتج</th>`;
      body.innerHTML = `<tr><td>${esc(t(T.noData))}</td></tr>`;
      return;
    }

    const EVENT_ORDER = ['ViewContent', 'Search', 'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase'];
    const present = new Set();
    rows.forEach((r) => Object.keys(r.events || {}).forEach((k) => present.add(k)));
    const cols = EVENT_ORDER.filter((e) => present.has(e))
      .concat(Array.from(present).filter((e) => EVENT_ORDER.indexOf(e) < 0).sort());

    if (head) {
      head.innerHTML = `<th>${esc(t(T.productWord))}</th>` +
        cols.map((c) => `<th class="num">${esc(t(T['ev_' + c] || { ar: c, en: c }))}</th>`).join('') +
        `<th class="num">${esc(t(T.totalWord))}</th>`;
    }

    body.innerHTML = rows.map((r) => `
      <tr>
        <td><b>${esc(r.name || r.id)}</b><div class="att__note" dir="ltr">${esc(r.id)}</div></td>
        ${cols.map((c) => `<td class="num">${Number(r.events[c] || 0)}</td>`).join('')}
        <td class="num"><b>${Number(r.total || 0)}</b></td>
      </tr>`).join('');
  });

  perfBlock('#perfCompare', (n) => {
    const c = d.orders.change || {};
    n.textContent = (c.orders === null || c.orders === undefined) && (c.revenue === null || c.revenue === undefined)
      ? t(T.noCompare)
      : `${t(T.vsPrevious)}: ${t(T.ordersWord)}${pct(c.orders)} · ${t(T.revenue)}${pct(c.revenue)}`;
  });

  perfBlock('#perfSpark', () => renderSpark(d.daily));

  perfBlock('#perfProducts', (n) => {
    n.innerHTML = d.topProducts.length
      ? d.topProducts.map((p) => `
          <tr><td>${esc(p.name || p.id)}</td>
              <td class="num">${p.qty}</td>
              <td class="num">${money(p.value)} ${esc(currency())}</td></tr>`).join('')
      : `<tr><td colspan="3">${esc(t(T.noData))}</td></tr>`;
  });

  perfBlock('#perfGovs', (n) => {
    n.innerHTML = d.governorates.length
      ? d.governorates.map((g) => `
          <tr><td>${esc(g.name)}</td>
              <td class="num">${g.n}</td>
              <td class="num">${money(g.value)} ${esc(currency())}</td></tr>`).join('')
      : `<tr><td colspan="3">${esc(t(T.noData))}</td></tr>`;
  });

  perfBlock('#perfStatuses', (n) => {
    n.innerHTML = d.statuses.length
      ? d.statuses.map((s) => statTile(t(T['o_' + s.status] || T.o_new), `${s.n}`)).join('')
      : `<p class="card__note">${esc(t(T.noData))}</p>`;
  });

  /* Paid, waiting, failed — each with what it is worth. The count alone
     understates the one that matters: nine unpaid orders is a number, nine
     unpaid orders holding 40,000 EGP is the afternoon's work. */
  perfBlock('#perfPayments', (n) => {
    n.innerHTML = d.paymentStatuses.length
      ? d.paymentStatuses.map((s) => statTile(
          t(T['pay_' + s.status] || T.pay_pending),
          `${s.n} · ${money(s.value)} ${currency()}`,
          s.status === 'paid' ? 'is-pos' : (s.status === 'failed' ? 'is-neg' : '')
        )).join('')
      : `<p class="card__note">${esc(t(T.noData))}</p>`;
  });

  /* Health. The one number here that is an alarm rather than a metric. */
  perfBlock('#perfHealth', (health) => {
    const bad = d.orders.unnotified > 0;
    health.textContent = bad
      ? `${t(T.alertsFailed)}: ${d.orders.unnotified}`
      : t(T.allDelivered);
    health.classList.toggle('is-bad', bad);
    health.classList.toggle('is-good', !bad);
  });

  perfBlock('#perfSecondary', (n) => {
    n.innerHTML = [
      statTile(t(T.alertsNotDelivered), String(d.orders.unnotified), d.orders.unnotified ? 'is-neg' : 'is-pos'),
      statTile(t(T.cancelledWord), String(d.orders.cancelled)),
      statTile(t(T.accountsWord), `${d.accounts.total} (+${d.accounts.created})`),
      statTile(t(T.mailingList), String(d.newsletter.total - d.newsletter.unsubscribed)),
      statTile(t(T.onShiftNow), String(d.staff.onShift))
    ].join('');
  });
}

async function loadPerf() {
  if (!me || !me.admin) return;
  try {
    perfData = await api('/api/admin/stats?days=' + ($('#perfDays').value || '30'));
    $('#perfErr').hidden = true;
    renderPerf();
  } catch (err) {
    $('#perfErr').textContent = err.display || err.message;
    $('#perfErr').hidden = false;
  }
}

$('#perfDays').addEventListener('change', () => loadPerf());

/* =========================================================================
   7. MANAGE — the administrator's write operations

   Every button here posts to /api/admin/manage, which re-checks that the
   caller is an administrator. Nothing is trusted because a tab was visible.

   The two irreversible actions — deleting an order, terminating a person —
   confirm by saying what will actually be lost, rather than asking "are you
   sure?". A confirmation nobody reads is not a safeguard.
   ========================================================================= */
function mSay(msg, bad) {
  const ok = $('#mOk'), err = $('#mErr');
  ok.hidden = true; err.hidden = true;
  const el = bad ? err : ok;
  el.textContent = msg;
  el.hidden = false;
}

function manageCall(payload) {
  return api('/api/admin/manage', { body: payload });
}

function roleLabel(u) {
  return u.admin ? t(T.mAdminRow) : (u.role === 'staff' ? t(T.mStaffRow) : t(T.mCustRow));
}

const ORDER_STATES = ['new', 'confirmed', 'shipped', 'done', 'cancelled'];
/* Replaced by the list /api/admin/manage sends with the orders, for the same
   reason the leads board fills its dropdowns from the server: the options
   offered and the values accepted then cannot drift apart. What is written
   here is only the fallback for an answer that arrives without one. */
let payStates = ['pending', 'paid', 'failed'];

function renderOrders(orders) {
  $('#mOrders').innerHTML = orders.length ? orders.map(function (o) {
    const opts = ORDER_STATES.map(function (st) {
      return `<option value="${esc(st)}"${st === o.status ? " selected" : ""}>${esc(t(T["o_" + st] || T.o_new))}</option>`;
    }).join("");
    /* An order written before payment states existed has no value in the
       column; it reads as 'pending', which is what the migration set it to
       and what the row honestly is until somebody says otherwise. */
    const pay = o.payment_status || 'pending';
    const payOpts = payStates.map(function (st) {
      return `<option value="${esc(st)}"${st === pay ? " selected" : ""}>${esc(t(T["pay_" + st] || T.pay_pending))}</option>`;
    }).join("");
    return `
      <tr>
        <td><b dir="ltr">${esc(o.id)}</b><div class="att__note">${esc(localDate(o.created_at))}${o.notified ? "" : " · ⚠"}</div></td>
        <td>${esc(o.name)}<div class="att__note" dir="ltr">${esc(o.phone)}</div></td>
        <td class="num">${money(o.total)} ${esc(currency())}</td>
        <td><select class="m-status" data-id="${esc(o.id)}">${opts}</select></td>
        <td><select class="m-pay is-pay-${esc(pay)}" data-id="${esc(o.id)}">${payOpts}</select></td>
        <td><button class="btn btn--ghost btn--sm m-del" type="button" data-id="${esc(o.id)}">${esc(t(T.mDelete))}</button></td>
      </tr>`;
  }).join("") : `<tr><td colspan="6">${esc(t(T.mNone))}</td></tr>`;
}

function renderUsers(users) {
  $('#mUsers').innerHTML = users.length ? users.map(function (u) {
    /* No terminate button for an administrator: the API refuses it, and a
       button that always errors is worse than no button. */
    const term = u.admin ? "" : `<button class="btn btn--ghost btn--sm m-term" type="button" data-id="${esc(u.id)}" data-name="${esc(u.name)}">${esc(t(T.mTerminate))}</button>`;
    return `
      <tr>
        <td>${esc(u.name)}<div class="att__note" dir="ltr">${esc(u.email)}</div></td>
        <td>${esc(roleLabel(u))}</td>
        <td class="num">${u.last_login_at ? esc(localDate(u.last_login_at)) : esc(t(T.mNever))}</td>
        <td><button class="btn btn--ghost btn--sm m-reset" type="button" data-email="${esc(u.email)}">${esc(t(T.mReset))}</button> ${term}</td>
      </tr>`;
  }).join("") : `<tr><td colspan="4">${esc(t(T.mNone))}</td></tr>`;
}

async function loadManage() {
  if (!me || !me.admin) return;
  try {
    const oq = encodeURIComponent($('#mOrderQ').value.trim());
    const uq = encodeURIComponent($('#mUserQ').value.trim());
    const both = await Promise.all([
      api('/api/admin/manage?entity=orders&q=' + oq),
      api('/api/admin/manage?entity=users&q=' + uq)
    ]);
    if (Array.isArray(both[0].paymentStatuses) && both[0].paymentStatuses.length) {
      payStates = both[0].paymentStatuses;
    }
    renderOrders(both[0].orders);
    renderUsers(both[1].users);
  } catch (err) {
    mSay(err.display || err.message, true);
  }
}

/* Delegated: both tables are re-rendered after every change. */
$('#panelManage').addEventListener('change', async function (e) {
  const sel = e.target.closest('.m-status');
  const pay = e.target.closest('.m-pay');
  if (sel) {
    try {
      await manageCall({ entity: 'order', action: 'status', id: sel.dataset.id, status: sel.value });
      mSay(t(T.mSaved));
    } catch (err) { mSay(err.display || err.message, true); loadManage(); }
    return;
  }
  if (pay) {
    try {
      await manageCall({ entity: 'order', action: 'payment', id: pay.dataset.id, paymentStatus: pay.value });
      /* Recolour in place rather than reloading the table: an administrator
         working down a list of transfers changes several of these in a row,
         and re-rendering underneath them loses their scroll position. */
      pay.className = 'm-pay is-pay-' + pay.value;
      mSay(t(T.paySaved));
    } catch (err) { mSay(err.display || err.message, true); loadManage(); }
  }
});

$('#mPasswordForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  $('#mPasswordErr').hidden = true;
  $('#mPasswordOk').hidden = true;
  const btn = $('#mPasswordBtn');
  busy(btn, t(T.directPasswordSet));
  try {
    const email = $('#mSetEmail').value.trim();
    const password = $('#mSetPassword').value;
    checkPassword(password);
    const r = await manageCall({ entity: 'user', action: 'password', email, password });
    $('#mSetPassword').value = '';
    mSay(r.updated ? t(T.directPasswordUpdate) : t(T.mNotReg), !r.updated);
  } catch (err) {
    showFormError('#mPasswordErr', err);
  } finally {
    unbusy(btn, t(T.directPasswordSet));
  }
});

$('#panelManage').addEventListener('click', async function (e) {
  const del = e.target.closest('.m-del');
  const reset = e.target.closest('.m-reset');
  const term = e.target.closest('.m-term');

  if (del) {
    if (!confirm(t(T.mConfirmDel))) return;
    try {
      await manageCall({ entity: 'order', action: 'delete', id: del.dataset.id, confirm: true });
      mSay(t(T.mSaved)); loadManage();
    } catch (err) { mSay(err.display || err.message, true); }
    return;
  }

  if (reset) {
    try {
      const r = await manageCall({ entity: 'user', action: 'reset', email: reset.dataset.email });
      mSay(r.sent ? t(T.mResetSent) : t(T.mNotReg), !r.sent);
    } catch (err) { mSay(err.display || err.message, true); }
    return;
  }

  if (term) {
    if (!confirm(t(T.mConfirmTerm).replace('{name}', term.dataset.name))) return;
    try {
      await manageCall({ entity: 'user', action: 'terminate', id: term.dataset.id, confirm: true });
      mSay(t(T.mSaved)); loadManage();
    } catch (err) { mSay(err.display || err.message, true); }
  }
});

$('#mCreateForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  $('#mCreateErr').hidden = true;
  const btn = $('#mCreateBtn');
  busy(btn, t(T.saving));
  try {
    await manageCall({
      entity: 'user', action: 'create',
      email: $('#mNewEmail').value, name: $('#mNewName').value, phone: $('#mNewPhone').value
    });
    $('#mNewEmail').value = ''; $('#mNewName').value = ''; $('#mNewPhone').value = '';
    mSay(t(T.mCreated));
    loadManage();
  } catch (err) {
    showFormError('#mCreateErr', err);
  } finally {
    unbusy(btn, t(T.create));
  }
});

/* Search re-queries the server rather than filtering what is on screen: the
   list is capped, so filtering locally would only ever search the first
   page of it. */
function manageSearch() {
  clearTimeout(manageDebounce);
  manageDebounce = setTimeout(loadManage, 250);
}
$('#mOrderQ').addEventListener('input', manageSearch);
$('#mUserQ').addEventListener('input', manageSearch);
$('#mOrderRefresh').addEventListener('click', function () { loadManage(); });

/* =========================================================================
   8. CATALOGUE — products in D1

   Reads and writes /api/admin/catalog. The shop itself still prices from
   public/catalog.js, so the banner at the top of the tab says so: an
   administrator who changes a price here and then cannot find the change in
   the shop should be told why, not left to work it out.
   ========================================================================= */
function cSay(msg, bad) {
  const ok = $('#cOk'), err = $('#cErr');
  ok.hidden = true; err.hidden = true;
  const el = bad ? err : ok;
  el.textContent = msg; el.hidden = false;
}

function catName(id) {
  const c = (catalogData && catalogData.categories || []).find(function (x) { return x.id === id; });
  return c ? t(c) : id;
}

function renderCatalog() {
  if (!catalogData) return;
  $('#cNotice').textContent = t(T.cNotice);
  $('#cNotice').classList.add('is-bad');

  const q = $('#cQ').value.trim().toLowerCase();
  const list = catalogData.products.filter(function (p) {
    if (!q) return true;
    return ((p.name || '') + ' ' + (p.id || '') + ' ' + (p.brand || '')).toLowerCase().indexOf(q) >= 0;
  });

  $('#cRows').innerHTML = list.length ? list.map(function (p) {
    return `
      <tr>
        <td class="c-thumb-cell">
          ${p.img ? `<img class="c-thumb" src="${esc(thumbSrc(p))}" alt="${esc(p.name)}" loading="lazy">` : `<span class="c-thumb c-thumb--empty">${esc(t(T.cNone))}</span>`}
        </td>
        <td><b>${esc(p.name)}</b><div class="att__note" dir="ltr">${esc(p.id)}${p.brand ? " · " + esc(p.brand) : ""}</div></td>
        <td>${esc(catName(p.cat))}</td>
        <td class="num">${money(p.price)} ${esc(currency())}${p.was ? `<div class="att__note"><s>${money(p.was)}</s></div>` : ""}</td>
        <td><button class="btn btn--ghost btn--sm c-toggle" type="button" data-id="${esc(p.id)}" data-active="${p.active ? 1 : 0}">${esc(p.active ? t(T.cShown) : t(T.cHidden))}</button></td>
        <td>
          <button class="btn btn--ghost btn--sm c-edit" type="button" data-id="${esc(p.id)}">${esc(t(T.cEdit))}</button>
          <button class="btn btn--ghost btn--sm c-del" type="button" data-id="${esc(p.id)}" data-name="${esc(p.name)}">${esc(t(T.mDelete))}</button>
        </td>
      </tr>`;
  }).join("") : `<tr><td colspan="6">${esc(t(T.cNone))}</td></tr>`;
}

async function loadCatalog() {
  if (!me || !me.admin) return;
  try {
    catalogData = await api('/api/admin/catalog');
    const sel = $('#cCat');
    sel.innerHTML = catalogData.categories.map(function (c) {
      return `<option value="${esc(c.id)}">${esc(t(c))}</option>`;
    }).join("");
    renderCatalog();
  } catch (err) {
    cSay(err.display || err.message, true);
  }
}

let previewUrl = null;

/* Removing an image has to be sent as its own instruction, not inferred from
   an empty img field. The server keeps whatever is already stored unless it
   is told otherwise — that is what stops a form round-trip from silently
   dropping a picture — so "remove" needs a flag of its own. */
let imageRemoved = false;

function revokePreviewUrl() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

/* Uploaded images keep the same URL when they are replaced, and are served
   with a short cache rather than an immutable one (see
   functions/assets/products/[[path]].js). In the shop that is exactly right.
   In the admin it is not: the whole point of the screen is to look at the
   image you just changed. updated_at changes on every save, so it is a free
   cache key. */
/* The chosen filename, next to our own picker button. It replaces the text
   the native control used to print for itself, which was English on an Arabic
   page and untranslatable — see the note in account.html.

   No data-en on the span: site.js would overwrite it with the attribute on
   every language switch and wipe out whichever file is actually selected. The
   text is set from here instead, and re-set from the onLang hook. */
function renderFileName() {
  const el = $('#cImgName');
  if (!el) return;
  const input = $('#cImgFile');
  const file = input && input.files && input.files[0];
  el.textContent = file ? file.name : t(T.noFile);
  el.classList.toggle('is-set', !!file);
}

function thumbSrc(p) {
  if (!p.img) return '';
  if (/^(data|https?):/i.test(p.img)) return p.img;
  return p.img + (p.updated_at ? '?t=' + encodeURIComponent(p.updated_at) : '');
}

function updateImagePreview(src) {
  const preview = $('#cImgPreview');
  const hidden = $('#cImgHidden');
  if (!src) {
    revokePreviewUrl();
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute('src');
    }
    if (hidden) hidden.value = '';
    return;
  }
  if (preview) {
    preview.src = src;
    preview.hidden = false;
  }
}

function openEditor(product) {
  const p = product || {};
  $('#cEditorCard').hidden = false;
  $('#cEditorTitle').textContent = product ? t(T.cEditT) : t(T.cNewT);
  /* The id is the key past orders reference, so it is fixed once created. */
  $('#cId').value = p.id || '';
  $('#cId').disabled = !!product;
  $('#cCat').value = p.cat || (catalogData.categories[0] && catalogData.categories[0].id);
  $('#cName').value = p.name || '';
  $('#cBrand').value = p.brand || '';
  $('#cPrice').value = p.price === undefined ? '' : p.price;
  $('#cWas').value = p.was || 0;
  $('#cAr').value = p.ar || '';
  $('#cEn').value = p.en || '';
  $('#cImgFile').value = '';
  imageRemoved = false;
  renderFileName();
  const hidden = $('#cImgHidden');
  if (hidden) hidden.value = p.img || '';
  updateImagePreview(p.img ? thumbSrc(p) : '');
  $('#cActive').checked = product ? !!p.active : true;
  $('#cFormErr').hidden = true;
  $('#cEditorCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

$('#cNew').addEventListener('click', function () { openEditor(null); });
$('#cCancel').addEventListener('click', function () {
  $('#cEditorCard').hidden = true;
  $('#cImgFile').value = '';
  imageRemoved = false;
  renderFileName();
  revokePreviewUrl();
  const preview = $('#cImgPreview');
  if (preview) preview.hidden = true;
  const hidden = $('#cImgHidden');
  if (hidden) hidden.value = '';
});
$('#cRefresh').addEventListener('click', function () { loadCatalog(); });
$('#cQ').addEventListener('input', function () {
  clearTimeout(catalogDebounce);
  catalogDebounce = setTimeout(renderCatalog, 200);
});

/* =========================================================================
   8b. THE TWO SPREADSHEET DOWNLOADS

   /api/admin/export answers a real .xlsx. Both buttons come through here.

   WHY THIS IS A fetch() AND A BLOB, NOT href ON A LINK
   ---------------------------------------------------
   A plain navigation is one line and it is the wrong line. The endpoint can
   answer 403 (session expired in another tab) or 429 (rate limited), and a
   navigation renders that JSON as a page — the administrator loses the panel
   they were on and gets a wall of braces instead of a message. Reading the
   response here means an error lands in the panel's own error line, next to
   the button that was pressed.

   It also lets the row count and the feed warnings — which travel as headers,
   because a header cannot ride on a download otherwise — actually be shown.
   ========================================================================= */
async function downloadXlsx(kind, btn, say) {
  const label = btn.textContent;
  busy(btn, t(T.xBusy));
  try {
    const res = await fetch(`/api/admin/export?kind=${encodeURIComponent(kind)}`, {
      credentials: 'same-origin'
    });

    if (!res.ok) {
      /* The error path is JSON; the success path is a spreadsheet. Reading
         the body as text first means a proxy returning HTML does not throw a
         parse error on top of the real failure. */
      const text = await res.text();
      let message = text;
      try { message = (JSON.parse(text) || {}).message || text; } catch (e) {}
      throw new Error(message || `Export failed (${res.status}).`);
    }

    const rows = Number(res.headers.get('x-vg-rows') || 0);

    /* Percent-encoded on the way out — see the comment in the route. A header
       is latin-1 as far as any reader is concerned, and the em dash in the
       SVG warning came through as "â" until this was added. */
    let warnings = '';
    try {
      warnings = decodeURIComponent(res.headers.get('x-vg-warnings') || '');
    } catch (e) {
      warnings = res.headers.get('x-vg-warnings') || '';
    }

    /* Content-Disposition is on the response but unreachable from script —
       it is not a CORS-safelisted header and this is a same-origin fetch, so
       rather than depend on that, the name is rebuilt from the same parts the
       server used. */
    const stamp = new Date().toISOString().slice(0, 10);
    const name = kind === 'catalog'
      ? `VG_Meta_Catalog_${stamp}.xlsx`
      : `VG_Meta_Data_${stamp}.xlsx`;

    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Revoked on the next tick, not immediately: Safari has not finished
       reading the blob when click() returns. */
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    if (warnings) say(t(T.xWarn).replace('{list}', warnings), true);
    else if (rows) say(t(T.xDone).replace('{n}', String(rows)));
    else say(t(T.xEmpty));
  } catch (err) {
    say(err.display || err.message, true);
  } finally {
    unbusy(btn, label);
  }
}

/* =========================================================================
   8c. CATEGORIES — how the product groups are presented

   The homepage cards and the shop's filter chips, both drawn from the same
   rows. This tab owns the labels, the blurbs, the cover picture, the order
   and the visibility. It does NOT own which products are in a group — that
   is the product's own Category field one tab across, and keeping it there
   means one fact in one place.

   HIDING IS NOT WITHDRAWING, and the copy says so in both languages because
   the distinction is the whole reason `active` exists here. Hiding a
   category removes its card and its chip; every product in it stays on sale
   and stays reachable by search and by direct link. Withdrawing a product is
   a separate act with its own switch.
   ========================================================================= */
function gSay(msg, bad) {
  const ok = $('#gOk'), err = $('#gErr');
  ok.hidden = true; err.hidden = true;
  const el = bad ? err : ok;
  el.textContent = msg; el.hidden = false;
}

function renderCategories() {
  if (!categoryData) return;
  const rows = categoryData.categories || [];

  $('#gRows').innerHTML = rows.length ? rows.map(function (c) {
    const cover = (categoryData.products || []).find(function (p) { return p.id === c.cover; });
    const img = (cover && cover.img) || c.img || '';
    /* The count is why delete can refuse: a category with products in it
       cannot be removed without orphaning them. */
    const count = Number(c.products) || 0;
    return `
      <tr${c.active ? '' : ' class="is-off"'}>
        <td class="c-thumb-cell">${img
          ? `<img class="c-thumb" src="${esc(img)}" alt="" loading="lazy">`
          : `<span class="c-thumb--empty">${esc(t(T.gNoCover))}</span>`}</td>
        <td>
          <b>${esc(t(c))}</b>
          <div class="att__note" dir="ltr">${esc(c.id)}${c.cover ? ' · ' + esc(c.cover) : ''}</div>
        </td>
        <td class="num">${count}</td>
        <td class="num">${Number(c.sort) || 0}</td>
        <td>${c.active ? esc(t(T.cShown)) : esc(t(T.cHidden))}</td>
        <td>
          <button class="btn btn--ghost btn--sm g-edit" type="button" data-id="${esc(c.id)}">${esc(t(T.cEdit))}</button>
          <button class="btn btn--ghost btn--sm g-tog" type="button" data-id="${esc(c.id)}" data-active="${c.active ? '1' : '0'}">${c.active ? esc(t(T.gHide)) : esc(t(T.gShow))}</button>
          <button class="btn btn--ghost btn--sm g-del" type="button" data-id="${esc(c.id)}" data-name="${esc(t(c))}" data-count="${count}">${esc(t(T.mDelete))}</button>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="6">${esc(t(T.gNone))}</td></tr>`;
}

async function loadCategories() {
  if (!me || !me.admin) return;
  try {
    categoryData = await api('/api/admin/categories');
    renderCategories();
    /* Said once, on the load that did it. A database that predates the table
       is copied from the built-in list rather than opening on a blank tab. */
    if (categoryData.seeded) {
      gSay(t(T.gSeeded).replace('{n}', String(categoryData.seeded)));
    }
  } catch (err) {
    gSay(err.display || err.message, true);
  }
}

/* The cover list is filtered to the category being edited: a card advertising
   a group with a photograph of something from a different group is the exact
   mistake the server also refuses, and offering it here would be inviting it. */
function fillCoverOptions(catId, selected) {
  const sel = $('#gCover');
  const mine = (categoryData.products || []).filter(function (p) { return p.cat === catId; });
  sel.innerHTML = `<option value="">${esc(t(T.gNoCover))}</option>` + mine.map(function (p) {
    return `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`;
  }).join('');
}

function openCategoryEditor(cat) {
  const isNew = !cat;
  $('#gEditorTitle').textContent = t(isNew ? T.gNewT : T.gEditT);
  $('#gEditorCard').hidden = false;
  $('#gFormErr').hidden = true;

  $('#gId').value = cat ? cat.id : '';
  /* The id is a foreign key from every product row and a URL component, so
     it is fixed once the category exists. */
  $('#gId').disabled = !isNew;
  $('#gAr').value = cat ? cat.ar : '';
  $('#gEn').value = cat ? cat.en : '';
  $('#gBlurbAr').value = cat && cat.blurb ? cat.blurb.ar : '';
  $('#gBlurbEn').value = cat && cat.blurb ? cat.blurb.en : '';
  $('#gSort').value = cat ? (Number(cat.sort) || 0) : ((categoryData.categories || []).length * 10);
  $('#gActive').checked = cat ? !!cat.active : true;
  fillCoverOptions(cat ? cat.id : '', cat ? cat.cover : '');
  $('#gEditorCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('#gNew').addEventListener('click', function () { openCategoryEditor(null); });
$('#gRefresh').addEventListener('click', function () { loadCategories(); });
$('#gCancel').addEventListener('click', function () { $('#gEditorCard').hidden = true; });

/* A new category has no products yet, so its cover list is empty until one is
   assigned in the catalogue tab. Re-filling on id input keeps the list honest
   while somebody is typing a brand-new id. */
$('#gId').addEventListener('input', function () {
  if (!$('#gId').disabled) fillCoverOptions($('#gId').value.trim().toLowerCase(), $('#gCover').value);
});

$('#panelCategories').addEventListener('click', async function (e) {
  const ed = e.target.closest('.g-edit');
  if (ed) {
    const c = (categoryData.categories || []).find(function (x) { return x.id === ed.dataset.id; });
    if (c) openCategoryEditor(c);
    return;
  }

  const tog = e.target.closest('.g-tog');
  if (tog) {
    try {
      await api('/api/admin/categories', {
        body: { action: 'active', id: tog.dataset.id, active: tog.dataset.active !== '1' }
      });
      await loadCategories();
      gSay(t(T.cSaved));
    } catch (err) { gSay(err.display || err.message, true); }
    return;
  }

  const del = e.target.closest('.g-del');
  if (del) {
    const count = Number(del.dataset.count) || 0;
    /* Refused server-side too — this only saves the round trip and explains
       the alternative while the person is still looking at the row. */
    if (count > 0) {
      gSay(t(T.gInUse).replace('{n}', String(count)).replace('{name}', del.dataset.name), true);
      return;
    }
    if (!confirm(t(T.gDelConfirm).replace('{name}', del.dataset.name))) return;
    try {
      await api('/api/admin/categories', { body: { action: 'delete', id: del.dataset.id, confirm: true } });
      await loadCategories();
      gSay(t(T.cSaved));
    } catch (err) { gSay(err.display || err.message, true); }
  }
});

$('#gForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  $('#gFormErr').hidden = true;
  const btn = $('#gSave');
  busy(btn, t(T.saving));
  try {
    await api('/api/admin/categories', {
      body: {
        action: 'save',
        category: {
          id: $('#gId').value.trim().toLowerCase(),
          ar: $('#gAr').value,
          en: $('#gEn').value,
          blurbAr: $('#gBlurbAr').value,
          blurbEn: $('#gBlurbEn').value,
          cover: $('#gCover').value,
          sort: $('#gSort').value,
          active: $('#gActive').checked
        }
      }
    });
    $('#gEditorCard').hidden = true;
    await loadCategories();
    gSay(t(T.cSaved));
  } catch (err) {
    showFormError('#gFormErr', err);
  } finally {
    unbusy(btn, t(T.save));
  }
});

$('#cExport').addEventListener('click', function () {
  downloadXlsx('catalog', $('#cExport'), cSay);
});

$('#perfExport').addEventListener('click', function () {
  downloadXlsx('data', $('#perfExport'), function (msg, bad) {
    const ok = $('#perfOk'), err = $('#perfErr');
    ok.hidden = true; err.hidden = true;
    const el = bad ? err : ok;
    el.textContent = msg; el.hidden = false;
  });
});

$('#panelCatalog').addEventListener('click', async function (e) {
  const ed = e.target.closest('.c-edit');
  const del = e.target.closest('.c-del');
  const tog = e.target.closest('.c-toggle');

  if (ed) {
    const p = catalogData.products.find(function (x) { return x.id === ed.dataset.id; });
    if (p) openEditor(p);
    return;
  }

  if (tog) {
    try {
      await api('/api/admin/catalog', { body: { action: 'active', id: tog.dataset.id, active: tog.dataset.active !== '1' } });
      cSay(t(T.cSaved)); loadCatalog();
    } catch (err) { cSay(err.display || err.message, true); }
    return;
  }

  if (del) {
    if (!confirm(t(T.cDelConfirm).replace('{name}', del.dataset.name))) return;
    try {
      await api('/api/admin/catalog', { body: { action: 'delete', id: del.dataset.id, confirm: true } });
      cSay(t(T.cSaved)); $('#cEditorCard').hidden = true; loadCatalog();
    } catch (err) { cSay(err.display || err.message, true); }
  }
});

$('#cImgFile').addEventListener('change', function () {
  const file = this.files && this.files[0];
  if (!file) return;
  /* Picking a file after pressing remove is a change of mind, not both
     instructions at once. */
  imageRemoved = false;
  revokePreviewUrl();
  previewUrl = URL.createObjectURL(file);
  updateImagePreview(previewUrl);
  renderFileName();
});

$('#cImgRemove').addEventListener('click', function () {
  $('#cImgFile').value = '';
  imageRemoved = true;
  renderFileName();
  const hidden = $('#cImgHidden');
  if (hidden) hidden.value = '';
  updateImagePreview('');
});

$('#cForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  $('#cFormErr').hidden = true;
  const btn = $('#cSave');
  busy(btn, t(T.saving));
  try {
    const formData = new FormData();
    const hidden = $('#cImgHidden');
    formData.append('action', 'save');
    formData.append('id', $('#cId').value);
    formData.append('cat', $('#cCat').value);
    formData.append('name', $('#cName').value);
    formData.append('brand', $('#cBrand').value);
    formData.append('price', $('#cPrice').value);
    formData.append('was', $('#cWas').value);
    formData.append('ar', $('#cAr').value);
    formData.append('en', $('#cEn').value);
    formData.append('img', hidden ? hidden.value : '');
    formData.append('active', $('#cActive').checked ? '1' : '0');
    if (imageRemoved) formData.append('removeImage', '1');

    const file = $('#cImgFile').files && $('#cImgFile').files[0];
    if (file) formData.append('file', file);

    await api('/api/admin/catalog', { body: formData });
    $('#cEditorCard').hidden = true;
    cSay(t(T.cSaved));
    loadCatalog();
  } catch (err) {
    showFormError('#cFormErr', err);
  } finally {
    unbusy(btn, t({ ar: 'احفظ', en: 'Save' }));
  }
});

/* =========================================================================
   The seam.

   account.js holds the tab strip and the language hook; this module holds
   what those two need to reach. Exported as functions rather than as the
   internals so the panel state above stays owned here.
   ========================================================================= */

/* Called when a tab is opened. Unknown names are ignored rather than thrown
   on — the tab strip is markup, and a typo in it should cost one dead tab,
   not a broken page. */
/* =========================================================================
   PROMOS — codes for people you have not met, and a discount for one you have

   Two forms and a table. The split is the point: a CODE is a thing that gets
   forwarded, so it carries a window and a use limit; a discount on ONE order
   carries nothing, because there is nothing to hand out. An owner who wants
   to give a friend ten per cent should not have to invent a code, publish
   it, and remember to expire it.

   Every write goes to /api/admin/promos, which re-checks that the caller is
   an administrator. Nothing here is a security boundary.
   ========================================================================= */
function pmSay(msg, bad, okSel, errSel) {
  const ok = $(okSel || '#pmOk');
  const err = $(errSel || '#pmErr');
  ok.hidden = true; err.hidden = true;
  const el = bad ? err : ok;
  el.textContent = msg;
  el.hidden = false;
}

/* A <input type="datetime-local"> gives back local wall-clock with no zone.
   The server stores ISO, so the conversion happens here, once, rather than
   being guessed at either end. An empty box stays empty — that is "no
   bound", which is a real answer. */
function isoFromLocal(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString();
}

/* The window in words. A code with no bounds is the common case and should
   read as such rather than as two dashes. */
function windowLabel(p) {
  if (!p.startsAt && !p.endsAt) return t(T.pmAlways);
  const from = p.startsAt ? localDate(p.startsAt) : '—';
  const to = p.endsAt ? localDate(p.endsAt) : '—';
  return `${from} → ${to}`;
}

function renderPromos() {
  if (!promoData) return;
  const rows = promoData.promos || [];
  $('#pmRows').innerHTML = rows.length ? rows.map(function (p) {
    const off = p.percent > 0 ? `${p.percent}%` : `${money(p.amount)} ${currency()}`;
    const used = p.maxUses > 0 ? `${p.uses} / ${p.maxUses}` : String(p.uses);
    /* Live is not the same as active: a switched-on code whose window has
       closed is doing nothing, and the table should say which. */
    const now = Date.now();
    const started = !p.startsAt || Date.parse(p.startsAt) <= now;
    const ended = p.endsAt && Date.parse(p.endsAt) <= now;
    const usedUp = p.maxUses > 0 && p.uses >= p.maxUses;
    const state = !p.active ? T.pmOff : (!started ? T.pmSoon : (ended ? T.pmEnded : (usedUp ? T.pmUsedUp : T.pmLive)));
    return `
      <tr>
        <td><b dir="ltr">${esc(p.code)}</b>${p.note ? `<div class="att__note">${esc(p.note)}</div>` : ''}</td>
        <td class="num">${esc(off)}${p.minSubtotal > 0 ? `<div class="att__note">${esc(t(T.pmMinOver))} ${money(p.minSubtotal)}</div>` : ''}</td>
        <td>${esc(windowLabel(p))}<div class="att__note">${esc(t(state))}</div></td>
        <td class="num">${esc(used)}</td>
        <td>${esc(t(p.newOnly ? T.pmNewOnly : T.pmAnyone))}</td>
        <td>
          <button class="btn btn--ghost btn--sm pm-toggle" type="button" data-code="${esc(p.code)}" data-active="${p.active ? '1' : '0'}">${esc(t(p.active ? T.pmStop : T.pmStart))}</button>
          ${p.uses === 0 ? `<button class="btn btn--out btn--sm pm-del" type="button" data-code="${esc(p.code)}">${esc(t(T.mDelete))}</button>` : ''}
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="6">${esc(t(T.pmNone))}</td></tr>`;
}

async function loadPromos() {
  if (!me || !me.admin) return;
  try {
    promoData = await api('/api/admin/promos');
    renderPromos();
  } catch (err) {
    pmSay(err.display || err.message, true);
  }
}

$('#pmForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const btn = $('#pmCreate');
  busy(btn, t(T.saving));
  try {
    await api('/api/admin/promos', {
      body: {
        action: 'create',
        code: $('#pmCode').value,
        percent: Number($('#pmPercent').value) || 0,
        amount: Number($('#pmAmount').value) || 0,
        startsAt: isoFromLocal($('#pmStarts').value),
        endsAt: isoFromLocal($('#pmEnds').value),
        maxUses: Number($('#pmMaxUses').value) || 0,
        minSubtotal: Number($('#pmMin').value) || 0,
        newOnly: $('#pmNewOnly').checked,
        note: $('#pmNote').value
      }
    });
    pmSay(t(T.pmCreated).replace('{code}', $('#pmCode').value.trim().toUpperCase()));
    $('#pmForm').reset();
    $('#pmNewOnly').checked = true;
    loadPromos();
  } catch (err) {
    pmSay(err.display || err.message, true);
  } finally {
    unbusy(btn, t(T.pmCreate));
  }
});

$('#panelPromos').addEventListener('click', async function (e) {
  const toggle = e.target.closest('.pm-toggle');
  const del = e.target.closest('.pm-del');

  if (toggle) {
    try {
      await api('/api/admin/promos', {
        body: { action: 'update', code: toggle.dataset.code, active: toggle.dataset.active !== '1' }
      });
      loadPromos();
    } catch (err) { pmSay(err.display || err.message, true); }
    return;
  }

  if (del) {
    if (!confirm(t(T.pmDelConfirm).replace('{code}', del.dataset.code))) return;
    try {
      await api('/api/admin/promos', { body: { action: 'delete', code: del.dataset.code } });
      pmSay(t(T.mSaved));
      loadPromos();
    } catch (err) { pmSay(err.display || err.message, true); }
  }
});

/* ---- a discount on one order, for somebody the owner knows ---- */
$('#pmOrderForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const btn = $('#pmOrderApply');
  busy(btn, t(T.saving));
  try {
    const r = await api('/api/admin/promos', {
      body: {
        action: 'discount-order',
        orderId: $('#pmOrderId').value,
        percent: Number($('#pmOrderPercent').value) || 0,
        amount: Number($('#pmOrderAmount').value) || 0
      }
    });
    pmSay(
      t(T.pmOrderDone)
        .replace('{off}', `${money(r.order.discount)} ${currency()}`)
        .replace('{total}', `${money(r.order.total)} ${currency()}`),
      false, '#pmOrderOk', '#pmOrderErr'
    );
    /* The orders table is showing a stale total now, if it is loaded. */
    if (me && me.admin) loadManage();
  } catch (err) {
    pmSay(err.display || err.message, true, '#pmOrderOk', '#pmOrderErr');
  } finally {
    unbusy(btn, t(T.pmOrderApply));
  }
});

/* =========================================================================
   AD CREATIVES — the images the campaigns are built from

   Every creative has a public URL under /assets/ads/, and copying that URL is
   the point of the whole tab: Ads Manager can build an ad from a URL, which
   turns six ads across two placements from a morning of uploading into one
   pass of pasting.

   The grid mixes two kinds and says which is which. The pack that ships with
   the site cannot be deleted from here — Pages uploads static assets at
   deploy time and no Worker can write to them — so those rows get no delete
   button rather than one that fails.
   ========================================================================= */
function adSay(msg, bad) {
  const ok = $('#adOk'), err = $('#adErr');
  ok.hidden = true; err.hidden = true;
  const el = bad ? err : ok;
  el.textContent = msg;
  el.hidden = false;
}

function renderAds() {
  if (!adData) return;
  const origin = adData.origin || '';
  const rows = adData.creatives || [];

  $('#adGrid').innerHTML = rows.length ? rows.map(function (c) {
    const url = `${origin}/${c.path}`;
    const dims = c.width && c.height ? `${c.width}×${c.height}` : '';
    const size = c.bytes ? `${Math.round(c.bytes / 1024)} KB` : '';
    const meta = [c.ratio, dims, size].filter(Boolean).join(' · ');
    /* The pack ships each 9:16 twice: the master as delivered, and a copy
       resampled to the size Meta recommends. The badge is what stops
       somebody building an ad from the smaller one by accident. */
    const best = c.variant === '1080';
    return `
      <figure class="adcard">
        <img class="adcard__img" src="/${esc(c.path)}" alt="${esc(c.title || c.name)}" loading="lazy">
        <figcaption class="adcard__body">
          <b class="adcard__name" dir="ltr">${esc(c.name)}</b>
          ${c.title ? `<span class="adcard__title">${esc(c.title)}</span>` : ''}
          <span class="adcard__meta">${esc(meta)}</span>
          <button class="adcard__url" type="button" data-copy="${esc(url)}" dir="ltr" title="${esc(t(T.adCopy))}">${esc(url)}</button>
          <span class="adcard__acts">
            <span class="tag tag--${c.source === 'upload' ? 'new' : 'contacted'}">${esc(t(c.source === 'upload' ? T.adUploaded : T.adShipped))}</span>
            ${best ? `<span class="tag tag--won">${esc(t(T.adBest))}</span>` : ''}
            ${c.source === 'upload'
              ? `<button class="btn btn--out btn--sm ad-del" type="button" data-name="${esc(c.name)}">${esc(t(T.mDelete))}</button>`
              : ''}
          </span>
        </figcaption>
      </figure>`;
  }).join('') : `<p class="card__note">${esc(t(T.adNone))}</p>`;
}

async function loadAds() {
  if (!me || !me.admin) return;
  try {
    adData = await api('/api/admin/ads');
    $('#adListErr').hidden = true;
    renderAds();
  } catch (err) {
    $('#adListErr').textContent = err.display || err.message;
    $('#adListErr').hidden = false;
  }
}

/* The chosen filename, shown next to the button — the input itself is
   clipped to a pixel so it stays keyboard-reachable, so without this nobody
   can tell whether their click registered. Same pattern as the catalogue. */
$('#adFile').addEventListener('change', function () {
  const file = this.files && this.files[0];
  $('#adFileName').textContent = file ? file.name : t(T.noFile);
});

$('#adForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const file = $('#adFile').files && $('#adFile').files[0];
  if (!file) return adSay(t(T.adPickFile), true);

  const btn = $('#adUpload');
  busy(btn, t(T.avUploading));
  try {
    /* multipart, because it carries a file — the same shape the catalogue
       editor posts. api() passes a FormData body through untouched. */
    const form = new FormData();
    form.append('action', 'upload');
    form.append('name', $('#adName').value);
    form.append('file', file);
    const r = await api('/api/admin/ads', { body: form });

    adSay(t(T.adUploaded2).replace('{name}', r.creative.name));
    $('#adForm').reset();
    $('#adFileName').textContent = t(T.noFile);
    loadAds();
  } catch (err) {
    adSay(err.display || err.message, true);
  } finally {
    unbusy(btn, t(T.adUpload));
  }
});

$('#panelAds').addEventListener('click', async function (e) {
  const copy = e.target.closest('[data-copy]');
  const del = e.target.closest('.ad-del');

  if (copy) {
    const url = copy.dataset.copy;
    try {
      await navigator.clipboard.writeText(url);
      toast(t(T.adCopied), 'good');
    } catch (err) {
      /* Clipboard access can be refused — over http, or by policy. Selecting
         the text is the fallback that always works. */
      const range = document.createRange();
      range.selectNodeContents(copy);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast(t(T.adCopyManual), 'warn');
    }
    return;
  }

  if (del) {
    if (!confirm(t(T.adDelConfirm).replace('{name}', del.dataset.name))) return;
    try {
      await api('/api/admin/ads', { body: { action: 'delete', name: del.dataset.name } });
      adSay(t(T.mSaved));
      loadAds();
    } catch (err) { adSay(err.display || err.message, true); }
  }
});

export function loadPanel(name) {
  if (name === 'team') return loadTeam();
  if (name === 'perf') return loadPerf();
  if (name === 'manage') return loadManage();
  if (name === 'catalog') return loadCatalog();
  if (name === 'categories') return loadCategories();
  if (name === 'promos') return loadPromos();
  if (name === 'ads') return loadAds();
}

/* Called on a language switch. Each panel is redrawn only if it holds data —
   the same conditions the hook in account.js used when this code lived there.
   `manageVisible` is passed in because the panel element belongs to that
   file's tab strip, and management re-reads from the server rather than
   re-rendering, because its rows are built from a live query. */
export function repaint(manageVisible) {
  renderFileName();
  if (teamData) renderTeam();
  if (perfData) renderPerf();
  if (manageVisible) loadManage();
  if (catalogData) renderCatalog();
  if (categoryData) renderCategories();
  if (promoData) renderPromos();
  if (adData) renderAds();
}

/* Called on sign-out. The DOM is torn down by the view switch; this drops the
   data behind it so a second sign-in on the same page cannot paint the
   previous administrator's numbers. */
export function reset() {
  teamData = null;
  perfData = null;
  catalogData = null;
  categoryData = null;
  promoData = null;
  adData = null;
}
