/* =========================================================================
   Vision Guard — account-leads.js
   The leads centre.

   Loaded lazily for staff, the same as account-staff.js and
   account-admin.js. Employees write here as well as administrators — the
   person who answered the phone is the one who knows what was said, and a
   leads centre only the owner can write to is one nobody uses.

   THE EDITOR IS ONE CARD, NOT TWO
   -------------------------------
   "New lead" and "open lead" are the same fields with the same validation,
   so they are the same form. Which one it is depends on whether `openId` is
   held. Two forms would be two places to fix a bug in.
   ========================================================================= */
import { $, $$, t, esc, api, toast, localDate, LANG } from './site.js?v=66';
import { T, me, busy, unbusy, showFormError } from './account-shared.js?v=66';
import { GOVERNORATES } from './catalog.js?v=66';

const L = {
  boardOpen:    { ar: 'الشغّال', en: 'Open' },
  s_new:        { ar: 'جديد', en: 'New' },
  s_contacted:  { ar: 'اتكلمنا', en: 'Contacted' },
  s_quoted:     { ar: 'اتبعتله سعر', en: 'Quoted' },
  s_won:        { ar: 'اشترى', en: 'Won' },
  s_lost:       { ar: 'ضاع', en: 'Lost' },
  src_whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  src_phone:    { ar: 'تليفون', en: 'Phone' },
  src_instagram:{ ar: 'إنستجرام', en: 'Instagram' },
  src_facebook: { ar: 'فيسبوك', en: 'Facebook' },
  src_website:  { ar: 'الموقع', en: 'Website' },
  src_walk_in:  { ar: 'جه المحل', en: 'Walk-in' },
  src_referral: { ar: 'ترشيح', en: 'Referral' },
  src_other:    { ar: 'غير ذلك', en: 'Other' },
  none:         { ar: 'مافيش عملاء هنا لسه.', en: 'Nobody here yet.' },
  newLead:      { ar: 'عميل جديد', en: 'New lead' },
  saved:        { ar: 'اتحفظ.', en: 'Saved.' },
  saving:       { ar: 'جاري الحفظ…', en: 'Saving…' },
  save:         { ar: 'احفظ', en: 'Save' },
  added:        { ar: 'اتضاف.', en: 'Added.' },
  noteAdded:    { ar: 'اتسجلت.', en: 'Noted.' },
  noOrder:      { ar: 'مافيش طلب مربوط.', en: 'No order linked yet.' },
  orderIs:      { ar: 'الطلب', en: 'Order' },
  payIs:        { ar: 'الدفع', en: 'Payment' },
  deleting:     { ar: 'جاري الحذف…', en: 'Deleting…' },
  openExisting: { ar: 'افتح اللي موجود', en: 'Open the existing one' },
  chooseGov:    { ar: 'اختار المحافظة', en: 'Choose a governorate' },
  notesEmpty:   { ar: 'مافيش سجل لسه.', en: 'Nothing recorded yet.' }
};
const ls = (k) => t(L[k] || { ar: '', en: '' });

let board = null;      // the last board payload
let openId = null;     // the lead currently in the editor
let filter = 'open';
let searchTimer = null;
/* Whether THIS session may delete a lead, as the server answered it. Held
   here so the editor can consult it without re-reading the board payload,
   and false until asked — a button that appears late is a smaller problem
   than one that appears for the wrong person. */
let canDelete = false;

/* =========================================================================
   THE BOARD
   ========================================================================= */
function renderTabs() {
  if (!board) return;
  const counts = board.counts || {};
  const tabs = [{ id: 'open', label: ls('boardOpen') }]
    .concat((board.statuses || []).map((s) => ({ id: s, label: ls('s_' + s), n: counts[s] })));

  $('#leadTabs').innerHTML = tabs.map((tb) => `
    <button class="seg__b${tb.id === filter ? ' is-on' : ''}" type="button" data-lead-tab="${esc(tb.id)}">
      ${esc(tb.label)}${tb.n ? ` <i>${tb.n}</i>` : ''}
    </button>`).join('');
}

function renderList() {
  if (!board) return;
  const rows = board.leads || [];
  $('#leadList').innerHTML = rows.length
    ? rows.map((l) => `
      <button class="lead" type="button" data-lead="${esc(l.id)}">
        <span class="lead__main">
          <b>${esc(l.name)}</b>
          <span dir="ltr">${esc(l.phone)}</span>
          <span class="tag tag--${esc(l.status)}">${esc(ls('s_' + l.status))}</span>
        </span>
        <span class="lead__meta">
          ${l.interest ? esc(l.interest) + ' · ' : ''}${esc(ls('src_' + l.source) || l.source)}
          ${l.orderId ? ` · <span dir="ltr">${esc(l.orderId)}</span>` : ''}
          ${l.noteCount ? ` · ${l.noteCount}` : ''}
          · ${esc(localDate(l.updatedAt))}
        </span>
      </button>`).join('')
    : `<p class="card__note">${esc(ls('none'))}</p>`;
}

export async function loadLeads() {
  $('#leadErr').hidden = true;
  try {
    const q = $('#leadQ').value.trim();
    board = await api(`/api/leads?status=${encodeURIComponent(filter)}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    renderTabs();
    renderList();
    fillSelects();
  } catch (err) {
    $('#leadErr').textContent = err.display || err.message;
    $('#leadErr').hidden = false;
  }
}

/* The dropdowns are filled from what the SERVER says is allowed, so the
   options offered and the values accepted cannot drift apart. */
function fillSelects() {
  if (!board) return;
  const gov = $('#ldGov');
  if (!gov.options.length) {
    gov.innerHTML = `<option value="">${esc(ls('chooseGov'))}</option>` +
      GOVERNORATES.map((g) => `<option value="${esc(LANG === 'en' ? g.en : g.ar)}">${esc(LANG === 'en' ? g.en : g.ar)}</option>`).join('');
  }
  $('#ldSource').innerHTML = (board.sources || [])
    .map((s) => `<option value="${esc(s)}">${esc(ls('src_' + s) || s)}</option>`).join('');
  $('#ldStatus').innerHTML = (board.statuses || [])
    .map((s) => `<option value="${esc(s)}">${esc(ls('s_' + s))}</option>`).join('');
  /* Cancelled is absent from what the server sends on purpose — it refuses
     it from staff, so offering it would be a button that only ever produces
     an error. The fallback list is the same four, for a response that
     predates the field. */
  $('#ldOrderStatus').innerHTML = (board.orderStatuses || ['new', 'confirmed', 'shipped', 'done'])
    .map((s) => `<option value="${esc(s)}"${s === 'confirmed' ? ' selected' : ''}>${esc(s)}</option>`).join('');
  $('#ldPaymentStatus').innerHTML = (board.paymentStatuses || ['pending', 'paid', 'failed'])
    .map((s) => `<option value="${esc(s)}"${s === 'paid' ? ' selected' : ''}>${esc(t(T['pay_' + s] || T.pay_pending))}</option>`).join('');

  /* Who may delete. The answer comes from the endpoint rather than from this
     file's own reading of `me`, so there is one place that decides and the
     button cannot outlive the permission. `me.admin` is the fallback for a
     response that predates the field; the server refuses either way. */
  canDelete = board.canDelete === undefined ? !!(me && me.admin) : !!board.canDelete;
  showDeleteButton();
}

/* Shown to an administrator, and only against a lead that exists — there is
   nothing to delete while the card is a blank "new lead" form. */
function showDeleteButton() {
  $('#ldDelete').hidden = !(canDelete && openId);
}

$('#leadTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lead-tab]');
  if (!b) return;
  filter = b.dataset.leadTab;
  loadLeads();
});

$('#leadQ').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadLeads, 220);
});

/* =========================================================================
   THE EDITOR
   ========================================================================= */
function showEditor(lead) {
  openId = lead ? lead.id : null;
  $('#leadCard').hidden = false;
  $('#leadCardTitle').textContent = lead ? lead.name : ls('newLead');
  $('#ldName').value = lead ? lead.name : '';
  $('#ldPhone').value = lead ? lead.phone : '';
  $('#ldEmail').value = lead ? lead.email : '';
  $('#ldGov').value = lead ? lead.governorate : '';
  $('#ldSource').value = lead ? lead.source : 'phone';
  $('#ldStatus').value = lead ? lead.status : 'new';
  $('#ldInterest').value = lead ? lead.interest : '';
  $('#ldErr').hidden = true;
  $('#ldOk').hidden = true;

  /* The order and history cards only make sense against a lead that exists. */
  $('#leadOrderCard').hidden = !lead;
  $('#leadNotesCard').hidden = !lead;
  showDeleteButton();
  if (!lead) $('#leadCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderNotes(notes) {
  $('#ldNotes').innerHTML = (notes || []).length
    ? notes.map((n) => `
      <div class="note note--${esc(n.kind)}">
        <p class="note__body">${esc(n.body)}</p>
        <p class="note__meta">${esc(n.authorName || '')} · ${esc(localDate(n.createdAt))}</p>
      </div>`).join('')
    : `<p class="card__note">${esc(ls('notesEmpty'))}</p>`;
}

function renderOrder(order) {
  /* Two states, side by side: where the parcel is, and where the money is.
     The payment one is a pill rather than plain text because it is the thing
     somebody opens this card to check, now that an order arrives unpaid. */
  const pay = order && (order.payment_status || 'pending');
  $('#ldOrderNow').innerHTML = order
    ? `<p class="card__note">
         <b>${esc(ls('orderIs'))} <span dir="ltr">${esc(order.id)}</span></b>
         · ${esc(order.status)}
         · ${order.total} ${esc(order.currency || 'EGP')}
         · ${esc(ls('payIs'))} <span class="pill pill--${esc(pay)}">${esc(t(T['pay_' + pay] || T.pay_pending))}</span>
       </p>`
    : `<p class="card__note">${esc(ls('noOrder'))}</p>`;
  if (order) {
    $('#ldOrderId').value = order.id;
    /* Starts on what the order actually says, so the control reports the
       present state rather than proposing a change nobody asked for. */
    const sel = $('#ldPaymentStatus');
    if (sel && [...sel.options].some((o) => o.value === pay)) sel.value = pay;
  }
}

async function openLead(id) {
  try {
    const data = await api('/api/leads?id=' + encodeURIComponent(id));
    showEditor(data.lead);
    renderNotes(data.lead.notes);
    renderOrder(data.order);
    $('#leadCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) { toast(err.display || err.message, 'bad'); }
}

$('#leadList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lead]');
  if (b) openLead(b.dataset.lead);
});

$('#leadNew').addEventListener('click', () => showEditor(null));

/* Put the editor away. Distinct from reset() at the bottom, which throws the
   whole panel back to its signed-out state — closing a card must not also
   move somebody off the tab they were working in. */
function closeEditor() {
  openId = null;
  $('#leadCard').hidden = true;
  $('#leadOrderCard').hidden = true;
  $('#leadNotesCard').hidden = true;
  showDeleteButton();
}

$('#ldClose').addEventListener('click', closeEditor);

$('#leadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#ldErr').hidden = true;
  $('#ldOk').hidden = true;
  const btn = $('#ldSave');
  busy(btn, ls('saving'));
  const payload = {
    name: $('#ldName').value,
    phone: $('#ldPhone').value,
    email: $('#ldEmail').value,
    governorate: $('#ldGov').value,
    source: $('#ldSource').value,
    interest: $('#ldInterest').value
  };
  try {
    if (openId) {
      await api('/api/leads', { body: Object.assign({ action: 'update', id: openId }, payload) });
      /* The stage is its own action because it writes a line into the
         timeline; bundling it into `update` would lose that record. */
      await api('/api/leads', { body: { action: 'status', id: openId, status: $('#ldStatus').value } });
      $('#ldOk').textContent = ls('saved');
    } else {
      const res = await api('/api/leads', { body: Object.assign({ action: 'create' }, payload) });
      openId = res.id;
      $('#ldOk').textContent = ls('added');
      await openLead(res.id);
    }
    $('#ldOk').hidden = false;
    loadLeads();
  } catch (err) {
    /* A duplicate number is not really an error — it is the same person
       ringing back. Offer the record they already have. */
    const existingId = err.details && err.details.leadId;
    if (err.code === 'lead_exists' && existingId) {
      $('#ldErr').innerHTML = `${esc(err.display || err.message)} <button class="link" type="button" data-open-existing="${esc(existingId)}">${esc(ls('openExisting'))}</button>`;
      $('#ldErr').hidden = false;
    } else {
      showFormError('#ldErr', err);
    }
  } finally {
    unbusy(btn, ls('save'));
  }
});

$('#ldErr').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-existing]');
  if (b) openLead(b.dataset.openExisting);
});

/* ---- the timeline ---- */
$('#ldNoteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!openId) return;
  const note = $('#ldNote').value.trim();
  if (!note) return;
  try {
    await api('/api/leads', { body: { action: 'note', id: openId, note } });
    $('#ldNote').value = '';
    toast(ls('noteAdded'), 'good');
    openLead(openId);
  } catch (err) { toast(err.display || err.message, 'bad'); }
});

/* ---- helping with the order ---- */
$('#ldLink').addEventListener('click', async () => {
  if (!openId) return;
  $('#ldOrderErr').hidden = true;
  try {
    await api('/api/leads', { body: { action: 'link', id: openId, orderId: $('#ldOrderId').value } });
    openLead(openId);
    loadLeads();
  } catch (err) {
    $('#ldOrderErr').textContent = err.display || err.message;
    $('#ldOrderErr').hidden = false;
  }
});

$('#ldConfirm').addEventListener('click', async () => {
  if (!openId) return;
  $('#ldOrderErr').hidden = true;
  try {
    await api('/api/leads', {
      body: {
        action: 'confirm', id: openId,
        orderId: $('#ldOrderId').value,
        orderStatus: $('#ldOrderStatus').value
      }
    });
    toast(ls('saved'), 'good');
    openLead(openId);
    loadLeads();
  } catch (err) {
    $('#ldOrderErr').textContent = err.display || err.message;
    $('#ldOrderErr').hidden = false;
  }
});

/* Did the money arrive? A separate button from "set status" above because it
   is a separate question asked at a different moment — usually while the
   order is still `new` and the customer is on WhatsApp saying they have
   sent it. Open to every employee; see the header of functions/api/leads.js. */
$('#ldPayment').addEventListener('click', async () => {
  if (!openId) return;
  $('#ldOrderErr').hidden = true;
  try {
    await api('/api/leads', {
      body: {
        action: 'payment', id: openId,
        orderId: $('#ldOrderId').value,
        paymentStatus: $('#ldPaymentStatus').value
      }
    });
    toast(t(T.paySaved), 'good');
    openLead(openId);
    loadLeads();
  } catch (err) {
    $('#ldOrderErr').textContent = err.display || err.message;
    $('#ldOrderErr').hidden = false;
  }
});

/* ---- removing somebody from the board ----

   Administrators only. The button is not drawn for anyone else — see
   fillSelects — and /api/leads refuses the action regardless of what the
   page thinks.

   The confirmation names the person and says what actually goes: the notes.
   "Are you sure?" is not a safeguard, because nobody reads it. */
$('#ldDelete').addEventListener('click', async () => {
  if (!openId) return;
  const name = $('#ldName').value || $('#leadCardTitle').textContent || '';
  if (!confirm(t(T.ldDelConfirm).replace('{name}', name))) return;

  const btn = $('#ldDelete');
  busy(btn, ls('deleting'));
  try {
    await api('/api/leads', { body: { action: 'delete', id: openId, confirm: true } });
    toast(t(T.ldDeleted), 'good');
    /* The card is about a lead that no longer exists, so it goes with it
       rather than sitting there editable. The board reloads on the tab the
       person was already looking at. */
    closeEditor();
    loadLeads();
  } catch (err) {
    showFormError('#ldErr', err);
  } finally {
    unbusy(btn, t(T.ldDelete));
  }
});

/* =========================================================================
   The seam back to account.js
   ========================================================================= */
export function loadPanel() { return loadLeads(); }

export function repaint() {
  if (board) { renderTabs(); renderList(); fillSelects(); }
}

export function reset() {
  board = null;
  filter = 'open';
  closeEditor();
}
