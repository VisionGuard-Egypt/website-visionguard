/* =========================================================================
   Vision Guard — account-support.js
   Live chat, from the employee's side.

   Three lists, because they are three different jobs and lumping them
   together is how the urgent one gets lost:

     Yours now    — offered to you, with the countdown running. Answer it or
                    it moves on.
     Unclaimed    — everybody has had a turn and nobody took it. Anyone may
                    grab it.
     In progress  — already being handled, yours or somebody else's.

   THE COUNTDOWN IS DRAWN LOCALLY AND TRUSTED FROM THE SERVER. secondsLeft
   arrives with every poll and ticks down between polls, so the number moves
   smoothly without the browser's clock ever being the authority. A laptop
   an hour out of sync would otherwise show an offer as expired that is not,
   or hold one that is.
   ========================================================================= */
import { $, t, esc, api, toast, localTime } from './site.js?v=66';
import { me, busy, unbusy } from './account-shared.js?v=66';

const L = {
  none:        { ar: 'مافيش محادثات مفتوحة.', en: 'No open chats.' },
  yours:       { ar: 'ليك دلوقتي', en: 'Yours now' },
  unclaimed:   { ar: 'محدش خدها', en: 'Unclaimed' },
  inProgress:  { ar: 'شغّالة', en: 'In progress' },
  take:        { ar: 'خدها', en: 'Take it' },
  taking:      { ar: 'لحظة…', en: 'One moment…' },
  send:        { ar: 'ابعت', en: 'Send' },
  sending:     { ar: 'جاري الإرسال…', en: 'Sending…' },
  close:       { ar: 'اقفل المحادثة', en: 'Close chat' },
  back:        { ar: '← رجوع', en: '← Back' },
  placeholder: { ar: 'اكتب ردك للعميل…', en: 'Write your reply…' },
  anon:        { ar: 'عميل', en: 'Customer' },
  waitingFor:  { ar: 'مستني من', en: 'Waiting since' },
  left:        { ar: 'باقي', en: 'left' },
  expired:     { ar: 'الوقت خلص', en: 'time is up' },
  onShift:     { ar: 'على الشيفت دلوقتي', en: 'On shift now' },
  nobodyOn:    {
    ar: 'مافيش حد مسجّل حضور، فالمحادثات بتتبعت لكل الفريق.',
    en: 'Nobody is clocked in, so chats go to the whole team.'
  },
  answeredToday:{ ar: 'ردّوا النهارده', en: 'Answered today' },
  answeredMonth:{ ar: 'آخر ٣٠ يوم', en: 'Last 30 days' },
  nobodyAnswered:{ ar: 'مافيش محادثات اتردت لسه.', en: 'No chats answered yet.' },
  youWord:     { ar: 'إنت', en: 'you' },
  closed:      { ar: 'المحادثة اتقفلت.', en: 'Chat closed.' },
  taken:       { ar: 'اتاخدت.', en: 'Taken.' },
  rule:        {
    ar: 'المحادثة بتتعرض على موظف واحد. لو ماردش خلال {m} دقايق بتروح للي بعده.',
    en: 'A chat is offered to one person. If they do not answer within {m} minutes it passes to the next.'
  }
};
const ls = (k) => t(L[k] || { ar: '', en: '' });

let data = null;
let open = null;
let poll = null;
let tick = null;

/* ------------------------------------------------------------------------- */
function block(id, render) {
  const node = $(id);
  if (!node) return;
  try {
    render(node);
  } catch (err) {
    console.error('support block failed', id, err && err.message);
    node.innerHTML = `<p class="card__note is-bad">${esc(ls('none'))}</p>`;
  }
}

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function row(c) {
  const who = c.name || ls('anon');
  const countdown = c.offeredToMe
    ? `<span class="sup__clock ${c.secondsLeft <= 60 ? 'is-urgent' : ''}" data-left="${c.secondsLeft}">${esc(mmss(c.secondsLeft))}</span>`
    : '';
  const owner = c.agentName
    ? `<span class="tag">${esc(c.mine ? ls('youWord') : c.agentName)}</span>`
    : '';
  return `
    <button class="orow orow--btn" type="button" data-chat="${esc(c.id)}">
      <span class="orow__id">${esc(who)}</span>
      <span class="orow__meta">${owner}${countdown}<span>${esc(localTime(c.createdAt))}</span></span>
      <span class="orow__note">${esc(c.last || '')}</span>
    </button>`;
}

function renderList() {
  $('#supList').hidden = false;
  $('#supThread').hidden = true;
  if (!data) return;

  const mine = data.chats.filter((c) => c.offeredToMe);
  const free = data.chats.filter((c) => c.unclaimed);
  const going = data.chats.filter((c) => c.status === 'live');

  block('#supMine', (n) => {
    n.innerHTML = mine.length ? mine.map(row).join('') : `<p class="card__note">${esc(ls('none'))}</p>`;
  });
  block('#supFree', (n) => {
    n.innerHTML = free.length ? free.map(row).join('') : `<p class="card__note">${esc(ls('none'))}</p>`;
  });
  block('#supLive', (n) => {
    n.innerHTML = going.length ? going.map(row).join('') : `<p class="card__note">${esc(ls('none'))}</p>`;
  });

  /* Who the rota currently is. A queue that routes invisibly is one nobody
     trusts — this is the answer to "why did that go to him and not me". */
  block('#supShift', (n) => {
    const on = data.onShift || [];
    n.innerHTML = on.length
      ? on.map((p) => `<span class="tag">${esc(p.name || '')}</span>`).join(' ')
      : `<p class="card__note is-bad">${esc(ls('nobodyOn'))}</p>`;
  });

  block('#supScores', (n) => {
    const rows = (data.answered && data.answered.month) || [];
    if (!rows.length) {
      n.innerHTML = `<p class="card__note">${esc(ls('nobodyAnswered'))}</p>`;
      return;
    }
    const today = new Map(((data.answered && data.answered.today) || []).map((r) => [r.id, r.answered]));
    n.innerHTML = rows.map((r) => `
      <div class="stat">
        <span class="stat__k">${esc(r.id === (me && me.id) ? `${r.name} (${ls('youWord')})` : r.name)}</span>
        <span class="stat__v">${esc(String(today.get(r.id) || 0))} / ${esc(String(r.answered))}</span>
      </div>`).join('');
  });

  $('#supRule').textContent = ls('rule').replace('{m}', String(data.offerMinutes || 5));
}

function renderThread() {
  if (!open) return;
  $('#supList').hidden = true;
  $('#supThread').hidden = false;

  const c = open.chat;
  $('#supPeer').textContent = c.name || ls('anon');
  $('#supMeta').textContent = [c.phone, c.page].filter(Boolean).join(' · ');

  block('#supMessages', (n) => {
    n.innerHTML = (open.messages || []).map((m) => {
      if (m.role === 'system') {
        return `<div class="dm dm--sys"><div class="dm__body">${esc(m.body)}</div></div>`;
      }
      const outgoing = m.role === 'agent';
      return `
        <div class="dm ${outgoing ? 'dm--out' : 'dm--in'}">
          <div class="dm__body">${esc(m.body)}</div>
          <div class="dm__at">${esc(m.role === 'bot' ? 'AI · ' : '')}${esc(localTime(m.at))}</div>
        </div>`;
    }).join('');
    n.scrollTop = n.scrollHeight;
  });

  /* Take it, or answer it. Never both — an unanswered offer with a reply box
     invites somebody to type into a chat that is about to move on. */
  const taken = c.status === 'live';
  $('#supAccept').hidden = taken;
  $('#supReplyForm').hidden = !taken || !c.mine;
  $('#supCloseBtn').hidden = !taken || !c.mine;
}

/* ------------------------------------------------------------------------- */
export async function loadSupport() {
  const err = $('#supErr');
  if (err) err.hidden = true;
  try {
    data = await api('/api/support');
    if (!open) renderList();
    /* The badge on the tab: anything with my name on it right now. */
    const mine = data.chats.filter((c) => c.offeredToMe).length;
    const dot = $('#supportDot');
    if (dot) dot.hidden = mine === 0;
  } catch (e) {
    if (err) { err.textContent = e.display || e.message; err.hidden = false; }
  }
}

async function openChat(id) {
  try {
    open = await api(`/api/support?session=${encodeURIComponent(id)}`);
    renderThread();
  } catch (e) {
    toast(e.display || e.message, 'bad');
  }
}

/* ---- wiring ---- */
$('#supPanels').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-chat]');
  if (btn) openChat(btn.getAttribute('data-chat'));
});

$('#supBack').addEventListener('click', () => { open = null; loadSupport(); renderList(); });

$('#supAccept').addEventListener('click', async () => {
  if (!open) return;
  const btn = $('#supAccept');
  busy(btn, ls('taking'));
  try {
    await api('/api/support', { method: 'POST', body: { action: 'accept', session: open.chat.id } });
    toast(ls('taken'), 'good');
    await openChat(open.chat.id);
  } catch (e) {
    /* The other half of the race in /api/support: somebody beat you to it. */
    toast(e.display || e.message, 'bad');
    await loadSupport();
  } finally {
    unbusy(btn, ls('take'));
  }
});

$('#supReplyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!open) return;
  const input = $('#supReply');
  const btn = $('#supSend');
  const body = input.value.trim();
  if (!body) return;
  busy(btn, ls('sending'));
  try {
    await api('/api/support', { method: 'POST', body: { action: 'reply', session: open.chat.id, body } });
    input.value = '';
    await openChat(open.chat.id);
  } catch (err) {
    toast(err.display || err.message, 'bad');
  } finally {
    unbusy(btn, ls('send'));
  }
});

$('#supCloseBtn').addEventListener('click', async () => {
  if (!open) return;
  try {
    await api('/api/support', { method: 'POST', body: { action: 'close', session: open.chat.id } });
    toast(ls('closed'), 'good');
    open = null;
    await loadSupport();
    renderList();
  } catch (e) {
    toast(e.display || e.message, 'bad');
  }
});

/* The panel only polls while it is the visible tab. A dashboard left open on
   Orders should not be talking to the server every four seconds all day. */
function startPolling() {
  stopPolling();
  poll = setInterval(() => {
    if (open) openChat(open.chat.id);
    else loadSupport();
  }, 5000);
  /* The countdown moves every second without a request behind it. */
  tick = setInterval(() => {
    document.querySelectorAll('.sup__clock').forEach((el) => {
      const left = Math.max(0, Number(el.getAttribute('data-left') || 0) - 1);
      el.setAttribute('data-left', String(left));
      el.textContent = left ? mmss(left) : ls('expired');
      el.classList.toggle('is-urgent', left <= 60);
    });
  }, 1000);
}

function stopPolling() {
  if (poll) { clearInterval(poll); poll = null; }
  if (tick) { clearInterval(tick); tick = null; }
}

export function loadPanel() {
  startPolling();
  return loadSupport();
}

export function leavePanel() { stopPolling(); }

export function repaint() {
  if (open) renderThread();
  else if (data) renderList();
}

export function reset() {
  stopPolling();
  data = null;
  open = null;
}
