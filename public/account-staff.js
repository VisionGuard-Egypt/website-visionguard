/* =========================================================================
   Vision Guard — account-staff.js
   Notifications, internal messages, and leave.

   Loaded the same way account-admin.js is: a dynamic import from account.js,
   the first time a signed-in STAFF account needs it. A customer never fetches
   it, because none of it is theirs — and like the admin console, withholding
   the file is about not shipping code to people with no use for it, never
   about hiding anything. Every endpoint behind these screens re-checks the
   caller server-side.

   The admin half (the leave approval queue) lives here too rather than in
   account-admin.js, because it reads the same request shape and the same
   copy table as the employee half. Splitting them would mean two modules
   sharing a third.
   ========================================================================= */
import {
  $, $$, t, esc, api, toast, localDate, LANG
} from './site.js?v=66';
import { T, me, busy, unbusy, showFormError } from './account-shared.js?v=66';

/* Copy owned by this module. Kept separate from the shared T rather than
   added to it: these strings are only ever rendered by this file, and the
   whole point of the split is that a customer does not download them. */
const S = {
  noNotifs:     { ar: 'مافيش تنبيهات لسه.', en: 'Nothing yet.' },
  markRead:     { ar: 'علّم الكل كمقروء', en: 'Mark all read' },
  noMessages:   { ar: 'مافيش رسايل هنا.', en: 'Nothing here.' },
  sent:         { ar: 'اتبعتت.', en: 'Sent.' },
  sending:      { ar: 'جاري الإرسال…', en: 'Sending…' },
  send:         { ar: 'ابعت', en: 'Send' },
  from:         { ar: 'من', en: 'From' },
  to:           { ar: 'إلى', en: 'To' },
  allowance:    { ar: 'الرصيد السنوي', en: 'Annual allowance' },
  taken:        { ar: 'مستخدم', en: 'Used' },
  remaining:    { ar: 'المتبقي', en: 'Remaining' },
  days:         { ar: 'يوم', en: 'days' },
  policyNote:   {
    ar: 'رصيدك ١٤ يوم في السنة الميلادية. الأجازات الرسمية اللي جوه المدة بتتحسب من رصيدك. الإجازة المرضية مالهاش حد بس لازم شهادة.',
    en: 'You get 14 days per calendar year. Public holidays inside a requested range DO come out of your allowance. Sick leave is not capped but needs a certificate.'
  },
  willCost:     { ar: 'المدة دي هتحسب', en: 'This range costs' },
  including:    { ar: 'منهم أجازات رسمية', en: 'of them public holidays' },
  requestSent:  { ar: 'اتبعت الطلب. هيوصلك رد.', en: 'Request sent. You will be told the answer.' },
  noRequests:   { ar: 'مافيش طلبات لسه.', en: 'No requests yet.' },
  st_pending:   { ar: 'في الانتظار', en: 'Pending' },
  st_approved:  { ar: 'اتوافق عليها', en: 'Approved' },
  st_declined:  { ar: 'اترفضت', en: 'Declined' },
  st_cancelled: { ar: 'اتسحبت', en: 'Withdrawn' },
  k_vacation:   { ar: 'إجازة', en: 'Vacation' },
  k_sick:       { ar: 'مرضية', en: 'Sick leave' },
  withdraw:     { ar: 'اسحب الطلب', en: 'Withdraw' },
  confirmWithdraw: { ar: 'تسحب الطلب ده؟', en: 'Withdraw this request?' },
  approve:      { ar: 'وافق', en: 'Approve' },
  decline:      { ar: 'ارفض', en: 'Decline' },
  viewCert:     { ar: 'شوف الشهادة', en: 'View certificate' },
  noPending:    { ar: 'مافيش طلبات مستنية.', en: 'Nothing waiting.' },
  decisionNote: { ar: 'سبب (اختياري)', en: 'Reason (optional)' },
  ofAllowance:  { ar: 'من الرصيد', en: 'of allowance' },
  certOnly:     { ar: 'الشهادة تتفتح من الإدارة وصاحب الطلب بس.', en: 'Only the admin and the person who filed it can open the certificate.' }
};

const ts = (key) => t(S[key] || { ar: '', en: '' });

/* =========================================================================
   NOTIFICATIONS
   ========================================================================= */
let notifs = [];

const KIND_ICON = {
  clock_in: '🟢',
  clock_out: '🔴',
  order: '🛒',
  message: '✉️',
  leave_request: '📋',
  leave_decision: '✅'
};

function renderBell(unread) {
  const count = $('#bellCount');
  count.textContent = unread > 99 ? '99+' : String(unread);
  count.hidden = unread === 0;
  $('#bellBtn').classList.toggle('has-unread', unread > 0);

  $('#bellList').innerHTML = notifs.length
    ? notifs.map((n) => `
      <button class="notif${n.read ? '' : ' is-new'}" type="button" data-notif="${esc(n.id)}" data-link="${esc(n.link)}">
        <span class="notif__icon" aria-hidden="true">${KIND_ICON[n.kind] || '•'}</span>
        <span class="notif__body">
          <span class="notif__title">${esc(n.title)}</span>
          ${n.body ? `<span class="notif__note">${esc(n.body)}</span>` : ''}
          <span class="notif__when">${esc(localDate(n.createdAt))}</span>
        </span>
      </button>`).join('')
    : `<p class="card__note">${esc(ts('noNotifs'))}</p>`;
}

export async function loadNotifications() {
  try {
    const data = await api('/api/notifications');
    notifs = data.notifications || [];
    renderBell(data.unread || 0);
    /* The tab dots are driven from the same fetch rather than their own —
       one request on page load answers the bell and both badges. */
    $('#inboxDot').hidden = !notifs.some((n) => !n.read && n.kind === 'message');
    $('#leaveDot').hidden = !notifs.some((n) => !n.read && n.kind === 'leave_request');
    /* Anything new gets raised on the desktop too, if permission stands.
       Defined below; hoisted, so the order here is presentation not
       dependency. */
    surface();
  } catch (err) {
    /* A notification list that will not load must not break the dashboard
       behind it. */
    console.info('notifications unavailable', err && err.message);
  }
}

/* =========================================================================
   WHERE THE PANEL SITS

   It used to be position:absolute under the bell, which put it in the page
   rather than on the screen. The bell lives in the dashboard header, and the
   dashboard is long — so by the time anybody had scrolled down to the panel
   they wanted, opening the bell dropped a 60vh panel at the TOP of the
   document, out of sight. You had to scroll back up to read your own
   notifications, which is the opposite of what a notification is for.

   It is fixed to the viewport now and measured from the bell each time it
   opens, then clamped so it cannot hang off the bottom or past either edge.
   Measured rather than hard-coded for the same reasons promo.js measures:
   the header is not at the same height on every screen, the bell moves
   between breakpoints, and the whole thing has to read the same in Arabic
   and English.
   ========================================================================= */
const BELL_GAP = 8;      // between the bell and the panel
const BELL_EDGE = 12;    // smallest gap to any viewport edge

function placeBellPop() {
  const pop = $('#bellPop');
  const btn = $('#bellBtn');
  if (!pop || pop.hidden || !btn) return;

  const r = btn.getBoundingClientRect();
  if (!r.width && !r.height) return;

  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  /* If the bell itself has scrolled out of view, close rather than follow it.
     A panel anchored to a button nobody can see is either floating in the
     middle of the page with nothing to explain it, or — because it tracks the
     bell — sitting off-screen entirely, which is the original bug wearing a
     different hat. Every other dropdown on this site closes on an outside
     interaction; scrolling the anchor away is one. */
  if (r.bottom < 0 || r.top > vh) { closeBell(); return; }

  /* Height first: the panel is capped at 60vh in CSS, but the space actually
     below the bell can be less than that, and a panel taller than its room
     is exactly how the bottom of the list became unreachable. */
  const room = vh - r.bottom - BELL_GAP - BELL_EDGE;
  pop.style.setProperty('--bell-max', Math.max(180, Math.round(room)) + 'px');

  const w = pop.offsetWidth || 360;
  /* Aligned to the bell's inline-end edge, then pulled back if that would
     put it past the far edge — which is what happens on a narrow screen
     where the panel is nearly as wide as the viewport. */
  let left = r.right - w;
  left = Math.min(Math.max(BELL_EDGE, left), Math.max(BELL_EDGE, vw - w - BELL_EDGE));

  pop.style.setProperty('--bell-top', Math.round(r.bottom + BELL_GAP) + 'px');
  pop.style.setProperty('--bell-left', Math.round(left) + 'px');
}

let bellTracking = false;
let bellQueued = false;

/* rAF-throttled: this runs on scroll, and doing layout reads on every scroll
   event is how a page starts to stutter on a phone. */
function reBell() {
  if (bellQueued) return;
  bellQueued = true;
  requestAnimationFrame(() => { bellQueued = false; placeBellPop(); });
}

function trackBell(on) {
  if (on === bellTracking) return;
  bellTracking = on;
  if (on) {
    window.addEventListener('scroll', reBell, { passive: true });
    window.addEventListener('resize', reBell, { passive: true });
  } else {
    window.removeEventListener('scroll', reBell);
    window.removeEventListener('resize', reBell);
  }
}

function closeBell() {
  $('#bellPop').hidden = true;
  $('#bellBtn').setAttribute('aria-expanded', 'false');
  trackBell(false);
}

$('#bellBtn').addEventListener('click', () => {
  const pop = $('#bellPop');
  const open = pop.hidden;
  pop.hidden = !open;
  $('#bellBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    /* Placed before the list is fetched, so it opens in the right place
       rather than jumping there when the rows arrive. */
    placeBellPop();
    trackBell(true);
    loadNotifications();
  } else {
    trackBell(false);
  }
});

/* Close on an outside click, the same as the cart drawer on the shop. */
document.addEventListener('click', (e) => {
  if ($('#bellPop').hidden) return;
  if (e.target.closest('#bellPop, #bellBtn')) return;
  closeBell();
});

/* Escape closes it, and focus goes back to the button that opened it —
   otherwise a keyboard user dismisses the panel and lands nowhere. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('#bellPop').hidden) return;
  closeBell();
  $('#bellBtn').focus();
});

$('#bellReadAll').addEventListener('click', async () => {
  try {
    await api('/api/notifications', { body: { readAll: true } });
    notifs = notifs.map((n) => Object.assign({}, n, { read: true }));
    renderBell(0);
    $('#inboxDot').hidden = true;
    $('#leaveDot').hidden = true;
  } catch (err) { toast(err.display || err.message, 'bad'); }
});

/* Clicking one marks it read and goes where it points. The tab it names is
   stored on the row, so a new kind of notification needs no change here. */
$('#bellList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-notif]');
  if (!btn) return;
  const id = btn.dataset.notif;
  const link = btn.dataset.link;
  closeBell();
  if (link) {
    const tab = $(`.tab[data-tab="${link}"]`);
    if (tab && !tab.hidden) tab.click();
  }
  try {
    await api('/api/notifications', { body: { read: [id] } });
    const hit = notifs.find((n) => n.id === id);
    if (hit) hit.read = true;
    renderBell(notifs.filter((n) => !n.read).length);
  } catch (err) { /* the navigation already happened; the badge catches up */ }
});

/* =========================================================================
   MESSAGES
   ========================================================================= */
let msgBox = 'inbox';

export async function loadMessages() {
  /* The recipient list comes from the server, so the only addresses offered
     are ones that can actually receive — see onRequestOptions in
     functions/api/messages.js. */
  try {
    const people = await api('/api/messages', { method: 'OPTIONS' });
    const sel = $('#msgTo');
    const keep = sel.value;
    sel.innerHTML = (people.people || [])
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (keep) sel.value = keep;
  } catch (err) { /* the list stays as it was */ }

  try {
    const data = await api('/api/messages?box=' + msgBox);
    $('#msgList').innerHTML = (data.messages || []).length
      ? data.messages.map((m) => `
        <div class="msg${m.read || m.mine ? '' : ' is-new'}">
          <div class="msg__head">
            <b>${esc(m.who.name)}</b>
            <span class="msg__when">${esc(localDate(m.createdAt))}</span>
          </div>
          ${m.subject ? `<p class="msg__subject">${esc(m.subject)}</p>` : ''}
          <p class="msg__body">${esc(m.body)}</p>
        </div>`).join('')
      : `<p class="card__note">${esc(ts('noMessages'))}</p>`;

    /* Opening the inbox is reading it. */
    const unread = (data.messages || []).filter((m) => !m.read && !m.mine).map((m) => m.id);
    if (unread.length) {
      await api('/api/messages', { body: { read: unread } });
      loadNotifications();
    }
  } catch (err) {
    $('#msgList').innerHTML = `<p class="card__note">${esc(err.display || err.message)}</p>`;
  }
}

$$('[data-box]').forEach((b) => b.addEventListener('click', () => {
  msgBox = b.dataset.box;
  $$('[data-box]').forEach((x) => x.classList.toggle('is-on', x === b));
  loadMessages();
}));

$('#msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#msgErr').hidden = true;
  $('#msgOk').hidden = true;
  const btn = $('#msgSend');
  busy(btn, ts('sending'));
  try {
    await api('/api/messages', {
      body: {
        to: $('#msgTo').value,
        subject: $('#msgSubject').value,
        body: $('#msgBody').value
      }
    });
    $('#msgBody').value = '';
    $('#msgSubject').value = '';
    $('#msgOk').textContent = ts('sent');
    $('#msgOk').hidden = false;
    toast(ts('sent'), 'good');
    loadMessages();
  } catch (err) {
    showFormError('#msgErr', err);
  } finally {
    unbusy(btn, ts('send'));
  }
});

/* =========================================================================
   LEAVE — the employee's own
   ========================================================================= */
let leaveData = null;

const statusTag = (s) => `<span class="tag tag--${esc(s)}">${esc(ts('st_' + s))}</span>`;
const kindLabel = (k) => ts('k_' + k);

function renderLeave() {
  if (!leaveData) return;
  const b = leaveData.balance;

  $('#leaveStats').innerHTML = `
    <div class="stat"><span class="stat__k">${esc(ts('allowance'))}</span><span class="stat__v">${b.allowance}</span></div>
    <div class="stat"><span class="stat__k">${esc(ts('taken'))}</span><span class="stat__v">${b.taken}</span></div>
    <div class="stat"><span class="stat__k">${esc(ts('remaining'))}</span><span class="stat__v ${b.remaining > 0 ? 'is-pos' : 'is-neg'}">${b.remaining}</span></div>`;
  $('#leavePolicy').textContent = ts('policyNote');

  $('#lvList').innerHTML = (leaveData.requests || []).length
    ? leaveData.requests.map((r) => `
      <div class="lrow">
        <div class="lrow__main">
          <b>${esc(kindLabel(r.kind))}</b>
          <span dir="ltr">${esc(r.startDate)} → ${esc(r.endDate)}</span>
          <span class="lrow__days">${r.days} ${esc(ts('days'))}</span>
          ${statusTag(r.status)}
        </div>
        ${r.note ? `<p class="lrow__note">${esc(r.note)}</p>` : ''}
        ${r.decisionNote ? `<p class="lrow__note">↳ ${esc(r.decisionNote)}</p>` : ''}
        ${r.hasCertificate ? `<a class="link" href="/api/leave/certificate?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${esc(ts('viewCert'))}</a>` : ''}
        ${r.status === 'pending' ? `<button class="btn btn--ghost btn--sm" type="button" data-withdraw="${esc(r.id)}">${esc(ts('withdraw'))}</button>` : ''}
      </div>`).join('')
    : `<p class="card__note">${esc(ts('noRequests'))}</p>`;
}

export async function loadLeave() {
  try {
    leaveData = await api('/api/leave');
    renderLeave();
    previewRange();
  } catch (err) {
    $('#lvList').innerHTML = `<p class="card__note">${esc(err.display || err.message)}</p>`;
  }
}

/* What the chosen range will cost, shown before it is submitted.

   This is the only place the policy becomes visible. Because public holidays
   are deducted, a week containing Eid costs a full week of somebody's
   allowance — and being told that at the moment of choosing is the difference
   between a policy and a surprise. */
function previewRange() {
  const start = $('#lvStart').value;
  const end = $('#lvEnd').value;
  const box = $('#lvPreview');
  if (!start || !end || end < start || !leaveData) { box.hidden = true; return; }

  let days = 0;
  const inRange = [];
  for (let d = new Date(start + 'T12:00:00Z'); d <= new Date(end + 'T12:00:00Z'); d = new Date(d.getTime() + 86400000)) {
    const iso = d.toISOString().slice(0, 10);
    days++;
    const hit = (leaveData.holidays || []).find((h) => h.date === iso);
    if (hit) inRange.push(hit);
  }

  const parts = [`${ts('willCost')}: ${days} ${ts('days')}`];
  if (inRange.length) {
    /* Arabic separates a list with ٬/، and English with a comma. Using one
       for both leaves the wrong punctuation in half the interface. */
    const sep = LANG === 'en' ? ', ' : '، ';
    const names = inRange.map((h) => (LANG === 'en' ? h.en : h.ar)).join(sep);
    parts.push(`(${inRange.length} ${ts('including')}: ${names})`);
  }
  box.textContent = parts.join(' ');
  box.hidden = false;
}

$('#lvStart').addEventListener('change', previewRange);
$('#lvEnd').addEventListener('change', previewRange);

/* The certificate field only exists for sick leave, because only sick leave
   requires one. */
$('#lvKind').addEventListener('change', () => {
  $('#lvCertField').hidden = $('#lvKind').value !== 'sick';
});

$('#leaveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#lvErr').hidden = true;
  $('#lvOk').hidden = true;
  const btn = $('#lvSend');
  busy(btn, ts('sending'));
  try {
    const kind = $('#lvKind').value;
    const file = $('#lvCert').files && $('#lvCert').files[0];

    /* Multipart only when there is genuinely a file, so an ordinary vacation
       request stays a plain JSON post — the endpoint reads the content type
       and handles either. */
    let payload;
    if (kind === 'sick' && file) {
      payload = new FormData();
      payload.append('kind', kind);
      payload.append('startDate', $('#lvStart').value);
      payload.append('endDate', $('#lvEnd').value);
      payload.append('note', $('#lvNote').value);
      payload.append('certificate', file);
    } else {
      payload = {
        kind,
        startDate: $('#lvStart').value,
        endDate: $('#lvEnd').value,
        note: $('#lvNote').value
      };
    }

    await api('/api/leave', { body: payload });
    $('#lvNote').value = '';
    $('#lvCert').value = '';
    $('#lvOk').textContent = ts('requestSent');
    $('#lvOk').hidden = false;
    toast(ts('requestSent'), 'good');
    loadLeave();
  } catch (err) {
    showFormError('#lvErr', err);
  } finally {
    unbusy(btn, t({ ar: 'ابعت الطلب', en: 'Send request' }));
  }
});

$('#lvList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-withdraw]');
  if (!btn) return;
  if (!confirm(ts('confirmWithdraw'))) return;
  try {
    await api('/api/leave', { body: { cancel: btn.dataset.withdraw } });
    loadLeave();
  } catch (err) { toast(err.display || err.message, 'bad'); }
});

/* =========================================================================
   LEAVE — the administrator's queue
   ========================================================================= */
let lvaStatus = 'pending';

export async function loadLeaveAdmin() {
  if (!me || !me.admin) return;
  $('#lvaErr').hidden = true;
  try {
    const data = await api('/api/admin/leave?status=' + lvaStatus);
    const rows = data.requests || [];
    $('#lvaList').innerHTML = rows.length
      ? rows.map((r) => `
        <div class="lrow">
          <div class="lrow__main">
            <b>${esc(r.who.name)}</b>
            <span>${esc(kindLabel(r.kind))}</span>
            <span dir="ltr">${esc(r.startDate)} → ${esc(r.endDate)}</span>
            <span class="lrow__days">${r.days} ${esc(ts('days'))}</span>
            ${statusTag(r.status)}
          </div>
          <p class="lrow__note">${r.balance.taken}/${r.balance.allowance} ${esc(ts('ofAllowance'))}</p>
          ${r.note ? `<p class="lrow__note">${esc(r.note)}</p>` : ''}
          ${r.hasCertificate
            ? `<a class="link" href="/api/leave/certificate?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${esc(ts('viewCert'))}</a>`
            : ''}
          ${r.status === 'pending' ? `
            <div class="lrow__act">
              <input class="lrow__reason" data-reason="${esc(r.id)}" maxlength="400" placeholder="${esc(ts('decisionNote'))}">
              <button class="btn btn--sm" type="button" data-approve="${esc(r.id)}">${esc(ts('approve'))}</button>
              <button class="btn btn--ghost btn--sm" type="button" data-decline="${esc(r.id)}">${esc(ts('decline'))}</button>
            </div>` : ''}
        </div>`).join('')
      : `<p class="card__note">${esc(ts('noPending'))}</p>`;
  } catch (err) {
    $('#lvaErr').textContent = err.display || err.message;
    $('#lvaErr').hidden = false;
  }
}

$$('[data-lstatus]').forEach((b) => b.addEventListener('click', () => {
  lvaStatus = b.dataset.lstatus;
  $$('[data-lstatus]').forEach((x) => x.classList.toggle('is-on', x === b));
  loadLeaveAdmin();
}));

$('#panelLeaveAdmin').addEventListener('click', async (e) => {
  const ok = e.target.closest('[data-approve]');
  const no = e.target.closest('[data-decline]');
  if (!ok && !no) return;
  const id = (ok || no).dataset.approve || (ok || no).dataset.decline;
  const reason = $(`[data-reason="${id}"]`);
  try {
    await api('/api/admin/leave', {
      body: { id, action: ok ? 'approve' : 'decline', note: reason ? reason.value : '' }
    });
    loadLeaveAdmin();
    loadNotifications();
  } catch (err) {
    /* 'already_decided' is the useful one: another admin got there first, and
       reloading shows what they chose rather than leaving a stale button. */
    toast(err.display || err.message, 'bad');
    loadLeaveAdmin();
  }
});

/* =========================================================================
   The seam back to account.js
   ========================================================================= */
export function loadPanel(name) {
  if (name === 'inbox') return loadMessages();
  if (name === 'leave') return loadLeave();
  if (name === 'leaveAdmin') return loadLeaveAdmin();
}

/* =========================================================================
   DESKTOP NOTIFICATION PERMISSION

   WHAT A WEBSITE CAN AND CANNOT DO HERE
   -------------------------------------
   It cannot make anybody accept these. Notification.requestPermission() opens
   a dialog that belongs to the browser, the answer belongs to the person, and
   once it has been refused the browser will not show the dialog again — a
   second requestPermission() call resolves instantly as 'denied' without
   anything appearing on screen. That is a deliberate protection against
   exactly the nagging this feature is asking for, and there is no way round
   it from JavaScript.

   So "mandatory for employees" is enforced where it actually can be:

     - the banner has no dismiss button for an employee, and comes back on
       every load until the answer is 'granted';
     - the answer is reported to the server after every attempt, so the owner
       can see who has not turned them on — /api/notify-optin;
     - once the browser is on 'denied' the banner stops pretending a button
       will fix it and says where the setting lives instead, because a button
       that silently does nothing is worse than an instruction.

   An administrator gets the same ask with a "not now" that is remembered for
   the session.

   WHAT THIS IS NOT
   ----------------
   Not Web Push. There is no service worker and no subscription, so these
   appear only while the dashboard is actually open in a tab. That is the
   agreed starting point — the in-app list is the record, this is the nudge
   for somebody who has the tab open but is looking at something else.
   ========================================================================= */
const NOTIF_COPY = {
  ask:        { ar: 'شغّل تنبيهات سطح المكتب', en: 'Turn on desktop notifications' },
  bodyStaff:  {
    ar: 'التنبيهات دي مطلوبة لكل الموظفين عشان تعرف فورًا لما يجي طلب جديد.',
    en: 'These are required for all employees, so you know the moment an order comes in.'
  },
  bodyAdmin:  {
    ar: 'عايز يوصلك تنبيه على سطح المكتب لما يجي طلب أو حد يسجل حضور؟',
    en: 'Want a desktop alert when an order arrives or someone clocks in?'
  },
  allow:      { ar: 'اسمح', en: 'Allow' },
  later:      { ar: 'مش دلوقتي', en: 'Not now' },
  blocked:    { ar: 'التنبيهات مرفوضة من المتصفح', en: 'Notifications are blocked by your browser' },
  blockedHow: {
    ar: 'المتصفح مش هيسأل تاني. افتح القفل جنب العنوان فوق وحوّل «التنبيهات» لمسموح، وبعدين حدّث الصفحة.',
    en: 'The browser will not ask again. Open the padlock next to the address bar, set Notifications to Allow, then reload.'
  },
  unsupported:{ ar: 'المتصفح ده مابيدعمش التنبيهات.', en: 'This browser does not support notifications.' }
};
const nc = (k) => t(NOTIF_COPY[k]);

const canNotify = () => typeof window.Notification === 'function';
/* Session-scoped, so an administrator who says "not now" is not asked again
   until they come back. An employee's banner ignores this by construction. */
const SNOOZE = 'vg-notif-snooze';

/* Reported after every attempt. Failing to report is not worth telling
   anybody about — it is a status line for the owner, not a feature. */
function report(state) {
  api('/api/notify-optin', { body: { state } }).catch(() => {});
}

function renderAsk() {
  const bar = $('#notifAsk');
  if (!me || !me.staff) { bar.hidden = true; return; }

  if (!canNotify()) {
    $('#notifAskTitle').textContent = nc('unsupported');
    $('#notifAskBody').textContent = '';
    $('#notifAllow').hidden = true;
    $('#notifLater').hidden = true;
    bar.hidden = false;
    report('unsupported');
    return;
  }

  const state = Notification.permission;
  if (state === 'granted') { bar.hidden = true; return; }

  /* An employee is never given a way out; an administrator is. */
  const mandatory = !me.admin;
  let snoozed = false;
  try { snoozed = sessionStorage.getItem(SNOOZE) === '1'; } catch (e) { /* private mode */ }
  if (!mandatory && snoozed) { bar.hidden = true; return; }

  if (state === 'denied') {
    /* The browser will not reopen the dialog, so stop offering a button that
       cannot work and say where the real setting is. */
    $('#notifAskTitle').textContent = nc('blocked');
    $('#notifAskBody').textContent = nc('blockedHow');
    $('#notifAllow').hidden = true;
  } else {
    $('#notifAskTitle').textContent = nc('ask');
    $('#notifAskBody').textContent = mandatory ? nc('bodyStaff') : nc('bodyAdmin');
    $('#notifAllow').hidden = false;
    $('#notifAllow').textContent = nc('allow');
  }
  $('#notifLater').hidden = mandatory || state === 'denied';
  $('#notifLater').textContent = nc('later');
  bar.classList.toggle('is-required', mandatory);
  bar.hidden = false;
}

$('#notifAllow').addEventListener('click', async () => {
  if (!canNotify()) return;
  try {
    const state = await Notification.requestPermission();
    report(state);
    renderAsk();
    if (state === 'granted') toast(t({ ar: 'اتشغّلت.', en: 'Turned on.' }), 'good');
  } catch (err) {
    /* Older Safari resolves this through a callback rather than a promise;
       either way there is nothing useful to show if it throws. */
    renderAsk();
  }
});

$('#notifLater').addEventListener('click', () => {
  try { sessionStorage.setItem(SNOOZE, '1'); } catch (e) {}
  $('#notifAsk').hidden = true;
});

/* Raise a real one for anything that arrived since the last check, so
   somebody with the tab open but not in front of them still finds out.
   Only what is unread and only while permission stands. */
let lastSeen = new Set();
function surface() {
  if (!canNotify() || Notification.permission !== 'granted') return;
  for (const n of notifs) {
    if (n.read || lastSeen.has(n.id)) continue;
    try {
      /* tag: one per notification, so a re-render cannot stack duplicates of
         the same event on the desktop. */
      new Notification(n.title, { body: n.body || '', tag: n.id, icon: '/assets/logo-trim.png' });
    } catch (e) { /* some browsers refuse outside a user gesture; not fatal */ }
  }
  lastSeen = new Set(notifs.map((n) => n.id));
}

/* The owner's line: who has these on, and who has not.

   A count rather than a table, because with four people the only question is
   "is anyone missing", and naming them only when somebody IS missing keeps a
   healthy team's dashboard quiet. */
async function loadRoster() {
  if (!me || !me.admin) return;
  try {
    const data = await api('/api/notify-optin');
    const people = data.people || [];
    const off = people.filter((p) => p.state !== 'granted');
    const el = $('#notifRoster');
    /* Arabic and English separate a list differently; one comma for both
       leaves the wrong punctuation in half the interface. */
    const sep = LANG === 'en' ? ', ' : '، ';
    el.textContent = off.length
      ? `${t({ ar: 'تنبيهات سطح المكتب مقفولة عند', en: 'Desktop notifications are off for' })}: ${off.map((p) => p.name).join(sep)}`
      : `${t({ ar: 'كل الفريق مفعّل التنبيهات', en: 'Everyone on the team has notifications on' })} (${people.length})`;
    el.classList.toggle('is-warn', off.length > 0);
    el.hidden = false;
  } catch (err) { /* a status line is not worth an error message */ }
}

/* Called on sign-in, once, for anyone on staff. */
export function start() {
  $('#bellBtn').hidden = false;
  renderAsk();
  loadRoster();
  /* Seed the "already seen" set from the first load, so signing in does not
     fire a desktop notification for everything already in the list. */
  loadNotifications().then(() => { lastSeen = new Set(notifs.map((n) => n.id)); });
}


/* A language switch. The lists carry their own copy, so they are redrawn;
   the notification bodies are written by the server in one language and are
   deliberately left alone rather than half-translated. */
export function repaint() {
  renderAsk();
  loadRoster();
  renderBell(notifs.filter((n) => !n.read).length);
  if (leaveData) renderLeave();
  if (!$('#panelInbox').hidden) loadMessages();
  if (!$('#panelLeaveAdmin').hidden) loadLeaveAdmin();
}

export function reset() {
  notifs = [];
  leaveData = null;
  $('#bellBtn').hidden = true;
  /* Through closeBell so the scroll listener goes with it — a sign-out that
     left it attached would keep measuring a button that is no longer there. */
  closeBell();
  $('#notifRoster').hidden = true;
  $('#notifAsk').hidden = true;
}
