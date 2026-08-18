/* =========================================================================
   Vision Guard — page.js

   The whole script for a static content page (privacy.html): language, theme,
   nav, burger menu and the footer year, all of which already live in site.js.

   It exists as a file rather than an inline <script> because the Content
   Security Policy in public/_headers allows exactly one inline script — the
   no-js class swap in every <head>, allow-listed by hash. A second inline
   block would be silently blocked, and the page would render with no working
   menu and no language button.
   ========================================================================= */
import { initChrome } from './site.js?v=66';

initChrome();
