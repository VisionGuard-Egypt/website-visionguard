/* =========================================================================
   Order notification.

   Five providers, picked by whichever credentials you actually set. Nothing
   here is required for the shop to work: an order is written to D1 first and
   the notification is fired afterwards through waitUntil(), so an outage, a
   wrong token or an expired 24-hour window can slow nothing down and lose
   nothing. Failures are recorded on the order row (notified / notify_error)
   instead of being thrown at the customer.

   ---------------------------------------------------------------------------
   Choosing a provider
   ---------------------------------------------------------------------------
   telegram  A Telegram bot. Free, official, no template approval and no
             sending window — the full multi-line Arabic summary arrives as
             written. This is the recommended one and it wins over the
             WhatsApp providers when TELEGRAM_BOT_TOKEN is set.
   meta      Official WhatsApp Cloud API. Free tier, needs a Meta Business
             account and a verified number. Business-initiated messages
             outside a 24-hour customer window MUST use an approved template,
             so set WHATSAPP_TEMPLATE to your approved template name. Plain
             text is used only if WHATSAPP_ALLOW_TEXT=1 and you know the
             recipient messaged you in the last 24 hours.
   ultramsg  Unofficial bridge to a normal WhatsApp account. No template
             approval, no 24-hour rule. Paid, and it is not Meta-sanctioned.
   twilio    Twilio's WhatsApp channel. Same template rules as Meta.
   callmebot Free, one recipient, plain text. Fine for "ping my phone".

   Set NOTIFY_PROVIDER (or the older WHATSAPP_PROVIDER) to force one;
   otherwise the first provider with complete credentials wins, in the order
   above.
   ========================================================================= */
import { merchantWa } from './orders.js';

const TIMEOUT_MS = 8000;

/* The approved template to fall back on when WHATSAPP_TEMPLATE is not in the
   environment.

   It has a default rather than being purely configuration because the
   configuration did not arrive. wrangler.toml [vars] are not picked up by
   this Git-built Pages project, so WHATSAPP_TEMPLATE was empty at runtime and
   every alert took the plain-text path — which is undeliverable to the shop's
   own number outside a 24-hour window. The failure was silent in the sense
   that the variable looked set in the repo.

   The name and language match the template functions/api/order-webhook.js was
   already written against, so this is the shop's real template, not a guess.
   An env var still wins if one is ever set. If the template turns out not to
   be approved the send falls back to plain text anyway, so a wrong default
   costs nothing that the previous behaviour did not already cost. */
const DEFAULT_TEMPLATE = 'new_order_alert';
const DEFAULT_TEMPLATE_LANG = 'en_US';

function templateName(env) {
  const v = env && typeof env.WHATSAPP_TEMPLATE === 'string' ? env.WHATSAPP_TEMPLATE.trim() : '';
  return v || DEFAULT_TEMPLATE;
}

function templateLang(env) {
  const v = env && typeof env.WHATSAPP_TEMPLATE_LANG === 'string' ? env.WHATSAPP_TEMPLATE_LANG.trim() : '';
  return v || DEFAULT_TEMPLATE_LANG;
}

function has(env, ...keys) {
  return keys.every((k) => env && typeof env[k] === 'string' && env[k].trim().length > 0);
}

/* Reads the first of several names that is actually set.

   This exists because the names Meta uses in its own dashboard and docs
   (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID) are not the shorter ones
   this file was originally written against. Secrets were provisioned under
   Meta's names, pickProvider looked for the short ones, found nothing, and
   every order recorded `none: no_provider_configured` while the credentials
   sat there correctly configured. Accepting both spellings costs nothing and
   removes a failure mode that is invisible until you read the order rows. */
function firstOf(env, ...keys) {
  for (const k of keys) {
    const v = env && env[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export function metaToken(env)   { return firstOf(env, 'WHATSAPP_TOKEN', 'WHATSAPP_ACCESS_TOKEN'); }
export function metaPhoneId(env) { return firstOf(env, 'WHATSAPP_PHONE_ID', 'WHATSAPP_PHONE_NUMBER_ID'); }

/* The bot token from @BotFather, as `<bot id>:<secret>`. TELEGRAM_TOKEN is
   accepted too because that is the shorter name people reach for. */
export function telegramToken(env) { return firstOf(env, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN'); }
export function telegramChatId(env) { return firstOf(env, 'TELEGRAM_CHAT_ID', 'TELEGRAM_TO'); }

export function pickProvider(env) {
  const forced = firstOf(env, 'NOTIFY_PROVIDER', 'WHATSAPP_PROVIDER').toLowerCase();
  if (forced) return forced;
  if (telegramToken(env)) return 'telegram';
  if (metaToken(env) && metaPhoneId(env)) return 'meta';
  if (has(env, 'ULTRAMSG_INSTANCE', 'ULTRAMSG_TOKEN')) return 'ultramsg';
  if (has(env, 'TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_FROM')) return 'twilio';
  if (has(env, 'CALLMEBOT_KEY')) return 'callmebot';
  return 'none';
}

async function post(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal }, init));
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Meta WhatsApp Cloud API ----------------

   Two shapes of message, and which one you get matters more than it looks.

   A plain text message is only deliverable inside a 24-hour "customer service
   window" — that is, within a day of the recipient messaging the business
   number. An order alert to the shop's own phone is almost never inside that
   window, so plain text fails with error 131047 and the alert is lost exactly
   when it is wanted. A template has no such restriction, which is why one is
   used whenever WHATSAPP_TEMPLATE names one.

   Template body parameters cannot contain newlines, and Meta rejects four or
   more consecutive spaces, so anything passed here is flattened first. */
function templatePayload(env, to, params) {
  const clean = (s) => String(s).replace(/\s*\n\s*/g, ' · ').replace(/ {4,}/g, ' ').slice(0, 1024);
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName(env),
      language: { code: templateLang(env) },
      components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: clean(p) })) }]
    }
  };
}

function textPayload(to, text) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) }
  };
}

async function sendMeta(env, to, text, templateParams) {
  const version = (env.WHATSAPP_API_VERSION || 'v21.0').trim();
  const url = `https://graph.facebook.com/${version}/${metaPhoneId(env)}/messages`;
  const headers = {
    authorization: `Bearer ${metaToken(env)}`,
    'content-type': 'application/json'
  };
  const send = (payload) => post(url, { method: 'POST', headers, body: JSON.stringify(payload) });

  const template = templateName(env);
  const allowText = String(env.WHATSAPP_ALLOW_TEXT || '') === '1';

  if (template && !allowText) {
    /* Caller-supplied parameters when the approved template expects several
       (order number, total); otherwise the whole summary in a single {{1}}. */
    const params = Array.isArray(templateParams) && templateParams.length
      ? templateParams
      : [text];
    try {
      return await send(templatePayload(env, to, params));
    } catch (err) {
      /* A template send fails for reasons worth surviving: the name is not
         approved yet, or the parameter count does not match what was
         approved. Plain text still works if someone happens to have messaged
         the number recently, so it is worth one attempt before giving up —
         a message that arrives is better than a correct-looking failure. */
      try {
        return await send(textPayload(to, text));
      } catch (textErr) {
        throw new Error(`template failed (${err.message}); text fallback also failed (${textErr.message})`);
      }
    }
  }

  return send(textPayload(to, text));
}

/* ---------------- UltraMsg ---------------- */
async function sendUltramsg(env, to, text) {
  const url = `https://api.ultramsg.com/${env.ULTRAMSG_INSTANCE.trim()}/messages/chat`;
  const form = new URLSearchParams({
    token: env.ULTRAMSG_TOKEN.trim(),
    to: '+' + to,
    body: text.slice(0, 4096)
  });
  return post(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
}

/* ---------------- Twilio ---------------- */
async function sendTwilio(env, to, text) {
  const sid = env.TWILIO_SID.trim();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const form = new URLSearchParams({
    From: `whatsapp:+${env.TWILIO_FROM.trim().replace(/\D/g, '')}`,
    To: `whatsapp:+${to}`,
    Body: text.slice(0, 1600)
  });
  return post(url, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${sid}:${env.TWILIO_TOKEN.trim()}`),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
}

/* ---------------- CallMeBot ---------------- */
async function sendCallmebot(env, to, text) {
  const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({
    phone: '+' + to,
    apikey: env.CALLMEBOT_KEY.trim(),
    text: text.slice(0, 1000)
  }).toString();
  return post(url, { method: 'GET' });
}

/* ---------------- Telegram Bot API ----------------

   The simplest of the five, and the reason it is first in pickProvider: no
   template approval, no 24-hour window, no per-message cost. The message is
   sent exactly as orderMessage() composed it, newlines and Arabic intact —
   none of the flattening the WhatsApp template path has to do.

   Two things it needs that a phone number is not:

   - the bot token, `<bot id>:<secret>` from @BotFather;
   - a chat id, which is NOT a phone number. It is the id of the chat the bot
     posts into: your own user id for a direct message, or a negative id like
     -1001234567890 for a group or channel the bot has been added to.

   A bot cannot open a conversation with you. Message the bot once (or add it
   to the group) before expecting anything to arrive. */
const TELEGRAM_LIMIT = 4096;

function telegramApi(env, method) {
  return `https://api.telegram.org/bot${telegramToken(env)}/${method}`;
}

/* Falls back to asking the bot who has talked to it.

   TELEGRAM_CHAT_ID is the supported way to configure this, but the id is a
   number nobody has to hand — the usual way to find it is to message the bot
   and read getUpdates. Doing that lookup here means the shop notifies
   correctly with the token alone, which is all you get from @BotFather.

   It is a fallback and not the main path on purpose: getUpdates only returns
   updates from the last 24 hours, returns nothing at all once a webhook is
   set on the bot, and is drained by anything else polling the same bot. Set
   TELEGRAM_CHAT_ID once it is known. */
async function resolveChatId(env) {
  const configured = telegramChatId(env);
  if (configured) return configured;

  const body = await post(telegramApi(env, 'getUpdates') + '?limit=100', { method: 'GET' });
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('getUpdates returned unparseable JSON');
  }

  const updates = Array.isArray(data && data.result) ? data.result : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i] || {};
    const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    const id = msg && msg.chat && msg.chat.id;
    if (id !== undefined && id !== null) return String(id);
  }

  throw new Error(
    'no TELEGRAM_CHAT_ID set and getUpdates is empty — send your bot a message, then read the chat id from getUpdates and set it'
  );
}

async function sendTelegram(env, text, toOverride) {
  const chatId = toOverride || await resolveChatId(env);
  const body = await post(telegramApi(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, TELEGRAM_LIMIT),
      disable_web_page_preview: true
    })
  });

  /* Telegram answers 4xx for the failures that matter, which post() already
     throws on. This catches the rest: a 200 carrying ok:false. */
  try {
    const data = JSON.parse(body);
    if (data && data.ok === false) {
      throw new Error(`telegram: ${data.description || 'ok:false'}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) return body;   // unexpected shape, but a 200
    throw err;
  }
  return body;
}

/* -------------------------------------------------------------------------
   The one entry point. Never throws.

   `toOverride` is read in whatever the chosen provider's address space is: a
   phone number for the WhatsApp providers, a chat id for Telegram.
   ------------------------------------------------------------------------- */
export async function notifyWhatsApp(env, text, toOverride, templateParams) {
  const provider = pickProvider(env);

  if (provider === 'none') {
    return { ok: false, provider, error: 'no_provider_configured' };
  }

  /* Telegram takes the whole message and addresses a chat, not a phone, so it
     skips both the phone normalisation and the template machinery below. */
  if (provider === 'telegram') {
    if (!telegramToken(env)) {
      return { ok: false, provider, error: 'no_telegram_bot_token' };
    }
    try {
      await sendTelegram(env, text, toOverride ? String(toOverride).trim() : '');
      return { ok: true, provider, error: '' };
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      console.error('notify telegram', message);
      return { ok: false, provider, error: message.slice(0, 500) };
    }
  }

  const to = (toOverride || merchantWa(env)).replace(/\D/g, '');
  if (!to) {
    return { ok: false, provider, error: 'no_recipient' };
  }

  try {
    switch (provider) {
      case 'meta':      await sendMeta(env, to, text, templateParams); break;
      case 'ultramsg':  await sendUltramsg(env, to, text); break;
      case 'twilio':    await sendTwilio(env, to, text); break;
      case 'callmebot': await sendCallmebot(env, to, text); break;
      default:
        return { ok: false, provider, error: `unknown_provider:${provider}` };
    }
    return { ok: true, provider, error: '' };
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    console.error('whatsapp', provider, message);
    return { ok: false, provider, error: message.slice(0, 500) };
  }
}

/* Persists the outcome without ever letting a logging failure surface. Called
   from waitUntil, so the customer's response has already been sent. */
export async function recordNotify(d1, orderId, result) {
  try {
    await d1.prepare(
      'UPDATE orders SET notified = ?1, notify_error = ?2 WHERE id = ?3'
    ).bind(
      result.ok ? 1 : 0,
      result.ok ? null : `${result.provider}: ${result.error}`,
      orderId
    ).run();
  } catch (err) {
    console.error('recordNotify', err && err.message);
  }
}
