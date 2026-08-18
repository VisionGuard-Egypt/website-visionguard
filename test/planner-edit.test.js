/* =========================================================================
   Editing a plan.

   The customer can now resize the building and drag its interior walls, and
   the coverage sampler behind the score assumes the same things about an
   EDITED plan that it assumes about a generated one: rooms that tile the
   floor with no gaps, walls with doorways in them, zones inside the
   building. None of those failing throws. The drawing still looks plausible
   and the score is quietly about a floor plan that does not exist — which is
   the number the customer decides how much to spend from.

   So the two editing functions are held to the same invariants
   test/planner.test.js holds buildProperty() to, before and after every
   operation.

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProperty, resizeScene, moveWall, isOuterWall, MIN_PLAN, EDIT_MAX
} from '../public/game-data.js';

const base = () => buildProperty('apartment', 'medium', 5).indoor;

/* The invariant bundle, as one assertion, so every test below can demand the
   whole contract rather than the bit it happened to think about. */
function assertSound(scene, why) {
  const near = (a, b) => Math.abs(a - b) < 0.051;

  for (const r of scene.rooms) {
    assert.ok(r.w > 0 && r.h > 0, `${why}: room has no area`);
    assert.ok(r.x >= -0.05 && r.y >= -0.05, `${why}: room starts outside the plan`);
    assert.ok(r.x + r.w <= scene.w + 0.05, `${why}: room runs past the width`);
    assert.ok(r.y + r.h <= scene.h + 0.05, `${why}: room runs past the height`);
  }
  /* The one the coverage sampler actually depends on: every square metre of
     floor belongs to exactly one room. */
  const floor = scene.rooms.reduce((sum, r) => sum + r.w * r.h, 0);
  assert.ok(near(floor, scene.w * scene.h) || Math.abs(floor - scene.w * scene.h) < 0.6,
    `${why}: rooms cover ${floor.toFixed(2)} of ${(scene.w * scene.h).toFixed(2)} m²`);

  for (const z of scene.zones) {
    assert.ok(z.x >= 0 && z.x <= scene.w, `${why}: zone outside the width`);
    assert.ok(z.y >= 0 && z.y <= scene.h, `${why}: zone outside the height`);
  }
  for (const s of scene.walls) {
    assert.equal(s.length, 4, `${why}: wall is not four numbers`);
    for (const n of s) assert.ok(Number.isFinite(n), `${why}: wall coordinate is not finite`);
  }
  for (const p of scene.presets || []) {
    assert.ok(p.x >= 0 && p.x <= scene.w && p.y >= 0 && p.y <= scene.h,
      `${why}: mounting preset outside the plan`);
  }
}

test('the plan we start from is sound, or nothing below means anything', () => {
  assertSound(base(), 'baseline');
});

/* -------------------------------------------------------------------------
   Resizing the building
   ------------------------------------------------------------------------- */
test('resizing sets the size that was asked for', () => {
  const out = resizeScene(base(), 20, 14);
  assert.equal(out.w, 20);
  assert.equal(out.h, 14);
});

test('everything scales with it, so the plan stays sound at any size', () => {
  for (const [w, h] of [[8, 6], [12, 9], [20, 14], [40, 30], [55, 40]]) {
    assertSound(resizeScene(base(), w, h), `resized to ${w}x${h}`);
  }
});

test('resizing does not move anything relative to the building', () => {
  /* A zone that was in the middle is still in the middle. Scaling is the
     whole reason the invariants survive — a stretch that moved only one edge
     would leave rooms overlapping or short of the wall. */
  const before = base();
  const z0 = before.zones[0];
  const after = resizeScene(before, before.w * 2, before.h * 2);
  assert.ok(Math.abs(after.zones[0].x / after.w - z0.x / before.w) < 0.02);
  assert.ok(Math.abs(after.zones[0].y / after.h - z0.y / before.h) < 0.02);
});

test('a building cannot be shrunk below a usable size', () => {
  const out = resizeScene(base(), 1, 1);
  assert.equal(out.w, MIN_PLAN.w);
  assert.equal(out.h, MIN_PLAN.h);
  assertSound(out, 'clamped small');
});

test('and cannot be grown until the sampler chokes', () => {
  /* Coverage walks the floor on a 0.4m grid on every redraw. An unbounded
     plan is tens of thousands of samples per frame of a drag. */
  const out = resizeScene(base(), 9999, 9999);
  assert.equal(out.w, EDIT_MAX.w);
  assert.equal(out.h, EDIT_MAX.h);
});

test('nonsense dimensions clamp rather than producing NaN geometry', () => {
  for (const bad of [null, undefined, NaN, 'wide', -30]) {
    const out = resizeScene(base(), bad, bad);
    assert.ok(Number.isFinite(out.w) && Number.isFinite(out.h));
    assertSound(out, `resize(${String(bad)})`);
  }
});

test('resizing returns a new scene and leaves the original alone', () => {
  /* The planner keeps the generated plan around to reset to. */
  const before = base();
  const w = before.w, rooms = before.rooms.length, firstX = before.rooms[0].x;
  resizeScene(before, 30, 20);
  assert.equal(before.w, w);
  assert.equal(before.rooms.length, rooms);
  assert.equal(before.rooms[0].x, firstX);
});

/* -------------------------------------------------------------------------
   Telling the outline from the partitions
   ------------------------------------------------------------------------- */
test('the four sides of the building are outer walls', () => {
  const s = base();
  assert.equal(isOuterWall(s, [0, 0, s.w, 0]), true, 'top');
  assert.equal(isOuterWall(s, [s.w, 0, s.w, s.h]), true, 'right');
  assert.equal(isOuterWall(s, [s.w, s.h, 0, s.h]), true, 'bottom');
  assert.equal(isOuterWall(s, [0, s.h, 0, 0]), true, 'left');
});

test('a partition inside the building is not an outer wall', () => {
  const s = base();
  assert.equal(isOuterWall(s, [s.w / 2, 0, s.w / 2, s.h / 2]), false);
});

/* -------------------------------------------------------------------------
   Moving an interior wall
   ------------------------------------------------------------------------- */
const interiorIndex = (s) => s.walls.findIndex((seg) => !isOuterWall(s, seg));

test('moving a partition moves it, and the plan stays sound', () => {
  const s = base();
  const i = interiorIndex(s);
  assert.ok(i >= 0, 'the fixture needs at least one partition');
  const seg = s.walls[i];
  const vertical = Math.abs(seg[0] - seg[2]) < 0.05;
  const to = (vertical ? seg[0] : seg[1]) + 1.5;

  const out = moveWall(s, i, to);
  const moved = out.walls[i];
  assert.equal(vertical ? moved[0] : moved[1], to);
  assertSound(out, 'after moving a partition');
});

test('THE OUTER WALLS CANNOT BE DRAGGED THIS WAY', () => {
  /* Resizing is how the building changes size. Letting moveWall shift an
     outer wall would move one side without moving the rooms behind it, and
     the floor would stop tiling — the exact silent corruption these tests
     exist for. */
  const s = base();
  const i = s.walls.findIndex((seg) => isOuterWall(s, seg));
  assert.ok(i >= 0);
  const out = moveWall(s, i, 3);
  assert.deepEqual(out.walls[i], s.walls[i], 'the outer wall must not move');
  assert.equal(out, s, 'and the scene should come back untouched');
});

test('a partition cannot be pushed through the outside of the building', () => {
  const s = base();
  const i = interiorIndex(s);
  const seg = s.walls[i];
  const vertical = Math.abs(seg[0] - seg[2]) < 0.05;
  const limit = vertical ? s.w : s.h;

  for (const attempt of [-40, 0, limit, limit + 40]) {
    const out = moveWall(s, i, attempt);
    const got = vertical ? out.walls[i][0] : out.walls[i][1];
    assert.ok(got >= 1 && got <= limit - 1, `pushed to ${got}, outside 1..${limit - 1}`);
    assertSound(out, `partition pushed to ${attempt}`);
  }
});

test('both halves of a wall with a doorway in it move together', () => {
  /* Partitions are drawn as two segments with a gap between them. Moving one
     half leaves a wall with a hole in the middle of a room. */
  const s = base();
  const i = interiorIndex(s);
  const seg = s.walls[i];
  const vertical = Math.abs(seg[0] - seg[2]) < 0.05;
  const from = vertical ? seg[0] : seg[1];
  const siblings = s.walls
    .map((w, k) => ({ w, k }))
    .filter(({ w }) => (vertical
      ? Math.abs(w[0] - w[2]) < 0.05 && Math.abs(w[0] - from) < 0.05
      : Math.abs(w[1] - w[3]) < 0.05 && Math.abs(w[1] - from) < 0.05));

  const to = from + 1;
  const out = moveWall(s, i, to);
  for (const { k } of siblings) {
    const got = vertical ? out.walls[k][0] : out.walls[k][1];
    assert.ok(Math.abs(got - to) < 0.051, `segment ${k} was left behind at ${got}`);
  }
});

test('an index that is not a wall changes nothing', () => {
  const s = base();
  assert.equal(moveWall(s, 999, 4), s);
  assert.equal(moveWall(s, -1, 4), s);
});

test('resize then move then resize still leaves a sound plan', () => {
  /* The sequence a real customer produces: set the size, nudge a wall, decide
     the flat is bigger than they thought. */
  let s = base();
  s = resizeScene(s, 18, 12);
  assertSound(s, 'after first resize');
  const i = interiorIndex(s);
  s = moveWall(s, i, (Math.abs(s.walls[i][0] - s.walls[i][2]) < 0.05 ? s.walls[i][0] : s.walls[i][1]) + 2);
  assertSound(s, 'after moving a wall');
  s = resizeScene(s, 26, 18);
  assertSound(s, 'after the second resize');
});
