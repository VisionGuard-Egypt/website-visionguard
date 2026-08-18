/* =========================================================================
   Plans built to order.

   The generated plan feeds the same coverage sampler as the hand-drawn ones,
   and that sampler assumes things the drawing has to actually be true about:
   rooms that tile the area with no gaps, walls with doorways in them, zones
   that sit inside the building. A plan that quietly breaks one of those does
   not throw — it just reports a coverage score that is wrong, which is the
   number the customer decides how much to spend from.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProperty, SIZES, AREA_COUNTS, PROPERTIES } from '../public/game-data.js';

const TYPES = ['apartment', 'villa', 'company', 'compound'];
const every = (fn) => {
  for (const type of TYPES) {
    for (const size of Object.keys(SIZES)) {
      for (const count of AREA_COUNTS) {
        fn(buildProperty(type, size, count), { type, size, count });
      }
    }
  }
};

test('produces both an indoor and an outdoor plan for every combination', () => {
  every((p, at) => {
    const where = `${at.type}/${at.size}/${at.count}`;
    for (const mode of ['indoor', 'outdoor']) {
      const plan = p[mode];
      assert.ok(plan, `${where} ${mode} missing`);
      assert.ok(plan.w > 0 && plan.h > 0, `${where} ${mode} has no size`);
      assert.ok(Array.isArray(plan.rooms) && plan.rooms.length, `${where} ${mode} has no rooms`);
      assert.ok(Array.isArray(plan.walls) && plan.walls.length, `${where} ${mode} has no walls`);
      assert.ok(Array.isArray(plan.zones) && plan.zones.length, `${where} ${mode} has no zones`);
      assert.ok(Array.isArray(plan.presets) && plan.presets.length, `${where} ${mode} has no presets`);
    }
  });
});

test('draws exactly the number of areas that was asked for', () => {
  every((p, at) => {
    assert.equal(p.indoor.rooms.length, at.count,
      `${at.type}/${at.size}: asked for ${at.count} areas, got ${p.indoor.rooms.length}`);
  });
});

test('the rooms tile the floor exactly — no gaps, no overlap', () => {
  every((p, at) => {
    const where = `${at.type}/${at.size}/${at.count}`;
    const floor = p.indoor.w * p.indoor.h;
    const sum = p.indoor.rooms.reduce((n, r) => n + r.w * r.h, 0);
    /* Rounded to 0.1m, so a small residue is arithmetic rather than a hole. */
    assert.ok(Math.abs(sum - floor) < 1.0,
      `${where}: rooms cover ${sum.toFixed(2)}m² of a ${floor.toFixed(2)}m² floor`);
  });
});

test('every room sits inside the plan', () => {
  every((p, at) => {
    for (const r of p.indoor.rooms) {
      assert.ok(r.x >= -0.01 && r.y >= -0.01, `${at.type}: room starts outside the plan`);
      assert.ok(r.x + r.w <= p.indoor.w + 0.01, `${at.type}: room runs past the right edge`);
      assert.ok(r.y + r.h <= p.indoor.h + 0.01, `${at.type}: room runs past the bottom edge`);
      assert.ok(r.w > 0.5 && r.h > 0.5, `${at.type}: room too small to place a camera in`);
    }
  });
});

test('every room and zone is named in both languages', () => {
  every((p, at) => {
    for (const r of p.indoor.rooms) {
      assert.ok(r.ar && r.en, `${at.type}: a room is missing a name`);
    }
    for (const z of p.indoor.zones) {
      assert.ok(z.ar && z.en, `${at.type}: a zone is missing a name`);
      assert.ok(z.id, `${at.type}: a zone is missing an id`);
    }
  });
});

test('zone ids are unique, or the coverage list double-counts', () => {
  every((p, at) => {
    for (const mode of ['indoor', 'outdoor']) {
      const ids = p[mode].zones.map((z) => z.id);
      assert.equal(new Set(ids).size, ids.length, `${at.type} ${mode}: duplicate zone id`);
    }
  });
});

test('every zone sits inside the plan it belongs to', () => {
  every((p, at) => {
    for (const mode of ['indoor', 'outdoor']) {
      for (const z of p[mode].zones) {
        assert.ok(z.x >= 0 && z.x <= p[mode].w, `${at.type} ${mode}: zone ${z.id} is off the plan horizontally`);
        assert.ok(z.y >= 0 && z.y <= p[mode].h, `${at.type} ${mode}: zone ${z.id} is off the plan vertically`);
      }
    }
  });
});

test('mounting presets sit inside the plan, and aim somewhere real', () => {
  every((p, at) => {
    for (const mode of ['indoor', 'outdoor']) {
      for (const pt of p[mode].presets) {
        assert.ok(pt.x >= 0 && pt.x <= p[mode].w, `${at.type} ${mode}: preset off the plan`);
        assert.ok(pt.y >= 0 && pt.y <= p[mode].h, `${at.type} ${mode}: preset off the plan`);
        assert.ok(Number.isFinite(pt.aim) && pt.aim >= 0 && pt.aim < 360, `${at.type} ${mode}: bad preset aim`);
      }
    }
  });
});

test('every wall is four finite numbers, which is what blocked() expects', () => {
  every((p, at) => {
    for (const mode of ['indoor', 'outdoor']) {
      for (const w of p[mode].walls) {
        assert.equal(w.length, 4, `${at.type} ${mode}: wall is not a 4-tuple`);
        for (const n of w) assert.ok(Number.isFinite(n), `${at.type} ${mode}: wall has a non-number`);
      }
    }
  });
});

test('interior partitions have doorways — a sealed grid would ruin the score', () => {
  /* The four outer walls run the full edge; anything else is a partition, and
     a partition that spans its whole run is a room with no door. This is the
     test that stops the planner telling customers they need one camera per
     room. */
  every((p, at) => {
    const { w, h, walls } = p.indoor;
    const isOuter = (s) =>
      (s[0] === 0 && s[2] === 0) || (s[1] === 0 && s[3] === 0) ||
      (s[0] === w && s[2] === w) || (s[1] === h && s[3] === h);

    for (const s of walls) {
      if (isOuter(s)) continue;
      const vertical = s[0] === s[2];
      const span = vertical ? Math.abs(s[3] - s[1]) : Math.abs(s[2] - s[0]);
      const full = vertical ? h : w;
      assert.ok(span < full - 0.5,
        `${at.type}/${at.size}/${at.count}: interior wall spans the full ${vertical ? 'height' : 'width'} with no doorway`);
    }
  });
});

test('the same three answers always draw the same plan', () => {
  /* Placing cameras on a drawing that reshuffles itself between redraws would
     be impossible, so the generator must be deterministic. */
  const a = buildProperty('villa', 'medium', 6);
  const b = buildProperty('villa', 'medium', 6);
  assert.deepEqual(a, b);
});

test('bigger sizes really do draw bigger plans', () => {
  for (const type of TYPES) {
    const s = buildProperty(type, 'small', 5).indoor;
    const l = buildProperty(type, 'large', 5).indoor;
    assert.ok(l.w * l.h > s.w * s.h, `${type}: large is not bigger than small`);
  }
});

test('falls back rather than throwing on nonsense answers', () => {
  for (const args of [
    ['nope', 'nope', 0],
    [undefined, undefined, undefined],
    ['apartment', 'medium', -5],
    ['apartment', 'medium', 999],
    [null, null, NaN]
  ]) {
    const p = buildProperty(...args);
    assert.ok(p && p.indoor && p.indoor.rooms.length >= 2, `buildProperty(${JSON.stringify(args)}) produced nothing usable`);
    assert.ok(p.indoor.rooms.length <= 10, 'area count must stay clamped');
  }
});

test('carries the label and icon of the type it is based on', () => {
  for (const type of TYPES) {
    const p = buildProperty(type, 'medium', 4);
    assert.equal(p.ar, PROPERTIES[type].ar);
    assert.equal(p.en, PROPERTIES[type].en);
    assert.equal(p.icon, PROPERTIES[type].icon);
    assert.equal(p.generated, true);
    assert.ok(/m²/.test(p.en_note), 'the note should say how big the plan is');
  }
});
