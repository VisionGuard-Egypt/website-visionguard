/* =========================================================================
   /api/admin/ads — the creatives that go into Ads Manager. ADMIN ONLY.

   GET                      everything under /assets/ads/: the pack that
                            ships with the repo, and everything uploaded
   POST action: 'upload'    multipart — a name and a file
   POST action: 'delete'    remove an uploaded creative

   WHY AN ADMIN CAN DELETE SOME AND NOT OTHERS, said plainly because it will
   be the first question: an upload lives in KV and can be removed from a
   browser. The pack in public/assets/ads/ is part of the deployed static
   bundle, which Cloudflare Pages uploads at deploy time and no Worker can
   write to — removing one of those is a commit, and pretending otherwise
   with a button that fails would be worse than the honest absence of one.

   An upload CAN take a shipped creative's name, and then it wins: the route
   in functions/assets/ads/ checks KV first. That is the one way to correct a
   creative that is already live in a running ad without a deploy.
   ========================================================================= */
import { json, handle, requireSameOrigin, ApiError, clean, readJson } from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import {
  listAds, putAd, deleteAd, slugifyName, isAdName, MAX_AD_BYTES
} from '../../../lib/ads.js';

/* The manifest of the committed pack. Fetched through the site's own asset
   server rather than imported, because it is a static file and a Worker has
   no filesystem — see the note on the file itself. */
async function shippedAds(request, env) {
  try {
    const url = new URL('/assets/ads/index.json', request.url);
    const res = env && env.ASSETS
      ? await env.ASSETS.fetch(new Request(url))
      : await fetch(url.toString());
    if (!res || !res.ok) return [];
    const data = await res.json();
    return (data.creatives || []).map((c) => ({
      name: String(c.file || '').replace(/\.[a-z0-9]+$/i, ''),
      file: c.file,
      path: `assets/ads/${c.file}`,
      title: c.title || '',
      concept: c.concept || '',
      lang: c.lang || '',
      ratio: c.ratio || '',
      /* '1080' marks the copy resampled to Meta's recommended size. */
      variant: c.variant || '',
      width: c.width || 0,
      height: c.height || 0,
      bytes: c.bytes || 0,
      /* What the tab keys its delete button off. */
      source: 'shipped'
    }));
  } catch (err) {
    /* A missing or malformed manifest costs the listing of the shipped pack
       and nothing else — the files still serve, and uploads still list. */
    console.error('ads manifest', err && err.message);
    return [];
  }
}

async function readUpload(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('multipart/form-data')) return null;
  const form = await request.formData();
  const file = form.get('file');
  return {
    action: clean(form.get('action'), 20) || 'upload',
    name: clean(form.get('name'), 80),
    file: file && typeof file === 'object' && typeof file.arrayBuffer === 'function' ? file : null
  };
}

/* ------------------------------------------------------------------ read */
export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  await requireAdmin(context, d1);

  const [shipped, uploads] = await Promise.all([
    shippedAds(request, env),
    listAds(env)
  ]);

  /* An upload that uses a shipped creative's name REPLACES it in the list as
     well as at the URL, so the tab shows one row per URL and it describes
     what is actually being served. */
  const byName = new Map(shipped.map((c) => [c.name, c]));
  for (const up of uploads) byName.set(up.name, Object.assign({}, byName.get(up.name), up));

  /* Uploads first, newest first within them. What somebody added five
     minutes ago is what they came to the tab to find; the shipped pack is a
     fixed list they already know. */
  const creatives = [...byName.values()].sort((a, b) => {
    if ((a.source === 'upload') !== (b.source === 'upload')) return a.source === 'upload' ? -1 : 1;
    if (a.source === 'upload') return String(b.updated || '').localeCompare(String(a.updated || ''));
    return String(a.name).localeCompare(String(b.name));
  });

  return json({
    ok: true,
    creatives,
    maxBytes: MAX_AD_BYTES,
    /* So the tab can build absolute URLs to copy, without guessing the host
       from the browser's address bar. */
    origin: new URL(request.url).origin
  });
});

/* ----------------------------------------------------------------- write */
export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  await requireAdmin(context, d1);

  const upload = await readUpload(request);

  /* ---- delete, which arrives as ordinary JSON ---- */
  if (!upload) {
    const body = await readJson(request);
    const action = clean(body.action, 20);
    if (action !== 'delete') {
      throw new ApiError(400, 'bad_action', 'action must be upload or delete.', { field: 'action' });
    }
    const name = clean(body.name, 80);
    if (!isAdName(name)) {
      throw new ApiError(400, 'bad_name', 'That is not a creative name.', { field: 'name' });
    }
    const removed = await deleteAd(env, name);
    if (!removed) {
      throw new ApiError(503, 'no_storage',
        'Image storage is not available, so nothing was deleted.');
    }
    /* Not an error if KV had no such key: the button is only drawn for
       uploads, and a double click should be quiet rather than alarming. */
    return json({ ok: true, deleted: name });
  }

  /* ---- upload ---- */
  if (upload.action !== 'upload') {
    throw new ApiError(400, 'bad_action', 'action must be upload or delete.', { field: 'action' });
  }
  if (!upload.file) {
    throw new ApiError(400, 'no_file', 'Choose an image first.', { field: 'file' });
  }

  /* The name is what the URL will be. Taken from the field when the admin
     typed one, and otherwise from the filename they chose — which is almost
     always what they meant, and saves typing "vg-ramadan-9x16" twice. */
  const name = slugifyName(upload.name || (upload.file.name || ''));
  if (!isAdName(name)) {
    throw new ApiError(400, 'bad_name',
      'Give the creative a name: lower-case letters, digits and hyphens, 2 to 64 characters.',
      { field: 'name' });
  }

  try {
    const stored = await putAd(env, name, upload.file);
    return json({ ok: true, creative: Object.assign({ source: 'upload' }, stored) }, 201);
  } catch (err) {
    const code = (err && err.message) || '';
    if (code === 'bad_type') {
      throw new ApiError(400, 'bad_image_type',
        'The creative must be a JPEG, PNG, WebP or GIF. SVG is not accepted.', { field: 'file' });
    }
    if (code === 'too_large') {
      throw new ApiError(413, 'image_too_large',
        `That file is over ${Math.round(MAX_AD_BYTES / (1024 * 1024))} MB. Export a smaller copy and upload that.`,
        { field: 'file' });
    }
    if (code === 'empty_file') {
      throw new ApiError(400, 'empty_file', 'That file is empty.', { field: 'file' });
    }
    if (code === 'no_kv') {
      throw new ApiError(503, 'no_storage',
        'Image storage is not connected, so the creative was not saved.');
    }
    throw err;
  }
});
