import { json, handle, readJson, requireSameOrigin, ApiError } from '../../lib/util.js';
import { sendMetaEvent } from '../../lib/meta.js';

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const body = await readJson(request);
  if (!body || !Array.isArray(body.data) || body.data.length === 0) {
    throw new ApiError(400, 'bad_payload', 'The request body must include a non-empty data array.');
  }

  const result = await sendMetaEvent(env, body);
  if (!result.ok) {
    return json({ ok: false, error: result.error || result.reason || 'Meta API failed' }, result.status || 500);
  }

  return json({ ok: true, result: result.body }, result.status);
});
