/* =========================================================================
   Sick-note storage.

   Same KV binding as the product images and a deliberately different set of
   rules, because these are not the same kind of thing at all. A product photo
   is published; a sick note is a medical document about an employee, and the
   difference has to show up in the code or it will not show up anywhere.

   WHAT IS DIFFERENT FROM lib/images.js
   ------------------------------------
   1. The key is unguessable. Product images are keyed by product id, because
      the whole point is that a URL can be predicted and cached. A certificate
      is keyed by random bytes, so possession of the key is itself part of the
      control rather than a slug anybody could type.

   2. There is no public route. Nothing in functions/assets/ serves these.
      They come back only through functions/api/leave/certificate.js, which
      checks who is asking on every single request.

   3. PDFs are allowed, because that is what a clinic emails you, and SVG is
      refused for the same reason lib/images.js refuses it — it is a document
      that can carry script, and it would be served from our own origin.

   4. They are DELETED when the request they belong to is deleted. An image
      outliving its product is untidy; a medical document outliving the reason
      it was collected is a different category of problem.
   ========================================================================= */

export const CERT_PREFIX = 'sick-cert:';

/* A phone camera photograph of a piece of paper, or a PDF from a clinic.
   Nothing else — this is not a general file store. */
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf'
};

/* 8 MB. A photo straight off a modern phone is comfortably under this; a
   multi-page scan at maximum quality is not, and refusing it with a message
   is kinder than storing something the browser then struggles to show. */
export const MAX_CERT_BYTES = 8 * 1024 * 1024;

export function certExtension(contentType) {
  return TYPES[String(contentType || '').toLowerCase().split(';')[0].trim()] || '';
}

export function certKey(random) {
  return CERT_PREFIX + random;
}

const kvOf = (env) => (env && env.KV) || null;

/* Stores the bytes and returns what the row needs to find them again.
   Throws a plain Error the caller turns into an ApiError — this module has no
   opinion about HTTP, same as lib/images.js. */
export async function putCertificate(env, keySuffix, file) {
  const kv = kvOf(env);
  if (!kv) throw new Error('no_kv');

  const ext = certExtension(file.type);
  if (!ext) throw new Error('bad_type');

  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('empty_file');
  if (buf.byteLength > MAX_CERT_BYTES) throw new Error('too_large');

  const key = certKey(keySuffix);
  await kv.put(key, buf, {
    metadata: {
      ct: String(file.type).split(';')[0].trim(),
      ext,
      bytes: buf.byteLength,
      /* The name the employee's own file had, for the download. Cleaned by
         the caller — it is attacker-controlled text that ends up in a
         Content-Disposition header. */
      name: String(file.name || '').slice(0, 120),
      uploaded: new Date().toISOString()
    }
  });
  return { key, ext, bytes: buf.byteLength };
}

export async function getCertificate(env, key) {
  const kv = kvOf(env);
  if (!kv || !key) return null;
  const res = await kv.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!res || !res.value) return null;
  return { body: res.value, metadata: res.metadata || {} };
}

export async function deleteCertificate(env, key) {
  const kv = kvOf(env);
  if (!kv || !key) return false;
  try {
    await kv.delete(key);
    return true;
  } catch (err) {
    console.error('certificate delete failed', err && err.message);
    return false;
  }
}
