/* POST /api/assist  { messages: [{ role, content }, …] }

   The shop assistant. Runs entirely on Cloudflare: the request lands in this
   Pages Function and the answer comes from Workers AI through the `AI`
   binding, so there is no third-party API key to hold and no other company
   in the path of a customer's question.

   Stateless by design. The browser keeps the thread and sends it back each
   turn; nothing about a conversation is stored, which is also why there is
   nothing here to leak. */
import {
  json, handle, readJson, requireSameOrigin, clean, clientIp, ApiError
} from '../../lib/util.js';
import { db, enforceRate } from '../../lib/db.js';
import {
  systemPrompt, sanitiseHistory, replyText, modelFor, MAX_TOKENS, REMINDER
} from '../../lib/assistant.js';

export const onRequestPost = handle(async ({ request, env }) => {
  requireSameOrigin(request);

  /* Every turn costs Workers AI neurons, so this is a spend limit as much as
     an abuse limit. Generous enough that a real conversation never sees it. */
  const d1 = await db(env);
  await enforceRate(d1, `assist:${clientIp(request)}`, 40, 3600);

  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new ApiError(
      503, 'assistant_off',
      'The assistant is not switched on for this deployment yet.'
    );
  }

  const body = await readJson(request);
  const history = sanitiseHistory(body.messages, clean);
  if (!history.length) {
    throw new ApiError(400, 'empty_message', 'Send a message for the assistant to answer.');
  }

  let result;
  try {
    result = await env.AI.run(modelFor(env), {
      messages: [
        { role: 'system', content: systemPrompt() },
        ...history,
        { role: 'system', content: REMINDER }
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.3
    });
  } catch (err) {
    /* A bad model id, an unbound account or a Workers AI outage all land
       here. The customer gets one clear sentence and the WhatsApp number;
       the detail goes to the log where it is useful. */
    console.error('assist: AI.run failed', err && err.stack ? err.stack : err);
    throw new ApiError(
      502, 'assistant_unavailable',
      'The assistant could not answer just now. Please try again, or message us on WhatsApp.'
    );
  }

  const reply = clean(replyText(result), 4000);
  if (!reply) {
    throw new ApiError(
      502, 'assistant_unavailable',
      'The assistant could not answer just now. Please try again, or message us on WhatsApp.'
    );
  }

  return json({ ok: true, reply });
});
