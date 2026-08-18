/* GET /api/geo   ->   { ok, country, regime }

   Which consent regime this visitor falls under, decided from Cloudflare's
   own geolocation rather than from anything the browser claims.

   Why this exists at all
   ----------------------
   The shop's audience is Egyptian and its advertising depends on the Meta
   pixel, so blocking the pixel behind an Accept click for every visitor would
   cost real measurement to satisfy a law that does not apply to most of them.
   Blocking it for nobody is not an option either: an EU, EEA or UK visitor has
   a right to refuse tracking BEFORE it happens, and a banner that appears
   after the pixel has already fired is decoration, not consent.

   So the regime is chosen per visitor:

     optin    EU + EEA + UK + Switzerland. public/consent.js keeps pixel.js
              from loading at all until Accept is clicked. Reject means no
              fbevents.js, no /api/capi, and no server-side Purchase relay.
     notice   everyone else, Egypt included. The pixel runs as it always has
              and the bar explains what is collected and how to turn it off.

   Why a Function and not a header on the HTML
   -------------------------------------------
   The static HTML is edge-cached and shared between visitors, so a country
   baked into it would eventually be served to someone in a different one —
   and the failure is silent and in the unsafe direction. This endpoint is
   `no-store` per visitor (lib/util.js sets that on every JSON response), so
   it is always the right answer for the person asking.

   The cost is one same-origin edge request on a first visit only: once a
   decision is stored, consent.js never calls this again, and within a session
   the answer is cached in sessionStorage.

   `cf-ipcountry` is set by Cloudflare on every request that reaches it and
   cannot be spoofed by the client — a forged header from the browser is
   overwritten at the edge before the Function sees it. XX/T1 are Cloudflare's
   own values for "unknown" and "Tor exit"; both are treated as opt-in, since
   an unknown visitor is exactly the one you cannot prove is outside the EU.
*/
import { json, handle } from '../../lib/util.js';

/* EU 27 + the three EEA states + the UK + Switzerland. Switzerland is not
   EEA and its revised FADP is not the GDPR, but it expects the same refusal
   right, and one extra country costs nothing here. */
const OPT_IN = new Set([
  /* EU 27 */
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
  /* EEA */
  'IS', 'LI', 'NO',
  /* UK, Switzerland */
  'GB', 'CH',
  /* unknown origin and Tor: treated as opt-in, see the note above */
  'XX', 'T1'
]);

export const onRequestGet = handle(async ({ request }) => {
  const country = (request.headers.get('cf-ipcountry') || 'XX').toUpperCase();
  return json({
    ok: true,
    country,
    regime: OPT_IN.has(country) ? 'optin' : 'notice'
  });
});
