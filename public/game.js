/* =========================================================================
   Vision Guard — game.js
   The coverage planner.

   Place cameras on a floor plan, see what they would actually cover, and turn
   the result into ONE order containing the whole system — cameras, recorder,
   drive, power supply, cable and connectors.

   Every number the customer sees comes from the real catalogue and from
   game-data.js. Nothing here invents a price or a product: the cameras are
   catalog.js rows filtered to the camera categories, and the order it builds
   goes into the same vg-cart the shop uses, so the checkout, the server-side
   re-pricing and the WhatsApp alert are all the ones that already exist.

   HOW COVERAGE IS COMPUTED
   ------------------------
   By sampling, not by adding up cone areas. The plan is walked on a 0.4m grid
   and each point is asked "can any camera see this?" — which means overlapping
   cameras are counted once rather than twice, and a camera pointed at a wall
   contributes what it really contributes. Summing sector areas is the obvious
   approach and it lies in both directions: it double-counts overlap and it
   credits coverage that is on the far side of a wall.

   Walls block. A camera in the hallway does not see through the flat into the
   bedroom, because every sample is checked against the wall segments in
   game-data.js. That is the difference between a toy and something a customer
   can make a purchase decision on.
   ========================================================================= */
import { $, $$, initChrome, onLang, LANG, t, money, currency, esc, toast } from './site.js?v=66';
import { PRODUCTS as STATIC_PRODUCTS, imageFor } from './catalog.js?v=66';
import {
  LENS, PROPERTIES, SYSTEM, specFor, SIZES, AREA_COUNTS, buildProperty,
  resizeScene, moveWall, isOuterWall, MIN_PLAN, EDIT_MAX
} from './game-data.js?v=66';

initChrome();

/* Wired cameras record to a DVR; Wi-Fi ones do not. Both are cameras. */
const CAMERA_CATS = ['analog', 'ip', 'wireless'];

let CATALOG = STATIC_PRODUCTS.slice();
const byId = (id) => CATALOG.find((p) => p.id === id);
const cameras = () => CATALOG.filter((p) => CAMERA_CATS.includes(p.cat) && p.active !== 0);

/* =========================================================================
   COPY
   ========================================================================= */
const T = {
  step1:       { ar: 'اختار نوع المكان', en: 'Choose your property' },
  step2:       { ar: 'حط الكاميرات', en: 'Place your cameras' },
  indoor:      { ar: 'داخلي', en: 'Indoor' },
  outdoor:     { ar: 'خارجي', en: 'Outdoor' },
  addCam:      { ar: 'ضيف كاميرا', en: 'Add camera' },
  suggest:     { ar: 'رشّحلي أماكن', en: 'Suggest placement' },
  editWalls:   { ar: 'عدّل الحيطان', en: 'Edit walls' },
  doneWalls:   { ar: 'خلصت التعديل', en: 'Done editing' },
  widthM:      { ar: 'العرض (متر)', en: 'Width (m)' },
  depthM:      { ar: 'العمق (متر)', en: 'Depth (m)' },
  resetPlan:   { ar: 'رجّع الأصلي', en: 'Reset plan' },
  addDrawing:  { ar: 'حط رسمة المكان', en: 'Add your drawing' },
  drawingFade: { ar: 'وضوح الرسمة', en: 'Drawing opacity' },
  removeDrawing:{ ar: 'شيل الرسمة', en: 'Remove drawing' },
  editHelp:    {
    ar: 'اسحب حيطة برّانية عشان تكبّر المكان أو تصغّره، واسحب أي حيطة جوّه عشان تحرّكها. الرسمة اللي بترفعها بتفضل في التاب ده بس — مش بتترفع على السيرفر ولا بتتحفظ عندنا.',
    en: 'Drag an outer wall to resize the place, or any inner wall to move it. A drawing you add stays in this tab only — it is never uploaded and we never keep it.'
  },
  tooBigImg:   { ar: 'الصورة كبيرة أوي. اختار صورة أصغر من ٨ ميجا.', en: 'That image is too large. Pick one under 8 MB.' },
  badImg:      { ar: 'مش قادرين نقرا الصورة دي.', en: 'That image could not be read.' },
  clear:       { ar: 'امسح الكل', en: 'Clear all' },
  tapPlan:     { ar: 'دوس على الرسمة عشان تحط كاميرا', en: 'Tap the plan to place a camera' },
  noCams:      { ar: 'لسه مافيش كاميرات. دوس على الرسمة أو استخدم «رشّحلي أماكن».', en: 'No cameras yet. Tap the plan, or use “Suggest placement”.' },
  camera:      { ar: 'كاميرا', en: 'Camera' },
  aim:         { ar: 'الاتجاه', en: 'Direction' },
  remove:      { ar: 'شيل', en: 'Remove' },
  coverage:    { ar: 'التغطية', en: 'Coverage' },
  covered:     { ar: 'مساحة مغطاة', en: 'Covered area' },
  ofPlan:      { ar: 'من المساحة', en: 'of the plan' },
  monitored:   { ar: 'الأماكن المغطاة', en: 'Monitored zones' },
  blind:       { ar: 'أماكن مكشوفة', en: 'Not covered' },
  approx:      { ar: 'تقديري — بيحسب الحوائط، بس التركيب الفعلي بيتظبط في المعاينة.', en: 'Approximate — walls are accounted for, but the real install is set at survey.' },
  score:       { ar: 'التقييم', en: 'Score' },
  sysTitle:    { ar: 'النظام الكامل', en: 'The complete system' },
  sysNote:     { ar: 'الكاميرات لوحدها مش نظام. ده كل اللي محتاجه التركيب يشتغل.', en: 'Cameras alone are not a system. This is everything the install needs to work.' },
  total:       { ar: 'الإجمالي', en: 'Total' },
  order:       { ar: 'اطلب النظام ده', en: 'Order this system' },
  print:       { ar: 'اطبع الملخص', en: 'Print summary' },
  qty:         { ar: 'عدد', en: 'Qty' },
  placeFirst:  { ar: 'حط كاميرا واحدة على الأقل الأول.', en: 'Place at least one camera first.' },
  added:       { ar: 'النظام اتحط في السلة — كمّل الطلب.', en: 'System added to your cart — finish the order.' },
  gradeA:      { ar: 'تغطية ممتازة', en: 'Excellent coverage' },
  gradeB:      { ar: 'تغطية كويسة', en: 'Good coverage' },
  gradeC:      { ar: 'تغطية مقبولة', en: 'Basic coverage' },
  gradeD:      { ar: 'لسه فيه فجوات كبيرة', en: 'Big gaps left' },
  lensLabel:   { ar: 'العدسة', en: 'Lens' },
  rangeLabel:  { ar: 'المدى', en: 'Range' },
  fovLabel:    { ar: 'زاوية الرؤية', en: 'Field of view' },
  outdoorOnly: { ar: 'مقاومة للعوامل الجوية', en: 'Weatherproof' },
  wifi:        { ar: 'واي فاي — من غير أسلاك', en: 'Wi-Fi — no cabling' },
  wired:       { ar: 'سلكية — محتاجة DVR', en: 'Wired — needs a recorder' },
  noneOutdoor: { ar: 'مافيش كاميرات خارجية مناسبة في الكتالوج دلوقتي.', en: 'No weatherproof cameras available right now.' },

  /* The three questions in step 1 */
  q1:          { ar: 'المكان ده إيه؟', en: 'What kind of place is it?' },
  q2:          { ar: 'مساحته قد إيه؟', en: 'Roughly how big is it?' },
  q3:          { ar: 'كام مكان جوّه محتاج تغطية؟', en: 'How many separate areas need covering?' },
  back:        { ar: 'رجوع', en: 'Back' },
  orPreset:    { ar: 'أو ابدأ من مخطط جاهز', en: 'Or start from a ready-made plan' },
  areasWord:   { ar: 'أماكن', en: 'areas' },
  redoQuiz:    { ar: 'غيّر الإجابات', en: 'Change the answers' },
  builtFor:    { ar: 'رسمنا المخطط ده على مقاسك', en: 'This plan was drawn to your answers' }
};

/* =========================================================================
   STATE
   ========================================================================= */
const state = {
  property: null,          // key of PROPERTIES
  mode: 'indoor',          // 'indoor' | 'outdoor'
  cams: [],                // { id, x, y, aim, productId }
  selected: null,
  nextId: 1,
  /* A plan drawn from the three answers in step 1, or null when a ready-made
     property is in use. See property() below. */
  built: null,
  answers: { type: null, size: null, areas: null },

  /* ---- editing the plan ----

     `edited` holds the customer's own version of a scene, keyed by mode, so
     switching indoor/outdoor and back does not throw their walls away. The
     plan they started from is never mutated, which is what makes "reset"
     a deletion rather than an attempt to undo arithmetic.

     `ref` is a drawing they uploaded to measure against. It lives in
     sessionStorage and NOWHERE ELSE — see loadRef(). */
  editing: false,
  edited: { indoor: null, outdoor: null },
  ref: null,          // { src, opacity }
  dragWall: null      // in-flight wall drag
};

/* The plan currently on screen.

   `state.built` holds a plan drawn from the three answers in step 1; when it
   is set it wins over the ready-made property. Both are the same shape — see
   buildProperty() in game-data.js — so nothing downstream of here has to know
   which one it is looking at. */
const property = () => state.built || PROPERTIES[state.property];
/* The customer's edited version of this scene wins over the one they started
   from. Everything downstream — coverage, walls, zones, the summary — reads
   through here, so an edited plan is scored exactly like a stock one and no
   caller has to know which it is looking at. */
const plan = () => state.edited[state.mode] || property()[state.mode];
const stockPlan = () => property()[state.mode];
/* The property is the type; the SCENE is the plan you are currently looking
   at. Geometry always comes from the scene — see the note in game-data.js. */

/* =========================================================================
   GEOMETRY

   Angles are degrees, clockwise from east, matching the SVG coordinate system
   (y grows downward) so nothing has to be flipped at render time.
   ========================================================================= */
const rad = (d) => (d * Math.PI) / 180;
/* Back to whole degrees in 0–359, which is the range the direction slider in
   the camera list uses. Keeping the two in the same units means a drag on the
   plan and the slider are writing the same number to the same field. */
const deg = (r) => {
  const d = Math.round((r * 180) / Math.PI);
  return ((d % 360) + 360) % 360;
};

function angleDiff(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return Math.abs(d);
}

/* Do segments AB and CD cross? Used to ask whether a wall stands between a
   camera and the point it is being asked about. */
function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/* Distance from a point to a segment — used to let a camera mounted ON a wall
   see past it. Without this, every camera screwed to the outside wall would
   be blinded by the wall it is bolted to. */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let tt = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  tt = Math.max(0, Math.min(1, tt));
  const qx = x1 + tt * dx, qy = y1 + tt * dy;
  return Math.hypot(px - qx, py - qy);
}

function blocked(cam, px, py, walls) {
  for (const w of walls) {
    /* A wall the camera is mounted on does not block it. */
    if (distToSeg(cam.x, cam.y, w[0], w[1], w[2], w[3]) < 0.4) continue;
    if (crosses(cam.x, cam.y, px, py, w[0], w[1], w[2], w[3])) return true;
  }
  return false;
}

function sees(cam, px, py, walls) {
  const spec = cam.spec;
  const dx = px - cam.x, dy = py - cam.y;
  const dist = Math.hypot(dx, dy);
  if (dist > spec.range) return false;
  if (dist > 0.001) {
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angleDiff(ang, cam.aim) > spec.fov / 2) return false;
  }
  return !blocked(cam, px, py, walls);
}

/* The whole coverage answer, computed once per change. */
const GRID = 0.4;

function computeCoverage() {
  const p = plan();
  const walls = p.walls;
  const live = state.cams.map((c) => Object.assign({}, c, { spec: specFor(byId(c.productId)) }));

  let total = 0, hit = 0;
  for (let x = GRID / 2; x < p.w; x += GRID) {
    for (let y = GRID / 2; y < p.h; y += GRID) {
      total++;
      for (const c of live) {
        if (sees(c, x, y, walls)) { hit++; break; }
      }
    }
  }

  const zonesCovered = [], zonesBlind = [];
  p.zones.forEach((z) => {
    const seen = live.some((c) => sees(c, z.x, z.y, walls));
    (seen ? zonesCovered : zonesBlind).push(z);
  });

  return {
    pct: total ? Math.round((hit / total) * 100) : 0,
    area: Math.round(hit * GRID * GRID),
    planArea: Math.round(p.w * p.h),
    zonesCovered,
    zonesBlind
  };
}

/* =========================================================================
   THE PLAN, DRAWN

   viewBox is in metres, so every length in game-data.js is literal and a
   camera's range is drawn at exactly the scale of the building.
   ========================================================================= */
function conePath(cam, spec) {
  const r = spec.range;
  /* A 300° PTZ sweep is very nearly a circle; drawing it as one arc keeps the
     path simple and reads correctly. */
  if (spec.fov >= 350) {
    return `M ${cam.x - r} ${cam.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
  }
  const a1 = rad(cam.aim - spec.fov / 2);
  const a2 = rad(cam.aim + spec.fov / 2);
  const x1 = cam.x + r * Math.cos(a1), y1 = cam.y + r * Math.sin(a1);
  const x2 = cam.x + r * Math.cos(a2), y2 = cam.y + r * Math.sin(a2);
  const large = spec.fov > 180 ? 1 : 0;
  return `M ${cam.x} ${cam.y} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function renderPlan() {
  const svg = $('#planSvg');
  if (!state.property) return;
  const p = plan();

  /* THE MARGIN IS THE OUTDOORS, and it grows with the building.

     Making the plan bigger has to read as the camera pulling BACK, not as
     the drawing bursting its box. The viewBox has always been derived from
     the plan, so the zoom already happened — what was missing was anything
     out there to see it against: at a half-metre margin the building filled
     the frame edge to edge and resizing looked like nothing moved.

     A proportional margin with a floor means there is always ground around
     the building, and dragging a wall outward visibly zooms out onto it. */
  const m = Math.max(1.2, Math.min(p.w, p.h) * 0.12);
  svg.setAttribute('viewBox', `${-m} ${-m} ${p.w + m * 2} ${p.h + m * 2}`);

  const ground = `<rect class="pl-ground" x="${-m}" y="${-m}" width="${p.w + m * 2}" height="${p.h + m * 2}"/>`;
  /* The building's own footprint, so the inside reads as inside even before
     a single room is drawn on it. */
  const slab = `<rect class="pl-slab" x="0" y="0" width="${p.w}" height="${p.h}" rx="0.2"/>`;

  /* The uploaded drawing, under everything. Stretched to the building rather
     than placed at a scale of its own: the customer is matching the plan to
     their drawing by dragging walls, so the drawing is the reference and the
     plan moves to meet it. */
  const ref = state.ref
    ? `<image class="pl-ref" href="${esc(state.ref.src)}" x="0" y="0"
              width="${p.w}" height="${p.h}" preserveAspectRatio="none"
              opacity="${(Number(state.ref.opacity) || 45) / 100}"/>`
    : '';

  const rooms = p.rooms.map((r) => `
    <rect class="pl-room" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="0.2"/>
    <text class="pl-roomlabel" x="${r.x + r.w / 2}" y="${r.y + r.h / 2}">${esc(t(r))}</text>`).join('');

  const walls = p.walls.map((w, i) => {
    const outer = isOuterWall(p, w);
    const grab = state.editing
      ? ` data-wall="${i}" data-outer="${outer ? 1 : 0}"`
      : '';
    return `<line class="pl-wall${state.editing ? ' is-editable' : ''}${outer ? ' is-outer' : ''}"
                  x1="${w[0]}" y1="${w[1]}" x2="${w[2]}" y2="${w[3]}"${grab}/>`;
  }).join('');

  /* A fat invisible line over each wall, only while editing. A wall is drawn
     a few centimetres wide in plan metres, which is an impossible target on
     a phone; this gives the drag a thumb-sized area without making the
     drawing look like a diagram of its own controls. */
  const grips = state.editing
    ? p.walls.map((w, i) => {
        const outer = isOuterWall(p, w);
        const vertical = Math.abs(w[0] - w[2]) < 0.05;
        return `<line class="pl-wallgrip${outer ? ' is-outer' : ''}"
                      x1="${w[0]}" y1="${w[1]}" x2="${w[2]}" y2="${w[3]}"
                      data-wall="${i}" data-outer="${outer ? 1 : 0}"
                      style="cursor:${vertical ? 'ew-resize' : 'ns-resize'}"/>`;
      }).join('')
    : '';

  const cov = state.cams.map((c) => {
    const spec = specFor(byId(c.productId));
    const on = state.selected === c.id;
    return `<path class="pl-cone${on ? ' is-on' : ''}" d="${conePath(c, spec)}"/>`;
  }).join('');

  const zoneDots = p.zones.map((z) => {
    const live = state.cams.map((c) => Object.assign({}, c, { spec: specFor(byId(c.productId)) }));
    const seen = live.some((c) => sees(c, z.x, z.y, p.walls));
    return `<g class="pl-zone${seen ? ' is-seen' : ''}">
      <circle cx="${z.x}" cy="${z.y}" r="0.32"/>
      <text x="${z.x}" y="${z.y - 0.7}">${esc(t(z))}</text>
    </g>`;
  }).join('');

  const cams = state.cams.map((c, i) => {
    const on = state.selected === c.id;
    /* The turn grip, drawn on the selected camera only.

       Dragging anywhere on the marker turns it, but nothing about a plain dot
       says so. The grip sits out along the aim direction, so the control and
       the thing it controls are the same shape pointing the same way: take
       hold of it, swing it round, the cone follows. On the selected camera
       only, because sixty grips on a busy plan is clutter rather than a hint.

       Inside the same <g>, so it inherits the translate and is covered by the
       marker's own hit test — the gesture handler asks for .pl-cam and gets it
       whether the grip or the dot was grabbed. */
    const grip = on ? (() => {
      const a = rad(c.aim);
      const gx = (Math.cos(a) * 2.1).toFixed(3);
      const gy = (Math.sin(a) * 2.1).toFixed(3);
      return `<line class="pl-grip__arm" x1="0" y1="0" x2="${gx}" y2="${gy}"/>
              <circle class="pl-grip" cx="${gx}" cy="${gy}" r="0.46"/>`;
    })() : '';
    return `<g class="pl-cam${on ? ' is-on' : ''}" data-cam="${c.id}" transform="translate(${c.x} ${c.y})">
      ${grip}
      <circle class="pl-cam__dot" r="0.75"/>
      <text y="0.28">${i + 1}</text>
    </g>`;
  }).join('');

  /* Grips last so they sit above the cameras: while editing, a drag on a wall
     must win over a drag on a camera marker that happens to overlap it. */
  svg.innerHTML = ground + slab + ref + rooms + walls + cov + zoneDots + cams + grips;
}

/* =========================================================================
   PANELS
   ========================================================================= */
/* =========================================================================
   STEP 1, AS THREE QUESTIONS

   One question on screen at a time. Answering the last one draws the plan and
   scrolls to it, so the shortest path from landing on the page to turning a
   camera on your own floor plan is three taps.

   The answers live in state.answers rather than in the DOM, so re-rendering
   for a language switch cannot lose them.
   ========================================================================= */
const QUIZ_TYPES = ['apartment', 'villa', 'company', 'compound'];

function quizRender() {
  const a = state.answers;

  $('#qType').innerHTML = QUIZ_TYPES.map((k) => {
    const p = PROPERTIES[k];
    return `<button class="qopt${a.type === k ? ' is-on' : ''}" type="button" data-qtype="${esc(k)}">
      <span class="qopt__icon" aria-hidden="true">${p.icon}</span>
      <span class="qopt__label">${esc(t(p))}</span>
    </button>`;
  }).join('');

  /* The area is shown per answer, because "medium" means nothing on its own
     and a customer who recognises 140m² trusts the camera count that follows
     from it. It depends on the type, so this list is redrawn once the first
     question is answered. */
  const type = a.type || 'apartment';
  $('#qSize').innerHTML = Object.keys(SIZES).map((k) => {
    const s = SIZES[k];
    return `<button class="qopt${a.size === k ? ' is-on' : ''}" type="button" data-qsize="${esc(k)}">
      <span class="qopt__label">${esc(t(s))}</span>
      <span class="qopt__sub">${s[type]} m²</span>
    </button>`;
  }).join('');

  $('#qAreas').innerHTML = AREA_COUNTS.map((n) => `
    <button class="qopt qopt--n${a.areas === n ? ' is-on' : ''}" type="button" data-qareas="${n}">
      <span class="qopt__label">${n}</span>
    </button>`).join('');

  /* Which question is on screen: the first one still unanswered. */
  const at = a.type === null ? 0 : a.size === null ? 1 : 2;
  $$('.quiz__step').forEach((el) => {
    el.classList.toggle('is-on', Number(el.dataset.q) === at);
  });
  $('#quizBack').hidden = at === 0;

  const parts = [];
  if (a.type) parts.push(t(PROPERTIES[a.type]));
  if (a.size) parts.push(t(SIZES[a.size]) + ' · ' + SIZES[a.size][type] + ' m²');
  if (a.areas) parts.push(a.areas + ' ' + t(T.areasWord));
  $('#quizSum').textContent = parts.join('  •  ');
}

/* Draws the plan and hands over to step 2. */
function quizBuild() {
  const a = state.answers;
  state.built = buildProperty(a.type, a.size, a.areas);
  state.property = a.type;      // keeps the ready-made grid's highlight honest
  state.cams = [];
  state.selected = null;
  renderProperties();
  quizRender();
  redraw();
  $('#planner').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#quiz').addEventListener('click', (e) => {
  const type = e.target.closest('[data-qtype]');
  if (type) {
    state.answers.type = type.dataset.qtype;
    /* The size options are labelled in m² OF THIS TYPE, so a type change makes
       any previous size answer describe the wrong number. Asking again is one
       tap and beats showing a villa's 340m² under "Apartment". */
    state.answers.size = null;
    state.answers.areas = null;
    quizRender();
    return;
  }
  const size = e.target.closest('[data-qsize]');
  if (size) {
    state.answers.size = size.dataset.qsize;
    quizRender();
    return;
  }
  const areas = e.target.closest('[data-qareas]');
  if (areas) {
    state.answers.areas = Number(areas.dataset.qareas);
    quizRender();
    quizBuild();
  }
});

$('#quizBack').addEventListener('click', () => {
  const a = state.answers;
  if (a.areas !== null) a.areas = null;
  else if (a.size !== null) a.size = null;
  else a.type = null;
  quizRender();
});

function renderProperties() {
  $('#propGrid').innerHTML = Object.keys(PROPERTIES).map((k) => {
    const p = PROPERTIES[k];
    const on = state.property === k;
    return `<button class="prop${on ? ' is-on' : ''}" type="button" data-prop="${k}">
      <span class="prop__icon" aria-hidden="true">${p.icon}</span>
      <span class="prop__name">${esc(t(p))}</span>
      <span class="prop__note">${esc(LANG === 'en' ? p.en_note : p.ar_note)}</span>
    </button>`;
  }).join('');
}

function availableCameras() {
  return cameras().filter((p) => {
    const s = specFor(p);
    return state.mode === 'outdoor' ? s.outdoor : true;
  });
}

function renderCamList() {
  const box = $('#camList');
  if (!state.cams.length) {
    box.innerHTML = `<p class="card__note">${esc(t(T.noCams))}</p>`;
    return;
  }
  box.innerHTML = state.cams.map((c, i) => {
    const product = byId(c.productId);
    const spec = specFor(product);
    const opts = availableCameras().map((p) =>
      `<option value="${esc(p.id)}"${p.id === c.productId ? ' selected' : ''}>${esc(p.name)} — ${money(p.price)} ${esc(currency())}</option>`).join('');
    return `<div class="camrow${state.selected === c.id ? ' is-on' : ''}" data-cam="${c.id}">
      <div class="camrow__head">
        <span class="camrow__n">${i + 1}</span>
        <select class="camrow__pick" data-pick="${c.id}" aria-label="${esc(t(T.camera))} ${i + 1}">${opts}</select>
        <button class="camrow__x" type="button" data-del="${c.id}" aria-label="${esc(t(T.remove))}">&times;</button>
      </div>
      <div class="camrow__spec">
        <span>${esc(t(LENS[spec.lens]))}</span>
        <span>${spec.fov}°</span>
        <span>${spec.range} m</span>
        <span class="camrow__tag">${esc(spec.wired ? t(T.wired) : t(T.wifi))}</span>
      </div>
      <label class="camrow__aim">
        <span>${esc(t(T.aim))}</span>
        <input type="range" min="0" max="359" value="${c.aim}" data-aim="${c.id}">
      </label>
    </div>`;
  }).join('');
}

function grade(pct) {
  if (pct >= 80) return t(T.gradeA);
  if (pct >= 60) return t(T.gradeB);
  if (pct >= 35) return t(T.gradeC);
  return t(T.gradeD);
}

function renderSummary(cov) {
  $('#covPct').textContent = cov.pct + '%';
  $('#covBar').style.width = Math.min(100, cov.pct) + '%';
  $('#covBar').className = 'meter__fill' + (cov.pct >= 80 ? ' is-a' : cov.pct >= 60 ? ' is-b' : cov.pct >= 35 ? ' is-c' : '');
  $('#covGrade').textContent = grade(cov.pct);
  $('#covArea').textContent = `${cov.area} / ${cov.planArea} m²`;

  $('#zonesOk').innerHTML = cov.zonesCovered.length
    ? cov.zonesCovered.map((z) => `<li class="zone is-ok">${esc(t(z))}</li>`).join('')
    : `<li class="zone is-none">—</li>`;
  $('#zonesBad').innerHTML = cov.zonesBlind.length
    ? cov.zonesBlind.map((z) => `<li class="zone is-bad">${esc(t(z))}</li>`).join('')
    : `<li class="zone is-none">—</li>`;
}

/* =========================================================================
   THE BILL OF MATERIALS

   The part that makes this one order rather than a list of cameras. Rules
   live in SYSTEM in game-data.js; this only applies them.
   ========================================================================= */
function buildSystem() {
  const lines = [];
  const add = (id, qty, why) => {
    const p = byId(id);
    if (!p || qty <= 0) return;
    const found = lines.find((l) => l.id === id);
    if (found) found.qty += qty;
    else lines.push({ id, qty, name: p.name, price: p.price, why });
  };

  /* 1. The cameras themselves. */
  const counts = {};
  state.cams.forEach((c) => { counts[c.productId] = (counts[c.productId] || 0) + 1; });
  Object.keys(counts).forEach((id) => add(id, counts[id], 'camera'));

  /* 2. Everything the WIRED cameras drag along with them. */
  const wired = state.cams.filter((c) => specFor(byId(c.productId)).wired);
  const n = wired.length;

  if (n) {
    const maxMp = Math.max(...wired.map((c) => specFor(byId(c.productId)).mp));

    const rec = SYSTEM.recorders.find((r) => r.ch >= n && r.maxMp >= maxMp)
             || SYSTEM.recorders.filter((r) => r.ch >= n).pop()
             || SYSTEM.recorders[SYSTEM.recorders.length - 1];
    if (rec) add(rec.id, 1, 'recorder');

    const drive = SYSTEM.drives.find((d) => d.days / n >= SYSTEM.minDays)
               || SYSTEM.drives[SYSTEM.drives.length - 1];
    if (drive) add(drive.id, 1, 'storage');

    const amps = n * SYSTEM.ampsPerCamera;
    const psu = SYSTEM.supplies.find((s) => s.amps >= amps) || SYSTEM.supplies[SYSTEM.supplies.length - 1];
    if (psu) add(psu.id, 1, 'power');

    /* Cable, greedily from the largest roll down — cheaper per metre than
       buying the shortfall in 50m pieces. */
    let need = n * SYSTEM.cablePerCamera;
    SYSTEM.cables.forEach((c) => {
      const whole = Math.floor(need / c.m);
      if (whole > 0) { add(c.id, whole, 'cable'); need -= whole * c.m; }
    });
    if (need > 0) {
      const smallest = SYSTEM.cables[SYSTEM.cables.length - 1];
      add(smallest.id, 1, 'cable');
    }

    SYSTEM.perCamera.forEach((x) => add(x.id, x.qty * n, 'parts'));
  }

  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  return { lines, total, wiredCount: n };
}

function renderSystem() {
  const sys = buildSystem();
  const box = $('#sysRows');
  if (!sys.lines.length) {
    box.innerHTML = `<tr><td colspan="3">${esc(t(T.noCams))}</td></tr>`;
    $('#sysTotal').textContent = '—';
    return sys;
  }
  box.innerHTML = sys.lines.map((l) => `
    <tr>
      <td>${esc(l.name)}<div class="att__note" dir="ltr">${esc(l.id)}</div></td>
      <td class="num">${l.qty}</td>
      <td class="num">${money(l.price * l.qty)} ${esc(currency())}</td>
    </tr>`).join('');
  $('#sysTotal').textContent = `${money(sys.total)} ${currency()}`;
  return sys;
}

/* =========================================================================
   REDRAW — one function, called after every change
   ========================================================================= */
/* `keepList` exists for the direction slider.

   renderCamList() replaces the whole list's innerHTML, which destroys and
   recreates the very <input range> being dragged — the element loses focus
   mid-adjustment, so a keyboard user gets exactly one arrow-key press before
   focus is gone, and a mouse drag stops tracking. Nothing in the list depends
   on the aim anyway: the slider already holds the new value. So aim changes
   redraw the plan and the numbers and leave the list alone. */
/* keepList  — leave the camera list alone. Rebuilding it replaces the very
               <input range> being dragged, which loses focus and stops the
               drag tracking.
   skipScore — leave the coverage figures alone too, and only move the
               drawing.

   skipScore exists because computeCoverage() walks the whole plan on a 0.4m
   grid and asks every camera about every point. On the small hand-drawn plans
   that is under a thousand samples and cheap enough to run on every frame of
   a drag. A generated plan can be 44m x 30m — around eight thousand samples,
   against every camera, every frame — and running it while someone is turning
   a camera makes the thing they are dragging stutter. The score cannot change
   in a way anyone can read mid-gesture anyway, so it is computed once when
   the gesture ends. */
function redraw(keepList, skipScore) {
  if (!state.property) return;
  renderPlan();
  if (!keepList) renderCamList();
  if (!skipScore) {
    const cov = computeCoverage();
    renderSummary(cov);
    renderSystem();
  }
  $('#planner').hidden = false;
  $('#orderBtn').disabled = !state.cams.length;
}

/* =========================================================================
   INTERACTION
   ========================================================================= */
function defaultProduct() {
  const list = availableCameras();
  if (!list.length) return null;
  /* Something mid-priced rather than the cheapest, so the first impression is
     a sensible camera the customer can price down from. */
  const sorted = list.slice().sort((a, b) => a.price - b.price);
  return sorted[Math.floor(sorted.length / 2)].id;
}

/* Which way should a camera dropped HERE face?

   Pointing every new camera the same way is how the planner greets you with a
   camera staring at a wall a metre away and a coverage score of zero — which
   is exactly what a fixed default did on the villa's indoor plan, where the
   centre of the room sits just above a partition. So try twelve directions
   and keep the best one.

   Twelve coarse samples on a 1.2m grid, not the full 0.4m coverage pass: this
   runs once per placement and only has to beat "always 90°", which it does
   comfortably. The user can still turn it afterwards. */
function bestAim(x, y, spec) {
  const p = plan();
  const cam = { x, y, spec };
  let best = 90, bestHits = -1;
  for (let a = 0; a < 360; a += 30) {
    cam.aim = a;
    let hits = 0;
    for (let gx = 0.6; gx < p.w; gx += 1.2) {
      for (let gy = 0.6; gy < p.h; gy += 1.2) {
        if (sees(cam, gx, gy, p.walls)) hits++;
      }
    }
    if (hits > bestHits) { bestHits = hits; best = a; }
  }
  return best;
}

function addCamera(x, y, aim) {
  const pid = defaultProduct();
  if (!pid) { toast(t(T.noneOutdoor), 'bad'); return; }
  const p = plan();
  const cx = Math.max(0.4, Math.min(p.w - 0.4, x));
  const cy = Math.max(0.4, Math.min(p.h - 0.4, y));
  const cam = {
    id: state.nextId++,
    x: cx,
    y: cy,
    aim: aim === undefined ? bestAim(cx, cy, specFor(byId(pid))) : aim,
    productId: pid
  };
  state.cams.push(cam);
  state.selected = cam.id;
  redraw();
}

/* Where a pointer is, in plan metres. The SVG viewBox is metres, so the
   conversion is the ratio of the rendered box to the viewBox — no magic
   numbers.

   preserveAspectRatio is the default (meet), so the drawing is letterboxed
   inside the box; back that out before converting.

   Returns a point whether or not it is inside the plan. Placing a camera cares
   about the bounds and checks them; rotating one does not, because dragging
   the aim past the edge of the building is a perfectly ordinary thing to do. */
function planPoint(e) {
  const r = $('#planSvg').getBoundingClientRect();
  const p = plan();
  const vw = p.w + 1, vh = p.h + 1;
  const scale = Math.min(r.width / vw, r.height / vh);
  const offX = (r.width - vw * scale) / 2;
  const offY = (r.height - vh * scale) / 2;
  return {
    x: (e.clientX - r.left - offX) / scale - 0.5,
    y: (e.clientY - r.top - offY) / scale - 0.5
  };
}

/* =========================================================================
   AIMING BY DRAGGING ON THE PLAN

   The direction slider in the list below still works and is unchanged. This
   is the same value, reachable the way people actually think about it: take
   hold of the camera on the drawing and turn it to face where you want.

   WHY THE POINTER IS CAPTURED ON THE SVG AND NOT ON THE CAMERA
   -----------------------------------------------------------
   renderPlan() rebuilds the whole drawing with innerHTML, and it runs on every
   frame of the drag because the cone has to follow the pointer. So the <g>
   the gesture started on is destroyed and replaced continuously — capturing on
   it would lose the pointer on the first move. The <svg> element itself is
   never replaced, so it is what holds the capture.

   DISTINGUISHING A TURN FROM A TAP
   --------------------------------
   A tap on a camera selects it; a drag turns it. They start identically, so
   the gesture only becomes a rotation once the pointer has travelled far
   enough to mean it, and a rotation swallows the click that follows it —
   otherwise letting go anywhere off the marker would fall through to
   click-to-place and drop an unwanted camera on the plan.
   ========================================================================= */
const TURN_SLOP = 4;        // CSS pixels of travel before a tap becomes a turn
const TURN_DEADZONE = 0.55; // metres from the pivot inside which the angle is noise

let turning = null;
let swallowClick = false;

$('#planSvg').addEventListener('pointerdown', (e) => {
  if (!state.property || e.button > 0) return;
  const marker = e.target.closest('.pl-cam');
  if (!marker) return;
  const cam = state.cams.find((c) => c.id === Number(marker.dataset.cam));
  if (!cam) return;

  turning = { id: cam.id, fromX: e.clientX, fromY: e.clientY, turned: false };
  if (state.selected !== cam.id) {
    state.selected = cam.id;
    redraw();
  }
  $('#planSvg').setPointerCapture(e.pointerId);
  /* Stops the drag turning into a text selection on desktop. Touch scrolling is
     handled by touch-action on .pl-cam in app.css — preventDefault alone cannot
     stop it, because the listener has to stay passive-compatible. */
  e.preventDefault();
});

$('#planSvg').addEventListener('pointermove', (e) => {
  if (!turning) return;
  const cam = state.cams.find((c) => c.id === turning.id);
  if (!cam) { turning = null; return; }

  if (!turning.turned) {
    if (Math.hypot(e.clientX - turning.fromX, e.clientY - turning.fromY) < TURN_SLOP) return;
    turning.turned = true;
  }

  const pt = planPoint(e);
  const dx = pt.x - cam.x, dy = pt.y - cam.y;
  /* Right on top of the camera every pixel is a different angle, so the cone
     would spin wildly for a movement the hand did not intend. */
  if (Math.hypot(dx, dy) < TURN_DEADZONE) return;

  cam.aim = deg(Math.atan2(dy, dx));
  /* Drawing only. The list holds the slider this is meant to agree with, and
     the score is the expensive half of a redraw; both are brought up to date
     once, on release. */
  redraw(true, true);
});

function endTurn(e) {
  if (!turning) return;
  const turned = turning.turned;
  turning = null;
  if (e && e.pointerId !== undefined && $('#planSvg').hasPointerCapture(e.pointerId)) {
    $('#planSvg').releasePointerCapture(e.pointerId);
  }
  if (turned) {
    swallowClick = true;
    redraw();               // now refresh the list, the slider and the score
  }
}

$('#planSvg').addEventListener('pointerup', endTurn);
$('#planSvg').addEventListener('pointercancel', endTurn);

/* =========================================================================
   EDITING THE PLAN — dragging the walls

   Two different gestures wearing the same clothes.

   An OUTER wall resizes the building. Dragging the right-hand wall to the
   right makes the place wider; everything inside scales with it, because
   "my flat is 12 by 9" is a statement about the whole plan and not about one
   wall. The view zooms out as it grows, onto the ground drawn around the
   building — see the margin in renderPlan().

   An INNER wall just moves, and the rooms either side follow it.

   Neither one does its own arithmetic. resizeScene() and moveWall() in
   game-data.js own that, and test/planner-edit.test.js holds them to the
   same invariants a generated plan is held to — rooms tiling the floor,
   nothing outside the building. Both of those were broken by the first
   version of this and neither would have thrown; the score would just have
   been about a floor plan that does not exist.
   ========================================================================= */

/* The customer's version of the current scene, created on first edit. */
function editable() {
  if (!state.edited[state.mode]) {
    state.edited[state.mode] = JSON.parse(JSON.stringify(stockPlan()));
  }
  return state.edited[state.mode];
}

function commitScene(next) {
  state.edited[state.mode] = next;
  /* A camera left outside the building after a shrink is pulled back inside
     rather than deleted. Deleting somebody's work because they dragged a
     wall too far is the wrong trade; a camera on the edge is obvious and
     draggable. */
  const p = next;
  state.cams.forEach((c) => {
    c.x = Math.min(Math.max(c.x, 0.2), p.w - 0.2);
    c.y = Math.min(Math.max(c.y, 0.2), p.h - 0.2);
  });
  syncEditFields();
}

function syncEditFields() {
  const p = plan();
  const w = $('#planW'), h = $('#planH');
  if (w && document.activeElement !== w) w.value = p.w;
  if (h && document.activeElement !== h) h.value = p.h;
}

$('#planSvg').addEventListener('pointerdown', (e) => {
  if (!state.editing || !state.property || e.button > 0) return;
  const grip = e.target.closest('[data-wall]');
  if (!grip) return;

  const p = editable();
  const index = Number(grip.dataset.wall);
  const seg = p.walls[index];
  if (!seg) return;

  state.dragWall = {
    index,
    outer: grip.dataset.outer === '1',
    vertical: Math.abs(seg[0] - seg[2]) < 0.05,
    startW: p.w,
    startH: p.h
  };
  $('#planSvg').setPointerCapture(e.pointerId);
  e.preventDefault();
  /* Stops the gesture also being read as a tap on the plan, which would drop
     a camera the moment the wall was released. */
  swallowClick = true;
});

$('#planSvg').addEventListener('pointermove', (e) => {
  if (!state.dragWall) return;
  const d = state.dragWall;
  const at = planPoint(e);
  const p = editable();

  if (d.outer) {
    /* Which edge is being pulled decides which dimension changes. The near
       edge (x=0 or y=0) is not draggable as a resize — moving it would mean
       translating the whole building, which is not a thing a floor plan
       needs to do. */
    const next = d.vertical
      ? resizeScene(p, at.x, p.h)
      : resizeScene(p, p.w, at.y);
    commitScene(next);
  } else {
    commitScene(moveWall(p, d.index, d.vertical ? at.x : at.y));
  }
  /* Keep the list, skip the score: the sampler walks the whole floor and
     doing that on every frame of a drag is what makes the thing being
     dragged stutter. The score is recomputed on release. */
  redraw(true, true);
});

function endWallDrag() {
  if (!state.dragWall) return;
  state.dragWall = null;
  redraw();                 // now the score, with the plan settled
  setTimeout(() => { swallowClick = false; }, 0);
}
$('#planSvg').addEventListener('pointerup', endWallDrag);
$('#planSvg').addEventListener('pointercancel', endWallDrag);

/* ---- the mode toggle ---- */
$('#editWalls').addEventListener('click', () => {
  state.editing = !state.editing;
  const b = $('#editWalls');
  b.setAttribute('aria-pressed', String(state.editing));
  b.textContent = t(state.editing ? T.doneWalls : T.editWalls);
  b.classList.toggle('is-on', state.editing);
  $('#editBar').hidden = !state.editing;
  $('#planSvg').classList.toggle('is-editing', state.editing);
  syncEditFields();
  redraw(true, true);
});

/* ---- typing the size, for anybody who knows their measurements ---- */
function applyTypedSize() {
  if (!state.property) return;
  const w = parseFloat($('#planW').value);
  const h = parseFloat($('#planH').value);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  commitScene(resizeScene(editable(), w, h));
  redraw();
}
$('#planW').addEventListener('change', applyTypedSize);
$('#planH').addEventListener('change', applyTypedSize);

$('#planReset').addEventListener('click', () => {
  /* Delete the edit rather than trying to invert it — the plan they started
     from was never touched, which is the whole reason reset can be exact. */
  state.edited[state.mode] = null;
  syncEditFields();
  redraw();
});

/* =========================================================================
   THE CUSTOMER'S OWN DRAWING

   Somebody with a floor plan on paper can photograph it, drop it under the
   plan and drag the walls to match. That is the difference between "a
   rectangle roughly like my flat" and their actual flat.

   IT NEVER LEAVES THE BROWSER. No upload, no endpoint, nothing in KV or D1.
   It is read with FileReader, held as a data URL, and put in sessionStorage
   — which means it survives a reload and moving between pages, and is gone
   the moment the tab closes. That is what was asked for and it is also the
   only version worth building: a photograph of somebody's home is not
   something to hold on a server for a feature that only needs it for the
   next five minutes.

   sessionStorage is per-tab, so two tabs do not share a drawing either.
   ========================================================================= */
const REF_KEY = 'vg-plan-ref';
const REF_MAX = 8 * 1024 * 1024;      // 8 MB of original file

function paintRefControls() {
  const has = !!state.ref;
  $('#refFade').disabled = !has;
  $('#refClear').hidden = !has;
  if (has) $('#refFade').value = state.ref.opacity;
}

function loadRef() {
  try {
    const raw = sessionStorage.getItem(REF_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved.src === 'string' && saved.src.startsWith('data:image/')) {
      state.ref = { src: saved.src, opacity: Number(saved.opacity) || 45 };
    }
  } catch (e) {
    /* Quota, private mode, or something else wrote nonsense to the key. A
       missing reference drawing is not worth a broken planner. */
  }
  paintRefControls();
}

function saveRef() {
  try {
    if (state.ref) sessionStorage.setItem(REF_KEY, JSON.stringify(state.ref));
    else sessionStorage.removeItem(REF_KEY);
  } catch (e) {
    /* Over quota — a big photograph in a small budget. It still works for
       this page view; it just will not survive a reload. */
  }
}

$('#planRef').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                       // so the same file can be re-picked
  if (!file) return;
  if (file.size > REF_MAX) return void toast(t(T.tooBigImg), 'bad');

  const reader = new FileReader();
  reader.onload = () => {
    state.ref = { src: String(reader.result), opacity: Number($('#refFade').value) || 45 };
    saveRef();
    paintRefControls();
    redraw(true, true);
  };
  reader.onerror = () => toast(t(T.badImg), 'bad');
  reader.readAsDataURL(file);
});

$('#refFade').addEventListener('input', () => {
  if (!state.ref) return;
  state.ref.opacity = Number($('#refFade').value) || 45;
  redraw(true, true);
});
$('#refFade').addEventListener('change', saveRef);

$('#refClear').addEventListener('click', () => {
  state.ref = null;
  saveRef();
  paintRefControls();
  redraw(true, true);
});

loadRef();

/* Click-to-place, and click-to-select. */
$('#planSvg').addEventListener('click', (e) => {
  if (swallowClick) { swallowClick = false; return; }
  if (!state.property) return;
  const existing = e.target.closest('.pl-cam');
  if (existing) {
    state.selected = Number(existing.dataset.cam);
    redraw();
    return;
  }
  const p = plan();
  const { x, y } = planPoint(e);
  if (x < 0 || y < 0 || x > p.w || y > p.h) return;
  addCamera(x, y);
});

$('#propGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-prop]');
  if (!b) return;
  state.property = b.dataset.prop;
  /* Picking a ready-made plan drops any generated one, or property() would
     keep returning the built plan and the choice would appear to do nothing. */
  state.built = null;
  state.cams = [];
  state.selected = null;
  renderProperties();
  redraw();
  $('#planner').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$$('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    $$('[data-mode]').forEach((b) => b.classList.toggle('is-on', b === btn));
    /* A camera that is not weatherproof cannot stay outdoors. Swap it for one
       that is, rather than silently leaving it there. */
    if (state.mode === 'outdoor') {
      const ok = availableCameras();
      const fallback = ok.length ? ok[0].id : null;
      state.cams.forEach((c) => {
        if (!specFor(byId(c.productId)).outdoor && fallback) c.productId = fallback;
      });
    }
    /* Plans differ between modes, so pull any camera back inside the new one. */
    const p = plan();
    state.cams.forEach((c) => {
      c.x = Math.max(0.4, Math.min(p.w - 0.4, c.x));
      c.y = Math.max(0.4, Math.min(p.h - 0.4, c.y));
    });
    redraw();
  });
});

$('#camList').addEventListener('change', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const cam = state.cams.find((c) => c.id === Number(pick.dataset.pick));
    if (cam) { cam.productId = pick.value; state.selected = cam.id; redraw(); }
    return;
  }
  const aim = e.target.closest('[data-aim]');
  if (aim) {
    const cam = state.cams.find((c) => c.id === Number(aim.dataset.aim));
    if (cam) { cam.aim = Number(aim.value); redraw(true); }
  }
});

/* `input` as well as `change`, so dragging the direction slider animates the
   cone instead of jumping when you let go. */
$('#camList').addEventListener('input', (e) => {
  const aim = e.target.closest('[data-aim]');
  if (!aim) return;
  const cam = state.cams.find((c) => c.id === Number(aim.dataset.aim));
  if (!cam) return;
  cam.aim = Number(aim.value);
  state.selected = cam.id;
  /* Same reasoning as the drag on the plan: keep the list so this slider is
     not replaced mid-drag, and leave the score until the `change` below fires
     on release. */
  redraw(true, true);
});

$('#camList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    state.cams = state.cams.filter((c) => c.id !== Number(del.dataset.del));
    redraw();
    return;
  }
  const row = e.target.closest('[data-cam]');
  if (row) { state.selected = Number(row.dataset.cam); redraw(); }
});

$('#addCam').addEventListener('click', () => {
  /* The next unused mounting point, not the middle of the plan.

     Dropping a camera at the centre put it in mid-air in the middle of a
     room — and on the villa's outdoor plan, the centre is INSIDE the house,
     so the first camera a customer added saw four walls and scored 3%. Real
     cameras go on walls, corners and gateposts, which is exactly what the
     `presets` in game-data.js are. Fall back to the centre only once every
     mounting point is used. */
  const scene = plan();
  const used = (pt) => state.cams.some((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < 1);
  const free = scene.presets.find((pt) => !used(pt));
  if (free) addCamera(free.x, free.y, free.aim);
  else addCamera(scene.w / 2, scene.h / 2);
});

$('#suggest').addEventListener('click', () => {
  const scene = plan();
  state.cams = [];
  state.nextId = 1;
  scene.presets.forEach((pt) => addCamera(pt.x, pt.y, pt.aim));
  redraw();
});

$('#clearCams').addEventListener('click', () => {
  state.cams = [];
  state.selected = null;
  redraw();
});

/* =========================================================================
   ORDER — one cart, one order
   ========================================================================= */
$('#orderBtn').addEventListener('click', () => {
  if (!state.cams.length) { toast(t(T.placeFirst), 'bad'); return; }
  const sys = buildSystem();
  try {
    /* The shop's own cart format: {id, qty} and nothing else. Prices are
       recomputed on the server at checkout, so nothing here can set one. */
    localStorage.setItem('vg-cart', JSON.stringify(sys.lines.map((l) => ({ id: l.id, qty: l.qty }))));
  } catch (e) {
    toast(t({ ar: 'المتصفح مش سامح بالتخزين.', en: 'Your browser blocked storage.' }), 'bad');
    return;
  }
  if (window.vgTrack) {
    window.vgTrack.fire('AddToCart', {
      content_type: 'product',
      content_ids: sys.lines.map((l) => l.id),
      contents: sys.lines.map((l) => ({ id: l.id, quantity: l.qty, item_price: l.price })),
      value: sys.total,
      currency: 'EGP',
      content_name: 'coverage-planner-system'
    });
  }
  toast(t(T.added), 'good');
  setTimeout(() => { location.href = 'shop.html#checkout'; }, 700);
});

$('#printBtn').addEventListener('click', () => window.print());

/* =========================================================================
   BOOT
   ========================================================================= */
onLang(() => {
  renderProperties();
  /* The questions carry their own labels and the size options are written in
     m², so they have to be redrawn like anything else JavaScript owns. The
     answers live in state, not in the DOM, so none of them are lost here. */
  quizRender();
  if (state.property) redraw();
  $$('[data-i18n]').forEach((el) => {
    const k = el.dataset.i18n;
    if (T[k]) el.textContent = t(T[k]);
  });
});

$$('[data-i18n]').forEach((el) => {
  const k = el.dataset.i18n;
  if (T[k]) el.textContent = t(T[k]);
});
renderProperties();
quizRender();

/* Live prices, same as the shop: start from the built-in catalogue so the
   page works immediately, then replace it with the products table. */
(async function () {
  try {
    const res = await fetch('/api/catalog', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.products) || !data.products.length) return;
    CATALOG = data.products;
    if (state.property) redraw();
  } catch (e) { /* built-in prices are last-known-good */ }
})();
