/* =========================================================================
   Vision Guard — game-data.js
   EVERYTHING THE COVERAGE PLANNER GETS WRONG IS PROBABLY IN THIS FILE.

   This is the tuning file. It holds the optics, the floor plans, the zone
   names and the system-building rules, deliberately separated from
   game.js — which is only maths and rendering and should not need editing to
   correct a number.

   The four things you will want to change, in the order you will want them:

     1. LENS          field of view and range per lens type
     2. CAMERA_SPECS  which lens a given catalogue product has
     3. PROPERTIES    floor plans, walls and the named zones on them
     4. SYSTEM        the rules that turn N cameras into a full order

   Distances are METRES and angles are DEGREES throughout. Floor plans are
   drawn in metres too — the SVG viewBox is the room, so a wall from (0,0) to
   (12,0) is twelve metres long and a camera with a 15m range reaches exactly
   as far across the plan as it would across the building.
   ========================================================================= */

/* -------------------------------------------------------------------------
   1. LENS TYPES

   `fov` is the horizontal angle the camera sees. `range` is the useful
   identification distance — not the absolute maximum the sensor can register
   something, which is always a bigger and less honest number. If you want the
   planner to promise more, raise these; they are what the coverage percentage
   is computed from.
   ------------------------------------------------------------------------- */
export const LENS = {
  fixed:     { id: 'fixed',     fov: 72,  range: 15, ar: 'عدسة ثابتة',      en: 'Fixed lens' },
  wide:      { id: 'wide',      fov: 110, range: 9,  ar: 'زاوية واسعة',      en: 'Wide angle' },
  varifocal: { id: 'varifocal', fov: 90,  range: 22, ar: 'عدسة متغيرة',      en: 'Vari-focal' },
  ptz:       { id: 'ptz',       fov: 300, range: 18, ar: 'دوّارة PTZ',       en: 'PTZ (rotating)' }
};

/* -------------------------------------------------------------------------
   2. CAMERA SPECS, per catalogue product

   Only the exceptions are listed. Everything else is derived from the product
   itself by specFor() below — resolution drives range, the category and the
   product name drive the lens and whether it is weatherproof — so adding a
   new camera to the shop makes it appear here automatically with a sensible
   guess. Override it only when the guess is wrong.

   `outdoor: true` means weather-rated, and it is the ONLY thing that decides
   whether a camera is offered in Outdoor mode. Get it wrong and the planner
   will happily put an indoor camera in the rain.
   ------------------------------------------------------------------------- */
export const CAMERA_SPECS = {
  /* Genuinely rotating heads — these sweep rather than stare. */
  'dahua-ip-pt-3mp':  { lens: 'ptz', outdoor: true },
  'imou-3mp-cruiser': { lens: 'ptz', outdoor: true },
  'tapo-c200':        { lens: 'ptz', outdoor: false },
  'tenda-cp3':        { lens: 'ptz', outdoor: false },
  'skyworth-h30p':    { lens: 'ptz', outdoor: false },

  /* Long, narrow views — the 8MP bullet is the one that actually reaches. */
  'dahua-8mp':        { lens: 'varifocal', outdoor: true, range: 30 },
  'unv-5mp-nv':       { lens: 'varifocal', outdoor: true },
  'dahua-5mp-nv':     { lens: 'varifocal', outdoor: true },

  /* Indoor Wi-Fi that is genuinely indoor-only. */
  'tapo-c70':         { lens: 'wide', outdoor: false },
  'skyworth-h30':     { lens: 'wide', outdoor: false },
  'imou-3mp':         { lens: 'wide', outdoor: false },
  'imou-5mp':         { lens: 'wide', outdoor: false },
  'imou-3mp-color':   { lens: 'wide', outdoor: false },
  'imou-5mp-color':   { lens: 'wide', outdoor: false }
};

/* Resolution -> useful range multiplier. More pixels on the same scene means
   a face is still identifiable further away, which is the whole reason to pay
   for 5MP over 2MP. */
const MP_RANGE = { 2: 1.0, 3: 1.15, 4: 1.25, 5: 1.4, 8: 1.75 };

export function megapixelsOf(product) {
  const m = /(\d+)\s*MP/i.exec(product.name || '');
  return m ? Number(m[1]) : 2;
}

/* The one function that turns a catalogue row into optics. */
export function specFor(product) {
  const override = CAMERA_SPECS[product.id] || {};
  const name = (product.name || '') + ' ' + (product.en || '');

  let lens = override.lens;
  if (!lens) {
    if (/pan[- ]?tilt|cruiser|ptz/i.test(name)) lens = 'ptz';
    else if (product.cat === 'wireless') lens = /outdoor/i.test(name) ? 'fixed' : 'wide';
    else lens = 'fixed';
  }

  let outdoor = override.outdoor;
  if (outdoor === undefined) {
    /* Analog and IP bullets/domes in this catalogue are weather-rated; Wi-Fi
       units are indoor unless the model name says otherwise. */
    outdoor = product.cat === 'wireless' ? /outdoor/i.test(name) : true;
  }

  const base = LENS[lens];
  const mp = megapixelsOf(product);
  const range = override.range !== undefined
    ? override.range
    : Math.round(base.range * (MP_RANGE[mp] || 1) * 10) / 10;

  return {
    lens,
    fov: override.fov !== undefined ? override.fov : base.fov,
    range,
    outdoor,
    mp,
    /* Wi-Fi cameras record to a card and need no recorder, cable or PSU.
       Everything else is wired and drives the rest of the bill of materials. */
    wired: product.cat !== 'wireless'
  };
}

/* -------------------------------------------------------------------------
   3. PROPERTIES

   Every property has TWO SCENES, indoor and outdoor, and each scene is a
   complete, self-contained plan: its own extents, its own walls, its own
   rooms and its own named zones.

   That separation is not tidiness, it is correctness. The first version
   shared one set of walls between both scenes while letting the extents
   differ, and the result was a villa whose 18×12 indoor plan was being
   blocked by the walls of its 26×20 grounds — a camera dropped in the garden
   found itself sealed inside a phantom room, and coverage sat at 4% no matter
   which way it was pointed. A wall list only means anything against the plan
   it was drawn for.

   Each scene:
     w, h     extents in metres — the SVG viewBox, so everything else is literal
     walls    [x1,y1,x2,y2] segments that BLOCK a camera's view
     rooms    cosmetic rectangles with a label, drawn underneath
     zones    the named places the summary reports on; a zone counts as covered
              when its anchor point falls inside some camera's cone, so put the
              anchor where a person would actually stand
     presets  where "Suggest placement" drops cameras, with an aim in degrees
              (0 = east, 90 = south, clockwise — the SVG convention)

   To add a floor plan: copy a scene, keep everything in metres, and make sure
   the walls describe the same rectangle as w and h.
   ------------------------------------------------------------------------- */
export const PROPERTIES = {
  apartment: {
    id: 'apartment',
    ar: 'شقة', en: 'Apartment',
    icon: '🏢',
    ar_note: 'باب، صالة، ممر ودرج',
    en_note: 'Door, living room, hallway and stairs',

    /* Inside the flat. */
    indoor: {
      w: 14, h: 10,
      rooms: [
        { x: 0, y: 0, w: 8, h: 6, ar: 'الصالة', en: 'Living room' },
        { x: 8, y: 0, w: 6, h: 6, ar: 'غرفة نوم', en: 'Bedroom' },
        { x: 0, y: 6, w: 5, h: 4, ar: 'المطبخ', en: 'Kitchen' },
        { x: 5, y: 6, w: 4, h: 4, ar: 'الممر', en: 'Hallway' },
        { x: 9, y: 6, w: 5, h: 4, ar: 'المدخل', en: 'Entrance' }
      ],
      walls: [
        [0,0,14,0],[14,0,14,10],[14,10,0,10],[0,10,0,0],
        [8,0,8,4.5],[0,6,3.5,6],[5,6,5,8.5],[9,6,9,8.5],[5,6,9,6]
      ],
      zones: [
        { id: 'door',    x: 12.8, y: 9.2, ar: 'باب الشقة',  en: 'Apartment door' },
        { id: 'hall',    x: 7,    y: 8,   ar: 'الممر',       en: 'Hallway' },
        { id: 'living',  x: 4,    y: 3,   ar: 'الصالة',      en: 'Living room' },
        { id: 'kitchen', x: 2.5,  y: 8,   ar: 'المطبخ',      en: 'Kitchen' },
        { id: 'bedroom', x: 11,   y: 3,   ar: 'غرفة النوم',  en: 'Bedroom' },
        { id: 'entry',   x: 11.5, y: 7.5, ar: 'المدخل',      en: 'Entrance' }
      ],
      presets: [
        { x: 9.4, y: 9.5, aim: 340 },
        { x: 0.5, y: 0.5, aim: 45 },
        { x: 5.4, y: 6.4, aim: 90 }
      ]
    },

    /* The landing outside it — the door, the stairs, the lift. */
    outdoor: {
      w: 16, h: 11,
      rooms: [
        { x: 0,  y: 0, w: 16, h: 4, ar: 'مواقف العمارة', en: 'Building parking' },
        { x: 1,  y: 6, w: 6,  h: 5, ar: 'المدخل',        en: 'Lobby' },
        { x: 9,  y: 6, w: 6,  h: 5, ar: 'السلم والأسانسير', en: 'Stairs & lift' }
      ],
      walls: [
        [0,0,16,0],[16,0,16,11],[16,11,0,11],[0,11,0,0],
        [1,6,7,6],[7,6,7,11],[9,6,9,11],[9,6,15,6]
      ],
      zones: [
        { id: 'gate',    x: 8,    y: 0.8,  ar: 'مدخل العمارة',  en: 'Building entrance' },
        { id: 'parking', x: 3,    y: 2,    ar: 'المواقف',       en: 'Parking' },
        { id: 'lobby',   x: 4,    y: 8.5,  ar: 'الاستقبال',     en: 'Lobby' },
        { id: 'stairs',  x: 12,   y: 8.5,  ar: 'السلم',         en: 'Stairs' },
        { id: 'lift',    x: 14.5, y: 8.5,  ar: 'الأسانسير',     en: 'Lift' },
        { id: 'flatdoor',x: 8,    y: 10.4, ar: 'باب الشقة',     en: 'Flat door' }
      ],
      presets: [
        { x: 8,   y: 5.2,  aim: 90 },
        { x: 0.6, y: 0.6,  aim: 45 },
        { x: 15.4,y: 6.4,  aim: 135 }
      ]
    }
  },

  villa: {
    id: 'villa',
    ar: 'فيلا', en: 'Villa',
    icon: '🏡',
    ar_note: 'بوابة، جنينة، مدخل وجراج',
    en_note: 'Gate, garden, entrance and garage',

    /* The ground floor. */
    indoor: {
      w: 18, h: 12,
      rooms: [
        { x: 0,  y: 0, w: 10, h: 7,  ar: 'الريسبشن', en: 'Reception' },
        { x: 10, y: 0, w: 8,  h: 7,  ar: 'السفرة',   en: 'Dining' },
        { x: 0,  y: 7, w: 6,  h: 5,  ar: 'المطبخ',   en: 'Kitchen' },
        { x: 6,  y: 7, w: 5,  h: 5,  ar: 'الصالة',   en: 'Hall' },
        { x: 11, y: 7, w: 7,  h: 5,  ar: 'المدخل',   en: 'Entrance' }
      ],
      walls: [
        [0,0,18,0],[18,0,18,12],[18,12,0,12],[0,12,0,0],
        [10,0,10,4.5],[0,7,4,7],[6,7,6,10],[11,7,11,10],[6,7,11,7]
      ],
      zones: [
        { id: 'frontdoor', x: 16,  y: 11.3, ar: 'باب الفيلا',  en: 'Front door' },
        { id: 'hall',      x: 8.5, y: 9.5,  ar: 'الصالة',      en: 'Hall' },
        { id: 'stairs',    x: 13,  y: 8.5,  ar: 'السلم',       en: 'Stairs' },
        { id: 'reception', x: 5,   y: 3.5,  ar: 'الريسبشن',    en: 'Reception' },
        { id: 'kitchen',   x: 3,   y: 9.5,  ar: 'المطبخ',      en: 'Kitchen' },
        { id: 'dining',    x: 14,  y: 3.5,  ar: 'السفرة',      en: 'Dining' }
      ],
      presets: [
        { x: 11.4, y: 11.4, aim: 200 },
        { x: 0.5,  y: 0.5,  aim: 45 },
        { x: 6.4,  y: 7.4,  aim: 60 }
      ]
    },

    /* The grounds — gate, drive, garden, perimeter. */
    outdoor: {
      w: 26, h: 20,
      rooms: [
        { x: 7, y: 6, w: 12, h: 9, ar: 'المبنى',        en: 'House' },
        { x: 2, y: 1, w: 22, h: 4, ar: 'الجنينة الأمامية', en: 'Front garden' }
      ],
      walls: [
        [0,0,26,0],[26,0,26,20],[26,20,0,20],[0,20,0,0],
        [7,6,19,6],[19,6,19,15],[19,15,7,15],[7,15,7,6]
      ],
      zones: [
        { id: 'gate',     x: 13,  y: 1.2,  ar: 'البوابة',       en: 'Main gate' },
        { id: 'drive',    x: 13,  y: 4,    ar: 'المدخل',        en: 'Driveway' },
        { id: 'frontdoor',x: 13,  y: 5.4,  ar: 'باب الفيلا',    en: 'Front door' },
        { id: 'garage',   x: 3,   y: 8,    ar: 'الجراج',        en: 'Garage' },
        { id: 'garden',   x: 22.5,y: 10,   ar: 'الجنينة',       en: 'Garden' },
        { id: 'backgate', x: 13,  y: 18.8, ar: 'الباب الخلفي',  en: 'Back gate' },
        { id: 'sideA',    x: 3,   y: 17,   ar: 'الجنب الشمال',  en: 'Left side' },
        { id: 'sideB',    x: 23,  y: 17,   ar: 'الجنب اليمين',  en: 'Right side' }
      ],
      presets: [
        { x: 13,   y: 3,    aim: 270 },
        { x: 0.6,  y: 0.6,  aim: 45 },
        { x: 25.4, y: 0.6,  aim: 135 },
        { x: 13,   y: 17.5, aim: 90 }
      ]
    }
  },

  company: {
    id: 'company',
    ar: 'شركة', en: 'Company',
    icon: '🏬',
    ar_note: 'استقبال، مكاتب، ممرات وجراج',
    en_note: 'Reception, offices, corridors and parking',

    indoor: {
      w: 24, h: 16,
      rooms: [
        { x: 0,  y: 0,  w: 9,  h: 7,  ar: 'الاستقبال', en: 'Reception' },
        { x: 9,  y: 0,  w: 15, h: 7,  ar: 'المكاتب',   en: 'Open office' },
        { x: 0,  y: 9,  w: 10, h: 7,  ar: 'اجتماعات',  en: 'Meeting room' },
        { x: 10, y: 9,  w: 14, h: 7,  ar: 'المخزن',    en: 'Store room' }
      ],
      walls: [
        [0,0,24,0],[24,0,24,16],[24,16,0,16],[0,16,0,0],
        [9,0,9,5],[0,7,10,7],[13,7,24,7],[10,9,10,16],[0,9,7,9],[10,9,24,9]
      ],
      zones: [
        { id: 'entrance', x: 4.5,  y: 0.9,  ar: 'المدخل',        en: 'Main entrance' },
        { id: 'reception',x: 4.5,  y: 4,    ar: 'الاستقبال',     en: 'Reception desk' },
        { id: 'office',   x: 16,   y: 3.5,  ar: 'المكاتب',       en: 'Open office' },
        { id: 'corridor', x: 11.5, y: 8,    ar: 'الممر',         en: 'Corridor' },
        { id: 'meeting',  x: 5,    y: 12.5, ar: 'غرفة اجتماعات', en: 'Meeting room' },
        { id: 'store',    x: 17,   y: 12.5, ar: 'المخزن',        en: 'Store room' },
        { id: 'backdoor', x: 23,   y: 15.2, ar: 'الباب الخلفي',  en: 'Back door' }
      ],
      presets: [
        { x: 4.5,  y: 1.2,  aim: 270 },
        { x: 23.4, y: 0.6,  aim: 200 },
        { x: 11.5, y: 8,    aim: 180 },
        { x: 23.4, y: 15.4, aim: 160 }
      ]
    },

    /* The yard — where the cars, the deliveries and the back door are. */
    outdoor: {
      w: 28, h: 18,
      rooms: [
        { x: 8,  y: 9, w: 20, h: 9, ar: 'المبنى',   en: 'Building' },
        { x: 0,  y: 2, w: 26, h: 5, ar: 'الجراج',   en: 'Parking' }
      ],
      walls: [
        [0,0,28,0],[28,0,28,18],[28,18,0,18],[0,18,0,0],
        [8,9,28,9]
      ],
      zones: [
        { id: 'gate',     x: 14,  y: 0.8,  ar: 'بوابة الدخول',  en: 'Vehicle gate' },
        { id: 'parking',  x: 6,   y: 4.5,  ar: 'المواقف',       en: 'Parking' },
        { id: 'entrance', x: 18,  y: 8.2,  ar: 'المدخل الرئيسي',en: 'Main entrance' },
        { id: 'loading',  x: 3,   y: 12,   ar: 'منطقة التحميل', en: 'Loading bay' },
        { id: 'backdoor', x: 26,  y: 8.2,  ar: 'الباب الخلفي',  en: 'Back door' },
        { id: 'fence',    x: 27,  y: 2,    ar: 'السور',         en: 'Perimeter fence' }
      ],
      presets: [
        { x: 14,   y: 1.6,  aim: 90 },
        { x: 0.6,  y: 0.6,  aim: 45 },
        { x: 27.4, y: 0.6,  aim: 135 },
        { x: 18,   y: 9.4,  aim: 270 }
      ]
    }
  },

  compound: {
    id: 'compound',
    ar: 'كمبوند', en: 'Compound',
    icon: '🏘️',
    ar_note: 'سور، بوابات، شوارع داخلية',
    en_note: 'Perimeter, gates and internal roads',

    /* A compound's indoor scene is the block lobby, not the site. */
    indoor: {
      w: 20, h: 12,
      rooms: [
        { x: 0,  y: 0, w: 20, h: 5, ar: 'مدخل المبنى', en: 'Block lobby' },
        { x: 0,  y: 7, w: 9,  h: 5, ar: 'السلم',       en: 'Stairs' },
        { x: 11, y: 7, w: 9,  h: 5, ar: 'الجراج',      en: 'Basement' }
      ],
      walls: [
        [0,0,20,0],[20,0,20,12],[20,12,0,12],[0,12,0,0],
        [0,5,7,5],[13,5,20,5],[9,7,9,12],[11,7,11,12]
      ],
      zones: [
        { id: 'lobby',   x: 10,  y: 2.5,  ar: 'الاستقبال',    en: 'Lobby' },
        { id: 'door',    x: 10,  y: 0.8,  ar: 'باب المبنى',   en: 'Block door' },
        { id: 'stairs',  x: 4.5, y: 9.5,  ar: 'السلم',        en: 'Stairs' },
        { id: 'lift',    x: 10,  y: 6,    ar: 'الأسانسير',    en: 'Lift' },
        { id: 'basement',x: 15.5,y: 9.5,  ar: 'الجراج',       en: 'Basement' }
      ],
      presets: [
        { x: 10,   y: 4.6,  aim: 90 },
        { x: 0.6,  y: 0.6,  aim: 45 },
        { x: 19.4, y: 11.4, aim: 225 }
      ]
    },

    /* The site. */
    outdoor: {
      w: 40, h: 30,
      rooms: [
        { x: 5,  y: 6,  w: 12, h: 9, ar: 'مبنى أ', en: 'Block A' },
        { x: 23, y: 6,  w: 12, h: 9, ar: 'مبنى ب', en: 'Block B' },
        { x: 5,  y: 19, w: 12, h: 8, ar: 'مبنى ج', en: 'Block C' },
        { x: 23, y: 19, w: 12, h: 8, ar: 'مبنى د', en: 'Block D' }
      ],
      walls: [
        [0,0,40,0],[40,0,40,30],[40,30,0,30],[0,30,0,0],
        [5,6,17,6],[17,6,17,15],[17,15,5,15],[5,15,5,6],
        [23,6,35,6],[35,6,35,15],[35,15,23,15],[23,15,23,6],
        [5,19,17,19],[17,19,17,27],[17,27,5,27],[5,27,5,19],
        [23,19,35,19],[35,19,35,27],[35,27,23,27],[23,27,23,19]
      ],
      zones: [
        { id: 'maingate', x: 20,   y: 1,    ar: 'البوابة الرئيسية', en: 'Main gate' },
        { id: 'exitgate', x: 20,   y: 29,   ar: 'بوابة الخروج',     en: 'Exit gate' },
        { id: 'road',     x: 20,   y: 17,   ar: 'الشارع الداخلي',   en: 'Internal road' },
        { id: 'parking',  x: 20,   y: 10,   ar: 'الجراج',           en: 'Parking' },
        { id: 'perimN',   x: 2,    y: 2,    ar: 'السور الشمالي',    en: 'North perimeter' },
        { id: 'perimS',   x: 38,   y: 28,   ar: 'السور الجنوبي',    en: 'South perimeter' },
        { id: 'perimE',   x: 38,   y: 2,    ar: 'السور الشرقي',     en: 'East perimeter' },
        { id: 'perimW',   x: 2,    y: 28,   ar: 'السور الغربي',     en: 'West perimeter' },
        { id: 'blockA',   x: 11,   y: 16.5, ar: 'مدخل مبنى أ',      en: 'Block A entrance' },
        { id: 'blockB',   x: 29,   y: 16.5, ar: 'مدخل مبنى ب',      en: 'Block B entrance' }
      ],
      presets: [
        { x: 20,   y: 2,    aim: 90 },
        { x: 0.6,  y: 0.6,  aim: 45 },
        { x: 39.4, y: 0.6,  aim: 135 },
        { x: 0.6,  y: 29.4, aim: 315 },
        { x: 39.4, y: 29.4, aim: 225 }
      ]
    }
  }
};

/* -------------------------------------------------------------------------
   4. SYSTEM RULES

   What a pile of cameras needs to become a working installation. This is what
   turns the planner into one order the workshop can actually fulfil, instead
   of a list of cameras that arrives without a recorder.

   Only WIRED cameras (analog and IP) drive any of this. Wi-Fi cameras record
   to their own card and are sold on their own.
   ------------------------------------------------------------------------- */
export const SYSTEM = {
  /* Metres of coax per wired camera, before rounding up to whole rolls. A run
     is never the straight-line distance — it goes up walls and around them. */
  cablePerCamera: 25,

  /* One 12V line per wired camera. Amps each, so the planner can pick a
     supply that is not running at its limit. */
  ampsPerCamera: 1,

  /* Recorders, smallest first. `ch` is channels; the planner picks the first
     that fits and prefers one matching the highest camera resolution. */
  recorders: [
    { id: 'unv-dvr-4ch-2mp',  ch: 4,  maxMp: 2 },
    { id: 'xvr1b04-i-t',      ch: 4,  maxMp: 5 },
    { id: 'unv-dvr-4ch-5mp',  ch: 4,  maxMp: 5 },
    { id: 'unv-dvr-8ch-2mp',  ch: 8,  maxMp: 2 },
    { id: 'xvr1b08-i-t',      ch: 8,  maxMp: 5 },
    { id: 'unv-dvr-8ch-5mp',  ch: 8,  maxMp: 5 },
    { id: 'xvr5108hs-i3',     ch: 8,  maxMp: 8 },
    { id: 'unv-dvr-16ch-5mp', ch: 16, maxMp: 5 }
  ],

  /* Storage, smallest first. `days` is roughly how long that drive holds
     continuous recording for ONE camera at 2MP; the planner divides by the
     camera count and picks the first drive that still clears `minDays`. */
  drives: [
    { id: 'seagate-500gb',  days: 60 },
    { id: 'wd-purple-1tb',  days: 120 },
    { id: 'wd-purple-2tb',  days: 240 },
    { id: 'wd-purple-4tb',  days: 480 }
  ],
  minDays: 14,

  /* Power supplies, smallest first, with the amps each can carry. */
  supplies: [
    { id: 'psu-12v-10a', amps: 10 },
    { id: 'psu-12v-20a', amps: 20 },
    { id: 'psu-12v-30a', amps: 30 },
    { id: 'psu-12v-40a', amps: 40 }
  ],

  /* Coax rolls, longest first so the planner uses whole big rolls before
     topping up with small ones. */
  cables: [
    { id: 'rg59-300m', m: 300 },
    { id: 'rg59-200m', m: 200 },
    { id: 'rg59-50m',  m: 50 }
  ],

  /* Per wired camera. Two BNC ends and a DC end per run, plus a box. */
  perCamera: [
    { id: 'connector-bnc', qty: 2 },
    { id: 'connector-dc',  qty: 1 },
    { id: 'junction-box',  qty: 1 }
  ]
};

/* =========================================================================
   PLANS BUILT TO ORDER

   The four PROPERTIES above are hand-drawn and fixed. They are good for
   "show me roughly what this looks like", and wrong for the customer who
   actually wants to know whether four cameras cover THEIR place — because
   their flat is not the flat above, and the number they came for depends on
   the size of their rooms, not on a picture of somebody else's.

   So the planner also asks three questions — what kind of place, how big,
   how many separate areas — and draws a plan from the answers. The result is
   the same shape as the hand-drawn ones, so everything downstream (the
   coverage sampler, the wall occlusion, the mounting presets, the SVG
   renderer) works on it unchanged and knows nothing about where it came from.

   WHY THE ROOMS TILE THE RECTANGLE EXACTLY
   ----------------------------------------
   Coverage is measured by sampling the whole plan area, so a gap between two
   rooms is floor nobody asked to cover and no camera is credited for. Bands
   are therefore divided into columns that consume their row exactly, and the
   remainder of an uneven division goes into the last room rather than being
   left as a hole in the middle of the score.

   WHY EVERY INTERIOR WALL HAS A HOLE IN IT
   ----------------------------------------
   Because doorways exist, and because without them the drawing is a grid of
   sealed boxes: blocked() in game.js would stop every camera at its own four
   walls, every layout would score about one room's worth of coverage, and the
   planner would tell the customer they need one camera per room — which is
   both untrue and a worse pitch than the truth. Each partition is emitted as
   two segments with a gap between them, which is exactly what the hand-drawn
   plans do (see the apartment's [8,0,8,4.5] — a wall that stops short of the
   far side on purpose).
   ========================================================================= */

/* Floor area in m², per property type and size. Ordinary Egyptian numbers
   rather than round ones: a "medium" flat really is about 140m², and a plan
   drawn to a number the customer recognises is one whose camera count they
   will believe. */
export const SIZES = {
  small:  { id: 'small',  ar: 'صغير',  en: 'Small',  apartment: 90,  villa: 220, company: 130, compound: 620 },
  medium: { id: 'medium', ar: 'متوسط', en: 'Medium', apartment: 140, villa: 340, company: 280, compound: 950 },
  large:  { id: 'large',  ar: 'كبير',  en: 'Large',  apartment: 210, villa: 520, company: 520, compound: 1350 }
};

/* How large a plan may be drawn, per type, in metres.

   The bound is not decoration. Coverage is sampled on a 0.4m grid, so area is
   what the sampler costs — and it runs on every redraw. A compound drawn to
   its true 3200m² would be a 68m x 47m plan, which is 20,000 sample points
   per redraw against every camera, and it would also render as a postage
   stamp inside the SVG with cameras too small to grab.

   So the compound figures above are a representative block of one rather than
   the whole development, and these ceilings keep every plan both quick to
   score and big enough to aim a camera on. The three sizes must stay clear of
   each other after clamping, or "large" silently draws the same plan as
   "small" — which is what the first version of this table did. */
const MAX_PLAN = {
  apartment: { w: 24, h: 16 },
  villa:     { w: 30, h: 20 },
  company:   { w: 30, h: 20 },
  compound:  { w: 44, h: 30 }
};

/* How many separate areas to draw. Fewer, larger rooms need fewer cameras on
   wider lenses; more, smaller ones need more of them. That is the whole
   reason this is a question and not a constant. */
export const AREA_COUNTS = [3, 4, 5, 6, 7, 8];

/* Room names, handed out in order. Running past the end of a list is a normal
   outcome, not an error: the eighth room of a flat is numbered rather than
   named, which is the honest answer — we do not know what it is. */
const ROOM_NAMES = {
  apartment: [
    { ar: 'الصالة', en: 'Living room' },
    { ar: 'غرفة نوم', en: 'Bedroom' },
    { ar: 'المطبخ', en: 'Kitchen' },
    { ar: 'الممر', en: 'Hallway' },
    { ar: 'غرفة نوم ٢', en: 'Bedroom 2' },
    { ar: 'المدخل', en: 'Entrance' },
    { ar: 'غرفة أطفال', en: 'Kids room' },
    { ar: 'مكتب', en: 'Study' }
  ],
  villa: [
    { ar: 'الريسبشن', en: 'Reception' },
    { ar: 'الصالة', en: 'Hall' },
    { ar: 'السفرة', en: 'Dining' },
    { ar: 'المطبخ', en: 'Kitchen' },
    { ar: 'غرفة نوم', en: 'Bedroom' },
    { ar: 'السلم', en: 'Stairs' },
    { ar: 'غرفة نوم ٢', en: 'Bedroom 2' },
    { ar: 'مكتب', en: 'Study' }
  ],
  company: [
    { ar: 'الاستقبال', en: 'Reception' },
    { ar: 'المكاتب', en: 'Open office' },
    { ar: 'غرفة اجتماعات', en: 'Meeting room' },
    { ar: 'المخزن', en: 'Store room' },
    { ar: 'مكتب المدير', en: 'Manager office' },
    { ar: 'الممر', en: 'Corridor' },
    { ar: 'الكافتيريا', en: 'Cafeteria' },
    { ar: 'غرفة السيرفر', en: 'Server room' }
  ],
  compound: [
    { ar: 'البوابة', en: 'Gate' },
    { ar: 'الممشى', en: 'Walkway' },
    { ar: 'المواقف', en: 'Parking' },
    { ar: 'الجنينة', en: 'Garden' },
    { ar: 'النادي', en: 'Clubhouse' },
    { ar: 'حمام السباحة', en: 'Pool' },
    { ar: 'الملعب', en: 'Playground' },
    { ar: 'الأمن', en: 'Security' }
  ]
};

const roomName = (type, i) =>
  (ROOM_NAMES[type] || ROOM_NAMES.apartment)[i] || { ar: 'منطقة ' + (i + 1), en: 'Area ' + (i + 1) };

const round1 = (n) => Math.round(n * 10) / 10;
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* A wall with a doorway in it. `at` is where along the run the gap sits, 0–1,
   varied per wall so the plan does not read as a barcode. */
function wallWithDoor(x1, y1, x2, y2, at, gap) {
  const g = gap === undefined ? 1.1 : gap;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len <= g * 1.6) return [];              // too short to hold a door: leave it open
  const t = clampN(at === undefined ? 0.58 : at, 0.18, 0.82);
  const half = (g / 2) / len;
  const a = clampN(t - half, 0, 1);
  const b = clampN(t + half, 0, 1);
  const px = (k) => round1(x1 + (x2 - x1) * k);
  const py = (k) => round1(y1 + (y2 - y1) * k);
  return [
    [round1(x1), round1(y1), px(a), py(a)],
    [px(b), py(b), round1(x2), round1(y2)]
  ];
}

/* Rooms that tile w x h exactly, in horizontal bands. */
function tile(w, h, count) {
  const bands = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * (h / w))) || 1));
  const per = [];
  let left = count;
  for (let b = 0; b < bands; b++) {
    const share = Math.max(1, Math.round(left / (bands - b)));
    per.push(share);
    left -= share;
  }
  /* Rounding can overshoot or undershoot. Settle it on the last band, so the
     number of areas the customer asked for is the number they get. */
  const total = per.reduce((n, v) => n + v, 0);
  per[per.length - 1] += count - total;
  if (per[per.length - 1] < 1) per[per.length - 1] = 1;

  const bandH = h / per.length;
  const rooms = [];
  const partitions = [];
  per.forEach((cols, bi) => {
    /* Both edges are rounded FIRST and the size derived from the pair.
       Rounding the start and then adding an unrounded height is what makes a
       room end 0.05m past where the next one begins — which is invisible on
       screen and shows up as rooms covering 91.2m² of a 90m² floor, or as the
       bottom row hanging over the edge of the plan. Deriving from two rounded
       edges makes the tiling exact by construction. */
    const y = round1(bi * bandH);
    const yEnd = round1(bi === per.length - 1 ? h : (bi + 1) * bandH);
    const colW = w / cols;
    for (let c = 0; c < cols; c++) {
      const x = round1(c * colW);
      const xEnd = round1(c === cols - 1 ? w : (c + 1) * colW);
      rooms.push({ x, y, w: round1(xEnd - x), h: round1(yEnd - y) });
      if (c > 0) partitions.push({ vertical: true, x, y, len: round1(yEnd - y), seed: bi * 3 + c });
    }
    if (bi > 0) partitions.push({ vertical: false, x: 0, y, len: w, seed: bi * 5 + 1 });
  });
  return { rooms, partitions };
}

function buildFloor(type, w, h, count) {
  const { rooms, partitions } = tile(w, h, count);

  const walls = [[0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0]];
  partitions.forEach((p) => {
    /* A repeatable pseudo-position, so the same three answers always draw the
       same plan. A drawing that reshuffled itself on every redraw would be
       impossible to reason about while you are placing cameras on it. */
    const at = 0.30 + ((p.seed * 37) % 45) / 100;
    const seg = p.vertical
      ? wallWithDoor(p.x, p.y, p.x, round1(p.y + p.len), at)
      : wallWithDoor(p.x, p.y, round1(p.x + p.len), p.y, at, 1.4);
    seg.forEach((s) => walls.push(s));
  });

  const named = rooms.map((r, i) => Object.assign({}, r, roomName(type, i)));

  const zones = named.map((r, i) => ({
    id: 'area' + i,
    x: round1(r.x + r.w / 2),
    y: round1(r.y + r.h / 2),
    ar: r.ar,
    en: r.en
  }));
  /* The way in is always worth covering, and it is the zone a customer looks
     for first. It sits just inside the bottom edge, which is where the door
     is drawn. */
  zones.push({ id: 'entry', x: round1(w * 0.5), y: round1(h - 0.6), ar: 'المدخل', en: 'Entrance' });

  /* Mounting points: the corners looking in, plus one over the door. Real
     cameras go on walls and corners, which is why these are what is offered
     instead of the middle of the floor. */
  return {
    w,
    h,
    rooms: named,
    walls,
    zones,
    presets: [
      { x: 0.5, y: 0.5, aim: 45 },
      { x: round1(w - 0.5), y: 0.5, aim: 135 },
      { x: round1(w - 0.5), y: round1(h - 0.5), aim: 225 },
      { x: 0.5, y: round1(h - 0.5), aim: 315 },
      { x: round1(w * 0.5), y: round1(h - 0.4), aim: 270 }
    ]
  };
}

/* The plot around the building — the gate, the parking, the perimeter.
   Everything a break-in passes through before it reaches a door. */
function buildOutdoor(type, w, h) {
  const pw = round1(clampN(w * 1.5, w + 6, 40));
  const ph = round1(clampN(h * 1.5, h + 6, 30));
  const bw = round1(w * 0.8);
  const bh = round1(h * 0.8);
  const bx = round1((pw - bw) / 2);
  const by = round1(Math.max(1.5, (ph - bh) / 2 - 1));
  const isCompound = type === 'compound';

  return {
    w: pw,
    h: ph,
    rooms: [
      {
        x: bx, y: by, w: bw, h: bh,
        ar: isCompound ? 'المباني' : 'المبنى',
        en: isCompound ? 'Buildings' : 'Building'
      },
      { x: 1, y: round1(ph - 4), w: round1(pw - 2), h: 3, ar: 'المواقف', en: 'Parking' }
    ],
    walls: [
      [0, 0, pw, 0], [pw, 0, pw, ph], [0, ph, 0, 0],
      /* The gate: the front wall stops either side of it. */
      ...wallWithDoor(pw, ph, 0, ph, 0.5, 3),
      /* The building blocks sight lines, so it is walled on three sides with
         the entrance side left open. */
      [bx, by, round1(bx + bw), by],
      [round1(bx + bw), by, round1(bx + bw), round1(by + bh)],
      [bx, by, bx, round1(by + bh)]
    ],
    zones: [
      { id: 'gate',  x: round1(pw / 2),             y: round1(ph - 0.7),      ar: 'البوابة',       en: 'Gate' },
      { id: 'park',  x: round1(pw * 0.22),          y: round1(ph - 2.5),      ar: 'المواقف',       en: 'Parking' },
      { id: 'door',  x: round1(bx + bw / 2),        y: round1(by + bh + 0.7), ar: 'باب المبنى',    en: 'Building door' },
      { id: 'sideL', x: round1(bx / 2),             y: round1(ph / 2),        ar: 'الجنب الشمال',  en: 'Left side' },
      { id: 'sideR', x: round1((pw + bx + bw) / 2), y: round1(ph / 2),        ar: 'الجنب اليمين',  en: 'Right side' },
      { id: 'back',  x: round1(pw / 2),             y: round1(Math.max(0.8, by / 2)), ar: 'الخلفية', en: 'Back' }
    ],
    presets: [
      { x: round1(pw / 2), y: round1(ph - 0.5), aim: 270 },
      { x: 0.5, y: 0.5, aim: 45 },
      { x: round1(pw - 0.5), y: 0.5, aim: 135 },
      { x: round1(bx + bw / 2), y: round1(by + bh + 0.5), aim: 90 }
    ]
  };
}

/* The public entry point: three answers in, a property-shaped object out.

   Deliberately the SAME shape as an entry in PROPERTIES, so a generated plan
   and a hand-drawn one are interchangeable everywhere downstream — game.js
   only has to decide which object to read, never how to read it. */
export function buildProperty(typeKey, sizeKey, areaCount) {
  const type = ROOM_NAMES[typeKey] ? typeKey : 'apartment';
  const size = SIZES[sizeKey] ? sizeKey : 'medium';
  const count = clampN(Math.round(Number(areaCount)) || 4, 2, 10);

  const area = SIZES[size][type] || SIZES[size].apartment;
  const max = MAX_PLAN[type] || MAX_PLAN.apartment;
  /* A rectangle rather than a square: buildings are longer than they are
     deep, and on a square plan every corner is equivalent, which is a duller
     puzzle to solve. */
  const w = round1(clampN(Math.sqrt(area * 1.45), 8, max.w));
  const h = round1(clampN(area / w, 6, max.h));

  const base = PROPERTIES[type] || PROPERTIES.apartment;
  return {
    id: 'custom',
    generated: true,
    ar: base.ar,
    en: base.en,
    icon: base.icon,
    ar_note: SIZES[size].ar + ' · ' + Math.round(area) + ' م² · ' + count + ' أماكن',
    en_note: SIZES[size].en + ' · ' + Math.round(area) + ' m² · ' + count + ' areas',
    indoor: buildFloor(type, w, h, count),
    outdoor: buildOutdoor(type, w, h)
  };
}

/* =========================================================================
   4. EDITING A PLAN

   The wizard draws a rectangle from three answers, and the ready-made plans
   are somebody's flat and not yours. These two let a customer push the plan
   towards their actual home: resize the building, and move the walls inside
   it.

   PURE, AND THEY RETURN A NEW SCENE. game.js does the dragging; everything
   that could quietly corrupt a plan is here, where test/planner.test.js can
   hold it to the same invariants buildProperty() is held to — rooms tiling
   the floor exactly, everything inside the plan, walls that blocked() can
   read. A plan that violates those does not throw; it silently scores wrong,
   which is the worst way for a planner to be broken.
   ========================================================================= */

/* How small and how large a building may get. Below the minimum a room is
   narrower than a doorway and the drawing stops meaning anything; above the
   maximum the coverage sampler walks tens of thousands of points on every
   redraw — see the note on MAX_PLAN. */
export const MIN_PLAN = { w: 6, h: 5 };
export const EDIT_MAX = { w: 60, h: 44 };

/* Resize the building.

   Everything scales with it — walls, rooms, zones, mounting presets. That is
   what keeps the invariants true by construction: rectangles that tiled the
   floor still tile it after both axes are multiplied by the same pair of
   factors, a point inside the plan stays inside it, and a doorway keeps its
   proportion of the wall it is in.

   Scaling rather than stretching one edge is also the honest reading of what
   somebody is doing when they drag: "my flat is 12 by 9, not 14 by 10" is a
   statement about the whole plan, not about one wall. Moving a single
   interior wall is the other function.

   Cameras are NOT scaled here. They belong to the customer's own layout and
   game.js decides what to do with one that ends up outside the new outline —
   this function only knows about the building. */
export function resizeScene(scene, nextW, nextH) {
  const w = round1(clampN(Number(nextW) || 0, MIN_PLAN.w, EDIT_MAX.w));
  const h = round1(clampN(Number(nextH) || 0, MIN_PLAN.h, EDIT_MAX.h));
  const fx = w / scene.w;
  const fy = h / scene.h;

  return Object.assign({}, scene, {
    w, h,
    walls: (scene.walls || []).map((s) => [
      round1(s[0] * fx), round1(s[1] * fy),
      round1(s[2] * fx), round1(s[3] * fy)
    ]),
    /* ROUND THE EDGES, THEN DERIVE THE SIZE. Rounding x and w separately is
       what breaks the tiling: two rooms sharing an edge each round their own
       side of it, the results differ by a centimetre, and the floor ends up
       with a seam. Rounding the boundary and subtracting means both rooms
       compute round1(edge * f) from the same number and land on the same
       value by construction. Measured before the fix: 1198.48 m² of floor in
       a 1200 m² building. */
    rooms: (scene.rooms || []).map((r) => {
      const x = round1(r.x * fx);
      const y = round1(r.y * fy);
      return Object.assign({}, r, {
        x, y,
        w: round1(round1((r.x + r.w) * fx) - x),
        h: round1(round1((r.y + r.h) * fy) - y)
      });
    }),
    zones: (scene.zones || []).map((z) => Object.assign({}, z, {
      x: round1(z.x * fx), y: round1(z.y * fy)
    })),
    presets: (scene.presets || []).map((p) => Object.assign({}, p, {
      x: round1(p.x * fx), y: round1(p.y * fy)
    }))
  });
}

/* Is this wall part of the outer outline rather than a partition inside it?

   The outline is what resizeScene moves; the partitions are what moveWall
   moves. Told apart by position rather than by an index, because the wall
   lists in game-data.js are hand-written and their order is not a contract. */
export function isOuterWall(scene, seg) {
  const on = (v, edge) => Math.abs(v - edge) < 0.05;
  const vertical = Math.abs(seg[0] - seg[2]) < 0.05;
  const horizontal = Math.abs(seg[1] - seg[3]) < 0.05;
  if (vertical) return on(seg[0], 0) || on(seg[0], scene.w);
  if (horizontal) return on(seg[1], 0) || on(seg[1], scene.h);
  return false;
}

/* Move one interior wall sideways.

   A partition here is axis-aligned, so moving it means changing one
   coordinate. The rooms either side have to follow, or the wall drifts off
   the rectangle it was dividing and the floor stops tiling — the drawing
   would still look plausible and the coverage score would quietly be about a
   floor plan nobody has.

   So every room edge sitting ON the wall's line moves with it: a room whose
   far edge was the wall grows or shrinks, and a room whose near edge was the
   wall moves and resizes to match. Rooms that never touched it are untouched.

   Clamped to leave a metre either side, because a room narrower than a door
   is not a room, and dragging a partition through the outer wall would put
   the plan inside out.
   ------------------------------------------------------------------------- */
export function moveWall(scene, index, nextValue) {
  const seg = (scene.walls || [])[index];
  if (!seg || isOuterWall(scene, seg)) return scene;

  const vertical = Math.abs(seg[0] - seg[2]) < 0.05;
  const horizontal = Math.abs(seg[1] - seg[3]) < 0.05;
  if (!vertical && !horizontal) return scene;      // diagonal: not draggable

  const axisMax = vertical ? scene.w : scene.h;
  const from = vertical ? seg[0] : seg[1];
  const same = (v) => Math.abs(v - from) < 0.05;

  /* HOW FAR IT MAY ACTUALLY GO, asked of the rooms rather than assumed.

     Clamping to the building alone is not enough. A partition dragged almost
     to the far wall leaves the room behind it a few centimetres wide, and the
     first version dealt with that by declining to resize a room that got too
     small — which moved one side of the wall and not the other, and left the
     floor with a 40 m² overlap. Refusing to resize a room is the same bug as
     not resizing it.

     So the limit comes from the rooms the wall actually divides: it may not
     be pushed closer than MIN_ROOM to the far edge of anything it touches.
     Nothing is skipped, because nothing is ever asked to become too small. */
  const MIN_ROOM = 1;
  let lo = 1;
  let hi = round1(axisMax - 1);
  for (const r of scene.rooms || []) {
    const near = vertical ? r.x : r.y;
    const far = near + (vertical ? r.w : r.h);
    if (same(near)) hi = Math.min(hi, round1(far - MIN_ROOM));
    if (same(far)) lo = Math.max(lo, round1(near + MIN_ROOM));
  }
  /* No room to move at all — a partition between two minimum-width rooms. */
  if (lo > hi) return scene;

  const to = round1(clampN(Number(nextValue) || 0, lo, hi));
  if (Math.abs(to - from) < 0.05) return scene;

  const walls = scene.walls.map((s, i) => {
    if (i !== index) {
      /* Any OTHER wall that shares the line moves too — a partition is often
         drawn as two segments with a doorway between them, and moving half of
         a wall is how you get a hole in the middle of a room. */
      if (vertical && Math.abs(s[0] - s[2]) < 0.05 && same(s[0])) return [to, s[1], to, s[3]];
      if (horizontal && Math.abs(s[1] - s[3]) < 0.05 && same(s[1])) return [s[0], to, s[2], to];
      return s.slice();
    }
    return vertical ? [to, seg[1], to, seg[3]] : [seg[0], to, seg[2], to];
  });

  /* Every room touching the line follows it. No conditional bail-out: the
     range above already guarantees nothing is asked to become too small, so
     a room that touches the wall ALWAYS moves with it and the floor keeps
     tiling. */
  const rooms = (scene.rooms || []).map((r) => {
    const near = vertical ? r.x : r.y;
    const far = round1(near + (vertical ? r.w : r.h));
    if (same(near)) {
      return Object.assign({}, r, vertical
        ? { x: to, w: round1(far - to) }
        : { y: to, h: round1(far - to) });
    }
    if (same(far)) {
      return Object.assign({}, r, vertical
        ? { w: round1(to - near) }
        : { h: round1(to - near) });
    }
    return Object.assign({}, r);
  });

  return Object.assign({}, scene, { walls, rooms });
}
