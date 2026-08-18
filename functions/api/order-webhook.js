/* Meta webhook — https://www.visionguardeg.com/api/order-webhook
 *
 * This path is the one already registered in the Meta dashboard, so it stays.
 * What changed is that it no longer carries its own copy of the WhatsApp
 * sending logic: that lives in lib/whatsapp.js, is used by the checkout, and
 * having a second implementation here is how the two drifted apart. This file
 * had been reading WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID, which
 * were later renamed in the dashboard to WHATSAPP_TOKEN / WHATSAPP_PHONE_ID —
 * so every send from here was `Bearer undefined` to `.../undefined/messages`.
 * One implementation, one set of names, one place to fix.
 *
 * Worth being explicit, because it is the natural assumption and it is wrong:
 * THIS ENDPOINT IS NOT WHAT ALERTS YOU ABOUT ORDERS FROM YOUR OWN SHOP. When
 * a customer checks out, functions/api/orders.js sends the WhatsApp message
 * directly. Nothing calls this. It exists for Meta to call us:
 *
 *   GET   subscription verification. Meta sends hub.mode, hub.verify_token
 *         and hub.challenge and wants the challenge echoed back as plain text
 *         if the token matches META_VERIFY_TOKEN.
 *   POST  delivery receipts and inbound replies, logged and acknowledged.
 *
 * It also still accepts an order payload on POST — from an external system
 * that wants to trigger the same alert — but that is a secondary use.
 */
import { notifyWhatsApp, pickProvider } from '../../lib/whatsapp.js';

/* Constant-time compare: the verify token is a shared secret on a public
   endpoint. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = (url.searchParams.get('hub.verify_token') || '').trim();
    const challenge = url.searchParams.get('hub.challenge') || '';

    const expected = typeof env.META_VERIFY_TOKEN === 'string' ? env.META_VERIFY_TOKEN.trim() : '';
    if (!expected) {
      /* Distinct from 403 on purpose. 403 means "your token is wrong"; this
         means "there is no token configured here at all", which is a
         different thing to go and fix. The previous version compared against
         undefined and answered 403, which sent you looking at the Meta
         dashboard for a problem that was on this side. */
      console.error('order-webhook: META_VERIFY_TOKEN is not set');
      return new Response('webhook not configured: META_VERIFY_TOKEN is missing', { status: 503 });
    }

    if (mode === 'subscribe' && timingSafeEqual(token, expected)) {
      return new Response(challenge, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    /* Configuration report: ?diag=1 with the verify token.

       This exists because "why did the WhatsApp alert not send" was, twice,
       a question about which variables the DEPLOYMENT can see — not about
       the code. Pages binds secrets at build time and wrangler.toml [vars]
       do not always reach a Git-built Pages project, so the dashboard
       showing a value is not evidence the running Function has it.

       It reports presence, length and a masked prefix. Never a value: this
       endpoint is public, and the verify token gating it is itself only a
       shared secret, not an authorisation system. A length and first four
       characters are enough to tell a Phone Number ID from a WABA ID, or a
       token that was truncated on paste, without disclosing anything usable. */
    if (url.searchParams.get('diag') === '1' && timingSafeEqual(token, expected)) {
      const shape = (v) => {
        if (typeof v !== 'string' || !v.trim()) return 'MISSING';
        const s = v.trim();
        return `set (len ${s.length}, starts "${s.slice(0, 4)}…")`;
      };
      return Response.json({
        note: 'presence and shape only — no values are ever returned',
        provider: pickProvider(env),
        telegram: {
          TELEGRAM_BOT_TOKEN: shape(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TOKEN),
          TELEGRAM_CHAT_ID: shape(env.TELEGRAM_CHAT_ID || env.TELEGRAM_TO),
          effect: (env.TELEGRAM_CHAT_ID || env.TELEGRAM_TO || '').trim()
            ? 'alerts go to the configured chat'
            : 'NO CHAT ID: falls back to getUpdates, which is empty unless the bot was messaged in the last 24h'
        },
        sending: {
          WHATSAPP_TOKEN: shape(env.WHATSAPP_TOKEN || env.WHATSAPP_ACCESS_TOKEN),
          WHATSAPP_PHONE_ID: shape(env.WHATSAPP_PHONE_ID || env.WHATSAPP_PHONE_NUMBER_ID),
          WHATSAPP_TO: shape(env.WHATSAPP_TO || env.MERCHANT_WHATSAPP || env.MY_PHONE_NUMBER)
        },
        template: {
          WHATSAPP_TEMPLATE: shape(env.WHATSAPP_TEMPLATE),
          WHATSAPP_TEMPLATE_LANG: shape(env.WHATSAPP_TEMPLATE_LANG),
          effect: (env.WHATSAPP_TEMPLATE || '').trim()
            ? 'template will be used — deliverable outside the 24h window'
            : 'NO TEMPLATE: plain text only, which fails with 131047 outside the 24h window'
        },
        webhook: { META_VERIFY_TOKEN: shape(env.META_VERIFY_TOKEN) },
        otherVars: {
          WORK_DAY_HOURS: shape(env.WORK_DAY_HOURS),
          SHIPPING_FLAT: shape(env.SHIPPING_FLAT)
        }
      }, { status: 200, headers: { 'cache-control': 'no-store' } });
    }

    return new Response('Forbidden', { status: 403 });
  }

  if (request.method === 'POST') {
    let body = null;
    try {
      body = await request.json();
    } catch (e) {
      return Response.json({ ok: true, ignored: 'unparseable' }, { status: 200 });
    }

    /* Meta's own callbacks: delivery receipts and inbound messages. These are
       the common case once the subscription is live. Always acknowledged —
       Meta disables a webhook that keeps failing, and an event we do not
       recognise is not worth losing the subscription over. */
    if (body && Array.isArray(body.entry)) {
      try {
        for (const entry of body.entry) {
          for (const change of entry.changes || []) {
            const v = change.value || {};
            for (const s of v.statuses || []) {
              if (s.status === 'failed') {
                const err = (s.errors && s.errors[0]) || {};
                console.error(`whatsapp ${s.status} id=${s.id} error=${err.code} ${err.title || ''}`);
              } else {
                console.log(`whatsapp ${s.status} id=${s.id} to=${s.recipient_id}`);
              }
            }
            for (const m of v.messages || []) {
              console.log(`whatsapp inbound from=${m.from} type=${m.type}`);
            }
          }
        }
      } catch (err) {
        console.error('order-webhook parse', err && err.message);
      }
      return Response.json({ ok: true }, { status: 200 });
    }

    /* Otherwise: an order payload from an external system asking us to send
       the same alert the shop's own checkout sends. */
    const orderId = String(body.order_id || body.id || 'N/A');
    const total = String(body.total_price || body.total || 'N/A');
    const text = `🔔 طلب جديد — Vision Guard\nرقم الطلب: ${orderId}\nالإجمالي: ${total}`;
    const result = await notifyWhatsApp(env, text, null, [orderId, total]);

    return Response.json(
      { ok: result.ok, provider: result.provider, error: result.error || undefined },
      { status: result.ok ? 200 : 502 }
    );
  }

  return new Response('method not allowed', { status: 405 });
}
