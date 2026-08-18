/* Meta WhatsApp webhook — https://www.visionguardeg.com/api/whatsapp/webhook
 *
 * This is the URL registered in the Meta dashboard, so it has to answer at
 * this path. The logic lives in ../order-webhook.js and is shared, because
 * two copies of a webhook is exactly how the previous pair drifted apart —
 * one of them was still reading secret names that had been renamed.
 *
 * It delegates through a locally declared handler rather than
 * `export { onRequest } from '../order-webhook.js'`. That re-export form is
 * valid JavaScript and does the right thing at runtime, but Pages decides
 * which routes exist by statically analysing each module for its exported
 * handlers, and a re-export is not recognised as one. The file deployed, the
 * route was never registered, and requests fell through to the static site —
 * so Meta's verification got the homepage HTML back with a 200 and failed
 * with no useful error. Declaring the export here is what makes the route
 * real.
 */
import { onRequest as shared } from '../order-webhook.js';

export const onRequest = (context) => shared(context);
